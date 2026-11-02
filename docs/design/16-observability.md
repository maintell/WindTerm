# 详细设计 · 16 · 可观测性与诊断

实现需求：`NFR-020` `NFR-021`、`SES-028`、`SEC-010`
关键约束：`SEC-015`（无遥测、默认离线）

## 1. 三条原则

| 原则 | 含义 |
|---|---|
| **本地优先** | 所有日志、指标、诊断都落在本机；默认不外发任何数据 |
| **脱敏在写入时** | 不是在展示时。日志文件里绝不能出现密码 |
| **诊断包由用户主动导出** | 崩溃不自动上报；用户点「导出诊断包」才生成文件 |

## 2. 日志

### 2.1 结构化格式

```json
{"ts":"2026-11-02T10:32:15.123Z","level":"INFO","target":"wt_ssh::connect",
 "span":{"session":"prod-web-01","handle":"h-7f3a"},
 "msg":"ssh handshake complete",
 "fields":{"kex":"curve25519-sha256","hostkey":"ssh-ed25519","duration_ms":42}}
```

| 字段 | 说明 |
|---|---|
| `ts` | ISO 8601，毫秒精度，UTC |
| `level` | `ERROR`/`WARN`/`INFO`/`DEBUG`/`TRACE` |
| `target` | Rust 模块路径 |
| `span` | 当前 span 的关键字段（会话、隧道、传输 ID） |
| `msg` | 稳定的英文消息（不翻译，便于搜索） |
| `fields` | 结构化附加字段 |

**`msg` 用英文的原因**：日志是给开发者与搜索用的，不面向终端用户。用户看到的是 UI 上的本地化错误消息。

### 2.2 级别与默认值

| 级别 | 默认 | 内容 |
|---|---|---|
| `ERROR` | ✅ | 需要用户干预的失败 |
| `WARN` | ✅ | 自动恢复的问题（重连、降级） |
| `INFO` | ✅ | 生命周期事件（连接、断开、迁移、安装） |
| `DEBUG` | ❌ | 协议细节、状态转换 |
| `TRACE` | ❌ | 字节级（仅在排查时短暂开启） |

**运行时切换**：设置页可改级别，立即生效（`tracing_subscriber` 的 `reload` layer）。

**性能约束**：`TRACE` 下 20 MB/s 终端数据会产生海量日志。终端字节流**永远不记 TRACE**，只记「收到 N 字节」。

### 2.3 脱敏

```rust
pub struct Redactor {
    secrets: Vec<String>,      // 从保险库解锁时登记的明文（用 ProtectedBytes 持有）
}

impl Redactor {
    pub fn redact(&self, s: &str) -> Cow<'_, str> {
        let mut out = Cow::Borrowed(s);
        for secret in &self.secrets {
            if out.contains(secret.as_str()) {
                out = Cow::Owned(out.replace(secret.as_str(), "***"));
            }
        }
        out
    }
}
```

**三层防护**

| 层 | 做法 |
|---|---|
| 类型层 | 密码用 `SecretString` 类型，`Debug`/`Display` 实现为 `***` |
| 字段层 | 日志宏用 `%redacted` 而非 `%password` |
| 输出层 | `Redactor` 作为 `tracing` 的 layer，对最终字符串做替换 |

**为什么三层都要**：类型层防「不小心 `{:?}` 打印」；字段层防「显式记录」；输出层兜底「通过 `anyhow` 的错误链泄漏」。

**测试**：`tests/redaction.rs` 里让密码流经每条日志路径，断言输出中不含原文。

### 2.4 轮转

```rust
let appender = tracing_appender::rolling::Builder::new()
    .rotation(Rotation::DAILY)
    .max_log_files(5)
    .filename_prefix("windterm")
    .filename_suffix("log")
    .build(log_dir)?;
```

单文件上限 10 MB（`tracing_appender` 不直接支持按大小，用自定义 `MakeWriter` 在超限时切换文件）。

## 3. 审计日志

与主日志**分离**（`SEC-010`）：主日志可能被用户清空或降级，审计不能。

```rust
pub struct AuditWriter {
    file: BufWriter<File>,       // audit/YYYY-MM.jsonl
    path: PathBuf,
}
```

**事件清单**

