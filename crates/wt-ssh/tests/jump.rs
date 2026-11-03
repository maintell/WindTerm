//! 跳板机单跳（`SES-024`）的端到端用例。
//!
//! 拓扑是两台进程内 mock 服务端 + 一条真实 TCP：
//!
//! ```text
//! 客户端 ──SSH──> mock A（跳板机） ──direct-tcpip（真实 TCP）──> mock B（目标）
//! ```
//!
//! 跳板机上那条 `direct-tcpip` 由 mock 实现，它连的是 `127.0.0.1:B`——所以
//! 「第二跳跑在一条真实 TCP 上」这件事是被证实的，不是模拟出来的。
//! 目标机上再跑一次 SSH 握手与认证，这只有在协议真的对的时候才可能成功。

use wt_ssh::testing::MockSshServer;
use wt_ssh::{Auth, HostKeyPolicy, SshConfig, SshConnection};

fn cfg(port: u16) -> SshConfig {
    SshConfig {
        host: "127.0.0.1".into(),
        port,
        user: "tester".into(),
        connect_timeout_secs: 5,
        ..Default::default()
    }
}

#[tokio::test]
async fn connects_to_target_through_jump_host() {
    let jump_server = MockSshServer::start().await;
    let target_server = MockSshServer::start().await;

    let jump_cfg = cfg(jump_server.port);
    let jump = SshConnection::connect_password(&jump_cfg, "secret", HostKeyPolicy::AcceptAll)
        .await
        .expect("登录跳板机");
    let jump_link = format!("127.0.0.1:{}", jump_server.port);

    let target_cfg = cfg(target_server.port);
    let target = wt_ssh::connect_via(
        &jump,
        &jump_link,
        &target_cfg,
        &Auth::Password("secret"),
        HostKeyPolicy::AcceptAll,
    )
    .await
    .expect("经跳板机连上目标");

    // 关键证据：在第二跳上真的能执行命令（mock 的回执是 `ran:<cmd>`）
    let out = target.exec("whoami").await.expect("在目标机上执行命令");
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        stdout.contains("ran:whoami"),
        "第二跳必须是真正的 SSH 会话，实际：{stdout}"
    );

    // 两跳各自独立有效：开完第二跳后，跳板机自己还能正常执行
    let jump_out = jump.exec("whoami").await.expect("跳板机仍可用");
    assert!(
        String::from_utf8_lossy(&jump_out.stdout).contains("ran:whoami"),
        "跳板机连接不该被第二跳影响"
    );
}

#[tokio::test]
async fn target_auth_failure_names_the_hop_and_address() {
    let jump_server = MockSshServer::start().await;
    let target_server = MockSshServer::start().await;

    let jump = SshConnection::connect_password(&cfg(jump_server.port), "secret", HostKeyPolicy::AcceptAll)
        .await
        .expect("登录跳板机");
    let jump_link = format!("127.0.0.1:{}", jump_server.port);
    let target_cfg = cfg(target_server.port);
    let target_link = format!("127.0.0.1:{}", target_server.port);

    let err = wt_ssh::connect_via(
        &jump,
        &jump_link,
        &target_cfg,
        &Auth::Password("wrong-password"),
        HostKeyPolicy::AcceptAll,
    )
    .await
    .err()
    .expect("密码错误必须失败");

    // AC-2：错误里要出现「第 2 跳」和具体地址，否则多跳链路里根本定位不到
    assert!(err.message.contains("第 2 跳"), "实际：{}", err.message);
    assert!(err.message.contains(&target_link), "实际：{}", err.message);
    // 错误码仍然是「认证失败」——换成笼统的跳板错误会让人以为是网络问题
    assert_eq!(err.code, wt_common::codes::SSH_AUTH_FAILED, "实际：{}", err.code);
}

#[tokio::test]
async fn jump_host_denying_forwarding_says_so() {
    let jump_server = MockSshServer::start().await;
    let jump = SshConnection::connect_password(&cfg(jump_server.port), "secret", HostKeyPolicy::AcceptAll)
        .await
        .expect("登录跳板机");

    // `deny-forward` 是 mock 的约定：按 AdministrativelyProhibited 拒绝，
    // 与真实 sshd 在 AllowTcpForwarding no 时的行为一致
    let mut target_cfg = cfg(1);
    target_cfg.host = "deny-forward".into();

    let err = wt_ssh::connect_via(
        &jump,
        "127.0.0.1:jump",
        &target_cfg,
        &Auth::Password("secret"),
        HostKeyPolicy::AcceptAll,
    )
    .await
    .err()
    .expect("禁止转发时必须失败");

    assert_eq!(err.code, wt_common::codes::SSH_FORWARD_DENIED);
    assert!(
        err.message.contains("AllowTcpForwarding"),
        "错误里要直接点名原因，实际：{}",
        err.message
    );
}

#[tokio::test]
async fn unreachable_target_through_jump_reports_first_hop() {
    let jump_server = MockSshServer::start().await;
    let jump = SshConnection::connect_password(&cfg(jump_server.port), "secret", HostKeyPolicy::AcceptAll)
        .await
        .expect("登录跳板机");
    let jump_link = format!("127.0.0.1:{}", jump_server.port);

    // 目标端口先占后放，拿到一个几乎不可能被复用的端口
    let probe = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let dead_port = probe.local_addr().unwrap().port();
    drop(probe);

    let err = wt_ssh::connect_via(
        &jump,
        &jump_link,
        &cfg(dead_port),
        &Auth::Password("secret"),
        HostKeyPolicy::AcceptAll,
    )
    .await
    .err()
    .expect("目标不可达时必须失败");

    // 失败发生在跳板机（它连不上目标），所以报第 1 跳并带上目标地址
    assert!(err.message.contains("第 1 跳"), "实际：{}", err.message);
    assert!(
        err.message.contains(&dead_port.to_string()),
        "实际：{}",
        err.message
    );
}
