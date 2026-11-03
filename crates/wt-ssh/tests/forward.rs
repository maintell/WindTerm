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

#[tokio::test]
async fn local_forward_rejects_connections_over_the_limit() {
    let server = MockSshServer::start().await;
    let echo = spawn_echo().await;
    let conn = connect(server.port).await;

    // 上限设成 1：第一条占住，第二条必须被拒（而不是排队或被悄悄放进来）
    let fwd = wt_ssh::start_local_limited(
        conn,
        "127.0.0.1",
        0,
        &echo.ip().to_string(),
        echo.port(),
        1,
    )
    .await
    .expect("启动带上限的转发");

    let mut first = tokio::net::TcpStream::connect(fwd.listen_addr())
        .await
        .expect("第一条应被接受");
    first.write_all(b"x").await.expect("写");
    let mut buf = [0u8; 1];
    first.read_exact(&mut buf).await.expect("读回");

    // 第二条：连得上（本地监听还在）但会被立刻关掉
    let mut second = tokio::net::TcpStream::connect(fwd.listen_addr())
        .await
        .expect("仍应能完成 TCP 连接");
    let ended = tokio::time::timeout(Duration::from_secs(5), second.read(&mut buf)).await;
    let Ok(Ok(n)) = ended else {
        panic!("超上限的连接必须干净结束，实际：{ended:?}");
    };
    assert_eq!(n, 0, "应当立刻 EOF，而不是有数据");

    let stats = wait_stats(&fwd, |s| s.rejected >= 1).await;
    assert_eq!(stats.rejected, 1, "被拒的连接要单独计数");
    assert_eq!(stats.total, 1, "被拒的不该混进 total");

    drop(first);
    fwd.stop().await;
}

#[test]
fn lan_exposure_detection() {    // NET-001 行为规格第 1 条：选这些地址要红色警告 + 确认
    for host in ["0.0.0.0", "::", "[::]", "*"] {
        assert!(wt_ssh::exposes_to_lan(host), "{host} 应判定为对外暴露");
    }
    for host in ["127.0.0.1", "::1", "localhost", ""] {
        assert!(!wt_ssh::exposes_to_lan(host), "{host} 不应判定为对外暴露");
    }
    // 具体网卡地址同样意味着局域网可达
    assert!(wt_ssh::exposes_to_lan("192.168.1.10"));
}

/// 极简 SOCKS5 客户端：只发 CONNECT，用于验证动态转发真的在讲 SOCKS5。
async fn socks5_connect(
    proxy: std::net::SocketAddr,
    target_host: &str,
    target_port: u16,
) -> Result<tokio::net::TcpStream, String> {
    let mut sock = tokio::net::TcpStream::connect(proxy)
        .await
        .map_err(|e| e.to_string())?;

    // 协商：只要「无需认证」
    sock.write_all(&[5, 1, 0]).await.map_err(|e| e.to_string())?;
    let mut picked = [0u8; 2];
    sock.read_exact(&mut picked)
        .await
        .map_err(|e| e.to_string())?;
    if picked != [5, 0] {
        return Err(format!("协商失败：{picked:?}"));
    }

    // CONNECT + 域名地址（AC-2：域名交给远端解析）
    let mut req = vec![5, 1, 0, 3, target_host.len() as u8];
    req.extend_from_slice(target_host.as_bytes());
    req.extend_from_slice(&target_port.to_be_bytes());
    sock.write_all(&req).await.map_err(|e| e.to_string())?;

    // VER REP RSV ATYP BND.ADDR(4) BND.PORT(2)
    let mut head = [0u8; 10];
    sock.read_exact(&mut head).await.map_err(|e| e.to_string())?;
    if head[1] != 0 {
        return Err(format!("CONNECT 被拒绝：REP={}", head[1]));
    }
    Ok(sock)
}

