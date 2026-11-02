# 04 · MobaXterm 特性覆盖矩阵

> **本文是需求基线。** 任何「这个功能做不做」的争论，先查这张表。
> 表中每一条都有决策；不允许出现「待定」。变更需走 `spec/03` §8 的流程。

## 0. 怎么读这张表

### 出处标记

| 标记 | 含义 |
|---|---|
| `F:<name>` | `https://mobaxterm.mobatek.net/features.html` 的特性块（18 个） |
| `D:<n.n>` | `https://mobaxterm.mobatek.net/documentation.html` 的章节号 |
| `P:<name>` | `https://mobaxterm.mobatek.net/plugins.html` 的插件条目 |
| `H:<topic>` | 帮助文档第 5 章「How to」与第 6 章 FAQ 中揭示的隐含需求 |

原始文本快照见仓库 `.research/`（`mobaxterm-features.txt` / `mobaxterm-documentation.txt` / `mobaxterm-plugins.txt`）。

### 决策标记

`P0` 必须 · `P1` 重要 · `P2` 增强 · `P3` 观察 · `NO` 不做 · `ALT` 替代实现

### 兼容性（仅 `ALT` 需要）

`C1` 完全兼容 · `C2` 等价 · `C3` 部分 · `C4` 不兼容（定义见 `spec/03` §3.3）

### 统计口径

MobaXterm 官网特性块共 **18** 个；帮助文档可枚举的配置项/能力约 **150** 条。本表合并去重后共 **229** 条需求，其中功能需求 **203** 条、非功能需求 **26** 条。
「全覆盖」指 229 条全部有决策，**不等于全部实现**——`NO` 与 `P3` 也是决策。

---

## 1. SES · 会话与连接（30 条）

| ID | 特性 | 出处 | 优先级 | 兼容 | 决策与差异 | 规格 |
|---|---|---|---|---|---|---|
| SES-001 | SSH 会话 | `F:sessions` `D:4.1` | **P0** | C1 | 完整实现 SSH-2：密码/公钥/keyboard-interactive/GSSAPI(可选)/agent 转发/keepalive/压缩；覆盖 MobaXterm 4.1 的全部选项 | `spec/05` §3.1 |
| SES-002 | Telnet 会话 | `F:sessions` `D:4.2` | P1 | C1 | 支持 RFC 854 + NAWS/TTYPE/ECHO/LINEMODE 子集；**明文协议，首次使用需确认风险** | `spec/05` §3.2 |
| SES-003 | Rlogin 会话 | `F:sessions` `D:4.3` | **NO** | C4 | 协议已被 SSH 取代，服务端默认关闭，安全评审必然否决。**保留导入能力**（迁移时不丢数据，灰显+说明） | `spec/05` §3.9 |
| SES-004 | Rsh 会话 | `F:sessions` | **NO** | C4 | 同上，且完全无认证 | `spec/05` §3.9 |
| SES-005 | RDP 会话 | `F:rdp` `D:4.4` | **P0** | C1 | 完整 RDP 客户端（见 `GUI-015`~`GUI-026`）。MobaXterm 把 RDP 作为一等公民，我们必须同等对待 | `spec/05` §3.3 |
| SES-006 | VNC 会话 | `F:sessions` `D:4.5` | P1 | C1 | RFB 3.3/3.7/3.8 + VeNCrypt；见 `GUI-028` | `spec/05` §3.4 |
| SES-008 | FTP 会话 | `F:sessions` `D:4.6` | P1 | C1 | 主动/被动、FTPS（显式 AUTH TLS）、数据通道加密、ASCII 模式 | `spec/05` §3.6 |
| SES-009 | SFTP 会话 | `F:sftp-browser` `D:4.7` | **P0** | C1 | 独立 SFTP 会话 + SSH 会话内嵌浏览器两种入口 | `spec/05` §3.7 |
| SES-010 | Mosh 会话 | `D:4.8` | P1 | C3 | 自行实现 SSP 协议（`windterm-mosh`）；**服务端前置条件：`mosh-server` 必须存在**，缺失时明确报错并给出安装命令 | `spec/05` §3.8 |
| SES-011 | 串口会话 | `F:sessions` | P1 | C1 | 波特率/数据位/停止位/校验/流控；枚举本机串口；热插拔检测 | `spec/05` §3.10 |
| SES-012 | 会话自动保存 | `F:sessions` `D:1.2` | **P0** | C1 | 新建即入库；**不允许「未保存的会话」概念**（MobaXterm 的「每个会话自动保存」是它的粘性来源之一） | `spec/05` §4.2 |
| SES-013 | 会话树与文件夹 | `F:sessions` `D:1.2` | **P0** | C1 | 无限层级、拖拽排序、多选、折叠状态持久化 | `spec/05` §4.1 |
| SES-014 | 会话上下文菜单 | `D:1.2` | **P0** | C1 | 编辑/复制/删除/重命名/移动到/新建子文件夹/在此启动/导出 | `spec/05` §4.3 |
| SES-015 | 导入/导出会话 | `D:6.7.5` | P1 | C2 | 导出为 JSON（自有格式）+ 可选导出为 MobaXterm `.ini` 片段；导入支持 JSON / MobaXterm ini / `~/.ssh/config` | `spec/05` §4.5 |
| SES-016 | 会话桌面快捷方式 | `D:1.2` | P2 | C2 | Windows `.lnk` / macOS `.webloc` 等价物 / Linux `.desktop`；内容为 `wt connect <id>` | `spec/05` §4.6 |
| SES-017 | 文件夹批量启动 | `D:1.2` | P1 | C1 | 右键文件夹「启动全部」；可配「启动后按网格分屏」 | `spec/05` §4.4 |
| SES-018 | 会话搜索 / 标签 / 最近 | 增强 | P1 | — | MobaXterm 只能靠命名约定；我们提供模糊搜索（fzf 式）、标签、最近使用、按环境着色 | `spec/05` §4.7 |
| SES-019 | 会话共享 | `D:5.5` | P1 | C2 | 支持共享目录 / HTTP(S) / FTP(S) / SFTP 四种后端拉取只读会话集；冲突时以本地为准并提示 | `spec/05` §4.8 |
| SES-020 | MobaXterm 配置导入 | `D:6.7.7` `D:6.7.8` | **P0** | C1 | 解析 `MobaXterm.ini`：会话树、全部字段、加密密码（需主密码）、全局设置。**这是唯一的入场券** | `spec/05` §5 |
| SES-021 | 快速连接 | `H:quick-connect` | P1 | C1 | 一个输入框解析 `user@host:port`、`ssh://`、`rdp://`、`sftp://`；`Ctrl+Shift+Q` | `spec/05` §4.9 |
| SES-022 | 命令面板 | 增强 | P2 | — | `Ctrl+Shift+P` 搜索全部动作（不只会话），对齐现代编辑器习惯 | `spec/05` §4.10 |
| SES-023 | 云端会话同步 | 增强 | P3 | — | 我们不运营服务端；用户可用 `SES-019` 的共享后端自建。不做专有同步协议 | `spec/05` §4.8 |
| SES-024 | SSH 跳板机（单跳） | `F:ssh-gateway` `D:4.10` | **P0** | C1 | 任一连接类型都可指定前置 SSH 主机；复用已建立连接（连接池） | `spec/05` §6.1 |
| SES-025 | 多跳跳板 | 增强 | P1 | — | MobaXterm 只能单跳；我们支持链式最多 5 跳，并可视化链路 | `spec/05` §6.2 |
| SES-026 | SOCKS / HTTP 代理 | `H:socks` | P1 | C1 | SOCKS5（含用户名密码）/ SOCKS4 / HTTP CONNECT；可全局或按会话配置 | `spec/05` §6.3 |
| SES-027 | 自动重连 | `D:4.11` | P1 | C1 | 可配次数/间隔/退避；重连后保留滚动缓冲并插入断连标记；Mosh 会话不做重连（协议自愈） | `spec/05` §6.4 |
| SES-028 | 连接诊断 | 增强 | P1 | — | 分层展示：DNS → TCP → SSH 握手 → 认证 → 通道；每层耗时与失败原因。**MobaXterm 完全没有这个能力**，是排障体验的关键差异点 | `spec/05` §6.5 |
| SES-029 | 会话克隆 | 增强 | P2 | — | 右键「复制会话」，保留全部字段但清空名称后缀 | `spec/05` §4.3 |
| SES-030 | 环境分组与颜色标识 | 增强 | P2 | — | 生产/预发/测试用颜色条与标签页边框区分，降低误操作概率 | `spec/05` §4.7 |

---

## 2. TER · 终端仿真（34 条）

