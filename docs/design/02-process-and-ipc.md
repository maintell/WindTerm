# 详细设计 · 02 · 进程模型与 IPC

实现需求：`NFR-001` `NFR-002` `NFR-003` `NFR-007` `SYS-005` `TER-034`
关键 ADR：ADR-0005（拉取式二进制通道）

## 1. 进程模型

### 1.1 进程拓扑

```
┌─────────────────────────────────────────────────────────────┐
│  WindTerm 主进程（Rust）                                      │
│  ├─ Tauri runtime                                           │
│  ├─ tokio 多线程运行时                                        │
│  ├─ 会话/隧道/传输任务                                        │
│  └─ IPC 端点（本机回环，不监听 TCP）                           │
└───────────────┬─────────────────────────────────────────────┘
                │ Tauri IPC（进程内 + WebView 通道）
   ┌────────────┴────────────┬──────────────────┐
   ▼                         ▼                  ▼
┌─────────────┐      ┌─────────────┐    ┌─────────────┐
│ WebView 进程 │      │ WebView 进程 │    │ 分离窗口     │
│ （主窗口）    │      │ （分离标签）  │    │ （TER-003） │
└─────────────┘      └─────────────┘    └─────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 外部进程（按需启动，独立生命周期）                             │
│  ├─ （原 X Server，已移除，见 ADR-0012）                     │
│  ├─ coreutils（wt-coreutils.exe，短生命周期）                 │
│  ├─ WindShell 子进程（每个本地终端一个）                       │
│  └─ 用户 shell（pwsh / bash / wsl）                          │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 为什么核心不在 WebView 里

WebView 进程会被 OS 在内存压力下回收（尤其 macOS 与移动端策略），而 SSH 连接不能因此断开。
把连接、缓冲、凭据放在 Rust 主进程，WebView 崩溃/重载后可以**无缝重连 UI**（会话不丢）。这是 `NFR-007` 的实现基础。

### 1.3 分离窗口（`TER-003`）

Tauri 2 支持创建多个 WebviewWindow。设计：

- 每个分离窗口是一个**独立的 WebView 实例**，但**共享同一个 Rust 核心**。
- 会话的「渲染归属」由一个 `render_owner` 字段记录（窗口 ID）。
- 分离时：把 `render_owner` 改为新窗口，旧窗口停止拉取，新窗口开始拉取。**终端缓冲在 Rust 侧，不受影响**。
- 因此分离/重附是无损的，不重建连接。

**约束**：一个会话同时只能有一个渲染归属（避免双份 ack 导致计数错乱）。若用户在新窗口打开同一会话，旧窗口显示「已在新窗口打开」。

## 2. 线程模型

### 2.1 tokio 运行时

```rust
// apps/wt-desktop/src/main.rs
let runtime = tokio::runtime::Builder::new_multi_thread()
    .worker_threads(num_cpus::get().clamp(2, 8))
    .thread_name("wt-worker")
    .enable_all()
    .build()?;
```

**为什么 clamp 到 8**：50 个会话不等于 50 个线程。会话读循环是 IO 密集型（大部分时间在 `await`），少量 worker 足够；线程过多反而增加上下文切换。CPU 密集型任务（RDP 解码、加密）走独立线程池。

### 2.2 线程/任务分类

| 类别 | 位置 | 说明 |
|---|---|---|
| 会话读循环 | tokio task（每会话 1 个） | 读 socket → 解密 → 写入环形缓冲 |
| 会话写路径 | tokio task（每会话 1 个，或用 mpsc 合并） | 从 UI 队列取数据 → 加密 → 写 socket |
| RDP 解码 | 专用 `std::thread`（每会话 1 个） | 解码是 CPU 密集且同步的，不能占 tokio worker |
| RDP 网络 | tokio task | |
| SFTP 传输 | tokio task（受信号量限流） | 并发由 `Semaphore(N)` 控制 |
| 文件 IO（大文件） | `spawn_blocking` | 避免阻塞 reactor |
| SQLite | `spawn_blocking` + 单写连接 | `rusqlite` 是同步 API |
| 配置保存 | 去抖后 `spawn_blocking` | |
| 日志写入 | 独立线程（`tracing-appender`） | |
| 插件 WASM | 专用线程池（每实例 1 线程） | 超时可控 |

### 2.3 panic 隔离

```rust
// 每个会话一个 task，panic 被捕获并上报
let handle = tokio::spawn(async move {
    session_loop(ctx).await
});

