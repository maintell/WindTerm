# 11 · 功能规格 · 安全与凭据

承接需求：`SEC-001`~`SEC-016`

## 1. 范围与威胁模型

### 1.1 我们要防什么

| 威胁 | 场景 | 对策 |
|---|---|---|
| **本地文件泄露** | 笔记本丢失、备份被拷走、云盘同步了配置目录 | 凭据全部加密，密钥由主密码派生，不落明文 |
| **同机低权限进程窃取** | 恶意软件读取配置目录 | 同上；内存中的密钥用 `mlock`/`VirtualLock` 锁定并 `zeroize` |
| **中间人攻击** | 伪造服务器 | 主机密钥校验（TOFU + 变更强提示）；TLS 证书校验不提供全局忽略 |
| **凭据被日志/崩溃转储捕获** | 调试日志、崩溃 dump | 日志脱敏；不记录密码字段；崩溃转储默认关闭 |
| **配置被篡改** | 攻击者修改 `known_hosts` 或会话指向自己的服务器 | 保险库完整性校验（AEAD）；策略文件签名校验（企业场景） |
| **横向移动** | 用我们保存的凭据连到其他机器 | 凭据按会话绑定，不提供「全局密码」；审计日志记录每次使用 |
| **供应链** | 依赖被投毒、安装包被替换 | 依赖审计、SBOM、签名、更新签名校验 |

### 1.2 我们不防什么（必须明说）

| 不防 | 理由 |
|---|---|
| 已取得你用户权限的攻击者（能读进程内存、能 hook） | 这是 OS 层的信任边界，任何用户态程序都无法防 |
| 键盘记录器 | 同上 |
| 你主动把密码贴到聊天窗口 | — |
| 服务端被攻破 | 不是客户端能解决的 |

**这条「不防什么」必须出现在设置页的安全说明里**，避免给用户虚假的安全感。

## 2. 凭据分类

| 类别 | 例子 | 存储位置 |
|---|---|---|
| 会话密码 | SSH/Telnet/RDP/VNC/FTP/SFTP 密码 | 保险库 |
| 私钥 | SSH 私钥（含口令） | 保险库（默认）或用户指定文件 |
| 私钥口令 | 解密私钥的 passphrase | 保险库 |
| 代理凭据 | SOCKS/HTTP 代理用户名密码 | 保险库 |
| 跳板机凭据 | 跳板会话的密码/密钥 | 保险库（随会话） |
| TOTP 密钥 | 双因素种子 | 保险库 |
| sudo 密码 | **不保存** | — |
| 主密码 | 派生密钥，**不存储**（只存校验值） | 内存 |

## 3. 主密码与解锁

### 3.1 SEC-001 · 主密码

| 字段 | 值 |
|---|---|
| 优先级 | P0 · 兼容性 C1 |
| 来源 | `F:passwords` `D:3.1` |

**首次设置**

- 触发时机：第一次需要保存凭据时（不是首次启动——避免强迫用户）。
- 要求：≥ 12 字符；强度条；不允许出现在常见弱密码列表中（内置 top-10000 列表，约 80 KB）。
- 确认输入两次。
- 提供「生成强密码」按钮。
- 提供「暂不设置主密码」选项 → 后果说明：「凭据将只受操作系统账户保护（使用系统钥匙串），换机器或重装系统后无法迁移」。

**解锁**

```
启动 → 若存在保险库且未配置自动解锁 → 显示解锁对话框
     → 输入主密码 → Argon2id 派生 → 解密 → 校验 MAC
     → 成功：进入应用，密钥驻留内存（受保护）
     → 失败：显示「主密码错误」，第 3 次起增加 1 s 延迟，第 10 次起锁定 5 分钟
```

**修改主密码**

1. 验证旧密码。
2. 输入新密码。
3. 重新派生 + 重新加密整个保险库（原子替换：写临时文件 → `fsync` → rename）。
4. 失败时旧保险库不变。

**移除主密码**

- 需要二次确认 + 输入主密码。
- 后果说明：「凭据将改用系统钥匙串保护，无法跨机器迁移」。
- 移除后保险库仍加密，但密钥由系统钥匙串托管。

### 3.2 SEC-013 · 自动锁定

