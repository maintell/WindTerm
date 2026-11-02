# 05 · 功能规格 · 连接与会话管理

承接需求：`SES-001`~`SES-030`

## 1. 范围与设计立场

会话是本产品的**中心数据结构**。MobaXterm 的 INI 本质上是一棵可序列化的会话树，我们把它升级为「结构化 + 可查询 + 可共享 + 可审计」的模型，但**不改变用户的心智模型**：用户看到的仍然是一棵可以拖拽、右键、双击即连的树。

三条立场：

1. **没有「未保存的会话」。** 用户新建连接的那一刻就入库（`SES-012`）。MobaXterm 的这一设计是它最容易被低估的优点——它消除了「保存/另存为」这类仪式，也让「上次连的那台机器叫什么来着」永远有答案。
2. **会话是连接参数的唯一真相。** 会话不是「书签」，而是「连接模板 + 凭据引用 + 终端偏好」的聚合。命令行 `wt connect <id>`、桌面快捷方式、共享文件，全部指向同一份数据。
3. **连接链路的每一跳都必须可见。** 跳板机 + 代理 + 端口转发叠加时，用户必须能一眼看出「卡在哪一跳」（`SES-028`）。这是 MobaXterm 最薄弱的环节。

## 2. 会话类型总览

| 类型 | 需求 | 优先级 | 传输 | 认证 | 备注 |
|---|---|---|---|---|---|
| SSH | `SES-001` | P0 | TCP | 密码 / 公钥 / keyboard-interactive / agent / GSSAPI | 主类型，承载 SFTP 与隧道 |
| RDP | `SES-005` | P0 | TCP | NLA(CredSSP) / TLS / 标准 RDP | 见 `spec/08` §2 |
| SFTP | `SES-009` | P0 | SSH 子系统 | 同 SSH | 独立入口 + SSH 内嵌两种形态 |
| Telnet | `SES-002` | P1 | TCP | 明文登录 | 首次使用需确认风险 |
| VNC | `SES-006` | P1 | TCP | VNC Auth / VeNCrypt / ARD | 见 `spec/08` §3 |
| FTP | `SES-008` | P1 | TCP | 明文 / TLS | 主动 + 被动 |
| Mosh | `SES-010` | P1 | SSH 引导 + UDP | 同 SSH | 需服务端 `mosh-server` |
| 串口 | `SES-011` | P1 | 本地设备 | 无 | 网络设备运维 |
| 本地终端 | `LOC-001` | P0 | 本地 PTY | 无 | 见 `spec/10` |
| Rlogin | `SES-003` | **NO** | — | — | 仅可导入并灰显 |
| Rsh | `SES-004` | **NO** | — | — | 同上 |

## 3. 各类型规格

### 3.1 SES-001 · SSH 会话

| 字段 | 值 |
|---|---|
| 优先级 | P0 |
| 兼容性 | C1 |
| 来源 | `F:sessions` / `D:4.1` |
| 依赖 | `SEC-003`（密钥）、`SEC-005`（主机校验）、`SES-024`（跳板） |

**协议能力**

| 项 | 要求 |
|---|---|
| 版本 | SSH-2 only（SSH-1 不实现） |
| KEX | `curve25519-sha256`、`curve25519-sha256@libssh.org`、`ecdh-sha2-nistp256/384/521`、`diffie-hellman-group14-sha256`、`diffie-hellman-group16-sha512`；**禁用** `group1-sha1`、`gss-group1-sha1-*` |
| 主机密钥 | `ssh-ed25519`、`ecdsa-sha2-nistp256/384/521`、`rsa-sha2-512/256`、`ssh-rsa`（仅兼容旧服务器，需显式开启并警告） |
| 加密 | `chacha20-poly1305@openssh.com`、`aes256-gcm@openssh.com`、`aes128-gcm@openssh.com`、`aes256-ctr`、`aes192-ctr`、`aes128-ctr` |
| MAC | `hmac-sha2-256-etm@openssh.com`、`hmac-sha2-512-etm@openssh.com`、`umac-128-etm@openssh.com`、`hmac-sha2-256` |
| 压缩 | `zlib@openssh.com`（延迟压缩，默认关闭）、`none` |
| 认证 | `publickey`、`password`、`keyboard-interactive`、`none`；agent 转发可选 |
| 扩展 | `direct-tcpip`、`tcpip-forward`、`subsystem sftp`、`env`、`signal`、`keepalive@openssh.com`、`server-sig-algs` |

**行为规格**

