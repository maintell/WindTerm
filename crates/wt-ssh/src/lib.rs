//! SSH 协议栈：算法配置、`known_hosts` 校验、指纹。
//!
//! 设计依据：`docs/design/05-ssh-stack.md`。
//!
//! **对外不暴露底层 SSH 库的类型**（`design/01` §3.1）：
//! 上层只看到本模块的类型，将来从 `russh` 换到 `ssh2` 不影响任何调用方。
//!
//! 当前已实现的是「可纯逻辑测试」的部分（算法、主机密钥、指纹）；
//! 真正的连接与通道管理（依赖 `russh`）在后续迭代补上。

#![forbid(unsafe_code)]

pub mod algos;
pub mod client;
pub mod keys;
pub mod term;
#[cfg(feature = "test-util")]
pub mod testing;
pub mod known_hosts;

pub use algos::{diagnose, negotiate, AlgoCategory, Algos, CompatFlags, NegotiationFailure};
pub use client::{
    ChannelData, ExecOutput, HostKeyPolicy, HostKeyVerdict, ObservedHostKey, SshChannel,
    SshConnection,
};
pub use keys::{inspect as inspect_key, KeyInfo, PrivateKeySource};
pub use term::{Keepalive, SshTermSession};
pub use known_hosts::{
    fingerprint_sha256, hash_host, CheckOutcome, HostKeyId, KnownHosts, KnownHostsEntry, Marker,
};

/// SSH 连接参数（与 UI 的会话字段一一对应）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub term_type: String,
    /// keepalive 间隔（秒），0 = 关闭
    pub keepalive_secs: u32,
    /// 连续多少次心跳没有回应就判定连接已断（默认 3）
    pub keepalive_max_missed: u32,
    pub compression: bool,
    /// 兼容开关（弱算法）
    pub compat: CompatFlags,
    /// TCP 连接超时（秒）
    pub connect_timeout_secs: u32,
}

impl Default for SshConfig {
    fn default() -> Self {
        Self {
            host: String::new(),
            port: 22,
            user: String::new(),
            term_type: "xterm-256color".into(),
            keepalive_secs: 30,
            keepalive_max_missed: 3,
            compression: false,
            compat: CompatFlags::default(),
            connect_timeout_secs: 10,
        }
    }
}

impl SshConfig {
    pub fn endpoint(&self) -> HostKeyId {
        HostKeyId::new(self.host.clone(), self.port)
    }

    pub fn algorithms(&self) -> Algos {
        Algos::with_compat(self.compat)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_defaults_are_sane() {
        let c = SshConfig::default();
        assert_eq!(c.port, 22);
        assert_eq!(c.term_type, "xterm-256color");
        assert_eq!(c.keepalive_secs, 30);
        assert!(!c.compression);
        assert_eq!(c.compat, CompatFlags::default());
    }

    #[test]
    fn config_derives_host_key_id_and_algos() {
        let c = SshConfig {
            host: "10.0.1.11".into(),
            port: 2222,
            compat: CompatFlags::all(),
            ..Default::default()
        };
        assert_eq!(c.endpoint().to_pattern(), "[10.0.1.11]:2222");
        assert!(c.algorithms().host_key.contains(&"ssh-rsa"));
    }
}
