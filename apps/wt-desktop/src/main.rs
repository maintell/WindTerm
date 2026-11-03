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

// ── 会话列表 ────────────────────────────────────────────────

/// 会话库位置，与 `wt` CLI 的默认值一致（`%APPDATA%\WindTerm\data.db`），
/// 这样 `wt session import` 导入的结果在界面里直接能看到。
fn sessions_db_path() -> std::path::PathBuf {
    data_dir().join("data.db")
}

#[derive(serde::Serialize)]
struct SessionsDto {
    db_path: String,
    /// 库文件是否存在。不存在时界面提示「先去导入」，而不是显示一个空树
    exists: bool,
    folders: Vec<wt_core::Folder>,
    sessions: Vec<wt_core::Session>,
    warnings: Vec<String>,
}

/// 读取会话树。
///
/// 库不存在时返回空结果而不是创建空库：用户第一次打开界面不该被悄悄塞一个文件，
/// 而且「库不存在」和「库是空的」对用户是两种不同的提示。
#[tauri::command]
fn sessions_load() -> Result<SessionsDto, String> {
    let db = sessions_db_path();
    let db_path = db.display().to_string();
    if !db.exists() {
        return Ok(SessionsDto {
            db_path,
            exists: false,
            folders: Vec::new(),
            sessions: Vec::new(),
            warnings: Vec::new(),
        });
    }
    let store = wt_store::Store::open(&db).map_err(|e| e.to_string())?;
    let snap = store.load_snapshot().map_err(|e| e.to_string())?;
    Ok(SessionsDto {
        db_path,
        exists: true,
        folders: snap.folders,
        sessions: snap.sessions,
        warnings: snap.warnings,
    })
}

#[derive(serde::Serialize)]
struct SkippedDto {
    name: String,
    reason: String,
}

#[derive(serde::Serialize)]
struct ImportDto {
    folders: usize,
    sessions: usize,
    reused_folders: usize,
    duplicates: Vec<String>,
    warnings: Vec<String>,
    skipped: Vec<SkippedDto>,
    /// 实际使用的编码（`utf-8` / `gbk` / …）。非 UTF-8 时界面要告诉用户。
    encoding: String,
}

/// 从 MobaXterm 的 ini **字节流**导入会话。
///
/// 收字节不收路径：界面里的 `<input type=file>` 拿不到真实路径，
/// 也不该为了拿路径去引入文件对话框插件。文件内容不出本机。
///
/// 收字节也不收文本：中文 Windows 上的 MobaXterm 写 GBK，交给前端按 UTF-8 解
/// 会把中文名变成 �——编码判定必须放在这里（`wt_import::decode_ini`）。
#[tauri::command]
fn import_mobaxterm(bytes: Vec<u8>) -> Result<ImportDto, String> {
    let (text, encoding) = wt_import::decode_ini(&bytes);
    let plan = wt_import::parse_mobaxterm_ini(&text).map_err(|e| e.to_string())?;

    let db = sessions_db_path();
    let mut store = wt_store::Store::open(&db).map_err(|e| e.to_string())?;
    // 与 CLI 共用同一套去重语义，避免「命令行导一遍、界面导一遍」长出两棵树
    let existing = store.load_snapshot().map_err(|e| e.to_string())?;
    let deduped = wt_store::dedup_against(&existing, &plan.folders, &plan.sessions);
    let report = store
        .import(&deduped.folders, &deduped.sessions)
        .map_err(|e| e.to_string())?;

    Ok(ImportDto {
        folders: report.folders,
        sessions: report.sessions,
        reused_folders: deduped.reused_folders,
        duplicates: deduped.duplicates,
        warnings: plan.warnings,
        skipped: plan
            .skipped
            .into_iter()
            .map(|s| SkippedDto {
                name: s.name,
                reason: s.reason,
            })
            .collect(),
        encoding: encoding.to_string(),
    })
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

/// 认证方式：密码，或一把私钥（可带口令）。
enum AuthInput {
    Password(String),
    Key(wt_ssh::PrivateKeySource),
}

fn known_policy(known: &wt_ssh::KnownHosts) -> wt_ssh::HostKeyPolicy {
    wt_ssh::HostKeyPolicy::Known(Box::new(known.clone()))
}

async fn try_connect(
    cfg: &wt_ssh::SshConfig,
    auth: &AuthInput,
    policy: wt_ssh::HostKeyPolicy,
) -> Result<wt_ssh::SshConnection, wt_common::WtError> {
    match auth {
        AuthInput::Password(p) => wt_ssh::SshConnection::connect_password(cfg, p, policy).await,
        AuthInput::Key(k) => wt_ssh::SshConnection::connect_publickey(cfg, k, policy).await,
    }
}

/// 建立 SSH 交互式终端。
///
/// 主机密钥策略是 OpenSSH 的 `accept-new`：第一次见到某台主机就记住指纹，
/// 之后指纹变化一律拒绝。用户不需要理解 TOFU，但中间人换证书会被挡住。
///
/// 认证支持密码与私钥两条路：很多服务器关掉了密码认证，只给密钥。
#[tauri::command]
async fn ssh_open(
    state: State<'_, AppState>,
    host: String,
    port: Option<u16>,
    user: String,
    password: Option<String>,
    key_pem: Option<String>,
    key_passphrase: Option<String>,
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

    let auth = match key_pem {
        Some(pem) if !pem.trim().is_empty() => {
            AuthInput::Key(wt_ssh::PrivateKeySource::new(pem.into_bytes(), key_passphrase))
        }
        _ => AuthInput::Password(password.unwrap_or_default()),
    };

    let mut known = load_known_hosts();
    let mut host_key_added = false;

    let conn = match try_connect(&cfg, &auth, known_policy(&known)).await {
        Ok(c) => c,
        Err(e) if e.code == wt_common::codes::SSH_HOSTKEY_UNKNOWN => {
            let observed = wt_ssh::SshConnection::probe_host_key(&cfg)
                .await
                .map_err(|e| e.to_string())?;
            known.add(&cfg.endpoint(), &observed.key_type, &observed.blob, false);
            save_known_hosts(&known)?;
            host_key_added = true;
            try_connect(&cfg, &auth, known_policy(&known))
                .await
                .map_err(|e| e.to_string())?
        }
        Err(e) => return Err(e.to_string()),
    };

    let fingerprint = conn.server_fingerprint().unwrap_or_default();
    // 空闲连接会被 NAT/防火墙静默断开，按会话配置发心跳（默认 30 秒）
    let keepalive = (cfg.keepalive_secs > 0)
        .then(|| std::time::Duration::from_secs(u64::from(cfg.keepalive_secs)));
    let session = wt_ssh::SshTermSession::open_owned(
        conn,
        keepalive,
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

/// 端到端验收专用：生成一把一次性的 OpenSSH 私钥。
///
/// 仓库里不放测试私钥（哪怕只用于 localhost，见 `wt-ssh::testing` 的注释），
/// 所以验收时现生成、用完即弃。生产构建（没有 `e2e-mock`）只返回错误，
/// 不会生成任何密钥。
#[tauri::command]
fn mock_generate_key() -> Result<String, String> {
    #[cfg(feature = "e2e-mock")]
    {
        let pem = wt_ssh::testing::MockSshServer::fresh_openssh_key(None);
        Ok(String::from_utf8_lossy(&pem).to_string())
    }
    #[cfg(not(feature = "e2e-mock"))]
    {
        Err("[E2E_ONLY] 生产构建不提供该命令".into())
    }
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
            ssh_open,
            sessions_load,
            import_mobaxterm,
            mock_generate_key
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
