//! `known_hosts`：主机密钥的存储与校验。
//!
//! 设计依据：`docs/design/05-ssh-stack.md` §4、`docs/spec/11-func-security.md` §5。
//!
//! **兼容 OpenSSH 格式是硬要求**（`SEC-005` AC-3）：用户已有的 `~/.ssh/known_hosts` 要能直接导入，
//! 我们写出的文件也要能被 `ssh-keygen -F` 查到。
//!
//! 支持的行形式：
//! ```text
//! host[,host2] keytype base64key [comment]
//! [host]:2222 keytype base64key
//! |1|base64salt|base64hmac keytype base64key        # 哈希主机名
//! @revoked * ssh-rsa AAAA...
//! @cert-authority *.example.com ssh-ed25519 AAAA...
//! *.example.com ssh-ed25519 AAAA...
//! ```

#![forbid(unsafe_code)]

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use hmac::{Hmac, Mac};
use rand::RngCore;
use sha1::Sha1;
use sha2::{Digest, Sha256};

type HmacSha1 = Hmac<Sha1>;

/// 主机标识：主机名 + 端口。端口 22 在序列化时省略方括号。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct HostKeyId {
    pub host: String,
    pub port: u16,
}

impl HostKeyId {
    pub fn new(host: impl Into<String>, port: u16) -> Self {
        Self {
            host: host.into(),
            port,
        }
    }