1. **连接超时**：TCP 连接 10 s（可配 5~120 s）；SSH 握手 15 s；认证 120 s（等待用户输入不计入）。
2. **keepalive**：默认每 30 s 发 `keepalive@openssh.com`，连续 3 次无响应判定断开（可配）。
3. **不做 `x11-req`**：X11 转发已整体移除（ADR-0012）。若用户需要，在远端自行 `ssh -X` 到目标机（WindTerm 不参与 DISPLAY 管理）。
4. **远程命令**：`Execute command` 字段支持多命令（`;` 或 `&&` 分隔）；执行完默认断开，勾选「命令结束后不退出」则保留交互。
5. **环境变量**：`env` 请求发送用户配置的变量；默认只发 `LANG`/`LC_*`（若开启「适配远端 locale」）。
6. **终端类型**：默认 `xterm-256color`；可配 `xterm`、`screen-256color`、`vt100`、`ansi`、`linux`。
7. **连接复用**：同一 `(host, port, user, auth-method, jump-chain)` 的连接在 60 s 内可复用（连接池），用于 SFTP 浏览器、隧道、多标签共享。

**配置项**

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `ssh.host` | string | — | 主机名或 IP |
| `ssh.port` | u16 | 22 | |
| `ssh.user` | string | 当前系统用户名 | 空则提示输入 |
| `ssh.auth` | enum | `auto` | `auto`/`password`/`publickey`/`keyboard-interactive` |
| `ssh.privateKey` | ref | 空 | 密钥引用（指向保险库条目或文件路径） |
| `ssh.agentForward` | bool | false | |
| `ssh.compression` | bool | false | |
| `ssh.keepaliveSecs` | u32 | 30 | 0 = 关闭 |
| `ssh.remoteCommand` | string | 空 | |
| `ssh.keepOpenAfterCommand` | bool | false | |
| `ssh.termType` | string | `xterm-256color` | |
| `ssh.locale` | string | `auto` | `auto`/`off`/具体值 |
| `ssh.algos` | object | 空 | 覆盖算法列表（高级） |

**异常与边界**

| 情况 | 期望行为 |
|---|---|
| 主机密钥未知 | 弹 TOFU 对话框，展示算法 + SHA256 指纹，要求「接受并保存 / 仅本次 / 取消」 |
| 主机密钥变更 | **红色阻断式**对话框，展示新旧指纹，说明可能是中间人攻击；提供「我已确认服务器重装」的显式勾选后才能继续 |
| `no matching key exchange method` | 报错包含「服务端支持的算法列表」与「建议在会话高级设置中启用 XXX」 |
| `no matching host key type` | 同上，并提示 `ssh-rsa` 兼容开关 |
| 认证失败 | 区分「密码错误」「密钥不被接受」「密钥有口令」「服务端禁止该认证方式」 |
| `Connection reset by peer` | 提示可能原因（旧版 SSH 服务端 / 压缩不兼容 / 中间设备），并给出「关闭压缩」「改用 legacy 算法」两个可点按钮 |
| 网络中断 | 按 `SES-027` 重连；重连期间终端显示倒计时与「立即重试/取消」 |

**验收标准**

- [ ] AC-1 给定 OpenSSH 7.4 服务端，使用默认算法列表连接成功，`ssh -Q kex` 中列出的每个算法都能协商（逐个测试）
- [ ] AC-2 给定服务端只支持 `diffie-hellman-group14-sha1`，连接失败且错误信息包含该算法名与「不受支持，存在安全风险」
- [ ] AC-3 给定首次连接，弹出 TOFU 对话框；接受后 `known_hosts` 新增一行且格式可被 OpenSSH 读取（`ssh-keygen -F host` 能查到）
- [ ] AC-4 给定已保存主机密钥后服务端密钥变更，连接被阻断且展示新旧两个 SHA256 指纹
- [ ] AC-6 给定 `Execute command` = `pwd; ls`，连接后依次输出两命令结果且（未勾选保持连接时）会话自动关闭
- [ ] AC-7 给定 keepalive=10s、服务端中途断网，连接在 30~45 s 内判定断开并进入重连流程

### 3.2 SES-002 · Telnet 会话

| 字段 | 值 |
|---|---|
| 优先级 | P1 · 兼容性 C1 |
| 依赖 | `SEC-009`（企业策略可禁用） |

**协议能力**：RFC 854 基础 + 选项协商 `ECHO(1)`、`SUPPRESS-GO-AHEAD(3)`、`TERMINAL-TYPE(24)`、`NAWS(31)`、`LINEMODE(34)` 子集。

**行为规格**

1. 首次创建 Telnet 会话时弹出一次性风险提示：「Telnet 传输不加密，密码与内容可被网络上的任何人读取」，需勾选「我了解风险」。
2. 用户名可选：填了则连接后自动发送 `user\r`；留空则显示 `login:` 提示（与 MobaXterm 一致，因为部分服务端不支持预置用户名）。
3. 字符模式：默认 `LINEMODE` 关闭（逐字符发送），可切换为行模式以兼容老设备。
4. 支持经由 `SES-024` 跳板机（这是把明文协议安全化的唯一现实路径）。

