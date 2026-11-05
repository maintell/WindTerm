# 详细设计 · 13 · 前端架构与 UI 规范

实现需求：`SET-003`~`SET-012`、`SYS-001`~`SYS-012`、`TER-001`~`TER-005`、`FIL-001`、`GUI-*` 的 UI 部分
关键 ADR：ADR-0008（SolidJS）

## 1. 技术栈

| 项 | 选择 | 理由 |
|---|---|---|
| 框架 | SolidJS 1.9+ | 细粒度响应式，无 VDOM diff；高频状态更新（终端状态、传输进度）成本最低 |
| 语言 | TypeScript 5.x（`strict: true`） | |
| 构建 | Vite 6 | |
| 样式 | CSS Modules + CSS 变量（设计 token） | 不用 Tailwind（产物大、语义弱）；不用 CSS-in-JS（运行时成本） |
| 终端 | `@xterm/xterm` 5.x | ADR-0004 |
| 编辑器 | CodeMirror 6 | 体积小、可扩展 |
| 虚拟列表 | 自研（约 200 行） | 现有库对「树 + 表 + 动态行高」支持都不够 |
| 图标 | 内联 SVG 组件 | 避免图标字体（字体加载阻塞） |

**为什么不用 React**：终端相关的状态更新频率高（每帧的滚动位置、光标、活动指示），React 的 VDOM diff 在 60 fps 下会明显增加 CPU。Solid 的细粒度更新直接改 DOM 属性，成本低一个数量级。

### 1.1 现状（M1 的偏差，必须显式记录）

当前 `apps/wt-desktop/ui/` 是**纯静态 HTML + JS**，没有 SolidJS、没有 TypeScript、没有 Vite：

| 目标 | 现状 | 为什么先这样 |
|---|---|---|
| SolidJS 1.9 | 无框架，直接操作 DOM | 这一阶段只验证「数据能从 Rust 到界面、输入能从界面到 PTY」，框架选型不影响 IPC 形状 |
| Vite 6 | 无构建步骤，`frontendDist: "ui"` 直接内联 | 避免 npm 依赖与构建链；`cargo build` 一步出可运行产物 |
| `@xterm/xterm` 5.x | 6.0.0（UMD 静态文件内联在 `ui/vendor/`） | 6.x 是当前版本；UMD 版可零构建使用，许可证随文件存放 |
偏差的代价是**可维护性**：`main.js` 约 230 行、单文件，够用但没有组件化。
补上 SolidJS + Vite 是纯前端工作，不影响 Rust 侧与 IPC 契约；
届时 `terminal-pump.ts` 可以直接照抄现在的 `pump()` 逻辑。

### 1.2 CSP 必须放行 IPC 协议（踩过，别省这一行）

`apps/wt-desktop/tauri.conf.json` 里的 CSP 不是可选的装饰：

```json
"csp": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ipc: http://ipc.localhost"
```

`connect-src` 少了 `ipc: http://ipc.localhost` 时，Tauri 的 IPC 自定义协议会被 CSP 拦掉，
每次 `invoke` 先 `fetch` 失败、再退到 `postMessage` 兼容路径——**命令照跑，控制台只有一条
warning**，但响应在这种回退路径上更容易丢，表现就是「后端日志显示做完了，界面一直转圈」。

症状与判据：

| 现象 | 结论 |
|---|---|
| 控制台出现 `IPC custom protocol failed, Tauri will now use the postMessage interface instead` | CSP 漏了 `connect-src`，先修这里再查别的 |
| 后端埋点有 `[离开]`、前端 promise 不 settle | 命令跑完了，问题在响应这一段 |

启动时打一次 `typeof window.__TAURI__` 之外，还应当有一条**版本断言**：前端把自己的
版本号挂在 `window.__wt.ui` 上，验收脚本比对它，避免「改了 `ui/` 但页面还在跑旧 JS」
这种沉默失效（WebView2 会缓存 `http://tauri.localhost` 下的静态资源）。

### 1.3 粘贴走 `paste` 事件，不自己读剪贴板

终端粘贴只用一条路径：**捕获 `paste` 事件，取 `event.clipboardData`，再交给 `term.paste()`**。

理由都是踩出来的：