| 参数 | 默认 | 范围 |
|---|---|---|
| 空闲锁定 | 15 分钟 | 1~240 分钟 / 关闭 |
| 锁定行为 | 清除内存中的密钥；已建立的连接**保持**（不打断工作） | 可选「锁定时断开全部连接」 |
| 系统休眠/锁屏 | 立即锁定 | 可配 |
| 解锁方式 | 主密码 / 系统生物识别（若启用钥匙串集成） | |

**锁定时**：新建连接会提示解锁；已有连接继续工作（否则用户会疯）。

### 3.3 SEC-002 · 密码保存与自动填充

| 时机 | 行为 |
|---|---|
| 首次连接需要密码 | 输入框旁有「保存」勾选框（默认勾选，可在设置中改为默认不勾） |
| 保存后再次连接 | 自动填充，不提示 |
| 认证失败 | 提示「保存的密码可能已过期，是否更新？」→ 重新输入并覆盖 |
| keyboard-interactive | **必须支持保存**（MobaXterm 的已知缺陷：这种认证方式下不弹保存提示，导致每次都要输密码，且 SFTP 浏览器会二次要密码） |

**实现要点**：`keyboard-interactive` 的每个 prompt 单独处理；识别出「password:」类 prompt 时把用户输入关联到会话凭据；非密码 prompt（如 OTP、验证码）不保存。

**验收标准**

- [ ] AC-1 服务端配置 `PasswordAuthentication no` + `KbdInteractiveAuthentication yes`，首次连接后保存密码，第二次连接无提示
- [ ] AC-2 同一会话的 SFTP 浏览器不再二次询问密码（共享已认证连接）
- [ ] AC-3 密码错误时提示更新，更新后连接成功

### 3.4 SEC-003 · 密钥格式兼容

| 格式 | 读 | 写 | 备注 |
|---|---|---|---|
| OpenSSH 新格式（`BEGIN OPENSSH PRIVATE KEY`） | ✅ | ✅ | 支持 bcrypt 加密 |
| OpenSSH 旧格式（PEM 包裹） | ✅ | ❌ | |
| PKCS#1（`BEGIN RSA PRIVATE KEY`） | ✅ | ✅ | |
| PKCS#8（`BEGIN PRIVATE KEY`） | ✅ | ✅ | |
| PuTTY `.ppk` v2 | ✅ | ✅ | Argon2 加密 |
| PuTTY `.ppk` v3 | ✅ | ✅ | |
| RFC 4716（`BEGIN SSH2 PUBLIC KEY`） | ✅ | ✅ | 仅公钥 |
| `authorized_keys` 单行 | ✅ | ✅ | 仅公钥 |

**算法**：Ed25519、ECDSA P-256/384/521、RSA（≥ 2048）、DSA（**仅读取**，连接时警告「DSA 已被弃用」）。

**自动识别**：读取文件头判断格式，不需要用户选择。

**验收标准**

- [ ] AC-1 六种私钥格式各导入一次，均能连接成功
- [ ] AC-2 带口令的 ppk v3 导入后提示输入口令，记住后可无感使用
- [ ] AC-3 DSA 密钥导入成功但连接时显示弃用警告

### 3.5 SEC-004 · SSH Agent 集成

| 平台 | Agent |
|---|---|
| Windows | OpenSSH Agent（`\\.\pipe\openssh-ssh-agent`）、Pageant（`WM_COPYDATA`） |
| macOS | 系统 `ssh-agent`（`SSH_AUTH_SOCK`）+ Keychain 集成 |
| Linux | `SSH_AUTH_SOCK` |

**能力**

1. 列出 agent 中的密钥（`SSH_AGENTC_REQUEST_IDENTITIES`），显示指纹与注释，供会话选择。
2. 认证时通过 agent 签名（私钥不出 agent）。
3. **Agent 转发**（`auth-agent-req@openssh.com`）：可选，默认关闭；开启时警告「远端主机可以借用你的 agent 身份登录其他机器」。

**验收标准**

- [ ] AC-1 枚举 Windows OpenSSH Agent 中的 3 个密钥并显示指纹
- [ ] AC-2 用 agent 密钥连接成功，且本地不加载私钥文件
- [ ] AC-3 开启 agent 转发后，远端 `ssh-add -l` 能看到本地密钥

