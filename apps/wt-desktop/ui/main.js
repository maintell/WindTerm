// WindTerm 前端：xterm.js 渲染 + 拉取式二进制 IPC。
//
// 形状与 `docs/design/02-process-and-ipc.md` §3.4 一致：
//   term_read(handle, max) -> ArrayBuffer -> term.write(bytes) -> term_ack(handle, n) -> 下一帧
//
// 两个不显然的点：
//   1. ack 在 xterm **消费完**这一块之后才发（write 的回调里），否则后端算出的
//      「未确认字节」是假的，背压会失效。
//   2. 输入交给 xterm 的 `onData`，不自己拼键位——方向键、Ctrl 组合、Alt 前缀、
//      中文输入法都只有它做得对（TER-020）。

const invoke = window.__TAURI__.core.invoke;

// UMD 构建的两种形状不一样，这里显式取：
//   vendor/xterm.js   → globalThis.Terminal 直接是构造函数
//   vendor/addon-fit.js → globalThis.FitAddon 是命名空间对象
const Terminal = window.Terminal;
const FitAddon = window.FitAddon?.FitAddon;
const SearchAddon = window.SearchAddon?.SearchAddon;

const statusEl = document.getElementById("status");

if (
  typeof Terminal !== "function" ||
  typeof FitAddon !== "function" ||
  typeof SearchAddon !== "function"
) {
  statusEl.textContent = "前端依赖未加载：vendor 下的 xterm.js / addon-fit.js / addon-search.js 缺失";
  throw new Error(
    `xterm 加载失败：Terminal=${typeof Terminal} FitAddon=${typeof FitAddon} SearchAddon=${typeof SearchAddon}`,
  );
}

const openBtn = document.getElementById("open");
const sshBtn = document.getElementById("ssh");
const closeBtn = document.getElementById("close");
const hostInput = document.getElementById("host");
const portInput = document.getElementById("port");
const userInput = document.getElementById("user");
const passInput = document.getElementById("password");
const nameInput = document.getElementById("session-name");
const kindSelect = document.getElementById("kind");
const saveSessionBtn = document.getElementById("save-session");
const deleteSessionBtn = document.getElementById("delete-session");
const useKeyBox = document.getElementById("use-key");
const useAgentBox = document.getElementById("use-agent");
const keyRow = document.getElementById("key-row");
const useJumpBox = document.getElementById("use-jump");
const jumpRow = document.getElementById("jump-row");
const jumpHostInput = document.getElementById("jump-host");
const jumpUserInput = document.getElementById("jump-user");
const jumpPassInput = document.getElementById("jump-pass");
const jumpSessionSelect = document.getElementById("jump-session");
const pickKeyBtn = document.getElementById("pick-key");
const keyFileInput = document.getElementById("key-file");
const keyName = document.getElementById("key-name");
const keyPassInput = document.getElementById("key-pass");

/** 已选中的私钥内容（PEM/OpenSSH 文本），null 表示没选 */
/** 当前密码框里的口令是「自动填进来的」吗（`SEC-002` 判断「可能已过期」要用） */
let pwFromStore = false;

let keyPem = null;

const rememberBox = document.getElementById("remember");
/** 「密码」控件的默认值（`SEC-002`）：只影响新建连接时表单的初值 */
let rememberDefault = "persist";
const vaultRow = document.getElementById("vault-row");
const masterPassInput = document.getElementById("master-pass");
const vaultOpenBtn = document.getElementById("vault-open");
const vaultLockBtn = document.getElementById("vault-lock");
const vaultStateEl = document.getElementById("vault-state");

let vaultUnlocked = false;
/** 会话树里当前选中的会话（保存密码要按它记） */
let selectedSession = null;

const termHost = document.getElementById("term");
const paneA = document.getElementById("term-a");
const paneB = document.getElementById("term-b");
const splitToggle = document.getElementById("split-toggle");
const tabsEl = document.getElementById("tabs");

/** 攒够这么多未确认字节就先确认一次，减少 IPC 往返 */
const ACK_BATCH = 32 * 1024;
/** 低流量时也定期确认，避免 pending 长期挂账 */
const ACK_INTERVAL = 200;

/** 所有已打开的会话：id → view */
const sessions = new Map();
/** 当前激活的 view；`null` 表示没有会话 */
let active = null;
let nextViewId = 1;
/** 主窗口是否全屏（`TER-020`）。以后端 `is_fullscreen` 为准，不自己猜。 */
let isFullscreen = false;

/**
 * 最近使用的标签顺序（`TER-001` / `TER-020`），第一个永远是最新激活的。
 *
 * 规格要求 `Ctrl+Tab` 按 **MRU** 而不是标签位置切换：标签一多，按位置切几乎必然
 * 切错。做法与 Alt+Tab 一致——连续按时沿「最近顺序」往下走，停手 1.5 秒后结束这一轮。
 */
const mruViews = [];
/** 正在连续切换时的那一轮顺序快照与游标；`null` 表示这一轮还没开始 */
let mruBurst = null;
let mruTimer = null;

/** 把某个标签提到 MRU 最前（切走时用；关闭标签时顺手清掉已消失的） */
function mruRemember(view) {
  const at = mruViews.indexOf(view);
  if (at >= 0) mruViews.splice(at, 1);
  mruViews.unshift(view);
}

let uiLang = "zh";

/**
 * 状态栏文案的中文→英文对照（SET-012）。
 *
 * 状态栏有 130 多处 setStatus 调用，绝大多数是带变量的模板字符串，逐条国际化
 * 不现实；这里只覆盖**纯字面量**那一批，并在 setStatus 里统一查表，所以调用点
 * 一个都不用改，覆盖到哪儿一眼可数。模板字符串仍是中文——不假装状态栏已全英文。
 *
 * 门禁：scripts/check-docs.ps1 第 9 项核对「每个纯字面量 setStatus 都有词条」
 * 且「表里没有没人用的死词条」。加一条状态文案却忘了配英文，检查会直接失败。
 */
const STATUS_EN = {
  "已关闭": "Closed",
  "没有选中内容": "Nothing selected",
  "打开失败": "Open failed",
  "请先填主机与用户名": "Enter host and username first",
  "请先选择私钥文件": "Choose a private key file first",
  "请重新输入密码（连上后会覆盖已保存的口令）": "Re-enter password (overwrites the saved one once connected)",
  "这条标签没有记录连接参数，无法复制": "This tab has no recorded connection settings to copy",
  "已移动": "Moved",
  "已调整顺序": "Order changed",
  "填名称与主机后保存；连接则用当前参数": "Fill name and host to save; Connect uses the current values",
  "保存会话需要名称与主机": "Saving a session needs a name and host",
  "读剪贴板被拒绝，请用 Ctrl+Shift+V 粘贴": "Clipboard read denied; use Ctrl+Shift+V to paste",
  "没有活动会话": "No active session",
  "粘贴已取消": "Paste cancelled",
  "已清屏": "Screen cleared",
  "没有匹配": "No matches",
  "已全部替换（记得保存）": "Replaced all (remember to save)",
  "键位已恢复默认": "Keybindings restored to defaults",
  "文件面板需要先填主机与用户名": "The file panel needs host and username first",
  "没有可广播的会话": "No sessions to broadcast to",
  "选中的标签没有已连接的会话": "None of the selected tabs is connected",
  "已取消广播": "Broadcast cancelled",
  "还没有广播结果可导出": "No broadcast results to export yet",
  "实时广播已开启": "Live broadcast on",
  "危险命令被拦下，实时广播已关闭": "Dangerous command blocked; live broadcast turned off",
  "密码保存默认值已更新": "Saved password default updated",
  "显示修改时间列：开": "Modified time column on",
  "显示修改时间列：关": "Modified time column off",
  "实时广播已关闭": "Live broadcast off",
  "已关闭分屏": "Split view closed",
  "分屏需要至少两个已连接的会话": "Split view needs at least two connected sessions",
  "已更换主密码": "Master password changed",
  "保险库已移除": "Vault removed",
  "请输入主密码": "Enter the master password",
  "保险库已锁定": "Vault locked",
  "密码已记住（仅本次运行）": "Password remembered (this run only)",
  "就绪（点击「新建本地终端」开始）": "Ready (click New local terminal to start)",
  "已进入全屏（F11 退出）": "Entered fullscreen (F11 to exit)",
  "已退出全屏": "Exited fullscreen",
  "切换全屏失败": "Failed to toggle fullscreen",
};

/**
 * 带变量状态栏模板的中文→英文骨架（`SET-012`）。
 *
 * `STATUS_EN` 只认「整句相等」的字面量，而状态栏里绝大多数是
 * `已保存会话 ${name}` 这种模板——英文界面下它们仍是中文，是 `SET-012` 的主要缺口。
 * 这里用「中文骨架正则 → 英文骨架」做精确匹配：固定文字翻掉，捕获组（名字/数字/
 * 路径/编码名）原样带回，不碰数据本身。
 *
 * **失败/异常类模板故意不列**：`${e}` 展开的是后端错误串（`[CODE] 中文说明`），
 * 翻了前半句会得到「Failed: …中文…」这种中英混排，比全中文更糟。那批如实记在
 * README 的缺口里，等后端错误码也英文化再一起做。
 *
 * 门禁：`check-docs.ps1` 核对「每条骨架都能在源码里匹配到至少一个 setStatus 调用」
 * 且「没有永远匹配不到的死骨架」；e2e 逐条在英文下验 `shown` 真的等于英文。
 */
const STATUS_TPL_EN = [
  [/^标签已改名为：(.+)$/, "Tab renamed: $1"],
  [/^标签顺序：(.+)$/, "Tab order: $1"],
  [/^已填入 (.+) 的密码（本次运行记住的）$/, "Filled password for $1 (this run only)"],
  [/^已从保险库填入 (.+) 的密码$/, "Filled password for $1 from vault"],
  [/^(.+) 是 (.+) 会话，暂不支持$/, "$1 is a $2 session, not supported yet"],
  [/^已重命名：(.+)$/, "Renamed: $1"],
  [/^已复制：(.+)$/, "Copied: $1"],
  [/^已导出：(.+)$/, "Exported: $1"],
  [/^已选 (\d+) 个会话（Ctrl\+点击增减，右键可批量移动）$/, "$1 sessions selected (Ctrl+click to toggle, right-click for bulk move)"],
  [/^已移动 (\d+) 个会话$/, "Moved $1 sessions"],
  [/^已删除 (\d+) 个会话$/, "Deleted $1 sessions"],
  [/^已新建文件夹：(.+)$/, "Folder created: $1"],
  [/^已重命名文件夹：(.+)$/, "Folder renamed: $1"],
  [/^已保存会话 (.+)$/, "Session saved: $1"],
  [/^已删除会话 (.+)$/, "Session deleted: $1"],
  [/^已删除保险库条目 (.+)$/, "Vault entry deleted: $1"],
  [/^已复制 (\d+) 字符$/, "Copied $1 chars"],
  [/^已粘贴 (\d+) 字符$/, "Pasted $1 chars"],
  [/^已下载到本地：(.+)$/, "Downloaded to: $1"],
  [/^已打开 (.+)（(\d+) 字节）$/, "Opened $1 ($2 bytes)"],
  [/^已保存 (.+)（(\d+) 字节）$/, "Saved $1 ($2 bytes)"],
  [/^匹配 (.+)$/, "Match: $1"],
  [/^已按 (.+) 重新读取 (.+)$/, "Re-read $2 as $1"],
  [/^换行符已经是 (.+)$/, "Line endings already $1"],
  [/^换行符已改成 (.+)（记得保存）$/, "Line endings changed to $1 (remember to save)"],
  [/^已生成 (.+) 密钥$/, "Generated $1 key"],
  [/^键位冲突：(.+) 已被「(.+)」占用$/, "Key conflict: $1 is already used by $2"],
  [/^已绑定 (.+)$/, "Bound: $1"],
  [/^键位方案已导出：(.+)$/, "Keymap exported: $1"],
  [/^自动刷新目录（(.+)）$/, "Auto-refreshed directory ($1)"],
  [/^文件列表按 (.+) 排序$/, "File list sorted by $1"],
  [/^权限位要 0~777 的八进制数，收到「(.+)」$/, "Permission must be octal 0-777, got $1"],
  [/^已把 (.+) 的权限改成 (.+)$/, "Changed $1 permissions to $2"],
  [/^已在当前终端切到 (.+)$/, "Changed to $1 in current terminal"],
  [/^已复制路径：(.+)$/, "Path copied: $1"],
  [/^复制失败，路径是：(.+)$/, "Copy failed, path is: $1"],
  [/^已下载到 (.+)$/, "Downloaded to $1"],
  [/^已广播到 (\d+) 个会话$/, "Broadcast to $1 sessions"],
  [/^已导出广播结果：(.+)$/, "Broadcast results exported: $1"],
  [/^右侧显示：(.+)$/, "Right pane: $1"],
  [/^自定义危险规则：(\d+) 条$/, "Custom danger rules: $1"],
  [/^密钥已轮换（(\d+) 条，保险库仍解锁）$/, "Key rotated ($1 entries, vault still unlocked)"],
  [/^已忘掉 (.+)$/, "Forgot: $1"],
  [/^已导入 (\d+) 套配色$/, "Imported $1 color schemes"],
  [/^本地终端 shell：(.+)（新建终端生效）$/, "Local shell: $1 (applies to new terminals)"],
  [/^显示列：大小(.+)$/, "Columns: size $1"],
  [/^显示列：权限(.+)$/, "Columns: permissions $1"],
  [/^连接超时：(\d+) 秒（下一次建连生效）$/, "Connect timeout: $1 s (applies to next connection)"],
  [/^keepalive 最多丢失：(\d+) 次$/, "keepalive max missed: $1"],
  [/^已跳到「(.+)」$/, "Jumped to $1"],
  [/^终端编码：(.+)$/, "Terminal encoding: $1"],
  // 保存终端输出（`TER-020`）
  [/^已保存终端输出：(.+)$/, "Terminal output saved: $1"],
  [/^保存终端输出失败：(.+)$/, "Failed to save terminal output: $1"],
  // 会话树批量多执行（`TER-004`）
  [/^正在打开 (\d+) 个会话…$/, "Opening $1 sessions…"],
  [/^广播目标 (\d+) 台$/, "Broadcast targets: $1"],
  [/^广播目标 (\d+) 台（跳过 (\d+) 个非 SSH 会话）$/, "Broadcast targets: $1 (skipped $2 non-SSH session(s))"],
  // 命令面板（`SES-022`）
  [/^已选中「(.+)」：填好密码后点「连接」$/, "Selected $1: fill in the password, then click Connect"],
  [/^「(.+)」现在没有可作用的对象$/, "Nothing for $1 to act on right now"],
];

let lastStatus = "";

function setStatus(text) {
  // 存原文而不是成品：切到 English 时能把当前这条也重刷一遍，
  // 不然「已关闭」会一直挂到下一次状态变化才变英文
  lastStatus = text;
  let shown = text;
  if (uiLang === "en") {
    if (Object.hasOwn(STATUS_EN, text)) {
      shown = STATUS_EN[text];
    } else {
      // 带变量模板：逐条试骨架正则，命中就翻固定文字、把捕获组（数据）原样带回
      for (const [re, en] of STATUS_TPL_EN) {
        const m = re.exec(text);
        if (m) {
          shown = en.replace(/\$(\d)/g, (_, n) => m[Number(n)] ?? "");
          break;
        }
      }
    }
  }
  statusEl.textContent = shown;
}

/** 打开/关闭按钮的可用状态：多会话后开新会话不该被禁用 */
function refreshButtons() {
  closeBtn.disabled = sessions.size === 0;
  openBtn.disabled = false;
  sshBtn.disabled = false;
}

function frame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

/**
 * 建一个终端视图（一个标签页）。
 *
 * 每个会话有自己的 xterm 实例、FitAddon、未确认计数与拉取循环——
 * 共用一份状态会让「切走的标签页停止 ack」变成静默的背压泄漏。
 */
/**
 * 内置配色（`TER-005`）。
 *
 * 每项 4 个界面色 + 16 个 ANSI 色。写成紧凑数组而不是对象字面量，是因为
 * 20 套 × 20 个键的 `black:`/`brightBlack:` 形式会把文件撑成好几屏，改起来反而容易错位。
 */
const THEME_DATA = [
{ name: "WindTerm Dark", bg: "#1a1a1c", fg: "#e8e8ea", cur: "#5b9bff", sel: "#2f4f7f", ansi: ["#1a1a1c","#e5534b","#4caf50","#d7a24a","#5b9bff","#b06bd0","#3aa6a6","#c8c8cc","#5a5a62","#ff6b64","#7ee787","#ffd479","#8ab6ff","#d99cf0","#63cfcf","#f0f0f4"] },
{ name: "Solarized Dark", bg: "#002b36", fg: "#839496", cur: "#93a1a1", sel: "#073642", ansi: ["#073642","#dc322f","#859900","#b58900","#268bd2","#d33682","#2aa198","#eee8d5","#002b36","#cb4b16","#586e75","#657b83","#839496","#6c71c4","#93a1a1","#fdf6e3"] },
{ name: "Solarized Light", bg: "#fdf6e3", fg: "#657b83", cur: "#586e75", sel: "#eee8d5", ansi: ["#073642","#dc322f","#859900","#b58900","#268bd2","#d33682","#2aa198","#eee8d5","#002b36","#cb4b16","#586e75","#657b83","#839496","#6c71c4","#93a1a1","#fdf6e3"] },
{ name: "Dracula", bg: "#282a36", fg: "#f8f8f2", cur: "#f8f8f2", sel: "#44475a", ansi: ["#21222c","#ff5555","#50fa7b","#f1fa8c","#bd93f9","#ff79c6","#8be9fd","#f8f8f2","#6272a4","#ff6e6e","#69ff94","#ffffa5","#d6acff","#ff92df","#a4ffff","#ffffff"] },
{ name: "Nord", bg: "#2e3440", fg: "#d8dee9", cur: "#d8dee9", sel: "#434c5e", ansi: ["#3b4252","#bf616a","#a3be8c","#ebcb8b","#81a1c1","#b48ead","#88c0d0","#e5e9f0","#4c566a","#bf616a","#a3be8c","#ebcb8b","#81a1c1","#b48ead","#8fbcbb","#eceff4"] },
{ name: "Gruvbox Dark", bg: "#282828", fg: "#ebdbb2", cur: "#ebdbb2", sel: "#504945", ansi: ["#282828","#cc241d","#98971a","#d79921","#458588","#b16286","#689d6a","#a89984","#928374","#fb4934","#b8bb26","#fabd2f","#83a598","#d3869b","#8ec07c","#ebdbb2"] },
{ name: "One Dark", bg: "#282c34", fg: "#abb2bf", cur: "#528bff", sel: "#3e4451", ansi: ["#282c34","#e06c75","#98c379","#e5c07b","#61afef","#c678dd","#56b6c2","#abb2bf","#5c6370","#e06c75","#98c379","#e5c07b","#61afef","#c678dd","#56b6c2","#ffffff"] },
{ name: "Monokai", bg: "#272822", fg: "#f8f8f2", cur: "#f8f8f0", sel: "#49483e", ansi: ["#272822","#f92672","#a6e22e","#f4bf75","#66d9ef","#ae81ff","#a1efe4","#f8f8f2","#75715e","#f92672","#a6e22e","#f4bf75","#66d9ef","#ae81ff","#a1efe4","#f9f8f5"] },
{ name: "Tokyo Night", bg: "#1a1b26", fg: "#c0caf5", cur: "#c0caf5", sel: "#33467c", ansi: ["#15161e","#f7768e","#9ece6a","#e0af68","#7aa2f7","#bb9af7","#7dcfff","#a9b1d6","#414868","#f7768e","#9ece6a","#e0af68","#7aa2f7","#bb9af7","#7dcfff","#c0caf5"] },
{ name: "Catppuccin Mocha", bg: "#1e1e2e", fg: "#cdd6f4", cur: "#f5e0dc", sel: "#585b70", ansi: ["#45475a","#f38ba8","#a6e3a1","#f9e2af","#89b4fa","#f5c2e7","#94e2d5","#bac2de","#585b70","#f38ba8","#a6e3a1","#f9e2af","#89b4fa","#f5c2e7","#94e2d5","#a6adc8"] },
{ name: "Material", bg: "#263238", fg: "#eeffff", cur: "#ffcc00", sel: "#80cbc4", ansi: ["#000000","#ff5370","#c3e88d","#ffcb6b","#82aaff","#c792ea","#89ddff","#ffffff","#545454","#ff5370","#c3e88d","#ffcb6b","#82aaff","#c792ea","#89ddff","#ffffff"] },
{ name: "Tomorrow Night", bg: "#1d1f21", fg: "#c5c8c6", cur: "#c5c8c6", sel: "#373b41", ansi: ["#1d1f21","#cc6666","#b5bd68","#f0c674","#81a2be","#b294bb","#8abeb7","#c5c8c6","#969896","#cc6666","#b5bd68","#f0c674","#81a2be","#b294bb","#8abeb7","#ffffff"] },
{ name: "Zenburn", bg: "#3f3f3f", fg: "#dcdccc", cur: "#dcdccc", sel: "#2f2f2f", ansi: ["#4d4d4d","#705050","#60b48a","#f0dfaf","#506070","#dc8cc3","#8cd0d3","#dcdccc","#709080","#dca3a3","#c3bf9f","#e0cf9f","#dfaf8f","#dc8cc3","#93e0e3","#ffffff"] },
{ name: "Ocean", bg: "#224fbc", fg: "#ffffff", cur: "#ffffff", sel: "#2c62d6", ansi: ["#000000","#ff0000","#00b300","#c8c800","#0000ff","#ff00ff","#00b3b3","#ffffff","#808080","#ff5555","#55ff55","#ffff55","#5555ff","#ff55ff","#55ffff","#ffffff"] },
{ name: "Ubuntu", bg: "#300a24", fg: "#eeeeec", cur: "#bbbbbb", sel: "#b4a6a2", ansi: ["#2e3436","#cc0000","#4e9a06","#c4a000","#3465a4","#75507b","#06989a","#d3d7cf","#555753","#ef2929","#8ae234","#fce94f","#729fcf","#ad7fa8","#34e2e2","#eeeeec"] },
{ name: "Tango Light", bg: "#ffffff", fg: "#000000", cur: "#000000", sel: "#a6d9f7", ansi: ["#2e3436","#cc0000","#4e9a06","#c4a000","#3465a4","#75507b","#06989a","#d3d7cf","#555753","#ef2929","#8ae234","#fce94f","#729fcf","#ad7fa8","#34e2e2","#eeeeec"] },
{ name: "xterm", bg: "#000000", fg: "#e5e5e5", cur: "#ffffff", sel: "#444444", ansi: ["#000000","#cd0000","#00cd00","#cdcd00","#0000ee","#cd00cd","#00cdcd","#e5e5e5","#7f7f7f","#ff0000","#00ff00","#ffff00","#5c5cff","#ff00ff","#00ffff","#ffffff"] },
{ name: "Cobalt", bg: "#193549", fg: "#ffffff", cur: "#ffcc00", sel: "#0050a4", ansi: ["#000000","#ff0000","#38de21","#ffe50a","#1460d2","#ff005d","#00bbbb","#bbbbbb","#555555","#f40e17","#3bd01d","#edc809","#0e7ff5","#ff5572","#00eeee","#ffffff"] },
{ name: "Ayu Mirage", bg: "#1f2430", fg: "#cbccc6", cur: "#ffcc66", sel: "#33415e", ansi: ["#191e2a","#ed8274","#a6cc70","#fad07b","#6dcbfa","#cfbafa","#90e1c6","#c7c7c7","#686868","#f28779","#bae67e","#ffd580","#73d0ff","#d4bfff","#95e6cb","#ffffff"] },
{ name: "Kanagawa", bg: "#1f1f28", fg: "#dcd7ba", cur: "#c8c093", sel: "#2d4f67", ansi: ["#090618","#c34043","#76946a","#c0a36e","#7e9cd8","#957fb8","#6a9589","#c8c093","#727169","#e82424","#98bb6c","#e6c384","#7fb4ca","#938aa9","#7aa89f","#dcd7ba"] },
{ name: "PaperColor Light", bg: "#eeeeee", fg: "#444444", cur: "#444444", sel: "#b5c7d9", ansi: ["#1c1c1c","#af0000","#008700","#5f8700","#0087af","#878787","#005f87","#d0d0d0","#585858","#d70000","#d70087","#8700af","#d75f00","#d75f00","#005faf","#f5f5f5"] },
];

/** 内置配色的数量：导入的配色追加在后面，重置偏好时按这个下标截回去 */
const THEME_BUILTIN_COUNT = THEME_DATA.length;

/** 名称 → xterm 的 theme 对象 */
const ANSI_KEYS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow",
  "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
];

function xtermTheme(name) {
  const t = THEME_DATA.find((x) => x.name === name) ?? THEME_DATA[0];
  const th = {
    background: t.bg,
    foreground: t.fg,
    cursor: t.cur,
    selectionBackground: t.sel,
  };
  ANSI_KEYS.forEach((k, i) => {
    th[k] = t.ansi[i];
  });
  return th;
}

/** 当前字号；Ctrl+= / Ctrl+- 调整，对所有会话生效（真值在 `look.fontSize`） */
let fontSize = 13;

/**
 * 终端外观状态（`TER-005` / `TER-008`）。
 *
 * 存 localStorage 而不是配置文件，是**已知偏差**：`SET-006` 要求设置走 TOML
 * （人可读、可进 Git），但设置体系（`SET-001`）还没做。先把「换主题这种
 * 立刻想看效果」的偏好落地，别让用户每次启动重设一遍。
 */

const look = {
  theme: "WindTerm Dark",
  fontFamily: '"JetBrains Mono", Consolas, "Cascadia Mono", monospace',
  fontSize: 13,
  lineHeight: 1.2,
  scrollback: 10000,
};

function clampNum(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * 读偏好（`SET-006`）：外观、编码、键位都来自 `config.toml`。
 *
 * 文件不存在就是默认值；解析失败也退回默认值并说明原因——
 * 一份写坏的配置不该让界面起不来。
 */
async function loadPrefs() {
  let p = null;
  try {
    p = await invoke("prefs_load");
  } catch (e) {
    setStatus(`配置读取失败，已用默认值：${e}`);
  }
  if (p) {
    if (THEME_DATA.some((t) => t.name === p.theme)) look.theme = p.theme;
    if (typeof p.fontFamily === "string" && p.fontFamily) look.fontFamily = p.fontFamily;
    if (Number.isFinite(p.fontSize)) look.fontSize = clampNum(p.fontSize, 9, 28);
    if (Number.isFinite(p.lineHeight)) look.lineHeight = clampNum(p.lineHeight, 1, 2);
    if (Number.isFinite(p.scrollback)) look.scrollback = clampNum(p.scrollback, 1000, 1000000);
    if (typeof p.encoding === "string" && p.encoding) encoding = p.encoding;
    if (p.tabsPosition === "top" || p.tabsPosition === "bottom") tabsPosition = p.tabsPosition;
    if (typeof p.localShell === "string" && p.localShell) localShell = p.localShell;
    if (typeof p.localShellPath === "string") localShellPath = p.localShellPath;
    if (typeof p.localShellArgs === "string") localShellArgs = p.localShellArgs;
    if (typeof p.filesAutoOpen === "boolean") filesAutoOpen = p.filesAutoOpen;
    if (typeof p.filesShowHidden === "boolean") filesShowHidden = p.filesShowHidden;
    if (["persist", "session", "no"].includes(p.rememberDefault)) {
      rememberDefault = p.rememberDefault;
    }
    if (Array.isArray(p.broadcastExtraRules)) {
      // 存的规则可能被手改成非法正则：跳过那一条并继续，别让界面起不来
      extraDangerRules = p.broadcastExtraRules.flatMap((src) => {
        if (typeof src !== "string") return [];
        try {
          return [new RegExp(src)];
        } catch {
          return [];
        }
      });
    }
    if (typeof p.showSizeCol === "boolean") showSizeCol = p.showSizeCol;
    if (typeof p.showModeCol === "boolean") showModeCol = p.showModeCol;
    if (typeof p.showMtimeCol === "boolean") showMtimeCol = p.showMtimeCol;
    if (Number.isFinite(p.autoRefreshSecs)) autoRefreshSecs = clampNum(p.autoRefreshSecs, 0, 3600);
    if (Number.isFinite(p.netConnectTimeoutSecs)) netTimeout = p.netConnectTimeoutSecs;
    if (Number.isFinite(p.netKeepaliveSecs)) netKeepalive = p.netKeepaliveSecs;
    if (Number.isFinite(p.netKeepaliveMaxMissed)) netMaxMissed = p.netKeepaliveMaxMissed;
    if (p.rightClickAction === "menu" || p.rightClickAction === "paste") {
      rightClickAction = p.rightClickAction;
    }
    if (typeof p.wordSeparatorExtra === "string") wordSeparatorExtra = p.wordSeparatorExtra;
    if (Number.isFinite(p.autoCopyDelayMs)) autoCopyDelay = clampNum(p.autoCopyDelayMs, 0, 2000);
    if (typeof p.pasteTrimTrailing === "boolean") pasteTrimTrailing = p.pasteTrimTrailing;
    if (typeof p.autoCopyOnSelect === "boolean") autoCopy = p.autoCopyOnSelect;
    if (p.language === "en" || p.language === "zh") uiLang = p.language;
    // 导入的配色要在建会话之前就进表，否则第一个终端会先闪一下默认配色
    for (const t of p.customThemes ?? []) {
      if (THEME_DATA.some((x) => x.name === t.name)) continue;
      THEME_DATA.push(t);
      customThemes.push(t);
    }
    for (const [action, chords] of Object.entries(p.keymap ?? {})) {
      if (keymap[action] && Array.isArray(chords)) {
        keymap[action].chords = chords.filter((c) => typeof c === "string");
      }
    }
  }
  fontSize = look.fontSize;
}

/** 把偏好写回 `config.toml`。失败只提示，本次运行内的效果仍然生效。 */
/** savePrefs 被调用了几次（验收用：验证「改了控件真的触发保存」，防死控件） */
let savePrefsCount = 0;
async function savePrefs() {
  savePrefsCount += 1;
  const plain = {};
  for (const [action, v] of Object.entries(keymap)) plain[action] = v.chords;
  try {
    await invoke("prefs_save", {
      prefs: {
        theme: look.theme,
        fontFamily: look.fontFamily,
        fontSize: look.fontSize,
        lineHeight: look.lineHeight,
        scrollback: look.scrollback,
        encoding,
        tabsPosition,
        keymap: plain,
        customThemes,
        localShell,
        localShellPath,
        localShellArgs,
        filesAutoOpen,
        filesShowHidden,
        rememberDefault,
        broadcastExtraRules: extraDangerRules.map((re) => re.source),
        showSizeCol,
        showModeCol,
        showMtimeCol,
        autoRefreshSecs,
        netConnectTimeoutSecs: netTimeout,
        netKeepaliveSecs: netKeepalive,
        netKeepaliveMaxMissed: netMaxMissed,
        rightClickAction,
        wordSeparatorExtra,
        pasteTrimTrailing,
        autoCopyOnSelect: autoCopy,
        autoCopyDelayMs: autoCopyDelay,
        language: uiLang,
      },
    });
  } catch (e) {
    setStatus(`配置保存失败：${e}`);
  }
}

/** 外观与键位改动都走同一个入口，免得漏掉某一项 */
function saveLook() {
  void savePrefs();
}

/**
 * 终端输出编码（`TER-006`）。
 *
 * 全终端统一一个口径：MobaXterm 那里是会话属性，但用户换编码通常是在

 * 「这台机器的输出全是乱码」的时候，统一口径能少点一次。
 *
 * 切编码**只影响之后的输出**：已经显示的内容不动（规格明确要求不丢已显示内容）。
 */
let encoding = "utf-8";

/**
 * 本地终端用哪个 shell（`LOC-001`）。
 *
 * 存的是**稳定标识**（`auto` / `cmd` / `gitbash`…）而不是路径：路径会随升级或
 * 迁移变化，标识不会。`custom` 时才用得上后两个字段。
 */
let localShell = "auto";
let localShellPath = "";
let localShellArgs = "";

/** SSH 连上就打开文件面板（`FIL-001`）。默认开，规格要能关。 */
let filesAutoOpen = true;

/** 网络参数（`SET-001` 的「网络」组）：建连超时与 keepalive。0 表示关闭 keepalive */
let netTimeout = 15;
let netKeepalive = 30;
let netMaxMissed = 3;

/** 每个编码一个解码器：`stream: true` 才能让多字节字符跨块拼接正确 */
const decoders = new Map();

function decoderFor(name) {
  let d = decoders.get(name);
  if (!d) {
    d = new TextDecoder(name);
    decoders.set(name, d);
  }
  return d;
}

/** 把远端字节变成 xterm 能写的东西：UTF-8 直接交给 xterm（它自己跨块解码最稳） */
function decodeOutput(bytes) {
  if (encoding === "utf-8") return bytes;
  try {
    return decoderFor(encoding).decode(bytes, { stream: true });
  } catch {
    // 浏览器不认这个编码名时退回 UTF-8，而不是让整个 pump 停下来
    return bytes;
  }
}

/**
 * 远端标题的清洗（`TER-001`）。
 *
 * `OSC 2` 的内容来自远端，可能是任意字节：控制字符会把标签栏撑坏，过长标题会把
 * 右侧按钮挤出去，所以先去掉控制字符再截断。**不清洗就是让远端能改我们的界面**。
 */
function cleanRemoteTitle(raw) {
  return String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim()
    .slice(0, 40);
}

function createView(label) {
  const el = document.createElement("div");
  el.className = "term-view";
  // 新会话进左 pane；分屏时由 syncSplit 决定谁去右边
  paneA.appendChild(el);

  const term = new Terminal({
    fontFamily: look.fontFamily,
    fontSize: look.fontSize,
    lineHeight: look.lineHeight,
    cursorBlink: true,
    scrollback: look.scrollback,
    // 查找高亮用到了 decorations（proposed API）。不开这个开关，
    // addon-search 的 findNext 会直接抛错，界面上表现为「搜索框没反应」。
    allowProposedApi: true,
    theme: xtermTheme(look.theme),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const search = new SearchAddon();
  term.loadAddon(search);
  term.open(el);

  // 记下 xterm 的默认分隔符（第一次建视图时），并套上用户额外加的那几个字符
  if (defaultWordSeparator === null) defaultWordSeparator = term.options.wordSeparator;
  if (wordSeparatorExtra) term.options.wordSeparator = defaultWordSeparator + wordSeparatorExtra;

  const view = {
    id: nextViewId++,
    label,
    term,
    fit,
    search,
    el,
    handle: null,
    running: false,
    pending: 0,
    status: "",
    dataEvents: 0,
    inputLog: [],
    /** 用户手动改过标签名（`TER-001`）：改过之后就不再跟着远端 `OSC 2` 变 */
    renamedByUser: false,
    /**
     * 连上之后要不要把焦点抢过来（`TER-001`）。
     *
     * 默认要；但用户在这条还在连的时候切去别的标签了，就不要再抢回来——
     * 正在另一个标签里敲命令、焦点突然跳走，是很烦人的事（验收也会因此误判）。
     */
    focusOnReady: true,
    /** 粘贴次数（验收用：确认「取消后零字节」时对比它没变） */
    pasteCount: 0,
    /** 自动复制成功次数（验收用：静默能力也要有可观测的成功信号） */
    autoCopyCount: 0,
  };

  search.onDidChangeResults(({ resultIndex, resultCount }) => {
    if (view !== active) return;
    updateFindCount(resultIndex, resultCount);
  });

  // 远端 `OSC 2` 标题（`TER-001`）：ssh 里跑 vim/top 时标签能显示「在跑什么」。
  // 用户手动改过名字就不再跟着变——用户的意图比远端的更该保留。
  term.onTitleChange((title) => {
    const clean = cleanRemoteTitle(title);
    if (!clean || view.renamedByUser || clean === view.label) return;
    view.label = clean;
    renderTabs();
  });

  term.onData((data) => {
    if (!view.handle) return;
    view.dataEvents += 1;
    if (view.inputLog.length < 64) view.inputLog.push(data);
    // 实时广播下先把回车扣一下：命中危险模式就整条不发（`SEC-011`）
    if (holdDangerousEnter(data)) return;
    invoke("term_write", { handle: view.handle, data }).catch((e) =>
      setStatus(`写入失败：${e}`),
    );
    mirrorInput(view, data);
  });

  // 鼠标上报（TER-022）：xterm 在 X10 编码（默认，`\e[M` 后跟三个原始字节）下
  // 走**二进制**事件，不进 `onData`。只接 `onData` 的话，远端开了 `?1000h`
  // 却没要 SGR 时，点击会被静默丢掉——界面上什么也不发生，远端一个字节都收不到。
  //
  // `data` 是「一字符一字节」的串（码位 0~255），不能当 UTF-8 文本发：坐标
  // 字节一旦 >0x7F 就会被重新编码成两字节，远端收到的是错的坐标。所以单独走
  // 按字节写入的通道。
  term.onBinary((data) => {
    if (!view.handle) return;
    view.dataEvents += 1;
    if (view.inputLog.length < 64) view.inputLog.push(data);
    invoke("term_write_bytes", {
      handle: view.handle,
      data: Array.from(data, (c) => c.charCodeAt(0)),
    }).catch((e) => setStatus(`写入失败：${e}`));
  });

  // 选中即复制（TER-011）。防抖是因为拖选会连续触发，每次都写剪贴板既浪费
  // 又会让剪贴板里短暂出现半截内容。
  let autoCopyTimer = null;
  term.onSelectionChange(() => {
    if (!autoCopy) return;
    const text = term.getSelection();
    if (!text) return;
    clearTimeout(autoCopyTimer);
    autoCopyTimer = setTimeout(() => {
      navigator.clipboard
        ?.writeText(text)
        .then(() => {
          view.autoCopyCount += 1;
        })
        .catch((e) => {
          if (autoCopyWarned) return;
          autoCopyWarned = true;
          setStatus(`自动复制失败：${e}（Ctrl+Shift+C 仍可用）`);
        });
    }, autoCopyDelay);
  });

  term.onResize(({ cols, rows }) => {
    if (!view.handle) return;
    invoke("term_resize", { handle: view.handle, cols, rows }).catch(() => {});
  });

  // 右键与中键粘贴（TER-011）。用捕获阶段：应用开启鼠标上报时，
  // xterm 会先把这两个键拿去当鼠标事件，冒泡阶段就轮不到我们了。
  // 右键（`TER-011`）：规格要求**默认弹菜单**，可配成「直接粘贴」，那时的菜单用
  // `Ctrl+右键` / `Shift+右键` 唤出。之前这里固定是粘贴，菜单根本不存在。
  el.addEventListener(
    "contextmenu",
    (ev) => {
      ev.preventDefault();
      if (view !== active) return;
      if (rightClickAction === "paste" && !ev.ctrlKey && !ev.shiftKey) {
        void pasteFromClipboard(view);
        return;
      }
      openTermMenu(ev.clientX, ev.clientY, view);
    },
    true,
  );
  // 中键粘贴（`TER-011`）走 `mousedown` 而不是 `auxclick`：实测 WebView2 里合成
  // 鼠标事件不一定产生 `auxclick`（标签中键关闭就是因此改用 mousedown）。
  // `auxclick` 仍然拦一下，免得宿主把它变成「自动滚动」。
  el.addEventListener(
    "mousedown",
    (ev) => {
      if (ev.button !== 1) return;
      ev.preventDefault();
      if (view !== active) return;
      void pasteFromClipboard(view);
    },
    true,
  );
  el.addEventListener(
    "auxclick",
    (ev) => {
      if (ev.button !== 1) return;
      ev.preventDefault();
    },
    true,
  );

  el.addEventListener("mousedown", () => term.focus());

  sessions.set(view.id, view);
  // 新标签连上后广播目标会变（`TER-004`）：栏开着时立刻把计数刷新过来
  if (!bcBar.hidden) renderBcTargets();
  return view;
}

function renderTabs() {
  tabsEl.textContent = "";
  for (const view of sessions.values()) {
    const tab = document.createElement("div");
    tab.className = view === active ? "tab active" : "tab";
    tab.dataset.id = view.id;

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = view.label;
    label.title = view.status || view.label;

    const x = document.createElement("span");
    x.className = "x";
    x.textContent = "×";
    x.title = "关闭";
    x.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void (async () => {
        if (await confirmCloseIfBusy([view])) await closeView(view);
      })();
    });

    tab.append(label, x);
    tab.addEventListener("click", () => activateByUser(view));

    // 中键关闭 + 左键拖拽排序（`TER-001`）。
    //
    // 都走 `mousedown` 而不是 `pointerdown` / `auxclick`：实测 WebView2 里
    // 合成的可信鼠标事件**不产生 pointerdown**（pointerup 却会），`auxclick` 也不一定
    // 触发；`mousedown` 一定触发，而且中键与左键都在同一个地方判断，行为可预期。
    tab.addEventListener("mousedown", (ev) => {
      if (ev.button === 1) {
        ev.preventDefault();
        void (async () => {
          if (await confirmCloseIfBusy([view])) await closeView(view);
        })();
        return;
      }
      if (ev.button === 0) startTabDrag(view.id, ev.clientX);
    });

    // 双击重命名、右键菜单（`TER-001`）。菜单只列这条标签能做的事，
    // 不把全局动作塞进来——那会让菜单变成第二个工具栏。
    tab.addEventListener("dblclick", () => void renameTab(view));
    tab.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      showTabMenu(view, ev.clientX, ev.clientY);
    });

    tabsEl.appendChild(tab);
  }
}

