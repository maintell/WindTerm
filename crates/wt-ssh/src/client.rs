//! SSH 客户端封装。
//!
//! 设计依据：`docs/design/05-ssh-stack.md` §1、§2、§7。
//!
//! **对外不暴露 `russh` 类型**：上层只看到 [`SshConnection`]，将来换实现不影响调用方。
//!
//! 主机密钥校验在这里做（而不是在 UI 层）：它必须在密钥交换完成、认证开始之前决定，
//! 否则就是把凭据发给了未经确认的服务器。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client;
use russh::ChannelMsg;
use wt_common::{codes, HintAction, WtError};

use crate::keys::{self, PrivateKeySource};
use crate::known_hosts::{fingerprint_sha256, CheckOutcome, HostKeyId, KnownHosts};
use crate::SshConfig;

// ─────────────────────────────────────────────────────────────
// 主机密钥策略
// ─────────────────────────────────────────────────────────────

/// 主机密钥策略。
pub enum HostKeyPolicy {
    /// 接受任何密钥（仅用于测试与用户显式选择「本次信任」）。
    AcceptAll,
    /// 按 `known_hosts` 校验。未知主机被拒绝，指纹通过 [`HostKeyVerdict`] 回传给上层做 TOFU 确认。
    Known(Box<KnownHosts>),
}

/// 校验结果，供上层决定下一步（弹 TOFU 对话框 / 阻断）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyVerdict {
    Trusted,
    Unknown {
        key_type: String,
        fingerprint: String,
    },
    Changed {
        key_type: String,
        new_fingerprint: String,
        known_fingerprints: Vec<String>,
    },
    Revoked {
        key_type: String,
        fingerprint: String,
    },
}

/// 一次连接中观察到的服务端主机密钥。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservedHostKey {
    pub key_type: String,
    /// `SHA256:...`（OpenSSH 风格，无 base64 填充）
    pub fingerprint: String,
    /// 公钥原始 blob（写入 known_hosts 用）
    pub blob: Vec<u8>,
}

struct ClientHandler {
    host_id: HostKeyId,
    policy: Arc<Mutex<HostKeyPolicy>>,
    observed: Arc<Mutex<Option<ObservedHostKey>>>,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // 我们默认不advertise 主机证书算法，所以服务端不该发证书。
        // 真发了就拒绝——这比「假装支持」安全。
        let key = match server_public_key {
            russh::keys::PublicKeyOrCertificate::PublicKey { key, .. } => key,
            russh::keys::PublicKeyOrCertificate::Certificate(_) => return Ok(false),
        };

        let key_type = key.algorithm().as_str().to_string();
        let blob = match key.to_bytes() {
            Ok(b) => b,
            Err(_) => return Ok(false),
        };
        let fingerprint = fingerprint_sha256(&blob);

        *self.observed.lock().unwrap() = Some(ObservedHostKey {
            key_type: key_type.clone(),
            blob: blob.clone(),
            fingerprint,
        });

        let policy = self.policy.lock().unwrap();
        let ok = match &*policy {
            HostKeyPolicy::AcceptAll => true,
            HostKeyPolicy::Known(kh) => {
                matches!(
                    kh.check(&self.host_id, &key_type, &blob),
                    CheckOutcome::Match
                )
            }
        };
        Ok(ok)
    }
}

// ─────────────────────────────────────────────────────────────
// 连接
// ─────────────────────────────────────────────────────────────

/// 一条已认证的 SSH 连接。
pub struct SshConnection {
    handle: client::Handle<ClientHandler>,
    host_id: HostKeyId,
    observed: Arc<Mutex<Option<ObservedHostKey>>>,
}

