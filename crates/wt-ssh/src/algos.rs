//! 算法配置与协商诊断。
//!
//! 设计依据：`docs/design/05-ssh-stack.md` §3。
//!
//! 两个刻意的选择：
//! 1. **默认只启用现代算法**，弱算法（SHA-1 系列、CBC）必须显式开启；
//! 2. 协商失败时**把服务端支持的列表展示出来**——没有这个信息，用户只能猜。

#![forbid(unsafe_code)]

/// 算法集合。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Algos {
    pub kex: Vec<&'static str>,
    pub host_key: Vec<&'static str>,
    pub cipher: Vec<&'static str>,
    pub mac: Vec<&'static str>,
    pub compression: Vec<&'static str>,
}

/// 兼容开关。默认全关。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CompatFlags {
    /// 允许 `ssh-rsa`（SHA-1 签名）。多数发行版已默认禁用。
    pub allow_ssh_rsa: bool,
    /// 允许 `diffie-hellman-group14-sha1` / `group1-sha1`。
    pub allow_group14_sha1: bool,
    /// 允许 AES-CBC（存在 padding oracle 风险）。
    pub allow_aes_cbc: bool,
    /// 允许 3DES。
    pub allow_3des: bool,
}

impl CompatFlags {
    /// 全部开启（「兼容旧服务器」开关打开时的状态）。
    pub fn all() -> Self {
        Self {
            allow_ssh_rsa: true,
            allow_group14_sha1: true,
            allow_aes_cbc: true,
            allow_3des: true,
        }
    }

    /// 给用户看的说明：开启了哪些弱算法、风险是什么。
    pub fn describe(&self) -> Vec<&'static str> {
        let mut out = Vec::new();
        if self.allow_ssh_rsa {
            out.push("ssh-rsa（SHA-1 签名，已被多数发行版弃用）");
        }
        if self.allow_group14_sha1 {
            out.push("diffie-hellman-group14-sha1（SHA-1 密钥交换）");
        }
        if self.allow_aes_cbc {
            out.push("aes*-cbc（CBC 模式，存在 padding oracle 风险）");
        }
        if self.allow_3des {
            out.push("3des-cbc（已过时）");
        }
        out
    }
}

impl Algos {
    /// 默认算法列表（只含现代算法）。
    pub fn modern() -> Self {
        Self {
            kex: vec![
                "curve25519-sha256",
                "curve25519-sha256@libssh.org",
                "ecdh-sha2-nistp256",
                "ecdh-sha2-nistp384",
                "ecdh-sha2-nistp521",
                "diffie-hellman-group16-sha512",
                "diffie-hellman-group14-sha256",
            ],
            host_key: vec![
                "ssh-ed25519",
                "ecdsa-sha2-nistp256",
                "ecdsa-sha2-nistp384",
                "ecdsa-sha2-nistp521",
                "rsa-sha2-512",
                "rsa-sha2-256",
            ],
            cipher: vec![
                "chacha20-poly1305@openssh.com",
                "aes256-gcm@openssh.com",
                "aes128-gcm@openssh.com",
                "aes256-ctr",
                "aes192-ctr",
                "aes128-ctr",
            ],
            mac: vec![
                "hmac-sha2-256-etm@openssh.com",
                "hmac-sha2-512-etm@openssh.com",
                "umac-128-etm@openssh.com",
                "hmac-sha2-256",
                "hmac-sha2-512",
            ],
            compression: vec!["none", "zlib@openssh.com"],
        }
    }

    /// 按兼容开关扩展算法列表（追加到末尾，优先级低于现代算法）。
    pub fn with_compat(flags: CompatFlags) -> Self {
        let mut a = Self::modern();
        if flags.allow_ssh_rsa {
            a.host_key.push("ssh-rsa");
        }
        if flags.allow_group14_sha1 {
            a.kex.push("diffie-hellman-group14-sha1");
        }
        if flags.allow_aes_cbc {
            a.cipher
                .extend(["aes256-cbc", "aes192-cbc", "aes128-cbc"]);
        }
        if flags.allow_3des {
            a.cipher.push("3des-cbc");
        }
        a
    }

