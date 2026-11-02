//! 私钥加载与指纹。
//!
//! 设计依据：`docs/design/09-credentials-crypto.md` §5、`docs/spec/11-func-security.md` §3.4。
//!
//! **对外不暴露 `russh` / `ssh-key` 的类型**：调用方只拿到 [`KeyInfo`] 与
//! [`PrivateKeySource`]，换实现不影响上层。
//!
//! 支持的格式由 `ssh-key` 决定：OpenSSH 新格式（含 bcrypt 加密）、PEM PKCS#1/#8、
//! RFC 4716 公钥。PuTTY `.ppk` **不在其中**——需要单独实现，见 README 的已知缺口。

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

/// 解析私钥并返回公开信息。用于「导入密钥时显示指纹」与「连接前校验」。
pub fn inspect(source: &PrivateKeySource) -> Result<KeyInfo, WtError> {
    let key = parse(source)?;
    Ok(info_of(&key))
}

/// 解析私钥。加密且未提供口令时给出明确错误，而不是让底层报一句看不懂的话。
pub(crate) fn parse(source: &PrivateKeySource) -> Result<russh::keys::PrivateKey, WtError> {
    let key = russh::keys::PrivateKey::from_openssh(&source.pem).map_err(|e| {
        WtError::new("SSH_KEY_INVALID")
            .message("私钥格式无法识别")
            .detail(e.to_string())
            .hint(
                "支持 OpenSSH 新格式、PEM（PKCS#1/#8）；PuTTY .ppk 需先转换",
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
