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
//! - 收到数据：回 `echo:<原文>`；以 `\e[M` 开头的鼠标报文回 `MOUSE`（验鼠标上报）、
//!   输入含 `__gbk__` 回 GBK 字节的「中文」（验编码）、
//!   `__truecolor__` 回 24 位色序列（验 Truecolor）、`__wide__` 回两个 CJK 字符（验宽字符）、
//!   `__mouseon__` 回开启鼠标上报的序列（验鼠标模式）
//! - `exec_request`：回 `ran:<命令>\r\n`，退出码 0

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use russh::server::{Auth, Msg, Server as _, Session};
use russh::{Channel, ChannelId};use russh_sftp::protocol::{Attrs, Data, File, FileAttributes, Handle, Name, Status, StatusCode};
use tokio::net::TcpListener;
use tokio::sync::Mutex as AsyncMutex;

/// mock 的远端文件系统：路径 → 内容。目录靠路径前缀体现，够 SFTP 测试用。
pub type MockFs = Arc<AsyncMutex<HashMap<String, Vec<u8>>>>;

/// mock 的符号链接表：链接路径 → 目标（`FIL-002`）。目标可以指到不存在的路径，
/// 那就是断链——客户端必须能分辨，否则界面上只能点进去才报错。
pub type MockLinks = Arc<AsyncMutex<HashMap<String, String>>>;

/// mock 的权限位覆盖表：路径 → `st_mode`（`FIL-002` 的 `SETSTAT`）。
/// 没被改过的路径用 readdir 里的默认值（文件 0644、目录 0755）。
pub type MockModes = Arc<AsyncMutex<HashMap<String, u32>>>;

/// 内存文件系统上的 SFTP 服务端（只实现列目录/读/写/stat）。
///
/// 刻意不完整——它的价值是让「客户端真的会讲 SFTP」可验证，
/// 不是替代真实 sshd。
pub struct MemSftp {
    fs: MockFs,
    links: MockLinks,
    modes: MockModes,
    dir_sent: bool,
}

impl MemSftp {
    pub fn new(fs: MockFs, links: MockLinks, modes: MockModes) -> Self {
        Self {
            fs,
            links,
            modes,
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
        // `/noperm` 一律拒绝（`FIL-001` AC-4）：用来验「权限不足要说清楚，而不是显示空目录」
        if path.starts_with("/noperm") {
            return Err(StatusCode::PermissionDenied);
        }
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
        let modes = self.modes.lock().await;
        // 先快照键：判断「这一项是不是目录」要再查一遍前缀，边迭代边借用过不了编译
        let keys: Vec<String> = fs.keys().cloned().collect();
        let files = keys
            .iter()
            .filter_map(|path| path.strip_prefix(&prefix))
            // 空目录用「路径以 / 结尾」表示，所以允许一层尾斜杠；
            // 更深的层级仍要排除，否则会把孙辈当成本目录的条目
            .filter(|rest| {
                !rest.is_empty()
                    && (!rest.contains('/') || (rest.ends_with('/') && rest.matches('/').count() == 1))
            })
            .map(|name| {
                let name = name.trim_end_matches('/');
                let full = format!("{prefix}{name}");
                // 没有独立目录表，一个路径「是目录」当且仅当存在它的子项
                let is_dir = keys.iter().any(|p| p.starts_with(&format!("{full}/")));
                // 不能用 `FileAttributes::dummy()`：它把 permissions 写死成
                // `0o777 | S_IFDIR`，于是每个条目都被报成目录，界面上给文件加个 `/`。
                // 这会让「列目录」看起来对、`is_dir` 全错——测试保真度的问题最难发现。
                // `SETSTAT` 改过的路径优先：否则改完权限再列目录又变回默认值，
                // 用户会以为改失败了
                let default_mode = if is_dir {
                    0o755 | 0o040000 // S_IFDIR
                } else {
                    0o644 | 0o100000 // S_IFREG
                };
                let mut attrs = FileAttributes::empty();
                attrs.permissions = Some(modes.get(&full).copied().unwrap_or(default_mode));
                attrs.size = Some(if is_dir {
                    0
                } else {
                    fs.get(&full).map(|v| v.len() as u64).unwrap_or(0)
                });
                File::new(name, attrs)
            })
            .collect::<Vec<_>>();
        // 符号链接单独一张表：`entries` 只列本层，属性里标成 S_IFLNK，
        // 客户端靠它区分「链接」与「文件」
        let mut files = files;
        let links = self.links.lock().await;
        for (path, target) in links.iter() {
            let Some(rest) = path.strip_prefix(&prefix) else {
                continue;
            };
            if rest.is_empty() || rest.contains('/') {
                continue;
            }
            let mut attrs = FileAttributes::empty();
            attrs.permissions = Some(0o777 | 0o120000); // S_IFLNK
            attrs.size = Some(target.len() as u64);
            files.push(File::new(rest, attrs));
        }
        Ok(Name { id, files })
    }

    /// 建目录：用「路径以 / 结尾 + 空内容」表示空目录，不引入第二套表。
    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        _attrs: FileAttributes,
    ) -> Result<Status, StatusCode> {
        let mut fs = self.fs.lock().await;
        let key = format!("{}/", path.trim_end_matches('/'));
        if fs.contains_key(&key) || fs.contains_key(path.trim_end_matches('/')) {
            return Err(StatusCode::Failure);
        }
        fs.insert(key, Vec::new());
        Ok(ok_status(id))
    }

