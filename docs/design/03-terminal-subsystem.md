# 详细设计 · 03 · 终端子系统

实现需求：`TER-001`~`TER-035`
关键 ADR：ADR-0004（终端内核用 xterm.js）

## 1. 一个必须先讲清的分工问题

终端子系统最容易设计错的地方是：**VT 解析到底放在哪一侧？**

三个候选：

| 方案 | 解析位置 | 优点 | 缺点 |
|---|---|---|---|
| A | 全在前端（xterm.js） | 零重复、conformance 成熟、实现量最小 | Rust 侧拿不到屏幕内容（搜索、日志、跟随路径都要额外通路） |
| B | 全在 Rust（vte + 自研网格） | 单一真相、可服务端搜索、可多订阅者 | 需要自研渲染器与完整 VT 实现，6~12 人月，且 vttest 全绿遥遥无期 |
| C | 两侧都解析 | 各取所需 | **状态双份，必然不同步**（典型 bug：前端显示正常、日志记录错位） |

**决策：v1 采用 A，但把「Rust 需要的东西」用最小代价补齐。**

具体地，Rust 侧**不做 VT 网格**，只做三件事：

1. **字节级传输**（环形缓冲、背压、日志原始流）；
2. **ANSI 剥离**（用于纯文本日志——这是一个无状态的行过滤器，不需要网格）；
3. **从控制序列里抽取少量元信息**（标题、`OSC 7` 工作目录）——用一个 ~300 行的「控制序列嗅探器」，它只识别 `ESC ]` / `ESC [` 的结构，不理解光标与字符宽度。

其余（渲染、搜索、选择、输入编码、剪贴板、高亮）全部在前端。

**为什么这样切是对的**：

- 搜索：xterm.js 的 `buffer.active.getLine(i).translateToString()` 已经是 O(1) 取行，前端做比 IPC 往返快得多；
- 输入编码：需要 `DECCKM`（应用光标键）、`bracketed paste` 等模式位，这些状态在前端本来就是权威的；若放 Rust 就要把每次模式变化同步过去，反而多一层；
- 日志：原始流不需要解析；纯文本日志只需剥离转义序列（`design/03` §8）。

**代价与缓解**：若将来需要「服务端搜索」「会话录制回放」「多客户端共享终端」，就必须有 Rust 侧网格。为此保留 `wt-term::GridModel` 的空实现与 `TerminalBackend` trait 定义，v2 可切换。这个决定记录在 ADR-0004。

## 2. 组件结构

```
┌──────────────────────────── WebView ────────────────────────────┐
│                                                                  │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────┐     │
│  │ InputEncoder │   │  XtermView   │   │  Decorator       │     │
│  │ 键→字节       │   │  xterm.js    │   │  语法高亮         │     │
│  └──────┬───────┘   └──────┬───────┘   └────────┬─────────┘     │
│         │                  │                     │               │
│         │ term_write       │ term_read/ack       │ 读 buffer 行   │
└─────────┼──────────────────┼─────────────────────┼───────────────┘
          ▼                  ▼                     │
┌──────────────────────── Rust 核心 ───────────────┼───────────────┐
│                                                  │               │
│  ┌────────────────┐   ┌──────────────────┐      │               │
│  │ TermSession    │   │  RingBuffer      │      │               │
│  │ ├ write_queue  │   │  4 MB / 会话      │      │               │
│  │ ├ read_loop    │──►│  未确认计数        │      │               │
│  │ └ ctrl_sniffer │   └────────┬─────────┘      │               │
│  └───────┬────────┘            │                 │               │
│          │                     ▼                 │               │
│          │            ┌──────────────────┐      │               │
│          │            │  LogSink         │      │               │
│          │            │  raw / ansi / plain │   │               │
│          │            └──────────────────┘      │               │
│          ▼                                       │               │
│  ┌────────────────┐   ┌──────────────────┐      │               │
│  │ PtyTransport   │   │  MacroRecorder   │◄─────┘ 事件            │
│  │ SshTransport   │   │  （记录输入序列）  │                      │
│  └────────────────┘   └──────────────────┘                      │
└──────────────────────────────────────────────────────────────────┘
```

