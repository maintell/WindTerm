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
fn vault_unlock(state: State<'_, AppState>, password: String) -> Result<VaultStatusDto, String> {
    let bytes = std::fs::read(vault_path()).map_err(|e| format!("读取保险库失败：{e}"))?;
    let vault = wt_crypto::Vault::unlock(&bytes, &password).map_err(|e| e.to_string())?;

    let mut st = state.vault.lock().unwrap();
    st.vault = Some(vault);
    st.password = Some(zeroize::Zeroizing::new(password));
    Ok(status_of(&st))
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
async fn ssh_open(state: State<'_, AppState>, req: SshOpenReq) -> Result<SshOpenDto, String> {
    let SshOpenReq {
        host,
        port,
        user,
        password,
        key_pem,
        key_passphrase,
        cols,
        rows,
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

/// 端到端诊断用：把 SFTP 那条路径拆成几个阶段，定位卡在哪一步。
///
/// `stage`：1 = 只建 SSH 连接；2 = 建连 + 开 sftp 子系统（含 `SftpSession::new`）；
/// 3 = 再加一次 `list_dir("/")`。
///
/// # 它证明了什么
///
/// 「界面点击 → 建连接 → 开子系统 → 列目录」这条完整路径**是通的**。
/// 所以 G8 那段历史里「点击触发的 SFTP 挂起」不是 SFTP 的问题，而是
/// 当时给命令套的那层超时包装（`tokio::time::timeout` / `recv_timeout`）
/// 在 Tauri 命令里不推进。
///
/// 保留它作为回归护栏：如果哪天又有人在 SFTP 命令外面包超时包装，这个命令会先红。
#[tauri::command]
async fn e2e_sftp_stage(port: u16, stage: u8) -> Result<String, String> {
    let cfg = wt_ssh::SshConfig {
        host: "127.0.0.1".into(),
        port,
        user: "tester".into(),
        ..Default::default()
    };
    let conn =
        wt_ssh::SshConnection::connect_password(&cfg, "secret", wt_ssh::HostKeyPolicy::AcceptAll)
            .await
            .map_err(|e| format!("stage1 失败: {e}"))?;
    if stage <= 1 {
        return Ok("1:connected".into());
    }

    let sftp = wt_ssh::SftpClient::open(conn)
        .await
        .map_err(|e| format!("stage2 失败: {e}"))?;
    if stage <= 2 {
        return Ok("2:sftp-ready".into());
    }

    let entries = sftp
        .list_dir("/")
        .await
        .map_err(|e| format!("stage3 失败: {e}"))?;
    Ok(format!("3:listed {}", entries.len()))
}

// ── SFTP ────────────────────────────────────────────────────
//
// **不要给这些命令套超时包装。**
//
// 踩过：用 `tokio::time::timeout` 或 `std::sync::mpsc::recv_timeout` 包住 SFTP 操作，
// 命令就再也不返回（Rust 侧跑完了、前端收不到）。而同样的操作**不包**就正常——
// `e2e_sftp_stage` 用点击触发跑通建连/开子系统/列目录三步，就是这个结论的证据。
//
// 每次操作独立建连：文件面板的操作是低频的（列个目录、传个文件），
// 多一次握手百来毫秒，换掉「跨命令持有通道流」那一整类问题。

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
async fn open_sftp(req: SshOpenReq) -> Result<wt_ssh::SftpClient, String> {
    let cfg = wt_ssh::SshConfig {
        host: req.host.trim().to_string(),
        port: req.port.unwrap_or(22),
        user: req.user.trim().to_string(),
        ..Default::default()
    };
    if cfg.host.is_empty() {
        return Err("[SSH_BAD_ARGUMENT] 主机不能为空".into());
    }
    if cfg.user.is_empty() {
        return Err("[SSH_BAD_ARGUMENT] 用户名不能为空".into());
    }

    let auth = match req.key_pem {
        Some(pem) if !pem.trim().is_empty() => {
            AuthInput::Key(wt_ssh::PrivateKeySource::new(pem.into_bytes(), req.key_passphrase))
        }
        _ => AuthInput::Password(req.password.unwrap_or_default()),
    };

    let mut known = load_known_hosts();
    let conn = match try_connect(&cfg, &auth, known_policy(&known)).await {
        Ok(c) => c,
        Err(e) if e.code == wt_common::codes::SSH_HOSTKEY_UNKNOWN => {
            let observed = wt_ssh::SshConnection::probe_host_key(&cfg)
                .await
                .map_err(|e| e.to_string())?;
            known.add(&cfg.endpoint(), &observed.key_type, &observed.blob, false);
            save_known_hosts(&known)?;
            try_connect(&cfg, &auth, known_policy(&known))
                .await
                .map_err(|e| e.to_string())?
        }
        Err(e) => return Err(e.to_string()),
    };

    wt_ssh::SftpClient::open(conn)
        .await
        .map_err(|e| e.to_string())
}

/// 诊断用：与 `sftp_list` 完全相同的操作，但**不碰 known_hosts**（AcceptAll）、
/// 参数用基本类型。
///
/// 用来区分「SFTP 路径不行」和「`open_sftp` 里那段 known_hosts 处理不行」。
#[tauri::command]
async fn e2e_sftp_list_simple(port: u16, path: String) -> Result<usize, String> {
    let cfg = wt_ssh::SshConfig {
        host: "127.0.0.1".into(),
        port,
        user: "tester".into(),
        ..Default::default()
    };
    let conn =
        wt_ssh::SshConnection::connect_password(&cfg, "secret", wt_ssh::HostKeyPolicy::AcceptAll)
            .await
            .map_err(|e| e.to_string())?;
    let sftp = wt_ssh::SftpClient::open(conn)
        .await
        .map_err(|e| e.to_string())?;
    let entries = sftp.list_dir(&path).await.map_err(|e| e.to_string())?;
    Ok(entries.len())
}

#[tauri::command]
async fn sftp_list(req: SshOpenReq, path: String) -> Result<SftpListDto, String> {
    let sftp = open_sftp(req).await?;
    let entries = sftp.list_dir(&path).await.map_err(|e| e.to_string())?;    Ok(SftpListDto {
        path,
        entries: entries
            .into_iter()
            .map(|e| RemoteEntryDto {
                name: e.name,
                is_dir: e.is_dir,
                size: e.size,
            })
            .collect(),
    })
}

#[derive(serde::Serialize)]
struct DownloadDto {
    bytes: usize,
    /// 文件内容（base64）：页面没有任意写盘权限，只能由前端触发保存
    content: String,
}

#[tauri::command]
async fn sftp_download(req: SshOpenReq, path: String) -> Result<DownloadDto, String> {
    let sftp = open_sftp(req).await?;
    let data = sftp.read_file(&path).await.map_err(|e| e.to_string())?;
    Ok(DownloadDto {
        bytes: data.len(),
        content: B64.encode(&data),
    })
}

#[tauri::command]
async fn sftp_upload(req: SshOpenReq, path: String, content: String) -> Result<usize, String> {
    let data = B64
        .decode(content)
        .map_err(|e| format!("上传内容解码失败：{e}"))?;
    let sftp = open_sftp(req).await?;
    let len = data.len();
    sftp.write_file(&path, &data)
        .await
        .map_err(|e| e.to_string())?;
    Ok(len)
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
            vault: std::sync::Mutex::new(VaultState::locked()),
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
            e2e_sftp_stage,
            e2e_sftp_list_simple,
            sftp_list,
            sftp_download,
            sftp_upload,
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
    });
}

#[cfg(not(feature = "e2e-mock"))]
fn start_mock_ssh_if_requested() {}
