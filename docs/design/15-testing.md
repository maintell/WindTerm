# 详细设计 · 15 · 测试策略与质量门禁

实现需求：`NFR-014` `NFR-018` `NFR-019` `NFR-025`
对应 `spec/02` §3 的六条任务流与 `spec/14` 的里程碑验收

## 1. 分层策略

| 层 | 范围 | 工具 | 运行时机 | 目标 |
|---|---|---|---|---|
| L1 单元 | 纯函数、解析器、状态机 | `cargo test` | 每次保存（watch） | 快（< 10 s），覆盖边界 |
| L2 集成 | crate 间协作，mock 外部 | `cargo test --test` | 提交前 | 中（< 2 min） |
| L3 协议互通 | 真实服务端（容器） | `pytest` 驱动 `wt` CLI | 提交前（子集）/ 每日（全量） | 慢（10~30 min） |
| L4 E2E | 六条 FLOW | CDP 直驱 WebView2（`scripts/e2e-desktop.mjs`）+ `wt` CLI | 提交前（冒烟）/ 每日（全量） | 慢（15 min） |
| L5 性能 | `NFR-*` 基准 | `wt bench` | 每日 + 发版前 | 10 min |
| L6 结构 | 需求闭合、i18n、文档 | 自研脚本 | 每次提交 | 快（< 5 s） |

**原则：越快的层覆盖越多。** 一个逻辑错误应该在 L1 被发现，而不是靠 L4 跑 15 分钟。

## 2. 各层的具体做法

### 2.1 L1 单元测试

**重点覆盖的模块**

| 模块 | 必测内容 |
|---|---|
| `wt-core` 会话树 | 拖拽重排、跨文件夹移动、删除级联、环检测 |
| `wt-store` 迁移 | 每个迁移的 up、幂等重跑、降级拒绝 |
| `wt-crypto` | KDF 参数自适应、AEAD 往返、篡改检测、`ProtectedBytes` 清零 |
| `wt-ssh` 算法协商 | 每种 KEX/cipher/MAC 组合的成功与失败路径 |
| `wt-ssh` known_hosts | 六种格式（端口/哈希/多密钥/通配/吊销/注释） |
| `wt-sftp` | 块大小自适应、原子写、断点续传的头部校验 |
| `wt-shell` 词法/语法 | 引号、转义、`$(...)` 嵌套、here-doc、错误语法 |
| `wt-shell` 展开 | 变量默认值/前后缀、通配、波浪号、分词顺序 |
| `wt-vnc` | DES 位序反转、ZRLE 解压、状态机非法转换 |
| `wt-rdp` | 脏矩形合并、NTSTATUS 映射、能力降级顺序 |
| `wt-vnc` | DES 位序反转、ZRLE 增量解压、CopyRect 重叠 |
| `wt-term` | ANSI 剥离状态机（跨 chunk）、环形缓冲溢出、宏解析 |
| `wt-plugin` | manifest 校验八步、zip 路径穿越、签名验证 |

**边界用例是重点**：畸形输入、超长字段、非法状态机转换、空输入、UTF-8 边界、整数溢出。

```rust
#[test]
fn ansi_stripper_handles_sequence_split_across_chunks() {
    let mut s = AnsiStripper::new();
    let mut out = Vec::new();
    s.feed(b"hello \x1b[3", &mut out);
    s.feed(b"1mred\x1b[0m world", &mut out);
    assert_eq!(String::from_utf8(out).unwrap(), "hello red world");
}
```

### 2.2 L2 集成测试

用 trait 注入 mock，不启动真实网络：

```rust
#[tokio::test]
async fn jump_chain_reports_failing_hop() {
    let ctx = TestContext::new()
        .with_hop("bastion1", MockSsh::ok())
        .with_hop("bastion2", MockSsh::auth_fail())
        .build();

    let err = connect_chain(&ctx, &["bastion1", "bastion2"], ("target", 22)).await.unwrap_err();

    assert_eq!(err.code, "SSH_AUTH_FAILED");
    assert!(err.message.contains("第 2 跳"));
    assert!(err.message.contains("bastion2"));
}
```