    /// 序列化为 known_hosts 的主机字段：22 端口写裸主机名，其他端口写 `[host]:port`。
    pub fn to_pattern(&self) -> String {
        if self.port == 22 {
            self.host.clone()
        } else {
            format!("[{}]:{}", self.host, self.port)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Marker {
    Revoked,
    CertAuthority,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownHostsEntry {
    pub marker: Option<Marker>,
    /// 主机模式（可能是多个、可能是哈希形式、可能含通配符）
    pub patterns: Vec<String>,
    pub key_type: String,
    pub key_blob: Vec<u8>,
    pub comment: Option<String>,
}

/// 校验结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckOutcome {
    /// 主机已知且密钥匹配
    Match,
    /// 该主机从未见过（首次连接，需要 TOFU 确认）
    Unknown,
    /// 该主机已知，但密钥变了（高危）
    Changed { known_fingerprints: Vec<String> },
    /// 命中了 `@revoked`
    Revoked,
}

#[derive(Debug, Clone, Default)]
pub struct KnownHosts {
    entries: Vec<KnownHostsEntry>,
}

impl KnownHosts {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn entries(&self) -> &[KnownHostsEntry] {
        &self.entries
    }

    /// 解析文件内容。无法解析的行进 `warnings`（绝不静默丢弃）。
    pub fn parse(text: &str) -> (Self, Vec<String>) {
        let mut entries = Vec::new();
        let mut warnings = Vec::new();

        for (lineno, raw) in text.lines().enumerate() {
            let line = raw.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }

            let mut rest = line;
            let mut marker = None;
            if let Some(stripped) = rest.strip_prefix('@') {
                let (m, r) = match stripped.split_once(char::is_whitespace) {
                    Some((m, r)) => (m, r.trim_start()),
                    None => {
                        warnings.push(format!("第 {} 行：只有标记没有内容，已忽略", lineno + 1));
                        continue;
                    }
                };
                marker = match m {
                    "revoked" => Some(Marker::Revoked),
                    "cert-authority" => Some(Marker::CertAuthority),
                    other => {
                        warnings.push(format!("第 {} 行：未知标记 @{other}，已忽略", lineno + 1));
                        continue;
                    }
                };
                rest = r;
            }

            let mut parts = rest.split_whitespace();
            let Some(hosts) = parts.next() else {
                continue;
            };
            let Some(key_type) = parts.next() else {
                warnings.push(format!("第 {} 行：缺少密钥类型，已忽略", lineno + 1));
                continue;
            };
            let Some(b64) = parts.next() else {
                warnings.push(format!("第 {} 行：缺少密钥内容，已忽略", lineno + 1));
                continue;
            };
            let comment = parts.next().map(str::to_string);

            let key_blob = match B64.decode(b64) {
                Ok(b) => b,
                Err(_) => {
                    warnings.push(format!(
                        "第 {} 行：密钥不是合法 base64，已忽略",
                        lineno + 1
                    ));
                    continue;
                }
            };

            entries.push(KnownHostsEntry {
                marker,
                patterns: hosts.split(',').map(|s| s.to_string()).collect(),
                key_type: key_type.to_string(),
                key_blob,
                comment,
            });
        }

        (Self { entries }, warnings)
    }

    /// 校验一个主机密钥。
    pub fn check(&self, id: &HostKeyId, key_type: &str, blob: &[u8]) -> CheckOutcome {
        let mut known_fingerprints = Vec::new();
        let mut matched = false;

        for e in &self.entries {
            if !e.patterns.iter().any(|p| pattern_matches(p, id)) {
                continue;
            }
            if e.key_type != key_type {
                continue;
            }
            if e.key_blob == blob {
                if e.marker == Some(Marker::Revoked) {
                    return CheckOutcome::Revoked;
                }
                matched = true;
            } else {
                known_fingerprints.push(fingerprint_sha256(&e.key_blob));
            }
        }

        if matched {
            CheckOutcome::Match
        } else if !known_fingerprints.is_empty() {
            CheckOutcome::Changed { known_fingerprints }
        } else {
            CheckOutcome::Unknown
        }
    }

    /// 记录一个主机密钥。`hashed` 为真时按 OpenSSH 的 `|1|salt|hmac` 形式存储。
    pub fn add(&mut self, id: &HostKeyId, key_type: &str, blob: &[u8], hashed: bool) {
        let pattern = if hashed {
            let mut salt = [0u8; 20];
            rand::thread_rng().fill_bytes(&mut salt);
            hash_host(&id.to_pattern(), &salt)
        } else {
            id.to_pattern()
        };

        // 同主机同类型已存在则替换（避免文件里堆重复行）
        if let Some(e) = self
            .entries
            .iter_mut()
            .find(|e| e.key_type == key_type && e.patterns.iter().any(|p| pattern_matches(p, id)))
        {
            e.key_blob = blob.to_vec();
            e.patterns = vec![pattern];
            e.marker = None;
            return;
        }

        self.entries.push(KnownHostsEntry {
            marker: None,
            patterns: vec![pattern],
            key_type: key_type.to_string(),
            key_blob: blob.to_vec(),
            comment: None,
        });
    }

    /// 按主机**模式**删除记录（含哈希形式与通配符）。返回删除条数。
    ///
    /// `remove_host` 只认 `host:port`，表达不了 `|1|salt|hmac` 这种哈希模式——
    /// 而界面上列出来的正是模式本身，所以另给一个按模式删的入口。
    pub fn remove_pattern(&mut self, pattern: &str) -> usize {
        let before = self.entries.len();
        self.entries
            .retain(|e| !e.patterns.iter().any(|p| p == pattern));
        before - self.entries.len()
    }

    /// 删除某主机的全部记录（用户确认「服务器已重装」后调用）。返回删除条数。
    pub fn remove_host(&mut self, id: &HostKeyId) -> usize {
        let before = self.entries.len();
        self.entries
            .retain(|e| !e.patterns.iter().any(|p| pattern_matches(p, id)));
        before - self.entries.len()
    }

    /// 序列化为 OpenSSH 格式文本。
    pub fn to_text(&self) -> String {
        let mut out = String::new();
        for e in &self.entries {
            if let Some(m) = e.marker {
                out.push_str(match m {
                    Marker::Revoked => "@revoked ",
                    Marker::CertAuthority => "@cert-authority ",
                });
            }
            out.push_str(&e.patterns.join(","));
            out.push(' ');
            out.push_str(&e.key_type);
            out.push(' ');
            out.push_str(&B64.encode(&e.key_blob));
            if let Some(c) = &e.comment {
                out.push(' ');
                out.push_str(c);
            }
            out.push('\n');
        }
        out
    }
}

/// 生成哈希主机名条目：`|1|base64(salt)|base64(HMAC-SHA1(salt, host))`。
pub fn hash_host(host: &str, salt: &[u8]) -> String {
    let mut mac = HmacSha1::new_from_slice(salt).expect("HMAC 接受任意长度密钥");
    mac.update(host.as_bytes());
    let digest = mac.finalize().into_bytes();
    format!("|1|{}|{}", B64.encode(salt), B64.encode(digest))
}

/// 判断一条 pattern 是否匹配目标主机。
fn pattern_matches(pattern: &str, id: &HostKeyId) -> bool {
    let target = id.to_pattern();

    if let Some(rest) = pattern.strip_prefix("|1|") {
        // 哈希形式：|1|salt|hash
        let Some((salt_b64, hash_b64)) = rest.split_once('|') else {
            return false;
        };
        let (Ok(salt), Ok(expected)) = (B64.decode(salt_b64), B64.decode(hash_b64)) else {
            return false;
        };
        let mut mac = match HmacSha1::new_from_slice(&salt) {
            Ok(m) => m,
            Err(_) => return false,
        };
        mac.update(target.as_bytes());
        return mac.verify_slice(&expected).is_ok();
    }

    glob_match(pattern, &target)
}

/// 简单的 glob：`*` 匹配任意长度，`?` 匹配单字符。大小写不敏感。
fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let t: Vec<char> = text.to_lowercase().chars().collect();

    // 经典双指针回溯，避免递归爆栈
    let (mut pi, mut ti) = (0usize, 0usize);
    let mut star: Option<(usize, usize)> = None;

    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some((pi, ti));
            pi += 1;
        } else if let Some((sp, st)) = star {
            pi = sp + 1;
            ti = st + 1;
            star = Some((sp, st + 1));
        } else {
            return false;
        }
    }

    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// OpenSSH 风格的 SHA256 指纹：`SHA256:<base64 无填充>`。
