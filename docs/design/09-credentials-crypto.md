# 详细设计 · 09 · 凭据与加密

实现需求：`SEC-001`~`SEC-016`
关键 ADR：ADR-0009（自研保险库格式）

## 1. 为什么自研而不是用现成 keyring

| 方案 | 问题 |
|---|---|
| `keyring` crate 只存 OS 钥匙串 | 无法跨机器迁移；Linux 上 libsecret 缺失时静默失败；不能表达「一次解锁、多个条目」 |
| 用 SQLCipher | 引入 C 依赖与 SQLite 编译变体，体积 +3 MB；且我们要的不只是「数据库加密」 |
| 用 `age` | 面向文件加密，不适合「频繁增删条目」的容器 |
| **自研格式** | 可控、可审计、可公开规范、可跨平台一致；代价是约 1200 行代码 + 严格测试 |

自研的核心收益是**格式公开**：用户可以写脚本恢复自己的凭据（`spec/11` §4.2），这在闭源工具里不可能。

## 2. Crate 结构

```
crates/wt-crypto/src/
├── lib.rs
├── kdf.rs          Argon2id 封装
├── aead.rs         XChaCha20-Poly1305 封装
├── vault.rs        容器格式、读写、轮换
├── entry.rs        条目类型
├── memory.rs       受保护内存（mlock / zeroize）
├── keyfile.rs      私钥解析（OpenSSH/PEM/PPK）
├── policy.rs       企业策略加载与校验
└── audit.rs        审计日志
```

## 3. KDF

```rust
pub struct KdfParams {
    pub alg: KdfAlg,        // 目前只有 Argon2id
    pub m_cost: u32,        // KiB，默认 65536（64 MiB）
    pub t_cost: u32,        // 迭代，默认 3
    pub p_cost: u32,        // 并行，默认 4
    pub salt: [u8; 16],
}

impl KdfParams {
    pub fn derive(&self, password: &[u8]) -> Result<SecretKey> {
        let params = argon2::Params::new(self.m_cost, self.t_cost, self.p_cost, Some(32))?;
        let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        let mut key = [0u8; 32];
        argon.hash_password_into(password, &self.salt, &mut key)?;
        Ok(SecretKey::new(key))
    }
}
```

### 3.1 参数选择

| 参数 | 值 | 依据 |
|---|---|---|
| `m_cost` | 64 MiB | OWASP 2024 推荐 ≥ 19 MiB；64 MiB 在现代机器上约 200~300 ms，用户可接受 |
| `t_cost` | 3 | 与 m 配合达到目标耗时 |
| `p_cost` | 4 | 匹配常见 4 核；过高在低端机反而变慢 |

**自适应**：首次创建时跑一次基准（测量 64 MiB/3/4 的耗时），若 < 150 ms 则提高参数（最多 256 MiB / 6 / 8），若 > 800 ms 则降低（最低 32 MiB / 2 / 2）。参数写进文件头，所以不同机器创建的库参数不同但都能读。

**为什么自适应**：在低端笔记本上 64 MiB 可能需要 1.5 s（用户体验差），在高性能服务器上可能只要 80 ms（保护不足）。自适应让两者都合理。

### 3.2 密码强度

```rust
pub fn check_strength(pw: &str) -> Strength {
    if pw.chars().count() < 12 { return Weak("至少 12 个字符"); }
    if COMMON_PASSWORDS.contains(pw) { return Weak("这是常见密码"); }
    // zxcvbn 风格的熵估算
    let entropy = estimate_entropy(pw);
    if entropy < 50.0 { Weak("可预测性较高") } else { Ok }
}
```

`COMMON_PASSWORDS`：内置 top-10000（约 80 KB，压缩后 30 KB），只做精确匹配与简单变形（大小写、尾部数字）。

## 4. AEAD

```rust
pub fn seal(key: &SecretKey, aad: &[u8], plaintext: &[u8]) -> Result<(Vec<u8>, [u8; 24])> {
    let cipher = XChaCha20Poly1305::new(key.as_ref().into());
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let ct = cipher.encrypt(XNonce::from_slice(&nonce), Payload { msg: plaintext, aad })?;
    Ok((ct, nonce))
}

pub fn open(key: &SecretKey, aad: &[u8], nonce: &[u8; 24], ct: &[u8]) -> Result<Vec<u8>> {
    let cipher = XChaCha20Poly1305::new(key.as_ref().into());
    Ok(cipher.decrypt(XNonce::from_slice(nonce), Payload { msg: ct, aad })?)
}
```

