# WindTerm

> 一个开源、跨平台、可替代 MobaXterm 的 SSH / RDP / VNC / SFTP 一体化远程运维工作台。

**当前状态：M1 收尾（基础设施 + 本地终端 + SSH 协议层 + 桌面壳可交互）。**

| 层 | 状态 | 证据 |
|---|---|---|
| 规格与详细设计 | ✅ 完成 | `docs/`，244→229 条需求基线，`scripts/check-docs.ps1` 通过 |
| 基础设施（错误/模型/配置/加密/存储/导入） | ✅ 完成 | 6 个 crate，111 个测试 |
| 终端传输侧（环形缓冲/背压/ANSI 剥离） | ✅ 完成 | `wt-term`，28 个测试 |
| 本地终端（ConPTY + TermSession） | ✅ 完成 | `wt-term` 40 个测试；真实 shell 启停、输入回显、resize、背压 ack、反复开关 |
| SSH 协议层（算法/主机密钥/连接/通道/双认证/TOFU/终端会话） | ✅ 完成 | `wt-ssh` 57 个测试，含进程内 mock 服务端的正向路径与终端回显验收 |
| 统一终端抽象 | ✅ 完成 | `TerminalSession` trait：本地 PTY 与 SSH 通道同一套 read/ack 背压模型 |
| `wt` CLI | ✅ 可用 | `version` / `doctor` / `local exec` / `ssh exec` / `ssh shell`（交互式，接管本机终端）/ `sftp`；密码、私钥、ssh-agent 三种认证 + known_hosts 校验 |
| IPC 数据面（`wt-ipc`） | ✅ 完成 | 会话注册表 + 拉取式二进制读取 + 未确认字节背压 + 事件节流；7 个测试 |
| MobaXterm 迁移（`SES-020`） | ✅ 可用 | `wt session import/list`：树结构还原、Rlogin 跳过并说明、重复导入按 name+host+port 与会话/文件夹去重 |
| SFTP（列目录 / 下载 / 上传 / 文件管理） | ✅ CLI + 界面 | `wt sftp ls/get/put` + `wt-ssh::SftpClient`（含 `create_dir` / `rename` / `remove_dir` / `remove_file`）；用例覆盖报文级（内存管道）、真实 SSH 通道、CLI 真实执行路径。界面文件面板：**顶部可切「对着哪台机器」**（跟随连接表单或选某个会话，各自记住浏览位置）、单击选中、双击进入目录或下载、同名自动改名不覆盖、上传本地文件（**前端按 64 KB `File.slice` 逐块发送，写句柄跨命令存活——整文件不再进内存**，进度来自真实写入）、**拖拽文件进面板即上传**、**新建目录 / 改名 / 删除**（删除二次确认；非空目录由服务端拒绝并说明原因）。**拖出去下载**需要额外插件，见 `G10` |
| 终端剪贴板（`TER-011` / `TER-013` / `TER-023`） | ✅ 可用 | 双击选整词（含 `user@host:/var/log` 这种串）、选中即复制、`Ctrl+Shift+C` / `Ctrl+Insert` 复制、`Ctrl+Shift+V` / `Shift+Insert` 粘贴、多行粘贴确认（取消后零字节）、bracketed paste 遵守 `?2004`；右键粘贴见 `G11` |
| 端口转发（`NET-001` / `NET-002` / `NET-003` / `NET-004` / `NET-005`） | ✅ 可用（`-L` + `-R` + `-D`） | 本地转发 `-L`：本地监听 → SSH `direct-tcpip` → 远端目标。远程转发 `-R`：**服务端**监听，连接进来转回本机目标（`tcpip-forward` + `forwarded-tcpip`，`port=0` 由服务端分配）。动态代理 `-D`：本地 SOCKS5（CONNECT-only，域名交给服务端解析，**可选用户名密码认证**——带认证的隧道不落库，重启后需重填）。三者共用同一套统计与失败上报：`port=0` 回填实际端口、双向字节计数、半关闭不丢数据、监听 `0.0.0.0` 需显式确认、失败原因可见（红点 + 上次错误）、**每隧道并发上限 64**（超限的连接立刻关闭并单独计「拒绝 N」，不与累计连接数混在一起）。**配置落库**：停止后仍留在列表（灰灯），可「启动」/「删除」；`autoStart` 在保险库解锁后或打开面板时自动拉起 |
| SSH 跳板机（`SES-024` 单跳） | ✅ 界面可用 | `wt_ssh::connect_via`：登录跳板机 → `direct-tcpip` 到目标 → 在通道上做**第二次 SSH 握手**。跳板机可以存成**会话属性**（`options.jumpSessionId`，保存时做环检测，最多 5 跳）——点会话就自动带出跳板配置，不用每次重填；也可以就地手填。SSH / SFTP / 隧道三条路径共用同一条链路。错误带「第 N 跳（host:port）」定位，`AllowTcpForwarding no` 有专项报错。CLI 侧 `--jump user@host[:port]` 走的是同一条 `connect_target` 链路（`ssh exec` / `ssh shell` / `sftp` 都支持，跳板机凭据 `--jump-password` / `--jump-key` / `--jump-agent` 必须另给） |
| 其余协议（RDP / VNC） | ⬜ 未开始 | — |
| UI 壳（Tauri 2 + xterm.js） | ✅ 可交互 | 端到端验收 **115 项**通过（`scripts/e2e-desktop.mjs`）：本地终端全链路 + 多标签 + 查找/字号 + 剪贴板（选词/复制/粘贴/多行确认/bracketed paste）+ 文件管理（新建目录/改名/删除二次确认）+ 拖拽上传 + 分块上传/真实进度 + 文件面板按会话切换与路径记忆 + 隧道（`-L` 启动/穿透收发/统计/停止/局域网确认 + `-D` SOCKS5 代理/**代理认证**/停止 + 停止后保留配置/一键重启守卫 + autoStart 仅靠保险库凭据拉起 + `-R` 服务端端口转回本机）+ 跳板机（两跳连接/横幅/双主机密钥/存成会话属性/环引用被拒/取消跳板）+ 会话树（新建/删除/过滤/导入含 GBK）+ SSH 密码/密钥/**agent** 三种认证 + TOFU + 保险库（存/填/列/删）+ SFTP 文件面板（列目录/下载/上传）+ 错误路径 + 三条防「沉默失效」的自检（前端版本、内嵌资源一致性、页面任务队列活性） |

实现按 [`docs/spec/14-roadmap-acceptance.md`](docs/spec/14-roadmap-acceptance.md) 的里程碑推进。

```bash
cargo test --workspace      # 247 个测试
cargo clippy --workspace --all-targets   # 零告警

# 跑一下 CLI（真实 PTY）
cargo run -p wt-cli -- doctor
cargo run -p wt-cli -- local exec -- cmd /c "echo hello"     # Windows
cargo run -p wt-cli -- local exec -- sh -c "echo hello"      # Unix
cargo run -p wt-cli -- ssh exec --host H --user U --password P --insecure-host-key -- uptime

# 用 ssh-agent（私钥不出 agent）：Windows 先启动「OpenSSH Authentication Agent」服务，
# 或 Windows 上用 Pageant；Unix 让 SSH_AUTH_SOCK 指向 agent socket
cargo run -p wt-cli -- ssh exec --host H --user U --agent -- uptime

# 远端交互式 shell（接管本机终端；Ctrl+C 发给远端，Ctrl+D 退出）
cargo run -p wt-cli -- ssh shell --host H --user U --agent

# 经跳板机（单跳）：目标由跳板机侧解析；跳板机的凭据必须另给，不继承目标机的
cargo run -p wt-cli -- ssh exec --host 10.0.3.44 --user root --password P --jump admin@bastion:2222 --jump-password JP -- uptime

# 文件传输（认证参数与 ssh exec 一致，也支持 --key 与 --jump）
cargo run -p wt-cli -- sftp ls  --host H --user U --password P --path /var/log
cargo run -p wt-cli -- sftp get --host H --user U --password P --remote /etc/hosts --local hosts.txt
cargo run -p wt-cli -- sftp put --host H --user U --password P --local hosts.txt --remote /tmp/hosts.txt

# 桌面壳（会打开窗口）：填主机/用户名/密码点「连接 SSH」，或「新建本地终端」
cargo run -p wt-desktop

# 桌面端端到端验收（自动点按钮、打字、断言界面输出；会自己起停窗口）
# 必须带 e2e-mock：界面要验 SSH，就得有一台「服务器」，本机没有 sshd
cargo build -p wt-desktop --features e2e-mock && node scripts/e2e-desktop.mjs

# 从 MobaXterm 迁移（导入后界面点「刷新」就能看到）
cargo run -p wt-cli -- session import --file "C:\Users\me\Documents\MobaXterm\MobaXterm.ini"
cargo run -p wt-cli -- session list
```

前端没有构建步骤：`apps/wt-desktop/ui/vendor/` 里内联了 xterm.js 6.0.0、addon-fit 0.11.0
与 addon-search 0.16.0（均为 MIT，许可证随文件一起放在同目录）。`scripts/e2e-desktop.mjs` 靠 `WT_CDP_PORT`
让 `wt-desktop` 给 WebView2 打开 CDP 端口，再用可信鼠标/键盘事件驱动界面——
不是 `el.click()` 那种假事件，因此能覆盖键位编码与焦点链路。

界面「点了没反应」时用这两个工具定位，不要靠猜：

- `WT_TRACE=1`：把后端命令的分步埋点写进 `%TEMP%\wt-trace.log`（默认关闭，避免用户没要过的写盘副作用）。
  它能区分「命令跑完但响应没送回」和「命令压根没跑完」——前者有 `[离开]` 行，后者没有。
  `scripts/e2e-desktop.mjs` 已默认打开，验收失败后直接读这个文件。
- `node scripts/probe-sftp.mjs`：最小探针，只跑「连上一台 mock SSH → 打开文件面板」，
  连同页面 console 与埋点尾部一起打出来，不受其余 50 多项断言干扰。

### 已知缺口（不隐藏）

| # | 缺口 | 影响 | 计划 |
|---|---|---|---|
| G1 | `Algos` / `CompatFlags` 未映射到 `russh::Preferred` | 连老服务器时无法开启弱算法（`SES-001` AC-2） | 需手写 `kex::Name` 等枚举映射表 |
| ~~G2~~ | ~~SSH 正向路径无自动化测试~~ | ✅ 已补齐：进程内 mock 服务端，覆盖握手/认证/exec/PTY/TOFU | — |
| G3 | `.ppk` 只支持未加密的 ed25519；agent 只接**本机** agent（不支持转发到远端） | RSA 或带口令的 `.ppk` 需 puttygen 转一次；远端主机想复用本机 agent 时不行 | `.ppk` 其余类型视需求补；agent 转发属 `SES-001` AC-8，独立一轮 |
| ~~G4~~ | ~~本地 PTY 关闭挂起~~ | ✅ 已修复：根因是未应答 ConPTY 的 `ESC[6n` 光标查询，补上应答后子进程输出与关闭均正常 | — |
| G5 | 非 SSH 会话点不动；保险库只能按会话存密码，没有「主密码提示/恢复」机制 | RDP/VNC 会话只能看不能连；主密码忘了保险库就打不开 | 对应协议栈 + 保险库恢复流程（`SEC-*`） |
| ~~G8~~ | ~~界面里没有 SFTP 文件面板~~ | ✅ 已实现：列目录、进出目录、双击下载到本地（同名自动改名不覆盖）、上传本地文件；传输走真实 SSH + SFTP | — |
| G8 复盘 | 这个缺口排查了七轮才收口，三个根因都不是「SFTP 不行」，值得记下来 | ① **测试保真度**：`russh_sftp` 的 `FileAttributes::dummy()` 把 `permissions` 写死成 `0o777 \| S_IFDIR`，mock 于是把**每个**条目都报成目录——`notes.txt` 渲染成 `notes.txt/`，而断言在等 `notes.txt`。列目录其实一直是成功的。② **断言会撒谎**：轮询里对「msg 非空」抛错，超时后报的是**第一次**轮询的「读取中…」，于是「成功但条件不匹配」被读成「后端挂起」。③ **IPC 一直走回退路径**：CSP 缺 `connect-src 'self' ipc: http://ipc.localhost`，每次 `invoke` 都先 `fetch` 失败再退到 postMessage。三处都已修，并补了三条常驻断言：前端版本标记、内嵌资源与磁盘源文件逐字节一致、有终端会话时定时器与 rAF 仍在跑 | — |
| G10 | 文件面板还缺：**断点续传**（已有流式分块与真实进度，但没记录 offset 的续传）、**拖出去下载**（WebView2 里 `DownloadURL` 只支持 http/data URL，要真拖出需额外插件）；面板按会话切换时用的是该会话的 host/port/user，密码仍取表单或保险库 | 大文件能传、有进度、内存友好，但中断后要重传；拖出不行 | 下一步：续传（`begin` 加 `offset`，用 `File.slice(offset)` 接着发）需要一份传输记录 |
| G11 | 右键 / 中键粘贴暂时不可用：WebView2 里 `navigator.clipboard.readText()` 要剪贴板读权限，当前构建拿不到（既不 resolve 也不 reject） | 键盘路径（`Ctrl+V` / `Ctrl+Shift+V` / `Shift+Insert`）完全可用；右键会明确提示「读剪贴板被拒绝，请用 Ctrl+Shift+V」，不会静默无反应 | 需要 Rust 侧读剪贴板：接 `tauri-plugin-clipboard-manager`，或自己用 `arboard`。**两者在 Linux 上都会引入 X11 客户端依赖**，与 ADR-0012 的「零 X11 依赖」取向相关，须先定调再动手 |
| G12 | `TER-020` 快捷键体系还没做：键位写死在 `main.js`，不能重绑、不能导出 | 现有键位够用，但用户改不了，也不符合规格的「全部可重绑 + 冲突检测」 | 等设置体系（`SET-001`）落地后一起做键位表 |
| G13 | 隧道仍缺：`autoStart` 只在**保险库解锁后**或打开隧道面板时触发（冷启动拿不到凭据）；「启动已保存的隧道」要求承载会话在保险库里存过密码；SOCKS5 只支持 `CONNECT`（`BIND`/`UDP ASSOCIATE` 按规格回 `0x07`），认证走 RFC 1929 用户名密码（**带凭据的隧道不落库**，重启后要重填）；并发上限固定 64、不可按隧道配置（`TunnelSpec` 加字段要一次 schema 迁移）；`-R` 需要服务端允许 `AllowTcpForwarding`（监听非回环地址还要 `GatewayPorts`） | 自动重连（崩溃恢复）仍要手工；`-R` 在受限 sshd 上会启动失败 | 下一步：要不要做「主密码托管」以支持冷启动自动拉起（安全取舍） |
| G14 | 跳板机的 CLI 入口（`--jump`）已做，但**只支持单跳**（`SES-025` 多跳未做）；CLI 不自动 TOFU——跳板机与目标的主机密钥要预先信任或加 `--insecure-host-key`；CLI 读不到保险库，跳板机与目标的口令都得手填 | 命令行能过跳板了；多跳链路仍要拆成两段手工操作 | 多跳要先把 `design/10` §1 的 `StreamProvider` 抽象补上；TOFU 交互与保险库接入要等 CLI 有密码输入路径 |
| G6 | 没有分屏、主题自定义 | 多会话已用标签页解决；查找与字号已可用（Ctrl+F / Ctrl+±） | 随 `TER-01x` / `SET-00x` 推进 |
| G9 | `wt ssh shell` 的**交互路径**没有在真实 sshd 上验证过（本机无 sshd） | 参数解析、连接失败与「连接前不碰终端」已验证；raw 模式下的按键转发、窗口尺寸、远端退出后恢复终端只能靠人工试 | 拿到真实 sshd 后走一遍：`ls` 有颜色、方向键可用、`Ctrl+C` 中断、`Ctrl+D` 退出后本机终端正常 |
| ~~G7~~ | ~~非 UTF-8 的 ini 会让中文名乱码~~ | ✅ 已修复：`wt_import::decode_ini` 先按 UTF-8 严格解、失败再按 GBK；导入结果里显示用了哪种编码 | — |

---

## 这是什么

MobaXterm 是 Windows 上最受欢迎的远程运维工具箱，但它有三个无法回避的限制：**仅支持 Windows**、**闭源**、**免费版限制较多（会话数、隧道数、宏等）**。

WindTerm 的目标是把它完整地重做一遍，并补上它没有的东西：

| 维度 | MobaXterm | WindTerm |
|---|---|---|
| 平台 | 仅 Windows | Windows / macOS / Linux 三平台同源 |
| 许可 | 闭源（免费版受限） | Apache-2.0，代码可审计、可自建 |
| 会话 | INI 文件，弱结构 | SQLite + 结构化模型，可查询、可同步、可审计 |
| 终端 | PuTTY 内核 | 可插拔 VT 内核（xterm.js → 自研 Rust 内核的可迁移路径） |
| 扩展 | `.mxt3` 插件（只装二进制） | 带签名与权限清单的插件包 + 包管理器 |
| 自动化 | 宏录制 | 宏录制 + 可脚本化 CLI + 无头模式 |
| 安全 | 主密码 | 主密码 + Argon2id/AEAD 保险库 + OS 钥匙串 + 审计日志 |
| 数据外发 | 无 | 无遥测，默认完全离线 |

功能覆盖的判定标准不是「像不像 MobaXterm」，而是 **MobaXterm 用户能否在不损失工作流的前提下整体迁移过来**。
逐条对照见 [`docs/spec/04-feature-matrix.md`](docs/spec/04-feature-matrix.md)。

## 文档地图

```
docs/
├── README.md                  # 文档总索引、阅读顺序、状态与约定
├── spec/                      # 第一册：产品规格说明书（What / Why）
│   ├── 00-index.md
│   ├── 01-positioning.md             产品定位、竞品、边界、许可
│   ├── 02-users-and-scenarios.md     目标用户、核心场景、任务流
│   ├── 03-requirement-model.md       需求编号体系、优先级、验收口径
│   ├── 04-feature-matrix.md          ★ MobaXterm 特性覆盖矩阵（逐条）
│   ├── 05-func-sessions.md           连接与会话管理
│   ├── 06-func-terminal.md           终端仿真
│   ├── 07-func-files.md              文件传输与编辑
│   ├── 08-func-remote-desktop.md     远程桌面（RDP / VNC）
│   ├── 09-func-network.md            网络工具与隧道
│   ├── 10-func-local-shell.md        本地 Shell 与内置工具
│   ├── 11-func-security.md           安全与凭据
│   ├── 12-func-settings-extensions.md 设置、个性化、扩展与插件
│   ├── 13-nonfunctional.md           非功能需求
│   └── 14-roadmap-acceptance.md      版本路线图与验收标准
├── design/                    # 第二册：详细设计（How）
│   ├── 00-index.md
│   ├── 01-architecture.md            总体架构、技术选型、crate 划分
│   ├── 02-process-and-ipc.md         进程模型、IPC 协议、背压
│   ├── 03-terminal-subsystem.md      终端子系统
│   ├── 04-data-model.md              数据模型、持久化、迁移
│   ├── 05-ssh-stack.md               SSH 协议栈
│   ├── 06-file-transfer.md           SFTP/SCP/FTP 传输引擎
│   ├── 07-rdp-stack.md               RDP 协议栈
│   ├── 08-vnc.md                     VNC 与图形会话截图
│   ├── 09-credentials-crypto.md      凭据与加密
│   ├── 10-tunnels-jump.md            隧道与跳板机
│   ├── 11-local-shell-vfs.md         本地 Shell 与虚拟文件系统
│   ├── 12-plugins-packages.md        插件与包管理
│   ├── 13-frontend-ui.md             前端架构与 UI 规范
│   ├── 14-build-release.md           构建、打包、发布
│   ├── 15-testing.md                 测试策略与质量门禁
│   └── 16-observability.md           可观测性与诊断
└── appendix/
    ├── a-adr-index.md         架构决策记录索引
    ├── b-glossary.md          术语表
    └── c-references.md        参考资料与事实来源
```

**建议阅读顺序**：`docs/README.md` → `spec/01` → `spec/03` → `spec/04` → 按模块读 `spec/05~12` → `design/01` → `design/02` → 按模块读 `design/03~16`。

## 事实来源

规格中关于 MobaXterm 的一切描述都来自其官方页面（抓取于 2026-11-02，快照见 `.research/`）：

- 特性清单：<https://mobaxterm.mobatek.net/features.html>
- 帮助文档：<https://mobaxterm.mobatek.net/documentation.html>
- 插件清单：<https://mobaxterm.mobatek.net/plugins.html>

本项目与 Mobatek 无任何关联，MobaXterm 是 Mobatek 的注册商标。本项目仅做功能对标与兼容性设计。

## 许可

本项目自有代码采用 **Apache-2.0**。
MSYS2 等以 GPL 发布的可选组件**不随主安装包分发**，由用户自行安装；X11 相关能力已整体移除（ADR-0012），不再涉及 X Server 分发问题。详见
[`docs/spec/01-positioning.md`](docs/spec/01-positioning.md) 的「许可与合规」一节与 [`docs/appendix/a-adr-index.md`](docs/appendix/a-adr-index.md) 的 ADR-0007。

## 参与

文档阶段欢迎对**规格遗漏**与**设计风险**提 issue。实现阶段开始后见 `CONTRIBUTING.md`（待建）。
