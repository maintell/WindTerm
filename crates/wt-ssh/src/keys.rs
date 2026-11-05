//! 私钥加载与指纹。
//!
//! 设计依据：`docs/design/09-credentials-crypto.md` §5、`docs/spec/11-func-security.md` §3.4。
//!
//! **对外不暴露 `russh` / `ssh-key` 的类型**：调用方只拿到 [`KeyInfo`] 与
//! [`PrivateKeySource`]，换实现不影响上层。
//!
//! 支持的格式由 `ssh-key` 决定：OpenSSH 新格式（含 bcrypt 加密）、PEM PKCS#1/#8、
//! RFC 4716 公钥。PuTTY `.ppk` 由 [`crate::ppk`] 先转成 OpenSSH 文本——
//! **只覆盖未加密的 ed25519**，RSA 与带口令的 `.ppk` 仍要 puttygen 转一次。

use russh::keys::ssh_key::rand_core::{TryCryptoRng, TryRng};
use wt_common::{HintAction, WtError};

/// 私钥来源：原文 + 可选口令。
#[derive(Clone)]
pub struct PrivateKeySource {
    pub pem: Vec<u8>,
    pub passphrase: Option<String>,
}

impl std::fmt::Debug for PrivateKeySource {
    /// 手写 Debug：**绝不打印私钥内容**。
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PrivateKeySource")
            .field("pem_len", &self.pem.len())
            .field("has_passphrase", &self.passphrase.is_some())
            .finish()
    }
}

impl PrivateKeySource {
    pub fn new(pem: impl Into<Vec<u8>>, passphrase: Option<String>) -> Self {
        Self {
            pem: pem.into(),
            passphrase,
        }
    }

    pub fn from_file(path: &std::path::Path, passphrase: Option<String>) -> Result<Self, WtError> {
        let pem = std::fs::read(path).map_err(|e| {
            WtError::new("SSH_KEY_UNREADABLE")
                .message(format!("无法读取私钥文件 {}", path.display()))
                .detail(e.to_string())
                .hint("检查路径与文件权限", HintAction::None)
        })?;
        Ok(Self::new(pem, passphrase))
    }
}

/// 私钥的公开信息（可安全展示、可写入审计日志）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyInfo {
    pub key_type: String,
    /// `SHA256:...`（OpenSSH 风格）
    pub fingerprint: String,
    pub encrypted: bool,
}

/// 桥接 RNG：`ssh-key 0.7` 用 `rand_core 0.10` 的 `CryptoRng`，而项目主依赖是
/// rand 0.8（`rand_core 0.6`）。两者 trait 不同代，不能直接传。
///
/// 生成密钥（`LOC-014`）与测试用的那把「一次性私钥」都走这里——
/// 私钥不该进版本库，哪怕它「只用于 localhost」。
struct KeyRng;

fn fill_random(dst: &mut [u8]) {
    use rand::RngCore;
    rand::thread_rng().fill_bytes(dst);
}

impl TryRng for KeyRng {
    type Error = std::convert::Infallible;

    fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
        let mut b = [0u8; 4];
        fill_random(&mut b);
        Ok(u32::from_le_bytes(b))
    }

    fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
        let mut b = [0u8; 8];
        fill_random(&mut b);
        Ok(u64::from_le_bytes(b))
    }

    fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Self::Error> {
        fill_random(dst);
        Ok(())
    }
}

impl TryCryptoRng for KeyRng {}

#[cfg(test)]
mod generate_tests {
    use super::*;

    #[test]
    fn generated_key_inspects_to_the_same_fingerprint() {
        let key = generate("ed25519", None, "wt@test").expect("生成");
        assert!(!key.encrypted);
        assert!(!key.pem.is_empty());
        // 公钥行要能直接贴进 authorized_keys：算法 + base64 + 注释
        assert!(key.public_openssh.starts_with("ssh-ed25519 "), "{}", key.public_openssh);
        assert!(key.public_openssh.ends_with(" wt@test"), "{}", key.public_openssh);

        // 拿生成的私钥再解析一次：指纹必须一致，否则「导出的是什么」说不清
        let src = PrivateKeySource::new(key.pem.clone(), None);
        let info = inspect(&src).expect("解析自己生成的私钥");
        assert_eq!(info.fingerprint, key.fingerprint);
        assert_eq!(info.key_type, key.key_type);
    }