impl SshConnection {
    /// 建立传输层并完成主机密钥校验，但**不认证**。
    ///
    /// 拆出来的原因：密码与公钥两条路径的前半段完全相同，
    /// 复制一遍会导致「改了一处忘了另一处」——这类 bug 通常只在某一种认证方式下出现。
    async fn establish(
        cfg: &SshConfig,
        policy: HostKeyPolicy,
    ) -> Result<
        (
            client::Handle<ClientHandler>,
            HostKeyId,
            Arc<Mutex<Option<ObservedHostKey>>>,
        ),
        WtError,
    > {
        let host_id = cfg.endpoint();
        let observed = Arc::new(Mutex::new(None));

        let handler = ClientHandler {
            host_id: host_id.clone(),
            policy: Arc::new(Mutex::new(policy)),
            observed: observed.clone(),
        };

        // 算法偏好：使用 russh 默认集。
        //
        // 【待实现】`Algos` / `CompatFlags` 目前只用于 UI 展示与诊断文案，
        // 尚未映射到 `russh::Preferred`——因为 `russh::kex::Name` 等是枚举，
        // 没有 `From<&str>`，需要逐项手写映射表。russh 的默认集本身已是现代算法
        // （curve25519 / chacha20 / ed25519，不含 ssh-rsa 与 CBC），
        // 因此默认路径是安全的；缺口只在「连老服务器时需要开启弱算法」这一项（SES-001 AC-2）。
        let config = Arc::new(client::Config::default());

        let addr = format!("{}:{}", cfg.host, cfg.port);
        let timeout = Duration::from_secs(cfg.connect_timeout_secs.max(1) as u64);
        let connect_result = tokio::time::timeout(timeout, async {
            client::connect(config, addr.as_str(), handler).await
        })
        .await;

        let handle = match connect_result {
            Ok(Ok(h)) => h,
            Ok(Err(e)) => return Err(map_connect_error(e, &host_id, &observed)),
            Err(_) => {
                return Err(WtError::new("SSH_CONNECT_TIMEOUT")
                    .message(format!("连接 {} 超时（{} 秒）", addr, timeout.as_secs()))
                    .detail("TCP 连接或密钥交换未在超时内完成")
                    .hint("检查网络与防火墙", HintAction::None)
                    .hint(
                        "增大超时",
                        HintAction::OpenSettings {
                            page: "session.network".into(),
                        },
                    ));
            }
        };

        Ok((handle, host_id, observed))
    }

    /// 用密码建立连接。
    ///
    /// 失败时会区分「主机密钥不可信」与「认证失败」——这两类问题用户的处理方式完全不同。
    pub async fn connect_password(
        cfg: &SshConfig,
        password: &str,
        policy: HostKeyPolicy,
    ) -> Result<Self, WtError> {
        let (mut handle, host_id, observed) = Self::establish(cfg, policy).await?;
        let addr = format!("{}:{}", cfg.host, cfg.port);

        match handle.authenticate_password(&cfg.user, password).await {
            Ok(russh::client::AuthResult::Success) => {}
            Ok(_) => {
                return Err(WtError::new(codes::SSH_AUTH_FAILED)
                    .message("密码认证被服务端拒绝")
                    .detail(format!("用户 {} 在 {} 上认证失败", cfg.user, addr))
                    .hint("确认用户名与密码", HintAction::None)
                    .hint(
                        "编辑会话凭据",
                        HintAction::OpenSettings {
                            page: "session.auth".into(),
                        },
                    ));
            }
            Err(e) => {
                return Err(WtError::new(codes::SSH_AUTH_FAILED)
                    .message("认证过程出错")
                    .detail(e.to_string()));
            }
        }

        Ok(Self {
            handle,
            host_id,
            observed,
        })
    }