    async fn rmdir(&mut self, id: u32, path: String) -> Result<Status, StatusCode> {
        let mut fs = self.fs.lock().await;
        let key = format!("{}/", path.trim_end_matches('/'));
        if !fs.contains_key(&key) {
            return Err(StatusCode::NoSuchFile);
        }
        // 与真实服务端一致：非空目录不许删（`remove_dir` 的提示里也是这么说的）
        if fs
            .keys()
            .any(|p| p != &key && p.starts_with(&format!("{}/", path.trim_end_matches('/'))))
        {
            return Err(StatusCode::Failure);
        }
        fs.remove(&key);
        Ok(ok_status(id))
    }

    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, StatusCode> {
        let mut fs = self.fs.lock().await;
        match fs.remove(&filename) {
            Some(_) => Ok(ok_status(id)),
            None => Err(StatusCode::NoSuchFile),
        }
    }

    async fn rename(
        &mut self,
        id: u32,
        oldpath: String,
        newpath: String,
    ) -> Result<Status, StatusCode> {
        // 权限位表要跟着路径一起搬：真实服务端 `rename` 不换 inode，之前 `SETSTAT`
        // 设过的权限仍在；mock 分两张表存，只搬内容的话「改名后的权限」会退回默认值，
        // 「保留原文件权限位」这类断言就永远看不到真值。
        let mut pairs: Vec<(String, String)> = Vec::new();
        {
            let mut fs = self.fs.lock().await;
            if let Some(data) = fs.remove(&oldpath) {
                fs.insert(newpath.clone(), data);
                pairs.push((oldpath.clone(), newpath.clone()));
            } else {
                // 目录：把整棵子树按前缀搬过去
                let from = format!("{}/", oldpath.trim_end_matches('/'));
                let moved: Vec<(String, Vec<u8>)> = fs
                    .keys()
                    .filter(|k| k.starts_with(&from))
                    .map(|k| (k.clone(), fs.get(k).cloned().unwrap_or_default()))
                    .collect();
                if moved.is_empty() {
                    return Err(StatusCode::NoSuchFile);
                }
                let to = format!("{}/", newpath.trim_end_matches('/'));
                for (k, v) in moved {
                    fs.remove(&k);
                    let target = format!("{to}{}", &k[from.len()..]);
                    pairs.push((k.clone(), target.clone()));
                    fs.insert(target, v);
                }
            }
        }
        let mut modes = self.modes.lock().await;
        for (from, to) in pairs {
            // 目标原有的权限记录必须先丢掉：`rename` 换掉的是 inode，目标原来的
            // 属性不再存在。留着它会让「临时文件没设权限」也看起来是保留成功的
            // ——变异验证就是这么发现用例没生效的。
            modes.remove(&to);
            if let Some(mode) = modes.remove(&from) {
                modes.insert(to, mode);
            }
        }
        Ok(ok_status(id))
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
        pflags: russh_sftp::protocol::OpenFlags,
        _attrs: FileAttributes,
    ) -> Result<Handle, StatusCode> {
        // TRUNC 必须真的清空：真实 sshd 在 O_TRUNC 时会这么做。
        // mock 不模拟它，「覆盖成更短的内容」这类 bug 在测试里就看不出来——
        // 客户端看着没问题，服务端却没截断，尾部留着上一次的旧字节。
        if pflags
            .contains(russh_sftp::protocol::OpenFlags::TRUNCATE)
        {
            self.fs.lock().await.insert(filename.clone(), Vec::new());
        }
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
        let size = {
            let fs = self.fs.lock().await;
            match fs.get(&path) {
                Some(content) => content.len() as u64,
                None => return Err(StatusCode::NoSuchFile),
            }
        };
        // 权限位要跟 `readdir` 用同一套（`SETSTAT` 改过的优先）。
        // 不能再用 `FileAttributes::dummy()`：它把 permissions 写死成 `0o777|S_IFDIR`，
        // 文件会被看成目录——客户端照这个值决定「保留什么权限位」时会拿到假值。
        let mode = self
            .modes
            .lock()
            .await
            .get(&path)
            .copied()
            .unwrap_or(0o644 | 0o100000);
        let mut attrs = FileAttributes::empty();
        attrs.size = Some(size);
        attrs.permissions = Some(mode);
        Ok(Attrs { id, attrs })
    }