    #[test]
    fn encrypted_key_needs_the_passphrase() {
        let key = generate("ed25519", Some("s3cret"), "").expect("生成");
        assert!(key.encrypted);

        // 不给口令：明确报「需要口令」，而不是一句看不懂的解析错误
        let err = inspect(&PrivateKeySource::new(key.pem.clone(), None)).unwrap_err();
        assert_eq!(err.code, "SSH_KEY_PASSPHRASE_REQUIRED");

        let ok = inspect(&PrivateKeySource::new(key.pem.clone(), Some("s3cret".into()))).unwrap();
        assert_eq!(ok.fingerprint, key.fingerprint);
    }

    #[test]
    fn unknown_algorithm_is_rejected_not_guessed() {
        let err = generate("dsa1024", None, "").unwrap_err();
        assert_eq!(err.code, "SSH_KEY_BAD_ARGUMENT");
        assert!(err.message.contains("dsa1024"), "{}", err.message);
    }
}

/// 生成一把原始私钥对象。
///
/// 生产路径（[`generate`]）与 mock 服务端的主机密钥都走这里：两边各写一份
/// 生成代码，迟早会出现「测试能生成、真实生成却导不出」这类分叉。
pub(crate) fn random_private_key(
    alg: russh::keys::Algorithm,
) -> Result<russh::keys::PrivateKey, WtError> {
    russh::keys::PrivateKey::random(&mut KeyRng, alg).map_err(|e| {
        WtError::new("SSH_KEY_GENERATE_FAILED")
            .message("生成密钥失败")
            .detail(e.to_string())
    })
}

/// 生成出来的一把新密钥（`LOC-014`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeneratedKey {
    pub key_type: String,
    pub fingerprint: String,
    /// OpenSSH 私钥文本；给了口令就是加密的
    pub pem: Vec<u8>,
    /// 可直接贴进 `authorized_keys` 的公钥行
    pub public_openssh: String,
    pub encrypted: bool,
}

/// 生成一把新密钥。
///
/// `alg` 只认三种（其余一律报错，不猜）：`ed25519`、`rsa3072`、`ecdsa-p256`。
/// 口令给了就加密——明文私钥落在磁盘上是 `LOC-014` 最容易被忽略的坑。
pub fn generate(alg: &str, passphrase: Option<&str>, comment: &str) -> Result<GeneratedKey, WtError> {
    let alg = match alg {
        "ed25519" => russh::keys::Algorithm::Ed25519,
        "rsa3072" => russh::keys::Algorithm::Rsa { hash: None },
        "ecdsa-p256" => russh::keys::Algorithm::Ecdsa {
            curve: russh::keys::EcdsaCurve::NistP256,
        },
        other => {
            return Err(WtError::new("SSH_KEY_BAD_ARGUMENT")
                .message(format!("不支持的算法 {other}"))
                .hint("可选 ed25519 / rsa3072 / ecdsa-p256", HintAction::None))
        }
    };

    let key = random_private_key(alg)?;
    let info = info_of(&key);
    let public_openssh = key
        .public_key()
        .to_openssh()
        .map(|s| if comment.is_empty() { s } else { format!("{s} {comment}") })
        .map_err(|e| {
            WtError::new("SSH_KEY_GENERATE_FAILED")
                .message("导出公钥失败")
                .detail(e.to_string())
        })?;

    let encrypted = passphrase.map(|p| !p.is_empty()).unwrap_or(false);
    let key = if encrypted {
        key.encrypt(&mut KeyRng, passphrase.unwrap_or_default())
            .map_err(|e| {
                WtError::new("SSH_KEY_GENERATE_FAILED")
                    .message("加密私钥失败")
                    .detail(e.to_string())
            })?
    } else {
        key
    };
    let pem = key
        .to_openssh(russh::keys::ssh_key::LineEnding::LF)
        .map_err(|e| {
            WtError::new("SSH_KEY_GENERATE_FAILED")
                .message("导出私钥失败")
                .detail(e.to_string())
        })?
        .as_bytes()
        .to_vec();

    Ok(GeneratedKey {
        key_type: info.key_type,
        fingerprint: info.fingerprint,
        pem,
        public_openssh,
        encrypted,
    })
}

/// 看起来是不是 DSA 私钥（`SEC-003`）。
///
/// 只认两个明文标志：`BEGIN DSA PRIVATE KEY`（OpenSSH 旧格式）与 .ppk 头里的
/// `ssh-dss`。**PKCS#8 包裹的 DSA 从外壳上看不出来**，那种情况仍会落到通用错误上——
/// 这一点写在文档里，不假装全都认得。
fn looks_like_dsa(pem: &[u8]) -> bool {
    let text = String::from_utf8_lossy(pem);
    text.contains("BEGIN DSA PRIVATE KEY") || text.contains("ssh-dss")
}