pub fn fingerprint_sha256(blob: &[u8]) -> String {
    use base64::engine::general_purpose::STANDARD_NO_PAD;
    let digest = Sha256::digest(blob);
    format!("SHA256:{}", STANDARD_NO_PAD.encode(digest))
}

#[cfg(test)]
mod pattern_tests {
    use super::*;

    #[test]
    fn remove_pattern_covers_hashed_entries_too() {
        let mut kh = KnownHosts::new();
        kh.add(&HostKeyId::new("h1", 22), "ssh-ed25519", b"k1", false);
        kh.add(&HostKeyId::new("h2", 22), "ssh-ed25519", b"k2", true);
        assert_eq!(kh.entries().len(), 2);

        // 哈希形式的记录 `remove_host` 表达不了，只能按模式删
        let hashed = kh.entries()[1].patterns[0].clone();
        assert_eq!(kh.remove_pattern(&hashed), 1);
        assert_eq!(kh.entries().len(), 1);
        assert_eq!(kh.remove_pattern("没这个模式"), 0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 用真实编码构造样本：手写的假 base64 长度不合法会被当成坏行丢弃，
    // 那样测的就不是「解析逻辑」而是「我的字符串写得对不对」。
    const K_ED: &[u8] = b"ed25519-key-material-1";
    const K_RSA: &[u8] = b"rsa-key-material-1";
    const K_ECDSA: &[u8] = b"ecdsa-key-material-1";
    const K_REVOKED: &[u8] = b"revoked-key-material";

    fn sample() -> String {
        format!(
            "# 这是注释\n\
             10.0.1.11 ssh-ed25519 {ed}\n\
             [10.0.1.12]:2222 ssh-rsa {rsa}\n\
             *.example.com,foo.example.com ecdsa-sha2-nistp256 {ecdsa}\n\
             @revoked 10.0.9.9 ssh-rsa {rev}\n",
            ed = B64.encode(K_ED),
            rsa = B64.encode(K_RSA),
            ecdsa = B64.encode(K_ECDSA),
            rev = B64.encode(K_REVOKED),
        )
    }

    #[test]
    fn parses_entries_and_skips_comments() {
        let (kh, warnings) = KnownHosts::parse(&sample());
        assert_eq!(kh.len(), 4, "应解析出 4 条：{warnings:?}");
        assert!(warnings.is_empty());
        assert_eq!(kh.entries()[0].key_type, "ssh-ed25519");
        assert_eq!(kh.entries()[1].patterns, vec!["[10.0.1.12]:2222"]);
        assert_eq!(kh.entries()[2].patterns.len(), 2);
        assert_eq!(kh.entries()[3].marker, Some(Marker::Revoked));
    }

    #[test]
    fn matches_plain_host_on_default_port() {
        let (kh, _) = KnownHosts::parse(&sample());
        let id = HostKeyId::new("10.0.1.11", 22);
        assert_eq!(kh.check(&id, "ssh-ed25519", K_ED), CheckOutcome::Match);
    }

    #[test]
    fn plain_host_does_not_match_non_default_port() {
        let (kh, _) = KnownHosts::parse(&sample());
        let id = HostKeyId::new("10.0.1.11", 2222);
        assert_eq!(kh.check(&id, "ssh-ed25519", K_ED), CheckOutcome::Unknown);
    }

    #[test]
    fn matches_bracketed_host_with_port() {
        let (kh, _) = KnownHosts::parse(&sample());
        let id = HostKeyId::new("10.0.1.12", 2222);
        assert_eq!(kh.check(&id, "ssh-rsa", K_RSA), CheckOutcome::Match);
    }

    #[test]
    fn wildcard_patterns_match_subdomains() {
        let (kh, _) = KnownHosts::parse(&sample());
        let id = HostKeyId::new("web.example.com", 22);
        assert_eq!(
            kh.check(&id, "ecdsa-sha2-nistp256", K_ECDSA),
            CheckOutcome::Match
        );
    }

    #[test]
    fn changed_key_is_detected_with_known_fingerprint() {
        let (kh, _) = KnownHosts::parse(&sample());
        let id = HostKeyId::new("10.0.1.11", 22);
        match kh.check(&id, "ssh-ed25519", b"different-key-material") {
            CheckOutcome::Changed { known_fingerprints } => {
                assert_eq!(known_fingerprints.len(), 1);
                assert_eq!(known_fingerprints[0], fingerprint_sha256(K_ED));
            }
            other => panic!("应判定为 Changed，实际 {other:?}"),
        }
    }

    #[test]
    fn different_key_type_for_known_host_is_unknown_not_changed() {
        // 同一主机换了密钥类型（如从 ed25519 换成 rsa）不是「密钥变更」，是新增
        let (kh, _) = KnownHosts::parse(&sample());
        let id = HostKeyId::new("10.0.1.11", 22);
        assert_eq!(kh.check(&id, "rsa-sha2-512", b"x"), CheckOutcome::Unknown);
    }

    #[test]
    fn revoked_entry_wins() {
        let (kh, _) = KnownHosts::parse(&sample());
        let id = HostKeyId::new("10.0.9.9", 22);
        assert_eq!(kh.check(&id, "ssh-rsa", K_REVOKED), CheckOutcome::Revoked);
    }

    #[test]
    fn unknown_host_returns_unknown() {
        let (kh, _) = KnownHosts::parse(&sample());
        assert_eq!(
            kh.check(&HostKeyId::new("192.0.2.1", 22), "ssh-ed25519", b"x"),
            CheckOutcome::Unknown
        );
    }

    #[test]
    fn hashed_entry_matches_and_does_not_leak_hostname() {
        let salt = b"0123456789abcdefghij".to_vec();
        let hashed = hash_host("secret.internal", &salt);
        assert!(hashed.starts_with("|1|"));
        assert!(!hashed.contains("secret.internal"), "哈希条目不能含明文主机名");

        let text = format!("{hashed} ssh-ed25519 {}\n", B64.encode(b"keymaterial"));
        let (kh, warnings) = KnownHosts::parse(&text);
        assert!(warnings.is_empty(), "{warnings:?}");

        assert_eq!(
            kh.check(
                &HostKeyId::new("secret.internal", 22),
                "ssh-ed25519",
                b"keymaterial"
            ),
            CheckOutcome::Match
        );
        assert_eq!(
            kh.check(
                &HostKeyId::new("other.internal", 22),
                "ssh-ed25519",
                b"keymaterial"
            ),
            CheckOutcome::Unknown
        );
    }

    #[test]
    fn hashed_entry_respects_port() {
        let salt = b"0123456789abcdefghij".to_vec();
        let hashed = hash_host("[host.internal]:2222", &salt);
        let text = format!("{hashed} ssh-ed25519 {}\n", B64.encode(b"k"));
        let (kh, _) = KnownHosts::parse(&text);

        assert_eq!(
            kh.check(&HostKeyId::new("host.internal", 2222), "ssh-ed25519", b"k"),
            CheckOutcome::Match
        );
        assert_eq!(
            kh.check(&HostKeyId::new("host.internal", 22), "ssh-ed25519", b"k"),
            CheckOutcome::Unknown
        );
    }

    #[test]
    fn add_then_check_roundtrip() {
        let mut kh = KnownHosts::new();
        let id = HostKeyId::new("10.0.1.11", 22);
        kh.add(&id, "ssh-ed25519", b"blob1", false);

        assert_eq!(kh.check(&id, "ssh-ed25519", b"blob1"), CheckOutcome::Match);
        assert_eq!(
            kh.check(&id, "ssh-ed25519", b"blob2"),
            CheckOutcome::Changed {
                known_fingerprints: vec![fingerprint_sha256(b"blob1")]
            }
        );
    }

    #[test]
    fn add_replaces_existing_entry_for_same_host_and_type() {
        let mut kh = KnownHosts::new();
        let id = HostKeyId::new("10.0.1.11", 22);
        kh.add(&id, "ssh-ed25519", b"old", false);
        kh.add(&id, "ssh-ed25519", b"new", false);

        assert_eq!(kh.len(), 1, "同主机同类型应替换而不是堆叠");
        assert_eq!(kh.check(&id, "ssh-ed25519", b"new"), CheckOutcome::Match);
    }

    #[test]
    fn add_hashed_writes_hash_form() {
        let mut kh = KnownHosts::new();
        kh.add(
            &HostKeyId::new("secret.internal", 22),
            "ssh-ed25519",
            b"k",
            true,
        );
        let text = kh.to_text();
        assert!(text.starts_with("|1|"));
        assert!(!text.contains("secret.internal"));

        // 写出的哈希条目必须能被自己读回来
        let (back, warnings) = KnownHosts::parse(&text);
        assert!(warnings.is_empty());
        assert_eq!(
            back.check(&HostKeyId::new("secret.internal", 22), "ssh-ed25519", b"k"),
            CheckOutcome::Match
        );
    }

    #[test]
    fn remove_host_removes_all_key_types() {
        let mut kh = KnownHosts::new();
        let id = HostKeyId::new("10.0.1.11", 22);
        kh.add(&id, "ssh-ed25519", b"a", false);
        kh.add(&id, "rsa-sha2-512", b"b", false);
        assert_eq!(kh.len(), 2);

        assert_eq!(kh.remove_host(&id), 2);
        assert!(kh.is_empty());
    }

    #[test]
    fn remove_host_leaves_others_alone() {
        let (mut kh, _) = KnownHosts::parse(&sample());
        let before = kh.len();
        assert_eq!(kh.remove_host(&HostKeyId::new("10.0.1.11", 22)), 1);
        assert_eq!(kh.len(), before - 1);
        assert_eq!(
            kh.check(&HostKeyId::new("10.0.1.12", 2222), "ssh-rsa", K_RSA),
            CheckOutcome::Match
        );
    }

    #[test]
    fn serialize_then_parse_is_stable() {
        let (kh, _) = KnownHosts::parse(&sample());
        let text = kh.to_text();
        let (kh2, warnings) = KnownHosts::parse(&text);
        assert!(warnings.is_empty());
        assert_eq!(kh.len(), kh2.len());
        assert_eq!(kh.entries(), kh2.entries());
    }

    #[test]
    fn malformed_lines_produce_warnings_not_silence() {
        let text = "host1\nhost2 ssh-ed25519\nhost3 ssh-ed25519 !!!notbase64\n@weird host ssh-ed25519 AAAA\n";
        let (kh, warnings) = KnownHosts::parse(text);
        assert!(kh.is_empty());
        assert_eq!(warnings.len(), 4, "四种坏行都要有警告：{warnings:?}");
    }

    #[test]
    fn glob_matching_basics() {
        assert!(glob_match("*.example.com", "web.example.com"));
        assert!(glob_match("host?", "host1"));
        assert!(!glob_match("host?", "host12"));
        assert!(glob_match("*", "anything"));
        assert!(glob_match("WEB.EXAMPLE.COM", "web.example.com"), "大小写不敏感");
        assert!(!glob_match("*.example.com", "example.com.evil.org"));
    }

    #[test]
    fn fingerprint_matches_openssh_style() {
        let f = fingerprint_sha256(b"abc");
        assert!(f.starts_with("SHA256:"));
        assert!(!f.contains('='), "OpenSSH 的指纹不带 base64 填充");
        assert_ne!(f, fingerprint_sha256(b"abd"));
    }

    #[test]
    fn host_key_id_pattern_formats_port_correctly() {
        assert_eq!(HostKeyId::new("h", 22).to_pattern(), "h");
        assert_eq!(HostKeyId::new("h", 2222).to_pattern(), "[h]:2222");
    }
}