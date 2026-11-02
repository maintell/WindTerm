# 详细设计 · 05 · SSH 协议栈

实现需求：`SES-001` `SES-024` `SES-025` `SES-027` `SES-028` `SEC-003` `SEC-004` `SEC-005` `SEC-016`
关键 ADR：ADR-0005（`wt-ssh` 封装，不暴露底层类型）

## 1. 封装策略

```rust
// crates/wt-ssh/src/lib.rs
pub struct SshSession { /* 内部持有 russh::client::Handle */ }

impl SshSession {
    pub async fn connect(cfg: &SshConfig, ctx: &ConnectContext) -> Result<Self, WtError>;
    pub async fn open_session(&self, opts: SessionOpts) -> Result<SshChannel, WtError>;
    pub async fn open_direct_tcpip(&self, host: &str, port: u16) -> Result<SshChannel, WtError>;
    pub async fn request_remote_forward(&self, addr: &str, port: u16) -> Result<u16, WtError>;
    pub async fn disconnect(&self) -> Result<(), WtError>;
    pub fn state(&self) -> SshState;
}
```

**硬规则：`russh` 的类型不出现在 `wt-ssh` 的公共 API 中。**
原因：若 `russh` 在某个能力（`direct-tcpip`、`tcpip-forward`、agent 转发）上有缺口，可能需要换 `ssh2`（libssh2）。封装后换实现不影响上层。（X11 能力已移除，不再需要 `x11-req`，见 ADR-0012。）

`ConnectContext` 注入外部依赖（便于测试与解耦）：

```rust
pub struct ConnectContext {
    pub host_key_verifier: Arc<dyn HostKeyVerifier>,   // SEC-005
    pub credential_source: Arc<dyn CredentialSource>,  // 保险库 / agent / 交互
    pub diagnostics: Arc<Diagnostics>,                 // SES-028 分层耗时
    pub stream_provider: Arc<dyn StreamProvider>,      // 跳板/代理（design/10）
}
```

## 2. 连接状态机

```
                    ┌──────────┐
                    │  Idle    │
                    └────┬─────┘
                         │ connect()
                    ┌────▼──────────┐
                    │ Resolving     │  DNS
                    └────┬──────────┘
                    ┌────▼──────────┐
                    │ Transporting  │  代理/跳板/直连 → 得到 TCP 流
                    └────┬──────────┘
                    ┌────▼──────────┐
                    │ Banner        │  交换 SSH-2.0-xxx
                    └────┬──────────┘
                    ┌────▼──────────┐
                    │ KeyExchange   │  KEX + 主机密钥
                    └────┬──────────┘
                    ┌────▼──────────┐
                    │ VerifyingHost │  TOFU / 变更检测
                    └────┬──────────┘
                    ┌────▼──────────┐
                    │ Authenticating│  密码/公钥/KbdInt
                    └────┬──────────┘
                    ┌────▼──────────┐
                    │ Ready         │◄────┐
                    └────┬──────────┘     │
                         │ 断开            │ 重连成功
                    ┌────▼──────────┐     │
                    │ Reconnecting  │─────┘
                    └────┬──────────┘
                         │ 达上限/取消
                    ┌────▼──────────┐
                    │ Failed/Closed │
                    └───────────────┘
```

**每一步都记录耗时**（`SES-028` 的诊断数据来源）：

```rust
pub struct Diagnostics {
    stages: Mutex<Vec<Stage>>,     // (name, started, ended, result)
}

impl Diagnostics {
    fn stage<T>(&self, name: &str, f: impl Future<Output = Result<T>>) -> Result<T> {
        let start = Instant::now();
        let r = f.await;
        self.push(Stage { name, dur: start.elapsed(), ok: r.is_ok(), err: r.as_ref().err().cloned() });
        r
    }
}
```

## 3. 算法配置

