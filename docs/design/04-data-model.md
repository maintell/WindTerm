# 详细设计 · 04 · 数据模型与持久化

实现需求：`SES-012`~`SES-020`、`SET-006`~`SET-014`、`NET-004`、`TER-035`、`NFR-024`
关键 ADR：ADR-0006（SQLite + TOML 分离）、ADR-0010（导入：结构优先、凭据补录）

## 1. 为什么分三种存储

| 数据 | 形态 | 存储 | 理由 |
|---|---|---|---|
| 设置 | 树状、项少、需人读 | **TOML 文件** | 可 diff、可进 Git、可被企业配置系统下发、可手改 |
| 会话/隧道/宏/队列 | 表格、项多、需查询与事务 | **SQLite** | 事务性（导入要么全成要么全败）、可索引、可并发读 |
| 凭据 | 少量、高敏感 | **加密二进制** | 见 `design/09` |

**不用单一存储的理由**

- 全用 SQLite：设置无法手改、无法 diff、企业下发困难（要教 IT 部门写 SQL）。
- 全用文件：会话树的事务性无法保证（导入中途崩溃 = 半个树）、查询要全量加载、并发写会互相覆盖。

MobaXterm 用单一 INI 文件，代价就是：导入导出容易半途失败、并发写会丢数据、无法表达嵌套（只能 `[Bookmarks_1]` 平铺编号）。

## 2. SQLite Schema

### 2.1 元信息

```sql
CREATE TABLE schema_migrations (
    version     INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL,
    applied_at  TEXT    NOT NULL
);
```

版本号同时写入 `PRAGMA user_version`，用于快速判断（不查表）。

### 2.2 文件夹

```sql
CREATE TABLE folders (
    id          TEXT PRIMARY KEY,           -- UUID v7（时间有序，便于排序）
    parent_id   TEXT REFERENCES folders(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    color       TEXT,                        -- #RRGGBB
    environment TEXT,                        -- production|staging|test|dev|NULL
    collapsed   INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    rev         INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_folders_parent ON folders(parent_id, sort_order);
```

**为什么 `ON DELETE CASCADE`**：删除文件夹必须连带删除子项，否则会产生孤儿节点。但**应用层仍要先做二次确认**（`SEC-011`），不能依赖数据库级联来做用户交互。

### 2.3 会话

```sql
CREATE TABLE sessions (
    id              TEXT PRIMARY KEY,
    folder_id       TEXT REFERENCES folders(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    type            TEXT NOT NULL,            -- ssh|telnet|rdp|vnc|ftp|sftp|mosh|serial|local
    sort_order      INTEGER NOT NULL DEFAULT 0,

    -- 通用连接字段（可查询、可索引）
    host            TEXT,
    port            INTEGER,
    username        TEXT,
    environment     TEXT,
    credential_ref  TEXT,                     -- 保险库条目 ID，不含密文

    -- 协议特有字段（JSON）
    options         TEXT NOT NULL DEFAULT '{}',

    -- 会话级设置覆盖（JSON）
    settings        TEXT NOT NULL DEFAULT '{}',

    -- 运行态回填
    last_used_at    TEXT,
    last_cwd        TEXT,

    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    rev             INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_sessions_folder ON sessions(folder_id, sort_order);
CREATE INDEX idx_sessions_type   ON sessions(type);
CREATE INDEX idx_sessions_host   ON sessions(host);
CREATE INDEX idx_sessions_used   ON sessions(last_used_at DESC);
```

**为什么「通用字段用列、协议特有字段用 JSON」**

| 方案 | 问题 |
|---|---|
| 全部 JSON | 无法索引 host，搜索「所有连过 10.0.1.* 的会话」要全表扫描 + JSON 解析 |
| 全部列 | 10 种会话类型 × 每类 15 个字段 = 150 列，绝大多数为 NULL；加字段要迁移 |
| 混合（采用） | 通用字段可查可索引；协议字段灵活；加协议字段不需迁移 |

**`options` 的 JSON Schema（按类型）**

