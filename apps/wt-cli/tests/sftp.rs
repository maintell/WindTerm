//! `wt sftp` 的真实执行路径（不是只测参数解析）。
//!
//! 用进程内的 mock 服务端跑通「列出 / 下载 / 上传」，
//! 因为用户实际走的是这条命令路径，而不是库的某个方法。

use std::path::PathBuf;

use wt_cli::{run_sftp, SftpAction, SshAuth, SshTarget};
use wt_ssh::testing::MockSshServer;

fn target(port: u16) -> SshTarget {
    SshTarget {
        host: "127.0.0.1".into(),
        port,
        user: "tester".into(),
        auth: SshAuth::Password("secret".into()),
        insecure_host_key: true,
        jumps: Vec::new(),
    }
}

fn tmp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "wt-cli-sftp-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[tokio::test]
async fn ls_lists_remote_directory() {
    let server = MockSshServer::start().await;
    server
        .fs
        .lock()
        .await
        .insert("/alpha.txt".into(), b"a".to_vec());
    server
        .fs
        .lock()
        .await
        .insert("/beta.txt".into(), b"bb".to_vec());

    let mut out: Vec<u8> = Vec::new();
    run_sftp(&target(server.port), &SftpAction::Ls { path: "/".into() }, &mut out)
        .await
        .expect("ls 应成功");

    let text = String::from_utf8_lossy(&out);
    assert!(text.contains("alpha.txt"), "实际输出: {text}");
    assert!(text.contains("beta.txt"), "实际输出: {text}");
}

#[tokio::test]
async fn get_writes_local_file() {
    let server = MockSshServer::start().await;
    server
        .fs
        .lock()
        .await
        .insert("/remote.txt".into(), b"downloaded".to_vec());

    let dir = tmp_dir("get");
    let local = dir.join("remote.txt");
    let mut out: Vec<u8> = Vec::new();
    run_sftp(
        &target(server.port),
        &SftpAction::Get {
            remote: "/remote.txt".into(),
            local: local.clone(),
        },
        &mut out,
    )
    .await
    .expect("get 应成功");

    assert_eq!(std::fs::read(&local).unwrap(), b"downloaded");
    assert!(String::from_utf8_lossy(&out).contains("已下载"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn put_uploads_local_file() {
    let server = MockSshServer::start().await;

    let dir = tmp_dir("put");
    let local = dir.join("upload.txt");
    std::fs::write(&local, b"uploaded").unwrap();

    let mut out: Vec<u8> = Vec::new();
    run_sftp(
        &target(server.port),
        &SftpAction::Put {
            local,
            remote: "/upload.txt".into(),
        },
        &mut out,
    )
    .await
    .expect("put 应成功");

    let stored = server.fs.lock().await.get("/upload.txt").cloned();
    assert_eq!(stored.as_deref(), Some(&b"uploaded"[..]));
    assert!(String::from_utf8_lossy(&out).contains("已上传"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn missing_remote_file_reports_clearly() {
    let server = MockSshServer::start().await;
    let dir = tmp_dir("missing");
    let mut out: Vec<u8> = Vec::new();
    let err = run_sftp(
        &target(server.port),
        &SftpAction::Get {
            remote: "/nope.txt".into(),
            local: dir.join("nope.txt"),
        },
        &mut out,
    )
    .await
    .unwrap_err();

    assert!(err.contains("/nope.txt"), "实际: {err}");
    assert!(err.contains("SFTP_FAILED"), "应带稳定错误码，实际: {err}");
    let _ = std::fs::remove_dir_all(&dir);
}
