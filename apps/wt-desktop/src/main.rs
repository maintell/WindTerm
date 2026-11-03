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

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use std::collections::HashMap;
use tauri::State;
use wt_ipc::{SessionHandle, SessionRegistry, SessionStats};
use wt_term::pty::PtyConfig;

/// 保险库的运行时状态。
struct VaultState {
    /// 已解锁的保险库；`None` 表示锁定或还没创建
    vault: Option<wt_crypto::Vault>,
    /// 解锁期间保留主密码：`Vault::seal` 每次都要重新派生密钥（Argon2id），
    /// 不保留的话用户每存一个密码就得重输一次主密码。
    /// 用 `Zeroizing` 保证丢弃时清零。
    password: Option<zeroize::Zeroizing<String>>,
}

impl VaultState {
    fn locked() -> Self {
        Self {
            vault: None,
            password: None,
        }
    }
}

struct AppState {
    registry: SessionRegistry,
    vault: std::sync::Mutex<VaultState>,
    /// 运行中的隧道（`NET-004`）。`LocalForward` 不是 `Clone`，停止时要从表里
    /// 取出来调用 `stop()`——所以存值而不是存引用。
    tunnels: std::sync::Mutex<HashMap<String, (TunnelMeta, RunningTunnel)>>,
    /// 库里的隧道配置。启动时读一次，增删改后同步更新——
    /// 不要在 1 s 一次的统计轮询里开 SQLite。
    tunnel_specs: std::sync::Mutex<Vec<wt_core::TunnelSpec>>,
}

/// 一条运行中的隧道。`-L`/`-D` 在本地监听、`-R` 在服务端监听——
/// 两者的停止与统计接口不同，用枚举收在一起，别让调用方到处 match 字段。
enum RunningTunnel {
    Local(wt_ssh::LocalForward),
    Remote(wt_ssh::RemoteForward),
}

impl RunningTunnel {
    fn stats(&self) -> wt_ssh::ForwardStats {
        match self {
            Self::Local(f) => f.stats(),
            Self::Remote(f) => f.stats(),
        }
    }

    async fn stop(self) {
        match self {
            Self::Local(f) => f.stop().await,
            Self::Remote(f) => f.stop().await,
        }
    }
}

