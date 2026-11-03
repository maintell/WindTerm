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
const SearchAddon = window.SearchAddon?.SearchAddon;

const statusEl = document.getElementById("status");

if (
  typeof Terminal !== "function" ||
  typeof FitAddon !== "function" ||
  typeof SearchAddon !== "function"
) {
  statusEl.textContent = "前端依赖未加载：vendor 下的 xterm.js / addon-fit.js / addon-search.js 缺失";
  throw new Error(
    `xterm 加载失败：Terminal=${typeof Terminal} FitAddon=${typeof FitAddon} SearchAddon=${typeof SearchAddon}`,
  );
}

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
const useAgentBox = document.getElementById("use-agent");
const keyRow = document.getElementById("key-row");
const useJumpBox = document.getElementById("use-jump");
const jumpRow = document.getElementById("jump-row");
const jumpHostInput = document.getElementById("jump-host");
const jumpUserInput = document.getElementById("jump-user");
const jumpPassInput = document.getElementById("jump-pass");
const jumpSessionSelect = document.getElementById("jump-session");
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

const termHost = document.getElementById("term");
const tabsEl = document.getElementById("tabs");

/** 攒够这么多未确认字节就先确认一次，减少 IPC 往返 */
const ACK_BATCH = 32 * 1024;
/** 低流量时也定期确认，避免 pending 长期挂账 */
const ACK_INTERVAL = 200;

/** 所有已打开的会话：id → view */
const sessions = new Map();
/** 当前激活的 view；`null` 表示没有会话 */
let active = null;
let nextViewId = 1;

function setStatus(text) {
  statusEl.textContent = text;
}

/** 打开/关闭按钮的可用状态：多会话后开新会话不该被禁用 */
function refreshButtons() {
  closeBtn.disabled = sessions.size === 0;
  openBtn.disabled = false;
  sshBtn.disabled = false;
}

function frame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

/**
 * 建一个终端视图（一个标签页）。
 *
 * 每个会话有自己的 xterm 实例、FitAddon、未确认计数与拉取循环——
 * 共用一份状态会让「切走的标签页停止 ack」变成静默的背压泄漏。
 */
/** 当前字号；Ctrl+= / Ctrl+- 调整，对所有会话生效 */
let fontSize = 13;

