# 附录 B · 术语表

## 使用约定

- 正文中文，**标识符、协议名、字段名、crate 名一律保留英文**（`docs/README.md` 的约定）。
- 本表按「项目内部术语 → 协议术语 → 密码学术语」分组。
- 每条给出一句话定义 + 在本项目中的具体含义（避免「词典式」的空泛）。

---

## 1. 项目内部术语

| 术语 | 英文 | 定义 |
|---|---|---|
| **会话** | Session | 一份可复用的连接配置（类型 + 主机 + 认证 + 选项）。**不是**「一次连接」——一次连接是 `SessionHandle` |
| **会话句柄** | SessionHandle | 一次运行中的连接实例。同一会话可开多个句柄（多标签连同一台机器） |
| **文件夹** | Folder | 会话树中的容器，可无限嵌套 |
| **隧道** | Tunnel | 端口转发配置 + 运行实例。有独立 ID 与生命周期，不等同于「会话的附属物」 |
| **传输** | Transfer | 一个文件的上传/下载任务，有独立状态机 |
| **工作区** | Workspace | 保存的「打开了哪些会话 + 布局 + 窗口位置」 |
| **保险库** | Vault | 加密的凭据容器（`vault.bin`） |
| **主密码** | Master Password | 解锁保险库的密码，不存储，只用于派生密钥 |
| **策略** | Policy | 企业下发的强制规则文件（`policy.json`），优先级高于用户设置 |
| **插件包** | Package | `.wtpkg` 文件（zip + manifest + 签名） |
| **诊断包** | Diagnostic Bundle | 用户主动导出的排障压缩包（脱敏，不含凭据与终端内容） |
| **连接链路** | Chain | 从本地到目标经过的所有跳（代理 / 跳板 / 隧道） |
| **provider** | Provider | 可替换的外部能力实现（流提供者、抓包驱动） |
| **渲染归属** | Render Owner | 某个会话当前由哪个窗口负责渲染（分离窗口时切换） |
| **凭据引用** | Credential Ref | 会话中指向保险库条目的 ID，不含密文 |
| **凭据补录** | Credential Backfill | 导入后批量重新输入密码的向导流程（ADR-0010） |

---

## 2. 终端与 VT