### 3.5b SEC-006 · 密钥口令缓存

带口令的私钥在**一次会话期内**不应反复询问口令。

| 项 | 规格 |
|---|---|
| 缓存范围 | 进程内存，按「密钥指纹」为键，不按会话 |
| 默认有效期 | 与保险库解锁状态一致（锁定时一并清除） |
| 可配 | 「缓存到本次退出」/「N 分钟后过期（默认 30）」/「记住到保险库」 |
| 「记住到保险库」 | 口令与私钥一起加密存储（`design/09` §7 的 `PrivateKey.passphrase`） |
| 清除 | 保险库锁定、应用退出、用户点「立即清除」 |

**安全约束**：缓存的口令必须放在 `ProtectedBytes`（`design/09` §6），并在失效时 `zeroize`。禁止出现在日志、诊断包、崩溃转储中。

**验收标准**

- [ ] AC-1 同一带口令私钥连 5 个会话，只询问一次口令
- [ ] AC-2 保险库锁定后再次连接，重新询问口令
- [ ] AC-3 选择「记住到保险库」后，重启应用无需再输入

### 3.6 SEC-016 · OTP / 双因素

- 识别 `keyboard-interactive` 中的 OTP prompt（`Verification code:`、`OTP:`、`Password+OTP:`）。
- 内置 TOTP 生成器（RFC 6238，SHA-1/256/512，6/8 位，30/60 s）。
- TOTP 密钥存入保险库，绑定到会话。
- 显示倒计时，剩余 < 5 s 时提示「等待下一个码」。
- 支持「密码 + OTP 拼接」模式（部分服务端要求 `password+otp` 一次提交）。

## 4. 保险库

### 4.1 SEC-007 · 加密方案

| 项 | 选择 | 理由 |
|---|---|---|
| KDF | **Argon2id** | 抗 GPU/ASIC；OWASP 推荐 |
| KDF 参数 | `m=64 MiB, t=3, p=4` | OWASP 2024 推荐下限；实测解锁约 200~400 ms |
| 盐 | 16 字节随机，每库独立 | |
| AEAD | **XChaCha20-Poly1305** | 24 字节 nonce 可随机生成，无需计数器管理；无 AES-NI 依赖，跨平台一致 |
| Nonce | 24 字节随机，每次写入新生成 | |
| AAD | 文件头（含版本与 KDF 参数） | 防参数降级攻击 |

**为什么不用 AES-256-GCM**：需要严格保证 nonce 不重复，在多进程/崩溃恢复场景下容易出错。XChaCha20 的 192 位 nonce 允许安全随机生成。

**为什么参数写进文件头**：允许未来升级参数而不破坏旧文件；AAD 绑定可防止攻击者把参数改成弱值。

### 4.2 文件格式（公开规范）

```
偏移   长度   字段
0      8      magic: "WTVLT\0" + 版本号(1 字节) + 保留(3 字节)
8      4      header_len (小端 u32)
12     N      header (UTF-8 JSON)
12+N   M      ciphertext (AEAD 密文 + 16 字节 tag)
```

**header JSON**

```json
{
  "v": 1,
  "kdf": { "alg": "argon2id", "m": 65536, "t": 3, "p": 4, "salt": "<base64 16B>" },
  "aead": { "alg": "xchacha20poly1305", "nonce": "<base64 24B>" },
  "created": "2026-11-02T10:00:00Z",
  "keyId": "k-2026-11",
  "hint": "公司统一密码，问运维"
}
```

**payload JSON（加密后）**

```json
{
  "v": 1,
  "entries": [
    {
      "id": "e1",
      "kind": "password",
      "name": "prod-web-01",
      "secret": "<base64>",
      "meta": { "sessionId": "s1", "user": "root", "created": "...", "lastUsed": "..." }
    },
    {
      "id": "e2",
      "kind": "private-key",
      "name": "id_ed25519",
      "secret": "<base64 私钥原文>",
      "passphrase": "<base64 或 null>",
      "meta": { "alg": "ed25519", "fingerprint": "SHA256:..." }
    },
    {
      "id": "e3",
      "kind": "totp",
      "name": "bastion-otp",
      "secret": "<base64>",
      "meta": { "digits": 6, "period": 30, "alg": "SHA1" }
    }
  ],
  "checksum": "<SHA-256 of entries 的规范化 JSON>"
}
```

