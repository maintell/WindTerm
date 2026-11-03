//! WindTerm 公共基础设施：错误模型、错误码。
//!
//! 设计依据：`docs/design/01-architecture.md` §6。
//!
//! 三条硬规则（违反即视为缺陷）：
//! 1. 每个错误有稳定 `code`（文档与测试引用 code，不引用文案）；
//! 2. `message` 是用户能懂的一句话，协议原文放 `detail`；
//! 3. 能给出动作就必须给（`hints` 非空）——「连接失败」+ 无建议 = 不合格。

use serde::{Deserialize, Serialize};
use std::fmt;

/// 错误分类。UI 依据它决定呈现方式（内联 / 横幅 / 模态）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    /// 配置非法、缺失、版本不兼容
    Config,
    /// DNS、TCP、TLS、代理等链路问题
    Network,
    /// 认证失败（密码、密钥、主机密钥）
    Auth,
    /// 协议层异常（SSH 协商、RDP 连接序列、RFB 握手）
    Protocol,
    /// 权限不足（本地文件系统、远端路径）
    Permission,
    /// 资源不存在
    NotFound,
    /// 冲突（端口占用、文件已存在、并发修改）
    Conflict,
    /// 资源耗尽（磁盘满、内存、连接数上限）
    Resource,
    /// 内部缺陷（不应发生；发生时必须带诊断信息）
    Internal,
    /// 用户主动取消
    Canceled,
}

impl ErrorKind {
    /// 是否属于「用户自己能解决」的问题。决定 UI 是否强调 hints。
    pub fn is_actionable(self) -> bool {
        matches!(
            self,
            ErrorKind::Config
                | ErrorKind::Network
                | ErrorKind::Auth
                | ErrorKind::Permission
                | ErrorKind::Conflict
                | ErrorKind::Resource
        )
    }
}

/// 可执行建议。结构化而非纯文本，前端才能把它渲染成按钮。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HintAction {
    /// 无动作，仅作说明
    None,
    /// 重试当前操作
    Retry,
    /// 打开设置页
    OpenSettings { page: String },
    /// 用系统浏览器打开链接（下载依赖、查看文档）
    OpenUrl(String),
    /// 复制一段文本到剪贴板（例如给运维的配置行）
    CopyText(String),
    /// 执行一条 `wt` 命令
    RunCommand(String),
    /// 应用一个核心已知的修复（由核心解释 fix 名称）
    ApplyFix { fix: String },
}

/// 一条建议：按钮文案 + 动作。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hint {
    pub label: String,
    pub action: HintAction,
}

impl Hint {
    pub fn new(label: impl Into<String>, action: HintAction) -> Self {
        Self {
            label: label.into(),
            action,
        }
    }
}

/// WindTerm 统一错误类型。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WtError {
    pub kind: ErrorKind,
    /// 稳定错误码，形如 `SSH_HOSTKEY_CHANGED`。文档与测试引用它。
    pub code: String,
    /// 面向用户的一句话（已本地化或已是最简表述）。
    pub message: String,
    /// 技术细节，UI 折叠显示。
    pub detail: Option<String>,
    /// 可执行建议。
    pub hints: Vec<Hint>,
}

impl WtError {
    pub fn new(code: &str) -> Self {
        Self {
            kind: kind_of(code),
            code: code.to_string(),
            message: String::new(),
            detail: None,
            hints: Vec::new(),
        }
    }

    /// 显式指定分类（当错误码前缀不足以判断时使用）。
    pub fn with_kind(mut self, kind: ErrorKind) -> Self {
        self.kind = kind;
        self
    }

    pub fn message(mut self, msg: impl Into<String>) -> Self {
        self.message = msg.into();
        self
    }

    pub fn detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    pub fn hint(mut self, label: impl Into<String>, action: HintAction) -> Self {
        self.hints.push(Hint::new(label, action));
        self
    }