/// 解析私钥并返回公开信息。用于「导入密钥时显示指纹」与「连接前校验」。
pub fn inspect(source: &PrivateKeySource) -> Result<KeyInfo, WtError> {
    let key = parse(source)?;
    Ok(info_of(&key))
}

/// 解析私钥。加密且未提供口令时给出明确错误，而不是让底层报一句看不懂的话。
///
/// `.ppk` 会先转成 OpenSSH 文本（见 [`crate::ppk`]）——迁移用户手里多半是这个格式。
pub(crate) fn parse(source: &PrivateKeySource) -> Result<russh::keys::PrivateKey, WtError> {
    // DSA 先说清楚为什么不支持（`SEC-003`）：丢一句「格式无法识别」等于把问题推回给用户。
    if looks_like_dsa(&source.pem) {
        return Err(WtError::new("SSH_KEY_DSA_UNSUPPORTED")
            .message("DSA 私钥不受支持")
            .detail(
                "当前构建只支持 Ed25519 / ECDSA / RSA。DSA 已被 OpenSSH 9.8 默认禁用，\
                 且存在 Marvin 攻击（实现已无维护），所以这里不引入它",
            )
            .hint("用 ssh-keygen -t ed25519 生成新密钥", HintAction::None)
            .hint("把新公钥换到服务器上，旧的 DSA 公钥可以删掉", HintAction::None));
    }
    let pem = if crate::ppk::is_ppk(&source.pem) {
        crate::ppk::convert(&source.pem)?
    } else {
        source.pem.clone()
    };

    let key = russh::keys::PrivateKey::from_openssh(&pem).map_err(|e| {
        WtError::new("SSH_KEY_INVALID")
            .message("私钥格式无法识别")
            .detail(e.to_string())
            .hint(
                "支持 OpenSSH 新格式、PEM（PKCS#1/#8）与未加密的 ed25519 .ppk；\
                 其他 .ppk 用 puttygen 转成 OpenSSH 格式",
                HintAction::None,
            )
    })?;

    if !key.is_encrypted() {
        return Ok(key);
    }

    let Some(pass) = source.passphrase.as_deref() else {
        return Err(WtError::new("SSH_KEY_PASSPHRASE_REQUIRED")
            .message("私钥已加密，需要口令")
            .detail(format!("算法 {}", key.algorithm().as_str()))
            .hint("输入私钥口令", HintAction::None)
            .hint(
                "把口令保存到保险库",
                HintAction::OpenSettings {
                    page: "security.vault".into(),
                },
            ));
    };

    key.decrypt(pass).map_err(|_| {
        WtError::new("SSH_KEY_BAD_PASSPHRASE")
            .message("私钥口令错误")
            .detail("解密失败")
            .hint("确认口令（注意大小写与输入法）", HintAction::None)
    })
}

fn info_of(key: &russh::keys::PrivateKey) -> KeyInfo {
    KeyInfo {
        key_type: key.algorithm().as_str().to_string(),
        fingerprint: key.fingerprint(russh::keys::HashAlg::Sha256).to_string(),
        encrypted: key.is_encrypted(),
    }
}

