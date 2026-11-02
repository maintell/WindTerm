//! 凭据保险库：容器格式、KDF、AEAD。
//!
//! 设计依据：`docs/design/09-credentials-crypto.md`、`docs/spec/11-func-security.md` §4.2。
//!
//! **格式是公开的**（这是刻意的）：用户需要能审计、能在紧急情况下用脚本恢复自己的凭据。
//! 闭源工具做不到这一点，这是本项目的差异点之一。
//!
//! 文件布局：
//! ```text
//! 偏移   长度   字段
//! 0      6      magic "WTVLT\0"
//! 6      1      版本号（当前 1）
//! 7      1      保留（0）
//! 8      4      header_len（小端 u32）
//! 12     N      header（UTF-8 JSON）
//! 12+N   M      密文（AEAD 密文 + 16 字节 tag）
//! ```
//!
//! AAD = magic ‖ 版本 ‖ 保留 ‖ header_len ‖ header_json
//! 把 header 绑进 AAD，攻击者就无法把 `m_cost` 改成 8 再解密（改了 AAD 校验即失败）。

use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use chacha20poly1305::aead::{Aead, Payload as AeadPayload};
use chacha20poly1305::{Key, KeyInit, XChaCha20Poly1305, XNonce};
use rand::RngCore;
use serde::{Deserialize, Serialize};

use wt_common::time::{now_iso8601, now_unix};
use wt_common::{codes, HintAction, WtError};
use zeroize::Zeroizing;

pub const MAGIC: &[u8; 6] = b"WTVLT\0";
pub const FORMAT_VERSION: u8 = 1;
pub const SALT_LEN: usize = 16;
pub const NONCE_LEN: usize = 24;
pub const KEY_LEN: usize = 32;

// ─────────────────────────────────────────────────────────────
// KDF
// ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KdfParams {
    pub alg: String,
    /// 内存开销，单位 KiB
    pub m: u32,
    /// 迭代次数
    pub t: u32,
    /// 并行度
    pub p: u32,
    /// base64(16 字节)
    pub salt: String,
}

impl KdfParams {
    /// 生产默认：OWASP 2024 推荐下限，实测解锁约 200~400 ms。
    pub fn production() -> Self {
        Self::with_cost(65_536, 3, 4)
    }

    /// 测试用低成本参数（解锁 < 10 ms），**不得用于生产**。
    pub fn fast_for_tests() -> Self {
        Self::with_cost(8 * 1024, 1, 1)
    }

    pub fn with_cost(m: u32, t: u32, p: u32) -> Self {
        let mut salt = [0u8; SALT_LEN];
        rand::thread_rng().fill_bytes(&mut salt);
        Self {
            alg: "argon2id".into(),
            m,
            t,
            p,
            salt: B64.encode(salt),
        }
    }

    fn salt_bytes(&self) -> Result<Vec<u8>, WtError> {
        let s = B64.decode(&self.salt).map_err(|_| {
            WtError::new(codes::CRY_VAULT_CORRUPT).message("保险库头部损坏：salt 不是合法 base64")
        })?;
        if s.len() != SALT_LEN {
            return Err(WtError::new(codes::CRY_VAULT_CORRUPT)
                .message("保险库头部损坏：salt 长度不正确"));
        }
        Ok(s)
    }

    /// 从密码派生 32 字节密钥。返回值用 `Zeroizing` 包裹，离开作用域自动清零。
    pub fn derive(&self, password: &str) -> Result<Zeroizing<[u8; KEY_LEN]>, WtError> {
        if self.alg != "argon2id" {
            return Err(WtError::new(codes::CRY_UNSUPPORTED_VERSION)
                .message(format!("不支持的 KDF 算法：{}", self.alg)));
        }
        let params = Params::new(self.m, self.t, self.p, Some(KEY_LEN)).map_err(|e| {
            WtError::new(codes::CRY_VAULT_CORRUPT)
                .message("保险库头部损坏：KDF 参数非法")
                .detail(e.to_string())
        })?;
        let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        let salt = self.salt_bytes()?;
        let mut key = Zeroizing::new([0u8; KEY_LEN]);
        argon
            .hash_password_into(password.as_bytes(), &salt, &mut key[..])
            .map_err(|e| {
                WtError::new("CRY_KDF_FAILED")
                    .message("密钥派生失败")
                    .detail(e.to_string())
            })?;
        Ok(key)
    }
}

