//! 文件面板多选与批量删除（FIL-001 规格第 8 条）的**独立探针**。
//!
//! 为什么单独一个脚本：这套断言原本长在 e2e-desktop.mjs 末尾，而那条全量脚本
//! 有 450+ 条断言、跑十分钟；本机连跑久了会在**任意位置**挂掉（建连超时、CDP 超时、
//! 回到根目录失败……位置每轮都不同），于是末尾这几条永远轮不到执行。
//!
//! 这里只做一件事：全新数据目录 → 连一次 mock SSH → 种三个文件 → 验多选与批量删除。
//! 一分钟出结果，失败点只有一处可能，不存在「前面某段把状态搞坏了」。
//!
//! 用法：node scripts/e2e-multiselect.mjs

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const EXE = join(root, "target", "debug", isWin ? "wt-desktop.exe" : "wt-desktop");
const PORT = 9347;
const BASE = "http://127.0.0.1:" + PORT;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail || "" });
  console.log((ok ? "PASS" : "FAIL") + "  " + name + (detail ? "  — " + detail : ""));
}
function die(msg) {
  console.error("\n错误：" + msg);
  cleanup();
  process.exit(2);
}

if (!existsSync(EXE)) {
  die("找不到 " + EXE + "\n先执行：cargo build -p wt-desktop --features e2e-mock");
}

// 自己的数据目录：与全量脚本的 target/e2e-data 分开，两边可以交替跑
const DATA_DIR = join(root, "target", "e2e-ms-data");
rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });
const DOWNLOAD_DIR = join(DATA_DIR, "downloads");

let stderr = "";
let stdout = "";
let closing = false;
const child = spawn(EXE, [], {
  env: {
    ...process.env,
    WT_CDP_PORT: String(PORT),
    WT_MOCK_SSH: "1",
    WT_DATA_DIR: DATA_DIR,
    WT_DOWNLOAD_DIR: DOWNLOAD_DIR,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stderr?.on("data", (d) => (stderr += d.toString()));
child.stdout?.on("data", (d) => (stdout += d.toString()));

function cleanup() {
  closing = true;
  try {
    if (isWin) spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
    else child.kill("SIGKILL");
  } catch {
    /* 可能已退出 */
  }
}
process.on("exit", cleanup);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, opts) {
  const o = opts || {};
  const timeout = o.timeout || 20000;
  const interval = o.interval || 100;
  const label = o.label || "条件";
  const deadline = Date.now() + timeout;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(interval);
  }
  throw new Error("等待「" + label + "」超时（" + timeout + " ms）" + (lastErr ? "：" + lastErr.message : ""));
}

async function discover() {
  const res = await fetch(BASE + "/json/list", { signal: AbortSignal.timeout(1500) });
  const list = await res.json();
  return list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
}

/** 极简 CDP 客户端：只要 send / eval 两件 */
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
        if (msg.error) p.reject(new Error(msg.error.message + " (" + msg.error.code + ")"));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params?.exceptionDetails;
        this.exceptions.push(d?.exception?.description || d?.text || "unknown exception");
      }
    });
  }

  send(method, params, timeoutMs) {
    const p = params || {};
    const ms = timeoutMs || 20000;
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const hint =
          method === "Runtime.evaluate"
            ? " — " + String(p.expression || "").slice(0, 160)
            : "";
        reject(new Error("CDP 超时：" + method + hint));
      }, ms);
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
      this.ws.send(JSON.stringify({ id, method, params: p }));
    });
  }

  async eval(expression, opts) {
    const o = opts || {};
    const r = await this.send(
      "Runtime.evaluate",
      { expression, awaitPromise: o.awaitPromise !== false, returnByValue: true, userGesture: true },
      o.timeoutMs || 20000,
    );
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description || d.text || "页面求值异常");
    }
    return r.result?.value;
  }
}

let cdp = null;