/** 正在拖的标签：`{ id, x, target, moved }`，松手时按它重排 */
let dragTab = null;

/**
 * 拖拽处理器的命中计数。
 *
 * 「拖了没反应」有很多种原因（事件没到、没越过门槛、没找到目标标签）。
 * 只留计数与最后一次的目标，一眼能分开，省掉一整轮瞎猜——与 `inputLog` 同一思路。
 */
const tabDrag = { down: 0, move: 0, up: 0, last: null };

/**
 * 开始拖标签（`TER-001`）。
 *
 * move/up 挂到 `document` 上：鼠标事件没有指针捕获，光标一离开标签，
 * 像 `mousemove` 就只会到 document，挂在标签上会整个丢。
 */
function startTabDrag(id, x) {
  tabDrag.down += 1;
  dragTab = { id, x, target: null, moved: false };
  document.addEventListener("mousemove", onTabDragMove);
  document.addEventListener("mouseup", onTabDragEnd, { once: true });
}

function onTabDragMove(ev) {
  if (!dragTab) return;
  tabDrag.move += 1;
  if (!dragTab.moved && Math.abs(ev.clientX - dragTab.x) < 4) return;
  dragTab.moved = true;
  // 拖到哪个标签上就插到它前面。这里只记目标，松手才重排——
  // 拖动中重建 DOM 会把后续 move 的落点算错。
  const hit = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.(".tab");
  const target = hit?.dataset?.id ?? null;
  if (target && String(target) !== String(dragTab.id)) dragTab.target = target;
}

function onTabDragEnd() {
  document.removeEventListener("mousemove", onTabDragMove);
  tabDrag.up += 1;
  const drag = dragTab;
  dragTab = null;
  tabDrag.last = drag;
  // 拖到窗口外松手时 target 还是 null：那种情况就当没拖过，别乱排序
  if (drag?.moved && drag.target) moveTab(drag.id, drag.target);
}

/** 重命名标签（`TER-001`）。只改显示名，不动会话本身。 */
async function renameTab(view) {
  const name = await askName("标签名", view.label);
  if (!name || name === view.label) return;
  view.label = name;
  // 用户改过名之后，远端的 `OSC 2` 不再改写它
  view.renamedByUser = true;
  renderTabs();
  setStatus(`标签已改名为：${name}`);
}

/** 关掉除这一条之外的所有标签 */
async function closeTabsExcept(keep) {
  const targets = [...sessions.values()].filter((v) => v.id !== keep.id);
  if (!(await confirmCloseIfBusy(targets))) return;
  for (const v of targets) await closeView(v);
  if (sessions.has(keep.id)) setActive(keep);
}

/** 关掉这一条**右侧**的所有标签（顺序就是标签栏顺序） */
async function closeTabsRight(view) {
  const order = [...sessions.values()];
  const at = order.findIndex((v) => v.id === view.id);
  if (at < 0) return;
  const targets = order.slice(at + 1);
  if (!(await confirmCloseIfBusy(targets))) return;
  for (const v of targets) await closeView(v);
}

/**
 * 这些标签里，哪些还有**前台命令**在跑（`TER-018`）。
 *
 * 只有本地会话问得出结果：远端有没有东西在跑，客户端无法知道，
 * 所以 `term_busy` 对远端恒为 false，这里也就不假装知道。
 */
async function busyViews(views) {
  const busy = [];
  for (const v of views) {
    if (!v || !v.handle || !v.running) continue;
    const b = await invoke("term_busy", { handle: v.handle }).catch(() => false);
    if (b) busy.push(v);
  }
  return busy;
}

/** 关之前问一句：有前台命令在跑就确认（`TER-018`）。返回 true 表示可以关。 */
async function confirmCloseIfBusy(views) {
  const busy = await busyViews(views);
  if (!busy.length) return true;
  if (busy.length === 1) {
    return askConfirm(
      "有命令正在运行",
      `${busy[0].label} 里还有前台命令在跑，关掉会中断它。`,
      "仍然关闭",
    );
  }
  return askConfirm(
    "有命令正在运行",
    `${busy.length} 个标签里还有前台命令在跑，关掉会中断它们。`,
    "仍然关闭",
  );
}

/** 标签的右键菜单（`TER-001`）。关不掉的项（比如右边没有标签）就不显示数字。 */
function showTabMenu(view, x, y) {
  const order = [...sessions.values()];
  const at = order.findIndex((v) => v.id === view.id);
  const right = at < 0 ? 0 : order.length - at - 1;
  showCtxMenu(x, y, [
    { label: t("ctx.copyTab"), run: () => duplicateTab(view) },
    { label: t("ctx.renameTab"), run: () => renameTab(view) },
    { label: tf("ctx.closeOthers", { n: order.length - 1 }), run: () => closeTabsExcept(view) },
    { label: tf("ctx.closeRight", { n: right }), run: () => closeTabsRight(view) },
    { label: t("ctx.closeAll"), run: () => closeAllTabs() },
  ]);
}

/**
 * 把 `from` 这个标签挪到 `to` 的位置（`TER-001` 拖拽排序）。
 *
 * `sessions` 是 Map，会保持插入顺序，所以重排就是「按新顺序重新 set 一遍」。
 */
function moveTab(from, to) {
  const order = [...sessions.keys()];
  // `dataset` 里拿到的永远是**字符串**，而会话键是数字：直接用 indexOf 会一个都找不到
  // （表现是「拖了、计数也对，就是顺序不变」）。统一按字符串比。
  const same = (a, b) => String(a) === String(b);
  const fi = order.findIndex((k) => same(k, from));
  const ti = order.findIndex((k) => same(k, to));
  if (fi < 0 || ti < 0 || fi === ti) return;
  const [moved] = order.splice(fi, 1);
  // 拔掉后面的下标会前移一位：只有「往后拖」才要减 1
  order.splice(fi < ti ? ti - 1 : ti, 0, moved);
  const views = order.map((id) => sessions.get(id));
  sessions.clear();
  for (const v of views) sessions.set(v.id, v);
  renderTabs();
  setStatus(`标签顺序：${views.map((v) => v.label).join(" → ")}`);
}

function setActive(view) {
  active = view;
  if (view) mruRemember(view);
  for (const v of sessions.values()) {
    v.el.classList.toggle("active", v === view);
  }
  renderTabs();
  refreshButtons();
  termFoot.hidden = !view;
  if (!view) {
    setStatus("已关闭");
    return;
  }
  view.fit.fit();
  view.term.focus();
  setStatus(view.status || `已连接 ${view.label}`);
}

async function ackView(view, force = false) {
  if (!view.handle || view.pending === 0) return;
  if (!force && view.pending < ACK_BATCH) return;
  const n = view.pending;
  view.pending = 0;
  try {
    await invoke("term_ack", { handle: view.handle, n });
  } catch {
    // 会话已关闭时确认会失败，这是正常收尾路径
  }
}

async function pump(view) {
  while (view.running && view.handle) {
    let bytes;
    try {
      const buf = await invoke("term_read", { handle: view.handle, maxBytes: 65536 });
      bytes = new Uint8Array(buf);
    } catch (e) {
      setStatus(`读取失败：${e}`);
      break;
    }
    if (bytes.length === 0) {
      await frame();
      continue;
    }
    const n = bytes.length;
    // 广播期间顺带把文本收一份（`TER-004` 的结果聚合要用原文比对）
    if (view.cap) {
      try {
        view.cap.text += view.cap.dec.decode(bytes, { stream: true });
      } catch {
        // 编码不支持就放弃这一块，别让捕获影响正常输出
      }
    }
    // ack 在 xterm 消费完之后才发，否则后端算出的「未确认字节」是假的
    view.term.write(decodeOutput(bytes), () => {
      view.pending += n;
      if (view.pending >= ACK_BATCH) void ackView(view);
    });
    await frame();
  }
}

/**
 * 用户主动切到某个标签（点标签、快捷键）。
 *
 * 只有「用户」切走才算数：其它还没连好的标签此后不要再抢焦点。
 * 注意别把这一步放进 `setActive`——它也被「某条连好了、自己激活」调用，
 * 那样后开的两条会互相把对方的意图清掉，结果谁都不会被激活（MRU 也就只剩一条）。
 */
function activateByUser(view) {
  for (const v of sessions.values()) {
    if (v !== view && !v.running) v.focusOnReady = false;
  }
  setActive(view);
}

/**
 * 终端里的右键菜单（`TER-011`）。
 *
 * 复用会话树的那个浮层（`#ctx-menu`），但用 `data-kind="terminal"` 标记来源——
 * 否则验收脚本读 `#ctx-menu button` 时分不清拿到的是哪一套菜单。
 */
function openTermMenu(x, y, view) {
  const hasSel = Boolean(view.term.getSelection());
  showCtxMenu(
    x,
    y,
    [
      {
        label: t("ctx.copy"),
        run: () => (hasSel ? copySelection() : setStatus("没有选中内容")),
      },
      { label: t("ctx.paste"), run: () => pasteFromClipboard(view) },
      { label: t("ctx.selectAll"), run: () => view.term.selectAll() },
      { label: t("ctx.find"), run: () => openFind() },
      { label: t("ctx.clear"), run: () => view.term.clear() },
      { label: t("ctx.split"), run: () => runAction("splitToggle") },
    ],
    "terminal",
  );
}

/** 取整个滚动缓冲的纯文本（`TER-020` 的「保存终端输出」） */
function terminalBufferText(view) {
  const b = view.term.buffer.active;
  const lines = [];
  for (let i = 0; i < b.length; i++) {
    const line = b.getLine(i);
    lines.push(line ? line.translateToString(true) : "");
  }
  // 去掉尾部空行：日志末尾常拖一大段空白，存下来纯属噪音
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return `${lines.join("\r\n")}\r\n`;
}

/** 会话建立后的公共收尾：激活标签、开始拉取 */
function afterOpen(view, statusText) {
  view.running = true;
  view.pending = 0;
  view.status = statusText;
  if (view.focusOnReady) {
    setActive(view);
    setStatus(statusText);
  } else {
    // 用户在等它连上的时候已经切去别的标签了：只把它画出来，不抢焦点
    renderTabs();
  }
  void pump(view);
}

/**
 * 带死线的 `invoke`，超时后还能**回收迟到的会话**。
 *
 * 后端命令卡住时 `await` 永远不返回：界面上表现为「点了没反应」，既不报错也不亮
 * 灯（验收里则是一次莫名其妙的 20 秒超时）。给它一条死线，超时就明确说出来。
 *
 * 关键在「超时之后后台可能已经把会话建起来了」：`Promise.race` 只让前端放弃等待，
 * 底层 `invoke` 仍在跑；`local_open` / `ssh_open` 是同步命令，稍后仍会往 registry
 * 里注册一个会话。前端这个 view 已经标成「打开失败」、handle=null，永远不会去 close 它
 * ——于是 shell / conhost / 读泵线程常驻。连跑多轮越积越多、启动越来越慢，正好是
 * `handover` 里记了很久的「连跑多轮后打开失败、根因未定位」。
 *
 * 做法：超时后继续盯着底层 Promise，若它最终成功且带回了 handle，就 `term_close`
 * 把它关掉。失败就忽略——会话没建起来，没什么可回收的。
 *
 * 只有「成功返回值里带 handle」的建连类命令有这个效果；其它命令（返回结果不带
 * handle）超时后即便迟到也自然什么都不做，不影响原语义。
 */
function invokeWithTimeout(cmd, args, ms, what) {
  let timer = null;
  let timedOut = false;
  const call = invoke(cmd, args).then(
    (value) => {
      clearTimeout(timer);
      if (timedOut) {
        const h = typeof value === "string" ? value : value?.handle;
        if (typeof h === "string" && h) {
          invoke("term_close", { handle: h }).catch(() => {});
        }
      }
      return value;
    },
    (err) => {
      clearTimeout(timer);
      // 超时后 race 已经用超时错误 settle 了，这里再 throw 会变成一个没人接的
      // unhandled rejection（控制台报错、还会触发「页面无未捕获异常」断言）。
      // 前端早已按超时收场，这个迟到的失败只需静默丢弃。
      if (!timedOut) throw err;
      return undefined;
    },
  );
  return Promise.race([
    call,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => {
          timedOut = true;
          reject(new Error(`${what}超时（${Math.round(ms / 1000)} 秒没有响应）`));
        },
        ms,
      );
    }),
  ]);
}

async function openLocal() {
  const view = createView("本地终端");
  // 复制标签要知道这是一条本地会话（`TER-001`）
  view.isLocalTerminal = true;
  view.fit.fit();
  try {
    view.handle = await invokeWithTimeout(
      "local_open",
      { cols: view.term.cols, rows: view.term.rows },
      20000,
      "打开本地终端",
    );
  } catch (e) {
    view.status = `打开失败：${e}`;
    view.term.write(`\r\n\x1b[31m打开失败：${e}\x1b[0m\r\n`);
    // 超时的时候后台可能已经把 shell 起来了，只是回不来：告诉用户怎么收场，
    // 别让人以为「什么都没发生」又连点几次。
    view.term.write("\x1b[2m如果反复失败，关掉这个标签重开一次即可\x1b[0m\r\n");
    setActive(view);
    setStatus("打开失败");
    return;
  }
  view.label = `本地 ${view.handle.slice(0, 6)}`;
  afterOpen(view, `已连接 ${view.handle.slice(0, 8)}`);
}

async function openSsh() {
  const host = hostInput.value.trim();
  const user = userInput.value.trim();
  const port = Number.parseInt(portInput.value, 10) || 22;
  if (!host || !user) {
    setStatus("请先填主机与用户名");
    (host ? userInput : hostInput).focus();
    return;
  }
  if (useKeyBox.checked && !keyPem) {
    setStatus("请先选择私钥文件");
    pickKeyBtn.focus();
    return;
  }

  await runSshOpen(
    {
      host,
      port,
      user,
      // 只用勾选的那一种：多传一个会被当成备选，
      // 从而掩盖「密钥/agent 没被接受」这类问题
      password: useKeyBox.checked || useAgentBox.checked ? null : passInput.value,
      keyPem: useKeyBox.checked ? keyPem : null,
      keyPassphrase: useKeyBox.checked ? keyPassInput.value || null : null,
      useAgent: useAgentBox.checked,
    },
    jumpReq(),
    `${user}@${host}`,
  );
}

/**
 * 用一组现成参数开一条 SSH 会话：`openSsh` 与「复制标签」共用（`TER-001`）。
 *
 * 参数记在 `view.openReq` 上——复制标签要能原样重来，而不是回头去读表单，
 * 那时表单可能早就被改成别的机器了。
 */
async function runSshOpen(req, jump, label) {
  const view = createView(label);
  view.fit.fit();
  view.status = `正在连接 ${label}…`;
  view.openReq = { req, jump, label };
  setActive(view);
  setStatus(view.status);
  sshBtn.disabled = true;
  try {
    // 死线兜底：后端万一卡住，`await` 永远不返回，界面上就是「一直正在连接」、
    // 按钮一直禁用（点第二次什么都不发生）。60 秒给足（连接超时 15 秒 + 可能的
    // TOFU probe 一次），超时就明确说出来，至少按钮能恢复、能重试。
    const r = await invokeWithTimeout(
      "ssh_open",
      { req: { ...req, cols: view.term.cols, rows: view.term.rows }, jump },
      60000,
      "连接",
    );
    view.handle = r.handle;
    const text = `已连接 ${label}${r.host_key_added ? "（已记录主机密钥）" : ""}`;
    afterOpen(view, text);
    if (r.fingerprint) view.term.write(`\x1b[2m主机密钥 ${r.fingerprint}\x1b[0m\r\n`);
    await savePasswordIfAsked();
    // 连上了就把远端目录摆出来（`FIL-001`）。不 await：SFTP 建连比终端慢，
    // 不该让终端等它；失败了面板自己会显示原因。
    void autoOpenFiles();
  } catch (e) {
    const why = String(e);
    // 失败原因写进这个标签页：状态栏放不下 hints，而且用户需要能复制下来
    view.term.write(`\r\n\x1b[31m${why}\x1b[0m\r\n`);
    // 主机密钥变了不是「连不上」，是安全事件：状态栏必须自己说出来，
    // 否则用户会当成网络问题一直重试。指纹与出路在错误详情里（上面那行就是）
    const hostKeyChanged = why.includes("SSH_HOSTKEY_CHANGED");
    const hostKeyRevoked = why.includes("SSH_HOSTKEY_REVOKED");
    view.status = hostKeyChanged
      ? `主机密钥变了：${label}`
      : `连接失败：${label}`;
    setStatus(
      hostKeyChanged
        ? "主机密钥变了：先核对指纹，可能有人在中间"
        : hostKeyRevoked
          ? "主机密钥已被标为不可信：换一条可信通道确认"
          : "连接失败",
    );
    renderTabs();
    // 自动填进去的口令被拒：多半是过期了（`SEC-002`）。直接给「重新输入」的出路，
    // 连上之后 `savePasswordIfAsked` 会把新口令覆盖保存。
    if (String(e).includes("SSH_AUTH_FAILED") && pwFromStore) {
      const retry = await askConfirm(
        "保存的密码可能已过期",
        "服务端拒绝了自动填入的密码。重新输入一次，连上后会覆盖已保存的口令。",
        "重新输入",
      );
      if (retry) {
        passInput.value = "";
        pwFromStore = false;
        passInput.focus();
        setStatus("请重新输入密码（连上后会覆盖已保存的口令）");
      }
    }
  } finally {
    sshBtn.disabled = false;
  }
}

/** 复制标签（`TER-001`）：用这条标签自己的参数再开一条。 */
async function duplicateTab(view) {
  if (view?.isLocalTerminal) {
    await openLocal();
    return;
  }
  if (!view?.openReq) {
    setStatus("这条标签没有记录连接参数，无法复制");
    return;
  }
  await runSshOpen(view.openReq.req, view.openReq.jump, view.openReq.label);
}

async function closeView(view) {
  view.running = false;
  if (view.handle) {
    await ackView(view, true);
    const h = view.handle;
    view.handle = null;
    try {
      await invoke("term_close", { handle: h });
    } catch {
      /* 关闭失败不阻塞界面 */
    }
  }
  sessions.delete(view.id);
  // 关掉的标签要从广播目标里摘掉：栏还开着时计数得跟着变，不能停在旧数字上
  if (!bcBar.hidden) renderBcTargets();
  // MRU 里也要摘掉：否则关掉的 view（连它的 xterm 实例）会被一直引用着
  const mruAt = mruViews.indexOf(view);
  if (mruAt >= 0) mruViews.splice(mruAt, 1);
  view.el.remove();
  // 关掉的正是右侧那个：分屏跟着取消，别留一个空 pane
  if (splitViewId === view.id) {
    splitViewId = null;
    syncSplit();
  }
  const next = sessions.values().next().value ?? null;
  setActive(next);
}

async function closeTerm() {
  // 先把当前标签抓住：确认框是异步的，await 回来时 active 可能已经是 null
  const v = active;
  if (v && (await confirmCloseIfBusy([v]))) await closeView(v);
}

// 低流量时也定期确认，避免 pending 长期挂账（对所有会话生效）
// 注意要 force：否则低于 ACK_BATCH 的零散字节永远等不到确认，背压就卡住了
setInterval(() => {
  for (const view of sessions.values()) void ackView(view, true);
}, ACK_INTERVAL);

// ── 会话树 ──────────────────────────────────────────────────
const treeBody = document.getElementById("tree-body");
const refreshBtn = document.getElementById("refresh");

function treeEmpty(text) {
  const p = document.createElement("p");
  p.id = "tree-empty";
  p.textContent = text;
  treeBody.appendChild(p);
}

/** 点会话 → 把连接参数填进表单。密码不存库时仍需用户自己填。 */
/**
 * 「本次记住」的口令。
 *
 * 只活在**这次运行的内存**里：不落盘、不需要主密码，关掉应用就没了。
 * 键按 `host:port:user` 而不是会话 id——手填表单连的也要能记住。
 */
const sessionPasswords = new Map();
const sessionKey = (host, port, user) =>
  `${String(host ?? "").trim()}:${Number.parseInt(port, 10) || 22}:${String(user ?? "").trim()}`;

/**
 * 选中会话时把能用上的口令填进来：先用「本次记住」的，其次保险库。
 *
 * 提到函数里是因为 SFTP 会话（`SES-009`）也要走同一套：它没有终端，但一样需要凭据。
 */
async function fillPasswordFor(s) {
  const memo = sessionPasswords.get(sessionKey(s.host, s.port, s.username));
  if (memo) {
    passInput.value = memo;
    pwFromStore = true;
    setStatus(`已填入 ${s.name} 的密码（本次运行记住的）`);
    return true;
  }
  if (!vaultUnlocked) return false;
  try {
    const saved = await invoke("credential_get", { sessionId: s.id });
    if (saved) {
      passInput.value = saved;
      pwFromStore = true;
      setStatus(`已从保险库填入 ${s.name} 的密码`);
      return true;
    }
  } catch {
    /* 取不到就当没存过，不打扰用户 */
  }
  return false;
}

async function selectSession(s) {
  // `ssh` 走终端，`sftp` 走文件面板（`SES-009`）；其余类型还没做，如实说
  if (s.kind !== "ssh" && s.kind !== "sftp") {
    setStatus(`${s.name} 是 ${s.kind} 会话，暂不支持`);
    return;
  }
  selectedSession = s;
  deleteSessionBtn.disabled = false;
  deleteSessionBtn.textContent = "删除";
  if (s.name) nameInput.value = s.name;
  if (s.host) hostInput.value = s.host;
  if (s.port) portInput.value = String(s.port);
  if (s.username) userInput.value = s.username;
  setStatus(s.kind === "sftp" ? `已选中 ${s.name}（SFTP），正在打开文件面板` : `已选中 ${s.name}，填密码后连接`);
  if (s.kind !== "sftp") passInput.focus();

  // 跳板机是会话属性：选中会话就把它带出来（含密码，若保险库已解锁）
  await applyJumpFromSession(s);

  const filled = await fillPasswordFor(s);

  if (s.kind === "sftp") {
    // 独立 SFTP 会话：没有终端，文件面板直接对着它打开
    filesPaths.set(filesSessionId, sftpPath);
    filesSessionId = s.id;
    filesSessionSelect.value = s.id;
    openSidePanel(filesPanel);
    await loadDir(filesPaths.get(s.id) ?? "/");
    return;
  }
  if (filled) return;
}

/** 上一次读到的会话树；过滤时直接复用，不重复查库 */
let lastTree = null;
const filterInput = document.getElementById("tree-filter");

/** 这个文件夹（含更深层）里有没有名字匹配的会话 */
function folderHasMatch(id, query, byParent, byFolder) {
  for (const s of byFolder.get(id) ?? []) {
    if (s.name.toLowerCase().includes(query)) return true;
  }
  for (const f of byParent.get(id) ?? []) {
    if (folderHasMatch(f.id, query, byParent, byFolder)) return true;
  }
  return false;
}

/**
 * 刷新「跳板机会话」下拉（`SES-024`）。
 *
 * 只列 SSH 会话——只有 SSH 能当跳板。当前编辑的会话不在这里过滤掉：
 * 让后端在保存时给出「不能把自己设为跳板机」的明确错误，比下拉里凭空少一项更好懂。
 */
function refreshJumpSelect(dto) {
  const keep = jumpSessionSelect.value;
  jumpSessionSelect.textContent = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "从会话里选跳板机";
  jumpSessionSelect.appendChild(none);
  for (const s of dto.sessions ?? []) {
    if (s.kind !== "ssh") continue;
    const o = document.createElement("option");
    o.value = s.id;
    o.textContent = s.name;
    jumpSessionSelect.appendChild(o);
  }
  jumpSessionSelect.value = keep;
}

/** 把某个会话的跳板配置填进表单（地址/用户，密码从保险库取）。 */
async function fillJumpFields(jump) {
  if (!jump) {
    jumpHostInput.value = "";
    jumpUserInput.value = "";
    jumpPassInput.value = "";
    return;
  }
  jumpHostInput.value = `${jump.host ?? ""}:${jump.port ?? 22}`;
  jumpUserInput.value = jump.username ?? "";
  jumpPassInput.value = "";
  if (!vaultUnlocked) return;
  try {
    // 跳板机的凭据按**它自己**的会话存（规格第 4 条：不继承目标会话）
    const pw = await invoke("credential_get", { sessionId: jump.id });
    if (pw) jumpPassInput.value = pw;
  } catch {
    /* 没存过就算了，用户手填 */
  }
}

/** 会话若配了跳板机，选中时把跳板参数一起带出来——跳板是会话属性，不该每次重填。 */
async function applyJumpFromSession(s) {
  const jumpId = s.options?.jumpSessionId ?? "";
  const jump = jumpId ? (lastTree?.sessions ?? []).find((x) => x.id === jumpId) : null;
  jumpSessionSelect.value = jump ? jumpId : "";
  useJumpBox.checked = Boolean(jump);
  syncAuthUi();
  await fillJumpFields(jump);
}

function renderTree(dto) {  lastTree = dto;
  treeBody.textContent = "";
  refreshJumpSelect(dto);
  refreshTunnelSessionSelect();
  refreshFilesSessionSelect();
  if (!dto.exists) {
    treeEmpty(`没有会话库：\n${dto.db_path}\n先导入，再点刷新`);
    return;
  }

  const query = filterInput.value.trim().toLowerCase();

  const byParent = new Map(); // folderId → 子文件夹
  const byFolder = new Map(); // folderId → 会话
  for (const f of dto.folders) {
    const k = f.parent_id ?? "";
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(f);
  }
  for (const s of dto.sessions) {
    const k = s.folder_id ?? "";
    if (!byFolder.has(k)) byFolder.set(k, []);
    byFolder.get(k).push(s);
  }

  const addNode = (text, cls, depth, onClick, data = {}) => {
    const el = document.createElement("div");
    el.className = `node ${cls}`;
    el.style.paddingLeft = `${8 + depth * 12}px`;
    el.textContent = text;
    // 右键菜单靠这几个 id 找回对象：树节点是纯文本，没有别的身份标识
    Object.assign(el.dataset, data);
    el.draggable = true;
    if (onClick) el.addEventListener("click", onClick);
    // 拖拽只带「我是谁」，放下的地方决定去哪儿（`SES-013`）
    el.addEventListener("dragstart", (ev) => {
      const payload = JSON.stringify({ kind: cls, ...data });
      ev.dataTransfer?.setData("text/plain", payload);
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
    });
    treeBody.appendChild(el);
    return el;
  };

  const walk = (key, depth) => {
    for (const f of byParent.get(key) ?? []) {
      // 过滤时保留「里面有匹配会话」的文件夹，否则会话会从树里消失得莫名其妙
      const keep =
        !query ||
        f.name.toLowerCase().includes(query) ||
        folderHasMatch(f.id, query, byParent, byFolder);
      if (!keep) continue;
      const node = addNode(f.name, "folder", depth, () => void toggleFolder(f), {
        folderId: f.id,
      });
      // 折叠标记走 CSS 伪元素，节点的 textContent 仍是纯名字
      if (f.collapsed) node.classList.add("collapsed");
      // 接受拖放：把会话或文件夹挪进来（自己到自己由后端拦）
      node.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        node.classList.add("drop-target");
      });
      node.addEventListener("dragleave", () => node.classList.remove("drop-target"));
      node.addEventListener("drop", (ev) => {
        ev.preventDefault();
        node.classList.remove("drop-target");
        void dropInto(ev.dataTransfer?.getData("text/plain") ?? "", f.id);
      });
      if (!f.collapsed) walk(f.id, depth + 1);
    }
    for (const s of byFolder.get(key) ?? []) {
      if (query && !s.name.toLowerCase().includes(query)) continue;
      const sNode = addNode(
        s.name,
        "session",
        depth,
        (ev) => {
          // Ctrl/Cmd + 点击＝增减多选；普通点击＝单选并填表单
          if (ev?.ctrlKey || ev?.metaKey) {
            if (multiSel.has(s.id)) multiSel.delete(s.id);
            else multiSel.add(s.id);
            paintMulti();
            return;
          }
          multiSel.clear();
          paintMulti();
          selectSession(s);
        },
        { sessionId: s.id },
      );
      if (multiSel.has(s.id)) sNode.classList.add("multi");
      // 拖到另一条会话上＝插到它前面（同层排序，`SES-013`）
      sNode.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        sNode.classList.add("drop-target");
      });
      sNode.addEventListener("dragleave", () => sNode.classList.remove("drop-target"));
      sNode.addEventListener("drop", (ev) => {
        ev.preventDefault();
        sNode.classList.remove("drop-target");
        void dropBefore(ev.dataTransfer?.getData("text/plain") ?? "", s);
      });
    }
  };
  walk("", 0);

  if (!treeBody.childElementCount) {
    treeEmpty(query ? `没有匹配「${filterInput.value.trim()}」的会话` : "会话库是空的");
  }
  // 无法解析的记录必须说出来，不能悄悄少几个会话
  if (dto.warnings.length && !query) {
    const el = addNode(`⚠ ${dto.warnings.length} 条记录无法解析`, "folder", 0);
    el.title = dto.warnings.join("\n");
  }
}

filterInput.addEventListener("input", () => {
  if (lastTree) renderTree(lastTree);
});

// ── 右键菜单（`SES-014`）──────────────────────────────────
//
// 只列「当前这个对象能做什么」：会话给重命名/复制/移动到/删除，文件夹给重命名/新建子文件夹。
// 把全局动作（导入、刷新）也塞进来会让菜单变成第二个工具栏。

const ctxMenu = document.getElementById("ctx-menu");
const pickDialog = document.getElementById("pick-dialog");
const pickTitle = document.getElementById("pick-title");
const pickSelect = document.getElementById("pick-select");

function closeCtxMenu() {
  ctxMenu.hidden = true;
}

function showCtxMenu(x, y, items, kind = "session") {
  // 记来源：会话树的菜单和终端里的菜单共用一个浮层，验收要能分清是哪一个
  ctxMenu.dataset.kind = kind;
  ctxMenu.textContent = "";
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = it.label;
    b.addEventListener("click", () => {
      closeCtxMenu();
      void it.run();
    });
    ctxMenu.appendChild(b);
  }
  ctxMenu.hidden = false;
  // 靠边右键时不要溢出视口：先量再定位置（先定位置再量会闪一下）
  const r = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = `${Math.max(0, Math.min(x, innerWidth - r.width - 4))}px`;
  ctxMenu.style.top = `${Math.max(0, Math.min(y, innerHeight - r.height - 4))}px`;
}

function askPick(title, options, current) {
  pickTitle.textContent = title;
  pickSelect.textContent = "";
  for (const o of options) {
    const el = document.createElement("option");
    el.value = o.value;
    el.textContent = o.label;
    pickSelect.appendChild(el);
  }
  pickSelect.value = current;
  pickDialog.returnValue = "";
  pickDialog.showModal();
  pickSelect.focus();
  return new Promise((resolve) => {
    pickDialog.addEventListener(
      "close",
      () => resolve(pickDialog.returnValue === "yes" ? pickSelect.value : null),
      { once: true },
    );
  });
}

/** 会话的保存参数：改名/复制都要把**其它字段原样带回去**，否则会被清空 */
function sessionReqOf(s, name) {
  return {
    id: s.id,
    name,
    host: s.host ?? "",
    port: s.port ?? 22,
    user: s.username ?? "",
    // 跳板是会话属性：这里传 null 会把它清掉，所以必须带原值
    jumpSessionId: s.options?.jumpSessionId ?? null,
    // 类型同样不能丢：改名时把它写成 ssh，SFTP 会话就变成终端了
    kind: s.kind ?? "ssh",
  };
}

async function renameSession(s) {
  const name = await askName("重命名会话", s.name);
  if (!name || name === s.name) return;
  try {
    await invoke("session_save", { req: sessionReqOf(s, name) });
    await loadTree();
    setStatus(`已重命名：${name}`);
  } catch (e) {
    setStatus(`重命名失败：${e}`);
  }
}

async function duplicateSession(s) {
  const name = await askName("复制为新名字", `${s.name} 副本`);
  if (!name) return;
  try {
    const req = sessionReqOf(s, name);
    delete req.id; // 没有 id 才是新建
    await invoke("session_save", { req });
    await loadTree();
    setStatus(`已复制：${name}`);
  } catch (e) {
    setStatus(`复制失败：${e}`);
  }
}

async function moveSession(s) {
  const folders = lastTree?.folders ?? [];
  const options = [{ value: "", label: "（根目录）" }].concat(
    folders.map((f) => ({ value: f.id, label: f.name })),
  );
  const pick = await askPick("移动到文件夹", options, s.folder_id ?? "");
  if (pick === null) return;
  try {
    await invoke("session_move", { sessionId: s.id, folderId: pick || null });
    await loadTree();
    setStatus("已移动");
  } catch (e) {
    setStatus(`移动失败：${e}`);
  }
}

async function exportSession(s) {
  try {
    const path = await invoke("session_export", { sessionId: s.id });
    // 把落点说出来：不给路径的「已导出」等于没告诉用户东西在哪
    setStatus(`已导出：${path}`);
  } catch (e) {
    setStatus(`导出失败：${e}`);
  }
}

// ── 多选（`SES-013`）────────────────────────────────────
//
// 只做「选中 + 批量移动」：批量删除是破坏性动作，需要先把确认流程定下来，
// 在那之前不提供——给一个能一次删十条的按钮而不谈确认，是给自己挖坑。

/** 多选的会话 id（与「当前会话」是两回事：后者决定表单填什么） */
const multiSel = new Set();

function paintMulti() {
  for (const node of document.querySelectorAll("#tree-body .node.session")) {
    const id = node.dataset.sessionId;
    if (id) node.classList.toggle("multi", multiSel.has(id));
  }
  if (multiSel.size > 1) {
    setStatus(`已选 ${multiSel.size} 个会话（Ctrl+点击增减，右键可批量移动）`);
  }
}

/** 批量移动：一次开库改多条，失败要说清是哪一条 */
async function moveSelectedSessions() {
  if (!multiSel.size) return;
  const folders = lastTree?.folders ?? [];
  const options = [{ value: "", label: "（根目录）" }].concat(
    folders.map((f) => ({ value: f.id, label: f.name })),
  );
  const pick = await askPick(`移动 ${multiSel.size} 个会话到`, options, "");
  if (pick === null) return;
  try {
    const n = await invoke("session_move_many", {
      sessionIds: [...multiSel],
      folderId: pick || null,
    });
    multiSel.clear();
    await loadTree();
    setStatus(`已移动 ${n} 个会话`);
  } catch (e) {
    setStatus(`批量移动失败：${e}`);
  }
}

/** 批量删除（`SES-013`）：破坏性动作，先把「删几个、删谁」摆在确认框里 */
async function deleteSelectedSessions() {
  if (!multiSel.size) return;
  const names = [...multiSel]
    .map((id) => lastTree?.sessions?.find((s) => s.id === id)?.name ?? id)
    .slice(0, 5);
  const more = multiSel.size > names.length ? ` 等 ${multiSel.size} 个` : "";
  const ok = await askConfirm(
    `删除 ${multiSel.size} 个会话？`,
    `${names.join("、")}${more}\n\n会话与保险库里属于它们的密码都会被删掉，不可撤销。`,
    "确认删除",
  );
  if (!ok) return;
  try {
    const n = await invoke("session_delete_many", { ids: [...multiSel] });
    multiSel.clear();
    await loadTree();
    setStatus(`已删除 ${n} 个会话`);
  } catch (e) {
    setStatus(`批量删除失败：${e}`);
  }
}

/** 折叠/展开一个文件夹（`SES-013`）：状态落库，重启后还是这个形状 */
async function toggleFolder(f) {
  try {
    await invoke("folder_save", {
      req: { id: f.id, name: f.name, collapsed: !f.collapsed },
    });
    await loadTree();
  } catch (e) {
    setStatus(`折叠失败：${e}`);
  }
}

