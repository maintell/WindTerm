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
    /// 进行中的分块上传（`FIL-019`）。
    ///
    /// 存在 state 里是为了**跨命令**持有 SFTP 写句柄：前端每次只发一块，
    /// 整文件不再进内存。`SftpWriter` 自己持有连接，所以条目本身就是守卫。
    uploads: std::sync::Mutex<HashMap<String, wt_ssh::SftpWriter>>,
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
    /// 配置是否已落库（带代理认证的隧道不落库）
    persisted: bool,
    /// 解锁保险库后是否自动拉起（`NET-005`）。**没落库的隧道这个值没意义**，
    /// 所以它跟着 `persisted` 一起为 `false`
    auto_start: bool,
}

/// 前端拉取单次上限：64 KB（`design/02` §5.2）。
const MAX_CHUNK: usize = 64 * 1024;

#[tauri::command]
fn local_open(state: State<'_, AppState>, cols: u16, rows: u16) -> Result<String, String> {
    // 用哪个 shell 由配置说了算（`LOC-001`）。这里**不做静默回退**：用户明明选了
    // Git Bash 却拿到 PowerShell，比直接报错的排查成本高得多。
    let prefs = prefs_load().unwrap_or_default();
    let (program, args) = wt_term::pty::shell_command(
        &prefs.local_shell,
        &prefs.local_shell_path,
        &prefs.local_shell_args,
    )
    .map_err(|e| e.to_string())?;
    let cfg = PtyConfig {
        program,
        args,
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
/// 本机可选的 shell（`LOC-001`），界面据此生成下拉框。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellChoiceDto {
    id: String,
    label: String,
    /// 找到的可执行文件；没找到是空串
    program: String,
    available: bool,
    /// 没找到时给用户的话（去哪儿装、怎么开）
    hint: String,
}

#[tauri::command]
fn local_shells() -> Vec<ShellChoiceDto> {
    wt_term::pty::detect_shells()
        .into_iter()
        .map(|c| {
            // 先算可用性：`program` 一移出去就借不到 `c` 了
            let available = c.available();
            ShellChoiceDto {
                id: c.id.to_string(),
                label: c.label.to_string(),
                program: c.program.unwrap_or_default(),
                available,
                hint: c.hint.unwrap_or_default().to_string(),
            }
        })
        .collect()
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

/// 按字节写入。
///
/// 给鼠标上报这类**二进制**输入用（`TER-022`）：X10 编码的序列是 `\e[M` 后跟
/// 三个原始字节，坐标字节可以 >0x7F。走 `String` 的话会被当 UTF-8 重新编码成
/// 两字节，远端收到的坐标就错了。
#[tauri::command]
fn term_write_bytes(
    state: State<'_, AppState>,
    handle: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let h = SessionHandle::from(handle.as_str());
    state.registry.write(&h, &data).map_err(|e| e.to_string())
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

/// 后端还活着的会话数（诊断用）。
///
/// 界面上的标签数与会话数应当同步：跑完一大串用例后两者对不上，说明有句柄没被关掉——
/// 这类泄漏在 Windows 上表现为「后面开终端越来越慢、最后起不来」，很难从界面上看出来。
#[tauri::command]
fn session_count(state: State<'_, AppState>) -> usize {
    state.registry.len()
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

/// 改主密码（`SEC-001`）：旧密码解封校验 → 新密码重封 → 写盘 → 保持解锁状态。
///
/// 不用内存里那份：万一眼前这份是「解锁后又被外部改过」的，用旧密码重新解一次
/// 才能确保改完之后**磁盘上的密文与内存里的条目是同一份**。
#[tauri::command]
fn vault_change_password(
    state: State<'_, AppState>,
    old_password: String,
    new_password: String,
) -> Result<VaultStatusDto, String> {
    // 新口令也要过强度检查：改密码时把口令改弱是最容易被忽略的降级
    wt_crypto::check_strength(&new_password).map_err(|e| e.to_string())?;
    let bytes = std::fs::read(vault_path()).map_err(|e| format!("读取保险库失败：{e}"))?;
    let mut vault =
        wt_crypto::Vault::unlock(&bytes, &old_password).map_err(|e| e.to_string())?;
    let sealed = vault.seal(&new_password).map_err(|e| e.to_string())?;
    std::fs::write(vault_path(), sealed).map_err(|e| format!("写入保险库失败：{e}"))?;

    let mut st = state.vault.lock().unwrap();
    st.vault = Some(vault);
    st.password = Some(zeroize::Zeroizing::new(new_password));
    Ok(status_of(&st))
}

/// 移除保险库（`SEC-001`）：删文件 + 清内存。**不可恢复**，调用方必须先做二次确认。
#[tauri::command]
fn vault_remove(state: State<'_, AppState>) -> Result<VaultStatusDto, String> {
    if vault_path().exists() {
        std::fs::remove_file(vault_path()).map_err(|e| format!("删除保险库失败：{e}"))?;
    }
    let mut st = state.vault.lock().unwrap();
    st.vault = None;
    st.password = None;
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

/// 新建/重命名文件夹（`SES-014`）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct FolderSaveReq {
    #[serde(default)]
    id: Option<String>,
    name: String,
    /// 只在新建时生效：父文件夹（空表示根）。移动走 `folder_move`，这里不掺和
    #[serde(default)]
    parent_id: Option<String>,
    /// 折叠状态（`SES-013`）：只存不要动结构，所以形状跟 parentId 一样克制
    #[serde(default)]
    collapsed: Option<bool>,
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
    /// 会话类型（`SES-009`）：界面只提供 `ssh` 与 `sftp`。旧记录没有这一项，
    /// 保持原样（更新时不覆盖）。
    #[serde(default)]
    kind: Option<String>,
}

/// 新建或重命名文件夹（`SES-014`）。
///
/// 重命名时不接受 `parentId`：改名不该顺手把文件夹搬到别处——那是两个动作，
/// 合并会让用户在「只改个名字」之后发现结构也变了。
#[tauri::command]
fn folder_save(req: FolderSaveReq) -> Result<String, String> {
    let name = req.name.trim();
    if name.is_empty() {
        return Err("[FOLDER_BAD_ARGUMENT] 文件夹名称不能为空".into());
    }
    let mut store = wt_store::Store::open(&sessions_db_path()).map_err(|e| e.to_string())?;
    let existing = match &req.id {
        Some(id) => store
            .load_snapshot()
            .map_err(|e| e.to_string())?
            .folders
            .into_iter()
            .find(|f| f.id.as_str() == id),
        None => None,
    };
    let mut folder = existing.unwrap_or_else(|| wt_core::Folder {
        id: wt_core::FolderId::new(),
        parent_id: None,
        name: String::new(),
        sort_order: 0,
        color: None,
        environment: None,
        collapsed: false,
        rev: 1,
    });
    folder.name = name.to_string();
    if let Some(collapsed) = req.collapsed {
        folder.collapsed = collapsed;
    }
    if req.id.is_none() {
        folder.parent_id = req
            .parent_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(wt_core::FolderId::from);
    }
    let id = folder.id.as_str().to_string();
    store.upsert_folder(&folder).map_err(|e| e.to_string())?;
    Ok(id)
}

/// 批量把会话移到某个文件夹（`SES-013` 多选）。
///
/// 一次开库改多条：逐个调用 `session_move` 会重复打开数据库，条数一多就明显变慢，
/// 而且中途失败会留下「移了一半」的状态——这里要么全成、要么报错并说明哪条失败。
#[tauri::command]
fn session_move_many(session_ids: Vec<String>, folder_id: Option<String>) -> Result<usize, String> {
    if session_ids.is_empty() {
        return Ok(0);
    }
    let mut store = wt_store::Store::open(&sessions_db_path()).map_err(|e| e.to_string())?;
    let snapshot = store.load_snapshot().map_err(|e| e.to_string())?;
    let target = folder_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let mut moved = 0;
    for id in &session_ids {
        let Some(mut session) = snapshot.sessions.iter().find(|s| s.id.as_str() == id).cloned()
        else {
            return Err(format!("[SESSION_NOT_FOUND] 会话 {id} 不存在（可能已被删除）"));
        };
        session.folder_id = target.as_deref().map(wt_core::FolderId::from);
        store.upsert_session(&session).map_err(|e| e.to_string())?;
        moved += 1;
    }
    Ok(moved)
}

/// 重排会话（`SES-013` 拖拽排序）：放到同层第 `index` 位。
///
/// 只重写**同一层**的 `sort_order`（0, 1000, 2000…），不碰别的行——全表重排会让
/// 两条无关记录的相对顺序莫名变化，用户会觉得「我什么都没动，它自己换了位置」。
#[tauri::command]
fn session_reorder(
    session_id: String,
    folder_id: Option<String>,
    index: usize,
) -> Result<(), String> {
    let mut store = wt_store::Store::open(&sessions_db_path()).map_err(|e| e.to_string())?;
    let snapshot = store.load_snapshot().map_err(|e| e.to_string())?;
    let target = folder_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let mut moved = snapshot
        .sessions
        .iter()
        .find(|s| s.id.as_str() == session_id)
        .cloned()
        .ok_or_else(|| "[SESSION_NOT_FOUND] 会话不存在（可能已被删除）".to_string())?;

    // 同层其它会话（按当前 sort_order 顺序），把目标摘出来再插进去
    let mut siblings: Vec<wt_core::Session> = snapshot
        .sessions
        .iter()
        .filter(|s| s.id.as_str() != session_id)
        .filter(|s| s.folder_id.as_ref().map(|f| f.as_str()) == target.as_deref())
        .cloned()
        .collect();
    let at = index.min(siblings.len());
    moved.folder_id = target.map(wt_core::FolderId::from);
    siblings.insert(at, moved);

    for (i, mut s) in siblings.into_iter().enumerate() {
        s.sort_order = (i as i64) * 1000;
        store.upsert_session(&s).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 移动文件夹（`SES-013` 拖拽）。
///
/// **必须做环检测**：把 A 挪进 A/B 会让 A 变成自己的子孙，整棵子树从树上消失——
/// 界面上看不出错，数据却已经坏了。
#[tauri::command]
fn folder_move(folder_id: String, parent_id: Option<String>) -> Result<(), String> {
    let mut store = wt_store::Store::open(&sessions_db_path()).map_err(|e| e.to_string())?;
    let snapshot = store.load_snapshot().map_err(|e| e.to_string())?;
    let parent = parent_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if parent.as_deref() == Some(folder_id.as_str()) {
        return Err("[FOLDER_BAD_ARGUMENT] 不能把文件夹移到自己里面".into());
    }
    if let Some(parent) = &parent {
        // 顺着 parent 往上走，遇到自己就说明目标是自己的子孙
        let by_id: std::collections::HashMap<&str, &wt_core::Folder> =
            snapshot.folders.iter().map(|f| (f.id.as_str(), f)).collect();
        let mut cursor = Some(parent.clone());
        let mut guard = 0;
        while let Some(id) = cursor {
            if id == folder_id {
                return Err(format!(
                    "[FOLDER_CYCLE] 不能把文件夹移到它自己的子文件夹「{parent}」里"
                ));
            }
            guard += 1;
            if guard > 64 {
                return Err("[FOLDER_CYCLE] 文件夹层级异常（超过 64 层）".into());
            }
            cursor = by_id
                .get(id.as_str())
                .and_then(|f| f.parent_id.as_ref())
                .map(|p| p.as_str().to_string());
        }
    }

    let mut folder = snapshot
        .folders
        .into_iter()
        .find(|f| f.id.as_str() == folder_id)
        .ok_or_else(|| "[FOLDER_NOT_FOUND] 文件夹不存在（可能已被删除）".to_string())?;
    folder.parent_id = parent.map(wt_core::FolderId::from);
    store.upsert_folder(&folder).map_err(|e| e.to_string())?;
    Ok(())
}

/// 用户偏好（`SET-006`）：外观与键位存在 `config.toml`，人可读、可进 Git。
///
/// 之前这两块各自存在 `localStorage` 里——那是**已知偏差**：浏览器存储既不可读、
/// 也不能随仓库走。这里补上真正的配置文件，并把 `localStorage` 撤掉（一份真值）。
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct PrefsDto {
    theme: String,
    font_family: String,
    font_size: u32,
    line_height: f64,
    scrollback: u32,
    /// 终端输出编码（`TER-006`）
    encoding: String,
    /// 键位（`TER-020`）：`action → chords[]`
    keymap: std::collections::BTreeMap<String, Vec<String>>,
    /// 导入的配色方案（`TER-005`）：跟内置的放一起，重启后还在
    #[serde(default)]
    custom_themes: Vec<CustomTheme>,
    /// 本地终端用哪个 shell（`LOC-001`）：`auto` / `pwsh` / `powershell` /
    /// `cmd` / `gitbash` / `wsl` / `custom`。存的是**稳定标识**而不是路径，
    /// 因为路径会随升级或迁移变化。
    local_shell: String,
    /// `local_shell = "custom"` 时的可执行文件
    local_shell_path: String,
    /// `local_shell = "custom"` 时的参数（空格分隔，`"` 包住带空格的段）
    local_shell_args: String,
    /// SSH 连上就打开文件面板（`FIL-001`）。规格要求默认开、但要能关——
    /// 有人只想开一个终端。
    files_auto_open: bool,
    /// 建连超时（秒，`SET-001` 的「网络」组）
    net_connect_timeout_secs: u32,
    /// keepalive 间隔（秒，0 = 关闭）
    net_keepalive_secs: u32,
    /// keepalive 连续丢失多少次算断线
    net_keepalive_max_missed: u32,
    /// 终端里右键干什么（`TER-011`）：`menu` 弹菜单（规格默认）/ `paste` 直接粘贴，
    /// 后者用 `Ctrl+右键` 或 `Shift+右键` 唤出菜单。
    right_click_action: String,
    /// 双击选词时**额外**当分隔符的字符（`TER-011`）。空串表示只用 xterm 默认那一套；
    /// 想把 `/` 也当分隔符的人填一个 `/` 即可（默认不填，`user@host:/var/log` 才能一次选中）。
    word_separator_extra: String,
    /// 粘贴时去掉每行末尾的空格/制表符（`TER-011` 规格第 1 条「去除尾部空白（可配）」）。
    /// 默认**关**：改用户粘贴进来的内容是危险动作，要开也得用户自己开。
    paste_trim_trailing: bool,
    /// 选中即复制（`TER-011`）：规格要求默认开、可关。有人剪贴板里放着别的东西，
    /// 选区一动就被覆盖很烦。关掉之后 `Ctrl+Shift+C` 仍然可用。
    auto_copy_on_select: bool,
    /// 选中即复制的防抖延迟（毫秒，`TER-011`）。
    ///
    /// 拖选会连续触发 `selectionchange`，不防抖就每挪一格写一次剪贴板；但 0
    /// （立即）是合法的——有人就是要在拖完立刻粘贴。0..=2000，默认 120。
    auto_copy_delay_ms: u32,
    /// 界面语言（`SET-012`）：`zh` / `en`。只覆盖标了 `data-i18n` 的元素，
    /// 其余文案仍是中文硬编码——如实写在 README 里。
    language: String,
}

/// 一套导入的配色：4 个界面色 + 16 个 ANSI 色，和内置的结构一致。
#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CustomTheme {
    name: String,
    bg: String,
    fg: String,
    cur: String,
    sel: String,
    ansi: Vec<String>,
}

impl Default for PrefsDto {
    fn default() -> Self {
        Self {
            theme: "WindTerm Dark".into(),
            font_family: "\"JetBrains Mono\", Consolas, \"Cascadia Mono\", monospace".into(),
            font_size: 13,
            line_height: 1.2,
            scrollback: 10_000,
            encoding: "utf-8".into(),
            keymap: std::collections::BTreeMap::new(),
            custom_themes: Vec::new(),
            local_shell: "auto".into(),
            local_shell_path: String::new(),
            local_shell_args: String::new(),
            files_auto_open: true,
            net_connect_timeout_secs: 15,
            net_keepalive_secs: 30,
            net_keepalive_max_missed: 3,
            right_click_action: "menu".into(),
            word_separator_extra: String::new(),
            paste_trim_trailing: false,
            auto_copy_on_select: true,
            auto_copy_delay_ms: 120,
            language: "zh".into(),
        }
    }
}

/// `config.toml` 的位置：与会话库同目录（`WT_DATA_DIR` 可覆盖）。
fn prefs_path() -> std::path::PathBuf {
    sessions_db_path()
        .parent()
        .map(|d| d.join("config.toml"))
        .unwrap_or_else(|| std::path::PathBuf::from("config.toml"))
}

/// 读偏好。文件不存在就是默认值，不算错误。
#[tauri::command]
fn prefs_load() -> Result<PrefsDto, String> {
    let path = prefs_path();
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return Ok(PrefsDto::default()),
    };
    toml::from_str(&text).map_err(|e| {
        format!(
            "[PREFS_INVALID] 配置文件无法解析（{}）：{e}",
            path.display()
        )
    })
}

/// 写偏好。先序列化成 TOML 再落盘，返回值是实际路径（界面据此告诉用户存在哪）。
#[tauri::command]
fn prefs_save(prefs: PrefsDto) -> Result<String, String> {
    let path = prefs_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败：{e}"))?;
    }
    let text = toml::to_string_pretty(&prefs).map_err(|e| format!("序列化配置失败：{e}"))?;
    std::fs::write(&path, text).map_err(|e| format!("写入 {} 失败：{e}", path.display()))?;
    Ok(path.display().to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct KeyDto {
    /// 私钥落盘路径（下载目录）
    path: String,
    key_type: String,
    fingerprint: String,
    /// 可贴进 authorized_keys 的公钥行
    public_key: String,
    encrypted: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct KeyInfoDto {
    key_type: String,
    fingerprint: String,
    encrypted: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EditDownloadDto {
    /// 本地副本路径（临时区，按文件名区分）
    local_path: String,
    remote_path: String,
    size: usize,
}

/// 把远端文件下载到本地临时区，供外部编辑器打开（`FIL-005`）。
///
/// 临时区放在下载目录下：用户找不到的临时文件等于没下载，
/// 而且真出事时还能自己捞回来。
#[tauri::command]
async fn sftp_edit_download(
    state: State<'_, AppState>,
    req: SshOpenReq,
    path: String,
    jump: Option<JumpReq>,
) -> Result<EditDownloadDto, String> {
    let sftp = open_sftp(&state, req, jump).await?;
    let data = sftp.read_file(&path).await.map_err(|e| e.to_string())?;
    drop(sftp);

    let dir = download_dir().join("wt-edit");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败：{e}"))?;
    let name = path.rsplit('/').next().unwrap_or("remote.txt");
    let local = unique_path(&dir, name);
    std::fs::write(&local, &data).map_err(|e| format!("写入 {} 失败：{e}", local.display()))?;

    Ok(EditDownloadDto {
        local_path: local.display().to_string(),
        remote_path: path,
        size: data.len(),
    })
}

/// 写回远端的结果。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EditSaveDto {
    bytes: usize,
    /// 是否走了原子替换；`false` 表示退化成「先删后改名」，中间有一瞬间目标不存在
    atomic: bool,
}

/// 把本地副本写回远端（`FIL-005`）。
///
/// 写之前比一次远端大小：期间被别人改过就不覆盖——「悄悄盖掉别人的修改」
/// 是这类编辑器最坏的行为。
///
/// 写本身走 `write_file_atomic`（`FIL-002` 的关键约束）：先写临时文件再 rename，
/// 观察者只会看到旧内容或新内容，不会看到空文件。服务端不肯覆盖时返回
/// `atomic: false`，界面据此如实提示。
#[tauri::command]
async fn sftp_edit_save(
    state: State<'_, AppState>,
    req: SshOpenReq,
    path: String,
    local_path: String,
    expected_size: usize,
    jump: Option<JumpReq>,
) -> Result<EditSaveDto, String> {
    let data = std::fs::read(&local_path).map_err(|e| format!("读取本地副本失败：{e}"))?;
    let sftp = open_sftp(&state, req, jump).await?;

    // 冲突检测：远端大小与下载时不一致，说明期间有人动过
    let (dir, name) = match path.rsplit_once('/') {
        Some((d, n)) => (if d.is_empty() { "/" } else { d }, n),
        None => ("/", path.as_str()),
    };
    if let Ok(entries) = sftp.list_dir(dir).await {
        if let Some(e) = entries.iter().find(|e| e.name == name) {
            if e.size as usize != expected_size {
                return Err(format!(
                    "[SFTP_CONFLICT] 远端文件已被改动（下载时 {expected_size} 字节，现在 {} 字节），拒绝覆盖；先重新下载确认差异",
                    e.size
                ));
            }
        } else {
            return Err("[SFTP_CONFLICT] 远端文件已不存在（可能被删除），不重建".into());
        }
    }

    let atomic = sftp
        .write_file_atomic(&path, &data)
        .await
        .map_err(|e| e.to_string())?;
    Ok(EditSaveDto {
        bytes: data.len(),
        atomic,
    })
}

/// 编辑器能打开的上限（`FIL-011` 的「大文件保护」）。
///
/// textarea 撑到几 MB 就会卡住整个渲染进程——与其让界面假死，
/// 不如明确拒绝并告诉用户该用外部编辑器。
const MAX_EDIT_BYTES: u64 = 2 * 1024 * 1024;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalTextDto {
    text: String,
    size: u64,
}

/// 读一个本地文本文件给内嵌编辑器（`FIL-011`）。
#[tauri::command]
fn local_read_text(path: String) -> Result<LocalTextDto, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("[FILE_NOT_FOUND] {e}"))?;
    if meta.len() > MAX_EDIT_BYTES {
        return Err(format!(
            "[FILE_TOO_LARGE] 文件 {} 字节，超过内嵌编辑器的 {} 字节上限；用外部编辑器打开",
            meta.len(),
            MAX_EDIT_BYTES
        ));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("读取失败：{e}"))?;
    // 非 UTF-8 不猜编码：编辑器只有一个文本视图，硬转会把内容弄坏
    let text = String::from_utf8(bytes).map_err(|_| {
        "[FILE_NOT_UTF8] 这个文件不是 UTF-8 文本，内嵌编辑器暂时只编辑 UTF-8；用外部编辑器打开".to_string()
    })?;
    Ok(LocalTextDto {
        text,
        size: meta.len(),
    })
}

/// 把编辑器的内容写回本地文件（`FIL-011`）。
#[tauri::command]
fn local_write_text(path: String, text: String) -> Result<u64, String> {
    let bytes = text.into_bytes();
    std::fs::write(&path, &bytes).map_err(|e| format!("写入 {path} 失败：{e}"))?;
    Ok(bytes.len() as u64)
}

/// 用系统默认程序打开一个本地文件（`FIL-005` 的「打开编辑器」）。
#[tauri::command]
fn open_in_system(path: String) -> Result<(), String> {
    if !std::path::Path::new(&path).exists() {
        return Err(format!("[FILE_NOT_FOUND] 文件不存在：{path}"));
    }
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", "", &path]);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(&path);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&path);
        c
    };
    cmd.spawn().map_err(|e| format!("无法启动系统程序：{e}"))?;
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct KnownHostRow {
    /// known_hosts 里的主机模式（可能是 `[host]:port`，也可能是哈希形式）
    pattern: String,
    key_type: String,
    fingerprint: String,
    comment: String,
}

/// 列出已记录的主机密钥（`SEC-005`：密钥变了要能重置信任）。
///
/// 没有这个入口，用户遇到 `SSH_HOSTKEY_CHANGED` 只能手动去改 `known_hosts`——
/// 而那个文件里存的是 base64 blob，手改几乎必然改坏。
#[tauri::command]
fn known_hosts_list() -> Result<Vec<KnownHostRow>, String> {
    let known = load_known_hosts();
    let mut rows = Vec::new();
    for e in known.entries() {
        let fp = wt_ssh::fingerprint_sha256(&e.key_blob);
        for p in &e.patterns {
            rows.push(KnownHostRow {
                pattern: p.clone(),
                key_type: e.key_type.clone(),
                fingerprint: fp.clone(),
                comment: e.comment.clone().unwrap_or_default(),
            });
        }
    }
    Ok(rows)
}

/// 忘掉某台主机的密钥（`SEC-005`）。下次连接会重新走 TOFU。
#[tauri::command]
fn known_hosts_forget(pattern: String) -> Result<usize, String> {
    let mut known = load_known_hosts();
    // 直接按主机模式删：`HostKeyId` 只能表达 `host:port`，表达不了哈希形式与通配符，
    // 而界面上列出来的正是模式本身
    let removed = known.remove_pattern(&pattern);
    if removed == 0 {
        return Err(format!("[KNOWN_HOSTS_NOT_FOUND] 没有记录 {pattern}"));
    }
    save_known_hosts(&known)?;
    Ok(removed)
}

/// 生成密钥并落盘（`LOC-014`）。
///
/// 私钥写到下载目录：界面上还没有文件保存对话框，而「生成了但不知道存哪」
/// 比多一次另存为更糟。口令可选，给了就加密。
#[tauri::command]
fn key_generate(
    alg: String,
    passphrase: Option<String>,
    comment: Option<String>,
) -> Result<KeyDto, String> {
    let pass = passphrase.as_deref().filter(|p| !p.is_empty());
    let comment = comment.unwrap_or_default();
    let key = wt_ssh::generate_key(&alg, pass, comment.trim()).map_err(|e| e.to_string())?;

    let dir = download_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败：{e}"))?;
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = unique_path(&dir, &format!("id_{alg}_{secs}.key"));
    std::fs::write(&path, &key.pem).map_err(|e| format!("写入 {} 失败：{e}", path.display()))?;

    Ok(KeyDto {
        path: path.display().to_string(),
        key_type: key.key_type,
        fingerprint: key.fingerprint,
        public_key: key.public_openssh,
        encrypted: key.encrypted,
    })
}

/// 读一把已有私钥并显示它的公开信息（`LOC-014` 的「导入并显示指纹」）。
#[tauri::command]
fn key_inspect(path: String, passphrase: Option<String>) -> Result<KeyInfoDto, String> {
    let src = wt_ssh::PrivateKeySource::from_file(
        std::path::Path::new(&path),
        passphrase.filter(|p| !p.is_empty()),
    )
    .map_err(|e| e.to_string())?;
    let info = wt_ssh::inspect_key(&src).map_err(|e| e.to_string())?;
    Ok(KeyInfoDto {
        key_type: info.key_type,
        fingerprint: info.fingerprint,
        encrypted: info.encrypted,
    })
}

/// 把一条会话导出成 JSON（`SES-014`）。
///
/// 落点是下载目录而不是「另存为」对话框：界面还没有可用的文件选择器，
/// 先固定落点并**把路径说出来**，比弹一个半成品对话框可靠得多。
/// 名字冲突时自动加序号（复用下载那套 `unique_path`），不覆盖已有文件。
#[tauri::command]
fn session_export(session_id: String) -> Result<String, String> {
    let snapshot = wt_store::Store::open(&sessions_db_path())
        .map_err(|e| e.to_string())?
        .load_snapshot()
        .map_err(|e| e.to_string())?;
    let session = snapshot
        .sessions
        .into_iter()
        .find(|s| s.id.as_str() == session_id)
        .ok_or_else(|| "[SESSION_NOT_FOUND] 会话不存在（可能已被删除）".to_string())?;

    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let safe: String = session
        .name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let file = format!("{safe}-{secs}.json");

    let payload = serde_json::json!({
        "format": "windterm-session",
        "version": 1,
        "exportedAt": secs,
        "session": session,
    });
    let text = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    let path = unique_path(&download_dir(), &file);
    std::fs::write(&path, text).map_err(|e| format!("写入 {} 失败：{e}", path.display()))?;
    Ok(path.display().to_string())
}

/// 应用把哪些文件放在哪（`SET-001` 的「高级」组）。
///
/// 用户要备份或排查配置时，最常问的就是「配置文件在哪」——把它显示出来比写进文档有用。
#[derive(serde::Serialize)]
struct AppPathsDto {
    /// `config.toml` 的绝对路径
    prefs: String,
    /// 数据目录（会话库、保险库、known_hosts 都在这里）
    data: String,
}

#[tauri::command]
fn app_paths() -> AppPathsDto {
    AppPathsDto {
        prefs: prefs_path().display().to_string(),
        data: sessions_db_path()
            .parent()
            .map(|d| d.display().to_string())
            .unwrap_or_default(),
    }
}

/// 把偏好重置为默认：现有的 `config.toml` 先**改名备份**，界面重新读默认值。
///
/// 不直接删：用户点错一次就丢掉全部配色、键位与导入的方案，代价太大。
/// 备份路径会回给界面，由它告诉用户旧配置在哪。
#[tauri::command]
fn prefs_reset() -> Result<Option<String>, String> {
    let path = prefs_path();
    if !path.exists() {
        return Ok(None);
    }
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let backup = path.with_extension(format!("toml.bak-{secs}"));
    std::fs::rename(&path, &backup)
        .map_err(|e| format!("备份 {} 失败：{e}", path.display()))?;
    Ok(Some(backup.display().to_string()))
}

/// 改一条已保存隧道的「名字 / 分组 / 自动拉起」（`NET-004` 的「编辑」）。
///
/// **只改这三项**：类型与端口换了其实已经是另一条隧道，让它们在原记录上改会把「上次跑
/// 的是什么」抹掉。要改端口就重新填表建一条。
#[tauri::command]
fn tunnel_update(
    state: State<'_, AppState>,
    id: String,
    name: Option<String>,
    group: Option<String>,
    auto_start: Option<bool>,
) -> Result<String, String> {
    let spec = {
        let mut specs = state
            .tunnel_specs
            .lock()
            .map_err(|_| "[INTERNAL] 隧道配置状态异常".to_string())?;
        let Some(slot) = specs.iter_mut().find(|s| s.id == id) else {
            return Err(
                "[TUN_BAD_ARGUMENT] 这条隧道不在配置库里（可能是运行时临时建的）".into(),
            );
        };
        if let Some(n) = name.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
            slot.name = n;
        }
        // 传空串表示「取消分组」，与建隧道时的约定一致
        if let Some(g) = group {
            let g = g.trim().to_string();
            slot.group = if g.is_empty() { None } else { Some(g) };
        }
        if let Some(a) = auto_start {
            slot.auto_start = a;
        }
        slot.validate().map_err(|e| e.to_string())?;
        slot.clone()
    };
    let mut store = wt_store::Store::open(&sessions_db_path()).map_err(|e| e.to_string())?;
    store.upsert_tunnel(&spec).map_err(|e| e.to_string())?;
    set_tunnel_spec_cache(&state, spec.clone(), true);
    // 运行中的实例把名字也换掉，否则列表里同一条会显示两个名字
    if let Ok(mut running) = state.tunnels.lock() {
        if let Some((meta, _)) = running.get_mut(&spec.id) {
            meta.name = spec.name.clone();
        }
    }
    Ok(spec.name)
}

/// 把键位方案导出成 JSON 文件（`TER-020`）。
///
/// 落点与其它导出一致（下载目录 + 时间戳 + 冲突加序号）。内容由界面给：只有它知道
/// 当前有哪些动作，后端不该复制一份动作表——两份清单迟早对不上。
#[tauri::command]
fn keymap_export(json: String) -> Result<String, String> {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = unique_path(&download_dir(), &format!("windterm-keymap-{secs}.json"));
    std::fs::write(&path, json).map_err(|e| format!("写入 {} 失败：{e}", path.display()))?;
    Ok(path.display().to_string())
}

/// 把广播结果导出成 CSV（`TER-004`）。
///
/// 落点与会话/隧道导出一致（下载目录 + 时间戳 + 冲突加序号），路径回给界面。
/// 单元格按 RFC 4180 转义：远端输出里逗号、引号、换行都很常见，不转义会直接把表格
/// 撑歪；文件开头加 UTF-8 BOM，否则 Excel 打开中文是乱码。
#[tauri::command]
fn broadcast_export_csv(rows: Vec<Vec<String>>) -> Result<String, String> {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut text = String::new();
    for row in &rows {
        let cells: Vec<String> = row.iter().map(|c| csv_cell(c)).collect();
        text.push_str(&cells.join(","));
        text.push_str("\r\n");
    }
    let path = unique_path(&download_dir(), &format!("windterm-broadcast-{secs}.csv"));
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice(text.as_bytes());
    std::fs::write(&path, bytes).map_err(|e| format!("写入 {} 失败：{e}", path.display()))?;
    Ok(path.display().to_string())
}

/// CSV 单元格转义（RFC 4180）：含逗号、引号或换行时整体加引号，引号翻倍。
fn csv_cell(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// 把全部隧道配置导出成 JSON（`NET-004`）。
///
/// 落点与会话导出一致（下载目录 + 时间戳 + 冲突加序号），并把路径回给界面。
/// **不含任何口令**：带 SOCKS5 认证的隧道本来就不落库，库里根本没有口令可导。
#[tauri::command]
fn tunnels_export() -> Result<String, String> {
    let snapshot = wt_store::Store::open(&sessions_db_path())
        .map_err(|e| e.to_string())?
        .load_snapshot()
        .map_err(|e| e.to_string())?;
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let payload = serde_json::json!({
        "format": "windterm-tunnels",
        "version": 1,
        "exportedAt": secs,
        "tunnels": snapshot.tunnels,
    });
    let text = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    let path = unique_path(&download_dir(), &format!("windterm-tunnels-{secs}.json"));
    std::fs::write(&path, text).map_err(|e| format!("写入 {} 失败：{e}", path.display()))?;
    Ok(path.display().to_string())
}

/// 从 JSON 导入隧道配置（`NET-004`），返回导入条数。
///
/// **先整批校验再写库**：导到一半失败会留下一半配置，用户看着像「导成功了但少几条」，
/// 比直接报错难查得多。
#[tauri::command]
fn tunnels_import(state: State<'_, AppState>, json: String) -> Result<usize, String> {
    let value: serde_json::Value = serde_json::from_str(&json)
        .map_err(|e| format!("[TUN_BAD_FILE] 不是合法的 JSON：{e}"))?;
    if value.get("format").and_then(|v| v.as_str()) != Some("windterm-tunnels") {
        return Err("[TUN_BAD_FILE] 这不是 WindTerm 导出的隧道文件".into());
    }
    let list: Vec<wt_core::TunnelSpec> = serde_json::from_value(
        value
            .get("tunnels")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
    )
    .map_err(|e| format!("[TUN_BAD_FILE] 隧道列表解析失败：{e}"))?;
    for t in &list {
        t.validate()
            .map_err(|e| format!("[TUN_BAD_FILE] {}", e.message))?;
    }
    let mut store = wt_store::Store::open(&sessions_db_path()).map_err(|e| e.to_string())?;
    for t in &list {
        store.upsert_tunnel(t).map_err(|e| e.to_string())?;
        // 内存缓存也要更新：`tunnel_stats` 读的是它，只写库的话导入完列表还是空的
        // （表现为「导入成功但一条都没出现」）。
        set_tunnel_spec_cache(&state, t.clone(), true);
    }
    Ok(list.len())
}

/// 把会话移到某个文件夹（`folderId` 为空表示移到根）。`SES-014` 的「移动到」。
#[tauri::command]
fn session_move(session_id: String, folder_id: Option<String>) -> Result<(), String> {
    let mut store = wt_store::Store::open(&sessions_db_path()).map_err(|e| e.to_string())?;
    let mut session = store
        .load_snapshot()
        .map_err(|e| e.to_string())?
        .sessions
        .into_iter()
        .find(|s| s.id.as_str() == session_id)
        .ok_or_else(|| "[SESSION_NOT_FOUND] 会话不存在（可能已被删除）".to_string())?;
    session.folder_id = folder_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(wt_core::FolderId::from);
    store.upsert_session(&session).map_err(|e| e.to_string())?;
    Ok(())
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
    // 类型：只接受界面真的提供的两种。其它值直接拒，别悄悄存成 ssh——
    // 用户以为建了 RDP 会话、结果点开是个终端，这类静默替换最难查。
    if let Some(kind) = req.kind.as_deref() {
        match kind.trim() {
            "" => {}
            "ssh" => session.kind = wt_core::SessionKind::Ssh,
            "sftp" => session.kind = wt_core::SessionKind::Sftp,
            other => {
                return Err(format!(
                    "[SESSION_BAD_ARGUMENT] 界面只支持 ssh 与 sftp 两种会话类型，收到「{other}」"
                ));
            }
        }
    }
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
/// 清掉保险库里属于某个会话的密码。失败会把错误抛回去，由调用方决定是否继续。
///
/// 抽出来是因为单条删除与批量删除都要做同一件事：两处各写一遍，
/// 迟早出现「批量删了会话、保险库里的密码还留着」。
fn purge_vault_for(state: &AppState, id: &str) -> Result<(), String> {
    {
        let mut st = state.vault.lock().unwrap();
        if let Some(master) = st.password.clone() {
            if let Some(vault) = st.vault.as_mut() {
                let stale: Vec<String> = vault
                    .entries()
                    .iter()
                    .filter(|e| {
                        matches!(e, wt_crypto::Entry::Password { session_id: Some(s), .. } if s == id)
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
    Ok(())
}

#[tauri::command]
fn session_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    // 顺序是「先清保险库、再删会话」：前者失败就整体报错、什么都不动，
    // 免得出现「会话没了、密码还在库里」这种更难收拾的中间态。
    purge_vault_for(&state, &id)?;
    let mut store = wt_store::Store::open(&sessions_db_path()).map_err(|e| e.to_string())?;
    store
        .delete_session(&wt_core::SessionId::from(id.as_str()))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 批量删除（`SES-013` 多选）。
///
/// 逐条做「清保险库 → 删会话」；中途失败会报出**哪一条**失败、以及已经删掉几条——
/// 破坏性批量操作最忌讳「报了个笼统的错，用户不知道删到哪了」。
#[tauri::command]
fn session_delete_many(state: State<'_, AppState>, ids: Vec<String>) -> Result<usize, String> {
    if ids.is_empty() {
        return Ok(0);
    }
    let mut store = wt_store::Store::open(&sessions_db_path()).map_err(|e| e.to_string())?;
    let mut done = 0;
    for id in &ids {
        if let Err(e) = purge_vault_for(&state, id) {
            return Err(format!("删除中断：已删 {done} 条，清保险库时失败（{id}）：{e}"));
        }
        if let Err(e) = store.delete_session(&wt_core::SessionId::from(id.as_str())) {
            return Err(format!("删除中断：已删 {done} 条，{id} 删除失败：{e}"));
        }
        done += 1;
    }
    Ok(done)
}

// ── SSH ─────────────────────────────────────────────────────

/// 从命令行参数里取数据目录覆盖（`SET-006`）。
///
/// 单独抽出来是为了能测：`--config-dir` 少了值必须报错，而不是悄悄退回默认目录——
/// 用户以为数据写到了 U 盘，实际落在 `%APPDATA%`，这种「静默失效」最难查。
fn parse_data_dir_arg<I: Iterator<Item = String>>(
    args: I,
    exe_dir: Option<std::path::PathBuf>,
) -> Result<Option<std::path::PathBuf>, String> {
    let mut it = args.peekable();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--config-dir" => {
                let Some(v) = it.next() else {
                    return Err("--config-dir 需要一个目录".into());
                };
                if v.trim().is_empty() {
                    return Err("--config-dir 的目录不能为空".into());
                }
                return Ok(Some(std::path::PathBuf::from(v)));
            }
            // 便携模式：数据跟着可执行文件走（U 盘、免安装）
            "--portable" => {
                return exe_dir.map(Some).ok_or_else(|| {
                    "--portable 取不到程序所在目录，请改用 --config-dir".to_string()
                });
            }
            _ => {}
        }
    }
    Ok(None)
}

/// 命令行覆盖只解析一次：数据目录在一次运行里必须稳定。
static DATA_DIR_OVERRIDE: std::sync::OnceLock<Option<std::path::PathBuf>> = std::sync::OnceLock::new();

fn data_dir_override() -> &'static Option<std::path::PathBuf> {
    DATA_DIR_OVERRIDE.get_or_init(|| {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()));
        match parse_data_dir_arg(std::env::args().skip(1), exe_dir) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("参数错误：{e}");
                None
            }
        }
    })
}

/// 应用数据目录。
///
/// 优先级：`--config-dir` / `--portable` > `WT_DATA_DIR` > `%APPDATA%\WindTerm`。
/// `WT_DATA_DIR` 供端到端验收覆盖——验收必须用干净目录，
/// 否则上一轮记下的主机密钥会让 TOFU 分支测不到。
fn data_dir() -> std::path::PathBuf {
    if let Some(dir) = data_dir_override() {
        return dir.clone();
    }
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
    jumps: &[JumpReq],
) -> Result<(wt_ssh::SshConnection, bool), String> {
    let Some(first) = jumps.first() else {
        return connect_direct_accept_new(cfg, auth).await;
    };

    // 第 1 跳由本机直连（它自己的主机密钥也走 accept-new）
    let first_cfg = hop_cfg(first)?;
    let first_auth = AuthInput::Password(first.password.clone());
    let (mut conn, mut added) = connect_direct_accept_new(&first_cfg, &first_auth).await?;
    trace(&format!("[connect] 第 1 跳 {}:{} 就绪", first_cfg.host, first_cfg.port));

    // 之后的每一跳都从上一跳开一条 `direct-tcpip`，在通道上做完整握手与认证
    let mut link = format!("{}:{}", first_cfg.host, first_cfg.port);
    for (i, hop) in jumps.iter().enumerate().skip(1) {
        let hop_cfg = hop_cfg(hop)?;
        let hop_auth = AuthInput::Password(hop.password.clone());
        let (c, a) = connect_over_accept_new(&conn, i, &link, &hop_cfg, &hop_auth).await?;
        conn = c;
        added |= a;
        link = format!("{}:{}", hop_cfg.host, hop_cfg.port);
    }

    // 最后一跳连目标：它**没法 probe**（`probe_host_key` 是直连的，目标只有跳板机能到），
    // 所以密钥未知时就地接受并记录——这就是 `trust_observed_key` 存在的理由。
    let (conn, a) = connect_over_accept_new(&conn, jumps.len(), &link, cfg, auth).await?;
    Ok((conn, added || a))
}

/// 从上一跳开一条 `direct-tcpip` 到 `cfg`，在通道上握手；主机密钥未知时接受并记录。
///
/// 与 `wt_ssh::connect_chain` 的区别只有主机密钥策略：界面侧是 accept-new（未知就记下），
/// 命令行侧是严格校验。两边共用 `SshConnection::connect_over`，数据面是同一份实现。
async fn connect_over_accept_new(
    from: &wt_ssh::SshConnection,
    from_hop: usize,
    from_link: &str,
    cfg: &wt_ssh::SshConfig,
    auth: &AuthInput,
) -> Result<(wt_ssh::SshConnection, bool), String> {
    let link = format!("{}:{}", cfg.host, cfg.port);
    let mut known = load_known_hosts();
    let auth = ssh_auth(auth);
    let first = match wt_ssh::connect_over_hop(
        from,
        from_hop,
        from_link,
        cfg,
        &auth,
        known_policy(&known),
    )
    .await
    {
        Ok(c) => return Ok((c, false)),
        Err(e) if e.code == wt_common::codes::SSH_HOSTKEY_UNKNOWN => e,
        Err(e) => return Err(e.to_string()),
    };
    // 通道被上一次握手用掉了，重开一条；这次接受未知密钥并记录
    let conn = wt_ssh::connect_over_hop(
        from,
        from_hop,
        from_link,
        cfg,
        &auth,
        wt_ssh::HostKeyPolicy::AcceptAll,
    )
    .await
    .map_err(|e| e.to_string())?;
    conn.trust_observed_key(&mut known, false)
        .map_err(|e| e.to_string())?;
    save_known_hosts(&known)?;
    let _ = first;
    trace(&format!("[connect] 第 {} 跳 {link} 主机密钥未知 → 已记录", from_hop + 1));
    Ok((conn, true))
}

/// 把偏好里的网络参数套到连接配置上（`SET-001` 的「网络」组）。
///
/// **所有建连的地方都走这里**：超时与 keepalive 是全局行为，散在五处手抄迟早不一致，
/// 而且改一处忘一处很难被发现——只有某个入口超时特别短时才会有人怀疑。
fn apply_net_prefs(cfg: &mut wt_ssh::SshConfig) {
    let prefs = prefs_load().unwrap_or_default();
    cfg.connect_timeout_secs = prefs.net_connect_timeout_secs.clamp(1, 300);
    cfg.keepalive_secs = prefs.net_keepalive_secs.min(3600);
    cfg.keepalive_max_missed = prefs.net_keepalive_max_missed.clamp(1, 20);
}

/// 一跳的连接参数。主机与用户名不能为空——空着连上去只会得到一条看不懂的错误。
fn hop_cfg(hop: &JumpReq) -> Result<wt_ssh::SshConfig, String> {
    let mut cfg = wt_ssh::SshConfig {
        host: hop.host.trim().to_string(),
        port: hop.port,
        user: hop.user.trim().to_string(),
        ..Default::default()
    };
    apply_net_prefs(&mut cfg);
    if cfg.host.is_empty() || cfg.user.is_empty() {
        return Err("[SSH_BAD_ARGUMENT] 跳板机的主机与用户名都不能为空".into());
    }
    Ok(cfg)
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

/// 解析跳板机链（`SES-025`）。
///
/// 界面只告诉后端「用哪一条会话当跳板机」，它自己可能还有跳板——链由会话属性决定，
/// 界面不必为每一跳各加一组控件。手填的跳板机就是一条单跳链。
fn resolve_jumps(state: &AppState, jump: Option<&JumpReq>) -> Result<Vec<JumpReq>, String> {
    let Some(jump) = jump else {
        return Ok(Vec::new());
    };
    let Some(session_id) = jump.session_id.as_deref().map(str::trim).filter(|s| !s.is_empty())
    else {
        // 手填：就一跳，凭据来自表单
        return Ok(vec![jump.clone()]);
    };

    let snapshot = wt_store::Store::open(&sessions_db_path())
        .map_err(|e| e.to_string())?
        .load_snapshot()
        .map_err(|e| e.to_string())?;
    let by_id: std::collections::HashMap<&str, &wt_core::Session> =
        snapshot.sessions.iter().map(|s| (s.id.as_str(), s)).collect();

    let start = wt_core::SessionId::from(session_id);
    // 环与深度在这里再拦一次：链是会话属性，可能在别处被改成环
    let rest = wt_core::validate_jump_chain(&start, |id| {
        by_id
            .get(id.as_str())
            .and_then(|s| s.jump())
            .into_iter()
            .collect()
    })
    .map_err(|e| e.to_string())?;

    let mut hops = Vec::with_capacity(rest.len() + 1);
    for (idx, id) in std::iter::once(start).chain(rest).enumerate() {
        let s = by_id.get(id.as_str()).ok_or_else(|| {
            format!(
                "[SSH_BAD_ARGUMENT] 第 {} 跳的会话不存在（可能已被删除）：{id}",
                idx + 1
            )
        })?;
        let host = s.host.clone().unwrap_or_default();
        let user = s.username.clone().unwrap_or_default();
        if host.is_empty() || user.is_empty() {
            return Err(format!(
                "[SSH_BAD_ARGUMENT] 第 {} 跳会话「{}」缺少主机或用户名",
                idx + 1,
                s.name
            ));
        }
        // 第一跳可以沿用表单里的口令（用户可能刚手填过），其后各跳只认保险库
        let password = if idx == 0 && !jump.password.is_empty() {
            jump.password.clone()
        } else {
            vault_password(state, id.as_str()).ok_or_else(|| {
                format!(
                    "[SSH_AUTH_FAILED] 第 {} 跳「{}」在保险库里没有密码：先给它存一条，或改用手填跳板机",
                    idx + 1,
                    s.name
                )
            })?
        };
        hops.push(JumpReq {
            host,
            port: s.port.unwrap_or(22),
            user,
            password,
            session_id: None,
        });
    }
    Ok(hops)
}

/// 取某个会话在保险库里的密码（保险库锁着就当没有）。
fn vault_password(state: &AppState, session_id: &str) -> Option<String> {
    let st = state.vault.lock().ok()?;
    let vault = st.vault.as_ref()?;
    vault.entries().iter().find_map(|e| match e {
        wt_crypto::Entry::Password {
            secret,
            session_id: Some(s),
            ..
        } if s == session_id => B64
            .decode(secret)
            .ok()
            .map(|b| String::from_utf8_lossy(&b).to_string()),
        _ => None,
    })
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
#[derive(serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct JumpReq {
    host: String,
    port: u16,
    user: String,
    #[serde(default)]
    password: String,
    /// 选中的跳板机**会话**（`SES-025`）：它自己可能还有跳板，
    /// 由后端顺着会话链解析成多跳，界面不用为每一跳加控件。
    #[serde(default)]
    session_id: Option<String>,
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
    let mut cfg = wt_ssh::SshConfig {
        host: host.trim().to_string(),
        port: port.unwrap_or(22),
        user: user.trim().to_string(),
        ..Default::default()
    };
    apply_net_prefs(&mut cfg);
    if cfg.host.is_empty() {
        return Err("[SSH_BAD_ARGUMENT] 主机不能为空".into());
    }
    if cfg.user.is_empty() {
        return Err("[SSH_BAD_ARGUMENT] 用户名不能为空".into());
    }

    let jumps = resolve_jumps(&state, jump.as_ref())?;
    let (conn, host_key_added) = connect_accept_new(&cfg, &auth, &jumps).await?;

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
static MOCK_LINKS: std::sync::OnceLock<wt_ssh::testing::MockLinks> = std::sync::OnceLock::new();
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

/// 端到端验收专用：一次种 `count` 个文件，用来压虚拟滚动（`FIL-001` AC-1）。
#[tauri::command]
async fn mock_seed_many(dir: String, count: usize) -> Result<usize, String> {
    #[cfg(feature = "e2e-mock")]
    {
        let fs = MOCK_FS
            .get()
            .ok_or_else(|| "[E2E_ONLY] mock 服务端未启动".to_string())?;
        let mut guard = fs.lock().await;
        // 目录本身也要有一条：mock 用「路径以 / 结尾」表示目录
        guard.insert(format!("{dir}/"), Vec::new());
        for i in 1..=count {
            guard.insert(format!("{dir}/f{i:04}.txt"), vec![b'x'; 4]);
        }
        Ok(count)
    }
    #[cfg(not(feature = "e2e-mock"))]
    {
        let _ = (dir, count);
        Err("[E2E_ONLY] 该命令只在 e2e-mock 构建里可用".into())
    }
}

/// 端到端验收专用：往 mock 的 SFTP 文件系统里种一个符号链接（`FIL-002`）。
#[tauri::command]
async fn mock_seed_link(path: String, target: String) -> Result<(), String> {
    #[cfg(feature = "e2e-mock")]
    {
        let links = MOCK_LINKS
            .get()
            .ok_or_else(|| "[E2E_ONLY] mock 服务端未启动".to_string())?;
        links.lock().await.insert(path, target);
        Ok(())
    }
    #[cfg(not(feature = "e2e-mock"))]
    {
        let _ = (path, target);
        Err("[E2E_ONLY] 该命令只在 e2e-mock 构建里可用".into())
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
    /// 符号链接（`FIL-002` / `FIL-001` AC-2）
    is_symlink: bool,
    /// 链向哪里；非链接为 `None`
    link_target: Option<String>,
    /// 断链：链接在、目标没了，界面要标出来
    broken: bool,
    /// 权限位（原始 `st_mode`，含类型位）；服务端不给就是 `None`
    mode: Option<u32>,
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
    state: &AppState,
    req: SshOpenReq,
    jump: Option<JumpReq>,
) -> Result<wt_ssh::SftpClient, String> {
    let _scope = TraceScope::enter("open_sftp");
    let mut cfg = wt_ssh::SshConfig {
        host: req.host.trim().to_string(),
        port: req.port.unwrap_or(22),
        user: req.user.trim().to_string(),
        ..Default::default()
    };
    apply_net_prefs(&mut cfg);
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
    let jumps = resolve_jumps(state, jump.as_ref())?;
    let (conn, _added) = connect_accept_new(&cfg, &auth, &jumps).await?;
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
async fn sftp_list(
    state: State<'_, AppState>,
    arg: SftpListArg,
) -> Result<SftpListDto, String> {
    let _scope = TraceScope::enter("sftp_list");
    let SftpListArg { req, path, jump } = arg;
    trace(&format!(
        "[sftp_list] 参数 host={} user={} path={} jump={}",
        req.host,
        req.user,
        path,
        jump.is_some()
    ));
    let sftp = open_sftp(&state, req, jump).await?;
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
                is_symlink: e.is_symlink,
                link_target: e.link_target,
                broken: e.broken,
                mode: e.mode,
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
    state: State<'_, AppState>,
    req: SshOpenReq,
    path: String,
    jump: Option<JumpReq>,
) -> Result<DownloadDto, String> {
    let _scope = TraceScope::enter("sftp_download");
    let sftp = open_sftp(&state, req, jump).await?;
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

/// 上传序号（只在本进程内有意义）。
static UPLOAD_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// 开始一次分块上传：建连 + 打开写句柄，返回 id。
///
/// 为什么要分成 begin/chunk/end 三步：整文件 base64 一次性发过来会让
/// 「大文件上传」把整个文件塞进内存。分块后每块只有 64 KB，
/// 而且写句柄跨命令存活——这是省内存与将来做断点续传的前提。
#[tauri::command]
async fn sftp_upload_begin(
    state: State<'_, AppState>,
    req: SshOpenReq,
    path: String,
    jump: Option<JumpReq>,
) -> Result<String, String> {
    let _scope = TraceScope::enter("sftp_upload_begin");
    let sftp = open_sftp(&state, req, jump).await?;
    let writer = wt_ssh::SftpWriter::create(sftp, &path)
        .await
        .map_err(|e| e.to_string())?;
    let id = format!(
        "u{}",
        UPLOAD_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    state
        .uploads
        .lock()
        .map_err(|_| "[INTERNAL] 上传表状态异常".to_string())?
        .insert(id.clone(), writer);
    Ok(id)
}

/// 写一块（base64），返回**累计**字节数。
#[tauri::command]
async fn sftp_upload_chunk(
    state: State<'_, AppState>,
    id: String,
    content: String,
) -> Result<u64, String> {
    let data = B64
        .decode(content)
        .map_err(|e| format!("分块解码失败：{e}"))?;
    // 取出再写、写回再放：`MutexGuard` 不能跨 await
    let mut writer = {
        state
            .uploads
            .lock()
            .map_err(|_| "[INTERNAL] 上传表状态异常".to_string())?
            .remove(&id)
            .ok_or_else(|| format!("[SFTP_UPLOAD_UNKNOWN] 没有 id 为 {id} 的上传（可能已结束）"))?
    };
    let result = writer.write_chunk(&data).await;
    // 失败也要放回去：让调用方还能 end/abort，而不是把句柄丢在半空
    state
        .uploads
        .lock()
        .map_err(|_| "[INTERNAL] 上传表状态异常".to_string())?
        .insert(id, writer);
    result.map_err(|e| e.to_string())
}

/// 收尾：刷完缓冲并关闭远端文件，返回总字节数。
#[tauri::command]
async fn sftp_upload_end(state: State<'_, AppState>, id: String) -> Result<u64, String> {
    let writer = {
        state
            .uploads
            .lock()
            .map_err(|_| "[INTERNAL] 上传表状态异常".to_string())?
            .remove(&id)
            .ok_or_else(|| format!("[SFTP_UPLOAD_UNKNOWN] 没有 id 为 {id} 的上传"))?
    };
    writer.finish().await.map_err(|e| e.to_string())
}

/// 放弃这次上传：丢掉写句柄（连接随之释放）。
///
/// 远端会留下半截文件——真实客户端在中断时也是这样，这里不假装能回滚。
#[tauri::command]
async fn sftp_upload_abort(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let taken = {
        state
            .uploads
            .lock()
            .map_err(|_| "[INTERNAL] 上传表状态异常".to_string())?
            .remove(&id)
    };
    if taken.is_none() {
        return Err(format!("[SFTP_UPLOAD_UNKNOWN] 没有 id 为 {id} 的上传"));
    }
    trace(&format!("[sftp_upload_abort] 已放弃 {id}"));
    Ok(())
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
    /// 配置是否落库。带 SOCKS5 认证的隧道**不落库**（凭据不写配置文件），
    /// 界面据此说明「重启后要重填」
    persisted: bool,
    /// 解锁保险库后是否自动拉起。停止状态下界面也要显示它，
    /// 否则「我明明勾了」只能靠记忆（`NET-005`）
    auto_start: bool,
    active: usize,
    total: usize,
    /// 因为超过并发上限被拒的连接数
    rejected: usize,
    up_bytes: u64,
    down_bytes: u64,
    /// 最近一次转发失败的原因；成功转发后清空。界面据此把「运行中」降级成红色
    last_error: Option<String>,
    /// 用户自定义分组（`NET-004`）；空表示按类型自动分组
    group: Option<String>,
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
    /// 用户自定义分组（`NET-004`）。空表示按类型自动分组
    #[serde(default)]
    group: Option<String>,
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
    /// SOCKS5 的代理认证（RFC 1929，`NET-003` AC-3）。只在 `dynamic` 时有效。
    #[serde(default)]
    socks_user: Option<String>,
    #[serde(default)]
    socks_password: Option<String>,
    /// 解锁保险库后自动拉起（`NET-005`）。界面表单里有勾选框；
    /// 带代理认证的隧道不落库，勾选框会被禁用（勾了也没有可拉起的配置）
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
        persisted: meta.persisted,
        auto_start: meta.auto_start,
        active: s.active,
        total: s.total,
        rejected: s.rejected,
        up_bytes: s.up_bytes,
        down_bytes: s.down_bytes,
        last_error: s.last_error,
        // 运行中的实例本身不带分组；`tunnel_stats` 会从配置缓存里补上
        group: None,
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
        group: spec.group.clone(),
        via: spec
            .via_session_id
            .as_ref()
            .map(|s| s.as_str().to_string())
            .unwrap_or_default(),
        running: false,
        persisted: true,
        auto_start: spec.auto_start,
        active: 0,
        total: 0,
        rejected: 0,
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

    let mut cfg = wt_ssh::SshConfig {
        host: arg.req.host.trim().to_string(),
        port: arg.req.port.unwrap_or(22),
        user: arg.req.user.trim().to_string(),
        ..Default::default()
    };
    apply_net_prefs(&mut cfg);
    if cfg.host.is_empty() {
        return Err("[SSH_BAD_ARGUMENT] 主机不能为空".into());
    }
    if cfg.user.is_empty() {
        return Err("[SSH_BAD_ARGUMENT] 用户名不能为空".into());
    }

    let auth = auth_of(&arg.req);
    let jumps = resolve_jumps(&state, arg.jump.as_ref())?;
    let (conn, _added) = connect_accept_new(&cfg, &auth, &jumps).await?;
    trace("[tunnel_start] 承载连接就绪");

    let via = format!("{}@{}", cfg.user, cfg.host);
    let conn = std::sync::Arc::new(conn);
    // SOCKS5 的代理认证（RFC 1929）。只给用户名不给密码是配置错误，不猜。
    let socks_auth = match (
        arg.socks_user.as_deref().map(str::trim).filter(|s| !s.is_empty()),
        arg.socks_password.clone().filter(|s| !s.is_empty()),
    ) {
        (None, _) => None,
        (Some(_), None) => {
            return Err("[TUN_BAD_ARGUMENT] 填了代理用户名就必须填密码".into())
        }
        (Some(u), Some(p)) => Some((u.to_string(), p)),
    };
    if socks_auth.is_some() && !matches!(kind, wt_core::TunnelKind::Dynamic) {
        return Err("[TUN_BAD_ARGUMENT] 代理认证只对动态代理（SOCKS5）有意义".into());
    }
    let (fwd, bound) = match kind {
        wt_core::TunnelKind::Dynamic => {
            let f = wt_ssh::start_socks5(conn, &listen_host, arg.listen_port, socks_auth.clone())
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
        // 带代理认证的隧道不落库：口令不写进配置库
        persisted: socks_auth.is_none(),
        // 没落库就没有「下次启动」，autoStart 一律为假（界面也会据此禁用勾选框）
        auto_start: socks_auth.is_none() && arg.auto_start.unwrap_or(false),
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
        group: arg
            .group
            .as_deref()
            .map(str::trim)
            .filter(|g| !g.is_empty())
            .map(str::to_string),
    };
    if socks_auth.is_some() {
        // 有代理口令就不落库：把它写进配置库等于把口令明文存盘。
        // 代价是重启后要重填——界面会提示（`persisted = false`）。
        trace("[tunnel_start] 带代理认证，跳过落库");
    } else if let Ok(mut store) = wt_store::Store::open(&sessions_db_path()) {
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
            Some((meta, fwd)) => {
                // 运行中的实例拿不到分组，从配置缓存里补：界面的分组必须与库里一致
                let mut dto = tunnel_dto(meta, fwd);
                dto.group = spec.group.clone();
                out.push(dto);
            }
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

    let mut cfg = wt_ssh::SshConfig {
        host,
        port: session.port.unwrap_or(22),
        user,
        ..Default::default()
    };
    apply_net_prefs(&mut cfg);
    let auth = AuthInput::Password(password);
    let (conn, _added) = connect_accept_new(&cfg, &auth, &[]).await?;
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
        persisted: true,
        auto_start: spec.auto_start,
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
    // 埋点：删除是「先停再删」，任何一步挂住都会表现成「点了删除没反应、也不报错」
    trace(&format!("[tunnel_delete] id={id} 运行中={}", taken.is_some()));
    if let Some((_, fwd)) = taken {
        trace("[tunnel_delete] 等待转发停止…");
        fwd.stop().await;
        trace("[tunnel_delete] 转发已停止");
    } else {
        trace("[tunnel_delete] 没有运行中的实例");
    }
    trace("[tunnel_delete] 删除配置…");
    if let Ok(mut store) = wt_store::Store::open(&sessions_db_path()) {
        match store.delete_tunnel(&id) {
            Ok(()) => {}
            // 从没落过库的隧道（例如带代理认证的那类）——本来就没有可删的，
            // 这不是错误。当成错误会让「删除」永远失败、条目留着删不掉。
            Err(e) if e.code == "STORE_NOT_FOUND" => {}
            Err(e) => {
                trace(&format!("[tunnel_delete] 删除失败：{e}"));
                return Err(format!("停止成功，但删除配置失败：{e}"));
            }
        }
    }
    if let Ok(mut specs) = state.tunnel_specs.lock() {
        specs.retain(|s| s.id != id);
    }
    trace("[tunnel_delete] 完成");
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
async fn sftp_mkdir(
    state: State<'_, AppState>,
    req: SshOpenReq,
    path: String,
    jump: Option<JumpReq>,
) -> Result<(), String> {
    let sftp = open_sftp(&state, req, jump).await?;
    sftp.create_dir(&path).await.map_err(|e| e.to_string())
}

/// 改名 / 移动。
#[tauri::command]
async fn sftp_rename(
    state: State<'_, AppState>,
    req: SshOpenReq,
    from: String,
    to: String,
    jump: Option<JumpReq>,
) -> Result<(), String> {
    let sftp = open_sftp(&state, req, jump).await?;
    sftp.rename(&from, &to).await.map_err(|e| e.to_string())
}

/// 删除：按 `is_dir` 分派到 `rmdir` / `unlink`。
///
/// 不做递归删除——一次误点删掉整棵树是最难恢复的事故，
/// 非空目录让服务端拒绝并说清原因。
#[tauri::command]
async fn sftp_remove(
    state: State<'_, AppState>,
    req: SshOpenReq,
    path: String,
    is_dir: bool,
    jump: Option<JumpReq>,
) -> Result<(), String> {
    let sftp = open_sftp(&state, req, jump).await?;
    if is_dir {
        sftp.remove_dir(&path).await.map_err(|e| e.to_string())
    } else {
        sftp.remove_file(&path).await.map_err(|e| e.to_string())
    }
}

/// 改权限位（`FIL-002` 的 `SETSTAT`）。
///
/// `mode` 是完整的 `st_mode`：界面把原条目的类型位与新的权限位拼起来传进来，
/// 这里不做猜测——类型位丢了的后果是有服务端把路径当成未知类型。
#[tauri::command]
async fn sftp_chmod(
    state: State<'_, AppState>,
    req: SshOpenReq,
    path: String,
    mode: u32,
    jump: Option<JumpReq>,
) -> Result<(), String> {
    let sftp = open_sftp(&state, req, jump).await?;
    sftp.set_mode(&path, mode).await.map_err(|e| e.to_string())
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
            uploads: std::sync::Mutex::new(HashMap::new()),
        })
        .setup(|app| {
            create_main_window(app)?;
            start_mock_ssh_if_requested();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            local_open,
            local_shells,
            term_read,
            term_ack,
            term_write,
            term_write_bytes,
            term_resize,
            term_stats,
            term_close,
            ssh_open,
            sessions_load,
            import_mobaxterm,
            mock_generate_key,
            mock_seed_file,
            mock_seed_link,
            mock_seed_many,
            e2e_mock_port,
            sftp_list,
            sftp_download,
            sftp_upload_begin,
            sftp_upload_chunk,
            sftp_upload_end,
            sftp_upload_abort,
            sftp_mkdir,
            sftp_rename,
            sftp_remove,
            sftp_chmod,
            tunnel_start,
            tunnel_start_saved,
            tunnel_autostart,
            tunnel_delete,
            tunnel_stats,
            tunnel_stop,
            vault_status,
            vault_create,
            vault_unlock,
            vault_change_password,
            vault_remove,
            vault_lock,
            credential_save,
            credential_get,
            credential_list,
            credential_delete,
            session_save,
            session_delete,
            session_delete_many,
            folder_save,
            folder_move,
            session_move,
            session_move_many,
            session_reorder,
            session_export,
            app_paths,
            broadcast_export_csv,
            keymap_export,
            tunnel_update,
            prefs_reset,
            session_count,
            tunnels_export,
            tunnels_import,
            prefs_load,
            prefs_save,
            known_hosts_list,
            known_hosts_forget,
            key_generate,
            key_inspect,
            sftp_edit_download,
            sftp_edit_save,
            local_read_text,
            local_write_text,
            open_in_system
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
        let _ = MOCK_LINKS.set(server.links.clone());
        let _ = MOCK_PORT.set(server.port);
        println!("WT_MOCK_SSH_PORT={}", server.port);

        // 第二台：`SES-024` 的跳板机。它的 `direct-tcpip` 会连**真实 TCP** 到目标，
        // 所以「经跳板连上第一台」是一条真的两跳链路，不是模拟的。
        if std::env::var("WT_MOCK_SSH_JUMP").is_ok() {
            let jump = wt_ssh::testing::MockSshServer::start().await;
            println!("WT_MOCK_SSH_JUMP_PORT={}", jump.port);
        }

        // 第三台：`SES-025` 的多跳。目标 ← 跳板机 ← 再一台跳板机，
        // 每一段都是真实 TCP，所以「三跳」也是被证实的链路。
        if std::env::var("WT_MOCK_SSH_JUMP2").is_ok() {
            let jump2 = wt_ssh::testing::MockSshServer::start().await;
            println!("WT_MOCK_SSH_JUMP2_PORT={}", jump2.port);
        }
    });
}

#[cfg(not(feature = "e2e-mock"))]
fn start_mock_ssh_if_requested() {}

#[cfg(test)]
mod data_dir_tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn no_flag_means_no_override() {
        assert_eq!(parse_data_dir_arg(args(&[]).into_iter(), None).unwrap(), None);
    }

    #[test]
    fn config_dir_is_taken_verbatim() {
        let got = parse_data_dir_arg(args(&["--config-dir", "D:/wt-data"]).into_iter(), None).unwrap();
        assert_eq!(got, Some(std::path::PathBuf::from("D:/wt-data")));
    }

    #[test]
    fn config_dir_without_value_is_an_error() {
        // 不能悄悄退回默认目录：用户以为写到了 U 盘，实际落在 %APPDATA%
        assert!(parse_data_dir_arg(args(&["--config-dir"]).into_iter(), None).is_err());
    }

    #[test]
    fn portable_uses_the_exe_dir() {
        let got = parse_data_dir_arg(
            args(&["--portable"]).into_iter(),
            Some(std::path::PathBuf::from("E:/app")),
        )
        .unwrap();
        assert_eq!(got, Some(std::path::PathBuf::from("E:/app")));
    }

    #[test]
    fn portable_without_exe_dir_is_an_error() {
        assert!(parse_data_dir_arg(args(&["--portable"]).into_iter(), None).is_err());
    }
}