**为什么格式要公开**：用户需要能审计、能在紧急情况下用脚本恢复（我们会提供 `wt key export --format json`，需主密码）。闭源工具做不到这一点，这是我们的差异点。

### 4.3 原子写入

```
写 temp 文件 → fsync(temp) → rename(temp, vault) → fsync(目录)
```

任何一步失败，原文件不变。启动时若发现残留 temp 文件，忽略并清理。

**备份**：每次写入前保留上一版本为 `vault.bak`（1 份），用于主密码修改失败后的恢复。

### 4.4 SEC-008 · OS 钥匙串集成

| 平台 | 机制 |
|---|---|
| Windows | DPAPI（`CryptProtectData`，用户作用域） |
| macOS | Keychain（`kSecClassGenericPassword`） |
| Linux | libsecret（GNOME Keyring / KWallet） |

**两种用法（用户可选）**

| 模式 | 行为 |
|---|---|
| `master-password`（默认） | 每次启动输入主密码 |
| `keychain-unlock` | 主密码派生的密钥被系统钥匙串包裹；启动时无需输入，靠系统登录态解锁 |
| `keychain-only` | 不设主密码，直接用系统钥匙串保护（可移植性最差） |

**切换时的提示**：`keychain-unlock` 降低安全性（任何能以你的账户运行的程序都可能解锁），需明确告知。

### 4.5 密钥轮换

- 支持「重新生成盐并重加密」（不需改主密码）。
- 支持「改主密码」（改密码 + 重加密）。
- 轮换期间保险库不可写（加文件锁），完成后原子替换。

## 5. SEC-005 · 主机密钥校验

### 5.1 存储

- 文件：`<config-dir>/known_hosts`，**兼容 OpenSSH 格式**（含 `|1|salt|hash` 哈希主机名）。
- 为什么兼容：用户可能已有 `~/.ssh/known_hosts`，我们希望可以「导入现有 known_hosts」，也希望我们的文件能被 `ssh-keygen -F` 验证。

### 5.2 首次连接（TOFU）

```
┌─────────────────────────────────────────────┐
│  未知主机                                    │
│                                             │
│  主机：10.0.1.11:22                          │
│  密钥类型：ssh-ed25519                       │
│  指纹：SHA256:AbCdEf...（点击复制）           │
│                                             │
│  这是第一次连接该主机。请确认指纹与服务器管理   │
│  员提供的一致。                               │
│                                             │
│  [ 取消 ]  [ 仅本次接受 ]  [ 接受并保存 ]      │
└─────────────────────────────────────────────┘
```

### 5.3 密钥变更（高危）

```
┌─────────────────────────────────────────────┐
│  ⚠ 主机密钥已变更                            │
│                                             │
│  主机：10.0.1.11:22                          │
│  这可能是服务器重装，也可能是中间人攻击。      │
│                                             │
│  旧指纹：SHA256:AbCdEf...（保存于 2026-10-01）│
│  新指纹：SHA256:XyZ123...                    │
│                                             │
│  □ 我已确认该服务器被重装或更换了密钥          │
│                                             │
│  [ 取消连接 ]  [ 更新并连接 ]                 │
└─────────────────────────────────────────────┘
```

**硬要求**：未勾选确认时「更新并连接」按钮禁用。**不提供**「忽略所有主机密钥检查」的全局开关（只提供按主机删除记录）。

### 5.4 管理界面

- 列出所有已知主机：主机、端口、密钥类型、指纹、首次记录时间、最后使用时间。
- 操作：删除、编辑（替换指纹）、导出为 OpenSSH 格式、从 OpenSSH 导入。
- 搜索与批量删除。

**验收标准**

- [ ] AC-1 首次连接弹 TOFU，接受后 `known_hosts` 新增一行且 `ssh-keygen -F` 能查到
- [ ] AC-2 服务端更换密钥后连接被阻断，展示新旧指纹，未勾选确认无法继续
- [ ] AC-3 导入系统 `~/.ssh/known_hosts`（含 50 条，其中有哈希条目）后全部生效