// ─────────────────────────────────────────────────────────────
// 条目
// ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Entry {
    Password {
        id: String,
        name: String,
        /// base64（密码可能含任意字节，不能用 String）
        secret: String,
        #[serde(default)]
        session_id: Option<String>,
    },
    PrivateKey {
        id: String,
        name: String,
        /// base64(私钥原文)
        pem: String,
        #[serde(default)]
        passphrase: Option<String>,
        #[serde(default)]
        fingerprint: Option<String>,
    },
    Totp {
        id: String,
        name: String,
        /// base64(种子)
        secret: String,
        #[serde(default = "default_digits")]
        digits: u8,
        #[serde(default = "default_period")]
        period: u32,
        #[serde(default = "default_totp_alg")]
        alg: String,
    },
    ProxyCredential {
        id: String,
        name: String,
        username: String,
        secret: String,
    },
}

fn default_digits() -> u8 {
    6
}
fn default_period() -> u32 {
    30
}
fn default_totp_alg() -> String {
    "SHA1".into()
}

impl Entry {
    pub fn id(&self) -> &str {
        match self {
            Entry::Password { id, .. }
            | Entry::PrivateKey { id, .. }
            | Entry::Totp { id, .. }
            | Entry::ProxyCredential { id, .. } => id,
        }
    }

    pub fn name(&self) -> &str {
        match self {
            Entry::Password { name, .. }
            | Entry::PrivateKey { name, .. }
            | Entry::Totp { name, .. }
            | Entry::ProxyCredential { name, .. } => name,
        }
    }

    /// 条目类型的稳定标识（用于 UI 图标与审计日志）。
    pub fn kind_str(&self) -> &'static str {
        match self {
            Entry::Password { .. } => "password",
            Entry::PrivateKey { .. } => "private_key",
            Entry::Totp { .. } => "totp",
            Entry::ProxyCredential { .. } => "proxy_credential",
        }
    }
}