    /// 改元数据（`FIL-002` 的 `SETSTAT`）：这里只认权限位，其它字段照收不报错，
    /// 但不会假装支持（`uid/gid/mtime` 尚未实现，mock 也没法模拟）。
    async fn setstat(
        &mut self,
        id: u32,
        path: String,
        attrs: FileAttributes,
    ) -> Result<Status, StatusCode> {
        let exists = self.fs.lock().await.contains_key(&path)
            || self.links.lock().await.contains_key(&path);
        if !exists {
            return Err(StatusCode::NoSuchFile);
        }
        if let Some(mode) = attrs.permissions {
            self.modes.lock().await.insert(path, mode);
        }
        Ok(ok_status(id))
    }

    /// 读链接目标（`FIL-002`）。协议回的 `Name` 里第一条的文件名就是目标，
    /// 客户端（russh-sftp）正是这么取的。
    async fn readlink(&mut self, id: u32, path: String) -> Result<Name, StatusCode> {
        let links = self.links.lock().await;
        match links.get(&path) {
            Some(target) => {
                let mut attrs = FileAttributes::empty();
                attrs.permissions = Some(0o777 | 0o120000); // S_IFLNK
                attrs.size = Some(target.len() as u64);
                Ok(Name {
                    id,
                    files: vec![File::new(target.clone(), attrs)],
                })
            }
            None => Err(StatusCode::NoSuchFile),
        }
    }
}

struct MockServer {
    fs: MockFs,
    links: MockLinks,
    modes: MockModes,
}