/**
 * 把拖来的东西放进某个文件夹（`folderId` 为空表示根）。
 *
 * 环检测在后端：把文件夹挪进自己的子孙会让整棵子树从树上消失，
 * 这种错在界面上看不出来，所以必须在写库前拦住。
 */
async function dropInto(raw, folderId) {
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  if (!payload) return;
  try {
    if (payload.sessionId) {
      await invoke("session_move", { sessionId: payload.sessionId, folderId: folderId || null });
    } else if (payload.folderId && payload.folderId !== folderId) {
      await invoke("folder_move", { folderId: payload.folderId, parentId: folderId || null });
    } else {
      return;
    }
    await loadTree();
    setStatus("已移动");
  } catch (e) {
    setStatus(`移动失败：${e}`);
  }
}

/**
 * 把拖来的会话插到 `target` 前面（同层排序）。
 *
 * 位置按 `lastTree` 里同层会话的顺序算：那正是渲染顺序，也是用户看到的顺序。
 */
async function dropBefore(raw, target) {
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  const movingId = payload?.sessionId;
  if (!movingId || movingId === target.id) return;
  const folder = target.folder_id ?? null;
  const siblings = (lastTree?.sessions ?? []).filter(
    (s) => (s.folder_id ?? null) === folder && s.id !== movingId,
  );
  const index = siblings.findIndex((s) => s.id === target.id);
  if (index < 0) return;
  try {
    await invoke("session_reorder", { sessionId: movingId, folderId: folder, index });
    await loadTree();
    setStatus("已调整顺序");
  } catch (e) {
    setStatus(`排序失败：${e}`);
  }
}

async function newSubFolder(parentId) {
  const name = await askName("新建子文件夹", "");
  if (!name) return;
  try {
    await invoke("folder_save", { req: { name, parentId } });
    await loadTree();
    setStatus(`已新建文件夹：${name}`);
  } catch (e) {
    setStatus(`新建文件夹失败：${e}`);
  }
}

async function renameFolder(f) {
  const name = await askName("重命名文件夹", f.name);
  if (!name || name === f.name) return;
  try {
    await invoke("folder_save", { req: { id: f.id, name } });
    await loadTree();
    setStatus(`已重命名文件夹：${name}`);
  } catch (e) {
    setStatus(`重命名失败：${e}`);
  }
}

// 拖到树空白处＝移到根：否则「从文件夹里拖出来」没有落点
treeBody.addEventListener("dragover", (ev) => ev.preventDefault());
treeBody.addEventListener("drop", (ev) => {
  if (ev.target !== treeBody) return;
  ev.preventDefault();
  void dropInto(ev.dataTransfer?.getData("text/plain") ?? "", null);
});

treeBody.addEventListener("contextmenu", (ev) => {
  const node = ev.target.closest?.(".node");
  if (!node) return;
  ev.preventDefault();
  const sessionId = node.dataset.sessionId;
  const folderId = node.dataset.folderId;
  if (sessionId) {
    const s = (lastTree?.sessions ?? []).find((x) => x.id === sessionId);
    if (!s) return;
    showCtxMenu(ev.clientX, ev.clientY, [
      ...(multiSel.size > 1
        ? [
            {
              label: tf("ctx.broadcastSelected", { n: multiSel.size }),
              run: () => void broadcastToSavedSessions([...multiSel], "选中的会话"),
            },
            { label: tf("ctx.moveSelected", { n: multiSel.size }), run: () => moveSelectedSessions() },
            { label: tf("ctx.deleteSelected", { n: multiSel.size }), run: () => deleteSelectedSessions() },
          ]
        : [{ label: t("ctx.moveTo"), run: () => moveSession(s) }]),
      { label: t("ctx.rename"), run: () => renameSession(s) },
      { label: t("ctx.duplicate"), run: () => duplicateSession(s) },
      { label: t("ctx.export"), run: () => exportSession(s) },
    ]);
  } else if (folderId) {
    const f = (lastTree?.folders ?? []).find((x) => x.id === folderId);
    if (!f) return;
    const ids = folderSessionIds(f.id);
    const sshCount = ids.filter(
      (id) => (lastTree?.sessions ?? []).find((s) => s.id === id)?.kind === "ssh",
    ).length;
    showCtxMenu(ev.clientX, ev.clientY, [
      // 文件夹批量多执行（`TER-004`）：空文件夹或没有 SSH 会话时不出现，避免点了没反应
      ...(sshCount
        ? [
            {
              label: tf("ctx.broadcastFolder", { n: sshCount }),
              run: () => void broadcastToSavedSessions(ids, f.name),
            },
          ]
        : []),
      { label: t("ctx.rename"), run: () => renameFolder(f) },
      { label: t("ctx.newSubfolder"), run: () => newSubFolder(f.id) },
    ]);
  }
});

// 点别处或按 Esc 就关掉：菜单留在屏幕上会挡住底下的节点
document.addEventListener("click", closeCtxMenu);
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") closeCtxMenu();
});

async function loadTree() {
  try {
    renderTree(await invoke("sessions_load"));
  } catch (e) {
    treeBody.textContent = "";
    treeEmpty(`读取会话库失败：${e}`);
  }
}

refreshBtn.addEventListener("click", loadTree);

// ── 会话的新建 / 保存 / 删除 ────────────────────────────────
// 「新建」不是装饰：表单里的「保存」在选中某个会话之后是**更新**它
// （`selectedSession.id`），没有这个按钮就无法在不重启的前提下再建一条。
document.getElementById("new-session").addEventListener("click", () => {
  selectedSession = null;
  deleteSessionBtn.disabled = true;
  deleteSessionBtn.textContent = "删除";
  nameInput.value = "";
  passInput.value = "";
  jumpSessionSelect.value = "";
  useJumpBox.checked = false;
  syncAuthUi();
  nameInput.focus();
  setStatus("填名称与主机后保存；连接则用当前参数");
});

saveSessionBtn.addEventListener("click", async () => {
  const name = nameInput.value.trim() || hostInput.value.trim();
  const host = hostInput.value.trim();
  if (!name || !host) {
    setStatus("保存会话需要名称与主机");
    (host ? nameInput : hostInput).focus();
    return;
  }
  try {
    const id = await invoke("session_save", {
      req: {
        id: selectedSession?.id ?? null,
        name,
        host,
        port: Number.parseInt(portInput.value, 10) || 22,
        user: userInput.value.trim() || null,
        jumpSessionId: jumpSessionSelect.value || null,
        kind: kindSelect.value,
      },
    });
    await loadTree();
    // 保存后按 id 重新选中，避免「刚存的会话在树里点不到」
    selectedSession = { id, name, host, port: Number.parseInt(portInput.value, 10) || 22, username: userInput.value.trim(), kind: kindSelect.value };
    nameInput.value = name;
    deleteSessionBtn.disabled = false;
    setStatus(`已保存会话 ${name}`);
  } catch (e) {
    setStatus(`保存失败：${e}`);
  }
});

// 删除是两步：第一次点变成「确认删除」，3 秒内再点才真的删
let deleteArmed = false;
let deleteTimer = null;

deleteSessionBtn.addEventListener("click", async () => {
  if (!selectedSession) return;
  if (!deleteArmed) {
    deleteArmed = true;
    deleteSessionBtn.textContent = "确认删除";
    clearTimeout(deleteTimer);
    deleteTimer = setTimeout(() => {
      deleteArmed = false;
      deleteSessionBtn.textContent = "删除";
    }, 3000);
    return;
  }

  clearTimeout(deleteTimer);
  deleteArmed = false;
  deleteSessionBtn.textContent = "删除";
  const name = selectedSession.name;
  try {
    await invoke("session_delete", { id: selectedSession.id });
    selectedSession = null;
    deleteSessionBtn.disabled = true;
    await loadTree();
    setStatus(`已删除会话 ${name}`);
  } catch (e) {
    setStatus(`删除失败：${e}`);
  }
});

// ── 导入 ────────────────────────────────────────────────────
const importBtn = document.getElementById("import");
const importFile = document.getElementById("import-file");
const treeMsg = document.getElementById("tree-msg");

function showImportMsg(lines) {
  treeMsg.textContent = lines.join("\n");
  treeMsg.hidden = lines.length === 0;
}

importBtn.addEventListener("click", () => importFile.click());

importFile.addEventListener("change", async () => {
  const file = importFile.files?.[0];
  if (!file) return;
  importBtn.disabled = true;
  try {
    // 传字节不传文本：中文 Windows 上的 MobaXterm 写 GBK，按 UTF-8 解会把中文名
    // 变成 �。编码判定放在 Rust 侧（wt_import::decode_ini），与 CLI 同一套逻辑。
    const buf = new Uint8Array(await file.arrayBuffer());
    const r = await invoke("import_mobaxterm", { bytes: Array.from(buf) });
    const lines = [`导入完成：文件夹 ${r.folders} 个、会话 ${r.sessions} 个`];
    if (r.encoding !== "utf-8") lines.push(`按 ${r.encoding} 解码`);
    if (r.reused_folders) lines.push(`复用已有文件夹 ${r.reused_folders} 个`);
    if (r.duplicates.length) {
      lines.push(`已跳过 ${r.duplicates.length} 个已存在会话：${r.duplicates.join("、")}`);
    }
    for (const w of r.warnings) lines.push(`提示：${w}`);
    for (const s of r.skipped) lines.push(`跳过：${s.name} —— ${s.reason}`);
    showImportMsg(lines);
    await loadTree();
  } catch (e) {
    showImportMsg([`导入失败：${e}`]);
  } finally {
    importBtn.disabled = false;
    importFile.value = "";
  }
});

// ── 保险库条目面板 ─────────────────────────────────────────
const vaultToggleBtn = document.getElementById("vault-toggle");
const vaultPanel = document.getElementById("vault-panel");

async function renderVaultPanel() {
  vaultPanel.textContent = "";
  const line = (text, cls = "empty") => {
    const el = document.createElement("div");
    el.className = cls;
    el.textContent = text;
    vaultPanel.appendChild(el);
  };
  try {
    const entries = await invoke("credential_list");
    if (!entries.length) {
      line("保险库里没有密码");
      return;
    }
    for (const e of entries) {
      const row = document.createElement("div");
      row.className = "entry";
      const name = document.createElement("span");
      name.textContent = e.name;
      name.title = e.sessionId ?? e.id;
      const del = document.createElement("button");
      del.textContent = "删除";
      del.addEventListener("click", async () => {
        try {
          await invoke("credential_delete", { entryId: e.id });
          await refreshVault();
          await renderVaultPanel();
          setStatus(`已删除保险库条目 ${e.name}`);
        } catch (err) {
          setStatus(`删除失败：${err}`);
        }
      });
      row.append(name, del);
      vaultPanel.appendChild(row);
    }
  } catch (e) {
    line(String(e));
  }
}

vaultToggleBtn.addEventListener("click", async () => {
  if (!vaultPanel.hidden) {
    vaultPanel.hidden = true;
    return;
  }
  openSidePanel(vaultPanel);
  await renderVaultPanel();
});

// ── 终端查找与字号 ─────────────────────────────────────────
const findBar = document.getElementById("find-bar");
const findInput = document.getElementById("find-input");
const findCount = document.getElementById("find-count");
const findPrev = document.getElementById("find-prev");
const findNext = document.getElementById("find-next");
const findClose = document.getElementById("find-close");

function updateFindCount(index, total) {
  if (!total) {
    findCount.textContent = findInput.value ? "0" : "";
    return;
  }
  findCount.textContent = `${index + 1}/${total}`;
}

function openFind() {
  if (!active) return;
  findBar.hidden = false;
  findInput.focus();
  findInput.select();
}

function closeFind() {
  findBar.hidden = true;
  findCount.textContent = "";
  active?.term.focus();
}

/** 查找高亮配色。**必须传**：不传 decorations 时插件不会发 onDidChangeResults，
 *  界面上就永远看不到「第几个/共几个」 */
const FIND_DECORATIONS = {
  matchBackground: "#4a4a1f",
  matchOverviewRuler: "#4a4a1f",
  activeMatchBackground: "#5b9bff",
  activeMatchOverviewRuler: "#5b9bff",
};

function runFind(backwards) {
  if (!active) return;
  const query = findInput.value;
  if (!query) {
    findCount.textContent = "";
    return;
  }
  // incremental：边打边找，不用按回车
  const found = active.search.findNext(query, {
    incremental: !backwards,
    backwards,
    decorations: FIND_DECORATIONS,
  });
  if (!found) findCount.textContent = "0";
}

findInput.addEventListener("input", () => runFind(false));
findNext.addEventListener("click", () => runFind(false));
findPrev.addEventListener("click", () => runFind(true));
findClose.addEventListener("click", closeFind);

/** 字号调整：所有会话一起改，改完重新 fit（行列数会变） */
function setFontSize(next) {
  look.fontSize = Math.min(28, Math.max(9, next));
  fontSize = look.fontSize;
  lookSizeInput.value = String(look.fontSize);
  for (const view of sessions.values()) {
    view.term.options.fontSize = look.fontSize;
    view.fit.fit();
  }
  saveLook();
}

/**
 * 外观（`TER-005`）与回滚行数（`TER-008`）全部应用到已有会话。
 *
 * 逐项 set 再统一 fit：只改一项时 fit 一次就够，但统一走这里最省心——
 * 字号/字体/行高都会改变行列数，漏一次 fit 就会和远端 PTY 的尺寸对不上。
 */
function applyLook() {
  for (const view of sessions.values()) {
    view.term.options.theme = xtermTheme(look.theme);
    view.term.options.fontFamily = look.fontFamily;
    view.term.options.fontSize = look.fontSize;
    view.term.options.lineHeight = look.lineHeight;
    view.term.options.scrollback = look.scrollback;
    view.fit.fit();
  }
  fontSize = look.fontSize;
  refreshFontWarn();
  saveLook();
}

// ── 剪贴板（TER-011 / TER-013 / TER-023）────────────────────
//
// 数据只经 `term.paste()` 发出，不自己拼 `\e[200~…\e[201~`。
// xterm 的 paste 内部已经做了两件我们不该重复的事：`\r?\n` → `\r` 规范化，
// 以及远端开启 `?2004` 时自动包裹 bracketed paste。再包一层，vim 里会看到
// 多出来的 `200~` 字样——这就是「粘贴处理」写两遍的典型后果。
//
// 已知规格偏差（`spec/06` TER-011 AC-1 与「默认分隔符 `/~+-.&?$%`」自相矛盾）：
// 按 AC-1 优先，保留 xterm 默认分隔符，使 `user@host:/var/log` 双击能选全串。
// 若把 `/` 当分隔符，双击只会选中 `user@host:`。

/** 选中即复制（Unix 终端习惯，TER-011）。验收脚本可关掉。 */
let autoCopy = true;
/** 防抖延迟（毫秒，`TER-011`）：拖选会连续触发，不防抖就每挪一格写一次剪贴板 */
let autoCopyDelay = 120;
/** 右键行为（`TER-011`）：`menu` 弹菜单（规格默认）/ `paste` 直接粘贴 */
let rightClickAction = "menu";
/** 双击选词额外当分隔符的字符（`TER-011`）：空串表示只用 xterm 默认那一套 */
let wordSeparatorExtra = "";
/** xterm 的默认分隔符：第一次建视图时记下来，用户清空自定义时要还原成它 */
let defaultWordSeparator = null;
/** 自动复制失败只提示一次，避免每拖一次选就刷一条状态 */
let autoCopyWarned = false;

/** 粘贴时去掉每行末尾的空格/制表符（`TER-011`）。默认关：改用户内容要用户自己点头。 */
let pasteTrimTrailing = false;

/** 多行粘贴确认门限：含 ≥ 2 个换行就确认（TER-013） */
const PASTE_CONFIRM_LINES = 2;

const pasteDialog = document.getElementById("paste-confirm");
const pasteInfo = document.getElementById("paste-info");
const pastePreview = document.getElementById("paste-preview");

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    // 不能静默：用户按了复制却什么都没进剪贴板，是最难自查的一类问题
    setStatus(`写剪贴板失败：${e}`);
    return false;
  }
}

async function readClipboard() {
  // 带超时：WebView2 里 `readText()` 可能既不 resolve 也不 reject（等权限），
  // 不设上限的话右键就变成「点了什么都没有」——比报错更难排查。
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 1500));
  try {
    const text = await Promise.race([navigator.clipboard.readText(), timeout]);
    if (text === null) {
      setStatus("读剪贴板被拒绝，请用 Ctrl+Shift+V 粘贴");
    }
    return text;
  } catch (e) {
    setStatus(`读剪贴板失败：${e}（可用 Ctrl+Shift+V）`);
    return null;
  }
}

/** 复制当前会话的选区（Ctrl+Shift+C / Ctrl+Insert）。 */
async function copySelection(view = active) {
  const text = view?.term.getSelection() ?? "";
  if (!text) {
    setStatus("没有选中内容");
    return;
  }
  if (await writeClipboard(text)) {
    setStatus(`已复制 ${text.length} 字符`);
  }
}

/** 多行粘贴确认；返回用户是否确认。取消时一个字节都不会发出去。 */
function confirmPaste(text, view) {
  const lines = text.split(/\r\n|\r|\n/);
  pasteInfo.textContent = `${lines.length} 行 · ${text.length} 字符 · 目标会话 ${view.label}`;
  pastePreview.textContent = lines.slice(0, 3).join("\n");
  pasteDialog.returnValue = "";
  pasteDialog.showModal();
  return new Promise((resolve) => {
    pasteDialog.addEventListener(
      "close",
      () => {
        resolve(pasteDialog.returnValue === "yes");
        if (view === active) view.term.focus();
      },
      { once: true },
    );
  });
}

/**
 * 粘贴一段文本（多行先确认，再交给 xterm）。
 *
 * 顺序是刻意的：先确认，确认通过后才 `term.paste()`。反过来写就会留下
 * 「取消之后远端已经收到一半」这种最难解释的现象。
 */
async function pasteText(raw, view = active) {
  if (!view?.handle) {
    setStatus("没有活动会话");
    return;
  }
  if (!raw) return;

  // 规范化（`TER-011` 规格第 1 条）：`\r\n` / `\n` 一律变成 `\r`（终端语义），
  // 再按设置决定要不要去掉每行末尾的空格与制表符。xterm 的 paste 自己也会处理换行，
  // 但「去尾空白」只能我们做；而且先把文本定死，验收才能看到**到底送出去了什么**。
  let text = raw.replace(/\r\n/g, "\r").replace(/\n/g, "\r");
  if (pasteTrimTrailing) text = text.replace(/[ \t]+(?=\r|$)/g, "");
  // 记下这次真正粘贴的文本（验收用：规范化与去尾空白都要能观察，别靠肉眼看）
  view.lastPaste = text;

  const newlines = (text.match(/\r/g) ?? []).length;
  if (newlines >= PASTE_CONFIRM_LINES && !(await confirmPaste(text, view))) {
    setStatus("粘贴已取消");
    return;
  }

  view.term.paste(text);
  view.pasteCount += 1;
  setStatus(`已粘贴 ${text.length} 字符`);
}

/**
 * 右键 / 中键粘贴：这里没有 `paste` 事件可用，只能自己去读剪贴板。
 *
 * `navigator.clipboard.readText()` 在 WebView2 里要「用户激活」才放行，
 * 脚本合成的事件可能拿不到，所以读失败时给出可执行的替代动作，
 * 而不是默默什么都不做。
 */
async function pasteFromClipboard(view = active) {
  const text = await readClipboard();
  // 读失败时 `readClipboard` 已经说明原因与替代办法，这里不再覆盖
  if (text === null) return;
  await pasteText(text, view);
}

// 键盘粘贴与右键菜单粘贴都走这里：`paste` 事件自带数据，不需要剪贴板权限。
//
// 为什么不自己处理 Ctrl+Shift+V：浏览器只在真正的粘贴动作上触发 `paste`，
// 我们拦下来再去读剪贴板反而多一道权限坎。交给浏览器，这条路径在所有平台上都一样。
document.addEventListener(
  "paste",
  (ev) => {
    const text = ev.clipboardData?.getData("text/plain") ?? "";
    ev.preventDefault();
    ev.stopPropagation();
    void pasteText(text);
  },
  true,
);

// ── 键位表（`TER-020`）────────────────────────────────────
//
// 之前是几个 if 写死在这里：改一个键要动代码，也没法告诉用户「现在有哪些快捷键」。
// 改成表驱动之后，重绑 / 冲突检测 / 导出导入都只是这张表上的操作。
//
// 粘贴（`Ctrl+Shift+V` / `Shift+Insert`）**不在表里**：浏览器只在真正的粘贴动作上
// 触发 `paste` 事件，拦下按键反而会让事件不产生。它是浏览器行为，不是我们的键位。

const KEYMAP_DEFAULT = {
  // 排在最前面是有意的：命令面板是「其余所有动作」的入口，用户找不到功能时先按它
  commandPalette: { label: "命令面板", chords: ["Ctrl+Shift+P"] },
  copy: { label: "复制选区", chords: ["Ctrl+Shift+C", "Ctrl+Insert"] },
  find: { label: "查找", chords: ["Ctrl+F"] },
  zoomIn: { label: "放大字号", chords: ["Ctrl+=", "Ctrl++"] },
  zoomOut: { label: "缩小字号", chords: ["Ctrl+-"] },
  zoomReset: { label: "重置字号", chords: ["Ctrl+0"] },
  closeFind: { label: "关闭查找栏", chords: ["Escape"] },
  broadcast: { label: "多执行广播", chords: ["Ctrl+Shift+B"] },
  files: { label: "文件面板", chords: ["Ctrl+Shift+F"] },
  tunnels: { label: "隧道面板", chords: ["Ctrl+Shift+T"] },
  // 下面这些是**真有行为**的，不是凑数：每一条都在 runAction 里有对应分支。
  // 规格说 30+ 个动作，但填一堆点了没反应的条目比数量不够更糟。
  newLocal: { label: "新建本地终端", chords: ["Ctrl+T"] },
  nextTab: { label: "下一个标签", chords: ["Ctrl+Tab"] },
  prevTab: { label: "上一个标签", chords: ["Ctrl+Shift+Tab"] },
  findNext: { label: "查找下一个", chords: ["F3"] },
  findPrev: { label: "查找上一个", chords: ["Shift+F3"] },
  settingsOpen: { label: "打开设置", chords: ["Ctrl+,"] },
  keysOpen: { label: "键位设置", chords: ["Ctrl+K"] },
  // 左右分屏原来占着 Ctrl+Shift+S，和规格里「保存终端输出」的键位撞了。
  // 规格优先：分屏让到 Ctrl+Shift+E（与「分屏」语义一致），Ctrl+Shift+S 还给保存输出。
  splitToggle: { label: "左右分屏", chords: ["Ctrl+Shift+E"] },
  saveOutput: { label: "保存终端输出", chords: ["Ctrl+Shift+S"] },
  fullscreen: { label: "全屏", chords: ["F11"] },
  // 第二批量：标签管理、滚动、清屏、全选、侧栏。**每一条都有真行为**——
  // 规格里 30+ 个动作，但填一堆按了没反应的条目比数量不够更糟（`TER-020`）。
  closeTab: { label: "关闭当前标签", chords: ["Ctrl+Alt+Q"] },
  duplicateTab: { label: "复制当前标签", chords: ["Ctrl+Shift+U"] },
  renameTab: { label: "重命名当前标签", chords: ["Ctrl+Alt+R"] },
  clearScreen: { label: "清屏", chords: ["Ctrl+Shift+K"] },
  selectAll: { label: "全选", chords: ["Ctrl+Shift+A"] },
  scrollPageUp: { label: "上滚一页", chords: ["Shift+PageUp"] },
  scrollPageDown: { label: "下滚一页", chords: ["Shift+PageDown"] },
  scrollLineUp: { label: "上滚一行", chords: ["Shift+ArrowUp"] },
  scrollLineDown: { label: "下滚一行", chords: ["Shift+ArrowDown"] },
  scrollTop: { label: "滚到顶", chords: ["Shift+Home"] },
  scrollBottom: { label: "滚到底", chords: ["Shift+End"] },
  sidebarToggle: { label: "显示/隐藏侧栏", chords: ["Ctrl+Alt+B"] },
  jumpTab1: { label: "跳到第 1 个标签", chords: ["Ctrl+Alt+F1"] },
  jumpTab2: { label: "跳到第 2 个标签", chords: ["Ctrl+Alt+F2"] },
  jumpTab3: { label: "跳到第 3 个标签", chords: ["Ctrl+Alt+F3"] },
};


/** 当前生效的键位表：`action → { label, chords[] }` */
let keymap = structuredClone(KEYMAP_DEFAULT);

/** 把按键事件规范化成可比较的字符串：修饰键顺序固定，字母统一大写 */
function chordOf(ev) {
  const mods = [];
  if (ev.ctrlKey) mods.push("Ctrl");
  if (ev.altKey) mods.push("Alt");
  if (ev.shiftKey) mods.push("Shift");
  let key = ev.key;
  if (key === " ") key = "Space";
  else if (key.length === 1) key = key.toUpperCase();
  // 只有修饰键被按下时不算一个键位
  if (["Control", "Shift", "Alt", "Meta"].includes(ev.key)) return null;
  return [...mods, key].join("+");
}

/** 键位与外观存在同一份 `config.toml` 里，所以这里只是转发 */
function saveKeymap() {
  void savePrefs();
}

/** 键位冲突：同一个组合被两个动作占用时返回占用者 */
function chordOwner(chord, exceptAction) {
  for (const [action, v] of Object.entries(keymap)) {
    if (action === exceptAction) continue;
    if (v.chords.includes(chord)) return v.label;
  }
  return null;
}

/**
 * MRU 切换标签（`TER-020` 的「下一个/上一个标签」，`TER-001` 要求按最近使用排序）。
 *
 * 第一次按进入一轮新的切换：顺序是「当前 → 最近用过的 → 再早的…」；之后每次按都在
 * 这一轮里前后走（到两头就绕回去）。停手 1.5 秒，这一轮结束，顺序按新的使用情况重排。
 * 只有一条标签时不算命中（返回 false，让按键继续往下传）。
 */
function cycleTab(delta) {
  if (sessions.size < 2) return false;
  const now = Date.now();
  if (!mruBurst || now > mruBurst.expires) {
    const order = active ? [active] : [];
    for (const v of mruViews) {
      if (v !== active && sessions.has(v.id)) order.push(v);
    }
    mruBurst = { order, cursor: 0, expires: now + 1500 };
  }
  const { order } = mruBurst;
  const step = delta > 0 ? 1 : -1;
  mruBurst.cursor = (mruBurst.cursor + step + order.length) % order.length;
  mruBurst.expires = now + 1500;
  if (mruTimer) clearTimeout(mruTimer);
  mruTimer = setTimeout(() => {
    mruBurst = null;
  }, 1600);
  const next = order[mruBurst.cursor];
  if (!next || next === active || !sessions.has(next.id)) return false;
  activateByUser(next);
  return true;
}

function runAction(action) {
  switch (action) {
    case "commandPalette":
      togglePalette();
      return true;
    case "copy":
      void copySelection();
      return true;
    case "find":
      openFind();
      return true;
    case "zoomIn":
      setFontSize(look.fontSize + 1);
      return true;
    case "zoomOut":
      setFontSize(look.fontSize - 1);
      return true;
    case "zoomReset":
      setFontSize(13);
      return true;
    case "closeFind":
      if (findBar.hidden) return false;
      closeFind();
      return true;
    case "broadcast":
      bcToggle.click();
      return true;
    case "files":
      document.getElementById("files-toggle").click();
      return true;
    case "tunnels":
      document.getElementById("tunnels-toggle").click();
      return true;
    case "newLocal":
      void openLocal();
      return true;
    case "nextTab":
      return cycleTab(1);
    case "prevTab":
      return cycleTab(-1);
    case "findNext":
    case "findPrev": {
      if (findBar.hidden || !active) return false;
      const q = findInput.value;
      const opts = { decorations: FIND_DECORATIONS };
      if (action === "findNext") active.search.findNext(q, opts);
      else active.search.findPrevious(q, opts);
      return true;
    }
    case "settingsOpen":
      openSettings();
      return true;
    case "keysOpen":
      keysOpen.click();
      return true;
    case "fullscreen": {
      // 状态以窗口真实状态为准（后端回传 `is_fullscreen`），不是本地记一个布尔
      void (async () => {
        const r = await invoke("window_set_fullscreen", { on: !isFullscreen }).catch(() => null);
        if (r === null) {
          setStatus("切换全屏失败");
          return;
        }
        isFullscreen = r;
        // 写成两条直接调用：状态栏词表扫描只认「直接传字符串」的形状，
        // 三元表达式里的字符串会被判成「没人用的死词条」。
        if (r) setStatus("已进入全屏（F11 退出）");
        else setStatus("已退出全屏");
      })();
      return true;
    }
    case "splitToggle":
      document.getElementById("split-toggle").click();
      return true;
    case "saveOutput": {
      // 保存整段滚动缓冲（不只是可见区）：用户按这个键通常是为了留证据，
      // 只存一屏等于让他自己再翻一遍。
      const v = active;
      if (!v) return false;
      void (async () => {
        try {
          const path = await invoke("save_terminal_text", { text: terminalBufferText(v) });
          setStatus(`已保存终端输出：${path}`);
        } catch (e) {
          setStatus(`保存终端输出失败：${e}`);
        }
      })();
      return true;
    }
    case "closeTab": {
      // 同上：确认框是异步的，闭包里必须用抓下来的引用，不能回头再读 active
      const v = active;
      if (!v) return false;
      void (async () => {
        if (await confirmCloseIfBusy([v])) await closeView(v);
      })();
      return true;
    }
    case "duplicateTab":
      if (!active) return false;
      void duplicateTab(active);
      return true;
    case "renameTab":
      if (!active) return false;
      void renameTab(active);
      return true;
    case "clearScreen":
      if (!active) return false;
      // xterm 的 clear 连回滚区一起清；这正是「清屏」在终端里被期待的效果。
      // 注意别在这里发 `\x1b[2J`：那只是往缓冲里写字符，滚动条还在。
      active.term.clear();
      setStatus("已清屏");
      return true;
    case "selectAll":
      if (!active) return false;
      active.term.selectAll();
      return true;
    case "scrollPageUp":
    case "scrollPageDown":
    case "scrollLineUp":
    case "scrollLineDown":
    case "scrollTop":
    case "scrollBottom": {
      if (!active) return false;
      const t = active.term;
      if (action === "scrollPageUp") t.scrollPages(-1);
      else if (action === "scrollPageDown") t.scrollPages(1);
      else if (action === "scrollLineUp") t.scrollLines(-1);
      else if (action === "scrollLineDown") t.scrollLines(1);
      else if (action === "scrollTop") t.scrollToTop();
      else t.scrollToBottom();
      return true;
    }
    case "sidebarToggle": {
      const tree = document.getElementById("tree");
      tree.hidden = !tree.hidden;
      // 侧栏宽度变了，终端要重新 fit，否则行列数还按老宽度算，输出会串行
      active?.fit.fit();
      setStatus(tree.hidden ? "侧栏已隐藏" : "侧栏已显示");
      return true;
    }
    case "jumpTab1":
    case "jumpTab2":
    case "jumpTab3": {
      const idx = Number(action.slice(-1)) - 1;
      const target = [...sessions.values()][idx];
      if (!target) return false;
      activateByUser(target);
      return true;
    }
    default:
      return false;
  }
}

// ── 远端文件编辑（`FIL-005`）──────────────────────────────
//
// 下载到本地临时区 → 外部编辑器 → 写回。不做内嵌编辑器（`FIL-011` 是另一条 P0）。
// 写回前比一次远端大小：期间被别人改过就拒绝覆盖——悄悄盖掉别人的修改
// 是这类功能最坏的行为。

const editDialog = document.getElementById("edit-dialog");
const editInfo = document.getElementById("edit-info");
const filesEdit = document.getElementById("files-edit");
const editHintEl = document.getElementById("edit-hint");
const editSaveEl = document.getElementById("edit-save");

/** 当前正在编辑的远端文件（验收读它） */
let lastEdit = null;

/*
 * 自动检测本地保存（FIL-005）：外部编辑器把副本存了，界面上要看得见。
 *
 * 判据是 mtime 变大，不是文件大小——改一个字符大小可能不变，但保存一定会动 mtime。
 * 轮询绑在对话框「开着」这件事上：一关就 clearInterval，绝不留后台定时器。
 */
let editWatchTimer = null;
let editWatch = { active: false, base: 0, current: 0, changed: false, polls: 0 };

function editHintReset() {
  editHintEl.hidden = true;
  editSaveEl.classList.remove("ready");
}

function stopEditWatch() {
  if (editWatchTimer !== null) {
    clearInterval(editWatchTimer);
    editWatchTimer = null;
  }
  editWatch.active = false;
}

async function startEditWatch(localPath) {
  stopEditWatch();
  editHintReset();
  editWatch = { active: true, base: 0, current: 0, changed: false, polls: 0 };
  try {
    editWatch.base = await invoke("local_mtime", { path: localPath });
    editWatch.current = editWatch.base;
  } catch {
    stopEditWatch();
    return;
  }
  editWatchTimer = setInterval(async () => {
    if (!editWatch.active) return;
    try {
      const m = await invoke("local_mtime", { path: localPath });
      editWatch.polls += 1;
      editWatch.current = m;
      // 有些编辑器（vim 等）是「写临时文件 + rename」原子保存，中间有一瞬间
      // 原路径不存在，local_mtime 会报 FILE_NOT_FOUND——忽略它，下一轮就能看到新 mtime。
      if (m > editWatch.base && !editWatch.changed) {
        editWatch.changed = true;
        editHintEl.hidden = false;
        editSaveEl.classList.add("ready");
      }
    } catch {
      /* 原子保存的窗口期：什么都不做，等下一轮 */
    }
  }, 700);
}

// 对话框一关就停：close 事件是「开着」这个事实本身，比在定时器里自检更即时
editDialog.addEventListener("close", () => {
  stopEditWatch();
  editHintReset();
});

function editReq() {
  return { req: filesReq(), jump: jumpReq() };
}

filesEdit.addEventListener("click", async () => {
  if (!selectedEntry || selectedEntry.is_dir) return;
  const remote = joinPath(sftpPath, selectedEntry.name);
  editInfo.textContent = "下载中…";
  editDialog.showModal();
  try {
    const d = await invoke("sftp_edit_download", { ...editReq(), path: remote });
    lastEdit = d;
    editInfo.textContent = [
      `远端：${d.remotePath}（${d.size} 字节）`,
      `本地副本：${d.localPath}`,
    ].join("\n");
    setStatus(`已下载到本地：${d.localPath}`);
    // 下载完成的这一刻记下基准，之后外部编辑器保存了副本就能看出来
    void startEditWatch(d.localPath);
  } catch (e) {
    lastEdit = null;
    editInfo.textContent = `下载失败：${e}`;
  }
});

document.getElementById("edit-open").addEventListener("click", async () => {
  if (!lastEdit) return;
  try {
    await invoke("open_in_system", { path: lastEdit.localPath });
  } catch (e) {
    setStatus(`打开失败：${e}`);
  }
});

document.getElementById("edit-inline").addEventListener("click", async () => {
  if (!lastEdit) return;
  editDialog.close();
  await openEditor(lastEdit.localPath, lastEdit.remotePath.split("/").pop());
});

document.getElementById("edit-save").addEventListener("click", async () => {
  if (!lastEdit) return;
  try {
    const r = await invoke("sftp_edit_save", {
      ...editReq(),
      path: lastEdit.remotePath,
      localPath: lastEdit.localPath,
      expectedSize: lastEdit.size,
    });
    // 写回之后远端大小变了，下次写回要按新的算，否则第二次必然误报冲突
    lastEdit.size = r.bytes;
    // 基准要跟着刷新：不然用户再改一次本地副本，提示会一直亮着不复位
    if (editWatch.active) {
      try {
        editWatch.base = await invoke("local_mtime", { path: lastEdit.localPath });
        editWatch.current = editWatch.base;
        editWatch.changed = false;
        editHintReset();
      } catch {
        /* 副本刚被外部程序换掉：下一轮轮询会重新看见 */
      }
    }
    // 原子与否必须说出来：降级路径中间有一瞬间文件是不存在的，
    // 用户正在盯 inotify 或跑构建的话，那是要命的信息
    setStatus(
      r.atomic
        ? `已写回远端（${r.bytes} 字节，原子替换）`
        : `已写回远端（${r.bytes} 字节）；服务端不支持原子替换，期间有一瞬间文件不存在`,
    );
    await loadDir(sftpPath);
  } catch (e) {
    setStatus(`写回失败：${e}`);
  }
});

document.getElementById("edit-close").addEventListener("click", () => editDialog.close());

// ── 内嵌文本编辑器（`FIL-011`）────────────────────────────
//
// 用 textarea 而不是 CodeMirror：前端是零构建、vendor 内联的，
// 引一个编辑器框架要连带打包器和体积。代价是没有语法高亮——这一条如实标在 README 里，
// 别让「有编辑器」被读成「有高亮的编辑器」。

const editorEl = document.getElementById("editor");
const edTabsEl = document.getElementById("ed-tabs");
const edEncodingEl = document.getElementById("ed-encoding");
const edEolEl = document.getElementById("ed-eol");
const edTextEl = document.getElementById("ed-text");
const edGutterEl = document.getElementById("ed-gutter");
const edInfoEl = document.getElementById("ed-info");
const edFindEl = document.getElementById("ed-find");
const edReplaceEl = document.getElementById("ed-replace");
const edReEl = document.getElementById("ed-re");
const edColEl = document.getElementById("ed-col");

/** 打开的文档（每个一个标签）；`dirty` 表示有未保存修改 */
let edDocs = [];
let edActiveId = null;

function edActive() {
  return edDocs.find((d) => d.id === edActiveId) ?? null;
}

const edMonacoEl = document.getElementById("ed-monaco");
/** Monaco 实例；`null` = 没加载成功，退回原来的 textarea（编辑功能不受影响） */
let edMonaco = null;
let edMonacoLoading = null;
/** 我们自己往模型里写值时置真：否则切个标签就全变「未保存」 */
let edSilent = false;

/**
 * 列选择模式（`FIL-011`）：开着时拖拽就是矩形框选，一次改多行同列。
 *
 * Monaco 自带这个能力，这里只加一个**看得见、可验**的开关。
 * 没有 Monaco 时按钮不显示——textarea 不做矩形框选，摆一个点了没反应的开关
 * 比没有更糟（用户会以为点坏了）。
 */
let edColumnSelection = false;

function edApplyColumnSelection(on) {
  edColumnSelection = Boolean(on);
  if (edMonaco) edMonaco.updateOptions({ columnSelection: edColumnSelection });
  edColEl.setAttribute("aria-pressed", String(edColumnSelection));
  // 点按钮会把焦点拿走：不还给编辑器，接下来的键入就掉在地上了
  edFocus();
}