    /// 判断某个算法是否属于「弱算法」（用于 UI 标注）。
    pub fn is_weak(name: &str) -> bool {
        matches!(
            name,
            "ssh-rsa"
                | "diffie-hellman-group14-sha1"
                | "diffie-hellman-group1-sha1"
                | "aes256-cbc"
                | "aes192-cbc"
                | "aes128-cbc"
                | "3des-cbc"
        )
    }
}

impl Default for Algos {
    fn default() -> Self {
        Self::modern()
    }
}

/// 协商失败的诊断信息。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NegotiationFailure {
    /// 哪一类算法没有交集
    pub category: AlgoCategory,
    /// 服务端支持的列表（若已获得）
    pub server_offers: Vec<String>,
    /// 我们支持的列表
    pub client_offers: Vec<&'static str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlgoCategory {
    Kex,
    HostKey,
    Cipher,
    Mac,
    Compression,
}

impl AlgoCategory {
    pub fn label(self) -> &'static str {
        match self {
            AlgoCategory::Kex => "密钥交换",
            AlgoCategory::HostKey => "主机密钥",
            AlgoCategory::Cipher => "加密算法",
            AlgoCategory::Mac => "消息认证码",
            AlgoCategory::Compression => "压缩",
        }
    }

    /// 该类别里哪些「兼容开关」可能解决问题。
    pub fn suggested_flags(self) -> Vec<&'static str> {
        match self {
            AlgoCategory::Kex => vec!["allow_group14_sha1"],
            AlgoCategory::HostKey => vec!["allow_ssh_rsa"],
            AlgoCategory::Cipher => vec!["allow_aes_cbc", "allow_3des"],
            AlgoCategory::Mac => vec![],
            AlgoCategory::Compression => vec![],
        }
    }
}

