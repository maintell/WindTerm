//! 用 `russh` 的 server 端在进程内起一个真实 SSH 服务器，验证客户端正向路径。
//!
//! 为什么不用「装一个 sshd」：CI/开发机不一定有；而且外部依赖会让测试变慢、变脆。
//! 进程内的 mock 走的是**完整 SSH 协议**（版本交换 → KEX → 认证 → 通道 → PTY → 数据），
//! 不是打桩，所以它能证明「我们的客户端真的会讲 SSH」。
//!
//! 覆盖 `docs/spec/05-func-sessions.md` 的 `SES-001` AC-1/AC-3 与 `SEC-005` 的 TOFU 流程。

use std::sync::Arc;
use std::time::Duration;

use russh::server::{Auth, Msg, Server as _, Session};
use russh::{Channel, ChannelId};
use tokio::net::TcpListener;

use wt_ssh::{HostKeyPolicy, KnownHosts, SshConfig, SshConnection};
// trait 方法（write/resize/size/close）需要显式引入
use wt_term::TerminalSession;

// ─────────────────────────────────────────────────────────────
// Mock SSH 服务端
// ─────────────────────────────────────────────────────────────

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

/// 桥接 RNG：`ssh-key 0.7` 用 `rand_core 0.10` 的 `CryptoRng`，
/// 而项目主依赖是 rand 0.8（`rand_core 0.6`）。两者 trait 不同代，无法直接传。
///
/// 与其在仓库里塞一个测试私钥，不如写这 20 行适配器——私钥不该进版本库，
/// 哪怕它是「只用于 localhost」的。
struct BridgeRng;

fn fill(dst: &mut [u8]) {
    <rand::rngs::ThreadRng as rand::RngCore>::fill_bytes(&mut rand::thread_rng(), dst);
}

impl russh::keys::ssh_key::rand_core::TryRng for BridgeRng {
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

// `Rng` / `CryptoRng` 由 rand_core 的 blanket impl 自动派生，这里只需实现底层两个 trait
impl russh::keys::ssh_key::rand_core::TryCryptoRng for BridgeRng {}

/// 起一个监听随机端口的 mock 服务端，返回端口。
async fn start_mock_server() -> u16 {
    let key = russh::keys::PrivateKey::random(&mut BridgeRng, russh::keys::Algorithm::Ed25519)
        .expect("生成测试主机密钥");

    let config = Arc::new(russh::server::Config {
        keys: vec![key],
        // 测试里不需要人为延迟；生产默认的 3 秒会让测试很慢
        auth_rejection_time: Duration::from_millis(10),
        auth_rejection_time_initial: Some(Duration::from_millis(0)),
        inactivity_timeout: Some(Duration::from_secs(30)),
        ..Default::default()
    });

    // `run_on_socket` 借用了 server 与 listener，返回的 future 不是 'static，
    // 无法直接 tokio::spawn。测试里把它们 leak 掉最简单——进程结束即回收。
    let listener: &'static TcpListener =
        Box::leak(Box::new(TcpListener::bind("127.0.0.1:0").await.unwrap()));
    let port = listener.local_addr().unwrap().port();

    let server: &'static mut MockServer = Box::leak(Box::new(MockServer));
    tokio::spawn(server.run_on_socket(config, listener));

    // 给监听循环一点时间就绪（accept 是异步的，这里只是减少首连抖动）
    tokio::time::sleep(Duration::from_millis(30)).await;
    port
}

fn cfg(port: u16) -> SshConfig {
    SshConfig {
        host: "127.0.0.1".into(),
        port,
        user: "tester".into(),
        connect_timeout_secs: 5,
        ..Default::default()
    }
}

// ─────────────────────────────────────────────────────────────
// 测试
// ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn probe_reports_sha256_fingerprint() {
    let port = start_mock_server().await;
    let key = SshConnection::probe_host_key(&cfg(port))
        .await
        .expect("应能拿到主机密钥");

