//! SQLite 持久化：schema、迁移、会话读写、导入事务。
//!
//! 设计依据：`docs/design/04-data-model.md` §2、§3、§4。
//!
//! 三条刻意的约束：
//! 1. **单写连接**：写操作串行，避免 `SQLITE_BUSY`；读可并发（后续用连接池）。
//! 2. **导入是单事务**：要么全成、要么全败，绝不留下半截会话树（`spec/05` AC-4）。
//! 3. **未知数据不静默丢弃**：读不出来的行进 `warnings`，由 UI 告知用户。

#![forbid(unsafe_code)]

use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use wt_common::time::now_iso8601;
use wt_common::WtError;
use wt_core::{Environment, Folder, FolderId, Session, SessionId, SessionKind, TunnelKind, TunnelSpec};

/// 当前支持的最高 schema 版本。
pub const SCHEMA_VERSION: i64 = 2;

const MIGRATIONS: &[(i64, &str, &str)] = &[
    (1, "init", include_str!("../migrations/0001_init.sql")),
    (2, "tunnels", include_str!("../migrations/0002_tunnels.sql")),
];

/// 一次加载的结果。
#[derive(Debug, Default, Clone)]
pub struct Snapshot {
    pub folders: Vec<Folder>,
    pub sessions: Vec<Session>,
    /// 隧道配置（只在库里，运行状态由调用方维护）
    pub tunnels: Vec<TunnelSpec>,
    /// 无法解析的行（未知会话类型、坏 JSON 等）。绝不静默丢弃。
    pub warnings: Vec<String>,
}

/// 导入结果。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ImportReport {
    pub folders: usize,
    pub sessions: usize,
}

/// 去重后的导入内容。
#[derive(Debug, Default, Clone)]
pub struct Deduped {
    pub folders: Vec<Folder>,
    pub sessions: Vec<Session>,
    /// 复用了多少个已存在的文件夹
    pub reused_folders: usize,
    /// 因已存在而跳过的会话名
    pub duplicates: Vec<String>,
}

/// 把「待导入内容」与「库里已有内容」对齐，去掉重复的会话与文件夹。
///
/// 判据刻意选用户能感知的「同一个东西」：
/// - 会话：`(名称, 主机, 端口)`；
/// - 文件夹：`(父目录, 名称)`。
///
/// 文件夹必须一起去重：否则重复导入会跳过会话、却把目录树翻倍。
/// 复用的文件夹会把新会话的 `folder_id` 重映射到已有文件夹上。
///
/// 这是纯函数，CLI 与界面共用同一套语义——两边各写一份必然跑偏。
pub fn dedup_against(existing: &Snapshot, folders: &[Folder], sessions: &[Session]) -> Deduped {
    use std::collections::{HashMap, HashSet};

    let seen: HashSet<(String, Option<String>, Option<u16>)> = existing
        .sessions
        .iter()
        .map(|s| (s.name.clone(), s.host.clone(), s.port))
        .collect();

    let mut existing_folders: HashMap<(Option<String>, String), FolderId> = HashMap::new();
    for f in &existing.folders {
        existing_folders.insert(
            (
                f.parent_id.as_ref().map(|p| p.as_str().to_string()),
                f.name.clone(),
            ),
            f.id.clone(),
        );
    }

    let mut folder_remap: HashMap<String, FolderId> = HashMap::new();
    let mut out = Deduped::default();

    // 调用方保证 folders 是「父先于子」，单趟即可完成映射
    for f in folders {
        let mapped_parent = f.parent_id.as_ref().map(|p| {
            folder_remap
                .get(p.as_str())
                .cloned()
                .unwrap_or_else(|| p.clone())
        });
        let key = (
            mapped_parent.as_ref().map(|p| p.as_str().to_string()),
            f.name.clone(),
        );

        match existing_folders.get(&key) {
            Some(id) => {
                folder_remap.insert(f.id.as_str().to_string(), id.clone());
                out.reused_folders += 1;
            }
            None => {
                let mut nf = f.clone();
                nf.parent_id = mapped_parent;
                folder_remap.insert(f.id.as_str().to_string(), nf.id.clone());
                out.folders.push(nf);
            }
        }
    }

    for s in sessions {
        if seen.contains(&(s.name.clone(), s.host.clone(), s.port)) {
            out.duplicates.push(s.name.clone());
            continue;
        }
        let mut s = s.clone();
        if let Some(fid) = &s.folder_id {
            if let Some(mapped) = folder_remap.get(fid.as_str()) {
                s.folder_id = Some(mapped.clone());
            }
        }
        out.sessions.push(s);
    }

    out
}

pub struct Store {
    conn: Connection,
}