| 术语 | 全称 / 说明 |
|---|---|
| **VT** | Video Terminal。泛指 ANSI/ECMA-48 终端控制序列体系 |
| **CSI** | Control Sequence Introducer，`ESC [`。绝大多数控制序列的前缀 |
| **OSC** | Operating System Command，`ESC ]`。用于设置标题、工作目录、超链接、剪贴板 |
| **SGR** | Select Graphic Rendition，`CSI ... m`。控制颜色与样式（粗体、下划线、256 色、24 位色） |
| **DCS** | Device Control String，`ESC P`。Sixel 图形等 |
| **DECCKM** | `DECSET 1`。应用光标键模式：方向键发 `ESC O A` 而非 `ESC [ A` |
| **DECAWM** | `DECSET 7`。自动换行 |
| **DECSTBM** | 设置滚动区域（上下边界） |
| **备用屏** | Alternate Screen（`?1049`）。vim/less 等全屏程序使用；切换时不污染主屏滚动缓冲 |
| **bracketed paste** | `?2004`。粘贴时用 `ESC[200~`/`ESC[201~` 包裹，让程序区分「键入」与「粘贴」 |
| **鼠标上报** | Mouse Reporting（`?1000`/`?1002`/`?1003`/`?1006`）。把鼠标事件发给远端程序 |
| **滚动缓冲** | Scrollback。终端保留的历史行 |
| **列宽** | East-Asian Width。CJK 字符占 2 列，算错会导致全屏程序错位 |
| **Sixel** | 一种在终端中显示位图的协议（DEC 提出） |
| **OSC 7** | 终端上报当前工作目录的约定（`file://host/path`），用于「文件浏览器跟随终端路径」 |
| **OSC 8** | 终端超链接（`ESC]8;;URL ESC\ text ESC]8;; ESC\`） |
| **vttest** | 终端一致性测试套件（Thomas Dickey） |
| **esctest** | 终端转义序列自动化测试套件 |

---

## 3. SSH

| 术语 | 说明 |
|---|---|
| **KEX** | Key Exchange。密钥交换算法（`curve25519-sha256` 等） |
| **host key** | 服务端的主机密钥，用于向客户端证明身份 |
| **known_hosts** | 记录已知主机密钥的文件（OpenSSH 格式）。支持哈希主机名（`\|1\|salt\|hash`） |
| **TOFU** | Trust On First Use。首次连接时接受并记住密钥，之后变更则告警 |
| **`direct-tcpip`** | SSH 通道类型：让服务端替你连到某主机某端口。**跳板机的实现基础** |
| **`tcpip-forward`** | SSH 全局请求：让服务端监听某端口（`-R` 远程转发） |
| **agent** | SSH 密钥代理，持有私钥并代为签名（`ssh-agent`/Pageant） |
| **agent forwarding** | `auth-agent-req@openssh.com`。让远端借用你的 agent（有安全风险） |
| **keyboard-interactive** | 一种认证方式，服务端发任意 prompt，客户端逐条回答（OTP、密码都走它） |
| **PPK** | PuTTY 私钥格式（v2/v3）。v3 用 Argon2id 加密 |
| **`posix-rename@openssh.com`** | SFTP 扩展：原子重命名。**保存远端文件必须用它** |

---

## 4. 文件传输

| 术语 | 说明 |
|---|---|
| **SFTP** | SSH File Transfer Protocol。跑在 SSH 通道上的文件协议，与 FTP 无关 |
| **SCP** | Secure Copy。老协议（`\x01` 确认 + 文件名行）；OpenSSH 9.0+ 的 `scp` 实际走 SFTP |
| **FXP** | SFTP 的报文前缀（`SSH_FXP_READ`/`WRITE`/`STAT` 等） |
| **MLSD** | FTP 的机器可读目录列表命令 |
| **FTPS** | FTP over TLS。显式（`AUTH TLS`）与隐式（990 端口）两种 |
| **ZMODEM** | 在终端通道内做文件传输的协议（`rz`/`sz`）。支持断点续传（`ZCRSE`） |
| **rsync 算法** | 块级差分同步。需要双方都有 rsync |
| **断点续传** | 从中断位置继续传输。SFTP 用偏移量实现 |

---

## 5. 图形与远程桌面

| 术语 | 说明 |
|---|---|
| **RFB** | Remote Framebuffer。VNC 的协议名 |
| **VeNCrypt** | VNC 的 TLS 扩展（安全类型 19，含子类型 Plain/TLSNone/TLSVnc 等） |
| **RDP** | Remote Desktop Protocol（微软） |
| **NLA** | Network Level Authentication。在建立 RDP 会话前先完成用户认证 |
| **CredSSP** | NLA 的实现：TLS + SPNEGO/NTLM + 公钥绑定 |
| **EGFX** | RDP 的图形管线扩展（H.264 / RemoteFX Progressive / AVC444） |
| **RDPDR** | RDP 的设备重定向虚拟通道（驱动器/打印机/端口/智能卡） |
| **CLIPRDR** | RDP 的剪贴板重定向虚拟通道 |
| **RDPSND** | RDP 的音频重定向虚拟通道 |
| **ARC** | Auto-Reconnect Cookie。RDP 断线重连时恢复原会话 |
| **RemoteApp** | 只发布单个应用而非整个桌面（我们不做，`GUI-027` NO） |
| ~~X11 / X Server / XDMCP / xauth / XTest / XIM~~ | **本项目不支持**。X11 能力已整体移除（ADR-0012）。这些术语保留在此仅为便于阅读历史 ADR 与作废需求表 |

---

## 6. 密码学

| 术语 | 说明 |
|---|---|
| **KDF** | Key Derivation Function。从密码派生密钥 |
| **Argon2id** | 内存硬的 KDF（RFC 9106），抗 GPU/ASIC。本项目用 `m=64MiB, t=3, p=4`（自适应） |
| **AEAD** | Authenticated Encryption with Associated Data。加密 + 完整性校验 |
| **XChaCha20-Poly1305** | 192 位 nonce 的 ChaCha20-Poly1305。nonce 可安全随机生成 |
| **AAD** | Additional Authenticated Data。参与完整性校验但不加密的数据（本项目用文件头） |
| **nonce** | 一次性随机数。AEAD 中绝不能重复 |
| **salt** | KDF 的随机输入，防彩虹表 |
| **DPAPI** | Windows 的数据保护 API（用户/机器作用域） |
| **Keychain** | macOS 的凭据存储 |
| **libsecret** | Linux 的凭据存储抽象（GNOME Keyring / KWallet） |
| **zeroize** | 把内存中的敏感数据清零（需防编译器优化） |
| **mlock / VirtualLock** | 把内存页锁定在物理内存，防止换页到磁盘 |
| **SBOM** | Software Bill of Materials。软件物料清单（本项目用 CycloneDX） |
| **ed25519** | 签名算法（插件包、更新清单、策略文件） |
| **bcrypt_pbkdf** | OpenSSH 私钥使用的 KDF（不是普通 bcrypt） |

---

## 7. 网络

| 术语 | 说明 |
|---|---|
| **跳板机** | Jump Host / Bastion。先连它，再经它连目标 |
| **SOCKS5** | 代理协议（RFC 1928），支持 `CONNECT`/`BIND`/`UDP ASSOCIATE`（本项目只用 `CONNECT`） |
| **HTTP CONNECT** | HTTP 代理的隧道方法 |
| **端口转发** | `-L`（本地）/ `-R`（远程）/ `-D`（动态 SOCKS） |
| **背压** | Backpressure。消费端处理不过来时，让生产端减速 |
| **水位（高/低）** | High/Low Water Mark。背压的启停阈值（本项目 2 MB / 512 KB） |
| **滞回** | Hysteresis。用不同阈值启停，避免临界点反复抖动 |
| **BPF** | Berkeley Packet Filter。抓包过滤器语法 |
| **Npcap** | Windows 的抓包驱动（WinPcap 的继任者，许可限制再分发） |

---

## 8. 工程

| 术语 | 说明 |
|---|---|
| **ADR** | Architecture Decision Record。架构决策记录 |
| **NFR** | Non-Functional Requirement。非功能需求 |
| **AC** | Acceptance Criteria。验收标准 |
| **P0/P1/P2/P3** | 优先级（必须/重要/增强/观察），定义见 `spec/03` §3.2 |
| **C1~C4** | 兼容性等级（完全兼容/等价/部分/不兼容），定义见 `spec/03` §3.3 |
| **ALT** | 替代实现（不照搬 MobaXterm 机制） |
| **FLOW-1~6** | 六条端到端任务流（`spec/02` §3），直接对应 E2E 用例（原 FLOW-4「X11 图形」已随 ADR-0012 移除） |
| **Spike** | 技术验证（M0 的 S1~S8） |
| **门禁** | Gate。CI 中不达标即失败的检查 |
| **结构测试** | 检查文档与代码一致性的测试（`design/15` §6 的 12 项） |
| **WIT** | WebAssembly Interface Types。组件模型的接口定义语言 |
| **WASM** | WebAssembly。插件脚本的沙箱运行时 |
| **fuel** | wasmtime 的指令计数配额，用于限制脚本执行量 |