**异常**：协商死循环（对端反复 `DO/WILL`）需在 10 轮后停止并警告；`IAC` 序列异常时降级为原始字节透传并记录一次警告。

**验收标准**

- [ ] AC-1 连接 Cisco 交换机（行模式）与 Linux telnetd（字符模式）均能正常交互，方向键与退格行为正确
- [ ] AC-2 窗口大小变化时发送 `NAWS`，远端 `stty size` 结果随之变化
- [ ] AC-3 企业策略禁用 Telnet 后，会话类型选择器中该项灰显并说明原因

### 3.3 SES-005 · RDP 会话

协议细节见 `spec/08` §2。本节只规定会话层的字段与行为。

| 字段 | 值 |
|---|---|
| 优先级 | P0 · 兼容性 C1 |
| 依赖 | `GUI-015`~`GUI-026`、`SEC-005`（证书） |

**会话字段**（与 MobaXterm 4.4 对齐）

| 键 | 默认 | 说明 |
|---|---|---|
| `rdp.host` / `rdp.port` | — / 3389 | |
| `rdp.user` / `rdp.domain` | 空 | 留空则显示远端登录界面 |
| `rdp.consoleSession` | false | 等价 `/admin` |
| `rdp.redirectDrives` | 空列表 | 选择本地盘/目录 |
| `rdp.redirectClipboard` | true | 方向可配 |
| `rdp.redirectPrinters` | false | 映射为「打印到 PDF」 |
| `rdp.redirectPorts` | false | 串口/并口（仅 Windows 宿主） |
| `rdp.smartcard` | false | |
| `rdp.enhancedGraphics` | true | EGFX / RemoteFX |
| `rdp.h264` | true | 可关（专利/性能） |
| `rdp.forwardKeys` | true | 快捷键发给远端 |
| `rdp.credssp` | true | 关闭时降级 TLS 并警告 |
| `rdp.multimon` | `current` | `current`/`all`/指定屏 |
| `rdp.dynamicResolution` | true | 窗口缩放时重协商 |
| `rdp.audio` | `local` | `local`/`remote`/`off` |
| `rdp.colorDepth` | 32 | 16/24/32 |

**验收标准**

- [ ] AC-1 给定 Windows Server 2019 默认配置，连接成功并进入桌面
- [ ] AC-2 给定勾选驱动器重定向，远端「此电脑」出现名为 `WindTerm` 的驱动器且可读写
- [ ] AC-3 给定关闭 CredSSP，连接在要求 NLA 的服务器上失败并提示「服务器要求 NLA，请开启 CredSSP」
- [ ] AC-4 给定错误密码，错误信息为可读中文，包含服务端返回的 NTSTATUS 与解释（如 `0xC000006D` → 用户名或密码错误）

### 3.4 SES-006 · VNC 会话

协议细节见 `spec/08` §3。会话字段：`host`、`port`（默认 5900）、`password`（入保险库）、`viewOnly`、`scaleMode`、`colorDepth`、`shared`（是否允许其他客户端同时连接）。

**验收标准**

- [ ] AC-1 连接 TightVNC / TigerVNC / RealVNC / macOS 屏幕共享 四种服务端均成功
- [ ] AC-2 只读模式下所有键鼠事件被丢弃，且 UI 明确显示「只读」

### 3.5 SES-008 · FTP 会话

字段：`host`、`port`（21）、`user`、`password`、`passive`（默认 true）、`ftps`（`off`/`explicit`/`implicit`）、`encryptDataChannel`、`asciiMode`。

**行为规格**

1. 默认被动模式；主动模式在防火墙后失败时自动提示切换。
2. `ftps=explicit` → `AUTH TLS` 后升级；`implicit` → 直接 TLS（端口 990）。
3. `asciiMode` 开启时对文本文件做 CRLF 转换，**UI 必须标注「不要用于二进制文件」**（MobaXterm 只在文档里说，我们要在界面上说）。
4. 目录列表优先 `MLSD`，回退 `LIST` 解析。

**验收标准**

- [ ] AC-1 vsftpd（被动 + 主动）与 FileZilla Server（FTPS explicit）三种组合均可列目录、上传、下载
- [ ] AC-2 开启 ASCII 模式上传 `.png` 后文件损坏，UI 在上传前给出警告并需确认

### 3.6 SES-009 · SFTP 会话

独立 SFTP 会话复用 `FIL-001` 的文件浏览器，但**不建立终端**。字段：`host`、`port`、`user`、认证方式、`startDir`、`asciiMode`。

**验收标准**

- [ ] AC-1 独立 SFTP 会话打开后直接进入双栏文件视图，无终端标签
- [ ] AC-2 SSH 会话的 SFTP 浏览器与独立 SFTP 会话共享同一连接池条目（服务端 `ss` 只看到一条连接）