```jsonc
// ssh
{ "auth": "auto|password|publickey|keyboard-interactive|agent",
  "privateKeyRef": "vault-id | null",
  "compression": false, "agentForward": false,
  "keepaliveSecs": 30, "remoteCommand": "", "keepOpen": false,
  "termType": "xterm-256color", "locale": "auto",
  "jumpSessionId": null, "proxy": { "type": "none|socks5|socks4|http", "host": "", "port": 0, "user": "", "credentialRef": null },
  "algos": null }

// rdp
{ "domain": "", "consoleSession": false, "redirectDrives": [], "redirectClipboard": "both",
  "redirectPrinters": false, "redirectPorts": false, "smartcard": false,
  "egfx": true, "h264": true, "forwardKeys": true, "credssp": true,
  "multimon": "current", "dynamicResolution": true, "audio": "local", "colorDepth": 32 }

// serial
{ "port": "COM3", "baudRate": 115200, "dataBits": 8, "stopBits": 1,
  "parity": "none", "flowControl": "none", "dtr": true, "rts": true }
```

### 2.4 隧道

```sql
CREATE TABLE tunnels (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    type            TEXT NOT NULL,            -- local|remote|dynamic
    session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    listen_host     TEXT NOT NULL DEFAULT '127.0.0.1',
    listen_port     INTEGER NOT NULL DEFAULT 0,
    target_host     TEXT,
    target_port     INTEGER,
    auto_start      TEXT NOT NULL DEFAULT 'manual',   -- manual|on_app_start|on_session_start
    enabled         INTEGER NOT NULL DEFAULT 1,
    options         TEXT NOT NULL DEFAULT '{}',       -- 重连策略、认证等
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX idx_tunnels_session ON tunnels(session_id);
```

**`listen_port = 0`** 表示系统分配；实际端口在运行时确定，不写回数据库（否则下次启动会试图绑定上次的随机端口）。

### 2.5 宏

```sql
CREATE TABLE macros (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    steps       TEXT NOT NULL,               -- JSON 数组
    description TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
```

### 2.6 传输队列

```sql
CREATE TABLE transfers (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    direction   TEXT NOT NULL,               -- upload|download
    src         TEXT NOT NULL,
    dst         TEXT NOT NULL,
    size        INTEGER NOT NULL DEFAULT 0,
    done        INTEGER NOT NULL DEFAULT 0,
    state       TEXT NOT NULL,               -- queued|running|paused|completed|failed|canceled|interrupted
    error       TEXT,
    priority    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE INDEX idx_transfers_state ON transfers(state, priority);
```

**为什么持久化队列**：`FIL-007` 要求「应用重启后未完成任务标记为已中断，可一键恢复」。这需要记录源、目标、已传字节。

**写入频率**：每 5 s 或每 8 MB 更新一次 `done`（不是每个块）。崩溃时最多丢 5 s 的进度，续传时通过「比较远端已有大小」重新对齐（`FIL-019`）。

### 2.7 工作区

```sql
CREATE TABLE workspaces (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    layout      TEXT NOT NULL,               -- JSON：标签、分屏、窗口几何
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
```

### 2.8 标签

```sql
CREATE TABLE tags (
    name  TEXT PRIMARY KEY,
    color TEXT
);

CREATE TABLE session_tags (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    tag        TEXT NOT NULL REFERENCES tags(name) ON DELETE CASCADE,
    PRIMARY KEY (session_id, tag)
);
```

### 2.9 插件状态

```sql
CREATE TABLE plugins (
    name                 TEXT PRIMARY KEY,
    version              TEXT NOT NULL,
    enabled              INTEGER NOT NULL DEFAULT 1,
    granted_permissions  TEXT NOT NULL DEFAULT '[]',
    installed_at         TEXT NOT NULL
);
```

## 3. 事务性保证

### 3.1 导入是单事务

```rust
pub fn import_sessions(&self, plan: ImportPlan) -> Result<ImportReport> {
    let mut tx = self.conn.transaction()?;     // BEGIN IMMEDIATE
    // 1. 插入全部 folders（按拓扑序，父先于子）
    // 2. 插入全部 sessions
    // 3. 插入 tunnels / tags
    // 4. 记录导入日志
    tx.commit()?;
    Ok(report)
}
```

`BEGIN IMMEDIATE` 而非 `BEGIN DEFERRED`：立即获取写锁，避免「读到一半发现要升级为写锁」导致的 `SQLITE_BUSY`。

**失败即回滚**：`spec/05` AC-4 要求「导入中途失败后重启，会话树为导入前状态」。事务天然满足。

### 3.2 并发策略