| ID | 特性 | 出处 | 优先级 | 兼容 | 决策与差异 | 规格 |
|---|---|---|---|---|---|---|
| TER-001 | 多标签终端 | `F:terminal` `D:1.3` | **P0** | C1 | 标签可拖拽排序、重命名、中键关闭、溢出滚动 | `spec/06` §3.1 |
| TER-002 | 分屏（2/4 宫格） | `D:1.3` `D:5.3` | P1 | C1 | 水平/垂直 2 分屏、4 分屏；分屏内可继续嵌套（MobaXterm 只支持一级） | `spec/06` §3.2 |
| TER-003 | 标签分离为独立窗口 | `D:2.1.3` | P2 | C2 | 不做跨进程窗口 reparent；改为「同一进程内多窗口」（每个窗口一个 WebView 实例） | `spec/06` §3.3 |
| TER-004 | 多执行广播 | `F:multiexec` `D:1.3` | **P0** | C1 | 两种模式：实时广播 / 确认后广播；结果聚合视图（按输出一致性分组）；危险命令拦截 | `spec/06` §3.4 |
| TER-005 | 配色与字体 | `D:3.2` | **P0** | C1 | 内置 ≥ 20 套配色；字体可指定 family/size/行高/字距；等宽字体检测；字体缺失回退提示 | `spec/06` §4.1 |
| TER-006 | 字符集与编码 | `D:3.2` `H:charset` | **P0** | C1 | UTF-8 默认；GB18030/GBK/Big5/Shift-JIS/ISO-8859-x；**支持运行时切换且不丢已显示内容**（MobaXterm 需重启会话） | `spec/06` §4.2 |
| TER-007 | 背景透明与皮肤 | `D:2.1.6` | P2 | C2 | 支持背景图/透明度/毛玻璃；macOS 用 vibrancy，Windows 用 Mica/Acrylic（Win11） | `spec/06` §4.3 |
| TER-008 | 滚动缓冲 | `D:3.2` | **P0** | C1 | 默认 10 000 行，可配至 1 000 000；内存上限保护（超限淘汰并提示） | `spec/06` §4.4 |
| TER-009 | 终端内搜索 | `D:5.3` | P1 | C1 | 正则/大小写/全词；高亮全部命中并显示 `n/m`；`Ctrl+Shift+F` | `spec/06` §4.5 |
| TER-010 | 语法高亮 | `F:syntax-highlighting` `D:3.2` | P2 | C1 | 基于「行文本 + 正则规则集」的装饰器，不依赖远端支持颜色；内置 nginx/java/log4j/python/dmesg/ip 等规则集；支持用户自定义 JSON 规则 | `spec/06` §4.6 |
| TER-011 | 选择 / 复制 / 粘贴 | `D:3.2` `H:rightclick-paste` | **P0** | C1 | 左键选择、双击选词（可配分隔符）、三击选行；`Ctrl+Shift+C/V`；**右键粘贴可配**，开启后右键菜单用 `Ctrl+右键`/`Shift+右键` 唤出 | `spec/06` §4.7 |
| TER-012 | 列（块）选择 | `D:5.3` | P1 | C1 | `Ctrl+Alt+拖拽`，用于选中表格化输出 | `spec/06` §4.7 |
| TER-013 | 多行粘贴告警 | `D:3.2` | P1 | C1 | 粘贴内容含 ≥ 2 个换行时确认；可配白名单（如 vim 内不告警） | `spec/06` §4.8 |
| TER-014 | 粘贴延迟 | `D:4.9` | P2 | C1 | 按行/按字节节流，适配慢速远端；默认关闭 | `spec/06` §4.8 |
| TER-015 | 终端日志记录 | `D:3.2` `H:log-encoding` | P1 | C1 | 双模式：**原始字节流**（保真，用于回放）与**纯文本**（可读）。MobaXterm 只给原始流且不说明，导致用户拿到乱码文件——我们默认纯文本 + ANSI 可选 | `spec/06` §4.9 |
| TER-016 | 保存终端文本 | `H:log-encoding` | P1 | C1 | 保存可见区/全部滚动缓冲；可选保留颜色（ANSI/HTML） | `spec/06` §4.9 |
| TER-017 | 标签活动指示 | `D:3.2` | P2 | C1 | 非活动标签有新输出时显示圆点；可配「仅当输出匹配关键词时提醒」 | `spec/06` §3.1 |
| TER-018 | 关闭确认 | `D:3.2` | P1 | C1 | 有前台进程运行时确认；可配「永远不确认」 | `spec/06` §3.1 |
| TER-019 | 标题锁定 | `D:4.11` | P2 | C1 | 锁定后忽略远端 `OSC 0/2` 改标题 | `spec/06` §3.1 |
| TER-020 | 快捷键体系 | `D:5.3` `D:3.1` | **P0** | C1 | 覆盖 MobaXterm 全部 30+ 快捷键；全部可重绑；冲突检测；可导出/导入键位方案 | `spec/06` §5 |
| TER-021 | URL / 路径识别 | `D:2.2` | P1 | C1 | 自动识别 URL、`file:line`、IP:port、路径；`Ctrl+Click` 打开（URL 用系统浏览器、路径用编辑器、`file:line` 跳到编辑器对应行） | `spec/06` §4.10 |
| TER-022 | 鼠标上报 | 协议要求 | **P0** | C1 | 完整 xterm 鼠标模式（1000/1002/1003/1005/1006/1015）；`Shift+拖拽` 强制本地选择 | `spec/06` §6.1 |
| TER-023 | Bracketed paste | 协议要求 | **P0** | C1 | 遵循 `?2004` 模式 | `spec/06` §6.1 |
| TER-024 | Truecolor | 协议要求 | **P0** | C1 | 24-bit `SGR 38;2` / `48;2`；COLORTERM=truecolor | `spec/06` §6.1 |
| TER-025 | Unicode 宽字符 | `H:charset` | **P0** | C1 | East-Asian Width 正确处理（CJK 占 2 列）、emoji 组合、零宽字符；**这是中文用户的第一道门槛** | `spec/06` §6.2 |
| TER-026 | 终端图形协议 | 增强 | P2 | — | Sixel / iTerm2 inline image / kitty graphics；用于远端直接看图（`ls` 出缩略图） | `spec/06` §6.3 |
| TER-027 | 响铃与通知 | 增强 | P2 | — | 视觉闪烁/系统通知/声音三选；可按会话静音 | `spec/06` §4.11 |
| TER-028 | 命令历史与补全 | 增强 | P2 | — | 本地记录输入历史，跨会话可搜；补全基于历史 + 会话名 + 路径 | `spec/06` §4.12 |
| TER-029 | 弹出式终端 | `D:5.3` | P2 | C1 | 全局热键唤出的 Quake 式下拉终端，贴屏幕顶部，可配高度与动画 | `spec/06` §3.5 |
| TER-030 | 字体连字 | 增强 | P2 | — | 支持 Fira Code 等连字；可关闭（连字会破坏列对齐判断） | `spec/06` §4.1 |
| TER-031 | OSC 8 超链接 | 增强 | P2 | — | 识别远端输出的超链接，`Ctrl+Click` 打开 | `spec/06` §4.10 |
| TER-032 | 终端内分屏（pane） | 增强 | P2 | — | 单标签内左右/上下分割，比 `TER-002` 更细粒度；对标 tmux 使用习惯 | `spec/06` §3.2 |
| TER-033 | 滚动到上次输出位置 | 增强 | P2 | — | 用户上翻查看历史后，新输出到达不强制跳底，显示「↓ 新输出」浮标 | `spec/06` §4.4 |
| TER-034 | 大量输出流控 | 增强 | **P0** | — | MobaXterm 在 `cat` 大文件时会卡死；我们实现信用制背压（见 `NFR-003`）。**这条是「比它更好」而非「和它一样」** | `spec/06` §6.4 |
| TER-035 | 宏录制与回放 | `F:macros` | P1 | C1 | 录制键入序列 + 时间戳 + 等待条件；四种回放模式（原速/加速/逐字/单步）；**参数化宏**（`{{host}}` 回放时填参）是 MobaXterm 没有的能力；`echo off` 期间不记录 | `spec/06` §7 |

---

## 3. FIL · 文件传输与编辑（23 条）