tokio::spawn(async move {
    match handle.await {
        Ok(()) => { /* 正常结束 */ }
        Err(e) if e.is_panic() => {
            tracing::error!(session_id, "session task panicked");
            events.emit(SessionEvent::Crashed { session_id, reason: "internal" });
            // 清理资源，标记会话为断开，不重启（避免 panic 循环）
        }
        Err(e) => { /* canceled */ }
    }
});
```

**注意**：`tokio::spawn` 的 panic 不会传播到父任务，但会打印到 stderr。必须显式处理 `JoinError::is_panic()`，否则用户只会看到「会话莫名其妙断了」。

**发布构建不使用 `panic = "abort"`**（见 `design/01` §2.1）。

## 3. IPC 三层

### 3.1 分层职责

| 层 | 方向 | 传输 | 用途 | 频率 |
|---|---|---|---|---|
| **Command** | UI → Core → UI | JSON（请求/响应） | 动作与查询 | 低（用户操作级） |
| **Event** | Core → UI | JSON（推送） | 状态变更通知 | 中（需节流） |
| **Pull** | UI → Core | **二进制**（响应体） | 终端/RDP 数据 | 高（每帧） |

**为什么不是两层（command + event）**：终端的「推送」模式无法自然背压——核心不知道前端能不能处理。改成「前端主动拉」，背压变成结构性的，不需要额外限流代码。

**为什么不是三层全用 event**：事件是广播的，多个窗口/多个订阅者会重复投递；拉取天然是单消费者，与「一个会话一个渲染归属」的模型一致。

### 3.2 Command 定义规范

```rust
// crates/wt-ipc/src/commands.rs
#[derive(Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Command {
    SessionList,
    SessionGet { id: SessionId },
    SessionCreate { draft: SessionDraft },
    SessionUpdate { id: SessionId, patch: SessionPatch },
    SessionDelete { ids: Vec<SessionId> },
    Connect { id: SessionId, options: ConnectOptions },
    Disconnect { handle: SessionHandle },
    TermWrite { handle: SessionHandle, data: String },   // 输入是 UTF-8 文本或转义序列
    TermResize { handle: SessionHandle, cols: u16, rows: u16 },
    // ...
}
```

**统一入口 vs 每命令一个函数**

| 方案 | 优点 | 缺点 |
|---|---|---|
| 每命令一个 `#[tauri::command]` | 类型安全、IDE 友好 | 命令数 > 100 时样板代码爆炸 |
| 统一 `dispatch(Command)` | 一处鉴权/日志/指标 | 需要手写 enum 与 TS 类型同步 |

**选择**：混合。
- **高频/大参数**命令用独立 `#[tauri::command]`（`term_read`、`term_ack`、`rdp_frame`、`term_write`）。
- **其余**走统一 `dispatch`，用一个 `#[tauri::command] fn dispatch(cmd: Command) -> Result<Value, WtError>`。

**TS 类型同步**：用 `ts-rs` 从 Rust 类型生成 `.d.ts`，CI 校验生成结果与提交的一致（防止前后端漂移）。

### 3.3 Event 定义与节流

```rust
#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AppEvent {
    SessionState { handle: SessionHandle, state: SessionState },
    SessionTitle { handle: SessionHandle, title: String },
    SessionActivity { handle: SessionHandle, has_output: bool },
    TransferProgress { id: TransferId, done: u64, total: u64, speed: u64 },
    TransferState { id: TransferId, state: TransferState, error: Option<String> },
    TunnelState { id: TunnelId, state: TunnelState, stats: TunnelStats },
    Toast { level: ToastLevel, message: String, actions: Vec<Action> },
    // ...
}
```

**节流规则（强制）**