## 6. SEC-009 · 企业安全策略

### 6.1 策略文件

位置（按优先级）：

1. 命令行 `--policy <path>`
2. 系统级：Windows `%PROGRAMDATA%\WindTerm\policy.json`；macOS `/Library/Application Support/WindTerm/policy.json`；Linux `/etc/windterm/policy.json`
3. 配置目录：`<config-dir>/policy.json`

**格式**

```json
{
  "v": 1,
  "name": "ACME 公司运维终端策略",
  "signature": "<ed25519 签名，base64>",
  "rules": {
    "allowPlaintextProtocols": false,
    "allowTelnet": false,
    "allowPasswordAuth": true,
    "allowSavePassword": false,
    "requireHostKeyCheck": true,
  
    "allowAgentForwarding": false,
    "allowPacketCapture": false,
    "allowExternalProxyCommand": false,
    "allowPortForwardToAnyHost": false,
    "allowedForwardTargets": ["10.0.*", "*.internal"],
    "allowPluginInstall": false,
    "allowedPluginPublishers": ["ACME-IT"],
    "allowTelemetry": false,
    "updateSource": "https://updates.acme.internal/windterm/",
    "minVersion": "1.2.0",
    "sessionShareSources": ["\\\\fileserver\\windterm\\sessions.json"]
  }
}
```

### 6.2 行为

| 场景 | 行为 |
|---|---|
| 策略禁止某功能 | UI 中该项**灰显并说明原因**（不隐藏——隐藏会让用户以为软件坏了） |
| 策略签名无效 | 拒绝加载并告警；若有系统级策略则用系统级 |
| `minVersion` 高于当前版本 | 启动时提示「公司要求升级到 X」，核心功能仍可用但显示常驻提示 |
| 策略与用户设置冲突 | 策略优先；设置页显示「已被公司策略锁定」 |

**签名验证**：公钥内置在安装包中（由企业定制器生成，`EXT-008`）。未签名的策略文件在「要求签名」模式下被拒绝。

### 6.3 验收标准

- [ ] AC-1 策略禁用 Telnet 后，会话类型选择器中 Telnet 灰显并提示「已被公司策略禁用」
- [ ] AC-2 策略禁用密码保存后，密码输入框旁的「保存」勾选框消失，且保险库不再写入新密码
- [ ] AC-3 签名被篡改的策略文件被拒绝加载，回退到系统级或默认

## 7. SEC-010 · 审计日志

**格式**：JSONL，每行一个事件。

```json
{"ts":"2026-11-02T10:00:00.123Z","event":"connect","sessionId":"s1","sessionName":"prod-web-01","host":"10.0.1.11","port":22,"user":"root","via":"bastion","result":"success","durationMs":568}
{"ts":"...","event":"auth.fail","sessionId":"s1","reason":"publickey-rejected","attempts":1}
{"ts":"...","event":"tunnel.start","tunnelId":"t1","type":"local","listen":"127.0.0.1:13306","target":"db:3306"}
{"ts":"...","event":"vault.access","entryId":"e1","action":"read","purpose":"connect s1"}
{"ts":"...","event":"policy.deny","rule":"allowTelnet","action":"create-session"}
{"ts":"...","event":"plugin.install","pkg":"acme-tools","version":"1.2.0","publisher":"ACME-IT","sigValid":true}
```

**规则**

1. 默认开启，写入 `<config-dir>/audit/YYYY-MM.jsonl`，按月滚动。
2. **不记录**：密码、私钥内容、终端输入输出内容（可选开启「记录命令」，但默认关闭并警告）。
3. 保留期可配（默认 90 天），到期自动清理。
4. 可导出为 JSON/CSV；可配置实时推送到 syslog/HTTP 端点（企业场景，`P2`）。
5. 日志文件本身不加密（内容不含秘密），但权限设为仅当前用户可读。

## 8. SEC-011 / SEC-012 · 危险操作与剪贴板

### 危险操作二次确认