| ID | 特性 | 出处 | 优先级 | 兼容 | 决策与差异 | 规格 |
|---|---|---|---|---|---|---|
| FIL-001 | 图形 SFTP 浏览器 | `F:sftp-browser` `D:1.6` | **P0** | C1 | 左侧边栏树 + 列表；SSH 会话连上即自动打开（可关）；支持多会话并存 | `spec/07` §3.1 |
| FIL-002 | SFTP 协议 | `D:4.7` | **P0** | C1 | SFTP v3（OpenSSH 事实标准）；并发请求窗口、大文件偏移、符号链接、权限位 | `spec/07` §4.1 |
| FIL-003 | SCP 协议 | `D:4.1` | P1 | C1 | 同时支持 legacy SCP 与 OpenSSH 9.0+ 的 SFTP-backed scp；自动协商 | `spec/07` §4.2 |
| FIL-004 | 拖拽传输 | `D:1.6` | **P0** | C1 | 系统文件管理器 → 浏览器（上传）；浏览器 → 桌面/文件夹（下载）；浏览器内拖拽移动 | `spec/07` §3.2 |
| FIL-005 | 双击编辑远端文件 | `F:text-editor` `D:1.6` | **P0** | C1 | 下载到临时区 → 编辑器打开 → 保存时原子写回（临时文件 + rename），保留 mode/owner | `spec/07` §3.3 |
| FIL-006 | 双栏文件管理器 | 增强 | P1 | — | 左本地/右远端，或双远端；支持同步浏览、对比、批量传输 | `spec/07` §3.4 |
| FIL-007 | 传输队列 | 增强 | P1 | — | 并发可配（默认 4）；暂停/恢复/取消/重试；失败原因可见；队列持久化（重启后恢复未完成项） | `spec/07` §4.3 |
| FIL-008 | 递归与符号链接策略 | 增强 | P1 | — | 上传/下载目录时可选：跟随符号链接 / 跳过 / 作为链接复制；防止循环 | `spec/07` §4.4 |
| FIL-009 | 权限与属主修改 | 增强 | P1 | — | 右键属性：`chmod`（含八进制与勾选）、`chown`（需权限）、mtime | `spec/07` §3.5 |
| FIL-010 | 远端文件搜索 | 增强 | P2 | — | 按名称/大小/时间/内容（grep）在远端搜索；内容搜索走 `grep -r` 而非下载 | `spec/07` §3.6 |
| FIL-011 | 内嵌文本编辑器 | `F:text-editor` `D:2.4` | **P0** | C1 | 多标签、语法高亮（≥ 30 语言）、行号、自动缩进、编码与换行符切换、列编辑、查找替换（正则）、大文件保护 | `spec/07` §5 |
| FIL-012 | 文本 Diff | `D:2.4` | P1 | C1 | 并排/行内；忽略空白；三方可选（本地 vs 远端 vs 上次保存） | `spec/07` §6.1 |
| FIL-013 | 文件夹 Diff | `D:2.4` | P2 | C1 | 按名称/大小/哈希比较；可一键同步差异 | `spec/07` §6.2 |
| FIL-014 | 图片查看器 | `D:2.4` | P2 | C1 | 缩放/旋转/全屏/幻灯片；支持远端直接查看（不落盘） | `spec/07` §7 |
| FIL-015 | FTP / FTPS 客户端 | `D:4.6` | P1 | C1 | 见 `SES-008`；文件浏览器复用同一套 UI | `spec/07` §4.5 |
| FIL-016 | rsync 增量同步 | `D:2.3` | P2 | C3 | 若远端有 `rsync` 则用远端 rsync（走 SSH 执行）；否则退回 SFTP 增量（按 size+mtime 比对）。**不内置 rsync 二进制** | `spec/07` §4.6 |
| FIL-017 | 跟随终端路径 | `D:4.1` | P2 | C1 | 解析终端 `OSC 7`（shell 集成）或 `cd` 命令回显；无 OSC 7 时降级为「手动同步」按钮。**不采用 MobaXterm 的实验性 shell 钩子注入**（会污染用户 shell 环境） | `spec/07` §3.7 |
| FIL-018 | 元数据保留 | 增强 | P1 | — | 传输保留 mtime；权限按策略（保留源/统一/询问） | `spec/07` §4.4 |
| FIL-019 | 大文件与断点续传 | 增强 | P1 | — | > 4 GB 支持；中断后可从断点继续（SFTP `FXP_READ` 偏移续传）；进度按字节 | `spec/07` §4.7 |
| FIL-020 | ZMODEM | `P:lrzsz` | P2 | C2 | 在终端内识别 `rz`/`sz` 协商序列并自动接管传输；用于只能走终端通道的场景 | `spec/07` §4.8 |
| FIL-021 | 本地文件管理 | 增强 | P2 | — | 双栏中的本地侧提供基本操作（新建/重命名/删除/打开方式） | `spec/07` §3.4 |
| FIL-022 | 传输限速与并发 | 增强 | P2 | — | 全局与单任务限速（KB/s）；并发数可配；避免占满带宽导致终端卡顿 | `spec/07` §4.3 |
| FIL-023 | 完整性校验 | 增强 | P2 | — | 传输后可选 md5/sha256 比对（本地算 + 远端 `sha256sum`） | `spec/07` §4.7 |

---

## 4. GUI · 图形与远程桌面（35 条）

| ID | 特性 | 出处 | 优先级 | 兼容 | 决策与差异 | 规格 |
|---|---|---|---|---|---|---|
| GUI-015 | RDP 客户端 | `F:rdp` `D:4.4` | **P0** | C1 | 基于 IronRDP；标签内渲染；窗口自适应分辨率；全屏；断开/注销策略 | `spec/08` §2.1 |
| GUI-016 | RDP 增强图形（EGFX） | `D:4.4` | P1 | C2 | 支持 RemoteFX Progressive 与 EGFX(H.264)；H.264 只用 OpenH264 官方二进制（专利授权），可关闭回退 | `spec/08` §2.2 |
| GUI-017 | RDP 驱动器重定向 | `D:4.4` | P1 | C1 | 选择要重定向的本地盘/目录；远端显示为网络驱动器 | `spec/08` §2.3 |
| GUI-018 | RDP 剪贴板重定向 | `D:4.4` | **P0** | C1 | 文本/HTML/图片/文件列表（文件走驱动器重定向）；可配方向（双向/仅本地→远端/仅远端→本地） | `spec/08` §2.3 |
| GUI-019 | RDP 打印机重定向 | `D:4.4` | P2 | C3 | 映射为「打印到 PDF」虚拟打印机（跨平台可行路径）；真实打印机驱动重定向不做 | `spec/08` §2.3 |
| GUI-020 | RDP 端口重定向 | `D:4.4` | P2 | C2 | 串口/并口重定向；仅 Windows 宿主有意义 | `spec/08` §2.3 |
| GUI-021 | RDP 智能卡 | `D:4.4` | P2 | C3 | Windows 用 `NCrypt`/`SCardAPI`；macOS 用 CryptoTokenKit；Linux 用 PC/SC。实现成本高，先记录 | `spec/08` §2.4 |
| GUI-022 | RDP CredSSP / NLA | `D:4.4` | **P0** | C1 | 完整 NLA（CredSSP over TLS/SPNEGO/NTLM）；失败时给出可读错误码翻译 | `spec/08` §2.5 |
| GUI-023 | RDP 控制台会话 | `D:4.4` | P1 | C1 | `/admin` 等价：`SERVER_INFO` 中 `ConsoleSession` 标志 | `spec/08` §2.1 |
| GUI-024 | RDP 多显示器与动态分辨率 | 增强 | P1 | — | 单屏/全部屏/指定屏；窗口缩放时发送 `DISPLAYCONTROL_MONITOR_LAYOUT` | `spec/08` §2.6 |
| GUI-025 | RDP 音频重定向 | 增强 | P2 | — | RDPSND：PCM 播放；录音（音频输入重定向）P3 | `spec/08` §2.7 |
| GUI-026 | RDP 键盘快捷键转发 | `D:4.4` | P1 | C1 | 「快捷键发给远端」开关；`Ctrl+Alt+END` → `Ctrl+Alt+Del`；`Ctrl+Alt+Del` 本地拦截并提示替代键 | `spec/08` §2.8 |
| GUI-027 | RDP RemoteApp | `D:4.4` | **NO** | C4 | 需服务端 RemoteApp 配置，使用面极窄，IronRDP 支持度不足 | — |
| GUI-028 | VNC 客户端 | `D:4.5` | P1 | C1 | RFB 3.3/3.7/3.8；Raw/CopyRect/Hextile/ZRLE/RRE/TRLE 编码；ViewOnly 模式 | `spec/08` §3.1 |
| GUI-029 | VNC 认证 | 增强 | P1 | C1 | VNC Auth（DES 挑战）、VeNCrypt（TLS + 用户名密码/Plain）、Apple ARD；无认证时显式警告 | `spec/08` §3.2 |
| GUI-030 | VNC 剪贴板 | 增强 | P1 | C1 | 双向文本剪贴板 | `spec/08` §3.3 |
| GUI-031 | VNC 缩放与自适应 | 增强 | P1 | — | 等比缩放/适应窗口/1:1；缩放算法可选（最近邻/双线性） | `spec/08` §3.4 |
| GUI-032 | 会话录制 | 增强 | **NO** | C4 | 视频编码与存储负担大，且录制他人桌面有合规风险 | — |
| GUI-033 | RDP 会话重连 | 增强 | P1 | — | 使用 autoreconnect cookie；网络抖动后自动恢复；失败保留窗口 | `spec/08` §2.9 |
| GUI-034 | RDP 证书校验 | `H:rdp-cert` | P1 | C1 | 展示证书主体/颁发者/指纹/有效期；**不提供「永久忽略」**，只提供「本次信任」与「加入信任列表（可撤销）」 | `spec/08` §2.5 |
| GUI-035 | 图形会话截图 | 增强 | P2 | — | 一键截取当前图形会话画面（RDP/VNC），可复制或保存 | `spec/08` §4 |

