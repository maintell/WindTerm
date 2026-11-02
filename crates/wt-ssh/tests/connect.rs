//! SSH 连接层的真实 socket 测试。
//!
//! 这里只验证「不需要真实 SSH 服务端」也能验证的部分：TCP 连接失败、非 SSH 服务端、
//! 超时与错误映射。**正向路径（握手成功、认证、开通道）需要真实 SSH 服务端**，
//! 本机未安装 sshd，因此该用例留待下一步用 russh 的 server 端在进程内做 mock。
//!
//! 之所以仍然写这组测试：错误映射是最容易被写错、也最影响用户体验的部分
//! （「连接失败」四个字没有信息量）。这组测试保证错误里带上了主机、端口与可执行建议。

use std::io::Write;
use std::net::TcpListener;
use std::time::Duration;

use wt_ssh::{HostKeyPolicy, SshConfig, SshConnection};

fn cfg(port: u16) -> SshConfig {
    SshConfig {
        host: "127.0.0.1".into(),
        port,
        user: "tester".into(),
        connect_timeout_secs: 3,
        ..Default::default()
    }
}

async fn expect_err(cfg: &SshConfig) -> wt_common::WtError {
    match SshConnection::connect_password(cfg, "pw", HostKeyPolicy::AcceptAll).await {
        Ok(_) => panic!("本应连接失败，却成功了"),
        Err(e) => e,
    }
}

#[tokio::test]
async fn closed_port_reports_endpoint_and_hints() {
    // 绑定后立即释放 → 得到一个确定关闭的端口
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);

    let err = expect_err(&cfg(port)).await;

    assert_eq!(err.code, "SSH_CONNECT_FAILED", "实际: {err:?}");
    assert!(
        err.message.contains(&format!("127.0.0.1:{port}")),
        "错误信息必须包含主机与端口，实际: {}",
        err.message
    );
    assert!(
        err.hints.iter().any(|h| h.label.contains("诊断")),
        "必须给出可执行建议，实际: {:?}",
        err.hints
    );
}

#[tokio::test]
async fn non_ssh_server_is_rejected_without_panic() {
    // 一个只会说 HTTP 的 TCP 服务端：SSH 版本交换必然失败
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();

    std::thread::spawn(move || {
        if let Ok((mut s, _)) = listener.accept() {
            let _ = s.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
            let _ = s.flush();
            std::thread::sleep(Duration::from_millis(300));
        }
    });

    let err = expect_err(&cfg(port)).await;
    assert!(
        err.code == "SSH_CONNECT_FAILED" || err.code == "SSH_CONNECT_TIMEOUT",
        "非 SSH 服务端应归类为连接/协议失败，实际: {err:?}"
    );
    // 关键：不能 panic，且错误可读
    assert!(!err.message.is_empty());
}

#[tokio::test]
async fn silent_server_hits_connect_timeout() {
    // 只 accept 不说话：必须靠超时兜底，不能永久挂住
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();

    std::thread::spawn(move || {
        if let Ok((_s, _)) = listener.accept() {
            std::thread::sleep(Duration::from_secs(5));
        }
    });

    let mut c = cfg(port);
    c.connect_timeout_secs = 1;

    let started = std::time::Instant::now();
    let err = expect_err(&c).await;
    let elapsed = started.elapsed();

    assert_eq!(err.code, "SSH_CONNECT_TIMEOUT", "实际: {err:?}");
    assert!(
        elapsed < Duration::from_secs(4),
        "超时应在约 1 秒内触发，实际 {elapsed:?}"
    );
    assert!(err.hints.iter().any(|h| h.label.contains("超时")));
}

#[tokio::test]
async fn config_endpoint_matches_connection_target() {
    let c = cfg(2222);
    assert_eq!(c.endpoint().host, "127.0.0.1");
    assert_eq!(c.endpoint().port, 2222);
    assert_eq!(c.endpoint().to_pattern(), "[127.0.0.1]:2222");
}
