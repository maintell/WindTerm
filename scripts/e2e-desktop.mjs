#!/usr/bin/env node
// WindTerm 桌面端端到端验收。
//
// 不依赖 Playwright / WebDriver / npm 依赖：
//   WebView2 支持 --remote-debugging-port，启动时通过环境变量打开它，
//   然后用 CDP（HTTP 发现 + WebSocket）在页面里执行 JS，像用户一样点击、按键。
//
// 验证的是**真实链路**，而不是「函数能跑」：
//   DOM 事件 → invoke → Tauri command → SessionRegistry → ConPTY → 子进程
//   → 输出 → term_read → 渲染进 DOM
//
// 用法：
//   node scripts/e2e-desktop.mjs
//   WT_DESKTOP_EXE=path/to/wt-desktop.exe WT_E2E_PORT=9333 node scripts/e2e-desktop.mjs

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect as netConnect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const EXE =
  process.env.WT_DESKTOP_EXE ??
  join(root, "target", "debug", isWin ? "wt-desktop.exe" : "wt-desktop");
const PORT = Number(process.env.WT_E2E_PORT ?? 9333);
const BASE = `http://127.0.0.1:${PORT}`;
const WT_EXE =
  process.env.WT_CLI_EXE ?? join(root, "target", "debug", isWin ? "wt.exe" : "wt");

/**
 * 只可能出现在命令**输出**里的标记。
 *
 * 用整行匹配而不是子串匹配：输入回显那一行是 `PS C:\…> echo windtermok`，
 * 单独成行的 `windtermok` 只可能来自命令执行结果。
 */
const MARKER = "windtermok";
const MARKER_CMD = "echo windtermok";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

function die(msg) {
  console.error(`\n错误：${msg}`);
  process.exit(2);
}

// ── 启动应用 ────────────────────────────────────────────────
if (!existsSync(EXE)) {
  die(
    `找不到 ${EXE}\n先执行：cargo build -p wt-desktop --features e2e-mock（界面要验 SSH 需要内建 mock 服务端）`,
  );
}

// 验收用的数据目录必须是干净的：上一轮记下的主机密钥会让 TOFU 分支测不到
const DATA_DIR = join(root, "target", "e2e-data");
rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });
// 下载落点必须可预期：不然断言要去用户的真实下载目录里翻，既脏也没法比对内容
const DOWNLOAD_DIR = join(DATA_DIR, "downloads");

let stderr = "";
let stdout = "";
const child = spawn(EXE, [], {
  env: {
    ...process.env,
    // 由 wt-desktop 在创建 WebView2 时转成 --remote-debugging-port。
    // 不能用 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS：wry 会覆盖它。
    WT_CDP_PORT: String(PORT),
    // 应用内起一台 mock SSH 服务端（仅 e2e-mock feature 编译进来的代码会响应）
    WT_MOCK_SSH: "1",
    WT_DATA_DIR: DATA_DIR,
    WT_DOWNLOAD_DIR: DOWNLOAD_DIR,
    // 打开后端埋点：失败时能直接看到命令停在哪一步，不用再改一遍代码重跑
    WT_TRACE: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stderr?.on("data", (d) => (stderr += d.toString()));
child.stdout?.on("data", (d) => (stdout += d.toString()));
child.on("exit", (code) => {
  if (!closing) die(`应用提前退出（code=${code}）\n${stderr}`);
});

/** mock SSH 服务端监听的端口，由应用打到 stdout */
async function mockSshPort() {
  const m = await waitFor(
    () => {
      const hit = stdout.match(/WT_MOCK_SSH_PORT=(\d+)/);
      return hit ? Number(hit[1]) : null;
    },
    { timeout: 15000, label: "mock SSH 端口" },
  );
  return m;
}

let closing = false;
function cleanup() {
  closing = true;
  try {
    if (isWin) spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
    else child.kill("SIGKILL");
  } catch {
    /* 进程可能已退出 */
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

// ── CDP 客户端 ──────────────────────────────────────────────
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.exceptions = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params?.exceptionDetails;
        this.exceptions.push(d?.exception?.description ?? d?.text ?? "unknown exception");
      }
      if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
        const parts = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? "");
        this.exceptions.push(`console.error: ${parts.join(" ")}`);
      }
    });
  }

  send(method, params = {}, timeoutMs = 20000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** 在页面里求值；异常直接抛出，便于定位是页面错还是断言错。 */
  async eval(expression, { awaitPromise = true } = {}) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description ?? d.text ?? "页面求值异常");
    }
    return r.result?.value;
  }
}

async function waitFor(fn, { timeout = 20000, interval = 100, label = "条件" } = {}) {
  const deadline = Date.now() + timeout;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`等待「${label}」超时（${timeout} ms）${lastErr ? `：${lastErr.message}` : ""}`);
}

async function discover() {
  const res = await fetch(`${BASE}/json/list`, { signal: AbortSignal.timeout(1500) });
  const list = await res.json();
  return list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
}

/**
 * 派发**可信**键盘事件。
 *
 * 不能用 JS 合成的 `KeyboardEvent`：xterm 的键位编码挂在真实 keydown 上，
 * 合成事件进不去，测出来的只是「我们自己的监听器被调用了」。
 *
 * 还必须带 `windowsVirtualKeyCode`——xterm 的 `evaluateKeyboardEvent` 是按
 * `ev.keyCode` 分支的，只给 `text` 时 keyCode 为 0，字符会被丢掉。
 */
const US_LAYOUT = {
  " ": [32, false, "Space"],
  "-": [189, false, "Minus"], "=": [187, false, "Equal"],
  "[": [219, false, "BracketLeft"], "]": [221, false, "BracketRight"],
  "\\": [220, false, "Backslash"], ";": [186, false, "Semicolon"],
  "'": [222, false, "Quote"], ",": [188, false, "Comma"],
  ".": [190, false, "Period"], "/": [191, false, "Slash"],
  "`": [192, false, "Backquote"],
  "!": [49, true, "Digit1"], "@": [50, true, "Digit2"], "#": [51, true, "Digit3"],
  "$": [52, true, "Digit4"], "%": [53, true, "Digit5"], "^": [54, true, "Digit6"],
  "&": [55, true, "Digit7"], "*": [56, true, "Digit8"], "(": [57, true, "Digit9"],
  ")": [48, true, "Digit0"], "_": [189, true, "Minus"], "+": [187, true, "Equal"],
  "{": [219, true, "BracketLeft"], "}": [221, true, "BracketRight"],
  "|": [220, true, "Backslash"], ":": [186, true, "Semicolon"],
  '"': [222, true, "Quote"], "<": [188, true, "Comma"], ">": [190, true, "Period"],
  "?": [191, true, "Slash"], "~": [192, true, "Backquote"],
};

function keyFor(ch) {
  if (/[a-zA-Z]/.test(ch)) {
    return { key: ch, code: `Key${ch.toUpperCase()}`, vk: ch.toUpperCase().charCodeAt(0), shift: false };
  }
  if (/[0-9]/.test(ch)) {
    return { key: ch, code: `Digit${ch}`, vk: ch.charCodeAt(0), shift: false };
  }
  const m = US_LAYOUT[ch];
  if (!m) throw new Error(`typeText 未覆盖字符 ${JSON.stringify(ch)}，请补 US 布局映射`);
  return { key: ch, code: m[2], vk: m[0], shift: m[1] };
}

async function typeText(text) {
  for (const ch of text) {
    const { key, code, vk, shift } = keyFor(ch);
    const base = {
      key,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      modifiers: shift ? 8 : 0,
    };
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      ...base,
      text: ch,
      unmodifiedText: ch,
    });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }
  const enter = {
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...enter });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...enter });
}

/**
 * 用**可信鼠标事件**点击元素（不是 `el.click()`）。
 *
 * 两个原因：`el.click()` 不是用户手势，页面拿不到 user activation；
 * 而 WebView2 在没有用户手势时会吞掉第一个输入事件，导致验收里
 * 「首字符消失」这种假失败。
 */
async function clickElement(selector) {
  const box = await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!box) throw new Error(`找不到元素 ${selector}`);
  await clickAt(box);
}