```rust
pub fn default_algorithms() -> Algos {
    Algos {
        kex: vec![
            "curve25519-sha256",
            "curve25519-sha256@libssh.org",
            "ecdh-sha2-nistp256", "ecdh-sha2-nistp384", "ecdh-sha2-nistp521",
            "diffie-hellman-group16-sha512",
            "diffie-hellman-group14-sha256",
        ],
        host_key: vec![
            "ssh-ed25519",
            "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521",
            "rsa-sha2-512", "rsa-sha2-256",
            // "ssh-rsa" 仅在 compat 模式下追加（SHA-1，已被多数发行版禁用）
        ],
        cipher: vec![
            "chacha20-poly1305@openssh.com",
            "aes256-gcm@openssh.com", "aes128-gcm@openssh.com",
            "aes256-ctr", "aes192-ctr", "aes128-ctr",
        ],
        mac: vec![
            "hmac-sha2-256-etm@openssh.com", "hmac-sha2-512-etm@openssh.com",
            "umac-128-etm@openssh.com",
            "hmac-sha2-256", "hmac-sha2-512",
        ],
        compression: vec!["none", "zlib@openssh.com"],
    }
}
```

### 3.1 兼容模式

用户遇到老服务器（CentOS 6、老交换机）时，需要开启兼容算法。**不能默认开启**，因为 SHA-1 类算法有已知弱点。

```rust
pub struct CompatFlags {
    pub allow_ssh_rsa: bool,        // SHA-1 签名
    pub allow_group14_sha1: bool,   // diffie-hellman-group14-sha1
    pub allow_aes_cbc: bool,        // CBC 模式（有 padding oracle 风险）
    pub allow_3des: bool,
}
```

**UI 设计**：会话高级设置里一个「兼容旧服务器」开关，开启时显示具体启用了哪些弱算法与风险说明。诊断失败时（`SSH_NO_COMMON_KEX`）错误信息里直接给「开启兼容模式」按钮（`Hint`），并说明会启用什么。

### 3.2 算法协商失败的诊断

```rust
fn map_negotiation_error(e: russh::Error, server_algs: Option<&ServerAlgos>) -> WtError {
    match e {
        Error::NoCommonKex => WtError::new("SSH_NO_COMMON_KEX")
            .message("无法与服务端协商密钥交换算法")
            .detail(format!("服务端支持：{}", server_algs.kex.join(", ")))
            .hint("开启兼容模式（会启用 SHA-1 类算法）", HintAction::EnableCompat),
        // ...
    }
}
```

**关键**：把服务端支持的算法列表展示出来。没有这个信息，用户只能猜。

## 4. 主机密钥校验

```rust
#[async_trait]
pub trait HostKeyVerifier: Send + Sync {
    async fn verify(&self, host: &str, port: u16, key: &HostKey) -> Result<VerifyOutcome, WtError>;
}

pub enum VerifyOutcome {
    Accept,                          // 已知且匹配
    AcceptAndSave,                   // 用户选择「接受并保存」
    Reject { reason: RejectReason }, // 取消
}

pub enum RejectReason {
    Unknown { fingerprint: String },              // 用户拒绝 TOFU
    Changed { old: String, new: String },         // 密钥变更且未确认
}
```

### 4.1 known_hosts 兼容

```rust
pub struct KnownHosts {
    path: PathBuf,
    entries: HashMap<HostKeyId, Vec<KeyEntry>>,
}

impl KnownHosts {
    pub fn load(path: &Path) -> Result<Self>;      // 解析 OpenSSH 格式
    pub fn check(&self, host: &str, port: u16, key: &HostKey) -> CheckResult;
    pub fn add(&mut self, host: &str, port: u16, key: &HostKey) -> Result<()>;
    pub fn remove(&mut self, host: &str, port: u16) -> Result<()>;
    pub fn import_openssh(&mut self, path: &Path) -> Result<usize>;
    pub fn export_openssh(&self) -> String;
}
```

**必须支持的格式细节**

| 特性 | 说明 |
|---|---|
| 端口非 22 | `[host]:2222` 的方括号形式 |
| 哈希主机名 | `|1|<base64 salt>|<base64 hmac-sha1(host)>` |
| 多密钥类型 | 同一主机多行（`ssh-ed25519` + `rsa-sha2-512`） |
| 注释字段 | 行尾可选注释，解析时忽略但保留 |
| 通配符 | `*.example.com`（OpenSSH 支持；我们读入时支持，写出时不生成） |
| 吊销标记 | `@revoked`（读到则拒绝连接并告警） |
| 证书权威 | `@cert-authority`（读到则记录但不使用，因为我们不做证书认证） |