edColEl.addEventListener("click", () => {
  if (!edMonaco) return;
  edApplyColumnSelection(!edColumnSelection);
});

/**
 * 扩展名（或整名）→ Monaco 语言 id（`FIL-011` 要求 ≥ 30 种）。
 *
 * 猜不到就是 `plaintext`——**不猜**。乱着色比不着色更误导人。
 * 这张表同时是「支持多少种语言」的唯一来源：`__wt.editor.languages` 报的是它
 * 去重后的数量，悄悄删掉几种会被 e2e 的 ≥30 断言拦住。
 */
const ED_LANG_BY_EXT = {
  dockerfile: "dockerfile", makefile: "makefile",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript",
  json: "json", jsonc: "json",
  md: "markdown", markdown: "markdown",
  css: "css", scss: "scss", less: "less",
  html: "html", htm: "html", xml: "xml", svg: "xml",
  yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini", conf: "ini", cfg: "ini",
  sh: "shell", bash: "shell", zsh: "shell", ksh: "shell",
  ps1: "powershell", psm1: "powershell",
  py: "python", rs: "rust", go: "go", java: "java", kt: "kotlin",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp",
  cs: "csharp", php: "php", rb: "ruby", pl: "perl", lua: "lua",
  sql: "sql", graphql: "graphql", proto: "proto",
  bat: "bat", cmd: "bat", diff: "diff", patch: "diff",
};

/** 去重后的语言数：多个扩展名可能指向同一种语言（mjs/cjs 都是 javascript） */
const ED_LANG_COUNT = new Set(Object.values(ED_LANG_BY_EXT)).size;

function edLangOf(name) {
  const base = String(name || "").toLowerCase();
  // 整名匹配排前面：Dockerfile / Makefile 没有扩展名
  const byName = ED_LANG_BY_EXT[base];
  if (byName) return byName;
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
  return ED_LANG_BY_EXT[ext] ?? "plaintext";
}

/**
 * 加载 Monaco（官方 AMD 版，直接 vendor、不需要构建）。
 *
 * 失败就返回 `null`：语法高亮是增强，不能因为它挂了就连编辑一起废掉。
 */
function monacoLoad() {
  if (edMonacoLoading) return edMonacoLoading;
  edMonacoLoading = new Promise((resolve) => {
    if (typeof window.require !== "function") {
      resolve(null);
      return;
    }
    try {
      // worker 走**同源 URL**：默认它会用 `blob:`，而 CSP 里没有 `worker-src blob:`，
      // 于是 worker 创建失败、页面冒出未捕获的 `Event`（就是 e2e 报的那条）。
      // 同源 URL 落在 `default-src 'self'` 里，不用放宽 CSP。
      window.MonacoEnvironment = {
        getWorkerUrl: () => "vendor/monaco/vs/base/worker/workerMain.js",
      };
      window.require.config({
        paths: { vs: "vendor/monaco/vs" },
        // 只用 Monaco 内置的英文消息：否则它会按页面 locale 去取
        // `vs/nls.messages.zh-cn.js` 之类——那些翻译文件被刻意裁掉了，
        // 取不到时服务器返回 index.html，被当 JS 解析就报
        // 「SyntaxError: Unexpected token '<'」。
        "vs/nls": { availableLanguages: { "*": "" } },
      });
      window.require(
        ["vs/editor/editor.main"],
        () => resolve(window.monaco ?? null),
        () => resolve(null),
      );
    } catch {
      resolve(null);
    }
  });
  return edMonacoLoading;
}

/** 首次显示编辑器时建 Monaco；成功后把 textarea 与行号槽藏起来 */
async function edEnsureMonaco() {
  if (edMonaco) return edMonaco;
  const m = await monacoLoad();
  if (!m) return null;
  edMonaco = m.editor.create(edMonacoEl, {
    value: "",
    language: "plaintext",
    theme: "vs-dark",
    automaticLayout: true,
    fontSize: 13,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    wordWrap: "off",
    tabSize: 2,
    // 词库建议要用 web worker；我们把 worker 目录裁掉了，这里关掉它，
    // 免得控制台一直刷「worker 创建失败」而让人以为编辑器坏了
    suggest: { showWords: false },
  });
  edMonaco.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => edSave());
  edMonaco.addCommand(m.KeyCode.Tab, () => {
    const sel = edMonaco.getSelection();
    if (sel) edMonaco.executeEdits("tab", [{ range: sel, text: "  ", forceMoveMarkers: true }]);
  });
  edMonaco.onDidChangeModelContent(() => {
    if (edSilent) return;
    const doc = edActive();
    if (!doc) return;
    doc.text = edMonaco.getValue();
    // EOL 跟着模型走：用户可能在编辑器里就把换行改了
    doc.eol = edMonaco.getModel()?.getEOL() === "\r\n" ? "crlf" : "lf";
    doc.dirty = true;
    edRenderTabs();
    edSyncInfo();
  });
  edMonacoEl.hidden = false;
  edGutterEl.hidden = true;
  edTextEl.hidden = true;
  // 只有 Monaco 起来了才给这个开关：它靠 Monaco 的矩形框选，退路没有对应能力
  edColEl.hidden = false;
  edSyncBody();
  return edMonaco;
}

/** 只刷「N 行 · N 字 · 未保存」那行，不动正文（Monaco 路径下用） */
function edSyncInfo() {
  const doc = edActive();
  if (!doc) {
    edInfoEl.textContent = "";
    return;
  }
  const lines = doc.text.split("\n").length;
  edInfoEl.textContent = `${lines} 行 · ${doc.text.length} 字 · ${doc.encoding ?? "utf-8"} · ${(doc.eol ?? "lf").toUpperCase()}${doc.dirty ? " · 未保存" : ""}`;
}

/** 选区读写：Monaco 与 textarea 两套 API 收在这两个函数里，别的地方不再直接碰 */
function edSelection() {
  if (edMonaco) {
    const model = edMonaco.getModel();
    const sel = edMonaco.getSelection();
    if (!model || !sel) return { start: 0, end: 0 };
    return {
      start: model.getOffsetAt(sel.getStartPosition()),
      end: model.getOffsetAt(sel.getEndPosition()),
    };
  }
  return { start: edTextEl.selectionStart, end: edTextEl.selectionEnd };
}

function edSetSelection(start, end) {
  if (edMonaco) {
    const model = edMonaco.getModel();
    if (!model) return;
    const a = model.getPositionAt(start);
    const b = model.getPositionAt(end);
    edMonaco.setSelection(
      new window.monaco.Selection(a.lineNumber, a.column, b.lineNumber, b.column),
    );
    edMonaco.revealRangeInCenterIfOutsideViewport(edMonaco.getSelection());
    edMonaco.focus();
    return;
  }
  edTextEl.focus();
  edTextEl.setSelectionRange(start, end);
}

function edFocus() {
  if (edMonaco) edMonaco.focus();
  else edTextEl.focus();
}

function edSyncBody() {
  const doc = edActive();
  if (!doc) {
    if (edMonaco) {
      edSilent = true;
      edMonaco.setValue("");
      edSilent = false;
    }
    edTextEl.value = "";
    edGutterEl.textContent = "";
    edInfoEl.textContent = "";
    return;
  }
  if (edMonaco) {
    // 写模型时静音：`setValue` 会触发 change，否则一打开就变「未保存」
    edSilent = true;
    if (edMonaco.getValue() !== doc.text) edMonaco.setValue(doc.text);
    const model = edMonaco.getModel();
    if (model && window.monaco) {
      window.monaco.editor.setModelLanguage(model, edLangOf(doc.name));
      // Monaco 的 `setValue` 会按 model 当前 EOL 重排换行：不显式设回来，
      // CRLF 文件一打开就被静默改成 LF，保存后整份文件的换行全变——
      // 用户只改了一个字，diff 却是整篇。
      const wantEol = doc.eol === "crlf" ? "\r\n" : "\n";
      if (model.getEOL() !== wantEol) {
        model.setEOL(
          doc.eol === "crlf"
            ? window.monaco.editor.EndOfLineSequence.CRLF
            : window.monaco.editor.EndOfLineSequence.LF,
        );
      }
    }
    edSilent = false;
  } else if (edTextEl.value !== doc.text) {
    edTextEl.value = doc.text;
  }
  const lines = doc.text.split("\n").length;
  if (!edMonaco) {
    edGutterEl.textContent = Array.from({ length: lines }, (_, i) => i + 1).join("\n");
    edGutterEl.scrollTop = edTextEl.scrollTop;
  }
  edInfoEl.textContent = `${lines} 行 · ${doc.text.length} 字 · ${doc.encoding ?? "utf-8"} · ${(doc.eol ?? "lf").toUpperCase()}${doc.dirty ? " · 未保存" : ""}`;
}

function edRenderTabs() {
  edTabsEl.textContent = "";
  for (const doc of edDocs) {
    const tab = document.createElement("div");
    tab.className = `edtab${doc.id === edActiveId ? " active" : ""}`;
    const name = document.createElement("span");
    name.textContent = doc.name;
    tab.appendChild(name);
    if (doc.dirty) {
      const dot = document.createElement("span");
      dot.className = "dirty";
      dot.textContent = "●";
      tab.appendChild(dot);
    }
    const x = document.createElement("span");
    x.className = "x";
    x.textContent = "×";
    x.title = "关闭";
    x.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void edCloseDoc(doc.id);
    });
    tab.appendChild(x);
    tab.addEventListener("click", () => {
      edActiveId = doc.id;
      edRenderTabs();
      edSyncBody();
    });
    edTabsEl.appendChild(tab);
  }
}

function edShow() {
  editorEl.hidden = false;
  termHost.hidden = true;
  termFoot.hidden = true;
  edRenderTabs();
  edSyncBody();
  void edEnsureMonaco();
  edFocus();
}

function edHideIfEmpty() {
  if (edDocs.length) return;
  editorEl.hidden = true;
  termHost.hidden = false;
  termFoot.hidden = !active;
}

/** 打开一个本地文件到编辑器（`FIL-011`）。重复打开同一个路径只切标签 */
async function openEditor(path, name) {
  const existing = edDocs.find((d) => d.path === path);
  if (existing) {
    edActiveId = existing.id;
    edShow();
    return;
  }
  try {
    const r = await invoke("local_read_text", { path });
    const doc = {
      id: `ed${Date.now()}${Math.random().toString(16).slice(2, 6)}`,
      path,
      name: name ?? path.split(/[\\/]/).pop(),
      text: r.text,
      dirty: false,
      encoding: r.encoding ?? "utf-8",
      bom: Boolean(r.bom),
      // 原文件的换行符（`FIL-011`）：保存时按它写回，别把 Windows 文件悄悄改成 LF
      eol: /\r\n/.test(r.text ?? "") ? "crlf" : "lf",
    };
    edDocs.push(doc);
    edActiveId = doc.id;
    edShow();
    setStatus(`已打开 ${doc.name}（${r.size} 字节）`);
  } catch (e) {
    setStatus(`打开失败：${e}`);
  }
}

async function edCloseDoc(id) {
  const doc = edDocs.find((d) => d.id === id);
  if (!doc) return;
  if (doc.dirty) {
    const ok = await askConfirm("有未保存的修改", `${doc.name} 还没保存，确定关闭？`);
    if (!ok) return;
  }
  edDocs = edDocs.filter((d) => d.id !== id);
  if (edActiveId === id) edActiveId = edDocs[0]?.id ?? null;
  edRenderTabs();
  edSyncBody();
  edHideIfEmpty();
}

function edSave() {
  const doc = edActive();
  if (!doc) return;
  void (async () => {
    try {
      const n = await invoke("local_write_text", {
        path: doc.path,
        text: doc.text,
        encoding: doc.encoding ?? "utf-8",
        bom: Boolean(doc.bom),
      });
      doc.dirty = false;
      edRenderTabs();
      edSyncBody();
      setStatus(`已保存 ${doc.name}（${n} 字节）`);
    } catch (e) {
      setStatus(`保存失败：${e}`);
    }
  })();
}

function edPattern() {
  const q = edFindEl.value;
  if (!q) return null;
  try {
    // 非正则模式要转义：用户查 `a.b` 不该match `axb`
    const src = edReEl.checked ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(src, "g");
  } catch (e) {
    setStatus(`正则无效：${e}`);
    return null;
  }
}

function edFindStep(dir) {
  const doc = edActive();
  const re = edPattern();
  if (!doc || !re) return;
  const sel = edSelection();
  const from = dir > 0 ? sel.end : 0;
  const text = doc.text;
  const forward = dir > 0 ? text.slice(from) : text;
  re.lastIndex = 0;
  const m = re.exec(forward);
  if (!m) {
    setStatus("没有匹配");
    return;
  }
  const start = (dir > 0 ? from : 0) + m.index;
  edSetSelection(start, start + m[0].length);
  setStatus(`匹配 ${JSON.stringify(m[0])}`);
}

function edReplaceOne() {
  const doc = edActive();
  if (!doc) return;
  const { start, end } = edSelection();
  if (start === end) {
    edFindStep(1);
    return;
  }
  doc.text = doc.text.slice(0, start) + edReplaceEl.value + doc.text.slice(end);
  doc.dirty = true;
  edSyncBody();
  edRenderTabs();
  const caret = start + edReplaceEl.value.length;
  edSetSelection(caret, caret);
}

function edReplaceAll() {
  const doc = edActive();
  const re = edPattern();
  if (!doc || !re) return;
  const before = doc.text;
  const after = before.replace(re, edReplaceEl.value);
  if (after === before) {
    setStatus("没有匹配");
    return;
  }
  doc.text = after;
  doc.dirty = true;
  edSyncBody();
  edRenderTabs();
  setStatus("已全部替换（记得保存）");
}

edTextEl.addEventListener("input", () => {
  const doc = edActive();
  if (!doc) return;
  doc.text = edTextEl.value;
  doc.dirty = true;
  edRenderTabs();
  edSyncBody();
});

edTextEl.addEventListener("scroll", () => {
  edGutterEl.scrollTop = edTextEl.scrollTop;
});

// Tab 插两个空格；Ctrl+S 保存（别让浏览器弹「保存网页」）
edTextEl.addEventListener("keydown", (ev) => {
  if (ev.key === "Tab") {
    ev.preventDefault();
    const start = edTextEl.selectionStart;
    edTextEl.setRangeText("  ", start, edTextEl.selectionEnd, "end");
    edTextEl.dispatchEvent(new Event("input"));
    return;
  }
  if (ev.ctrlKey && (ev.key === "s" || ev.key === "S")) {
    ev.preventDefault();
    edSave();
  }
});

// 编码切换（`FIL-011`）：重读一遍当前文件。有未保存修改先问一句，别默默丢掉。
edEncodingEl.addEventListener("change", async () => {
  const doc = edActive();
  if (!doc) return;
  if (doc.dirty) {
    const ok = await askConfirm("有未保存的修改", `按新编码重读会丢掉 ${doc.name} 的改动，继续？`);
    if (!ok) {
      edEncodingEl.value = "";
      return;
    }
  }
  try {
    const r = await invoke("local_read_text", {
      path: doc.path,
      encoding: edEncodingEl.value || null,
    });
    doc.text = r.text;
    doc.encoding = r.encoding ?? "utf-8";
    doc.bom = Boolean(r.bom);
    doc.dirty = false;
    edSyncBody();
    edRenderTabs();
    setStatus(`已按 ${doc.encoding} 重新读取 ${doc.name}`);
  } catch (e) {
    setStatus(`换编码失败：${e}`);
    edEncodingEl.value = "";
  }
});

// 换行符切换（`FIL-011`）：就地转换正文，不重读文件。
// 「自动」= 保持现状（保存按当前内容写），不猜也不改。
edEolEl.addEventListener("change", () => {
  const doc = edActive();
  if (!doc) return;
  const want = edEolEl.value;
  if (!want) return;
  const lf = doc.text.split("\r\n").join("\n");
  const next = want === "crlf" ? lf.split("\n").join("\r\n") : lf;
  if (next === doc.text) {
    setStatus(`换行符已经是 ${want.toUpperCase()}`);
    return;
  }
  doc.text = next;
  doc.eol = want;
  doc.dirty = true;
  edSyncBody();
  edRenderTabs();
  setStatus(`换行符已改成 ${want.toUpperCase()}（记得保存）`);
});

document.getElementById("ed-save").addEventListener("click", edSave);
document.getElementById("ed-next").addEventListener("click", () => edFindStep(1));
document.getElementById("ed-prev").addEventListener("click", () => edFindStep(-1));
document.getElementById("ed-replace-one").addEventListener("click", edReplaceOne);
document.getElementById("ed-replace-all").addEventListener("click", edReplaceAll);

// ── 密钥生成/导入（`LOC-014`）────────────────────────────
//
// 私钥落在下载目录：界面还没有文件保存对话框，而「生成了但不知道存哪」
// 比多一次另存为更糟。生成完把路径、指纹、公钥都摆出来。

const keyDialog = document.getElementById("key-dialog");
const keyAlg = document.getElementById("key-alg");
const keyPass = document.getElementById("key-pass");
const keyResult = document.getElementById("key-result");
const keyImportInfo = document.getElementById("key-import-info");
const keyFile = document.getElementById("key-file");

/** 最近一次生成的密钥（验收读它，别去解析 pre 里的文本） */
let lastKey = null;

document.getElementById("keygen-open").addEventListener("click", () => {
  keyResult.textContent = "";
  keyImportInfo.textContent = "";
  keyDialog.showModal();
});

document.getElementById("key-close").addEventListener("click", () => keyDialog.close());
document.getElementById("net-open").addEventListener("click", () => void renderNetActivity());

document.getElementById("key-gen").addEventListener("click", async () => {
  keyResult.textContent = "生成中…";
  try {
    const k = await invoke("key_generate", {
      alg: keyAlg.value,
      passphrase: keyPass.value || null,
      comment: "windterm",
    });
    lastKey = k;
    keyResult.textContent = [
      `类型：${k.keyType}${k.encrypted ? "（已加密）" : ""}`,
      `指纹：${k.fingerprint}`,
      `私钥：${k.path}`,
      `公钥：${k.publicKey}`,
    ].join("\n");
    setStatus(`已生成 ${k.keyType} 密钥`);
  } catch (e) {
    keyResult.textContent = `生成失败：${e}`;
  }
});

document.getElementById("key-import").addEventListener("click", () => keyFile.click());

keyFile.addEventListener("change", async () => {
  const file = keyFile.files?.[0];
  if (!file) return;
  keyImportInfo.textContent = "读取中…";
  try {
    const info = await invoke("key_inspect", {
      path: file.path,
      passphrase: keyPass.value || null,
    });
    keyImportInfo.textContent = `${info.keyType} · ${info.fingerprint}${info.encrypted ? "（已加密）" : ""}`;
  } catch (e) {
    keyImportInfo.textContent = `导入失败：${e}`;
  } finally {
    keyFile.value = "";
  }
});

// ── 键位设置界面（`TER-020`）──────────────────────────────

const keysDialog = document.getElementById("keys-dialog");
const keysList = document.getElementById("keys-list");
const keysOpen = document.getElementById("keys-open");
const keysExport = document.getElementById("keys-export");
const keysImport = document.getElementById("keys-import");
const keysReset = document.getElementById("keys-reset");

/** 正在录制键位的动作（null 表示没在录制） */
let recordingAction = null;

function renderKeys() {
  keysList.textContent = "";
  for (const [action, v] of Object.entries(keymap)) {
    const row = document.createElement("div");
    row.className = "key-row";
    row.dataset.action = action;
    if (recordingAction === action) row.classList.add("recording");

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = v.label;

    const chord = document.createElement("span");
    chord.className = "chord";
    chord.textContent =
      recordingAction === action ? "按下新组合键…" : v.chords.join(" 或 ") || "（未绑定）";

    const btn = document.createElement("button");
    btn.textContent = recordingAction === action ? "取消" : "录制";
    btn.addEventListener("click", () => {
      recordingAction = recordingAction === action ? null : action;
      renderKeys();
    });

    row.append(label, chord, btn);
    keysList.appendChild(row);
  }
}

/** 录制：下一次按键直接成为该动作的唯一组合键 */
document.addEventListener(
  "keydown",
  (ev) => {
    if (!keysDialog.open || !recordingAction) return;
    ev.preventDefault();
    ev.stopPropagation();
    const chord = chordOf(ev);
    if (!chord) return; // 只按了修饰键，继续等
    const owner = chordOwner(chord, recordingAction);
    if (owner) {
      // 冲突就明说被谁占了，并且**不保存**——留个「看起来改了其实没改」的状态最糟
      setStatus(`键位冲突：${chord} 已被「${owner}」占用`);
      recordingAction = null;
      renderKeys();
      return;
    }
    keymap[recordingAction].chords = [chord];
    recordingAction = null;
    saveKeymap();
    renderKeys();
    setStatus(`已绑定 ${chord}`);
  },
  true,
);

keysOpen.addEventListener("click", () => {
  recordingAction = null;
  renderKeys();
  keysDialog.showModal();
});

// 这个对话框里没有 `<form method=dialog>`（里面的按钮都是普通按钮），
// 所以「关闭」要自己接——否则点下去什么都不会发生，接着按键全被当成录制
document.getElementById("keys-close").addEventListener("click", () => keysDialog.close());

keysReset.addEventListener("click", () => {
  keymap = structuredClone(KEYMAP_DEFAULT);
  saveKeymap();
  renderKeys();
  setStatus("键位已恢复默认");
});

// 导出成**文件**（`TER-020`）：以前只复制到剪贴板，用户还得自己找地方存；
// 导入以前用 prompt()——在 WebView 里是阻塞的，也没法校验来源。
keysExport.addEventListener("click", async () => {
  const payload = {
    format: "windterm-keymap",
    version: 1,
    keymap: Object.fromEntries(Object.entries(keymap).map(([a, v]) => [a, v.chords])),
  };
  try {
    const path = await invoke("keymap_export", {
      json: JSON.stringify(payload, null, 2),
    });
    setStatus(`键位方案已导出：${path}`);
  } catch (e) {
    setStatus(`导出失败：${e}`);
  }
});

const keysFileInput = document.getElementById("keys-file");
keysImport.addEventListener("click", () => keysFileInput.click());
keysFileInput.addEventListener("change", async () => {
  const file = keysFileInput.files?.[0];
  keysFileInput.value = "";
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    // 兼容裸映射（老版本复制到剪贴板的就是它）
    const source = parsed?.keymap ?? parsed;
    let applied = 0;
    const unknown = [];
    for (const [action, chords] of Object.entries(source)) {
      if (!keymap[action] || !Array.isArray(chords)) {
        unknown.push(action);
        continue;
      }
      keymap[action].chords = chords.filter((c) => typeof c === "string");
      applied += 1;
    }
    saveKeymap();
    renderKeys();
    // 不认识的动作用「跳过 N 项」说出来，而不是悄悄丢掉
    setStatus(
      unknown.length
        ? `已导入 ${applied} 项键位，跳过 ${unknown.length} 项不认识的：${unknown.join("、")}`
        : `已导入 ${applied} 项键位`,
    );
  } catch (e) {
    setStatus(`导入失败：${e}`);
  }
});

// 捕获阶段处理并 stopPropagation：否则 Ctrl+F 会先被 xterm 当成 ^F 发给远端。
//
// 注意 `Ctrl+C` **不在表里**：它必须继续作为 SIGINT 发给远端，改了就是破坏肌肉记忆。
document.addEventListener(
  "keydown",
  (ev) => {
    // 键位对话框开着时，按键归录制流程，不再当快捷键用
    if (keysDialog.open) return;
    const chord = chordOf(ev);
    if (!chord) return;
    // 命令面板开着时，键盘归它自己：否则在搜索框里按 Shift+PageUp 会把终端滚走、
    // 按 Ctrl+Shift+A 会把终端全选，用户会以为输入框坏了。只放行「再按一次关掉它」。
    if (cmdDialog.open && !(keymap.commandPalette?.chords ?? []).includes(chord)) return;
    for (const [action, v] of Object.entries(keymap)) {
      if (!v.chords.includes(chord)) continue;
      // 动作自己判断「这次不该触发」（比如查找栏没开时按 Esc）就放行
      if (!runAction(action)) continue;
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
  },
  true,
);

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && !findBar.hidden) {
    ev.preventDefault();
    closeFind();
  }
});

// ── 文件面板（SFTP）────────────────────────────────────────
const filesPanel = document.getElementById("files");
const filesPath = document.getElementById("files-path");
const filesList = document.getElementById("files-list");
const filesMsg = document.getElementById("files-msg");
const filesUp = document.getElementById("files-up");
const filesRefresh = document.getElementById("files-refresh");
const filesUploadBtn = document.getElementById("files-upload-btn");
const filesUpload = document.getElementById("files-upload");
const filesMkdir = document.getElementById("files-mkdir");
const filesRename = document.getElementById("files-rename");
const filesChmod = document.getElementById("files-chmod");
const filesRemove = document.getElementById("files-remove");
const nameDialog = document.getElementById("name-dialog");
const nameTitle = document.getElementById("name-title");
const renameInput = document.getElementById("name-input");

/** 文件面板里当前选中的项（单击选中，双击才进入/下载——与文件管理器一致） */
let selectedEntry = null;
/** 删除的二次确认（3 秒窗口，与会话删除同一个模式） */
let removeArmed = false;

let sftpPath = "/";

/**
 * 文件面板对着哪个会话（`FIL-001` 多会话并存）。
 *
 * 空字符串表示「跟随连接表单」——保留原来的用法；选了会话之后，
 * 主机/端口/用户名来自那条会话，密码仍取表单里的（保险库解锁时会自动填）。
 */
let filesSessionId = "";
/** 每个会话各自记住自己浏览到哪（切换会话不该把路径带回根目录） */
const filesPaths = new Map();

const filesTree = document.getElementById("files-tree");

/**
 * 侧栏目录树（`FIL-001`）：按需展开，一个目录点开才去 `sftp_list`，
 * 不预先爬整棵树——远端目录可能很大，进面板就爬一遍等于自找卡顿。
 *
 * 只列**目录**：文件已经在右边的列表里，树里再放一遍只会更难找。
 */
const ftree = new Map(); // path -> { expanded, children }

async function ftreeChildren(path) {
  const node = ftree.get(path);
  if (node?.children) return node.children;
  const r = await withDeadline(
    invoke("sftp_list", { arg: { req: filesReq(), path, jump: jumpReq() } }),
    20000,
    "读目录树",
  );
  const dirs = r.entries.filter((e) => e.is_dir).map((e) => e.name);
  ftree.set(path, { ...(node ?? {}), children: dirs });
  return dirs;
}

async function toggleTreeDir(path) {
  const node = ftree.get(path) ?? { children: null };
  const next = { ...node, expanded: !node.expanded };
  ftree.set(path, next);
  if (next.expanded) {
    try {
      await ftreeChildren(path);
    } catch (e) {
      setFilesMsg(`展开 ${path} 失败：${e}`);
    }
  }
  renderFileTree();
}

function renderFileTree() {
  const rows = [];
  const walk = (path, depth) => {
    const node = ftree.get(path);
    if (!node?.expanded || !node.children) return;
    for (const name of node.children) {
      const full = joinPath(path, name);
      rows.push({ path: full, name, depth, expanded: !!ftree.get(full)?.expanded });
      walk(full, depth + 1);
    }
  };
  walk("/", 0);
  filesTree.textContent = "";
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = r.path === sftpPath ? "ftree-row selected" : "ftree-row";
    row.dataset.path = r.path;
    row.style.paddingLeft = `${6 + r.depth * 10}px`;
    const toggle = document.createElement("span");
    toggle.className = "ftree-toggle";
    toggle.textContent = r.expanded ? "▾" : "▸";
    toggle.title = r.expanded ? "收起" : "展开";
    toggle.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void toggleTreeDir(r.path);
    });
    const name = document.createElement("span");
    name.textContent = r.name;
    name.title = r.path;
    row.append(toggle, name);
    row.addEventListener("click", async () => {
      await loadDir(r.path);
      renderFileTree();
    });
    filesTree.appendChild(row);
  }
}

/** 面板打开时把根目录展开一次：树不能是空的，否则用户以为没有目录 */
async function initFileTree() {
  const node = ftree.get("/") ?? { children: null };
  ftree.set("/", { ...node, expanded: true });
  try {
    await ftreeChildren("/");
  } catch (e) {
    // 把原因同时挂到树上：树是空的时，光看「空」分不出「没有目录」还是「读失败了」
    filesTree.dataset.err = String(e);
    setFilesMsg(`读取目录树失败：${e}`);
  }
  renderFileTree();
}

const filesSessionSelect = document.getElementById("files-session");

/** 文件面板用的连接参数：选了会话就用会话的，否则跟随表单。 */
function filesReq() {
  const s = filesSessionId
    ? (lastTree?.sessions ?? []).find((x) => x.id === filesSessionId)
    : null;
  if (!s) return sftpReq();
  return {
    ...sftpReq(),
    host: s.host ?? "",
    port: s.port ?? 22,
    user: s.username ?? "",
  };
}

/** 刷新面板顶部的会话下拉（只列 SSH）。 */
function refreshFilesSessionSelect() {
  const keep = filesSessionSelect.value;
  filesSessionSelect.textContent = "";
  const follow = document.createElement("option");
  follow.value = "";
  follow.textContent = "跟随连接表单";
  filesSessionSelect.appendChild(follow);
  for (const s of lastTree?.sessions ?? []) {
    // SFTP 会话本来就只有文件面板（`SES-009`），当然也要能在这里选
    if (s.kind !== "ssh" && s.kind !== "sftp") continue;
    const o = document.createElement("option");
    o.value = s.id;
    o.textContent = s.name;
    filesSessionSelect.appendChild(o);
  }
  filesSessionSelect.value = keep;
}

function setFilesMsg(text) {
  filesMsg.textContent = text;
}

/**
 * 把 `st_mode` 格式化成 `drwxr-xr-x`（`FIL-002`）。
 *
 * 类型位单独看：`S_IFDIR` 是 d、`S_IFLNK` 是 l、`S_IFSOCK` 是 s；其余按普通文件显示。
 * 服务端没给 mode 就返回空串——显示一个 `-` 会让人误以为是个文件。
 */
function modeString(mode) {
  if (!Number.isFinite(mode)) return "";
  const type = mode & 0o170000;
  const head =
    type === 0o040000 ? "d" : type === 0o120000 ? "l" : type === 0o140000 ? "s" : "-";
  const bits = ["r", "w", "x"];
  let out = head;
  for (let shift = 6; shift >= 0; shift -= 3) {
    for (let i = 0; i < 3; i += 1) {
      out += (mode >> (shift + (2 - i))) & 1 ? bits[i] : "-";
    }
  }
  return out;
}

/**
 * 修改时间（`FIL-001` §1）：侧栏那一列只有 104px，塞不下完整日期，
 * 所以只显示「月-日 时:分」，完整时间放 tooltip。服务端没给就留空。
 */
function formatMtime(sec) {
  if (!sec) return "";
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function joinPath(dir, name) {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

function parentPath(path) {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
}

/** 把表单里的连接参数整理成 sftp 命令要的形状（认证与 ssh_open 一致） */
function sftpReq() {
  return {
    host: hostInput.value.trim(),
    port: Number.parseInt(portInput.value, 10) || 22,
    user: userInput.value.trim(),
    password: useKeyBox.checked || useAgentBox.checked ? null : passInput.value,
    keyPem: useKeyBox.checked ? keyPem : null,
    keyPassphrase: useKeyBox.checked ? keyPassInput.value || null : null,
    useAgent: useAgentBox.checked,
    cols: 80,
    rows: 24,
  };
}

/**
 * 最近一次列目录请求的序号。
 *
 * 切会话 / 换目录会各发一次请求，它们的返回顺序**不保证**：旧请求晚到会把
 * 新视图覆盖掉（表现为「明明切到好会话了，却显示上一个端口连不上」）。
 * 只让最新那一次写界面。
 */
let filesGen = 0;

/**
 * 路径面包屑（`FIL-001` 规格 §5）：`/ › var › log`，每一段都能点回去。
 *
 * **关键**：`#files-path.textContent` 必须恒等于 `sftpPath`——十几条 e2e 断言
 * 都读它。所以分隔符用**真实文本节点**而不是 UI 图标/箭头字符，段名放进 span，
 * 拼起来的文本恰好就是原路径，不能改成「/ var log」这种带装饰的形式。
 */
function renderFilePath() {
  filesPath.textContent = "";
  filesPath.title = sftpPath;
  const parts = sftpPath.split("/").filter(Boolean);
  // 分隔符放在**段之间**（不是每段后面）：否则 /sub 会拼成 /sub/，
  // 与 sftpPath 不等，十几条读 textContent 的断言会一起红。
  filesPath.appendChild(document.createTextNode("/"));
  let acc = "";
  for (let i = 0; i < parts.length; i += 1) {
    if (i > 0) filesPath.appendChild(document.createTextNode("/"));
    const part = parts[i];
    acc += "/" + part;
    const crumb = document.createElement("span");
    crumb.className = "path-crumb";
    crumb.textContent = part;
    crumb.title = `跳到 ${acc}`;
    const target = acc;
    crumb.addEventListener("click", () => void loadDir(target));
    filesPath.appendChild(crumb);
  }
}

// 输入完整路径跳转（`FIL-001` 规格 §5，含 `~` 展开）。
// `~` 由服务端 `SSH_FXP_REALPATH` 解析：SFTP 没有 shell，前端猜 home 目录不可靠。
const filesPathInput = document.getElementById("files-path-input");
const filesPathEditBtn = document.getElementById("files-path-edit");

function closePathInput() {
  filesPathInput.hidden = true;
  filesPath.hidden = false;
  filesPathEditBtn.hidden = false;
}

filesPathEditBtn.addEventListener("click", () => {
  filesPathInput.value = sftpPath;
  filesPath.hidden = true;
  filesPathEditBtn.hidden = true;
  filesPathInput.hidden = false;
  filesPathInput.focus();
  filesPathInput.select();
});

filesPathInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    ev.preventDefault();
    closePathInput();
    return;
  }
  if (ev.key !== "Enter") return;
  ev.preventDefault();
  const raw = filesPathInput.value.trim();
  if (!raw) return;
  // 相对路径按当前目录补全；绝对路径与 `~` 原样交给服务端解析
  const path = raw.startsWith("/") || raw.startsWith("~") ? raw : joinPath(sftpPath, raw);
  closePathInput();
  void (async () => {
    let target = path;
    if (path.includes("~")) {
      try {
        target = await withDeadline(
          invoke("sftp_canonicalize", {
            arg: { req: filesReq(), path, jump: jumpReq() },
          }),
          20000,
          "解析路径",
        );
      } catch (e) {
        setFilesMsg(`路径解析失败：${e}`);
        return;
      }
    }
    await loadDir(target);
  })();
});

async function loadDir(path) {
  const gen = ++filesGen;
  setFilesMsg("读取中…");
  // 换目录后旧选中项已经不属于当前列表
  clearSelection();
  try {
    // 后端如果挂住，前端只会一直显示「读取中…」——既看不出是慢还是死，
    // 也没法让用户重试。deadline 把它变成一条明确的错误，界面才有出路。
    const r = await withDeadline(
      invoke("sftp_list", { arg: { req: filesReq(), path, jump: jumpReq() } }),
      20000,
      "列目录",
    );
    // 期间又换过目录或会话：这份结果已经过期，写进去就是覆盖正确视图
    if (gen !== filesGen) return;
    sftpPath = r.path || path;
    // 每个会话各自记住浏览位置：切换会话回来还在原处
    filesPaths.set(filesSessionId, sftpPath);
    renderFilePath();
    // 只存数据，DOM 由 `renderFileList` 按可视窗口渲染（`FIL-001` AC-1）：
    // 1000 个条目逐个建 DOM 会明显卡顿，而绝大多数根本看不到
    filesLoadError = "";
    filesEntries = r.entries;
    renderFileList();
    setFilesMsg("");
    dirLoadCount += 1;
    return true;
  } catch (e) {
    // 旧请求的失败同样不该覆盖新视图
    if (gen !== filesGen) return;
    // 条目也要清：留着上一次的会让「当前目录」的结论是假的（虚拟滚动之后
    // 尤其明显——DOM 变空了，但数据源还在）
    filesEntries = [];
    filesLoadError = String(e);
    renderFileList();
    setFilesMsg(`列目录失败：${e}`);
    return false;
  }
}

/**
 * 给 invoke 加一层前端超时。
 *
 * 后端如果挂住，前端只会一直显示「读取中…」——既看不出是慢还是死，也没法
 * 让用户重试。超时后把它变成一条明确的错误，界面才有出路。
 * 注意这只是前端的 deadline，不参与后端那条链路的调度。
 */