| 事件 | 字段 |
|---|---|
| `connect` | sessionId, name, host, port, user, via, result, durationMs |
| `auth.fail` | sessionId, method, reason, attempts |
| `disconnect` | sessionId, reason |
| `tunnel.start` / `tunnel.stop` | tunnelId, type, listen, target |
| `vault.unlock` / `vault.lock` | reason（idle / manual / system） |
| `vault.access` | entryId, action, purpose |
| `policy.deny` | rule, action |
| `plugin.install` / `plugin.remove` | name, version, publisher, sigValid |
| `config.change` | key, oldHash, newHash（不记值） |
| `session.import` | source, count, skipped |

**不记录**：密码、私钥、终端内容、命令内容（可配置开启，默认关闭）。

**保留**：90 天（可配），按月滚动。

## 4. 连接诊断（`SES-028`）

### 4.1 数据模型

```rust
pub struct ConnectDiagnostics {
    pub target: String,
    pub stages: Vec<Stage>,
    pub total: Duration,
    pub outcome: Outcome,
}

pub struct Stage {
    pub name: StageName,
    pub ok: bool,
    pub duration: Duration,
    pub detail: String,
    pub error: Option<StageError>,
}

pub enum StageName {
    ConfigParse, DnsResolve, ProxyJump, TcpConnect,
    BannerExchange, KeyExchange, HostKeyVerify, Authenticate,
    ChannelOpen, SftpInit,
}
```

### 4.2 采集

```rust
impl Diagnostics {
    pub fn stage<T>(&self, name: StageName, f: impl FnOnce() -> Result<T, WtError>) -> Result<T, WtError> {
        let t = Instant::now();
        let r = f();
        self.push(Stage {
            name,
            ok: r.is_ok(),
            duration: t.elapsed(),
            detail: r.as_ref().map(|_| String::new()).unwrap_or_default(),
            error: r.as_ref().err().map(StageError::from),
        });
        r
    }
}
```

**异步版本**同理，用 `async fn` 包裹。

### 4.3 展示

```
① 配置解析        ✓ 0 ms
② DNS 解析        ✓ 12 ms   10.0.1.11 → 10.0.1.11（IP 直连）
③ 代理/跳板        ✓ 340 ms  经 bastion(10.0.0.5:22)，已复用连接
④ TCP 连接        ✓ 8 ms    10.0.1.11:22
⑤ SSH 版本交换     ✓ 15 ms   SSH-2.0-OpenSSH_8.0
⑥ 密钥交换        ✓ 42 ms    curve25519-sha256
⑦ 主机密钥校验     ✓ 1 ms     ssh-ed25519 SHA256:xxxx（已知主机）
⑧ 用户认证        ✓ 120 ms   publickey(ed25519)
⑨ 通道建立        ✓ 30 ms    session + sftp
────────────────────────────────
总计 568 ms
```

**失败时**：失败层红色高亮，展开显示 `error.detail` 与 `hints`（可点击动作）。

**可复制**：一键复制为纯文本（贴给同事/工单）。

### 4.4 主动诊断

```bash
wt diag <session> --json
```

只做握手（不建终端），产出 `ConnectDiagnostics`。用于：
- 用户在连不上时先自查；
- 脚本化巡检（批量测连通性）；
- E2E 测试断言每一层的耗时。

## 5. 网络活动面板（`SEC-015`）

```rust
pub struct NetworkActivity {
    pub entries: Vec<NetEntry>,
}

pub struct NetEntry {
    pub since: Instant,
    pub kind: NetKind,          // Session | Tunnel | Update | PluginRepo | ShareFetch
    pub target: String,         // host:port
    pub bytes_up: u64,
    pub bytes_down: u64,
    pub owner: String,          // 会话名 / 隧道名 / "auto-update"
}
```

**用途**：让用户能自己核对「这个程序到底往外连了什么」。这是「无遥测」承诺的可验证形式——不是让你信我，而是给你看。

**实现**：所有出站连接必须经过一个 `NetworkGate`：

```rust
pub struct NetworkGate {
    activity: Arc<Mutex<NetworkActivity>>,
    offline_mode: AtomicBool,
    allowed: Arc<dyn AllowList>,
}

impl NetworkGate {
    pub async fn connect(&self, kind: NetKind, owner: &str, host: &str, port: u16)
        -> Result<TcpStream, WtError>
    {
        if self.offline_mode.load(Ordering::Relaxed) && !matches!(kind, NetKind::Session) {
            return Err(WtError::new("NET_OFFLINE_MODE")
                .message("离线模式已开启，已阻止该连接")
                .detail(format!("{kind:?} → {host}:{port}")));
        }
        self.activity.lock().unwrap().add(kind, owner, host, port);
        TcpStream::connect((host, port)).await.map_err(Into::into)
    }
}
```