---

## 5. NET · 网络工具与隧道（18 条）

| ID | 特性 | 出处 | 优先级 | 兼容 | 决策与差异 | 规格 |
|---|---|---|---|---|---|---|
| NET-001 | 本地端口转发 `-L` | `F:ssh-tunnels` `D:2.1.5` | **P0** | C1 | 监听 `127.0.0.1`/`::1`/`0.0.0.0`；端口冲突检测；连接计数 | `spec/09` §3.1 |
| NET-002 | 远程端口转发 `-R` | `F:ssh-tunnels` | P1 | C1 | 请求远端监听；`GatewayPorts` 不支持时明确报错 | `spec/09` §3.2 |
| NET-003 | 动态转发 SOCKS5 `-D` | `F:ssh-tunnels` | P1 | C1 | 本地 SOCKS5 服务（CONNECT + 用户名密码可选）；用于浏览器代理 | `spec/09` §3.3 |
| NET-004 | 图形化隧道管理器 | `F:ssh-tunnels` `D:2.1.5` | **P0** | C1 | 列表 + 状态灯 + 启停 + 编辑；支持分组；可导出/导入 | `spec/09` §4 |
| NET-005 | 隧道生命周期 | 增强 | P1 | — | 随应用启动 / 随会话启动 / 手动；退出应用时的策略；崩溃后恢复 | `spec/09` §4.2 |
| NET-006 | 隧道状态与统计 | 增强 | P1 | — | 状态、连接数、上/下行字节、最后错误、运行时长；日志可查看 | `spec/09` §4.3 |
| NET-007 | 内置 HTTP 服务端 | `F:embedded-servers` `D:2.1.4` | P2 | C2 | 指定根目录/端口/认证（Basic）；用于临时共享文件 | `spec/09` §5.1 |
| NET-008 | 内置 FTP 服务端 | `F:embedded-servers` | P2 | C2 | 只读模式默认；可配用户/密码；被动模式端口范围 | `spec/09` §5.2 |
| NET-009 | 内置 SSH/SFTP 服务端 | `F:embedded-servers` | P2 | C2 | 用于「让同事临时连进来」；仅公钥认证；会话结束即停 | `spec/09` §5.3 |
| NET-010 | 内置 Telnet 服务端 | `D:2.1.4` | **NO** | C4 | 明文协议，提供它等于开后门 | — |
| NET-011 | 内置 TFTP 服务端 | `D:2.1.4` | P3 | C2 | 无认证，仅网络设备升级用；不排期，需要时以插件形式提供 | `spec/09` §5.4 |
| NET-012 | 抓包（TCPCapture） | `D:2.3` | P2 | C2 | 依赖 Npcap（Windows）/ libpcap（macOS/Linux）；**不随包分发驱动**，检测缺失时引导安装。提供 pcap 导出 | `spec/09` §6.1 |
| NET-013 | 端口监听与扫描 | `D:2.3` | P2 | C2 | 本机监听列表（进程名/PID/协议）；远端端口扫描走 SSH 执行 `ss`/`netstat`（不引入扫描器） | `spec/09` §6.2 |
| NET-014 | httping | `D:2.3` | P3 | C2 | 用内置 HTTP 探测器替代（延迟/状态码/TLS 握手耗时），不捆绑 httping 二进制 | `spec/09` §6.3 |
| NET-015 | iperf | `D:2.3` | P3 | C2 | 用内置带宽探测（SSH 通道吞吐）替代；完整 iperf3 客户端 P3 | `spec/09` §6.3 |
| NET-016 | 网络诊断工具箱 | `D:2.3` | P1 | C2 | ping（TCP/ICMP）/ traceroute / dig / nc / TLS 证书检查；统一 UI，结果可复制为文本 | `spec/09` §6.4 |
| NET-017 | 端口连通性测试 | 增强 | P1 | — | 输入 host:port → 显示 DNS 解析、TCP 握手耗时、TLS 握手（可选）、应用层 banner | `spec/09` §6.4 |
| NET-018 | 隧道导入导出 | 增强 | P2 | — | 随会话一起导出；支持从 `ssh -L` 命令行文本导入 | `spec/09` §4.4 |

---

## 6. LOC · 本地环境与内置工具（23 条）

| ID | 特性 | 出处 | 优先级 | 兼容 | 决策与差异 | 规格 |
|---|---|---|---|---|---|---|
| LOC-001 | 本地终端 | `F:terminal` `D:1.5` `D:2.2` | **P0** | C2 | 可配置 shell：PowerShell / cmd / Git Bash / WSL / 自定义。**不打包 Cygwin**（ADR-0003） | `spec/10` §3.1 |
| LOC-002 | POSIX 路径 `/drives` | `D:2.2` | P1 | C2 | 由自有 shell（WindShell）解析；PowerShell 等外部 shell 不识别。提供 `wt path` 转换命令 | `spec/10` §3.2 |
| LOC-003 | `/registry` 虚拟目录 | `D:2.2` | **NO** | C4 | 需内核级虚拟文件系统驱动，代价与收益不成比例。改为 `wt reg get/ls` CLI + GUI 注册表查看器 | — |
| LOC-004 | `//host/share` 网络路径 | `D:2.2` | P2 | C2 | WindShell 内支持 UNC 风格路径 | `spec/10` §3.2 |
| LOC-005 | `open` 命令 | `D:2.2` | P1 | C1 | 用系统默认程序打开文件/目录/URL；终端内 `Ctrl+Click` 亦可 | `spec/10` §3.3 |
| LOC-006 | 路径转换命令 | `D:2.2` | P1 | C2 | `wt path --to-windows /drives/c/x` / `--to-posix C:\x`；替代 `cygpath` | `spec/10` §3.3 |
| LOC-007 | 执行 Windows 程序 | `D:2.2` | **P0** | C1 | 本地终端内可直接运行 `ipconfig`、`notepad` 等；PATH 合并策略可配 | `spec/10` §3.1 |
| LOC-008 | 内置 coreutils | `D:1.5` `P:CygUtils` | P1 | C2 | 随包分发 `uutils/coreutils` 多调用二进制（MIT）；覆盖 ls/cat/grep/sed/awk(基础)/tail/head/wc/sort/uniq/find/xargs/cp/mv/rm/mkdir/chmod… | `spec/10` §4.1 |
| LOC-009 | 内置 ssh/scp/sftp CLI | `D:2.3` | P1 | C2 | 提供 `wt ssh` / `wt scp` / `wt sftp` 子命令，复用我们的协议栈与凭据 | `spec/10` §4.2 |
| LOC-010 | 内置 rsync | `D:2.3` | P2 | C3 | 不捆绑 rsync；提供 `wt sync`（基于 SFTP 的增量同步），语义接近 `rsync -a` | `spec/10` §4.3 |
| LOC-011 | 内置 git | `P:Git` | P2 | C3 | 不捆绑；检测系统 git 并复用。若用户需要便携 git，引导安装 PortableGit | `spec/10` §4.4 |
| LOC-012 | 内置 vim | `P:CygUtils` | P2 | C3 | 不捆绑完整 vim；内嵌编辑器可切换 vi 键位；远端 vim 通过 SSH 正常使用 | `spec/10` §4.4 |
| LOC-013 | 脚本运行时 | `P:Python` `P:Node.js` `P:Perl` `P:Ruby` | P2 | C3 | 不捆绑；`wt exec` 可调用系统已装的运行时。插件可用 WASM（`EXT-005`） | `spec/10` §4.4 |
| LOC-014 | SSH 密钥生成器 | `D:6.3.2` `D:4.1` | **P0** | C1 | 图形化生成 RSA/ECDSA/Ed25519，导出 OpenSSH/PEM/PPK；可导入已有密钥并显示指纹；支持 passphrase | `spec/10` §5 |
| LOC-015 | 系统信息工具 | `D:2.2` | P2 | C2 | `wt sysinfo`：OS/CPU/内存/磁盘/网卡/已装字体；可导出为诊断包的一部分 | `spec/10` §6.1 |
| LOC-016 | 任务管理工具 | `D:2.2` | P2 | C2 | `wt ps` / `wt kill`：列出进程树、CPU/内存、命令行；按端口反查进程 | `spec/10` §6.2 |
| LOC-017 | 注册表工具 | `D:2.2` | P3 | C2 | `wt reg ls/get/set`（Windows 专用）；GUI 查看器 P3 | `spec/10` §6.3 |
| LOC-018 | 快捷方式创建 | `D:2.2` | P2 | C2 | `wt shortcut create --session <id>`；等价 `mkshortcut` | `spec/10` §6.4 |
| LOC-019 | 文本编辑 CLI | `D:2.2` | P1 | C1 | `wt edit <file>` 打开内嵌编辑器；`wt edit user@host:/path` 直接编辑远端文件 | `spec/10` §6.5 |
| LOC-020 | 图片查看 CLI | `D:2.2` | P2 | C2 | `wt view <file|url>`；支持远端路径 | `spec/10` §6.5 |
| LOC-021 | mathomatic | `D:2.4` | **NO** | C4 | 与本产品场景无关 | — |
| LOC-022 | fdupes | `D:2.4` | **NO** | C4 | 与远程运维无关 | — |
| LOC-023 | 包管理器 CLI | `D:2.4` | P1 | C2 | `wt pkg install/search/list/remove`；替代 `MobApt`/`apt-get`；见 `EXT-002` | `spec/10` §7 |

