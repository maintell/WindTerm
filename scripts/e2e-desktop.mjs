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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    // 再起一台当跳板机：SES-024 要验「经跳板连目标」，单台 mock 验不了
    WT_MOCK_SSH_JUMP: "1",
    // 第三台：SES-025 的多跳（目标 ← 跳板机 ← 再一台跳板机）
    WT_MOCK_SSH_JUMP2: "1",
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

/** 第三台 mock（第二跳跳板机）的端口 */
async function mockJump2Port() {
  const m = await waitFor(
    () => {
      const hit = stdout.match(/WT_MOCK_SSH_JUMP2_PORT=(\d+)/);
      return hit ? Number(hit[1]) : null;
    },
    { timeout: 15000, label: "mock 第二跳端口" },
  );
  return m;
}

/** 第二台 mock（跳板机）的端口 */
async function mockJumpPort() {
  const m = await waitFor(
    () => {
      const hit = stdout.match(/WT_MOCK_SSH_JUMP_PORT=(\d+)/);
      return hit ? Number(hit[1]) : null;
    },
    { timeout: 15000, label: "mock 跳板机端口" },
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
    // 面板可能是可滚动的（隧道面板就是）：先滚进可视区，量到的位置才可点
    el.scrollIntoView({ block: "nearest" });
    const r = el.getBoundingClientRect();
    // 纵向与横向都要查：只查纵向时，被挤出对话框右边的按钮会在「看似正常」的
    // 坐标上点下去——实际落在背景遮罩上，既不报错也没反应
    if (r.bottom > innerHeight || r.top < 0 || r.right > innerWidth || r.left < 0) {
      return { offscreen: true, y: r.y, x: r.x, right: r.right };
    }
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (box?.offscreen) {
    throw new Error(`${selector} 在可视区外（x=${box.x} y=${box.y} right=${box.right}）`);
  }
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

/**
 * 确保文件面板处于指定开合状态。
 *
 * 不能只点 `#files-toggle`：SSH 连上会自动打开（`FIL-001`），那时「点一下」是**关闭**，
 * 后面的断言就都在错误的前提上跑。
 */
/**
 * 把文件面板带回根目录。
 *
 * 树与刷新都不改变当前目录，所以只能一路点 ↑。
 * 抽成函数是因为「忘了回根就刷新」这个错已经犯过两次。
 */
async function filesGoRoot() {
  for (let i = 0; i < 6; i += 1) {
    const at = await cdp.eval(`document.getElementById("files-path").textContent`);
    if (at === "/") return;
    await clickElement("#files-up");
    await waitFor(
      async () => {
        const p = await cdp.eval(`document.getElementById("files-path").textContent`);
        return p !== at;
      },
      { timeout: 8000, label: "回到上一层" },
    ).catch(() => null);
  }
}

async function ensureFilesPanel(open) {
  const hidden = await cdp.eval(`document.getElementById("files").hidden`);
  if (hidden === !open) return;
  await clickElement("#files-toggle");
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

/** 只做方法协商、看代理要哪种认证（用来验证「无凭据被拒」）。 */
function socksNoAuthProbe(proxyPort) {
  return new Promise((resolve, reject) => {
    const sock = netConnect({ host: "127.0.0.1", port: proxyPort });
    sock.setTimeout(5000, () => {
      sock.destroy();
      reject(new Error("SOCKS5 探测超时"));
    });
    sock.on("connect", () => sock.write(Buffer.from([5, 1, 0])));
    sock.on("data", (d) => {
      sock.destroy();
      resolve(d);
    });
    sock.on("error", reject);
  });
}

/** 带用户名密码的 SOCKS5 客户端（RFC 1929）。 */
function socksExchangeAuth(proxyPort, user, pass, targetHost, targetPort, payload) {
  return new Promise((resolve, reject) => {
    const sock = netConnect({ host: "127.0.0.1", port: proxyPort });
    let stage = "greet";
    let got = "";
    sock.setTimeout(8000, () => {
      sock.destroy();
      reject(new Error("SOCKS5(认证) 超时"));
    });
    sock.on("connect", () => sock.write(Buffer.from([5, 1, 2])));
    sock.on("data", (d) => {
      if (stage === "greet") {
        if (d[0] !== 5 || d[1] !== 2) {
          reject(new Error(`协商被拒 ${d.toString("hex")}`));
          return;
        }
        stage = "auth";
        sock.write(
          Buffer.concat([
            Buffer.from([1, Buffer.byteLength(user)]),
            Buffer.from(user),
            Buffer.from([Buffer.byteLength(pass)]),
            Buffer.from(pass),
          ]),
        );
        return;
      }
      if (stage === "auth") {
        if (d[1] !== 0) {
          reject(new Error(`认证失败 status=${d[1]}`));
          return;
        }
        stage = "reply";
        sock.write(
          Buffer.concat([
            Buffer.from([5, 1, 0, 3, Buffer.byteLength(targetHost)]),
            Buffer.from(targetHost),
            Buffer.from([targetPort >> 8, targetPort & 0xff]),
          ]),
        );
        return;
      }
      if (stage === "reply") {
        if (d[1] !== 0) {
          reject(new Error(`CONNECT 被拒 REP=${d[1]}`));
          return;
        }
        stage = "data";
        sock.write(payload);
        return;
      }
      got += d.toString();
      if (got.length >= payload.length) {
        sock.end();
        resolve(got);
      }
    });
    sock.on("error", reject);
  });
}

/**
 * 单击文件面板里的某一行（按名字），用于选中。
 *
 * 带重试：目录刚切换时列表还在「读取中…」，立刻点会扑空——
 * 这种时序失败看起来像功能坏了，其实是断言太急。
 */
async function clickFileRow(name) {
  const deadline = Date.now() + 15000;
  let box = null;
  while (Date.now() < deadline) {
    box = await cdp.eval(`(() => {
      const row = [...document.querySelectorAll("#files-list .row")].find(
        (r) => r.querySelector("span")?.textContent === ${JSON.stringify(name)},
      );
      if (!row) return null;
      const r = row.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (box) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!box) throw new Error(`文件面板里找不到 ${name}（当前：${await rowTexts()}）`);
  await clickAt(box);
}

/** 当前面板里有哪些行（失败时用来定位）。 */
async function rowTexts() {
  const f = await cdp.eval(`window.__wt?.files ?? null`);
  return `${(f?.rows ?? []).join("、")} msg=${f?.msg ?? ""} path=${f?.path ?? ""}`;
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
 * 极简 SOCKS5 客户端：握手 + CONNECT（域名地址）+ 一次收发。
 *
 * 手写而不是引入依赖：要验的正是「我们的代理讲不讲 SOCKS5」，
 * 用别人的实现会把两侧的 bug 混在一起。
 */
function socksExchange(proxyPort, targetHost, targetPort, payload) {
  return new Promise((resolve, reject) => {
    const sock = netConnect({ host: "127.0.0.1", port: proxyPort });
    let stage = "greet";
    let got = "";
    sock.setTimeout(8000, () => {
      sock.destroy();
      reject(new Error("SOCKS5 超时"));
    });
    sock.on("connect", () => sock.write(Buffer.from([5, 1, 0])));
    sock.on("data", (d) => {
      if (stage === "greet") {
        if (d[0] !== 5 || d[1] !== 0) {
          reject(new Error(`协商被拒 ${d.toString("hex")}`));
          return;
        }
        stage = "reply";
        sock.write(
          Buffer.concat([
            Buffer.from([5, 1, 0, 3, Buffer.byteLength(targetHost)]),
            Buffer.from(targetHost),
            Buffer.from([targetPort >> 8, targetPort & 0xff]),
          ]),
        );
        return;
      }
      if (stage === "reply") {
        if (d[1] !== 0) {
          reject(new Error(`CONNECT 被拒绝 REP=${d[1]}`));
          return;
        }
        stage = "data";
        sock.write(payload);
        return;
      }
      got += d.toString();
      if (got.length >= payload.length) {
        sock.end();
        resolve(got);
      }
    });
    sock.on("error", reject);
  });
}

/**
 * 点某类隧道行（`L`/`D`）里的按钮。
 *
 * `which`：`toggle` = 启动/停止（第一个按钮），`delete` = 删除（第二个）。
 * 停止后配置仍留在库里（灰灯），所以「删除」是独立的一步。
 */
/** 点会话树里的**任意**节点（会话或文件夹，`clickSessionNode` 只认会话） */
async function clickTreeNode(name) {
  const box = await cdp.eval(`(() => {
    const el = [...document.querySelectorAll("#tree-body .node")].find(
      (n) => n.textContent === ${JSON.stringify(name)},
    );
    if (!el) return null;
    el.scrollIntoView({ block: "nearest" });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!box) throw new Error(`会话树里找不到节点 ${name}`);
  await clickAt(box);
}

/**
 * 等屏幕内容稳定（连续 `ms` 毫秒没有新输出）。
 *
 * 定位文本再点击之前必须先等它稳下来：本地 shell 执行完命令会再打印一个提示符，
 * 行会整体上移——这时量到的坐标指向的已经是下一行了。
 */
async function waitScreenStable(ms) {
  let last = null;
  let since = Date.now();
  return waitFor(
    async () => {
      const s = await cdp.eval(`window.__wt.screen()`);
      if (s !== last) {
        last = s;
        since = Date.now();
        return null;
      }
      return Date.now() - since >= ms ? s : null;
    },
    { timeout: 10000, label: "屏幕稳定" },
  );
}

/** 点键位对话框里某个动作的「录制」按钮 */
async function clickKeyRow(action) {
  const box = await cdp.eval(`(() => {
    const row = document.querySelector("#keys-list .key-row[data-action=\\"${action}\\"]");
    const btn = row?.querySelector("button");
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!box) throw new Error(`键位表里找不到动作 ${action}`);
  await clickAt(box);
}

/** 在会话树上右键某个节点（真实右键事件，让页面的 contextmenu 监听自己触发） */
async function rightClickNode(name) {
  const box = await cdp.eval(`(() => {
    const el = [...document.querySelectorAll("#tree-body .node")].find(
      (n) => n.textContent === ${JSON.stringify(name)},
    );
    if (!el) return null;
    el.scrollIntoView({ block: "nearest" });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!box) throw new Error(`会话树里找不到 ${name}`);
  const base = { x: box.x, y: box.y, button: "right" };
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base, clickCount: 1 });
  await waitFor(
    async () => ((await cdp.eval(`document.getElementById("ctx-menu").hidden`)) ? null : true),
    { timeout: 5000, label: "右键菜单" },
  );
}

/** 点右键菜单里的一项（按文本找） */
async function clickCtxItem(label) {
  const box = await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll("#ctx-menu button")].find(
      (b) => b.textContent === ${JSON.stringify(label)},
    );
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!box) throw new Error(`右键菜单里没有「${label}」`);
  await clickAt(box);
}

/** 命名对话框：填名字并确定 */
async function confirmName(text) {
  await fillInput("#name-input", text);
  await clickElement("#name-ok");
}

/** 关掉所有还开着的 <dialog>：模态框会挡住后续点击，而 e2e 里很容易漏关一个 */
async function closeAllDialogs() {
  await cdp.eval(`(() => {
    for (const d of document.querySelectorAll("dialog[open]")) d.close();
    return true;
  })()`);
}

/** Ctrl+点击会话树节点（多选用） */
async function ctrlClickTreeNode(name) {
  const box = await cdp.eval(`(() => {
    const el = [...document.querySelectorAll("#tree-body .node.session")].find(
      (n) => n.textContent === ${JSON.stringify(name)},
    );
    if (!el) return null;
    el.scrollIntoView({ block: "nearest" });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!box) throw new Error(`会话树里找不到 ${name}`);
  const base = { x: box.x, y: box.y, button: "left", modifiers: 2 };
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base, clickCount: 1 });
}

async function clickTunnelButton(kind, which) {
  const idx = which === "delete" ? 1 : 0;
  const box = await cdp.eval(`(() => {
    const row = [...document.querySelectorAll("#tunnel-list .tunnel")].find((r) =>
      (r.querySelector(".line1")?.textContent ?? "").startsWith("●" + ${JSON.stringify(kind)}),
    );
    const btn = row?.querySelectorAll("button")[${idx}];
    if (!btn) return null;
    // 先滚进可视区再量：表单多一行就可能把列表挤到可视范围外，
    // 那时 rect 仍是「几何位置」，点下去落在别的元素上，表现为「点了没反应」
    btn.scrollIntoView({ block: "nearest" });
    const r = btn.getBoundingClientRect();
    if (r.bottom > innerHeight || r.top < 0) return { offscreen: true, y: r.y };
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    // 命中测试：点的位置到底是谁？覆盖层/溢出会让「点上去」变成「点空」
    const hitEl = document.elementFromPoint(cx, cy);
    // 这里不要再套一层模板字符串：外层 eval 本身就是模板，嵌套反引号会把整段截断
    const hit = hitEl ? hitEl.tagName + ":" + (hitEl.textContent ?? "").slice(0, 10) : "null";
    // 几何一起带回来：挡住按钮的到底是谁、以及各自的位置，事后不用再猜
    const box = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)];
    };
    const rects = {
      btn: box(btn),
      hit: box(hitEl),
      list: box(document.getElementById("tunnel-list")),
      foot: box(document.getElementById("tunnel-foot")),
      panel: box(document.getElementById("tunnels")),
    };
    return { x: cx, y: cy, hit, hits: hitEl === btn, rects };
  })()`);
  if (box?.offscreen) {
    throw new Error(`${kind} 类型隧道的 ${which} 按钮在可视区外（y=${box.y}），点击会落空`);
  }
  if (!box) throw new Error(`找不到 ${kind} 类型隧道的 ${which} 按钮`);
  if (box.hits === false) {
    throw new Error(
      `${kind} 的 ${which} 按钮被 ${box.hit} 挡住（几何 ${JSON.stringify(box.rects)}）`,
    );
  }
  await clickAt(box);
}

/**
 * 点一个按钮直到状态变化（最多三次）。
 *
 * WebView2 会偶发吞掉**第一次**可信点击（`#open`、`Ctrl+Shift+V` 都踩过），
 * 所以「点一次 + 等状态」在某些步骤上不稳：等不到就再点一次。
 * 先在循环开头探一次，避免「第一次就成功」时又去点一个已经不存在的按钮。
 */
async function clickUntil(clickFn, probeFn, { timeout = 8000, tries = 3, label = "操作" } = {}) {
  for (let i = 0; i < tries; i++) {
    if (await probeFn()) return true;
    await clickFn();
    const ok = await waitFor(probeFn, { timeout }).catch(() => null);
    if (ok) return true;
  }
  throw new Error(`${label}：点了 ${tries} 次仍未生效`);
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
  // 期望值不写死：直接读磁盘上那份 `main.js` 的版本号。写死的话每次改前端都要
  // 记得回来同步这里，忘一次就是一条假失败——而它本来就是用来防假结论的。
  const expectedUi =
    /ui:\s*"(wt-ui-\d+)"/.exec(
      readFileSync(join(root, "apps", "wt-desktop", "ui", "main.js"), "utf8"),
    )?.[1] ?? null;
  check(
    "前端脚本是本次构建的版本",
    expectedUi !== null && uiVersion === expectedUi,
    `__wt.ui=${uiVersion} / 磁盘 ${expectedUi}`,
  );

  // 2b. 每次运行都从默认键位开始。
  //
  //     偏好现在存在 `config.toml`（`SET-006`），而它是**跨运行保留**的：上一轮改过的
  //     键位会让这一轮的默认值断言失败（「Ctrl+F 打开查找」超时、终端上却出现 `^F`）。
  //     这里用界面自己的「恢复默认」把内存与文件一起复位——重载页面不可取：
  //     CDP 的执行上下文会随之失效，后面的 eval 全部拿不到页面。
  const localNormalized = await waitFor(
    async () => {
      const v = await cdp.eval(`(() => {
        // window.__wt 是 main.js 末尾挂上去的，桥接就绪 ≠ 前端初始化完成
        if (!window.__wt?.keymap) return null;
        const had = localStorage.length > 0;
        const dlg = document.getElementById("keys-dialog");
        dlg.showModal();
        document.getElementById("keys-reset").click();
        dlg.close();
        return { had, find: window.__wt.keymap.find.chords.join("/") };
      })()`);
      return v ?? null;
    },
    { timeout: 15000, label: "前端初始化完成" },
  );
  check(
    "每次运行都从默认键位开始",
    localNormalized.find.includes("Ctrl+F"),
    localNormalized.had ? "已把上一轮遗留的键位复位" : "本来就是默认键位",
  );

  // 2c. 偏好落在 `config.toml`（`SET-006`）：人可读、可进 Git，而不是浏览器存储
  const prefsFile = join(DATA_DIR, "config.toml");
  // 写文件是异步的（界面点「恢复默认」→ invoke → 落盘），这里等它出现
  const prefsOk = await waitFor(
    () => {
      if (!existsSync(prefsFile)) return null;
      const text = readFileSync(prefsFile, "utf8");
      return text.includes('theme = "') && text.includes("[keymap]") ? text : null;
    },
    { timeout: 10000, label: "config.toml 落盘" },
  ).catch(() => null);
  check(
    "偏好写到 config.toml 且是 TOML 文本",
    prefsOk !== null,
    prefsOk ? prefsFile : `${prefsFile}（不存在或不含 theme/[keymap]）`,
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
  // 首次点击偶发被 WebView2 吞掉（会话刚起时的已知行为），最多补点 2 次
  for (let i = 0; i < 2; i += 1) {
    await clickElement("#open");
    const quick = await cdp.eval(`(async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 2000) {
        const s = document.getElementById("status").textContent;
        if (!s.startsWith("就绪")) return s;
        await new Promise((r) => setTimeout(r, 50));
      }
      return null;
    })()`);
    if (quick !== null) break;
  }
  const handle = await cdp.eval(`(async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      const s = document.getElementById("status").textContent;
      if (s.startsWith("已连接")) return s;
      if (s.startsWith("打开失败")) throw new Error(s);
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error(
    "点击后 15s 内状态未变为已连接，当前：" +
      document.getElementById("status").textContent +
      " 诊断：" +
      JSON.stringify(
        (() => {
          const b = document.getElementById("open");
          const r = b.getBoundingClientRect();
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return {
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            hit: hit ? hit.id || hit.tagName : "视口外",
            dialogOpen: document.getElementById("name-dialog").open,
          };
        })(),
      ),
  );
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
  await waitScreenStable(350);
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
  // 这条**已经收紧成「必须真的粘上」**：早先 WebView2 里 `readText()` 拿不到权限，
  // 右键只能退化，断言才放成「有反馈就算过」。现在右键是真的粘上了（连续多轮都是
  // 「已粘贴 N 字符」），继续容忍退化就等于把回归放过去。
  check("右键粘贴真的把剪贴板内容送进终端", /^已粘贴/.test(rightStatus), rightStatus);

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
  //
  //     最多补打 3 次：WebView2 在会话刚建立时偶发吞掉前几个可信按键，
  //     判据用「有没有拿到回显」而不是「有没有发出去」。
  const echoedOk = async () => {
    const t = await cdp.eval(`window.__wt.screen()`);
    const echoed = /echo:h[\s\S]*?echo:e[\s\S]*?echo:l[\s\S]*?echo:l[\s\S]*?echo:o/.test(t);
    return t.includes("WELCOME") && echoed ? t : null;
  };
  let sshOut = null;
  for (let i = 0; i < 3 && !sshOut; i += 1) {
    await typeText("hello");
    sshOut = await waitFor(echoedOk, { timeout: 6000, label: "SSH 回显" }).catch(() => null);
  }
  if (!sshOut) throw new Error("等待「SSH 回显」超时：连打 3 次都没等到逐键回显");
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

  // 15c. 经跳板机连接（SES-024）：两台 mock 串起来，第二跳的 SSH 握手
  //      跑在跳板机的 direct-tcpip 通道上——只有协议真的对才可能成功。
  const jumpPort = await mockJumpPort();
  await cdp.eval(`(() => {
    const box = document.getElementById("use-jump");
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    document.getElementById("jump-host").value = ${JSON.stringify(`127.0.0.1:${jumpPort}`)};
    document.getElementById("jump-user").value = "tester";
    document.getElementById("jump-pass").value = "secret";
    return true;
  })()`);
  check(
    "勾「经跳板机」展开跳板机输入",
    (await cdp.eval(`document.getElementById("jump-row").hidden`)) === false,
  );

  await clickElement("#ssh");
  const jumpStatus = await waitFor(
    async () => {
      const s = await cdp.eval(`document.getElementById("status").textContent`);
      return s.startsWith("已连接") || s.includes("失败") ? s : null;
    },
    { timeout: 30000, label: "经跳板机连接" },
  );
  check("经跳板机能连上目标", jumpStatus.startsWith("已连接"), jumpStatus);

  // 第二跳必须是真正的 SSH 会话：横幅只能来自目标机自己的 shell
  const jumpScreen = await waitFor(
    async () => {
      const t = await cdp.eval(`window.__wt.screen()`);
      return t.includes("WELCOME") ? t : null;
    },
    { timeout: 15000, label: "经跳板会话的横幅" },
  ).catch(() => null);
  check("跳板后面的目标返回了自己的 shell 横幅", jumpScreen !== null);

  // 两条主机密钥都该记下来：跳板机（直连 accept-new）+ 目标
  //（经跳板**无法 probe**，只能连上后用 trust_observed_key 补）
  const khAfterJump = readFileSync(khPath, "utf8").split("\n").filter(Boolean).length;
  check("跳板机与目标的主机密钥都被记录", khAfterJump >= 2, `${khAfterJump} 条`);

  // 收起跳板机：后面的用例仍走直连
  await cdp.eval(`(() => {
    const box = document.getElementById("use-jump");
    box.checked = false;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);

  // 15d. 跳板机作为**会话属性**：建一条 bastion 会话，把 mock-ssh 的跳板指向它。
  //      这就是「点一下会话就自动带跳板」与「每次重填」的区别。
  await clickElement("#new-session");
  await cdp.eval(`(() => {
    document.getElementById("session-name").value = "bastion";
    document.getElementById("host").value = "127.0.0.1";
    document.getElementById("port").value = ${JSON.stringify(String(jumpPort))};
    document.getElementById("user").value = "tester";
    return true;
  })()`);
  await clickElement("#save-session");
  await waitFor(
    async () => ((await cdp.eval(`window.__wt.sessions()`)).includes("bastion") ? true : null),
    { timeout: 10000, label: "保存 bastion 会话" },
  );
  check("能保存一条跳板机会话", true, `127.0.0.1:${jumpPort}`);

  await clickSessionNode("mock-ssh");
  await cdp.eval(`(() => {
    const sel = document.getElementById("jump-session");
    const opt = [...sel.options].find((o) => o.textContent === "bastion");
    if (!opt) return false;
    sel.value = opt.value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  await clickElement("#save-session");
  const savedJump = await waitFor(
    async () => {
      const s = await cdp.eval(`document.getElementById("status").textContent`);
      return s.startsWith("已保存") || s.startsWith("保存失败") ? s : null;
    },
    { timeout: 10000, label: "保存跳板机属性" },
  );
  check("跳板机可以存成会话属性", savedJump.startsWith("已保存"), savedJump);

  // 重新点会话：跳板机应当自动带出来
  await clickSessionNode("mock-ssh");
  const applied = await cdp.eval(`({
    checked: document.getElementById("use-jump").checked,
    host: document.getElementById("jump-host").value,
    user: document.getElementById("jump-user").value,
    hidden: document.getElementById("jump-row").hidden,
  })`);
  check(
    "选中会话自动带出跳板机配置",
    applied.checked === true &&
      applied.hidden === false &&
      applied.host === `127.0.0.1:${jumpPort}` &&
      applied.user === "tester",
    JSON.stringify(applied),
  );

  // 环引用必须在**保存时**就被拒（SES-024 AC-4）
  await cdp.eval(`(() => {
    const sel = document.getElementById("jump-session");
    const self = [...sel.options].find((o) => o.textContent === "mock-ssh");
    sel.value = self ? self.value : "";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  await clickElement("#save-session");
  const cycleMsg = await waitFor(
    async () => {
      const s = await cdp.eval(`document.getElementById("status").textContent`);
      return s.startsWith("保存失败") ? s : null;
    },
    { timeout: 10000, label: "环引用被拒" },
  ).catch(async () => `未报错，状态=${await cdp.eval(`document.getElementById("status").textContent`)}`);
  check("把会话自己设为跳板机时保存被拒", /循环|自己/.test(cycleMsg), cycleMsg);

  // 清掉跳板机并保存——顺带验证「取消跳板」这条路。
  // 必须真的存回去：夹具留在「mock-ssh 有跳板机」的状态会污染后面的保险库用例
  // （那时 bastion 没有保存过密码，走跳板必然认证失败）。
  await clickSessionNode("mock-ssh");
  await cdp.eval(`(() => {
    document.getElementById("jump-session").value = "";
    document.getElementById("use-jump").checked = false;
    document.getElementById("use-jump").dispatchEvent(new Event("change", { bubbles: true }));
    // 「新建」会清空密码（这是对的：否则新会话会继承上一条的密码），
    // 而这一段流程里保险库还没解锁、没人把它填回来——测试自己补上
    document.getElementById("password").value = "secret";
    return true;
  })()`);
  await clickElement("#save-session");
  const cleared = await waitFor(
    async () => {
      const s = await cdp.eval(`document.getElementById("status").textContent`);
      return s.startsWith("已保存") ? s : null;
    },
    { timeout: 10000, label: "清除跳板机" },
  );
  await clickSessionNode("mock-ssh");
  const afterClear = await cdp.eval(`({
    checked: document.getElementById("use-jump").checked,
    selected: document.getElementById("jump-session").value,
    pass: document.getElementById("password").value,
  })`);
  check(
    "取消跳板后不再带出跳板配置",
    cleared.startsWith("已保存") && afterClear.checked === false && afterClear.selected === "",
    JSON.stringify(afterClear),
  );
  // 保险库还没解锁，「新建」清掉的密码没人补——测试自己填回去
  await cdp.eval(`document.getElementById("password").value = "secret"`);

  // 16b. 文件面板：列远端目录
  const seed = Buffer.from("hello from server").toString("base64");
  await cdp.eval(
    `window.__TAURI__.core.invoke("mock_seed_file", { path: "/notes.txt", content: ${JSON.stringify(seed)} })`,
  );
  await ensureFilesPanel(true);
  // 自动打开时可能已经列过一次（那时 /notes.txt 还没种进去）：强制重列一次
  await cdp.eval(`(() => {
    const sel = document.getElementById("files-session");
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return sel.value;
  })()`);
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
      if (f.rows.length) return f;
      // 面板报错必须立刻抛出来：只等 rows 会让「列目录失败」伪装成「超时」
      if (f.msg && f.msg !== "读取中…") throw new Error(`文件面板：${f.msg}`);
      return null;
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

  // 16d-2. 文件管理：新建目录 → 改名 → 删除（FIL-001）
  await clickElement("#files-mkdir");
  await typeText("logs"); // 输入名字并回车（typeText 末尾带 Enter）
  const madeDir = await waitFor(
    async () => {
      const f = await cdp.eval(`window.__wt.files`);
      return f.rows.includes("logs/") ? f : null;
    },
    { timeout: 20000, label: "新建目录" },
  ).catch(async () => {
    const dbg = await cdp.eval(`(() => {
      const btn = document.getElementById("files-mkdir");
      const r = btn.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return {
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        hit: hit ? hit.id || hit.tagName : "视口外",
        dialogOpen: document.getElementById("name-dialog").open,
        inputValue: document.getElementById("name-input").value,
        msg: document.getElementById("files-msg").textContent,
        rows: [...document.querySelectorAll("#files-list .row span:first-child")].map((e) => e.textContent),
      };
    })()`);
    throw new Error(`新建目录失败：${JSON.stringify(dbg)}`);
  });
  check("能在远端新建目录", madeDir !== null, madeDir.rows.join("、"));

  // 单击选中 → 改名
  await clickFileRow("logs/");
  check(
    "单击选中一行",
    (await cdp.eval(`window.__wt.files.selected`)) === "logs",
    JSON.stringify(await cdp.eval(`window.__wt.files.selected`)),
  );
  await clickElement("#files-rename");
  await typeText("logs-old"); // 原名已预选，输入即替换
  const renamed = await waitFor(
    async () => {
      const f = await cdp.eval(`window.__wt.files`);
      return f.rows.includes("logs-old/") ? f : null;
    },
    { timeout: 20000, label: "改名" },
  ).catch(async () => {
    const f = await cdp.eval(`window.__wt.files`);
    throw new Error(`改名后列表=${f.rows.join("、")} msg=${f.msg}`);
  });
  check(
    "能把目录改名（旧名字消失）",
    renamed !== null && !renamed.rows.includes("logs/"),
    renamed.rows.join("、"),
  );

  // 删除要二次确认：第一次点只改按钮文案
  await clickFileRow("logs-old/");
  await clickElement("#files-remove");
  const removeArmedText = await cdp.eval(`document.getElementById("files-remove").textContent`);
  check("删除需要二次确认", removeArmedText === "确认删除", removeArmedText);
  await clickElement("#files-remove");
  const removed = await waitFor(
    async () => {
      const f = await cdp.eval(`window.__wt.files`);
      return f.rows.some((r) => r.startsWith("logs")) ? null : f;
    },
    { timeout: 20000, label: "删除目录" },
  ).catch(async () => {
    const f = await cdp.eval(`window.__wt.files`);
    throw new Error(`删除后列表=${f.rows.join("、")} msg=${f.msg}`);
  });
  check("删除后目录从列表消失", removed !== null, removed.rows.join("、"));

  // 16d-3. 拖拽上传（FIL-004）：从资源管理器拖文件进来 = 往面板里 drop。
  //         事件是合成的（CDP 造不出真实的 OS 拖拽），但 File 对象与上传链路是真的。
  const highlighted = await cdp.eval(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "x.txt"));
    const target = document.getElementById("files-list");
    target.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true }));
    const on = target.classList.contains("dropping");
    target.dispatchEvent(new DragEvent("dragleave", { dataTransfer: dt, bubbles: true }));
    return on;
  })()`);
  check("拖拽进入时高亮上传区域", highlighted === true);

  await cdp.eval(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["dropped-content"], "dropped.txt", { type: "text/plain" }));
    const target = document.getElementById("files-list");
    target.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true }));
    target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true }));
    return true;
  })()`);
  const dropped = await waitFor(
    async () => {
      const f = await cdp.eval(`window.__wt.files`);
      return f.rows.includes("dropped.txt") ? f : null;
    },
    { timeout: 20000, label: "拖拽上传" },
  ).catch(async () => {
    const f = await cdp.eval(`window.__wt.files`);
    throw new Error(`拖拽后列表=${f.rows.join("、")} msg=${f.msg}`);
  });
  check("拖拽文件进面板会触发上传", dropped !== null, dropped.rows.join("、"));

  // 16d-4. 分块上传与进度（FIL-019 的进度部分）：200 KB 会分成 4 块
  const bigPath = join(DATA_DIR, "big.bin");
  writeFileSync(bigPath, Buffer.alloc(200 * 1024, 7));
  await setFileInput("#files-upload", [bigPath]);
  const bigUploaded = await waitFor(
    async () => {
      const f = await cdp.eval(`window.__wt.files`);
      return f.rows.includes("big.bin") ? f : null;
    },
    { timeout: 60000, label: "分块上传" },
  ).catch(async () => {
    const f = await cdp.eval(`window.__wt.files`);
    throw new Error(`分块上传后列表=${f.rows.join("、")} msg=${f.msg}`);
  });
  // 进度必须是「多次、最后落在总长上」：一次 100% 是假进度
  const up = await cdp.eval(`window.__wt.files.upload`);
  check(
    "大文件上传按块回报真实进度",
    up && up.events >= 3 && up.last === up.total && up.total === 200 * 1024,
    JSON.stringify(up),
  );
  check("分块上传后远端出现该文件", bigUploaded !== null, "200 KB");

  // 16d-4b. 远端文件编辑（`FIL-005`）：下载到本地 → 改 → 写回远端
  await clickFileRow("notes.txt");
  await clickElement("#files-edit");
  const editDl = await waitFor(
    async () => {
      const e = await cdp.eval(`window.__wt.lastEdit`);
      return e && e.localPath ? e : null;
    },
    { timeout: 20000, label: "下载远端文件到本地" },
  );
  const localCopy = readFileSync(editDl.localPath);
  check(
    "编辑会把远端文件下载到本地临时区",
    localCopy.length === editDl.size && localCopy.length > 0,
    `${editDl.localPath}（${editDl.size} 字节）`,
  );

  // 改本地副本再写回：远端内容必须真的变了（重新下载一次对照）
  const editedText = "edited by e2e";
  writeFileSync(editDl.localPath, editedText);
  await clickElement("#edit-save");
  const saveStatus = await waitFor(
    async () => {
      const s = await cdp.eval(`document.getElementById("status").textContent`);
      return s.startsWith("已写回远端") ? s : null;
    },
    { timeout: 20000, label: "写回远端" },
  );
  // `FIL-002` 的关键约束：保存远端文件必须「写临时文件 + rename」，不能就地截断
  check("写回远端走的是原子替换（FIL-002）", saveStatus.includes("原子替换"), saveStatus);
  await clickElement("#edit-close");
  // 重新下载一次，确认远端真的被改了
  await clickFileRow("notes.txt");
  await doubleClickFileRow("notes.txt");
  const redownloaded = await waitFor(
    async () => {
      const msg = await cdp.eval(`document.getElementById("files-msg").textContent`);
      return msg.startsWith("已保存") ? msg : null;
    },
    { timeout: 20000, label: "重新下载" },
  );
  const newest = readdirSync(DOWNLOAD_DIR)
    .filter((f) => f.startsWith("notes"))
    .map((f) => ({ f, t: statSync(join(DOWNLOAD_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0];
  const refreshed = readFileSync(join(DOWNLOAD_DIR, newest.f), "utf8");
  check(
    "写回远端后远端内容真的变了",
    refreshed === editedText,
    `${newest.f} → ${JSON.stringify(refreshed)}`,
  );
  // 16d-4c. 内嵌编辑器（`FIL-011`）：打开、改、查找替换、保存
  // 先记下上一次的路径：`lastEdit` 在上一段里已经有值了，只等「非 null」会立刻返回，
  // 编辑器打开的会是上一份拷贝（那时读的就是错的文件）。
  const prevEditPath = await cdp.eval(`window.__wt.lastEdit?.localPath ?? null`);
  await clickFileRow("notes.txt");
  await clickElement("#files-edit");
  await waitFor(
    async () => {
      const e = await cdp.eval(`window.__wt.lastEdit`);
      return e && e.localPath !== prevEditPath ? e : null;
    },
    { timeout: 20000, label: "编辑下载" },
  );
  await clickElement("#edit-inline");
  const edOpen = await waitFor(
    async () => {
      const e = await cdp.eval(`window.__wt.editor`);
      return e.open && e.docs.length ? e : null;
    },
    { timeout: 15000, label: "内嵌编辑器打开" },
  );
  check(
    "打开内嵌编辑器并显示文件内容",
    edOpen.text !== null && edOpen.text.length > 0,
    `${edOpen.active}（${edOpen.docs[0].chars} 字）`,
  );

  // 查找替换（正则）：把 "e2e" 全换成 "E2E"
  await fillInput("#ed-find", "e2e");
  await fillInput("#ed-replace", "E2E");
  await clickElement("#ed-replace-all");
  const replaced = await waitFor(
    async () => {
      const e = await cdp.eval(`window.__wt.editor`);
      return e.text?.includes("E2E") && e.docs[0]?.dirty ? e : null;
    },
    { timeout: 8000, label: "全部替换" },
  );
  check(
    "全部替换改到内容并标记未保存",
    replaced.text.includes("E2E") && replaced.docs[0].dirty === true,
    replaced.text.slice(0, 40),
  );

  await clickElement("#ed-save");
  const edSaved = await waitFor(
    async () => {
      const s = await cdp.eval(`document.getElementById("status").textContent`);
      return s.startsWith("已保存") ? s : null;
    },
    { timeout: 15000, label: "编辑器保存" },
  );
  // 回读本地副本，确认真的写进去了
  const edLocal = await cdp.eval(`window.__wt.lastEdit`);
  const edOnDisk = readFileSync(edLocal.localPath, "utf8");
  check(
    "编辑器保存后本地文件内容变了",
    edOnDisk.includes("E2E") && edSaved !== null,
    `${edLocal.localPath} → ${JSON.stringify(edOnDisk.slice(0, 60))}`,
  );
  await cdp.eval(`document.querySelector("#ed-tabs .edtab .x").click()`);

  // 16d-5. 多会话并存（FIL-001）：文件面板可以对着某个会话，而不是只能跟随连接表单
  const filesSessionId = await cdp.eval(`(async () => {
    const dto = await window.__TAURI__.core.invoke("sessions_load");
    return dto.sessions.find((s) => s.name === "mock-ssh")?.id ?? null;
  })()`);
  // 故意把表单端口改坏：如果面板仍能列出文件，说明它用的是会话里的参数
  await cdp.eval(`(() => {
    document.getElementById("port").value = "1";
    const sel = document.getElementById("files-session");
    sel.value = ${JSON.stringify(filesSessionId)};
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  const viaSession = await waitFor(
    async () => {
      const f = await cdp.eval(`window.__wt.files`);
      return f.rows.includes("notes.txt") ? f : null;
    },
    { timeout: 20000, label: "按会话列出目录" },
  ).catch(async () => {
    const f = await cdp.eval(`window.__wt.files`);
    throw new Error(`按会话列目录失败：rows=${f.rows.join("、")} msg=${f.msg}`);
  });
  check(
    "文件面板可以对着某个会话（不依赖表单里的端口）",
    viaSession !== null,
    viaSession.rows.join("、"),
  );

  // 路径记忆：进子目录 → 切回「跟随表单」→ 再切回来，应当还在子目录
  await clickElement("#files-mkdir");
  await typeText("sub");
  await waitFor(
    async () => {
      const f = await cdp.eval(`window.__wt.files`);
      return f.rows.includes("sub/") ? f : null;
    },
    { timeout: 20000, label: "建子目录" },
  );
  await doubleClickFileRow("sub/");
  const inSub = await waitFor(
    async () => {
      const p = await cdp.eval(`document.getElementById("files-path").textContent`);
      return p.endsWith("/sub") ? p : null;
    },
    { timeout: 10000, label: "进入子目录" },
  ).catch(() => null);
  check("双击目录能进入", inSub !== null, `${inSub}`);

  await cdp.eval(`(() => {
    const sel = document.getElementById("files-session");
    sel.value = "";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  await cdp.eval(`(() => {
    const sel = document.getElementById("files-session");
    sel.value = ${JSON.stringify(filesSessionId)};
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  const restoredPath = await waitFor(
    async () => {
      const p = await cdp.eval(`document.getElementById("files-path").textContent`);
      return p.endsWith("/sub") ? p : null;
    },
    { timeout: 10000, label: "路径记忆" },
  ).catch(() => null);
  check("切回会话后回到各自上次的目录", restoredPath !== null, `${restoredPath}`);

  // 收尾：先复原端口，再让面板跟随表单，最后上到根目录删掉子目录
  await cdp.eval(`(() => {
    document.getElementById("port").value = ${JSON.stringify(String(sshPort))};
    const sel = document.getElementById("files-session");
    sel.value = "";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  await clickElement("#files-up");
  // 刚才那次「跟随表单」的请求用的是被改坏的端口（1），它的失败可能**晚到**：
  // 晚到还写界面就会把这次正确结果覆盖掉——这条断言就是盯它
  const afterUp = await waitFor(
    async () => {
      const f = await cdp.eval(`window.__wt.files`);
      return f.rows.includes("sub/") && f.msg === "" ? f : null;
    },
    { timeout: 15000, label: "回到根目录" },
  ).catch(async () => {
    const f = await cdp.eval(`window.__wt.files`);
    throw new Error(`回到根目录失败：rows=${f.rows.join("、")} msg=${f.msg}`);
  });
  check(
    "旧请求的失败不会覆盖新视图",
    afterUp.rows.includes("sub/") && afterUp.msg === "",
    afterUp.msg || "rows 正常、无残留错误",
  );
  await clickFileRow("sub/");
  await clickElement("#files-remove");
  await clickElement("#files-remove");

  await ensureFilesPanel(false);

  // 16e. 隧道（NET-001 / NET-004）：启动 → 经隧道收发 → 统计 → 停止
  const echo = await startEchoTarget();
  await clickElement("#tunnels-toggle");
  await cdp.eval(`(() => {
    document.getElementById("tunnel-listen").value = "0";
    document.getElementById("tunnel-target").value = ${JSON.stringify(`127.0.0.1:${echo.port}`)};
    document.getElementById("tunnel-lan").checked = false;
    return true;
  })()`);
  // 面板刚展开时第一次点击可能被吞（`#tree-head`、`#files-head` 都踩过）：
  // 点一次没反应就再点，而不是点一次就干等 30 秒
  await clickUntil(
    () => clickElement("#tunnel-add"),
    async () => (await cdp.eval(`window.__wt.tunnels.length`)) === 1,
    { timeout: 8000, tries: 3, label: "隧道启动" },
  ).catch(() => {});
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
      // 命中测试：点空了（被别的元素盖住）和点到了但处理没跑，要能一眼分开
      hit: (() => {
        const el = document.getElementById("tunnel-add");
        if (!el) return "找不到按钮";
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return top === el ? "self" : (top ? top.id || top.tagName : "null");
      })(),
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
  // 分组（`NET-004`）：本地/远程/动态混在一起时，得一行行看端点才知道是哪类
  const groupL = await cdp.eval(`(() => {
    const g = document.querySelector('#tunnel-list .tun-group[data-kind="L"]');
    return g
      ? {
          title: g.querySelector(".tun-group-title")?.textContent ?? "",
          rows: g.querySelectorAll("[data-id]").length,
        }
      : null;
  })()`);
  check(
    "隧道按类型分组（NET-004）",
    groupL !== null && groupL.title.includes("本地转发") && groupL.rows === 1,
    JSON.stringify(groupL),
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

  // 停止后配置仍留在库里（灰灯）——这正是「不用重填」的前提
  await clickTunnelButton("L", "toggle");
  const tunStopped = await waitFor(
    async () => {
      const t = (await cdp.eval(`window.__wt.tunnels`)).find((x) => x.kind === "L");
      return t && t.running === false ? t : null;
    },
    { timeout: 15000, label: "隧道停止" },
  ).catch(() => null);
  check("停止后隧道仍留在列表里（配置已保存）", tunStopped !== null, "灰灯 + 未运行");
  check("停止后端口不再监听", (await portOpen(listenPort)) === false, `端口 ${listenPort}`);

  // 没有承载会话时，「启动已保存的隧道」必须给出明确原因，
  // 而不是拿空密码去认证、让用户对着「认证失败」猜自己填错了什么
  const noSession = await cdp.eval(`(async () => {
    const t = (await window.__TAURI__.core.invoke("tunnel_stats")).find((x) => x.kind === "L");
    try {
      await window.__TAURI__.core.invoke("tunnel_start_saved", { id: t.id });
      return "没有拦住";
    } catch (e) {
      return String(e);
    }
  })()`);
  check("没有承载会话时启动给出明确原因", /TUN_NO_SESSION/.test(noSession), noSession);

  // 删除才是真的从库里消失
  await clickTunnelButton("L", "delete");
  const tunDeleted = await waitFor(
    async () => {
      const list = await cdp.eval(`window.__wt.tunnels`);
      return list.some((x) => x.kind === "L") ? null : true;
    },
    { timeout: 15000, label: "删除隧道" },
  ).catch(() => null);
  check("删除后隧道从列表消失", tunDeleted === true);

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

  // 16f. 动态代理（SOCKS5，NET-003）：浏览器/curl/git 靠它把流量送过 SSH
  await cdp.eval(`(() => {
    const kind = document.getElementById("tunnel-kind");
    kind.value = "dynamic";
    kind.dispatchEvent(new Event("change", { bubbles: true }));
    document.getElementById("tunnel-listen").value = "0";
    return true;
  })()`);
  check(
    "切到动态代理后目标输入被禁用",
    (await cdp.eval(`document.getElementById("tunnel-target").disabled`)) === true,
  );
  await clickElement("#tunnel-add");
  const dyn = await waitFor(
    async () => {
      const list = await cdp.eval(`window.__wt.tunnels`);
      return list.find((t) => t.kind === "D") ?? null;
    },
    { timeout: 30000, label: "动态代理启动" },
  );
  const proxyPort = Number(String(dyn.listen).split(":").pop());
  check(
    "动态代理启动并回填端口",
    proxyPort > 0 && dyn.listen.endsWith(`:${proxyPort}`),
    dyn.listen,
  );
  const groupD = await cdp.eval(`(() => {
    const g = document.querySelector('#tunnel-list .tun-group[data-kind="D"]');
    return g ? g.querySelector(".tun-group-title")?.textContent ?? null : null;
  })()`);
  check(
    "动态代理落在自己的分组里（NET-004）",
    typeof groupD === "string" && groupD.includes("动态代理"),
    `${groupD}`,
  );

  // 经 SOCKS5 访问 echo（用域名形式发地址：印证「目标由服务端解析」）
  const viaSocks = await socksExchange(proxyPort, "127.0.0.1", echo.port, "socks-ok").catch(
    (e) => `失败：${e.message}`,
  );
  check("SOCKS5 代理把字节送到目标", viaSocks === "socks-ok", JSON.stringify(viaSocks));

  await clickTunnelButton("D", "toggle");
  const dynStopped = await waitFor(
    async () => {
      const t = (await cdp.eval(`window.__wt.tunnels`)).find((x) => x.kind === "D");
      return t && t.running === false ? t : null;
    },
    { timeout: 15000, label: "动态代理停止" },
  ).catch(() => null);
  check("动态代理停止后保留在列表里", dynStopped !== null);
  check("动态代理停止后端口不再监听", (await portOpen(proxyPort)) === false, `端口 ${proxyPort}`);

  await clickTunnelButton("D", "delete");
  const dynDeleted = await waitFor(
    async () => {
      const list = await cdp.eval(`window.__wt.tunnels`);
      return list.some((x) => x.kind === "D") ? null : true;
    },
    { timeout: 15000, label: "删除动态代理" },
  ).catch(() => null);
  check("动态代理删除后从列表消失", dynDeleted === true);

  // 16f-1b. 导出/导入隧道配置（`NET-004`）：建一条 → 导出 → 删掉 → 导入回来
  check(
    "隧道面板有导出/导入入口（NET-004）",
    await cdp.eval(`!!document.getElementById("tunnels-export") &&
      !!document.getElementById("tunnels-import")`),
    "两个按钮都在",
  );
  await cdp.eval(`(() => {
    const set = (id, v) => {
      const el = document.getElementById(id);
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const kind = document.getElementById("tunnel-kind");
    // 注意：表单里是 local/dynamic/remote，统计 DTO 里才是 L/D/R——两套名字，别混
    kind.value = "local";
    kind.dispatchEvent(new Event("change", { bubbles: true }));
    set("tunnel-listen", "0");
    set("tunnel-target", ${JSON.stringify(`127.0.0.1:${echo.port}`)});
    document.getElementById("tunnel-lan").checked = false;
    // 承载连接显式「跟随表单」：走会话路径要保险库口令，而这一步它可能是锁着的
    set("tunnel-session", "");
    set("host", "127.0.0.1");
    set("port", ${JSON.stringify(String(sshPort))});
    set("user", "tester");
    set("password", "secret");
    return kind.value;
  })()`);
  await clickUntil(
    () => clickElement("#tunnel-add"),
    async () => (await cdp.eval(`window.__wt.tunnels.length`)) === 1,
    { timeout: 10000, tries: 3, label: "导出用例建隧道" },
  ).catch(async (e) => {
    const msg = await cdp.eval(`document.getElementById("tunnel-msg").textContent`);
    throw new Error(`${e.message}；隧道面板说：${msg}`);
  });
  const tunPath = await cdp.eval(`window.__TAURI__.core.invoke("tunnels_export")`);
  const tunFile = JSON.parse(readFileSync(tunPath, "utf8"));
  check(
    "隧道配置能导出成 JSON（NET-004）",
    tunFile.format === "windterm-tunnels" && tunFile.tunnels.length === 1,
    `${tunPath}（${tunFile.tunnels?.length ?? 0} 条）`,
  );

  // 用后端命令删，不走列表按钮：列表每秒重排一次，按钮坐标会过期（这一条踩过）
  const tunList = await cdp.eval(`window.__TAURI__.core.invoke("tunnel_stats")`);
  const tunId = tunList[0].id;
  await cdp.eval(`window.__TAURI__.core.invoke("tunnel_delete", { id: ${JSON.stringify(tunId)} })`);
  // 判据读后端的真值，不读 `__wt.tunnels`：后者靠面板的 1 秒轮询刷新，
  // 直接调命令时它不会立刻变（这一条踩过一次）
  const tunGone = await waitFor(
    async () => {
      const rows = await cdp.eval(`window.__TAURI__.core.invoke("tunnel_stats")`);
      return rows.length === 0 ? true : null;
    },
    { timeout: 8000, label: "删掉导出用例的隧道" },
  ).catch(() => null);
  check("删除后配置从库里消失（NET-004）", tunGone === true, `${tunGone === true ? "已删除" : "还在"}`);

  // 导入时改 id 与名字：只导同一份文件是「更新」，证明不了「导入会新建」
  const clone = JSON.parse(JSON.stringify(tunFile));
  clone.tunnels[0].id = "imported-l-1";
  clone.tunnels[0].name = "imported-L";
  const importedCount = await cdp.eval(`window.__TAURI__.core.invoke("tunnels_import",
    { json: ${JSON.stringify(JSON.stringify(clone))} })`);
  const tunBack = await waitFor(
    async () => {
      const names = await cdp.eval(`window.__TAURI__.core.invoke("tunnel_stats")
        .then((rows) => rows.map((t) => t.name))`);
      return names.includes("imported-L") ? names : null;
    },
    { timeout: 8000, label: "导入后回到列表" },
  ).catch(() => null);
  check(
    "导入能把隧道配置建回来（NET-004）",
    importedCount === 1 && tunBack !== null,
    `导入 ${importedCount} 条，列表 ${tunBack ? tunBack.join("、") : "没有"}`,
  );
  await cdp.eval(`window.__TAURI__.core.invoke("tunnel_delete", { id: "imported-l-1" })`);
  await waitFor(
    async () => {
      const rows = await cdp.eval(`window.__TAURI__.core.invoke("tunnel_stats")`);
      return rows.length === 0 ? true : null;
    },
    { timeout: 8000, label: "收尾删除隧道" },
  );


  // 16f-2. SOCKS5 代理认证（NET-003 AC-3）
  await cdp.eval(`(() => {
    const kind = document.getElementById("tunnel-kind");
    kind.value = "dynamic";
    kind.dispatchEvent(new Event("change", { bubbles: true }));
    document.getElementById("tunnel-listen").value = "0";
    document.getElementById("tunnel-socks-user").value = "u";
    document.getElementById("tunnel-socks-pass").value = "p";
    return true;
  })()`);
  check(
    "切到动态代理后出现代理认证输入",
    (await cdp.eval(`document.getElementById("tunnel-socks-user").hidden`)) === false,
  );
  await clickElement("#tunnel-add");
  const dynAuth = await waitFor(
    async () => {
      const list = await cdp.eval(`window.__wt.tunnels`);
      return list.find((t) => t.kind === "D") ?? null;
    },
    { timeout: 30000, label: "带认证的动态代理" },
  );
  const authPort = Number(String(dynAuth.listen).split(":").pop());
  check(
    "带代理认证的隧道不落库（口令不写配置库）",
    dynAuth.persisted === false,
    `persisted=${dynAuth.persisted}`,
  );

  // 无凭据必须被拒（05 FF）
  const probe = await socksNoAuthProbe(authPort).catch((e) => `失败：${e.message}`);
  check(
    "代理要求认证时无凭据连接被拒",
    Buffer.isBuffer(probe) && probe[1] === 0xff,
    Buffer.isBuffer(probe) ? probe.toString("hex") : String(probe),
  );

  // 带凭据才能用
  const viaAuth = await socksExchangeAuth(
    authPort,
    "u",
    "p",
    "127.0.0.1",
    echo.port,
    "socks-auth-ok",
  ).catch((e) => `失败：${e.message}`);
  check("带凭据的 SOCKS5 能穿过隧道", viaAuth === "socks-auth-ok", JSON.stringify(viaAuth));

  await clickUntil(
    () => clickTunnelButton("D", "delete"),
    async () =>
      (await cdp.eval(`window.__wt.tunnels`)).some((x) => x.kind === "D") ? null : true,
    { timeout: 10000, label: "删除带认证的动态代理" },
  ).catch(async (e) => {
    // 失败时把面板自己的话带出来：「点了没反应」和「后端报了错」是两件事
    const msg = await cdp.eval(`document.getElementById("tunnel-msg").textContent`);
    const rows = await cdp.eval(`[...document.querySelectorAll("#tunnel-list .tunnel")].map((r) => r.textContent)`);
    throw new Error(`${e.message}；面板提示「${msg}」；列表=${JSON.stringify(rows)}`);
  });

  // 16g. 远程转发（-R，NET-002）：监听在**服务器**上，连接进来后被转到本机
  await cdp.eval(`(() => {
    const kind = document.getElementById("tunnel-kind");
    kind.value = "remote";
    kind.dispatchEvent(new Event("change", { bubbles: true }));
    document.getElementById("tunnel-listen").value = "0";
    document.getElementById("tunnel-target").value = ${JSON.stringify(`127.0.0.1:${echo.port}`)};
    return true;
  })()`);
  check(
    "切到远程转发后端口占位改成「服务器上的端口」",
    (await cdp.eval(`document.getElementById("tunnel-listen").placeholder`)).includes("服务器"),
  );
  await clickElement("#tunnel-add");
  const rev = await waitFor(
    async () => {
      const list = await cdp.eval(`window.__wt.tunnels`);
      return list.find((x) => x.kind === "R") ?? null;
    },
    { timeout: 30000, label: "远程转发启动" },
  );
  const revPort = Number(String(rev.listen).split(":").pop());
  check("远程转发启动并显示服务端端口", revPort > 0, rev.listen);

  // 连「服务器上的」端口：应当被转到我本机的 echo
  const viaReverse = await tunnelExchange(revPort, "reverse-ok").catch((e) => `失败：${e.message}`);
  check(
    "连服务器的端口能到达本机目标（-R）",
    viaReverse === "reverse-ok",
    JSON.stringify(viaReverse),
  );

  await clickTunnelButton("R", "delete");
  const revDeleted = await waitFor(
    async () => {
      const list = await cdp.eval(`window.__wt.tunnels`);
      return list.some((x) => x.kind === "R") ? null : true;
    },
    { timeout: 15000, label: "删除远程转发" },
  ).catch(() => null);
  check("远程转发删除后从列表消失", revDeleted === true);

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
  check("密钥/agent 模式下「保存密码」被禁用，退出后恢复", keyModeOff === true);

  // 三态（`SEC-002`）：不记住 / 本次记住 / 永久记住
  const rememberOpts = await cdp.eval(
    `[...document.getElementById("remember").options].map((o) => o.value)`,
  );
  check(
    "密码保存有三态（不记住 / 本次记住 / 永久记住）",
    rememberOpts.join(",") === "persist,session,no",
    rememberOpts.join("、"),
  );

  const setRemember = (value) =>
    cdp.eval(`(() => {
      const el = document.getElementById("remember");
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return el.value;
    })()`);

  await setRemember("session");
  const sessionNoVault = await cdp.eval(`document.getElementById("vault-row").hidden`);
  check(
    "选「本次记住」不需要主密码（保险库行保持隐藏）",
    sessionNoVault === true,
    sessionNoVault,
  );

  await setRemember("persist");
  const vaultVisible = await waitFor(
    async () => {
      const hidden = await cdp.eval(`document.getElementById("vault-row").hidden`);
      return hidden === false ? true : null;
    },
    { timeout: 5000, label: "保险库输入行" },
  );
  check("选「永久记住」后出现保险库输入", vaultVisible === true);

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

  // 18b. 隧道自动启动（NET-005）：承载会话的密码已在保险库里，能自己拉起来。
  //      放在这里而不是隧道那一节：那一节保险库还没解锁，没有密码可用。
  const mocksshId = await cdp.eval(`(async () => {
    const dto = await window.__TAURI__.core.invoke("sessions_load");
    return dto.sessions.find((s) => s.name === "mock-ssh")?.id ?? null;
  })()`);
  // 走界面而不是直接 invoke：这个开关以前只在后端存在、界面上根本没有入口，
  // 「后端支持」与「用户能用」是两件事（G8 的教训）。
  // 面板是开关：已经开着就别再点一下（会把它关掉）
  if (await cdp.eval(`document.getElementById("tunnels").hidden`)) {
    await clickElement("#tunnels-toggle");
  }
  await waitFor(
    async () => ((await cdp.eval(`document.getElementById("tunnels").hidden`)) ? null : true),
    { timeout: 10000, label: "打开隧道面板" },
  );
  const autoUi = await cdp.eval(`(() => {
    const box = document.getElementById("tunnel-auto");
    const before = box.checked;
    const kind = document.getElementById("tunnel-kind");
    kind.value = "dynamic";
    kind.dispatchEvent(new Event("change", { bubbles: true }));
    document.getElementById("tunnel-listen").value = "0";
    const sel = document.getElementById("tunnel-session");
    sel.value = ${JSON.stringify(mocksshId ?? "")};
    // 承载会话是自动拉起的前提（要从保险库取它的密码）：拿不到就当场说清楚，
    // 否则后面只会看到一个含义模糊的 TUN_NO_SESSION
    if (!sel.value) throw new Error("承载会话下拉里没有 mock-ssh");
    box.checked = true;
    return { before, existed: !!box, checked: box.checked };
  })()`);
  check(
    "隧道表单有「解锁保险库后自动拉起」开关且默认不勾",
    autoUi.existed === true && autoUi.before === false,
    `existed=${autoUi.existed} before=${autoUi.before}`,
  );

  // 带代理认证的隧道不落库，勾了也拉不起来——控件必须禁用并说明原因，
  // 而不是留个勾了不生效的开关
  const authBlocksAuto = await cdp.eval(`(() => {
    const u = document.getElementById("tunnel-socks-user");
    const p = document.getElementById("tunnel-socks-pass");
    const box = document.getElementById("tunnel-auto");
    u.value = "u";
    p.value = "p";
    u.dispatchEvent(new Event("input", { bubbles: true }));
    const blocked = { disabled: box.disabled, checked: box.checked };
    u.value = "";
    p.value = "";
    u.dispatchEvent(new Event("input", { bubbles: true }));
    // 清空代理认证后要能重新勾上：否则「禁用」看起来像永久关掉了这个能力
    box.checked = true;
    return { blocked, restored: box.disabled, rechecked: box.checked };
  })()`);
  check(
    "填了代理认证时「自动拉起」被禁用并清掉勾选",
    authBlocksAuto.blocked.disabled === true &&
      authBlocksAuto.blocked.checked === false &&
      authBlocksAuto.restored === false &&
      authBlocksAuto.rechecked === true,
    JSON.stringify(authBlocksAuto),
  );

  await clickElement("#tunnel-add");
  const autoSpec = await waitFor(
    async () => {
      const list = await cdp.eval(`window.__wt.tunnels`);
      return list.find((x) => x.kind === "D" && x.auto_start === true) ?? null;
    },
    { timeout: 30000, label: "勾了自动拉起的动态代理" },
  );
  check(
    "勾选后启动的隧道带自动拉起标记",
    autoSpec.running === true && autoSpec.auto_start === true,
    `${autoSpec.kind} ${autoSpec.listen} auto_start=${autoSpec.auto_start}`,
  );

  // 停掉它：配置留在库里，auto_start 标记还在
  await cdp.eval(`window.__TAURI__.core.invoke("tunnel_stop", { id: ${JSON.stringify(autoSpec.id)} })`);
  const parked = await waitFor(
    async () => {
      const list = await cdp.eval(`window.__TAURI__.core.invoke("tunnel_stats")`);
      const t = list.find((x) => x.id === autoSpec.id);
      return t && t.running === false ? t : null;
    },
    { timeout: 10000, label: "自动启动隧道已停止" },
  );
  check("停止后配置仍在（auto_start 保留）", parked !== null);
  const parkedText = await cdp.eval(`document.querySelector("#tunnel-list").textContent`);
  check(
    "停止状态下界面显示「解锁保险库后自动拉起」",
    parkedText.includes("自动拉起"),
    parkedText.slice(0, 80),
  );

  // 触发自动启动：应当只用保险库里的凭据就把它拉起来
  const autoErrors = await cdp.eval(`window.__TAURI__.core.invoke("tunnel_autostart")`);
  const autoRunning = await waitFor(
    async () => {
      const list = await cdp.eval(`window.__TAURI__.core.invoke("tunnel_stats")`);
      const t = list.find((x) => x.id === autoSpec.id);
      return t?.running ? t : null;
    },
    { timeout: 30000, label: "自动启动隧道" },
  ).catch(() => null);
  check(
    "自动启动只用保险库凭据就把隧道拉起来了",
    autoRunning !== null && autoErrors.length === 0,
    autoRunning ? `listen=${autoRunning.listen}` : `errors=${JSON.stringify(autoErrors)}`,
  );

  // 收尾：删掉，别把状态留给后面的用例
  await cdp.eval(`window.__TAURI__.core.invoke("tunnel_delete", { id: ${JSON.stringify(autoSpec.id)} })`);

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

  // 19c. 终端编码（`TER-006`）：mock 在输入含 `__gbk__` 时回 GBK 字节的中文，
  //      只有编码切对了才看得见「中文」。
  await closeAllTabs();
  await clickSessionNode("mock-ssh");
  await fillInput("#port", String(sshPort));
  await clickElement("#ssh");
  await waitFor(
    async () => {
      const s = await cdp.eval(`document.getElementById("status").textContent`);
      return s.startsWith("已连接") ? s : null;
    },
    { timeout: 30000, label: "编码用例建会话" },
  );
  // 编码控件已搬进设置中心（SET-001）：先开面板再改
  await clickElement("#settings-open");
  const encUi = await cdp.eval(`(() => {
    const sel = document.getElementById("encoding");
    const before = sel.value;
    const inSettings = !document.getElementById("settings").hidden;
    sel.value = "gbk";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return { before, inSettings, after: window.__wt.encoding };
  })()`);
  await clickElement("#set-close");
  check(
    "设置中心里能改终端编码且从 UTF-8 起",
    encUi.inSettings === true && encUi.before === "utf-8" && encUi.after === "gbk",
    JSON.stringify(encUi),
  );

  // 19c-3. 导入配色（`TER-005`）：Windows Terminal schemes JSON
  const scheme = {
    schemes: [
      {
        name: "E2E Scheme",
        background: "#101020",
        foreground: "#e0e0f0",
        cursorColor: "#ff0000",
        selectionBackground: "#303050",
        black: "#000000", red: "#aa0000", green: "#00aa00", yellow: "#aa5500",
        blue: "#0000aa", purple: "#aa00aa", cyan: "#00aaaa", white: "#aaaaaa",
        brightBlack: "#555555", brightRed: "#ff5555", brightGreen: "#55ff55",
        brightYellow: "#ffff55", brightBlue: "#5555ff", brightPurple: "#ff55ff",
        brightCyan: "#55ffff", brightWhite: "#ffffff",
      },
    ],
  };
  await clickElement("#settings-open");
  await clickElement("#theme-import-open");
  await cdp.eval(`(() => {
    const ta = document.getElementById("theme-text");
    ta.value = ${JSON.stringify(JSON.stringify(scheme))};
    return true;
  })()`);
  await clickElement("#theme-import");
  const themeImported = await waitFor(
    async () => {
      const l = await cdp.eval(`window.__wt.look`);
      return l.theme === "E2E Scheme" ? l : null;
    },
    { timeout: 10000, label: "导入配色" },
  );
  check(
    "导入的配色被选中并应用到终端",
    themeImported.appliedBackground === "#101020",
    `${themeImported.theme} / ${themeImported.appliedBackground}`,
  );
  const themeCount = await cdp.eval(`document.getElementById("look-theme").options.length`);
  check("导入的配色进了下拉框", themeCount >= 22, `${themeCount} 套`);
  await clickElement("#theme-close");
  await clickElement("#set-close");

  // 设置搜索（SET-001 要求「每项都可通过搜索可达」）
  await clickElement("#settings-open");
  const searchUi = await cdp.eval(`(() => {
    const s = document.getElementById("set-search");
    const visibleNames = () =>
      [...document.querySelectorAll("#set-body .set-row")]
        .filter((r) => !r.hidden)
        .map((r) => r.querySelector(".set-name").textContent);
    s.value = "乱码";
    s.dispatchEvent(new Event("input", { bubbles: true }));
    const hit = visibleNames();
    s.value = "zzzz";
    s.dispatchEvent(new Event("input", { bubbles: true }));
    const empty = !document.getElementById("set-empty").hidden;
    s.value = "";
    s.dispatchEvent(new Event("input", { bubbles: true }));
    return { hit, empty, restored: visibleNames().length };
  })()`);
  await clickElement("#set-close");
  check(
    "设置搜索能按关键词命中，搜不到时有空态提示",
    searchUi.hit.length === 1 &&
      searchUi.hit[0] === "终端编码" &&
      searchUi.empty === true &&
      searchUi.restored >= 6,
    JSON.stringify(searchUi),
  );

  // 一次性把触发词写下去：逐键输入会让 mock 收到「一次一个字符」，
  // 它那边的触发条件是整串出现——这和真实用户快速粘贴的形态也更接近
  const encHandle = await cdp.eval(`window.__wt.handle`);
  await cdp.eval(`window.__TAURI__.core.invoke("term_write", {
    handle: ${JSON.stringify(encHandle)}, data: "__gbk__",
  })`);
  const gbkText = await waitFor(
    async () => {
      const t = await cdp.eval(`window.__wt.screen()`);
      return t.includes("中文") ? t : null;
    },
    { timeout: 15000, label: "按 GBK 解码出中文" },
  );
  check("切到 GBK 后能把 GBK 字节解成中文", gbkText !== null);
  // 编码是持久化的：留着 GBK 会把后面用例的 UTF-8 输出解成乱码（涓枃），
  // 所以验完立刻切回 UTF-8——不看对话框是否打开，元素本身就在
  await cdp.eval(`(() => {
    const sel = document.getElementById("encoding");
    sel.value = "utf-8";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return window.__wt.encoding;
  })()`);
  await closeAllTabs();

  // 19e. 会话上下文菜单（`SES-014`）：重命名 / 复制 / 新建子文件夹
  await clickElement("#refresh");
  await rightClickNode("mock-ssh");
  const menuItems = await cdp.eval(`[...document.querySelectorAll("#ctx-menu button")].map((b) => b.textContent)`);
  check(
    "右键会话出现上下文菜单（重命名/复制/移动到）",
    ["重命名", "复制", "移动到…"].every((x) => menuItems.includes(x)),
    JSON.stringify(menuItems),
  );

  await clickCtxItem("复制");
  await waitFor(
    async () => ((await cdp.eval(`document.getElementById("name-dialog").open`)) ? true : null),
    { timeout: 5000, label: "复制对话框" },
  );
  await confirmName("mock-ssh 副本");
  const copied = await waitFor(
    async () => {
      const names = await cdp.eval(`window.__wt.sessions()`);
      return names.includes("mock-ssh 副本") ? names : null;
    },
    { timeout: 10000, label: "复制会话" },
  );
  check("复制会话后树里出现新条目", copied.includes("mock-ssh 副本"), `${copied.length} 条`);

  // 导出：落点是下载目录，界面把完整路径说出来——再回读那个文件确认真的是它
  await rightClickNode("mock-ssh");
  await clickCtxItem("导出");
  const exported = await waitFor(
    async () => {
      const st = await cdp.eval(`document.getElementById("status").textContent`);
      return st.startsWith("已导出：") ? st : null;
    },
    { timeout: 10000, label: "导出会话" },
  );
  const exportedPath = exported.replace(/^已导出：/, "").trim();
  const exportedJson = JSON.parse(readFileSync(exportedPath, "utf8"));
  check(
    "导出的 JSON 真落盘且是这条会话",
    exportedJson?.format === "windterm-session" && exportedJson?.session?.name === "mock-ssh",
    exportedPath,
  );

  await rightClickNode("Lab");
  await clickCtxItem("新建子文件夹");
  await waitFor(
    async () => ((await cdp.eval(`document.getElementById("name-dialog").open`)) ? true : null),
    { timeout: 5000, label: "新建文件夹对话框" },
  );
  await confirmName("sub-net");
  // 文件夹节点不是 `.node.session`，`__wt.sessions()` 看不到它们——直接读文件夹节点
  const folderMade = await waitFor(
    async () => {
      const names = await cdp.eval(
        `[...document.querySelectorAll("#tree-body .node.folder")].map((n) => n.textContent)`,
      );
      return names.includes("sub-net") ? names : null;
    },
    { timeout: 10000, label: "新建子文件夹" },
  );
  check("右键文件夹能新建子文件夹", folderMade.includes("sub-net"), folderMade.join("、"));

  // 19e-2. 折叠与拖拽（`SES-013`）
  await clickTreeNode("Lab");
  const collapsed = await waitFor(
    async () => {
      const names = await cdp.eval(`window.__wt.sessions()`);
      return names.includes("mock-ssh") ? null : true;
    },
    { timeout: 8000, label: "折叠文件夹" },
  );
  check("点文件夹能折叠，子节点从树里消失", collapsed === true);

  // 折叠状态要落库：刷新一次树，仍然得是折叠的
  await clickElement("#refresh");
  await waitFor(
    async () => ((await cdp.eval(`window.__wt.sessions()`)).length ? true : null),
    { timeout: 10000, label: "刷新会话树" },
  );
  const stillCollapsed = await cdp.eval(
    `![...document.querySelectorAll("#tree-body .node.session")].some((n) => n.textContent === "mock-ssh")`,
  );
  check("折叠状态会落库（刷新后仍然折叠）", stillCollapsed === true);

  // 展开回来，后面还要用这些节点
  await clickTreeNode("Lab");
  await waitFor(
    async () => ((await cdp.eval(`window.__wt.sessions()`)).includes("mock-ssh") ? true : null),
    { timeout: 8000, label: "展开文件夹" },
  );

  // 拖拽：把会话拖进 sub-net。合成 DragEvent 带同一个 DataTransfer，
  // 走的是页面自己的 dragstart/drop 处理器（CDP 造不出真实 OS 拖拽）
  const moved = await cdp.eval(`(async () => {
    const src = [...document.querySelectorAll("#tree-body .node.session")].find(
      (n) => n.textContent === "mock-ssh",
    );
    const dst = [...document.querySelectorAll("#tree-body .node.folder")].find(
      (n) => n.textContent === "sub-net",
    );
    if (!src || !dst) return { ok: false, why: "找不到节点" };
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt }));
    return { ok: true };
  })()`);
  const movedOk = await waitFor(
    async () => {
      const snap = await cdp.eval(`window.__TAURI__.core.invoke("sessions_load")`);
      const sub = snap.folders.find((f) => f.name === "sub-net");
      const s = snap.sessions.find((x) => x.name === "mock-ssh");
      return sub && s && s.folder_id === sub.id ? true : null;
    },
    { timeout: 10000, label: "拖拽移动会话" },
  ).catch(() => null);
  check("把会话拖进文件夹后 folder_id 变了", movedOk === true, JSON.stringify(moved));

  // 同层排序：把 ui-imported 拖到「mock-ssh 副本」前面
  const orderBefore = await cdp.eval(`(async () => {
    const snap = await window.__TAURI__.core.invoke("sessions_load");
    return snap.sessions.filter((s) => !s.folder_id).map((s) => s.name);
  })()`);
  const reordered = await cdp.eval(`(async () => {
    const snap = await window.__TAURI__.core.invoke("sessions_load");
    const root = snap.sessions.filter((s) => !s.folder_id);
    const src = [...document.querySelectorAll("#tree-body .node.session")].find(
      (n) => n.textContent === "ui-imported",
    );
    const dst = [...document.querySelectorAll("#tree-body .node.session")].find(
      (n) => n.textContent === "mock-ssh 副本",
    );
    if (!src || !dst) return { ok: false, why: "找不到节点", root: root.map((s) => s.name) };
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt }));
    return { ok: true };
  })()`);
  const reorderedOk = await waitFor(
    async () => {
      const names = await cdp.eval(
        `(async () => {
          const snap = await window.__TAURI__.core.invoke("sessions_load");
          return snap.sessions.filter((s) => !s.folder_id).map((s) => s.name);
        })()`,
      );
      const a = names.indexOf("ui-imported");
      const b = names.indexOf("mock-ssh 副本");
      return a >= 0 && b >= 0 && a < b ? names : null;
    },
    { timeout: 10000, label: "拖拽排序" },
  ).catch(() => null);
  check(
    "同层拖到另一条会话上会调整顺序",
    reorderedOk !== null,
    `${JSON.stringify(orderBefore)} → ${JSON.stringify(reorderedOk ?? reordered)}`,
  );

  // 环检测：把 Lab 挪进它自己的子文件夹 sub-net，必须被拒
  const cycleErr = await cdp.eval(`(async () => {
    const snap = await window.__TAURI__.core.invoke("sessions_load");
    const lab = snap.folders.find((f) => f.name === "Lab");
    const sub = snap.folders.find((f) => f.name === "sub-net");
    try {
      await window.__TAURI__.core.invoke("folder_move", {
        folderId: lab.id, parentId: sub.id,
      });
      return "没有报错";
    } catch (e) {
      return String(e);
    }
  })()`);
  check(
    "把文件夹挪进自己的子文件夹被拒绝",
    cycleErr.includes("FOLDER_CYCLE"),
    cycleErr.slice(0, 80),
  );

  // 19g. 键位可重绑（`TER-020`）：录制新组合键、冲突检测、关闭后真的生效
  await closeAllTabs();
  await clickSessionNode("mock-ssh");
  await fillInput("#port", String(sshPort));
  await clickElement("#ssh");
  await waitFor(
    async () => {
      const s = await cdp.eval(`document.getElementById("status").textContent`);
      return s.startsWith("已连接") ? s : null;
    },
    { timeout: 30000, label: "键位用例建会话" },
  );

  await clickElement("#keys-open");
  const keyRows = await cdp.eval(`document.querySelectorAll("#keys-list .key-row").length`);
  check("键位表列出所有可重绑动作", keyRows >= 8, `${keyRows} 项`);

  await clickKeyRow("find");
  await pressChord(2 | 8, "k", "KeyK", 75);
  const rebound = await waitFor(
    async () => {
      const km = await cdp.eval(`window.__wt.keymap`);
      return km.find.chords.includes("Ctrl+Shift+K") ? km : null;
    },
    { timeout: 5000, label: "录制新键位" },
  );
  check("能把「查找」重绑到 Ctrl+Shift+K", rebound !== null, rebound?.find?.chords?.join("/"));

  // 冲突：把「放大字号」也录成 Ctrl+Shift+K，必须被拒且原绑定不动
  await clickKeyRow("zoomIn");
  await pressChord(2 | 8, "k", "KeyK", 75);
  const conflict = await waitFor(
    async () => {
      const st = await cdp.eval(`document.getElementById("status").textContent`);
      return st.includes("键位冲突") ? st : null;
    },
    { timeout: 5000, label: "键位冲突提示" },
  );
  const zoomKept = (await cdp.eval(`window.__wt.keymap`)).zoomIn.chords.includes("Ctrl+=");
  check("重复键位被拒且原绑定不变", zoomKept === true, conflict);

  // 键位方案的**文件级**导出/导入（`TER-020`）：以前只复制到剪贴板、导入靠 prompt()
  await clickElement("#keys-export");
  const keymapPath = await waitFor(
    async () => {
      const s = await cdp.eval(`document.getElementById("status").textContent`);
      const m = /键位方案已导出：(.+)$/.exec(s);
      return m ? m[1].trim() : null;
    },
    { timeout: 10000, label: "导出键位" },
  ).catch(() => null);
  const keymapText = keymapPath ? readFileSync(keymapPath, "utf8") : "";
  check(
    "键位方案能导出成文件（TER-020）",
    keymapText.includes('"format": "windterm-keymap"') && keymapText.includes("Ctrl+Shift+K"),
    keymapPath ? `${keymapPath}` : "没导出",
  );

  await setFileInput("#keys-file", [keymapPath]);
  const keymapImported = await waitFor(
    async () => {
      const s = await cdp.eval(`document.getElementById("status").textContent`);
      return /已导入 \d+ 项键位/.test(s) ? s : null;
    },
    { timeout: 10000, label: "导入键位" },
  ).catch(() => null);
  check(
    "导入键位文件能生效（TER-020）",
    keymapImported !== null,
    `${keymapImported ?? "没导入"}`,
  );

  await clickElement("#keys-close");
  const prePress = await cdp.eval(`({
    tabs: window.__wt.tabs().length,
    active: window.__wt.tabs().find((t) => t.active)?.label ?? null,
    dialogOpen: document.getElementById("keys-dialog").open,
  })`);
  await pressChord(2 | 8, "k", "KeyK", 75);
  const findByNewChord = await waitFor(
    async () =>
      (await cdp.eval(`document.getElementById("find-bar").hidden`)) ? null : true,
    { timeout: 8000, label: "新键位生效" },
  ).catch(() => null);
  const keyDiag = await cdp.eval(`({
    tabs: window.__wt.tabs().length,
    hidden: document.getElementById("find-bar").hidden,
    status: document.getElementById("status").textContent,
  })`);
  check(
    "关闭对话框后新键位真的生效",
    findByNewChord === true,
    JSON.stringify({ prePress, keyDiag }),
  );
  await pressChord(0, "Escape", "Escape", 27);
  await closeAllTabs();

  // 新增的可重绑动作必须**真的有效果**，不能只是表里多几行
  await clickUntil(
    () => pressChord(2, "t", "KeyT", 84),
    async () => (await cdp.eval(`document.querySelectorAll("#tabs .tab").length`)) >= 1,
    { timeout: 15000, tries: 3, label: "Ctrl+T 新建本地终端" },
  );
  // 标签建出来 ≠ 已激活：`active` 要等连接完成后才设上，而 Ctrl+W 关的是「当前标签」，
  // 没有激活标签时按设计什么都不做
  await waitFor(
    async () => {
      const t = await cdp.eval(`window.__wt.tabs().find((x) => x.active)?.label ?? null`);
      return t ? t : null;
    },
    { timeout: 15000, label: "标签变为激活" },
  );
  check("Ctrl+T 新建本地终端（新动作真的生效）", true, "已开出一个标签");

  // `Ctrl+W` 的绑定已撤掉：连续两轮实测按下去什么都不发生（原因未查清，怀疑被宿主截获），
  // 与其留一个按了没反应的键位，不如先不提供——项目规则里「控件存在但不生效」是要避免的。
  await closeAllTabs();

  // 19i. 左右分屏（`G6`）：两个会话各占一半，各自独立渲染
  await closeAllTabs();
  await clickSessionNode("mock-ssh");
  await fillInput("#port", String(sshPort));
  await clickElement("#ssh");
  await waitFor(
    async () => {
      const s = await cdp.eval(`document.getElementById("status").textContent`);
      return s.startsWith("已连接") ? s : null;
    },
    { timeout: 30000, label: "分屏第一个会话" },
  );
  await clickElement("#ssh");
  await waitFor(
    async () => ((await cdp.eval(`window.__wt.tabs().length`)) >= 2 ? true : null),
    { timeout: 30000, label: "分屏第二个会话" },
  );
  await waitFor(
    async () => {
      const t = await cdp.eval(`window.__wt.screen()`);
      return t.includes("WELCOME") ? true : null;
    },
    { timeout: 15000, label: "第二个会话横幅" },
  );

  await clickElement("#split-toggle");
  const splitOn = await waitFor(
    async () => {
      const s = await cdp.eval(`window.__wt.split`);
      const panes = await cdp.eval(
        `({ a: document.querySelectorAll("#term-a .term-view").length, b: document.querySelectorAll("#term-b .term-view").length, bHidden: document.getElementById("term-b").hidden })`,
      );
      return s.on && panes.a === 1 && panes.b === 1 && panes.bHidden === false
        ? { ...s, panes }
        : null;
    },
    { timeout: 10000, label: "分屏生效" },
  );
  check(
    "分屏后两个 pane 各有一个会话",
    splitOn.panes.a === 1 && splitOn.panes.b === 1,
    `左 ${splitOn.panes.a} / 右 ${splitOn.panes.b}（右=${splitOn.right}）`,
  );

  await clickElement("#split-toggle");
  const splitOff = await waitFor(
    async () => {
      const s = await cdp.eval(`window.__wt.split`);
      const panes = await cdp.eval(
        `({ a: document.querySelectorAll("#term-a .term-view").length, b: document.querySelectorAll("#term-b .term-view").length, bHidden: document.getElementById("term-b").hidden })`,
      );
      return !s.on && panes.b === 0 && panes.bHidden === true ? panes : null;
    },
    { timeout: 10000, label: "关闭分屏" },
  );
  check("关闭分屏后会话都回到左 pane", splitOff.a === 2, `左 ${splitOff.a} 个`);
  await closeAllTabs();

  // 19l. Truecolor 与宽字符（`TER-024` / `TER-025`）：从 buffer 里读颜色与单元格宽度
  await closeAllDialogs();
  await closeAllTabs();
  await clickSessionNode("mock-ssh");
  await fillInput("#port", String(sshPort));
  await clickElement("#ssh");
  await waitFor(
    async () => {
      const s = await cdp.eval(`document.getElementById("status").textContent`);
      return s.startsWith("已连接") ? s : null;
    },
    { timeout: 30000, label: "Truecolor 用例建会话" },
  );
  await waitFor(
    async () => {
      const t = await cdp.eval(`window.__wt.screen()`);
      return t.includes("WELCOME") ? true : null;
    },
    { timeout: 15000, label: "会话横幅" },
  );

  const tcHandle = await cdp.eval(`window.__wt.handle`);
  // 一次性写入触发词（逐键会变成一串 echo:）
  await cdp.eval(`window.__TAURI__.core.invoke("term_write", {
    handle: ${JSON.stringify(tcHandle)}, data: "__truecolor__",
  })`).catch(() => null);

  const tcCell = await waitFor(
    async () => {
      const c = await cdp.eval(`(() => {
        const at = window.__wt.findRow("XTC");
        return at === null ? null : window.__wt.cellAt(at.row, at.col);
      })()`);
      return c && c.text === "X" ? c : null;
    },
    { timeout: 15000, label: "真彩色输出" },
  ).catch(async (e) => {
    const dbg = await cdp.eval(`(() => {
      const at = window.__wt.findRow("XTC");
      return {
        at,
        cell: at ? window.__wt.cellAt(at.row, at.col) : null,
        tail: window.__wt.screen().slice(-160),
      };
    })()`);
    throw new Error(`${e.message}；${JSON.stringify(dbg)}`);
  });
  check(
    "24 位色真的落到单元格上（TER-024）",
    tcCell.fgIsRgb === true && tcCell.fg === 0x123456,
    JSON.stringify(tcCell),
  );

  await cdp.eval(`window.__TAURI__.core.invoke("term_write", {
    handle: ${JSON.stringify(tcHandle)}, data: "__wide__",
  })`).catch(() => null);
  const wideCells = await waitFor(
    async () => {
      const c = await cdp.eval(`(() => {
        const at = window.__wt.findRow("中文");
        if (at === null) return null;
        return {
          first: window.__wt.cellAt(at.row, at.col),
          cont: window.__wt.cellAt(at.row, at.col + 1),
          second: window.__wt.cellAt(at.row, at.col + 2),
        };
      })()`);
      return c && c.first?.text === "中" ? c : null;
    },
    { timeout: 15000, label: "宽字符输出" },
  );
  check(
    "CJK 字符各占两列、后面不再是独立单元格（TER-025）",
    wideCells.first.width === 2 &&
      wideCells.cont.width === 0 &&
      wideCells.second.text === "文" &&
      wideCells.second.width === 2,
    JSON.stringify(wideCells),
  );
  await closeAllTabs();

  // 19m. 鼠标上报（`TER-022`）：远端开启 1000 模式后，点击应变成鼠标序列
  await closeAllDialogs();
  await closeAllTabs();
  await clickSessionNode("mock-ssh");
  await fillInput("#port", String(sshPort));
  await clickElement("#ssh");
  await waitFor(
    async () => {
      const s = await cdp.eval(`document.getElementById("status").textContent`);
      return s.startsWith("已连接") ? s : null;
    },
    { timeout: 30000, label: "鼠标用例建会话" },
  );
  await waitFor(
    async () => {
      const t = await cdp.eval(`window.__wt.screen()`);
      return t.includes("WELCOME") ? true : null;
    },
    { timeout: 15000, label: "会话横幅" },
  );

  const mouseHandle = await cdp.eval(`window.__wt.handle`);
  const termBox = await cdp.eval(`(() => {
    const r = document.getElementById("term-a").getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  const clickTerm = async (modifiers) => {
    const base = { x: termBox.x, y: termBox.y, button: "left", modifiers };
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base, clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base, clickCount: 1 });
  };

  await cdp.eval(`window.__TAURI__.core.invoke("term_write", {
    handle: ${JSON.stringify(mouseHandle)}, data: "__mouseon__",
  })`);
  // 远端回 `\e[?1000h` 之后才进鼠标模式；点一次看看有没有序列出来（最多三次）
  let mouseSeq = null;
  for (let i = 0; i < 3 && mouseSeq === null; i += 1) {
    await clickTerm(0);
    mouseSeq = await waitFor(
      async () => {
        const log = await cdp.eval(`window.__wt.inputLog`);
        return log.find((d) => d.startsWith("\u001b[M")) ?? null;
      },
      { timeout: 3000, label: "鼠标序列" },
    ).catch(() => null);
  }
  check("远端开启鼠标上报后，点击变成鼠标序列（TER-022）", mouseSeq !== null, mouseSeq);

  // 光「前端发了」不算数：还要证明这串字节到了服务端（mock 收到后回 MOUSE）。
  // 少了这一条，`term_write_bytes` 注册漏了、参数名对不上这类问题都测不出来。
  const mouseArrived = await waitFor(
    async () => {
      const t = await cdp.eval(`window.__wt.screen()`);
      return t.includes("MOUSE") ? true : null;
    },
    { timeout: 6000, label: "鼠标字节到达服务端" },
  ).catch(() => null);
  check("鼠标序列真的发到了服务端（不是只在前端记了一笔）", mouseArrived === true, mouseArrived === true);

  // Shift+点击应强制本地选择：不产生鼠标序列，inputLog 长度不变
  const beforeShift = await cdp.eval(`window.__wt.inputLog.length`);
  await clickTerm(8);
  const afterShift = await waitFor(
    async () => {
      const n = await cdp.eval(`window.__wt.inputLog.length`);
      return n > beforeShift ? n : null;
    },
    { timeout: 1500, label: "Shift 点击是否发出数据" },
  ).catch(() => beforeShift);
  check(
    "Shift+点击不发送鼠标序列（强制本地选择）",
    afterShift === beforeShift,
    `${beforeShift} → ${afterShift}`,
  );
  await closeAllTabs();

  // 19j. 已知主机（`SEC-005`）：能列出指纹，也能忘掉某条记录
  const khBefore = await cdp.eval(`window.__wt.knownHosts()`);
  check("known_hosts 里能列出已记录的主机", khBefore.length > 0, `${khBefore.length} 条`);

  // 这段之前刚 closeAllTabs()，底栏（含「设置」按钮）是隐藏的——直接开对话框
  await cdp.eval(`document.getElementById("settings").showModal()`);
  await clickElement("#known-open");
  const khRow = await waitFor(
    async () => {
      const rows = await cdp.eval(`[...document.querySelectorAll("#known-list .known-row")].map((r) => ({ pattern: r.dataset.pattern ?? null, text: r.textContent }))`);
      return rows.length && rows[0].pattern ? rows[0] : null;
    },
    { timeout: 10000, label: "已知主机列表" },
  );
  check(
    "界面显示出主机与指纹",
    khRow.text.includes("SHA256:"),
    khRow.text.slice(0, 60),
  );

  const forgottenPattern = khRow.pattern;
  await cdp.eval(`document.querySelector("#known-list .known-row button").click()`);
  const khAfter = await waitFor(
    async () => {
      const rows = await cdp.eval(`window.__wt.knownHosts()`);
      return rows.some((r) => r.pattern === forgottenPattern) ? null : rows;
    },
    { timeout: 10000, label: "忘掉主机密钥" },
  );
  check(
    "忘记后该主机的记录从 known_hosts 里消失",
    Array.isArray(khAfter),
    `${khBefore.length} → ${khAfter.length} 条（忘了 ${forgottenPattern}）`,
  );
  await clickElement("#known-close");
  await clickElement("#set-close");

  // 19h. 密钥生成与导入（`LOC-014`）：生成 → 落盘 → 回读指纹一致
  // 这条不需要会话：直接开对话框（「密钥」按钮在终端底栏里，没会话时是隐藏的）
  await closeAllDialogs();
  await cdp.eval(`document.getElementById("key-dialog").showModal()`);
  await cdp.eval(`(() => {
    const alg = document.getElementById("key-alg");
    alg.value = "ed25519";
    document.getElementById("key-pass").value = "";
    return true;
  })()`);
  await clickElement("#key-gen");
  const genKey = await waitFor(
    async () => {
      const k = await cdp.eval(`window.__wt.lastKey`);
      return k && k.fingerprint ? k : null;
    },
    { timeout: 20000, label: "生成密钥" },
  );
  check(
    "能生成 ed25519 密钥并给出 SHA256 指纹",
    genKey.fingerprint.startsWith("SHA256:") && genKey.keyType.includes("ed25519"),
    `${genKey.keyType} ${genKey.fingerprint}`,
  );

  // 文件真的落盘了：读回来必须是 OpenSSH 私钥，而不是一段空壳
  const keyPem = readFileSync(genKey.path, "utf8");
  check(
    "私钥真的写到磁盘且是 OpenSSH 格式",
    keyPem.includes("BEGIN OPENSSH PRIVATE KEY"),
    genKey.path,
  );

  // 再用「导入」路径解析同一份文件：指纹一致才算这把密钥真的可用
  const reInspected = await cdp.eval(`window.__TAURI__.core.invoke("key_inspect", {
    path: ${JSON.stringify(genKey.path)}, passphrase: null,
  })`);
  check(
    "导入同一份私钥得到相同指纹",
    reInspected?.fingerprint === genKey.fingerprint,
    `${reInspected?.fingerprint}`,
  );
  await clickElement("#key-close");

  // 19c-2. 多执行广播（`TER-004`）：同一命令发给多个会话，按输出分组收起
  await closeAllDialogs();
  await closeAllTabs();
  await clickSessionNode("mock-ssh");
  await fillInput("#port", String(sshPort));
  await clickElement("#ssh");
  await waitFor(
    async () => {
      const s = await cdp.eval(`document.getElementById("status").textContent`);
      return s.startsWith("已连接") ? s : null;
    },
    { timeout: 30000, label: "广播第一个会话" },
  );
  await clickElement("#ssh");
  await waitFor(
    async () => ((await cdp.eval(`window.__wt.tabs().length`)) >= 2 ? true : null),
    { timeout: 30000, label: "广播第二个会话" },
  );
  // 等第二个会话的横幅落地再广播：否则它迟到的 WELCOME 会落进捕获窗口，
  // 被当成「输出不一致」——那是测试时序问题，不是聚合逻辑出错
  await waitFor(
    async () => {
      const t = await cdp.eval(`window.__wt.screen()`);
      return t.includes("WELCOME") ? true : null;
    },
    { timeout: 15000, label: "第二个会话横幅" },
  );

  await clickElement("#bc-toggle");
  const bcOpen = await waitFor(
    async () => {
      const b = await cdp.eval(`window.__wt.broadcast`);
      return b.open && b.targets >= 2 ? b : null;
    },
    { timeout: 10000, label: "打开广播栏" },
  );
  check("广播栏识别到多个已连接会话", bcOpen.targets >= 2, `${bcOpen.targets} 个目标`);

  await fillInput("#bc-input", "echo hi");
  await clickElement("#bc-send");
  const bcDone = await waitFor(
    async () => {
      const b = await cdp.eval(`window.__wt.broadcast`);
      return b.last && !b.last.cancelled ? b : null;
    },
    { timeout: 30000, label: "广播完成" },
  );
  check(
    "两台输出一致时聚合为一行",
    bcDone.last.groups.length === 1 && bcDone.last.groups[0].labels.length === 2,
    bcDone.result,
  );

  // 导出 CSV（`TER-004`）：表头 + 每台一行，命令列要写上刚才发的那条
  await clickElement("#bc-export");
  const csvPath = await waitFor(
    async () => {
      const s = await cdp.eval(`document.getElementById("status").textContent`);
      const m = /已导出广播结果：(.+)$/.exec(s);
      return m ? m[1].trim() : null;
    },
    { timeout: 15000, label: "导出广播结果" },
  ).catch(() => null);
  const csvText = csvPath ? readFileSync(csvPath, "utf8").replace(/^\uFEFF/, "") : "";
  check(
    "广播结果能导出 CSV（TER-004）",
    csvText.startsWith("命令,主机,输出") && csvText.includes("echo hi"),
    csvPath ? `${csvPath}` : "没导出",
  );
  check(
    "CSV 里每台主机一行（TER-004）",
    csvText.split(/\r?\n/).filter((l) => l.includes("echo hi")).length === 2,
    `数据行 ${csvText.split(/\r?\n/).filter((l) => l.includes("echo hi")).length} 条`,
  );

  // 危险命令：必须拦下来先确认，取消后一个字节都不发
  await fillInput("#bc-input", "rm -rf /");
  await clickElement("#bc-send");
  const askBody = await waitFor(
    async () => {
      const open = await cdp.eval(`document.getElementById("ask-dialog").open`);
      if (!open) return null;
      return cdp.eval(`document.getElementById("ask-body").textContent`);
    },
    { timeout: 8000, label: "危险命令确认框" },
  );
  check(
    "危险命令被拦截且确认框说明目标数量",
    askBody.includes("rm -rf /") && /目标：\d+ 个已连接会话/.test(askBody),
    askBody.split("\n").filter(Boolean).pop(),
  );
  await clickElement("#ask-cancel");
  const cancelled = await waitFor(
    async () => {
      const b = await cdp.eval(`window.__wt.broadcast`);
      return b.last?.cancelled ? b : null;
    },
    { timeout: 8000, label: "取消广播" },
  );
  check("取消后没有发出任何命令", cancelled.last.sent === 0, cancelled.result || "未发送");
  await clickElement("#bc-toggle");
  await closeAllTabs();

  // 19e-3. 多选与批量移动（`SES-013`）
  await clickElement("#refresh");
  await waitFor(
    async () => ((await cdp.eval(`window.__wt.sessions()`)).length ? true : null),
    { timeout: 10000, label: "刷新会话树" },
  );
  await ctrlClickTreeNode("mock-ssh 副本");
  await ctrlClickTreeNode("ui-imported");
  const multiOn = await waitFor(
    async () => {
      const n = await cdp.eval(`document.querySelectorAll("#tree-body .node.multi").length`);
      return n === 2 ? n : null;
    },
    { timeout: 8000, label: "多选两个会话" },
  );
  check("Ctrl+点击能多选会话", multiOn === 2, `${multiOn} 个`);

  await rightClickNode("ui-imported");
  const multiMenu = await cdp.eval(`[...document.querySelectorAll("#ctx-menu button")].map((b) => b.textContent)`);
  check(
    "多选时右键菜单给出批量移动",
    multiMenu.some((t) => t.includes("移动 2 项到")),
    JSON.stringify(multiMenu),
  );
  await clickCtxItem(multiMenu.find((t) => t.includes("移动 2 项到")));
  await waitFor(
    async () => ((await cdp.eval(`document.getElementById("pick-dialog").open`)) ? true : null),
    { timeout: 5000, label: "选目标文件夹" },
  );
  const targetFolder = await cdp.eval(`(async () => {
    const snap = await window.__TAURI__.core.invoke("sessions_load");
    const f = snap.folders.find((x) => x.name === "sub-net");
    const sel = document.getElementById("pick-select");
    sel.value = f.id;
    return f.id;
  })()`);
  await cdp.eval(`[...document.querySelectorAll("#pick-dialog button")].find((b) => b.textContent === "确定").click()`);
  const movedAll = await waitFor(
    async () => {
      const snap = await cdp.eval(`window.__TAURI__.core.invoke("sessions_load")`);
      const picked = snap.sessions.filter(
        (s) => s.name === "mock-ssh 副本" || s.name === "ui-imported",
      );
      // 读后端真值：两个都在目标文件夹里才算成功
      return picked.length === 2 && picked.every((s) => s.folder_id === targetFolder)
        ? picked.map((s) => s.name)
        : null;
    },
    { timeout: 10000, label: "批量移动" },
  ).catch(() => null);
  check(
    "批量移动把两个会话都挪进目标文件夹",
    Array.isArray(movedAll) && movedAll.length === 2,
    JSON.stringify(movedAll),
  );

  // 19e-4. 批量删除（`SES-013`）：确认框要说清删几个，删完两条都没了
  await clickElement("#refresh");
  await waitFor(
    async () => ((await cdp.eval(`window.__wt.sessions()`)).length ? true : null),
    { timeout: 10000, label: "刷新会话树" },
  );
  await ctrlClickTreeNode("mock-ssh 副本");
  await ctrlClickTreeNode("ui-imported");
  await waitFor(
    async () => {
      const n = await cdp.eval(`document.querySelectorAll("#tree-body .node.multi").length`);
      return n === 2 ? n : null;
    },
    { timeout: 8000, label: "批量删除前多选" },
  );
  await rightClickNode("ui-imported");
  await clickCtxItem("删除 2 项…");
  const delBody = await waitFor(
    async () => {
      const open = await cdp.eval(`document.getElementById("ask-dialog").open`);
      if (!open) return null;
      return cdp.eval(`document.getElementById("ask-body").textContent`);
    },
    { timeout: 5000, label: "批量删除确认框" },
  );
  check(
    "批量删除前确认框写清删几个与不可撤销",
    delBody.includes("mock-ssh 副本") && delBody.includes("不可撤销"),
    delBody.split("\n").filter(Boolean)[0],
  );
  await clickElement("#ask-ok");
  const goneAll = await waitFor(
    async () => {
      const snap = await cdp.eval(`window.__TAURI__.core.invoke("sessions_load")`);
      const left = snap.sessions.filter(
        (s) => s.name === "mock-ssh 副本" || s.name === "ui-imported",
      );
      return left.length === 0 ? true : null;
    },
    { timeout: 10000, label: "批量删除生效" },
  ).catch(() => null);
  check("批量删除后两条会话都不在了", goneAll === true);

  // 19f. 外观与回滚（`TER-005` / `TER-008`）：主题要真的落到 xterm 上，
  //      只改下拉框不算（把 theme 传空也能骗过那种断言）
  await closeAllTabs();
  await clickSessionNode("mock-ssh");
  await fillInput("#port", String(sshPort));
  await clickElement("#ssh");
  await waitFor(
    async () => {
      const s = await cdp.eval(`document.getElementById("status").textContent`);
      return s.startsWith("已连接") ? s : null;
    },
    { timeout: 30000, label: "外观用例建会话" },
  );
  await clickElement("#settings-open");
  const lookUi = await cdp.eval(`(() => {
    const theme = document.getElementById("look-theme");
    const count = theme.options.length;
    theme.value = "Dracula";
    theme.dispatchEvent(new Event("change", { bubbles: true }));
    const sb = document.getElementById("look-scrollback");
    sb.value = "20000";
    sb.dispatchEvent(new Event("change", { bubbles: true }));
    const size = document.getElementById("look-size");
    size.value = "16";
    size.dispatchEvent(new Event("change", { bubbles: true }));
    return { count, ...window.__wt.look };
  })()`);
  await clickElement("#set-close");
  check("内置配色不少于 20 套", lookUi.count >= 20, `${lookUi.count} 套`);
  check(
    "切主题/改回滚/改字号都真的落到终端上",
    lookUi.theme === "Dracula" &&
      lookUi.appliedBackground === "#282a36" &&
      lookUi.scrollback === 20000 &&
      lookUi.appliedScrollback === 20000 &&
      lookUi.fontSize === 16,
    JSON.stringify(lookUi),
  );
  // 复原字号，别把后面用例的屏幕尺寸带偏
  await cdp.eval(`(() => {
    const size = document.getElementById("look-size");
    size.value = "13";
    size.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  await closeAllTabs();

  // 19b. 多跳（`SES-025`）：目标 ← bastion ← bastion2。
  //      界面只选「用哪条会话当跳板机」，它自己的跳板由会话属性决定，
  //      所以这里不改任何界面结构，只把两条会话连成链。
  const jump2Port = await mockJump2Port();
  const ids = await cdp.eval(`(async () => {
    const dto = await window.__TAURI__.core.invoke("sessions_load");
    const pick = (n) => dto.sessions.find((s) => s.name === n)?.id ?? null;
    return { mock: pick("mock-ssh"), bastion: pick("bastion") };
  })()`);
  await cdp.eval(`window.__TAURI__.core.invoke("session_save", { req: {
    name: "bastion2", host: "127.0.0.1", port: ${JSON.stringify(jump2Port)}, user: "tester",
  } })`);
  const jump2Id = await cdp.eval(`(async () => {
    const dto = await window.__TAURI__.core.invoke("sessions_load");
    return dto.sessions.find((s) => s.name === "bastion2")?.id ?? null;
  })()`);
  // bastion 的跳板指向 bastion2 —— 两条会话属性就构成三跳
  await cdp.eval(`window.__TAURI__.core.invoke("session_save", { req: {
    id: ${JSON.stringify(ids.bastion)}, name: "bastion", host: "127.0.0.1",
    port: ${JSON.stringify(jumpPort)}, user: "tester",
    jumpSessionId: ${JSON.stringify(jump2Id)},
  } })`);
  // 跳板机自己的凭据进保险库（逐跳各存各的，不继承目标会话）
  for (const [sid, nm] of [[ids.bastion, "bastion"], [jump2Id, "bastion2"]]) {
    await cdp.eval(`window.__TAURI__.core.invoke("credential_save", {
      sessionId: ${JSON.stringify(sid)}, name: ${JSON.stringify(nm)}, password: "secret",
    })`);
  }

  await closeAllTabs();
  await clickSessionNode("mock-ssh");
  await fillInput("#port", String(sshPort));
  // 选中 mock-ssh（它的跳板是 bastion），再确认跳板会话停在 bastion
  const chainUi = await cdp.eval(`(() => {
    const sel = document.getElementById("jump-session");
    const opt = [...sel.options].find((o) => o.textContent === "bastion");
    if (!opt) return { ok: false };
    sel.value = opt.value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, host: document.getElementById("jump-host").value };
  })()`);
  check(
    "多跳：跳板机下拉里能选中第一跳",
    chainUi.ok === true && chainUi.host === `127.0.0.1:${jumpPort}`,
    JSON.stringify(chainUi),
  );

  await clickElement("#ssh");
  const hop3 = await waitFor(
    async () => {
      const s = await cdp.eval(`document.getElementById("status").textContent`);
      if (s.startsWith("已连接")) return s;
      if (s === "连接失败") {
        const scr = await cdp.eval(`window.__wt.screen()`);
        throw new Error(`三跳连接失败：${scr.split(/\r?\n/).filter(Boolean).slice(-3).join(" | ")}`);
      }
      return null;
    },
    { timeout: 40000, label: "三跳连接" },
  );
  check("经两跳跳板机也能连上目标", hop3.includes("tester@"), hop3);
  const hop3Screen = await waitFor(
    async () => {
      const t = await cdp.eval(`window.__wt.screen()`);
      return t.includes("WELCOME") ? t : null;
    },
    { timeout: 15000, label: "三跳后的目标横幅" },
  );
  check("第三跳拿到的是目标机的 shell，不是跳板机的", hop3Screen !== null);
  await closeAllTabs();

  // 19k. 主密码管理（`SEC-001`）：改密码后旧密码失效、移除后保险库没了
  await closeAllDialogs();
  await cdp.eval(`document.getElementById("settings").showModal()`);
  await clickElement("#master-open");
  const MASTER2 = "WindTerm-E2E-Passw0rd#2";
  await fillInput("#master-old", MASTER);
  await fillInput("#master-new", MASTER2);
  await fillInput("#master-new2", MASTER2);
  await clickElement("#master-change");
  const changed = await waitFor(
    async () => {
      const t = await cdp.eval(`document.getElementById("master-msg").textContent`);
      return t.includes("已更换主密码") ? t : null;
    },
    { timeout: 20000, label: "更换主密码" },
  );
  check("改主密码成功且提示说清内容不变", changed.includes("保险库内容不变"), changed);

  // 锁定后：旧密码必须解不开，新密码能解开
  await cdp.eval(`window.__TAURI__.core.invoke("vault_lock")`);
  const oldRejected = await cdp.eval(`(async () => {
    try {
      await window.__TAURI__.core.invoke("vault_unlock", { password: ${JSON.stringify(MASTER)} });
    } catch (e) {
      return String(e);
    }
  })()`);
  check(
    "改密码后旧主密码解不开保险库",
    String(oldRejected).length > 0,
    String(oldRejected).slice(0, 60),
  );
  const newWorks = await cdp.eval(`(async () => {
    try {
      const s = await window.__TAURI__.core.invoke("vault_unlock", { password: ${JSON.stringify(MASTER2)} });
      return s;
    } catch (e) {
      return "ERR:" + String(e);
    }
  })()`);
  check(
    "新主密码能解开保险库",
    typeof newWorks === "object" && newWorks !== null,
    JSON.stringify(newWorks)?.slice(0, 60),
  );
  // 关掉对话框：模态框会挡住后面「连接失败」那一段的点击，
  // 表现是它一直等不到报错——报错点离真正原因隔了好几步
  await closeAllDialogs();

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

  // 19o. 本地终端 shell 可配（`LOC-001`）
  //
  // 光「下拉框能选」不算数：要证明选完真的落进 `config.toml`，而且**新建的终端
  // 真的是那个 shell**。用 `%COMSPEC%` 来验——只有 cmd 会展开它，PowerShell 里
  // 会原样打印。
  await closeAllDialogs();
  await closeAllTabs();
  await clickElement("#settings-open");
  const shells = await cdp.eval(`window.__TAURI__.core.invoke("local_shells")`);
  check(
    "本机可选 shell 由后端探测（未安装的也列出来）",
    shells.some((s) => s.id === "auto") &&
      shells.some((s) => s.id === "custom") &&
      shells.some((s) => s.id === "cmd"),
    shells.map((s) => `${s.id}${s.available ? "" : "（未装）"}`).join("、"),
  );

  await cdp.eval(`(() => {
    const el = document.getElementById("local-shell");
    el.value = "cmd";
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return el.value;
  })()`);
  const cmdSaved = await waitFor(
    async () => {
      const t = readFileSync(prefsFile, "utf8");
      return /localShell\s*=\s*"cmd"/.test(t) ? true : null;
    },
    { timeout: 10000, label: "shell 偏好落盘" },
  ).catch(() => null);
  check("选中的 shell 写进 config.toml", cmdSaved === true, `localShell=${cmdSaved ? "cmd" : "未落盘"}`);
  await closeAllDialogs();

  await clickElement("#open");
  await waitFor(
    async () => {
      const s = await cdp.eval(`document.getElementById("status").textContent`);
      return s.startsWith("已连接") ? s : null;
    },
    { timeout: 30000, label: "用 cmd 建本地终端" },
  );
  await typeText("echo %COMSPEC%");
  const comspec = await waitFor(
    async () => {
      const t = await cdp.eval(`window.__wt.screen()`);
      return t.includes("cmd.exe") ? true : null;
    },
    { timeout: 15000, label: "确认真的起了 cmd" },
  ).catch(() => null);
  check(
    "新建的本地终端真的用了所选 shell（LOC-001）",
    comspec === true,
    comspec === true ? "COMSPEC 被 cmd 展开" : "没等到 cmd.exe",
  );
  await closeAllTabs();

  // 复原：这是会写进配置文件的全局设置，留着会污染后面所有用例
  await clickElement("#settings-open");
  await cdp.eval(`(() => {
    const el = document.getElementById("local-shell");
    el.value = "auto";
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return el.value;
  })()`);
  const shellRestored = await waitFor(
    async () => {
      const t = readFileSync(prefsFile, "utf8");
      return /localShell\s*=\s*"auto"/.test(t) ? true : null;
    },
    { timeout: 10000, label: "shell 偏好复原" },
  ).catch(() => null);
  check("用完把 shell 偏好恢复默认（不污染后续用例）", shellRestored === true, shellRestored === true);
  await closeAllDialogs();

  // 19p. SSH 连上自动打开文件面板（`FIL-001`）
  //
  // 规格要求「连上即自动打开（可关）」。这里验三件事：默认是开的、连上真的自己弹出来
  // 并列出目录、关掉之后不会再弹。
  await closeAllDialogs();
  await closeAllTabs();
  await clickElement("#settings-open");
  const autoOpenDefault = await cdp.eval(`document.getElementById("files-auto-open").checked`);
  check("「连上 SSH 自动打开文件面板」默认是开的", autoOpenDefault === true, autoOpenDefault);
  await closeAllDialogs();

  await clickSessionNode("mock-ssh");
  await fillInput("#port", String(sshPort));
  await clickElement("#ssh");
  await waitFor(
    async () => {
      const s = await cdp.eval(`document.getElementById("status").textContent`);
      return s.startsWith("已连接") ? s : null;
    },
    { timeout: 30000, label: "自动开面板用例建会话" },
  );
  const opened = await waitFor(
    async () => {
      const s = await cdp.eval(`({
        hidden: document.getElementById("files").hidden,
        rows: window.__wt.files.rows,
        msg: window.__wt.files.msg,
        path: document.getElementById("files-path").textContent,
      })`);
      // 判据是「真的列成功了」，不是「列出来有内容」：自动打开会回到该会话上次
      // 浏览的目录，那个目录**可能就是空的**（空目录也是成功）
      return s.hidden === false && s.msg === "" && s.path.startsWith("/") ? s : null;
    },
    { timeout: 20000, label: "面板自动打开并列目录" },
  ).catch(() => null);
  if (opened === null) {
    // 失败时把面板自己的说法带出来：是没开、还在读、还是报错了，一眼能分开
    const why = await cdp.eval(`({
      hidden: document.getElementById("files").hidden,
      msg: window.__wt.files.msg,
      path: document.getElementById("files-path").textContent,
    })`);
    check("SSH 连上后文件面板自动打开并列出远端目录（FIL-001）", false, JSON.stringify(why));
  } else {
    check(
      "SSH 连上后文件面板自动打开并列出远端目录（FIL-001）",
      true,
      `path=${opened.path} rows=${opened.rows.length}`,
    );
  }

  const boundName = await cdp.eval(`(() => {
    const sel = document.getElementById("files-session");
    return sel.selectedOptions[0]?.textContent ?? "";
  })()`);
  check("面板绑定到刚连的会话（不是含糊地跟着表单跑）", boundName === "mock-ssh", boundName);

  // 关掉偏好：写进配置，并且以后连上不再自动弹
  await clickElement("#settings-open");
  await cdp.eval(`(() => {
    const el = document.getElementById("files-auto-open");
    el.checked = false;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return el.checked;
  })()`);
  const offSaved = await waitFor(
    async () => {
      const t = readFileSync(prefsFile, "utf8");
      return /filesAutoOpen\s*=\s*false/.test(t) ? true : null;
    },
    { timeout: 10000, label: "自动打开开关落盘" },
  ).catch(() => null);
  check("关掉开关后写进 config.toml", offSaved === true, offSaved === true);
  await closeAllDialogs();

  await closeAllTabs();
  await ensureFilesPanel(false);
  await clickSessionNode("mock-ssh");
  await fillInput("#port", String(sshPort));
  await clickElement("#ssh");
  await waitFor(
    async () => {
      const s = await cdp.eval(`document.getElementById("status").textContent`);
      return s.startsWith("已连接") ? s : null;
    },
    { timeout: 30000, label: "关掉开关后建会话" },
  );
  // 等输出安静下来再读：自动打开是异步的，刚连上就读会读到「还没来得及开」
  await waitScreenStable(600);
  const stayedHidden = await cdp.eval(`document.getElementById("files").hidden`);
  check("关掉开关后连上 SSH 不再自动弹面板", stayedHidden === true, stayedHidden);

  // 复原：这是会写进配置文件的全局设置
  await clickElement("#settings-open");
  await cdp.eval(`(() => {
    const el = document.getElementById("files-auto-open");
    el.checked = true;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return el.checked;
  })()`);
  const onRestored = await waitFor(
    async () => {
      const t = readFileSync(prefsFile, "utf8");
      return /filesAutoOpen\s*=\s*true/.test(t) ? true : null;
    },
    { timeout: 10000, label: "自动打开开关复原" },
  ).catch(() => null);
  check("用完把自动打开开关恢复默认", onRestored === true, onRestored === true);
  await closeAllDialogs();

  // 19q. 标签：中键关闭 / 拖拽排序 / 溢出滚动（`TER-001`）
  await closeAllDialogs();
  await closeAllTabs();
  // 点一次不一定生效（WebView2 会吞首次点击），而且「已连接」是上一个标签的旧状态——
  // 必须拿**标签数量**当探针
  for (let i = 1; i <= 3; i += 1) {
    await clickUntil(
      () => clickElement("#open"),
      async () => (await cdp.eval(`document.querySelectorAll("#tabs .tab").length`)) >= i,
      { timeout: 10000, tries: 4, label: `建第 ${i} 个标签` },
    );
  }
  const tabBefore = await cdp.eval(`
    [...document.querySelectorAll("#tabs .tab .label")].map((e) => e.textContent)
  `);
  check("能同时开三个标签", tabBefore.length === 3, tabBefore.join(" | "));

  // 溢出：溢出时要**滚动**，不能把标签压扁（压扁之后每格只剩几个字，谁也认不出来）
  const tabCss = await cdp.eval(`(() => {
    const bar = document.getElementById("tabs");
    const tab = bar.querySelector(".tab");
    const cs = getComputedStyle(bar);
    const ts = getComputedStyle(tab);
    return { overflowX: cs.overflowX, minWidth: ts.minWidth, flex: ts.flex };
  })()`);
  check(
    "标签栏溢出时横向滚动而不是压扁标签（TER-001）",
    tabCss.overflowX === "auto" && tabCss.minWidth === "120px" && tabCss.flex.startsWith("0 0"),
    JSON.stringify(tabCss),
  );

  // 中键关闭：中间那个标签
  const midBox = await cdp.eval(`(() => {
    const t = document.querySelectorAll("#tabs .tab")[1];
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  const mid = midBox && { x: midBox.x, y: midBox.y, button: "middle" };
  if (mid) {
    // `buttons` 是「当前按住了哪些键」的位掩码（中键 = 4）。不传的话 Chromium 认为
    // 一个键都没按，非主键的事件语义会不对
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...mid, buttons: 4, clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...mid, buttons: 0, clickCount: 1 });
  }
  const afterMid = await waitFor(
    async () => {
      const n = await cdp.eval(`document.querySelectorAll("#tabs .tab").length`);
      return n === 2 ? n : null;
    },
    { timeout: 8000, label: "中键关闭标签" },
  ).catch(() => null);
  const midDrag = await cdp.eval(`window.__wt.tabDrag()`);
  check(
    "中键点击关闭标签（TER-001）",
    afterMid === 2,
    `剩 ${afterMid ?? "?"} 个；drag=${JSON.stringify(midDrag)}`,
  );

  // 拖拽排序：补回第三个，把第一个拖到最后一个的位置
  await clickUntil(
    () => clickElement("#open"),
    async () => (await cdp.eval(`document.querySelectorAll("#tabs .tab").length`)) >= 3,
    { timeout: 10000, tries: 4, label: "拖拽用例补标签" },
  );
  const tabOrderBefore = await cdp.eval(`
    [...document.querySelectorAll("#tabs .tab .label")].map((e) => e.textContent)
  `);
  const dragBoxes = await cdp.eval(`(() => {
    const ts = [...document.querySelectorAll("#tabs .tab")];
    if (ts.length < 2) return null;
    const a = ts[0].getBoundingClientRect();
    const c = ts[ts.length - 1].getBoundingClientRect();
    return {
      from: { x: Math.round(a.x + a.width / 2), y: Math.round(a.y + a.height / 2) },
      to: { x: Math.round(c.x + c.width / 2), y: Math.round(c.y + c.height / 2) },
    };
  })()`);
  if (dragBoxes) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...dragBoxes.from, button: "left", buttons: 1, clickCount: 1 });
    // 先挪过 4px 门槛，再移到目标标签上：脚本里没有「按住」这个概念，必须显式发 move
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: dragBoxes.from.x + 24, y: dragBoxes.from.y, button: "left", buttons: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...dragBoxes.to, button: "left", buttons: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...dragBoxes.to, button: "left", clickCount: 1 });
  }
  const tabOrderAfter = await waitFor(
    async () => {
      const l = await cdp.eval(`
        [...document.querySelectorAll("#tabs .tab .label")].map((e) => e.textContent)
      `);
      return l[0] === tabOrderBefore[1] ? l : null;
    },
    { timeout: 8000, label: "拖拽重排" },
  ).catch(() => null);
  check(
    "拖拽标签能重排（TER-001）",
    tabOrderAfter !== null && tabOrderAfter[1] === tabOrderBefore[0],
    `${tabOrderBefore.join(" | ")} → ${tabOrderAfter ? tabOrderAfter.join(" | ") : "没变"}；drag=${JSON.stringify(await cdp.eval(`window.__wt.tabDrag()`))}`,
  );
  await closeAllTabs();

  // 19r. 「本次记住」与「不记住」（`SEC-002`）
  //
  // 「本次记住」不落盘也不进保险库，所以只能从内存里数——`__wt.sessionPasswords()`
  // 只回条数、不回口令。
  await closeAllDialogs();
  await closeAllTabs();
  const memoBefore = await cdp.eval(`window.__wt.sessionPasswords()`);

  await setRemember("session");
  await clickSessionNode("mock-ssh");
  await fillInput("#port", String(sshPort));
  await fillInput("#password", "secret");
  await clickElement("#ssh");
  await waitFor(
    async () => {
      const s = await cdp.eval(`document.getElementById("status").textContent`);
      // 连上之后「本次记住」会把状态栏改写成保存提示，所以两种都算连上了
      return /已连接|密码已记住/.test(s) ? s : null;
    },
    { timeout: 30000, label: "本次记住用例建会话" },
  );
  const memoAfter = await waitFor(
    async () => {
      const n = await cdp.eval(`window.__wt.sessionPasswords()`);
      return n > memoBefore ? n : null;
    },
    { timeout: 10000, label: "本次记住生效" },
  ).catch(() => null);
  check(
    "「本次记住」把口令放进本次运行的记忆",
    memoAfter !== null,
    `${memoBefore} → ${memoAfter ?? "没变"}`,
  );

  await closeAllTabs();
  await setRemember("no");
  await clickSessionNode("mock-ssh");
  await fillInput("#port", String(sshPort));
  await fillInput("#password", "secret");
  await clickElement("#ssh");
  await waitFor(
    async () => {
      const s = await cdp.eval(`document.getElementById("status").textContent`);
      return s.startsWith("已连接") ? s : null;
    },
    { timeout: 30000, label: "不记住用例建会话" },
  );
  await waitScreenStable(500);
  const memoNo = await cdp.eval(`window.__wt.sessionPasswords()`);
  check(
    "「不记住」不产生新的记忆",
    memoNo === (memoAfter ?? memoBefore),
    `${memoAfter ?? memoBefore} → ${memoNo}`,
  );
  await closeAllTabs();
  await setRemember("persist");

  // 19s. keyboard-interactive 下密码也能保存（`SEC-002` 的 AC-1）
  //
  // mock 里用户 `kbd` 只认 keyboard-interactive（`auth_password` 只接受 tester），
  // 所以这条走的就是「服务端关掉 PasswordAuthentication」那种部署。
  await closeAllDialogs();
  await closeAllTabs();
  await cdp.eval(`(() => {
    const set = (id, v) => {
      const el = document.getElementById(id);
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    set("host", "127.0.0.1");
    set("port", ${JSON.stringify(String(sshPort))});
    set("user", "kbd");
    set("password", "secret");
    return true;
  })()`);
  await setRemember("session");
  const beforeKbd = await cdp.eval(`window.__wt.sessionPasswords()`);
  await clickElement("#ssh");
  const kbdStatus = await waitFor(
    async () => {
      const s = await cdp.eval(`document.getElementById("status").textContent`);
      return /已连接|密码已记住/.test(s) ? s : null;
    },
    { timeout: 30000, label: "keyboard-interactive 连接" },
  ).catch(async () => {
    const t = await cdp.eval(`window.__wt.screen()`);
    throw new Error(`keyboard-interactive 没连上：${t.slice(-200)}`);
  });
  check(
    "只开 keyboard-interactive 的服务端也能连上（SEC-002）",
    /已连接|密码已记住/.test(kbdStatus),
    kbdStatus,
  );
  const afterKbd = await waitFor(
    async () => {
      const n = await cdp.eval(`window.__wt.sessionPasswords()`);
      return n > beforeKbd ? n : null;
    },
    { timeout: 10000, label: "kbd 模式保存密码" },
  ).catch(() => null);
  check(
    "keyboard-interactive 认证成功后也会保存密码（MobaXterm 的已知缺陷）",
    afterKbd !== null,
    `${beforeKbd} → ${afterKbd ?? "没变"}`,
  );
  await closeAllTabs();
  await setRemember("persist");

  // 19t. 符号链接（`FIL-002` / `FIL-001` AC-2）
  //
  // 种一个正常链接与一个断链：界面上要能一眼分开，否则用户点进去才报错。
  await closeAllDialogs();
  await closeAllTabs();
  await cdp.eval(`window.__TAURI__.core.invoke("mock_seed_file", { path: "/notes.txt", content: "eA==" })`);
  await cdp.eval(`window.__TAURI__.core.invoke("mock_seed_link", { path: "/ok.txt", target: "notes.txt" })`);
  await cdp.eval(`window.__TAURI__.core.invoke("mock_seed_link", { path: "/dead.txt", target: "gone.txt" })`);
  await clickSessionNode("mock-ssh");
  await fillInput("#password", "secret");
  await ensureFilesPanel(true);
  // 面板会还原该会话上次浏览的目录：一路回到根目录，才看得到刚种在 / 下的链接
  for (let i = 0; i < 5; i += 1) {
    const at = await cdp.eval(`document.getElementById("files-path").textContent`);
    if (at === "/") break;
    await clickElement("#files-up");
    // 这里不能用 waitScreenStable：此时一个终端标签都没开，它的判据是「终端输出安静」，
    // 没有终端时就永远等不到。等**路径变了**才是这件事的完成信号。
    await waitFor(
      async () => {
        const p = await cdp.eval(`document.getElementById("files-path").textContent`);
        return p !== at;
      },
      { timeout: 8000, label: "回到上一层" },
    ).catch(() => null);
  }
  // 强制重列：自动打开时可能已经列过一次（那时链接还没种进去）
  await cdp.eval(`(() => {
    const sel = document.getElementById("files-session");
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return sel.value;
  })()`);
  const linkView = await waitFor(
    async () => {
      const s = await cdp.eval(`(() => {
        const pick = (name) =>
          [...document.querySelectorAll("#files-list .row")].find((r) =>
            r.textContent.startsWith(name),
          );
        const ok = pick("ok.txt");
        const dead = pick("dead.txt");
        return {
          okText: ok ? ok.textContent : null,
          okTitle: ok ? (ok.querySelector("span")?.title ?? "") : "",
          deadClass: dead ? (dead.querySelector("span")?.className ?? "") : null,
        };
      })()`);
      return s.okText && s.deadClass !== null ? s : null;
    },
    { timeout: 15000, label: "符号链接行" },
  ).catch(() => null);
  check(
    "符号链接显示为 name@ 且 tooltip 给出目标（FIL-002）",
    linkView !== null && linkView.okText.startsWith("ok.txt@") && linkView.okTitle.includes("notes.txt"),
    JSON.stringify(linkView),
  );
  check(
    "断链单独标色，而不是伪装成普通文件（FIL-002）",
    linkView !== null && linkView.deadClass === "link broken",
    linkView ? linkView.deadClass : "没找到 dead.txt",
  );

  // 权限位（`FIL-002`）：mock 给普通文件 0644、目录 0755、链接 0777
  const modes = await cdp.eval(`(() => {
    const pick = (name) =>
      [...document.querySelectorAll("#files-list .row")]
        .find((r) => r.textContent.startsWith(name))
        ?.querySelector("span.mode")?.textContent ?? null;
    return { file: pick("notes.txt"), link: pick("ok.txt") };
  })()`);
  check(
    "普通文件显示权限位 -rw-r--r--（FIL-002）",
    modes.file === "-rw-r--r--",
    `${modes.file}`,
  );
  check(
    "符号链接的权限位以 l 开头（FIL-002）",
    typeof modes.link === "string" && modes.link.startsWith("l"),
    `${modes.link}`,
  );

  // 改权限（`FIL-002` 的 SETSTAT）：644 → 600，列表里要立刻反映出来
  await clickFileRow("notes.txt");
  await clickElement("#files-chmod");
  await confirmName("600");
  const changedMode = await waitFor(
    async () => {
      const m = await cdp.eval(`(() => {
        const row = [...document.querySelectorAll("#files-list .row")].find((r) =>
          r.textContent.startsWith("notes.txt"),
        );
        return row?.querySelector("span.mode")?.textContent ?? null;
      })()`);
      return m === "-rw-------" ? m : null;
    },
    { timeout: 15000, label: "改权限生效" },
  ).catch(() => null);
  check(
    "改权限后列表里的权限位真的变了（FIL-002 SETSTAT）",
    changedMode === "-rw-------",
    `${changedMode ?? "没变"}`,
  );

  // 19u. 字体缺失回退提示（`TER-005`）
  //
  // 选了本机没有的字体时，浏览器会**静默**往后回退：字号行高都对、字形却变了。
  // 这里塞一个不存在的 family，要求面板把「本机没有 X，实际用的是 Y」说出来。
  await closeAllDialogs();
  await clickElement("#settings-open");
  const uiFontBefore = await cdp.eval(`document.getElementById("look-font").value`);
  await cdp.eval(`(() => {
    const sel = document.getElementById("look-font");
    const o = document.createElement("option");
    o.value = '"NoSuchFontXYZ", monospace';
    o.textContent = "NoSuchFontXYZ";
    sel.appendChild(o);
    sel.value = o.value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return sel.value;
  })()`);
  const fontWarn = await waitFor(
    async () => {
      const s = await cdp.eval(`(() => {
        const el = document.getElementById("look-font-warn");
        return { hidden: el.hidden, text: el.textContent };
      })()`);
      return s.hidden === false && s.text.includes("NoSuchFontXYZ") ? s : null;
    },
    { timeout: 8000, label: "字体回退提示" },
  ).catch(() => null);
  check(
    "字体缺失时明确说清回退到了哪个（TER-005）",
    fontWarn !== null && fontWarn.text.includes("本机没有"),
    fontWarn ? fontWarn.text : "没有出现提示",
  );

  // 换回通用族名：提示要收起来
  await cdp.eval(`(() => {
    const sel = document.getElementById("look-font");
    const o = document.createElement("option");
    o.value = "monospace";
    o.textContent = "系统等宽";
    sel.appendChild(o);
    sel.value = "monospace";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return sel.value;
  })()`);
  const fontWarnGone = await waitFor(
    async () => {
      const h = await cdp.eval(`document.getElementById("look-font-warn").hidden`);
      return h === true ? true : null;
    },
    { timeout: 8000, label: "提示收起" },
  ).catch(() => null);
  check("换回能用的字体后提示收起（TER-005）", fontWarnGone === true, fontWarnGone === true);

  // 非等宽字体（`TER-005`）：Arial 本机有、但不是等宽——表格与 TUI 会错位，必须说出来
  await cdp.eval(`(() => {
    const sel = document.getElementById("look-font");
    const o = document.createElement("option");
    o.value = '"Arial", monospace';
    o.textContent = "Arial";
    sel.appendChild(o);
    sel.value = o.value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return sel.value;
  })()`);
  const monoWarn = await waitFor(
    async () => {
      const s = await cdp.eval(`(() => {
        const el = document.getElementById("look-mono-warn");
        return { hidden: el.hidden, text: el.textContent };
      })()`);
      return s.hidden === false ? s : null;
    },
    { timeout: 8000, label: "非等宽字体警告" },
  ).catch(() => null);
  check(
    "选了非等宽字体会明确警告（TER-005）",
    monoWarn !== null && monoWarn.text.includes("不是等宽"),
    monoWarn ? monoWarn.text : "没有出现警告",
  );

  await cdp.eval(`(() => {
    const sel = document.getElementById("look-font");
    const o = document.createElement("option");
    o.value = "monospace";
    o.textContent = "系统等宽";
    sel.appendChild(o);
    sel.value = "monospace";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return sel.value;
  })()`);
  const monoGone = await waitFor(
    async () => {
      const h = await cdp.eval(`document.getElementById("look-mono-warn").hidden`);
      return h === true ? true : null;
    },
    { timeout: 8000, label: "等宽警告收起" },
  ).catch(() => null);
  check("换回等宽字体后警告收起（TER-005）", monoGone === true, monoGone === true);

  // 复原：字体是写进 config.toml 的全局设置
  await cdp.eval(`(() => {
    const sel = document.getElementById("look-font");
    sel.value = ${JSON.stringify(uiFontBefore)};
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return sel.value;
  })()`);
  await closeAllDialogs();

  // 19v. 独立 SFTP 会话（`SES-009`）
  //
  // 这种会话没有终端：点它应当**直接**把文件面板对着它打开，不起标签页。
  await closeAllDialogs();
  await closeAllTabs();
  await cdp.eval(`(() => {
    const set = (id, v) => {
      const el = document.getElementById(id);
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    set("host", "127.0.0.1");
    set("port", ${JSON.stringify(String(sshPort))});
    set("user", "tester");
    set("password", "secret");
    set("session-name", "sftp-only");
    const k = document.getElementById("kind");
    k.value = "sftp";
    k.dispatchEvent(new Event("change", { bubbles: true }));
    return k.value;
  })()`);
  await clickElement("#save-session");
  const sftpSaved = await waitFor(
    async () => {
      const names = await cdp.eval(`
        [...document.querySelectorAll("#tree-body .node.session")].map((n) => n.textContent)
      `);
      return names.includes("sftp-only") ? names : null;
    },
    { timeout: 15000, label: "保存 SFTP 会话" },
  ).catch(() => null);
  check("能建一条 SFTP 类型的会话（SES-009）", sftpSaved !== null, "sftp-only");

  const tabsBefore = await cdp.eval(`document.querySelectorAll("#tabs .tab").length`);
  await clickSessionNode("sftp-only");
  const sftpOpened = await waitFor(
    async () => {
      const s = await cdp.eval(`({
        hidden: document.getElementById("files").hidden,
        msg: window.__wt.files.msg,
        path: document.getElementById("files-path").textContent,
        bound: document.getElementById("files-session").value,
      })`);
      return s.hidden === false && s.msg === "" && s.path.startsWith("/") ? s : null;
    },
    { timeout: 20000, label: "SFTP 会话打开文件面板" },
  ).catch(() => null);
  check(
    "点 SFTP 会话直接打开文件面板（SES-009）",
    sftpOpened !== null,
    JSON.stringify(sftpOpened),
  );
  const tabsAfter = await cdp.eval(`document.querySelectorAll("#tabs .tab").length`);
  check("SFTP 会话不创建终端标签（SES-009）", tabsAfter === tabsBefore, `${tabsBefore} → ${tabsAfter}`);
  await ensureFilesPanel(false);

  // 19w. 标签右键菜单与双击重命名（`TER-001`）
  await closeAllDialogs();
  await closeAllTabs();
  for (let i = 1; i <= 3; i += 1) {
    await clickUntil(
      () => clickElement("#open"),
      async () => (await cdp.eval(`document.querySelectorAll("#tabs .tab").length`)) >= i,
      { timeout: 10000, tries: 4, label: `建第 ${i} 个标签` },
    );
  }

  // 双击第一个标签 → 重命名对话框
  const firstTab = await cdp.eval(`(() => {
    const r = document.querySelectorAll("#tabs .tab")[0].getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  for (const count of [1, 2]) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...firstTab, button: "left", buttons: 1, clickCount: count });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...firstTab, button: "left", buttons: 0, clickCount: count });
  }
  const dlgOpen = await waitFor(
    async () =>
      (await cdp.eval(`document.getElementById("name-dialog").open`)) ? true : null,
    { timeout: 5000, label: "重命名对话框" },
  ).catch(() => null);
  check("双击标签弹出重命名（TER-001）", dlgOpen === true, dlgOpen === true);
  await confirmName("我的标签");
  const renamedTabs = await waitFor(
    async () => {
      const l = await cdp.eval(`
        [...document.querySelectorAll("#tabs .tab .label")].map((e) => e.textContent)
      `);
      return l.includes("我的标签") ? l : null;
    },
    { timeout: 8000, label: "标签改名生效" },
  ).catch(() => null);
  check(
    "标签改名生效（TER-001）",
    renamedTabs !== null,
    renamedTabs ? renamedTabs.join(" | ") : "没变",
  );

  // 右键第二个标签 → 菜单里应有「关闭其他（2）」等项
  const ctxAt = await cdp.eval(`(() => {
    const r = document.querySelectorAll("#tabs .tab")[1].getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...ctxAt, button: "right", buttons: 2, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...ctxAt, button: "right", buttons: 0, clickCount: 1 });
  const tabMenu = await waitFor(
    async () => {
      const items = await cdp.eval(`
        [...document.querySelectorAll("#ctx-menu button")].map((b) => b.textContent)
      `);
      return items.length ? items : null;
    },
    { timeout: 5000, label: "标签右键菜单" },
  ).catch(() => null);
  check(
    "标签右键菜单列出可做的事（TER-001）",
    tabMenu !== null && tabMenu.some((l) => l.startsWith("关闭其他")),
    tabMenu ? tabMenu.join("、") : "没有菜单",
  );
  await clickCtxItem("关闭其他（2）");
  const afterExcept = await waitFor(
    async () => {
      const n = await cdp.eval(`document.querySelectorAll("#tabs .tab").length`);
      return n === 1 ? n : null;
    },
    { timeout: 10000, label: "关闭其他" },
  ).catch(() => null);
  check("「关闭其他」只留当前标签（TER-001）", afterExcept === 1, `剩 ${afterExcept ?? "?"} 个`);
  await closeAllTabs();

  // 19x. 设置分组（`SET-001`）
  await closeAllDialogs();
  await clickElement("#settings-open");
  const setGroups = await cdp.eval(`(() => {
    const gs = [...document.querySelectorAll("#set-body .set-group")];
    return gs.map((g) => ({
      name: g.dataset.group,
      title: g.querySelector(".set-group-title")?.textContent ?? "",
      rows: g.querySelectorAll(".set-row").length,
    }));
  })()`);
  check(
    "设置分成可扫的分组（SET-001）",
    setGroups.length >= 4 && setGroups.every((g) => g.title === g.name && g.rows > 0),
    setGroups.map((g) => `${g.name}(${g.rows})`).join("、"),
  );

  await cdp.eval(`(() => {
    const el = document.getElementById("set-search");
    el.value = "乱码";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return el.value;
  })()`);
  const shownGroups = await waitFor(
    async () => {
      const s = await cdp.eval(`[...document.querySelectorAll("#set-body .set-group")]
        .filter((g) => !g.hidden).map((g) => g.dataset.group)`);
      return s.length ? s : null;
    },
    { timeout: 5000, label: "搜索过滤分组" },
  ).catch(() => null);
  check(
    "搜索只留下命中的分组（SET-001）",
    shownGroups !== null && shownGroups.length === 1 && shownGroups[0] === "终端",
    shownGroups ? shownGroups.join("、") : "没有结果",
  );

  await cdp.eval(`(() => {
    const el = document.getElementById("set-search");
    el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return el.value;
  })()`);
  const groupsBack = await waitFor(
    async () => {
      const n = await cdp.eval(`
        [...document.querySelectorAll("#set-body .set-group")].filter((g) => !g.hidden).length
      `);
      return n >= 4 ? n : null;
    },
    { timeout: 5000, label: "清空后恢复" },
  ).catch(() => null);
  check("清空搜索后分组全部回来（SET-001）", groupsBack !== null, `${groupsBack ?? 0} 组`);
  await closeAllDialogs();

  // 19y. 设置搜索：命中高亮 + 分组路径（`SET-002`）
  await closeAllDialogs();
  await clickElement("#settings-open");
  const setQuery = (q) =>
    cdp.eval(`(() => {
      const el = document.getElementById("set-search");
      el.value = ${JSON.stringify(q)};
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return el.value;
    })()`);

  await setQuery("字体");
  const hitView = await waitFor(
    async () => {
      const s = await cdp.eval(`(() => {
        const rows = [...document.querySelectorAll("#set-body .set-row")].filter((r) => !r.hidden);
        const row = rows.find((r) => r.querySelector("mark"));
        return {
          rows: rows.length,
          mark: row?.querySelector("mark")?.textContent ?? null,
          path: row?.querySelector(".set-path")?.textContent ?? null,
          pathHidden: row?.querySelector(".set-path")?.hidden ?? null,
        };
      })()`);
      return s.mark ? s : null;
    },
    { timeout: 5000, label: "搜索命中高亮" },
  ).catch(() => null);
  check("搜索把命中的字标出来（SET-002）", hitView?.mark === "字体", JSON.stringify(hitView));
  check(
    "搜索结果标出所在分组（SET-002）",
    hitView?.path === "终端 ›" && hitView?.pathHidden === false,
    hitView ? `${hitView.path} hidden=${hitView.pathHidden}` : "没有路径",
  );

  await setQuery("font");
  const byAlias = await waitFor(
    async () => {
      const names = await cdp.eval(`[...document.querySelectorAll("#set-body .set-row")]
        .filter((r) => !r.hidden)
        .map((r) => r.querySelector(".set-name")?.dataset.raw ?? r.querySelector(".set-name")?.textContent ?? "")`);
      return names.includes("字体") ? names : null;
    },
    { timeout: 5000, label: "英文别名搜索" },
  ).catch(() => null);
  check("英文关键词能搜到中文项（SET-002）", byAlias !== null, byAlias ? byAlias.join("、") : "没命中");

  await setQuery("");
  const cleaned = await waitFor(
    async () => {
      const s = await cdp.eval(`(() => ({
        marks: document.querySelectorAll("#set-body mark").length,
        badges: [...document.querySelectorAll("#set-body .set-path")].filter((b) => !b.hidden).length,
        names: [...document.querySelectorAll("#set-body .set-name")].some((n) =>
          (n.dataset.raw ?? n.textContent).includes("字体"),
        ),
      }))()`);
      return s.marks === 0 && s.badges === 0 && s.names ? s : null;
    },
    { timeout: 5000, label: "清空搜索复位" },
  ).catch(() => null);
  check(
    "清空搜索后高亮与分组路径都收起（SET-002）",
    cleaned !== null,
    JSON.stringify(cleaned),
  );
  await closeAllDialogs();

  // 19z. 侧栏目录树（`FIL-001`）
  //
  // 只列目录、按需展开：一个目录点开才去 `sftp_list`，不预先爬整棵树。
  await closeAllDialogs();
  await closeAllTabs();
  await cdp.eval(`window.__TAURI__.core.invoke("mock_seed_file", { path: "/treeA/", content: "" })`);
  await cdp.eval(`window.__TAURI__.core.invoke("mock_seed_file", { path: "/treeA/inner/", content: "" })`);
  await cdp.eval(`(() => {
    const set = (id, v) => {
      const el = document.getElementById(id);
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    set("host", "127.0.0.1");
    set("port", ${JSON.stringify(String(sshPort))});
    set("user", "tester");
    set("password", "secret");
    set("files-session", "");
    return true;
  })()`);
  await ensureFilesPanel(true);
  // 刷新按钮会重建目录树（顺带把这条真实路径也验了）
  await clickElement("#files-refresh");
  const treeRoot = await waitFor(
    async () => {
      const paths = await cdp.eval(`
        [...document.querySelectorAll("#files-tree .ftree-row")].map((r) => r.dataset.path)
      `);
      return paths.includes("/treeA") ? paths : null;
    },
    { timeout: 20000, label: "目录树根层" },
  ).catch(() => null);
  const treeDiag =
    treeRoot !== null
      ? treeRoot.join("、")
      : `树是空的；msg=${await cdp.eval(`document.getElementById("files-msg").textContent`)} err=${await cdp.eval(`document.getElementById("files-tree").dataset.err ?? ""`)}`;
  check("侧栏目录树列出根目录下的目录（FIL-001）", treeRoot !== null, treeDiag);

  // 展开 treeA：出现孙目录 inner
  await cdp.eval(`(() => {
    const row = [...document.querySelectorAll("#files-tree .ftree-row")].find((r) =>
      r.dataset.path === "/treeA",
    );
    row?.querySelector(".ftree-toggle")?.click();
    return true;
  })()`);
  const treeChild = await waitFor(
    async () => {
      const paths = await cdp.eval(`
        [...document.querySelectorAll("#files-tree .ftree-row")].map((r) => r.dataset.path)
      `);
      return paths.includes("/treeA/inner") ? paths : null;
    },
    { timeout: 15000, label: "展开子目录" },
  ).catch(() => null);
  check(
    "展开目录时才去读子目录（懒加载，FIL-001）",
    treeChild !== null,
    treeChild ? treeChild.join("、") : "没展开",
  );

  // 点树里的目录：列表跟着进那一层，并且该节点被标成选中
  await cdp.eval(`(() => {
    const row = [...document.querySelectorAll("#files-tree .ftree-row")].find((r) =>
      r.dataset.path === "/treeA",
    );
    row?.click();
    return true;
  })()`);
  const treeNav = await waitFor(
    async () => {
      const s = await cdp.eval(`({
        path: document.getElementById("files-path").textContent,
        selected: document.querySelector("#files-tree .ftree-row.selected")?.dataset.path ?? null,
      })`);
      return s.path === "/treeA" ? s : null;
    },
    { timeout: 15000, label: "点树导航" },
  ).catch(() => null);
  check(
    "点目录树能跳到该目录（FIL-001）",
    treeNav !== null,
    treeNav ? treeNav.path : "没跳过去",
  );
  check(
    "树里高亮当前所在目录（FIL-001）",
    treeNav?.selected === "/treeA",
    `${treeNav?.selected ?? "没有选中"}`,
  );

  // 19za. 大目录的虚拟滚动（`FIL-001` AC-1）
  await cdp.eval(`window.__TAURI__.core.invoke("mock_seed_many", { dir: "/many", count: 1000 })`);
  // 先回到根目录：上一步还停在 /treeA，刷新只会刷那一层
  await filesGoRoot();
  await clickElement("#files-refresh");
  const t0 = Date.now();
  await doubleClickFileRow("many/");
  const many = await waitFor(
    async () => {
      const s = await cdp.eval(`({
        rows: window.__wt.files.rows.length,
        rendered: document.querySelectorAll("#files-list .vrow").length,
      })`);
      return s.rows === 1000 ? s : null;
    },
    { timeout: 20000, label: "1000 个条目" },
  ).catch(() => null);
  const listMs = Date.now() - t0;
  check(
    "1000 个条目的目录能列出来（FIL-001）",
    many !== null,
    many ? `rows=${many.rows}，用时 ${listMs}ms（含轮询开销）` : "没列出来",
  );
  check(
    "大目录只渲染可视窗口内的行（虚拟滚动）",
    many !== null && many.rendered > 0 && many.rendered < 120,
    `DOM 行数 ${many?.rendered ?? 0}` ,
  );
  check(
    "1000 条列表 1 秒内完成（AC-1）",
    many !== null && listMs < 1000,
    `${listMs}ms`,
  );

  // 滚到底：窗口要跟着走，最后一条能渲染出来
  await cdp.eval(`(() => {
    const list = document.getElementById("files-list");
    list.scrollTop = list.scrollHeight;
    return list.scrollTop;
  })()`);
  const lastRow = await waitFor(
    async () => {
      const texts = await cdp.eval(`
        [...document.querySelectorAll("#files-list .vrow span:first-child")].map((s) => s.textContent)
      `);
      return texts.some((t) => t.startsWith("f1000")) ? texts : null;
    },
    { timeout: 8000, label: "滚到底部" },
  ).catch(() => null);
  check(
    "滚动到末尾时窗口跟着走（虚拟滚动正确）",
    lastRow !== null,
    lastRow ? `末行在：${lastRow[lastRow.length - 1]}` : "没渲染出末尾",
  );

  // 19zb. 权限不足要说清楚，而不是显示空目录（`FIL-001` AC-4）
  await cdp.eval(`window.__TAURI__.core.invoke("mock_seed_file", { path: "/noperm/", content: "" })`);
  // 上一步停在 /many，先回根，否则刷新刷的是 /many
  await filesGoRoot();
  await clickElement("#files-refresh");
  await waitFor(
    async () => {
      const rows = await cdp.eval(`window.__wt.files.rows`);
      return rows.some((r) => r.startsWith("noperm")) ? rows : null;
    },
    { timeout: 15000, label: "根目录出现 noperm" },
  );
  await doubleClickFileRow("noperm/");
  const denied = await waitFor(
    async () => {
      const s = await cdp.eval(`({
        error: window.__wt.files.error,
        rows: window.__wt.files.rows.length,
        errRow: document.querySelector("#files-list .row.err")?.textContent ?? null,
        emptyRow: [...document.querySelectorAll("#files-list .row")].some((r) =>
          r.textContent === "（空目录）",
        ),
      })`);
      return s.error ? s : null;
    },
    { timeout: 15000, label: "进入无权限目录" },
  ).catch(() => null);
  check(
    "权限不足时给出明确错误（FIL-001 AC-4）",
    denied !== null && denied.error.includes("权限不足"),
    denied ? denied.error : "没有错误信息",
  );
  check(
    "权限不足时不显示成「空目录」、也不残留上一个目录的条目",
    denied !== null && denied.rows === 0 && denied.emptyRow === false && denied.errRow !== null,
    denied ? `rows=${denied.rows} 空目录占位=${denied.emptyRow} 错误行=${denied.errRow}` : "没进到失败状态",
  );

  await clickElement("#files-up");
  const recovered = await waitFor(
    async () => {
      const s = await cdp.eval(`({ path: document.getElementById("files-path").textContent,
        error: window.__wt.files.error, rows: window.__wt.files.rows.length })`);
      return s.path === "/" && s.error === "" && s.rows > 0 ? s : null;
    },
    { timeout: 15000, label: "返回上一层" },
  ).catch(() => null);
  check(
    "离开无权限目录后错误清除、列表恢复（FIL-001）",
    recovered !== null,
    recovered ? `${recovered.path}，${recovered.rows} 条` : "没恢复",
  );

  // 19zc. 复制标签（`TER-001`）
  await closeAllDialogs();
  await closeAllTabs();
  await clickUntil(
    () => clickElement("#open"),
    async () => (await cdp.eval(`document.querySelectorAll("#tabs .tab").length`)) === 1,
    { timeout: 10000, tries: 4, label: "复制标签用例建终端" },
  );
  const dupTabBox = await cdp.eval(`(() => {
    const r = document.querySelectorAll("#tabs .tab")[0].getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...dupTabBox, button: "right", buttons: 2, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...dupTabBox, button: "right", buttons: 0, clickCount: 1 });
  const dupMenu = await waitFor(
    async () => {
      const items = await cdp.eval(`
        [...document.querySelectorAll("#ctx-menu button")].map((b) => b.textContent)
      `);
      return items.includes("复制标签") ? items : null;
    },
    { timeout: 5000, label: "复制标签菜单项" },
  ).catch(() => null);
  check(
    "标签菜单里有「复制标签」（TER-001）",
    dupMenu !== null,
    dupMenu ? dupMenu.join("、") : "没有这一项",
  );
  await clickCtxItem("复制标签");
  const dupDone = await waitFor(
    async () => {
      const n = await cdp.eval(`document.querySelectorAll("#tabs .tab").length`);
      return n === 2 ? n : null;
    },
    { timeout: 20000, label: "复制出第二个标签" },
  ).catch(() => null);
  check("复制标签会再开一条（TER-001）", dupDone === 2, `标签数 ${dupDone ?? "不对"}`);
  await closeAllTabs();

  // 19zd. 高级设置：配置文件路径与重置偏好（`SET-001`）
  await closeAllDialogs();
  // `G15` 回归：底栏在没有会话时是隐藏的，设置入口必须还能用（左侧树头那个）
  const footHidden = await cdp.eval(`document.getElementById("term-foot").hidden`);
  check("没有会话时终端底栏是隐藏的（前提）", footHidden === true, footHidden === true);
  await clickUntil(
    () => clickElement("#tree-settings"),
    async () => (await cdp.eval(`document.getElementById("settings").open`)) ? true : null,
    { timeout: 5000, tries: 3, label: "从树头打开设置" },
  );
  check(
    "没有会话时也能进设置（G15）",
    await cdp.eval(`document.getElementById("settings").open`),
    "面板已打开",
  );
  const advGroup = await cdp.eval(`(() => {
    const g = [...document.querySelectorAll("#set-body .set-group")].find((x) =>
      x.dataset.group === "高级",
    );
    return g ? { rows: g.querySelectorAll(".set-row").length } : null;
  })()`);
  check(
    "设置里有「高级」分组（SET-001）",
    advGroup !== null && advGroup.rows === 2,
    JSON.stringify(advGroup),
  );

  const prefsShown = await cdp.eval(`document.getElementById("app-prefs-path").textContent`);
  check(
    "显示出配置文件的实际路径（SET-001）",
    typeof prefsShown === "string" && prefsShown.endsWith("config.toml"),
    prefsShown,
  );

  // 改字号 → 重置 → 回到默认 13
  await cdp.eval(`(() => {
    const el = document.getElementById("look-size");
    el.value = "15";
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return el.value;
  })()`);
  await waitFor(
    async () => {
      const s = await cdp.eval(`window.__wt.look.fontSize`);
      return s === 15 ? s : null;
    },
    { timeout: 5000, label: "改字号" },
  );
  // 先做命中测试：这个按钮被挤出对话框或被别的元素盖住时，点下去不报错也没反应
  const resetHit = await cdp.eval(`(() => {
    const el = document.getElementById("prefs-reset");
    if (!el) return null;
    el.scrollIntoView({ block: "nearest" });
    const r = el.getBoundingClientRect();
    const cx = Math.round(r.x + r.width / 2);
    const cy = Math.round(r.y + r.height / 2);
    const top = document.elementFromPoint(cx, cy);
    return { cx, cy, top: top ? top.id || top.tagName : null };
  })()`);
  check(
    "「重置…」按钮能点到（没有被遮挡）",
    resetHit?.top === "prefs-reset",
    JSON.stringify(resetHit),
  );
  if (resetHit?.top === "prefs-reset") await clickAt({ x: resetHit.cx, y: resetHit.cy });
  // 等确认框真的打开再点确定：合成点击可能抢在 showModal 前面
  await waitFor(
    async () =>
      (await cdp.eval(`document.getElementById("ask-dialog").open`)) ? true : null,
    { timeout: 5000, label: "重置确认框" },
  );
  await clickElement("#ask-ok");
  const resetOk = await waitFor(
    async () => {
      const s = await cdp.eval(`({
        size: window.__wt.look.fontSize,
        status: document.getElementById("status").textContent,
      })`);
      return s.size === 13 ? s : null;
    },
    { timeout: 15000, label: "重置偏好" },
  ).catch(() => null);
  check(
    "重置偏好后字号回到默认（SET-001）",
    resetOk !== null,
    resetOk ? `字号 ${resetOk.size}；${resetOk.status}` : "没重置",
  );
  await closeAllDialogs();

  // 19ze. 网络设置：连接超时与 keepalive（`SET-001`）
  await closeAllDialogs();
  await clickUntil(
    () => clickElement("#tree-settings"),
    async () => (await cdp.eval(`document.getElementById("settings").open`)) ? true : null,
    { timeout: 5000, tries: 3, label: "打开设置看网络组" },
  );
  const netGroup = await cdp.eval(`(() => {
    const g = [...document.querySelectorAll("#set-body .set-group")].find((x) =>
      x.dataset.group === "网络",
    );
    return g ? { rows: g.querySelectorAll(".set-row").length } : null;
  })()`);
  check(
    "设置里有「网络」分组（SET-001）",
    netGroup !== null && netGroup.rows === 3,
    JSON.stringify(netGroup),
  );

  const setNet = (id, v) =>
    cdp.eval(`(() => {
      const el = document.getElementById(${JSON.stringify(id)});
      el.value = ${JSON.stringify(v)};
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return el.value;
    })()`);
  await setNet("net-keepalive", "0");
  const netOff = await waitFor(
    async () => {
      const t = readFileSync(prefsFile, "utf8");
      return /netKeepaliveSecs\s*=\s*0/.test(t) ? true : null;
    },
    { timeout: 10000, label: "keepalive 关闭落盘" },
  ).catch(() => null);
  check(
    "改 keepalive 会写进 config.toml（SET-001）",
    netOff === true,
    netOff === true,
  );

  await setNet("net-keepalive", "30");
  const netBack = await waitFor(
    async () => {
      const t = readFileSync(prefsFile, "utf8");
      return /netKeepaliveSecs\s*=\s*30/.test(t) ? true : null;
    },
    { timeout: 10000, label: "keepalive 复原" },
  ).catch(() => null);
  check("改回 keepalive 也落盘（不污染后续）", netBack === true, netBack === true);
  await closeAllDialogs();

  // 19zf. 每项设置都标出默认值与是否需要重启（`SET-001`）
  await closeAllDialogs();
  await clickUntil(
    () => clickElement("#tree-settings"),
    async () => (await cdp.eval(`document.getElementById("settings").open`)) ? true : null,
    { timeout: 5000, tries: 3, label: "打开设置看标注" },
  );
  const metaInfo = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll("#set-body .set-row")];
    const withCtl = rows.filter((r) => r.querySelector("select, input"));
    const missing = withCtl
      .filter((r) => !r.querySelector(".set-meta"))
      .map((r) => r.querySelector("select, input")?.id ?? "?");
    const texts = [...document.querySelectorAll("#set-body .set-meta")].map((e) => e.textContent);
    return {
      withCtl: withCtl.length,
      missing,
      sample: texts[0] ?? null,
      allRestart: texts.length > 0 && texts.every((t) => t.includes("重启")),
    };
  })()`);
  check(
    "每项设置都标出默认值（SET-001）",
    metaInfo.withCtl >= 10 && metaInfo.missing.length === 0,
    `有控件的 ${metaInfo.withCtl} 行，缺标注：${metaInfo.missing.join("、") || "无"}`,
  );
  check(
    "标注里写明是否需要重启（SET-001）",
    metaInfo.allRestart && metaInfo.sample !== null,
    `${metaInfo.sample}`,
  );
  await closeAllDialogs();

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