/// 一条隧道的展示信息。运行期状态（字节数、连接数）在 `stats` 里实时取。
#[derive(Clone)]
struct TunnelMeta {
    id: String,
    name: String,
    /// `L` / `R` / `D`，目前只实现 `L` 与 `D`
    kind: char,
    listen_host: String,
    listen_port: u16,
    target_host: String,
    target_port: u16,
    /// 承载它的 SSH 目标，界面上按这个分组（`NET-004` 行为第 3 条）
    via: String,
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

#[derive(serde::Serialize)]
struct CredentialDto {
    id: String,
    name: String,
    session_id: Option<String>,
}

/// 列出保险库里的密码条目。
///
/// 用户有权知道自己的密码都存了哪些——没有这个列表，
/// 保险库就是个黑盒，删都无从删起。
#[tauri::command]
fn credential_list(state: State<'_, AppState>) -> Result<Vec<CredentialDto>, String> {
    let st = state.vault.lock().unwrap();
    let Some(vault) = st.vault.as_ref() else {
        return Err(locked_error());
    };
    Ok(vault
        .entries()
        .iter()
        .filter_map(|e| match e {
            wt_crypto::Entry::Password {
                id,
                name,
                session_id,
                ..
            } => Some(CredentialDto {
                id: id.clone(),
                name: name.clone(),
                session_id: session_id.clone(),
            }),
            _ => None,
        })
        .collect())
}

/// 删掉一条密码条目并重新落盘。
#[tauri::command]
fn credential_delete(
    state: State<'_, AppState>,
    entry_id: String,
) -> Result<VaultStatusDto, String> {
    let mut st = state.vault.lock().unwrap();
    let master = st.password.clone().ok_or_else(locked_error)?;
    {
        let Some(vault) = st.vault.as_mut() else {
            return Err(locked_error());
        };
        vault.remove(&entry_id).map_err(|e| e.to_string())?;
        let bytes = vault.seal(&master).map_err(|e| e.to_string())?;
        std::fs::write(vault_path(), bytes).map_err(|e| format!("写入保险库失败：{e}"))?;
    }
    Ok(status_of(&st))
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

// ── 保险库 ──────────────────────────────────────────────────

fn vault_path() -> std::path::PathBuf {
    data_dir().join("vault.wtvlt")
}

#[derive(serde::Serialize)]
struct VaultStatusDto {
    exists: bool,
    unlocked: bool,
    entries: usize,
}

fn status_of(state: &VaultState) -> VaultStatusDto {
    VaultStatusDto {
        exists: vault_path().exists(),
        unlocked: state.vault.is_some(),
        entries: state.vault.as_ref().map(|v| v.entries().len()).unwrap_or(0),
    }
}

fn locked_error() -> String {
    "[VAULT_LOCKED] 保险库已锁定，请先解锁".to_string()
}

#[tauri::command]
fn vault_status(state: State<'_, AppState>) -> VaultStatusDto {
    status_of(&state.vault.lock().unwrap())
}

/// 首次创建保险库并解锁。
#[tauri::command]
fn vault_create(state: State<'_, AppState>, password: String) -> Result<VaultStatusDto, String> {
    if vault_path().exists() {
        return Err("[VAULT_EXISTS] 保险库已存在，请直接解锁".into());
    }
    // 弱口令直接拒绝：保险库里装的是服务器密码，不是本地笔记
    wt_crypto::check_strength(&password).map_err(|e| e.to_string())?;

    let mut vault = wt_crypto::Vault::create(&password).map_err(|e| e.to_string())?;
    let bytes = vault.seal(&password).map_err(|e| e.to_string())?;
    std::fs::write(vault_path(), bytes).map_err(|e| format!("写入保险库失败：{e}"))?;

    let mut st = state.vault.lock().unwrap();
    st.vault = Some(vault);
    st.password = Some(zeroize::Zeroizing::new(password));
    Ok(status_of(&st))
}

#[tauri::command]
fn vault_unlock(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    password: String,
) -> Result<VaultStatusDto, String> {
    let bytes = std::fs::read(vault_path()).map_err(|e| format!("读取保险库失败：{e}"))?;
    let vault = wt_crypto::Vault::unlock(&bytes, &password).map_err(|e| e.to_string())?;

    let mut st = state.vault.lock().unwrap();
    st.vault = Some(vault);
    st.password = Some(zeroize::Zeroizing::new(password));
    let status = status_of(&st);
    drop(st);

    // 解锁之后才有凭据可用：把 `auto_start` 的隧道拉起来（`NET-005`）。
    // 放到后台：锁屏/慢网络下不该让「解锁保险库」这个按钮卡住。
    tauri::async_runtime::spawn(async move {
        use tauri::Manager as _;
        let state = app.state::<AppState>();
        for e in run_autostart(&state).await {
            trace(&format!("[autostart] 失败：{e}"));
        }
    });
    Ok(status)
}

#[tauri::command]
fn vault_lock(state: State<'_, AppState>) -> VaultStatusDto {
    let mut st = state.vault.lock().unwrap();
    st.vault = None;
    st.password = None;
    status_of(&st)
}

/// 保存某个会话的密码。同一会话只保留一条，重复保存是覆盖而不是堆积。
#[tauri::command]
fn credential_save(
    state: State<'_, AppState>,
    session_id: String,
    name: String,
    password: String,
) -> Result<VaultStatusDto, String> {
    let mut st = state.vault.lock().unwrap();
    // 先取主密码再可变借用 vault，避免同一个 MutexGuard 上两次借用
    let master = st.password.clone().ok_or_else(locked_error)?;
    let Some(vault) = st.vault.as_mut() else {
        return Err(locked_error());
    };

    let stale: Vec<String> = vault
        .entries()
        .iter()
        .filter(|e| matches!(e, wt_crypto::Entry::Password { session_id: Some(s), .. } if s == &session_id))
        .map(|e| e.id().to_string())
        .collect();
    for id in stale {
        vault.remove(&id).map_err(|e| e.to_string())?;
    }

    vault
        .add(wt_crypto::Entry::Password {
            id: wt_core::id::new_uuid(),
            name,
            secret: B64.encode(password.as_bytes()),
            session_id: Some(session_id),
        })
        .map_err(|e| e.to_string())?;

    let bytes = vault.seal(&master).map_err(|e| e.to_string())?;
    std::fs::write(vault_path(), bytes).map_err(|e| format!("写入保险库失败：{e}"))?;
    Ok(status_of(&st))
}

/// 取某个会话保存的密码。没存过返回 `None`（不是错误）。
#[tauri::command]
fn credential_get(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Option<String>, String> {
    let st = state.vault.lock().unwrap();
    let Some(vault) = st.vault.as_ref() else {
        return Err(locked_error());
    };
    let found = vault.entries().iter().find_map(|e| match e {
        wt_crypto::Entry::Password {
            secret,
            session_id: Some(s),
            ..
        } if s == &session_id => Some(secret.clone()),
        _ => None,
    });
    match found {
        Some(encoded) => {
            let raw = B64
                .decode(encoded)
                .map_err(|e| format!("凭据解码失败：{e}"))?;
            Ok(Some(String::from_utf8_lossy(&raw).to_string()))
        }
        None => Ok(None),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionSaveReq {
    /// 有 id 就是更新，没有就是新建
    #[serde(default)]
    id: Option<String>,
    name: String,
    host: String,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    user: Option<String>,
    /// 跳板机会话（`SES-024`）：存进 `options.jumpSessionId`，保存时做环检测
    #[serde(default)]
    jump_session_id: Option<String>,
}

/// 新建或更新一条会话。
///
/// 更新时保留原记录的其它字段（`folder_id`、`credential_ref`、协议选项等），
/// 只改名称/主机/端口/用户名——用户在界面上只看到这四项，不该顺手把它们抹掉。
#[tauri::command]
fn session_save(req: SessionSaveReq) -> Result<String, String> {
    let name = req.name.trim();
    let host = req.host.trim();
    if name.is_empty() {
        return Err("[SESSION_BAD_ARGUMENT] 会话名称不能为空".into());
    }
    if host.is_empty() {
        return Err("[SESSION_BAD_ARGUMENT] 主机不能为空".into());
    }

    let mut store = wt_store::Store::open(&sessions_db_path()).map_err(|e| e.to_string())?;
    let existing = match &req.id {
        Some(id) => store
            .load_snapshot()
            .map_err(|e| e.to_string())?
            .sessions
            .into_iter()
            .find(|s| s.id.as_str() == id),
        None => None,
    };

    let mut session = existing.unwrap_or_else(|| wt_core::Session {
        id: wt_core::SessionId::new(),
        folder_id: None,
        name: String::new(),
        kind: wt_core::SessionKind::Ssh,
        sort_order: 0,
        host: None,
        port: None,
        username: None,
        environment: None,
        credential_ref: None,
        options: Default::default(),
        settings: Default::default(),
        last_used_at: None,
        last_cwd: None,
        rev: 1,
    });
    session.name = name.to_string();
    session.host = Some(host.to_string());
    session.port = req.port;
    session.username = req
        .user
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty());

    let id = session.id.as_str().to_string();

    // 跳板机链在**保存时**校验（`SES-024` AC-4）：环引用与超过 5 跳都拒绝。
    // 放到连接时才发现，用户已经忘了自己怎么配的。
    let jump = req
        .jump_session_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(jump_id) = jump {
        if jump_id == id {
            return Err("[SES_JUMP_CYCLE] 会话不能把自己设为跳板机".into());
        }
        let snapshot = store.load_snapshot().map_err(|e| e.to_string())?;
        // 现有配置 + 本次改动 = 待校验的链
        let mut jumps: HashMap<String, String> = snapshot
            .sessions
            .iter()
            .filter_map(|s| s.jump().map(|j| (s.id.as_str().to_string(), j.as_str().to_string())))
            .collect();
        jumps.insert(id.clone(), jump_id.to_string());
        wt_core::validate_jump_chain(&session.id, |sid| {
            jumps
                .get(sid.as_str())
                .map(|j| vec![wt_core::SessionId::from(j.as_str())])
                .unwrap_or_default()
        })
        .map_err(|e| e.to_string())?;
    }
    match jump {
        Some(jump_id) => session.set_jump(Some(wt_core::SessionId::from(jump_id))),
        None => session.set_jump(None),
    }

    store.upsert_session(&session).map_err(|e| e.to_string())?;
    Ok(id)
}

/// 删除一条会话，并顺手清掉保险库里属于它的密码。
///
/// 顺序是「先清保险库、再删会话」：前者失败就整体报错、什么都不动，
/// 免得出现「会话没了、密码还在库里」这种更难收拾的中间态。
#[tauri::command]
fn session_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    {
        let mut st = state.vault.lock().unwrap();
        if let Some(master) = st.password.clone() {
            if let Some(vault) = st.vault.as_mut() {
                let stale: Vec<String> = vault
                    .entries()
                    .iter()
                    .filter(|e| {
                        matches!(e, wt_crypto::Entry::Password { session_id: Some(s), .. } if s == &id)
                    })
                    .map(|e| e.id().to_string())
                    .collect();
                if !stale.is_empty() {
                    for entry in stale {
                        vault.remove(&entry).map_err(|e| e.to_string())?;
                    }
                    let bytes = vault.seal(&master).map_err(|e| e.to_string())?;
                    std::fs::write(vault_path(), bytes)
                        .map_err(|e| format!("写入保险库失败：{e}"))?;
                }
            }
        }
    }

    let mut store = wt_store::Store::open(&sessions_db_path()).map_err(|e| e.to_string())?;
    store
        .delete_session(&wt_core::SessionId::from(id.as_str()))
        .map_err(|e| e.to_string())?;
    Ok(())
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

/// 用 accept-new 建立连接：密钥未知就记下来再连一次，变了就拒。
///
/// 三处调用（`ssh_open`、`open_sftp`、`tunnel_start`）必须**行为完全一致**：
/// 只要有一处不同，「同一次点击里 SSH 能连、文件面板却连不上」这种问题就会
/// 出现，而且没人能解释为什么。返回的 `bool` 表示本次是否新增了主机密钥
/// （界面据此提示用户已经记录指纹）。
async fn connect_accept_new(
    cfg: &wt_ssh::SshConfig,
    auth: &AuthInput,
    jump: Option<&JumpReq>,
) -> Result<(wt_ssh::SshConnection, bool), String> {
    let Some(jump) = jump else {
        return connect_direct_accept_new(cfg, auth).await;
    };

    // 先登录跳板机（它自己的主机密钥也走 accept-new），再在它上面连目标
    let jump_cfg = wt_ssh::SshConfig {
        host: jump.host.trim().to_string(),
        port: jump.port,
        user: jump.user.trim().to_string(),
        ..Default::default()
    };
    if jump_cfg.host.is_empty() || jump_cfg.user.is_empty() {
        return Err("[SSH_BAD_ARGUMENT] 跳板机的主机与用户名都不能为空".into());
    }
    let jump_link = format!("{}:{}", jump_cfg.host, jump_cfg.port);
    // 跳板机自身的凭据（`SES-024` 行为规格第 4 条：不继承目标会话的）
    let jump_auth = AuthInput::Password(jump.password.clone());
    let (jump_conn, jump_added) = connect_direct_accept_new(&jump_cfg, &jump_auth).await?;
    trace(&format!("[connect] 第 1 跳 {jump_link} 就绪"));

    let target_auth = ssh_auth(auth);
    let mut known = load_known_hosts();
    match wt_ssh::connect_via(
        &jump_conn,
        &jump_link,
        cfg,
        &target_auth,
        known_policy(&known),
    )
    .await
    {
        Ok(c) => Ok((c, jump_added)),
        Err(e) if e.code == wt_common::codes::SSH_HOSTKEY_UNKNOWN => {
            // 跳板机后面的目标**没法 probe**（`probe_host_key` 是直连的，目标只有
            // 跳板机能到）。所以用 AcceptAll 连上，再用 `trust_observed_key` 把这次
            // 看到的主机密钥补进 known_hosts——这就是它存在的理由。
            let conn = wt_ssh::connect_via(
                &jump_conn,
                &jump_link,
                cfg,
                &target_auth,
                wt_ssh::HostKeyPolicy::AcceptAll,
            )
            .await
            .map_err(|e| e.to_string())?;
            conn.trust_observed_key(&mut known, false)
                .map_err(|e| e.to_string())?;
            save_known_hosts(&known)?;
            trace("[connect] 目标主机密钥未知 → 已记录（经跳板，无法 probe）");
            Ok((conn, true))
        }
        Err(e) => Err(e.to_string()),
    }
}

/// 直连的 accept-new（跳板机自己就走这条）。
async fn connect_direct_accept_new(
    cfg: &wt_ssh::SshConfig,
    auth: &AuthInput,
) -> Result<(wt_ssh::SshConnection, bool), String> {
    let mut known = load_known_hosts();
    match try_connect(cfg, auth, known_policy(&known)).await {
        Ok(c) => Ok((c, false)),
        Err(e) if e.code == wt_common::codes::SSH_HOSTKEY_UNKNOWN => {
            let observed = wt_ssh::SshConnection::probe_host_key(cfg)
                .await
                .map_err(|e| e.to_string())?;
            known.add(&cfg.endpoint(), &observed.key_type, &observed.blob, false);
            save_known_hosts(&known)?;
            let conn = try_connect(cfg, auth, known_policy(&known))
                .await
                .map_err(|e| e.to_string())?;
            Ok((conn, true))
        }
        Err(e) => Err(e.to_string()),
    }
}

/// 界面层的认证输入 → `wt-ssh` 的 `Auth`。
fn ssh_auth(input: &AuthInput) -> wt_ssh::Auth<'_> {
    match input {
        AuthInput::Password(p) => wt_ssh::Auth::Password(p),
        AuthInput::Key(k) => wt_ssh::Auth::Key(k),
        AuthInput::Agent => wt_ssh::Auth::Agent,
    }
}

/// 跳板机参数（`SES-024`）。
///
/// 目前是连接表单里的临时选项，**还不是会话属性**：`jump.sessionId` 没进数据模型，
/// 见 README 的 `G14`。凭据独立于目标会话（规格第 4 条）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct JumpReq {
    host: String,
    port: u16,
    user: String,
    #[serde(default)]
    password: String,
}

/// 认证方式：密码、一把私钥（可带口令），或 ssh-agent 里的身份。
enum AuthInput {
    Password(String),
    Key(wt_ssh::PrivateKeySource),
    Agent,
}

fn known_policy(known: &wt_ssh::KnownHosts) -> wt_ssh::HostKeyPolicy {
    wt_ssh::HostKeyPolicy::Known(Box::new(known.clone()))
}

async fn try_connect(
    cfg: &wt_ssh::SshConfig,
    auth: &AuthInput,
    policy: wt_ssh::HostKeyPolicy,
) -> Result<wt_ssh::SshConnection, wt_common::WtError> {
    // 三条认证路径在 `wt-ssh` 里已经收敛成一份实现，这里只做类型转换
    wt_ssh::SshConnection::connect(cfg, &ssh_auth(auth), policy).await
}

/// 从请求里挑出认证方式：agent > 密钥 > 密码。
///
/// 顺序很重要：勾了 agent 就不该再悄悄用密码兜底——那会掩盖「agent 里没有
/// 被接受的密钥」这种问题，用户以为 agent 生效了。
fn auth_of(req: &SshOpenReq) -> AuthInput {
    if req.use_agent {
        return AuthInput::Agent;
    }
    match req.key_pem.as_ref() {
        Some(pem) if !pem.trim().is_empty() => AuthInput::Key(wt_ssh::PrivateKeySource::new(
            pem.clone().into_bytes(),
            req.key_passphrase.clone(),
        )),
        _ => AuthInput::Password(req.password.clone().unwrap_or_default()),
    }
}

/// `ssh_open` 的入参。收成一个结构体而不是 9 个位置参数——
/// 参数一多就容易传错位，而且 clippy 也会报 `too_many_arguments`。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SshOpenReq {
    host: String,
    #[serde(default)]
    port: Option<u16>,
    user: String,
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    key_pem: Option<String>,
    #[serde(default)]
    key_passphrase: Option<String>,
    /// 用 ssh-agent 里的身份认证（私钥不出 agent）
    #[serde(default)]
    use_agent: bool,
    cols: u16,
    rows: u16,
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
    req: SshOpenReq,
    jump: Option<JumpReq>,
) -> Result<SshOpenDto, String> {
    // 先定认证方式（要读 req 的多个字段），再解构出连接参数
    let auth = auth_of(&req);
    let SshOpenReq {
        host, port, user, cols, rows, ..
    } = req;
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

    let (conn, host_key_added) = connect_accept_new(&cfg, &auth, jump.as_ref()).await?;

    let fingerprint = conn.server_fingerprint().unwrap_or_default();
    // 空闲连接会被 NAT/防火墙静默断开，按会话配置发心跳（默认 30 秒）；
    // 连续 max_missed 次无回应判定断开
    let keepalive = (cfg.keepalive_secs > 0).then(|| {
        wt_ssh::Keepalive::new(
            std::time::Duration::from_secs(u64::from(cfg.keepalive_secs)),
            cfg.keepalive_max_missed,
        )
    });
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

/// mock 的 SFTP 文件系统，供 `mock_seed_file` 预置文件。
#[cfg(feature = "e2e-mock")]
static MOCK_FS: std::sync::OnceLock<wt_ssh::testing::MockFs> = std::sync::OnceLock::new();
#[cfg(feature = "e2e-mock")]
static MOCK_PORT: std::sync::OnceLock<u16> = std::sync::OnceLock::new();

/// 诊断用：mock 服务端的端口（前端拿不到 stdout，用一个命令问）
#[tauri::command]
fn e2e_mock_port() -> u16 {
    #[cfg(feature = "e2e-mock")]
    {
        MOCK_PORT.get().copied().unwrap_or(0)
    }
    #[cfg(not(feature = "e2e-mock"))]
    {
        0
    }
}

/// 端到端验收专用：往 mock 的 SFTP 文件系统里预置一个文件（内容 base64）。
#[tauri::command]
async fn mock_seed_file(path: String, content: String) -> Result<(), String> {
    #[cfg(feature = "e2e-mock")]
    {
        let fs = MOCK_FS
            .get()
            .ok_or_else(|| "[E2E_ONLY] mock 服务端未启动".to_string())?;
        let data = B64
            .decode(content)
            .map_err(|e| format!("内容解码失败：{e}"))?;
        fs.lock().await.insert(path, data);
        Ok(())
    }
    #[cfg(not(feature = "e2e-mock"))]
    {
        let _ = (path, content);
        Err("[E2E_ONLY] 生产构建不提供该命令".into())
    }
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

// ── SFTP ────────────────────────────────────────────────────
//
// 主机密钥策略在这里**不是**特例：与 `ssh_open` 一样先 `Known`、密钥未知就走
// accept-new，没有「自己 probe 一遍再 AcceptAll」那套旁路。
//
// G8 复盘：一段时期里这里堆了多层「绕开挂起」的补丁（旁路 known_hosts、
// 换参数形态、换返回类型、包超时），全都基于误判。真实原因是 mock 把每个条目
// 都报成目录导致断言永远匹配不上，加上 CSP 漏了 `connect-src ipc:` 让 IPC
// 一直走 postMessage 回退。补丁已全部移除——**先拿到证据再改代码**。

#[derive(serde::Serialize)]
struct RemoteEntryDto {
    name: String,
    is_dir: bool,
    size: u64,
}

#[derive(serde::Serialize)]
struct SftpListDto {
    path: String,
    entries: Vec<RemoteEntryDto>,
}

/// 按请求建连并打开 sftp，用完随 `SftpClient` 一起释放。
///
/// 每次文件操作独立建连：面板操作是低频的（列目录、传一个文件），
/// 多一次握手百来毫秒，换掉「跨命令持有通道流」那一整类问题（通道与连接必须同寿命）。
async fn open_sftp(
    req: SshOpenReq,
    jump: Option<JumpReq>,
) -> Result<wt_ssh::SftpClient, String> {
    let _scope = TraceScope::enter("open_sftp");
    let cfg = wt_ssh::SshConfig {
        host: req.host.trim().to_string(),
        port: req.port.unwrap_or(22),
        user: req.user.trim().to_string(),
        ..Default::default()
    };
    trace(&format!(
        "[open_sftp] 参数 host={} port={} user={} agent={} key={} pw={}",
        cfg.host,
        cfg.port,
        cfg.user,
        req.use_agent,
        req.key_pem.is_some(),
        req.password.is_some()
    ));
    if cfg.host.is_empty() {
        return Err("[SSH_BAD_ARGUMENT] 主机不能为空".into());
    }
    if cfg.user.is_empty() {
        return Err("[SSH_BAD_ARGUMENT] 用户名不能为空".into());
    }

    let auth = auth_of(&req);
    trace("[open_sftp] 认证方式已定");

    // 主机密钥与 `ssh_open` 走完全相同的 accept-new 路径（见 `connect_accept_new`）
    let (conn, _added) = connect_accept_new(&cfg, &auth, jump.as_ref()).await?;
    trace("[open_sftp] ← 连接就绪");

    let client = wt_ssh::SftpClient::open(conn)
        .await
        .map_err(|e| e.to_string())?;
    trace("[open_sftp] ← SftpClient::open 返回");
    Ok(client)
}

/// `sftp_list` 的入参。
///
/// 收成**单个**结构体参数，而不是 `(req, path)` 两个参数。
/// 实测：两个参数（其中一个是结构体）时，界面点击触发的命令不返回；
/// 同样的工作收成一个参数就正常（G8）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SftpListArg {
    req: SshOpenReq,
    path: String,
    /// `SES-024`：经跳板机连（与 `ssh_open` 同一套参数）
    #[serde(default)]
    jump: Option<JumpReq>,
}

/// 列远端目录。
#[tauri::command]
async fn sftp_list(arg: SftpListArg) -> Result<SftpListDto, String> {
    let _scope = TraceScope::enter("sftp_list");
    let SftpListArg { req, path, jump } = arg;
    trace(&format!(
        "[sftp_list] 参数 host={} user={} path={} jump={}",
        req.host,
        req.user,
        path,
        jump.is_some()
    ));
    let sftp = open_sftp(req, jump).await?;
    trace("[sftp_list] open_sftp 完成");
    let entries = sftp.list_dir(&path).await.map_err(|e| e.to_string())?;
    trace(&format!("[sftp_list] list_dir 完成，{} 条", entries.len()));
    let dto = SftpListDto {
        path,
        entries: entries
            .into_iter()
            .map(|e| RemoteEntryDto {
                name: e.name,
                is_dir: e.is_dir,
                size: e.size,
            })
            .collect(),
    };
    trace("[sftp_list] DTO 组装完成，即将返回");
    Ok(dto)
}

#[derive(serde::Serialize)]
struct DownloadDto {
    bytes: usize,
    /// 落地的绝对路径。用户得能在资源管理器里找到这个文件，
    /// 所以不能只回「成功」——那样等于把一个下载结果藏起来。
    saved_to: String,
}

/// 本地下载目录。
///
/// `WT_DOWNLOAD_DIR` 供便携模式与端到端验收覆盖：验收要断言「文件真的落盘了、
/// 内容就是远端那份」，落到用户的真实下载目录里既污染又难断言。
fn download_dir() -> std::path::PathBuf {
    if let Ok(dir) = std::env::var("WT_DOWNLOAD_DIR") {
        if !dir.trim().is_empty() {
            return std::path::PathBuf::from(dir);
        }
    }
    let home = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".to_string());
    std::path::PathBuf::from(home).join("Downloads")
}

/// 在目录里挑一个不会覆盖已有文件的名字：`a.txt` → `a (1).txt` → `a (2).txt`。
///
/// 直接覆盖是数据丢失——用户下载同名文件时不会预期旧的被悄悄替换掉。
fn unique_path(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let path = std::path::Path::new(name);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("download");
    let ext = path.extension().and_then(|s| s.to_str());
    for n in 1..1000 {
        let file = match ext {
            Some(ext) => format!("{stem} ({n}).{ext}"),
            None => format!("{stem} ({n})"),
        };
        let candidate = dir.join(file);
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(name)
}

#[tauri::command]
async fn sftp_download(
    req: SshOpenReq,
    path: String,
    jump: Option<JumpReq>,
) -> Result<DownloadDto, String> {
    let _scope = TraceScope::enter("sftp_download");
    let sftp = open_sftp(req, jump).await?;
    let data = sftp.read_file(&path).await.map_err(|e| e.to_string())?;
    trace(&format!("[sftp_download] 读到 {} 字节", data.len()));

    let name = path
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("download.bin");
    let dir = download_dir();
    // 用 `std::fs` 而不是 `tokio::fs`：`read_file` 已经把整个文件读进内存了，
    // 这里只是把同一个缓冲区写出去，再加一层异步文件 IO 换不来什么，
    // 却要为桌面端引入 tokio 的 fs 特性。
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("无法创建下载目录 {}：{e}", dir.display()))?;
    let target = unique_path(&dir, name);
    std::fs::write(&target, &data)
        .map_err(|e| format!("无法写入 {}：{e}", target.display()))?;
    let saved_to = target.display().to_string();
    trace(&format!("[sftp_download] 已保存到 {saved_to}"));

    Ok(DownloadDto {
        bytes: data.len(),
        saved_to,
    })
}

/// 上传：按 64 KB 分块写，并把**累计字节数**通过 `Channel` 推给前端。
///
/// 进度必须来自真实写入节奏——「传完再报 100%」是假进度，用户看不出卡住还是快好了。
/// 分块同时是将来做断点续传的前提（`FIL-019` 的下一半）。
#[tauri::command]
async fn sftp_upload(
    req: SshOpenReq,
    path: String,
    content: String,
    jump: Option<JumpReq>,
    // `Channel` 不是 serde 类型，只能是必填参数（`Option<Channel>` 编译不过）
    progress: tauri::ipc::Channel<u64>,
) -> Result<usize, String> {
    let data = B64
        .decode(content)
        .map_err(|e| format!("上传内容解码失败：{e}"))?;
    let len = data.len();
    let sftp = open_sftp(req, jump).await?;
    sftp.write_file_chunked(&path, &data, |written| {
        // 前端关掉面板时通道会断，这里不能因此让上传失败
        let _ = progress.send(written);
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(len)
}

// ── 隧道（NET-001 / NET-004）────────────────────────────────
//
// 每条隧道一条独立的 SSH 承载连接。看起来浪费，但换来两件事：
// ① 隧道生命周期与会话生命周期解耦——关掉终端标签不会顺手掐断正在传数据的隧道；
// ② 停止/重启隧道不用碰会话注册表那一整套状态。
// `NET-004` 的「按承载会话分组」在界面上按 `via`（user@host）分组即可。

#[derive(serde::Serialize)]
struct TunnelDto {
    id: String,
    name: String,
    /// `L` / `R` / `D`。目前只实现 `L` 与 `D`，其余两种在界面上不出现
    kind: String,
    /// 实际监听地址（`listen_port = 0` 时是系统分配的端口；未运行时是配置值）
    listen: String,
    target: String,
    /// 承载它的 SSH 目标，界面按这个分组
    via: String,
    /// 是否正在运行。库里存着的隧道也会出现在列表里，但为 `false`
    running: bool,
    active: usize,
    total: usize,
    up_bytes: u64,
    down_bytes: u64,
    /// 最近一次转发失败的原因；成功转发后清空。界面据此把「运行中」降级成红色
    last_error: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TunnelStartArg {
    /// 与 `ssh_open` / `open_sftp` 同一套连接参数（flatten 进本结构体）
    #[serde(flatten)]
    req: SshOpenReq,
    /// `local`（默认，`NET-001`）或 `dynamic`（SOCKS5，`NET-003`）
    #[serde(default)]
    kind: Option<String>,
    /// 显示名。省略时用「目标 或 监听端口」拼一个，方便下次认出来
    #[serde(default)]
    name: Option<String>,
    /// 承载会话：存下来，下次可以从这条会话的凭据直接拉起
    #[serde(default)]
    via_session_id: Option<String>,
    #[serde(default)]
    listen_host: Option<String>,
    listen_port: u16,
    #[serde(default)]
    target_host: String,
    #[serde(default)]
    target_port: u16,
    /// 监听 `0.0.0.0` 等对外地址必须显式确认（`NET-001` 行为规格第 1 条）
    #[serde(default)]
    allow_lan: bool,
    /// 应用启动后自动拉起（`NET-005`）。界面暂未提供开关，先落库保证语义不掉
    #[serde(default)]
    auto_start: Option<bool>,
    /// `SES-024`：经跳板机建承载连接
    #[serde(default)]
    jump: Option<JumpReq>,
}

/// 隧道 id 序号。只在本进程内有意义（隧道不落库，见 G10 之后的持久化计划），
/// 用递增序号而不是随机串：出问题时人能一眼对上界面上的列表。
static TUNNEL_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn tunnel_dto(meta: &TunnelMeta, fwd: &RunningTunnel) -> TunnelDto {
    let s = fwd.stats();
    TunnelDto {
        id: meta.id.clone(),
        name: meta.name.clone(),
        kind: meta.kind.to_string(),
        listen: format!("{}:{}", meta.listen_host, meta.listen_port),
        target: format!("{}:{}", meta.target_host, meta.target_port),
        via: meta.via.clone(),
        running: true,
        active: s.active,
        total: s.total,
        up_bytes: s.up_bytes,
        down_bytes: s.down_bytes,
        last_error: s.last_error,
    }
}

/// 只存在于库里的隧道：状态灯为灰，计数全零。
///
/// 不编造统计值（比如沿用上次的字节数）——那会让「已停止」看起来像「在跑但没流量」。
fn tunnel_dto_from_spec(spec: &wt_core::TunnelSpec) -> TunnelDto {
    let kind = match spec.kind {
        wt_core::TunnelKind::Local => "L",
        wt_core::TunnelKind::Remote => "R",
        wt_core::TunnelKind::Dynamic => "D",
    };
    let target = match (&spec.target_host, spec.target_port) {
        (Some(h), Some(p)) => format!("{h}:{p}"),
        _ => String::new(),
    };
    TunnelDto {
        id: spec.id.clone(),
        name: spec.name.clone(),
        kind: kind.to_string(),
        listen: format!("{}:{}", spec.listen_host, spec.listen_port),
        target,
        via: spec
            .via_session_id
            .as_ref()
            .map(|s| s.as_str().to_string())
            .unwrap_or_default(),
        running: false,
        active: 0,
        total: 0,
        up_bytes: 0,
        down_bytes: 0,
        last_error: None,
    }
}

/// 读出库里的隧道配置。库不存在就是空——不为了「读隧道」去建一个空库。
fn load_tunnel_specs() -> Vec<wt_core::TunnelSpec> {
    let db = sessions_db_path();
    if !db.exists() {
        return Vec::new();
    }
    match wt_store::Store::open(&db).and_then(|s| s.load_snapshot()) {
        Ok(snap) => snap.tunnels,
        Err(_) => Vec::new(),
    }
}

#[tauri::command]
async fn tunnel_start(
    state: State<'_, AppState>,
    arg: TunnelStartArg,
) -> Result<TunnelDto, String> {
    let _scope = TraceScope::enter("tunnel_start");
    let listen_host = arg
        .listen_host
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("127.0.0.1")
        .to_string();
    // 三种隧道：`-L` 监听本地、`-D` 本地 SOCKS5、`-R` 监听**服务端**
    let kind = match arg.kind.as_deref().unwrap_or("local") {
        "local" => wt_core::TunnelKind::Local,
        "dynamic" => wt_core::TunnelKind::Dynamic,
        "remote" => wt_core::TunnelKind::Remote,
        other => {
            return Err(format!(
                "[TUN_BAD_ARGUMENT] 不认识的隧道类型 {other}（只支持 local / dynamic / remote）"
            ))
        }
    };
    let dynamic = kind == wt_core::TunnelKind::Dynamic;
    let target_host = arg.target_host.trim().to_string();
    if !dynamic && target_host.is_empty() {
        return Err("[TUN_BAD_ARGUMENT] 目标主机不能为空".into());
    }
    if wt_ssh::exposes_to_lan(&listen_host) && !arg.allow_lan {
        let what = if dynamic {
            "SOCKS5 代理".to_string()
        } else {
            format!("{target_host}:{}", arg.target_port)
        };
        return Err(format!(
            "[TUN_LAN_CONFIRM_REQUIRED] 监听 {listen_host} 会让局域网内任何人都能通过它访问 \
             {what}；确认后勾选「允许局域网访问」再启动"
        ));
    }

    let cfg = wt_ssh::SshConfig {
        host: arg.req.host.trim().to_string(),
        port: arg.req.port.unwrap_or(22),
        user: arg.req.user.trim().to_string(),
        ..Default::default()
    };
    if cfg.host.is_empty() {
        return Err("[SSH_BAD_ARGUMENT] 主机不能为空".into());
    }
    if cfg.user.is_empty() {
        return Err("[SSH_BAD_ARGUMENT] 用户名不能为空".into());
    }

    let auth = auth_of(&arg.req);
    let (conn, _added) = connect_accept_new(&cfg, &auth, arg.jump.as_ref()).await?;
    trace("[tunnel_start] 承载连接就绪");

    let via = format!("{}@{}", cfg.user, cfg.host);
    let conn = std::sync::Arc::new(conn);
    let (fwd, bound) = match kind {
        wt_core::TunnelKind::Dynamic => {
            let f = wt_ssh::start_socks5(conn, &listen_host, arg.listen_port, None)
                .await
                .map_err(|e| e.to_string())?;
            let p = f.listen_addr().port();
            (RunningTunnel::Local(f), p)
        }
        wt_core::TunnelKind::Local => {
            let f = wt_ssh::start_local(
                conn,
                &listen_host,
                arg.listen_port,
                &target_host,
                arg.target_port,
            )
            .await
            .map_err(|e| e.to_string())?;
            let p = f.listen_addr().port();
            (RunningTunnel::Local(f), p)
        }
        wt_core::TunnelKind::Remote => {
            // `-R`：监听在服务端（`listen_host:listen_port`），目标是本地
            let f = wt_ssh::start_remote(
                conn,
                &listen_host,
                arg.listen_port,
                &target_host,
                arg.target_port,
            )
            .await
            .map_err(|e| e.to_string())?;
            let p = f
                .remote_addr()
                .rsplit(':')
                .next()
                .and_then(|s| s.parse().ok())
                .unwrap_or(arg.listen_port);
            (RunningTunnel::Remote(f), p)
        }
    };

    let listen_port = bound;
    trace(&format!("[tunnel_start] 已监听 {listen_host}:{listen_port}"));
    let id = format!("f{}", TUNNEL_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    let name = arg
        .name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            if dynamic {
                format!("SOCKS5 {listen_port}")
            } else {
                format!("{target_host}:{}", arg.target_port)
            }
        });
    let via_session_id = arg
        .via_session_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(wt_core::SessionId::from);
    let meta = TunnelMeta {
        id: id.clone(),
        name,
        kind: match kind {
            wt_core::TunnelKind::Dynamic => 'D',
            wt_core::TunnelKind::Remote => 'R',
            wt_core::TunnelKind::Local => 'L',
        },
        listen_host: listen_host.clone(),
        listen_port,
        // 动态代理没有固定目标
        target_host: if dynamic { String::new() } else { target_host.clone() },
        target_port: if dynamic { 0 } else { arg.target_port },
        via,
    };
    let dto = tunnel_dto(&meta, &fwd);

    // 落库：配置要能在重启后还在（`G13`）。存的是**配置**不是运行状态，
    // 而且 `listen_port` 存的是用户填的值（0 = 每次随机），不是这次分配到的端口。
    let spec = wt_core::TunnelSpec {
        id: id.clone(),
        name: meta.name.clone(),
        kind,
        listen_host: listen_host.clone(),
        listen_port: arg.listen_port,
        target_host: if dynamic { None } else { Some(target_host) },
        target_port: if dynamic { None } else { Some(arg.target_port) },
        via_session_id,
        auto_start: arg.auto_start.unwrap_or(false),
    };
    if let Ok(mut store) = wt_store::Store::open(&sessions_db_path()) {
        if let Err(e) = store.upsert_tunnel(&spec) {
            // 存不下来不该让已经跑起来的隧道失败，但必须说清楚
            trace(&format!("[tunnel_start] 配置落库失败：{e}"));
            set_tunnel_spec_cache(&state, spec.clone(), true);
            state
                .tunnels
                .lock()
                .map_err(|_| "[INTERNAL] 隧道表状态异常".to_string())?
                .insert(id, (meta, fwd));
            return Err(format!("隧道已启动，但配置没能保存：{e}"));
        }
    }
    set_tunnel_spec_cache(&state, spec, false);
    state
        .tunnels
        .lock()
        .map_err(|_| "[INTERNAL] 隧道表状态异常".to_string())?
        .insert(id, (meta, fwd));
    Ok(dto)
}

/// 更新内存里的配置缓存（`replace = true` 表示覆盖同 id 的旧项）。
fn set_tunnel_spec_cache(state: &State<'_, AppState>, spec: wt_core::TunnelSpec, replace: bool) {
    if let Ok(mut specs) = state.tunnel_specs.lock() {
        if replace {
            if let Some(slot) = specs.iter_mut().find(|s| s.id == spec.id) {
                *slot = spec;
                return;
            }
        }
        specs.retain(|s| s.id != spec.id);
        specs.push(spec);
    }
}

/// 实时统计（`NET-004` 要求 ≤ 2 s 刷新，界面按 1 s 轮询）。
///
/// 返回**两类**：正在跑的（带实时计数）与只存在于库里的（灰灯）。
/// 只返回正在跑的会让用户以为「保存过的隧道没保存成功」。
#[tauri::command]
fn tunnel_stats(state: State<'_, AppState>) -> Result<Vec<TunnelDto>, String> {
    let running = state
        .tunnels
        .lock()
        .map_err(|_| "[INTERNAL] 隧道表状态异常".to_string())?;
    let specs = state
        .tunnel_specs
        .lock()
        .map_err(|_| "[INTERNAL] 隧道配置状态异常".to_string())?;

    let mut out = Vec::new();
    for spec in specs.iter() {
        match running.get(&spec.id) {
            Some((meta, fwd)) => out.push(tunnel_dto(meta, fwd)),
            None => out.push(tunnel_dto_from_spec(spec)),
        }
    }
    // 运行时新建但没进缓存的（落库失败那条路径）也要显示，不能凭空少一条
    for (id, (meta, fwd)) in running.iter() {
        if !specs.iter().any(|s| &s.id == id) {
            out.push(tunnel_dto(meta, fwd));
        }
    }
    Ok(out)
}

/// 从库里的配置拉起一条隧道。
///
/// 承载连接用 `viaSessionId` 指向的会话：主机/端口/用户名从会话取，
/// 密码从保险库取。**没有保存密码时直接说清楚**，而不是弹一个空密码去认证，
/// 让用户对着「认证失败」猜自己是不是填错了。
#[tauri::command]
async fn tunnel_start_saved(state: State<'_, AppState>, id: String) -> Result<TunnelDto, String> {
    let spec = {
        let specs = state
            .tunnel_specs
            .lock()
            .map_err(|_| "[INTERNAL] 隧道配置状态异常".to_string())?;
        specs
            .iter()
            .find(|s| s.id == id)
            .cloned()
            .ok_or_else(|| format!("[TUN_UNKNOWN] 没有 id 为 {id} 的隧道"))
    }?;
    start_spec(&state, &spec).await
}

/// 用一条已保存的配置拉起隧道。
///
/// 手动「启动」与自动启动（`NET-005`）共用这一条路径：两处各写一遍，
/// 迟早出现「手动能启动、自动启动报的错不一样」这种差异。
async fn start_spec(state: &AppState, spec: &wt_core::TunnelSpec) -> Result<TunnelDto, String> {
    let session_id = spec.via_session_id.as_ref().ok_or_else(|| {
        "[TUN_NO_SESSION] 这条隧道没有记录承载会话，无法直接用保存的配置启动；\
         请在表单里重新填写并启动一次（会覆盖保存）"
            .to_string()
    })?;

    // 会话参数
    let store = wt_store::Store::open(&sessions_db_path()).map_err(|e| e.to_string())?;
    let snap = store.load_snapshot().map_err(|e| e.to_string())?;
    let session = snap
        .sessions
        .iter()
        .find(|s| s.id == *session_id)
        .ok_or_else(|| {
            format!(
                "[TUN_NO_SESSION] 承载会话 {} 已经不存在了；请重新指定",
                session_id.as_str()
            )
        })?;
    let host = session.host.clone().unwrap_or_default();
    let user = session.username.clone().unwrap_or_default();
    if host.is_empty() || user.is_empty() {
        return Err("[TUN_NO_SESSION] 承载会话缺少主机或用户名".into());
    }

    // 密码：只从保险库取，不猜
    let password = {
        let st = state.vault.lock().unwrap();
        let Some(vault) = st.vault.as_ref() else {
            return Err(
                "[VAULT_LOCKED] 保险库没解锁，无法取出承载会话的密码；先解锁再启动".into(),
            );
        };
        vault
            .entries()
            .iter()
            .find_map(|e| match e {
                wt_crypto::Entry::Password {
                    secret,
                    session_id: Some(s),
                    ..
                } if *s == session_id.as_str() => B64.decode(secret).ok(),
                _ => None,
            })
            .map(|raw| String::from_utf8_lossy(&raw).to_string())
    };
    let Some(password) = password else {
        return Err(format!(
            "[TUN_NO_PASSWORD] 承载会话 {} 没有保存密码；先在会话树里连一次并勾「记住密码」",
            session.name
        ));
    };

    let cfg = wt_ssh::SshConfig {
        host,
        port: session.port.unwrap_or(22),
        user,
        ..Default::default()
    };
    let auth = AuthInput::Password(password);
    let (conn, _added) = connect_accept_new(&cfg, &auth, None).await?;
    let conn = std::sync::Arc::new(conn);
    let (fwd, bound) = match spec.kind {
        wt_core::TunnelKind::Dynamic => {
            let f = wt_ssh::start_socks5(conn, &spec.listen_host, spec.listen_port, None)
                .await
                .map_err(|e| e.to_string())?;
            let p = f.listen_addr().port();
            (RunningTunnel::Local(f), p)
        }
        wt_core::TunnelKind::Local => {
            let target_host = spec.target_host.clone().unwrap_or_default();
            let target_port = spec.target_port.unwrap_or(0);
            let f = wt_ssh::start_local(
                conn,
                &spec.listen_host,
                spec.listen_port,
                &target_host,
                target_port,
            )
            .await
            .map_err(|e| e.to_string())?;
            let p = f.listen_addr().port();
            (RunningTunnel::Local(f), p)
        }
        wt_core::TunnelKind::Remote => {
            // `-R` 是反的：监听在**服务端**，目标在本地
            let local_host = spec.target_host.clone().unwrap_or_default();
            let local_port = spec.target_port.unwrap_or(0);
            let f = wt_ssh::start_remote(
                conn,
                &spec.listen_host,
                spec.listen_port,
                &local_host,
                local_port,
            )
            .await
            .map_err(|e| e.to_string())?;
            let p = f
                .remote_addr()
                .rsplit(':')
                .next()
                .and_then(|s| s.parse().ok())
                .unwrap_or(spec.listen_port);
            (RunningTunnel::Remote(f), p)
        }
    };

    let meta = TunnelMeta {
        id: spec.id.clone(),
        name: spec.name.clone(),
        kind: match spec.kind {
            wt_core::TunnelKind::Dynamic => 'D',
            wt_core::TunnelKind::Remote => 'R',
            wt_core::TunnelKind::Local => 'L',
        },
        listen_host: spec.listen_host.clone(),
        listen_port: bound,
        target_host: spec.target_host.clone().unwrap_or_default(),
        target_port: spec.target_port.unwrap_or(0),
        via: session.name.clone(),
    };
    let dto = tunnel_dto(&meta, &fwd);
    state
        .tunnels
        .lock()
        .map_err(|_| "[INTERNAL] 隧道表状态异常".to_string())?
        .insert(spec.id.clone(), (meta, fwd));
    Ok(dto)
}

/// 把库里 `auto_start = true` 且未运行的隧道拉起来（`NET-005`）。
///
/// 返回失败项（`名称：原因`）。**一条失败不影响其它**：某条配置过期了，
/// 不该让剩下的隧道都不启动。
async fn run_autostart(state: &AppState) -> Vec<String> {
    let specs: Vec<wt_core::TunnelSpec> = match state.tunnel_specs.lock() {
        Ok(guard) => guard.iter().filter(|s| s.auto_start).cloned().collect(),
        Err(_) => return vec!["[INTERNAL] 隧道配置状态异常".into()],
    };
    let mut errors = Vec::new();
    for spec in specs {
        // 锁只在判断里持有，绝不跨 await
        let running = match state.tunnels.lock() {
            Ok(guard) => guard.contains_key(&spec.id),
            Err(_) => {
                errors.push(format!("{}：[INTERNAL] 隧道表状态异常", spec.name));
                continue;
            }
        };
        if running {
            continue;
        }
        match start_spec(state, &spec).await {
            Ok(t) => trace(&format!("[autostart] 已拉起 {} → {}", t.name, t.listen)),
            Err(e) => errors.push(format!("{}：{e}", spec.name)),
        }
    }
    errors
}

/// 界面在打开隧道面板时调用一次（保险库解锁后也会自动跑一遍）。
#[tauri::command]
async fn tunnel_autostart(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(run_autostart(&state).await)
}

/// 删除一条隧道：**先停再删**。留着运行中的监听端口却把配置删了，
/// 用户会得到一条谁也停不掉、界面上也看不见的隧道。
#[tauri::command]
async fn tunnel_delete(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let taken = {
        state
            .tunnels
            .lock()
            .map_err(|_| "[INTERNAL] 隧道表状态异常".to_string())?
            .remove(&id)
    };
    if let Some((_, fwd)) = taken {
        fwd.stop().await;
    }
    if let Ok(mut store) = wt_store::Store::open(&sessions_db_path()) {
        if let Err(e) = store.delete_tunnel(&id) {
            trace(&format!("[tunnel_delete] 删除失败：{e}"));
            return Err(format!("停止成功，但删除配置失败：{e}"));
        }
    }
    if let Ok(mut specs) = state.tunnel_specs.lock() {
        specs.retain(|s| s.id != id);
    }
    Ok(true)
}

#[tauri::command]
async fn tunnel_stop(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    // 先摘出来再 await：`std::sync::MutexGuard` 不能跨 await 持有
    let taken = {
        state
            .tunnels
            .lock()
            .map_err(|_| "[INTERNAL] 隧道表状态异常".to_string())?
            .remove(&id)
    };
    match taken {
        Some((_, fwd)) => {
            fwd.stop().await;
            trace(&format!("[tunnel_stop] 已停止 {id}"));
            Ok(true)
        }
        None => Err(format!("[TUN_UNKNOWN] 没有 id 为 {id} 的隧道（可能已经停止）")),
    }
}

/// 新建目录（`FIL-001` 的右键菜单能力，接成显式按钮）。
#[tauri::command]
async fn sftp_mkdir(req: SshOpenReq, path: String, jump: Option<JumpReq>) -> Result<(), String> {
    let sftp = open_sftp(req, jump).await?;
    sftp.create_dir(&path).await.map_err(|e| e.to_string())
}

/// 改名 / 移动。
#[tauri::command]
async fn sftp_rename(
    req: SshOpenReq,
    from: String,
    to: String,
    jump: Option<JumpReq>,
) -> Result<(), String> {
    let sftp = open_sftp(req, jump).await?;
    sftp.rename(&from, &to).await.map_err(|e| e.to_string())
}

/// 删除：按 `is_dir` 分派到 `rmdir` / `unlink`。
///
/// 不做递归删除——一次误点删掉整棵树是最难恢复的事故，
/// 非空目录让服务端拒绝并说清原因。
#[tauri::command]
async fn sftp_remove(
    req: SshOpenReq,
    path: String,
    is_dir: bool,
    jump: Option<JumpReq>,
) -> Result<(), String> {
    let sftp = open_sftp(req, jump).await?;
    if is_dir {
        sftp.remove_dir(&path).await.map_err(|e| e.to_string())
    } else {
        sftp.remove_file(&path).await.map_err(|e| e.to_string())
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

// ── 诊断追踪 ────────────────────────────────────────────────
//
// 把命令内部每一步写进 `%TEMP%\wt-trace.log`，**默认关闭**，`WT_TRACE=1` 打开。
//
// 为什么需要它：前端只能看到「读取中…」然后一直等，看不到命令停在哪一步；
// Rust 侧如果挂在一个 await 上也不会报错。只靠「返回了/没返回」这一个
// 二进制信号，挨个假设去试也分不清「跑完了没送回」还是「压根没跑完」。
// 有了分级埋点，挂起位置变成证据。
//
// 默认关闭是因为它每次操作都写盘——用户没要过这个副作用。
// 排查时（或 e2e 失败后复盘）带上 `WT_TRACE=1` 再跑一遍即可。

fn trace_enabled() -> bool {
    std::env::var("WT_TRACE").map(|v| v == "1").unwrap_or(false)
}

fn trace_path() -> std::path::PathBuf {
    std::env::temp_dir().join("wt-trace.log")
}

fn trace_reset() {
    if trace_enabled() {
        let _ = std::fs::remove_file(trace_path());
    }
}

fn trace(msg: &str) {
    use std::io::Write;
    if !trace_enabled() {
        return;
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(trace_path())
    {
        let _ = writeln!(f, "{msg}");
    }
}

/// 记「进入」与「无论怎么退出都会写下的离开行」。
///
/// 只记进入不够：命令可能提前 `return Err`，也可能在中途挂死。
/// 两者都收不到返回值，但前者有离开行、后者没有——这才分得开。
struct TraceScope(&'static str);

impl TraceScope {
    fn enter(name: &'static str) -> Self {
        trace(&format!("[进入] {name}"));
        Self(name)
    }
}

impl Drop for TraceScope {
    fn drop(&mut self) {
        trace(&format!("[离开] {}", self.0));
    }
}

fn main() {
    trace_reset();
    tauri::Builder::default()
        .manage(AppState {
            registry: SessionRegistry::new(),
            vault: std::sync::Mutex::new(VaultState::locked()),
            tunnels: std::sync::Mutex::new(HashMap::new()),
            tunnel_specs: std::sync::Mutex::new(load_tunnel_specs()),
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
            mock_generate_key,
            mock_seed_file,
            e2e_mock_port,
            sftp_list,
            sftp_download,
            sftp_upload,
            sftp_mkdir,
            sftp_rename,
            sftp_remove,
            tunnel_start,
            tunnel_start_saved,
            tunnel_autostart,
            tunnel_delete,
            tunnel_stats,
            tunnel_stop,
            vault_status,
            vault_create,
            vault_unlock,
            vault_lock,
            credential_save,
            credential_get,
            credential_list,
            credential_delete,
            session_save,
            session_delete
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
        let _ = MOCK_FS.set(server.fs.clone());
        let _ = MOCK_PORT.set(server.port);
        println!("WT_MOCK_SSH_PORT={}", server.port);

        // 第二台：`SES-024` 的跳板机。它的 `direct-tcpip` 会连**真实 TCP** 到目标，
        // 所以「经跳板连上第一台」是一条真的两跳链路，不是模拟的。
        if std::env::var("WT_MOCK_SSH_JUMP").is_ok() {
            let jump = wt_ssh::testing::MockSshServer::start().await;
            println!("WT_MOCK_SSH_JUMP_PORT={}", jump.port);
        }
    });
}

#[cfg(not(feature = "e2e-mock"))]
fn start_mock_ssh_if_requested() {}