---

## 7. SEC · 安全与凭据（16 条）

| ID | 特性 | 出处 | 优先级 | 兼容 | 决策与差异 | 规格 |
|---|---|---|---|---|---|---|
| SEC-001 | 主密码 | `F:passwords` `D:3.1` | **P0** | C1 | 首次保存密码时要求设置；Argon2id 派生；可改可移除（移除需二次确认并警告） | `spec/11` §3.1 |
| SEC-002 | 密码保存与自动填充 | `F:passwords` | **P0** | C1 | 按会话保存；支持「本次记住/永久记住/不记住」；键盘交互式认证也能保存（MobaXterm 的已知缺陷） | `spec/11` §3.2 |
| SEC-003 | 密钥格式兼容 | `D:4.1` `D:4.7` | **P0** | C1 | OpenSSH（新/旧）、PEM PKCS#1/PKCS#8、PuTTY `.ppk`（v2/v3）、RFC 4716；RSA/ECDSA/Ed25519/DSA（仅读取）；自动识别 | `spec/11` §3.3 |
| SEC-004 | SSH Agent 集成 | 增强 | P1 | — | OpenSSH Agent（`SSH_AUTH_SOCK` / Windows named pipe `\\.\pipe\openssh-ssh-agent`）、Pageant、macOS Keychain agent；Agent 转发 | `spec/11` §3.4 |
| SEC-005 | 主机密钥校验 | `D:6.8.6` | **P0** | C1 | TOFU；`known_hosts` 兼容 OpenSSH 格式（含 hashed hostname）；变更时**必须**强提示并展示新旧指纹；支持按主机重置 | `spec/11` §3.5 |
| SEC-006 | 密钥口令缓存 | 增强 | P1 | — | 会话期内缓存；可配超时；可「记住到保险库」 | `spec/11` §3.4 |
| SEC-007 | 保险库加密 | `D:6.7.4` | **P0** | — | Argon2id（m=64MiB, t=3, p=4）+ XChaCha20-Poly1305；文件格式公开并有规范文档；支持密钥轮换 | `spec/11` §4 |
| SEC-008 | OS 钥匙串集成 | 增强 | P1 | — | Windows DPAPI/Credential Manager、macOS Keychain、Linux libsecret；可选「用系统钥匙串解锁保险库」 | `spec/11` §4.4 |
| SEC-009 | 企业安全策略 | `D:6.7.4` | P1 | C2 | 策略文件（JSON，可放共享目录/注册表/GPO）：禁用明文协议、禁用密码保存、强制主机校验、禁用 0.0.0.0 监听、禁用抓包、禁用外部命令 | `spec/11` §5 |
| SEC-010 | 审计日志 | 增强 | P2 | — | 记录连接（谁/何时/到哪/结果）、隧道启停、凭据访问、策略拒绝；本地 JSONL，可导出；不含密码与命令内容（可配） | `spec/11` §6 |
| SEC-011 | 危险操作二次确认 | 增强 | P1 | — | 多执行广播危险命令、批量删除会话、开放 0.0.0.0 监听、导出含密码的会话 | `spec/11` §7 |
| SEC-012 | 剪贴板敏感内容 | 增强 | P2 | — | 从密码框复制时提示；可选「N 秒后清空剪贴板」 | `spec/11` §7 |
| SEC-013 | 自动锁定 | 增强 | P1 | — | 空闲 N 分钟锁定保险库；锁定时断开可选 | `spec/11` §3.1 |
| SEC-014 | 供应链安全 | 增强 | P1 | — | 依赖审计（`cargo-deny`）、SBOM（CycloneDX）、构建可复现、安装包签名、更新签名校验 | `spec/11` §8 |
| SEC-015 | 无遥测与离线优先 | 增强 | **P0** | — | 默认零外发；网络请求白名单可在设置中查看；提供「离线模式」开关阻断全部非目标主机流量 | `spec/11` §9 |
| SEC-016 | OTP / 双因素 | 增强 | P2 | — | 支持 keyboard-interactive 中的 OTP 提示；内置 TOTP 生成器（可选，绑定到会话） | `spec/11` §3.6 |

---

## 8. SET · 设置与个性化（15 条）

| ID | 特性 | 出处 | 优先级 | 兼容 | 决策与差异 | 规格 |
|---|---|---|---|---|---|---|
| SET-001 | 设置体系 | `D:3` `D:3.1~3.4` | **P0** | C2 | 分组：常规/外观/终端/文件/图形/网络/安全/高级。**每项都有「搜索」可达**，且显示生效范围 | `spec/12` §3.1 |
| SET-002 | 设置搜索 | 增强 | P2 | — | 输入关键词过滤设置项，并高亮命中位置 | `spec/12` §3.1 |
| SET-003 | 主题与配色 | `D:3.2` | P1 | C1 | 浅色/深色/跟随系统；终端配色独立于 UI 主题；导入 iTerm2/Windows Terminal 配色 | `spec/12` §3.2 |
| SET-004 | 快捷键编辑器 | `D:3.1` `D:5.3` | P1 | C1 | 可视化录制、冲突检测、按作用域分组、恢复默认、导出/导入 | `spec/12` §3.3 |
| SET-005 | 会话级设置覆盖 | `D:4.9` | P1 | C1 | 字体/编码/回滚行数/终端行为可在会话级覆盖；UI 明确标出「已覆盖」 | `spec/12` §3.4 |
| SET-006 | 配置存储 | `D:6.7.7` `D:6.7.8` | **P0** | C2 | 设置用 TOML（人可读、可进 Git）；会话用 SQLite；位置可由 `--config-dir` 指定；`--portable` 用程序目录 | `spec/12` §4 |
| SET-007 | 便携模式 | `D:6.7.7` | P1 | C1 | 数据全部落在程序目录 `./data`；不写注册表/AppData；U 盘可用 | `spec/12` §4.3 |
| SET-008 | 共享/漫游配置 | `D:6.7.6` `D:5.5` | P1 | C2 | 指向只读共享配置文件（本地路径/HTTP/SFTP）；本地可覆盖；变更时提示刷新 | `spec/12` §4.4 |
| SET-009 | DPI 缩放 | `D:6.7.9` | P1 | C2 | 跟随系统 + 手动覆盖（80%~250%）；终端字号独立于 UI 缩放 | `spec/12` §3.5 |
| SET-010 | 紧凑模式 | `D:6.7.2` | P2 | C1 | 隐藏侧栏/工具栏，只留标签与终端；快捷键切换 | `spec/12` §3.6 |
| SET-011 | 工作区与布局 | 增强 | P2 | — | 保存「打开了哪些会话 + 分屏布局 + 窗口位置」为工作区，一键恢复 | `spec/12` §3.7 |
| SET-012 | 国际化 | 增强 | **P0** | — | zh-CN / en-US 完整覆盖；语言可切换无需重启；日期/数字本地化 | `spec/12` §5 |
| SET-013 | MobaXterm 设置导入 | `D:6.7.7` | **P0** | C1 | 与 `SES-020` 同一入口；导入终端配色、字体、快捷键、全局开关 | `spec/12` §6 |
| SET-014 | 设置导入导出与重置 | 增强 | P1 | — | 导出为单个 JSON（不含密码）；按分组重置；「恢复出厂」 | `spec/12` §4.5 |
| SET-015 | 字体管理 | `D:3.2` | P1 | — | 枚举系统等宽字体、预览、缺失字体回退、内置等宽字体（保证跨平台一致） | `spec/12` §3.6 |
| SET-016 | 屏保与内置游戏 | `D:6.7.11` `D:6.7.12` | **NO** | C4 | MobaXterm 的企鹅屏保与游戏是历史遗留彩蛋，Pro 版才允许关闭。我们从一开始就不提供——企业环境下这类内容会被安全/合规直接否掉，且与「运维工作台」定位无关 | `spec/12` §3.7 |
| SET-017 | 无闪烁主窗口 | `D:3.4` | P3 | **ALT** | 这是 GDI 时代的重绘问题（`WM_ERASEBKGND` 未处理导致闪烁）。WebView 天然双缓冲，不需要该开关。改为「遵循系统『减少动画』偏好」+ 局部 CSS `will-change` 优化，不暴露为用户设置 | `spec/12` §3.7 |