### 3.7 SES-010 · Mosh 会话

| 字段 | 值 |
|---|---|
| 优先级 | P1 · 兼容性 **C3** |
| 依赖 | `SES-001`（引导）、`windterm-mosh` crate |

**前置条件（必须在 UI 上显式说明）**：服务端必须安装 `mosh-server`（Debian/Ubuntu `mosh`，RHEL `mosh`，Alpine `mosh`）。

**行为规格**

1. 引导流程：SSH 连接 → 执行 `mosh-server new -c 256 -l LANG=... -p 60000:61000` → 解析返回的 `MOSH CONNECT <port> <key>` → 建立 UDP → 关闭 SSH（保留 5 s 用于错误回传）。
2. 若服务端无 `mosh-server`：报错「远端未安装 mosh-server」+ 给出对应发行版的安装命令 + 提供「改用普通 SSH 会话」按钮。
3. 支持漫游（客户端 IP 变化）与断线恢复，这是 Mosh 的核心价值，不得省略。
4. 预测回显（local echo）默认开启，可关。

**验收标准**

- [ ] AC-1 给定 Ubuntu 22.04 + `mosh` 已安装，连接成功且 `mosh-server` 进程存在
- [ ] AC-2 拔网线 30 s 后恢复，会话在 3 s 内自动恢复且滚动缓冲不丢
- [ ] AC-3 给定未安装 mosh-server，错误信息包含 `apt install mosh` 且不出现 UDP 超时等无关错误

### 3.8 SES-003 / SES-004 · Rlogin / Rsh（不做，但可导入）

- 会话类型选择器中**不出现**。
- 导入 MobaXterm 配置时，这类会话被保留在树中，图标灰显，双击提示：「Rlogin 已不再支持（协议不安全）。建议改用 SSH。是否现在编辑为 SSH 会话？」并提供「一键转换」。
- 数据不丢失是硬要求：用户可能只是想先看看有哪些机器。

### 3.9 SES-011 · 串口会话

字段：`port`（枚举 `COM1..COMn` / `/dev/ttyUSB*` / `/dev/tty.usbserial-*`）、`baudRate`（300~4000000，常用 9600/115200）、`dataBits`（5~8）、`stopBits`（1/1.5/2）、`parity`（none/odd/even/mark/space）、`flowControl`（none/xon-xoff/rts-cts/dsr-dtr）、`dtr`/`rts` 初始状态。

**行为规格**

1. 端口列表实时刷新（热插拔）；已占用端口标注「被 XXX 占用」。
2. 支持「发送 Break」动作（网络设备进入 ROM 模式常用）。
3. 支持十六进制视图切换（调试二进制协议）。
4. 断开时保留缓冲，允许「重新连接」。

**验收标准**

- [ ] AC-1 连接 USB-Serial（CH340/CP210x/FTDI）到 Cisco 交换机，115200 8N1 可正常交互
- [ ] AC-2 发送 Break 后设备进入 `rommon>` 提示符
- [ ] AC-3 拔掉 USB 后 UI 在 2 s 内提示「设备已移除」，插回后可一键重连

## 4. 会话管理

### 4.1 SES-013 · 会话树

**结构**：无限层级文件夹 + 叶子会话。排序：手动（拖拽）优先，其次按名称/最近使用（可配）。

**行为**

| 操作 | 行为 |
|---|---|
| 单击 | 选中，右侧显示详情（不连接） |
| 双击 | 连接 |
| 拖拽会话 | 移动到文件夹；跨文件夹拖拽需保持 ID 不变（引用它的快捷方式/隧道不失效） |
| 拖拽文件夹 | 移动整棵子树 |
| 多选 | `Ctrl`/`Shift` 多选，支持批量移动/删除/导出 |
| 折叠 | 状态持久化到会话库 |
| 键盘 | `↑↓` 移动、`Enter` 连接、`F2` 重命名、`Delete` 删除、`Ctrl+F` 搜索 |

### 4.2 SES-012 · 会话自动保存

- 新建会话对话框点「确定」即写入数据库并出现在树中，**没有「保存」按钮**。
- 会话编辑采用「即时保存 + 撤销」：改动立即生效，提供 5 秒内的「撤销」提示条。
- 连接时产生的运行时状态（最后连接时间、最后工作目录）也写回会话，用于「最近使用」与「跟随路径」。

### 4.3 SES-014 / SES-029 · 上下文菜单

```
连接
在新标签中连接
在新窗口中连接
──────────
编辑…
复制会话
重命名
移动到 ▸
──────────
导出…            导出所选会话为 JSON
创建桌面快捷方式
──────────
删除              （多选时显示「删除 N 项」，需确认）
```