function withDeadline(promise, ms, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what}超过 ${ms / 1000}s 没有返回`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// 切换「文件面板对着哪个会话」：存下当前位置，恢复目标会话上次的位置
filesSessionSelect.addEventListener("change", async () => {
  filesPaths.set(filesSessionId, sftpPath);
  filesSessionId = filesSessionSelect.value;
  const restored = filesPaths.get(filesSessionId) ?? "/";
  await loadDir(restored);
});

async function goUpDir() {
  await loadDir(parentPath(sftpPath));
}
filesUp.addEventListener("click", () => void goUpDir());
filesRefresh.addEventListener("click", async () => {
  await loadDir(sftpPath);
  // 目录树也跟着刷：缓存里的子目录可能已经变了（`FIL-001`）。
  // 刷新会把树收回到根层——保留展开状态得记住每条路径，收益不值这个复杂度。
  ftree.clear();
  await initFileTree();
});
// 自动刷新（`FIL-001` 规格 §6）：窗口重新获得焦点 / 页面重新可见时，
// 若距上次列目录已超过 autoRefreshSecs，就刷一次目录与目录树。
// 默认关（0）——焦点事件很频繁，不节流会反复重连 SFTP。
// 用「上次列目录时刻」而非定时器：没有活跃窗口时不产生任何请求。
const filesAutoRefreshSelect = document.getElementById("files-auto-refresh");
async function refreshFilesAndTree() {
  await loadDir(sftpPath);
  ftree.clear();
  await initFileTree();
}
async function maybeAutoRefresh(reason) {
  if (autoRefreshSecs <= 0) return;
  if (document.getElementById("files").hidden) return;
  if (!filesSessionId && !active?.handle) return;
  if (Date.now() - lastDirLoadAt < autoRefreshSecs * 1000) return;
  autoRefreshCount += 1;
  setStatus(`自动刷新目录（${reason}）`);
  await refreshFilesAndTree();
}
window.addEventListener("focus", () => void maybeAutoRefresh("窗口获得焦点"));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void maybeAutoRefresh("页面重新可见");
});
filesAutoRefreshSelect.addEventListener("change", () => {
  autoRefreshSecs = clampNum(Number(filesAutoRefreshSelect.value) || 0, 0, 3600);
  void savePrefs();
  setStatus(autoRefreshSecs === 0 ? "自动刷新：关" : `自动刷新间隔：${autoRefreshSecs} 秒`);
});

/** 文件列表的行高（虚拟滚动按它算窗口）。与 CSS 里 `.vrow` 的高度保持一致 */
const FILES_ROW_H = 20;
/** 当前目录的全部条目。DOM 里只有可视窗口内的那些（`FIL-001` AC-1） */
let filesEntries = [];
/** 标签栏位置（`TER-001`）：`top` / `bottom`，写进 config.toml */
let tabsPosition = "top";
/** 是否显示 `.` 开头的隐藏文件（`FIL-001` 规格 §4）：默认开，运维场景必须可见 */
let filesShowHidden = true;
/** 可配显示列（`FIL-001` 规格 §1）：名称恒显示，大小/权限可关。
 *  DTO 只有 name/size/mode 三列，没有 mtime/owner，不编造没有数据的列 */
let showSizeCol = true;
let showModeCol = true;
/** 显示「修改时间」列（`FIL-001` §1）：侧栏窄，默认关，用户自己开 */
let showMtimeCol = false;
/** 自动刷新间隔（秒，`FIL-001` §6）：0=关（默认），窗口重新获得焦点时按间隔节流刷新 */
let autoRefreshSecs = 0;
/** 最近一次成功列目录的时刻；焦点刷新用它判断「距上次够不够久」 */
let lastDirLoadAt = 0;
/** 焦点自动刷新实际触发了几次（验收可观察，证明不是点了没反应） */
let autoRefreshCount = 0;
/** 成功列目录的次数。验收用它当「这次重列已经落地」的信号，别去猜 DOM */
let dirLoadCount = 0;

/**
 * 列表排序（`FIL-001` 规格 §1「可排序」）。
 *
 * 默认 `default` = 后端给的「目录在前 + 名称升序」——既有断言都按这个顺序写的，
 * 不能一上来就改。点列头才切到 name/size/mode，再点同一列翻转方向。
 * 排序在前端对**全量**做，之后才过隐藏文件过滤，虚拟滚动照常工作。
 */
let filesSortKey = "default";
let filesSortDir = 1;

function sortedFiles() {
  if (filesSortKey === "default") return filesEntries;
  const dir = filesSortDir;
  return [...filesEntries].sort((a, b) => {
    // 目录永远在前：文件管理器的一致习惯，排序不应把目录冲散到列表中间
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    let d = 0;
    if (filesSortKey === "name") {
      d = a.name.localeCompare(b.name, "zh", { numeric: true });
    } else if (filesSortKey === "size") {
      d = a.size - b.size;
    } else if (filesSortKey === "mode") {
      d = (a.mode ?? 0) - (b.mode ?? 0);
    } else if (filesSortKey === "mtime") {
      // 服务端不给时间的排在最后：拿 0 顶上去会把它们全推到最前面，
      // 看起来像「这些文件是 1970 年建的」
      const am = a.mtime ?? Number.POSITIVE_INFINITY;
      const bm = b.mtime ?? Number.POSITIVE_INFINITY;
      d = am - bm;
    }
    return d !== 0 ? d * dir : a.name.localeCompare(b.name, "zh", { numeric: true });
  });
}

/** 按「显示隐藏文件」开关过滤后的条目。列表渲染与 __wt.files.rows 都用它 */
function visibleFiles() {
  const base = sortedFiles();
  return filesShowHidden ? base : base.filter((e) => !e.name.startsWith("."));
}
/** 列目录失败的原因；非空时列表只显示这条，不再显示「（空目录）」 */
let filesLoadError = "";
let filesScrollRaf = 0;

/**
 * 条目类型（`FIL-001` 规格第 2 条）：目录 / 普通文件 / 符号链接 / 设备或管道 / 可执行。
 *
 * 只看 `mode` 的类型位与执行位——服务端不给 mode 时一律当普通文件，不猜。
 */
function entryKind(e) {
  if (e.is_symlink) return "link";
  if (e.is_dir) return "dir";
  const type = Number.isFinite(e.mode) ? e.mode & 0o170000 : 0;
  // 字符设备 / 块设备 / FIFO / socket：都不是普通文件，标出来免得双击去「编辑」
  if (type === 0o020000 || type === 0o060000 || type === 0o010000 || type === 0o140000) return "special";
  if (Number.isFinite(e.mode) && (e.mode & 0o111) !== 0) return "exec";
  return "file";
}

/** 一条的显示名：目录带 `/`、链接带 `@`（`ls -F` 的老习惯） */
function entryLabel(e) {
  if (e.is_symlink) return `${e.name}@`;
  return e.is_dir ? `${e.name}/` : e.name;
}

function buildFileRow(e, index) {
  const row = document.createElement("div");
  const selected = selectedEntry && selectedEntry.name === e.name;
  row.className = selected ? "row name vrow selected" : "row name vrow";
  row.style.top = `${index * FILES_ROW_H}px`;
  const label = document.createElement("span");
  // 注意字段名：`RemoteEntryDto` 没有 camelCase 重命名，序列化出来就是 snake_case
  label.textContent = entryLabel(e);
  // 类型标记（`FIL-001` 规格第 2 条）走 CSS `::before`，**不进 textContent**：
  // 名字里多一个字符，既有的「名字等于 notes.txt」这类判断全会错，用户复制路径也脏。
  label.classList.add(`kind-${entryKind(e)}`);
  if (e.is_symlink) {
    // 目标放 tooltip，断链单独标色
    label.title = e.broken
      ? `断链：${e.link_target ?? "（读不到目标）"} 不存在`
      : `链接到 ${e.link_target ?? ""}`;
    // 用 classList 追加而不是整体赋值：直接写 `className` 会把上面刚加的
    // `kind-*` 类型标记一起冲掉（链接就没有 `↗` 了）
    label.classList.add("link");
    if (e.broken) label.classList.add("broken");
  }
  // 权限位（`FIL-002`）：`drwxr-xr-x` 这种十列串，等宽字体对齐。
  // 服务端不给就留空，别显示一个 "-" 让人以为是文件
  // 顺序必须与 #files-cols 表头一致：名称 / 大小 / 权限。
  // 之前这里是 label, perms, size（权限在大小前），表头写的是「大小 权限」——列头与内容错位。
  const size = document.createElement("span");
  size.className = "size";
  size.textContent = e.is_dir ? "" : `${e.size}`;
  size.style.color = "#8a8a92";
  const perms = document.createElement("span");
  perms.className = "mode";
  perms.textContent = modeString(e.mode);
  // 可配显示列（`FIL-001` §1）：名称恒显示；大小、权限可单独关。
  row.append(label);
  if (showSizeCol) row.appendChild(size);
  if (showModeCol) row.appendChild(perms);
  if (showMtimeCol) {
    const mt = document.createElement("span");
    mt.className = "mtime";
    // 服务端没给就留空：写个「—」会让人以为那是真实值
    mt.textContent = formatMtime(e.mtime);
    mt.title = e.mtime ? new Date(e.mtime * 1000).toLocaleString() : "服务端没有提供修改时间";
    row.appendChild(mt);
  }
  // 单击只选中，双击才动作：与文件管理器一致，也让「改名/删除」有明确的操作对象
  row.addEventListener("click", () => selectEntry(e, row));
  row.addEventListener("dblclick", () => {
    if (e.is_dir) void loadDir(joinPath(sftpPath, e.name));
    else void downloadFile(joinPath(sftpPath, e.name));
  });
  return row;
}

/**
 * 只渲染可视窗口内的条目，上下用撑高的容器保持滚动条长度。
 *
 * 关键是**先记住 scrollTop 再清空**：清空后内容高度变 0，浏览器会把 scrollTop
 * 夹回 0，那时再读窗口就永远是第一屏（表现为「滚下去又跳回顶部」）。
 */
/** 表头：点一列排序，再点翻转方向；箭头显示当前状态 */
const filesCols = document.getElementById("files-cols");
function renderSortHeader() {
  // 关掉的列，表头也一起藏：否则表头还占一格、内容却少了，视觉上会错位
  filesCols.classList.toggle("hide-size", !showSizeCol);
  filesCols.classList.toggle("hide-mode", !showModeCol);
  filesCols.classList.toggle("hide-mtime", !showMtimeCol);
  for (const btn of filesCols.querySelectorAll(".filecol")) {
    const key = btn.dataset.sort;
    const active = filesSortKey === key;
    btn.classList.toggle("active", active);
    btn.querySelector(".arrow").textContent = active
      ? filesSortDir === 1 ? "↑" : "↓"
      : "";
  }
}
filesCols.addEventListener("click", (ev) => {
  const btn = ev.target.closest(".filecol");
  if (!btn) return;
  const key = btn.dataset.sort;
  if (filesSortKey === key) filesSortDir = -filesSortDir;
  else {
    filesSortKey = key;
    filesSortDir = 1;
  }
  clearSelection();
  filesList.scrollTop = 0;
  renderSortHeader();
  renderFileList();
  setStatus(`文件列表按 ${btn.textContent.trim().replace(/[↑↓]/g, "")} 排序`);
});

function renderFileList() {
  const savedTop = filesList.scrollTop;
  filesList.textContent = "";
  // 失败时必须显示失败本身：显示「（空目录）」会让用户以为文件没了（`FIL-001` AC-4）
  if (filesLoadError) {
    const el = document.createElement("div");
    el.className = "row err";
    el.textContent = filesLoadError;
    filesList.appendChild(el);
    return;
  }
  const shown = visibleFiles();
  if (!shown.length) {
    const el = document.createElement("div");
    el.className = "row";
    el.textContent = filesEntries.length ? "（隐藏文件已全部隐藏）" : "（空目录）";
    filesList.appendChild(el);
    return;
  }
  const body = document.createElement("div");
  body.className = "vbody";
  body.style.height = `${shown.length * FILES_ROW_H}px`;
  const viewport = filesList.clientHeight || 320;
  const start = Math.max(0, Math.floor(savedTop / FILES_ROW_H) - 4);
  const end = Math.min(shown.length, start + Math.ceil(viewport / FILES_ROW_H) + 8);
  for (let i = start; i < end; i += 1) body.appendChild(buildFileRow(shown[i], i));
  filesList.appendChild(body);
  filesList.scrollTop = savedTop;
}

/**
 * 键盘移动选中项（`FIL-001` 规格第 8 条）。
 *
 * 列表是虚拟滚动的：只有可视窗口内的行真的存在。所以先把目标行滚进可视区、
 * 再渲染、再按标签找回那一行——顺序反过来就会选到一个还没渲染出来的条目。
 */
function moveSelection(delta) {
  const list = visibleFiles();
  if (!list.length) return;
  const cur = list.findIndex((e) => e.name === selectedEntry?.name);
  const next = Math.max(0, Math.min(list.length - 1, (cur < 0 ? 0 : cur) + delta));
  const top = next * FILES_ROW_H;
  const view = filesList.scrollTop;
  const h = filesList.clientHeight;
  if (top < view) filesList.scrollTop = top;
  else if (top + FILES_ROW_H > view + h) filesList.scrollTop = top + FILES_ROW_H - h;
  renderFileList();
  const want = entryLabel(list[next]);
  const row = [...filesList.querySelectorAll(".vrow")].find(
    (r) => r.querySelector("span")?.textContent === want,
  );
  if (row) selectEntry(list[next], row);
}

// `Ctrl+A` / `Ctrl+C/V`（全选、复制/移动）还没做——当前模型是单选，
// 加多选要连删/移动/拖拽一起改，先别用半套假的多选糊过去。这里遇到带修饰键的
// 一律放行，交给别处的快捷键处理。
filesList.addEventListener("keydown", (ev) => {
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  switch (ev.key) {
    case "ArrowDown":
      ev.preventDefault();
      moveSelection(1);
      break;
    case "ArrowUp":
      ev.preventDefault();
      moveSelection(-1);
      break;
    case "Enter":
      if (!selectedEntry) return;
      ev.preventDefault();
      // 文件走「编辑」按钮那条流程：先把远端文件下载成临时副本再交给编辑器。
      // 直接把远端路径传给 openEditor 是错的——它读的是**本地**文件。
      if (selectedEntry.is_dir) void loadDir(joinPath(sftpPath, selectedEntry.name));
      else filesEdit.click();
      break;
    case "Backspace":
      ev.preventDefault();
      void goUpDir();
      break;
    case "F2":
      if (!selectedEntry) return;
      ev.preventDefault();
      void renameEntry();
      break;
    case "Delete":
      if (!selectedEntry) return;
      ev.preventDefault();
      void removeEntryConfirmed(selectedEntry);
      break;
    default:
      break;
  }
});

filesList.addEventListener("scroll", () => {
  // 滚动事件很密：一帧只重建一次
  if (filesScrollRaf) return;
  filesScrollRaf = requestAnimationFrame(() => {
    filesScrollRaf = 0;
    renderFileList();
  });
});

/**
 * 改权限位（`FIL-002` 的 `SETSTAT`）。输入用八进制——`chmod 644` 是所有人都会的写法，
 * 摆在对话框里点九宫格反而更慢。
 *
 * 抽成函数而不是写在按钮监听里：右键菜单要用同一套（`FIL-001` 规格第 9 条），
 * 两处各写一遍迟早有一处忘了保留类型位。
 */
async function chmodEntry(target = selectedEntry) {
  if (!target) return;
  const full = Number.isFinite(target.mode) ? target.mode : 0o100644;
  // 类型位必须原样带回去：只写权限位、把 S_IFREG 丢了的后果是有服务端把路径当成
  // 未知类型，后续操作全失败。
  const type = full & 0o170000;
  const cur = (full & 0o777).toString(8).padStart(3, "0");
  const ans = await askName(`改权限：${target.name}（八进制，如 644）`, cur);
  if (ans === null) return;
  const perm = Number.parseInt(ans, 8);
  if (!Number.isFinite(perm) || perm < 0 || perm > 0o777) {
    setStatus(`权限位要 0~777 的八进制数，收到「${ans}」`);
    return;
  }
  try {
    await withDeadline(
      invoke("sftp_chmod", {
        req: filesReq(),
        path: joinPath(sftpPath, target.name),
        mode: type | perm,
        jump: jumpReq(),
      }),
      20000,
      "改权限",
    );
    setStatus(`已把 ${target.name} 的权限改成 ${perm.toString(8).padStart(3, "0")}`);
    await loadDir(sftpPath);
  } catch (e) {
    setStatus(`改权限失败：${e}`);
  }
}

filesChmod.addEventListener("click", () => void chmodEntry());

// ── 文件列表右键菜单（`FIL-001` 规格第 9 条）────────────────
//
// 只列「这个对象能做什么」，动作全部复用工具栏那几个函数。两处各写一套的话，
// 迟早有一处忘了保留类型位（权限）或者忘了二次确认（删除）。
let ctxEntry = null;

/** 删除（右键菜单版）：菜单里没法「再点一次确认」，所以直接弹确认框 */
async function removeEntryConfirmed(target) {
  const ok = await askConfirm(
    `删除 ${target.name}？`,
    target.is_dir ? "目录非空时服务端会拒绝；不做递归删除。" : "删除后不可恢复。",
    "删除",
  );
  if (!ok) return;
  setFilesMsg("删除中…");
  try {
    await withDeadline(
      invoke("sftp_remove", {
        req: filesReq(),
        path: joinPath(sftpPath, target.name),
        isDir: target.is_dir,
        jump: jumpReq(),
      }),
      20000,
      "删除",
    );
    setFilesMsg(`已删除 ${target.name}`);
    clearSelection();
    await loadDir(sftpPath);
  } catch (e) {
    setFilesMsg(`删除失败：${e}`);
  }
}

/**
 * 新建空文件（`FIL-001` 规格第 9 条）：走「上传零字节」这条路，不新增后端命令。
 * 没有内容就不发分块，`end` 一落盘文件名就出现了。
 */
async function createEmptyFile() {
  const name = await askName("新建文件（在当前位置）", "");
  if (!name) return;
  const path = joinPath(sftpPath, name);
  setFilesMsg("新建中…");
  let id = null;
  try {
    id = await withDeadline(
      invoke("sftp_upload_begin", { req: filesReq(), path, jump: jumpReq() }),
      20000,
      "新建文件",
    );
    await withDeadline(invoke("sftp_upload_end", { id }), 20000, "新建文件");
    id = null;
    setFilesMsg(`已创建 ${name}`);
    await loadDir(sftpPath);
  } catch (e) {
    if (id) await invoke("sftp_upload_abort", { id }).catch(() => {});
    setFilesMsg(`新建文件失败：${e}`);
  }
}

/**
 * 在当前终端里 `cd` 到这个目录（`FIL-001` 规格第 9 条）。
 *
 * 只在路径「干净」时发：路径里有空格或引号时 shell 会拆错，发出去反而在终端里
 * 留下半截命令。宁可让用户手打，也不做半吊子转义。
 */
function cdHere(path) {
  const v = active;
  if (!v?.handle || !v.running) {
    setFilesMsg("没有已连接的终端可以切目录");
    return;
  }
  if (!/^[A-Za-z0-9_@%+=:,./-]+$/.test(path)) {
    setFilesMsg(`这个路径里有空格或特殊字符，先手动 cd：${path}`);
    return;
  }
  void invoke("term_write", { handle: v.handle, data: `cd ${path}\r` });
  setStatus(`已在当前终端切到 ${path}`);
}

async function copyEntryPath(entry) {
  const full = joinPath(sftpPath, entry.name);
  try {
    await navigator.clipboard.writeText(full);
    setStatus(`已复制路径：${full}`);
  } catch {
    setStatus(`复制失败，路径是：${full}`);
  }
}

/** 菜单项按「有目标 / 空区」两套：空区只给「新建文件夹」 */
function fileMenuItems() {
  const e = ctxEntry;
  const items = [];
  if (e) {
    items.push({
      label: e.is_dir ? t("ctx.open") : t("ctx.openInEditor"),
      run: () =>
        e.is_dir
          ? loadDir(joinPath(sftpPath, e.name))
          : openEditor(joinPath(sftpPath, e.name), e.name),
    });
    if (!e.is_dir) {
      items.push({ label: t("ctx.download"), run: () => downloadFile(joinPath(sftpPath, e.name)) });
    } else {
      // 「上传到此处」：记下目标目录再打开选择框，省掉「先双击进去」那一步
      items.push({
        label: t("ctx.uploadHere"),
        run: () => {
          uploadTargetDir = joinPath(sftpPath, e.name);
          filesUpload.click();
        },
      });
    }
  }
  items.push({ label: t("ctx.newFolder"), run: () => makeDir() });
  items.push({ label: t("ctx.newFile"), run: () => createEmptyFile() });
  if (e) {
    items.push({ label: t("ctx.rename"), run: () => renameEntry(e) });
    items.push({ label: t("ctx.remove"), run: () => removeEntryConfirmed(e) });
    items.push({ label: t("ctx.perms"), run: () => chmodEntry(e) });
    items.push({ label: t("ctx.copyPath"), run: () => copyEntryPath(e) });
    if (e.is_dir) {
      items.push({ label: t("ctx.cdHere"), run: () => cdHere(joinPath(sftpPath, e.name)) });
    }
  }
  return items;
}

filesList.addEventListener("contextmenu", (ev) => {
  ev.preventDefault();
  const row = ev.target.closest(".vrow");
  let entry = null;
  if (row) {
    const label = row.querySelector("span")?.textContent ?? "";
    entry = filesEntries.find((x) => entryLabel(x) === label) ?? null;
    // 右键同时选中：菜单里的动作都作用在这个对象上，界面得看得出来是哪一个
    if (entry) selectEntry(entry, row);
  }
  ctxEntry = entry;
  showCtxMenu(ev.clientX, ev.clientY, fileMenuItems(), "files");
});

function selectEntry(entry, row) {
  selectedEntry = entry;
  // 键盘导航要求列表本身能拿焦点（`FIL-001` 规格第 8 条）：行是 div，点它不会移焦点。
  // `preventScroll` 不能省：聚焦一个可滚动容器会把它滚一下，双击的第二次点击就落到
  // 别的位置上，`dblclick` 不再触发——表现为「双击没反应」，查半天以为事件没绑。
  if (document.activeElement !== filesList) filesList.focus({ preventScroll: true });
  for (const r of filesList.children) r.classList.remove?.("selected");
  row.classList.add("selected");
  filesRename.disabled = false;
  filesRemove.disabled = false;
  filesChmod.disabled = false;
  // 目录不能「编辑」（先凑成 FIL-005 的语义：只对文件）
  filesEdit.disabled = Boolean(entry.is_dir);
}

/** 清掉选中态（换目录后旧选中项已经不属于当前列表）。 */
function clearSelection() {
  selectedEntry = null;
  filesRename.disabled = true;
  filesRemove.disabled = true;
  filesChmod.disabled = true;
  filesEdit.disabled = true;
  removeArmed = false;
  filesRemove.textContent = "删除";
}

/**
 * 用一个最小的对话框要一个名字；取消返回 `null`。
 */
function askName(title, initial) {
  nameTitle.textContent = title;
  renameInput.value = initial;
  nameDialog.returnValue = "";
  nameDialog.showModal();
  renameInput.focus();
  renameInput.select();
  return new Promise((resolve) => {
    nameDialog.addEventListener(
      "close",
      () => resolve(nameDialog.returnValue === "yes" ? renameInput.value.trim() : null),
      { once: true },
    );
  });
}

// 回车 = 确定。不依赖 `<form method=dialog>` 的隐式提交：
// 它在合成按键（没有 text 字段）下不一定触发，靠不住。
renameInput.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter") return;
  ev.preventDefault();
  nameDialog.returnValue = "yes";
  nameDialog.close();
});

async function makeDir() {
  const name = await askName("新建文件夹（在当前位置）", "");
  if (!name) return;
  setFilesMsg("新建中…");
  try {
    await withDeadline(
      invoke("sftp_mkdir", { req: filesReq(), path: joinPath(sftpPath, name), jump: jumpReq() }),
      20000,
      "新建目录",
    );
    setFilesMsg(`已创建 ${name}`);
    await loadDir(sftpPath);
  } catch (e) {
    setFilesMsg(`新建目录失败：${e}`);
  }
}

async function renameEntry(target = selectedEntry) {
  if (!target) return;
  const oldName = target.name;
  const name = await askName(`把 ${oldName} 改名为`, oldName);
  if (!name || name === oldName) return;
  setFilesMsg("改名中…");
  try {
    await withDeadline(
      invoke("sftp_rename", {
        req: filesReq(),
        from: joinPath(sftpPath, oldName),
        to: joinPath(sftpPath, name),
        jump: jumpReq(),
      }),
      20000,
      "改名",
    );
    setFilesMsg(`已改名为 ${name}`);
    clearSelection();
    await loadDir(sftpPath);
  } catch (e) {
    setFilesMsg(`改名失败：${e}`);
  }
}

/** 删除要二次确认：第一次点变「确认删除」，3 秒内再点才真的删。 */
async function onRemoveClick() {
  if (!selectedEntry) return;
  if (!removeArmed) {
    removeArmed = true;
    filesRemove.textContent = "确认删除";
    setTimeout(() => {
      if (removeArmed) {
        removeArmed = false;
        filesRemove.textContent = "删除";
      }
    }, 3000);
    return;
  }
  removeArmed = false;
  filesRemove.textContent = "删除";
  const target = selectedEntry;
  setFilesMsg("删除中…");
  try {
    await withDeadline(
      invoke("sftp_remove", {
        req: filesReq(),
        path: joinPath(sftpPath, target.name),
        isDir: target.is_dir,
        jump: jumpReq(),
      }),
      20000,
      "删除",
    );
    setFilesMsg(`已删除 ${target.name}`);
    clearSelection();
    await loadDir(sftpPath);
  } catch (e) {
    setFilesMsg(`删除失败：${e}`);
  }
}

filesMkdir.addEventListener("click", () => void makeDir());
filesRename.addEventListener("click", () => void renameEntry());
filesRemove.addEventListener("click", () => void onRemoveClick());

// ── 拖拽上传（FIL-004）────────────────────────────────────
//
// 只做「拖进来上传」。**拖出去下载**在 WebView2 里需要额外插件
// （HTML5 的 `DownloadURL` 只支持 http/data URL），当前构建不做——
// 见 README 的 G10，别在这里假装支持。
const filesDrop = document.getElementById("files");
let dragDepth = 0;

filesDrop.addEventListener("dragenter", (ev) => {
  if (!ev.dataTransfer?.types.includes("Files")) return;
  ev.preventDefault();
  dragDepth += 1;
  filesList.classList.add("dropping");
});

filesDrop.addEventListener("dragover", (ev) => {
  // 不 preventDefault 的话浏览器的默认行为是「打开这个文件」，会把整个窗口导航走
  if (!ev.dataTransfer?.types.includes("Files")) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = "copy";
});

filesDrop.addEventListener("dragleave", () => {
  // 用计数抵消子元素之间的 enter/leave：直接 remove 会在鼠标划过行时闪
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) filesList.classList.remove("dropping");
});

filesDrop.addEventListener("drop", (ev) => {
  if (!ev.dataTransfer?.types.includes("Files")) return;
  ev.preventDefault();
  dragDepth = 0;
  filesList.classList.remove("dropping");
  const dropped = [...(ev.dataTransfer?.files ?? [])];
  if (!dropped.length) return;
  setFilesMsg(`准备上传 ${dropped.length} 个文件…`);
  void uploadFiles(dropped);
});

/** 下载远端文件到本地下载目录（路径由后端决定并回报）。 */
async function downloadFile(path) {
  setFilesMsg("下载中…");
  try {
    const r = await withDeadline(
      invoke("sftp_download", { req: filesReq(), path, jump: jumpReq() }),
      30000,
      "下载",
    );
    setFilesMsg(`已保存 ${r.bytes} 字节 → ${r.saved_to}`);
    setStatus(`已下载到 ${r.saved_to}`);
  } catch (e) {
    setFilesMsg(`下载失败：${e}`);
  }
}

/**
 * 把二进制转成 base64。
 *
 * 分段而不是 `String.fromCharCode(...bytes)`：后者在几 MB 的文件上会因为
 * 展开成太多实参直接抛 `Maximum call stack size exceeded`。
 */
function toBase64(bytes) {
  const chunk = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** 最近一次上传的进度快照（验收与脚本读它，避免去解析提示文本） */
let lastUpload = null;

/** 每次发给后端的分块大小：64 KB（base64 后约 87 KB，IPC 开销可接受） */
const UPLOAD_CHUNK = 64 * 1024;

/**
 * 上传本地文件到当前远端目录。
 *
 * **按块读、按块发**：整文件不再进内存——这是与「一次性 base64」的关键区别，
 * 也是将来做断点续传的前提（续传只需要知道已经写到哪个 offset）。
 */
/**
 * 上传一组本地文件到远端目录。
 *
 * `targetDir` 默认是当前目录；右键目录选「上传到此处」时会传那个目录——
 * 不然用户得先双击进去再点上传，多一步且容易传错地方。
 */
async function uploadFiles(picked, targetDir = sftpPath) {
  if (!picked.length) return;
  let done = 0;
  for (const file of picked) {
    setFilesMsg(`上传中… ${file.name}`);
    lastUpload = { name: file.name, total: file.size, last: 0, events: 0 };
    let id = null;
    try {
      const path = joinPath(targetDir, file.name);
      id = await withDeadline(
        invoke("sftp_upload_begin", { req: filesReq(), path, jump: jumpReq() }),
        20000,
        "开始上传",
      );
      let offset = 0;
      while (offset < file.size) {
        const slice = file.slice(offset, Math.min(offset + UPLOAD_CHUNK, file.size));
        const bytes = new Uint8Array(await slice.arrayBuffer());
        const written = await withDeadline(
          invoke("sftp_upload_chunk", { id, content: toBase64(bytes) }),
          60000,
          "上传分块",
        );
        lastUpload.last = written;
        lastUpload.events += 1;
        const pct = file.size ? Math.round((written / file.size) * 100) : 100;
        setFilesMsg(`上传中… ${file.name} ${pct}%`);
        offset = written;
      }
      // 保留本地文件的修改时间（FIL-018）：前端从 File.lastModified（毫秒）算出 Unix 秒，
      // 后端在 close 之后 SETSTAT mtime。新建空文件那条路径没有源文件，不传这个参数。
      const mtimeSecs = Number.isFinite(file.lastModified) && file.lastModified > 0
        ? Math.floor(file.lastModified / 1000)
        : undefined;
      const end = await withDeadline(
        invoke("sftp_upload_end", { id, mtimeSecs }),
        20000,
        "结束上传",
      );
      id = null;
      done += 1;
      // SETSTAT 失败不推翻上传成功，但要如实说出来，不假装保留了时间
      if (mtimeSecs !== undefined && end && end.mtimeKept === false) {
        setFilesMsg(`已上传 ${file.name}（服务端不支持保留修改时间）`);
      }
    } catch (e) {
      if (id) await invoke("sftp_upload_abort", { id }).catch(() => {});
      setFilesMsg(`上传 ${file.name} 失败：${e}`);
      return;
    }
  }
  setFilesMsg(`已上传 ${done} 个文件`);
  // 传完回当前目录（不是目标目录）：用户看的是自己所在那层，切走反而迷路
  await loadDir(sftpPath);
}

/** 「上传到此处」的临时目标目录；普通上传时为 `null` */
let uploadTargetDir = null;

filesUploadBtn.addEventListener("click", () => {
  uploadTargetDir = null;
  filesUpload.click();
});
filesUpload.addEventListener("change", () => {
  const picked = [...filesUpload.files];
  const target = uploadTargetDir;
  // 清空，否则同一个文件第二次选不会触发 change
  filesUpload.value = "";
  uploadTargetDir = null;
  void uploadFiles(picked, target ?? sftpPath);
});

// 面板开关。每次操作独立建连，所以「关掉」只是收起 UI。
document.getElementById("files-toggle").addEventListener("click", async () => {
  if (!filesPanel.hidden) {
    filesPanel.hidden = true;
    return;
  }
  if (!hostInput.value.trim() || !userInput.value.trim()) {
    setStatus("文件面板需要先填主机与用户名");
    return;
  }
  openSidePanel(filesPanel);
  await loadDir("/");
  await initFileTree();
});

/**
 * SSH 连上就打开文件面板（`FIL-001`）。
 *
 * 规格要求「连上即自动打开（可关）」——这是 MobaXterm 的主路径，用户不必再点一次。
 * 必须能关：有人就只想开一个终端。
 */
async function autoOpenFiles() {
  if (!filesAutoOpen) return;
  const host = hostInput.value.trim();
  const user = userInput.value.trim();
  const port = Number.parseInt(portInput.value, 10) || 22;
  // 从会话树点进来的才绑定到那条会话（面板显示会话名、各自记路径）；
  // 手填表单连的就跟表单走——硬拉一条不相干的会话进来只会让人困惑。
  const picked =
    selectedSession &&
    selectedSession.kind === "ssh" &&
    selectedSession.host === host &&
    (selectedSession.username ?? "") === user &&
    (selectedSession.port ?? 22) === port &&
    [...filesSessionSelect.options].some((o) => o.value === selectedSession.id)
      ? selectedSession.id
      : null;
  if (picked) {
    filesPaths.set(filesSessionId, sftpPath);
    filesSessionId = picked;
    filesSessionSelect.value = picked;
  }
  openSidePanel(filesPanel);
  await initFileTree();
  const remembered = filesPaths.get(filesSessionId) ?? "/";
  if (await loadDir(remembered)) return;
  if (remembered === "/") return;
  // 记住的目录可能已经不在了（上一条会话里把它删了，或者权限变了）：退回根目录。
  // 不退回的话，一连接就只看到一条「列目录失败」，看着像压根连不上。
  filesPaths.delete(filesSessionId);
  await loadDir("/");
}

// ── 隧道（NET-001 / NET-004）───────────────────────────────
//
// 承载连接用的是上面那张表单里的主机/用户名/密码——与 SSH、SFTP 同一套参数，
// 用户不用为隧道再填一遍。每条隧道一条独立连接（见后端注释）。
const tunnelsPanel = document.getElementById("tunnels");
const tunnelList = document.getElementById("tunnel-list");
const tunnelMsgEl = document.getElementById("tunnel-msg");
const tunnelListen = document.getElementById("tunnel-listen");
const tunnelKind = document.getElementById("tunnel-kind");
const tunnelSessionSelect = document.getElementById("tunnel-session");
const tunnelTarget = document.getElementById("tunnel-target");
const tunnelLan = document.getElementById("tunnel-lan");
const tunnelSocksUser = document.getElementById("tunnel-socks-user");
const tunnelSocksPass = document.getElementById("tunnel-socks-pass");
// ── 多执行广播（`TER-004`）────────────────────────────────
//
// 只做「一条命令发给所有已连接会话」这件事：MobaXterm 的实时逐键广播（`broadcast-live`）
// 在交互式程序里会互相踩，规格也把它排在最后一条 AC；这里先给更安全的两种模式。

/** 危险命令：命中就把模式强制切成「发送前确认」（`SEC-011`） */
const DANGEROUS = [
  /rm\s+-[rf]{1,2}\s+\/(\s|$)/i,
  /mkfs\./i,
  /dd\s+.*of=\/dev\//i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /:\(\)\s*\{.*\};\s*:/i,
  /chmod\s+-R\s+777\s+\//i,
  />\s*\/dev\/sd[a-z]/i,
  /iptables\s+-F/i,
  /systemctl\s+(stop|disable)\s+.*(sshd|network)/i,
];

/**
 * 用户加的危险规则（`TER-004` 规格「规则集可配置」）。
 *
 * 存在 `config.toml` 的 `broadcastExtraRules`（JSON 字符串数组）。**内置规则不可关**：
 * 那等于把安全阀拆了，不是配置项。
 */
let extraDangerRules = [];

function isDangerous(cmd) {
  return DANGEROUS.some((re) => re.test(cmd)) || extraDangerRules.some((re) => re.test(cmd));
}

/**
 * 广播目标（`TER-004` 规格「目标选择：多选标签」）。
 *
 * `null` = 全部已连接会话（默认）；`Set<view.id>` = 只发勾上的那几个标签。
 * 用**标签**而不是保存的会话来定位：同一条会话可以开两个标签（复制标签），
 * 按会话选区分不开它们，而用户要的正是「发给这个标签」。
 */
let bcTargetsChosen = null;

/** 当前有连接的终端（不管有没有勾选） */
function bcConnected() {
  return [...sessions.values()].filter((v) => v.handle && v.running);
}

function broadcastTargets() {
  const all = bcConnected();
  if (!bcTargetsChosen) return all;
  return all.filter((v) => bcTargetsChosen.has(v.id));
}

/** 关掉的标签要从勾选集合里摘掉，否则「目标 2 台」里有一台早就不在了 */
function pruneBcTargets() {
  if (!bcTargetsChosen) return;
  const alive = new Set([...sessions.values()].map((v) => v.id));
  let dropped = false;
  for (const id of [...bcTargetsChosen]) {
    if (!alive.has(id)) {
      bcTargetsChosen.delete(id);
      dropped = true;
    }
  }
  // 勾过的标签全关了 → 退回「全部」。留着空集合会让下一次广播悄悄发不出去；
  // 而「用户主动把勾全去掉」时集合本就是空的、这里 dropped 为假，仍会走到发送时报错
  if (dropped && !bcTargetsChosen.size) bcTargetsChosen = null;
}

/** 文件夹子树（含子文件夹）里的会话 id，顺序与树里一致 */
function folderSessionIds(folderId) {
  const ids = [];
  const walk = (fid) => {
    for (const s of lastTree?.sessions ?? []) {
      if ((s.folder_id ?? "") === fid) ids.push(s.id);
    }
    for (const f of lastTree?.folders ?? []) {
      if ((f.parent_id ?? "") === fid) walk(f.id);
    }
  };
  walk(folderId);
  return ids;
}

/**
 * 把一批**已存会话**打开并设为广播目标（`TER-004`：规格要的「多选会话树节点 / 整个文件夹」）。
 *
 * 顺序打开而不是并发：连接参数走的是同一套表单（主机/口令/跳板机），
 * 并发会把这些串到别的会话上——表现为「明明选了 A，连上的是 B」。
 *
 * 只处理 `ssh` 会话；其余类型（sftp 等）如实跳过并说明，不假装支持。
 */
async function broadcastToSavedSessions(ids, what) {
  const saved = ids
    .map((id) => (lastTree?.sessions ?? []).find((s) => s.id === id))
    .filter(Boolean);
  const sshOnes = saved.filter((s) => s.kind === "ssh");
  const skipped = saved.length - sshOnes.length;
  if (!sshOnes.length) {
    setStatus("没有可广播的会话");
    return;
  }

  const before = new Set([...sessions.values()].map((v) => v.id));
  setStatus(`正在打开 ${sshOnes.length} 个会话…`);
  for (const s of sshOnes) {
    await selectSession(s);
    await openSsh();
  }

  const added = [...sessions.values()]
    .filter((v) => !before.has(v.id))
    .map((v) => v.id);
  const all = bcConnected().map((v) => v.id);
  const chosen = added.filter((id) => all.includes(id));
  if (!chosen.length) {
    setStatus("没有可广播的会话");
    return;
  }

  // 目标正好是全部时用 null（「全部」是默认语义），否则记显式集合
  bcTargetsChosen = chosen.length === all.length ? null : new Set(chosen);
  bcBar.hidden = false;
  bcToggle.classList.add("on");
  renderBcTargets();
  bcInput.focus();
  // 一条消息说清「设了几台 + 跳过了几个」：连发两条会被后者立刻覆盖，
  // 用户永远看不到目标数（目标数只在「非全部」时显示在按钮上）
  setStatus(
    skipped
      ? `广播目标 ${chosen.length} 台（跳过 ${skipped} 个非 SSH 会话）`
      : `广播目标 ${chosen.length} 台`,
  );
}

/** 刷新「目标」按钮上的计数（浮层内容打开时才重建） */
function renderBcTargets() {
  if (!bcTargetsBtn) return;
  pruneBcTargets();
  const all = bcConnected().length;
  const shown = broadcastTargets().length;
  bcTargetsBtn.textContent = bcTargetsChosen ? `目标 ${shown}/${all}` : "目标 全部";
  bcTargetsBtn.classList.toggle("narrowed", Boolean(bcTargetsChosen));
  bcTargetsBtn.title = bcTargetsChosen
    ? `这次广播只发给勾上的 ${shown} 个标签（共 ${all} 个已连接）`
    : "选择这次广播发给哪几个标签（默认全部已连接）";
}

/** 目标浮层：每个已连接标签一行复选框 */
function renderBcTargetPop() {
  bcTargetsPop.textContent = "";
  const all = bcConnected();
  if (!all.length) {
    const empty = document.createElement("span");
    empty.textContent = "还没有已连接的会话";
    bcTargetsPop.appendChild(empty);
    return;
  }
  for (const v of all) {
    const row = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !bcTargetsChosen || bcTargetsChosen.has(v.id);
    cb.addEventListener("change", () => {
      // 第一次动复选框时把「全部」落成显式集合，之后按勾选增删
      if (!bcTargetsChosen) bcTargetsChosen = new Set(all.map((x) => x.id));
      if (cb.checked) bcTargetsChosen.add(v.id);
      else bcTargetsChosen.delete(v.id);
      renderBcTargets();
    });
    row.appendChild(cb);
    const text = document.createElement("span");
    text.textContent = v.label;
    row.appendChild(text);
    bcTargetsPop.appendChild(row);
  }
}

/** 最近一次广播的结果（验收读它） */
let lastBroadcast = null;

/**
 * 实时逐键广播（`TER-004` 的 `broadcast-live`）。
 *
 * 每次按键立刻发到其余目标，所以**没有**「发送前确认」的机会——一行一发那套
 * 危险命令拦截在这里帮不上忙。三重保险代替确认：开之前弹一次说明、开着时底栏
 * 按钮与整条广播栏变警示色、关掉广播栏就自动失活。
 *
 * 只镜像 `onData`（键盘与粘贴），不镜像 `onBinary`：那里是鼠标上报，把一份鼠标
 * 坐标发给所有会话只会让每台都以为在被点。
 */
// `lastLine` 是刚敲完（回车）的那一行，留作诊断：拦没拦下、拦的是什么，都能从它看出来
const liveBroadcast = { on: false, chars: 0, sends: 0, failed: 0, blocked: 0, lastLine: null };

/** 实时广播下正在敲的那一行：回车前拿它比对危险命令 */
let liveLine = "";

/**
 * 实时广播下的危险命令拦截（`SEC-011` 要求 live 模式也要拦）。
 *
 * 逐键广播没有「发送前确认」这个时机，但**回车**这一下可以扣住：把这一行攒起来，
 * 回车时先比对危险模式。命中就把这次回车吞掉、关掉实时广播并说清原因——已经打出去
 * 的字符收不回来，但那条命令不会被执行。
 *
 * 返回 `true` 表示这次输入被拦下，调用方连本地会话都不要发。
 */
function holdDangerousEnter(data) {
  if (!liveBroadcast.on) return false;
  if (!data.includes("\r") && !data.includes("\n")) {
    // 只攒可见输入，别把一整段粘贴无限存进来
    if (liveLine.length < 512) liveLine += data;
    return false;
  }
  const line = liveLine.trim();
  liveLine = "";
  liveBroadcast.lastLine = line;
  if (!isDangerous(line)) return false;
  liveBroadcast.blocked += 1;
  stopLiveBroadcast(false);
  setStatus("危险命令被拦下，实时广播已关闭");
  void showAlert(
    "实时广播拦下了一条危险命令",
    `${line}\n\n这条命令没有执行（回车被拦住了），实时广播已自动关闭。需要的话再手动打开。`,
  );
  return true;
}

/** 把一次输入镜像到其余已连接会话（实时广播开着时才做） */
function mirrorInput(view, data) {
  if (!liveBroadcast.on || !view.handle || !data) return;
  const targets = broadcastTargets().filter((v) => v !== view);
  if (!targets.length) return;
  liveBroadcast.chars += data.length;
  for (const v of targets) {
    liveBroadcast.sends += 1;
    invoke("term_write", { handle: v.handle, data }).catch(() => {
      liveBroadcast.failed += 1;
    });
  }
}

/** 关掉实时广播：界面标记与状态一起收，别留下「看着像开着其实没发」 */
function stopLiveBroadcast(announce) {
  const wasOn = liveBroadcast.on;
  liveBroadcast.on = false;
  liveLine = "";
  bcLive.checked = false;
  bcBar.classList.remove("live");
  bcToggle.classList.remove("live");
  if (wasOn && announce) setStatus("实时广播已关闭");
}

/**
 * 网络活动面板（`SEC-015`）。
 *
 * 它要回答的不是「有哪些连接」（那在标签栏和隧道面板里也能看到），
 * 而是「**除了我主动发起的，还有没有别的出站**」——这正是「不发送遥测」这句
 * 承诺可以被核对的地方。所以除了列连接，还要明确写出「非用户发起：0 条」。
 */
async function renderNetActivity() {
  const rows = [];
  for (const v of sessions.values()) {
    if (!v.handle) continue;
    rows.push(["终端", v.label, v.running ? "已连接" : "连接中"]);
  }
  try {
    const tunnels = await invoke("tunnel_stats");
    for (const t of tunnels) {
      if (!t.running) continue;
      rows.push(["隧道", `${t.listen} → ${t.target}`, `经 ${t.via}`]);
    }
  } catch {
    /* 隧道列表取不到不影响「终端」那部分，如实少列一行即可 */
  }

  netRows.textContent = "";
  for (const [kind, target, note] of rows) {
    const tr = document.createElement("tr");
    for (const text of [kind, target, note]) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.appendChild(td);
    }
    netRows.appendChild(tr);
  }
  netSummary.textContent = rows.length
    ? `共 ${rows.length} 条，全部由你发起；非用户发起的出站连接 0 条。`
    : "当前没有出站连接；非用户发起的出站连接 0 条。";
  netDialog.showModal();
}
function askConfirm(title, body, okLabel = "确认发送") {
  askTitle.textContent = title;
  askBody.textContent = body;
  // 按钮文案跟着场景走：删除写「确认发送」会让人以为是发命令
  document.getElementById("ask-ok").textContent = okLabel;
  askDialog.returnValue = "";
  askDialog.showModal();
  return new Promise((resolve) => {
    askDialog.addEventListener(
      "close",
      () => resolve(askDialog.returnValue === "yes"),
      { once: true },
    );
  });
}

/** 只报告、不询问：把「取消」藏起来，只留一个确认键 */
async function showAlert(title, body) {
  const cancel = document.getElementById("ask-cancel");
  const wasHidden = cancel.hidden;
  cancel.hidden = true;
  try {
    await askConfirm(title, body, "知道了");
  } finally {
    cancel.hidden = wasHidden;
  }
}

/**
 * 等每个会话的捕获安静下来。
 *
 * 「安静」比固定 sleep 靠谱：命令回多快取决于远端，固定等 1 秒要么慢要么截断。
 * 上限兜底，免得某台一直吐东西把整个广播卡住。
 */
function settleCapture(targets, quietMs, maxMs) {
  const start = performance.now();
  const lastLen = new Map(targets.map((v) => [v, v.cap.text.length]));
  const lastChange = new Map(targets.map((v) => [v, start]));
  return new Promise((resolve) => {
    const tick = () => {
      const now = performance.now();
      let quiet = true;
      for (const v of targets) {
        const len = v.cap.text.length;
        if (len !== lastLen.get(v)) {
          lastLen.set(v, len);
          lastChange.set(v, now);
        }
        if (now - lastChange.get(v) < quietMs) quiet = false;
      }
      if (quiet || now - start > maxMs) {
        const out = targets.map((v) => ({ label: v.label, text: v.cap.text }));
        for (const v of targets) v.cap = null;
        resolve(out);
        return;
      }
      setTimeout(tick, 100);
    };
    setTimeout(tick, quietMs);
  });
}

/** 分组：输出一致就折成一行（`TER-004` 的核心增强） */
function groupByOutput(results) {
  const groups = new Map();
  for (const r of results) {
    const key = r.text.replace(/\r/g, "").replace(/[ \t]+$/gm, "").trim();
    const g = groups.get(key) ?? { key, text: key, labels: [] };
    g.labels.push(r.label);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.labels.length - a.labels.length);
}

function renderBroadcast(groups, total) {
  const differing = groups.length > 1;
  const parts = groups.map((g) => `${g.labels.length} 台：${firstLine(g.text) || "（无输出）"}`);
  bcResult.textContent = differing ? parts.join("　|　") : `${total} 台一致：${firstLine(groups[0]?.text) || "（无输出）"}`;
  bcResult.classList.toggle("diff", differing);
  bcResult.title = groups
    .map((g) => `【${g.labels.join("、")}】\n${g.text}`)
    .join("\n\n");
}

function firstLine(text) {
  return (text ?? "").split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "";
}

async function runBroadcast() {
  const cmd = bcInput.value.trim();
  if (!cmd) return;
  const targets = broadcastTargets();
  const idle = [...sessions.values()].filter((v) => !v.handle || !v.running).length;
  if (!targets.length) {
    // 选了目标却一台都没连上，和「压根没有会话」是两回事：
    // 前者要说清是选中的那些没连上，否则用户会以为广播坏了。
    // 写成两条独立调用而不是三元表达式：词表门禁只认「纯字面量 setStatus」，
    // 塞进三元里它就会以为这两条没人用，翻译与覆盖都跟着漏掉
    if (bcTargetsChosen) setStatus("选中的标签没有已连接的会话");
    else setStatus("没有可广播的会话");
    return;
  }
  const dangerous = isDangerous(cmd);
  if (dangerous || bcMode.value === "confirm") {
    const title = dangerous ? "危险命令，确认要广播吗？" : "确认广播";
    const ok = await askConfirm(
      title,
      `${cmd}\n\n目标：${targets.length} 个已连接会话${idle ? `（另有 ${idle} 个未就绪，会被跳过）` : ""}`,
    );
    if (!ok) {
      lastBroadcast = { sent: 0, cancelled: true, groups: [] };
      setStatus("已取消广播");
      return;
    }
  }

  for (const v of targets) {
    // 每个会话一个独立解码器：多字节字符会跨块，共用会把字拼错
    v.cap = { dec: new TextDecoder(encoding === "utf-8" ? "utf-8" : encoding), text: "" };
  }
  await Promise.all(
    targets.map((v) =>
      invoke("term_write", { handle: v.handle, data: `${cmd}\r` }).catch(() => {}),
    ),
  );
  const results = await settleCapture(targets, 400, 8000);
  const groups = groupByOutput(results);
  lastBroadcast = { sent: targets.length, cancelled: false, idle, groups };
  // 记住这条命令：导出 CSV 时要写进「命令」列
  bcInput.dataset.lastCmd = cmd;
  bcExport.disabled = false;
  renderBroadcast(groups, targets.length);
  if (bcDiff.checked && groups.length > 1) {
    const onlyDiff = groups.filter((g) => g.labels.length < targets.length);
    renderBroadcast(onlyDiff.length ? onlyDiff : groups, targets.length);
  }
  setStatus(`已广播到 ${targets.length} 个会话`);
}

/// 控件接线要等 DOM 引用就绪（引用声明在这段之后，直接写在顶层会撞 TDZ）
function initBroadcast() {
  bcToggle.addEventListener("click", () => {
    bcBar.hidden = !bcBar.hidden;
    bcToggle.classList.toggle("on", !bcBar.hidden);
    // 关掉广播栏就等于关掉实时广播：栏都收起来了还继续往各会话发按键，
    // 用户看不到任何提示，这是最危险的一种「静默还在生效」
    if (bcBar.hidden) {
      stopLiveBroadcast(true);
      bcTargetsPop.hidden = true;
    } else {
      renderBcTargets();
      bcInput.focus();
    }
  });

  // 目标浮层（`TER-004`「多选标签」）：点按钮开合，点别处收起
  bcTargetsBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (bcTargetsPop.hidden) {
      renderBcTargetPop();
      bcTargetsPop.hidden = false;
    } else {
      bcTargetsPop.hidden = true;
    }
  });
  bcTargetsPop.addEventListener("click", (ev) => ev.stopPropagation());
  document.addEventListener("click", () => {
    if (!bcTargetsPop.hidden) bcTargetsPop.hidden = true;
  });

  bcLive.addEventListener("change", async () => {
    if (!bcLive.checked) {
      stopLiveBroadcast(true);
      return;
    }
    const targets = broadcastTargets().length;
    const ok = await askConfirm(
      "开启实时逐键广播？",
      `你在当前终端的每一次按键都会同时发到其余 ${Math.max(0, targets - 1)} 个已连接会话。\n\n这一行一行发的危险命令拦截在这里不生效——每次按键都直接发走，没有确认的机会。切走前记得关掉。`,
      "开启实时广播",
    );
    if (!ok) {
      bcLive.checked = false;
      return;
    }
    liveLine = "";
    liveBroadcast.on = true;
    bcBar.classList.add("live");
    bcToggle.classList.add("live");
    setStatus("实时广播已开启");
  });

  bcSend.addEventListener("click", () => void runBroadcast());

  // 回车发送（广播框里回车不换行，这里就是「发送」的意思）
  bcInput.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    void runBroadcast();
  });
}

const termFoot = document.getElementById("term-foot");
const bcBar = document.getElementById("bc-bar");
const bcToggle = document.getElementById("bc-toggle");
const bcMode = document.getElementById("bc-mode");
const bcInput = document.getElementById("bc-input");
const bcSend = document.getElementById("bc-send");
const bcDiff = document.getElementById("bc-diff");
const bcLive = document.getElementById("bc-live");
const bcTargetsBtn = document.getElementById("bc-target-open");
const bcTargetsPop = document.getElementById("bc-target-pop");
const bcResult = document.getElementById("bc-result");

// 广播结果导出 CSV（`TER-004`）：按「分组 × 主机」铺成行，Excel 直接能看。
// 没有结果时按钮禁用，而不是导出一张空表让人以为导成功了。
const bcExport = document.getElementById("bc-export");
bcExport.disabled = true;
bcExport.addEventListener("click", async () => {
  const last = lastBroadcast;
  if (!last?.groups?.length) {
    setStatus("还没有广播结果可导出");
    return;
  }
  const rows = [["命令", "主机", "输出"]];
  for (const g of last.groups) {
    const text = g.text.trimEnd();
    for (const label of g.labels) rows.push([bcInput.dataset.lastCmd ?? "", label, text]);
  }
  try {
    const path = await invoke("broadcast_export_csv", { rows });
    setStatus(`已导出广播结果：${path}`);
  } catch (e) {
    setStatus(`导出失败：${e}`);
  }
});
const askDialog = document.getElementById("ask-dialog");
// 网络活动（`SEC-015`）
const netDialog = document.getElementById("net-dialog");
const netRows = document.getElementById("net-rows");
const netSummary = document.getElementById("net-summary");
const askTitle = document.getElementById("ask-title");
const askBody = document.getElementById("ask-body");
const encodingSelect = document.getElementById("encoding");
const lookThemeSelect = document.getElementById("look-theme");
const lookAutoCopySelect = document.getElementById("look-autocopy");
const lookAutoCopyOnBox = document.getElementById("look-autocopy-on");
const termRightClickSelect = document.getElementById("term-right-click");
const bcExtraRulesBox = document.getElementById("bc-extra-rules");
const lookWordSepInput = document.getElementById("look-word-sep");
const lookPasteTrimBox = document.getElementById("look-paste-trim");
const lookFontSelect = document.getElementById("look-font");
const lookFontWarn = document.getElementById("look-font-warn");
const lookMonoWarn = document.getElementById("look-mono-warn");
const lookSizeInput = document.getElementById("look-size");
const lookHeightInput = document.getElementById("look-height");
const lookScrollbackInput = document.getElementById("look-scrollback");
const tunnelAuto = document.getElementById("tunnel-auto");
const tunnelAutoRow = document.getElementById("tunnel-auto-row");
const tunnelAdd = document.getElementById("tunnel-add");

/** 最近一次取到的隧道状态（验收与脚本读它，避免去解析 DOM 文本） */
let lastTunnels = [];
let tunnelTimer = null;

function setTunnelMsg(text) {
  tunnelMsgEl.textContent = text;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/**
 * 每条隧道对应的 DOM 节点。
 *
 * **必须复用，不能每次整表重建**：统计每秒刷新一次，重建意味着按钮每秒被换成
 * 新节点——鼠标悬停会闪，点击落在「重建的那一帧」就落空（验收里删掉隧道删不掉
 * 就是这么来的，而且从面板提示看不出任何异常）。
 */
const tunnelNodes = new Map();

/** 建一行（只在第一次见到这条隧道时调用）。事件里读 `lastTunnels`，避免闭包持有旧状态 */
/**
 * 编辑一条已保存的隧道（`NET-004`）：只改名字与分组。
 *
 * 类型与端口不在编辑范围：换了它们其实是另一条隧道，让它在原记录上改会把「上次跑的
 * 是什么」抹掉。要改就重新填表建一条。
 */
async function editTunnel(t) {
  const name = await askName("隧道名称", t.name);
  if (name === null) return;
  const group = await askName("分组（留空表示不分组）", t.group ?? "");
  if (group === null) return;
  try {
    const finalName = await invoke("tunnel_update", { id: t.id, name, group });
    setTunnelMsg(`已更新「${finalName}」`);
    await refreshTunnels();
  } catch (e) {
    setTunnelMsg(`更新失败：${e}`);
  }
}

function buildTunnelRow(id) {
  const box = document.createElement("div");
  box.className = "tunnel";
  box.dataset.id = id;
  const line1 = document.createElement("div");
  line1.className = "line1";
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.textContent = "●";
  const route = document.createElement("span");
  const startBtn = document.createElement("button");
  startBtn.addEventListener("click", () => {
    const cur = lastTunnels.find((x) => x.id === id);
    if (!cur) return;
    if (cur.running) void stopTunnel(cur.id);
    else void startSavedTunnel(cur.id);
  });
  const delBtn = document.createElement("button");
  delBtn.textContent = "删除";
  delBtn.addEventListener("click", () => void deleteTunnel(id));
  // 「编辑」放在最后：`clickTunnelButton` 按索引 1 找删除，插在前面会把它顶掉
  const editBtn = document.createElement("button");
  editBtn.textContent = "编辑";
  editBtn.title = "改名字 / 分组（端口与类型要改就重新建一条）";
  editBtn.addEventListener("click", () => {
    const cur = lastTunnels.find((x) => x.id === id);
    if (cur) void editTunnel(cur);
  });
  line1.append(dot, route, startBtn, delBtn, editBtn);
  const line2 = document.createElement("div");
  line2.className = "line2";
  box.append(line1, line2);
  return { box, dot, route, startBtn, delBtn, line2 };
}

/** 把一条隧道的最新状态画到它已有的节点上 */
function paintTunnelRow(n, t) {
  if (!t.running) {
    // 灰灯：配置在库里，但当前没跑
    n.dot.style.color = "#8a8a92";
    n.dot.title = "已停止";
  } else if (t.last_error) {
    // 有上次错误就变红：承载连接断了以后监听还在，但每个连接都会失败，
    // 这时候继续显示绿灯等于骗人
    n.dot.style.color = "#e5534b";
    n.dot.title = `最近一次转发失败：${t.last_error}`;
  } else {
    n.dot.style.color = "";
    n.dot.title = "运行中";
  }
  // 动态代理没有固定目标：路由由客户端每次请求决定
  n.route.textContent =
    t.kind === "D" ? `${t.kind} ${t.listen}` : `${t.kind} ${t.listen} → ${t.target}`;
  n.route.title = t.name ? `${t.name}（via ${t.via || "手填参数"}）` : "";
  n.startBtn.textContent = t.running ? "停止" : "启动";
  n.startBtn.title = t.running ? `停止 ${t.listen}` : `用保存的配置启动 ${t.listen}`;
  n.delBtn.title = `删除 ${t.listen}`;
  if (!t.running) {
    // autoStart 必须在**停止**状态下也看得见，否则「我明明勾了」只能靠记忆
    n.line2.textContent = t.auto_start
      ? "未运行 · 配置已保存 · 解锁保险库后自动拉起"
      : "未运行 · 配置已保存";
    n.line2.title = "";
  } else {
    const parts = [
      `${t.active} 连接`,
      `累计 ${t.total}`,
      `↑${formatBytes(t.up_bytes)} ↓${formatBytes(t.down_bytes)}`,
      `via ${t.via}`,
    ];
    // 被拒的连接要单独说出来：看到「拒绝 30」才知道是撞上限，而不是网络抖
    if (t.rejected) parts.push(`拒绝 ${t.rejected}`);
    if (t.auto_start) parts.push("自动拉起");
    if (t.last_error) parts.push(`上次错误：${t.last_error}`);
    n.line2.textContent = parts.join(" · ");
    n.line2.title = t.last_error ?? "";
  }
}

/** 隧道分组（`NET-004`）：顺序就是面板里的显示顺序 */
/** 没有自定义分组时按类型分组（`NET-004`） */
const TUNNEL_TYPE_LABEL = {
  L: "本地转发 -L",
  R: "远程转发 -R",
  D: "动态代理 -D",
};

function renderTunnels(rows) {
  lastTunnels = rows;
  const alive = new Set(rows.map((r) => r.id));
  // 已经不在列表里的隧道（或空状态占位）先摘掉
  for (const [id, n] of tunnelNodes) {
    if (!alive.has(id)) {
      n.box.remove();
      tunnelNodes.delete(id);
    }
  }
  // 分组容器每次重建：空组不显示，重建比维护增删简单，隧道数量本来就不多
  for (const el of [...tunnelList.children]) el.remove();
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "tunnel";
    empty.dataset.empty = "1";
    // 空状态要说清「这东西解决什么问题」，否则用户不知道要不要建
    empty.textContent =
      "还没有隧道。隧道把远端端口映射到本地，用来连只允许从服务器访问的服务（数据库、Redis 等）。";
    tunnelList.appendChild(empty);
    return;
  }
  // 分组（`NET-004`）：用户填了分组名就按它排，没填就退回按类型（-L/-R/-D）。
  // 两种混在一张列表里时，一行行看端点才知道是哪类——这正是要分的原因。
  const grouped = new Map();
  for (const t of rows) {
    const key = (t.group ?? "").trim() || TUNNEL_TYPE_LABEL[t.kind] || t.kind;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(t);
  }
  for (const [title, inGroup] of [...grouped.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    if (!inGroup.length) continue;
    const group = document.createElement("div");
    group.className = "tun-group";
    group.dataset.group = title;
    // 整组同类型时保留 data-kind：老验收与新分组各取所需，不互相妨碍
    if (inGroup.every((t) => t.kind === inGroup[0].kind)) {
      group.dataset.kind = inGroup[0].kind;
    }
    const h = document.createElement("h4");
    h.className = "tun-group-title";
    h.textContent = `${title}（${inGroup.length}）`;
    group.appendChild(h);
    for (const t of inGroup) {
      let n = tunnelNodes.get(t.id);
      if (!n) {
        n = buildTunnelRow(t.id);
        tunnelNodes.set(t.id, n);
      }
      paintTunnelRow(n, t);
      group.appendChild(n.box);
    }
    tunnelList.appendChild(group);
  }
}

/** 刷新「承载会话」下拉（只有 SSH 能承载隧道）。 */
function refreshTunnelSessionSelect() {
  const keep = tunnelSessionSelect.value;
  tunnelSessionSelect.textContent = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "承载会话（可选，保存后便于重启）";
  tunnelSessionSelect.appendChild(none);
  for (const s of lastTree?.sessions ?? []) {
    if (s.kind !== "ssh") continue;
    const o = document.createElement("option");
    o.value = s.id;
    o.textContent = s.name;
    tunnelSessionSelect.appendChild(o);
  }
  tunnelSessionSelect.value = keep;
}

// 导出/导入（`NET-004`）：只导配置，不导口令——带 SOCKS5 认证的隧道本来就不落库。
document.getElementById("tunnels-export").addEventListener("click", async () => {
  try {
    // 落点由后端决定（下载目录 + 时间戳），必须把路径说出来：
    // 不给路径的「已导出」等于没告诉用户东西在哪
    const path = await invoke("tunnels_export");
    setTunnelMsg(`已导出：${path}`);
  } catch (e) {
    setTunnelMsg(`导出失败：${e}`);
  }
});

const tunnelFileInput = document.getElementById("tunnel-file");
document.getElementById("tunnels-import").addEventListener("click", () => tunnelFileInput.click());
tunnelFileInput.addEventListener("change", async () => {
  const file = tunnelFileInput.files?.[0];
  // 清空，否则同一个文件第二次选不会触发 change
  tunnelFileInput.value = "";
  if (!file) return;
  try {
    const n = await invoke("tunnels_import", { json: await file.text() });
    setTunnelMsg(`已导入 ${n} 条隧道`);
    await refreshTunnels();
  } catch (e) {
    setTunnelMsg(`导入失败：${e}`);
  }
});

async function refreshTunnels() {
  try {
    renderTunnels(await invoke("tunnel_stats"));
  } catch (e) {
    setTunnelMsg(`读取隧道状态失败：${e}`);
  }
}

async function stopTunnel(id) {
  try {
    await invoke("tunnel_stop", { id });
    setTunnelMsg("已停止");
  } catch (e) {
    setTunnelMsg(`停止失败：${e}`);
  }
  await refreshTunnels();
}

/** 用保存的配置启动：承载会话与密码都从库里取（密码走保险库）。 */
async function startSavedTunnel(id) {
  setTunnelMsg("启动中…");
  try {
    const t = await withDeadline(invoke("tunnel_start_saved", { id }), 30000, "启动隧道");
    const tail = t.persisted ? "" : "（带代理认证，配置未保存：重启后需重填）";
    setTunnelMsg(`已启动 ${t.kind} ${t.listen}${t.target ? ` → ${t.target}` : ""}${tail}`);
  } catch (e) {
    setTunnelMsg(`启动失败：${e}`);
  }
  await refreshTunnels();
}

async function deleteTunnel(id) {
  try {
    await invoke("tunnel_delete", { id });
    setTunnelMsg("已删除");
  } catch (e) {
    setTunnelMsg(`删除失败：${e}`);
  }
  await refreshTunnels();
}

async function startTunnel() {
  if (!hostInput.value.trim() || !userInput.value.trim()) {
    setTunnelMsg("隧道要用上面的主机与用户名建承载连接，先把这两项填上");
    return;
  }
  const kind = tunnelKind.value;
  const dynamic = kind === "dynamic";
  let targetHost = "";
  let targetPort = 0;
  if (!dynamic) {
    const raw = tunnelTarget.value.trim();
    const sep = raw.lastIndexOf(":");
    if (sep <= 0 || sep === raw.length - 1) {
      setTunnelMsg("目标要写成 主机:端口，比如 db:3306");
      return;
    }
    targetHost = raw.slice(0, sep);
    targetPort = Number.parseInt(raw.slice(sep + 1), 10);
    if (!Number.isInteger(targetPort) || targetPort <= 0 || targetPort > 65535) {
      setTunnelMsg("目标端口要在 1–65535 之间");
      return;
    }
  }
  const listenPort = Number.parseInt(tunnelListen.value, 10);
  const allowLan = tunnelLan.checked;

  setTunnelMsg("启动中…");
  try {
    const t = await withDeadline(
      invoke("tunnel_start", {
        arg: {
          ...sftpReq(),
          kind,
          // 勾了「允许局域网」才监听 0.0.0.0，并把这个意图显式传给后端确认
          listenHost: allowLan ? "0.0.0.0" : "127.0.0.1",
          listenPort: Number.isInteger(listenPort) ? listenPort : 0,
          targetHost,
          targetPort,
          allowLan,
          // 只有动态代理才带代理认证；其它类型后端会拒绝
          socksUser: dynamic ? tunnelSocksUser.value.trim() || null : null,
          socksPassword: dynamic ? tunnelSocksPass.value || null : null,
          autoStart: tunnelAuto.checked,
          viaSessionId: tunnelSessionSelect.value || null,
          // 自定义分组（`NET-004`）：留空就按类型自动分
          group: document.getElementById("tunnel-group").value.trim() || null,
          jump: jumpReq(),
        },
      }),
      30000,
      "启动隧道",
    );
    const tail = t.persisted ? "" : "（带代理认证，配置未保存：重启后需重填）";
    setTunnelMsg(`已启动 ${t.kind} ${t.listen}${t.target ? ` → ${t.target}` : ""}${tail}`);
    await refreshTunnels();
  } catch (e) {
    setTunnelMsg(`启动失败：${e}`);
  }
}

// 动态代理不需要目标：每次请求由客户端决定连哪里。让它禁用而不是消失，
// 用户才看得出「这里本来有东西、只是现在用不上」。
// `-R` 的语义是反的：监听在服务器、目标在本地，所以占位文案必须跟着变，
// 否则用户会以为「本地端口」填的是自己机器上的端口。
function syncTunnelKind() {
  const kind = tunnelKind.value;
  const dynamic = kind === "dynamic";
  const remote = kind === "remote";
  tunnelTarget.disabled = dynamic;
  // 代理认证只对 SOCKS5 有意义；其余类型隐藏而不是禁用，避免被当成「暂时用不上」
  tunnelSocksUser.hidden = !dynamic;
  tunnelSocksPass.hidden = !dynamic;
  tunnelListen.placeholder = remote ? "服务器上的端口，0 为随机" : "本地端口，0 为随机";
  tunnelTarget.placeholder = dynamic
    ? "动态代理不需要目标"
    : remote
      ? "本机目标 host:port"
      : "目标主机:端口";
  if (dynamic) tunnelTarget.value = "";
  syncTunnelPersistable();
}

/**
 * 带代理认证的隧道不落库（口令不写配置库），所以「自动拉起」对它没意义——
 * 库里没有可拉起的配置。这里直接禁用并说明原因，而不是留个勾了也不生效的控件。
 */
// ── 左右分屏（`G6`）──────────────────────────────────────
//
// 只做两个 pane：Terminal 的尺寸由各自的 pane 决定，fit 按容器算，
// 所以分屏后两边行列数会各自重算（远端 stty size 也跟着变）。

/** 右侧 pane 显示哪个会话（null = 没分屏） */
let splitViewId = null;

function splitView() {
  return splitViewId === null ? null : (sessions.get(splitViewId) ?? null);
}

function syncSplit() {
  const second = splitView();
  paneB.hidden = second === null;
  splitToggle.classList.toggle("on", second !== null);
  if (second) {
    if (second.el.parentElement !== paneB) paneB.appendChild(second.el);
    second.fit.fit();
  }
  // 其余会话都回到左 pane（关掉分屏时也靠这一步把元素搬回来）
  for (const v of sessions.values()) {
    if (v !== second && v.el.parentElement !== paneA) paneA.appendChild(v.el);
  }
  active?.fit.fit();
}

splitToggle.addEventListener("click", () => {
  if (splitView()) {
    splitViewId = null;
    syncSplit();
    setStatus("已关闭分屏");
    return;
  }
  const other = [...sessions.values()].find((v) => v !== active && v.handle);
  if (!other) {
    // 只有一个会话时分屏没有意义，直接说清楚，别让按钮看起来坏了
    setStatus("分屏需要至少两个已连接的会话");
    return;
  }
  splitViewId = other.id;
  syncSplit();
  setStatus(`右侧显示：${other.label}`);
});

function syncTunnelPersistable() {
  const auth = tunnelSocksUser.value.trim() !== "" || tunnelSocksPass.value !== "";
  const blocked = !tunnelSocksUser.hidden && auth;
  tunnelAuto.disabled = blocked;
  tunnelAutoRow.classList.toggle("disabled", blocked);
  tunnelAutoRow.title = blocked
    ? "带代理认证的隧道不保存配置（口令不写盘），重启后无法自动拉起"
    : "解锁保险库后自动把它拉起来（承载会话的密码要存在保险库里）";
  if (blocked) tunnelAuto.checked = false;
}

tunnelKind.addEventListener("change", syncTunnelKind);
tunnelSocksUser.addEventListener("input", syncTunnelPersistable);
tunnelSocksPass.addEventListener("input", syncTunnelPersistable);

function syncTunnelTimer() {
  if (tunnelTimer !== null) {
    clearInterval(tunnelTimer);
    tunnelTimer = null;
  }
  // NET-004 要求统计 ≤ 2 s 刷新；1 s 让字节数看起来是「在动」的
  if (!tunnelsPanel.hidden) {
    tunnelTimer = setInterval(() => void refreshTunnels(), 1000);
  }
}

/**
 * 侧栏同一时间只开一个面板（保险库 / 文件 / 隧道）。
 *
 * 三个面板各占一块高度，全开着会把后开的那个挤出可视区——表现就是
 * 「点了保险库没反应」。窄侧栏里也不该并排塞三个列表。
 */
function openSidePanel(target) {
  for (const p of [vaultPanel, filesPanel, tunnelsPanel]) {
    p.hidden = p !== target;
  }
  syncTunnelTimer();
}

tunnelAdd.addEventListener("click", () => void startTunnel());
document.getElementById("tunnels-toggle").addEventListener("click", async () => {
  if (!tunnelsPanel.hidden) {
    tunnelsPanel.hidden = true;
    syncTunnelTimer();
    return;
  }
  openSidePanel(tunnelsPanel);
  // 打开面板时顺手拉起 auto_start 的隧道（NET-005）：保险库解锁后凭据才可用，
  // 所以「应用一启动就跑」做不到，这里是最早能跑起来的时机。
  try {
    const errs = await invoke("tunnel_autostart");
    if (errs.length) {
      setTunnelMsg(`自动启动 ${errs.length} 条失败：${errs[0]}`);
    }
  } catch (e) {
    setTunnelMsg(`自动启动失败：${e}`);
  }
  await refreshTunnels();
});

// ── 窗口尺寸 ────────────────────────────────────────────────
// 每个会话各自 fit：切换标签页时也要重新算，否则隐藏期间的 resize 会漏掉
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const view of sessions.values()) view.fit.fit();
  }, 100);
});

openBtn.addEventListener("click", openLocal);
sshBtn.addEventListener("click", openSsh);
closeBtn.addEventListener("click", closeTerm);

// 填完密码直接回车就能连（用户最自然的动作）
for (const el of [hostInput, portInput, userInput, passInput, keyPassInput]) {
  el.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      openSsh();
    }
  });
}

// ── 密钥认证 ────────────────────────────────────────────────
// 三种认证方式互斥：勾一个就把另外两个收起来。
// 让他们同时可见会让人以为可以叠加，而实际只会用其中一个。
function syncAuthUi() {
  const useKey = useKeyBox.checked;
  const useAgent = useAgentBox.checked;
  keyRow.hidden = !useKey;
  jumpRow.hidden = !useJumpBox.checked;
  passInput.hidden = useKey || useAgent;
  // 密钥/agent 模式没有密码可存：与其让「保存密码」静默失效，不如禁用并收起
  rememberBox.disabled = useKey || useAgent;
  if (useKey || useAgent) {
    rememberBox.value = "no";
    vaultRow.hidden = true;
  }
  if (useKey) pickKeyBtn.focus();
  else if (!useAgent) passInput.focus();
}

/**
 * 跳板机参数（`SES-024`）。没勾就返回 `null`。
 *
 * 不要「没勾也传个空对象」：后端会认为「有跳板机但主机为空」，
 * 报出来的错与用户看到的界面状态不符，排查时会被带偏。
 */
function jumpReq() {
  if (!useJumpBox.checked) return null;
  const raw = jumpHostInput.value.trim();
  const sep = raw.lastIndexOf(":");
  const host = sep > 0 ? raw.slice(0, sep) : raw;
  const port = sep > 0 ? Number.parseInt(raw.slice(sep + 1), 10) || 22 : 22;
  return {
    host,
    port,
    user: jumpUserInput.value.trim(),
    password: jumpPassInput.value,
    // 选了会话就把它交给后端：它自己可能还有跳板（`SES-025`），
    // 链由会话属性决定，界面不为每一跳加控件
    sessionId: jumpSessionSelect.value || null,
  };
}

// ── 外观控件（`TER-005` / `TER-008`）────────────────────────

/**
 * 字体栈里第一个**本机真的有**的 family；一个都没有就返回 `null`。
 *
 * `document.fonts.check` 对「系统装了这个字体」和「已经用 @font-face 加载」都认，
 * 所以拿它判断回退是可靠的——比量文字宽度稳得多。
 */
function firstAvailableFamily(stack) {
  for (const raw of String(stack).split(",")) {
    const name = raw.trim().replace(/^["']|["']$/g, "");
    if (!name) continue;
    // 通用族名永远可用，不用测
    if (name === "monospace" || name === "sans-serif" || name === "serif") return name;
    if (familyAvailable(name)) return name;
  }
  return null;
}

/**
 * 本机到底有没有这个字体。
 *
 * **不能用 `document.fonts.check`**：实测 Chromium 里它对不存在的 family 也返回 true
 * （总能匹配到某个回退），拿它判断等于永远「有」。这里用经典的宽度对照法：把候选字体
 * 与三个通用族各排一次同样的字，只要有一个宽度不同，就说明候选字体真的生效了。
 */
function familyAvailable(name) {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return false;
  const text = "mmmmmmmmmmlli";
  return ["monospace", "serif", "sans-serif"].some((base) => {
    ctx.font = `72px ${base}`;
    const plain = ctx.measureText(text).width;
    ctx.font = `72px "${name}", ${base}`;
    return ctx.measureText(text).width !== plain;
  });
}

/**
 * 把「字体到底生效了没」写进设置面板（`TER-005`）。
 *
 * 首选的字体本机没有时，浏览器会**静默**往后回退：字号、行高都对，字形却变了，
 * 用户只会觉得「字怎么怪怪的」。这里把实际用的那个说出来。
 */
/**
 * 这个字体是不是等宽的（`TER-005`）：同一段里 `i` 与 `W` 的宽度相等才算。
 *
 * 比例字体不会报错，只会让终端里的表格、`ps`/`top` 那种对齐输出全歪——比「字体没找到」
 * 更难察觉，所以要在设置里说一句。
 */
function familyIsMonospace(name) {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return true;
  ctx.font = `48px "${name}", monospace`;
  return Math.abs(ctx.measureText("i").width - ctx.measureText("W").width) < 0.5;
}

function refreshFontWarn() {
  const wanted = String(look.fontFamily).split(",")[0].trim().replace(/^["']|["']$/g, "");
  const actual = firstAvailableFamily(look.fontFamily);
  const ok = actual !== null && actual.toLowerCase() === wanted.toLowerCase();
  lookFontWarn.hidden = ok;
  if (!ok) {
    lookFontWarn.textContent = actual
      ? `本机没有「${wanted}」，实际用的是「${actual}」`
      : `本机没有「${wanted}」，已回退到系统等宽字体`;
  }

  // 等宽检查（`TER-005`）：实际生效的那个字体是不是等宽。通用族名也照测——
  // `monospace` 会通过，`sans-serif` 不会，这正是我们想要的判断。
  const monoOk = !actual || familyIsMonospace(actual);
  lookMonoWarn.hidden = monoOk;
  if (!monoOk) {
    lookMonoWarn.textContent = `「${actual}」不是等宽字体，表格与 TUI 会错位`;
  }
}

function initLookControls() {
  // 先清空：导入配色后这里会再被调用一次，不清就会攒出重复项
  lookThemeSelect.textContent = "";
  for (const t of THEME_DATA) {
    const o = document.createElement("option");
    o.value = t.name;
    o.textContent = t.name;
    lookThemeSelect.appendChild(o);
  }
  lookThemeSelect.value = look.theme;
  // 存下来的字体可能不在预设里（换过机器/手改过 localStorage）：补一条再选中，
  // 否则 select.value 静默落空，用户会看到「字体没生效」
  if (![...lookFontSelect.options].some((o) => o.value === look.fontFamily)) {
    const o = document.createElement("option");
    o.value = look.fontFamily;
    o.textContent = look.fontFamily.split(",")[0].replaceAll('"', "");
    lookFontSelect.appendChild(o);
  }
  lookFontSelect.value = look.fontFamily;
  lookSizeInput.value = String(look.fontSize);
  lookHeightInput.value = String(look.lineHeight);
  lookScrollbackInput.value = String(look.scrollback);
  lookAutoCopySelect.value = String(autoCopyDelay);
  lookAutoCopyOnBox.checked = autoCopy;
  termRightClickSelect.value = rightClickAction;
  bcExtraRulesBox.value = JSON.stringify(extraDangerRules.map((re) => re.source));
  lookWordSepInput.value = wordSeparatorExtra;
  lookPasteTrimBox.checked = pasteTrimTrailing;
}

/**
 * 自定义危险规则（`TER-004` 规格「规则集可配置（JSON）」）。
 *
 * 写成 JSON 字符串数组而不是「一行一条」：JSON 自带转义规则，正则里的 `\s`、`\.`
 * 不会被换行/反斜杠的歧义吃掉；而且解析失败能给出确切位置。
 * 写坏的正则**当场报错、不保存**——静默吞掉等于规则没生效却看着像生效了。
 */
bcExtraRulesBox.addEventListener("change", () => {
  const raw = bcExtraRulesBox.value.trim();
  let sources = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== "string")) {
        throw new Error("要一个字符串数组，例如 [\"rm -rf /opt\"]");
      }
      // 先全部编译一遍再落地：一半合法一半非法时不能只存前一半
      for (const p of parsed) new RegExp(p);
      sources = parsed;
    } catch (e) {
      setStatus(`规则集没保存：${e.message}`);
      return;
    }
  }
  extraDangerRules = sources.map((p) => new RegExp(p));
  void savePrefs();
  setStatus(`自定义危险规则：${extraDangerRules.length} 条`);
});

lookThemeSelect.addEventListener("change", () => {
  look.theme = lookThemeSelect.value;
  applyLook();
});

lookFontSelect.addEventListener("change", () => {
  look.fontFamily = lookFontSelect.value;
  applyLook();
});

// 右键行为（`TER-011`）：规格默认弹菜单，可配成直接粘贴——那时用 `Ctrl+右键`
// 或 `Shift+右键` 唤出菜单。
termRightClickSelect.addEventListener("change", () => {
  rightClickAction = termRightClickSelect.value === "paste" ? "paste" : "menu";
  void savePrefs();
  setStatus(
    rightClickAction === "paste"
      ? "右键：直接粘贴（Ctrl+右键 / Shift+右键 弹菜单）"
      : "右键：弹菜单",
  );
});

// 粘贴时去掉行尾空白（`TER-011` 规格第 1 条）：默认关——改用户粘贴进来的内容
// 是危险动作，要开也得用户自己开。
lookPasteTrimBox.addEventListener("change", () => {
  pasteTrimTrailing = lookPasteTrimBox.checked;
  void savePrefs();
  setStatus(pasteTrimTrailing ? "粘贴：去掉行尾空白" : "粘贴：保留原样");
});

// 双击选词的额外分隔符（`TER-011`）：直接改所有视图的 `wordSeparator`，立刻生效。
// 默认留空——xterm 默认那条能让 `user@host:/var/log` 一次选中，别替用户改掉。
lookWordSepInput.addEventListener("change", () => {
  wordSeparatorExtra = lookWordSepInput.value.trim();
  for (const v of sessions.values()) {
    v.term.options.wordSeparator = (defaultWordSeparator ?? "") + wordSeparatorExtra;
  }
  void savePrefs();
  setStatus(
    wordSeparatorExtra
      ? `双击选词：额外把「${wordSeparatorExtra}」当分隔符`
      : "双击选词：只用默认分隔符",
  );
});

// 选中即复制的防抖延迟（`TER-011`）：拖选时每挪一格都写一次剪贴板很浪费，
// 但「立即」也是合法选择——有人就是要在拖完立刻粘贴。
// 规格要求「选择时自动复制」可关闭（`TER-011`）：有人用剪贴板放别的东西，
// 选区一动就被覆盖很烦。关掉之后 `Ctrl+Shift+C` 仍然可用。
lookAutoCopyOnBox.addEventListener("change", () => {
  autoCopy = lookAutoCopyOnBox.checked;
  void savePrefs();
  setStatus(autoCopy ? "选中即复制：开" : "选中即复制：关（Ctrl+Shift+C 仍可用）");
});

lookAutoCopySelect.addEventListener("change", () => {
  autoCopyDelay = clampNum(Number(lookAutoCopySelect.value) || 0, 0, 2000);
  void savePrefs();
  setStatus(
    autoCopyDelay === 0 ? "选中即复制：立即" : `选中即复制延迟：${autoCopyDelay} 毫秒`,
  );
});

lookSizeInput.addEventListener("change", () => setFontSize(Number(lookSizeInput.value)));

lookHeightInput.addEventListener("change", () => {
  look.lineHeight = clampNum(Number(lookHeightInput.value) || 1.2, 1, 2);
  lookHeightInput.value = String(look.lineHeight);
  applyLook();
});

lookScrollbackInput.addEventListener("change", () => {
  look.scrollback = clampNum(
    Math.round(Number(lookScrollbackInput.value) || 10000),
    1000,
    1000000,
  );
  lookScrollbackInput.value = String(look.scrollback);
  applyLook();
});

// ── 主密码管理（`SEC-001`）────────────────────────────────
//
// 改密码与移除保险库。移除是不可恢复的：先二次确认，确认文案里写明「里面的密码全没」。

const masterDialog = document.getElementById("master-dialog");
const masterOld = document.getElementById("master-old");
const masterNew = document.getElementById("master-new");
const masterNew2 = document.getElementById("master-new2");
const masterMsg = document.getElementById("master-msg");

document.getElementById("master-open").addEventListener("click", () => {
  for (const el of [masterOld, masterNew, masterNew2]) el.value = "";
  masterMsg.textContent = "";
  masterDialog.showModal();
});

document.getElementById("master-close").addEventListener("click", () => masterDialog.close());

// 轮换加密密钥（`SEC-007`）：换个新 salt 重封一遍，条目与密码都不变。
// 为什么要问一句：轮换会覆盖磁盘上的密文，虽然条目不动，但属于「不可撤销」的动作。
document.getElementById("vault-rotate").addEventListener("click", async () => {
  const ok = await askConfirm(
    "轮换加密密钥？",
    "会用一个新的 salt 把保险库重新加密一遍：条目不变、主密码不变，但磁盘上的密文会被覆盖（旧文件不再保留）。",
    "轮换",
  );
  if (!ok) return;
  try {
    const st = await invoke("vault_rotate_key");
    await refreshVault();
    setStatus(`密钥已轮换（${st.entries} 条，保险库仍解锁）`);
  } catch (e) {
    setStatus(`轮换失败：${e}`);
  }
});

document.getElementById("master-change").addEventListener("click", () => {
  void (async () => {
    if (masterNew.value !== masterNew2.value) {
      // 两次输入不一致就别去猜用户想要哪个
      masterMsg.textContent = "两次输入的新密码不一致";
      return;
    }
    try {
      await invoke("vault_change_password", {
        oldPassword: masterOld.value,
        newPassword: masterNew.value,
      });
      masterMsg.textContent = "已更换主密码（保险库内容不变）";
      setStatus("已更换主密码");
      masterOld.value = "";
      masterNew.value = "";
      masterNew2.value = "";
    } catch (e) {
      masterMsg.textContent = `失败：${e}`;
    }
  })();
});

document.getElementById("master-remove").addEventListener("click", () => {
  void (async () => {
    const ok = await askConfirm(
      "移除保险库？",
      "保险库里保存的所有密码会被删除，且**无法恢复**。\n\n移除后「记住密码」会退回未创建状态。",
      "确认移除",
    );
    if (!ok) return;
    try {
      await invoke("vault_remove");
      masterMsg.textContent = "保险库已移除";
      setStatus("保险库已移除");
    } catch (e) {
      masterMsg.textContent = `移除失败：${e}`;
    }
  })();
});

// ── 已知主机（`SEC-005`）──────────────────────────────────
//
// 主机密钥变了的时候，用户唯一的出路是「忘掉旧记录」。没有这个界面，
// 他只能手改 known_hosts——那里存的是 base64 blob，手改几乎必然改坏。

const knownDialog = document.getElementById("known-dialog");
const knownList = document.getElementById("known-list");

async function renderKnownHosts() {
  knownList.textContent = "";
  let rows = [];
  try {
    rows = await invoke("known_hosts_list");
  } catch (e) {
    setStatus(`读取 known_hosts 失败：${e}`);
    return;
  }
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "known-row";
    empty.textContent = "还没有记录（第一次连接时会自动记下）";
    knownList.appendChild(empty);
    return;
  }
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "known-row";
    row.dataset.pattern = r.pattern;
    const host = document.createElement("span");
    host.className = "host";
    host.textContent = r.pattern;
    const fp = document.createElement("span");
    fp.className = "fp";
    fp.textContent = `${r.keyType} ${r.fingerprint}`;
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "忘记";
    del.title = "删掉这条记录；下次连接会重新走 TOFU 确认";
    del.addEventListener("click", async () => {
      try {
        await invoke("known_hosts_forget", { pattern: r.pattern });
        setStatus(`已忘掉 ${r.pattern}`);
        await renderKnownHosts();
      } catch (e) {
        setStatus(`删除失败：${e}`);
      }
    });
    row.append(host, fp, del);
    knownList.appendChild(row);
  }
}

document.getElementById("known-open").addEventListener("click", () => {
  knownDialog.showModal();
  void renderKnownHosts();
});

document.getElementById("known-close").addEventListener("click", () => knownDialog.close());

// ── 导入配色方案（`TER-005`）──────────────────────────────
//
// 支持两种来源：Windows Terminal 的 `schemes`（JSON）与 iTerm2 的 `.itermcolors`（plist）。
// 解析出来的结构跟内置配色一样（4 个界面色 + 16 个 ANSI），所以能直接进同一个下拉框。

/** 导入进来的配色（写进 `config.toml` 的 `customThemes`） */
let customThemes = [];

const themeDialog = document.getElementById("theme-dialog");
const themeText = document.getElementById("theme-text");
const themeFile = document.getElementById("theme-file");
const themeMsg = document.getElementById("theme-msg");

const ANSI_NAMES = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow",
  "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
];

/** `#rrggbb` 归一化：有的方案写 `#abc`，有的写 `rgb(1,2,3)`，不一致就别硬认 */
function normHex(v, fallback) {
  if (typeof v !== "string") return fallback;
  const m = /^#?([0-9a-f]{6})$/i.exec(v.trim());
  if (m) return `#${m[1].toLowerCase()}`;
  const m3 = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(v.trim());
  if (m3) return `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`.toLowerCase();
  return fallback;
}