---

## 9. EXT · 扩展与插件（8 条）

| ID | 特性 | 出处 | 优先级 | 兼容 | 决策与差异 | 规格 |
|---|---|---|---|---|---|---|
| EXT-001 | 插件包格式 | `D:6.7.3` `P:plugins` | P1 | C3 | 沿用 `.zip` 结构但加 `manifest.json`（名称/版本/兼容范围/入口/权限/校验和）；扩展名 `.wtpkg`；**兼容读取 `.mxt3`**（迁移友好，仅提取可执行文件到 bin） | `spec/12` §7.1 |
| EXT-002 | 包管理器 | `F:mobapt` `D:2.4` | P1 | C2 | `wt pkg` + GUI；索引为签名 JSON；支持本地目录/HTTP/自建源；离线导入 `.wtpkg` | `spec/12` §7.2 |
| EXT-003 | 插件仓库与签名 | 增强 | P1 | — | ed25519 签名索引与包；安装时校验；可配置信任的发布者公钥；企业可锁定只允许内部源 | `spec/12` §7.3 |
| EXT-004 | 插件权限与沙箱 | 增强 | P2 | — | 声明式权限：`fs:read`/`fs:write`/`net`/`process:spawn`/`clipboard`；首次使用需授权；可撤销 | `spec/12` §7.4 |
| EXT-005 | 脚本扩展 | 增强 | P2 | — | WASM（`wasmtime`）脚本钩子：连接前后、输出匹配、自定义命令；限制 CPU/内存/时间 | `spec/12` §7.5 |
| EXT-006 | 主题插件 | 增强 | P2 | — | 配色与 UI 主题以 JSON 描述，可打包为插件 | `spec/12` §7.6 |
| EXT-007 | 自定义传输协议 | 增强 | P3 | — | 允许插件注册新会话类型（例如 SPICE、Serial over TCP）；接口不稳定，暂不开放 | `spec/12` §7.7 |
| EXT-008 | 企业定制器 | `F:customizer` | P2 | C2 | 生成带预置配置/预置会话/锁定策略的安装包；不做「改写 exe 内嵌」这种不可审计的方式，改为「伴随配置文件 + 签名」 | `spec/12` §7.8 |

---

## 10. SYS · 系统集成（13 条）

| ID | 特性 | 出处 | 优先级 | 兼容 | 决策与差异 | 规格 |
|---|---|---|---|---|---|---|
| SYS-001 | 系统托盘 | `D:5.3` `D:6.2.8` | P1 | C1 | 最小化到托盘、托盘菜单（会话/隧道/显示主窗口）、可配关闭行为 | `spec/12` §8.1 |
| SYS-002 | 全局热键与弹出终端 | `D:5.3` | P2 | C1 | 见 `TER-029`；热键注册失败时明确提示被谁占用 | `spec/12` §8.1 |
| SYS-003 | URL 协议处理 | `D:5.4` | P2 | C1 | 注册 `windterm://connect?session=...`；**打开前必须确认**（防钓鱼链接直接触发连接） | `spec/12` §8.2 |
| SYS-004 | 资源管理器集成 | `D:3.1` `D:5.4` | P2 | C1 | 右键「在此打开 WindTerm」；可安装/卸载 | `spec/12` §8.3 |
| SYS-005 | 单实例与命令行开关 | `D:5.4` | P1 | C1 | 覆盖 MobaXterm 全部 20+ 开关（见 `spec/10` §8 对照表）；新开关用 `--` 长格式 | `spec/12` §8.4 |
| SYS-006 | 崩溃恢复 | 增强 | P1 | — | 异常退出后重启，提示「上次有 5 个会话未正常关闭，是否恢复」；恢复会话与布局（不恢复终端内容） | `spec/12` §8.5 |
| SYS-007 | 自动更新 | 增强 | P1 | — | 签名校验；可指向内网更新源；可完全禁用；企业可锁定版本 | `spec/12` §8.6 |
| SYS-008 | 多平台打包 | 增强 | **P0** | — | Windows（MSI + 便携 zip）、macOS（DMG，universal2，公证）、Linux（AppImage + deb + rpm） | `spec/12` §8.7 |
| SYS-009 | 可访问性 | 增强 | P1 | — | 全键盘可达、屏幕阅读器（终端内容朗读）、焦点可见、高对比度 | `spec/12` §9 |
| SYS-010 | 高对比度与色觉友好 | 增强 | P2 | — | 高对比主题；配色方案标注色盲友好性；不只靠颜色传达状态 | `spec/12` §9 |
| SYS-011 | 深色模式跟随系统 | 增强 | P1 | — | Windows/macOS/Linux 主题变化实时响应 | `spec/12` §3.2 |
| SYS-012 | 系统通知 | 增强 | P2 | — | 长任务完成、连接断开、隧道异常通过系统通知中心提示 | `spec/12` §8.1 |
| SYS-013 | 无管理员权限运行 | `D:6.7.10` | P1 | C1 | 核心功能不需要管理员；仅安装、驱动（抓包）、全局热键可能需要 | `spec/12` §8.8 |

---

## 11. NFR · 非功能需求（26 条）

NFR 的权威定义在 `spec/13`（含测量点、环境、门禁规则）。本表只登记 ID 与阈值，避免两处维护。

| ID | 需求 | 阈值 | 门禁 | 规格 |
|---|---|---|---|---|
| NFR-001 | 冷启动时间 | P95 ≤ 1200 ms | 阻塞 | `spec/13` §2 |
| NFR-002 | 内存占用 | 3 会话 ≤ 150 MB | 阻塞 | `spec/13` §2 |
| NFR-003 | 终端吞吐与流控 | ≥ 20 MB/s 零丢字节 | 阻塞 | `spec/13` §2 |
| NFR-004 | SFTP 传输性能 | 上传 ≥ 60 MB/s | 阻塞 | `spec/13` §2 |
| NFR-005 | 图形会话延迟 | RDP ≤ 60 ms | 告警 | `spec/13` §2 |
| NFR-006 | 并发会话 | 50 会话稳定 1 h | 阻塞 | `spec/13` §2 |
| NFR-007 | 稳定性 | 崩溃率 < 0.1/千会话小时 | 观察 | `spec/13` §3 |
| NFR-008 | 故障恢复 | 五类故障均可恢复 | 阻塞 | `spec/13` §3 |
| NFR-009 | 长时间运行 | 7 天无泄漏 | 观察 | `spec/13` §3 |
| NFR-010 | 数据安全 | 无明文凭据落盘 | 阻塞 | `spec/13` §4 |
| NFR-011 | 依赖安全 | 无 RUSTSEC 高危 | 阻塞 | `spec/13` §4 |
| NFR-012 | 平台兼容 | Win10 1809+/macOS 12+/主流 Linux | 阻塞 | `spec/13` §5 |
| NFR-013 | 服务端兼容 | OpenSSH 7.4+、WinSrv 2012R2+ 等 | 阻塞 | `spec/13` §5 |
| NFR-014 | 终端兼容 | `vttest` 全量、`esctest` ≥ 95% | 阻塞 | `spec/13` §5 |
| NFR-015 | i18n 覆盖 | zh-CN/en-US 100% 键对齐 | 阻塞 | `spec/13` §6 |
| NFR-016 | 可访问性基线 | WCAG 2.1 AA（UI 部分） | 阻塞 | `spec/13` §7 |
| NFR-017 | 架构约束 | 依赖无环、单文件 ≤ 800 行 | 阻塞 | `spec/13` §8 |
| NFR-018 | 测试覆盖 | 核心 crate 行覆盖 ≥ 70% | 阻塞 | `spec/13` §8 |
| NFR-019 | 结构测试 | 需求闭合、键对齐、无死链 | 阻塞 | `spec/13` §8 |
| NFR-020 | 日志与诊断 | 结构化 + 脱敏 + 诊断包 | 阻塞 | `spec/13` §9 |
| NFR-021 | 性能可观测 | 内置性能面板 | 告警 | `spec/13` §9 |
| NFR-022 | 安装包体积 | Win ≤ 45 MB | 告警 | `spec/13` §10 |
| NFR-023 | 磁盘占用 | 安装后 ≤ 120 MB | 告警 | `spec/13` §10 |
| NFR-024 | 数据格式版本 | 升级只向前、降级保护 | 阻塞 | `spec/13` §11 |
| NFR-025 | 升级测试 | N-1 → N 数据完整 | 阻塞 | `spec/13` §11 |
| NFR-026 | 文档完整性 | 每个 P0/P1 有用户文档 | 告警 | `spec/13` §12 |

---

## 12. 覆盖结论

### 12.1 数量统计

> 由脚本对本文表格直接统计得出（`design/15` §6 的统计测试会在 CI 中重算并比对，防止手工维护漂移）。