```rust
pub struct Store {
    writer: Mutex<Connection>,          // 单一写连接
    readers: r2d2::Pool<SqliteConnectionManager>,  // 读连接池
}
```

| 场景 | 连接 |
|---|---|
| 写（增删改） | `writer`（串行，避免 `SQLITE_BUSY`） |
| 读（列表、搜索） | `readers`（并发） |

**WAL 模式必须开启**：

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

`WAL` 让读不阻塞写、写不阻塞读；`synchronous=NORMAL` 在 WAL 下已足够安全（崩溃最多丢最后一个事务），性能远好于 `FULL`。

### 3.3 `rev` 字段的用途

`rev` 每次更新 +1。用于：

1. **乐观并发**：`UPDATE ... WHERE id=? AND rev=?`，影响行数为 0 则说明被别处改过。
2. **共享会话合并**（`SES-019`）：比较本地与共享文件的 `rev` 判断谁更新。
3. **未来同步**（`SES-023`）：变更集的基础。

## 4. 迁移

### 4.1 迁移文件

```
crates/wt-store/migrations/
├── 0001_init.sql
├── 0002_add_workspaces.sql
└── 0003_add_plugin_permissions.sql
```

```rust
const MIGRATIONS: &[(i64, &str, &str)] = &[
    (1, "init",                  include_str!("../migrations/0001_init.sql")),
    (2, "add_workspaces",        include_str!("../migrations/0002_add_workspaces.sql")),
    (3, "add_plugin_permissions",include_str!("../migrations/0003_add_plugin_permissions.sql")),
];

pub fn migrate(conn: &mut Connection) -> Result<()> {
    let current: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;

    // 降级保护（NFR-024）
    let max_known = MIGRATIONS.last().unwrap().0;
    if current > max_known {
        return Err(WtError::new("STORE_VERSION_TOO_NEW")
            .message(format!("数据版本 {current} 高于程序支持的 {max_known}，请升级 WindTerm"))
            .hint("下载最新版本", HintAction::OpenUrl(UPDATE_URL)));
    }

    for (v, name, sql) in MIGRATIONS.iter().filter(|(v, _, _)| *v > current) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.execute("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?1,?2,?3)",
                   (v, name, now_iso()))?;
        tx.pragma_update(None, "user_version", v)?;
        tx.commit()?;
        tracing::info!(version = v, name, "migration applied");
    }
    Ok(())
}
```

### 4.2 迁移前的自动备份

```rust
fn backup_before_migration(conn: &Connection, from: i64, to: i64) -> Result<PathBuf> {
    let dir = config_dir().join("backup").join(format!("{from}-to-{to}"));
    fs::create_dir_all(&dir)?;
    let dst = dir.join("data.db");
    conn.execute("VACUUM INTO ?1", [dst.to_str().unwrap()])?;   // 一致性快照，不阻塞
    Ok(dst)
}
```

`VACUUM INTO` 是 SQLite 3.27+ 的一致性快照方式，比复制文件安全（复制正在写入的 WAL 文件会得到不一致状态）。

### 4.3 迁移的硬规则

| 规则 | 原因 |
|---|---|
| 迁移只增不改 | 已发布的迁移文件永不修改（用户可能已执行过） |
| 每个迁移幂等或可重入 | 用 `IF NOT EXISTS`；失败可重跑 |
| 迁移在事务内 | 失败自动回滚 |
| 大表迁移要分批 | `UPDATE` 100 万行会锁表；用 `WHERE id > ?` 分批 |
| 迁移后校验 | `PRAGMA integrity_check` + 关键表计数 |

## 5. 配置（TOML）

### 5.1 Rust 模型

```rust
// crates/wt-config/src/model.rs
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub general: General,
    pub terminal: TerminalCfg,
    pub appearance: Appearance,
    pub files: FilesCfg,
    pub graphics: GraphicsCfg,
    pub network: NetworkCfg,
    pub security: SecurityCfg,
    pub advanced: AdvancedCfg,
}
```

**`deny_unknown_fields` 是刻意的**：用户手改 TOML 时打错字段名，应该报错而不是静默忽略。错误信息要指出「未知字段 `termnal`，是否想写 `terminal`？」（用 `strsim` 做近似匹配）。

### 5.2 分层解析