| 做法 | 结果 |
|---|---|
| 拦下 `Ctrl+Shift+V` 按键，再 `navigator.clipboard.readText()` | WebView2 里 `readText()` 要剪贴板读权限，当前构建拿不到；而且它**既不 resolve 也不 reject**，右键粘贴变成「点了毫无反应」。更糟的是：拦下按键会让浏览器**不产生** `paste` 事件，等于把唯一可用的通路也堵死 |
| 自己拼 `\e[200~…\e[201~` | xterm 的 `paste()` 已按远端 `?2004` 自动包裹，再包一层会让 vim 里出现多余的 `200~` |
| 自己把 `\r\n` 换成 `\r` | 同上，`paste()` 内部已规范化；重复处理会在某些输入上翻倍 |

所以：键盘粘贴（`Ctrl+V` / `Ctrl+Shift+V` / `Shift+Insert`）完全交给浏览器 + xterm；
只有**右键/中键**没有 `paste` 事件可用，才去读剪贴板，并且必须：

1. 给 `readText()` 套 1500ms 超时（否则永远等一个不来的响应）；
2. 失败时明确告诉用户替代动作（`请用 Ctrl+Shift+V 粘贴`），不允许静默。

**已知规格冲突**（`spec/06` `TER-011`）：正文写「双击选词，默认分隔符 `/~+-.&?$%`」，
但同一条的 AC-1 要求双击 `user@host:/var/log` 选中全串——分隔符里带 `/` 就做不到。
实现按 AC-1 优先：保留 xterm 默认分隔符（不含 `/ @ :`）。要改回带 `/` 的分隔符，
必须同时改 AC-1，否则验收会红。

## 2. 目录结构

```
ui/src/
├── main.tsx
├── app.tsx
├── core/                     # 与 Rust 的桥
│   ├── ipc.ts                # invoke 封装 + 错误处理
│   ├── events.ts             # 事件订阅与分发
│   ├── terminal-pump.ts      # 终端拉取循环
│   ├── graphics-pump.ts      # RDP/VNC 拉取循环
│   └── types.gen.ts          # 从 Rust 生成的类型（ts-rs）
├── state/                    # 全局状态（Solid Store）
│   ├── sessions.ts
│   ├── tabs.ts
│   ├── transfers.ts
│   ├── tunnels.ts
│   ├── config.ts
│   └── ui.ts
├── layout/
│   ├── app-shell.tsx
│   ├── sidebar.tsx
│   ├── tab-bar.tsx
│   ├── split-pane.tsx
│   ├── status-bar.tsx
│   └── command-palette.tsx
├── views/
│   ├── terminal-view.tsx
│   ├── rdp-view.tsx
│   ├── vnc-view.tsx
│   ├── files-view.tsx
│   ├── editor-view.tsx
│   ├── settings/
│   └── dialogs/
├── components/               # 通用组件
│   ├── virtual-list.tsx
│   ├── tree.tsx
│   ├── dialog.tsx
│   ├── toast.tsx
│   ├── form/
│   └── icon/
├── styles/
│   ├── tokens.css
│   ├── themes/
│   └── global.css
└── i18n/
    ├── index.ts
    ├── zh-CN.ts
    └── en-US.ts
```

## 3. 布局引擎

### 3.1 布局模型

```ts
type LayoutNode =
  | { kind: 'leaf'; tabGroupId: string }
  | { kind: 'split'; direction: 'row' | 'column'; ratio: number; a: LayoutNode; b: LayoutNode };
```

- 主区域是一个 `LayoutNode` 树。
- `split` 支持任意嵌套（最大深度 3）。
- 分隔条拖拽改变 `ratio`，双击复位为 0.5。

### 3.2 渲染

```tsx
function LayoutView(props: { node: LayoutNode }) {
  return (
    <Switch>
      <Match when={props.node.kind === 'leaf'}>
        <TabGroup id={(props.node as Leaf).tabGroupId} />
      </Match>
      <Match when={props.node.kind === 'split'}>
        <SplitPane
          direction={node.direction}
          ratio={node.ratio}
          onResize={(r) => setRatio(node, r)}
          a={<LayoutView node={node.a} />}
          b={<LayoutView node={node.b} />}
        />
      </Match>
    </Switch>
  );
}
```