**对应 `SES-024` AC-2**：错误信息必须含跳数与主机名。

### 2.3 L3 协议互通

用 Docker Compose 起一套真实服务端：

```yaml
# tests/interop/docker-compose.yml
services:
  ssh-7.4:   { image: lscr.io/linuxserver/openssh-server:9.3_p2-r0 }   # 通过配置模拟旧版
  ssh-8.0:   { ... }
  ssh-9.6:   { ... }
  dropbear:  { image: alpine, command: dropbear -F -E -p 22 }
  sftp:      { ... }
  vsftpd:    { ... }
  filezilla: { ... }
  vnc-tiger: { image: theasp/novnc }
  vnc-real:  { ... }
  win-rdp:   { image: scottyhardy/docker-wine-rdp }   # 有限能力，仅测协议握手
  mosh:      { ... }
```

**驱动方式**：`pytest` 调用 `wt` CLI，断言 JSON 输出。

```python
# tests/interop/test_ssh.py
@pytest.mark.parametrize("server", ["ssh-7.4", "ssh-8.0", "ssh-9.6", "dropbear"])
def test_ssh_connect(server, wt):
    r = wt("ssh", f"{server}", "--user", "test", "--key", "/keys/id_ed25519",
           "--", "echo ok", "--json")
    assert r["exitCode"] == 0
    assert "ok" in r["stdout"]
```

**为什么用 CLI 而不是 UI**：协议正确性与 UI 无关；CLI 跑得快、易断言、易并行。

### 2.4 L4 E2E

**现状（M1）**：`scripts/e2e-desktop.mjs`，零 npm 依赖。

做法是让 `wt-desktop` 在创建 WebView2 时打开 CDP 调试端口（环境变量 `WT_CDP_PORT`），
验收脚本用 HTTP 发现页面、用 WebSocket 说 CDP，在真实窗口里点按钮、敲键盘、读终端缓冲。

三个必须遵守的细节（都踩过）：