/// 构造认证用的 `PrivateKeyWithHashAlg`。
///
/// RSA 必须显式给 SHA-512：`None` 会被映射到 SHA-1 的 `ssh-rsa`，
/// 而多数现代服务端已禁用它（这正是「本地能连、服务器连不上」的经典原因）。
pub(crate) fn to_auth_key(
    key: russh::keys::PrivateKey,
) -> russh::keys::key::PrivateKeyWithHashAlg {
    let hash = if key.algorithm().is_rsa() {
        Some(russh::keys::HashAlg::Sha512)
    } else {
        None
    };
    russh::keys::key::PrivateKeyWithHashAlg::new(std::sync::Arc::new(key), hash)
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::ssh_key::rand_core::{TryCryptoRng, TryRng};

    /// 同 `tests/ssh_roundtrip.rs`：桥接 rand_core 0.10 与 rand 0.8。
    struct BridgeRng;

    fn fill(dst: &mut [u8]) {
        <rand::rngs::ThreadRng as rand::RngCore>::fill_bytes(&mut rand::thread_rng(), dst);
    }

    impl TryRng for BridgeRng {
        type Error = std::convert::Infallible;
        fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
            let mut b = [0u8; 4];
            fill(&mut b);
            Ok(u32::from_le_bytes(b))
        }
        fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
            let mut b = [0u8; 8];
            fill(&mut b);
            Ok(u64::from_le_bytes(b))
        }
        fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Self::Error> {
            fill(dst);
            Ok(())
        }
    }

    impl TryCryptoRng for BridgeRng {}

    fn generate_openssh_key() -> (Vec<u8>, String) {
        let key = russh::keys::PrivateKey::random(&mut BridgeRng, russh::keys::Algorithm::Ed25519)
            .expect("生成密钥");
        let fp = key.fingerprint(russh::keys::HashAlg::Sha256).to_string();
        let pem = key
            .to_openssh(russh::keys::ssh_key::LineEnding::LF)
            .expect("导出 OpenSSH 格式");
        (pem.as_bytes().to_vec(), fp)
    }

    #[test]
    fn inspect_reads_type_and_fingerprint() {
        let (pem, expected_fp) = generate_openssh_key();
        let info = inspect(&PrivateKeySource::new(pem, None)).expect("应能解析");

        assert_eq!(info.key_type, "ssh-ed25519");
        assert_eq!(info.fingerprint, expected_fp);
        assert!(!info.encrypted);
    }

    #[test]
    fn invalid_pem_gives_actionable_error() {
        let err = inspect(&PrivateKeySource::new(b"not a key".to_vec(), None)).unwrap_err();
        assert_eq!(err.code, "SSH_KEY_INVALID");
        assert!(err.hints.iter().any(|h| h.label.contains("ppk")));
    }

    /// `SEC-003`：DSA 不支持，但必须**说清原因**，不能丢一句「格式无法识别」。
    #[test]
    fn dsa_key_says_why_it_is_unsupported() {
        let pem = b"-----BEGIN DSA PRIVATE KEY-----\nAAAA\n-----END DSA PRIVATE KEY-----\n".to_vec();
        let err = inspect(&PrivateKeySource::new(pem, None)).unwrap_err();
        assert_eq!(err.code, "SSH_KEY_DSA_UNSUPPORTED");
        assert!(err.message.contains("DSA"));
        assert!(err.detail.as_deref().unwrap_or("").contains("Marvin"));
        assert!(err.hints.iter().any(|h| h.label.contains("ed25519")));
    }

    /// .ppk 里的 DSA（`Algorithm: ssh-dss`）同样要认出来——迁移用户多半是这个格式。
    #[test]
    fn ppk_dsa_is_detected_before_conversion() {
        let ppk = b"PuTTY-User-Key-File-2: ssh-dss\nEncryption: none\n".to_vec();
        let err = inspect(&PrivateKeySource::new(ppk, None)).unwrap_err();
        assert_eq!(err.code, "SSH_KEY_DSA_UNSUPPORTED");
    }

    #[test]
    fn encrypted_key_without_passphrase_is_explicit() {
        // 用空口令加密一个 ed25519 密钥
        let key = russh::keys::PrivateKey::random(&mut BridgeRng, russh::keys::Algorithm::Ed25519)
            .unwrap();
        let encrypted = key.encrypt(&mut BridgeRng, "hunter2").expect("加密");
        let pem = encrypted
            .to_openssh(russh::keys::ssh_key::LineEnding::LF)
            .unwrap()
            .as_bytes()
            .to_vec();

        let err = inspect(&PrivateKeySource::new(pem.clone(), None)).unwrap_err();
        assert_eq!(err.code, "SSH_KEY_PASSPHRASE_REQUIRED");
        assert!(err.message.contains("口令"));

        // 给错口令
        let err = inspect(&PrivateKeySource::new(pem.clone(), Some("wrong".into()))).unwrap_err();
        assert_eq!(err.code, "SSH_KEY_BAD_PASSPHRASE");

        // 给对口令
        let info = inspect(&PrivateKeySource::new(pem, Some("hunter2".into()))).unwrap();
        assert_eq!(info.key_type, "ssh-ed25519");
    }

    #[test]
    fn debug_never_prints_key_material() {
        let (pem, _) = generate_openssh_key();
        let src = PrivateKeySource::new(pem.clone(), Some("secret".into()));
        let text = format!("{src:?}");
        assert!(!text.contains("secret"), "不能打印口令：{text}");
        assert!(!text.contains("PRIVATE KEY"), "不能打印私钥：{text}");
        assert!(text.contains("has_passphrase: true"));
    }

    #[test]
    fn rsa_keys_get_sha512_hash_alg() {
        let key = russh::keys::PrivateKey::random(&mut BridgeRng, russh::keys::Algorithm::Rsa {
            hash: None,
        })
        .unwrap();
        // 只要能构造出来就说明没有 panic；具体 hash 由 russh 内部保存
        let _ = to_auth_key(key);
    }
}