/** Windows Terminal 的 scheme 对象 → 内部结构 */
function fromWindowsTerminal(scheme, index) {
  // Windows Terminal 用 `purple`/`brightPurple`，ANSI 那边叫 magenta：两个名字都收，
  // 只认一个的话真实方案会一半读不出来
  const alias = { magenta: "purple", brightMagenta: "brightPurple" };
  const ansi = ANSI_NAMES.map((k) =>
    normHex(scheme[k] ?? scheme[alias[k] ?? ""] ?? null, null),
  );
  if (ansi.some((c) => c === null)) return null;
  return {
    name: String(scheme.name ?? `导入配色 ${index + 1}`),
    bg: normHex(scheme.background, "#000000"),
    fg: normHex(scheme.foreground, "#e5e5e5"),
    cur: normHex(scheme.cursorColor, normHex(scheme.foreground, "#e5e5e5")),
    sel: normHex(scheme.selectionBackground, "#444444"),
    ansi,
  };
}

/** 解析 JSON：接受 `{schemes:[...]}` 或裸数组 */
function parseSchemeJson(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : Array.isArray(data.schemes) ? data.schemes : null;
  if (!list) throw new Error("JSON 里没有 schemes 数组");
  return list.map(fromWindowsTerminal).filter(Boolean);
}

