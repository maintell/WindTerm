//! SFTP 的 SSH 侧：子系统请求与错误映射。
//!
//! 协议本身（列目录/读/写）在 `src/sftp.rs` 的单元测试里用内存管道覆盖；
//! 这里验证的是另一半——**通道能不能开出来、失败时给的是什么错**。
//!
//! mock 服务端不支持 sftp 子系统（对 `subsystem_request` 回 failure），
//! 正好用来确认「服务端没开 sftp」这个最常见的失败场景有可读的提示。

use wt_ssh::testing::MockSshServer;
use wt_ssh::{HostKeyPolicy, SftpClient, SshConfig, SshConnection};

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
async fn subsystem_failure_surfaces_a_readable_error() {
    let server = MockSshServer::start().await;
    let conn = SshConnection::connect_password(&cfg(server.port), "secret", HostKeyPolicy::AcceptAll)
        .await
        .expect("连接应成功");

    let err = match SftpClient::open(&conn).await {
        Ok(_) => panic!("mock 不支持 sftp 子系统，不应该成功"),
        Err(e) => e,
    };
    assert_eq!(err.code, "SFTP_FAILED", "实际: {err:?}");
    assert!(
        err.hints.iter().any(|h| h.label.contains("sftp 子系统")),
        "提示要指向 sftp 子系统：{:?}",
        err.hints
    );
}
