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

  term.onResize(({ cols, rows }) => {
    if (!view.handle) return;
    invoke("term_resize", { handle: view.handle, cols, rows }).catch(() => {});
  });

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
        // 密钥模式下不传密码：传了会被当成备选，容易掩盖「密钥没被接受」这种问题
        password: useKeyBox.checked ? null : passInput.value,
        keyPem: useKeyBox.checked ? keyPem : null,
        keyPassphrase: useKeyBox.checked ? keyPassInput.value || null : null,
        cols: view.term.cols,
        rows: view.term.rows,
      },
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

function renderTree(dto) {
  lastTree = dto;
  treeBody.textContent = "";
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
  vaultPanel.hidden = false;
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

// 捕获阶段处理并 stopPropagation：否则 Ctrl+F 会先被 xterm 当成 ^F 发给远端
document.addEventListener(
  "keydown",
  (ev) => {
    if (!ev.ctrlKey || ev.altKey || ev.metaKey) return;
    if (ev.key === "f") {
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
    if (!vaultPanel.hidden) await renderVaultPanel();
  } catch (e) {
    active?.term.write(`\r\n\x1b[33m密码未保存：${e}\x1b[0m\r\n`);
  }
}

// 自动化验收接口（`scripts/e2e-desktop.mjs` 用 CDP 读它）。
// 只读、无副作用：靠 DOM 文本反推会话句柄会变成脆弱实现，
// 而「界面可被脚本驱动」本身也是 AI Agent 体验的一部分。
window.__wt = {
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