function createView(label) {
  const el = document.createElement("div");
  el.className = "term-view";
  termHost.appendChild(el);

  const term = new Terminal({
    fontFamily: '"JetBrains Mono", Consolas, "Cascadia Mono", monospace',
    fontSize,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    // 查找高亮用到了 decorations（proposed API）。不开这个开关，
    // addon-search 的 findNext 会直接抛错，界面上表现为「搜索框没反应」。
    allowProposedApi: true,
    theme: {
      background: "#1a1a1c",
      foreground: "#e8e8ea",
      cursor: "#5b9bff",
      selectionBackground: "#2f4f7f",
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const search = new SearchAddon();
  term.loadAddon(search);
  term.open(el);

  const view = {
    id: nextViewId++,
    label,
    term,
    fit,
    search,
    el,
    handle: null,
    running: false,
    pending: 0,
    status: "",
    dataEvents: 0,
    inputLog: [],
    /** 粘贴次数（验收用：确认「取消后零字节」时对比它没变） */
    pasteCount: 0,
    /** 自动复制成功次数（验收用：静默能力也要有可观测的成功信号） */
    autoCopyCount: 0,
  };

  search.onDidChangeResults(({ resultIndex, resultCount }) => {
    if (view !== active) return;
    updateFindCount(resultIndex, resultCount);
  });

  term.onData((data) => {
    if (!view.handle) return;
    view.dataEvents += 1;
    if (view.inputLog.length < 64) view.inputLog.push(data);
    invoke("term_write", { handle: view.handle, data }).catch((e) =>
      setStatus(`写入失败：${e}`),
    );
  });

  // 选中即复制（TER-011）。防抖是因为拖选会连续触发，每次都写剪贴板既浪费
  // 又会让剪贴板里短暂出现半截内容。
  let autoCopyTimer = null;
  term.onSelectionChange(() => {
    if (!autoCopy) return;
    const text = term.getSelection();
    if (!text) return;
    clearTimeout(autoCopyTimer);
    autoCopyTimer = setTimeout(() => {
      navigator.clipboard
        ?.writeText(text)
        .then(() => {
          view.autoCopyCount += 1;
        })
        .catch((e) => {
          if (autoCopyWarned) return;
          autoCopyWarned = true;
          setStatus(`自动复制失败：${e}（Ctrl+Shift+C 仍可用）`);
        });
    }, 120);
  });

  term.onResize(({ cols, rows }) => {
    if (!view.handle) return;
    invoke("term_resize", { handle: view.handle, cols, rows }).catch(() => {});
  });

  // 右键与中键粘贴（TER-011）。用捕获阶段：应用开启鼠标上报时，
  // xterm 会先把这两个键拿去当鼠标事件，冒泡阶段就轮不到我们了。
  el.addEventListener(
    "contextmenu",
    (ev) => {
      ev.preventDefault();
      if (view !== active) return;
      void pasteFromClipboard(view);
    },
    true,
  );
  el.addEventListener(
    "auxclick",
    (ev) => {
      if (ev.button !== 1) return;
      ev.preventDefault();
      if (view !== active) return;
      void pasteFromClipboard(view);
    },
    true,
  );

  el.addEventListener("mousedown", () => term.focus());

  sessions.set(view.id, view);
  return view;
}

function renderTabs() {
  tabsEl.textContent = "";
  for (const view of sessions.values()) {
    const tab = document.createElement("div");
    tab.className = view === active ? "tab active" : "tab";

    const label = document.createElement("span");
    label.textContent = view.label;
    label.title = view.status || view.label;

    const x = document.createElement("span");
    x.className = "x";
    x.textContent = "×";
    x.title = "关闭";
    x.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void closeView(view);
    });

    tab.append(label, x);
    tab.addEventListener("click", () => setActive(view));
    tabsEl.appendChild(tab);
  }
}

function setActive(view) {
  active = view;
  for (const v of sessions.values()) {
    v.el.classList.toggle("active", v === view);
  }
  renderTabs();
  refreshButtons();
  if (!view) {
    setStatus("已关闭");
    return;
  }
  view.fit.fit();
  view.term.focus();
  setStatus(view.status || `已连接 ${view.label}`);
}

async function ackView(view, force = false) {
  if (!view.handle || view.pending === 0) return;
  if (!force && view.pending < ACK_BATCH) return;
  const n = view.pending;
  view.pending = 0;
  try {
    await invoke("term_ack", { handle: view.handle, n });
  } catch {
    // 会话已关闭时确认会失败，这是正常收尾路径
  }
}

async function pump(view) {
  while (view.running && view.handle) {
    let bytes;
    try {
      const buf = await invoke("term_read", { handle: view.handle, maxBytes: 65536 });
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
    // ack 在 xterm 消费完之后才发，否则后端算出的「未确认字节」是假的
    view.term.write(bytes, () => {
      view.pending += n;
      if (view.pending >= ACK_BATCH) void ackView(view);
    });
    await frame();
  }
}

/** 会话建立后的公共收尾：激活标签、开始拉取 */
function afterOpen(view, statusText) {
  view.running = true;
  view.pending = 0;
  view.status = statusText;
  setActive(view);
  setStatus(statusText);
  void pump(view);
}

async function openLocal() {
  const view = createView("本地终端");
  view.fit.fit();
  try {
    view.handle = await invoke("local_open", {
      cols: view.term.cols,
      rows: view.term.rows,
    });
  } catch (e) {
    view.status = `打开失败：${e}`;
    view.term.write(`\r\n\x1b[31m打开失败：${e}\x1b[0m\r\n`);
    setActive(view);
    setStatus("打开失败");
    return;
  }
  view.label = `本地 ${view.handle.slice(0, 6)}`;
  afterOpen(view, `已连接 ${view.handle.slice(0, 8)}`);
}

async function openSsh() {
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

  const view = createView(`${user}@${host}`);
  view.fit.fit();
  view.status = `正在连接 ${user}@${host}…`;
  setActive(view);
  setStatus(view.status);
  sshBtn.disabled = true;
  try {
    const r = await invoke("ssh_open", {
      req: {
        host,
        port,
        user,
        // 只用勾选的那一种：多传一个会被当成备选，
        // 从而掩盖「密钥/agent 没被接受」这类问题
        password: useKeyBox.checked || useAgentBox.checked ? null : passInput.value,
        keyPem: useKeyBox.checked ? keyPem : null,
        keyPassphrase: useKeyBox.checked ? keyPassInput.value || null : null,
        useAgent: useAgentBox.checked,
        cols: view.term.cols,
        rows: view.term.rows,
      },
      jump: jumpReq(),
    });
    view.handle = r.handle;
    const text = `已连接 ${user}@${host}${r.host_key_added ? "（已记录主机密钥）" : ""}`;
    afterOpen(view, text);
    if (r.fingerprint) view.term.write(`\x1b[2m主机密钥 ${r.fingerprint}\x1b[0m\r\n`);
    await savePasswordIfAsked();
  } catch (e) {
    // 失败原因写进这个标签页：状态栏放不下 hints，而且用户需要能复制下来
    view.term.write(`\r\n\x1b[31m${String(e)}\x1b[0m\r\n`);
    view.status = `连接失败：${user}@${host}`;
    setStatus("连接失败");
    renderTabs();
  } finally {
    sshBtn.disabled = false;
  }
}

async function closeView(view) {
  view.running = false;
  if (view.handle) {
    await ackView(view, true);
    const h = view.handle;
    view.handle = null;
    try {
      await invoke("term_close", { handle: h });
    } catch {
      /* 关闭失败不阻塞界面 */
    }
  }
  sessions.delete(view.id);
  view.el.remove();
  const next = sessions.values().next().value ?? null;
  setActive(next);
}

async function closeTerm() {
  if (active) await closeView(active);
}

// 低流量时也定期确认，避免 pending 长期挂账（对所有会话生效）
// 注意要 force：否则低于 ACK_BATCH 的零散字节永远等不到确认，背压就卡住了
setInterval(() => {
  for (const view of sessions.values()) void ackView(view, true);
}, ACK_INTERVAL);

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

  // 跳板机是会话属性：选中会话就把它带出来（含密码，若保险库已解锁）
  await applyJumpFromSession(s);

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

/** 上一次读到的会话树；过滤时直接复用，不重复查库 */
let lastTree = null;
const filterInput = document.getElementById("tree-filter");

/** 这个文件夹（含更深层）里有没有名字匹配的会话 */
function folderHasMatch(id, query, byParent, byFolder) {
  for (const s of byFolder.get(id) ?? []) {
    if (s.name.toLowerCase().includes(query)) return true;
  }
  for (const f of byParent.get(id) ?? []) {
    if (folderHasMatch(f.id, query, byParent, byFolder)) return true;
  }
  return false;
}

/**
 * 刷新「跳板机会话」下拉（`SES-024`）。
 *
 * 只列 SSH 会话——只有 SSH 能当跳板。当前编辑的会话不在这里过滤掉：
 * 让后端在保存时给出「不能把自己设为跳板机」的明确错误，比下拉里凭空少一项更好懂。
 */
function refreshJumpSelect(dto) {
  const keep = jumpSessionSelect.value;
  jumpSessionSelect.textContent = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "从会话里选跳板机";
  jumpSessionSelect.appendChild(none);
  for (const s of dto.sessions ?? []) {
    if (s.kind !== "ssh") continue;
    const o = document.createElement("option");
    o.value = s.id;
    o.textContent = s.name;
    jumpSessionSelect.appendChild(o);
  }
  jumpSessionSelect.value = keep;
}

/** 把某个会话的跳板配置填进表单（地址/用户，密码从保险库取）。 */
async function fillJumpFields(jump) {
  if (!jump) {
    jumpHostInput.value = "";
    jumpUserInput.value = "";
    jumpPassInput.value = "";
    return;
  }
  jumpHostInput.value = `${jump.host ?? ""}:${jump.port ?? 22}`;
  jumpUserInput.value = jump.username ?? "";
  jumpPassInput.value = "";
  if (!vaultUnlocked) return;
  try {
    // 跳板机的凭据按**它自己**的会话存（规格第 4 条：不继承目标会话）
    const pw = await invoke("credential_get", { sessionId: jump.id });
    if (pw) jumpPassInput.value = pw;
  } catch {
    /* 没存过就算了，用户手填 */
  }
}

/** 会话若配了跳板机，选中时把跳板参数一起带出来——跳板是会话属性，不该每次重填。 */
async function applyJumpFromSession(s) {
  const jumpId = s.options?.jumpSessionId ?? "";
  const jump = jumpId ? (lastTree?.sessions ?? []).find((x) => x.id === jumpId) : null;
  jumpSessionSelect.value = jump ? jumpId : "";
  useJumpBox.checked = Boolean(jump);
  syncAuthUi();
  await fillJumpFields(jump);
}

function renderTree(dto) {  lastTree = dto;
  treeBody.textContent = "";
  refreshJumpSelect(dto);
  refreshTunnelSessionSelect();
  refreshFilesSessionSelect();
  if (!dto.exists) {
    treeEmpty(`没有会话库：\n${dto.db_path}\n先导入，再点刷新`);
    return;
  }

  const query = filterInput.value.trim().toLowerCase();

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
      // 过滤时保留「里面有匹配会话」的文件夹，否则会话会从树里消失得莫名其妙
      const keep =
        !query ||
        f.name.toLowerCase().includes(query) ||
        folderHasMatch(f.id, query, byParent, byFolder);
      if (!keep) continue;
      addNode(f.name, "folder", depth);
      walk(f.id, depth + 1);
    }
    for (const s of byFolder.get(key) ?? []) {
      if (query && !s.name.toLowerCase().includes(query)) continue;
      addNode(s.name, "session", depth, () => selectSession(s));
    }
  };
  walk("", 0);

  if (!treeBody.childElementCount) {
    treeEmpty(query ? `没有匹配「${filterInput.value.trim()}」的会话` : "会话库是空的");
  }
  // 无法解析的记录必须说出来，不能悄悄少几个会话
  if (dto.warnings.length && !query) {
    const el = addNode(`⚠ ${dto.warnings.length} 条记录无法解析`, "folder", 0);
    el.title = dto.warnings.join("\n");
  }
}