| 域 | 条目 | P0 | P1 | P2 | P3 | NO |
|---|---|---|---|---|---|---|
| SES | 29 | 8 | 14 | 4 | 1 | 2 |
| TER | 35 | 12 | 9 | 14 | 0 | 0 |
| FIL | 23 | 5 | 9 | 9 | 0 | 0 |
| GUI | 21 | 3 | 11 | 5 | 0 | 2 |
| NET | 18 | 2 | 6 | 6 | 3 | 1 |
| LOC | 23 | 3 | 7 | 9 | 1 | 3 |
| SEC | 16 | 6 | 7 | 3 | 0 | 0 |
| SET | 17 | 4 | 8 | 3 | 1 | 1 |
| EXT | 8 | 0 | 3 | 4 | 1 | 0 |
| SYS | 13 | 1 | 7 | 5 | 0 | 0 |
| **功能小计** | **203** | **44** | **81** | **62** | **7** | **9** |
| NFR | 26 | — | — | — | — | — |
| **合计** | **229** | | | | | |

P3 的 7 条：`SES-023`（云同步）、`NET-011`（TFTP 服务端）、`NET-014`（httping）、`NET-015`（iperf）、`LOC-017`（注册表工具）、`EXT-007`（自定义传输协议）、`SET-017`（无闪烁主窗口）。
NO 的 9 条：`SES-003`、`SES-004`、`GUI-027`、`GUI-032`、`NET-010`、`LOC-003`、`LOC-021`、`LOC-022`、`SET-016`。

### 12.2 MobaXterm 官网 18 个特性块的覆盖确认

| # | 特性块 | 承接需求 | 结论 |
|---|---|---|---|
| 1 | MobaXterm tabbed terminal | `TER-001` `LOC-001` `LOC-008` | ✅ 覆盖 |
| 2 | Sessions management | `SES-012`~`SES-017` | ✅ 覆盖 |
| 3 | Graphical SFTP browser | `FIL-001`~`FIL-005` | ✅ 覆盖 |
| 4 | X11 server | — | ❌ **不做**（ADR-0012）。X11 需要本地 X Server，与「跨平台、轻量、零外部依赖」的定位冲突 |
| 5 | Enhanced X extensions | — | ❌ **不做**（随 X11 一并移除） |
| 6 | Multi-execution | `TER-004` | ✅ 覆盖（增强：结果聚合） |
| 7 | Embedded servers | `NET-007`~`NET-009` | ✅ 覆盖（Telnet/TFTP 不做） |
| 8 | Embedded tools | `LOC-008`~`LOC-020` `NET-012` `NET-013` | ✅ 覆盖（不做 mathomatic/fdupes） |
| 9 | Remote Unix desktop (XDMCP) | — | ❌ **不做**（XDMCP 依赖 X Server，X11 已移除） |
| 10 | Remote Windows desktop (RDP) | `GUI-015`~`GUI-026` | ✅ 覆盖（不做 RemoteApp） |
| 11 | SSH gateway | `SES-024` `SES-025` | ✅ 覆盖（增强：多跳） |
| 12 | SSH tunnels | `NET-001`~`NET-006` | ✅ 覆盖 |
| 13 | MobApt package manager | `EXT-002` `LOC-023` | ✅ 覆盖（增强：签名与权限） |
| 14 | Text Editor | `FIL-011` `FIL-012` | ✅ 覆盖 |
| 15 | Macros support | `TER-035` | ✅ 覆盖（增强：参数化宏） |
| 16 | Passwords management | `SEC-001`~`SEC-008` | ✅ 覆盖 |
| 17 | Syntax highlighting in terminal | `TER-010` | ✅ 覆盖（P2） |
| 18 | Professional Customizer | `EXT-008` | ✅ 覆盖（改为配置伴随式） |

### 12.3 缺口登记（本文的已知不足）

矩阵在评审中发现三处需要补充，**其中一处已补齐、两处已闭环**：

| 缺口 | 说明 | 处理 |
|---|---|---|
| ~~**宏录制与回放**~~ | MobaXterm 特性块 15「Macros support」未单独编号 | ✅ **已补齐**：新增 `TER-035`（P1），规格见 `spec/06` §7 |
| **SSH-browser 的 SCP 双实现** | MobaXterm 区分「enhanced speed / normal speed」两种 SCP 实现，需明确我们是否也做双实现 | ✅ **已决策**：只做一套实现 + 自动探测（`spec/07` §4.2、`design/06` §4），不提供两套路径 |
| **MobaXterm 的 `-justunpack` 类受限环境适配** | 企业 GPO 禁止从 TEMP 运行时，MobaXterm 提供 `-justunpack` 把核心文件解到只读目录 | ✅ **已消解**：安装版把运行时资源放在安装目录，不依赖 TEMP，从设计上消除该问题（`spec/12` §7.8） |

> 这张表本身是矩阵的一部分：**它证明矩阵是被评审过的，而不是抄来的。**
> 保留已闭环项（而不是删除）是为了让后来者知道「这些坑踩过、结论是什么」，避免重复讨论。

---

### 12.4 帮助文档章节覆盖表

`documentation.html` 共 **38 个顶层小节**（1.1~6.8）。此表逐节给出承接，用于证明「不是只挑了特性页的 18 个块」。

> 核对方式：`.research/mobaxterm-documentation.txt` 的目录段落用脚本提取小节号，与本文 `D:x.y` 出处做差集。
> 首次执行时发现 `3.4`（无闪烁主窗口）未被承接，据此补入 `SET-017`；`6.7.11/6.7.12`（屏保与游戏）补入 `SET-016`。

| 小节 | 内容 | 承接需求 |
|---|---|---|
| 1.1 | Presentation（产品总述） | `spec/01` §1（背景与定位） |
| 1.2 | Sessions（会话创建与自动保存） | `SES-012` `SES-013` |
| 1.3 | Multitab environment（多标签/分屏/多执行） | `TER-001` `TER-002` `TER-004` |
| 1.4 | X11 server（内置 X Server 与远程桌面） | — ❌ 不做（ADR-0012） |
| 1.5 | Unix-like terminal（终端与 Unix 命令） | `LOC-001` `LOC-008` |
| 1.6 | Built-in graphical tools（图形工具与 SSH 浏览器） | `FIL-001` `FIL-014` `LOC-014`~`LOC-020` |
| 2.1 | Different integration modes（标签/分屏/分离/服务/隧道/设置/会话管理） | `TER-001`~`003` `NET-007`~`009` `NET-004` `SET-001` `SES-013` |
| 2.2 | Local terminal features（open/cygpath/drives/registry/UNC/Windows 程序） | `LOC-002` `LOC-004` `LOC-005` `LOC-006` `LOC-007` `LOC-003`(NO) |
| 2.3 | Network utilities（远程计算/DISPLAY/文件传输/网络监控） | `SES-001` `SES-002` `GUI-010` `FIL-003` `NET-012` `NET-013` `NET-014` `NET-015` |
| 2.4 | Other utilities（编辑器/杂项/插件/MobApt） | `FIL-011` `FIL-012` `FIL-013` `FIL-014` `EXT-001` `EXT-002` `LOC-021`(NO) `LOC-022`(NO) |
| 3.1 | General tab（持久 home/编辑器/右键菜单/密码/快捷键/共享会话/持久 root） | `SET-006` `SET-007` `SET-008` `SYS-004` `SEC-001` `TER-020` `SES-019` |
| 3.2 | Terminal tab（13 项） | `TER-005`~`TER-016` |
| 3.3 | X11 tab（引擎/键盘/自启/显示器/偏移/剪贴板/Xorg 版本/OpenGL/远程访问） | — ❌ 不做（ADR-0012） |
| 3.4 | Display tab（无闪烁主窗口） | `SET-017`（ALT） |
| 4.1 | SSH settings（12 项） | `SES-001` `SES-024` `SEC-003` `FIL-017` |
| 4.2 | Telnet settings（4 项） | `SES-002` |
| 4.3 | XDMCP settings（5 项） | — ❌ 不做（XDMCP 依赖 X Server） |
| 4.4 | RDP settings（12 项） | `SES-005` `GUI-015`~`GUI-026` |
| 4.5 | VNC settings | `SES-006` `GUI-028` |
| 4.6 | FTP settings（5 项） | `SES-008` |
| 4.7 | SFTP settings（3 项） | `SES-009` `FIL-003` |
| 4.8 | Mosh settings（3 项） | `SES-010` |
| 4.9 | Terminal settings（会话级，7 项） | `SET-005` `TER-005`~`TER-014` |
| 4.10 | Network settings（SSH 网关） | `SES-024` |
| 4.11 | Bookmark settings（标题锁定/重连提示） | `TER-019` `SES-027` |
| 5.1 | 免密 SSH 连接 | `SEC-003` `SEC-004` |
| 5.2 | 免密 rsh 连接 | `SES-004`（NO，仅可导入） |
| 5.3 | 键盘快捷键（30+） | `TER-020` |
| 5.4 | 启动时执行脚本 / 命令行开关（20+） | `LOC-023` `SYS-005` |
| 5.5 | 共享会话 | `SES-019` |
| 6.1 | FAQ · General（定位/优势/联网行为） | `SEC-015` |
| 6.2 | FAQ · X11（10 条） | — ❌ 不做（ADR-0012） |
| 6.3 | FAQ · SSH（密钥/SOCKS） | `SEC-003` `SES-026` |
| 6.4 | FAQ · RDP（Ctrl+Alt+Del） | `GUI-026` |
| 6.5 | FAQ · 隧道 | `NET-004` |
| 6.6 | FAQ · 终端（字符集/PATH/右键粘贴/分隔符） | `TER-006` `LOC-007` `TER-011` |
| 6.7 | FAQ · 高级（13 条：批处理/紧凑/插件/安全/备份/共享/配置位置/DPI/GPO/屏保/日志编码） | `SYS-005` `SET-010` `EXT-001` `SEC-009` `SES-015` `SES-019` `SET-006` `SET-009` `SYS-013` `SET-016`(NO) `TER-015` |
| 6.8 | FAQ · 排错（9 条） | `SES-001` `SEC-005` `SEC-002` `TER-011` `SES-027` |