## 3. 传输抽象

```rust
// crates/wt-term/src/transport.rs
#[async_trait]
pub trait TermTransport: Send + Sync {
    /// 从远端/PTY 读一批数据
    async fn read(&mut self, buf: &mut [u8]) -> Result<usize, WtError>;

    /// 写入（用户输入）
    async fn write(&mut self, data: &[u8]) -> Result<(), WtError>;

    /// 窗口尺寸变化
    async fn resize(&mut self, cols: u16, rows: u16) -> Result<(), WtError>;

    /// 流控：恢复读取（SSH 场景下发 WINDOW_ADJUST）
    async fn resume_read(&mut self) -> Result<(), WtError>;

    /// 是否已断开
    fn is_closed(&self) -> bool;

    async fn close(&mut self) -> Result<(), WtError>;
}
```

**实现**

| 实现 | 用于 | 说明 |
|---|---|---|
| `PtyTransport` | 本地终端（`LOC-001`）、WindShell | `portable-pty` crate |
| `SshTransport` | SSH 会话 | 包装 `wt-ssh` 的 channel |
| `SerialTransport` | 串口（`SES-011`） | `serialport` crate |
| `TelnetTransport` | Telnet（`SES-002`） | 选项协商在 `wt-ssh` 之外单独实现 |
| `MoshTransport` | Mosh（`SES-010`） | UDP + SSP |
| `NullTransport` | 测试 | 内存管道 |

**关键点**：`TermSession` 不知道底层是什么，所有会话类型共用同一套缓冲/背压/日志逻辑。这是 `SES-002/010/011` 能低成本实现的原因。

## 4. 环形缓冲与背压

```rust
// crates/wt-term/src/ring.rs
pub struct RingBuffer {
    buf: Box<[u8]>,          // 固定容量，避免频繁分配
    head: usize,
    len: usize,
    capacity: usize,
    unacked: usize,          // 已投递未确认
    dropped: u64,            // 丢弃字节数（溢出时）
    dropped_lines: u64,      // 估算丢弃行数（用于提示）
}
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `capacity` | 4 MB | 每会话 |
| `HIGH_WATER` | 2 MB | 未确认超过则暂停读取 |
| `LOW_WATER` | 512 KB | 未确认低于则恢复 |
| `MAX_CHUNK` | 64 KB | 单次 `term_read` 上限 |

**溢出处理**：容量满时丢弃最旧数据，并在流中注入提示行。注入点在「当前写位置」，即用户看到的顺序是正确的。

**为什么用固定容量 Box<[u8]> 而不是 `VecDeque<u8>`**：`VecDeque` 的 `make_contiguous` 会拷贝；固定数组 + 手动 head/len 可以零拷贝地取连续段（最多两段）。在 20 MB/s 下这点差异会累积成可观的 CPU。

**取数据的两段式**

```rust
pub fn read_chunk(&mut self, max: usize) -> (&[u8], &[u8]) {
    // 返回最多两段：从 head 到末尾，以及从 0 到剩余
    // 调用方无需合并，直接两次写入 IPC
}
```

## 5. 渲染（xterm.js 配置）

```ts
// ui/src/terminal/create.ts
const term = new Terminal({
  cols: 80,
  rows: 24,
  fontFamily: cfg.fontFamily,
  fontSize: cfg.fontSize,
  lineHeight: cfg.lineHeight,
  letterSpacing: cfg.letterSpacing,
  cursorStyle: cfg.cursorStyle,
  cursorBlink: true,
  scrollback: cfg.scrollback,
  theme: resolveTheme(cfg.theme),
  allowProposedApi: true,        // 需要 decorations / unicode11
  convertEol: false,
  windowsPty: isWindows ? { backend: 'conpty', buildNumber: osBuild } : undefined,
  macOptionIsMeta: true,
  rightClickSelectsWord: false,
  altClickMovesCursor: false,
});