| 事件 | 最小间隔 | 合并策略 |
|---|---|---|
| `TransferProgress` | 500 ms | 同一传输只保留最新值 |
| `TunnelState`/`TunnelStats` | 1000 ms | 按隧道合并 |
| `SessionActivity` | 200 ms | 布尔值去重（只在 false→true 时发） |
| `SessionTitle` | 300 ms | 去重 |
| `Toast` | 不限 | 相同文案 5 s 内去重 |

**为什么必须节流**：1000 个小文件传输若不节流，会产生数万条事件，前端 `JSON.parse` + 响应式更新会直接卡死。这是「看起来能跑、实际不可用」的典型陷阱。

### 3.4 Pull 通道

#### 终端

```rust
#[tauri::command]
async fn term_read(
    state: State<'_, AppState>,
    handle: SessionHandle,
    max_bytes: usize,
) -> Result<tauri::ipc::Response, WtError> {
    let buf = state.sessions.read_term(handle, max_bytes.min(64 * 1024)).await?;
    Ok(tauri::ipc::Response::new(buf))   // 原始字节，无 base64
}

#[tauri::command]
async fn term_ack(
    state: State<'_, AppState>,
    handle: SessionHandle,
    n: usize,
) -> Result<(), WtError> {
    state.sessions.ack(handle, n).await
}
```

```ts
// ui/src/core/terminal-pump.ts
async function pump(handle: string) {
  while (running) {
    const buf = await invoke<ArrayBuffer>('term_read', { handle, maxBytes: 65536 });
    if (buf.byteLength === 0) {
      await nextFrame();          // 无数据，等下一帧
      continue;
    }
    term.write(new Uint8Array(buf));   // xterm.js 内部有写队列
    await invoke('term_ack', { handle, n: buf.byteLength });
  }
}
```

**关键细节**

| 细节 | 原因 |
|---|---|
| `maxBytes` 上限 64 KB | 单次 IPC 过大反而增加延迟；64 KB 在千兆下约 0.5 ms |
| 空结果时 `await nextFrame()` | 避免忙轮询烧 CPU |
| `term.write` 后立即 `ack` | xterm.js 的 `write` 有内部队列，`ack` 表示「已接收」，不是「已渲染」 |
| 渲染节流在 xterm 内部 | xterm.js 自带 rAF 批处理，不需要我们再控 |

**背压由谁实现**：`ack` 减少未确认计数；`term_read` 在未确认 > 高水位时返回空（或更少数据）；读循环在未确认 > 高水位时暂停读 socket。详见 §5。

#### RDP

```rust
#[derive(Serialize)]
struct FrameMeta {
    seq: u64,
    width: u32,
    height: u32,
    rects: Vec<Rect>,     // 脏矩形
}

// 先取元数据（JSON），再取像素（二进制）
#[tauri::command] async fn rdp_frame_meta(handle) -> Result<Option<FrameMeta>, WtError>;
#[tauri::command] async fn rdp_frame_data(handle, seq: u64) -> Result<tauri::ipc::Response, WtError>;
```

**为什么拆两步**：脏矩形是结构化的（JSON 方便），像素是二进制。混在一起要么牺牲 JSON 可读性，要么牺牲二进制效率。两步的额外开销是一次 IPC（约 0.3 ms），可接受。

**优化**：若脏区覆盖 > 60% 画面，直接传整帧（省掉多次 `putImageData` 的调用开销）。

## 4. 命令清单（按域）

> 完整清单在 `crates/wt-ipc/src/commands.rs`。此处列出各域的核心命令与频率，用于评估 IPC 负载。