**哈希算法**：`HMAC-SHA1(key=salt, msg=hostname)`。虽然是 SHA-1，但这是 OpenSSH 的格式约定，不是安全依赖（用于隐藏主机名，不用于认证）。

### 4.2 TOFU 流程的时序

```mermaid
sequenceDiagram
    participant U as UI
    participant S as wt-ssh
    participant K as KnownHosts

    S->>K: check(host, port, key)
    alt 已知且匹配
        K-->>S: Match
    else 未知
        K-->>S: Unknown
        S->>U: 弹 TOFU 对话框（指纹）
        U-->>S: AcceptAndSave / Reject
        alt AcceptAndSave
            S->>K: add(host, port, key)
        end
    else 已变更
        K-->>S: Changed { old, new }
        S->>U: 阻断式对话框（新旧指纹）
        U-->>S: 确认勾选 + 更新 / 取消
    end
```

**异步等待用户输入**：`verify` 是 `async`，内部通过 oneshot channel 等待 UI 回传结果。必须设置超时（默认 5 分钟），超时视为拒绝。

## 5. 认证

### 5.1 认证方法选择

```rust
pub enum AuthMethod {
    Auto,                    // 按顺序尝试
    Password,
    PublicKey { key_ref: String },
    KeyboardInteractive,
    Agent,
}

pub async fn authenticate(&self, methods: &[AuthMethod], src: &dyn CredentialSource) -> Result<()> {
    for m in methods {
        match m {
            AuthMethod::PublicKey { key_ref } => {
                let key = src.load_key(key_ref).await?;
                if self.try_publickey(&key).await? { return Ok(()); }
            }
            AuthMethod::Agent => {
                for key in src.agent_keys().await? {
                    if self.try_agent_key(&key).await? { return Ok(()); }
                }
            }
            AuthMethod::Password => {
                let pw = src.password().await?;
                if self.try_password(&pw).await? { return Ok(()); }
            }
            AuthMethod::KeyboardInteractive => {
                self.do_kbd_interactive(src).await?;
            }
            AuthMethod::Auto => { /* 见下 */ }
        }
    }
    Err(WtError::new("SSH_AUTH_FAILED").message("所有认证方式均被拒绝"))
}
```

**`Auto` 的顺序**（与 OpenSSH 一致，可配）：

```
1. Agent（若可用，先试——零成本）
2. 已保存的私钥
3. keyboard-interactive（若服务端支持）
4. password
```

**为什么 keyboard-interactive 在 password 之前**：很多服务端关闭了 `PasswordAuthentication` 但保留 `KbdInteractiveAuthentication`（用于 OTP）。先试它成功率更高。

### 5.2 keyboard-interactive 的凭据保存（`SEC-002` 的关键）

这是 MobaXterm 的已知缺陷：`keyboard-interactive` 模式下不弹「保存密码」，导致每次连接都要输，且 SFTP 浏览器会二次询问。

```rust
async fn do_kbd_interactive(&self, src: &dyn CredentialSource) -> Result<bool> {
    let mut round = 0;
    loop {
        round += 1;
        if round > 10 { return Err(WtError::new("SSH_KBD_TOO_MANY_ROUNDS")); }

        // 服务端发来 prompts，我们逐个回答
        let prompts = self.kbd_prompts().await?;
        let mut answers = Vec::new();
        let mut password_like: Option<String> = None;

        for p in &prompts {
            let ans = if is_password_prompt(&p.text) {
                let pw = src.password().await?;
                password_like = Some(pw.clone());
                pw
            } else if is_otp_prompt(&p.text) {
                src.otp(&p.text).await?          // SEC-016
            } else {
                src.answer(&p.text).await?        // 其他 prompt（用户名、域名等）
            };
            answers.push(ans);
        }

        match self.kbd_respond(&answers).await? {
            KbdResult::Success => {
                // 关键：认证成功后，如果这次用了「像密码的 prompt」，
                // 主动询问是否保存（而不是等服务端提示）
                if let Some(pw) = password_like {
                    src.offer_save_password(pw).await?;
                }
                return Ok(true);
            }
            KbdResult::Failed => return Ok(false),
            KbdResult::Continue => continue,
        }
    }
}

fn is_password_prompt(text: &str) -> bool {
    let t = text.to_lowercase();
    t.contains("password") || t.contains("passphrase") || t.contains("密码")
}

fn is_otp_prompt(text: &str) -> bool {
    let t = text.to_lowercase();
    t.contains("verification code") || t.contains("otp")
        || t.contains("one-time") || t.contains("token") || t.contains("验证码")
}
```