**AAD 必须是文件头**：这样攻击者无法把 `m_cost` 改成 8 再解密（改了 AAD 校验就失败）。

## 5. 容器

```rust
pub struct VaultFile {
    pub header: Header,
    pub ciphertext: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
pub struct Header {
    pub v: u8,
    pub kdf: KdfParams,
    pub aead: AeadParams,
    pub created: String,
    pub key_id: String,
    pub hint: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct AeadParams {
    pub alg: AeadAlg,
    pub nonce: [u8; 24],
}
```

### 5.1 序列化

```
magic   "WTVLT\0" (6 字节) + version (1) + reserved (1)
len     u32 LE（header 的 JSON 字节数）
header  UTF-8 JSON
body    AEAD 密文（含 16 字节 tag）
```

```rust
pub fn write(&self, path: &Path, password: &[u8]) -> Result<()> {
    let key = self.header.kdf.derive(password)?;
    let header_json = serde_json::to_vec(&self.header)?;

    // AAD = magic + len + header_json
    let mut aad = Vec::new();
    aad.extend_from_slice(b"WTVLT\0");
    aad.push(self.header.v);
    aad.push(0);
    aad.extend_from_slice(&(header_json.len() as u32).to_le_bytes());
    aad.extend_from_slice(&header_json);

    let (ct, nonce) = aead::seal(&key, &aad, &self.ciphertext)?;

    let mut out = Vec::with_capacity(aad.len() + ct.len());
    out.extend_from_slice(&aad);
    out.extend_from_slice(&ct);

    // 备份旧文件，然后原子写
    if path.exists() {
        fs::copy(path, path.with_extension("bin.bak"))?;
    }
    atomic_write(path, &out)
}
```

**注意**：`nonce` 在 header 里，但 header 是 AAD 的一部分——这是鸡生蛋问题。

**解决**：`nonce` 不进 AAD，只把 `v`/`kdf`/`created`/`key_id` 进 AAD。`nonce` 本身被 header 的完整性「间接」保护（若篡改 nonce，解密必然失败）。

更严谨的做法：把 nonce 也写进 header，AAD 用「header 中除 nonce 外的字段」+ nonce 的哈希。但没必要——篡改 nonce 只会导致解密失败，不会导致错误解密。

## 6. 内存保护

```rust
// crates/wt-crypto/src/memory.rs
pub struct ProtectedBytes {
    ptr: *mut u8,
    len: usize,
    _lock: (),
}

impl ProtectedBytes {
    pub fn new(data: &[u8]) -> Self {
        let layout = Layout::from_size_align(data.len(), 64).unwrap();
        let ptr = unsafe { alloc_zeroed(layout) };
        unsafe { std::ptr::copy_nonoverlapping(data.as_ptr(), ptr, data.len()) };
        // 锁定到物理内存，防止被换页到磁盘
        unsafe { mlock(ptr as *mut _, data.len()) };
        Self { ptr, len: data.len(), _lock: () }
    }
}

impl Drop for ProtectedBytes {
    fn drop(&mut self) {
        unsafe {
            // 先清零，再解锁，再释放
            std::ptr::write_bytes(self.ptr, 0, self.len);
            munlock(self.ptr as *const _, self.len);
            dealloc(self.ptr, Layout::from_size_align(self.len, 64).unwrap());
        }
    }
}
```

**平台差异**

| 平台 | 锁定 API |
|---|---|
| Unix | `mlock` / `munlock` |
| Windows | `VirtualLock` / `VirtualUnlock` |

**`mlock` 可能失败**（`RLIMIT_MEMLOCK` 限制），失败时不报错，只记录警告并降级（仍然 `zeroize`，只是不防换页）。

**`zeroize` 的坑**：编译器可能优化掉「写零」操作。必须用 `std::hint::black_box` 或 `zeroize` crate 的 `Zeroize` trait（它用 volatile 写）。

## 7. 条目模型

```rust
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Entry {
    Password {
        id: String,
        name: String,
        secret: Vec<u8>,             // 原文
        meta: PasswordMeta,
    },
    PrivateKey {
        id: String,
        name: String,
        pem: Vec<u8>,
        passphrase: Option<Vec<u8>>,
        meta: KeyMeta,
    },
    Totp {
        id: String,
        name: String,
        secret: Vec<u8>,
        meta: TotpMeta,
    },
    ProxyCredential {
        id: String,
        name: String,
        username: String,
        secret: Vec<u8>,
    },
}
```

