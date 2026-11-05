//! SFTP 走真实 SSH 通道的正向路径。
//!
//! 协议细节在 `src/sftp.rs` 的单元测试里用内存管道覆盖；这里验证的是
//! 「SSH 通道 → sftp 子系统 → 报文」整条链路，包括 mock 服务端上的
//! 内存文件系统。

use wt_ssh::testing::MockSshServer;
use wt_ssh::{HostKeyPolicy, SftpClient, SftpWriter, SshConfig, SshConnection};

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
async fn overwriting_with_shorter_content_truncates() {
    // 回归用例：`write` 不截断时，覆盖成更短的内容会在文件尾部留下旧字节
    let server = MockSshServer::start().await;
    let conn = SshConnection::connect_password(&cfg(server.port), "secret", HostKeyPolicy::AcceptAll)
        .await
        .expect("连接应成功");
    let sftp = SftpClient::open(conn).await.expect("应能打开 sftp 子系统");

    sftp.write_file("/a.txt", b"hello world").await.expect("写长内容");
    sftp.write_file("/a.txt", b"hi").await.expect("写短内容");
    let got = sftp.read_file("/a.txt").await.expect("读回");
    assert_eq!(got, b"hi", "覆盖后尾部不该残留旧字节");
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
async fn creates_renames_and_removes_over_real_channel() {
    let server = MockSshServer::start().await;
    let conn = SshConnection::connect_password(&cfg(server.port), "secret", HostKeyPolicy::AcceptAll)
        .await
        .expect("连接应成功");
    let sftp = SftpClient::open(conn).await.expect("应能打开 sftp 子系统");

    // 建目录 → 列表里应当是**目录**（`is_dir` 来自服务端属性，不是靠猜）
    sftp.create_dir("/logs").await.expect("建目录应成功");
    let entries = sftp.list_dir("/").await.expect("列目录");
    let logs = entries
        .iter()
        .find(|e| e.name == "logs")
        .expect("新建的目录应当出现在列表里");
    assert!(logs.is_dir, "新建的应当是目录");

    // 改名
    sftp.rename("/logs", "/logs-old").await.expect("改名应成功");
    let entries = sftp.list_dir("/").await.expect("列目录");
    assert!(entries.iter().any(|e| e.name == "logs-old"), "改名后应当出现");
    assert!(!entries.iter().any(|e| e.name == "logs"), "旧名字应当消失");

    // 删除空目录
    sftp.remove_dir("/logs-old").await.expect("删空目录应成功");
    let entries = sftp.list_dir("/").await.expect("列目录");
    assert!(!entries.iter().any(|e| e.name == "logs-old"));

    // 非空目录不许删：这是刻意不做递归删除的保护，错误信息要说明原因
    sftp.create_dir("/keep").await.expect("建目录");
    sftp.write_file("/keep/inner.txt", b"x")
        .await
        .expect("往目录里写文件");
    let err = sftp
        .remove_dir("/keep")
        .await
        .expect_err("非空目录必须删不掉");
    assert!(
        err.detail.as_deref().unwrap_or_default().contains("空目录"),
        "提示要说清「只有空目录能删」，实际：{:?}",
        err.detail
    );

    // 删文件
    sftp.write_file("/gone.txt", b"bye").await.expect("写文件");
    sftp.remove_file("/gone.txt").await.expect("删文件应成功");
    assert!(
        !sftp
            .list_dir("/")
            .await
            .expect("列目录")
            .iter()
            .any(|e| e.name == "gone.txt")
    );
}

#[tokio::test]
async fn streaming_writer_takes_chunks_across_calls() {
    let server = MockSshServer::start().await;
    let conn = SshConnection::connect_password(&cfg(server.port), "secret", HostKeyPolicy::AcceptAll)
        .await
        .expect("连接应成功");
    let sftp = SftpClient::open(conn).await.expect("应能打开 sftp 子系统");

    // 模拟「前端每次发一块」：写句柄在多次调用之间存活
    let mut writer = SftpWriter::create(sftp, "/stream.bin")
        .await
        .expect("创建写句柄");
    let chunks: [&[u8]; 3] = [b"aaaa", b"bbbbbb", b"cc"];
    let mut expect = 0u64;
    for c in chunks {
        expect += c.len() as u64;
        let written = writer.write_chunk(c).await.expect("写块");
        assert_eq!(written, expect, "累计字节数必须与已写量一致");
    }
    let total = writer.finish().await.expect("收尾");
    assert_eq!(total, expect);

    // 内容按写入顺序拼起来
    let conn = SshConnection::connect_password(&cfg(server.port), "secret", HostKeyPolicy::AcceptAll)
        .await
        .expect("再连一次应成功");
    let reader = SftpClient::open(conn).await.expect("打开 sftp");
    assert_eq!(
        reader.read_file("/stream.bin").await.expect("读回"),
        b"aaaabbbbbbcc".to_vec(),
        "分块写入的顺序必须保留"
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

#[tokio::test]
async fn lists_symlinks_with_target_and_broken_flag() {
    let server = MockSshServer::start().await;
    {
        let mut fs = server.fs.lock().await;
        fs.insert("/real.txt".into(), b"body".to_vec());
    }
    {
        let mut links = server.links.lock().await;
        // 相对目标：要按**链接所在目录**解析，不是按进程当前目录
        links.insert("/ok.txt".into(), "real.txt".into());
        links.insert("/dead.txt".into(), "gone.txt".into());
    }
    let conn = SshConnection::connect_password(&cfg(server.port), "secret", HostKeyPolicy::AcceptAll)
        .await
        .expect("连接应成功");
    let sftp = SftpClient::open(conn).await.expect("应能打开 sftp 子系统");

    let entries = sftp.list_dir("/").await.expect("列目录");
    let ok = entries
        .iter()
        .find(|e| e.name == "ok.txt")
        .expect("ok.txt 应在列表里");
    assert!(ok.is_symlink, "链接要标成链接，不能当普通文件");
    assert_eq!(ok.link_target.as_deref(), Some("real.txt"));
    assert!(!ok.broken, "指向存在的文件，不该判成断链");

    let dead = entries
        .iter()
        .find(|e| e.name == "dead.txt")
        .expect("dead.txt 应在列表里");
    assert!(dead.is_symlink);
    assert!(dead.broken, "目标不存在必须标成断链，否则用户点进去才报错");

    // 权限位（`FIL-002`）：类型位要是 S_IFLNK，普通文件要是 S_IFREG
    let mode = ok.mode.expect("服务端给了 permissions，不该是 None");
    assert_eq!(
        mode & 0o170000,
        0o120000,
        "链接的类型位要标成 S_IFLNK：{mode:o}"
    );
    let file = entries
        .iter()
        .find(|e| e.name == "real.txt")
        .expect("real.txt 应在列表里");
    let file_mode = file.mode.expect("普通文件也该有 mode");
    assert_eq!(file_mode & 0o170000, 0o100000, "real.txt 应是普通文件");
    assert_eq!(file_mode & 0o777, 0o644, "mock 给的权限是 0644");
}

#[tokio::test]
async fn set_mode_changes_reported_permissions() {
    let server = MockSshServer::start().await;
    {
        let mut fs = server.fs.lock().await;
        fs.insert("/run.sh".into(), b"#!/bin/sh\n".to_vec());
    }
    let conn = SshConnection::connect_password(&cfg(server.port), "secret", HostKeyPolicy::AcceptAll)
        .await
        .expect("连接应成功");
    let sftp = SftpClient::open(conn).await.expect("应能打开 sftp 子系统");

    // `FIL-002` 的 SETSTAT：0644 → 0755，类型位必须原样保留
    sftp.set_mode("/run.sh", 0o100755).await.expect("改权限");
    let entries = sftp.list_dir("/").await.expect("列目录");
    let e = entries
        .iter()
        .find(|e| e.name == "run.sh")
        .expect("run.sh 应在列表里");
    let mode = e.mode.expect("改过之后必须有 mode");
    assert_eq!(mode & 0o777, 0o755, "权限位应变成 755：{mode:o}");
    assert_eq!(mode & 0o170000, 0o100000, "类型位不能被改掉：{mode:o}");
}

#[tokio::test]
async fn atomic_write_replaces_content_and_leaves_no_temp_file() {
    let server = MockSshServer::start().await;
    {
        let mut fs = server.fs.lock().await;
        fs.insert("/a.txt".into(), b"original".to_vec());
    }
    let conn = SshConnection::connect_password(&cfg(server.port), "secret", HostKeyPolicy::AcceptAll)
        .await
        .expect("连接应成功");
    let sftp = SftpClient::open(conn).await.expect("应能打开 sftp 子系统");

    // `FIL-002`：保存远端文件必须是「写临时文件 + rename」，不能就地截断目标
    let atomic = sftp
        .write_file_atomic("/a.txt", b"new content")
        .await
        .expect("原子写应成功");
    assert!(atomic, "mock 的 rename 会覆盖目标，应报告 atomic=true");
    assert_eq!(sftp.read_file("/a.txt").await.unwrap(), b"new content");

    let keys: Vec<String> = server.fs.lock().await.keys().cloned().collect();
    assert!(
        !keys.iter().any(|k| k.contains(".wt-tmp-")),
        "临时文件必须被 rename 掉，不该留在远端：{keys:?}"
    );
}

#[tokio::test]
async fn atomic_write_can_create_a_new_file() {
    let server = MockSshServer::start().await;
    let conn = SshConnection::connect_password(&cfg(server.port), "secret", HostKeyPolicy::AcceptAll)
        .await
        .expect("连接应成功");
    let sftp = SftpClient::open(conn).await.expect("应能打开 sftp 子系统");

    let atomic = sftp
        .write_file_atomic("/fresh.txt", b"hello")
        .await
        .expect("目标不存在时也该成功");
    assert!(atomic);
    assert_eq!(sftp.read_file("/fresh.txt").await.unwrap(), b"hello");
}

/// 编辑远端文件不能把原文件的权限位吃掉（`FIL-005`）。
///
/// 临时文件是按服务端 umask 建的，写完直接 `rename` 覆盖会把可执行位一起抹掉：
/// 「编辑一个 755 的部署脚本，存完变成 644」——内容对了、权限没了，而且界面上
/// 只看到「已保存」。所以替换前要把原件的权限位 `SETSTAT` 到临时文件上。
#[tokio::test]
async fn atomic_write_keeps_the_original_mode() {
    let server = MockSshServer::start().await;
    {
        let mut fs = server.fs.lock().await;
        fs.insert("/deploy.sh".into(), b"#!/bin/sh\necho old\n".to_vec());
    }
    let conn = SshConnection::connect_password(&cfg(server.port), "secret", HostKeyPolicy::AcceptAll)
        .await
        .expect("连接应成功");
    let sftp = SftpClient::open(conn).await.expect("应能打开 sftp 子系统");
    sftp.set_mode("/deploy.sh", 0o755 | 0o100000)
        .await
        .expect("先设成 755");

    sftp.write_file_atomic("/deploy.sh", b"#!/bin/sh\necho new\n")
        .await
        .expect("原子写应成功");

    let entries = sftp.list_dir("/").await.expect("列目录应成功");
    let mode = entries
        .iter()
        .find(|e| e.name == "deploy.sh")
        .and_then(|e| e.mode)
        .expect("deploy.sh 应有 mode");
    assert_eq!(mode & 0o777, 0o755, "编辑完可执行位不能丢：{mode:o}");
    assert_eq!(mode & 0o170000, 0o100000, "类型位要保住：{mode:o}");
    assert_eq!(
        sftp.read_file("/deploy.sh").await.unwrap(),
        b"#!/bin/sh\necho new\n"
    );
}