/** 按可见文本点会话树里的节点（节点没有 id，只能按文本找） */
async function clickSessionNode(name) {
  const box = await cdp.eval(`(() => {
    const el = [...document.querySelectorAll(".node.session")]
      .find((e) => e.textContent === ${JSON.stringify(name)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!box) throw new Error(`会话树里找不到 ${name}`);
  await clickAt(box);
}

async function clickAt(box) {
  const base = { x: box.x, y: box.y, button: "left", clickCount: 1 };
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
}

/**
 * 派发一个带修饰键的组合（可信事件）。
 *
 * `mods` 是 CDP 的位掩码：Alt=1、Ctrl=2、Meta=4、Shift=8。
 * `vk` 必须给对——xterm 按 `keyCode` 分支，给错就变成另一个键了。
 */
async function pressChord(mods, key, code, vk) {
  const base = {
    key,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers: mods,
  };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

/** 在视口坐标处双击（两次按下/抬起，第二次 clickCount=2 才会合成 dblclick）。 */
async function doubleClickAt(box) {
  const base = { x: box.x, y: box.y, button: "left" };
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base, clickCount: 2 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base, clickCount: 2 });
}

/**
 * 起一台本地 echo 服务，充当隧道的「远端目标」。
 *
 * 用 Node 的 TCP 而不是内存对象：`NET-001` 要验的正是「本地 socket ↔ SSH 通道」，
 * 对端是个真 socket 才能验到半关闭与字节计数。
 */
function startEchoTarget() {
  return new Promise((resolve) => {
    const server = createServer((sock) => sock.pipe(sock));
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/** 通过隧道收发一次，返回读回的文本。 */
function tunnelExchange(port, payload) {
  return new Promise((resolve, reject) => {
    const sock = netConnect({ host: "127.0.0.1", port });
    let got = "";
    sock.setTimeout(8000, () => {
      sock.destroy();
      reject(new Error("隧道读写超时"));
    });
    sock.on("connect", () => sock.write(payload));
    sock.on("data", (d) => {
      got += d.toString();
      if (got.length >= payload.length) {
        sock.end();
        resolve(got);
      }
    });
    sock.on("error", reject);
  });
}

/** 端口还能不能连上（验证「停止后真的不再监听」）。 */
function portOpen(port) {
  return new Promise((resolve) => {
    const sock = netConnect({ host: "127.0.0.1", port });
    sock.setTimeout(1500, () => {
      sock.destroy();
      resolve(false);
    });
    sock.on("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
  });
}

/**
 * 双击文件面板里的一行（按名字找）。
 *
 * 必须发两次按下/抬起并把第二次的 `clickCount` 设为 2：Chromium 是靠这个字段
 * 才合成 `dblclick` 的。只发一次 `click` 永远不会触发双击处理器。
 */
async function doubleClickFileRow(name) {
  const box = await cdp.eval(`(() => {
    const row = [...document.querySelectorAll("#files-list .row")].find(
      (r) => r.querySelector("span")?.textContent === ${JSON.stringify(name)},
    );
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!box) throw new Error(`文件面板里找不到 ${name}`);
  const base = { x: box.x, y: box.y, button: "left" };
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base, clickCount: 2 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base, clickCount: 2 });
}

/**
 * 给 `<input type=file>` 塞真实文件路径。
 *
 * 隐藏的 file input 点不出来，也没有别的办法把本地路径交进去——
 * `DOM.setFileInputFiles` 是唯一走真实 change 事件的路径。
 */
async function setFileInput(selector, paths) {
  const { root } = await cdp.send("DOM.getDocument", { depth: 1 });
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  if (!nodeId) throw new Error(`找不到 ${selector}`);
  await cdp.send("DOM.setFileInputFiles", { nodeId, files: paths });
}

/**
 * 往输入框里填值。
 *
 * 走 CDP 的 `Input.insertText`（焦点必须先到位），而不是直接改 `el.value`——
 * 后者绕过了真实的输入路径，测不出「焦点错了填不进去」这类问题。
 */