impl Store {
    /// 内存库（测试用）。
    pub fn open_in_memory() -> Result<Self, WtError> {
        let conn = Connection::open_in_memory().map_err(map_sqlite)?;
        let mut s = Self { conn };
        s.configure()?;
        s.migrate()?;
        Ok(s)
    }

    /// 文件库。
    pub fn open(path: &Path) -> Result<Self, WtError> {
        if let Some(dir) = path.parent() {
            if !dir.as_os_str().is_empty() {
                std::fs::create_dir_all(dir).map_err(|e| {
                    WtError::new("STORE_IO")
                        .message("无法创建数据目录")
                        .detail(format!("{}: {e}", dir.display()))
                })?;
            }
        }
        let conn = Connection::open(path).map_err(map_sqlite)?;
        let mut s = Self { conn };
        s.configure()?;
        s.migrate()?;
        Ok(s)
    }

    fn configure(&mut self) -> Result<(), WtError> {
        // WAL：读不阻塞写、写不阻塞读
        self.conn
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(map_sqlite)?;
        self.conn
            .pragma_update(None, "synchronous", "NORMAL")
            .map_err(map_sqlite)?;
        self.conn
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(map_sqlite)?;
        self.conn
            .pragma_update(None, "busy_timeout", 5000)
            .map_err(map_sqlite)?;
        Ok(())
    }

    /// 应用迁移。幂等；版本高于程序支持时拒绝启动（`NFR-024` 降级保护）。
    pub fn migrate(&mut self) -> Result<(), WtError> {
        let current: i64 = self
            .conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(map_sqlite)?;

        if current > SCHEMA_VERSION {
            return Err(WtError::new("STORE_VERSION_TOO_NEW")
                .message(format!(
                    "数据版本 {current} 高于本程序支持的 {SCHEMA_VERSION}，请升级 WindTerm"
                ))
                .detail("旧版本程序打开新数据会损坏数据，已拒绝启动")
                .hint(
                    "下载最新版本",
                    wt_common::HintAction::OpenUrl("https://windterm.dev/download".into()),
                ));
        }

        for (v, name, sql) in MIGRATIONS.iter().filter(|(v, _, _)| *v > current) {
            let tx = self.conn.transaction().map_err(map_sqlite)?;
            tx.execute_batch(sql).map_err(map_sqlite)?;
            tx.execute(
                "INSERT OR REPLACE INTO schema_migrations(version, name, applied_at) VALUES (?1, ?2, ?3)",
                params![v, name, now_iso8601()],
            )
            .map_err(map_sqlite)?;
            tx.pragma_update(None, "user_version", v)
                .map_err(map_sqlite)?;
            tx.commit().map_err(map_sqlite)?;
        }

        Ok(())
    }

    pub fn schema_version(&self) -> Result<i64, WtError> {
        self.conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(map_sqlite)
    }

    // ── 写入 ────────────────────────────────────────────────

    pub fn upsert_folder(&mut self, f: &Folder) -> Result<(), WtError> {
        let tx = self.conn.transaction().map_err(map_sqlite)?;
        upsert_folder_tx(&tx, f)?;
        tx.commit().map_err(map_sqlite)
    }

    pub fn upsert_session(&mut self, s: &Session) -> Result<(), WtError> {
        let tx = self.conn.transaction().map_err(map_sqlite)?;
        upsert_session_tx(&tx, s)?;
        tx.commit().map_err(map_sqlite)
    }