filterInput.addEventListener("input", () => {
  if (lastTree) renderTree(lastTree);
});

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
// 「新建」不是装饰：表单里的「保存」在选中某个会话之后是**更新**它
// （`selectedSession.id`），没有这个按钮就无法在不重启的前提下再建一条。
document.getElementById("new-session").addEventListener("click", () => {
  selectedSession = null;
  deleteSessionBtn.disabled = true;
  deleteSessionBtn.textContent = "删除";
  nameInput.value = "";
  passInput.value = "";
  jumpSessionSelect.value = "";
  useJumpBox.checked = false;
  syncAuthUi();
  nameInput.focus();
  setStatus("填名称与主机后保存；连接则用当前参数");
});

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
        jumpSessionId: jumpSessionSelect.value || null,
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

// ── 保险库条目面板 ─────────────────────────────────────────
const vaultToggleBtn = document.getElementById("vault-toggle");
const vaultPanel = document.getElementById("vault-panel");

async function renderVaultPanel() {
  vaultPanel.textContent = "";
  const line = (text, cls = "empty") => {
    const el = document.createElement("div");
    el.className = cls;
    el.textContent = text;
    vaultPanel.appendChild(el);
  };
  try {
    const entries = await invoke("credential_list");
    if (!entries.length) {
      line("保险库里没有密码");
      return;
    }
    for (const e of entries) {
      const row = document.createElement("div");
      row.className = "entry";
      const name = document.createElement("span");
      name.textContent = e.name;
      name.title = e.sessionId ?? e.id;
      const del = document.createElement("button");
      del.textContent = "删除";
      del.addEventListener("click", async () => {
        try {
          await invoke("credential_delete", { entryId: e.id });
          await refreshVault();
          await renderVaultPanel();
          setStatus(`已删除保险库条目 ${e.name}`);
        } catch (err) {
          setStatus(`删除失败：${err}`);
        }
      });
      row.append(name, del);
      vaultPanel.appendChild(row);
    }
  } catch (e) {
    line(String(e));
  }
}

vaultToggleBtn.addEventListener("click", async () => {
  if (!vaultPanel.hidden) {
    vaultPanel.hidden = true;
    return;
  }
  openSidePanel(vaultPanel);
  await renderVaultPanel();
});

// ── 终端查找与字号 ─────────────────────────────────────────
const findBar = document.getElementById("find-bar");
const findInput = document.getElementById("find-input");
const findCount = document.getElementById("find-count");
const findPrev = document.getElementById("find-prev");
const findNext = document.getElementById("find-next");
const findClose = document.getElementById("find-close");

function updateFindCount(index, total) {
  if (!total) {
    findCount.textContent = findInput.value ? "0" : "";
    return;
  }
  findCount.textContent = `${index + 1}/${total}`;
}

function openFind() {
  if (!active) return;
  findBar.hidden = false;
  findInput.focus();
  findInput.select();
}

function closeFind() {
  findBar.hidden = true;
  findCount.textContent = "";
  active?.term.focus();
}

/** 查找高亮配色。**必须传**：不传 decorations 时插件不会发 onDidChangeResults，
 *  界面上就永远看不到「第几个/共几个」 */
const FIND_DECORATIONS = {
  matchBackground: "#4a4a1f",
  matchOverviewRuler: "#4a4a1f",
  activeMatchBackground: "#5b9bff",
  activeMatchOverviewRuler: "#5b9bff",
};

function runFind(backwards) {
  if (!active) return;
  const query = findInput.value;
  if (!query) {
    findCount.textContent = "";
    return;
  }
  // incremental：边打边找，不用按回车
  const found = active.search.findNext(query, {
    incremental: !backwards,
    backwards,
    decorations: FIND_DECORATIONS,
  });
  if (!found) findCount.textContent = "0";
}

findInput.addEventListener("input", () => runFind(false));
findNext.addEventListener("click", () => runFind(false));
findPrev.addEventListener("click", () => runFind(true));
findClose.addEventListener("click", closeFind);

/** 字号调整：所有会话一起改，改完重新 fit（行列数会变） */
function setFontSize(next) {
  fontSize = Math.min(28, Math.max(9, next));
  for (const view of sessions.values()) {
    view.term.options.fontSize = fontSize;
    view.fit.fit();
  }
}

// ── 剪贴板（TER-011 / TER-013 / TER-023）────────────────────
//
// 数据只经 `term.paste()` 发出，不自己拼 `\e[200~…\e[201~`。
// xterm 的 paste 内部已经做了两件我们不该重复的事：`\r?\n` → `\r` 规范化，
// 以及远端开启 `?2004` 时自动包裹 bracketed paste。再包一层，vim 里会看到
// 多出来的 `200~` 字样——这就是「粘贴处理」写两遍的典型后果。
//
// 已知规格偏差（`spec/06` TER-011 AC-1 与「默认分隔符 `/~+-.&?$%`」自相矛盾）：
// 按 AC-1 优先，保留 xterm 默认分隔符，使 `user@host:/var/log` 双击能选全串。
// 若把 `/` 当分隔符，双击只会选中 `user@host:`。

/** 选中即复制（Unix 终端习惯，TER-011）。验收脚本可关掉。 */
let autoCopy = true;
/** 自动复制失败只提示一次，避免每拖一次选就刷一条状态 */
let autoCopyWarned = false;

/** 多行粘贴确认门限：含 ≥ 2 个换行就确认（TER-013） */
const PASTE_CONFIRM_LINES = 2;

const pasteDialog = document.getElementById("paste-confirm");
const pasteInfo = document.getElementById("paste-info");
const pastePreview = document.getElementById("paste-preview");

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    // 不能静默：用户按了复制却什么都没进剪贴板，是最难自查的一类问题
    setStatus(`写剪贴板失败：${e}`);
    return false;
  }
}

async function readClipboard() {
  // 带超时：WebView2 里 `readText()` 可能既不 resolve 也不 reject（等权限），
  // 不设上限的话右键就变成「点了什么都没有」——比报错更难排查。
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 1500));
  try {
    const text = await Promise.race([navigator.clipboard.readText(), timeout]);
    if (text === null) {
      setStatus("读剪贴板被拒绝，请用 Ctrl+Shift+V 粘贴");
    }
    return text;
  } catch (e) {
    setStatus(`读剪贴板失败：${e}（可用 Ctrl+Shift+V）`);
    return null;
  }
}

/** 复制当前会话的选区（Ctrl+Shift+C / Ctrl+Insert）。 */
async function copySelection(view = active) {
  const text = view?.term.getSelection() ?? "";
  if (!text) {
    setStatus("没有选中内容");
    return;
  }
  if (await writeClipboard(text)) {
    setStatus(`已复制 ${text.length} 字符`);
  }
}

/** 多行粘贴确认；返回用户是否确认。取消时一个字节都不会发出去。 */
function confirmPaste(text, view) {
  const lines = text.split(/\r\n|\r|\n/);
  pasteInfo.textContent = `${lines.length} 行 · ${text.length} 字符 · 目标会话 ${view.label}`;
  pastePreview.textContent = lines.slice(0, 3).join("\n");
  pasteDialog.returnValue = "";
  pasteDialog.showModal();
  return new Promise((resolve) => {
    pasteDialog.addEventListener(
      "close",
      () => {
        resolve(pasteDialog.returnValue === "yes");
        if (view === active) view.term.focus();
      },
      { once: true },
    );
  });
}