**「主动询问保存」是差异点**：不等服务端给机会，我们在认证成功后主动弹一次。这解决了 MobaXterm 的痛点。

### 5.3 密钥加载

```rust
pub enum PrivateKeyFormat {
    OpenSshNew,      // -----BEGIN OPENSSH PRIVATE KEY-----
    OpenSshOld,      // 旧 OpenSSH（PEM 包裹）
    Pkcs1,           // -----BEGIN RSA PRIVATE KEY-----
    Pkcs8,           // -----BEGIN PRIVATE KEY-----
    PpkV2,           // PuTTY-User-Key-File-2
    PpkV3,           // PuTTY-User-Key-File-3
    Unknown,
}

pub fn detect_format(pem: &[u8]) -> PrivateKeyFormat;
pub fn load_key(pem: &[u8], passphrase: Option<&str>) -> Result<PrivateKey>;
```

| 格式 | 库 |
|---|---|
| OpenSSH 新格式（bcrypt KDF） | `ssh-key`（RustCrypto） |
| PKCS#1 / PKCS#8 | `rsa` + `pkcs8` |
| PPK v2/v3 | 自研（格式简单，约 200 行）或 `putty-key` crate（若成熟） |
| Ed25519 | `ed25519-dalek` |
| ECDSA P-256/384/521 | `p256`/`p384`/`p521` |

**PPK v3 的 Argon2 参数**：v3 用 Argon2id，参数在文件头里（`Argon2-Memory`、`Argon2-Passes`、`Argon2-Parallelism`、`Argon2-Salt`）。必须读文件头而不是硬编码。

## 6. Agent 集成

```rust
#[async_trait]
pub trait SshAgent: Send + Sync {
    async fn list_keys(&self) -> Result<Vec<AgentKey>>;
    async fn sign(&self, key: &AgentKey, data: &[u8], flags: u32) -> Result<Vec<u8>>;
}
```

| 平台 | 实现 |
|---|---|
| Windows OpenSSH Agent | 命名管道 `\\.\pipe\openssh-ssh-agent`，协议 `SSH_AGENTC_*` |
| Pageant | `WM_COPYDATA` 到 `Pageant` 窗口类；协议同上 |
| macOS / Linux | Unix socket `SSH_AUTH_SOCK` |

**Agent 转发的安全提示**：`auth-agent-req@openssh.com` 让远端能借用你的 agent。默认关闭；开启时警告「远端主机（及其上的任何进程，包括 root）可以以你的身份登录其他机器」。

## 7. 通道管理

```rust
pub struct SshChannel {
    id: ChannelId,
    kind: ChannelKind,
    reader: mpsc::Receiver<Vec<u8>>,
    writer: mpsc::Sender<Vec<u8>>,
}

pub enum ChannelKind {
    Session { pty: bool },
    DirectTcpip { host: String, port: u16 },
    ForwardedTcpip { addr: String, port: u16 },
    Sftp,
}
```

### 7.1 通道注册表

```rust
pub struct ChannelRegistry {
    channels: DashMap<ChannelId, ChannelHandle>,
}
```

## 8. keepalive 与超时

```rust
pub struct Timeouts {
    pub tcp_connect: Duration,      // 默认 10 s
    pub handshake: Duration,        // 默认 15 s
    pub auth: Duration,             // 默认 120 s（含用户输入）
    pub keepalive_interval: Duration, // 默认 30 s
    pub keepalive_max_missed: u32,  // 默认 3
}
```

**keepalive 的实现**：每 `interval` 发 `keepalive@openssh.com` 全局请求；若连续 `max_missed` 次在 `interval` 内无响应，判定断开。

**为什么不用 TCP keepalive**：默认 2 小时，太慢；且中间设备可能只对应用层活动有反应。