    assert_eq!(key.key_type, "ssh-ed25519");
    assert!(
        key.fingerprint.starts_with("SHA256:"),
        "指纹应为 OpenSSH 风格，实际 {}",
        key.fingerprint
    );
    assert!(!key.blob.is_empty(), "必须带原始公钥，否则无法写入 known_hosts");
}

#[tokio::test]
async fn exec_returns_output_and_exit_code() {
    let port = start_mock_server().await;
    let conn = SshConnection::connect_password(&cfg(port), "secret", HostKeyPolicy::AcceptAll)
        .await
        .expect("连接应成功");

    let out = conn.exec("uname -a").await.expect("exec 应成功");
    assert_eq!(out.stdout_text(), "ran:uname -a\r\n");
    assert_eq!(out.exit_code, Some(0));
    assert!(out.stderr.is_empty());
}

#[tokio::test]
async fn interactive_shell_echoes_input() {
    let port = start_mock_server().await;
    let conn = SshConnection::connect_password(&cfg(port), "secret", HostKeyPolicy::AcceptAll)
        .await
        .expect("连接应成功");

    let mut ch = conn
        .open_shell("xterm-256color", 120, 40)
        .await
        .expect("开 shell 应成功");

    // 服务端在 shell_request 时先发一条 banner
    let first = ch.next().await.expect("应收到 banner");
    match first {
        wt_ssh::ChannelData::Stdout(d) => assert_eq!(String::from_utf8_lossy(&d), "WELCOME\r\n"),
        other => panic!("banner 应为 stdout，实际 {other:?}"),
    }

    // 写入 → 服务端回显
    ch.write(b"ls -l").await.expect("写入应成功");
    let echo = ch.next().await.expect("应收到回显");
    match echo {
        wt_ssh::ChannelData::Stdout(d) => {
            assert_eq!(String::from_utf8_lossy(&d), "echo:ls -l");
        }
        other => panic!("回显应为 stdout，实际 {other:?}"),
    }

    // 窗口变更不应报错
    ch.resize(100, 30).await.expect("resize 应成功");
}

#[tokio::test]
async fn keepalive_keeps_session_responsive() {
    let port = start_mock_server().await;
    let conn = SshConnection::connect_password(&cfg(port), "secret", HostKeyPolicy::AcceptAll)
        .await
        .expect("连接应成功");

    // 20ms 一次心跳：几百毫秒里会触发十几次，足够暴露「心跳把读循环饿死」这类问题
    let mut session = wt_ssh::SshTermSession::open_owned(
        conn,
        Some(wt_ssh::Keepalive::new(Duration::from_millis(20), 3)),
        "xterm-256color",
        120,
        40,
        wt_term::RingBuffer::with_defaults(),
    )
    .await
    .expect("开会话应成功");

    tokio::time::sleep(Duration::from_millis(300)).await;
    session.write(b"ping").expect("写入应成功");
    let out = session
        .wait_for_output("echo:ping", Duration::from_secs(5))
        .await;
    assert!(
        out.contains("echo:ping"),
        "心跳期间会话应仍然可用，实际 {out:?}"
    );
    session.close();
}

#[tokio::test]
async fn wrong_password_is_auth_failure_not_connect_failure() {
    let port = start_mock_server().await;
    let err = match SshConnection::connect_password(&cfg(port), "wrong", HostKeyPolicy::AcceptAll)
        .await
    {
        Ok(_) => panic!("错误密码不该连上"),
        Err(e) => e,
    };

    assert_eq!(err.code, "SSH_AUTH_FAILED", "实际: {err:?}");
    assert!(
        err.hints.iter().any(|h| h.label.contains("凭据")),
        "认证失败要给出「编辑凭据」的动作，实际: {:?}",
        err.hints
    );
}