    /// 用私钥建立连接。
    ///
    /// 私钥解析失败（格式不对、缺口令、口令错）会在建连之前就报错——
    /// 不要先连上再发现密钥有问题，那样用户会以为「网络不稳定」。
    pub async fn connect_publickey(
        cfg: &SshConfig,
        key: &PrivateKeySource,
        policy: HostKeyPolicy,
    ) -> Result<Self, WtError> {
        let parsed = keys::parse(key)?;
        let fingerprint = parsed
            .fingerprint(russh::keys::HashAlg::Sha256)
            .to_string();
        let auth_key = keys::to_auth_key(parsed);

        let (mut handle, host_id, observed) = Self::establish(cfg, policy).await?;
        let addr = format!("{}:{}", cfg.host, cfg.port);

        match handle.authenticate_publickey(&cfg.user, auth_key).await {
            Ok(russh::client::AuthResult::Success) => {}
            Ok(_) => {
                return Err(WtError::new(codes::SSH_AUTH_FAILED)
                    .message("服务端拒绝了这把密钥")
                    .detail(format!(
                        "用户 {} 在 {} 上使用密钥 {fingerprint} 认证失败",
                        cfg.user, addr
                    ))
                    .hint("确认公钥已加入服务端 authorized_keys", HintAction::None)
                    .hint(
                        "换一把密钥",
                        HintAction::OpenSettings {
                            page: "session.auth".into(),
                        },
                    ));
            }
            Err(e) => {
                return Err(WtError::new(codes::SSH_AUTH_FAILED)
                    .message("公钥认证过程出错")
                    .detail(e.to_string()));
            }
        }

        Ok(Self {
            handle,
            host_id,
            observed,
        })
    }
    /// 用 ssh-agent 里的身份建立连接。
    ///
    /// 逐个尝试 agent 持有的公钥，第一个被服务端接受的即为本次使用的身份。
    /// 私钥始终留在 agent 里——我们只发公钥、由 agent 签名，这正是用 agent 的意义。
    ///
    /// agent 的位置按平台取：
    /// - Unix：`SSH_AUTH_SOCK`；
    /// - Windows：OpenSSH Authentication Agent 的命名管道（Win10 1809 自带）。
    ///
    /// Pageant 暂不支持（需要额外依赖），见 README 的 G3。
    pub async fn connect_agent(
        cfg: &SshConfig,
        policy: HostKeyPolicy,
    ) -> Result<Self, WtError> {
        let (mut handle, host_id, observed) = Self::establish(cfg, policy).await?;

        #[cfg(unix)]
        let mut agent = russh::keys::agent::client::AgentClient::connect_env()
            .await
            .map_err(|e| agent_unavailable(&e.to_string()))?;
        #[cfg(windows)]
        let mut agent = russh::keys::agent::client::AgentClient::connect_named_pipe(
            r"\\.\pipe\openssh-ssh-agent",
        )
        .await
        .map_err(|e| agent_unavailable(&e.to_string()))?;

        let identities = agent
            .request_identities()
            .await
            .map_err(|e| agent_unavailable(&format!("无法读取 agent 里的身份：{e}")))?;
        if identities.is_empty() {
            return Err(WtError::new(codes::SSH_AGENT_UNAVAILABLE)
                .message("ssh-agent 里没有任何身份")
                .hint("先用 ssh-add 添加私钥", HintAction::None));
        }

        for id in &identities {
            let key = id.public_key().as_ref().clone();
            match handle
                .authenticate_publickey_with(&cfg.user, key, None, &mut agent)
                .await
            {
                Ok(russh::client::AuthResult::Success) => {
                    return Ok(Self {
                        handle,
                        host_id,
                        observed,
                    });
                }
                // 这把不被接受就换下一把——agent 里通常有多把
                _ => continue,
            }
        }

        Err(WtError::new(codes::SSH_AUTH_FAILED)
            .message("ssh-agent 里的身份都被服务端拒绝了")
            .detail(format!("尝试了 {} 把公钥", identities.len()))
            .hint(
                "确认 agent 里的公钥已加到远端的 authorized_keys",
                HintAction::None,
            ))
    }

    pub fn host_id(&self) -> &HostKeyId {
        &self.host_id
    }

    /// 本次连接实际使用的主机密钥指纹（用于展示与审计）。
    pub fn server_fingerprint(&self) -> Option<String> {
        self.observed
            .lock()
            .unwrap()
            .as_ref()
            .map(|k| k.fingerprint.clone())
    }

    /// 打开一个带 PTY 的交互式 shell 通道。
    pub async fn open_shell(
        &self,
        term: &str,
        cols: u32,
        rows: u32,
    ) -> Result<SshChannel, WtError> {
        let channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(map_channel_error)?;

        channel
            .request_pty(false, term, cols, rows, 0, 0, &[])
            .await
            .map_err(map_channel_error)?;
        channel.request_shell(false).await.map_err(map_channel_error)?;

        Ok(SshChannel { inner: channel })
    }

