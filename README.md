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
| `wt` CLI | ✅ 可用 | `version` / `doctor` / `local exec` / `ssh exec`（密码与密钥认证、known_hosts 校验）；ANSI 默认剥离、退出码透传 |
| IPC 数据面（`wt-ipc`） | ✅ 完成 | 会话注册表 + 拉取式二进制读取 + 未确认字节背压 + 事件节流；7 个测试 |
| MobaXterm 迁移（`SES-020`） | ✅ 可用 | `wt session import/list`：树结构还原、Rlogin 跳过并说明、重复导入按 name+host+port 与会话/文件夹去重 |
| SFTP（列目录 / 下载 / 上传） | ✅ CLI 可用 | `wt sftp ls/get/put`（认证参数与 `ssh exec` 一致）+ `wt-ssh::SftpClient`；3 个用例覆盖真实 SFTP 报文 + 1 个覆盖子系统失败映射。**界面入口还没做** |
| 其余协议（RDP / VNC / 隧道） | ⬜ 未开始 | — |
| UI 壳（Tauri 2 + xterm.js） | ✅ 可交互 | 端到端验收 51 项通过（`scripts/e2e-desktop.mjs`）：本地终端全链路 + 多标签 + 查找/字号 + 会话树（新建/删除/过滤/导入含 GBK）+ SSH 密码/密钥双认证 + TOFU + 保险库（存/填/列/删）+ 错误路径 |

实现按 [`docs/spec/14-roadmap-acceptance.md`](docs/spec/14-roadmap-acceptance.md) 的里程碑推进。

```bash
cargo test --workspace      # 238 个测试
cargo clippy --workspace --all-targets   # 零告警

# 跑一下 CLI（真实 PTY）
cargo run -p wt-cli -- doctor
cargo run -p wt-cli -- local exec -- cmd /c "echo hello"     # Windows
cargo run -p wt-cli -- local exec -- sh -c "echo hello"      # Unix
cargo run -p wt-cli -- ssh exec --host H --user U --password P --insecure-host-key -- uptime

# 文件传输（认证参数与 ssh exec 一致，也支持 --key）
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

### 已知缺口（不隐藏）

| # | 缺口 | 影响 | 计划 |
|---|---|---|---|
| G1 | `Algos` / `CompatFlags` 未映射到 `russh::Preferred` | 连老服务器时无法开启弱算法（`SES-001` AC-2） | 需手写 `kex::Name` 等枚举映射表 |
| ~~G2~~ | ~~SSH 正向路径无自动化测试~~ | ✅ 已补齐：进程内 mock 服务端，覆盖握手/认证/exec/PTY/TOFU | — |
| G3 | ssh-agent 转发未实现；`.ppk` 只支持未加密的 ed25519 | 无法用 ssh-agent 免密；RSA 或带口令的 `.ppk` 仍需 puttygen 转一次 | agent 下一迭代；`.ppk` 的其余类型视需求补 |
| ~~G4~~ | ~~本地 PTY 关闭挂起~~ | ✅ 已修复：根因是未应答 ConPTY 的 `ESC[6n` 光标查询，补上应答后子进程输出与关闭均正常 | — |
| G5 | 非 SSH 会话点不动；保险库只能按会话存密码，没有「主密码提示/恢复」机制 | RDP/VNC 会话只能看不能连；主密码忘了保险库就打不开 | 对应协议栈 + 保险库恢复流程（`SEC-*`） |
| G8 | SFTP 只有 CLI，界面里没有文件面板 | 文件传输要开终端敲命令，不能像 MobaXterm 那样拖文件 | 下一轮：界面文件面板 |
| G6 | 没有分屏、主题自定义 | 多会话已用标签页解决；查找与字号已可用（Ctrl+F / Ctrl+±） | 随 `TER-01x` / `SET-00x` 推进 |
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