```rust
pub fn load_effective() -> Result<(Config, Vec<Source>)> {
    let mut cfg = Config::default();
    let mut sources = vec![];

    // 1. 系统级（企业下发）
    if let Some(p) = system_config_path() {
        if p.exists() { cfg = merge(cfg, Config::from_file(&p)?); sources.push(Source::System(p)); }
    }
    // 2. 用户级
    let up = user_config_path();
    if up.exists() { cfg = merge(cfg, Config::from_file(&up)?); sources.push(Source::User(up)); }
    // 3. 命令行覆盖（--dpi 等）
    cfg = apply_cli_overrides(cfg);

    Ok((cfg, sources))
}
```

**合并语义**：后加载的覆盖先加载的，但**只覆盖显式出现的字段**。这要求反序列化时能区分「字段缺失」与「字段等于默认值」——用 `Option<T>` 包装每个字段，或解析为 `toml::Value` 再逐键合并。

**选择**：解析为 `toml::Value` 做深合并，再反序列化为 `Config`。这样 `#[serde(default)]` 只用于最终填充默认值，不参与合并判断。

### 5.3 保存

```rust
pub fn save_user_config(cfg: &Config) -> Result<()> {
    let text = toml::to_string_pretty(cfg)?;
    // 保留用户注释：读原文件，按 key 路径替换值（toml_edit）
    let edited = toml_edit::DocumentMut::from_str(&fs::read_to_string(path).unwrap_or_default())?;
    apply_to_document(&mut edited, cfg)?;
    atomic_write(path, edited.to_string().as_bytes())?;
    Ok(())
}
```

**用 `toml_edit` 而不是 `toml::to_string`**：用户可能在 `config.toml` 里写了注释，直接序列化会全部丢失。这是「配置文件可手改」这个承诺的必要条件。

**写入去抖**：设置页连续修改（拖动滑块）时，500 ms 去抖后写一次。

### 5.4 原子写

```rust
pub fn atomic_write(path: &Path, data: &[u8]) -> io::Result<()> {
    let tmp = path.with_extension("tmp");
    {
        let mut f = File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;                       // 必须 fsync，否则断电后可能是空文件
    }
    fs::rename(&tmp, path)?;                 // 同分区 rename 是原子的
    // 目录 fsync（Unix 需要；Windows 上 rename 已足够）
    #[cfg(unix)] { File::open(path.parent().unwrap())?.sync_all()?; }
    Ok(())
}
```

**这个函数被用于**：`config.toml`、`vault.bin`、导出的会话文件、插件安装。**任何覆盖式写入都必须走它**——这是「磁盘满时不产生半个文件」的唯一保证。

## 6. 迁移器（MobaXterm 导入）

### 6.1 管线

```
读文件 → 检测格式 → 解析为中间表示（IR） → 校验 → 生成 ImportPlan → 事务写入
```

**中间表示（IR）** 是关键：不同来源（MobaXterm ini、ssh config、自有 JSON）都先转成 IR，再由同一个写入器落库。这样加一个新来源不需要改写入逻辑。

```rust
pub struct ImportPlan {
    pub folders: Vec<FolderDraft>,
    pub sessions: Vec<SessionDraft>,
    pub tunnels: Vec<TunnelDraft>,
    pub warnings: Vec<ImportWarning>,
    pub skipped: Vec<SkippedItem>,
}
```

### 6.2 MobaXterm ini 解析

**结构**（`spec/05` §5.2 已说明字段名需 M0 校准）：

```ini
[Bookmarks]
SubRep=
ImgNum=42

[Bookmarks_1]
SubRep=生产环境
ImgNum=41

[Bookmarks_2]
SubRep=生产环境\
BookmarkName=web-01
Host=10.0.1.11
Port=22
UserName=deploy
Protocol=...
```

**解析策略**

```rust
pub struct IniDoc {
    sections: BTreeMap<String, BTreeMap<String, String>>,
}

pub fn parse_mobaxterm(doc: &IniDoc) -> Result<ImportPlan> {
    // 1. 所有 [Bookmarks*] 段
    // 2. SubRep 表示层级：空 = 根；"A" = 一级文件夹 A；"A\" = 文件夹 A 本身（叶子容器）
    // 3. 有 BookmarkName 的是会话，否则是文件夹
    // 4. 按 SubRep 构建树
    ...
}
```