### 4.4 SES-017 · 文件夹批量启动

- 右键文件夹 → 「启动全部会话」。
- 启动前显示确认：「将启动 12 个会话（其中 3 个标记为生产环境）」，生产环境用红色强调。
- 可选「启动后布局」：全部标签 / 2 分屏 / 4 分屏 / 网格（按数量自动选择行列）。
- 单个会话失败不阻塞其余；结束后汇总「11 成功 / 1 失败（点击查看）」。

### 4.5 SES-015 · 导入导出

**导出格式（自有，JSON）**

```json
{
  "format": "windterm.sessions",
  "version": 1,
  "exportedAt": "2026-11-02T10:00:00Z",
  "includesSecrets": false,
  "folders": [
    { "id": "f1", "name": "生产", "parentId": null, "order": 0, "color": "#d9534f" }
  ],
  "sessions": [
    {
      "id": "s1", "name": "web-01", "folderId": "f1", "type": "ssh",
      "host": "10.0.1.11", "port": 22, "user": "deploy",
      "auth": { "method": "publickey", "keyRef": "k1" },
      "jump": { "sessionId": "s0" },
      "terminal": { "charset": "utf-8", "fontSize": 13 }
    }
  ],
  "keys": []
}
```

**规则**

1. 默认**不导出密码与私钥**；勾选「包含凭据」时，密码以导出方主密码重新加密（不是明文），并在文件头标注 `"includesSecrets": true` 与 KDF 参数。
2. 导入时若 `includesSecrets=true`，要求输入导出时的主密码。
3. 导入冲突策略：`重命名`（默认，追加 ` (2)`）/ `跳过` / `覆盖`。
4. 支持导入 `~/.ssh/config`：解析 `Host`/`HostName`/`User`/`Port`/`IdentityFile`/`ProxyJump`/`ProxyCommand`，生成会话；`ProxyCommand` 无法等价表达时保留为备注并降级为直连（提示）。

**验收标准**

- [ ] AC-1 导出 50 个会话（含 3 层嵌套）后导入到干净配置，树结构与字段 100% 一致
- [ ] AC-2 勾选包含凭据导出，文件内不出现明文密码（`grep` 原文密码为空）
- [ ] AC-3 导入 `~/.ssh/config`（含 12 个 Host、3 个 ProxyJump），生成 12 个会话且跳板关系正确

### 4.6 SES-016 · 桌面快捷方式

- 内容为 `wt connect <session-id>`（不是主机名），保证会话改名后快捷方式仍有效。
- Windows：`.lnk`（ICON 用会话类型图标）；macOS：`.command` 包装脚本；Linux：`.desktop`。
- 快捷方式不携带凭据；首次运行仍需解锁保险库。

### 4.7 SES-018 / SES-030 · 搜索、标签、环境标识

- 搜索：模糊匹配名称/主机/用户/标签/文件夹路径；`Ctrl+F` 聚焦；结果高亮命中片段；`Enter` 连接第一个。
- 标签：自由文本 + 建议值（`prod`/`staging`/`dev`/`db`/`web`）；标签可批量打。
- 环境标识：会话或文件夹可设 `environment` 枚举（`production`/`staging`/`test`/`dev`），影响：
  - 树中显示彩色竖条；
  - 该会话的标签页边框着色；
  - 多执行广播时生产环境需额外确认（`SEC-011`）。

### 4.8 SES-019 · 会话共享

**发布方**：右键文件夹 → 「共享此文件夹」→ 导出为只读 `sessions-shared.json` 到指定位置（本地路径 / HTTP URL / FTP / SFTP）。

**订阅方**：设置 → 「共享会话」→ 添加：
- 名称（树中显示的节点名）
- 后端：`local` / `http(s)` / `ftp(s)` / `ssh`
- 位置与凭据
- 刷新策略：启动时 / 每 N 分钟 / 手动

**行为规则**

1. 共享节点在树中显示为只读（锁图标），不可编辑、不可拖入。
2. 本地覆盖：用户可对共享会话「复制到我的会话」，得到可编辑副本。
3. 拉取失败：保留上次成功的内容，标注「数据来自 2026-11-01 10:00（刷新失败）」，不阻塞启动。
4. 共享文件**不包含凭据**（发布方导出时强制 `includesSecrets=false`），这是硬约束——共享目录通常是弱权限。

**验收标准**

- [ ] AC-1 共享节点在树中只读，尝试编辑时提示「这是共享会话，请先复制到我的会话」
- [ ] AC-2 断网后启动，共享节点仍显示上次内容并带「刷新失败」标记
- [ ] AC-3 发布方导出时若尝试包含凭据，被拒绝并说明原因

### 4.8b SES-023 · 云端会话同步（不做专有同步）

`P3`，不排期。明确决策：**我们不运营同步服务端**。