**关键性能约束**：布局变化时不能重新挂载终端组件（会丢失 xterm 实例与滚动位置）。用 `<KeepAlive>` 式的「隐藏而非卸载」：

```tsx
// 所有已打开的终端常驻 DOM，通过 display 控制可见性
<div style={{ display: active ? 'block' : 'none' }}>
  <TerminalView handle={h} />
</div>
```

**代价**：打开的会话多时 DOM 节点多。但每个终端只是 1 个 canvas + 1 个 textarea（xterm 的结构），50 个会话约 100 个节点，可接受。

### 3.3 尺寸计算与 resize

```tsx
function useTerminalFit(term: Terminal, container: HTMLElement) {
  const ro = new ResizeObserver(debounce(() => {
    const cols = Math.floor(container.clientWidth / cellWidth(term));
    const rows = Math.floor(container.clientHeight / cellHeight(term));
    if (cols >= 20 && rows >= 4 && (cols !== term.cols || rows !== term.rows)) {
      term.resize(cols, rows);
    }
  }, 50));
  ro.observe(container);
  onCleanup(() => ro.disconnect());
}
```

**50 ms 去抖**（`design/03` §5.2）：拖拽窗口时 `ResizeObserver` 每帧触发，直接 resize 会造成 SSH 窗口消息风暴。

## 4. 状态管理

```ts
// state/sessions.ts
import { createStore } from 'solid-js/store';

export const [sessions, setSessions] = createStore<{
  byId: Record<string, Session>;
  tree: TreeNode[];
  selected: string[];
  loading: boolean;
}>({ byId: {}, tree: [], selected: [], loading: true });

export async function loadSessions() {
  const list = await ipc.sessionList();
  setSessions('byId', Object.fromEntries(list.map(s => [s.id, s])));
  setSessions('tree', buildTree(list));
  setSessions('loading', false);
}
```

**规则**

| 规则 | 原因 |
|---|---|
| 单一数据源在 Rust（DB） | 前端状态是缓存，不是权威 |
| 变更走「命令 → 事件 → 更新 store」 | 避免前端与后端状态分叉 |
| 乐观更新仅用于纯 UI 状态（选中、展开） | 数据类变更必须等后端确认 |
| 每个 store 一个文件，不建全局大 store | 避免无关更新互相触发 |

## 5. 主题与设计 token

```css
/* styles/tokens.css */
:root {
  --wt-space-1: 4px;  --wt-space-2: 8px;  --wt-space-3: 12px;
  --wt-space-4: 16px; --wt-space-6: 24px; --wt-space-8: 32px;

  --wt-radius-sm: 4px; --wt-radius-md: 6px; --wt-radius-lg: 10px;

  --wt-font-ui: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  --wt-font-mono: "JetBrains Mono", "Cascadia Code", Consolas, monospace;

  --wt-text-sm: 12px; --wt-text-md: 13px; --wt-text-lg: 15px;

  --wt-color-bg: #ffffff;
  --wt-color-bg-subtle: #f7f7f8;
  --wt-color-fg: #1a1a1a;
  --wt-color-fg-muted: #6b6b70;
  --wt-color-border: #e3e3e6;
  --wt-color-accent: #2f6feb;
  --wt-color-danger: #d13438;
  --wt-color-warn: #b8770a;
  --wt-color-success: #107c10;
}

[data-theme="dark"] {
  --wt-color-bg: #1a1a1c;
  --wt-color-bg-subtle: #232326;
  --wt-color-fg: #e8e8ea;
  --wt-color-fg-muted: #9a9aa0;
  --wt-color-border: #33333a;
  --wt-color-accent: #5b9bff;
  --wt-color-danger: #f1707a;
  --wt-color-warn: #e0a742;
  --wt-color-success: #4cc26b;
}
```

**UI 字体与终端字体分离**（`SET-009`）：UI 用系统字体（渲染快、中文友好），终端用等宽字体。

## 6. 键位系统

```ts
type Scope = 'global' | 'terminal' | 'graphics' | 'files' | 'editor';

interface Binding {
  id: string;              // 稳定 ID（与需求 ID 无关，是动作 ID）
  label: string;           // i18n key
  scope: Scope;
  default: string;         // "Ctrl+Shift+P"
  when?: (ctx: KeyContext) => boolean;   // 条件（例如「有选区时才启用」）
  run: (ctx: KeyContext) => void | Promise<void>;
}
```