/// 找出两侧列表的交集（按客户端优先级排序）。
pub fn negotiate(client: &[&'static str], server: &[String]) -> Option<String> {
    client
        .iter()
        .find(|c| server.iter().any(|s| s == *c))
        .map(|c| c.to_string())
}

/// 生成协商失败报告。`server_offers` 为空表示还没拿到服务端列表。
pub fn diagnose(
    category: AlgoCategory,
    client: &[&'static str],
    server_offers: &[String],
) -> NegotiationFailure {
    NegotiationFailure {
        category,
        server_offers: server_offers.to_vec(),
        client_offers: client.to_vec(),
    }
}

impl NegotiationFailure {
    /// 转成用户可见的错误（含可执行建议）。
    pub fn to_error(&self) -> wt_common::WtError {
        use wt_common::{HintAction, WtError};

        let label = self.category.label();
        let mut e = WtError::new("SSH_NO_COMMON_KEX")
            .message(format!("无法与服务端协商{label}算法"));

        if self.server_offers.is_empty() {
            e = e.detail("未获取到服务端支持的算法列表");
        } else {
            e = e.detail(format!(
                "服务端支持：{}\n本程序支持：{}",
                self.server_offers.join(", "),
                self.client_offers.join(", ")
            ));
        }

        let flags = self.category.suggested_flags();
        if !flags.is_empty() {
            e = e.hint(
                "开启兼容模式（会启用已被弃用的算法）",
                HintAction::ApplyFix {
                    fix: format!("ssh.compat:{}", flags.join(",")),
                },
            );
        }
        e.hint("查看连接诊断", HintAction::RunCommand("wt diag --last".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modern_algos_exclude_weak_ones() {
        let a = Algos::modern();
        assert!(!a.host_key.contains(&"ssh-rsa"));
        assert!(!a.kex.contains(&"diffie-hellman-group14-sha1"));
        assert!(!a.cipher.iter().any(|c| c.ends_with("-cbc")));
        assert!(a.cipher.contains(&"chacha20-poly1305@openssh.com"));
    }

    #[test]
    fn compat_flags_append_weak_algos_at_the_end() {
        let a = Algos::with_compat(CompatFlags::all());
        assert_eq!(a.host_key.last(), Some(&"ssh-rsa"));
        assert!(a.kex.contains(&"diffie-hellman-group14-sha1"));
        assert!(a.cipher.contains(&"aes256-cbc"));
        assert!(a.cipher.contains(&"3des-cbc"));

        // 弱算法必须在末尾：现代算法优先
        let ssh_rsa_pos = a.host_key.iter().position(|x| *x == "ssh-rsa").unwrap();
        assert_eq!(ssh_rsa_pos, a.host_key.len() - 1);
    }

    #[test]
    fn partial_compat_only_adds_requested() {
        let flags = CompatFlags {
            allow_ssh_rsa: true,
            ..Default::default()
        };
        let a = Algos::with_compat(flags);
        assert!(a.host_key.contains(&"ssh-rsa"));
        assert!(!a.kex.contains(&"diffie-hellman-group14-sha1"));
        assert!(!a.cipher.contains(&"aes256-cbc"));
    }

    #[test]
    fn compat_description_lists_enabled_risks() {
        let d = CompatFlags::all().describe();
        assert_eq!(d.len(), 4);
        assert!(d.iter().any(|s| s.contains("SHA-1")));
        assert!(d.iter().any(|s| s.contains("padding oracle")));
        assert!(CompatFlags::default().describe().is_empty());
    }

    #[test]
    fn is_weak_recognises_legacy_algos() {
        assert!(Algos::is_weak("ssh-rsa"));
        assert!(Algos::is_weak("aes128-cbc"));
        assert!(!Algos::is_weak("ssh-ed25519"));
        assert!(!Algos::is_weak("aes256-gcm@openssh.com"));
    }

    #[test]
    fn negotiate_picks_client_preference() {
        let client: &[&'static str] = &["a", "b", "c"];
        let server = vec!["c".to_string(), "b".to_string()];
        // 客户端优先 a，其次 b，再次 c；服务端有 b、c → 选 b
        assert_eq!(negotiate(client, &server), Some("b".into()));
    }

    #[test]
    fn negotiate_returns_none_when_disjoint() {
        let client: &[&'static str] = &["a"];
        let server = vec!["z".to_string()];
        assert_eq!(negotiate(client, &server), None);
    }

    #[test]
    fn diagnosis_error_contains_server_list_and_hint() {
        let client: &[&'static str] = &["curve25519-sha256"];
        let server = vec!["diffie-hellman-group14-sha1".to_string()];
        let f = diagnose(AlgoCategory::Kex, client, &server);
        let e = f.to_error();

        assert_eq!(e.code, "SSH_NO_COMMON_KEX");
        assert!(e.message.contains("密钥交换"));
        assert!(e.detail.as_ref().unwrap().contains("group14-sha1"));
        assert!(e.hints.iter().any(|h| h.label.contains("兼容模式")));
    }

    #[test]
    fn diagnosis_without_server_list_still_actionable() {
        let client: &[&'static str] = &["ssh-ed25519"];
        let f = diagnose(AlgoCategory::HostKey, client, &[]);
        let e = f.to_error();
        assert!(e.detail.as_ref().unwrap().contains("未获取"));
        assert!(e.hints.iter().any(|h| h.label.contains("兼容模式")));
    }

    #[test]
    fn mac_category_has_no_compat_suggestion() {
        assert!(AlgoCategory::Mac.suggested_flags().is_empty());
        let f = diagnose(AlgoCategory::Mac, &["hmac-sha2-256"], &["hmac-md5".into()]);
        let e = f.to_error();
        assert!(!e.hints.iter().any(|h| h.label.contains("兼容模式")));
    }
}
