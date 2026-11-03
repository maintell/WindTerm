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
const sshBtn = document.getElementById("ssh");
const closeBtn = document.getElementById("close");
const hostInput = document.getElementById("host");
const portInput = document.getElementById("port");
const userInput = document.getElementById("user");
const passInput = document.getElementById("password");
const nameInput = document.getElementById("session-name");
const saveSessionBtn = document.getElementById("save-session");
const deleteSessionBtn = document.getElementById("delete-session");
const useKeyBox = document.getElementById("use-key");
const keyRow = document.getElementById("key-row");
const pickKeyBtn = document.getElementById("pick-key");
const keyFileInput = document.getElementById("key-file");
const keyName = document.getElementById("key-name");
const keyPassInput = document.getElementById("key-pass");

/** 已选中的私钥内容（PEM/OpenSSH 文本），null 表示没选 */
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
  sshBtn.disabled = on;
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

/** 会话建立后的公共收尾：状态、焦点、拉取循环 */
function afterOpen(statusText) {
  running = true;
  pending = 0;
  setConnected(true);
  setStatus(statusText);
  term.focus();
  pump();
}

async function openLocal() {
  if (handle) return;
  fit.fit();
  term.reset();
  try {
    handle = await invoke("local_open", { cols: term.cols, rows: term.rows });
  } catch (e) {
    setStatus(`打开失败：${e}`);
    return;
  }
  afterOpen(`已连接 ${handle.slice(0, 8)}`);
}

async function openSsh() {
  if (handle) return;
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

  fit.fit();
  term.reset();
  setStatus(`正在连接 ${user}@${host}…`);
  sshBtn.disabled = true;
  try {
    const r = await invoke("ssh_open", {
      req: {
        host,
        port,
        user,
        // 密钥模式下不传密码：传了会被当成备选，容易掩盖「密钥没被接受」这种问题
        password: useKeyBox.checked ? null : passInput.value,
        keyPem: useKeyBox.checked ? keyPem : null,
        keyPassphrase: useKeyBox.checked ? keyPassInput.value || null : null,
        cols: term.cols,
        rows: term.rows,
      },
    });
    handle = r.handle;
    afterOpen(
      `已连接 ${user}@${host}${r.host_key_added ? "（已记录主机密钥）" : ""}`,
    );
    if (r.fingerprint) term.write(`\x1b[2m主机密钥 ${r.fingerprint}\x1b[0m\r\n`);
    await savePasswordIfAsked();
  } catch (e) {
    // 失败原因写进终端：状态栏放不下 hints，而且用户需要能复制下来
    term.write(`\r\n\x1b[31m${String(e)}\x1b[0m\r\n`);
    setStatus("连接失败");
  } finally {
    if (!handle) sshBtn.disabled = false;
  }
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
async function selectSession(s) {
  if (s.kind !== "ssh") {
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
  setStatus(`已选中 ${s.name}，填密码后连接`);
  passInput.focus();

  // 保险库解锁时顺手把存过的密码填上，省掉每次手输
  if (vaultUnlocked) {
    try {
      const saved = await invoke("credential_get", { sessionId: s.id });
      if (saved) {
        passInput.value = saved;
        setStatus(`已从保险库填入 ${s.name} 的密码`);
        return;
      }
    } catch {
      /* 取不到就当没存过，不打扰用户 */
    }
  }
}

function renderTree(dto) {
  treeBody.textContent = "";
  if (!dto.exists) {
    treeEmpty(`没有会话库：\n${dto.db_path}\n先导入，再点刷新`);
    return;
  }

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

  const addNode = (text, cls, depth, onClick) => {
    const el = document.createElement("div");
    el.className = `node ${cls}`;
    el.style.paddingLeft = `${8 + depth * 12}px`;
    el.textContent = text;
    if (onClick) el.addEventListener("click", onClick);
    treeBody.appendChild(el);
    return el;
  };

  const walk = (key, depth) => {
    for (const f of byParent.get(key) ?? []) {
      addNode(f.name, "folder", depth);
      walk(f.id, depth + 1);
    }
    for (const s of byFolder.get(key) ?? []) {
      addNode(s.name, "session", depth, () => selectSession(s));
    }
  };
  walk("", 0);

  if (!treeBody.childElementCount) treeEmpty("会话库是空的");
  // 无法解析的记录必须说出来，不能悄悄少几个会话
  if (dto.warnings.length) {
    const el = addNode(`⚠ ${dto.warnings.length} 条记录无法解析`, "folder", 0);
    el.title = dto.warnings.join("\n");
  }
}

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
      },
    });
    await loadTree();
    // 保存后按 id 重新选中，避免「刚存的会话在树里点不到」
    selectedSession = { id, name, host, port: Number.parseInt(portInput.value, 10) || 22, username: userInput.value.trim(), kind: "ssh" };
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
useKeyBox.addEventListener("change", () => {
  keyRow.hidden = !useKeyBox.checked;
  passInput.hidden = useKeyBox.checked;
  // 密钥模式下没有密码可存：与其让「记住密码」静默失效，不如直接禁用并收起
  rememberBox.disabled = useKeyBox.checked;
  if (useKeyBox.checked) {
    rememberBox.checked = false;
    vaultRow.hidden = true;
  }
  (useKeyBox.checked ? pickKeyBtn : passInput).focus();
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

rememberBox.addEventListener("change", () => {
  vaultRow.hidden = !rememberBox.checked;
  if (rememberBox.checked) {
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

/** 连接成功后按需保存密码。保存失败不影响已经连上的会话。 */
async function savePasswordIfAsked() {
  if (!rememberBox.checked || useKeyBox.checked || !selectedSession) return;
  const pw = passInput.value;
  if (!pw) return;
  try {
    await invoke("credential_save", {
      sessionId: selectedSession.id,
      name: selectedSession.name,
      password: pw,
    });
    await refreshVault();
  } catch (e) {
    term.write(`\r\n\x1b[33m密码未保存：${e}\x1b[0m\r\n`);
  }
}

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
  /** 会话树里可见的会话名，供验收断言用 */
  sessions() {
    return [...treeBody.querySelectorAll(".node.session")].map((el) => el.textContent);
  },
};

// 启动自检：把后端是否可达打到状态栏，避免「白屏但不知道哪坏了」
(async () => {
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