| 操作 | 确认内容 |
|---|---|
| 多执行广播危险命令 | 命令摘要 + 目标数 + 其中生产环境数量 |
| 批量删除会话 | 数量 + 是否包含共享会话 |
| 开放 `0.0.0.0` 监听 | 端口 + 「局域网内任何人可访问」 |
| 导出含凭据的会话 | 数量 + 「文件将包含可解密的密码」 |
| 关闭主机密钥校验（按主机） | 主机名 + 风险说明 |
| 开启 0.0.0.0 监听（隧道/内置服务端） | 完整风险说明（局域网可访问） |
| 安装未签名插件 | 发布者 + 签名状态 |
| 执行 `ProxyCommand` | 完整命令行 |
| 导出私钥为无口令 | 强警告 + 输入文件名确认 |

### 剪贴板（SEC-012）

- 从密码输入框复制时提示「剪贴板将保留密码，是否在 30 秒后自动清空？」
- 可选「N 秒后清空剪贴板」（默认关闭）。
- 剪贴板内容不写入日志、不进历史。

## 9. SEC-014 · 供应链安全

| 措施 | 实现 |
|---|---|
| 依赖审计 | CI 跑 `cargo-deny`（许可证白名单 + 漏洞库 `RUSTSEC`）与 `cargo-audit` |
| 依赖锁定 | 提交 `Cargo.lock`；`--locked` 构建 |
| SBOM | 构建时生成 CycloneDX JSON，随 Release 发布 |
| 可复现构建 | 固定工具链（`rust-toolchain.toml`）、固定依赖、`SOURCE_DATE_EPOCH` |
| 安装包签名 | Windows Authenticode、macOS Developer ID + 公证、Linux 提供 `.sig` |
| 更新签名 | 更新清单用 ed25519 签名，客户端内置公钥校验 |
| 第三方二进制 | OpenH264 用 Cisco 官方二进制并校验哈希；不在构建时编译 |

## 10. SEC-015 · 无遥测与离线优先

**默认行为**

- 不发送任何遥测、崩溃报告、使用统计。
- 唯一的出站连接是「用户明确发起的目标连接」与「用户开启的自动更新检查」。
- 自动更新默认**开启检查**但可关闭；检查只请求版本清单，不上报任何标识。

**离线模式开关**

- 开启后：禁止自动更新、禁止插件仓库访问、禁止共享会话的远程拉取。
- 设置页提供「网络活动」面板：列出当前所有出站连接（目标、端口、用途），让用户能自己核对。

**验收标准**

- [ ] AC-1 全新安装后不进行任何连接的情况下运行 1 小时，用抓包确认零出站流量（除本地回环）
- [ ] AC-2 开启离线模式后，插件安装与更新检查均被拒绝并说明原因
- [ ] AC-3 「网络活动」面板能实时反映 3 个 SSH 连接与 1 个隧道

## 11. 验收汇总

| 需求 | 关键 AC | 归属 |
|---|---|---|
| `SEC-001` | 主密码设置/修改/移除全流程；修改失败时旧库不变 | §3.1 |
| `SEC-002` | AC-1~3 | §3.3 |
| `SEC-003` | AC-1~3 | §3.4 |
| `SEC-004` | AC-1~3 | §3.5 |
| `SEC-005` | AC-1~3 | §5 |
| `SEC-007` | 保险库文件用第三方工具（Python `argon2-cffi` + `pynacl`）能按规范解密 | §4.2 |
| `SEC-009` | AC-1~3 | §6.3 |
| `SEC-015` | AC-1~3 | §10 |

## 12. 设计映射

| 需求 | 设计文档 |
|---|---|
| `SEC-001` `SEC-007` `SEC-008` 保险库 | `design/09` §3 格式、§4 KDF/AEAD、§5 密钥管理 |
| `SEC-002` `SEC-016` 认证 | `design/05` §5 认证流程 |
| `SEC-003` 密钥格式 | `design/09` §5 |
| `SEC-004` Agent | `design/05` §6 Agent |
| `SEC-005` 主机密钥 | `design/05` §4 |
| `SEC-009` 策略 | `design/09` §7 |
| `SEC-010` 审计 | `design/16` §3 |
| `SEC-014` 供应链 | `design/14` §5 |
