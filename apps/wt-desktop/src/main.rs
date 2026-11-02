//! WindTerm 桌面壳：把 `wt-ipc` 的会话能力暴露成 Tauri 命令。
//!
//! 设计依据：`docs/design/02-process-and-ipc.md` §3。
//!
//! # 这一层刻意很薄
//!
//! 所有逻辑都在 `wt-ipc` / `wt-term` 里，这里只做三件事：
//! 参数校验、调用注册表、把结果转成 Tauri 的响应类型。
//!
//! 终端数据走 `tauri::ipc::Response`（`InvokeResponseBody::Raw`），
//! **不做 base64**——这是 `design/02` §3.4 的核心假设，已在 tauri 2.10 的
//! `ipc::Response::new(Vec<u8>)` 上确认可行；性能仍需按 `NFR-003` 实测。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::State;
use wt_ipc::{SessionHandle, SessionRegistry, SessionStats};
use wt_term::pty::PtyConfig;

struct AppState {
    registry: SessionRegistry,
}

/// 前端拉取单次上限：64 KB（`design/02` §5.2）。
const MAX_CHUNK: usize = 64 * 1024;

#[tauri::command]
fn local_open(state: State<'_, AppState>, cols: u16, rows: u16) -> Result<String, String> {
    let cfg = PtyConfig {
        cols: cols.max(20),
        rows: rows.max(4),
        // 界面侧是 xterm.js，它自己会应答 ConPTY 的 DSR 查询。
        // 两边都答会多出一个 `ESC[1;1R`，被 shell 的行编辑器吃掉后紧跟的第一个字符。
        answer_queries: false,
        ..Default::default()
    };
    let session = wt_term::TermSession::spawn_local(cfg).map_err(|e| e.to_string())?;
    let handle = state.registry.register(Box::new(session));
    Ok(handle.as_str().to_string())
}

