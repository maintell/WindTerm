//! 认证路径：密码、以及 password 被拒后回落到 keyboard-interactive（`SEC-002`）。
//!
//! mock 里用户 `kbd` **只认 keyboard-interactive**：`auth_password` 只接受 `tester`，
//! 所以这条用例走的就是「服务端关掉了 PasswordAuthentication」那种部署。

use wt_ssh::testing::MockSshServer;
use wt_ssh::{HostKeyPolicy, SshConfig, SshConnection};

fn cfg(port: u16, user: &str) -> SshConfig {
    SshConfig {
        host: "127.0.0.1".into(),
        port,
        user: user.into(),
        connect_timeout_secs: 5,
        ..Default::default()
    }
}

#[tokio::test]
async fn password_auth_connects() {
    let server = MockSshServer::start().await;
    let conn = SshConnection::connect_password(
        &cfg(server.port, "tester"),
        "secret",
        HostKeyPolicy::AcceptAll,
    )
    .await
    .expect("tester/secret 应能连上");
    drop(conn);
}

#[tokio::test]
async fn falls_back_to_keyboard_interactive() {
    let server = MockSshServer::start().await;
    // `kbd` 的密码认证会被拒，只有 keyboard-interactive 能过；
    // 客户端必须自己回落，否则这类部署下用户永远连不上。
    let conn = SshConnection::connect_password(
        &cfg(server.port, "kbd"),
        "secret",
        HostKeyPolicy::AcceptAll,
    )
    .await
    .expect("password 被拒后应回落到 keyboard-interactive");
    drop(conn);
}

#[tokio::test]
async fn wrong_password_is_reported_as_auth_failure() {
    let server = MockSshServer::start().await;
    let err = SshConnection::connect_password(
        &cfg(server.port, "kbd"),
        "wrong",
        HostKeyPolicy::AcceptAll,
    )
    .await
    .err()
    .expect("密码错必须失败");
    assert_eq!(err.code, "SSH_AUTH_FAILED", "错误码要稳定，界面靠它区分问题");
    assert!(!err.hints.is_empty(), "认证失败必须给可执行建议");
}