try {
  // 1. 等调试端口
  const target = await waitFor(() => discover().then((p) => p[0] || null), {
    timeout: 30000,
    label: "WebView2 调试端口",
  });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP WebSocket 连接失败")), { once: true });
  });
  cdp = new Cdp(ws);
  await cdp.send("Runtime.enable");

  // 2. 等前端起来
  const ui = await waitFor(() => cdp.eval("window.__wt && window.__wt.ui"), {
    timeout: 30000,
    label: "前端脚本就绪",
  });
  check("前端脚本就绪", Boolean(ui), String(ui));

  // 3. mock 端口由应用打到 stdout
  const sshPort = await waitFor(
    () => {
      const hit = stdout.match(/WT_MOCK_SSH_PORT=(\d+)/);
      return hit ? Number(hit[1]) : null;
    },
    { timeout: 15000, label: "mock SSH 端口" },
  );

  // 4. 填连接表单（全新数据目录，没有任何历史会话）
  const fill = async (sel, value) =>
    cdp.eval(
      "(() => { const el = document.querySelector(" + JSON.stringify(sel) + "); el.value = " +
        JSON.stringify(value) +
        "; el.dispatchEvent(new Event(\"input\", { bubbles: true })); return true; })()",
    );
  await fill("#host", "127.0.0.1");
  await fill("#port", String(sshPort));
  await fill("#user", "tester");
  await fill("#password", "secret");

  // 5. 种三个文件（幂等）
  const seed = Buffer.from("x").toString("base64");
  for (const n of ["/ms-a.txt", "/ms-b.txt", "/ms-c.txt"]) {
    await cdp.eval(
      "window.__TAURI__.core.invoke(\"mock_seed_file\", { path: " +
        JSON.stringify(n) +
        ", content: " +
        JSON.stringify(seed) +
        " }).then(() => true)",
    );
  }

  // 6. 连接
  await cdp.eval("document.getElementById(\"ssh\").click()");
  const connected = await waitFor(
    async () => {
      const s = await cdp.eval("document.getElementById(\"status\").textContent");
      return /已连接|密码已记住/.test(s) ? s : null;
    },
    { timeout: 45000, label: "连接 mock SSH" },
  ).catch(async () => {
    const st = await cdp.eval(
      "({ status: document.getElementById(\"status\").textContent, disabled: document.getElementById(\"ssh\").disabled })",
    );
    return null;
  });
  const stNow = connected ? connected : await cdp.eval("document.getElementById(\"status\").textContent");
  check("连上 mock SSH（前提）", connected !== null, stNow);

  // 7. 打开文件面板并列出根目录。
  // **不能盲点** toggle：连上 SSH 后面板会自动打开（FIL-001），再点一下是关闭——
  // 这正是探针第一版「面板 hidden、列表 0 条、focus 无效」的原因。按状态补一次。
  const panelOpen = async () => !(await cdp.eval("document.getElementById(\"files\").hidden"));
  if (!(await panelOpen())) await cdp.eval("document.getElementById(\"files-toggle\").click()");
  await waitFor(() => panelOpen(), { timeout: 10000, label: "文件面板打开" });
  // 手动开面板这条路上，焦点必须落到列表：用户点「文件」就是想操作文件，
  // 这时还要「先点一行」键盘才管用，等于把 ↑↓ / Ctrl+A / Delete 藏在暗处。
  // 注意要**手动**开一次才算数——连上 SSH 自动打开那一路不抢焦点（用户可能正要敲终端），
  // 拿自动打开的状态去断言会误判。
  await cdp.eval("document.getElementById(\"files-toggle\").click()");
  await waitFor(async () => !(await panelOpen()), { timeout: 10000, label: "文件面板关闭" });
  await cdp.eval("document.getElementById(\"files-toggle\").click()");
  await waitFor(() => panelOpen(), { timeout: 15000, label: "文件面板重新打开" });
  const focusOnOpen = await waitFor(
    async () => {
      const id = await cdp.eval("document.activeElement?.id ?? \"\"");
      return id === "files-list" ? id : null;
    },
    { timeout: 10000, label: "焦点落到文件列表" },
  ).catch(async () => await cdp.eval("document.activeElement?.id ?? \"\""));
  const listed = await waitFor(
    async () => {
      const f = await cdp.eval("window.__wt.files");
      const names = f.rows.map((r) => r.replace(/\/$/, ""));
      return names.includes("ms-a.txt") && names.includes("ms-b.txt") && names.includes("ms-c.txt") ? f : null;
    },
    { timeout: 30000, label: "文件列表就绪" },
  ).catch(async () => {
    const f = await cdp.eval("window.__wt.files");
    return { bad: "条目=" + f.total + " 错误=" + (f.error || "无") };
  });
  check("文件列表列出刚种的三个文件（前提）", !listed.bad, listed.bad || "共 " + listed.total + " 条");
  check("面板一打开键盘就能用（焦点已在列表上）", focusOnOpen === "files-list", "焦点=" + (focusOnOpen || "空"));

  if (!listed.bad) {
    // 8. Ctrl+A 全选
    await cdp.eval("document.getElementById(\"files-list\").focus()");
    // 分清「事件没送到」与「处理逻辑坏了」：先看焦点在哪
    const focusBefore = await cdp.eval(
      "({ active: document.activeElement?.id ?? \"\", rows: document.querySelectorAll(\"#files-list .vrow\").length })",
    );
    const key = async (k, code, vk, mods) => {
      const base = { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods || 0 };
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    };
    await key("a", "KeyA", 65, 2); // Ctrl
    const all = await cdp.eval("window.__wt.files");
    // Ctrl+A 没生效时，再用**合成事件**直接打到列表上：
    // 如果这样能全选，说明键盘事件没送到（焦点/CDP 修饰键问题），而不是逻辑坏了
    let synthWorked = null;
    if (all.selectedCount !== all.total) {
      synthWorked = await cdp.eval(
        "(() => { const el = document.getElementById(\"files-list\");" +
          " el.dispatchEvent(new KeyboardEvent(\"keydown\", { key: \"a\", ctrlKey: true, bubbles: true }));" +
          " const f = window.__wt.files; return { count: f.selectedCount, total: f.total }; })()",
      );
    }
    check(
      "Ctrl+A 全选文件列表",
      all.selectedCount === all.total && all.selectedCount >= 3,
      "选中 " + all.selectedCount + "/" + all.total +
        "；焦点=" + focusBefore.active +
        "；渲染行数=" + focusBefore.rows +
        (synthWorked ? "；合成事件后=" + synthWorked.count + "/" + synthWorked.total : ""),
    );

    // 9. Ctrl+点击把 ms-a 移出选区（直接派发带 ctrlKey 的 click：
    //    验的是选区逻辑，不是 CDP 合成鼠标的修饰键传递）
    const toggled = await cdp.eval(
      "(() => { const r = [...document.querySelectorAll(\"#files-list .vrow\")].find((x) => x.dataset.name === \"ms-a.txt\"); if (!r) return \"没有 ms-a 这一行\"; r.dispatchEvent(new MouseEvent(\"click\", { bubbles: true, ctrlKey: true })); return \"ok\"; })()",
    );
    const after = await cdp.eval("window.__wt.files");
    check(
      "Ctrl+点击把一项移出选区",
      toggled === "ok" &&
        after.selectedCount === all.selectedCount - 1 &&
        !after.selectedNames.includes("ms-a.txt"),
      toggled + "；选中 " + after.selectedCount + "，含 ms-a：" + after.selectedNames.includes("ms-a.txt"),
    );

    // 10. Delete 删整个选区（除 ms-a 外全部）
    await key("Delete", "Delete", 46, 0);
    const asked = await waitFor(
      async () => ((await cdp.eval("document.getElementById(\"ask-dialog\").open")) ? true : null),
      { timeout: 5000, label: "批量删除确认" },
    ).catch(() => null);
    await cdp.eval("document.getElementById(\"ask-ok\").click()");
    const finalFiles = await waitFor(
      async () => {
        const f = await cdp.eval("window.__wt.files");
        const names = f.rows.map((r) => r.replace(/\/$/, ""));
        return names.includes("ms-a.txt") && !names.includes("ms-b.txt") ? f : null;
      },
      { timeout: 30000, label: "批量删除完成" },
    ).catch(() => null);
    check(
      "批量删除删的正好是选区，没选中的还在",
      asked === true && finalFiles !== null && finalFiles.selectedCount === 0,
      finalFiles
        ? "剩余选中 " + finalFiles.selectedCount + "，列表 " + JSON.stringify(finalFiles.rows.slice(0, 6))
        : "删除后没等到列表更新",
    );
  }

  check("页面无未捕获异常", cdp.exceptions.length === 0, cdp.exceptions.join(" | ") || "0 条");
  ws.close();
} catch (e) {
  check("探针未中断", false, e.message);
  if (stderr.trim()) console.error("应用 stderr：\n" + stderr.trim().slice(-800));
} finally {
  cleanup();
}

const failed = results.filter((r) => !r.ok);
console.log("\n" + (results.length - failed.length) + "/" + results.length + " 项通过");
if (failed.length) {
  console.error("\n失败项：");
  for (const f of failed) console.error("  - " + f.name + (f.detail ? "：" + f.detail : ""));
  process.exit(1);
}
console.log("文件面板多选验收通过。");