**为什么 `secret` 是 `Vec<u8>` 而不是 `String`**：密码可能含任意字节（非 UTF-8），用 `String` 会损坏。

## 8. 解锁流程

```mermaid
sequenceDiagram
    participant U as UI
    participant V as Vault
    participant K as KDF

    U->>V: unlock(password)
    V->>V: 读文件，解析 header
    V->>K: derive(password, kdf)
    K-->>V: key
    V->>V: AEAD open（失败则密码错误）
    alt 成功
        V->>V: 解析 payload JSON → entries
        V->>V: 计算 checksum，与 payload.checksum 比对
        V-->>U: Ok（记录 unlocked_at）
    else AEAD 失败
        V->>V: 失败计数 +1，记录延迟
        V-->>U: Err(CRY_BAD_PASSWORD)
    end
```

### 8.1 暴力破解防护

```rust
struct UnlockGuard {
    failures: AtomicU32,
    locked_until: Mutex<Option<Instant>>,
}

fn delay_for(failures: u32) -> Duration {
    match failures {
        0..=2 => Duration::ZERO,
        3..=9 => Duration::from_secs(1),
        _ => Duration::from_secs(300),
    }
}
```

**这不是真正的防护**（攻击者可以直接复制文件离线爆破），但它能阻止「有人在你电脑前试密码」。离线爆破的唯一防线是 Argon2id 的成本。

**必须在 UI 上说清**：`spec/11` §1.2 已列出「不防什么」。

### 8.2 自动锁定

```rust
pub struct AutoLock {
    idle: Duration,             // 默认 15 min
    last_activity: AtomicInstant,
    on_system_lock: bool,       // 系统锁屏时立即锁定
}

impl AutoLock {
    fn tick(&self) {
        if self.last_activity.elapsed() > self.idle {
            self.vault.lock();      // 清除内存中的 key 与 entries 明文
        }
    }
}
```

**锁定时做什么**

| 项 | 处理 |
|---|---|
| 派生密钥 | `zeroize` 并释放 |
| entries 明文 | `zeroize` 并释放 |
| 已建立的连接 | **保持**（不打断用户工作） |
| 新建连接 | 要求解锁 |
| UI | 显示锁图标；打开凭据面板要求解锁 |

## 9. 私钥解析

```rust
pub enum KeyFormat { OpenSshNew, Pkcs1, Pkcs8, PpkV2, PpkV3, Rfc4716Public }

pub fn detect(pem: &[u8]) -> KeyFormat {
    let s = std::str::from_utf8(pem).unwrap_or("");
    if s.contains("BEGIN OPENSSH PRIVATE KEY") { OpenSshNew }
    else if s.contains("BEGIN RSA PRIVATE KEY") { Pkcs1 }
    else if s.contains("BEGIN PRIVATE KEY") { Pkcs8 }
    else if s.contains("PuTTY-User-Key-File-3") { PpkV3 }
    else if s.contains("PuTTY-User-Key-File-2") { PpkV2 }
    else { /* 未知 */ }
}
```

### 9.1 PPK v3 解析

```
PuTTY-User-Key-File-3: ssh-ed25519
Encryption: aes256-cbc
Comment: user@host
Public-Lines: 1
AAAAC3NzaC1lZDI1NTE5AAAAI...
Key-Derivation: Argon2id
Argon2-Memory: 8192
Argon2-Passes: 13
Argon2-Parallelism: 1
Argon2-Salt: 1234567890abcdef...
Private-Lines: 1
<base64 密文>
Private-MAC: <hmac>
```

**必须读文件头里的 Argon2 参数**，不能硬编码。MAC 用 `HMAC-SHA256` 校验（密钥由 passphrase 派生）。

### 9.2 OpenSSH 新格式

```
-----BEGIN OPENSSH PRIVATE KEY-----
<base64>
-----END OPENSSH PRIVATE KEY-----
```

解码后是二进制结构：

```
"openssh-key-v1\0"
string ciphername        ("none" 或 "aes256-ctr" 等)
string kdfname           ("none" 或 "bcrypt")
string kdfoptions        (bcrypt: salt + rounds)
uint32 nkeys
string publickey[nkeys]
string encrypted_private
```

**bcrypt KDF**：`bcrypt_pbkdf`（不是普通 bcrypt）。用 `ssh-key` crate 处理。

## 10. 策略引擎