// ─────────────────────────────────────────────────────────────
// 头部与容器
// ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Header {
    pub v: u8,
    pub kdf: KdfParams,
    pub aead: AeadParams,
    pub created: String,
    pub key_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AeadParams {
    pub alg: String,
    /// base64(24 字节)
    pub nonce: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct VaultPayload {
    v: u8,
    entries: Vec<Entry>,
}

/// 已解锁的保险库（条目在内存中以明文存在，`lock()` 后清空）。
#[derive(Debug, Clone)]
pub struct Vault {
    header: Header,
    entries: Vec<Entry>,
    unlocked: bool,
}

impl Vault {
    /// 新建空保险库。
    pub fn create(password: &str) -> Result<Self, WtError> {
        Self::create_with_params(password, KdfParams::production(), None)
    }

    pub fn create_with_params(
        password: &str,
        kdf: KdfParams,
        hint: Option<String>,
    ) -> Result<Self, WtError> {
        check_strength(password)?;
        Ok(Self {
            header: Header {
                v: FORMAT_VERSION,
                kdf,
                aead: AeadParams {
                    alg: "xchacha20poly1305".into(),
                    nonce: B64.encode([0u8; NONCE_LEN]),
                },
                created: now_iso8601(),
                key_id: format!("k-{}", now_unix()),
                hint,
            },
            entries: Vec::new(),
            unlocked: true,
        })
    }

    pub fn header(&self) -> &Header {
        &self.header
    }

    pub fn is_unlocked(&self) -> bool {
        self.unlocked
    }

    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    pub fn add(&mut self, entry: Entry) -> Result<(), WtError> {
        self.ensure_unlocked()?;
        if self.entries.iter().any(|e| e.id() == entry.id()) {
            return Err(WtError::new("CRY_DUPLICATE_ENTRY")
                .message(format!("凭据条目 {} 已存在", entry.id())));
        }
        self.entries.push(entry);
        Ok(())
    }

    pub fn remove(&mut self, id: &str) -> Result<(), WtError> {
        self.ensure_unlocked()?;
        let before = self.entries.len();
        self.entries.retain(|e| e.id() != id);
        if self.entries.len() == before {
            return Err(WtError::new("CRY_ENTRY_NOT_FOUND")
                .message(format!("凭据条目 {id} 不存在")));
        }
        Ok(())
    }

    pub fn find(&self, id: &str) -> Option<&Entry> {
        self.entries.iter().find(|e| e.id() == id)
    }

    fn ensure_unlocked(&self) -> Result<(), WtError> {
        if self.unlocked {
            Ok(())
        } else {
            Err(WtError::new("CRY_LOCKED").message("保险库已锁定，请先解锁"))
        }
    }

    /// 加密为文件字节。每次调用都会生成新的 nonce。
    pub fn seal(&mut self, password: &str) -> Result<Vec<u8>, WtError> {
        self.ensure_unlocked()?;

        let key = self.header.kdf.derive(password)?;

        let mut nonce = [0u8; NONCE_LEN];
        rand::thread_rng().fill_bytes(&mut nonce);
        self.header.aead.nonce = B64.encode(nonce);

        let header_json = serde_json::to_vec(&self.header).map_err(|e| {
            WtError::new("CRY_SERIALIZE_FAILED").message("保险库头部序列化失败").detail(e.to_string())
        })?;
        let payload = serde_json::to_vec(&VaultPayload {
            v: FORMAT_VERSION,
            entries: self.entries.clone(),
        })
        .map_err(|e| {
            WtError::new("CRY_SERIALIZE_FAILED").message("保险库内容序列化失败").detail(e.to_string())
        })?;

        let aad = build_aad(&header_json);
        let cipher = XChaCha20Poly1305::new(Key::from_slice(&key[..]));
        let ciphertext = cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                AeadPayload {
                    msg: &payload,
                    aad: &aad,
                },
            )
            .map_err(|_| {
                WtError::new("CRY_ENCRYPT_FAILED").message("保险库加密失败（内部错误）")
            })?;

        let mut out = Vec::with_capacity(aad.len() + ciphertext.len());
        out.extend_from_slice(&aad);
        out.extend_from_slice(&ciphertext);
        Ok(out)
    }

    /// 从文件字节解锁。
    pub fn unlock(bytes: &[u8], password: &str) -> Result<Self, WtError> {
        let (header, header_json, ciphertext) = split_file(bytes)?;

        if header.v != FORMAT_VERSION {
            return Err(WtError::new(codes::CRY_UNSUPPORTED_VERSION)
                .message(format!(
                    "保险库版本 {} 高于本程序支持的 {}，请升级 WindTerm",
                    header.v, FORMAT_VERSION
                ))
                .hint("下载最新版本", HintAction::OpenUrl("https://windterm.dev/download".into())));
        }

        let key = header.kdf.derive(password)?;
        let nonce = B64.decode(&header.aead.nonce).map_err(|_| {
            WtError::new(codes::CRY_VAULT_CORRUPT).message("保险库头部损坏：nonce 不是合法 base64")
        })?;
        if nonce.len() != NONCE_LEN {
            return Err(WtError::new(codes::CRY_VAULT_CORRUPT)
                .message("保险库头部损坏：nonce 长度不正确"));
        }

        let aad = build_aad(&header_json);
        let cipher = XChaCha20Poly1305::new(Key::from_slice(&key[..]));
        let plaintext = cipher
            .decrypt(
                XNonce::from_slice(&nonce),
                AeadPayload {
                    msg: ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| {
                // AEAD 失败只有两种可能：密码错，或文件被篡改。
                // 无法区分（这正是 AEAD 的设计），所以文案要覆盖两种。
                WtError::new(codes::CRY_BAD_PASSWORD)
                    .message("主密码错误，或保险库文件已损坏")
                    .detail("AEAD 校验失败")
                    .hint("确认主密码（注意大小写与输入法）", HintAction::None)
                    .hint("若文件被改动过，从备份恢复", HintAction::None)
            })?;

        let payload: VaultPayload = serde_json::from_slice(&plaintext).map_err(|e| {
            WtError::new(codes::CRY_VAULT_CORRUPT)
                .message("保险库内容损坏")
                .detail(e.to_string())
        })?;

        Ok(Self {
            header,
            entries: payload.entries,
            unlocked: true,
        })
    }

    /// 锁定：清空内存中的明文条目。
    pub fn lock(&mut self) {
        self.entries.clear();
        self.entries.shrink_to_fit();
        self.unlocked = false;
    }
}

fn build_aad(header_json: &[u8]) -> Vec<u8> {
    let mut aad = Vec::with_capacity(12 + header_json.len());
    aad.extend_from_slice(MAGIC);
    aad.push(FORMAT_VERSION);
    aad.push(0); // reserved
    aad.extend_from_slice(&(header_json.len() as u32).to_le_bytes());
    aad.extend_from_slice(header_json);
    aad
}

fn split_file(bytes: &[u8]) -> Result<(Header, Vec<u8>, &[u8]), WtError> {
    if bytes.len() < 12 {
        return Err(WtError::new(codes::CRY_VAULT_CORRUPT)
            .message("保险库文件过短，不是有效文件"));
    }
    if &bytes[0..6] != MAGIC {
        return Err(WtError::new(codes::CRY_VAULT_CORRUPT)
            .message("不是 WindTerm 保险库文件（magic 不匹配）")
            .detail(format!("前 6 字节：{:?}", &bytes[0..6])));
    }
    let version = bytes[6];
    let header_len = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize;
    let header_end = 12 + header_len;
    if bytes.len() < header_end {
        return Err(WtError::new(codes::CRY_VAULT_CORRUPT)
            .message("保险库头部长度字段与实际文件不符"));
    }
    let header_json = bytes[12..header_end].to_vec();
    let ciphertext = &bytes[header_end..];

    let header: Header = serde_json::from_slice(&header_json).map_err(|e| {
        WtError::new(codes::CRY_VAULT_CORRUPT)
            .message("保险库头部无法解析")
            .detail(e.to_string())
    })?;

    if header.v != version {
        return Err(WtError::new(codes::CRY_VAULT_CORRUPT)
            .message("保险库头部版本与文件头不一致（可能被篡改）"));
    }

    Ok((header, header_json, ciphertext))
}

// ─────────────────────────────────────────────────────────────
// 密码强度
// ─────────────────────────────────────────────────────────────

/// 最低要求：≥ 12 个字符。更强的校验（常见密码库、熵估算）在后续迭代补。
pub fn check_strength(password: &str) -> Result<(), WtError> {
    let n = password.chars().count();
    if n < 12 {
        return Err(WtError::new(codes::CRY_WEAK_PASSWORD)
            .message(format!("主密码至少 12 个字符（当前 {n} 个）"))
            .hint("用一句话加两个符号，比随机 8 位更好记也更安全", HintAction::None));
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────
// 时间格式化（不引入 chrono）
// ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const PW: &str = "correct horse battery staple";

    fn fast_vault() -> Vault {
        Vault::create_with_params(PW, KdfParams::fast_for_tests(), None).unwrap()
    }

    #[test]
    fn create_seal_unlock_roundtrip() {
        let mut v = fast_vault();
        v.add(Entry::Password {
            id: "e1".into(),
            name: "prod-web-01".into(),
            secret: B64.encode(b"hunter2"),
            session_id: Some("s1".into()),
        })
        .unwrap();

        let bytes = v.seal(PW).unwrap();
        let back = Vault::unlock(&bytes, PW).unwrap();

        assert_eq!(back.entries().len(), 1);
        assert_eq!(back.entries()[0].name(), "prod-web-01");
        match &back.entries()[0] {
            Entry::Password { secret, .. } => {
                assert_eq!(B64.decode(secret).unwrap(), b"hunter2");
            }
            _ => panic!("类型错误"),
        }
    }

    #[test]
    fn wrong_password_is_rejected() {
        let mut v = fast_vault();
        let bytes = v.seal(PW).unwrap();
        let err = Vault::unlock(&bytes, "wrong password 123").unwrap_err();
        assert_eq!(err.code, codes::CRY_BAD_PASSWORD);
        assert!(err.hints.len() >= 2, "错误必须给出可执行建议");
    }

    #[test]
    fn tampered_ciphertext_is_rejected() {
        let mut v = fast_vault();
        let mut bytes = v.seal(PW).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0xFF;
        let err = Vault::unlock(&bytes, PW).unwrap_err();
        assert_eq!(err.code, codes::CRY_BAD_PASSWORD);
    }

    #[test]
    fn tampered_header_is_rejected_by_aad() {
        let mut v = fast_vault();
        let mut bytes = v.seal(PW).unwrap();

        // 在 header 区域内把 m_cost 8192 改成 8（等长替换，header_len 不变）。
        // 攻击者降低 KDF 成本后再离线爆破，AAD 绑定必须让这条路走不通。
        let needle = b"\"m\":8192";
        let pos = bytes
            .windows(needle.len())
            .position(|w| w == needle)
            .expect("header 中应能找到 m 字段");
        // 只改数字部分，保留引号与冒号，长度不变
        // "m":8192 -> "m":8    （等长，且仍是合法 JSON）
        bytes[pos + 4] = b'8';
        bytes[pos + 5] = b' ';
        bytes[pos + 6] = b' ';
        bytes[pos + 7] = b' ';

        let err = Vault::unlock(&bytes, PW).unwrap_err();
        // 改 header 后 AAD 不匹配 → AEAD 失败（与密码错无法区分，这是 AEAD 的设计）
        assert_eq!(err.code, codes::CRY_BAD_PASSWORD);
    }

    #[test]
    fn bad_magic_is_rejected() {
        // 12 字节：足够长到能检查 magic，但 magic 不对
        let err = Vault::unlock(b"NOPE\0\0\x01\x00\x00\x00\x00\x00\x00\x00", PW).unwrap_err();
        assert_eq!(err.code, codes::CRY_VAULT_CORRUPT);
        assert!(err.message.contains("magic"));
    }

    #[test]
    fn too_short_file_is_rejected() {
        let err = Vault::unlock(b"WTVL", PW).unwrap_err();
        assert_eq!(err.code, codes::CRY_VAULT_CORRUPT);
    }

    #[test]
    fn truncated_header_is_rejected() {
        let mut v = fast_vault();
        let mut bytes = v.seal(PW).unwrap();
        bytes.truncate(14);
        let err = Vault::unlock(&bytes, PW).unwrap_err();
        assert_eq!(err.code, codes::CRY_VAULT_CORRUPT);
    }

    #[test]
    fn weak_password_is_rejected() {
        let err = Vault::create("short").unwrap_err();
        assert_eq!(err.code, codes::CRY_WEAK_PASSWORD);
        assert!(err.message.contains("12"));
    }

    #[test]
    fn duplicate_entry_is_rejected() {
        let mut v = fast_vault();
        let e = Entry::Password {
            id: "dup".into(),
            name: "a".into(),
            secret: B64.encode(b"x"),
            session_id: None,
        };
        v.add(e.clone()).unwrap();
        let err = v.add(e).unwrap_err();
        assert_eq!(err.code, "CRY_DUPLICATE_ENTRY");
    }

    #[test]
    fn remove_missing_entry_is_rejected() {
        let mut v = fast_vault();
        let err = v.remove("nope").unwrap_err();
        assert_eq!(err.code, "CRY_ENTRY_NOT_FOUND");
    }

    #[test]
    fn lock_clears_entries() {
        let mut v = fast_vault();
        v.add(Entry::Password {
            id: "e1".into(),
            name: "a".into(),
            secret: B64.encode(b"x"),
            session_id: None,
        })
        .unwrap();
        v.lock();
        assert!(!v.is_unlocked());
        assert!(v.entries().is_empty());
        assert_eq!(v.add(Entry::Totp {
            id: "t".into(),
            name: "b".into(),
            secret: "c2VlZA==".into(),
            digits: 6,
            period: 30,
            alg: "SHA1".into(),
        }).unwrap_err().code, "CRY_LOCKED");
    }

    #[test]
    fn seal_generates_new_nonce_each_time() {
        let mut v = fast_vault();
        let a = v.seal(PW).unwrap();
        let nonce_a = v.header().aead.nonce.clone();
        let _b = v.seal(PW).unwrap();
        let nonce_b = v.header().aead.nonce.clone();
        assert_ne!(nonce_a, nonce_b, "nonce 绝不能重复");
        assert_ne!(a.len(), 0);
    }

    #[test]
    fn entry_kinds_serialize_with_tag() {
        let e = Entry::Totp {
            id: "t1".into(),
            name: "bastion".into(),
            secret: "c2VlZA==".into(),
            digits: 6,
            period: 30,
            alg: "SHA1".into(),
        };
        let j = serde_json::to_string(&e).unwrap();
        assert!(j.contains("\"kind\":\"totp\""));
        assert_eq!(e.kind_str(), "totp");
    }


    #[test]
    fn production_kdf_params_are_strong() {
        let p = KdfParams::production();
        assert!(p.m >= 64 * 1024, "内存开销应 ≥ 64 MiB");
        assert!(p.t >= 3);
        assert_eq!(p.p, 4);
        assert_eq!(p.alg, "argon2id");
    }

    #[test]
    fn derived_key_is_32_bytes_and_deterministic() {
        let p = KdfParams::fast_for_tests();
        let a = p.derive("pw").unwrap();
        let b = p.derive("pw").unwrap();
        assert_eq!(a.as_ref(), b.as_ref());
        assert_eq!(a.len(), 32);

        let c = p.derive("pw2").unwrap();
        assert_ne!(a.as_ref(), c.as_ref());
    }

    #[test]
    fn unsupported_kdf_algorithm_is_rejected() {
        let mut p = KdfParams::fast_for_tests();
        p.alg = "scrypt".into();
        let err = p.derive("pw").unwrap_err();
        assert_eq!(err.code, codes::CRY_UNSUPPORTED_VERSION);
    }
}