### 12.5 插件覆盖表

`plugins.html` 列出 **40 个官方插件**（含第三方收录）。此表逐个给出决策，避免「插件也算特性，但我们没表态」。

| 插件 | 决策 | 说明 |
|---|---|---|
| CygUtils | **ALT** → `LOC-008` | 用 `uutils/coreutils` 替代 Cygwin 工具集 |
| Cmake / Gcc / G++ / GFortran | **NO** | 需完整 POSIX 与 `fork()`；明确引导用 WSL 或 MSYS2（`LOC-001`） |
| Corkscrew | **ALT** → `SES-026` | 内置 SOCKS5/HTTP CONNECT 代理，不需要外部隧道工具 |
| Curl | **ALT** → `LOC-023` | `wt http` 子命令覆盖常见用法；完整能力用系统 curl |
| CvsClient / Subversion / Git / Git v2 | **NO** → `LOC-011` | 不捆绑版本控制客户端，检测系统 git 并复用 |
| DnsUtils（dig/host/nslookup） | **ALT** → `NET-016` | 内置 DNS 查询面板（A/AAAA/CNAME/MX/TXT/NS/SOA/PTR） |
| E2fsProgs / SquashFS / Png2Ico / Xmllint / Fontforge / Exif | **NO** | 与远程运维无关的格式/文件系统工具 |
| Emacs / Joe / NEdit / Gvim | **ALT** → `FIL-011` | 内嵌编辑器（CodeMirror 6）+ vi 键位模式；远端编辑器通过 SSH 正常使用 |
| FVWM2 / X11Fonts | **NO** | X11 已移除，不再需要 X11 窗口管理器与字体 |
| File | **ALT** → `LOC-023` | `wt file` 按魔数判断类型 |
| Httperf | **ALT** → `NET-014` | 内置 HTTP 探测器（延迟/状态码/TLS 握手） |
| Lftp | **NO** → `FIL-015` | 内置 FTP/FTPS 客户端覆盖需求 |
| Lrzsz | **P2** → `FIL-020` | ZMODEM 在终端内接管传输 |
| Lynx | **NO** | 文本浏览器，与场景无关 |
| MPlayer | **NO** | 与场景无关 |
| Midnight Commander | **NO** | 双栏文件管理器（`FIL-006`）已覆盖其核心用途 |
| Multitail | **ALT** → `TER-002` `TER-010` | 分屏 + 语法高亮 + 关键词提醒组合替代 |
| Node.js / Python / Perl / Ruby / PdKsh / Tcl-Tk-Expect | **NO** → `LOC-013` | 不捆绑运行时；`wt exec` 调用系统已装版本；插件脚本用 WASM |
| OpenSSL | **ALT** → `NET-016` | 内置 TLS 证书检查；完整 openssl 用系统版本 |
| Screen / Tmux（第三方） | **ALT** → `TER-032` | 标签内 pane 分屏替代；远端 tmux 通过 SSH 正常使用 |
| Sqlite3 | **NO** | 与本产品无关 |
| X3270Suite | **NO** | IBM 3270 是专有终端协议，场景极窄 |
| XServers（Xephyr/Xnest/Xdmx/Xvfb/Xfake） | **NO** | X11 已移除；Linux 用户如需图形转发请用系统 ssh -X + 自装 X Server |
| Zip | **ALT** | 用系统压缩工具；`wt zip` 为 P3 |
| Graphviz / Lua / Readline / CGDB（第三方收录） | **NO** | 开发者工具，与远程运维无关 |

**结论**：40 个插件中，`ALT`（换个做法实现）12 个、`NO`（明确不做）27 个、`P2` 1 个。
没有任何一个插件是「未表态」——这是本节的目的。

### 12.6 已作废需求（保留 ID）

**2026-11-02 决策：移除全部 X11 相关能力（ADR-0012）。**

作废原因是产品定位调整，不是实现困难：X11 转发必须依赖一个本地 X Server（Windows 要装 VcXsrv、macOS 要装 XQuartz、Linux 要用系统 Xorg），
这与「跨平台、开箱即用、零外部依赖」的定位直接冲突；同时 X11 生态（rootless、扩展、输入法）的质量完全由第三方 X Server 决定，我们无法保证体验。

按 `spec/03` §2 的规则，**ID 永不复用**：下列 15 条保留编号与作废理由，便于历史提交、issue 与 ADR 的引用继续有效。

| ID | 原特性 | 原优先级 | 作废日期 | 理由 | 用户的替代路径 |
|---|---|---|---|---|---|
| `GUI-001` | X Server provider 管理 | P0 | 2026-11-02 | X11 移除 | — |
| `GUI-002` | X11 转发（SSH） | P0 | 2026-11-02 | X11 移除 | 用系统 `ssh -X` / `ssh -Y` + 自装 X Server |
| `GUI-003` | X11 多窗口（rootless） | P0 | 2026-11-02 | X11 移除 | 同上（由用户自己的 X Server 提供） |
| `GUI-004` | X11 窗口化模式 + WM | P1 | 2026-11-02 | X11 移除 | 同上 |
| `GUI-005` | X11 标签内嵌（DWM） | P2 | 2026-11-02 | X11 移除 | — |
| `GUI-006` | X 扩展支持 | P1 | 2026-11-02 | X11 移除 | — |
| `GUI-007` | OpenGL 加速 | P1 | 2026-11-02 | X11 移除 | — |
| `GUI-008` | X11 剪贴板同步 | P1 | 2026-11-02 | X11 移除 | 由用户自己的 X Server 处理 |
| `GUI-009` | X11 键盘映射与输入法 | P1 | 2026-11-02 | X11 移除 | 同上 |
| `GUI-010` | DISPLAY 管理与偏移 | P1 | 2026-11-02 | X11 移除 | 用户自行 `export DISPLAY` |
| `GUI-011` | X11 访问控制 | P1 | 2026-11-02 | X11 移除 | 用户自行 `xhost` |
| `GUI-012` | X11 多显示器 | P2 | 2026-11-02 | X11 移除 | — |
| `GUI-013` | XDMCP 会话 | P2 | 2026-11-02 | XDMCP 依赖 X Server | 用系统 X Server 的 XDMCP 客户端 |
| `GUI-014` | 远程桌面环境启动 | P1 | 2026-11-02 | 依赖 X11 转发 | 用系统 `ssh -X` 后手动启动桌面 |
| `SES-007` | XDMCP 会话类型 | P2 | 2026-11-02 | 同 `GUI-013` | 同上 |

**受影响的统计**：功能需求 218 → 203；P0 47 → 44；P1 89 → 81；P2 66 → 62。
`GUI-015`~`GUI-035`（RDP / VNC / 截图）与 `SES-006`（VNC 会话）不受影响，继续保留。
## 13. 设计映射

| 矩阵域 | 设计文档 |
|---|---|
| `SES` | `design/04` 数据模型、`design/05` SSH、`design/10` 跳板与隧道 |
| `TER` | `design/03` 终端子系统、`design/02` IPC 与背压 |
| `FIL` | `design/06` 文件传输 |
| `GUI` | `design/07` RDP、`design/08` VNC/X11/XDMCP |
| `NET` | `design/10` 隧道、`design/01` §内置服务端 |
| `LOC` | `design/11` 本地 Shell 与 VFS |
| `SEC` | `design/09` 凭据与加密 |
| `SET` `EXT` | `design/12` 插件与包管理、`design/04` 配置模型 |
| `SYS` | `design/14` 构建发布、`design/13` 前端与 UI |
| `NFR` | `design/15` 测试、`design/16` 可观测性 |