| 用户想要的 | 我们的答案 |
|---|---|
| 多台机器会话一致 | 用 `SES-019` 的共享后端（共享目录 / HTTP / SFTP）自建，指定一个文件即可 |
| 自动双向同步 | 不支持。共享会话是**只读**的，避免冲突合并的复杂度与数据丢失风险 |
| 团队协作编辑 | 不支持。团队应通过 Git 管理导出的 `sessions.json`（`SES-015` 的导出格式是人可读 JSON） |

**理由**：双向同步需要解决冲突、删除传播、权限、服务端运维四个问题，而收益（省去把文件放共享盘这一步）极小。做一个「半吊子的同步」比不做更糟——用户会以为数据安全，直到某次冲突把会话树覆盖。

### 4.9 SES-021 · 快速连接

输入框接受以下格式，实时解析并显示将要执行的连接：

| 输入 | 解析结果 |
|---|---|
| `root@10.0.0.1` | SSH, user=root, host=10.0.0.1, port=22 |
| `root@10.0.0.1:2222` | SSH, port=2222 |
| `ssh://root@host:22` | SSH |
| `rdp://admin@win01` | RDP |
| `sftp://deploy@host/var/www` | SFTP，起始目录 `/var/www` |
| `serial://COM3?baud=115200` | 串口 |
| `10.0.0.1` | SSH，user 取默认 |

解析结果下方显示「以一次性会话连接（不保存）」与「保存为会话并连接」两个动作。

### 4.10 SES-022 · 命令面板

`Ctrl+Shift+P` 打开，模糊搜索全部可执行动作：会话（连接）、隧道（启停）、设置项（跳转）、工具（打开编辑器/密钥生成器/诊断）。每个动作显示其快捷键。这是「可发现性」的主要手段——MobaXterm 的很多能力藏在多级菜单里，用户根本不知道存在。

## 5. SES-020 · MobaXterm 配置导入

**这是整个产品的入场券，规格必须最严。**

### 5.1 输入来源

| 版本 | 默认路径 |
|---|---|
| 安装版 | `%USERPROFILE%\Documents\MobaXterm\MobaXterm.ini` |
| 便携版 | `<MobaXterm.exe 所在目录>\MobaXterm.ini` |
| 部分版本 | `%APPDATA%\MobaXterm\MobaXterm.ini` |

自动探测上述三处 + 允许手动选择；也支持从共享路径/URL 导入。

### 5.2 解析范围

| 内容 | 处理 |
|---|---|
| `[Bookmarks]` 与 `[Bookmarks_N]` 的树结构（`SubRep` 表示所属文件夹） | 完整还原层级、名称、顺序 |
| 会话字段（host/port/user/protocol/私钥/跳板/终端设置/压缩/远程命令/浏览器类型…） | 映射到我们的字段；无法映射的保留在 `extra` 里不丢。**X11 相关字段（`X11Forwarding`、`Display`）解析但不生效**，在结果报告中列为「已不支持」 |
| 全局设置（字体、配色、字符集、快捷键） | 映射到 `SET-*`；X11 选项卡整体忽略并记入报告 |
| 加密的密码字段 | 见 §5.4 |
| Rlogin/Rsh 会话 | 保留但灰显（`SES-003/004`） |

> **字段名与协议枚举值的精确映射表在 M0 用 3 个真实 ini 样本（安装版/便携版/Pro 版）校准，结论回填到本节附录。** 在此之前，任何具体键名都标 `【待验证】`。
> 已知需要覆盖的键（来自帮助文档与社区资料，需逐条验证）：`BookmarkName`、`SubRep`、`ImgNum`、`Host`、`Port`、`UserName`、`Protocol`、`PrivateKey`、`UsePrivateKey`、`X11Forwarding`、`Compression`、`RemoteCommand`、`GatewayHost`、`GatewayUserName`、`GatewayPort`、`SshBrowser`、`SCP`、`Mosh`、`Font`、`FontSize`、`Backspace`、`Charset`、`TerminalType`、`LogFileName`、`Display`、`RdpMonitor`、`RdpDrives`、`RdpClipboard`、`Password`。

### 5.3 导入流程（事务性）

```
探测文件 → 解析 → 预检报告 → 用户勾选 → 执行 → 结果报告
```

**预检报告**（必须显示，不可跳过）：

```
发现 1 个配置文件
  路径：C:\Users\zhang\Documents\MobaXterm\MobaXterm.ini
  版本：MobaXterm 24.2
  会话：47 个（SSH 38 / RDP 4 / SFTP 3 / Telnet 1 / Rlogin 1）
  文件夹：6 个
  密码：41 个已加密（需要主密码）

⚠ 1 个会话类型不受支持（Rlogin），将导入但标记为不可用
⚠ 3 个会话使用私钥文件，路径需在本机存在
```