/// 拉取终端数据。返回**原始字节**。
#[tauri::command]
fn term_read(
    state: State<'_, AppState>,
    handle: String,
    max_bytes: Option<usize>,
) -> Result<tauri::ipc::Response, String> {
    let h = SessionHandle::from(handle.as_str());
    let max = max_bytes.unwrap_or(MAX_CHUNK).min(MAX_CHUNK);
    let bytes = state.registry.read(&h, max).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn term_ack(state: State<'_, AppState>, handle: String, n: usize) -> Result<(), String> {
    let h = SessionHandle::from(handle.as_str());
    state.registry.ack(&h, n).map_err(|e| e.to_string())
}

#[tauri::command]
fn term_write(state: State<'_, AppState>, handle: String, data: String) -> Result<(), String> {
    let h = SessionHandle::from(handle.as_str());
    state
        .registry
        .write(&h, data.as_bytes())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn term_resize(
    state: State<'_, AppState>,
    handle: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let h = SessionHandle::from(handle.as_str());
    state
        .registry
        .resize(&h, cols, rows)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn term_stats(state: State<'_, AppState>, handle: String) -> Result<StatsDto, String> {
    let h = SessionHandle::from(handle.as_str());
    let s: SessionStats = state.registry.stats(&h).map_err(|e| e.to_string())?;
    Ok(StatsDto {
        buffered: s.buffered,
        unacked: s.unacked,
        paused: s.paused,
        dropped_bytes: s.dropped_bytes,
        cols: s.cols,
        rows: s.rows,
    })
}

#[tauri::command]
fn term_close(state: State<'_, AppState>, handle: String) {
    let h = SessionHandle::from(handle.as_str());
    state.registry.close(&h);
}

// ── SSH ─────────────────────────────────────────────────────

/// 应用数据目录。
///
/// `WT_DATA_DIR` 供便携模式与端到端验收覆盖——验收必须用干净目录，
/// 否则上一轮记下的主机密钥会让 TOFU 分支测不到。
fn data_dir() -> std::path::PathBuf {
    if let Ok(dir) = std::env::var("WT_DATA_DIR") {
        if !dir.trim().is_empty() {
            return std::path::PathBuf::from(dir);
        }
    }
    let base = std::env::var("APPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    base.join("WindTerm")
}

fn known_hosts_path() -> std::path::PathBuf {
    data_dir().join("known_hosts")
}

fn load_known_hosts() -> wt_ssh::KnownHosts {
    match std::fs::read_to_string(known_hosts_path()) {
        Ok(text) => wt_ssh::KnownHosts::parse(&text).0,
        // 文件不存在就是空库：首次连接走 accept-new
        Err(_) => wt_ssh::KnownHosts::new(),
    }
}

fn save_known_hosts(known: &wt_ssh::KnownHosts) -> Result<(), String> {
    let path = known_hosts_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("无法创建数据目录 {}：{e}", dir.display()))?;
    }
    std::fs::write(&path, known.to_text())
        .map_err(|e| format!("无法写入 {}：{e}", path.display()))
}

#[derive(serde::Serialize)]
struct SshOpenDto {
    handle: String,
    fingerprint: String,
    /// 本次是否把主机密钥写进了 known_hosts（首次连接）
    host_key_added: bool,
}

/// 建立 SSH 交互式终端。
///
/// 主机密钥策略是 OpenSSH 的 `accept-new`：第一次见到某台主机就记住指纹，
/// 之后指纹变化一律拒绝。用户不需要理解 TOFU，但中间人换证书会被挡住。
///
/// `SshConnection` 在命令返回后会被释放——这是安全的：`russh` 的
/// `Handle::drop` 只打日志，连接任务由 tokio 持有，直到通道关闭。
/// 若将来 russh 改成 drop 即 abort，这条注释就是排查线索。
#[tauri::command]
async fn ssh_open(
    state: State<'_, AppState>,
    host: String,
    port: Option<u16>,
    user: String,
    password: String,
    cols: u16,
    rows: u16,
) -> Result<SshOpenDto, String> {
    let cfg = wt_ssh::SshConfig {
        host: host.trim().to_string(),
        port: port.unwrap_or(22),
        user: user.trim().to_string(),
        ..Default::default()
    };
    if cfg.host.is_empty() {
        return Err("[SSH_BAD_ARGUMENT] 主机不能为空".into());
    }
    if cfg.user.is_empty() {
        return Err("[SSH_BAD_ARGUMENT] 用户名不能为空".into());
    }

    let mut known = load_known_hosts();
    let mut host_key_added = false;

    let conn = match wt_ssh::SshConnection::connect_password(
        &cfg,
        &password,
        wt_ssh::HostKeyPolicy::Known(Box::new(known.clone())),
    )
    .await
    {
        Ok(c) => c,
        Err(e) if e.code == wt_common::codes::SSH_HOSTKEY_UNKNOWN => {
            let observed = wt_ssh::SshConnection::probe_host_key(&cfg)
                .await
                .map_err(|e| e.to_string())?;
            known.add(&cfg.endpoint(), &observed.key_type, &observed.blob, false);
            save_known_hosts(&known)?;
            host_key_added = true;
            wt_ssh::SshConnection::connect_password(
                &cfg,
                &password,
                wt_ssh::HostKeyPolicy::Known(Box::new(known.clone())),
            )
            .await
            .map_err(|e| e.to_string())?
        }
        Err(e) => return Err(e.to_string()),
    };

    let fingerprint = conn.server_fingerprint().unwrap_or_default();
    let session = wt_ssh::SshTermSession::open(
        &conn,
        &cfg.term_type,
        cols.max(20),
        rows.max(4),
        wt_term::RingBuffer::with_defaults(),
    )
    .await
    .map_err(|e| e.to_string())?;

    let handle = state.registry.register(Box::new(session));
    Ok(SshOpenDto {
        handle: handle.as_str().to_string(),
        fingerprint,
        host_key_added,
    })
}

#[derive(serde::Serialize)]
struct StatsDto {
    buffered: usize,
    unacked: usize,
    paused: bool,
    dropped_bytes: u64,
    cols: u16,
    rows: u16,
}

fn main() {
    tauri::Builder::default()
        .manage(AppState {
            registry: SessionRegistry::new(),
        })
        .setup(|app| {
            create_main_window(app)?;
            start_mock_ssh_if_requested();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            local_open,
            term_read,
            term_ack,
            term_write,
            term_resize,
            term_stats,
            term_close,
            ssh_open
        ])
        .run(tauri::generate_context!())
        .expect("启动 WindTerm 失败");
}

/// 主窗口。
///
/// 窗口在这里建、不在 `tauri.conf.json` 里声明，是为了让端到端验收能按需
/// 给 WebView2 加调试参数：`wry` 每次都会调用
/// `set_additional_browser_arguments`，它会**覆盖** `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`
/// 环境变量，所以 CDP 端口只能由代码传进去。
///
/// 没有 `WT_CDP_PORT` 时不调用 `additional_browser_args`，生产路径与 wry 默认完全一致。
fn create_main_window(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    #[allow(unused_mut)]
    let mut win = tauri::WebviewWindowBuilder::new(
        app,
        "main",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("WindTerm")
    .inner_size(1000.0, 700.0)
    .min_inner_size(480.0, 320.0);

    #[cfg(windows)]
    if let Ok(port) = std::env::var("WT_CDP_PORT") {
        let port = port.trim();
        if !port.is_empty() {
            // 前缀是 wry 的默认参数，必须原样带上（见 tauri::webview::WebviewBuilder::additional_browser_args 文档）
            win = win.additional_browser_args(&format!(
                "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
                 --remote-debugging-port={port} --remote-allow-origins=*"
            ));
        }
    }

    win.build()?;
    Ok(())
}

/// 端到端验收专用：`WT_MOCK_SSH=1` 时在应用内起一个 SSH 服务端，端口打到 stdout。
///
/// 本机没有 sshd，界面要验 SSH 就只能自带一台「服务器」。
/// 只在 `e2e-mock` feature 下编译，生产构建里这段代码根本不存在。
#[cfg(feature = "e2e-mock")]
fn start_mock_ssh_if_requested() {
    if std::env::var("WT_MOCK_SSH").is_err() {
        return;
    }
    tauri::async_runtime::spawn(async {
        let server = wt_ssh::testing::MockSshServer::start().await;
        println!("WT_MOCK_SSH_PORT={}", server.port);
    });
}

#[cfg(not(feature = "e2e-mock"))]
fn start_mock_ssh_if_requested() {}
