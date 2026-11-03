// 一次性探针：定位 G8「界面列目录挂起」到底卡在哪一层。
//
// 与 e2e-desktop.mjs 分开写，是为了不被 50 多项断言拖住，只回答四个问题：
//   A. 页面跑的是不是刚编译进去的那份 JS（`typeof withDeadline`）
//   B. 从 CDP 直调 `sftp_list` 能不能拿到返回
//   C. 点按钮触发的路径能不能拿到返回
//   D. 埋点日志停在哪一步
//
// 用法：node scripts/probe-sftp.mjs
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXE = join(root, "target", "debug", "wt-desktop.exe");
const PORT = 9444;
const DATA_DIR = join(root, "target", "probe-data");
const TRACE = join(tmpdir(), "wt-trace.log");

if (!existsSync(EXE)) {
  console.error(`找不到 ${EXE}`);
  process.exit(1);
}
rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });

let stdout = "";
let stderr = "";
let closing = false;
const child = spawn(EXE, [], {
  env: { ...process.env, WT_CDP_PORT: String(PORT), WT_MOCK_SSH: "1", WT_DATA_DIR: DATA_DIR },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => (stdout += d.toString()));
child.stderr.on("data", (d) => (stderr += d.toString()));
child.on("exit", (c) => {
  if (!closing) console.error(`应用提前退出 code=${c}\n${stderr}`);
});

function cleanup() {
  closing = true;
  try {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
  } catch {
    /* 已退出 */
  }
}
process.on("exit", cleanup);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms, label) {
  const end = Date.now() + ms;
  let last = null;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(100);
  }
  throw new Error(`等待「${label}」超时${last ? `：${last.message}` : ""}`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.logs = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message}(${msg.error.code})`));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params?.exceptionDetails;
        this.logs.push(`[页面异常] ${d?.exception?.description ?? d?.text}`);
      }
      if (msg.method === "Runtime.consoleAPICalled") {
        const parts = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? "");
        this.logs.push(`[console.${msg.params.type}] ${parts.join(" ")}`);
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

let cdp = null;

async function clickAt(box) {
  const base = { x: box.x, y: box.y, button: "left", clickCount: 1 };
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
}

async function clickElement(selector) {
  const box = await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!box) throw new Error(`找不到 ${selector}`);
  await clickAt(box);
}

function traceTail(n = 40) {
  if (!existsSync(TRACE)) return "（没有 trace 文件）";
  const lines = readFileSync(TRACE, "utf8").trim().split("\n");
  return lines.slice(-n).join("\n");
}

function report(title, ok, detail) {
  console.log(`${ok ? "OK  " : "FAIL"}  ${title}${detail ? `  — ${detail}` : ""}`);
}

async function main() {
  const api = `http://127.0.0.1:${PORT}`;
  const target = await waitFor(
    async () => {
      try {
        const res = await fetch(`${api}/json/list`, { signal: AbortSignal.timeout(1500) });
        const list = await res.json();
        return list.find((t) => t.type === "page" && t.webSocketDebuggerUrl) ?? null;
      } catch {
        return null;
      }
    },
    30000,
    "WebView2 调试端口",
  );

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error("WebSocket 连接失败")), { once: true });
  });
  cdp = new Cdp(ws);
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await waitFor(() => cdp.eval(`document.readyState === "complete"`), 10000, "DOM 就绪");
  await waitFor(() => cdp.eval(`typeof window.__TAURI__?.core?.invoke === "function"`), 10000, "Tauri 桥接");

  const port = await waitFor(
    () => {
      const m = stdout.match(/WT_MOCK_SSH_PORT=(\d+)/);
      return m ? Number(m[1]) : null;
    },
    20000,
    "mock SSH 端口",
  );

  // ── A. 页面跑的是不是新 JS ────────────────────────────────
  // 直接读前端自己挂的版本标记：`fetch(..., {cache:"no-store"})` 会把缓存绕过，
  // 拿到的源码新不代表页面执行的那份新，那样判新旧会得出假结论。
  const fresh = await cdp.eval(
    `({
      ui: window.__wt?.ui ?? null,
      url: location.href,
      title: document.title,
      ready: document.readyState,
      type: typeof window.__wt,
      scripts: [...document.scripts].map((s) => s.src || "(inline)"),
      htmlLen: document.documentElement.outerHTML.length,
      hasToggle: !!document.getElementById("files-toggle"),
      resCount: performance.getEntriesByType("resource").length,
      head: document.head.innerHTML.slice(0, 300),
    })`,
  );
  console.log(JSON.stringify(fresh, null, 2));
  report(
    "页面加载的是刚编译进去的 JS",
    fresh.ui === "wt-ui-2",
    `__wt.ui=${fresh.ui} type=${fresh.type} hasToggle=${fresh.hasToggle}`,
  );

  // ── B. CDP 直调 sftp_list ────────────────────────────────
  await cdp.eval(
    `(() => {
      window.__probe = { state: "running" };
      const t0 = performance.now();
      const req = { host: "127.0.0.1", port: ${port}, user: "tester", password: "secret",
                    keyPem: null, keyPassphrase: null, useAgent: false, cols: 80, rows: 24 };
      window.__TAURI__.core.invoke("sftp_list", { arg: { req, path: "/" } }).then(
        (r) => { window.__probe = { state: "ok", ms: Math.round(performance.now() - t0),
                                    keys: Object.keys(r || {}), path: r?.path,
                                    n: r?.entries?.length ?? -1 }; },
        (e) => { window.__probe = { state: "err", ms: Math.round(performance.now() - t0), e: String(e) }; },
      );
      return true;
    })()`,
  );
  const direct = await waitFor(
    async () => {
      const p = await cdp.eval(`window.__probe`);
      return p && p.state !== "running" ? p : null;
    },
    15000,
    "CDP 直调 sftp_list",
  ).catch(async () => await cdp.eval(`window.__probe`));
  report(
    "CDP 直调 sftp_list 能拿到返回",
    direct?.state === "ok",
    JSON.stringify(direct),
  );

  // ── C. 真实用户路径 ─────────────────────────────────────
  // 与 e2e 对齐：先预置一个远端文件，再**连上一个 SSH 会话**，最后才开文件面板。
  // 探针单独跑时这条路径是通的，所以差别一定来自「已经有一个 SSH 终端会话」这个前置。
  await cdp.eval(
    `(() => {
      document.getElementById("host").value = "127.0.0.1";
      document.getElementById("port").value = ${JSON.stringify(String(port))};
      document.getElementById("user").value = "tester";
      document.getElementById("password").value = "secret";
      document.getElementById("use-key").checked = false;
      document.getElementById("use-agent").checked = false;
      return true;
    })()`,
  );
  await cdp.eval(
    `window.__TAURI__.core.invoke("mock_seed_file", { path: "/notes.txt", content: ${JSON.stringify(
      Buffer.from("hello from server").toString("base64"),
    )} })`,
  );

  await clickElement("#ssh");
  const connected = await waitFor(
    () => cdp.eval(`document.getElementById("status").textContent`).then((t) => (t.startsWith("已连接") ? t : null)),
    20000,
    "SSH 连接",
  );
  report("先连上一个 SSH 会话", true, connected);

  await clickElement("#files-toggle");

  const seen = [];
  for (let i = 0; i < 200; i++) {
    const s = await cdp.eval(`window.__wt?.files ?? null`).catch(() => null);
    if (s) {
      const tag = `${s.msg}|${s.rows.join(",")}`;
      if (seen[seen.length - 1] !== tag) seen.push(tag);
      if (s.rows.length > 0) break;
    }
    await sleep(125);
  }
  report("点按钮触发的列目录能拿到返回", seen.some((s) => s.includes("notes.txt") || !s.startsWith("读取中")),
    `状态变化：${seen.join(" → ")}`);

  // ── D. 埋点 ──────────────────────────────────────────────
  console.log("\n── 埋点尾部 ──");
  console.log(traceTail());

  if (cdp.logs.length) {
    console.log("\n── 页面日志 ──");
    console.log(cdp.logs.slice(-10).join("\n"));
  }
  if (stderr.trim()) {
    console.log("\n── 应用 stderr ──");
    console.log(stderr.trim().slice(-2000));
  }
}

main()
  .catch((e) => {
    console.error(`\n探针失败：${e.message}`);
    console.log("\n── 埋点尾部 ──");
    console.log(traceTail());
    if (cdp?.logs.length) console.log(`\n── 页面日志 ──\n${cdp.logs.slice(-10).join("\n")}`);
    if (stderr.trim()) console.log(`\n── 应用 stderr ──\n${stderr.trim().slice(-2000)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    // 必须显式退出：WebSocket 会让 Node 的事件循环常驻，脚本跑完也不返回。
    try {
      cdp?.ws?.close();
    } catch {
      /* 已关闭 */
    }
    cleanup();
    process.exit(process.exitCode ?? 0);
  });