**执行**：单事务。全部成功或全部回滚。中途失败（磁盘满、数据库锁）不得留下半个会话树。

**结果报告**：成功数、需重新输入凭据的会话列表（可点击逐个处理）、失败项与原因。

### 5.4 密码处理（诚实的能力边界）

MobaXterm 的密码加密方案是**未公开的私有实现**。我们不做以下两件事：

- ❌ 不承诺「一键解密全部密码」；
- ❌ 不在没有实测验证的情况下实现逆向解密。

**分三阶段：**

| 阶段 | 能力 | 说明 |
|---|---|---|
| **MVP（M1）** | 导入结构 + 凭据标记为「需重新输入」 | 提供「凭据补录向导」：依次列出缺凭据的会话，用户输一次密码即存入我们的保险库，后续无感 |
| **M2** | 若 M0 阶段用真实样本验证成功，则支持用主密码解密 | 验证标准：3 个不同版本的 ini 样本、共 ≥ 30 条密码，解密后能被真实服务器接受。验证不通过则永久放弃该能力 |
| **永不** | 不提供「密码导出为明文」 | 违反 `SEC-015` 与 `spec/01` §6 原则 2 |

> **设计理由**：用户真正需要的不是「密码被导入」，而是「不用重新记 41 个密码」。凭据补录向导配合「同一用户/同一密钥批量套用」可以把这个成本压到 2~3 分钟，且不引入任何不可靠的逆向代码。这比一个「可能失败且无法解释」的解密功能更有价值。

### 5.5 验收标准

- [ ] AC-1 给定 47 个会话、6 个文件夹的 ini，导入后树结构逐项比对一致（层级、名称、顺序）
- [ ] AC-2 给定 Rlogin 会话，导入后在树中可见、灰显、双击给出转换建议
- [ ] AC-3 给定 ini 中 3 个会话使用私钥路径，导入后私钥路径被记录且不存在时在结果报告中列出
- [ ] AC-4 导入过程中人为制造数据库写入失败，重启后会话树为导入前状态（事务回滚）
- [ ] AC-5 凭据补录向导可批量对「同一用户 + 同一认证方式」的 20 个会话一次套用同一密码

## 6. 连接链路

### 6.1 SES-024 · SSH 跳板机

**模型**：会话可以有 `jump.sessionId`，指向另一个 SSH 会话。链路为递归结构，最多 5 跳（`SES-025`）。

```
客户端 ──SSH──> 跳板机1 ──direct-tcpip──> 跳板机2 ──direct-tcpip──> 目标
```

**行为规格**

1. 目标可以是任意类型（SSH/Telnet/RDP/VNC/SFTP/FTP）：非 SSH 目标通过 `direct-tcpip` 建立裸 TCP 通道后在其上跑对应协议。
2. **连接复用**：若跳板机连接已存在且参数一致，复用之（`ss` 上不新增连接）。
3. **SFTP 自动跟随**：经跳板机的会话，其 SFTP 浏览器走同一隧道（对应 MobaXterm 的 Note 2 行为）。
4. 跳板机自身的凭据独立配置，不继承目标会话。
5. 链路可视化：会话详情页显示链路图，每跳显示主机、端口、状态、耗时。

**异常**

| 情况 | 期望行为 |
|---|---|
| 第 N 跳失败 | 错误信息必须指明「第 N 跳（host:port）」，并给出该跳的具体错误 |
| 跳板机 `AllowTcpForwarding no` | 报错「跳板机禁止 TCP 转发（AllowTcpForwarding no），无法通过它连接目标」 |
| 循环引用（A→B→A） | 保存时即检测并拒绝 |
| 跳板机断开 | 所有经它的连接标记「链路中断」，提供「重连全部」 |

**验收标准**

- [ ] AC-1 给定 A→B→C 三跳，连接 C 时在 B 上 `ss -tnp` 可见 A→B 与 B→C 两条连接
- [ ] AC-2 给定第 2 跳密码错误，错误信息包含「第 2 跳 bastion2:22 认证失败」
- [ ] AC-3 给定已有经 B 的连接，新建第二条经 B 的连接时 B 上 SSH 连接数不增加
- [ ] AC-4 给定 A→B→A 循环配置，保存时被拒绝并提示

### 6.2 SES-025 · 多跳

- UI 为可增删的有序列表，每项是一个会话引用。
- 保存时做环检测（拓扑排序）。
- 跳数 > 3 时提示「链路较长，每跳增加延迟与故障点」。

### 6.3 SES-026 · 代理

| 类型 | 支持 |
|---|---|
| SOCKS5 | 是（含用户名/密码、远程 DNS 解析） |
| SOCKS4/4a | 是（兼容老代理） |
| HTTP CONNECT | 是（含 Basic 认证） |
| `ProxyCommand` | 是（执行外部命令，stdin/stdout 作为通道；需显式授权） |
| 系统代理 | 可选「跟随系统设置」 |