async function fillInput(selector, text) {
  await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el.focus();
    if (el.select) el.select();
    return true;
  })()`);
  if (text.length > 0) await cdp.send("Input.insertText", { text });
  else await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 });
}

/** 取元素的 DOM nodeId（`DOM.setFileInputFiles` 要它，而 <input type=file> 只能这样喂文件） */
async function nodeIdOf(selector) {
  const { root: domRoot } = await cdp.send("DOM.getDocument", { depth: 0 });
  const { nodeId } = await cdp.send("DOM.querySelector", {
    nodeId: domRoot.nodeId,
    selector,
  });
  if (!nodeId) throw new Error(`找不到元素 ${selector}`);
  return nodeId;
}

/** 直接设值并派发 input 事件：用于「靠 input 事件触发」的控件（过滤、查找） */
async function setInputValue(selector, value) {
  await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el.focus();
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
}

/** 关掉所有标签页（多标签之后，「关闭」只关当前那个） */
async function closeAllTabs() {
  await waitFor(
    async () => {
      const n = await cdp.eval(`window.__wt.tabs().length`);
      if (n === 0) return true;
      await cdp.eval(`document.getElementById("close").click()`);
      await new Promise((r) => setTimeout(r, 300));
      return null;
    },
    { timeout: 20000, label: "关闭所有标签页" },
  );
}

// ── 主流程 ──────────────────────────────────────────────────
let cdp = null;

try {
  // 1. 等 WebView2 把调试端口开起来
  const target = await waitFor(
    async () => {
      const pages = await discover();
      return pages[0] ?? null;
    },
    { timeout: 30000, label: "WebView2 调试端口" },
  );
  check("WebView2 调试端口可用", true, target.url);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error("WebSocket 连接失败")), { once: true });
  });
  cdp = new Cdp(ws);
  await cdp.send("Runtime.enable");
  // WebView2 的窗口没拿到前台焦点时，会偶发吞掉可信鼠标/键盘事件（观察到过一次
  // 「点了按钮没反应」）。让页面始终被当成已聚焦，事件投递才稳定。
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});

  // 2. 页面就绪：DOM 完成 + Tauri 桥接注入
  await waitFor(() => cdp.eval(`document.readyState === "complete"`), { label: "DOM 就绪" });
  const hasBridge = await waitFor(
    () => cdp.eval(`typeof window.__TAURI__?.core?.invoke === "function"`),
    { timeout: 10000, label: "Tauri 桥接" },
  );
  check("页面加载且 Tauri 桥接注入", hasBridge === true);

  // 3. 启动自检：前端主动探一次后端，拿到 IPC_UNKNOWN_HANDLE 说明命令通道通
  const bootStatus = await waitFor(
    async () => {
      const t = await cdp.eval(`document.getElementById("status").textContent`);
      return t.includes("就绪") ? t : null;
    },
    { timeout: 15000, label: "启动自检" },
  );
  check("启动自检拿到后端应答", true, bootStatus);

  // 3b. 页面跑的必须是这次构建的前端脚本。
  // WebView2 会缓存 `http://tauri.localhost` 下的静态资源，改完前端只重编二进制时，
  // 页面可能仍在跑旧 JS——那时所有界面断言测的都是旧代码，结论全是假的。
  // 前端把自己的版本号挂在 `window.__wt.ui` 上，这里对一次。
  const uiVersion = await waitFor(
    () => cdp.eval(`window.__wt?.ui ?? null`),
    { timeout: 10000, label: "前端版本标记" },
  );
  check(
    "前端脚本是本次构建的版本",
    uiVersion === "wt-ui-7",
    `__wt.ui=${uiVersion}`,
  );

  // 3c. 二进制里内嵌的前端资源也是新的。
  // `fetch(..., {cache:"no-store"})` 绕过 WebView 缓存，拿到的是**二进制里**那一份；
  // 与磁盘上的源文件逐字节比对，就能发现「改了 ui/ 但没重新嵌进二进制」这种沉默失效。
  const served = await cdp.eval(`(async () => {
    const src = "http://tauri.localhost/main.js";
    const txt = await (await fetch(src, { cache: "no-store" })).text();
    return txt.length;
  })()`);
  const onDisk = readFileSync(join(root, "apps", "wt-desktop", "ui", "main.js"), "utf8").length;
  check(
    "内嵌前端资源与磁盘上的源文件一致",
    served === onDisk,
    `二进制 ${served} 字节 / 磁盘 ${onDisk} 字节`,
  );

  // 4. 点击「新建本地终端」——可信鼠标点击，走真实事件链
  await clickElement("#open");
  const handle = await cdp.eval(`(async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      const s = document.getElementById("status").textContent;
      if (s.startsWith("已连接")) return s;
      if (s.startsWith("打开失败")) throw new Error(s);
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error("点击后 15s 内状态未变为已连接，当前：" + document.getElementById("status").textContent);
  })()`);
  check("点击「新建本地终端」建立会话", typeof handle === "string" && handle.startsWith("已连接"), handle);

  // 句柄从页面暴露的自动化接口取（DOM 里只有前 8 位，不足以定位会话）
  const h = await cdp.eval(`window.__wt?.handle ?? null`);
  check("界面拿到会话句柄", typeof h === "string" && h.length > 8, h ?? "null");

  // 5. shell 启动横幅（或提示符）渲染进 DOM —— 证明 term_read → 渲染 通了
  const firstPaint = await waitFor(
    async () => {
      const t = await cdp.eval(`window.__wt.screen()`);
      return t && t.trim().length > 0 ? t : null;
    },
    { timeout: 25000, label: "终端首屏输出" },
  );
  check(
    "终端输出渲染进界面",
    true,
    `${firstPaint.length} 字符，首行：${JSON.stringify(firstPaint.split(/\r?\n/)[0].slice(0, 60))}`,
  );

  // 6. 真实键盘输入一条命令：CDP 派发可信 keydown → xterm onData → term_write → PTY
  //    先确认焦点落在终端上（用户点完按钮就能直接打字，不该需要再点一下）
  const focusOnTerm = await cdp.eval(
    `document.activeElement?.className?.includes("xterm-helper-textarea") === true`,
  );
  check("打开后焦点在终端上", focusOnTerm === true);
  // 窗口没被激活过时，浏览器会吞掉第一个按键事件；bringToFront 让它进入正常状态
  await cdp.send("Page.bringToFront");
  await typeText(MARKER_CMD);
  check("键盘输入已发送（可信事件）", true, MARKER_CMD);

  // 7. 命令**输出**出现（标记必须单独成行，输入回显那一行带着提示符，故不能自证）
  const out = await waitFor(
    async () => {
      const t = await cdp.eval(`window.__wt.screen()`);
      return t.split(/\r?\n/).some((line) => line.trim() === MARKER) ? t : null;
    },
    { timeout: 20000, label: "命令输出" },
  );
  check("shell 执行结果回显到界面", true, `累计 ${out.length} 字符`);

  // 8. 统计字段必须是真的（不允许「字段存在但永远报 0」），且前后端行列一致
  const stats = await cdp.eval(
    `window.__TAURI__.core.invoke("term_stats", { handle: ${JSON.stringify(h)} })`,
  );
  const uiCols = await cdp.eval(`window.__wt.cols`);
  check(
    "term_stats 返回真实统计",
    stats && stats.cols >= 20 && stats.rows >= 4 && stats.dropped_bytes === 0,
    `cols=${stats?.cols} rows=${stats?.rows} buffered=${stats?.buffered} unacked=${stats?.unacked} dropped=${stats?.dropped_bytes}`,
  );
  check("前后端行列一致", stats?.cols === uiCols, `后端 ${stats?.cols} / 界面 ${uiCols}`);

  // 9. 确认（ack）真的回流：空闲后未确认字节必须归零
  const settled = await waitFor(
    async () => {
      const s = await cdp.eval(
        `window.__TAURI__.core.invoke("term_stats", { handle: ${JSON.stringify(h)} })`,
      );
      return s.unacked === 0 ? s : null;
    },
    { timeout: 8000, label: "未确认字节归零" },
  );
  check("背压记账归零（ack 已回流）", true, `unacked=0 buffered=${settled.buffered}`);

  // 9b. 终端查找（Ctrl+F）与字号（Ctrl+=）
  const CTRL = 2; // CDP modifiers: Alt=1, Ctrl=2, Meta=4, Shift=8
  const ctrlKey = (k, code, vk) => ({
    key: k,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers: CTRL,
  });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...ctrlKey("f", "KeyF", 70) });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...ctrlKey("f", "KeyF", 70) });
  await waitFor(
    async () => (await cdp.eval(`document.getElementById("find-bar").hidden`)) === false,
    { timeout: 5000, label: "查找栏打开" },
  );
  check("Ctrl+F 打开查找栏", true);

  // 查找框的触发是 input 事件：这里显式派发，避免依赖 insertText 是否合成事件
  await cdp.eval(`(() => {
    const el = document.getElementById("find-input");
    el.focus();
    el.value = ${JSON.stringify(MARKER)};
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  const findResult = await waitFor(
    async () => {
      const r = await cdp.eval(`window.__wt.find(${JSON.stringify(MARKER)})`);
      const t = await cdp.eval(`document.getElementById("find-count").textContent`);
      const m = t.match(/^(\d+)\/(\d+)$/);
      return r?.found && m && Number(m[2]) >= 1 ? { ...r, text: t } : null;
    },
    { timeout: 10000, label: "查找命中" },
  );
  check("查找能命中终端输出", findResult.found === true, findResult.text);

  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await waitFor(
    async () => (await cdp.eval(`document.getElementById("find-bar").hidden`)) === true,
    { timeout: 5000, label: "查找栏关闭" },
  );

  const fontBefore = await cdp.eval(`window.__wt.fontSize`);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...ctrlKey("=", "Equal", 187) });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...ctrlKey("=", "Equal", 187) });
  const fontAfter = await waitFor(
    async () => {
      const s = await cdp.eval(`window.__wt.fontSize`);
      return s > fontBefore ? s : null;
    },
    { timeout: 5000, label: "字号放大" },
  );
  check("Ctrl+= 放大字号", fontAfter === fontBefore + 1, `${fontBefore} → ${fontAfter}`);

  // 9c. 剪贴板（TER-011 / TER-013）
  // 先往屏幕上打一段「有分隔符歧义」的串：规格里「默认分隔符含 /」与 AC-1
  //「双击要选全 user@host:/var/log」互相矛盾，这条断言把结论钉在 AC-1 上。
  await typeText("echo user@host:/var/log");
  const wordPoint = await waitFor(
    () => cdp.eval(`window.__wt.textPoint("user@host:/var/log")`),
    { timeout: 10000, label: "屏幕上出现待选文本" },
  );

  // 先关掉「选中即复制」，否则下面的复制断言会被自动复制掩盖（测了个寂寞）
  await cdp.eval(`(window.__wt.autoCopy = false)`);
  await cdp.eval(`navigator.clipboard.writeText("")`);
  await doubleClickAt(wordPoint);
  const selected = await waitFor(
    async () => (await cdp.eval(`window.__wt.selection()`)) || null,
    { timeout: 5000, label: "双击选词" },
  );
  check(
    "双击选中含 / 和 @ 的整串（AC-1）",
    selected === "user@host:/var/log",
    JSON.stringify(selected),
  );

  // Ctrl+Shift+C：modifiers 位掩码 Ctrl=2 | Shift=8。
  // 断言读状态栏而不是把剪贴板读回来：WebView2 里 `navigator.clipboard.readText()`
  // 要真实用户激活才放行，脚本回读会假失败；而「已复制 N 字符」只在 writeText
  // 真正成功之后才出现，是可用的成功信号（失败会显示原因）。
  await pressChord(2 | 8, "C", "KeyC", 67);
  const copyStatus = await waitFor(
    async () => {
      const s = await cdp.eval(`document.getElementById("status").textContent`);
      return s.startsWith("已复制") || s.includes("失败") || s.includes("没有选中") ? s : null;
    },
    { timeout: 5000, label: "复制反馈" },
  );
  check(
    "Ctrl+Shift+C 把选区写进剪贴板",
    copyStatus === "已复制 18 字符",
    copyStatus,
  );

  // Ctrl+Shift+V：单行不弹确认；末尾带 \r 让它粘贴后直接执行。
  // 合成按键偶发被吞（WebView2 的已知行为），所以最多补发 3 次，
  // 判据是 `pasteCount` 涨了——这比「屏幕上有没有出现」更早、更确定。
  await cdp.eval(`navigator.clipboard.writeText("echo pasted-ok\\r")`);
  const logBefore = await cdp.eval(`window.__wt.inputLog.length`);
  const pasteBefore = await cdp.eval(`window.__wt.pasteCount`);
  let pasted = false;
  for (let i = 0; i < 3 && !pasted; i += 1) {
    await pressChord(2 | 8, "V", "KeyV", 86);
    pasted = await waitFor(
      async () => {
        const n = await cdp.eval(`window.__wt.pasteCount`);
        return n > pasteBefore ? true : null;
      },
      { timeout: 3000, label: "粘贴动作生效" },
    ).catch(() => null);
  }
  const executed = await waitFor(
    async () => {
      const screen = await cdp.eval(`window.__wt.screen()`);
      // 出现两次：一次是粘贴进来的命令行，一次是执行结果
      return screen.split("pasted-ok").length > 2 ? true : null;
    },
    { timeout: 15000, label: "粘贴内容被执行" },
  ).catch(() => null);
  check("Ctrl+Shift+V 把剪贴板送进终端", executed === true, `pasteCount 涨到 ${pasted}`);

  // 粘贴不能把 ^V 当控制字符漏给远端：那会让 shell 收到一个 0x16
  const leaked = await cdp.eval(`window.__wt.inputLog.slice(${logBefore})`);
  check(
    "粘贴没有把 ^V 漏给终端",
    !leaked.some((s) => s === "\u0016"),
    JSON.stringify(leaked),
  );

  // 多行粘贴必须确认；取消后一个字节都不能发出去（AC-3）
  const beforePaste = await cdp.eval(
    `({ n: window.__wt.pasteCount, log: window.__wt.inputLog.length })`,
  );
  const manyLines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n");
  await cdp.eval(`navigator.clipboard.writeText(${JSON.stringify(manyLines)})`);
  await pressChord(2 | 8, "V", "KeyV", 86);
  await waitFor(
    async () => (await cdp.eval(`window.__wt.pasteDialogOpen`)) === true,
    { timeout: 5000, label: "多行粘贴确认框" },
  );
  await clickElement("#paste-cancel");
  const afterPaste = await cdp.eval(
    `({ n: window.__wt.pasteCount, log: window.__wt.inputLog.length, open: window.__wt.pasteDialogOpen })`,
  );
  check(
    "多行粘贴弹确认，取消后零字节发出（AC-3）",
    afterPaste.n === beforePaste.n &&
      afterPaste.log === beforePaste.log &&
      afterPaste.open === false,
    `pasteCount ${beforePaste.n}→${afterPaste.n}，inputLog ${beforePaste.log}→${afterPaste.log}`,
  );

  // 恢复「选中即复制」并验证它真的写了剪贴板（默认行为，不能被静默关掉）
  await cdp.eval(`(window.__wt.autoCopy = true)`);
  const autoBefore = await cdp.eval(`window.__wt.autoCopyCount`);
  await doubleClickAt(wordPoint);
  const autoCopied = await waitFor(
    async () => {
      const n = await cdp.eval(`window.__wt.autoCopyCount`);
      return n > autoBefore ? n : null;
    },
    { timeout: 5000, label: "自动复制" },
  ).catch(() => null);
  check(
    "选中即复制（默认开启）",
    autoCopied !== null,
    `autoCopyCount ${autoBefore} → ${autoCopied}`,
  );

  // 右键粘贴（H:rightclick-paste）。它走 `navigator.clipboard.readText()`，
  // 这条 API 要用户激活才放行——用可信右键验证它在真实手势下到底通不通，
  // 不通就把原因如实报出来，而不是留一个「点了没反应」。
  await cdp.eval(`navigator.clipboard.writeText("echo right-paste\\r")`);
  const rb = { x: wordPoint.x, y: wordPoint.y, button: "right", clickCount: 1 };
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...rb });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...rb });
  const rightStatus = await waitFor(
    async () => {
      const s = await cdp.eval(`document.getElementById("status").textContent`);
      return /^(已粘贴|读剪贴板)/.test(s) ? s : null;
    },
    { timeout: 8000, label: "右键粘贴反馈" },
  );
  // 断言的是「一定有明确反馈」，而不是「一定粘贴成功」：
  // WebView2 里 `navigator.clipboard.readText()` 要剪贴板读权限，当前构建拿不到，
  // 右键只能退化。这一条守住的是「点了不能没反应」——成功与不可用都必须说出来。
  // 拿到剪贴板读权限后（见 README 的 G11），这里应当收紧成「已粘贴」。
  check(
    "右键粘贴有明确反馈（成功或说明为何不可用）",
    /^(已粘贴|读剪贴板)/.test(rightStatus),
    rightStatus,
  );

  // 10. 尺寸变化 → 重新 fit → 后端收到 resize（TER-012）
  //     CDP 造不出真正的窗口拖拽，这里改侧栏宽度让终端变窄，再派发 resize 事件，
  //     走的是与真实拖拽完全相同的处理链路（window resize → fit() → term_resize）
  const resized = await cdp.eval(`(async () => {
    const st = () => window.__TAURI__.core.invoke("term_stats", { handle: ${JSON.stringify(h)} });
    const tree = document.getElementById("tree");
    const before = (await st()).cols;
    tree.style.width = "460px";
    window.dispatchEvent(new Event("resize"));
    await new Promise(r => setTimeout(r, 600));
    const after = (await st()).cols;
    tree.style.width = "190px";
    window.dispatchEvent(new Event("resize"));
    return { before, after };
  })()`);
  check(
    "界面尺寸变化传播到 PTY",
    resized && resized.after < resized.before && resized.after >= 20,
    `${resized?.before} → ${resized?.after} 列`,
  );

  // 11. 关闭：句柄必须失效（不能留下僵尸会话）
  await clickElement("#close");
  const closed = await cdp.eval(`(async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 10000) {
      const s = document.getElementById("status").textContent;
      if (s === "已关闭") {
        try {
          await window.__TAURI__.core.invoke("term_read", { handle: ${JSON.stringify(h)}, maxBytes: 16 });
          return { status: s, stale: "still-alive" };
        } catch (e) {
          return { status: s, stale: String(e) };
        }
      }
      await new Promise(r => setTimeout(r, 50));
    }
    return { status: document.getElementById("status").textContent, stale: "timeout" };
  })()`);
  check(
    "关闭后句柄失效",
    closed?.status === "已关闭" && closed.stale.includes("IPC_UNKNOWN_HANDLE"),
    `${closed?.status} / ${closed?.stale}`,
  );

  // 11b. 多标签：同时开两个会话，各自独立
  await clickElement("#open");
  await waitFor(
    async () => {
      const n = await cdp.eval(`document.querySelectorAll("#tabs .tab").length`);
      return n === 1 ? n : null;
    },
    { timeout: 20000, label: "第一个标签页" },
  );
  await clickElement("#open");
  const twoTabs = await waitFor(
    async () => {
      const state = await cdp.eval(
        `({ dom: document.querySelectorAll("#tabs .tab").length, tabs: window.__wt.tabs() })`,
      );
      return state.dom === 2 && state.tabs.length === 2 ? state : null;
    },
    { timeout: 20000, label: "第二个标签页" },
  );
  check(
    "能同时开多个会话（标签页）",
    twoTabs.dom === 2 && twoTabs.tabs.filter((t) => t.active).length === 1,
    twoTabs.tabs.map((t) => `${t.label}${t.active ? "*" : ""}`).join(" | "),
  );

  // 切回第一个标签：内容必须还在（说明是隐藏而不是重建）
  const firstHandle = twoTabs.tabs[0].handle;
  await cdp.eval(`document.querySelectorAll("#tabs .tab")[0].click()`);
  const switched = await waitFor(
    async () => {
      const state = await cdp.eval(
        `({ handle: window.__wt.handle, screen: window.__wt.screen() })`,
      );
      return state.handle === firstHandle && state.screen.trim().length > 0 ? state : null;
    },
    { timeout: 10000, label: "切回第一个标签" },
  );
  check(
    "切回标签页时内容还在（不是重建）",
    switched.screen.includes("PS "),
    switched.screen.split(/\r?\n/)[0].slice(0, 40),
  );

  // 关掉一个，另一个必须还在
  await clickElement("#close");
  const oneLeft = await waitFor(
    async () => {
      const t = await cdp.eval(`window.__wt.tabs()`);
      return t.length === 1 ? t : null;
    },
    { timeout: 10000, label: "关闭一个标签" },
  );
  check("关掉一个标签不会带走另一个", oneLeft.length === 1, oneLeft[0].label);
  await clickElement("#close");
  await waitFor(
    async () => {
      const t = await cdp.eval(`window.__wt.tabs()`);
      return t.length === 0 ? t : null;
    },
    { timeout: 10000, label: "关闭最后一个标签" },
  );

  // ── SSH：用应用内建的 mock 服务端验证整条链路 ──────────────
  const sshPort = await mockSshPort();
  check("应用内 mock SSH 服务端已启动", sshPort > 0, `127.0.0.1:${sshPort}`);

  // 12. 用 CLI 从 MobaXterm ini 导入一条会话，界面刷新后应能看到它
  const iniPath = join(DATA_DIR, "MobaXterm.ini");
  writeFileSync(
    iniPath,
    [
      "[Bookmarks]",
      "SubRep=Lab\\",
      "BookmarkName=mock-ssh",
      "Host=127.0.0.1",
      `Port=${sshPort}`,
      "UserName=tester",
      "Protocol=0",
      "",
    ].join("\r\n"),
  );
  const dbPath = join(DATA_DIR, "data.db");
  if (!existsSync(WT_EXE)) die(`找不到 ${WT_EXE}，先执行 cargo build -p wt-cli`);
  const imported = spawnSync(
    WT_EXE,
    ["session", "import", "--file", iniPath, "--db", dbPath],
    { encoding: "utf8" },
  );
  check(
    "wt session import 导入成功",
    imported.status === 0,
    (imported.stdout || imported.stderr || "").trim().split("\n")[0],
  );

  await clickElement("#refresh");
  const listed = await waitFor(
    async () => {
      const names = await cdp.eval(`window.__wt.sessions()`);
      return names.includes("mock-ssh") ? names : null;
    },
    { timeout: 10000, label: "会话树刷新" },
  );
  check("会话树显示导入的会话", true, listed.join("、"));

  // 12b. 界面里的「导入」按钮：选文件 → 解析 → 落库 → 自动刷新树
  //      用第二个 ini（会话名不同），既验证 UI 导入，又不和上面 CLI 导入的那条打架
  const ini2 = join(DATA_DIR, "MobaXterm-ui.ini");
  writeFileSync(
    ini2,
    [
      "[Bookmarks]",
      "SubRep=Lab\\",
      "BookmarkName=ui-imported",
      "Host=127.0.0.1",
      `Port=${sshPort}`,
      "UserName=tester",
      "Protocol=0",
      "",
    ].join("\r\n"),
  );
  const importFileNode = await nodeIdOf("#import-file");
  await cdp.send("DOM.setFileInputFiles", { nodeId: importFileNode, files: [ini2] });
  const afterUiImport = await waitFor(
    async () => {
      const names = await cdp.eval(`window.__wt.sessions()`);
      return names.includes("ui-imported") ? names : null;
    },
    { timeout: 15000, label: "界面导入" },
  );
  const msg = await cdp.eval(`document.getElementById("tree-msg").textContent`);
  check(
    "界面「导入」按钮可用（选文件即落库并刷新树）",
    afterUiImport.includes("ui-imported") && msg.includes("导入完成"),
    msg.split("\n")[0],
  );

  // 12c. 再导一次同一份文件：应全部判重，树里不出现第二份
  await cdp.send("DOM.setFileInputFiles", { nodeId: importFileNode, files: [ini2] });
  const dupMsg = await waitFor(
    async () => {
      const t = await cdp.eval(`document.getElementById("tree-msg").textContent`);
      return t.includes("已跳过") ? t : null;
    },
    { timeout: 15000, label: "重复导入判重" },
  );
  const namesAfterDup = await cdp.eval(`window.__wt.sessions()`);
  check(
    "重复导入被判定为重复而不是新增",
    namesAfterDup.filter((n) => n === "ui-imported").length === 1 &&
      dupMsg.includes("ui-imported"),
    dupMsg.split("\n").slice(0, 2).join(" / "),
  );

  // 12d. GBK 编码的 ini（中文 Windows 上 MobaXterm 的默认写法）：中文名必须可读，
  //      不能变成 �。「生产」的 GBK 字节是 C9 FA B2 FA。
  const gbkIni = join(DATA_DIR, "MobaXterm-gbk.ini");
  const shengChan = Buffer.from([0xc9, 0xfa, 0xb2, 0xfa]);
  writeFileSync(
    gbkIni,
    Buffer.concat([
      Buffer.from("[Bookmarks]\r\nSubRep=", "ascii"),
      shengChan,
      Buffer.from("\\\r\nBookmarkName=", "ascii"),
      shengChan,
      Buffer.from(
        `-gbk\r\nHost=127.0.0.1\r\nPort=${sshPort}\r\nUserName=tester\r\nProtocol=0\r\n`,
        "ascii",
      ),
    ]),
  );
  await cdp.send("DOM.setFileInputFiles", { nodeId: importFileNode, files: [gbkIni] });
  const gbkNames = await waitFor(
    async () => {
      const names = await cdp.eval(`window.__wt.sessions()`);
      return names.some((n) => n.includes("-gbk")) ? names : null;
    },
    { timeout: 15000, label: "GBK ini 导入" },
  );
  const gbkMsg = await cdp.eval(`document.getElementById("tree-msg").textContent`);
  check(
    "GBK 编码的 ini 中文名可读（不变成乱码）",
    gbkNames.includes("生产-gbk") && gbkMsg.includes("按 gbk 解码"),
    `${gbkNames.filter((n) => n.includes("-gbk")).join("、")} / ${gbkMsg.split("\n")[1] ?? ""}`,
  );

  // 12e. 会话的新建与删除（不依赖导入，用户自己加一条）
  await fillInput("#session-name", "手动会话");
  await fillInput("#host", "127.0.0.1");
  await fillInput("#port", String(sshPort));
  await fillInput("#user", "tester");
  await clickElement("#save-session");
  const created = await waitFor(
    async () => {
      const names = await cdp.eval(`window.__wt.sessions()`);
      return names.includes("手动会话") ? names : null;
    },
    { timeout: 10000, label: "保存新会话" },
  );
  check("界面上能新建会话", true, created.join("、"));

  await clickSessionNode("手动会话");
  const refilledName = await cdp.eval(`document.getElementById("session-name").value`);
  check("选中会话时名称也被填回", refilledName === "手动会话", refilledName);

  // 删除是两步：第一次点只变成「确认删除」，第二次才真的删
  await clickElement("#delete-session");
  const armed = await cdp.eval(`document.getElementById("delete-session").textContent`);
  await clickElement("#delete-session");
  const afterDelete = await waitFor(
    async () => {
      const names = await cdp.eval(`window.__wt.sessions()`);
      return names.includes("手动会话") ? null : names;
    },
    { timeout: 10000, label: "删除会话" },
  );
  check(
    "删除要二次确认，确认后从库里消失",
    armed === "确认删除" && !afterDelete.includes("手动会话"),
    `第一次点击后按钮文案：${armed}`,
  );

  // 12f. 会话树过滤：多会话之后靠它找东西
  const allSessions = await cdp.eval(`window.__wt.sessions()`);
  await setInputValue("#tree-filter", "mock");
  const filtered = await waitFor(
    async () => {
      const names = await cdp.eval(`window.__wt.sessions()`);
      return names.length === 1 && names[0] === "mock-ssh" ? names : null;
    },
    { timeout: 5000, label: "会话树过滤" },
  );
  check("会话树能按名字过滤", true, `${allSessions.length} → ${filtered.join("、")}`);

  await setInputValue("#tree-filter", "绝不存在的名字");
  const noMatch = await waitFor(
    async () => {
      const names = await cdp.eval(`window.__wt.sessions()`);
      const empty = await cdp.eval(`document.getElementById("tree-empty")?.textContent ?? ""`);
      return names.length === 0 && empty.includes("没有匹配") ? empty : null;
    },
    { timeout: 5000, label: "过滤无匹配" },
  );
  await setInputValue("#tree-filter", "");
  const restored = await waitFor(
    async () => {
      const names = await cdp.eval(`window.__wt.sessions()`);
      return names.length === allSessions.length ? names : null;
    },
    { timeout: 5000, label: "清空过滤" },
  );
  check(
    "过滤无匹配时给出提示，清空后恢复",
    noMatch.includes("没有匹配") && restored.length === allSessions.length,
    `${restored.length} 条恢复`,
  );

  // 13. 点会话 → 连接参数自动填好（密码不存库，仍要手填）
  await clickSessionNode("mock-ssh");
  const filled = await cdp.eval(`({
    host: document.getElementById("host").value,
    port: document.getElementById("port").value,
    user: document.getElementById("user").value,
    focus: document.activeElement?.id ?? "",
  })`);
  check(
    "点会话自动填好主机/端口/用户名",
    filled.host === "127.0.0.1" &&
      filled.port === String(sshPort) &&
      filled.user === "tester",
    JSON.stringify(filled),
  );
  check("焦点落在密码框", filled.focus === "password", filled.focus);

  // 14. 首次连接：TOFU 应记住主机密钥
  await fillInput("#password", "secret");
  await clickElement("#ssh");
  const sshStatus = await waitFor(
    async () => {
      const s = await cdp.eval(`document.getElementById("status").textContent`);
      if (s.startsWith("已连接")) return s;
      if (s === "连接失败") {
        const scr = await cdp.eval(`window.__wt.screen()`);
        throw new Error(`SSH 连接失败：${scr.split(/\r?\n/).filter(Boolean).slice(-3).join(" | ")}`);
      }
      return null;
    },
    { timeout: 30000, label: "SSH 连接" },
  );
  check(
    "SSH 首次连接成功并记录主机密钥",
    sshStatus.includes("tester@127.0.0.1") && sshStatus.includes("已记录主机密钥"),
    sshStatus,
  );

  // 15. 在 SSH 通道里输入：mock 先送 WELCOME 横幅，之后把收到的每个数据帧回显成 `echo:<data>`
  //     （逐键发送 → 逐键回显，所以断言用「有序序列」而不是整串）
  await typeText("hello");
  const sshOut = await waitFor(
    async () => {
      const t = await cdp.eval(`window.__wt.screen()`);
      const echoed =
        /echo:h[\s\S]*?echo:e[\s\S]*?echo:l[\s\S]*?echo:l[\s\S]*?echo:o/.test(t);
      return t.includes("WELCOME") && echoed ? t : null;
    },
    { timeout: 15000, label: "SSH 回显" },
  );
  check(
    "SSH 通道双向通（服务端横幅 + 逐键回显）",
    true,
    `累计 ${sshOut.length} 字符`,
  );

  // 15b. bracketed paste（TER-023）：远端开启 ?2004 后，粘贴必须被 \e[200~ 包裹。
  //      自己再包一层就会双重包裹；完全不包则 vim 里会触发自动缩进。
  //      mock 收到含 "bracketed" 的输入就会发 \e[?2004h，所以这一步是可控的。
  await typeText("bracketed");
  // 客户端是逐键发的，服务端要累积才认得出整词；这里等 `?2004` 真的生效
  await waitFor(
    async () => (await cdp.eval(`window.__wt.bracketedPaste`)) === true,
    { timeout: 15000, label: "远端开启 bracketed paste" },
  );
  await cdp.eval(`navigator.clipboard.writeText("xyz")`);
  await pressChord(2 | 8, "V", "KeyV", 86);
  const bracketed = await waitFor(
    async () => {
      const log = await cdp.eval(`window.__wt.inputLog`);
      return log.some((s) => s.includes("\x1b[200~") && s.includes("\x1b[201~")) ? true : null;
    },
    { timeout: 10000, label: "粘贴被 bracketed 包裹" },
  ).catch(() => null);
  check("远端要求 bracketed paste 时粘贴被 \\e[200~/\\e[201~ 包裹", bracketed === true);

  // 16. 关闭后重连：主机密钥已在 known_hosts 里，不该再报「已记录」
  await closeAllTabs();
  await clickElement("#ssh");
  const secondStatus = await waitFor(
    async () => {
      const s = await cdp.eval(`document.getElementById("status").textContent`);
      return s.startsWith("已连接") || s === "连接失败" ? s : null;
    },
    { timeout: 30000, label: "SSH 重连" },
  );
  check(
    "重连不再重复记录主机密钥（known_hosts 已持久化）",
    secondStatus.startsWith("已连接") && !secondStatus.includes("已记录主机密钥"),
    secondStatus,
  );

  // known_hosts 必须真的落盘，而不是只存在内存里
  const khPath = join(DATA_DIR, "known_hosts");
  const khText = existsSync(khPath) ? readFileSync(khPath, "utf8") : "";
  check(
    "known_hosts 已写入磁盘",
    khText.includes("127.0.0.1") && khText.includes("ssh-ed25519"),
    `${khPath}（${khText.split("\n").filter(Boolean).length} 条）`,
  );

  // 16b. 文件面板：列远端目录
  const seed = Buffer.from("hello from server").toString("base64");
  await cdp.eval(
    `window.__TAURI__.core.invoke("mock_seed_file", { path: "/notes.txt", content: ${JSON.stringify(seed)} })`,
  );
  await clickElement("#files-toggle");
  // 页面活性自检：定时器与 rAF 还在跑吗？
  // 「命令跑完但界面不动」有两种完全不同的原因——后端没返回，或者页面任务队列被占死。
  // 前者要查 IPC，后者要查泵循环。这条自检把两者分开，省掉一整轮瞎猜。
  await cdp.eval(`(() => {
    window.__live = { st: null, raf: null, t0: Date.now() };
    setTimeout(() => (window.__live.st = Date.now() - window.__live.t0), 0);
    requestAnimationFrame(() => (window.__live.raf = Date.now() - window.__live.t0));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 1200));
  const live = await cdp.eval(`({ ...window.__live, ui: window.__wt?.ui })`);
  check(
    "有终端会话时页面定时器与 rAF 仍在跑",
    live.st !== null && live.raf !== null,
    `setTimeout=${live.st}ms rAF=${live.raf}ms ui=${live.ui}`,
  );

  // 断言读 `__wt.files` 而不是逐项 DOM 文本，失败时把真实 rows/msg 打出来。
  // 踩过：原来在轮询里对「msg 非空」抛错，超时后报的是**第一次**轮询的
  // 「读取中…」，于是「列目录成功但断言条件不对」被误判成「后端挂起」。
  const files = await waitFor(
    async () => {
      const f = await cdp.eval(`window.__wt?.files ?? null`);
      if (!f) throw new Error("文件面板状态不可读（__wt.files 缺失）");
      return f.rows.length ? f : null;
    },
    { timeout: 20000, label: "文件面板列目录" },
  );
  check(
    "文件面板能列出远端文件",
    files.rows.includes("notes.txt"),
    `rows=${files.rows.join("、")} msg=${files.msg || "(空)"}`,
  );
  check(
    "远端文件的类型来自服务端属性（文件不带斜杠）",
    !files.rows.some((r) => r.endsWith("/")),
    files.rows.join("、"),
  );

  // 16c. 双击下载：文件必须真的落到本地，内容与远端一致
  await doubleClickFileRow("notes.txt");
  const savedMsg = await waitFor(
    async () => {
      const f = await cdp.eval(`window.__wt.files`);
      return f.msg.startsWith("已保存") ? f.msg : null;
    },
    { timeout: 20000, label: "下载完成" },
  );
  const first = join(DOWNLOAD_DIR, "notes.txt");
  const firstText = existsSync(first) ? readFileSync(first, "utf8") : null;
  check(
    "双击把远端文件下载到本地且内容一致",
    firstText === "hello from server",
    `落点 ${first} 内容=${JSON.stringify(firstText)}`,
  );

  // 再下一次：同名文件不能被覆盖（覆盖就是数据丢失）。
  // 先停一下：Chromium 会把同一位置的快速连击累加成 detail=3/4，那样根本不会再出
  // `dblclick`——两次双击挨太近，测出来的会是「第二次没反应」这种假失败。
  await new Promise((r) => setTimeout(r, 700));
  const before = await cdp.eval(`window.__wt.files.msg`);
  await doubleClickFileRow("notes.txt");
  const secondMsg = await waitFor(
    async () => {
      const m = await cdp.eval(`window.__wt.files.msg`);
      return m !== before && m.startsWith("已保存") ? m : null;
    },
    { timeout: 20000, label: "第二次下载完成" },
  ).catch(async () => `未完成，面板=${await cdp.eval(`window.__wt.files.msg`)}`);
  // 不钉死改名格式（`notes (1).txt` 还是 `notes-1.txt` 属于实现细节），
  // 要断言的是**语义**：多出一个文件，且原来那份没被覆盖。
  const downloaded = existsSync(DOWNLOAD_DIR) ? readdirSync(DOWNLOAD_DIR) : [];
  check(
    "同名下载自动改名而不覆盖",
    downloaded.length === 2 &&
      readFileSync(join(DOWNLOAD_DIR, "notes.txt"), "utf8") === "hello from server",
    `目录=[${downloaded.join("、")}]；面板=${secondMsg}`,
  );

  // 16d. 上传：选一个本地文件，远端列表要出现它
  const localUp = join(DATA_DIR, "upload.txt");
  writeFileSync(localUp, "uploaded from ui");
  await setFileInput("#files-upload", [localUp]);
  const uploaded = await waitFor(
    async () => {
      const f = await cdp.eval(`window.__wt.files`);
      return f.rows.includes("upload.txt") ? f.rows : null;
    },
    { timeout: 20000, label: "上传后刷新列表" },
  );
  check("上传本地文件后远端列表出现它", true, uploaded.join("、"));

  await clickElement("#files-toggle");

  // 16e. 隧道（NET-001 / NET-004）：启动 → 经隧道收发 → 统计 → 停止
  const echo = await startEchoTarget();
  await clickElement("#tunnels-toggle");
  await cdp.eval(`(() => {
    document.getElementById("tunnel-listen").value = "0";
    document.getElementById("tunnel-target").value = ${JSON.stringify(`127.0.0.1:${echo.port}`)};
    document.getElementById("tunnel-lan").checked = false;
    return true;
  })()`);
  await clickElement("#tunnel-add");
  const started = await waitFor(
    async () => {
      const list = await cdp.eval(`window.__wt.tunnels`);
      return list.length === 1 ? list[0] : null;
    },
    { timeout: 30000, label: "隧道启动" },
  ).catch(async (e) => {
    const dbg = await cdp.eval(`({
      msg: window.__wt.tunnelMsg,
      hidden: document.getElementById("tunnels").hidden,
      host: document.getElementById("host").value,
      user: document.getElementById("user").value,
      listen: document.getElementById("tunnel-listen").value,
      target: document.getElementById("tunnel-target").value,
      list: window.__wt.tunnels.length,
    })`);
    throw new Error(`${e.message}；${JSON.stringify(dbg)}`);
  });
  // AC-2：listenPort=0 必须回填真实端口，而不是把 0 原样显示出来
  const listenPort = Number(String(started.listen).split(":").pop());
  check(
    "隧道启动并回填系统分配的端口（AC-2）",
    listenPort > 0 && started.kind === "L" && started.target === `127.0.0.1:${echo.port}`,
    `${started.kind} ${started.listen} → ${started.target}`,
  );

  // AC-1：经隧道传的字节必须原样回来
  const echoed = await tunnelExchange(listenPort, "tunnel-ok").catch((e) => `失败：${e.message}`);
  check("经隧道穿过的字节原样返回（AC-1）", echoed === "tunnel-ok", JSON.stringify(echoed));

  // AC-5：连接数与字节数要跟上
  const tunStats = await waitFor(
    async () => {
      const list = await cdp.eval(`window.__wt.tunnels`);
      const t = list[0];
      return t && t.total >= 1 && t.up_bytes >= 9 ? t : null;
    },
    { timeout: 10000, label: "隧道统计更新" },
  ).catch(() => null);
  check(
    "隧道统计反映真实连接与字节（AC-5）",
    tunStats !== null,
    tunStats
      ? `连接 ${tunStats.total} · ↑${tunStats.up_bytes} ↓${tunStats.down_bytes}`
      : "统计未更新",
  );

  // 停止后必须真的不再监听，否则留下一个幽灵端口
  await clickElement("#tunnel-list .tunnel button");
  const stopped = await waitFor(
    async () => ((await cdp.eval(`window.__wt.tunnels`)).length === 0 ? true : null),
    { timeout: 15000, label: "隧道停止" },
  ).catch(() => null);
  check("停止后隧道从列表消失", stopped === true);
  check("停止后端口不再监听", (await portOpen(listenPort)) === false, `端口 ${listenPort}`);

  // 局域网监听不确认就必须被挡住（NET-001 行为规格第 1 条）
  const lanGuard = await cdp.eval(`window.__TAURI__.core.invoke("tunnel_start", {
    arg: { host: "127.0.0.1", port: ${sshPort}, user: "tester", password: "secret",
           keyPem: null, keyPassphrase: null, useAgent: false, cols: 80, rows: 24,
           listenHost: "0.0.0.0", listenPort: 0,
           targetHost: "127.0.0.1", targetPort: ${echo.port}, allowLan: false },
  }).then(() => "没有拦住", (e) => String(e))`);
  check(
    "监听 0.0.0.0 未确认时被挡住",
    /TUN_LAN_CONFIRM_REQUIRED/.test(lanGuard),
    lanGuard,
  );

  await clickElement("#tunnels-toggle");
  echo.server.close();

  // 17. 密钥认证：仓库里不放测试私钥，让应用现生成一把一次性的
  const pem = await cdp.eval(`window.__TAURI__.core.invoke("mock_generate_key")`);  check(
    "能生成一次性测试私钥",
    typeof pem === "string" && pem.includes("OPENSSH PRIVATE KEY"),
    `${String(pem).length} 字节`,
  );
  const keyPath = join(DATA_DIR, "id_test");
  writeFileSync(keyPath, pem);
  await clickElement("#use-key");
  await cdp.send("DOM.setFileInputFiles", {
    nodeId: await nodeIdOf("#key-file"),
    files: [keyPath],
  });
  const keyPicked = await waitFor(
    async () => {
      const name = await cdp.eval(`document.getElementById("key-name").textContent`);
      return name === "id_test" ? name : null;
    },
    { timeout: 10000, label: "选择密钥文件" },
  );
  check("选中密钥后显示文件名", true, keyPicked);

  await clickElement("#ssh");
  const keyStatus = await waitFor(
    async () => {
      const s = await cdp.eval(`document.getElementById("status").textContent`);
      if (s.startsWith("已连接")) return s;
      if (s === "连接失败") {
        const scr = await cdp.eval(`window.__wt.screen()`);
        throw new Error(`密钥连接失败：${scr.split(/\r?\n/).filter(Boolean).slice(-3).join(" | ")}`);
      }
      return null;
    },
    { timeout: 30000, label: "密钥认证连接" },
  );
  const keyOut = await waitFor(
    async () => {
      const t = await cdp.eval(`window.__wt.screen()`);
      return t.includes("WELCOME") ? t : null;
    },
    { timeout: 15000, label: "密钥会话输出" },
  );
  check(
    "密钥认证可用（无密码也能连）",
    keyStatus.includes("tester@127.0.0.1") && keyOut.includes("WELCOME"),
    keyStatus,
  );

  // 17b. agent 认证：本机没有 agent 时，错误必须指向环境而不是网络。
  //      有 agent 的机器上这条会走「身份被拒」，两种都算通过。
  await closeAllTabs();
  await clickElement("#use-key"); // 退出密钥模式
  await clickElement("#use-agent");
  const agentUi = await waitFor(
    async () => {
      const s = await cdp.eval(`({
        agent: document.getElementById("use-agent").checked,
        key: document.getElementById("use-key").checked,
        passHidden: document.getElementById("password").hidden,
      })`);
      return s.agent && !s.key && s.passHidden ? s : null;
    },
    { timeout: 5000, label: "agent 模式界面" },
  );
  check("勾「用 agent」时密钥与密码都收起", agentUi.agent === true);

  await clickElement("#ssh");
  const agentErr = await waitFor(
    async () => {
      const t = await cdp.eval(`window.__wt.screen()`);
      if (t.includes("SSH_AGENT_UNAVAILABLE") || t.includes("ssh-agent")) return t;
      if (t.includes("SSH_AUTH_FAILED")) return t;
      return null;
    },
    { timeout: 30000, label: "agent 认证失败提示" },
  );
  const agentLine =
    agentErr.split(/\r?\n/).find((l) => l.includes("agent") || l.includes("SSH_AUTH_FAILED")) ?? "";
  check(
    "agent 不可用时给出指向环境的错误",
    true,
    agentLine.trim().slice(0, 90),
  );
  await closeAllTabs();
  await clickElement("#use-agent"); // 退出 agent 模式

  // 18. 保险库：把密码存起来，下次选中会话自动填
  await closeAllTabs();

  // 密钥/agent 模式都已在上一步退出，「记住密码」应已恢复可用
  const keyModeOff = await waitFor(
    async () => {
      const disabled = await cdp.eval(`document.getElementById("remember").disabled`);
      return disabled === false ? true : null;
    },
    { timeout: 5000, label: "退出密钥与 agent 模式" },
  );
  check("密钥/agent 模式下「记住密码」被禁用，退出后恢复", keyModeOff === true);

  await clickElement("#remember");
  const vaultVisible = await waitFor(
    async () => {
      const hidden = await cdp.eval(`document.getElementById("vault-row").hidden`);
      return hidden === false ? true : null;
    },
    { timeout: 5000, label: "保险库输入行" },
  );
  check("勾选「记住密码」后出现保险库输入", vaultVisible === true);

  const MASTER = "WindTerm-E2E-Passw0rd!";
  await fillInput("#master-pass", MASTER);
  await clickElement("#vault-open");
  const vaultState = await waitFor(
    async () => {
      const t = await cdp.eval(`document.getElementById("vault-state").textContent`);
      return t.includes("已解锁") ? t : null;
    },
    { timeout: 20000, label: "创建保险库" },
  );
  check("创建保险库并解锁", vaultState.includes("已解锁"), vaultState);

  // 选中会话 → 填密码 → 连接成功 → 密码应被写入保险库
  await clickSessionNode("mock-ssh");
  await fillInput("#password", "secret");
  await clickElement("#ssh");
  await waitFor(
    async () => {
      const s = await cdp.eval(`document.getElementById("status").textContent`);
      return s.startsWith("已连接") ? s : null;
    },
    { timeout: 30000, label: "保险库会话连接" },
  );
  const vaultAfterSave = await waitFor(
    async () => {
      const t = await cdp.eval(`document.getElementById("vault-state").textContent`);
      return t.includes("1 条") ? t : null;
    },
    { timeout: 15000, label: "密码写入保险库" },
  );
  check("连接成功后密码写入保险库", true, vaultAfterSave);

  const vaultFile = join(DATA_DIR, "vault.wtvlt");
  const vaultBytes = existsSync(vaultFile) ? readFileSync(vaultFile) : Buffer.alloc(0);
  check(
    "保险库文件落盘且是加密容器",
    vaultBytes.length > 100 && vaultBytes.subarray(0, 6).toString("latin1") === "WTVLT\u0000",
    `${vaultBytes.length} 字节`,
  );

  // 关掉、清空密码框、重新选中会话：密码应从保险库自动填入
  await closeAllTabs();
  await fillInput("#password", "");
  await clickSessionNode("mock-ssh");
  const refilled = await waitFor(
    async () => {
      const v = await cdp.eval(`document.getElementById("password").value`);
      return v === "secret" ? v : null;
    },
    { timeout: 10000, label: "保险库自动填密码" },
  );
  check("重新选中会话时从保险库自动填入密码", refilled === "secret");

  // 用自动填入的密码直接连（证明存下来的密码真的能用）
  await clickElement("#ssh");
  const reusedStatus = await waitFor(
    async () => {
      const s = await cdp.eval(`document.getElementById("status").textContent`);
      return s.startsWith("已连接") ? s : null;
    },
    { timeout: 30000, label: "用保险库密码连接" },
  );
  check("用保险库里的密码能直接连上", reusedStatus.includes("tester@127.0.0.1"), reusedStatus);

  // 19. 保险库条目面板：能看到存了什么，也能删掉
  // 点之前先记一次状态：面板的开关是「可见则关」，如果它本来就被别处打开过，
  // 这一下会把它关掉，断言就会以「列表为空」的形式失败——先留证据再断言。
  const vaultPre = await cdp.eval(`(() => {
    const p = document.getElementById("vault-panel");
    const btn = document.getElementById("vault-toggle");
    const r = btn.getBoundingClientRect();
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    return {
      hidden: p.hidden,
      display: getComputedStyle(p).display,
      entries: p.querySelectorAll(".entry").length,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      hit: hit ? hit.id || hit.className || hit.tagName : "视口外",
    };
  })()`);
  await clickElement("#vault-toggle");
  const listedEntries = await waitFor(
    async () => {
      const names = await cdp.eval(
        `[...document.querySelectorAll("#vault-panel .entry span")].map((e) => e.textContent)`,
      );
      return names.includes("mock-ssh") ? names : null;
    },
    { timeout: 10000, label: "保险库条目列表" },
  ).catch(async (e) => {
    const dbg = await cdp.eval(`({
      hidden: document.getElementById("vault-panel").hidden,
      entries: document.querySelectorAll("#vault-panel .entry").length,
      text: document.getElementById("vault-panel").textContent.replace(/\\s+/g, " ").slice(0, 160),
    })`);
    throw new Error(`${e.message}；点前=${JSON.stringify(vaultPre)} 点后=${JSON.stringify(dbg)}`);
  });
  check("保险库面板能看到存了哪些密码", true, listedEntries.join("、"));

  const deleteBtnBox = await cdp.eval(`(() => {
    const btn = document.querySelector("#vault-panel .entry button");
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!deleteBtnBox) throw new Error("保险库面板里找不到删除按钮");
  await clickAt(deleteBtnBox);
  const panelCleared = await waitFor(
    async () => {
      const t = await cdp.eval(`document.getElementById("vault-panel").textContent`);
      return t.includes("没有密码") ? t : null;
    },
    { timeout: 10000, label: "删除保险库条目" },
  );
  const vaultAfterDelete = await cdp.eval(
    `document.getElementById("vault-state").textContent`,
  );
  check(
    "能删掉保险库里的密码（面板与计数同步）",
    panelCleared.includes("没有密码") && vaultAfterDelete.includes("0 条"),
    vaultAfterDelete,
  );

  // 20. 连不上的错误路径：必须给出稳定错误码，不能静默失败
  await closeAllTabs();
  await fillInput("#port", "1");
  await clickElement("#ssh");
  const errScreen = await waitFor(
    async () => {
      const t = await cdp.eval(`window.__wt.screen()`);
      return t.includes("SSH_CONNECT_FAILED") ? t : null;
    },
    { timeout: 20000, label: "连接失败提示" },
  );
  check(
    "连不上时给出稳定错误码而非静默失败",
    true,
    errScreen.split(/\r?\n/).find((l) => l.includes("SSH_CONNECT_FAILED"))?.trim() ?? "",
  );

  // 18. 页面无未捕获异常
  check("页面无未捕获异常", cdp.exceptions.length === 0, cdp.exceptions.join(" | ") || "0 条");

  ws.close();
} catch (e) {
  check("端到端流程未中断", false, e.message);
  // 失败时把页面状态栏、屏幕尾部内容和异常一起打出来，省得靠猜
  try {
    const st = await cdp?.eval(`document.getElementById("status")?.textContent ?? ""`);
    if (st) console.error(`页面状态栏：${st}`);
    const scr = await cdp?.eval(`window.__wt?.screen?.() ?? ""`);
    if (scr) {
      const tail = scr.split(/\r?\n/).filter((l) => l.trim()).slice(-6);
      console.error(`屏幕尾部：\n${tail.join("\n")}`);
    }
  } catch {
    /* 页面可能已经不可达 */
  }
  if (cdp?.exceptions.length) console.error(`页面异常：${cdp.exceptions.join(" | ")}`);
} finally {
  cleanup();
}

// ── 汇总 ────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) {
  console.error(`\n失败项：`);
  for (const f of failed) console.error(`  - ${f.name}${f.detail ? `：${f.detail}` : ""}`);
  if (stderr.trim()) console.error(`\n应用 stderr：\n${stderr.trim()}`);
  process.exit(1);
}
console.log("桌面端端到端验收通过。");