    /// 保存一条隧道配置。**先校验**：不自洽的配置不该进库（`TunnelSpec::validate`）。
    pub fn upsert_tunnel(&mut self, t: &TunnelSpec) -> Result<(), WtError> {
        t.validate()?;
        let kind = match t.kind {
            TunnelKind::Local => "local",
            TunnelKind::Remote => "remote",
            TunnelKind::Dynamic => "dynamic",
        };
        let tx = self.conn.transaction().map_err(map_sqlite)?;
        tx.execute(
            "INSERT INTO tunnels (id, name, kind, listen_host, listen_port, target_host,
                                  target_port, via_session_id, auto_start, rev)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                kind = excluded.kind,
                listen_host = excluded.listen_host,
                listen_port = excluded.listen_port,
                target_host = excluded.target_host,
                target_port = excluded.target_port,
                via_session_id = excluded.via_session_id,
                auto_start = excluded.auto_start,
                rev = tunnels.rev + 1",
            params![
                t.id,
                t.name,
                kind,
                t.listen_host,
                i64::from(t.listen_port),
                t.target_host,
                t.target_port.map(i64::from),
                t.via_session_id.as_ref().map(|s| s.as_str()),
                i64::from(t.auto_start),
            ],
        )
        .map_err(map_sqlite)?;
        tx.commit().map_err(map_sqlite)
    }

    /// 删除一条隧道配置（**不等于停止**：停止由调用方负责）。
    pub fn delete_tunnel(&mut self, id: &str) -> Result<(), WtError> {
        let n = self
            .conn
            .execute("DELETE FROM tunnels WHERE id = ?1", params![id])
            .map_err(map_sqlite)?;
        if n == 0 {
            return Err(WtError::new("STORE_NOT_FOUND").message(format!("隧道 {id} 不存在")));
        }
        Ok(())
    }

    pub fn delete_folder(&mut self, id: &FolderId) -> Result<(), WtError> {
        let n = self
            .conn
            .execute("DELETE FROM folders WHERE id = ?1", params![id.as_str()])
            .map_err(map_sqlite)?;
        if n == 0 {
            return Err(WtError::new("STORE_NOT_FOUND")
                .message(format!("文件夹 {id} 不存在")));
        }
        Ok(())
    }

    pub fn delete_session(&mut self, id: &SessionId) -> Result<(), WtError> {
        let n = self
            .conn
            .execute("DELETE FROM sessions WHERE id = ?1", params![id.as_str()])
            .map_err(map_sqlite)?;
        if n == 0 {
            return Err(WtError::new("STORE_NOT_FOUND")
                .message(format!("会话 {id} 不存在")));
        }
        Ok(())
    }

    /// 批量导入：**单事务**，任何一行失败则整体回滚。
    pub fn import(
        &mut self,
        folders: &[Folder],
        sessions: &[Session],
    ) -> Result<ImportReport, WtError> {
        let tx = self.conn.transaction().map_err(map_sqlite)?;

        // 父先于子：按「父是否已存在」迭代，避免依赖输入顺序
        let mut pending: Vec<&Folder> = folders.iter().collect();
        let mut inserted = 0usize;
        let mut guard = 0;
        while !pending.is_empty() {
            guard += 1;
            if guard > folders.len() + 2 {
                return Err(WtError::new("STORE_IMPORT_BAD_TREE")
                    .message("导入的文件夹结构存在环或缺失父节点，已中止")
                    .detail(format!("剩余 {} 个文件夹无法确定顺序", pending.len())));
            }

            let mut progressed = false;
            let mut rest = Vec::new();
            for f in pending {
                let parent_ok = match &f.parent_id {
                    None => true,
                    Some(p) => folder_exists_tx(&tx, p)?,
                };
                if parent_ok {
                    insert_folder_tx(&tx, f)?;
                    inserted += 1;
                    progressed = true;
                } else {
                    rest.push(f);
                }
            }
            if !progressed {
                return Err(WtError::new("STORE_IMPORT_BAD_TREE")
                    .message("导入的文件夹存在无法解析的父子关系，已中止")
                    .detail(format!(
                        "{} 个文件夹的父节点不在本次导入中",
                        rest.len()
                    )));
            }
            pending = rest;
        }

        for s in sessions {
            if let Some(fid) = &s.folder_id {
                if !folder_exists_tx(&tx, fid)? {
                    return Err(WtError::new("STORE_IMPORT_MISSING_FOLDER")
                        .message(format!(
                            "会话「{}」指向的文件夹 {fid} 不在本次导入中",
                            s.name
                        ))
                        .hint("先导入其所属文件夹", wt_common::HintAction::None));
                }
            }
            insert_session_tx(&tx, s)?;
        }

        tx.commit().map_err(map_sqlite)?;
        Ok(ImportReport {
            folders: inserted,
            sessions: sessions.len(),
        })
    }

    // ── 读取 ────────────────────────────────────────────────

    pub fn load_folders(&self) -> Result<Vec<Folder>, WtError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, parent_id, name, sort_order, color, environment, collapsed, rev
                 FROM folders ORDER BY sort_order, name",
            )
            .map_err(map_sqlite)?;

        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                ))
            })
            .map_err(map_sqlite)?;

        let mut out = Vec::new();
        for r in rows {
            let (id, parent, name, order, color, env, collapsed, rev) = r.map_err(map_sqlite)?;
            out.push(Folder {
                id: FolderId::from(id),
                parent_id: parent.map(FolderId::from),
                name,
                sort_order: order,
                color,
                environment: env.as_deref().and_then(parse_env),
                collapsed: collapsed != 0,
                rev,
            });
        }
        Ok(out)
    }

    pub fn load_sessions(&self) -> Result<Vec<Session>, WtError> {
        Ok(self.load_snapshot()?.sessions)
    }

    /// 一次读出全部数据，并把无法解析的行记入 `warnings`。
    pub fn load_snapshot(&self) -> Result<Snapshot, WtError> {
        let folders = self.load_folders()?;
        let mut warnings = Vec::new();

        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, folder_id, name, type, sort_order, host, port, username,
                        environment, credential_ref, options, settings, last_used_at, last_cwd, rev
                 FROM sessions ORDER BY sort_order, name",
            )
            .map_err(map_sqlite)?;

        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<i64>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, String>(11)?,
                    row.get::<_, Option<String>>(12)?,
                    row.get::<_, Option<String>>(13)?,
                    row.get::<_, i64>(14)?,
                ))
            })
            .map_err(map_sqlite)?;

        let mut sessions = Vec::new();
        for r in rows {
            let row = r.map_err(map_sqlite)?;
            let (id, folder_id, name, kind_s, order, host, port, username, env, cred, opt, set, used, cwd, rev) = row;

            let Some(kind) = SessionKind::parse(&kind_s) else {
                // 例如 X11 移除后残留的 'xdmcp' 行
                warnings.push(format!(
                    "会话「{name}」（{id}）的类型 `{kind_s}` 已不受支持，已跳过；\
                     可用 `wt session export --include-unsupported` 导出后手工处理"
                ));
                continue;
            };

            let options = parse_json_or_warn(&opt, &name, "options", &mut warnings);
            let settings = parse_json_or_warn(&set, &name, "settings", &mut warnings);

            sessions.push(Session {
                id: SessionId::from(id),
                folder_id: folder_id.map(FolderId::from),
                name,
                kind,
                sort_order: order,
                host,
                port: port.and_then(|p| u16::try_from(p).ok()),
                username,
                environment: env.as_deref().and_then(parse_env),
                credential_ref: cred,
                options,
                settings,
                last_used_at: used,
                last_cwd: cwd,
                rev,
            });
        }

        let tunnels = self.load_tunnels(&mut warnings)?;

        Ok(Snapshot {
            folders,
            sessions,
            tunnels,
            warnings,
        })
    }

    /// 读出隧道配置。未知类型只警告、不丢——用户需要知道库里有什么。
    fn load_tunnels(&self, warnings: &mut Vec<String>) -> Result<Vec<TunnelSpec>, WtError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, name, kind, listen_host, listen_port, target_host, target_port,
                        via_session_id, auto_start
                 FROM tunnels ORDER BY name, id",
            )
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<i64>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, i64>(8)?,
                ))
            })
            .map_err(map_sqlite)?;

        let mut out = Vec::new();
        for r in rows {
            let (id, name, kind_s, listen_host, listen_port, th, tp, via, auto_start) =
                r.map_err(map_sqlite)?;
            let kind = match kind_s.as_str() {
                "local" => TunnelKind::Local,
                "remote" => TunnelKind::Remote,
                "dynamic" => TunnelKind::Dynamic,
                other => {
                    warnings.push(format!(
                        "隧道「{name}」（{id}）的类型 `{other}` 不认识，已跳过"
                    ));
                    continue;
                }
            };
            out.push(TunnelSpec {
                id,
                name,
                kind,
                listen_host,
                listen_port: u16::try_from(listen_port).unwrap_or(0),
                target_host: th,
                target_port: tp.and_then(|p| u16::try_from(p).ok()),
                via_session_id: via.map(SessionId::from),
                auto_start: auto_start != 0,
            });
        }
        Ok(out)
    }

    /// 目录计数（诊断与测试用）。
    pub fn counts(&self) -> Result<(i64, i64), WtError> {
        let f: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM folders", [], |r| r.get(0))
            .map_err(map_sqlite)?;
        let s: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
            .map_err(map_sqlite)?;
        Ok((f, s))
    }
}

