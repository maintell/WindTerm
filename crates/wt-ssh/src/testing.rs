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

use std::sync::Arc;
use std::time::Duration;

use russh::keys::ssh_key::rand_core::{TryCryptoRng, TryRng};
use russh::server::{Auth, Msg, Server as _, Session};
use russh::{Channel, ChannelId};
use tokio::net::TcpListener;

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

struct MockServer;

impl russh::server::Server for MockServer {
    type Handler = MockHandler;
    fn new_client(&mut self, _peer: Option<std::net::SocketAddr>) -> MockHandler {
        MockHandler
    }
}

struct MockHandler;

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
        _channel: Channel<Msg>,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
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
        let echo = format!("echo:{}", String::from_utf8_lossy(data)).into_bytes();
        session.data(channel, echo)?;
        Ok(())
    }
}

/// 已启动的 mock 服务端。`port` 指向 `127.0.0.1`。
pub struct MockSshServer {
    pub port: u16,
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

        let server: &'static mut MockServer = Box::leak(Box::new(MockServer));
        tokio::spawn(server.run_on_socket(config, listener));

        // 给监听循环一点时间就绪，减少首连抖动
        tokio::time::sleep(Duration::from_millis(30)).await;

        Self { port }
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