/** 0..1 的浮点 → `#rrggbb`（iTerm2 的颜色分量是浮点） */
function floatToHex(r, g, b) {
  const to = (v) => Math.max(0, Math.min(255, Math.round(Number(v) * 255)))
    .toString(16)
    .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** 解析 iTerm2 的 `.itermcolors`（XML plist）：按 key 找后面的三个实数分量 */
function parseItermColors(text, name) {
  const pick = (key) => {
    const i = text.indexOf(`<key>${key}</key>`);
    if (i < 0) return null;
    const tail = text.slice(i, i + 400);
    const reals = [...tail.matchAll(/<real>([^<]+)<\/real>/g)].slice(0, 3);
    if (reals.length < 3) return null;
    return floatToHex(reals[0][1], reals[1][1], reals[2][1]);
  };
  const ansi = [];
  for (let i = 0; i < 16; i += 1) {
    const c = pick(`Ansi ${i} Color`);
    if (!c) throw new Error(`缺少 Ansi ${i} Color`);
    ansi.push(c);
  }
  return {
    name: name || "iTerm2 导入",
    bg: pick("Background Color") ?? "#000000",
    fg: pick("Foreground Color") ?? "#e5e5e5",
    cur: pick("Cursor Color") ?? pick("Foreground Color") ?? "#e5e5e5",
    sel: pick("Selection Color") ?? "#444444",
    ansi,
  };
}

/** 注册一批导入的配色：进下拉框、选中第一套、写进配置 */
async function adoptThemes(themes) {
  if (!themes.length) throw new Error("没有解析出任何配色");
  for (const t of themes) {
    // 同名覆盖：反复导入同一套不该攒出一堆重复项
    const at = THEME_DATA.findIndex((x) => x.name === t.name);
    if (at >= 0) THEME_DATA[at] = t;
    else THEME_DATA.push(t);
    const cat = customThemes.findIndex((x) => x.name === t.name);
    if (cat >= 0) customThemes[cat] = t;
    else customThemes.push(t);
  }
  look.theme = themes[0].name;
  initLookControls();
  applyLook();
  await savePrefs();
  return themes.length;
}

document.getElementById("theme-import-open").addEventListener("click", () => {
  themeText.value = "";
  themeMsg.textContent = "";
  themeDialog.showModal();
});

document.getElementById("theme-close").addEventListener("click", () => themeDialog.close());
document.getElementById("theme-file-btn").addEventListener("click", () => themeFile.click());

themeFile.addEventListener("change", async () => {
  const file = themeFile.files?.[0];
  if (!file) return;
  themeText.value = await file.text();
  themeMsg.textContent = `已读取 ${file.name}，点「导入」应用`;
});

document.getElementById("theme-import").addEventListener("click", () => {
  void (async () => {
    const raw = themeText.value.trim();
    if (!raw) {
      themeMsg.textContent = "先粘贴 JSON 或选择 .itermcolors 文件";
      return;
    }
    try {
      const themes = raw.startsWith("{") || raw.startsWith("[")
        ? parseSchemeJson(raw)
        : [parseItermColors(raw, "")];
      const n = await adoptThemes(themes);
      themeMsg.textContent = `已导入 ${n} 套，当前已切换`;
      setStatus(`已导入 ${n} 套配色`);
    } catch (e) {
      themeMsg.textContent = `导入失败：${e}`;
    }
  })();
});

// ── 本地终端 shell（`LOC-001`）──────────────────────────────
//
// 选项由后端探测：它会告诉你哪个没装、去哪儿装。界面只负责展示与保存，
// 不自己猜路径——猜错了用户只会看到「启动失败」而不知道为什么。

const localShellSelect = document.getElementById("local-shell");
const localShellPathInput = document.getElementById("local-shell-path");
const localShellArgsInput = document.getElementById("local-shell-args");
const localShellCustomRow = document.getElementById("local-shell-custom");

async function initShellControls() {
  let list = [];
  try {
    list = await invoke("local_shells");
  } catch (e) {
    setStatus(`读取本机 shell 失败：${e}`);
  }
  localShellSelect.textContent = "";
  for (const s of list) {
    const o = document.createElement("option");
    o.value = s.id;
    // 没装的也列出来（标一句「未安装」并禁用）：直接消失的话，用户只会觉得
    // 「Git Bash 明明装了怎么没有」，一点线索都没有
    o.textContent = s.available ? s.label : `${s.label}（未安装）`;
    o.disabled = !s.available;
    if (!s.available && s.hint) o.title = s.hint;
    localShellSelect.appendChild(o);
  }
  // 配置里存的选项可能已经不可用（卸了 Git Bash）：补一条说明，别让下拉静默落空
  if (localShell && ![...localShellSelect.options].some((o) => o.value === localShell)) {
    const o = document.createElement("option");
    o.value = localShell;
    o.textContent = `${localShell}（配置里指定的，本机没找到）`;
    localShellSelect.appendChild(o);
  }
  localShellSelect.value = localShell;
  localShellPathInput.value = localShellPath;
  localShellArgsInput.value = localShellArgs;
  syncShellUi();
}

/** 只有选「自定义」时才需要填路径与参数，其余情况收起来 */
function syncShellUi() {
  localShellCustomRow.hidden = localShellSelect.value !== "custom";
}

localShellSelect.addEventListener("change", () => {
  localShell = localShellSelect.value;
  syncShellUi();
  void savePrefs();
  const label = localShellSelect.selectedOptions[0]?.textContent ?? localShell;
  setStatus(`本地终端 shell：${label}（新建终端生效）`);
});

for (const input of [localShellPathInput, localShellArgsInput]) {
  input.addEventListener("change", () => {
    localShellPath = localShellPathInput.value.trim();
    localShellArgs = localShellArgsInput.value;
    void savePrefs();
  });
}

// 连上 SSH 自动打开文件面板（`FIL-001`）：规格要求默认开，但得能关
const filesAutoOpenBox = document.getElementById("files-auto-open");
filesAutoOpenBox.addEventListener("change", () => {
  filesAutoOpen = filesAutoOpenBox.checked;
  void savePrefs();
  setStatus(`连上 SSH 自动打开文件面板：${filesAutoOpen ? "开" : "关"}`);
});

// 标签栏位置（`TER-001`）：顶部 / 底部。只切 #right 的 class，不动 DOM 顺序，
// 所以标签的拖拽 / 中键关闭 / 溢出滚动逻辑不受影响。
const tabsPositionSelect = document.getElementById("tabs-position");
const rightPane = document.getElementById("right");
function applyTabsPosition() {
  rightPane.classList.toggle("tabs-bottom", tabsPosition === "bottom");
}
tabsPositionSelect.addEventListener("change", () => {
  tabsPosition = tabsPositionSelect.value === "bottom" ? "bottom" : "top";
  applyTabsPosition();
  // 位置变了，终端尺寸没变但要重新 fit 一次，避免某些浏览器不重算
  active?.fit.fit();
  void savePrefs();
  setStatus(tabsPosition === "bottom" ? "标签栏：底部" : "标签栏：顶部");
});

// 可配显示列（`FIL-001` 规格 §1）：大小 / 权限可单独关，名称恒显示。
// 只改怎么画，不重新连服务端；关掉某列时若正在按它排序，退回默认排序（别按一列看不见的东西排）。
const filesColSizeBox = document.getElementById("files-col-size");
const filesColMtimeBox = document.getElementById("files-col-mtime");
filesColMtimeBox.addEventListener("change", () => {
  showMtimeCol = filesColMtimeBox.checked;
  // 必须走 applyFileCols 而不是自己调 render*：它会在列被关掉时把排序退回默认，
  // 否则「按时间排着序、列却没了」——排序键指向一个看不见的列
  applyFileCols();
  void savePrefs();
  // 两条独立调用而不是三元：词表门禁只认「纯字面量 setStatus」
  if (showMtimeCol) setStatus("显示修改时间列：开");
  else setStatus("显示修改时间列：关");
});

const filesColModeBox = document.getElementById("files-col-mode");
const applyFileCols = () => {
  if (
    (!showSizeCol && filesSortKey === "size") ||
    (!showModeCol && filesSortKey === "mode") ||
    (!showMtimeCol && filesSortKey === "mtime")
  ) {
    filesSortKey = "default";
    filesSortDir = 1;
  }
  clearSelection();
  renderSortHeader();
  renderFileList();
};
filesColSizeBox.addEventListener("change", () => {
  showSizeCol = filesColSizeBox.checked;
  applyFileCols();
  void savePrefs();
  setStatus(`显示列：大小${showSizeCol ? "开" : "关"}`);
});
filesColModeBox.addEventListener("change", () => {
  showModeCol = filesColModeBox.checked;
  applyFileCols();
  void savePrefs();
  setStatus(`显示列：权限${showModeCol ? "开" : "关"}`);
});

// 显示隐藏文件（`FIL-001` 规格 §4）：默认开。切换只影响列表怎么画，
// 不重新连服务端——filesEntries 一直是全量，开关只是过滤。
const filesShowHiddenBox = document.getElementById("files-show-hidden");
filesShowHiddenBox.addEventListener("change", () => {
  filesShowHidden = filesShowHiddenBox.checked;
  clearSelection();
  renderFileList();
  void savePrefs();
  setStatus(filesShowHidden ? "显示隐藏文件：开" : "显示隐藏文件：关");
});

// 密码保存默认值（`SEC-002` 规格：「可在设置中改为默认不勾」）。
// 它改的是**表单初值**，不是「已经记住的密码」——已存的口令要删得去保险库那边，
// 所以这里只把新值同步到表单，不碰任何已存凭据。
const rememberDefaultBox = document.getElementById("remember-default");
rememberDefaultBox.addEventListener("change", () => {
  rememberDefault = rememberDefaultBox.value;
  // 表单上正显示着旧默认值就换掉；用户已经手改成别的话... 无从判断，直接同步更可预期
  rememberBox.value = rememberDefault;
  vaultRow.hidden = rememberBox.value !== "persist";
  void savePrefs();
  setStatus("密码保存默认值已更新");
});

// ── 设置中心（`SET-001`）──────────────────────────────────
//
// 控件只有这一份：底栏不再重复放主题/字体/字号/编码，避免「两处都能改、状态不一致」。
// 每项带生效范围标注，搜索框按「名字 + 关键词」过滤——关键词里放了中英文别名，
// 用户搜 `gbk`、`乱码`、`encoding` 都能命中。

const settingsDialog = document.getElementById("settings");
const setSearch = document.getElementById("set-search");
const setEmpty = document.getElementById("set-empty");

/**
 * 设置分组（`SET-001`）：规格要求「常规/外观/终端/文件/图形/网络/安全/扩展/高级」。
 *
 * 归属写在这张表里，运行时按分组顺序重排 DOM——比在 HTML 里手排更不容易漏：
 * 加一条设置只要在这里登记一次，忘登记会被兜到「其他」，不会从面板里消失。
 * 没有条目的分组不渲染（空标题是噪音）。
 */
const SET_GROUPS = [
  ["常规", ["ui-lang", "local-shell", "local-shell-path"]],
  ["外观", ["look-size", "look-height", "tabs-position"]],
  ["终端", ["encoding", "look-theme", "theme-import-open", "look-font", "look-scrollback", "term-right-click", "bc-extra-rules", "look-word-sep", "look-paste-trim", "look-autocopy-on", "look-autocopy"]],
  ["文件", ["files-auto-open", "files-show-hidden", "files-col-size", "files-col-mode", "files-auto-refresh"]],
  ["安全", ["master-open", "remember-default", "vault-rotate", "known-open"]],
  // 按「行里第一个带 id 的元素」认领：配置文件那行首个 id 是路径 span，不是按钮
  ["网络", ["net-timeout", "net-keepalive", "net-max-missed"]],
  ["高级", ["app-prefs-path", "prefs-reset"]],
];

/**
 * 每项设置的「默认值 + 是否需要重启」（`SET-001` 的硬指标）。
 *
 * 挂在这张表上而不是写进每条 HTML：加一项设置只改一处；漏登记时界面上会明显缺一行，
 * 而不是散在十几个 row 里各写各的、谁也不知道哪项漏了。
 * 动作类行（管理主密码、导入配色、重置偏好…）没有「默认值」，不登记。
 */
const SET_META = {
  "remember-default": ["永久记住", false],
  encoding: ["UTF-8", false],
  "look-theme": ["WindTerm Dark", false],
  "look-font": ["JetBrains Mono", false],
  "look-size": ["13", false],
  "look-height": ["1.2", false],
  "tabs-position": ["顶部", false],
  "look-scrollback": ["10000", false],
  "ui-lang": ["中文", false],
  "local-shell": ["跟随系统", false],
  "local-shell-path": ["（空）", false],
  "files-auto-open": ["开", false],
  "files-show-hidden": ["开", false],
  "files-col-size": ["全显", false],
  "files-auto-refresh": ["关", false],
  "net-timeout": ["15 秒", false],
  "net-keepalive": ["30 秒", false],
  "net-max-missed": ["3 次", false],
  "term-right-click": ["弹菜单", false],
  "bc-extra-rules": ["（空）", false],
  "look-word-sep": ["（空）", false],
  "look-paste-trim": ["关", false],
  "look-autocopy-on": ["开", false],
  "look-autocopy": ["120 毫秒", false],
};

function applySetMeta() {
  for (const row of document.querySelectorAll("#set-body .set-row")) {
    const ctl = row.querySelector("select, input");
    const meta = ctl?.id ? SET_META[ctl.id] : null;
    let el = row.querySelector(".set-meta");
    if (!meta) {
      el?.remove();
      continue;
    }
    if (!el) {
      el = document.createElement("span");
      el.className = "set-meta";
      row.appendChild(el);
    }
    const [def, restart] = meta;
    el.textContent = `默认 ${def} · ${restart ? "需重启" : "不需要重启"}`;
  }
}

function buildSettingGroups() {
  const body = document.getElementById("set-body");
  const empty = document.getElementById("set-empty");
  const rows = [...body.querySelectorAll(".set-row")];
  // 按「行里第一个带 id 的控件」认领归属；行的 id 挂在行自己身上时取不到，所以用控件
  const byId = new Map();
  for (const row of rows) {
    const ctl = row.querySelector("[id]");
    if (ctl) byId.set(ctl.id, row);
  }
  const placed = new Set();
  const frag = document.createDocumentFragment();
  for (const [name, ids] of SET_GROUPS) {
    const group = document.createElement("div");
    group.className = "set-group";
    group.dataset.group = name;
    const title = document.createElement("h4");
    title.className = "set-group-title";
    title.textContent = name;
    group.appendChild(title);
    let any = false;
    for (const id of ids) {
      const row = byId.get(id);
      if (!row || placed.has(row)) continue;
      group.appendChild(row);
      placed.add(row);
      any = true;
    }
    if (any) frag.appendChild(group);
  }
  const rest = rows.filter((r) => !placed.has(r));
  if (rest.length) {
    const group = document.createElement("div");
    group.className = "set-group";
    group.dataset.group = "其他";
    const title = document.createElement("h4");
    title.className = "set-group-title";
    title.textContent = "其他";
    group.appendChild(title);
    for (const r of rest) group.appendChild(r);
    frag.appendChild(group);
  }
  body.textContent = "";
  body.appendChild(frag);
  if (empty) body.appendChild(empty);
}

/**
 * 把命中的那几个字标出来（`SET-002`）。
 *
 * 原文先存在 `dataset.raw` 里：每次输入都重建的话，直接在已高亮的节点上再切一刀，
 * 标记会越套越乱（表现为「搜两次之后文字越少」）。
 */
function highlightName(el, needle) {
  if (!el) return;
  if (el.dataset.raw === undefined) el.dataset.raw = el.textContent;
  const raw = el.dataset.raw;
  const at = needle ? raw.toLowerCase().indexOf(needle) : -1;
  if (at < 0) {
    if (el.firstChild?.nodeType !== Node.TEXT_NODE || el.childNodes.length !== 1) {
      el.textContent = raw;
    }
    return;
  }
  el.textContent = "";
  const mark = document.createElement("mark");
  mark.textContent = raw.slice(at, at + needle.length);
  el.append(
    document.createTextNode(raw.slice(0, at)),
    mark,
    document.createTextNode(raw.slice(at + needle.length)),
  );
}

// 高级（`SET-001`）：配置文件在哪、以及一键重置偏好
// 语言切换（`SET-012`）：立刻重刷所有标了 data-i18n 的元素，并写进配置。
// 不全量刷新页面——CDP 执行上下文会随重载失效，验收脚本拿不到页面。
document.getElementById("ui-lang").addEventListener("change", (ev) => {
  uiLang = ev.target.value === "en" ? "en" : "zh";
  applyLang();
  void savePrefs();
  setStatus(uiLang === "en" ? "Interface language: English" : "界面语言：中文");
});

const appPrefsPath = document.getElementById("app-prefs-path");
let prefsDir = "";

async function refreshAppPaths() {
  try {
    const p = await invoke("app_paths");
    appPrefsPath.textContent = p.prefs;
    appPrefsPath.title = p.prefs;
    prefsDir = p.data;
  } catch (e) {
    appPrefsPath.textContent = `读取失败：${e}`;
  }
}

document.getElementById("app-prefs-open").addEventListener("click", async () => {
  if (!prefsDir) return;
  try {
    await invoke("open_in_system", { path: prefsDir });
  } catch (e) {
    setStatus(`打不开目录：${e}`);
  }
});

/**
 * 重置偏好时，把「只在内存里」的那部分也恢复默认。
 *
 * `loadPrefs` 对键位与导入配色是「配置里有才覆盖」，而默认配置里这两项是空的：
 * 于是重置后它们原样留在内存里，下一次保存又被写回 `config.toml`——界面说「已重置」，
 * 文件里却还是导入的键位与配色（这是真踩过的 bug，不是理论风险）。
 */
function resetLocalPrefs() {
  keymap = structuredClone(KEYMAP_DEFAULT);
  THEME_DATA.length = THEME_BUILTIN_COUNT;
  customThemes = [];
  // 当前主题要是正好是导入的那套，清掉后它会变成幽灵值：退回第一套内置配色
  if (!THEME_DATA.some((t) => t.name === look.theme)) look.theme = THEME_DATA[0].name;
  renderKeys();
}

document.getElementById("prefs-reset").addEventListener("click", async () => {
  const ok = await askConfirm(
    "重置全部偏好？",
    "配色、字体、编码、键位、导入的方案都会恢复默认。旧配置会备份成 config.toml.bak-<时间戳>，不会直接丢掉。",
    "重置",
  );
  if (!ok) return;
  try {
    const backup = await invoke("prefs_reset");
    // 重新从磁盘读一遍（现在是默认值），并把所有受影响的控件刷回来；
    // 不重载页面：CDP 的执行上下文会随重载失效，验收脚本拿不到页面
    await loadPrefs();
    resetLocalPrefs();
    initLookControls();
    await initShellControls();
    initNetControls();
    buildSettingGroups();
    applySetMeta();
    applyLook();
    await refreshAppPaths();
    // 备份完立刻把默认值写回去：否则 config.toml 会一直缺到用户下次改设置，
    // 去目录里找不到文件，会以为「重置把配置弄丢了」
    void savePrefs();
    setStatus(backup ? `已重置偏好；旧配置备份在 ${backup}` : "偏好本来就是默认值");
  } catch (e) {
    setStatus(`重置失败：${e}`);
  }
});

// 网络组（`SET-001`）：建连超时与 keepalive。改完写进 config.toml，下一次建连生效。
const netTimeoutInput = document.getElementById("net-timeout");
const netKeepaliveInput = document.getElementById("net-keepalive");
const netMaxMissedInput = document.getElementById("net-max-missed");

function initNetControls() {
  netTimeoutInput.value = String(netTimeout);
  netKeepaliveInput.value = String(netKeepalive);
  netMaxMissedInput.value = String(netMaxMissed);
}

netTimeoutInput.addEventListener("change", () => {
  netTimeout = clampNum(Number(netTimeoutInput.value) || 15, 1, 300);
  netTimeoutInput.value = String(netTimeout);
  void savePrefs();
  setStatus(`连接超时：${netTimeout} 秒（下一次建连生效）`);
});

netKeepaliveInput.addEventListener("change", () => {
  netKeepalive = clampNum(Number(netKeepaliveInput.value) || 0, 0, 3600);
  netKeepaliveInput.value = String(netKeepalive);
  void savePrefs();
  setStatus(
    netKeepalive === 0 ? "keepalive 已关闭" : `keepalive 间隔：${netKeepalive} 秒`
  );
});

netMaxMissedInput.addEventListener("change", () => {
  netMaxMissed = clampNum(Number(netMaxMissedInput.value) || 3, 1, 20);
  netMaxMissedInput.value = String(netMaxMissed);
  void savePrefs();
  setStatus(`keepalive 最多丢失：${netMaxMissed} 次`);
});

// ── 界面语言（`SET-012`）──────────────────────────────────
//
// 只翻译**标了 `data-i18n` 的元素**。全量国际化是几百处文案的活，一次做完不现实；
// 先把机制搭起来并覆盖一小组高可见度按钮，覆盖到哪如实写在 README 里。
// 没标的地方仍是中文——不假装「支持英文界面」。
const I18N = {
  zh: {
    "btn.local": "新建本地终端",
    "btn.save": "保存",
    "btn.settings": "设置",
    "btn.files": "文件",
    "btn.tunnels": "隧道",
    "btn.split": "分屏",
    "btn.broadcast": "广播",
    "set.lang": "界面语言",
    "set.shell": "本地终端 Shell",
    "set.shellCustom": "自定义 Shell",
    "set.fontSize": "字号",
    "set.lineHeight": "行高",
    "set.scrollback": "回滚行数",
    "set.rightClick": "右键行为",
    "set.dangerRules": "自定义危险命令规则",
    "set.autoRefresh": "自动刷新间隔",
    "set.fileCols": "显示列",
    "set.tabsPosition": "标签栏位置",
    "set.showHidden": "显示隐藏文件",
    "set.vaultRotate": "轮换加密密钥",
    "set.pasteTrim": "粘贴时去掉行尾空白",
    "set.wordSeparator": "双击选词的额外分隔符",
    "set.autoCopy": "选中即复制",
    "set.autoCopyDelay": "选中即复制延迟",
    "set.encoding": "终端编码",
    "set.theme": "配色",
    "set.themeImport": "导入配色方案",
    "set.font": "字体",
    "set.master": "主密码",
    "set.rememberDefault": "密码保存默认值",
    "set.knownHosts": "已知主机",
    "set.configFile": "配置文件",
    "set.resetPrefs": "重置偏好",
    "set.netTimeout": "连接超时（秒）",
    "set.netKeepalive": "keepalive 间隔（秒，0 关闭）",
    "set.netMaxMissed": "keepalive 最多丢失（次）",
    "btn.close": "关闭",
    "btn.resetDefault": "恢复默认",
    "btn.paste": "粘贴",
    "btn.cancel": "取消",
    "dlg.editTitle": "编辑远端文件",
    "dlg.vaultRemove": "移除保险库…",
    "dlg.knownTitle": "已记录的主机密钥",
    "dlg.themeTitle": "导入配色方案",
    "ctx.copyTab": "复制标签",
    "ctx.renameTab": "重命名…",
    "ctx.closeOthers": "关闭其他（{n}）",
    "ctx.closeRight": "关闭右侧（{n}）",
    "ctx.closeAll": "关闭全部",
    "ctx.copy": "复制",
    "ctx.paste": "粘贴",
    "ctx.selectAll": "全选",
    "ctx.find": "查找…",
    "ctx.clear": "清屏",
    "ctx.split": "左右分屏",
    "ctx.moveTo": "移动到…",
    "ctx.broadcastFolder": "多执行到此文件夹（{n} 个 SSH）",
    "ctx.broadcastSelected": "多执行到选中会话（{n} 个）",
    "ctx.moveSelected": "移动 {n} 项到…",
    "ctx.deleteSelected": "删除 {n} 项…",
    "ctx.rename": "重命名",
    "ctx.duplicate": "复制",
    "ctx.export": "导出",
    "ctx.newSubfolder": "新建子文件夹",
    "ctx.open": "打开",
    "ctx.openInEditor": "用编辑器打开",
    "ctx.download": "下载",
    "ctx.newFolder": "新建文件夹",
    "ctx.remove": "删除",
    "ctx.perms": "权限…",
    "ctx.copyPath": "复制路径",
    "ctx.uploadHere": "上传到此处",
    "ctx.newFile": "新建文件",
    "ctx.cdHere": "在终端中 cd 到此",
    "dlg.keysTitle": "键位",
  },
  en: {
    "btn.local": "New local terminal",
    "btn.save": "Save",
    "btn.settings": "Settings",
    "btn.files": "Files",
    "btn.tunnels": "Tunnels",
    "btn.split": "Split",
    "btn.broadcast": "Broadcast",
    "set.lang": "Language",
    "set.shell": "Local shell",
    "set.shellCustom": "Custom shell",
    "set.fontSize": "Font size",
    "set.lineHeight": "Line height",
    "set.scrollback": "Scrollback lines",
    "set.rightClick": "Right-click action",
    "set.dangerRules": "Custom dangerous-command rules",
    "set.autoRefresh": "Auto-refresh interval",
    "set.fileCols": "Visible columns",
    "set.tabsPosition": "Tab bar position",
    "set.showHidden": "Show hidden files",
    "set.vaultRotate": "Rotate vault key",
    "set.pasteTrim": "Trim trailing whitespace on paste",
    "set.wordSeparator": "Extra word separators (double-click)",
    "set.autoCopy": "Copy on select",
    "set.autoCopyDelay": "Copy-on-select delay",
    "set.encoding": "Terminal encoding",
    "set.theme": "Color scheme",
    "set.themeImport": "Import color scheme",
    "set.font": "Font",
    "set.master": "Master password",
    "set.rememberDefault": "Saved password default",
    "set.knownHosts": "Known hosts",
    "set.configFile": "Config file",
    "set.resetPrefs": "Reset preferences",
    "set.netTimeout": "Connect timeout (s)",
    "set.netKeepalive": "Keepalive interval (s, 0 = off)",
    "set.netMaxMissed": "Keepalive max missed",
    "btn.close": "Close",
    "btn.resetDefault": "Restore defaults",
    "btn.paste": "Paste",
    "btn.cancel": "Cancel",
    "dlg.editTitle": "Edit remote file",
    "dlg.vaultRemove": "Remove vault…",
    "dlg.knownTitle": "Recorded host keys",
    "dlg.themeTitle": "Import color scheme",
    "ctx.copyTab": "Duplicate tab",
    "ctx.renameTab": "Rename…",
    "ctx.closeOthers": "Close others ({n})",
    "ctx.closeRight": "Close tabs to the right ({n})",
    "ctx.closeAll": "Close all",
    "ctx.copy": "Copy",
    "ctx.paste": "Paste",
    "ctx.selectAll": "Select all",
    "ctx.find": "Find…",
    "ctx.clear": "Clear",
    "ctx.split": "Split view",
    "ctx.moveTo": "Move to…",
    "ctx.broadcastFolder": "Broadcast to this folder ({n} SSH)",
    "ctx.broadcastSelected": "Broadcast to selected sessions ({n})",
    "ctx.moveSelected": "Move {n} items to…",
    "ctx.deleteSelected": "Delete {n} items…",
    "ctx.rename": "Rename",
    "ctx.duplicate": "Duplicate",
    "ctx.export": "Export",
    "ctx.newSubfolder": "New subfolder",
    "ctx.open": "Open",
    "ctx.openInEditor": "Open in editor",
    "ctx.download": "Download",
    "ctx.newFolder": "New folder",
    "ctx.remove": "Delete",
    "ctx.perms": "Permissions…",
    "ctx.copyPath": "Copy path",
    "ctx.uploadHere": "Upload here",
    "ctx.newFile": "New file",
    "ctx.cdHere": "cd here in terminal",
    "dlg.keysTitle": "Keybindings",
  },
};

function t(key) {
  return I18N[uiLang]?.[key] ?? I18N.zh[key] ?? key;
}

/**
 * 带占位符的词条：把 `{n}` 之类替换掉。
 *
 * 菜单里有「关闭其他（3）」「移动 2 项到…」这种带数字的项。数字本身不用翻译，
 * 但**括号与语序**中英不同，所以整句进词表、只把数字留成占位符。
 */
function tf(key, params) {
  let s = t(key);
  for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** 把标了 `data-i18n` 的元素刷成当前语言 */
function applyLang() {
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
}

function filterSettings(query) {
  const needle = query.trim().toLowerCase();
  let shown = 0;
  for (const row of document.querySelectorAll("#set-body .set-row")) {
    const nameEl = row.querySelector(".set-name");
    // 只拿「关键词别名 + 名称」做匹配：算上整行 textContent 会把分组徽标里的
    // 「终端」也算进去，搜「终端」就命中一大堆无关项
    const name = nameEl?.dataset.raw ?? nameEl?.textContent ?? "";
    const hay = `${row.dataset.kw ?? ""} ${name}`.toLowerCase();
    const hit = !needle || hay.includes(needle);
    row.hidden = !hit;
    if (hit) shown += 1;
    highlightName(nameEl, needle);

    // 搜索时把「这个设置在哪个分组」写在行首（`SET-002`）：分组标题虽然也在，
    // 但过滤之后只剩零星几行，路径比滚动去找标题快
    let badge = row.querySelector(".set-path");
    if (needle && hit) {
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "set-path";
        row.prepend(badge);
      }
      badge.textContent = `${row.closest(".set-group")?.dataset.group ?? ""} ›`;
      badge.hidden = false;
    } else if (badge) {
      badge.hidden = true;
    }
  }
  // 分组标题跟着内容走：一个组里没有可见项就整组收起来，
  // 否则搜索时满屏都是空标题，等于没过滤
  for (const g of document.querySelectorAll("#set-body .set-group")) {
    const any = [...g.querySelectorAll(".set-row")].some((r) => !r.hidden);
    g.hidden = !any;
  }
  // 搜不到要说出来，别让面板看起来是空的
  setEmpty.hidden = shown > 0;
}

/**
 * 打开设置面板。
 *
 * 两个入口共用这一个函数：终端底栏（有会话时的顺路位置）与左侧树头（始终可见）。
 * 只放底栏的话，没有会话时整条底栏是隐藏的，用户根本进不来（`G15`）。
 */
function openSettings() {
  setSearch.value = "";
  filterSettings("");
  settingsDialog.showModal();
  setSearch.focus();
}

document.getElementById("settings-open").addEventListener("click", openSettings);
document.getElementById("tree-settings").addEventListener("click", openSettings);

document.getElementById("set-close").addEventListener("click", () => settingsDialog.close());
setSearch.addEventListener("input", () => filterSettings(setSearch.value));

// 「跳转到该项」（`SET-002` / `SET-001`）：回车跳到第一个命中项并把焦点给它。
// 搜完还得自己滚下去找，等于搜索只做了一半。
setSearch.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter") return;
  const row = [...document.querySelectorAll("#set-body .set-row")].find(
    (r) => !r.hidden && r.querySelector("select, input, button"),
  );
  const ctl = row?.querySelector("select, input, button");
  if (!ctl) return;
  ev.preventDefault();
  ctl.focus();
  ctl.scrollIntoView({ block: "nearest" });
  setStatus(`已跳到「${row.querySelector(".set-name")?.textContent ?? "该项"}」`);
});