**分发顺序**

```
keydown
  ├─ 若焦点在输入框（input/textarea/contenteditable）且不是 Esc/Tab → 放行
  ├─ 若在终端内且终端处于应用模式（xterm 已处理）→ 放行给 xterm
  ├─ 按 scope 从具体到宽泛查找（editor → files → graphics → terminal → global）
  ├─ 命中且 when() 通过 → 执行，preventDefault
  └─ 未命中 → 放行
```

**冲突检测**：同一 scope 内同一组合键绑定了多个动作 → 设置页标红，运行时只执行第一个并记录警告。

**保留键**（不可绑定，除非用户显式确认）：

```
Ctrl+C  Ctrl+D  Ctrl+Z  Ctrl+\  （终端控制字符）
Ctrl+Alt+Del                      （OS 保留）
```

## 7. 虚拟列表

会话树最多几千节点，文件列表可能上万项。必须虚拟化。

```tsx
function VirtualList<T>(props: {
  items: T[];
  itemHeight: number | ((index: number) => number);
  overscan?: number;
  render: (item: T, index: number) => JSX.Element;
}) {
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportH, setViewportH] = createSignal(0);

  const totalH = () => sumHeights(props.items);
  const range = () => computeRange(scrollTop(), viewportH(), props.items, props.itemHeight, props.overscan ?? 5);

  return (
    <div class="vlist" onScroll={e => setScrollTop(e.currentTarget.scrollTop)}>
      <div style={{ height: `${totalH()}px`, position: 'relative' }}>
        <For each={props.items.slice(range().start, range().end)}>
          {(item, i) => (
            <div style={{ position: 'absolute', top: `${offsetOf(range().start + i())}px`, ... }}>
              {props.render(item, range().start + i())}
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
```

**动态行高**：树节点可能有副标题（host/user），行高不同。用「预估 + 测量修正」：首次渲染用预估值，`ResizeObserver` 测量后更新偏移表。

## 8. 国际化

```ts
// i18n/index.ts
const dict = { 'zh-CN': zhCN, 'en-US': enUS };

export function t(key: string, params?: Record<string, string | number>): string {
  const lang = currentLang();
  const template = dict[lang][key] ?? dict['en-US'][key] ?? key;
  return params ? format(template, params) : template;
}
```

**约束**

| 约束 | CI 检查 |
|---|---|
| 两个语言文件键集合完全相同 | ✅ 脚本比对 |
| 源码中无中文字符串字面量（注释/测试除外） | ✅ ESLint 规则 |
| 参数占位符一致（`{n}` 数量与名称） | ✅ 脚本比对 |
| 复数用 ICU MessageFormat | 人工评审 |

**切换语言**：`currentLang` 是 signal，切换后所有 `t()` 调用自动重渲染（Solid 的细粒度更新）。

> **当前实现的偏差**（别照本节的 ts 代码去找文件）：前端是零构建的 `ui/main.js`，没有 Solid、
> 也没有 `i18n/index.ts`；词表是 `I18N` 字面对象 + 元素上的 `data-i18n` 属性 + 状态栏的
> `STATUS_EN` 查表。上表四条约束里目前只做到「两份词表键集合一致」与「`data-i18n` 键齐全」
> （`check-docs.ps1` 第 9 项），外加一条本表没有的「纯字面量状态文案必须有英文词条、且不许留
> 死词条」。「源码中无中文字符串字面量」离得很远——错误消息、右键菜单、带变量的状态模板
> 字符串都还是中文，覆盖面如实写在 README 的进度表与已知缺口里。

## 9. 可访问性

| 要求 | 实现 |
|---|---|
| 全键盘可达 | 每个交互元素可聚焦；树/列表支持方向键导航 |
| 焦点可见 | `:focus-visible { outline: 2px solid var(--wt-color-accent); outline-offset: 1px; }` |
| 语义化 | 用 `<nav>`/`<main>`/`<ul role="tree">`；按钮用 `<button>` |
| 屏幕阅读器 | 终端提供「朗读模式」：把可见区文本写入一个 `aria-live="polite"` 的隐藏区域 |
| 对比度 | 所有 token 组合通过 WCAG AA（脚本校验） |
| 减少动画 | `@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }` |
| 缩放 250% | 布局用 `rem`/`em`；不用固定像素宽度 |

