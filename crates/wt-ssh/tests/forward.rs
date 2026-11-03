//! 本地端口转发（`NET-001`）的端到端用例。
//!
//! 链路是真的：本地 TCP 客户端 → 监听端口 → `wt_ssh::start_local`
//! → SSH `direct-tcpip` 通道 → mock 服务端 → **真实 TCP 目标**（本进程起的 echo 服务）。
//!
//! 只有 SSH 那一跳是 mock——本机没有 sshd，而这条能力的正确性并不取决于
//! 服务端是谁实现的。目标那一侧用真实 socket，才能验到半关闭与字节计数。

use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use wt_ssh::testing::MockSshServer;
use wt_ssh::{HostKeyPolicy, SshConfig, SshConnection};

fn cfg(port: u16) -> SshConfig {
    SshConfig {
        host: "127.0.0.1".into(),
        port,
        user: "tester".into(),
        connect_timeout_secs: 5,
        ..Default::default()
    }
}

/// 起一台 echo 服务：收到什么回什么；对端关写端时跟着结束。
async fn spawn_echo() -> std::net::SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("绑定 echo 端口");
    let addr = listener.local_addr().expect("取 echo 地址");
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            tokio::spawn(async move {
                let (mut r, mut w) = sock.split();
                let _ = tokio::io::copy(&mut r, &mut w).await;
            });
        }
    });
    addr
}

async fn connect(server_port: u16) -> Arc<SshConnection> {
    let conn = SshConnection::connect_password(
        &cfg(server_port),
        "secret",
        HostKeyPolicy::AcceptAll,
    )
    .await
    .expect("连接 mock 服务端");
    Arc::new(conn)
}

/// 轮询统计直到满足条件；计数器是在连接收尾时累加的，存在一个很短的窗口。
async fn wait_stats(
    fwd: &wt_ssh::LocalForward,
    want: impl Fn(&wt_ssh::ForwardStats) -> bool,
) -> wt_ssh::ForwardStats {
    for _ in 0..100 {
        let s = fwd.stats();
        if want(&s) {
            return s;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    fwd.stats()
}

#[tokio::test]
async fn tunnels_tcp_through_ssh_and_reports_real_stats() {
    let server = MockSshServer::start().await;
    let echo = spawn_echo().await;
    let conn = connect(server.port).await;

    let fwd = wt_ssh::start_local(
        conn,
        "127.0.0.1",
        0, // AC-2：让系统分配端口
        &echo.ip().to_string(),
        echo.port(),
    )
    .await
    .expect("启动本地转发");

    // AC-2：listenPort = 0 必须回填实际端口，而不是把 0 原样带出去
    assert_ne!(fwd.listen_addr().port(), 0, "必须回填真实端口");
    assert_eq!(fwd.listen_addr().ip().to_string(), "127.0.0.1");
    assert!(!wt_ssh::exposes_to_lan("127.0.0.1"));

    let mut client = tokio::net::TcpStream::connect(fwd.listen_addr())
        .await
        .expect("连接本地监听端口");
    client.write_all(b"ping").await.expect("写入");

    let mut buf = [0u8; 4];
    client
        .read_exact(&mut buf)
        .await
        .expect("经隧道读回同样的字节");
    assert_eq!(&buf, b"ping", "透明转发必须逐字节一致");

    // 半关闭：关掉写端后应读到 EOF（干净结束），而不是 RST
    client.shutdown().await.expect("半关闭");
    let mut rest = Vec::new();
    client.read_to_end(&mut rest).await.expect("读到 EOF");
    assert!(rest.is_empty(), "EOF 之前不该还有数据");

    let stats = wait_stats(&fwd, |s| s.up_bytes >= 4 && s.down_bytes >= 4).await;
    assert_eq!(stats.total, 1, "累计连接数");
    assert_eq!(stats.up_bytes, 4, "上行字节数应等于写入量");
    assert_eq!(stats.down_bytes, 4, "下行字节数应等于回显量");
    assert_eq!(stats.active, 0, "连接结束后活跃数必须归零");
    assert_eq!(stats.last_error, None, "成功转发过之后不该留下错误");

    fwd.stop().await;
}

#[tokio::test]
async fn unreachable_target_fails_loudly_instead_of_hanging() {
    let server = MockSshServer::start().await;
    let conn = connect(server.port).await;

    // 目标端口先占住再释放，拿到一个「刚刚还开着」的端口，几乎不可能被复用
    let probe = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let dead = probe.local_addr().unwrap();
    drop(probe);

    let fwd = wt_ssh::start_local(conn, "127.0.0.1", 0, &dead.ip().to_string(), dead.port())
        .await
        .expect("监听本身应当成功——目标不可达是连接期错误");

    let mut client = tokio::net::TcpStream::connect(fwd.listen_addr())
        .await
        .expect("本地连接应被接受");

    // 服务端拒绝 `direct-tcpip` 后，本地这条连接必须立刻结束，
    // 而不是让调用方一直等一个永远不会来的响应。
    let mut buf = [0u8; 1];
    let ended = tokio::time::timeout(Duration::from_secs(5), client.read(&mut buf)).await;
    let Ok(Ok(n)) = ended else {
        panic!("目标不可达时本地连接必须干净结束，实际：{ended:?}");
    };
    assert_eq!(n, 0, "应当是 EOF，而不是有数据");

    // 失败原因必须留下来：否则界面只能显示「运行中」，用户看到
    // 「隧道好好的但连不上」——这正是 NET-004 AC-3 要避免的静默失效
    let stats = wait_stats(&fwd, |s| s.last_error.is_some()).await;
    let err = stats.last_error.expect("失败原因应被记录");
    assert!(
        err.contains(&dead.port().to_string()) || err.contains("转发通道"),
        "错误信息要能定位到目标，实际：{err}"
    );

    fwd.stop().await;
}

#[test]
fn lan_exposure_detection() {
    // NET-001 行为规格第 1 条：选这些地址要红色警告 + 确认
    for host in ["0.0.0.0", "::", "[::]", "*"] {
        assert!(wt_ssh::exposes_to_lan(host), "{host} 应判定为对外暴露");
    }
    for host in ["127.0.0.1", "::1", "localhost", ""] {
        assert!(!wt_ssh::exposes_to_lan(host), "{host} 不应判定为对外暴露");
    }
    // 具体网卡地址同样意味着局域网可达
    assert!(wt_ssh::exposes_to_lan("192.168.1.10"));
}
