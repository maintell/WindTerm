import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const s = readFileSync(join(root, "apps/wt-desktop/ui/main.js"), "utf8");

// 从真源码里抠出 invokeWithTimeout（到下一个 async function 之前），注入假的
// invoke / setTimeout / clearTimeout 来跑行为断言。抠源码而不是复制一份：
// 改了实现却忘了同步测试，这份测试会立刻读到新代码，不会「测的是旧拷贝」。
const a = s.indexOf("function invokeWithTimeout(");
const b = s.indexOf("async function openLocal(", a);
if (a < 0 || b < 0) {
  console.log("FAIL 抠不到 invokeWithTimeout 函数体");
  process.exit(1);
}
const fnSrc = s.slice(a, b);

// 场景驱动：lateResolve = 底层 invoke 在「超时」之后才成功/失败；
// lateValue 是成功值，lateError 为 true 表示迟到的是失败。
async function runScenario({ lateResolve, lateValue, lateError, label }) {
  const closed = [];
  let deferredResolve = null;
  let deferredReject = null;
  let timedOutAt = null;

  // 假 invoke：第一次调用是目标命令，返回可控的 Promise；term_close 记进 closed
  const invoke = (cmd, args) => {
    if (cmd === "term_close") {
      closed.push(args.handle);
      return Promise.resolve();
    }
    return new Promise((res, rej) => {
      deferredResolve = res;
      deferredReject = rej;
    });
  };
  // 假定时器：不真的等 ms，改成手动触发，便于确定性驱动超时
  let timeoutCb = null;
  const setTimeout = (cb) => { timeoutCb = cb; return 1; };
  const clearTimeout = () => { timeoutCb = null; };

  const factory = new Function(
    "invoke", "setTimeout", "clearTimeout",
    fnSrc + "; return invokeWithTimeout;",
  );
  const invokeWithTimeout = factory(invoke, setTimeout, clearTimeout);

  let result = "PENDING";
  let caught = null;
  const race = invokeWithTimeout("local_open", { cols: 80, rows: 24 }, 20000, "打开本地终端")
    .then((v) => { result = v; })
    .catch((e) => { caught = String(e); });

  if (!lateResolve) {
    // 正常路径：底层先成功，超时定时器还没触发
    deferredResolve({ ok: true });
    await race;
    return { label, result, caught, closed };
  }

  // 超时路径：先触发超时，再让底层迟到成功/失败
  if (timeoutCb) { timedOutAt = "fired"; timeoutCb(); }
  await race; // 等前端拿到超时错误
  if (lateError) deferredReject(new Error("后端迟到报错"));
  else deferredResolve(lateValue);
  // 给 .then 里的 term_close 一个微任务轮次
  await Promise.resolve();
  await Promise.resolve();
  return { label, result, caught, closed, timedOutAt };
}

const fail = [];
const check = (ok, msg, detail) => {
  if (!ok) fail.push(msg + "｜" + detail);
  console.log((ok ? "OK   " : "FAIL ") + msg + " — " + detail);
};

// 1. 正常返回：不该回收
{
  const r = await runScenario({ lateResolve: false, label: "normal" });
  check(r.caught === null && r.result && r.result.ok === true && r.closed.length === 0,
    "正常返回不回收", "result=" + JSON.stringify(r.result) + " closed=" + JSON.stringify(r.closed));
}
// 2. 超时后迟到成功，返回值是 string handle（local_open 形态）
{
  const r = await runScenario({ lateResolve: true, lateValue: "sLATE-abc", label: "late-string" });
  check(r.caught && r.caught.includes("超时") && r.closed.length === 1 && r.closed[0] === "sLATE-abc",
    "超时后迟到的 string handle 被 term_close 回收",
    "caught=" + r.caught + " closed=" + JSON.stringify(r.closed));
}
// 3. 超时后迟到成功，返回值是 {handle}（ssh_open 形态）
{
  const r = await runScenario({ lateResolve: true, lateValue: { handle: "sSSH-xyz", fingerprint: "xx" }, label: "late-object" });
  check(r.caught && r.caught.includes("超时") && r.closed.length === 1 && r.closed[0] === "sSSH-xyz",
    "超时后迟到的 {handle} 被 term_close 回收",
    "caught=" + r.caught + " closed=" + JSON.stringify(r.closed));
}
// 4. 超时后迟到失败：不能抛 unhandled、不能回收
{
  const r = await runScenario({ lateResolve: true, lateError: true, label: "late-error" });
  check(r.caught && r.caught.includes("超时") && r.closed.length === 0,
    "超时后迟到的失败被静默丢弃、不回收",
    "caught=" + r.caught + " closed=" + JSON.stringify(r.closed));
}
// 5. 超时后迟到成功但返回值不带 handle（非建连命令）：不该误关
{
  const r = await runScenario({ lateResolve: true, lateValue: { bytes: 5 }, label: "late-nohandle" });
  check(r.closed.length === 0,
    "不带 handle 的迟到结果不误回收", "closed=" + JSON.stringify(r.closed));
}

// 捕获全局 unhandled rejection（runScenario 之后检查）
process.on("unhandledRejection", (e) => { fail.push("unhandledRejection: " + e); });
await new Promise((r) => setImmediate(r));

console.log(fail.length ? "bad=" + fail.length + "｜" + fail.join("；") : "late-session回收自测全部通过（5 场景）");
process.exit(fail.length ? 1 : 0);