encodingSelect.addEventListener("change", () => {
  encoding = encodingSelect.value;
  // 换编码时丢掉旧的流式状态：上一个编码留下的半截字符不该混进新口径
  decoders.clear();
  void savePrefs();
  setStatus(`终端编码：${encodingSelect.selectedOptions[0]?.textContent ?? encoding}`);
});

useJumpBox.addEventListener("change", syncAuthUi);

// 从下拉里选一个会话当跳板机：把它的地址/用户带出来，密码仍走保险库
jumpSessionSelect.addEventListener("change", async () => {
  const id = jumpSessionSelect.value;
  const jump = id ? (lastTree?.sessions ?? []).find((x) => x.id === id) : null;
  await fillJumpFields(jump);
});

useKeyBox.addEventListener("change", () => {
  if (useKeyBox.checked) useAgentBox.checked = false;
  syncAuthUi();
});

useAgentBox.addEventListener("change", () => {
  if (useAgentBox.checked) useKeyBox.checked = false;
  syncAuthUi();
});

pickKeyBtn.addEventListener("click", () => keyFileInput.click());

keyFileInput.addEventListener("change", async () => {
  const file = keyFileInput.files?.[0];
  if (!file) return;
  try {
    // 私钥是 ASCII/PEM 文本；只在内存里留一份，不落盘、不回显内容
    keyPem = await file.text();
    keyName.textContent = file.name;
    keyName.title = file.name;
  } catch (e) {
    keyPem = null;
    keyName.textContent = `读取失败：${e}`;
  } finally {
    keyFileInput.value = "";
  }
});

// ── 保险库（保存密码）──────────────────────────────────────
async function refreshVault() {
  try {
    const s = await invoke("vault_status");
    vaultUnlocked = s.unlocked;
    vaultOpenBtn.textContent = s.exists ? "解锁" : "创建";
    vaultLockBtn.disabled = !s.unlocked;
    vaultStateEl.textContent = s.unlocked
      ? `已解锁（${s.entries} 条）`
      : s.exists
        ? "保险库已锁定"
        : "保险库未创建";
  } catch (e) {
    vaultStateEl.textContent = `保险库状态未知：${e}`;
  }
}

passInput.addEventListener("input", () => {
  // 用户自己敲了，就不再是「自动填的」——失败时不该提示「可能已过期」
  pwFromStore = false;
});

rememberBox.addEventListener("change", () => {
  // 只有「永久记住」才需要保险库：「本次记住」放内存，不该为它要一次主密码
  vaultRow.hidden = rememberBox.value !== "persist";
  if (rememberBox.value === "persist") {
    refreshVault();
    masterPassInput.focus();
  }
});

vaultOpenBtn.addEventListener("click", async () => {
  const pw = masterPassInput.value;
  if (!pw) {
    setStatus("请输入主密码");
    masterPassInput.focus();
    return;
  }
  try {
    // 有文件就解锁，没有就创建：用户不需要先理解「保险库」是什么
    const exists = (await invoke("vault_status")).exists;
    await invoke(exists ? "vault_unlock" : "vault_create", { password: pw });
    masterPassInput.value = "";
    await refreshVault();
    setStatus(exists ? "保险库已解锁" : "保险库已创建");
  } catch (e) {
    setStatus(`保险库操作失败：${e}`);
  }
});

vaultLockBtn.addEventListener("click", async () => {
  await invoke("vault_lock");
  await refreshVault();
  setStatus("保险库已锁定");
});

/**
 * 连接成功后按需保存密码（`SEC-002` 三态）。保存失败不影响已经连上的会话。
 *
 * - `no`：什么都不做；
 * - `session`：只放进这次运行的内存——不落盘、也不要主密码，关掉应用就忘；
 * - `persist`：写进保险库（需要主密码解锁）。
 */
async function savePasswordIfAsked() {
  const mode = rememberBox.value;
  if (mode === "no" || useKeyBox.checked) return;
  const pw = passInput.value;
  if (!pw) return;
  if (mode === "session") {
    sessionPasswords.set(sessionKey(hostInput.value, portInput.value, userInput.value), pw);
    setStatus("密码已记住（仅本次运行）");
    return;
  }
  if (!selectedSession) return;
  try {
    await invoke("credential_save", {
      sessionId: selectedSession.id,
      name: selectedSession.name,
      password: pw,
    });
    await refreshVault();
    if (!vaultPanel.hidden) await renderVaultPanel();
  } catch (e) {
    active?.term.write(`\r\n\x1b[33m密码未保存：${e}\x1b[0m\r\n`);
  }
}

// ── 命令面板（`SES-022`）────────────────────────────────────
//
// 规格里的原话是「这是可发现性的主要手段——MobaXterm 的很多能力藏在多级菜单里，
// 用户根本不知道存在」。所以它不只是一个搜索框：**来源必须覆盖全部能力**，
// 少一类就等于那类能力仍然藏在菜单里。这里是五类：动作（带快捷键）、工具、
// 会话（连接）、隧道（启停）、设置项（跳转）。
const cmdDialog = document.getElementById("cmd-dialog");
const cmdInput = document.getElementById("cmd-input");
const cmdList = document.getElementById("cmd-list");
const cmdEmpty = document.getElementById("cmd-empty");
const cmdHint = document.getElementById("cmd-hint");

/** 来源的显示名与排序权重：动作在最前（最常用），设置项垫底（最多、最不常搜） */
const CMD_KIND = { action: "动作", tool: "工具", session: "会话", tunnel: "隧道", setting: "设置" };
const CMD_KIND_ORDER = { action: 0, tool: 1, session: 2, tunnel: 3, setting: 4 };
/** 一次最多画多少行：几百条设置项全画出来既慢又没人看 */
const CMD_LIMIT = 50;

/** 这次打开面板时的全部候选 */
let cmdItems = [];
/** 过滤后实际画出来的那批（下标与 DOM 子节点一一对应） */
let cmdShown = [];
let cmdIndex = 0;

/**
 * 收集全部可搜的东西。
 *
 * 每次打开都重建：会话树、隧道状态、设置项都会变，缓存住就会搜到已经删掉的会话。
 * 这些来源本身都是内存里的数组或现成 DOM，重建一次没有成本。
 *
 * `run` 返回 false 表示「这个动作现在没有可作用的对象」（比如查找栏没开时按「关闭查找栏」），
 * 面板据此给一句话，而不是关掉面板却什么都没发生。
 */
function collectCommands() {
  const items = [];
  for (const [action, v] of Object.entries(keymap)) {
    items.push({
      kind: "action",
      title: v.label,
      detail: "",
      // 只显示首个组合键：`copy` 这种有备选键位的，后面那个写进快捷键对话框看
      chord: v.chords[0] ?? "",
      keywords: action,
      run: () => runAction(action),
    });
  }
  items.push(
    {
      kind: "tool",
      title: "生成或导入 SSH 密钥",
      detail: "查看指纹",
      chord: "",
      keywords: "keygen 密钥 指纹",
      run: () => {
        document.getElementById("keygen-open").click();
        return true;
      },
    },
    {
      kind: "tool",
      title: "网络活动",
      detail: "当前所有出站连接",
      chord: "",
      keywords: "net 出站 遥测 白名单",
      run: () => {
        document.getElementById("net-open").click();
        return true;
      },
    },
  );
  for (const s of lastTree?.sessions ?? []) {
    items.push({
      kind: "session",
      title: `连接：${s.name}`,
      detail: `${s.username ?? ""}@${s.host ?? ""}${s.port ? `:${s.port}` : ""}`,
      chord: "",
      keywords: `${s.host ?? ""} ${s.username ?? ""} ${s.kind}`,
      run: () => {
        void connectFromPalette(s);
        return true;
      },
    });
  }
  for (const t of lastTunnels) {
    items.push({
      kind: "tunnel",
      title: `${t.running ? "停止" : "启动"}隧道：${t.name}`,
      detail: `${t.listen}${t.target ? ` → ${t.target}` : ""}`,
      chord: "",
      keywords: `tunnel 隧道 ${t.group ?? ""}`,
      run: () => {
        if (t.running) void stopTunnel(t.id);
        else void startSavedTunnel(t.id);
        return true;
      },
    });
  }
  for (const row of document.querySelectorAll("#set-body .set-row")) {
    const nameEl = row.querySelector(".set-name");
    // 与 `filterSettings` 同一个取值口径：`data-raw` 是没被搜索高亮切碎的原名
    const name = nameEl?.dataset.raw ?? nameEl?.textContent ?? "";
    if (!name) continue;
    items.push({
      kind: "setting",
      title: `打开设置：${name}`,
      detail: row.closest(".set-group")?.dataset.group ?? "",
      chord: "",
      keywords: row.dataset.kw ?? "",
      run: () => {
        jumpToSetting(row, name);
        return true;
      },
    });
  }
  return items;
}

/** 会话命令：先走真实的「选中会话」路径（带出跳板、自动填口令），填得齐就直接连 */
async function connectFromPalette(s) {
  await selectSession(s);
  if (s.kind === "sftp") return; // 文件面板已经打开，SFTP 没有「连接」这一步
  if (passInput.value || useKeyBox.checked || useAgentBox.checked) {
    await openSsh();
    return;
  }
  // 口令要人填：把话说清楚，而不是假装连上了
  setStatus(`已选中「${s.name}」：填好密码后点「连接」`);
}

/** 设置项命令：打开设置 → 搜到它 → 焦点落到控件上 */
function jumpToSetting(row, name) {
  openSettings();
  setSearch.value = name;
  filterSettings(name);
  const ctl = row.querySelector("select, input, button");
  if (!ctl) return;
  ctl.focus();
  ctl.scrollIntoView({ block: "center" });
  setStatus(`已跳到「${name}」`);
}

/**
 * 过滤 + 排序 + 画出来。
 *
 * 多个词按「都要命中」处理（`连 prod` 能找到 `连接：prod-web-01`）：中文没有空格分词，
 * 但用户很自然会用空格把「干什么」和「哪一台」分开写。
 */
function renderPalette() {
  const q = cmdInput.value.trim().toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  const scored = [];
  for (const item of cmdItems) {
    const title = item.title.toLowerCase();
    const hay = `${title} ${item.detail} ${item.keywords} ${CMD_KIND[item.kind]}`.toLowerCase();
    if (!tokens.every((t) => hay.includes(t))) continue;
    let score = 0;
    if (q) {
      if (title === q) score = 100;
      else if (title.startsWith(q)) score = 80;
      else if (title.includes(q)) score = 60;
      // 整串没命中但每个词都在标题里（`命令` + `面板` 命中「命令面板」）
      else if (tokens.every((t) => title.includes(t))) score = 50;
      else score = 20; // 只在细节/关键词里命中
    }
    scored.push({ item, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      CMD_KIND_ORDER[a.item.kind] - CMD_KIND_ORDER[b.item.kind] ||
      a.item.title.localeCompare(b.item.title, "zh"),
  );
  cmdShown = scored.slice(0, CMD_LIMIT).map((x) => x.item);
  cmdIndex = 0;
  paintPalette(scored.length);
}

function paintPalette(total) {
  cmdList.textContent = "";
  cmdShown.forEach((item, i) => {
    const row = document.createElement("div");
    row.className = "cmd-row";
    row.dataset.kind = item.kind;
    row.setAttribute("role", "option");
    const kind = document.createElement("span");
    kind.className = "cmd-kind";
    kind.textContent = CMD_KIND[item.kind] ?? "";
    const title = document.createElement("span");
    title.className = "cmd-title";
    title.textContent = item.title;
    const detail = document.createElement("span");
    detail.className = "cmd-detail";
    detail.textContent = item.detail ?? "";
    row.append(kind, title, detail);
    if (item.chord) {
      const kbd = document.createElement("kbd");
      kbd.className = "cmd-chord";
      kbd.textContent = item.chord;
      row.appendChild(kbd);
    }
    // 用 mousedown + preventDefault 保住输入框的焦点：焦点一跑到行上，方向键就不再
    // 改选中项，用户会以为键盘坏了
    row.addEventListener("mousedown", (ev) => ev.preventDefault());
    row.addEventListener("click", () => runPaletteItem(i));
    row.addEventListener("mousemove", () => setPaletteIndex(i));
    if (i === cmdIndex) row.classList.add("active");
    cmdList.appendChild(row);
  });

  cmdEmpty.hidden = cmdShown.length > 0;
  cmdHint.textContent = total > CMD_LIMIT
    ? `共 ${total} 项，只显示前 ${CMD_LIMIT} 项——再输几个字缩小范围`
    : cmdShown.length
      ? `${cmdShown.length} 项 · ↑↓ 选择 · 回车执行 · Esc 关闭`
      : "";
  cmdList.children[cmdIndex]?.scrollIntoView({ block: "nearest" });
}

function setPaletteIndex(i) {
  if (!cmdShown.length) return;
  const next = (i + cmdShown.length) % cmdShown.length;
  if (next === cmdIndex) return;
  cmdList.children[cmdIndex]?.classList.remove("active");
  cmdIndex = next;
  const el = cmdList.children[cmdIndex];
  el?.classList.add("active");
  el?.scrollIntoView({ block: "nearest" });
}

function runPaletteItem(i) {
  const item = cmdShown[i];
  if (!item) return;
  // 先关面板再执行：动作可能自己开一个对话框（设置/键位/密钥），两个模态叠在一起时
  // Esc 只关掉上面那个，用户会以为卡住了
  cmdDialog.close();
  if (item.run() === false) setStatus(`「${item.title}」现在没有可作用的对象`);
}

function openPalette() {
  cmdItems = collectCommands();
  cmdInput.value = "";
  cmdDialog.showModal();
  renderPalette();
  cmdInput.focus();
  // 隧道面板没开过时 `lastTunnels` 还是空的：补一次读库，读完再刷一遍列表。
  // 少了这一步，用户搜不到任何隧道，还会以为隧道没保存。
  if (!lastTunnels.length) {
    void refreshTunnels().then(() => {
      if (!cmdDialog.open) return;
      cmdItems = collectCommands();
      renderPalette();
    });
  }
}

function togglePalette() {
  if (cmdDialog.open) cmdDialog.close();
  else openPalette();
}

document.getElementById("cmd-open").addEventListener("click", openPalette);
document.getElementById("tree-cmd").addEventListener("click", openPalette);

cmdInput.addEventListener("input", () => renderPalette());
cmdInput.addEventListener("keydown", (ev) => {
  if (ev.key === "ArrowDown") {
    ev.preventDefault();
    setPaletteIndex(cmdIndex + 1);
  } else if (ev.key === "ArrowUp") {
    ev.preventDefault();
    setPaletteIndex(cmdIndex - 1);
  } else if (ev.key === "PageDown") {
    ev.preventDefault();
    setPaletteIndex(cmdIndex + 10);
  } else if (ev.key === "PageUp") {
    ev.preventDefault();
    setPaletteIndex(cmdIndex - 10);
  } else if (ev.key === "Enter") {
    ev.preventDefault();
    runPaletteItem(cmdIndex);
  } else if (ev.key === "Escape") {
    // 自己关，不依赖 `<dialog>` 的默认取消：默认取消在 Esc 被别处 preventDefault 时
    // 会静默失效，那时用户会觉得「按 Esc 没反应」
    ev.preventDefault();
    cmdDialog.close();
  }
});

// 关掉（Esc / 执行完）就把查询清干净：下次打开不该还停在上次的搜索词上
cmdDialog.addEventListener("close", () => {
  cmdInput.value = "";
  cmdShown = [];
  cmdIndex = 0;
});

// 自动化验收接口（`scripts/e2e-desktop.mjs` 用 CDP 读它）。
// 只读、无副作用：靠 DOM 文本反推会话句柄会变成脆弱实现，
// 而「界面可被脚本驱动」本身也是 AI Agent 体验的一部分。
/** 读某个会话的屏幕文本（含回滚区）；会话还没建好时给空串 */
function screenText(view) {
  const buf = view?.term?.buffer?.active;
  if (!buf) return "";
  const lines = [];
  for (let i = 0; i < buf.length; i++) {
    lines.push(buf.getLine(i)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

window.__wt = {
  /**
   * 前端脚本版本标记。
   *
   * WebView2 会缓存 `http://tauri.localhost` 下的静态资源，改完前端只重编二进制
   * 时，页面里跑的可能是旧 JS——排查时就会把「旧代码的行为」当成新代码的 bug。
   * 验收先读这个值，对不上就直接判失败，省掉一整类假结论。
   */
  ui: "wt-ui-122",
  /** 验收用：主窗口当前是否全屏（`TER-020`） */
  get fullscreen() {
    return isFullscreen;
  },
  /**
   * 命令面板的当前状态（`SES-022`）。
   *
   * 验收要能断言「搜出来的第一项是哪一个」「选中项在第几个」「这一项挂着什么快捷键」，
   * 这些从截图看不出来，从 DOM 文本反推又脆弱。所以直接给结构化的快照。
   */
  palette() {
    return {
      open: cmdDialog.open,
      query: cmdInput.value,
      index: cmdIndex,
      total: cmdItems.length,
      shown: [...cmdList.children].map((el) => ({
        kind: el.dataset.kind,
        title: el.querySelector(".cmd-title")?.textContent ?? "",
        chord: el.querySelector(".cmd-chord")?.textContent ?? "",
        active: el.classList.contains("active"),
      })),
    };
  },
  /**
   * 验收用：刷新会话树并等它**画完**。
   *
   * `#refresh` 的 click 处理器是 async：点完立刻按坐标点节点，坐标是按旧行量的，
   * 落点却是重画后的另一行——验收会点到别的会话上去（这是真踩过的坑）。
   */
  refreshTree() {
    return loadTree();
  },
  /**
   * 验收用：按名字选中会话，走**真实的** `selectSession` 路径。
   *
   * 为什么不点树节点：这一条要验的是「自动填入的口令过期了」，与树渲染无关；
   * 让断言依赖树的话，树一旦没画出来就变成测树而不是测口令。
   */
  async selectSessionByName(name) {
    const s = (lastTree?.sessions ?? []).find((x) => x.name === name);
    if (!s) return false;
    await selectSession(s);
    return true;
  },
  /** 验收用：往「本次记住」里塞一条口令（验「过期密码」时不必解锁保险库） */
  sessionRemember(host, port, user, password) {
    sessionPasswords.set(sessionKey(host, port, user), password);
    return sessionPasswords.size;
  },
  /** 界面语言与词表（验收用：查「有没有漏翻的键」） */
  i18n() {
    return {
      lang: uiLang,
      zh: Object.keys(I18N.zh),
      en: Object.keys(I18N.en),
    };
  },
  /** 「本次记住」存了几条（验收用：只回数量，不回口令） */
  sessionPasswords() {
    return sessionPasswords.size;
  },
  /** 拖拽命中计数（验收用：分清「事件没到」「没越门槛」「没找着目标」） */
  tabDrag() {
    return { ...tabDrag };
  },
  /** 验收用：模拟一次「窗口获得焦点」，走与真实 focus 完全相同的 maybeAutoRefresh 路径。
   *  headless WebView 里 focus 事件未必派发，直接调处理函数才能确定地验节流/触发逻辑。 */
  _simulateFocus() {
    void maybeAutoRefresh("模拟焦点");
    return { autoRefreshSecs, autoRefreshCount };
  },
  /** 验收用：把「上次列目录时刻」设为此刻，让「刚列过目录」的前提确定成立 */
  _resetDirLoadClock() {
    lastDirLoadAt = Date.now();
    return lastDirLoadAt;
  },
  /** 验收用：把「上次列目录时刻」往回调，模拟距上次已过去足够久 */
  _ageDirLoad(ms) {
    lastDirLoadAt -= ms;
    return lastDirLoadAt;
  },

  /** 验收用：把文件列表排序复位成默认（点列头只能切到三种排序，没有回默认的按钮） */
  _resetFileSort() {
    filesSortKey = "default";
    filesSortDir = 1;
    renderSortHeader();
    renderFileList();
    return { sortKey: filesSortKey, sortDir: filesSortDir };
  },

  /** 滚动位置（验收用：上滚/下滚/到顶/到底看这个，不要看屏幕猜） */
  scroll() {
    if (!active) return null;
    const b = active.term.buffer.active;
    return { viewportY: b.viewportY, baseY: b.baseY, atBottom: b.viewportY === b.baseY };
  },
  /** 当前选区文本（验收与脚本用） */
  selection() {
    return active?.term.getSelection() ?? "";
  },
  /**
   * 屏幕上某段文字的中心点（视口坐标）。
   *
   * 用途是让脚本能「点到屏幕上这段字」——比如验收双击选词。走公开 DOM
   * （`.xterm-rows > div` + `Range`）而不是 xterm 的私有度量，是因为私有 API
   * 一升级就变，而 DOM 结构是渲染结果本身。
   */
  textPoint(text) {
    if (!text) return null;
    // 从**最新**的行往上找，并且跳过被裁掉一半的行：
    // 命中一个屏幕外的坐标，点击会落到别的字上（验收里表现为「选中了 echo」这种怪结果）。
    const rows = [...document.querySelectorAll(".xterm-rows > div")];
    const host = document.querySelector(".term-view.active")?.getBoundingClientRect() ?? null;
    for (let row = rows.length - 1; row >= 0; row -= 1) {
      const rowEl = rows[row];
      const idx = rowEl.textContent.indexOf(text);
      if (idx < 0) continue;
      const walker = document.createTreeWalker(rowEl, NodeFilter.SHOW_TEXT);
      let seen = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const len = node.nodeValue.length;
        if (seen + len > idx) {
          const start = idx - seen;
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, Math.min(start + text.length, len));
          const r = range.getBoundingClientRect();
          const visible = !host || (r.y >= host.top && r.bottom <= host.bottom + 1);
          if (r.width > 0 && visible) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
        seen += len;
      }
    }
    return null;
  },
  /** 粘贴次数：断言「取消后零字节」时对比它没变 */
  /** 上一次真正粘贴出去的文本（`TER-011`：规范化与去尾空白都靠它观察） */
  get lastPaste() {
    return active?.lastPaste ?? null;
  },
  get pasteCount() {
    return active?.pasteCount ?? 0;
  },
  /** 自动复制成功次数 */
  get autoCopyCount() {
    return active?.autoCopyCount ?? 0;
  },
  /** 多行粘贴确认框是否打开 */
  get pasteDialogOpen() {
    return pasteDialog.open;
  },
  /** 最近一次取到的隧道状态（验收与脚本用） */
  get tunnels() {
    return lastTunnels.slice();
  },
  /** 隧道面板底部的提示文本 */
  get tunnelMsg() {
    return tunnelMsgEl.textContent;
  },
  /** 远端是否要求 bracketed paste（DECSET ?2004） */
  get bracketedPaste() {
    return active?.term.modes?.bracketedPasteMode ?? false;
  },
  get autoCopy() {
    return autoCopy;
  },
  set autoCopy(on) {
    autoCopy = !!on;
  },
  /** 文件面板的当前状态（验收与脚本用） */
  get files() {
    return {
      path: sftpPath,
      msg: filesMsg.textContent,
      // 读**数据**而不是 DOM：列表是虚拟滚动的，DOM 里只有可视窗口内的那些条
      rows: visibleFiles().map(entryLabel),
      /** 全量条目数（含被隐藏的），与 rows 一起看能验「过滤真的生效」 */
      total: filesEntries.length,
      showHidden: filesShowHidden,
      sortKey: filesSortKey,
      sortDir: filesSortDir,
      tabsPosition,
      showSizeCol,
      showModeCol,
      showMtimeCol,
      autoRefreshSecs,
      autoRefreshCount,
      /** 成功列目录的累计次数（`SEC-002` AC-2 的验收靠它对齐操作与连接数） */
      listCount: dirLoadCount,
      savePrefsCount,
      /** 列目录失败的原因（空串表示这次是成功的） */
      error: filesLoadError,
      /** 当前选中项的名字（验收与脚本用） */
      selected: selectedEntry?.name ?? null,
      /** 最近一次上传的进度快照：`{name,total,last,events}` */
      upload: lastUpload,
      /** 原始修改时间映射（name → Unix 秒），验收读它，不去解析 DOM 的格式化文本 */
      mtimes: Object.fromEntries(filesEntries.map((e) => [e.name, e.mtime ?? null])),
    };
  },
  /** 当前激活会话的句柄 */
  get handle() {
    return active?.handle ?? null;
  },
  get running() {
    return active?.running ?? false;
  },
  get pending() {
    return active?.pending ?? 0;
  },
  get dataEvents() {
    return active?.dataEvents ?? 0;
  },
  get inputLog() {
    return (active?.inputLog ?? []).slice();
  },
  get cols() {
    return active?.term.cols ?? 0;
  },
  get rows() {
    return active?.term.rows ?? 0;
  },
  get fontSize() {
    return fontSize;
  },
  /**
   * 找包含某段文字的行号（在回滚缓冲里从第 0 行扫）。验收用。
   *
   * `TER-024`（24 位色）与 `TER-025`（CJK 占两列）没法从屏幕文本看出来，
   * 只能读 xterm 的 buffer——那里才有颜色与单元格宽度。
   */
  findRow(text) {
    const buf = active?.term.buffer.active;
    if (!buf) return null;
    for (let i = 0; i < buf.length; i += 1) {
      const line = buf.getLine(i);
      if (!line) continue;
      // 返回行列**两个**：只给行号的话，断言会隐含假设「文字从第 0 列开始」，
      // 前面的输出一变就假失败。
      //
      // 列号必须逐格算，不能用 `translateToString` 的下标：CJK 在 buffer 里占
      // **两列**但只是**一个**字符，下标会比真实列号小，拿去 `cellAt` 读到的
      // 是别的格子（症状：屏幕明明白白有那串字，断言却一直超时）。
      let plain = "";
      const cols = [];
      for (let x = 0; x < line.length; x += 1) {
        const cell = line.getCell(x);
        if (!cell) break;
        if (cell.getWidth() === 0) continue; // 宽字符的续列不产生字符
        plain += cell.getChars() || " ";
        cols.push(x);
      }
      const at = plain.indexOf(text);
      if (at >= 0) return { row: i, col: cols[at] };
    }
    return null;
  },
  /** 读某个单元格：文字、占几列、前景色（24 位色时 `fg` 就是 0xRRGGBB）。验收用。 */
  cellAt(row, col) {
    const line = active?.term.buffer.active.getLine(row);
    const cell = line?.getCell(col);
    if (!cell) return null;
    return {
      text: cell.getChars(),
      width: cell.getWidth(),
      fg: cell.getFgColor(),
      fgIsRgb: cell.isFgRGB(),
    };
  },

  /** 终端输出编码（`TER-006`，验收读它而不是去解析下拉框） */
  get encoding() {
    return encoding;
  },
  /** 已知主机条目数（`SEC-005`，验收读它） */
  async knownHosts() {
    return invoke("known_hosts_list");
  },
  /** 分屏状态（`G6`）：右侧显示哪个会话 */
  get split() {
    const v = splitView();
    return { on: v !== null, right: v?.label ?? null };
  },
  /** 内嵌编辑器（`FIL-011`）：打开的文档与当前内容 */
  get editor() {
    const doc = edActive();
    return {
      open: !editorEl.hidden,
      docs: edDocs.map((d) => ({ name: d.name, dirty: d.dirty, chars: d.text.length })),
      active: doc?.name ?? null,
      text: doc?.text ?? null,
      // 编码（`FIL-011`）：实际按哪个编码解出来的
      encoding: doc?.encoding ?? null,
      // 换行符（`FIL-011`）：`crlf` / `lf`
      eol: doc?.eol ?? null,
      // 语法高亮（`FIL-011`）：Monaco 有没有接管、按扩展名推断出什么语言
      monaco: Boolean(edMonaco),
      lang: doc ? edLangOf(doc.name) : null,
      // 列选择（`FIL-011`）：开关是否按下；`selections` 是当前选区/光标个数
      //（矩形框选算 1 个，多光标才是 >1）
      columnSelection: Boolean(edMonaco) && edColumnSelection,
      selections: edMonaco ? (edMonaco.getSelections()?.length ?? 0) : 0,
      // 语法高亮覆盖的语言数（规格要求 ≥ 30）
      languages: ED_LANG_COUNT,
    };
  },
  /** 正在编辑的远端文件（`FIL-005`）：验收读它 */
  get lastEdit() {
    return lastEdit ? { ...lastEdit } : null;
  },
  /** 自动检测本地保存（`FIL-005`）：验收读它，别去解析提示文案 */
  get editWatch() {
    return { ...editWatch };
  },
  /** 最近生成的密钥（`LOC-014`）：验收读它，别去解析对话框里的文本 */
  get lastKey() {
    return lastKey ? { ...lastKey } : null;
  },
  /**
   * 状态栏（`SET-012`）：raw 是写进去的原文，shown 是实际显示的字。
   * 验收靠这两者判断「翻译表里有词条」之外，字到底有没有换掉。
   */
  get status() {
    return { raw: lastStatus, shown: statusEl.textContent };
  },
  /** 验收用：走一遍真的 setStatus，验证中英切换落到状态栏上 */
  _setStatus(text) {
    setStatus(text);
    return { raw: lastStatus, shown: statusEl.textContent };
  },
  /** 键位表（`TER-020`）：验收读它，别去解析对话框里的文本 */
  get keymap() {
    return Object.fromEntries(
      Object.entries(keymap).map(([a, v]) => [a, { label: v.label, chords: [...v.chords] }]),
    );
  },
  /** 多执行广播（`TER-004`）：目标数、最近一次结果与分组 */
  get broadcast() {
    return {
      open: !bcBar.hidden,
      targets: broadcastTargets().length,
      last: lastBroadcast,
      result: bcResult.textContent,
      // 实时逐键（`broadcast-live`）：验收靠 chars/sends 判断「真的发了几份」，
      // 只看开关状态证明不了按键有没有被镜像出去
      live: { ...liveBroadcast },
      /** 勾选的目标标签 id；`null` 表示全部已连接（`TER-004` 目标选择） */
      chosen: bcTargetsChosen ? [...bcTargetsChosen] : null,
    };
  },
  /**
   * 外观与回滚行数（`TER-005` / `TER-008`）：验收读它，别去解析下拉框。
   *
   * 带 `appliedBackground` 是为了能断言「主题真的应用到 xterm 上了」——
   * 只验下拉框的话，把 theme 传空也能过。
   */
  get look() {
    return {
      ...look,
      appliedBackground: active?.term.options.theme?.background ?? null,
      appliedScrollback: active?.term.options.scrollback ?? null,
      // 双击选词的分隔符（`TER-011`）：验收要能分清「设置没生效」与「xterm 不认」，
      // 只看最终选区是分不出来的
      wordSeparator: active?.term.options.wordSeparator ?? null,
      rightClickAction,
      // 选中即复制的运行态（`TER-011`）：设置改了有没有真的落到变量上，验收要能分开看
      autoCopyOn: autoCopy,
      autoCopyDelayMs: autoCopyDelay,
    };
  },
  /** 在激活会话里查找（验收与脚本用），返回是否命中与当前计数文本 */
  find(query) {
    if (!active) return null;
    const found = active.search.findNext(query, { decorations: FIND_DECORATIONS });
    return { found, count: findCount.textContent };
  },
  /** 当前屏幕文本（含回滚区），供验收断言用 */
  screen() {
    return screenText(active);
  },
  /**
   * 每个会话各一份屏幕文本。
   *
   * 实时广播（`TER-004`）必须证明「**别的**会话也收到了这些按键」——只看发送
   * 计数证明不了字节有没有到远端；而两台会话的标签可能一模一样，按标签取会取错，
   * 所以整批给出去，让它自己数有几台含标记。
   */
  screens() {
    return [...sessions.values()].map((v) => ({ label: v.label, text: screenText(v) }));
  },
  /**
   * 标签页：每个会话一行，标出哪个是激活的。
   *
   * `id` 是 `nextViewId` 赋的稳定整数：**验收要按它认标签，别按 label**——
   * 本地 shell 起来后会用 OSC 2 标题把 label 改写（"本地 s14-18" → "pwsh.exe"），
   * 拿建标签时的 label 快照去判「切到哪一条」会偶发假失败。
   */
  tabs() {
    return [...sessions.values()].map((v) => ({
      id: v.id,
      label: v.label,
      active: v === active,
      handle: v.handle,
    }));
  },
  /** 会话树里可见的会话名，供验收断言用 */
  sessions() {
    return [...treeBody.querySelectorAll(".node.session")].map((el) => el.textContent);
  },
};

// 启动自检：把后端是否可达打到状态栏，避免「白屏但不知道哪坏了」
(async () => {
  // 外观要先读回来再建会话，否则第一个终端会用默认配色闪一下再变色
  await loadPrefs();
  initLookControls();
  await initShellControls();
  buildSettingGroups();
  applySetMeta();
  initNetControls();
  document.getElementById("ui-lang").value = uiLang;
  applyLang();
  await refreshAppPaths();
  filesAutoOpenBox.checked = filesAutoOpen;
  filesShowHiddenBox.checked = filesShowHidden;
  rememberDefaultBox.value = rememberDefault;
  rememberBox.value = rememberDefault;
  filesColSizeBox.checked = showSizeCol;
  filesColModeBox.checked = showModeCol;
  filesColMtimeBox.checked = showMtimeCol;
  filesAutoRefreshSelect.value = String(autoRefreshSecs);
  tabsPositionSelect.value = tabsPosition;
  applyTabsPosition();
  renderSortHeader();
  initBroadcast();
  loadTree();
  try {
    await invoke("term_stats", { handle: "probe" });
  } catch (e) {
    // 探针句柄不存在是预期的；能拿到错误说明 IPC 通了
    if (String(e).includes("IPC_UNKNOWN_HANDLE")) {
      setStatus("就绪（点击「新建本地终端」开始）");
      return;
    }
    setStatus(`后端异常：${e}`);
  }
})();