#[tokio::test]
async fn socks5_dynamic_forward_passes_bytes_through() {
    let server = MockSshServer::start().await;
    let echo = spawn_echo().await;
    let conn = connect(server.port).await;

    let fwd = wt_ssh::start_socks5(conn, "127.0.0.1", 0, None)
        .await
        .expect("启动 SOCKS5 代理");
    assert_ne!(fwd.listen_addr().port(), 0, "必须回填系统分配的端口");

    // 地址用域名形式发过去：这一条同时印证「域名由服务端解析」
    let mut sock = socks5_connect(fwd.listen_addr(), "127.0.0.1", echo.port())
        .await
        .expect("SOCKS5 CONNECT 应成功");

    let payload = b"through-socks";
    sock.write_all(payload).await.expect("写入");
    let mut buf = vec![0u8; payload.len()];
    sock.read_exact(&mut buf).await.expect("读回");
    assert_eq!(&buf, payload, "SOCKS5 转发必须逐字节一致");

    // 字节数是在连接收尾时累加的，所以先关掉再等统计
    drop(sock);
    let n = payload.len() as u64;
    let stats = wait_stats(&fwd, |s| s.up_bytes >= n && s.down_bytes >= n).await;
    assert_eq!(stats.total, 1, "累计连接数");
    assert_eq!(stats.up_bytes, n, "上行字节数应等于写入量");
    assert_eq!(stats.down_bytes, n, "下行字节数应等于回显量");
    assert_eq!(stats.active, 0, "连接结束后活跃数必须归零");
    assert_eq!(stats.last_error, None, "成功转发过之后不该留下错误");

    fwd.stop().await;
}

#[tokio::test]
async fn socks5_rejects_when_auth_configured_but_client_offers_none() {    let server = MockSshServer::start().await;
    let conn = connect(server.port).await;
    let fwd = wt_ssh::start_socks5(
        conn,
        "127.0.0.1",
        0,
        Some(("u".to_string(), "p".to_string())),
    )
    .await
    .expect("启动带认证的 SOCKS5 代理");

    let mut sock = tokio::net::TcpStream::connect(fwd.listen_addr())
        .await
        .expect("连上代理");
    // 只声明「无需认证」，但代理要求用户名密码 → 应回 05 FF（AC-3 的拒绝路径）
    sock.write_all(&[5, 1, 0]).await.expect("写协商");
    let mut picked = [0u8; 2];
    sock.read_exact(&mut picked).await.expect("读协商应答");
    assert_eq!(picked, [5, 0xFF], "没有可接受的方法时必须拒绝");

    fwd.stop().await;
}

/// `RemoteForward` 的统计轮询（与 `wait_stats` 同形，但对象不同）。
async fn wait_remote_stats(
    fwd: &wt_ssh::RemoteForward,
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
async fn remote_forward_lets_server_reach_local_target() {
    let server = MockSshServer::start().await;
    let echo = spawn_echo().await; // 本机上的目标
    let conn = connect(server.port).await;

    let fwd = wt_ssh::start_remote(conn, "127.0.0.1", 0, "127.0.0.1", echo.port())
        .await
        .expect("启动远程转发");

    // 端口由**服务端**分配并回填（请求的是 0）
    let addr = fwd.remote_addr();
    let port: u16 = addr.rsplit(':').next().unwrap().parse().unwrap();
    assert_ne!(port, 0, "服务端应回填实际端口，实际：{addr}");

    // 连「服务器上的」那个端口：应当被转到本机的 echo
    let mut client = tokio::net::TcpStream::connect(&addr)
        .await
        .expect("连上服务端的转发端口");
    client.write_all(b"reverse").await.expect("写入");
    let mut buf = [0u8; 7];
    client.read_exact(&mut buf).await.expect("读回");
    assert_eq!(&buf, b"reverse", "-R 必须把服务端的连接转到我本地目标");

    drop(client);
    let stats = wait_remote_stats(&fwd, |s| s.up_bytes >= 7 && s.down_bytes >= 7).await;
    assert_eq!(stats.total, 1, "累计连接数");
    assert_eq!(stats.up_bytes, 7, "上行字节数");
    assert_eq!(stats.down_bytes, 7, "下行字节数");
    assert_eq!(stats.active, 0, "连接结束后活跃数必须归零");
    assert_eq!(stats.last_error, None);

    fwd.stop().await;
    // 取消后服务端不该还在监听：不通知服务端会留下一个「我们以为停了」的端口
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        tokio::net::TcpStream::connect(&addr).await.is_err(),
        "cancel_tcpip_forward 之后不该还能连：{addr}"
    );
}

#[tokio::test]
async fn remote_forward_rejects_when_server_says_no() {
    let server = MockSshServer::start().await;
    let conn = connect(server.port).await;
    // mock 的约定：`deny-forward` 直接拒绝（等价于 sshd 不允许 -R）
    let err = wt_ssh::start_remote(conn, "deny-forward", 8080, "127.0.0.1", 1234)
        .await
        .err()
        .expect("服务端拒绝时必须失败");
    assert_eq!(err.code, wt_common::codes::TUN_CHANNEL_FAILED, "实际：{}", err.code);
    assert!(
        err.message.contains("拒绝"),
        "错误要说清是服务端不让监听，实际：{}",
        err.message
    );
}