| 域 | 命令 | 频率 |
|---|---|---|
| 应用 | `app_info` `app_quit` `app_open_window` `app_focus` | 极低 |
| 会话 | `session_list` `session_get` `session_create` `session_update` `session_delete` `session_move` `session_search` | 低 |
| 连接 | `connect` `disconnect` `reconnect` `connection_diagnose` | 低 |
| 终端 | `term_read`(pull) `term_ack`(pull) `term_write` `term_resize` `term_search` `term_select_text` `term_export` | **高**（read/ack 每帧） |
| 文件 | `files_list` `files_stat` `files_mkdir` `files_rename` `files_delete` `files_chmod` `transfer_start` `transfer_pause` `transfer_cancel` `transfer_list` | 中 |
| 图形 | `rdp_frame_meta`(pull) `rdp_frame_data`(pull) `rdp_input` `vnc_frame_*` | **高**（RDP 帧） |
| 隧道 | `tunnel_list` `tunnel_create` `tunnel_start` `tunnel_stop` `tunnel_stats` | 低 |
| 凭据 | `vault_status` `vault_unlock` `vault_lock` `vault_list` `vault_add` `vault_delete` `vault_export` | 低 |
| 配置 | `config_get` `config_set` `config_reset` `config_export` `config_import` | 低 |
| 插件 | `pkg_search` `pkg_install` `pkg_remove` `pkg_list` | 低 |
| 诊断 | `diag_run` `diag_bundle` `bench_run` | 低 |

**IPC 负载估算**（最坏情况）

| 场景 | 每秒 IPC 次数 |
|---|---|
| 1 个终端满速输出 | 60 × 2（read + ack）= 120 |
| 4 个终端满速输出 | 480 |
| 1 个 RDP 30 fps | 30 × 2 = 60 |
| 传输进度（10 个） | 20 |

峰值约 600 次/s。Tauri 的 IPC 在此量级可承受（M0/S1 需实测确认）。

## 5. 背压设计

### 5.1 三层缓冲

```
socket 内核缓冲（~256 KB）
        │
        ▼
Rust 环形缓冲（每会话，上限 4 MB）      ← 未确认计数在这里统计
        │
        ▼
IPC 传输（单次 ≤ 64 KB）
        │
        ▼
xterm.js 写队列（内部，默认 ~50 MB 上限）
        │
        ▼
渲染（每帧 ≤ 8 ms）
```

### 5.2 参数

| 参数 | 值 | 依据 |
|---|---|---|
| `HIGH_WATER` | 2 MB | 约 0.1 s 的 20 MB/s 输出；超过说明前端跟不上 |
| `LOW_WATER` | 512 KB | 恢复阈值，避免在临界点反复启停（滞回） |
| `MAX_CHUNK` | 64 KB | IPC 单次上限 |
| `RING_CAPACITY` | 4 MB | 环形缓冲上限；溢出时丢弃并计数 |
| `RENDER_BUDGET` | 8 ms/帧 | 保证 60 fps 有余量 |

### 5.3 状态机

```
        未确认 < HIGH_WATER                未确认 ≥ HIGH_WATER
  ┌──────────────────────┐          ┌──────────────────────┐
  │      正常读取         │ ───────► │      暂停读取         │
  │  （继续从 socket 读）  │          │ （不 ACK SSH 窗口）   │
  └──────────────────────┘ ◄─────── └──────────────────────┘
        未确认 ≤ LOW_WATER                 （等待 ack 降低）
```

**「暂停读取」对 SSH 意味着什么**：不向服务端发送 `SSH_MSG_CHANNEL_WINDOW_ADJUST`。服务端的发送窗口耗尽后自然停止发送——这是 SSH 协议自带的流控，不需要我们丢弃数据。**这是「不丢字节」的关键**：压力传导到服务端，而不是在我们这里丢。

对 PTY（本地终端）意味着：停止 `read()`，PTY 内核缓冲（默认 64 KB）满后子进程的 `write()` 阻塞——同样传导到源头。

### 5.4 溢出的唯一场景

环形缓冲 4 MB 也满了（例如前端完全卡死 5 分钟）。此时：

1. 丢弃最旧数据（保新不保旧），
2. 在流中插入一条标记：`\r\n[WindTerm] 输出过快，已丢弃 N 行\r\n`，
3. 上报 `TERM_OVERFLOW` 警告（Toast + 日志）。

**为什么保新不保旧**：运维看日志时最新的是最重要的；丢旧的损失最小。

## 6. IPC 安全边界

### 6.1 边界规则