## 9. 连接池

```rust
pub struct ConnectionPool {
    entries: DashMap<PoolKey, Weak<SshSession>>,
}

#[derive(Hash, Eq, PartialEq)]
pub struct PoolKey {
    host: String, port: u16, user: String,
    auth_fingerprint: String,       // 认证方式 + 密钥指纹的哈希
    jump_chain: Vec<String>,        // 跳板链的会话 ID
    proxy: Option<ProxyKey>,
}
```

**复用条件**：`PoolKey` 完全一致 + 连接仍 `Ready` + 空闲时间 < 60 s。

**用途**：
- 同一会话的终端 + SFTP 浏览器 + 隧道共享一条 SSH 连接（`SES-009` AC-2：服务端 `ss` 只看到一条连接）；
- 跳板机被多个目标复用时只连一次（`SES-024` AC-3）。

**清理**：定时任务每 30 s 清理 `Weak` 已失效的条目。

## 10. 重连

```rust
pub struct ReconnectPolicy {
    pub max_attempts: u32,          // 0 = 无限
    pub initial_delay: Duration,
    pub multiplier: f32,            // 1.6
    pub max_delay: Duration,        // 30 s
    pub preserve_scrollback: bool,
}
```

**重连必须恢复的东西**

| 项 | 处理 |
|---|---|
| 终端通道 | 重建 session channel |
| SFTP 浏览器 | 重建 sftp subsystem；**当前路径保留**，重新 `stat` 校验 |
| 隧道 | 由 `wt-tunnel` 监听状态，自行恢复（`design/10` §3.4） |
| 端口转发（`-R`） | 重新请求远端监听（远端可能仍持有旧端口，需处理 `TCPIP_FORWARD_FAILURE`） |

**重连失败后的处理**：`preserve_scrollback` 为真时保留终端内容并显示「已断开」；用户可手动重试或关闭。

**不在重连后自动重放命令**：这是刻意的（`spec/05` §6.4）——自动重放 `rm` 会是一场灾难。

## 11. 错误映射

```rust
pub fn map_russh_error(e: russh::Error, stage: Stage) -> WtError {
    match e {
        Error::ConnectionReset => WtError::new("SSH_CONNECTION_RESET")
            .message("连接被重置")
            .detail("可能是旧版 SSH 服务端、不兼容的压缩算法，或中间设备中断")
            .hint("关闭压缩后重试", HintAction::DisableCompression)
            .hint("开启兼容模式", HintAction::EnableCompat),
        Error::NoCommonKex => { /* 见 §3.2 */ }
        Error::NotAuthenticated => WtError::new("SSH_AUTH_FAILED")
            .message("认证失败：服务端拒绝了所有提供的认证方式"),
        Error::ChannelOpenFailure(reason) => match reason {
            OpenFailure::AdministrativelyProhibited => WtError::new("SSH_FORWARD_DENIED")
                .message("服务端禁止该操作")
                .detail("检查 sshd_config 中的 AllowTcpForwarding"),
            // ...
        },
        _ => WtError::new("SSH_PROTOCOL").message("SSH 协议错误").detail(e.to_string()),
    }
}
```

**`Connection reset by peer` 的三个 Hint 直接对应 MobaXterm 帮助文档 §6.8.3 的三条建议**——但我们把它做成按钮，而不是让用户去翻文档。

## 12. 与需求的对应

| 设计点 | 需求 |
|---|---|
| 封装不暴露 russh | 架构约束（`design/01` §3.1） |
| 状态机 + 诊断 | `SES-028` |
| 算法配置 + 兼容模式 | `SES-001` AC-1/2 |
| known_hosts 兼容 | `SEC-005` AC-3 |
| TOFU 与变更阻断 | `SEC-005` AC-1/2 |
| keyboard-interactive 保存 | `SEC-002` AC-1 |
| 密钥格式 | `SEC-003` |
| Agent | `SEC-004` |
| OTP 识别 | `SEC-016` |
| keepalive | `SES-001` AC-7 |
| 连接池 | `SES-009` AC-2、`SES-024` AC-3 |
| 重连 | `SES-027` |
| 错误映射 + Hint | `SES-001` 异常表 |