| 细节 | 原因 |
|---|---|
| 不能用 `el.click()` / 合成 `KeyboardEvent` | 不是用户手势，页面拿不到 user activation；且 xterm 的键位编码挂在真实 keydown 上，合成事件进不去 |
| `Input.dispatchKeyEvent` 必须带 `windowsVirtualKeyCode` | xterm 按 `ev.keyCode` 分支，只给 `text` 时 keyCode 为 0，字符被丢掉 |
| 调试参数必须由代码传，不能用 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` | `wry` 每次都会 `set_additional_browser_arguments`，会覆盖该环境变量 |
| 连上 CDP 后立刻 `Emulation.setFocusEmulationEnabled` | 窗口没拿到前台焦点时，WebView2 会偶发吞掉可信鼠标/键盘事件——观察到过一次「点了按钮没反应」的假失败 |

当前覆盖 108 项断言：

- 本地终端：页面加载与 Tauri 桥接、启动自检、点击建会话、句柄可取、首屏输出渲染、
  焦点在终端、键盘输入、命令输出、统计字段非零值、前后端行列一致、ack 回流归零、
  界面尺寸变化传播到 PTY、关闭后句柄失效；
- 多标签：能同时开多个会话、切回标签页时内容还在（隐藏而非重建）、
  关掉一个标签不会带走另一个；
- 查找与字号：Ctrl+F 打开查找栏、查找能命中终端输出（计数 x/y）、Ctrl+= 放大字号；
- 会话树：`wt session import` 导入后刷新可见、界面「导入」按钮选文件即落库并刷新树、
  同一份文件再导一次被判为重复而不是新增、GBK 编码的 ini 中文名可读（不变成乱码）、
  界面上能新建会话、选中会话时名称也填回、删除要二次确认且确认后从库里消失、
  能按名字过滤（无匹配时给提示、清空后恢复）、
  点会话自动填好主机/端口/用户名、焦点落到密码框（密码不存库时手填）；
- SSH 密码认证：连接成功、首次连接记录主机密钥（TOFU accept-new）、服务端横幅与逐键回显、
  重连不再重复记录、`known_hosts` 落盘、连不上时给出 `SSH_CONNECT_FAILED` 而非静默失败；
- SSH 密钥认证：仓库里不放测试私钥（见 `wt-ssh::testing` 的注释），验收时由应用的
  `mock_generate_key` 现生成一把一次性密钥（仅 `e2e-mock` feature 编译进来，
  生产构建该命令只返回错误），再经 `<input type=file>` + `DOM.setFileInputFiles` 喂给界面；
  断言选中后显示文件名、无密码也能连上并收到服务端横幅；
- SSH agent 认证：勾「用 agent」时密钥与密码都收起（三者互斥）、
  agent 不可用时错误指向环境而不是网络（`SSH_AGENT_UNAVAILABLE`）、
  这两种模式下「记住密码」被禁用；
- 保险库：密钥模式下「记住密码」被禁用（没有密码可存，不能让控件静默失效）、
  勾选后出现保险库输入、创建并解锁、连接成功后密码写入保险库、`vault.wtvlt` 落盘且是
  `WTVLT\0` 加密容器、重新选中会话时自动填入密码、用存下的密码能直接连上、
  条目面板能看到存了哪些密码、能删掉条目且面板与计数同步；
- SFTP 文件面板：打开面板即列出远端目录、**条目类型来自服务端属性**（文件不被当成目录）、
  双击文件下载到本地且内容逐字节一致、同名再下载自动改名而不覆盖、
  上传本地文件后远端列表出现它；
- 终端剪贴板：双击选中含 `/` 与 `@` 的整串（`TER-011` AC-1）、`Ctrl+Shift+C` 写剪贴板、
  `Ctrl+Shift+V` 粘贴并执行、粘贴不漏 `^V`、多行粘贴弹确认且取消后零字节
  （AC-3，同时比对 `pasteCount` 与 `inputLog` 长度）、选中即复制默认开启、
  右键一定有明确反馈、远端开启 `?2004` 时粘贴被 `\e[200~`/`\e[201~` 包裹（`TER-023`）；
- 端口转发（`NET-001` / `NET-004`）：界面启动隧道后 `listenPort=0` 被回填成真实端口（AC-2）、
  经隧道传的字节原样返回（AC-1，用 Node 起的真实 TCP echo 当目标）、
  统计里的连接数与双向字节数跟上（AC-5）、
  **停止后隧道仍留在列表里（灰灯，配置已保存）**、停止后端口不再监听、
  没有承载会话时「启动已保存的隧道」给出 `TUN_NO_SESSION` 而不是拿空密码去认证、
  **删除后**才从列表消失、监听 `0.0.0.0` 未确认时被后端挡住（`TUN_LAN_CONFIRM_REQUIRED`）；
- 动态代理（`NET-003`）：切到「动态代理」后目标输入被禁用、
  启动并回填端口、**手写的 SOCKS5 客户端**经它把字节送到目标（用域名形式发地址，
  同时印证「目标由服务端解析」）、停止后从列表消失且端口不再监听；
  协议层另有 6 条单元用例（域名/IPv4/IPv6 解析、`BIND` 回 `0x07`、
  要求认证时无凭据回 `05 FF`、密码错回 `01 01`、正确凭据可继续 CONNECT）；
- 跳板机（`SES-024`）：勾「经跳板机」展开输入、经跳板机能连上目标、
  跳板后面的目标返回了自己的 shell 横幅（证明第二跳是真 SSH 会话）、
  跳板机与目标的主机密钥都被记录（目标那条经跳板无法 probe，
  是在 `AcceptAll` 连上后用 `trust_observed_key` 补的）、
  跳板机能存成**会话属性**且再点会话自动带出、把会话自己设为跳板机时保存被拒
  （AC-4，环引用在保存时就拦）、取消跳板后不再带出；
- 远程转发（`NET-002`）：切到「远程转发 -R」后端口占位变成「服务器上的端口」、
  启动并显示**服务端**分配的端口、连服务器的那个端口能把字节送到本机目标、
  删除后从列表消失；引擎侧另有 2 条用例：服务端回填端口 + 双向字节计数 +
  `cancel_tcpip_forward` 之后端口真的不再监听、服务端拒绝 `-R` 时给出明确原因；
- 隧道自动启动（`NET-005`）：建一条 `autoStart` 的动态代理 → 停掉（配置留下）→
  调 `tunnel_autostart` **只用保险库里的凭据**把它重新拉起来（`start_spec` 与手动启动
  共用同一条路径，所以两者的错误语义一致）；
- SFTP 文件管理：新建目录后列表里出现它（`is_dir` 来自服务端属性）、
  单击选中一行、改名后旧名字消失、删除要二次确认（按钮先变「确认删除」）、
  确认后从列表消失；
- 拖拽上传（`FIL-004`）：拖拽进入时高亮上传区域、拖进来的文件真的出现在远端列表里。
  事件是合成的（CDP 造不出真实的 OS 拖拽），但 `File` 对象与上传链路是真的；
  **拖出去下载**没做（WebView2 需要额外插件），不在这条断言里假装支持；
- 流式上传与进度（`FIL-019`）：200 KB 文件按 64 KB 分块、**前端逐块 `File.slice` 读取**，
  前端必须收到 4 次进度更新（`events >= 3`）且最后一次等于总长——
  「一次 100%」是假进度，这条断言就是防它；上传后远端出现该文件。
  引擎侧另有 1 条用例：写句柄在多次调用之间存活、累计字节数正确、分块顺序保留；
- 三条防「沉默失效」的自检（都来自 G8 的教训）：  前端版本标记（`window.__wt.ui`）与本次构建一致、二进制内嵌的 `main.js` 与磁盘源文件
  逐字节一致、有终端会话在跑时页面的 `setTimeout` 与 `requestAnimationFrame` 仍在触发；
- 全程断言页面无未捕获异常。

SSH 那几项需要一台「服务器」。本机没有 sshd，所以 `wt-desktop` 带 `e2e-mock` feature 编译时
会在 `WT_MOCK_SSH=1` 下用 `wt-ssh` 的进程内 mock 服务端起一台，把端口打到 stdout 给验收脚本读。
生产构建不开启该 feature，mock 代码不进二进制；验收另用 `WT_DATA_DIR` 指向临时目录，
保证 `known_hosts` 是干净的，否则 TOFU 分支测不到。

### 2.4.1 用两台 mock 服务端验跳板机（`SES-024`）

跳板机不能靠单个 mock 验：它本身就是「两台 SSH 服务端之间多一条 TCP」。
`crates/wt-ssh/tests/jump.rs` 起两台 `MockSshServer`：

```text
客户端 ──SSH──> mock A（跳板机） ──direct-tcpip（真实 TCP）──> mock B（目标）
```

跳板机上那条 `direct-tcpip` 由 mock 实现，它连的是 `127.0.0.1:B` —— 所以
「第二跳跑在一条真实 TCP 上」是被证实的。用例覆盖：

| 用例 | 断言 |
|---|---|
| 经跳板连上目标 | 第二跳上能 `exec` 并拿到回执；开完第二跳后跳板机自己仍可用 |
| 目标机密码错误（AC-2） | 错误含「第 2 跳」与目标地址，**错误码仍是 `SSH_AUTH_FAILED`** |
| 跳板机禁止转发 | `SSH_FORWARD_DENIED`，消息直接点名 `AllowTcpForwarding` |
| 目标不可达 | 报第 1 跳（跳板机连不上目标）并带上目标地址 |

最后一条是刻意的：失败发生在**跳板机**而不是目标，报错必须落在正确的跳上，
否则多跳链路里用户会去查一台根本没问题的机器。

```js
// scripts/e2e-desktop.mjs（节选）
await clickElement("#open");                       // 可信鼠标点击
await typeText("echo windtermok");                 // 可信键盘输入
await waitFor(async () => {
  const screen = await cdp.eval(`window.__wt.screen()`);
  return screen.split("\n").some((l) => l.trim() === "windtermok");
});                                                // 断言命令输出
```

**全量 FLOW 用例**（六条）等界面有会话树、标签页、搜索之后再补，
仍按下面的 Playwright 形状写；CDP 客户端已经就绪，可以直接复用：

```ts
// ui/tests/e2e/flow-02-troubleshoot.spec.ts
test('FLOW-2 生产排障 SES-001 SES-024 TER-001 TER-009', async ({ page, wt }) => {
  await wt.seedSessions([
    { name: 'prod-web-01', host: '10.0.1.11', jump: 'bastion', key: 'k1' },
  ]);
  await page.goto('/');

  await page.getByRole('treeitem', { name: 'prod-web-01' }).dblclick();
  await expect(page.getByRole('tab', { name: /prod-web-01/ })).toBeVisible({ timeout: 5000 });

  await page.keyboard.type('tail -f /var/log/nginx/error.log\n');
  await expect(page.getByTestId('terminal')).toContainText('upstream timed out', { timeout: 10000 });

  await page.keyboard.press('Control+Shift+F');
  await page.getByRole('searchbox').fill('upstream');
  await expect(page.getByTestId('search-count')).toHaveText(/1\/\d+/);

  await expect(page.getByTestId('file-browser-path')).toHaveText('/var/log/nginx');
});
```

**E2E 的稳定性要求**

| 要求 | 做法 |
|---|---|
| 不依赖真实外网 | 全部服务端跑在本地容器 |
| 不依赖真实凭据 | 测试用临时生成的密钥与密码 |
| 可重复 | 每个用例前重置数据目录（`--config-dir` 指向临时目录） |
| 无 flaky | 断言用「等待条件」而非固定 `sleep`；超时给足（10 s） |
| 可并行 | 每个 worker 用独立端口与临时目录 |

### 2.5 L5 性能基准

见 `spec/13` §13。要点：

- 跑在**固定规格**的机器上（自托管 runner 或专用机器）；
- 每个基准取 30 次 P50/P95；
- 与上次基线比较，超过阈值即失败；
- 基线随版本更新（每次 minor 发布后重设）。

### 2.6 L6 结构测试

**已实现**：`scripts/check-docs.ps1`（PowerShell 7，三平台可跑）。它实际检查：

| # | 检查项 | 失败处理 |
|---|---|---|
| 1 | 必填文档全部存在 | 阻塞 |
| 2 | 矩阵中每个需求 ID 在 `spec/03~14` 有承接 | 阻塞 |
| 3 | 每个 P0/P1 需求在 `design/` 有承接 | 阻塞 |
| 4 | `design/` 引用的 ID 必须存在于矩阵（反向检查） | 阻塞 |
| 5 | 规格中无「作为取值的」TBD/待定（规则文本不算） | 阻塞 |
| 6 | 引用的 ADR 必须有定义；已定义的 ADR 应被引用（后者只告警） | 阻塞 / 告警 |
| 7 | 文档内部 `.md` 链接可达 | 阻塞 |
| 8 | §12.1 的统计数字与表格实际内容逐格一致 | 阻塞 |
| 9 | §12.4 帮助文档覆盖表包含全部 38 个小节（1.1~6.8） | 阻塞 |
| 10 | 统计 `【待验证】` 数量（M0 结束前应清零） | 告警 |

```bash
pwsh ./scripts/check-docs.ps1
# ===== WindTerm 文档结构校验 =====
# 需求条目：244（P0 47 / P1 89 / P2 66 / P3 7 / NO 9）
# ADR：定义 11 条，引用 11 条
# 待验证标记：11 处（M0 结束前需清零）
# 结果：PASSED
```

**为什么用 PowerShell 而不是 bash**：Windows 上不必额外装 bash；PowerShell 7 在 macOS/Linux 也可用。检查逻辑本身与 shell 无关。

**第 8 项（统计自洽）值得单独说明**：手工维护的统计表 100% 会漂移。让脚本从表格重新统计并逐格比对，是唯一能保证「文档里的数字不是编的」的办法。这条在本次交付中实际抓到了一次不一致（矩阵补 `TER-035` 后总数未更新）。

**这九项检查是「文档不会腐化」的唯一保障。** 没有它们，三个月后矩阵里会出现「已删除的需求 ID」和「指向不存在章节的链接」。

## 3. 兼容矩阵测试

```yaml
# .github/workflows/interop.yml（每日，不是每次提交）
on:
  schedule: [{ cron: "0 18 * * *" }]
  workflow_dispatch:
```

| 维度 | 取值 |
|---|---|
| SSH 服务端 | OpenSSH 7.4 / 8.0 / 8.9 / 9.6 / Dropbear / Windows OpenSSH |
| RDP 服务端 | Windows Server 2012R2 / 2016 / 2019 / 2022 / Win10 / Win11 |
| VNC 服务端 | TightVNC / TigerVNC / RealVNC / macOS / QEMU |
| SFTP | OpenSSH / ProFTPD mod_sftp / Bitvise |
| FTP | vsftpd / FileZilla / IIS |
| 客户端 OS | Win10 1809 / Win11 / macOS 12 / macOS 14 / Ubuntu 22.04 / Fedora 38 |

**RDP 的 Windows 服务端**需要虚拟机（不能容器化），用 `vagrant` 或云主机，每日跑一次子集。

## 4. 终端一致性测试

### 4.1 vttest

```bash
docker run --rm -it wt/vttest
# 手工走查每个菜单项，记录未通过项到 docs/spikes/vttest-<date>.md
```

**不追求 100% 通过**——vttest 包含大量 VT52/复古终端的用例，我们不支持。**目标是记录哪些不通过、为什么、是否影响真实使用**。

### 4.2 esctest

```bash
python3 esctest/interactive.py -p 10000
```

自动化子集在 CI 中跑，通过率 ≥ 95%（`NFR-014`）。

### 4.3 录制回放

```rust
#[test]
fn replay_vim_session() {
    let bytes = include_bytes!("fixtures/vim-edit.bin");
    let mut term = TestTerminal::new(80, 24);
    term.feed(bytes);
    let screen = term.snapshot();
    assert_eq!(screen, include_str!("fixtures/vim-edit.expected.txt"));
}
```

**录制的价值**：把一次真实交互（vim 打开文件、编辑、保存、退出，约 200 KB 字节流）固化下来，比跑 vttest 更贴近真实，且快得多（< 100 ms）。

**必须覆盖的真实场景**：`vim` 编辑中文文件、`top`/`htop`、`tmux` 分屏、`less` 翻页、`git log --graph`、`dialog`/`whiptail` 菜单、`mc`（Midnight Commander）。

## 5. 安全测试

| 测试 | 方法 | 频率 |
|---|---|---|
| XSS（终端输出注入） | E2E 让远端输出 `<img onerror>` 与 `OSC 8 javascript:`，断言无脚本执行 | 每次提交 |
| 路径穿越（HTTP 服务端） | 请求 `../../etc/passwd`、URL 编码变体、符号链接 | 每次提交 |
| Zip Slip（插件） | 构造含 `../` 条目的 `.wtpkg`，断言拒绝 | 每次提交 |
| 凭据不落盘 | 全目录 `grep` 已知密码，零命中 | 每次提交 |
| 日志脱敏 | 故意让密码进入日志路径，断言输出为 `***` | 每次提交 |
| 签名校验 | 篡改 manifest / 更新清单，断言拒绝 | 每次提交 |
| 保险库独立解密 | Python 脚本按 `spec/11` §4.2 解密，断言成功 | 每次提交 |
| 主机密钥变更 | 模拟服务端换密钥，断言阻断 | 每次提交 |

**最后一项（独立实现解密）特别重要**：它证明「格式公开」不是口号——如果第三方实现解不开，说明文档与实现不一致，这本身就是缺陷。

## 6. 结构测试清单（CI 强制）

| # | 检查 | 失败后果 |
|---|---|---|
| 1 | 需求 ID 在规格中存在 | 阻塞 |
| 2 | 每个 P0/P1 有设计承接 | 阻塞 |
| 3 | 无 TBD/待定 | 阻塞 |
| 4 | ADR 索引与正文一致 | 阻塞 |
| 5 | 文档内部链接无死链 | 阻塞 |
| 6 | i18n 键对齐 | 阻塞 |
| 7 | 无硬编码用户字符串 | 阻塞 |
| 8 | `ts-rs` 生成类型与提交一致 | 阻塞 |
| 9 | crate 依赖无环 | 阻塞 |
| 10 | 单文件 ≤ 800 行 | 阻塞（需注释豁免） |
| 11 | 矩阵统计与正文数字一致 | 阻塞 |
| 12 | 每个 P0 需求至少一个测试引用 | 阻塞 |

**第 12 项的实现**：测试用属性标注需求 ID。

```rust
#[test]
#[req(SES_024)]
fn jump_chain_reports_failing_hop() { ... }
```

自定义 proc-macro 把 `#[req(...)]` 收集到一个注册表，CI 检查每个 P0 是否至少出现一次。

## 7. 文档测试

| 类型 | 方法 |
|---|---|
| 代码块可编译 | `mdbook test`（Rust 代码块） |
| CLI 示例可执行 | 从文档提取 `wt ...` 命令，在测试环境执行 |
| 配置示例合法 | 从文档提取 TOML/JSON 块，用 schema 校验 |
| 快捷键表与实现一致 | 从键位配置生成文档表格（单一真相） |

**「快捷键表自动生成」很重要**：手工维护的快捷键表 100% 会与实现不一致（改代码忘了改文档）。让它从代码生成，文档里只放引用。

## 8. M0 技术验证用例

每个 spike 的验收必须写成可执行的测试或脚本：

| Spike | 验证方式 | 产物 |
|---|---|---|
| S1 IPC | `spikes/s1_ipc/` 里的最小 Tauri 应用，跑 `bench` 测吞吐与延迟 | 数据表 |
| S2 终端吞吐 | `wt bench throughput` 原型 | 数据表 + 是否达标的结论 |
| S3 RDP | 连真实 Windows，测四项能力 + 帧率 | 能力矩阵 + 帧率 |
| S4 SSH 转发与 agent | 跳板机 + `-R` + agent 转发三项跑通 | 成功/失败 + 若失败的替代方案 |
| S5 终端中文渲染 | vim/top/htop + 中文日志的列宽与输入法矩阵 | 矩阵结果 |
| S6 ini 解析 | 三个真实 ini 样本的解析报告 | 字段映射表 + 解密结论 |
| S7 保险库 | Python 独立解密脚本 | 成功/失败 + 耗时 |
| S8 跨平台 | 三平台截图比对 + 输入法 | 差异率 |

**每个 spike 必须有「如果失败怎么办」的预案**，且预案已写进 `spec/14` §9 的风险登记。

## 9. 与需求的对应

| 设计点 | 需求 |
|---|---|
| 分层策略 | `NFR-018` |
| 协议互通矩阵 | `NFR-013` |
| vttest / esctest / 回放 | `NFR-014` |
| 结构测试 12 项 | `NFR-019` |
| 安全测试 8 项 | `NFR-010`、`SEC-*` |
| 性能基准 | `NFR-001`~`NFR-006` |
| 文档测试 | `NFR-026` |
| 升级测试 | `NFR-025` |
| M0 验证 | `spec/14` §2 |
