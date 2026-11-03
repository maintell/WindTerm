//! 进程内 mock SSH 服务端（测试专用）。
//!
//! 为什么放在库里而不是某个 `tests/` 文件：上层（CLI、将来的 UI 后端）也需要一个
//! **不依赖外部 sshd** 的真实协议对端来验证「连接 → 认证 → 通道 → 数据」整条链路。
//! 复制一份 mock 到每个测试文件里，迟早会漂移成两套行为。
//!
//! 启用方式：`wt-ssh = { features = ["test-util"] }`。
//!
//! 行为约定（测试断言依赖它）：
//! - 密码认证：用户 `tester` / 密码 `secret`
//! - 公钥认证：接受任意公钥
//! - `shell_request`：先发 `WELCOME\r\n`
//! - 收到数据：回 `echo:<原文>`
//! - `exec_request`：回 `ran:<命令>\r\n`，退出码 0

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use russh::keys::ssh_key::rand_core::{TryCryptoRng, TryRng};
use russh::server::{Auth, Msg, Server as _, Session};
use russh::{Channel, ChannelId};use russh_sftp::protocol::{Attrs, Data, File, FileAttributes, Handle, Name, Status, StatusCode};
use tokio::net::TcpListener;
use tokio::sync::Mutex as AsyncMutex;

/// mock 的远端文件系统：路径 → 内容。目录靠路径前缀体现，够 SFTP 测试用。
pub type MockFs = Arc<AsyncMutex<HashMap<String, Vec<u8>>>>;

/// 内存文件系统上的 SFTP 服务端（只实现列目录/读/写/stat）。
///
/// 刻意不完整——它的价值是让「客户端真的会讲 SFTP」可验证，
/// 不是替代真实 sshd。
pub struct MemSftp {
    fs: MockFs,
    dir_sent: bool,
}

impl MemSftp {
    pub fn new(fs: MockFs) -> Self {
        Self {
            fs,
            dir_sent: false,
        }
    }
}

fn ok_status(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: "Ok".to_string(),
        language_tag: "en-US".to_string(),
    }
}

impl russh_sftp::server::Handler for MemSftp {
    type Error = StatusCode;

    fn unimplemented(&self) -> StatusCode {
        StatusCode::OpUnsupported
    }

    async fn close(&mut self, id: u32, _handle: String) -> Result<Status, StatusCode> {
        Ok(ok_status(id))
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, StatusCode> {
        self.dir_sent = false;
        Ok(Handle { id, handle: path })
    }

    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, StatusCode> {
        if self.dir_sent {
            return Err(StatusCode::Eof);
        }
        self.dir_sent = true;
        let prefix = if handle.ends_with('/') {
            handle.clone()
        } else {
            format!("{handle}/")
        };
        let fs = self.fs.lock().await;
        // 先快照键：判断「这一项是不是目录」要再查一遍前缀，边迭代边借用过不了编译
        let keys: Vec<String> = fs.keys().cloned().collect();
        let files = keys
            .iter()
            .filter_map(|path| path.strip_prefix(&prefix))
            .filter(|rest| !rest.is_empty() && !rest.contains('/'))
            .map(|name| {
                let full = format!("{prefix}{name}");
                // 没有独立目录表，一个路径「是目录」当且仅当存在它的子项
                let is_dir = keys.iter().any(|p| p.starts_with(&format!("{full}/")));
                // 不能用 `FileAttributes::dummy()`：它把 permissions 写死成
                // `0o777 | S_IFDIR`，于是每个条目都被报成目录，界面上给文件加个 `/`。
                // 这会让「列目录」看起来对、`is_dir` 全错——测试保真度的问题最难发现。
                let mut attrs = FileAttributes::empty();
                attrs.permissions = Some(if is_dir {
                    0o755 | 0o040000 // S_IFDIR
                } else {
                    0o644 | 0o100000 // S_IFREG
                });
                attrs.size = Some(if is_dir {
                    0
                } else {
                    fs.get(&full).map(|v| v.len() as u64).unwrap_or(0)
                });
                File::new(name, attrs)
            })
            .collect::<Vec<_>>();
        Ok(Name { id, files })
    }

    async fn realpath(&mut self, id: u32, _path: String) -> Result<Name, StatusCode> {
        Ok(Name {
            id,
            files: vec![File::dummy("/")],
        })
    }

    async fn open(
        &mut self,
        id: u32,
        filename: String,
        _pflags: russh_sftp::protocol::OpenFlags,
        _attrs: FileAttributes,
    ) -> Result<Handle, StatusCode> {
        Ok(Handle {
            id,
            handle: filename,
        })
    }

    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, StatusCode> {
        let fs = self.fs.lock().await;
        let Some(content) = fs.get(&handle) else {
            return Err(StatusCode::NoSuchFile);
        };
        let start = offset as usize;
        if start >= content.len() {
            return Err(StatusCode::Eof);
        }
        let end = (start + len as usize).min(content.len());
        Ok(Data {
            id,
            data: content[start..end].to_vec(),
        })
    }

    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, StatusCode> {
        let mut fs = self.fs.lock().await;
        let entry = fs.entry(handle).or_default();
        let start = offset as usize;
        if entry.len() < start + data.len() {
            entry.resize(start + data.len(), 0);
        }
        entry[start..start + data.len()].copy_from_slice(&data);
        Ok(ok_status(id))
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, StatusCode> {
        let fs = self.fs.lock().await;
        let Some(content) = fs.get(&path) else {
            return Err(StatusCode::NoSuchFile);
        };
        let mut attrs = FileAttributes::dummy();
        attrs.size = Some(content.len() as u64);
        Ok(Attrs { id, attrs })
    }
}

/// 桥接 RNG：`ssh-key 0.7` 用 `rand_core 0.10` 的 `CryptoRng`，
/// 而项目主依赖是 rand 0.8（`rand_core 0.6`）。两者 trait 不同代，无法直接传。
///
/// 与其在仓库里塞一个测试私钥，不如写这 20 行适配器——私钥不该进版本库，
/// 哪怕它是「只用于 localhost」的。
pub struct BridgeRng;

fn fill(dst: &mut [u8]) {
    <rand::rngs::ThreadRng as rand::RngCore>::fill_bytes(&mut rand::thread_rng(), dst);
}

impl TryRng for BridgeRng {
    type Error = std::convert::Infallible;

    fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
        let mut b = [0u8; 4];
        fill(&mut b);
        Ok(u32::from_le_bytes(b))
    }

    fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
        let mut b = [0u8; 8];
        fill(&mut b);
        Ok(u64::from_le_bytes(b))
    }

    fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Self::Error> {
        fill(dst);
        Ok(())
    }
}

impl TryCryptoRng for BridgeRng {}

struct MockServer {
    fs: MockFs,
}

impl russh::server::Server for MockServer {
    type Handler = MockHandler;
    fn new_client(&mut self, _peer: Option<std::net::SocketAddr>) -> MockHandler {
        MockHandler {
            channels: Arc::new(AsyncMutex::new(HashMap::new())),
            subsystems: Arc::new(AsyncMutex::new(std::collections::HashSet::new())),
            fs: self.fs.clone(),
            input_buf: String::new(),
        }
    }
}

struct MockHandler {
    /// 子系统请求要把通道从 `channel_open_session` 里取回来
    channels: Arc<AsyncMutex<HashMap<ChannelId, Channel<Msg>>>>,
    /// 已经交给子系统（如 echo）的通道：这些通道上的数据不该再被 shell 回显
    subsystems: Arc<AsyncMutex<std::collections::HashSet<ChannelId>>>,
    /// SFTP 子系统用的内存文件系统
    fs: MockFs,
    /// shell 收到的输入累积（按字符截断）。客户端是**逐键**发的，
    /// 想识别一段词就必须累积，否则永远匹配不到整词。
    input_buf: String,
}

impl russh::server::Handler for MockHandler {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        if user == "tester" && password == "secret" {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::reject())
        }
    }

    async fn auth_publickey(
        &mut self,
        _user: &str,
        _key: russh::server::VerifiedPublicKey<'_>,
    ) -> Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.channels.lock().await.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }

    /// `NET-001` 的数据面：连到调用方指定的 `host:port`，再把通道与 TCP 对接。
    ///
    /// 这里刻意连**真实 TCP** 而不是内存管道：上层要验的正是
    /// 「本地 socket ↔ SSH 通道」这段搬运，用内存对端就测不到半关闭与字节计数。
    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        host_to_connect: &str,
        port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        let addr = format!("{host_to_connect}:{port_to_connect}");
        match tokio::net::TcpStream::connect(&addr).await {
            Ok(mut tcp) => {
                // 这条通道已经交给转发处理器：不登记的话，`data()` 里的 shell
                // 回显还会往同一条通道补一句 `echo:...`，把转发流量污染成乱码。
                self.subsystems.lock().await.insert(channel.id());
                reply.accept().await;
                let mut stream = channel.into_stream();
                tokio::spawn(async move {
                    // 与生产代码一样用 copy_bidirectional：半关闭语义才一致
                    let _ = tokio::io::copy_bidirectional(&mut tcp, &mut stream).await;
                });
                Ok(())
            }
            Err(_) => {
                // 目标不可达就按协议拒绝，客户端会收到明确失败，
                // 而不是「通道开了但一个字节都没有」这种查不出原因的现象
                reply.reject(russh::ChannelOpenFailure::ConnectFailed).await;
                Ok(())
            }
        }
    }

    /// `subsystem_request("echo")`：把收到的字节原样回写。
    ///
    /// 用来验证「子系统通道 + 字节流」这条链路本身；SFTP 之类的上层协议可以
    /// 直接挂在同一条通道上（见 `sftp` 分支）。
    async fn subsystem_request(
        &mut self,
        channel_id: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let Some(channel) = self.channels.lock().await.remove(&channel_id) else {
            session.channel_failure(channel_id)?;
            return Ok(());
        };
        self.subsystems.lock().await.insert(channel_id);

        match name {
            "echo" => {
                session.channel_success(channel_id)?;
                let mut stream = channel.into_stream();
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = [0u8; 4096];
                    loop {
                        match stream.read(&mut buf).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                if stream.write_all(&buf[..n]).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                });
            }
            "sftp" => {
                session.channel_success(channel_id)?;
                let handler = MemSftp::new(self.fs.clone());
                // 必须 spawn：在 handler 里 await 服务端会挡住连接循环，
                // 客户端发来的报文永远读不到（表现为服务端「立刻退出」）
                tokio::spawn(async move {
                    russh_sftp::server::run(channel.into_stream(), handler).await;
                });
            }
            _ => session.channel_failure(channel_id)?,
        }
        Ok(())
    }

    async fn pty_request(
        &mut self,
        _channel: ChannelId,
        _term: &str,
        _col_width: u32,
        _row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(russh::Pty, u32)],
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.data(channel, b"WELCOME\r\n".to_vec())?;
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let out = format!("ran:{}\r\n", String::from_utf8_lossy(data)).into_bytes();
        session.data(channel, out)?;
        session.exit_status_request(channel, 0)?;
        session.close(channel)?;
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        // 子系统通道上的数据由子系统自己处理（如 echo 原样回写），
        // 再回显一遍会污染协议流
        if self.subsystems.lock().await.contains(&channel) {
            return Ok(());
        }
        let echo = format!("echo:{}", String::from_utf8_lossy(data)).into_bytes();
        session.data(channel, echo)?;
        // 让上层能验证 bracketed paste：客户端**逐键**发来的输入累积成含
        // `bracketed` 的一段时，服务端开启 `?2004`，之后客户端的粘贴应当被
        // `\e[200~` / `\e[201~` 包裹。真实 shell 由 readline 发这个序列，
        // 这里用可控输入触发，断言才稳定。
        self.input_buf.push_str(&String::from_utf8_lossy(data));
        if self.input_buf.chars().count() > 256 {
            // 只留最近 256 个字符：这个缓冲只用来识别触发词，不需要无限增长
            let skip = self.input_buf.chars().count() - 256;
            self.input_buf = self.input_buf.chars().skip(skip).collect();
        }
        if self.input_buf.contains("bracketed") {
            // 触发后清空：否则后续每个键都会再发一次 `?2004h`，把测试流刷满
            self.input_buf.clear();
            session.data(channel, b"\x1b[?2004h".to_vec())?;
            return Ok(());
        }
        Ok(())
    }
}