    /// 执行一条命令并收集输出（用于 `wt exec` 与诊断）。
    pub async fn exec(&self, command: &str) -> Result<ExecOutput, WtError> {
        let mut channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(map_channel_error)?;

        channel
            .exec(true, command)
            .await
            .map_err(map_channel_error)?;

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_code = None;

        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, ext: 1 } => {
                    stderr.extend_from_slice(&data)
                }
                ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }

        Ok(ExecOutput {
            stdout,
            stderr,
            exit_code,
        })
    }

    /// 用户确认指纹后，把本次观察到的密钥写入 `known_hosts`。
    ///
    /// 这是 TOFU 流程的闭环：先连（被拒）→ 拿到指纹 → 用户确认 → 写入 → 重连成功。
    pub fn trust_observed_key(
        &self,
        known: &mut KnownHosts,
        hashed: bool,
    ) -> Result<(), WtError> {
        let observed = self.observed.lock().unwrap().clone().ok_or_else(|| {
            WtError::new("SSH_NO_OBSERVED_KEY")
                .message("尚未获得服务端主机密钥，无法保存")
                .detail("请在密钥交换完成后调用")
        })?;
        known.add(&self.host_id, &observed.key_type, &observed.blob, hashed);
        Ok(())
    }

    /// 只做密钥交换、拿到主机密钥就断开。
    ///
    /// TOFU 流程需要它：用户在看到指纹之前无法决定是否信任，而带 `Known` 策略的连接会直接失败。
    /// 用法：`probe_host_key` → 展示指纹 → 用户确认 → `KnownHosts::add` → 用 `Known` 策略正式连接。
    pub async fn probe_host_key(cfg: &SshConfig) -> Result<ObservedHostKey, WtError> {
        let host_id = cfg.endpoint();
        let observed = Arc::new(Mutex::new(None));
        let handler = ClientHandler {
            host_id: host_id.clone(),
            policy: Arc::new(Mutex::new(HostKeyPolicy::AcceptAll)),
            observed: observed.clone(),
        };

        let addr = format!("{}:{}", cfg.host, cfg.port);
        let timeout = Duration::from_secs(cfg.connect_timeout_secs.max(1) as u64);
        let result = tokio::time::timeout(timeout, async {
            client::connect(Arc::new(client::Config::default()), addr.as_str(), handler).await
        })
        .await;

        match result {
            Ok(Ok(handle)) => {
                let key = observed.lock().unwrap().clone();
                let _ = handle
                    .disconnect(russh::Disconnect::ByApplication, "", "en")
                    .await;
                key.ok_or_else(|| {
                    WtError::new("SSH_NO_OBSERVED_KEY")
                        .message("服务端未提供主机密钥")
                        .detail(format!("{addr} 的密钥交换未返回公钥"))
                })
            }
            Ok(Err(e)) => Err(map_connect_error(e, &host_id, &observed)),
            Err(_) => Err(WtError::new("SSH_CONNECT_TIMEOUT")
                .message(format!("探测 {addr} 的主机密钥超时"))
                .hint("检查网络与防火墙", HintAction::None)),
        }
    }

    /// 本次连接观察到的密钥。
    pub fn observed_key(&self) -> Option<ObservedHostKey> {
        self.observed.lock().unwrap().clone()
    }

    pub async fn disconnect(&self) {
        let _ = self
            .handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
    }

    /// 打开一个子系统通道（目前只有 `sftp` 用）。
    ///
    /// 返回的是 `AsyncRead + AsyncWrite` 的流，交给上层协议实现（`crate::sftp`）。
    /// `russh` 的类型不外泄：这里是 `pub(crate)`。
    pub(crate) async fn open_subsystem(
        &self,
        name: &str,
    ) -> Result<russh::ChannelStream<russh::client::Msg>, WtError> {
        let channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(map_channel_error)?;
        channel
            .request_subsystem(true, name)
            .await
            .map_err(map_channel_error)?;
        Ok(channel.into_stream())
    }

    /// 发一条心跳并**等待回应**，用来判断连接是否还活着。
    ///
    /// 半开连接（对端掉电、NAT 表被清）不会自己报错，只有主动探测才发现。
    /// 这个方法会一直等到回应，调用方必须自己套超时。
    pub async fn probe(&self) -> Result<(), WtError> {
        self.handle.send_ping().await.map_err(|e| {
            WtError::new("SSH_KEEPALIVE_FAILED")
                .message("心跳发送失败，连接可能已断开")
                .detail(e.to_string())
        })
    }

    /// 发一条 keepalive。
    ///
    /// `want_reply = false` 是常见的「保活」用法：只要还能把包发出去，
    /// NAT/防火墙的空闲计时器就被续上了；要检测半开连接则传 `true`。
    pub async fn send_keepalive(&self, want_reply: bool) -> Result<(), WtError> {
        self.handle.send_keepalive(want_reply).await.map_err(|e| {
            WtError::new("SSH_KEEPALIVE_FAILED")
                .message("发送心跳失败，连接可能已断开")
                .detail(e.to_string())
        })
    }
}

/// 一条交互式通道。
pub struct SshChannel {
    inner: russh::Channel<russh::client::Msg>,
}

impl SshChannel {
    /// 写数据（用户键入）。
    pub async fn write(&self, data: &[u8]) -> Result<(), WtError> {
        self.inner.data(data).await.map_err(map_channel_error)
    }

    /// 通知窗口尺寸变化。
    pub async fn resize(&self, cols: u32, rows: u32) -> Result<(), WtError> {
        self.inner
            .window_change(cols, rows, 0, 0)
            .await
            .map_err(map_channel_error)
    }