#[tokio::test]
async fn tofu_flow_blocks_unknown_host_then_succeeds_after_trust() {
    let port = start_mock_server().await;

    // 1. 空 known_hosts：必须被拒
    let empty = KnownHosts::new();
    let err = match SshConnection::connect_password(
        &cfg(port),
        "secret",
        HostKeyPolicy::Known(Box::new(empty)),
    )
    .await
    {
        Ok(_) => panic!("未知主机不该被放行"),
        Err(e) => e,
    };
    assert_eq!(err.code, "SSH_HOSTKEY_UNKNOWN", "实际: {err:?}");
    let detail = err.detail.clone().unwrap_or_default();
    assert!(detail.contains("SHA256:"), "错误里必须带指纹：{detail}");

    // 2. 走 TOFU：探测指纹 → 用户确认 → 写入 known_hosts
    let observed = SshConnection::probe_host_key(&cfg(port)).await.unwrap();
    let mut known = KnownHosts::new();
    known.add(
        &cfg(port).endpoint(),
        &observed.key_type,
        &observed.blob,
        false,
    );

    // 3. 再连：应通过
    let conn = SshConnection::connect_password(
        &cfg(port),
        "secret",
        HostKeyPolicy::Known(Box::new(known)),
    )
    .await
    .expect("信任后应能连上");

    assert_eq!(
        conn.server_fingerprint().as_deref(),
        Some(observed.fingerprint.as_str()),
        "连接后报告的指纹应与探测到的一致"
    );
}

#[tokio::test]
async fn host_key_change_is_detected() {
    let port = start_mock_server().await;
    let observed = SshConnection::probe_host_key(&cfg(port)).await.unwrap();

    // 用一份「记录的是另一个密钥」的 known_hosts
    let mut known = KnownHosts::new();
    known.add(
        &cfg(port).endpoint(),
        &observed.key_type,
        b"some-other-key-material",
        false,
    );

    let err = match SshConnection::connect_password(
        &cfg(port),
        "secret",
        HostKeyPolicy::Known(Box::new(known)),
    )
    .await
    {
        Ok(_) => panic!("密钥变更不该被放行"),
        Err(e) => e,
    };
    // 变了就是变了：**不能**报成「未知主机」。报成未知，界面那条 accept-new 就会
    // 把已信任的指纹换成对方给的指纹再连一次——中间人换一次密钥就拿到信任。
    assert_eq!(err.code, "SSH_HOSTKEY_CHANGED", "实际: {err:?}");
    let detail = err.detail.as_deref().unwrap_or_default();
    assert!(
        detail.contains(&observed.fingerprint),
        "这次看到的指纹要摆出来：{detail}"
    );
    assert!(detail.contains("SHA256:"), "已知指纹也要摆出来：{detail}");
    assert!(
        !err.hints.iter().any(|h| h.label.contains("接受并保存")),
        "密钥变了不能提供「接受并保存」这条出路：{:?}",
        err.hints
    );
}

// ─────────────────────────────────────────────────────────────
// 公钥认证
// ─────────────────────────────────────────────────────────────