```rust
pub struct Policy {
    pub v: u8,
    pub name: String,
    pub signature: Option<String>,
    pub rules: PolicyRules,
}

#[derive(Default)]
pub struct PolicyRules {
    pub allow_plaintext_protocols: Option<bool>,
    pub allow_telnet: Option<bool>,
    pub allow_password_auth: Option<bool>,
    pub allow_save_password: Option<bool>,
    pub require_host_key_check: Option<bool>,

    pub allow_agent_forwarding: Option<bool>,
    pub allow_packet_capture: Option<bool>,
    pub allow_external_proxy_command: Option<bool>,
    pub allowed_forward_targets: Option<Vec<String>>,
    pub allow_plugin_install: Option<bool>,
    pub allowed_plugin_publishers: Option<Vec<String>>,
    pub min_version: Option<String>,
    pub update_source: Option<String>,
    pub session_share_sources: Option<Vec<String>>,
}
```

**`Option<bool>` 而非 `bool`**：未出现的字段表示「不限制」，而不是「禁止」。用 `bool` 会导致「策略文件里没写的项全被禁止」。

```rust
pub fn check(&self, action: &Action) -> Decision {
    let rule = match action {
        Action::Telnet => self.rules.allow_telnet,
        Action::SavePassword => self.rules.allow_save_password,
        // ...
    };
    match rule {
        Some(false) => Decision::Denied { rule: "allowTelnet", message: "已被公司策略禁用" },
        _ => Decision::Allowed,
    }
}
```

**签名校验**：内置公钥（由定制器生成时写入）+ 策略文件里的 `signature`。签名覆盖 `rules` 的规范化 JSON（键排序、无空白）。

**校验失败的处理**

| 情况 | 行为 |
|---|---|
| 系统级策略签名无效 | 拒绝加载，记审计；若无其他策略则用默认（等于无策略），并在 UI 常驻提示 |
| 用户级策略签名无效 | 拒绝加载，记审计 |
| `requireSignature` 为真且无签名 | 拒绝加载 |

## 11. 审计日志

```rust
pub struct AuditEvent {
    pub ts: String,
    pub event: AuditKind,
    pub fields: serde_json::Map<String, Value>,
}

pub enum AuditKind {
    Connect, AuthFail, Disconnect,
    TunnelStart, TunnelStop,
    VaultAccess, VaultUnlock, VaultLock,
    PolicyDeny,
    PluginInstall, PluginPermission,
    ConfigChange,
}
```

**写入**：`tracing` 的一个独立 layer，JSONL 到 `audit/YYYY-MM.jsonl`。与主日志分离（主日志可能被用户清空，审计不能）。

**脱敏**：`VaultAccess` 只记录 `entryId` 与 `purpose`，不记录内容。

**轮转**：按月；保留 90 天（可配）；可配置推送到 syslog/HTTP（P2）。

## 12. 密钥轮换

```rust
pub fn rotate(&mut self, old_pw: &[u8], new_pw: &[u8]) -> Result<()> {
    // 1. 用旧密码解密（验证）
    let entries = self.decrypt_all(old_pw)?;

    // 2. 生成新 salt 与参数
    let new_kdf = KdfParams::generate_adaptive();

    // 3. 用新密码加密
    let new_header = Header { v: 1, kdf: new_kdf, aead: AeadParams::random(), .. };

    // 4. 原子写（保留旧文件为 .bak）
    self.write_with(&new_header, new_pw, &entries)?;

    // 5. 验证新文件可解密
    let verify = Vault::load(&self.path)?.decrypt_all(new_pw)?;
    assert_eq!(verify.len(), entries.len());

    Ok(())
}
```

**第 5 步不能省**：如果新文件写入成功但无法解密（例如实现 bug），用户就永久失去了凭据。验证通过才删除 `.bak`。

## 13. 与需求的对应

| 设计点 | 需求 |
|---|---|
| 自研容器格式 | `SEC-007` |
| KDF 自适应 | `SEC-001` |
| AAD 绑定 header | `SEC-007`（防参数降级） |
| `ProtectedBytes` | `NFR-010` |
| 解锁失败延迟 | `SEC-001` |
| 自动锁定不清连接 | `SEC-013` |
| 私钥六格式 | `SEC-003` |
| PPK 参数读取 | `SEC-003` AC-2 |
| 策略 `Option<bool>` | `SEC-009` |
| 签名校验 | `SEC-009` AC-3 |
| 审计分离 | `SEC-010` |
| 轮换后验证 | `SEC-001` |
| 密钥口令缓存 | `SEC-006` |
| OS 钥匙串集成 | `SEC-008` |
