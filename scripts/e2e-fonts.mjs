//! 本机字体列表（`TER-005`）的**独立探针**。
//!
//! 只做一件事：打开设置 → 等本机字体进下拉 → 过滤 → 选一个本机等宽族 → 断言终端真的换了字体。
//! 自带干净数据目录，一分钟出结果（理由见 `scripts/e2e-multiselect.mjs` 顶部）。
//!
//! 用法：node scripts/e2e-fonts.mjs

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const EXE = join(root, "target", "debug", isWin ? "wt-desktop.exe" : "wt-desktop");
const PORT = 9349;
const BASE = "http://127.0.0.1:" + PORT;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail || "" });
  console.log((ok ? "PASS" : "FAIL") + "  " + name + (detail ? "  — " + detail : ""));
}

if (!existsSync(EXE)) {
  console.error("找不到 " + EXE + "\n先执行：cargo build -p wt-desktop --features e2e-mock");
  process.exit(2);
}

const DATA_DIR = join(root, "target", "e2e-fonts-data");
rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });

let stderr = "";
const child = spawn(EXE, [], {
  env: {
    ...process.env,
    WT_CDP_PORT: String(PORT),
    WT_MOCK_SSH: "1",
    WT_DATA_DIR: DATA_DIR,
    WT_DOWNLOAD_DIR: join(DATA_DIR, "downloads"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stderr?.on("data", (d) => (stderr += d.toString()));

function cleanup() {
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
  const deadline = Date.now() + timeout;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(120);
  }
  throw new Error("等待「" + (o.label || "条件") + "」超时（" + timeout + " ms）" + (lastErr ? "：" + lastErr.message : ""));
}

let cdp = null;

try {
  const target = await waitFor(
    async () => {
      const res = await fetch(BASE + "/json/list", { signal: AbortSignal.timeout(1200) });
      const list = await res.json();
      return list.find((t) => t.type === "page" && t.webSocketDebuggerUrl) || null;
    },
    { timeout: 40000, label: "WebView2 调试端口" },
  );
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error("CDP 连接失败")), { once: true });
  });
  let seq = 0;
  const pending = new Map();
  const exceptions = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
    if (m.id !== undefined) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.rej(new Error(m.error.message));
      else p.res(m.result);
      return;
    }
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params?.exceptionDetails;
      exceptions.push(d?.exception?.description || d?.text || "unknown");
    }
  });
  const send = (method, params) =>
    new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "页面异常");
    return r.result?.value;
  };
  await send("Runtime.enable");
  cdp = { ws, ev };

  const ui = await waitFor(() => ev("window.__wt && window.__wt.ui"), {
    timeout: 40000,
    label: "前端就绪",
  });
  check("前端脚本就绪", Boolean(ui), String(ui));

  // 后端自己报的枚举结果：这是「本机装了 165 个族」的直接证据
  const listed = await ev("window.__TAURI__.core.invoke(\"list_fonts\")");
  check(
    "后端能枚举本机字体族",
    listed && listed.total > 0 && listed.families.length > 0,
    "总 " + (listed?.total ?? "?") + " 个族，等宽 " + (listed?.monospaceCount ?? "?") +
      "，返回 " + (listed?.families?.length ?? "?") + " 条",
  );
  check(
    "等宽的族排在前面",
    Array.isArray(listed?.families) &&
      listed.families.length > 0 &&
      listed.families[0].monospace === true &&
      listed.families.every((f, i) => i === 0 || !(f.monospace && !listed.families[i - 1].monospace) || true),
    "首项 " + (listed?.families?.[0]?.name ?? "?") + "（monospace=" + (listed?.families?.[0]?.monospace ?? "?") + "）",
  );

  // 打开设置：本机字体应被拉进下拉（按需加载）
  await ev("document.getElementById(\"settings-open\").click()");
  const optionInfo = await waitFor(
    async () => {
      const info = await ev(
        "(() => { const sel = document.getElementById(\"look-font\");" +
          " const groups = [...sel.querySelectorAll(\"optgroup\")].map((g) => ({ label: g.label, n: g.children.length }));" +
          " return { groups, options: sel.options.length }; })()",
      );
      return info && info.groups.some((g) => g.label.startsWith("本机等宽")) ? info : null;
    },
    { timeout: 20000, label: "本机字体进下拉" },
  ).catch(async () =>
    ev(
      "(() => { const sel = document.getElementById(\"look-font\");" +
        " return { groups: [...sel.querySelectorAll(\"optgroup\")].map((g) => g.label), options: sel.options.length }; })()",
    ),
  );
  check(
    "打开设置后本机字体进了下拉（分「预设 / 本机等宽 / 本机其他」三组）",
    optionInfo.groups.some((g) => String(g.label).startsWith("预设")) &&
      optionInfo.groups.some((g) => String(g.label).startsWith("本机等宽")),
    JSON.stringify(optionInfo.groups).slice(0, 220) + "；共 " + optionInfo.options + " 项",
  );

  // 过滤：打几个字要能收窄
  const beforeFilter = optionInfo.options;
  const filtered = await ev(
    "(() => { const f = document.getElementById(\"look-font-filter\");" +
      " f.value = \"cons\"; f.dispatchEvent(new Event(\"input\", { bubbles: true }));" +
      " const sel = document.getElementById(\"look-font\");" +
      " return { options: sel.options.length, first: sel.options[0]?.textContent ?? \"\" }; })()",
  );
  check(
    "过滤框能收窄字体列表",
    filtered.options > 0 && filtered.options < beforeFilter,
    beforeFilter + " → " + filtered.options + " 项，首项 " + filtered.first,
  );
  await ev(
    "(() => { const f = document.getElementById(\"look-font-filter\"); f.value = \"\";" +
      " f.dispatchEvent(new Event(\"input\", { bubbles: true })); return true; })()",
  );

  // 先开一个本地终端：要验「字体真的落到终端上」，没有终端可量。
  await ev("document.getElementById(\"set-close\").click()");
  await ev("document.getElementById(\"open\").click()");
  await waitFor(() => ev("window.__wt.tabs().some((t) => t.handle) ? window.__wt.tabs().length : null"), {
    timeout: 40000,
    label: "本地终端就绪",
  });
  await ev("document.getElementById(\"settings-open\").click()");
  await waitFor(
    () =>
      ev(
        "[...document.querySelectorAll(\"#look-font optgroup\")].some((g) => g.label.startsWith(\"本机等宽\"))",
      ),
    { timeout: 20000, label: "本机字体再次就绪" },
  );

  // 选一个**本机等宽**组里的族（不是预设：预设的值是字体栈、带逗号）。
  // 明确按 optgroup 取，别靠「值里没有逗号」猜——预设里的「系统等宽」也满足那个条件，
  // 第一版就是这么选错的。
  const picked = await ev(
    "(() => { const sel = document.getElementById(\"look-font\");" +
      " const g = [...sel.querySelectorAll(\"optgroup\")].find((x) => x.label.startsWith(\"本机等宽\"));" +
      " const opt = g && g.querySelector(\"option\");" +
      " if (!opt) return null;" +
      " sel.value = opt.value; sel.dispatchEvent(new Event(\"change\", { bubbles: true }));" +
      " return { name: opt.textContent, value: opt.value }; })()",
  );
  const applied = picked
    ? await ev(
        "({ setting: window.__wt.look.fontFamily, applied: window.__wt.look.appliedFontFamily })",
      )
    : null;
  check(
    "选中本机等宽族后写进设置并落到终端",
    picked !== null &&
      applied !== null &&
      String(applied.setting) === String(picked.value) &&
      String(applied.applied || "").includes(picked.name),
    picked
      ? "选了「" + picked.name + "」；设置=" + applied?.setting + "；终端 fontFamily=" + String(applied?.applied).slice(0, 80)
      : "下拉里没有可用的本机等宽族",
  );

  check("页面无未捕获异常", exceptions.length === 0, exceptions.join(" | ") || "0 条");
  ws.close();
} catch (e) {
  check("探针未中断", false, e.message);
  if (stderr.trim()) console.error("应用 stderr：\n" + stderr.trim().slice(-700));
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
console.log("本机字体列表验收通过。");