**所有连接必须走它**：这条是架构约束（`design/01` §3.1 的「收口」）。CI 检查：除 `wt-common::net` 外，任何 crate 不得直接调 `TcpStream::connect`。

## 6. 性能面板（`NFR-021`）

`Ctrl+Shift+Alt+P` 打开：

```
┌──────────────────────────────────────────────┐
│ 性能                                          │
├──────────────────────────────────────────────┤
│ 帧率            58 fps                        │
│ IPC 往返        P50 0.6 ms / P95 1.4 ms       │
│ 终端吞吐        prod-web-01: 3.2 MB/s         │
│ 未确认字节      412 KB / 2 MB                 │
│ 内存（RSS）     118 MB                        │
│ 会话数          7（SSH 6 / RDP 1）            │
│ 传输            2 个进行中，合计 12 MB/s       │
│ 事件/秒         84                            │
├──────────────────────────────────────────────┤
│ [ 复制为文本 ]  [ 开始记录 30 秒 ]             │
└──────────────────────────────────────────────┘
```

**「开始记录 30 秒」**：采集 30 秒的采样数据（每 100 ms 一次），导出为 CSV，用于分析「卡顿发生在什么时候」。

## 7. 诊断包

```bash
wt diag bundle --out ~/Desktop/windterm-diag-20261102.zip
```

**内容**

```
windterm-diag-20261102/
├── meta.json            版本、OS、构建哈希、运行时长
├── sysinfo.json         硬件、OS 版本、WebView 版本、字体列表
├── config.toml          脱敏后（凭据引用替换为 <redacted>）
├── sessions.json        会话结构（不含凭据）
├── known_hosts.hash     只有主机名的哈希（不含密钥）
├── logs/                最近 2 个日志文件
├── audit/               最近 1 个审计文件（不含敏感字段）
├── diagnostics/         最近 10 次连接诊断
└── perf/                最近一次性能采样
```

**明确不含**

| 不含 | 原因 |
|---|---|
| 密码、私钥、TOTP 种子 | 即使加密也不该外流 |
| 终端内容与命令历史 | 可能含业务数据 |
| 完整的 `known_hosts` | 暴露内网主机名 |
| 保险库文件 | 不必要 |

**导出前预览**：显示将包含的文件清单与大小，让用户确认。

## 8. 崩溃处理

```rust
fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // 1. 写一条 ERROR 日志（含 panic 位置与 payload）
        tracing::error!(target: "panic", "{}", info);
        // 2. 记录会话快照（供重启后恢复）
        snapshot_running_sessions();
        // 3. 调用默认 hook（打印到 stderr）
        default(info);
        // 4. 不上报、不弹窗（由上层 UI 统一处理）
    }));
}
```

**崩溃后重启**：检测到上次非正常退出 → 提示恢复会话（`SYS-006`）。

**minidump**：默认关闭。开启时用 `minidump-writer` 生成，只存本地，路径显示给用户。

## 9. 指标（本地）

不需要 Prometheus，但需要能回答「最近有没有变慢」。

```rust
pub struct LocalMetrics {
    pub startup_ms: RingBuffer<u32, 30>,
    pub ipc_roundtrip_us: RingBuffer<u32, 1000>,
    pub frame_fps: RingBuffer<u8, 300>,
    pub session_count: AtomicU32,
    pub event_per_sec: AtomicU32,
    pub rss_mb: AtomicU32,
}
```

**用途**：性能面板展示；`wt bench` 读取；「关于」页显示「运行统计」（用户可看自己的数据，但不上报）。

## 10. 与需求的对应

| 设计点 | 需求 |
|---|---|
| 结构化日志 + 脱敏 | `NFR-020` |
| 三层脱敏 | `SEC-002`、`NFR-010` |
| 审计日志分离 | `SEC-010` |
| 连接诊断九层 | `SES-028` |
| `wt diag` | `SES-028`、CLI 可脚本化 |
| 网络活动面板 | `SEC-015` |
| `NetworkGate` 收口 | 架构约束 |
| 性能面板 | `NFR-021` |
| 诊断包 | `NFR-020` |
| 崩溃快照 | `SYS-006` |