term.loadAddon(new WebglAddon());        // 失败时回退 canvas
term.loadAddon(new Unicode11Addon());
term.loadAddon(new WebLinksAddon(handleLink));
term.loadAddon(new SearchAddon());
term.loadAddon(new SerializeAddon());    // 用于「保存终端输出」
term.loadAddon(new DecoratorAddon());    // 语法高亮，见 §7
```

### 5.1 渲染器选择

| 渲染器 | 何时使用 | 说明 |
|---|---|---|
| WebGL2 | 默认 | 大量文本时性能最好 |
| Canvas | WebGL 不可用（驱动/远程桌面） | 回退，性能约为 WebGL 的 40% |
| DOM | 仅用于可访问性模式 | 屏幕阅读器需要 DOM 节点 |

**回退检测**：`WebglAddon` 构造失败或 `onContextLoss` 触发时，`dispose()` 并加载 `CanvasAddon`。这个逻辑必须写，否则在虚拟机/远程桌面里会白屏。

### 5.2 尺寸计算

```ts
function fit(term: Terminal, container: HTMLElement) {
  const dims = term._core._renderService.dimensions;   // 内部 API，需封装
  const cols = Math.max(20, Math.floor(container.clientWidth / dims.css.cell.width));
  const rows = Math.max(4, Math.floor(container.clientHeight / dims.css.cell.height));
  if (cols !== term.cols || rows !== term.rows) {
    term.resize(cols, rows);          // 触发 onResize → IPC term_resize
  }
}
```

**去抖 50 ms**：拖拽窗口时会连续触发，直接发送会造成 SSH 通道窗口消息风暴。

## 6. 输入编码（前端）

**为什么在前端**：编码依赖 `DECCKM`、`bracketed paste`、鼠标模式等状态，这些状态的权威在 xterm.js。放 Rust 需要每次状态变化都同步，且每次按键都要 IPC 往返（+0.3 ms 延迟，对交互可感知）。

```ts
// ui/src/terminal/input.ts
term.onData((data) => {
  // xterm.js 已经完成键→序列的编码（含 DECCKM、修饰键）
  invoke('term_write', { handle, data });
});