**`SubRep` 的语义是本项目的第一个真实风险点**：它既表示「所属文件夹」又用结尾反斜杠表示「这是文件夹定义本身」。这个语义必须用真实样本验证（M0/S6）。

**容错要求**

| 情况 | 处理 |
|---|---|
| 字段缺失（无 Host） | 跳过该会话，记入 `skipped` 并说明 |
| 未知 `Protocol` 值 | 跳过，记入 `skipped` |
| 未知字段 | 保留在 `options.extra` 中，不丢 |
| 重复 `BookmarkName` | 自动加后缀 `(2)`，记入 `warnings` |
| 编码非 UTF-8 | 尝试 GBK/GB18030 解码（MobaXterm 在中文 Windows 上可能写 GBK） |

### 6.3 凭据处理

**不做**「猜测解密」。流程（`spec/05` §5.4）：

1. 导入时把所有需要凭据的会话标记 `credential_ref = null` 且 `options.needsCredential = true`。
2. 导入完成后启动「凭据补录向导」：
   - 按 `(username, auth_method)` 分组；
   - 每组输入一次密码，批量套用到该组全部会话；
   - 逐组推进，可跳过。
3. 补录完成后清除 `needsCredential`。

**这是 `ADR-0010` 的核心**：用户要的不是「密码被导入」，而是「不用重记 41 个密码」。分组批量套用把成本从「41 次输入」降到「3~5 次输入」。

### 6.4 ssh config 解析

```rust
pub fn parse_ssh_config(text: &str) -> Result<ImportPlan> {
    // 支持的指令：
    //   Host, HostName, User, Port, IdentityFile, ProxyJump, ProxyCommand,
    //   ServerAliveInterval, Compression, LocalForward, RemoteForward, DynamicForward
//   ForwardX11 读到即忽略（X11 已移除，ADR-0012）
    // 忽略：Match 块（记录警告）
}
```

`ProxyJump a,b` → 生成 `jumpSessionId` 链（`SES-025`）。
`LocalForward` → 生成隧道（`NET-018`）。
`ProxyCommand` → 记录为备注 + 警告（我们不默认执行外部命令，需用户确认）。

## 7. 备份与恢复

| 时机 | 动作 |
|---|---|
| 迁移前 | `VACUUM INTO backup/<from>-to-<to>/data.db` |
| 版本升级前 | 复制 `data.db` 与 `vault.bin` 到 `backup/<version>/` |
| 每日首次启动 | 保留最近 7 天的 `data.db` 快照（`VACUUM INTO`，耗时 < 100 ms/10 MB） |
| 手动 | 设置页「立即备份」 |

**保留策略**：按版本 3 份 + 按日 7 份；总大小上限 200 MB，超出删除最旧。

**恢复**：设置页「从备份恢复」→ 列出可用备份 → 选择 → 确认（提示「将覆盖当前数据」）→ 关闭数据库连接 → 替换文件 → 重启应用。

**损坏检测**：启动时 `PRAGMA integrity_check`。失败时：
1. 尝试从最近备份恢复；
2. 若失败，把损坏文件重命名为 `data.db.corrupt-<ts>` 并以空库启动；
3. 明确告知用户「会话数据已损坏，已保留原文件供人工抢救」。

**绝不静默删除损坏文件**——那可能是用户唯一的数据。

## 8. 与需求的对应

| 设计点 | 需求 |
|---|---|
| `sessions.options` JSON | `SES-001`~`SES-011` 各类型字段 |
| `rev` + 乐观并发 | `SES-019` 共享会话、`SES-023` |
| 导入单事务 | `SES-020` AC-4 |
| 凭据补录向导 | `SES-020` AC-5、`ADR-0010` |
| 传输队列持久化 | `FIL-007` AC-2 |
| `listen_port=0` | `NET-001` AC-2 |
| 迁移 + 降级保护 | `NFR-024` |
| 自动备份 | `NFR-008` |
| `atomic_write` | `NFR-008` 磁盘满不产生半个文件 |
| `toml_edit` 保留注释 | `SET-006` 可手改 |
| 配置分层 | `SET-008` 共享配置、`SEC-009` 策略优先级 |
| FTP 会话字段 | `SES-008` |
| 会话上下文菜单 | `SES-014` |
| 导入导出 | `SES-015` |
| 文件夹批量启动 | `SES-017` |
| 会话搜索与标签 | `SES-018` |
| 快速连接 | `SES-021` |
