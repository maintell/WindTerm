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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const { root: domRoot } = await cdp.send("DOM.getDocument", { depth: 0 });
  const { nodeId } = await cdp.send("DOM.querySelector", {
    nodeId: domRoot.nodeId,
    selector: "#import-file",
  });
  await cdp.send("DOM.setFileInputFiles", { nodeId, files: [ini2] });
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
  await cdp.send("DOM.setFileInputFiles", { nodeId, files: [ini2] });
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

  // 16. 关闭后重连：主机密钥已在 known_hosts 里，不该再报「已记录」
  await clickElement("#close");
  await waitFor(
    async () => (await cdp.eval(`document.getElementById("status").textContent`)) === "已关闭",
    { timeout: 10000, label: "SSH 会话关闭" },
  );
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

  // 17. 连不上的错误路径：必须给出稳定错误码，不能静默失败
  await clickElement("#close");
  await waitFor(
    async () => (await cdp.eval(`document.getElementById("status").textContent`)) === "已关闭",
    { timeout: 10000, label: "关闭第二次会话" },
  );
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
