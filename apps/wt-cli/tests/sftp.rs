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
    run_sftp(
        &target(server.port),
        &SftpAction::Ls {
            path: "/".into(),
            json: false,
        },
        &mut out,
    )
    .await
    .expect("ls 应成功");

    let text = String::from_utf8_lossy(&out);
    assert!(text.contains("alpha.txt"), "实际输出: {text}");
    assert!(text.contains("beta.txt"), "实际输出: {text}");
}

#[tokio::test]
async fn ls_json_is_machine_readable() {
    // `--json` 是给脚本与 AI Agent 用的（`spec/01`「每个 UI 能力都要能脚本化」）：
    // 输出必须是**能解析的 JSON**，字段与界面那份 DTO 一致，而不是另造一套。
    let server = MockSshServer::start().await;
    server
        .fs
        .lock()
        .await
        .insert("/alpha.txt".into(), b"abc".to_vec());
    server.fs.lock().await.insert("/dir".into(), Vec::new());

    let mut out: Vec<u8> = Vec::new();
    run_sftp(
        &target(server.port),
        &SftpAction::Ls {
            path: "/".into(),
            json: true,
        },
        &mut out,
    )
    .await
    .expect("ls --json 应成功");

    let text = String::from_utf8_lossy(&out);
    let rows: Vec<serde_json::Value> = serde_json::from_str(text.trim())
        .unwrap_or_else(|e| panic!("输出不是合法 JSON：{e}；实际：{text}"));
    let alpha = rows
        .iter()
        .find(|r| r["name"] == "alpha.txt")
        .unwrap_or_else(|| panic!("没找到 alpha.txt：{text}"));
    // 不钉 `alpha.txt` 的 isDir：mock 的 `FileAttributes::dummy()` 把权限位写死成
    // `0o777 | S_IFDIR`，每个条目都会被报成目录（README 的 G8 复盘记着这条）。
    // 这条用例验的是**输出的形状**，不是 mock 的属性保真度。
    // 字段名必须是 camelCase（与界面 DTO 同一套），不是 Rust 那边的 snake_case。
    assert!(alpha.get("isDir").is_some(), "缺 isDir 字段：{text}");
    assert!(alpha.get("linkTarget").is_some(), "缺 linkTarget 字段：{text}");
    assert!(alpha.get("size").is_some(), "缺 size 字段：{text}");
    // 每一行都必须是同一套字段：脚本按这些键取值，少一个就是断的
    for row in &rows {
        for key in [
            "name",
            "isDir",
            "size",
            "isSymlink",
            "linkTarget",
            "broken",
            "mode",
            "mtime",
        ] {
            assert!(
                row.get(key).is_some(),
                "缺字段 {key}：{row}；完整输出：{text}"
            );
        }
    }
    assert!(rows.len() >= 2, "至少两条：{text}");
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
async fn get_streams_large_file_in_chunks() {
    // 边读边写盘：200 KB 会跨多个 64 KB 块，内容必须逐字节一致。
    // 这条同时守「不再把整个文件读进内存」的回归——以前走的是 `read_file`。
    let server = MockSshServer::start().await;
    let big: Vec<u8> = (0..200 * 1024).map(|i| (i % 251) as u8).collect();
    server.fs.lock().await.insert("/big.bin".into(), big.clone());

    let dir = tmp_dir("get-big");
    let local = dir.join("big.bin");
    let mut out: Vec<u8> = Vec::new();
    run_sftp(
        &target(server.port),
        &SftpAction::Get {
            remote: "/big.bin".into(),
            local: local.clone(),
        },
        &mut out,
    )
    .await
    .expect("get 应成功");

    let got = std::fs::read(&local).expect("应落盘");
    assert_eq!(got.len(), big.len(), "字节数应一致");
    assert_eq!(got, big, "内容应逐字节一致");
    std::fs::remove_dir_all(&dir).ok();
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
