#!/usr/bin/env node
// 发布版 exe 的前端加载自检（SYS-008）
//
// verify-package.ps1 只验到「进程活着 + 有 WebView2 子进程」，但空白页 /
// 前端没嵌进去时 WebView2 子进程照样存在。这里用 CDP 连进 release exe 的
// webview，读 window.__wt.ui 与一个 DOM 元素，确认**前端真的加载了、且是当前版本**。
//
// 用法：node scripts/verify-release-ui.mjs [exe路径]
//   exe 默认 target/release/wt-desktop.exe；端口取 WT_CDP_PORT 或 9347
// 退出码：0 = 前端加载且版本对得上，1 = 失败

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exe = resolve(process.argv[2] ?? join(root, "target/release/wt-desktop.exe"));
const PORT = Number(process.env.WT_CDP_PORT ?? 9347);
const BASE = "http://127.0.0.1:" + PORT;
const isWin = process.platform === "win32";

if (!existsSync(exe)) { console.error("找不到 exe：" + exe); process.exit(1); }

// 当前磁盘前端版本：从 main.js 读，不写死
const mainJs = readFileSync(join(root, "apps/wt-desktop/ui/main.js"), "utf8");
const m = mainJs.match(/ui:\s*"(wt-ui-\d+)"/);
if (!m) { console.error("main.js 里找不到 __wt.ui 版本标记"); process.exit(1); }
const wantUi = m[1];

const dataDir = mkdtempSync(join(tmpdir(), "wt-release-probe-"));
let closing = false;
const child = spawn(exe, [], {
  env: {
    ...process.env,
    WT_CDP_PORT: String(PORT),
    WT_DATA_DIR: dataDir,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let appErr = "";
child.stderr?.on("data", (d) => (appErr += d.toString()));

function cleanup() {
  if (closing) return;
  closing = true;
  try {
    if (isWin) spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
    else child.kill("SIGKILL");
  } catch { /* 已退出 */ }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function discover() {
  const res = await fetch(BASE + "/json/list", { signal: AbortSignal.timeout(1500) });
  const list = await res.json();
  return list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
}

// 极简 CDP：连上 webview，按 id 读 Runtime.evaluate 结果
async function evaluate(ws, expression) {
  const id = Math.floor(Math.random() * 1e9);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP evaluate 超时")), 4000);
    const onMsg = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMsg);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result?.result?.value ?? null);
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({
      id, method: "Runtime.evaluate",
      params: { expression, returnByValue: true, awaitPromise: true },
    }));
  });
}

async function main() {
  // 等 CDP 端点就绪（release 首次起 WebView2 可能慢）
  let pages = [];
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline && pages.length === 0) {
    try { pages = await discover(); } catch { /* 还没起来 */ }
    if (pages.length === 0) await sleep(300);
  }
  if (pages.length === 0) {
    throw new Error("CDP 端点没起来（25s）｜stderr=" + appErr.slice(-300));
  }

  const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });

  // 等 __wt 就绪（main.js 同步赋值，给一点余量）
  let ui = null;
  const uiDeadline = Date.now() + 10000;
  while (Date.now() < uiDeadline && !ui) {
    try { ui = await evaluate(ws, "window.__wt && window.__wt.ui ? window.__wt.ui : null"); }
    catch { /* 页面还没好 */ }
    if (!ui) await sleep(300);
  }
  const domOk = ui ? await evaluate(ws, "!!document.getElementById('open')") : null;
  const ready = ui ? await evaluate(ws, "document.readyState") : null;
  try { ws.close(); } catch { /* ignore */ }

  const ok = ui === wantUi && domOk === true;
  console.log("exe      : " + exe);
  console.log("期望前端 : " + wantUi);
  console.log("实际前端 : " + (ui ?? "读不到"));
  console.log("DOM #open: " + JSON.stringify(domOk) + "  readyState=" + JSON.stringify(ready));
  if (!ok) {
    console.error("FAIL 发布版 exe 的前端不是当前版本 / 没加载\nstderr=" + appErr.slice(-400));
    process.exit(1);
  }
  console.log("PASS 发布版 exe 加载的是当前前端（" + wantUi + "），不是空白页或旧资源");
}

main().then(() => { cleanup(); process.exit(0); })
  .catch((e) => { console.error("FAIL " + e.message); cleanup(); process.exit(1); });