    /// 读下一条消息。返回 `None` 表示通道关闭。
    pub async fn next(&mut self) -> Option<ChannelData> {
        loop {
            match self.inner.wait().await? {
                ChannelMsg::Data { data } => return Some(ChannelData::Stdout(data.to_vec())),
                ChannelMsg::ExtendedData { data, ext: 1 } => {
                    return Some(ChannelData::Stderr(data.to_vec()))
                }
                ChannelMsg::ExitStatus { exit_status } => {
                    return Some(ChannelData::Exit(exit_status))
                }
                ChannelMsg::Eof | ChannelMsg::Close => return None,
                _ => continue,
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChannelData {
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
    Exit(u32),
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExecOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: Option<u32>,
}

impl ExecOutput {
    pub fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).to_string()
    }

    pub fn stderr_text(&self) -> String {
        String::from_utf8_lossy(&self.stderr).to_string()
    }
}

// ─────────────────────────────────────────────────────────────
// 错误映射
// ─────────────────────────────────────────────────────────────

fn map_connect_error(
    e: russh::Error,
    host_id: &HostKeyId,
    observed: &Arc<Mutex<Option<ObservedHostKey>>>,
) -> WtError {
    let detail = e.to_string();

    // 连接被拒通常发生在主机密钥校验之后：看 observed 有没有值来判断是哪一步
    if let Some(key) = observed.lock().unwrap().clone() {
        return WtError::new(codes::SSH_HOSTKEY_UNKNOWN)
            .message(format!("{} 的主机密钥未受信任", host_id.host))
            .detail(format!(
                "类型 {}，指纹 {}",
                key.key_type, key.fingerprint
            ))
            .hint(
                "确认指纹后接受并保存",
                HintAction::ApplyFix {
                    fix: format!("ssh.trust-host:{}", key.fingerprint),
                },
            )
            .hint("查看该主机的已知指纹", HintAction::None);
    }

    WtError::new("SSH_CONNECT_FAILED")
        .message(format!("无法连接到 {}:{}", host_id.host, host_id.port))
        .detail(detail)
        .hint("检查主机与端口", HintAction::None)
        .hint("运行连接诊断", HintAction::RunCommand("wt diag --last".into()))
}

/// ssh-agent 不可用时的错误。
///
/// 这是**配置/环境问题**，不是协议错误：用户需要知道该去启动什么。
fn agent_unavailable(detail: &str) -> WtError {
    #[cfg(windows)]
    let hint = "启动「OpenSSH Authentication Agent」服务，或用 ssh-add 添加私钥";
    #[cfg(not(windows))]
    let hint = "确认 ssh-agent 在运行且已导出 SSH_AUTH_SOCK";

    WtError::new(codes::SSH_AGENT_UNAVAILABLE)
        .message("连不上 ssh-agent")
        .detail(detail.to_string())
        .hint(hint, HintAction::None)
}

fn map_channel_error(e: russh::Error) -> WtError {    WtError::new("SSH_CHANNEL_FAILED")
        .message("SSH 通道操作失败")
        .detail(e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exec_output_text_helpers() {
        let o = ExecOutput {
            stdout: b"hello\n".to_vec(),
            stderr: b"oops".to_vec(),
            exit_code: Some(2),
        };
        assert_eq!(o.stdout_text(), "hello\n");
        assert_eq!(o.stderr_text(), "oops");
        assert_eq!(o.exit_code, Some(2));
    }

    #[test]
    fn connect_error_without_observed_key_is_plain_failure() {
        let observed = Arc::new(Mutex::new(None));
        let err = map_connect_error(
            russh::Error::NotAuthenticated,
            &HostKeyId::new("10.0.1.11", 22),
            &observed,
        );
        assert_eq!(err.code, "SSH_CONNECT_FAILED");
        assert!(err.message.contains("10.0.1.11:22"));
    }

    #[test]
    fn connect_error_after_key_exchange_points_at_host_key() {
        let observed = Arc::new(Mutex::new(Some(ObservedHostKey {
            key_type: "ssh-ed25519".into(),
            blob: b"blob".to_vec(),
            fingerprint: "SHA256:abc".into(),
        })));
        let err = map_connect_error(
            russh::Error::NotAuthenticated,
            &HostKeyId::new("10.0.1.11", 22),
            &observed,
        );
        assert_eq!(err.code, "SSH_HOSTKEY_UNKNOWN");
        assert!(err.detail.as_ref().unwrap().contains("SHA256:abc"));
        assert!(err.hints.iter().any(|h| h.label.contains("接受并保存")));
    }

    #[test]
    fn channel_data_variants_are_distinguishable() {
        assert_ne!(
            ChannelData::Stdout(b"a".to_vec()),
            ChannelData::Stderr(b"a".to_vec())
        );
        assert_eq!(ChannelData::Exit(0), ChannelData::Exit(0));
    }
}