// ── 内部工具 ────────────────────────────────────────────────

/// 只插入，不覆盖。导入路径专用：ID 冲突必须失败，由调用方决定「重命名/跳过/覆盖」。
fn insert_folder_tx(tx: &rusqlite::Transaction<'_>, f: &Folder) -> Result<(), WtError> {
    tx.execute(
        "INSERT INTO folders (id, parent_id, name, sort_order, color, environment, collapsed,
                              created_at, updated_at, rev)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9)",
        params![
            f.id.as_str(),
            f.parent_id.as_ref().map(|p| p.as_str()),
            f.name,
            f.sort_order,
            f.color,
            f.environment.map(env_str),
            f.collapsed as i64,
            now_iso8601(),
            f.rev,
        ],
    )
    .map_err(map_sqlite)?;
    Ok(())
}

/// 只插入，不覆盖。语义同 `insert_folder_tx`。
fn insert_session_tx(tx: &rusqlite::Transaction<'_>, s: &Session) -> Result<(), WtError> {
    let options = serde_json::to_string(&s.options).map_err(|e| {
        WtError::new("STORE_SERIALIZE").message("会话 options 序列化失败").detail(e.to_string())
    })?;
    let settings = serde_json::to_string(&s.settings).map_err(|e| {
        WtError::new("STORE_SERIALIZE").message("会话 settings 序列化失败").detail(e.to_string())
    })?;

    tx.execute(
        "INSERT INTO sessions (id, folder_id, name, type, sort_order, host, port, username,
                               environment, credential_ref, options, settings,
                               last_used_at, last_cwd, created_at, updated_at, rev)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15, ?16)",
        params![
            s.id.as_str(),
            s.folder_id.as_ref().map(|f| f.as_str()),
            s.name,
            s.kind.as_str(),
            s.sort_order,
            s.host,
            s.port.map(|p| p as i64),
            s.username,
            s.environment.map(env_str),
            s.credential_ref,
            options,
            settings,
            s.last_used_at,
            s.last_cwd,
            now_iso8601(),
            s.rev,
        ],
    )
    .map_err(map_sqlite)?;
    Ok(())
}
fn upsert_folder_tx(tx: &rusqlite::Transaction<'_>, f: &Folder) -> Result<(), WtError> {
    tx.execute(
        "INSERT INTO folders (id, parent_id, name, sort_order, color, environment, collapsed,
                              created_at, updated_at, rev)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
            parent_id = excluded.parent_id,
            name = excluded.name,
            sort_order = excluded.sort_order,
            color = excluded.color,
            environment = excluded.environment,
            collapsed = excluded.collapsed,
            updated_at = excluded.updated_at,
            rev = excluded.rev",
        params![
            f.id.as_str(),
            f.parent_id.as_ref().map(|p| p.as_str()),
            f.name,
            f.sort_order,
            f.color,
            f.environment.map(env_str),
            f.collapsed as i64,
            now_iso8601(),
            f.rev,
        ],
    )
    .map_err(map_sqlite)?;
    Ok(())
}