| 规则 | 原因 |
|---|---|
| 所有命令参数必须校验（长度、范围、ID 存在性） | WebView 内容可能被 XSS 注入（远端终端输出 → DOM 渲染） |
| 文件路径必须规范化后校验在允许范围内 | 防路径穿越 |
| 不接受来自前端的任意 SQL | 前端只传结构化参数 |
| 不接受来自前端的任意 shell 命令 | `ProxyCommand` 等必须走显式授权流程 |
| 会话 ID 使用不可猜测的 UUID，不用自增整数 | 防止前端构造越权 ID |

### 6.2 XSS 防线（这是真实的攻击面）

终端输出可以被远端完全控制。如果前端把终端内容当 HTML 渲染，远端就能执行任意 JS → 调用我们的 IPC → 读取保险库。

**防线**

1. 终端渲染走 canvas，**不生成 DOM 节点**（xterm.js 的 canvas 渲染器）。
2. 所有 UI 文本通过 `textContent` 设置，禁止 `innerHTML`（ESLint 规则 `no-unsanitized`）。
3. 链接点击必须二次确认（`TER-021`）。
4. `windterm://` 协议链接必须确认（`SYS-003`）。
5. CSP 严格：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:`。

**验证**：E2E 用例中故意让远端输出 `<img src=x onerror="...">` 与 `\e]8;;javascript:alert(1)\e\\x\e]8;;\e\\`，断言无脚本执行。

## 7. CLI 与 UI 共享核心

```rust
// crates/wt-core/src/app.rs  —— 不依赖 Tauri
pub struct AppCore {
    sessions: SessionManager,
    tunnels: TunnelManager,
    transfers: TransferManager,
    vault: Arc<Vault>,
    store: Arc<Store>,
    config: Arc<RwLock<Config>>,
}

impl AppCore {
    pub async fn connect(&self, id: SessionId, opts: ConnectOptions) -> Result<SessionHandle>;
    pub async fn exec(&self, handle: SessionHandle, cmd: &str) -> Result<ExecResult>;
    // ...
}
```

- `wt-desktop` 把 `AppCore` 包进 Tauri `State`。
- `wt-cli` 直接构造 `AppCore`，无 UI 依赖。

**收益**：CLI 的每条命令都是对同一套逻辑的调用，不存在「UI 能做的事 CLI 做不到」；同时 CLI 成为 E2E 测试的驱动器（`design/15` §5）。

**约束**：`AppCore` 不能依赖任何 `tauri::` 类型。UI 特有的关注点（窗口、事件推送）通过 `EventSink` trait 注入：

```rust
pub trait EventSink: Send + Sync {
    fn emit(&self, event: AppEvent);
}
// Tauri 实现：转发到 app_handle.emit
// CLI 实现：打印到 stderr 或 JSON 行
```

## 8. 单实例与参数转交（`SYS-005`）

```
启动
 ├─ 尝试获取实例锁（命名管道 / Unix socket / 文件锁）
 │   ├─ 成功 → 成为主实例，启动 UI
 │   └─ 失败 → 读取已有实例的端点，发送 argv（含 cwd），退出码 0
 └─ --new-instance → 跳过锁，直接启动
```

**端点位置**

| 平台 | 机制 |
|---|---|
| Windows | 命名管道 `\\.\pipe\windterm-<user-sid-hash>` |
| macOS/Linux | Unix socket `$XDG_RUNTIME_DIR/windterm-<uid>.sock`（权限 0600） |

**安全**：端点名包含用户 SID/UID 的哈希，避免多用户冲突；socket 权限 0600 防止其他用户注入命令。

**转交内容**：`argv`、`cwd`、`--config-dir`（必须一致，否则拒绝转交并提示）。

## 9. 与需求的对应

| 设计点 | 需求 |
|---|---|
| 核心在 Rust 主进程 | `NFR-007` 崩溃恢复 |
| 每会话 task + panic 隔离 | `NFR-007` |
| 分离窗口共享核心 | `TER-003` |
| 拉取式二进制 IPC | `NFR-003` `TER-034` |
| 三层缓冲与水位 | `NFR-002` `NFR-003` |
| 事件节流 | `FIL-007` `NET-006` |
| XSS 防线 | `SEC-*`（凭据保护） |
| `AppCore` 共享 | `LOC-023` CLI 全覆盖 |
| 单实例与端点安全 | `SYS-005` |
