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

const statusEl = document.getElementById("status");

if (typeof Terminal !== "function" || typeof FitAddon !== "function") {
  statusEl.textContent = "前端依赖未加载：vendor/xterm.js 或 vendor/addon-fit.js 缺失";
  throw new Error(
    `xterm 加载失败：Terminal=${typeof Terminal} FitAddon=${typeof FitAddon}`,
  );
}

const hostEl = document.getElementById("term");
const openBtn = document.getElementById("open");
const closeBtn = document.getElementById("close");

const term = new Terminal({
  fontFamily: '"JetBrains Mono", Consolas, "Cascadia Mono", monospace',
  fontSize: 13,
  lineHeight: 1.2,
  cursorBlink: true,
  scrollback: 5000,
  theme: {
    background: "#1a1a1c",
    foreground: "#e8e8ea",
    cursor: "#5b9bff",
    selectionBackground: "#2f4f7f",
  },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(hostEl);
fit.fit();

/** @type {string | null} */
let handle = null;
let running = false;
/** 已交给 xterm 但尚未向后端确认的字节数 */
let pending = 0;

/** 攒够这么多未确认字节就先确认一次，减少 IPC 往返 */
const ACK_BATCH = 32 * 1024;
/** 低流量时也定期确认，避免 pending 长期挂账 */
const ACK_INTERVAL = 200;

function setStatus(text) {
  statusEl.textContent = text;
}

function setConnected(on) {
  openBtn.disabled = on;
  closeBtn.disabled = !on;
}

async function ackPending() {
  if (!handle || pending === 0) return;
  const n = pending;
  pending = 0;
  try {
    await invoke("term_ack", { handle, n });
  } catch {
    // 会话已关闭时确认会失败，这是正常收尾路径
  }
}

function frame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

async function pump() {
  while (running && handle) {
    let bytes;
    try {
      const buf = await invoke("term_read", { handle, maxBytes: 65536 });
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
    term.write(bytes, () => {
      pending += n;
      if (pending >= ACK_BATCH) void ackPending();
    });
    await frame();
  }
}

async function openLocal() {
  if (handle) return;
  fit.fit();
  try {
    handle = await invoke("local_open", { cols: term.cols, rows: term.rows });
  } catch (e) {
    setStatus(`打开失败：${e}`);
    return;
  }
  running = true;
  pending = 0;
  term.reset();
  setConnected(true);
  setStatus(`已连接 ${handle.slice(0, 8)}`);
  term.focus();
  pump();
}

async function closeTerm() {
  if (!handle) return;
  running = false;
  await ackPending();
  const h = handle;
  handle = null;
  try {
    await invoke("term_close", { handle: h });
  } catch {
    /* 关闭失败不阻塞界面 */
  }
  pending = 0;
  setConnected(false);
  setStatus("已关闭");
}

// ── 输入 ────────────────────────────────────────────────────
/** xterm 交来的输入事件计数，用于诊断「首字符丢失」这类问题 */
let dataEvents = 0;
/** 最近的输入载荷，诊断用（只留前 64 条，避免无界增长） */
const inputLog = [];

term.onData((data) => {
  if (!handle) return;
  dataEvents += 1;
  if (inputLog.length < 64) inputLog.push(data);
  invoke("term_write", { handle, data }).catch((e) => setStatus(`写入失败：${e}`));
});

term.onResize(({ cols, rows }) => {
  if (!handle) return;
  invoke("term_resize", { handle, cols, rows }).catch(() => {});
});

// 窗口尺寸变化 → 重新计算行列（去抖 100 ms）
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => fit.fit(), 100);
});

// 点击终端区域重新聚焦（点工具栏后焦点会跑到按钮上）
hostEl.addEventListener("mousedown", () => term.focus());

openBtn.addEventListener("click", openLocal);
closeBtn.addEventListener("click", closeTerm);

setInterval(() => void ackPending(), ACK_INTERVAL);

// 自动化验收接口（`scripts/e2e-desktop.mjs` 用 CDP 读它）。
// 只读、无副作用：靠 DOM 文本反推会话句柄会变成脆弱实现，
// 而「界面可被脚本驱动」本身也是 AI Agent 体验的一部分。
window.__wt = {
  get handle() {
    return handle;
  },
  get running() {
    return running;
  },
  get pending() {
    return pending;
  },
  get dataEvents() {
    return dataEvents;
  },
  get inputLog() {
    return inputLog.slice();
  },
  get cols() {
    return term.cols;
  },
  get rows() {
    return term.rows;
  },
  /** 当前屏幕文本（含回滚区），供验收断言用 */
  screen() {
    const buf = term.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  },
};

// 启动自检：把后端是否可达打到状态栏，避免「白屏但不知道哪坏了」
(async () => {
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