fn upsert_session_tx(tx: &rusqlite::Transaction<'_>, s: &Session) -> Result<(), WtError> {
    let options = serde_json::to_string(&s.options).map_err(|e| {
        WtError::new("STORE_SERIALIZE").message("会话 options 序列化失败").detail(e.to_string())
    })?;
    let settings = serde_json::to_string(&s.settings).map_err(|e| {
        WtError::new("STORE_SERIALIZE").message("会话 settings 序列化失败").detail(e.to_string())
    })?;

    tx.execute(
        "INSERT INTO sessions (id, folder_id, name, type, sort_order, host, port, username,
                               environment, credential_ref, options, settings,
                               last_used_at, last_cwd, created_at, updated_at, rev)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15, ?16)
         ON CONFLICT(id) DO UPDATE SET
            folder_id = excluded.folder_id,
            name = excluded.name,
            type = excluded.type,
            sort_order = excluded.sort_order,
            host = excluded.host,
            port = excluded.port,
            username = excluded.username,
            environment = excluded.environment,
            credential_ref = excluded.credential_ref,
            options = excluded.options,
            settings = excluded.settings,
            last_used_at = excluded.last_used_at,
            last_cwd = excluded.last_cwd,
            updated_at = excluded.updated_at,
            rev = excluded.rev",
        params![
            s.id.as_str(),
            s.folder_id.as_ref().map(|f| f.as_str()),
            s.name,
            s.kind.as_str(),
            s.sort_order,
            s.host,
            s.port.map(|p| p as i64),
            s.username,
            s.environment.map(env_str),
            s.credential_ref,
            options,
            settings,
            s.last_used_at,
            s.last_cwd,
            now_iso8601(),
            s.rev,
        ],
    )
    .map_err(map_sqlite)?;
    Ok(())
}

fn folder_exists_tx(tx: &rusqlite::Transaction<'_>, id: &FolderId) -> Result<bool, WtError> {
    let found: Option<i64> = tx
        .query_row(
            "SELECT 1 FROM folders WHERE id = ?1",
            params![id.as_str()],
            |r| r.get(0),
        )
        .optional()
        .map_err(map_sqlite)?;
    Ok(found.is_some())
}

fn parse_json_or_warn(
    raw: &str,
    session_name: &str,
    field: &str,
    warnings: &mut Vec<String>,
) -> serde_json::Value {
    match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(e) => {
            warnings.push(format!(
                "会话「{session_name}」的 {field} 不是合法 JSON，已按空对象处理：{e}"
            ));
            serde_json::Value::Object(Default::default())
        }
    }
}

fn env_str(e: Environment) -> &'static str {
    match e {
        Environment::Production => "production",
        Environment::Staging => "staging",
        Environment::Test => "test",
        Environment::Dev => "dev",
    }
}