impl russh::server::Server for MockServer {
    type Handler = MockHandler;
    fn new_client(&mut self, _peer: Option<std::net::SocketAddr>) -> MockHandler {
        MockHandler {
            channels: Arc::new(AsyncMutex::new(HashMap::new())),
            subsystems: Arc::new(AsyncMutex::new(std::collections::HashSet::new())),
            fs: self.fs.clone(),
            links: self.links.clone(),
            modes: self.modes.clone(),
            input_buf: String::new(),
            forward_stops: HashMap::new(),
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
    /// SFTP 子系统的符号链接表（`FIL-002`）
    links: MockLinks,
    /// SFTP 子系统的权限位覆盖表（`SETSTAT`）
    modes: MockModes,
    /// shell 收到的输入累积（按字符截断）。客户端是**逐键**发的，
    /// 想识别一段词就必须累积，否则永远匹配不到整词。
    input_buf: String,
    /// 已建立的远程转发（`-R`）：`(address, port) → 停止信号`。
    /// `cancel_tcpip_forward` 靠它让监听真的停下，否则用例只能验「开始监听」。
    forward_stops: HashMap<(String, u32), tokio::sync::watch::Sender<bool>>,
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

    /// keyboard-interactive（`SEC-002`）：用户 `kbd` **只走这条路**（`auth_password`
    /// 只认 `tester`），用来验「这种认证方式下密码也能被保存」——规格点名的
    /// MobaXterm 已知缺陷就是这里不保存、用户每次都要重输。
    async fn auth_keyboard_interactive<'a>(
        &'a mut self,
        user: &str,
        _submethods: &str,
        response: Option<russh::server::Response<'a>>,
    ) -> Result<Auth, Self::Error> {
        if user != "kbd" {
            return Ok(Auth::reject());
        }
        match response {
            None => Ok(Auth::Partial {
                name: "Keyboard-interactive".into(),
                instructions: "".into(),
                prompts: vec![("Password: ".into(), false)].into(),
            }),
            Some(mut r) => {
                let answer = r
                    .next()
                    .map(|b| String::from_utf8_lossy(&b).to_string())
                    .unwrap_or_default();
                if answer == "secret" {
                    Ok(Auth::Accept)
                } else {
                    Ok(Auth::reject())
                }
            }
        }
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
        // 用来复现「跳板机禁止转发」（`SES-024` 异常表）：
        // 真实 sshd 在 `AllowTcpForwarding no` 时正是这样拒绝的
        if host_to_connect == "deny-forward" {
            reply
                .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return Ok(());
        }
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
                let handler = MemSftp::new(self.fs.clone(), self.links.clone(), self.modes.clone());
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

    async fn channel_eof(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        // 客户端说「不再输入了」（`Ctrl+D`）：真实 sshd 会让会话收尾退出，
        // 这里直接关通道，客户端的主循环才能结束（否则它会一直等下去）
        session.close(channel)?;
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
        // 鼠标上报（`TER-022`）：X10 编码的报文是 `\e[M` 后跟三个原始字节，
        // 原样回显会被终端当成控制序列执行（`CSI M` 是删行），所以回一行纯文本，
        // 让验收能确认「字节真的到服务端了」，而不是只看前端有没有发。
        if data.starts_with(b"\x1b[M") {
            session.data(channel, b"MOUSE\r\n".to_vec())?;
            return Ok(());
        }
        // SGR 编码（`?1006h`）的报文是 `\e[<b;x;yM`：全可打印，但同样只回一行标记，
        // 让验收能确认「字节到了服务端」而不是只在前端记了一笔。
        if data.starts_with(b"\x1b[<") {
            session.data(channel, b"MOUSE\r\n".to_vec())?;
            return Ok(());
        }
        // 验收要验「编码切换」（`TER-006`）：输入里带 `__gbk__` 时回一段 **GBK 字节**
        // 的中文。只有按 GBK 解码才看得见「中文」，按 UTF-8 解是一串替换符——
        // 这比断言「下拉框变了」有意义得多。
        if String::from_utf8_lossy(data).contains("__gbk__") {
            session.data(channel, b"\xd6\xd0\xce\xc4\r\n".to_vec())?;
            return Ok(());
        }
        // Truecolor（`TER-024`）：回一个 24 位前景色，验收去读单元格的实际颜色
        if String::from_utf8_lossy(data).contains("__truecolor__") {
            // 三字符标记：单字符 `X` 会和主机密钥指纹里的随机字符撞车，
            // 验收按行找会找到指纹那一行去
            session.data(channel, b"\x1b[38;2;18;52;86mXTC\x1b[0m\r\n".to_vec())?;
            return Ok(());
        }
        // 宽字符（`TER-025`）：两个 CJK 字符各占两列，验收读单元格宽度与光标列
        if String::from_utf8_lossy(data).contains("__wide__") {
            session.data(channel, "中文\r\n".as_bytes().to_vec())?;
            return Ok(());
        }
        // 鼠标上报（`TER-022`）：让客户端开启 1000 模式，之后的点击会变成鼠标序列
        if String::from_utf8_lossy(data).contains("__mouseon__") {
            session.data(channel, b"\x1b[?1000h".to_vec())?;
            return Ok(());
        }
        // 1002（按键事件跟踪）+ 1006（SGR 编码）：X10 编码把坐标压进单个字节，
        // ≥224 就溢出——点终端右下角必然踩到。所以这两种模式也要能开、能发对。
        if String::from_utf8_lossy(data).contains("__mousesgr__") {
            session.data(channel, b"\x1b[?1002h\x1b[?1006h".to_vec())?;
            return Ok(());
        }
        // 大量行（`TER-020` 的滚动动作）：验收需要一个真的能滚起来的缓冲
        if String::from_utf8_lossy(data).contains("__manylines__") {
            let mut out = String::new();
            for i in 1..=120 {
                out.push_str(&format!("line {i}\r\n"));
            }
            session.data(channel, out.into_bytes())?;
            return Ok(());
        }
        // 远端标题（`TER-001` 的 `OSC 2`）：真实 shell 里是 vim/top 之类在设，
        // 客户端应当把它显示成标签名
        if String::from_utf8_lossy(data).contains("__title__") {
            session.data(channel, "\u{1b}]2;远端标题-vim\u{7}".as_bytes().to_vec())?;
            return Ok(());
        }
        // 超长标题：客户端必须截断，否则标签栏会被一个远端撑坏
        if String::from_utf8_lossy(data).contains("__titlelong__") {
            let long: String = "x".repeat(60);
            session.data(channel, format!("\u{1b}]2;{long}\u{7}").into_bytes())?;
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
    /// `-R`：按客户端请求在**服务端本地**监听，把进来的连接转成
    /// `forwarded-tcpip` 通道发回客户端。真实 sshd 就是这个行为。
    ///
    /// `port` 是 `&mut u32`：请求 0 时由这里绑定实际端口并写回去。
    async fn tcpip_forward(
        &mut self,
        address: &str,
        port: &mut u32,
        session: &mut Session,
    ) -> Result<bool, Self::Error> {
        if address == "deny-forward" {
            return Ok(false);
        }
        let listener = match tokio::net::TcpListener::bind(format!("{address}:{port}")).await {
            Ok(l) => l,
            Err(_) => return Ok(false),
        };
        let actual = listener.local_addr().map(|a| a.port()).unwrap_or(*port as u16);
        *port = u32::from(actual);

        // 记住停止信号：`cancel_tcpip_forward` 要能让监听真的停下
        let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);
        self.forward_stops
            .insert((address.to_string(), u32::from(actual)), stop_tx);

        let handle = session.handle();
        let connect_address = address.to_string();
        // 转发通道也是「已接管」的：不登记的话 `data()` 里的 shell 回显会往
        // 同一条通道补一句 `echo:...`，把转发流量污染成乱码（与 direct-tcpip 同一个坑）
        let subsystems = self.subsystems.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    changed = stop_rx.changed() => {
                        if changed.is_err() || *stop_rx.borrow() {
                            break;
                        }
                    }
                    accepted = listener.accept() => {
                        let Ok((mut tcp, peer)) = accepted else { continue };
                        let handle = handle.clone();
                        let address = connect_address.clone();
                        let subsystems = subsystems.clone();
                        tokio::spawn(async move {
                            let channel = match handle
                                .channel_open_forwarded_tcpip(
                                    address,
                                    u32::from(actual),
                                    peer.ip().to_string(),
                                    u32::from(peer.port()),
                                )
                                .await
                            {
                                Ok(c) => c,
                                Err(_) => return,
                            };
                            subsystems.lock().await.insert(channel.id());
                            let mut stream = channel.into_stream();
                            let _ = tokio::io::copy_bidirectional(&mut tcp, &mut stream).await;
                        });
                    }
                }
            }
        });
        Ok(true)
    }

    async fn cancel_tcpip_forward(
        &mut self,
        address: &str,
        port: u32,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        match self.forward_stops.remove(&(address.to_string(), port)) {
            Some(tx) => {
                let _ = tx.send(true);
                Ok(true)
            }
            None => Ok(false),
        }
    }
}
pub struct MockSshServer {
    pub port: u16,
    /// 权限位覆盖：`SETSTAT` 改过的路径记在这里，列目录时优先生效
    pub modes: MockModes,
    /// SFTP 子系统的内存文件系统：用例在连接前预置、连接后检查
    pub fs: MockFs,
    /// 符号链接表：链接路径 → 目标（`FIL-002`）。目标不存在就是断链
    pub links: MockLinks,
}

impl MockSshServer {
    /// 在随机端口启动。返回后即可连接。
    pub async fn start() -> Self {
        let key = crate::keys::random_private_key(russh::keys::Algorithm::Ed25519)
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
            links: Arc::new(AsyncMutex::new(HashMap::new())),
            modes: Arc::new(AsyncMutex::new(HashMap::new())),
        }));
        let fs = server.fs.clone();
        let links = server.links.clone();
        let modes = server.modes.clone();
        tokio::spawn(server.run_on_socket(config, listener));

        // 给监听循环一点时间就绪，减少首连抖动
        tokio::time::sleep(Duration::from_millis(30)).await;

        Self {
            port,
            fs,
            links,
            modes,
        }
    }

    /// 生成一份可被服务端接受的 OpenSSH 私钥。
    ///
    /// 走生产同一条路径（`crate::keys::generate`）：测试与真实生成各写一份，
    /// 迟早会出现「测试里能过、真实生成却导不出」这种分叉。
    pub fn fresh_openssh_key(passphrase: Option<&str>) -> Vec<u8> {
        crate::keys::generate("ed25519", passphrase, "")
            .expect("生成密钥")
            .pem
    }
}