**终端朗读模式的实现**

```tsx
// 只在新输出且用户开启朗读时更新，避免刷屏
createEffect(() => {
  if (!readAloud()) return;
  const text = term.buffer.active.getLine(term.buffer.active.cursorY)?.translateToString(true) ?? '';
  if (text !== lastSpoken()) {
    liveRegion.textContent = text;
    setLastSpoken(text);
  }
});
```

## 10. 错误与提示规范

### 10.1 四级提示

| 级别 | 组件 | 用途 | 自动消失 |
|---|---|---|---|
| Toast | 右下角浮层 | 成功/轻量失败 | 4 s |
| Inline | 表单项下方 | 校验错误 | 否 |
| Banner | 顶部条 | 持续状态（断连、策略限制） | 否 |
| Dialog | 模态 | 需决策（主机密钥变更、冲突） | 否 |

### 10.2 错误展示模板

```
┌─────────────────────────────────────────────┐
│ ⚠ 无法连接到 10.0.1.11:22                    │
│                                             │
│ 第 2 跳（bastion2:22）认证失败：服务端拒绝了  │
│ 提供的密钥。                                 │
│                                             │
│ ▸ 技术详情                                   │
│   SSH_AUTH_FAILED                           │
│   publickey rejected: no supported key type │
│                                             │
│ [ 编辑第 2 跳的凭据 ]  [ 查看连接诊断 ]  [ 关闭 ]│
└─────────────────────────────────────────────┘
```

**三条硬规则**（对应 `design/01` §6.1）

1. 标题一句话说清「发生了什么」；
2. 正文说清「为什么」；
3. 按钮说清「我能做什么」——**至少一个可执行动作**。

**禁止**：只有「确定」按钮的错误框。

### 10.3 空状态

每个空视图必须有：图标 + 一句话说明 + 一个主操作。

```
┌─────────────────────────────┐
│         🔌                  │
│   还没有会话                 │
│                             │
│  [ 新建会话 ]  [ 从 MobaXterm 导入 ] │
└─────────────────────────────┘
```

**「从 MobaXterm 导入」必须是并列主按钮**（不是藏在设置里）——这是迁移用户的第一需求。

## 11. 命令面板

```tsx
const commands = createMemo(() => {
  const q = query().toLowerCase();
  return allCommands
    .filter(c => !q || c.title.toLowerCase().includes(q) || c.keywords.some(k => k.includes(q)))
    .sort((a, b) => score(b, q) - score(a, q))
    .slice(0, 50);
});
```

**命令来源**

| 来源 | 示例 |
|---|---|
| 会话 | 「连接：prod-web-01」 |
| 隧道 | 「启动隧道：test-db」 |
| 设置项 | 「打开设置：终端字体」 |
| 工具 | 「生成 SSH 密钥」「连接诊断」 |
| 插件命令 | 「ACME 巡检」 |

**这是「可发现性」的主要手段**：MobaXterm 的很多能力藏在多级菜单里，用户不知道存在。命令面板把全部能力拉平到一个搜索框。

## 12. 与需求的对应

| 设计点 | 需求 |
|---|---|
| 布局树 + KeepAlive | `TER-001`~`TER-003` |
| 虚拟列表 | `SES-013`（大会话树）、`FIL-001`（大目录） |
| token 与主题 | `SET-003`、`SYS-010`、`SYS-011` |
| 键位系统 | `TER-020`、`SET-004` |
| i18n 约束 | `SET-012`、`NFR-015` |
| 可访问性 | `SYS-009`、`NFR-016` |
| 错误模板 | 「可解释的失败」（`spec/01` §6 原则 3） |
| 空状态 | `SES-020` 入口可见性 |
| 命令面板 | `SES-022` |
| 设置分组与搜索 | `SET-001` |
| 会话级设置覆盖 | `SET-005` |
| 便携模式提示 | `SET-007` |
| 设置导入界面 | `SET-013` |
| 导入导出与重置 | `SET-015` |
| 无管理员权限运行 | `SYS-013` |