fn parse_env(s: &str) -> Option<Environment> {
    Some(match s {
        "production" => Environment::Production,
        "staging" => Environment::Staging,
        "test" => Environment::Test,
        "dev" => Environment::Dev,
        _ => return None,
    })
}

fn map_sqlite(e: rusqlite::Error) -> WtError {
    let detail = e.to_string();
    // 外键/唯一约束冲突是「用户可理解」的冲突，不该报成内部错误
    let (code, msg) = match &e {
        rusqlite::Error::SqliteFailure(err, _)
            if err.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            ("STORE_CONSTRAINT", "数据约束冲突（重复 ID 或引用了不存在的父节点）")
        }
        _ => ("STORE_SQLITE", "数据库操作失败"),
    };
    WtError::new(code).message(msg).detail(detail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn folder(id: &str, parent: Option<&str>, name: &str) -> Folder {
        Folder {
            id: FolderId::from(id),
            parent_id: parent.map(FolderId::from),
            name: name.into(),
            sort_order: 0,
            color: None,
            environment: None,
            collapsed: false,
            rev: 1,
        }
    }

    fn session(id: &str, folder: Option<&str>, name: &str) -> Session {
        Session {
            id: SessionId::from(id),
            folder_id: folder.map(FolderId::from),
            name: name.into(),
            kind: SessionKind::Ssh,
            sort_order: 0,
            host: Some("10.0.1.11".into()),
            port: Some(22),
            username: Some("deploy".into()),
            environment: Some(Environment::Production),
            credential_ref: Some("cred-1".into()),
            options: json!({ "compression": true, "jumpSessionId": "bastion" }),
            settings: json!({ "fontSize": 14 }),
            last_used_at: None,
            last_cwd: Some("/var/log".into()),
            rev: 1,
        }
    }

    #[test]
    fn migrate_creates_schema_and_is_idempotent() {
        let mut s = Store::open_in_memory().unwrap();
        assert_eq!(s.schema_version().unwrap(), SCHEMA_VERSION);
        // 再跑一次不应报错
        s.migrate().unwrap();
        assert_eq!(s.schema_version().unwrap(), SCHEMA_VERSION);
        assert_eq!(s.counts().unwrap(), (0, 0));
    }

    #[test]
    fn tunnels_persist_and_reject_contradictions() {
        let mut s = Store::open_in_memory().unwrap();
        let mut spec = TunnelSpec {
            id: "t1".into(),
            name: "测试库".into(),
            kind: TunnelKind::Local,
            listen_host: "127.0.0.1".into(),
            listen_port: 0,
            target_host: Some("db".into()),
            target_port: Some(3306),
            via_session_id: None,
            auto_start: true,
        };

        s.upsert_tunnel(&spec).unwrap();
        let snap = s.load_snapshot().unwrap();
        assert_eq!(snap.tunnels, vec![spec.clone()], "存进去的要原样读回来");
        assert!(snap.warnings.is_empty());

        // 同 id 再存是更新，不是新增
        spec.name = "改名了".into();
        s.upsert_tunnel(&spec).unwrap();
        let snap2 = s.load_snapshot().unwrap();
        assert_eq!(snap2.tunnels.len(), 1);
        assert_eq!(snap2.tunnels[0].name, "改名了");

        // 矛盾配置进不了库：动态代理不能带目标
        let mut bad = spec.clone();
        bad.kind = TunnelKind::Dynamic;
        assert_eq!(s.upsert_tunnel(&bad).unwrap_err().code, "TUN_BAD_ARGUMENT");

        s.delete_tunnel("t1").unwrap();
        assert!(s.load_snapshot().unwrap().tunnels.is_empty());
        assert_eq!(
            s.delete_tunnel("t1").unwrap_err().code,
            "STORE_NOT_FOUND",
            "删不存在的要报错，不能静默成功"
        );
    }

    #[test]
    fn unknown_tunnel_kind_is_reported_not_dropped_silently() {
        let s = Store::open_in_memory().unwrap();
        // 模拟「旧版本写入、新版本不认识的类型」
        s.conn
            .execute(
                "INSERT INTO tunnels (id, name, kind, listen_host, listen_port)
                 VALUES ('x', '旧隧道', 'socks4', '127.0.0.1', 0)",
                [],
            )
            .unwrap();
        let snap = s.load_snapshot().unwrap();
        assert!(snap.tunnels.is_empty());
        assert!(
            snap.warnings.iter().any(|w| w.contains("socks4")),
            "未知类型必须出现在 warnings 里，实际：{:?}",
            snap.warnings
        );
    }

    #[test]
    fn refuses_to_open_newer_schema() {
        let mut s = Store::open_in_memory().unwrap();
        s.conn
            .pragma_update(None, "user_version", SCHEMA_VERSION + 5)
            .unwrap();
        let err = s.migrate().unwrap_err();
        assert_eq!(err.code, "STORE_VERSION_TOO_NEW");
        assert!(err.hints.iter().any(|h| h.label.contains("最新")));
    }

    #[test]
    fn folder_and_session_roundtrip_preserves_options() {
        let mut s = Store::open_in_memory().unwrap();
        s.upsert_folder(&folder("f1", None, "生产")).unwrap();
        s.upsert_session(&session("s1", Some("f1"), "web-01")).unwrap();

        let snap = s.load_snapshot().unwrap();
        assert!(snap.warnings.is_empty());
        assert_eq!(snap.folders.len(), 1);
        assert_eq!(snap.sessions.len(), 1);

        let got = &snap.sessions[0];
        assert_eq!(got.name, "web-01");
        assert_eq!(got.kind, SessionKind::Ssh);
        assert_eq!(got.environment, Some(Environment::Production));
        assert_eq!(got.options["compression"], json!(true));
        assert_eq!(got.options["jumpSessionId"], json!("bastion"));
        assert_eq!(got.settings["fontSize"], json!(14));
        assert_eq!(got.last_cwd.as_deref(), Some("/var/log"));
    }

    #[test]
    fn upsert_updates_existing_row() {
        let mut s = Store::open_in_memory().unwrap();
        let mut ses = session("s1", None, "web-01");
        s.upsert_session(&ses).unwrap();

        ses.name = "web-01-renamed".into();
        ses.rev = 2;
        s.upsert_session(&ses).unwrap();

        let snap = s.load_snapshot().unwrap();
        assert_eq!(snap.sessions.len(), 1, "不能变成两行");
        assert_eq!(snap.sessions[0].name, "web-01-renamed");
        assert_eq!(snap.sessions[0].rev, 2);
    }

    #[test]
    fn dedup_reuses_folders_and_skips_duplicate_sessions() {
        // 已有：根文件夹 Prod、其下会话 web-01
        let existing = Snapshot {
            folders: vec![folder("f-prod", None, "Prod")],
            sessions: vec![session("s1", Some("f-prod"), "web-01")],
            tunnels: Vec::new(),
            warnings: Vec::new(),
        };

        // 再导一次同一份内容（新 ID），另外多一个同目录下的新会话
        let incoming_folders = vec![folder("f-prod-2", None, "Prod")];
        let incoming_sessions = vec![
            session("s1-2", Some("f-prod-2"), "web-01"),
            session("s2", Some("f-prod-2"), "web-02"),
        ];

        let d = dedup_against(&existing, &incoming_folders, &incoming_sessions);
        assert_eq!(d.reused_folders, 1, "同名同父的文件夹应复用");
        assert!(d.folders.is_empty(), "不应新增文件夹");
        assert_eq!(d.duplicates, vec!["web-01".to_string()]);
        assert_eq!(d.sessions.len(), 1);
        // 新会话必须挂到**已有**文件夹上，而不是那个没被创建的新 ID
        assert_eq!(
            d.sessions[0].folder_id.as_ref().map(|f| f.as_str()),
            Some("f-prod")
        );
    }

    #[test]
    fn dedup_keeps_nested_folders_under_their_remapped_parent() {
        let existing = Snapshot {
            folders: vec![folder("f-a", None, "A")],
            sessions: Vec::new(),
            tunnels: Vec::new(),
            warnings: Vec::new(),
        };
        // 导入内容：A（已存在）→ B（新）→ 会话挂在 B 下
        let incoming_folders = vec![
            folder("f-a2", None, "A"),
            folder("f-b", Some("f-a2"), "B"),
        ];
        let incoming_sessions = vec![session("s", Some("f-b"), "web-09")];

        let d = dedup_against(&existing, &incoming_folders, &incoming_sessions);
        assert_eq!(d.reused_folders, 1);
        assert_eq!(d.folders.len(), 1, "只应新增 B");
        assert_eq!(d.folders[0].name, "B");
        // B 的父必须指向已有 A
        assert_eq!(
            d.folders[0].parent_id.as_ref().map(|p| p.as_str()),
            Some("f-a")
        );
        assert_eq!(d.sessions.len(), 1);
    }

    #[test]
    fn import_is_atomic_on_conflict() {
        let mut s = Store::open_in_memory().unwrap();
        s.upsert_folder(&folder("existing", None, "已有")).unwrap();

        // 批次里第一行与已有 ID 冲突：整批必须回滚
        let folders = vec![folder("new-1", None, "新1"), folder("existing", None, "冲突")];
        let err = s.import(&folders, &[]).unwrap_err();
        assert_eq!(err.code, "STORE_CONSTRAINT");

        let snap = s.load_snapshot().unwrap();
        assert_eq!(snap.folders.len(), 1, "回滚后只应剩原有的一行");
        assert_eq!(snap.folders[0].name, "已有");
    }

    #[test]
    fn import_orders_parents_before_children() {
        let mut s = Store::open_in_memory().unwrap();
        // 故意把子节点放在前面
        let folders = vec![
            folder("child", Some("parent"), "子"),
            folder("parent", None, "父"),
            folder("grand", Some("child"), "孙"),
        ];
        let report = s.import(&folders, &[]).unwrap();
        assert_eq!(report.folders, 3);

        let snap = s.load_snapshot().unwrap();
        assert_eq!(snap.folders.len(), 3);
    }

    #[test]
    fn import_rejects_session_pointing_to_unknown_folder() {
        let mut s = Store::open_in_memory().unwrap();
        let err = s
            .import(&[], &[session("s1", Some("ghost"), "x")])
            .unwrap_err();
        assert_eq!(err.code, "STORE_IMPORT_MISSING_FOLDER");
        assert_eq!(s.counts().unwrap(), (0, 0), "失败后不能留下任何行");
    }

    #[test]
    fn import_rejects_cyclic_folders() {
        let mut s = Store::open_in_memory().unwrap();
        let folders = vec![
            folder("a", Some("b"), "A"),
            folder("b", Some("a"), "B"),
        ];
        let err = s.import(&folders, &[]).unwrap_err();
        assert_eq!(err.code, "STORE_IMPORT_BAD_TREE");
        assert_eq!(s.counts().unwrap(), (0, 0));
    }

    #[test]
    fn deleting_folder_cascades_to_sessions() {
        let mut s = Store::open_in_memory().unwrap();
        s.upsert_folder(&folder("f1", None, "生产")).unwrap();
        s.upsert_session(&session("s1", Some("f1"), "web-01")).unwrap();
        assert_eq!(s.counts().unwrap(), (1, 1));

        s.delete_folder(&FolderId::from("f1")).unwrap();
        assert_eq!(s.counts().unwrap(), (0, 0), "外键级联应删掉子会话");
    }

    #[test]
    fn unknown_session_type_is_reported_not_dropped_silently() {
        let mut s = Store::open_in_memory().unwrap();
        s.upsert_session(&session("s1", None, "ok")).unwrap();
        // 模拟 X11 移除后残留的旧数据
        s.conn
            .execute(
                "INSERT INTO sessions (id, name, type) VALUES ('s2', 'old-xdmcp', 'xdmcp')",
                [],
            )
            .unwrap();

        let snap = s.load_snapshot().unwrap();
        assert_eq!(snap.sessions.len(), 1);
        assert_eq!(snap.warnings.len(), 1);
        assert!(snap.warnings[0].contains("xdmcp"));
        assert!(snap.warnings[0].contains("old-xdmcp"));
    }

    #[test]
    fn bad_json_is_reported_and_replaced_with_empty_object() {
        let s = Store::open_in_memory().unwrap();
        s.conn
            .execute(
                "INSERT INTO sessions (id, name, type, options) VALUES ('s1', 'broken', 'ssh', 'not json')",
                [],
            )
            .unwrap();

        let snap = s.load_snapshot().unwrap();
        assert_eq!(snap.sessions.len(), 1);
        assert_eq!(snap.sessions[0].options, json!({}));
        assert!(snap.warnings.iter().any(|w| w.contains("options")));
    }

    #[test]
    fn delete_missing_rows_returns_not_found() {
        let mut s = Store::open_in_memory().unwrap();
        assert_eq!(
            s.delete_folder(&FolderId::from("nope")).unwrap_err().code,
            "STORE_NOT_FOUND"
        );
        assert_eq!(
            s.delete_session(&SessionId::from("nope")).unwrap_err().code,
            "STORE_NOT_FOUND"
        );
    }

    #[test]
    fn file_store_persists_across_reopen() {
        let dir = std::env::temp_dir().join(format!("wt-store-test-{}", std::process::id()));
        let path = dir.join("data.db");
        let _ = std::fs::remove_dir_all(&dir);

        {
            let mut s = Store::open(&path).unwrap();
            s.upsert_session(&session("s1", None, "persisted")).unwrap();
        }
        {
            let s = Store::open(&path).unwrap();
            let snap = s.load_snapshot().unwrap();
            assert_eq!(snap.sessions.len(), 1);
            assert_eq!(snap.sessions[0].name, "persisted");
        }

        let _ = std::fs::remove_dir_all(&dir);
    }
}