/**
 * 粘贴一段文本（多行先确认，再交给 xterm）。
 *
 * 顺序是刻意的：先确认，确认通过后才 `term.paste()`。反过来写就会留下
 * 「取消之后远端已经收到一半」这种最难解释的现象。
 */
async function pasteText(text, view = active) {
  if (!view?.handle) {
    setStatus("没有活动会话");
    return;
  }
  if (!text) return;

  const newlines = (text.match(/\r\n|\r|\n/g) ?? []).length;
  if (newlines >= PASTE_CONFIRM_LINES && !(await confirmPaste(text, view))) {
    setStatus("粘贴已取消");
    return;
  }

  view.term.paste(text);
  view.pasteCount += 1;
  setStatus(`已粘贴 ${text.length} 字符`);
}

/**
 * 右键 / 中键粘贴：这里没有 `paste` 事件可用，只能自己去读剪贴板。
 *
 * `navigator.clipboard.readText()` 在 WebView2 里要「用户激活」才放行，
 * 脚本合成的事件可能拿不到，所以读失败时给出可执行的替代动作，
 * 而不是默默什么都不做。
 */
async function pasteFromClipboard(view = active) {
  const text = await readClipboard();
  // 读失败时 `readClipboard` 已经说明原因与替代办法，这里不再覆盖
  if (text === null) return;
  await pasteText(text, view);
}

// 键盘粘贴与右键菜单粘贴都走这里：`paste` 事件自带数据，不需要剪贴板权限。
//
// 为什么不自己处理 Ctrl+Shift+V：浏览器只在真正的粘贴动作上触发 `paste`，
// 我们拦下来再去读剪贴板反而多一道权限坎。交给浏览器，这条路径在所有平台上都一样。
document.addEventListener(
  "paste",
  (ev) => {
    const text = ev.clipboardData?.getData("text/plain") ?? "";
    ev.preventDefault();
    ev.stopPropagation();
    void pasteText(text);
  },
  true,
);

// 捕获阶段处理并 stopPropagation：否则 Ctrl+F 会先被 xterm 当成 ^F 发给远端
document.addEventListener(
  "keydown",
  (ev) => {
    if (ev.altKey || ev.metaKey) return;
    const key = ev.key;

    // 复制（TER-011）。注意 Ctrl+C **不**在这里拦：它必须继续作为 SIGINT
    // 发给远端，改了就是破坏肌肉记忆。
    //
    // 粘贴（Ctrl+Shift+V / Shift+Insert）也**不拦**：浏览器只在真正的粘贴动作上
    // 触发 `paste` 事件，拦下按键反而会让事件不产生。事件处理见下面的 paste 监听。
    if (
      (ev.ctrlKey && ev.shiftKey && (key === "c" || key === "C")) ||
      (ev.ctrlKey && key === "Insert")
    ) {
      ev.preventDefault();
      ev.stopPropagation();
      void copySelection();
      return;
    }

    if (!ev.ctrlKey) return;
    if (key === "f") {
      ev.preventDefault();
      ev.stopPropagation();
      openFind();
    } else if (ev.key === "=" || ev.key === "+") {
      ev.preventDefault();
      ev.stopPropagation();
      setFontSize(fontSize + 1);
    } else if (ev.key === "-") {
      ev.preventDefault();
      ev.stopPropagation();
      setFontSize(fontSize - 1);
    } else if (ev.key === "0") {
      ev.preventDefault();
      ev.stopPropagation();
      setFontSize(13);
    }
  },
  true,
);

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && !findBar.hidden) {
    ev.preventDefault();
    closeFind();
  }
});

// ── 文件面板（SFTP）────────────────────────────────────────
const filesPanel = document.getElementById("files");
const filesPath = document.getElementById("files-path");
const filesList = document.getElementById("files-list");
const filesMsg = document.getElementById("files-msg");
const filesUp = document.getElementById("files-up");
const filesRefresh = document.getElementById("files-refresh");
const filesUploadBtn = document.getElementById("files-upload-btn");
const filesUpload = document.getElementById("files-upload");
const filesMkdir = document.getElementById("files-mkdir");
const filesRename = document.getElementById("files-rename");
const filesRemove = document.getElementById("files-remove");
const nameDialog = document.getElementById("name-dialog");
const nameTitle = document.getElementById("name-title");
const renameInput = document.getElementById("name-input");

/** 文件面板里当前选中的项（单击选中，双击才进入/下载——与文件管理器一致） */
let selectedEntry = null;
/** 删除的二次确认（3 秒窗口，与会话删除同一个模式） */
let removeArmed = false;

let sftpPath = "/";

/**
 * 文件面板对着哪个会话（`FIL-001` 多会话并存）。
 *
 * 空字符串表示「跟随连接表单」——保留原来的用法；选了会话之后，
 * 主机/端口/用户名来自那条会话，密码仍取表单里的（保险库解锁时会自动填）。
 */
let filesSessionId = "";
/** 每个会话各自记住自己浏览到哪（切换会话不该把路径带回根目录） */
const filesPaths = new Map();

const filesSessionSelect = document.getElementById("files-session");

/** 文件面板用的连接参数：选了会话就用会话的，否则跟随表单。 */
function filesReq() {
  const s = filesSessionId
    ? (lastTree?.sessions ?? []).find((x) => x.id === filesSessionId)
    : null;
  if (!s) return sftpReq();
  return {
    ...sftpReq(),
    host: s.host ?? "",
    port: s.port ?? 22,
    user: s.username ?? "",
  };
}

/** 刷新面板顶部的会话下拉（只列 SSH）。 */
function refreshFilesSessionSelect() {
  const keep = filesSessionSelect.value;
  filesSessionSelect.textContent = "";
  const follow = document.createElement("option");
  follow.value = "";
  follow.textContent = "跟随连接表单";
  filesSessionSelect.appendChild(follow);
  for (const s of lastTree?.sessions ?? []) {
    if (s.kind !== "ssh") continue;
    const o = document.createElement("option");
    o.value = s.id;
    o.textContent = s.name;
    filesSessionSelect.appendChild(o);
  }
  filesSessionSelect.value = keep;
}

function setFilesMsg(text) {
  filesMsg.textContent = text;
}