    /// 追加一条纯说明（无动作）。
    pub fn note(self, text: impl Into<String>) -> Self {
        self.hint(text, HintAction::None)
    }

    pub fn is_actionable(&self) -> bool {
        self.kind.is_actionable()
    }
}

impl fmt::Display for WtError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)?;
        if let Some(d) = &self.detail {
            write!(f, " ({d})")?;
        }
        Ok(())
    }
}

impl std::error::Error for WtError {}

/// 由错误码前缀推断分类。
///
/// 前缀约定见 `docs/design/01-architecture.md` §6.2：
/// `CFG_` `STORE_` `CRY_` `SSH_` `SFTP_` `RDP_` `VNC_` `TUN_` `SHE_` `PLG_` `SYS_` `NET_`
fn kind_of(code: &str) -> ErrorKind {
    let prefix = code.split('_').next().unwrap_or("");
    match prefix {
        "CFG" => ErrorKind::Config,
        "STORE" => ErrorKind::Internal,
        "CRY" => ErrorKind::Auth,
        "SSH" | "SFTP" | "RDP" | "VNC" | "NET" => ErrorKind::Protocol,
        "TUN" => ErrorKind::Network,
        "SHE" => ErrorKind::Internal,
        "PLG" => ErrorKind::Config,
        "SYS" => ErrorKind::Internal,
        _ => ErrorKind::Internal,
    }
}

/// 时间格式化。
///
/// 不引入 `chrono`：我们只需要「Unix 秒 → ISO 8601（UTC）」这一个方向，
/// 用 Howard Hinnant 的 civil_from_days 算法约 20 行即可，且无时区数据库负担。
pub mod time {
    use std::time::{SystemTime, UNIX_EPOCH};

    pub fn now_unix() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }

    pub fn now_iso8601() -> String {
        iso8601_from_unix(now_unix())
    }

    pub fn iso8601_from_unix(secs: u64) -> String {
        let days = (secs / 86_400) as i64;
        let rem = secs % 86_400;
        let (y, m, d) = civil_from_days(days);
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
            y,
            m,
            d,
            rem / 3600,
            (rem % 3600) / 60,
            rem % 60
        )
    }

    fn civil_from_days(z: i64) -> (i64, u32, u32) {
        let z = z + 719_468;
        let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
        let doe = (z - era * 146_097) as u64;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let y = yoe as i64 + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
        let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
        (if m <= 2 { y + 1 } else { y }, m, d)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn formats_known_instants() {
            assert_eq!(iso8601_from_unix(0), "1970-01-01T00:00:00Z");
            assert_eq!(iso8601_from_unix(1_000_000_000), "2001-09-09T01:46:40Z");
            assert_eq!(iso8601_from_unix(1_793_577_600), "2026-11-02T00:00:00Z");
        }

        #[test]
        fn handles_leap_day() {
            // 2024-02-29T12:00:00Z
            assert_eq!(iso8601_from_unix(1_709_208_000), "2024-02-29T12:00:00Z");
        }
    }
}
/// 常见错误码常量。集中定义，避免各处手写字面量漂移。
pub mod codes {
    pub const CFG_INVALID_TOML: &str = "CFG_INVALID_TOML";
    pub const CFG_UNKNOWN_FIELD: &str = "CFG_UNKNOWN_FIELD";
    pub const CFG_VERSION_TOO_NEW: &str = "CFG_VERSION_TOO_NEW";

    pub const CRY_BAD_PASSWORD: &str = "CRY_BAD_PASSWORD";
    pub const CRY_VAULT_CORRUPT: &str = "CRY_VAULT_CORRUPT";
    pub const CRY_WEAK_PASSWORD: &str = "CRY_WEAK_PASSWORD";
    pub const CRY_UNSUPPORTED_VERSION: &str = "CRY_UNSUPPORTED_VERSION";

