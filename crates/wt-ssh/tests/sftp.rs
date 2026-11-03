//! SFTP 走真实 SSH 通道的正向路径。
//!
//! 协议细节在 `src/sftp.rs` 的单元测试里用内存管道覆盖；这里验证的是
//! 「SSH 通道 → sftp 子系统 → 报文」整条链路，包括 mock 服务端上的
//! 内存文件系统。

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
async fn lists_reads_and_writes_over_real_channel() {
    let server = MockSshServer::start().await;
    {
        let mut fs = server.fs.lock().await;
        fs.insert("/hello.txt".into(), b"hi there".to_vec());
        fs.insert("/other.bin".into(), vec![0u8, 1, 2, 3]);
    }

    let conn = SshConnection::connect_password(&cfg(server.port), "secret", HostKeyPolicy::AcceptAll)
        .await
        .expect("连接应成功");
    let sftp = SftpClient::open(conn).await.expect("应能打开 sftp 子系统");

    let entries = sftp.list_dir("/").await.expect("列目录应成功");
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    assert!(names.contains(&"hello.txt"), "实际: {names:?}");
    assert!(names.contains(&"other.bin"), "实际: {names:?}");

    assert_eq!(
        sftp.read_file("/hello.txt").await.expect("读文件应成功"),
        b"hi there"
    );

    sftp.write_file("/written.txt", b"from client")
        .await
        .expect("写文件应成功");
    assert_eq!(
        server
            .fs
            .lock()
            .await
            .get("/written.txt")
            .map(|v| v.as_slice()),
        Some(&b"from client"[..])
    );
}

#[tokio::test]
async fn sftp_and_shell_share_one_connection() {
    let server = MockSshServer::start().await;
    server.fs.lock().await.insert("/a.txt".into(), b"a".to_vec());

    let conn = SshConnection::connect_password(&cfg(server.port), "secret", HostKeyPolicy::AcceptAll)
        .await
        .expect("连接应成功");

    // 先在连接上开 shell 通道，再把连接交给 SFTP（`open` 会接管所有权）
    let mut ch = conn
        .open_shell("xterm-256color", 80, 24)
        .await
        .expect("shell 通道应能打开");
    let sftp = SftpClient::open(conn).await.expect("应能打开 sftp 子系统");

    let banner = tokio::time::timeout(std::time::Duration::from_secs(5), ch.next())
        .await
        .expect("等 banner 不应超时")
        .expect("应有 banner");
    match banner {
        wt_ssh::ChannelData::Stdout(d) => assert_eq!(String::from_utf8_lossy(&d), "WELCOME\r\n"),
        other => panic!("banner 应为 stdout，实际 {other:?}"),
    }

    assert_eq!(sftp.read_file("/a.txt").await.unwrap(), b"a");
}