function joinPath(dir, name) {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

function parentPath(path) {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
}

/** 把表单里的连接参数整理成 sftp 命令要的形状（认证与 ssh_open 一致） */
function sftpReq() {
  return {
    host: hostInput.value.trim(),
    port: Number.parseInt(portInput.value, 10) || 22,
    user: userInput.value.trim(),
    password: useKeyBox.checked || useAgentBox.checked ? null : passInput.value,
    keyPem: useKeyBox.checked ? keyPem : null,
    keyPassphrase: useKeyBox.checked ? keyPassInput.value || null : null,
    useAgent: useAgentBox.checked,
    cols: 80,
    rows: 24,
  };
}

async function loadDir(path) {
  setFilesMsg("读取中…");
  // 换目录后旧选中项已经不属于当前列表
  clearSelection();
  try {
    // 后端如果挂住，前端只会一直显示「读取中…」——既看不出是慢还是死，
    // 也没法让用户重试。deadline 把它变成一条明确的错误，界面才有出路。
    const r = await withDeadline(
      invoke("sftp_list", { arg: { req: filesReq(), path, jump: jumpReq() } }),
      20000,
      "列目录",
    );
    sftpPath = r.path || path;
    // 每个会话各自记住浏览位置：切换会话回来还在原处
    filesPaths.set(filesSessionId, sftpPath);
    filesPath.textContent = sftpPath;
    filesPath.title = sftpPath;
    filesList.textContent = "";
    if (!r.entries.length) {
      const el = document.createElement("div");
      el.className = "row";
      el.textContent = "（空目录）";
      filesList.appendChild(el);
      setFilesMsg("");
      return;
    }
    for (const e of r.entries) {
      const row = document.createElement("div");
      row.className = "row name";
      const label = document.createElement("span");
      label.textContent = e.is_dir ? `${e.name}/` : e.name;
      const size = document.createElement("span");
      size.textContent = e.is_dir ? "" : `${e.size}`;
      size.style.color = "#8a8a92";
      row.append(label, size);
      // 单击只选中，双击才动作：与文件管理器一致，也让「改名/删除」有明确的操作对象
      row.addEventListener("click", () => selectEntry(e, row));
      row.addEventListener("dblclick", () => {
        if (e.is_dir) void loadDir(joinPath(sftpPath, e.name));
        else void downloadFile(joinPath(sftpPath, e.name));
      });
      filesList.appendChild(row);
    }
    setFilesMsg("");
  } catch (e) {
    filesList.textContent = "";
    setFilesMsg(`列目录失败：${e}`);
  }
}

/**
 * 给 invoke 加一层前端超时。
 *
 * 后端如果挂住，前端只会一直显示「读取中…」——既看不出是慢还是死，也没法
 * 让用户重试。超时后把它变成一条明确的错误，界面才有出路。
 * 注意这只是前端的 deadline，不参与后端那条链路的调度。
 */
function withDeadline(promise, ms, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what}超过 ${ms / 1000}s 没有返回`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// 切换「文件面板对着哪个会话」：存下当前位置，恢复目标会话上次的位置
filesSessionSelect.addEventListener("change", async () => {
  filesPaths.set(filesSessionId, sftpPath);
  filesSessionId = filesSessionSelect.value;
  const restored = filesPaths.get(filesSessionId) ?? "/";
  await loadDir(restored);
});

filesUp.addEventListener("click", () => loadDir(parentPath(sftpPath)));
filesRefresh.addEventListener("click", () => loadDir(sftpPath));

/** 选中某一行（只改状态，不发请求）。 */
function selectEntry(entry, row) {
  selectedEntry = entry;
  for (const r of filesList.children) r.classList.remove?.("selected");
  row.classList.add("selected");
  filesRename.disabled = false;
  filesRemove.disabled = false;
}

/** 清掉选中态（换目录后旧选中项已经不属于当前列表）。 */
function clearSelection() {
  selectedEntry = null;
  filesRename.disabled = true;
  filesRemove.disabled = true;
  removeArmed = false;
  filesRemove.textContent = "删除";
}

/**
 * 用一个最小的对话框要一个名字；取消返回 `null`。
 */
function askName(title, initial) {
  nameTitle.textContent = title;
  renameInput.value = initial;
  nameDialog.returnValue = "";
  nameDialog.showModal();
  renameInput.focus();
  renameInput.select();
  return new Promise((resolve) => {
    nameDialog.addEventListener(
      "close",
      () => resolve(nameDialog.returnValue === "yes" ? renameInput.value.trim() : null),
      { once: true },
    );
  });
}

// 回车 = 确定。不依赖 `<form method=dialog>` 的隐式提交：
// 它在合成按键（没有 text 字段）下不一定触发，靠不住。
renameInput.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter") return;
  ev.preventDefault();
  nameDialog.returnValue = "yes";
  nameDialog.close();
});

async function makeDir() {
  const name = await askName("新建文件夹（在当前位置）", "");
  if (!name) return;
  setFilesMsg("新建中…");
  try {
    await withDeadline(
      invoke("sftp_mkdir", { req: filesReq(), path: joinPath(sftpPath, name), jump: jumpReq() }),
      20000,
      "新建目录",
    );
    setFilesMsg(`已创建 ${name}`);
    await loadDir(sftpPath);
  } catch (e) {
    setFilesMsg(`新建目录失败：${e}`);
  }
}

async function renameEntry() {
  if (!selectedEntry) return;
  const oldName = selectedEntry.name;
  const name = await askName(`把 ${oldName} 改名为`, oldName);
  if (!name || name === oldName) return;
  setFilesMsg("改名中…");
  try {
    await withDeadline(
      invoke("sftp_rename", {
        req: filesReq(),
        from: joinPath(sftpPath, oldName),
        to: joinPath(sftpPath, name),
        jump: jumpReq(),
      }),
      20000,
      "改名",
    );
    setFilesMsg(`已改名为 ${name}`);
    clearSelection();
    await loadDir(sftpPath);
  } catch (e) {
    setFilesMsg(`改名失败：${e}`);
  }
}

/** 删除要二次确认：第一次点变「确认删除」，3 秒内再点才真的删。 */
async function onRemoveClick() {
  if (!selectedEntry) return;
  if (!removeArmed) {
    removeArmed = true;
    filesRemove.textContent = "确认删除";
    setTimeout(() => {
      if (removeArmed) {
        removeArmed = false;
        filesRemove.textContent = "删除";
      }
    }, 3000);
    return;
  }
  removeArmed = false;
  filesRemove.textContent = "删除";
  const target = selectedEntry;
  setFilesMsg("删除中…");
  try {
    await withDeadline(
      invoke("sftp_remove", {
        req: filesReq(),
        path: joinPath(sftpPath, target.name),
        isDir: target.is_dir,
        jump: jumpReq(),
      }),
      20000,
      "删除",
    );
    setFilesMsg(`已删除 ${target.name}`);
    clearSelection();
    await loadDir(sftpPath);
  } catch (e) {
    setFilesMsg(`删除失败：${e}`);
  }
}

filesMkdir.addEventListener("click", () => void makeDir());
filesRename.addEventListener("click", () => void renameEntry());
filesRemove.addEventListener("click", () => void onRemoveClick());

// ── 拖拽上传（FIL-004）────────────────────────────────────
//
// 只做「拖进来上传」。**拖出去下载**在 WebView2 里需要额外插件
// （HTML5 的 `DownloadURL` 只支持 http/data URL），当前构建不做——
// 见 README 的 G10，别在这里假装支持。
const filesDrop = document.getElementById("files");
let dragDepth = 0;

filesDrop.addEventListener("dragenter", (ev) => {
  if (!ev.dataTransfer?.types.includes("Files")) return;
  ev.preventDefault();
  dragDepth += 1;
  filesList.classList.add("dropping");
});

filesDrop.addEventListener("dragover", (ev) => {
  // 不 preventDefault 的话浏览器的默认行为是「打开这个文件」，会把整个窗口导航走
  if (!ev.dataTransfer?.types.includes("Files")) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = "copy";
});

filesDrop.addEventListener("dragleave", () => {
  // 用计数抵消子元素之间的 enter/leave：直接 remove 会在鼠标划过行时闪
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) filesList.classList.remove("dropping");
});

filesDrop.addEventListener("drop", (ev) => {
  if (!ev.dataTransfer?.types.includes("Files")) return;
  ev.preventDefault();
  dragDepth = 0;
  filesList.classList.remove("dropping");
  const dropped = [...(ev.dataTransfer?.files ?? [])];
  if (!dropped.length) return;
  setFilesMsg(`准备上传 ${dropped.length} 个文件…`);
  void uploadFiles(dropped);
});

/** 下载远端文件到本地下载目录（路径由后端决定并回报）。 */
async function downloadFile(path) {
  setFilesMsg("下载中…");
  try {
    const r = await withDeadline(
      invoke("sftp_download", { req: filesReq(), path, jump: jumpReq() }),
      30000,
      "下载",
    );
    setFilesMsg(`已保存 ${r.bytes} 字节 → ${r.saved_to}`);
    setStatus(`已下载到 ${r.saved_to}`);
  } catch (e) {
    setFilesMsg(`下载失败：${e}`);
  }
}

/**
 * 把二进制转成 base64。
 *
 * 分段而不是 `String.fromCharCode(...bytes)`：后者在几 MB 的文件上会因为
 * 展开成太多实参直接抛 `Maximum call stack size exceeded`。
 */
function toBase64(bytes) {
  const chunk = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** 最近一次上传的进度快照（验收与脚本读它，避免去解析提示文本） */
let lastUpload = null;

/** 每次发给后端的分块大小：64 KB（base64 后约 87 KB，IPC 开销可接受） */
const UPLOAD_CHUNK = 64 * 1024;

/**
 * 上传本地文件到当前远端目录。
 *
 * **按块读、按块发**：整文件不再进内存——这是与「一次性 base64」的关键区别，
 * 也是将来做断点续传的前提（续传只需要知道已经写到哪个 offset）。
 */
async function uploadFiles(picked) {
  if (!picked.length) return;
  let done = 0;
  for (const file of picked) {
    setFilesMsg(`上传中… ${file.name}`);
    lastUpload = { name: file.name, total: file.size, last: 0, events: 0 };
    let id = null;
    try {
      const path = joinPath(sftpPath, file.name);
      id = await withDeadline(
        invoke("sftp_upload_begin", { req: filesReq(), path, jump: jumpReq() }),
        20000,
        "开始上传",
      );
      let offset = 0;
      while (offset < file.size) {
        const slice = file.slice(offset, Math.min(offset + UPLOAD_CHUNK, file.size));
        const bytes = new Uint8Array(await slice.arrayBuffer());
        const written = await withDeadline(
          invoke("sftp_upload_chunk", { id, content: toBase64(bytes) }),
          60000,
          "上传分块",
        );
        lastUpload.last = written;
        lastUpload.events += 1;
        const pct = file.size ? Math.round((written / file.size) * 100) : 100;
        setFilesMsg(`上传中… ${file.name} ${pct}%`);
        offset = written;
      }
      await withDeadline(invoke("sftp_upload_end", { id }), 20000, "结束上传");
      id = null;
      done += 1;
    } catch (e) {
      if (id) await invoke("sftp_upload_abort", { id }).catch(() => {});
      setFilesMsg(`上传 ${file.name} 失败：${e}`);
      return;
    }
  }
  setFilesMsg(`已上传 ${done} 个文件`);
  await loadDir(sftpPath);
}

filesUploadBtn.addEventListener("click", () => filesUpload.click());
filesUpload.addEventListener("change", () => {
  const picked = [...filesUpload.files];
  // 清空，否则同一个文件第二次选不会触发 change
  filesUpload.value = "";
  void uploadFiles(picked);
});

// 面板开关。每次操作独立建连，所以「关掉」只是收起 UI。
document.getElementById("files-toggle").addEventListener("click", async () => {
  if (!filesPanel.hidden) {
    filesPanel.hidden = true;
    return;
  }
  if (!hostInput.value.trim() || !userInput.value.trim()) {
    setStatus("文件面板需要先填主机与用户名");
    return;
  }
  openSidePanel(filesPanel);
  await loadDir("/");
});

// ── 隧道（NET-001 / NET-004）───────────────────────────────
//
// 承载连接用的是上面那张表单里的主机/用户名/密码——与 SSH、SFTP 同一套参数，
// 用户不用为隧道再填一遍。每条隧道一条独立连接（见后端注释）。
const tunnelsPanel = document.getElementById("tunnels");
const tunnelList = document.getElementById("tunnel-list");
const tunnelMsgEl = document.getElementById("tunnel-msg");
const tunnelListen = document.getElementById("tunnel-listen");
const tunnelKind = document.getElementById("tunnel-kind");
const tunnelSessionSelect = document.getElementById("tunnel-session");
const tunnelTarget = document.getElementById("tunnel-target");
const tunnelLan = document.getElementById("tunnel-lan");
const tunnelAdd = document.getElementById("tunnel-add");

/** 最近一次取到的隧道状态（验收与脚本读它，避免去解析 DOM 文本） */
let lastTunnels = [];
let tunnelTimer = null;

function setTunnelMsg(text) {
  tunnelMsgEl.textContent = text;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function renderTunnels(rows) {
  lastTunnels = rows;
  tunnelList.textContent = "";
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "tunnel";
    // 空状态要说清「这东西解决什么问题」，否则用户不知道要不要建
    empty.textContent =
      "还没有隧道。隧道把远端端口映射到本地，用来连只允许从服务器访问的服务（数据库、Redis 等）。";
    tunnelList.appendChild(empty);
    return;
  }
  for (const t of rows) {
    const box = document.createElement("div");
    box.className = "tunnel";

    const line1 = document.createElement("div");
    line1.className = "line1";
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.textContent = "●";
    if (!t.running) {
      // 灰灯：配置在库里，但当前没跑
      dot.style.color = "#8a8a92";
      dot.title = "已停止";
    } else if (t.last_error) {
      // 有上次错误就变红：承载连接断了以后监听还在，但每个连接都会失败，
      // 这时候继续显示绿灯等于骗人
      dot.style.color = "#e5534b";
      dot.title = `最近一次转发失败：${t.last_error}`;
    } else {
      dot.title = "运行中";
    }
    const route = document.createElement("span");
    // 动态代理没有固定目标：路由由客户端每次请求决定
    route.textContent =
      t.kind === "D" ? `${t.kind} ${t.listen}` : `${t.kind} ${t.listen} → ${t.target}`;
    route.title = t.name ? `${t.name}（via ${t.via || "手填参数"}）` : "";
    line1.append(dot, route);

    const startBtn = document.createElement("button");
    startBtn.textContent = t.running ? "停止" : "启动";
    startBtn.title = t.running ? `停止 ${t.listen}` : `用保存的配置启动 ${t.listen}`;
    startBtn.addEventListener("click", () =>
      t.running ? void stopTunnel(t.id) : void startSavedTunnel(t.id),
    );
    line1.append(startBtn);

    const delBtn = document.createElement("button");
    delBtn.textContent = "删除";
    delBtn.title = `删除 ${t.listen}`;
    delBtn.addEventListener("click", () => void deleteTunnel(t.id));
    line1.append(delBtn);

    const line2 = document.createElement("div");
    line2.className = "line2";
    if (!t.running) {
      line2.textContent = "未运行 · 配置已保存";
      line2.title = "";
    } else {
      const parts = [
        `${t.active} 连接`,
        `累计 ${t.total}`,
        `↑${formatBytes(t.up_bytes)} ↓${formatBytes(t.down_bytes)}`,
        `via ${t.via}`,
      ];
      // 被拒的连接要单独说出来：看到「拒绝 30」才知道是撞上限，而不是网络抖
      if (t.rejected) parts.push(`拒绝 ${t.rejected}`);
      if (t.last_error) parts.push(`上次错误：${t.last_error}`);
      line2.textContent = parts.join(" · ");
      line2.title = t.last_error ?? "";
    }

    box.append(line1, line2);
    tunnelList.appendChild(box);
  }
}

/** 刷新「承载会话」下拉（只有 SSH 能承载隧道）。 */
function refreshTunnelSessionSelect() {
  const keep = tunnelSessionSelect.value;
  tunnelSessionSelect.textContent = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "承载会话（可选，保存后便于重启）";
  tunnelSessionSelect.appendChild(none);
  for (const s of lastTree?.sessions ?? []) {
    if (s.kind !== "ssh") continue;
    const o = document.createElement("option");
    o.value = s.id;
    o.textContent = s.name;
    tunnelSessionSelect.appendChild(o);
  }
  tunnelSessionSelect.value = keep;
}

async function refreshTunnels() {
  try {
    renderTunnels(await invoke("tunnel_stats"));
  } catch (e) {
    setTunnelMsg(`读取隧道状态失败：${e}`);
  }
}

async function stopTunnel(id) {
  try {
    await invoke("tunnel_stop", { id });
    setTunnelMsg("已停止");
  } catch (e) {
    setTunnelMsg(`停止失败：${e}`);
  }
  await refreshTunnels();
}

/** 用保存的配置启动：承载会话与密码都从库里取（密码走保险库）。 */
async function startSavedTunnel(id) {
  setTunnelMsg("启动中…");
  try {
    const t = await withDeadline(invoke("tunnel_start_saved", { id }), 30000, "启动隧道");
    setTunnelMsg(`已启动 ${t.kind} ${t.listen}${t.target ? ` → ${t.target}` : ""}`);
  } catch (e) {
    setTunnelMsg(`启动失败：${e}`);
  }
  await refreshTunnels();
}

async function deleteTunnel(id) {
  try {
    await invoke("tunnel_delete", { id });
    setTunnelMsg("已删除");
  } catch (e) {
    setTunnelMsg(`删除失败：${e}`);
  }
  await refreshTunnels();
}

async function startTunnel() {
  if (!hostInput.value.trim() || !userInput.value.trim()) {
    setTunnelMsg("隧道要用上面的主机与用户名建承载连接，先把这两项填上");
    return;
  }
  const kind = tunnelKind.value;
  const dynamic = kind === "dynamic";
  let targetHost = "";
  let targetPort = 0;
  if (!dynamic) {
    const raw = tunnelTarget.value.trim();
    const sep = raw.lastIndexOf(":");
    if (sep <= 0 || sep === raw.length - 1) {
      setTunnelMsg("目标要写成 主机:端口，比如 db:3306");
      return;
    }
    targetHost = raw.slice(0, sep);
    targetPort = Number.parseInt(raw.slice(sep + 1), 10);
    if (!Number.isInteger(targetPort) || targetPort <= 0 || targetPort > 65535) {
      setTunnelMsg("目标端口要在 1–65535 之间");
      return;
    }
  }
  const listenPort = Number.parseInt(tunnelListen.value, 10);
  const allowLan = tunnelLan.checked;

  setTunnelMsg("启动中…");
  try {
    const t = await withDeadline(
      invoke("tunnel_start", {
        arg: {
          ...sftpReq(),
          kind,
          // 勾了「允许局域网」才监听 0.0.0.0，并把这个意图显式传给后端确认
          listenHost: allowLan ? "0.0.0.0" : "127.0.0.1",
          listenPort: Number.isInteger(listenPort) ? listenPort : 0,
          targetHost,
          targetPort,
          allowLan,
          viaSessionId: tunnelSessionSelect.value || null,
          jump: jumpReq(),
        },
      }),
      30000,
      "启动隧道",
    );
    setTunnelMsg(`已启动 ${t.kind} ${t.listen}${t.target ? ` → ${t.target}` : ""}`);
    await refreshTunnels();
  } catch (e) {
    setTunnelMsg(`启动失败：${e}`);
  }
}

// 动态代理不需要目标：每次请求由客户端决定连哪里。让它禁用而不是消失，
// 用户才看得出「这里本来有东西、只是现在用不上」。
// `-R` 的语义是反的：监听在服务器、目标在本地，所以占位文案必须跟着变，
// 否则用户会以为「本地端口」填的是自己机器上的端口。
function syncTunnelKind() {
  const kind = tunnelKind.value;
  const dynamic = kind === "dynamic";
  const remote = kind === "remote";
  tunnelTarget.disabled = dynamic;
  tunnelListen.placeholder = remote ? "服务器上的端口，0 为随机" : "本地端口，0 为随机";
  tunnelTarget.placeholder = dynamic
    ? "动态代理不需要目标"
    : remote
      ? "本机目标 host:port"
      : "目标主机:端口";
  if (dynamic) tunnelTarget.value = "";
}

tunnelKind.addEventListener("change", syncTunnelKind);

function syncTunnelTimer() {
  if (tunnelTimer !== null) {
    clearInterval(tunnelTimer);
    tunnelTimer = null;
  }
  // NET-004 要求统计 ≤ 2 s 刷新；1 s 让字节数看起来是「在动」的
  if (!tunnelsPanel.hidden) {
    tunnelTimer = setInterval(() => void refreshTunnels(), 1000);
  }
}

/**
 * 侧栏同一时间只开一个面板（保险库 / 文件 / 隧道）。
 *
 * 三个面板各占一块高度，全开着会把后开的那个挤出可视区——表现就是
 * 「点了保险库没反应」。窄侧栏里也不该并排塞三个列表。
 */
function openSidePanel(target) {
  for (const p of [vaultPanel, filesPanel, tunnelsPanel]) {
    p.hidden = p !== target;
  }
  syncTunnelTimer();
}

tunnelAdd.addEventListener("click", () => void startTunnel());
document.getElementById("tunnels-toggle").addEventListener("click", async () => {
  if (!tunnelsPanel.hidden) {
    tunnelsPanel.hidden = true;
    syncTunnelTimer();
    return;
  }
  openSidePanel(tunnelsPanel);
  // 打开面板时顺手拉起 auto_start 的隧道（NET-005）：保险库解锁后凭据才可用，
  // 所以「应用一启动就跑」做不到，这里是最早能跑起来的时机。
  try {
    const errs = await invoke("tunnel_autostart");
    if (errs.length) {
      setTunnelMsg(`自动启动 ${errs.length} 条失败：${errs[0]}`);
    }
  } catch (e) {
    setTunnelMsg(`自动启动失败：${e}`);
  }
  await refreshTunnels();
});

// ── 窗口尺寸 ────────────────────────────────────────────────
// 每个会话各自 fit：切换标签页时也要重新算，否则隐藏期间的 resize 会漏掉
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const view of sessions.values()) view.fit.fit();
  }, 100);
});

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
// 三种认证方式互斥：勾一个就把另外两个收起来。
// 让他们同时可见会让人以为可以叠加，而实际只会用其中一个。
function syncAuthUi() {
  const useKey = useKeyBox.checked;
  const useAgent = useAgentBox.checked;
  keyRow.hidden = !useKey;
  jumpRow.hidden = !useJumpBox.checked;
  passInput.hidden = useKey || useAgent;
  // 密钥/agent 模式没有密码可存：与其让「记住密码」静默失效，不如禁用并收起
  rememberBox.disabled = useKey || useAgent;
  if (useKey || useAgent) {
    rememberBox.checked = false;
    vaultRow.hidden = true;
  }
  if (useKey) pickKeyBtn.focus();
  else if (!useAgent) passInput.focus();
}

/**
 * 跳板机参数（`SES-024`）。没勾就返回 `null`。
 *
 * 不要「没勾也传个空对象」：后端会认为「有跳板机但主机为空」，
 * 报出来的错与用户看到的界面状态不符，排查时会被带偏。
 */
function jumpReq() {
  if (!useJumpBox.checked) return null;
  const raw = jumpHostInput.value.trim();
  const sep = raw.lastIndexOf(":");
  const host = sep > 0 ? raw.slice(0, sep) : raw;
  const port = sep > 0 ? Number.parseInt(raw.slice(sep + 1), 10) || 22 : 22;
  return {
    host,
    port,
    user: jumpUserInput.value.trim(),
    password: jumpPassInput.value,
  };
}

useJumpBox.addEventListener("change", syncAuthUi);

// 从下拉里选一个会话当跳板机：把它的地址/用户带出来，密码仍走保险库
jumpSessionSelect.addEventListener("change", async () => {
  const id = jumpSessionSelect.value;
  const jump = id ? (lastTree?.sessions ?? []).find((x) => x.id === id) : null;
  await fillJumpFields(jump);
});

useKeyBox.addEventListener("change", () => {
  if (useKeyBox.checked) useAgentBox.checked = false;
  syncAuthUi();
});

useAgentBox.addEventListener("change", () => {
  if (useAgentBox.checked) useKeyBox.checked = false;
  syncAuthUi();
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
    if (!vaultPanel.hidden) await renderVaultPanel();
  } catch (e) {
    active?.term.write(`\r\n\x1b[33m密码未保存：${e}\x1b[0m\r\n`);
  }
}

// 自动化验收接口（`scripts/e2e-desktop.mjs` 用 CDP 读它）。
// 只读、无副作用：靠 DOM 文本反推会话句柄会变成脆弱实现，
// 而「界面可被脚本驱动」本身也是 AI Agent 体验的一部分。
window.__wt = {
  /**
   * 前端脚本版本标记。
   *
   * WebView2 会缓存 `http://tauri.localhost` 下的静态资源，改完前端只重编二进制
   * 时，页面里跑的可能是旧 JS——排查时就会把「旧代码的行为」当成新代码的 bug。
   * 验收先读这个值，对不上就直接判失败，省掉一整类假结论。
   */
  ui: "wt-ui-21",
  /** 当前选区文本（验收与脚本用） */
  selection() {
    return active?.term.getSelection() ?? "";
  },
  /**
   * 屏幕上某段文字的中心点（视口坐标）。
   *
   * 用途是让脚本能「点到屏幕上这段字」——比如验收双击选词。走公开 DOM
   * （`.xterm-rows > div` + `Range`）而不是 xterm 的私有度量，是因为私有 API
   * 一升级就变，而 DOM 结构是渲染结果本身。
   */
  textPoint(text) {
    if (!text) return null;
    for (const rowEl of document.querySelectorAll(".xterm-rows > div")) {
      const idx = rowEl.textContent.indexOf(text);
      if (idx < 0) continue;
      const walker = document.createTreeWalker(rowEl, NodeFilter.SHOW_TEXT);
      let seen = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const len = node.nodeValue.length;
        if (seen + len > idx) {
          const start = idx - seen;
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, Math.min(start + text.length, len));
          const r = range.getBoundingClientRect();
          if (r.width > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
        seen += len;
      }
    }
    return null;
  },
  /** 粘贴次数：断言「取消后零字节」时对比它没变 */
  get pasteCount() {
    return active?.pasteCount ?? 0;
  },
  /** 自动复制成功次数 */
  get autoCopyCount() {
    return active?.autoCopyCount ?? 0;
  },
  /** 多行粘贴确认框是否打开 */
  get pasteDialogOpen() {
    return pasteDialog.open;
  },
  /** 最近一次取到的隧道状态（验收与脚本用） */
  get tunnels() {
    return lastTunnels.slice();
  },
  /** 隧道面板底部的提示文本 */
  get tunnelMsg() {
    return tunnelMsgEl.textContent;
  },
  /** 远端是否要求 bracketed paste（DECSET ?2004） */
  get bracketedPaste() {
    return active?.term.modes?.bracketedPasteMode ?? false;
  },
  get autoCopy() {
    return autoCopy;
  },
  set autoCopy(on) {
    autoCopy = !!on;
  },
  /** 文件面板的当前状态（验收与脚本用） */
  get files() {
    return {
      path: sftpPath,
      msg: filesMsg.textContent,
      rows: [...filesList.querySelectorAll(".row span:first-child")].map((e) => e.textContent),
      /** 当前选中项的名字（验收与脚本用） */
      selected: selectedEntry?.name ?? null,
      /** 最近一次上传的进度快照：`{name,total,last,events}` */
      upload: lastUpload,
    };
  },
  /** 当前激活会话的句柄 */
  get handle() {
    return active?.handle ?? null;
  },
  get running() {
    return active?.running ?? false;
  },
  get pending() {
    return active?.pending ?? 0;
  },
  get dataEvents() {
    return active?.dataEvents ?? 0;
  },
  get inputLog() {
    return (active?.inputLog ?? []).slice();
  },
  get cols() {
    return active?.term.cols ?? 0;
  },
  get rows() {
    return active?.term.rows ?? 0;
  },
  get fontSize() {
    return fontSize;
  },
  /** 在激活会话里查找（验收与脚本用），返回是否命中与当前计数文本 */
  find(query) {
    if (!active) return null;
    const found = active.search.findNext(query, { decorations: FIND_DECORATIONS });
    return { found, count: findCount.textContent };
  },
  /** 当前屏幕文本（含回滚区），供验收断言用 */
  screen() {
    if (!active) return "";
    const buf = active.term.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  },
  /** 标签页：每个会话一行，标出哪个是激活的 */
  tabs() {
    return [...sessions.values()].map((v) => ({
      label: v.label,
      active: v === active,
      handle: v.handle,
    }));
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