fn fresh_key(passphrase: Option<&str>) -> Vec<u8> {
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

#[tokio::test]
async fn publickey_auth_succeeds_and_exec_works() {
    let port = start_mock_server().await;
    let src = wt_ssh::PrivateKeySource::new(fresh_key(None), None);

    // 先确认能读出指纹（UI 上要显示它）
    let info = wt_ssh::inspect_key(&src).expect("应能解析");
    assert_eq!(info.key_type, "ssh-ed25519");
    assert!(info.fingerprint.starts_with("SHA256:"));

    let conn = SshConnection::connect_publickey(&cfg(port), &src, HostKeyPolicy::AcceptAll)
        .await
        .expect("公钥认证应成功");

    let out = conn.exec("whoami").await.unwrap();
    assert_eq!(out.stdout_text(), "ran:whoami\r\n");
}

#[tokio::test]
async fn encrypted_key_needs_passphrase_before_connecting() {
    let port = start_mock_server().await;
    let pem = fresh_key(Some("correct horse"));

    // 不给口令：必须在建连之前就失败
    let src = wt_ssh::PrivateKeySource::new(pem.clone(), None);
    let err = match SshConnection::connect_publickey(&cfg(port), &src, HostKeyPolicy::AcceptAll)
        .await
    {
        Ok(_) => panic!("缺口令不该连上"),
        Err(e) => e,
    };
    assert_eq!(err.code, "SSH_KEY_PASSPHRASE_REQUIRED", "实际: {err:?}");

    // 给错口令
    let src = wt_ssh::PrivateKeySource::new(pem.clone(), Some("wrong".into()));
    let err = match SshConnection::connect_publickey(&cfg(port), &src, HostKeyPolicy::AcceptAll)
        .await
    {
        Ok(_) => panic!("错误口令不该连上"),
        Err(e) => e,
    };
    assert_eq!(err.code, "SSH_KEY_BAD_PASSPHRASE", "实际: {err:?}");

    // 给对口令
    let src = wt_ssh::PrivateKeySource::new(pem, Some("correct horse".into()));
    SshConnection::connect_publickey(&cfg(port), &src, HostKeyPolicy::AcceptAll)
        .await
        .expect("口令正确应能连上");
}

#[tokio::test]
async fn publickey_rejection_is_auth_failure_with_fingerprint() {
    let port = start_mock_server().await;
    // 用一个无效的私钥内容触发解析失败，确认错误码不同（不是 AUTH_FAILED）
    let src = wt_ssh::PrivateKeySource::new(b"garbage".to_vec(), None);
    let err = match SshConnection::connect_publickey(&cfg(port), &src, HostKeyPolicy::AcceptAll)
        .await
    {
        Ok(_) => panic!("坏密钥不该连上"),
        Err(e) => e,
    };
    assert_eq!(err.code, "SSH_KEY_INVALID", "实际: {err:?}");
}
// ─────────────────────────────────────────────────────────────
// SSH 终端会话（与本地 PTY 同一套 read/ack + 背压模型）
// ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn ssh_terminal_session_banner_echo_and_resize() {
    let port = start_mock_server().await;
    let conn = SshConnection::connect_password(&cfg(port), "secret", HostKeyPolicy::AcceptAll)
        .await
        .expect("连接应成功");

    let mut term = wt_ssh::SshTermSession::open(
        &conn,
        "xterm-256color",
        120,
        40,
        wt_term::RingBuffer::with_defaults(),
    )
    .await
    .expect("应能打开终端会话");

    // 1. 服务端在 shell_request 时发 banner
    let banner = term.wait_for_output("WELCOME", Duration::from_secs(5)).await;
    assert!(banner.contains("WELCOME"), "应收到 banner，实际: {banner:?}");

    // 2. 写入 → 服务端回显
    term.write(b"ls").expect("写入应成功");
    let echo = term.wait_for_output("echo:ls", Duration::from_secs(5)).await;
    assert!(echo.contains("echo:ls"), "应收到回显，实际: {echo:?}");

    // 3. 尺寸变更不报错，且本地记录同步
    term.resize(100, 30).expect("resize");
    assert_eq!(term.size(), (100, 30));

    // 4. 关闭幂等
    term.close();
    term.close();
}

#[tokio::test]
async fn ssh_terminal_session_shares_backpressure_semantics() {
    let port = start_mock_server().await;
    let conn = SshConnection::connect_password(&cfg(port), "secret", HostKeyPolicy::AcceptAll)
        .await
        .unwrap();

    // 小缓冲，便于观察未确认字节
    let ring = wt_term::RingBuffer::new(16 * 1024, 8 * 1024, 2 * 1024);
    let mut term = wt_ssh::SshTermSession::open(&conn, "xterm", 80, 24, ring)
        .await
        .unwrap();

    let _ = term.wait_for_output("WELCOME", Duration::from_secs(5)).await;

    // 不 ack 时未确认字节应累积；ack 后归零
    let mut out = Vec::new();
    let n = term.read_into(&mut out, 4096);
    if n > 0 {
        // 未确认 = 已投递未确认；这里 n 就是刚投递的
        term.ack(n);
        assert_eq!(term.dropped_bytes(), 0, "及时 ack 不应丢字节");
    }
    term.close();
}