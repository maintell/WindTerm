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

function setStatus(text) {
  statusEl.textContent = text;
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
    if (typeof p.showSizeCol === "boolean") showSizeCol = p.showSizeCol;
    if (typeof p.showModeCol === "boolean") showModeCol = p.showModeCol;
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
async function savePrefs() {
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
        showSizeCol,
        showModeCol,
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
    invoke("term_write", { handle: view.handle, data }).catch((e) =>
      setStatus(`写入失败：${e}`),
    );
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
      void closeView(view);
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
        void closeView(view);
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
  for (const v of [...sessions.values()]) {
    if (v.id !== keep.id) await closeView(v);
  }
  if (sessions.has(keep.id)) setActive(keep);
}

/** 关掉这一条**右侧**的所有标签（顺序就是标签栏顺序） */
async function closeTabsRight(view) {
  const order = [...sessions.values()];
  const at = order.findIndex((v) => v.id === view.id);
  if (at < 0) return;
  for (const v of order.slice(at + 1)) await closeView(v);
}

/** 标签的右键菜单（`TER-001`）。关不掉的项（比如右边没有标签）就不显示数字。 */
function showTabMenu(view, x, y) {
  const order = [...sessions.values()];
  const at = order.findIndex((v) => v.id === view.id);
  const right = at < 0 ? 0 : order.length - at - 1;
  showCtxMenu(x, y, [
    { label: "复制标签", run: () => duplicateTab(view) },
    { label: "重命名…", run: () => renameTab(view) },
    { label: `关闭其他（${order.length - 1}）`, run: () => closeTabsExcept(view) },
    { label: `关闭右侧（${right}）`, run: () => closeTabsRight(view) },
    { label: "关闭全部", run: () => closeAllTabs() },
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
        label: "复制",
        run: () => (hasSel ? copySelection() : setStatus("没有选中内容")),
      },
      { label: "粘贴", run: () => pasteFromClipboard(view) },
      { label: "全选", run: () => view.term.selectAll() },
      { label: "查找…", run: () => openFind() },
      { label: "清屏", run: () => view.term.clear() },
      { label: "左右分屏", run: () => runAction("splitToggle") },
    ],
    "terminal",
  );
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
 * 带死线的 `invoke`。
 *
 * 后端命令卡住时 `await` 永远不返回：界面上表现为「点了没反应」，既不报错也不亮
 * 灯（验收里则是一次莫名其妙的 20 秒超时）。给它一条死线，超时就明确说出来。
 * 注意：超时之后后台**可能**已经把会话建起来了，所以提示里要写清怎么收拾。
 */
function invokeWithTimeout(cmd, args, ms, what) {
  let timer = null;
  return Promise.race([
    invoke(cmd, args).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${what}超时（${Math.round(ms / 1000)} 秒没有响应）`)),
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
  if (active) await closeView(active);
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
            { label: `移动 ${multiSel.size} 项到…`, run: () => moveSelectedSessions() },
            { label: `删除 ${multiSel.size} 项…`, run: () => deleteSelectedSessions() },
          ]
        : [{ label: "移动到…", run: () => moveSession(s) }]),
      { label: "重命名", run: () => renameSession(s) },
      { label: "复制", run: () => duplicateSession(s) },
      { label: "导出", run: () => exportSession(s) },
    ]);
  } else if (folderId) {
    const f = (lastTree?.folders ?? []).find((x) => x.id === folderId);
    if (!f) return;
    showCtxMenu(ev.clientX, ev.clientY, [
      { label: "重命名", run: () => renameFolder(f) },
      { label: "新建子文件夹", run: () => newSubFolder(f.id) },
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
  splitToggle: { label: "左右分屏", chords: ["Ctrl+Shift+S"] },
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
    case "splitToggle":
      document.getElementById("split-toggle").click();
      return true;
    case "closeTab":
      if (!active) return false;
      void closeView(active);
      return true;
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

/** 当前正在编辑的远端文件（验收读它） */
let lastEdit = null;

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
const edTextEl = document.getElementById("ed-text");
const edGutterEl = document.getElementById("ed-gutter");
const edInfoEl = document.getElementById("ed-info");
const edFindEl = document.getElementById("ed-find");
const edReplaceEl = document.getElementById("ed-replace");
const edReEl = document.getElementById("ed-re");

/** 打开的文档（每个一个标签）；`dirty` 表示有未保存修改 */
let edDocs = [];
let edActiveId = null;

function edActive() {
  return edDocs.find((d) => d.id === edActiveId) ?? null;
}

function edSyncBody() {
  const doc = edActive();
  if (!doc) {
    edTextEl.value = "";
    edGutterEl.textContent = "";
    edInfoEl.textContent = "";
    return;
  }
  if (edTextEl.value !== doc.text) edTextEl.value = doc.text;
  const lines = doc.text.split("\n").length;
  edGutterEl.textContent = Array.from({ length: lines }, (_, i) => i + 1).join("\n");
  edInfoEl.textContent = `${lines} 行 · ${doc.text.length} 字${doc.dirty ? " · 未保存" : ""}`;
  edGutterEl.scrollTop = edTextEl.scrollTop;
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
  edTextEl.focus();
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
      const n = await invoke("local_write_text", { path: doc.path, text: doc.text });
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
  const from = dir > 0 ? edTextEl.selectionEnd : 0;
  const text = doc.text;
  const forward = dir > 0 ? text.slice(from) : text;
  re.lastIndex = 0;
  const m = re.exec(forward);
  if (!m) {
    setStatus("没有匹配");
    return;
  }
  const start = (dir > 0 ? from : 0) + m.index;
  edTextEl.focus();
  edTextEl.setSelectionRange(start, start + m[0].length);
  setStatus(`匹配 ${JSON.stringify(m[0])}`);
}

function edReplaceOne() {
  const doc = edActive();
  if (!doc) return;
  const start = edTextEl.selectionStart;
  const end = edTextEl.selectionEnd;
  if (start === end) {
    edFindStep(1);
    return;
  }
  doc.text = doc.text.slice(0, start) + edReplaceEl.value + doc.text.slice(end);
  doc.dirty = true;
  edSyncBody();
  edRenderTabs();
  edTextEl.setSelectionRange(start + edReplaceEl.value.length, start + edReplaceEl.value.length);
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

filesUp.addEventListener("click", () => loadDir(parentPath(sftpPath)));
filesRefresh.addEventListener("click", async () => {
  await loadDir(sftpPath);
  // 目录树也跟着刷：缓存里的子目录可能已经变了（`FIL-001`）。
  // 刷新会把树收回到根层——保留展开状态得记住每条路径，收益不值这个复杂度。
  ftree.clear();
  await initFileTree();
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
  if (e.is_symlink) {
    // 目标放 tooltip，断链单独标色
    label.title = e.broken
      ? `断链：${e.link_target ?? "（读不到目标）"} 不存在`
      : `链接到 ${e.link_target ?? ""}`;
    label.className = e.broken ? "link broken" : "link";
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

filesList.addEventListener("scroll", () => {
  // 滚动事件很密：一帧只重建一次
  if (filesScrollRaf) return;
  filesScrollRaf = requestAnimationFrame(() => {
    filesScrollRaf = 0;
    renderFileList();
  });
});

/** 选中某一行（只改状态，不发请求）。 */
// 改权限位（`FIL-002` 的 `SETSTAT`）。输入用八进制——`chmod 644` 是所有人都会的写法，
// 摆在对话框里点九宫格反而更慢。
filesChmod.addEventListener("click", async () => {
  if (!selectedEntry) return;
  const full = Number.isFinite(selectedEntry.mode) ? selectedEntry.mode : 0o100644;
  // 类型位必须原样带回去：只写权限位、把 S_IFREG 丢了的后果是有服务端把路径当成
  // 未知类型，后续操作全失败。
  const type = full & 0o170000;
  const cur = (full & 0o777).toString(8).padStart(3, "0");
  const ans = await askName(`改权限：${selectedEntry.name}（八进制，如 644）`, cur);
  if (ans === null) return;
  const perm = Number.parseInt(ans, 8);
  if (!Number.isFinite(perm) || perm < 0 || perm > 0o777) {
    setStatus(`权限位要 0~777 的八进制数，收到「${ans}」`);
    return;
  }
  const target = selectedEntry;
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
});

function selectEntry(entry, row) {
  selectedEntry = entry;
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

async function renameEntry() {
  if (!selectedEntry) return;
  const oldName = selectedEntry.name;
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
async function uploadFiles(picked) {
  if (!picked.length) return;
  let done = 0;
  for (const file of picked) {
    setFilesMsg(`上传中… ${file.name}`);
    lastUpload = { name: file.name, total: file.size, last: 0, events: 0 };
    let id = null;
    try {
      const path = joinPath(sftpPath, file.name);
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
      await withDeadline(invoke("sftp_upload_end", { id }), 20000, "结束上传");
      id = null;
      done += 1;
    } catch (e) {
      if (id) await invoke("sftp_upload_abort", { id }).catch(() => {});
      setFilesMsg(`上传 ${file.name} 失败：${e}`);
      return;
    }
  }
  setFilesMsg(`已上传 ${done} 个文件`);
  await loadDir(sftpPath);
}

filesUploadBtn.addEventListener("click", () => filesUpload.click());
filesUpload.addEventListener("change", () => {
  const picked = [...filesUpload.files];
  // 清空，否则同一个文件第二次选不会触发 change
  filesUpload.value = "";
  void uploadFiles(picked);
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

function isDangerous(cmd) {
  return DANGEROUS.some((re) => re.test(cmd));
}

/** 广播目标：当前有连接的所有终端 */
function broadcastTargets() {
  return [...sessions.values()].filter((v) => v.handle && v.running);
}

/** 最近一次广播的结果（验收读它） */
let lastBroadcast = null;

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
    setStatus("没有可广播的会话");
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
    if (!bcBar.hidden) bcInput.focus();
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
const askTitle = document.getElementById("ask-title");
const askBody = document.getElementById("ask-body");
const encodingSelect = document.getElementById("encoding");
const lookThemeSelect = document.getElementById("look-theme");
const lookAutoCopySelect = document.getElementById("look-autocopy");
const lookAutoCopyOnBox = document.getElementById("look-autocopy-on");
const termRightClickSelect = document.getElementById("term-right-click");
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
  lookWordSepInput.value = wordSeparatorExtra;
  lookPasteTrimBox.checked = pasteTrimTrailing;
}

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
const filesColModeBox = document.getElementById("files-col-mode");
const applyFileCols = () => {
  if ((!showSizeCol && filesSortKey === "size") || (!showModeCol && filesSortKey === "mode")) {
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
  ["终端", ["encoding", "look-theme", "theme-import-open", "look-font", "look-scrollback", "term-right-click", "look-word-sep", "look-paste-trim", "look-autocopy-on", "look-autocopy"]],
  ["文件", ["files-auto-open", "files-show-hidden", "files-col-size"]],
  ["安全", ["master-open", "vault-rotate", "known-open"]],
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
  "net-timeout": ["15 秒", false],
  "net-keepalive": ["30 秒", false],
  "net-max-missed": ["3 次", false],
  "term-right-click": ["弹菜单", false],
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
    "dlg.keysTitle": "Keybindings",
  },
};

let uiLang = "zh";

function t(key) {
  return I18N[uiLang]?.[key] ?? I18N.zh[key] ?? key;
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

// 自动化验收接口（`scripts/e2e-desktop.mjs` 用 CDP 读它）。
// 只读、无副作用：靠 DOM 文本反推会话句柄会变成脆弱实现，
// 而「界面可被脚本驱动」本身也是 AI Agent 体验的一部分。
window.__wt = {
  /**
   * 前端脚本版本标记。
   *
   * WebView2 会缓存 `http://tauri.localhost` 下的静态资源，改完前端只重编二进制
   * 时，页面里跑的可能是旧 JS——排查时就会把「旧代码的行为」当成新代码的 bug。
   * 验收先读这个值，对不上就直接判失败，省掉一整类假结论。
   */
  ui: "wt-ui-114",
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
      /** 列目录失败的原因（空串表示这次是成功的） */
      error: filesLoadError,
      /** 当前选中项的名字（验收与脚本用） */
      selected: selectedEntry?.name ?? null,
      /** 最近一次上传的进度快照：`{name,total,last,events}` */
      upload: lastUpload,
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
    };
  },
  /** 正在编辑的远端文件（`FIL-005`）：验收读它 */
  get lastEdit() {
    return lastEdit ? { ...lastEdit } : null;
  },
  /** 最近生成的密钥（`LOC-014`）：验收读它，别去解析对话框里的文本 */
  get lastKey() {
    return lastKey ? { ...lastKey } : null;
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
    if (!active) return "";
    const buf = active.term.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  },
  /** 标签页：每个会话一行，标出哪个是激活的 */
  tabs() {
    return [...sessions.values()].map((v) => ({
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
  filesColSizeBox.checked = showSizeCol;
  filesColModeBox.checked = showModeCol;
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