term.onBinary((data) => {
  // 8 位二进制模式（某些老程序）
  invoke('term_write_binary', { handle, data: Array.from(data) });
});
```

**xterm.js 已经处理好的**（我们不需要重写）：

| 场景 | 行为 |
|---|---|
| `DECCKM` | 方向键发 `\eOA` 而非 `\e[A` |
| `Alt+键` | `ESC` 前缀 |
| `Ctrl+字母` | `0x01~0x1A` |
| `F1~F12` + 修饰键 | 正确的 CSI 参数 |
| 应用键盘（`DECNKM`） | 小键盘序列 |
| `bracketed paste` | `\e[200~...\e[201~` 包裹 |

**我们需要额外处理的**

| 场景 | 处理 |
|---|---|
| 中文输入法组合 | 监听 `compositionstart/update/end`，组合期间**不发送任何按键**；`compositionend` 后发送最终字符串 |
| 粘贴 | 自行处理（`TER-011` 的多行告警、节流），然后调 `term.paste(text)` 让 xterm 处理 bracketed paste |
| 右键粘贴 | 捕获 `contextmenu`，按配置粘贴或弹菜单 |
| `Ctrl+C` 语义 | 有选区且配置为「复制优先」时拦截；否则放行给终端 |
| 鼠标上报 | xterm.js 处理；`Shift` 强制本地选择由 xterm 内置支持 |

**中文输入法的关键约束**：组合期间若把拼音字母发给远端，远端会收到垃圾字符并可能触发补全。必须用 `compositionstart` 阻断。

## 7. 语法高亮装饰器

```ts
// ui/src/terminal/decorator.ts
export class DecoratorAddon implements ITerminalAddon {
  private rules: CompiledRule[] = [];
  private disposables: IDisposable[] = [];

  activate(term: Terminal) {
    // 监听渲染的行范围变化
    this.disposables.push(term.onRender((range) => this.decorate(range)));
    this.disposables.push(term.onScroll(() => this.decorate(term.buffer.active.viewportY)));
  }

  private decorate(range: { start: number; end: number }) {
    const buf = this.term.buffer.active;
    for (let y = Math.max(0, range.start - 200); y <= Math.min(buf.length - 1, range.end + 200); y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      const text = line.translateToString(true);
      for (const rule of this.rules) {
        for (const m of rule.matchAll(text)) {
          this.applyDecoration(y, m.index, m.index + m[0].length, rule.style);
        }
      }
    }
  }
}
```

**性能约束（对应 `TER-010`）**

| 约束 | 实现 |
|---|---|
| 只处理可见区 ±200 行 | `onRender` 提供的 range 已足够 |
| 规则数上限 64 | 加载时截断并警告 |
| 单条正则超时 10 ms | 用 `RegExp` 的 `lastIndex` 步进 + `performance.now()` 检查；超时则禁用该规则并上报 |
| 装饰器数量上限 | 每行最多 32 个 decoration，超出忽略 |
| 增量应用 | `tail -f` 场景只处理新行 |

**ReDoS 防护是必须的**：用户可自定义正则，一个 `(a+)+b` 就能让 UI 永久卡死。`performance.now()` 检查只能事后发现（JS 正则无法中断），所以还要：
- 加载时用「病态输入」试跑（`'a'.repeat(30) + 'b'`，限制 5 ms），超时直接拒绝该规则；
- 提供「安全模式」：只允许内置规则集。

## 8. 日志

```rust
// crates/wt-term/src/log.rs
pub enum LogMode { Raw, Ansi, Plain }

pub struct LogSink {
    mode: LogMode,
    writer: BufWriter<File>,
    ansi: AnsiStripper,
    bytes: u64,
    rotate_at: u64,
}
```

### 8.1 ANSI 剥离（无状态行过滤器）

```rust
pub struct AnsiStripper { state: State }

enum State {
    Ground,
    Esc,          // 收到 ESC
    Csi,          // ESC [
    CsiParam,
    Osc,          // ESC ]
    OscEsc,       // OSC 内收到 ESC（等待 \）
    Dcs,          // ESC P
    DcsEsc,
}
```

**只做剥离，不解释语义**——所以不需要网格，也不需要处理宽字符。这使它可以在流式数据上增量工作，且跨 chunk 边界正确（状态机保留）。

**必须处理的边界**

| 情况 | 处理 |
|---|---|
| 转义序列跨 chunk | 状态机保留，下次继续 |
| 未终止的 OSC | 超过 8 KB 未终止则放弃该序列（防内存耗尽） |
| `\r` 覆盖行 | 纯文本模式下保留 `\r` 原样（不模拟覆盖语义）——**这是刻意的**：模拟覆盖需要网格，代价远超收益；日志里保留 `\r` 用户能理解 |
| 8 位 C1 控制符 | 一并剥离 |

### 8.2 滚动

| 策略 | 触发 |
|---|---|
| 按大小 | 达到 `rotate_at`（默认 10 MB）→ 关闭当前文件，重命名加序号，开新文件 |
| 按时间 | 跨天（可配） |

保留份数默认 5，超出删除最旧。

### 8.3 输入记录（默认关闭）

若用户开启「记录输入」，输入字节单独写入 `.input` 文件，并在 `echo off` 期间屏蔽：

**如何知道 `echo off`**：终端在密码输入时会关闭回显（`termios` 的 `ECHO` 位）。这发生在**远端**，我们看不到。
可行的近似：检测远端输出中出现 `Password:` / `password for` / `Enter passphrase` 等提示后，屏蔽后续 N 秒的输入记录，直到出现换行。

**这是启发式，必须告知用户**：「输入记录无法可靠识别密码输入，请勿在开启此功能时输入敏感信息」。诚实比假装安全好。

## 9. 宏引擎（`TER-035`）

```rust
// crates/wt-term/src/macro.rs
#[derive(Serialize, Deserialize)]
pub struct Macro {
    pub name: String,
    pub steps: Vec<Step>,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Step {
    Text { t: u64, value: String },
    Key  { t: u64, value: KeyName },
    Wait { expect: String, timeout_ms: u64 },
    Sleep { ms: u64 },
    Var  { name: String, prompt: String, default: Option<String> },
}
```

**录制**：前端在 `onData` 里把每次输入连同时间戳发给 Rust 的 `MacroRecorder`；`echo off` 期间（同上启发式）不记录。

**回放**

```rust
pub async fn play(&self, m: &Macro, target: &mut dyn TermTransport, speed: f32) -> Result<()> {
    for step in &m.steps {
        match step {
            Step::Text { t, value } => { sleep(t / speed); target.write(value.as_bytes()).await?; }
            Step::Key { t, value } => { sleep(t / speed); target.write(key_bytes(value)).await?; }
            Step::Wait { expect, timeout_ms } => {
                wait_for_output(target, expect, *timeout_ms).await?;   // 超时则中止整个宏
            }
            Step::Var { name, prompt, default } => { let v = ask_user(name, prompt, default)?; }
            Step::Sleep { ms } => sleep(ms / speed),
        }
    }
    Ok(())
}
```

**`Wait` 的实现**：在 `TermSession` 的读路径上挂一个观察者，匹配到 `expect` 则唤醒。不匹配则超时中止（**不继续执行后续步骤**——继续会造成「以为成功了其实没有」）。

## 10. 跟随终端路径（`FIL-017`）

```rust
// crates/wt-term/src/osc.rs
pub enum OscEvent {
    Title(String),                 // OSC 0 / 1 / 2
    Cwd(String),                   // OSC 7: file://host/path
    Hyperlink { uri: String },     // OSC 8
    Clipboard(String),             // OSC 52
}
```

嗅探器只识别 `ESC ] <num> ; <payload> ST`，`ST` 为 `ESC \` 或 `BEL`。

**`OSC 7` 的格式**：`file://<host>/<path>`，`path` 是百分号编码的。解析后得到远端路径。

**降级链**（`spec/07` §FIL-017）：
1. 有 `OSC 7` → 直接用（权威）。
2. 无 `OSC 7` → 前端解析用户输入行中的 `cd <path>`，发 `term_cwd_guess` 给 Rust，UI 显示「可能已切换，是否同步？」（**不自动跳转**）。
3. 用户点「同步到终端目录」→ 用 `OSC 7` 的值，或提示「当前 shell 未上报目录」。

**为什么不做 shell 钩子注入**：MobaXterm 的做法是往远端写配置或执行隐藏命令，会污染用户环境、破坏审计、在某些 shell 下失效。我们只在用户主动开启时提供「安装 shell 集成脚本」的引导（写入 `~/.config/windterm/shell-integration.sh`，由用户自己 `source`），且默认不做。

## 11. 一致性验证

| 手段 | 覆盖 | 频率 |
|---|---|---|
| `vttest` 手工走查 | VT 全能力 | 每个 minor 版本 |
| `esctest` 自动化子集 | 转义序列 | CI |
| 录制回放 | 真实会话（vim/top/tmux/htop） | CI（用预录制的字节流 + 截图比对） |
| 截图回归 | 渲染结果 | CI |
| 中文/emoji 列宽用例 | `TER-025` | CI |

**录制回放的价值**：把一次真实的 `vim` 会话录成字节流（约 200 KB），在 CI 里重放并比对最终屏幕快照。这比跑 `vttest` 更快、更贴近真实。

## 12. 与需求的对应

| 设计点 | 需求 |
|---|---|
| `TermTransport` 抽象 | `SES-001/002/010/011`、`LOC-001` |
| 环形缓冲 + 水位 | `TER-034`、`NFR-003` |
| 拉取式 read/ack | `TER-034`、`NFR-003` |
| WebGL/Canvas 回退 | `TER-005` |
| 前端输入编码 | `TER-011/022/023` |
| 装饰器（高亮） | `TER-010` |
| ANSI 剥离 | `TER-015` |
| 宏引擎 | `TER-035` |
| OSC 嗅探 | `TER-019`、`FIL-017`、`TER-031` |
| 一致性验证 | `NFR-014` |
| 标签与布局 | `TER-001`、`TER-002` |
| 多执行广播 | `TER-004` |
| 编码与回滚 | `TER-006`、`TER-008` |
| 列选择与多行粘贴 | `TER-012`、`TER-013` |
| 保存终端输出 | `TER-016` |
| 关闭确认 | `TER-018` |
| 鼠标/粘贴/真彩 | `TER-022`、`TER-023`、`TER-024` |