/// 已启动的 mock 服务端。`port` 指向 `127.0.0.1`。
pub struct MockSshServer {
    pub port: u16,
    /// SFTP 子系统的内存文件系统：用例在连接前预置、连接后检查
    pub fs: MockFs,
}

impl MockSshServer {
    /// 在随机端口启动。返回后即可连接。
    pub async fn start() -> Self {
        let key =
            russh::keys::PrivateKey::random(&mut BridgeRng, russh::keys::Algorithm::Ed25519)
                .expect("生成测试主机密钥");

        let config = Arc::new(russh::server::Config {
            keys: vec![key],
            // 测试里不需要人为延迟；默认的 3 秒会让测试很慢
            auth_rejection_time: Duration::from_millis(10),
            auth_rejection_time_initial: Some(Duration::from_millis(0)),
            inactivity_timeout: Some(Duration::from_secs(30)),
            ..Default::default()
        });

        // `run_on_socket` 借用 server 与 listener，返回的 future 不是 'static，
        // 无法直接 tokio::spawn。测试进程内 leak 掉最简单——进程结束即回收。
        let listener: &'static TcpListener =
            Box::leak(Box::new(TcpListener::bind("127.0.0.1:0").await.expect("绑定端口")));
        let port = listener.local_addr().expect("取地址").port();

        let server: &'static mut MockServer = Box::leak(Box::new(MockServer {
            fs: Arc::new(AsyncMutex::new(HashMap::new())),
        }));
        let fs = server.fs.clone();
        tokio::spawn(server.run_on_socket(config, listener));

        // 给监听循环一点时间就绪，减少首连抖动
        tokio::time::sleep(Duration::from_millis(30)).await;

        Self { port, fs }
    }

    /// 生成一份可被服务端接受的 OpenSSH 私钥（明文）。
    pub fn fresh_openssh_key(passphrase: Option<&str>) -> Vec<u8> {
        let key = russh::keys::PrivateKey::random(&mut BridgeRng, russh::keys::Algorithm::Ed25519)
            .expect("生成密钥");
        let key = match passphrase {
            Some(p) => key.encrypt(&mut BridgeRng, p).expect("加密私钥"),
            None => key,
        };
        key.to_openssh(russh::keys::ssh_key::LineEnding::LF)
            .expect("导出 OpenSSH")
            .as_bytes()
            .to_vec()
    }
}