    pub const SSH_AUTH_FAILED: &str = "SSH_AUTH_FAILED";
    /// ssh-agent 不可用（没在跑、没设 SSH_AUTH_SOCK、管道连不上）
    pub const SSH_AGENT_UNAVAILABLE: &str = "SSH_AGENT_UNAVAILABLE";
    pub const SSH_HOSTKEY_CHANGED: &str = "SSH_HOSTKEY_CHANGED";
    pub const SSH_HOSTKEY_UNKNOWN: &str = "SSH_HOSTKEY_UNKNOWN";
    pub const SSH_NO_COMMON_KEX: &str = "SSH_NO_COMMON_KEX";
    pub const SSH_FORWARD_DENIED: &str = "SSH_FORWARD_DENIED";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_kind_inferred_from_code_prefix() {
        assert_eq!(WtError::new("CFG_INVALID_TOML").kind, ErrorKind::Config);
        assert_eq!(WtError::new("CRY_BAD_PASSWORD").kind, ErrorKind::Auth);
        assert_eq!(WtError::new("SSH_AUTH_FAILED").kind, ErrorKind::Protocol);
        assert_eq!(WtError::new("TUN_PORT_IN_USE").kind, ErrorKind::Network);
        assert_eq!(WtError::new("RDP_NLA_REQUIRED").kind, ErrorKind::Protocol);
        // 未知前缀落到 Internal，避免静默归类错误
        assert_eq!(WtError::new("WHATEVER").kind, ErrorKind::Internal);
    }

    #[test]
    fn with_kind_overrides_inference() {
        let e = WtError::new("NET_TIMEOUT").with_kind(ErrorKind::Network);
        assert_eq!(e.kind, ErrorKind::Network);
    }

    #[test]
    fn builder_keeps_all_parts() {
        let e = WtError::new("SSH_NO_COMMON_KEX")
            .message("无法与服务端协商密钥交换算法")
            .detail("服务端支持：diffie-hellman-group14-sha1")
            .hint("开启兼容模式", HintAction::ApplyFix { fix: "ssh.compat".into() })
            .note("兼容模式会启用 SHA-1 类算法");

        assert_eq!(e.code, "SSH_NO_COMMON_KEX");
        assert_eq!(e.message, "无法与服务端协商密钥交换算法");
        assert!(e.detail.as_deref().unwrap().contains("group14-sha1"));
        assert_eq!(e.hints.len(), 2);
        assert_eq!(e.hints[0].action, HintAction::ApplyFix { fix: "ssh.compat".into() });
        assert_eq!(e.hints[1].action, HintAction::None);
    }

    #[test]
    fn display_contains_code_and_message() {
        let e = WtError::new("SSH_AUTH_FAILED").message("认证失败");
        let s = e.to_string();
        assert!(s.contains("SSH_AUTH_FAILED"));
        assert!(s.contains("认证失败"));
    }

    #[test]
    fn actionable_kinds() {
        assert!(ErrorKind::Network.is_actionable());
        assert!(ErrorKind::Auth.is_actionable());
        assert!(!ErrorKind::Internal.is_actionable());
        assert!(!ErrorKind::Canceled.is_actionable());
    }

    #[test]
    fn serde_roundtrip() {
        let e = WtError::new("TUN_PORT_IN_USE")
            .message("端口 13306 已被占用")
            .hint("改用随机端口", HintAction::ApplyFix { fix: "tunnel.random-port".into() });
        let j = serde_json::to_string(&e).unwrap();
        let back: WtError = serde_json::from_str(&j).unwrap();
        assert_eq!(e, back);
    }

    #[test]
    fn error_codes_are_uppercase_with_prefix() {
        for c in [
            codes::CFG_INVALID_TOML,
            codes::CRY_BAD_PASSWORD,
            codes::SSH_HOSTKEY_CHANGED,
        ] {
            assert!(c.chars().all(|ch| ch.is_ascii_uppercase() || ch == '_'));
            assert!(c.contains('_'));
        }
    }
}