作用域：全局默认 / 按会话覆盖。代理链可与跳板机叠加（先过代理，再连跳板机）。

**安全约束**：`ProxyCommand` 属于「执行外部程序」，必须在 `SEC-009` 策略中可控，且首次使用时展示将执行的完整命令行并要求确认。

### 6.4 SES-027 · 自动重连

**状态机**

```
         ┌──────────── 用户取消 ────────────┐
         ▼                                  │
  [Connected] ──断开──> [Reconnecting] ──成功──> [Connected]
                            │  ▲
                     达上限 │  │ 等待退避
                            ▼  │
                       [Failed] ──用户点击重试──> [Reconnecting]
```

| 参数 | 默认 | 范围 |
|---|---|---|
| `autoReconnect` | 开启（SSH/RDP/VNC） | 开关 |
| `maxAttempts` | 10 | 0（无限）~ 100 |
| `initialDelayMs` | 1000 | 200~30000 |
| `backoff` | `exponential`（×1.6，上限 30 s） | `fixed`/`exponential` |
| `preserveScrollback` | true | 开关 |

**行为**

1. 重连期间终端保持可滚动，插入分隔线：`──── 连接中断 10:32:15，正在重连（第 3/10 次）────`。
2. 重连成功后插入：`──── 已于 10:32:41 重新连接 ────`，**不自动重放**上次命令（避免误操作）。
3. 重连会重建通道：SFTP 浏览器与隧道需一并恢复；失败的子能力单独提示。
4. 用户手动关闭标签时立即停止重连。

### 6.5 SES-028 · 连接诊断

**分层展示**（每层显示耗时与结果）：

```
① 配置解析        ✓ 0 ms
② DNS 解析        ✓ 12 ms   10.0.1.11 → 10.0.1.11（IP 直连）
③ 代理/跳板        ✓ 340 ms  经 bastion(10.0.0.5:22)，已复用连接
④ TCP 连接        ✓ 8 ms    10.0.1.11:22
⑤ SSH 版本交换     ✓ 15 ms   SSH-2.0-OpenSSH_8.0
⑥ 密钥交换        ✓ 42 ms    curve25519-sha256
⑦ 主机密钥校验     ✓ 1 ms     ssh-ed25519 SHA256:xxxx（已知主机）
⑧ 用户认证        ✓ 120 ms   publickey(ed25519)，服务端接受
⑨ 通道建立        ✓ 30 ms    session + sftp
────────────────────────────────
总计 568 ms
```

**用途**

1. 连接失败时自动展开，失败层红色高亮并给出建议动作。
2. 用户可主动对任意会话「运行诊断」，不建立终端（只做握手然后断开）。
3. 诊断结果可一键复制为文本，便于贴给同事/工单。

**这是相对 MobaXterm 的明确增强**：MobaXterm 在跳板机链路失败时只给一句笼统的「连接失败」。

## 7. 验收汇总

| 需求 | 关键 AC | 归属 |
|---|---|---|
| `SES-001` | AC-1~7 | §3.1 |
| `SES-002` | AC-1~3 | §3.2 |
| `SES-005` | AC-1~4 | §3.3 |
| `SES-010` | AC-1~3 | §3.8 |
| `SES-011` | AC-1~3 | §3.10 |
| `SES-012` | 新建会话后重启应用，会话仍在树中 | §4.2 |
| `SES-013` | 3 层嵌套拖拽后层级与顺序正确、折叠状态持久 | §4.1 |
| `SES-015` | AC-1~3 | §4.5 |
| `SES-019` | AC-1~3 | §4.8 |
| `SES-020` | AC-1~5 | §5.5 |
| `SES-024` | AC-1~4 | §6.1 |
| `SES-027` | 断网 30 s 后恢复，缓冲保留且插入两条分隔线 | §6.4 |
| `SES-028` | 人为让第 3 跳失败，诊断视图第 3 层标红且含主机名 | §6.5 |

## 8. 设计映射

| 需求 | 设计文档 |
|---|---|
| `SES-001`~`SES-011` 协议实现 | `design/05`（SSH）、`design/07`（RDP）、`design/08`（VNC）、`design/06`（FTP/SFTP） |
| `SES-012`~`SES-019` 数据与树 | `design/04` §3 会话模型 |
| `SES-020` 导入 | `design/04` §6 迁移器 |
| `SES-021`~`SES-022` | `design/13` §命令面板 |
| `SES-024`~`SES-026` 链路 | `design/10` §2 链路模型 |
| `SES-027` 重连 | `design/05` §7 连接状态机 |
| `SES-028` 诊断 | `design/16` §4 连接诊断 |
