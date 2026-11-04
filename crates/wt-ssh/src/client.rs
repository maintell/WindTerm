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
///
/// `Clone` 是给多跳用的（`SES-025`）：每一跳都要各自校验一次，而策略是值语义，
/// 复制一份不会让两跳共享状态。
#[derive(Clone)]
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

/// 远程转发表（`-R`）。
pub(crate) type Forwards = Arc<Mutex<std::collections::HashMap<(String, u16), ForwardSlot>>>;

/// 一条远程转发（`-R`）的落地目标：服务端把新连接转过来时，连到这里的本地目标。
#[derive(Clone)]
pub(crate) struct ForwardSlot {
    pub local_host: String,
    pub local_port: u16,
    pub counters: std::sync::Arc<crate::forward::Counters>,
}

struct ClientHandler {
    host_id: HostKeyId,
    policy: Arc<Mutex<HostKeyPolicy>>,
    observed: Arc<Mutex<Option<ObservedHostKey>>>,
    /// 远程转发表：`(远端 host, 端口) → 本地目标`。
    ///
    /// 必须挂在 handler 上：`forwarded-tcpip` 通道是由 handler 回调收到的，
    /// 那时只有它知道该把数据送到哪里。
    forwards: Arc<Mutex<std::collections::HashMap<(String, u16), ForwardSlot>>>,
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

    /// `-R` 的数据面：服务端把新连接转过来，我们连本地目标再双向搬运。
    ///
    /// 这里必须**先连本地目标再 accept**：反过来的话，客户端已经收到
    /// 「转发成功」而我们连不上本地，那条连接会挂在那里直到超时。
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<russh::client::Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: russh::ChannelOpenHandleInner<russh::client::Msg>,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        let slot = self
            .forwards
            .lock()
            .unwrap()
            .get(&(connected_address.to_string(), connected_port as u16))
            .cloned();
        let Some(slot) = slot else {
            // 没有登记的转发：拒绝，别让对端以为连上了
            reply.reject(russh::ChannelOpenFailure::ConnectFailed).await;
            return Ok(());
        };

        slot.counters.inc_total();
        slot.counters.inc_active();
        let counts = slot.counters.clone();
        match tokio::net::TcpStream::connect((slot.local_host.as_str(), slot.local_port)).await {
            Ok(mut tcp) => {
                reply.accept().await;
                let mut stream = channel.into_stream();
                tokio::spawn(async move {
                    match tokio::io::copy_bidirectional(&mut tcp, &mut stream).await {
                        Ok((up, down)) => {
                            counts.add_bytes(up, down);
                            counts.clear_error();
                        }
                        Err(e) => counts.record_error(&format!("远程转发数据流中断：{e}")),
                    }
                    counts.dec_active();
                });
            }
            Err(e) => {
                counts.record_error(&format!(
                    "无法连接到本地目标 {}:{}：{e}",
                    slot.local_host, slot.local_port
                ));
                counts.dec_active();
                reply.reject(russh::ChannelOpenFailure::ConnectFailed).await;
            }
        }
        Ok(())
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
    /// 与 handler 共享的远程转发表（`-R`）
    forwards: Arc<Mutex<std::collections::HashMap<(String, u16), ForwardSlot>>>,
}

/// 一条既能读也能写的承载流。
///
/// 直连时用不到（`establish` 自己建 TCP），跳板机、将来的代理都需要
/// 「先有一条通道，再在上面跑 SSH 握手」这件事，所以统一成这个形状。
pub trait TunnelStream: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send> TunnelStream for T {}

/// 认证方式。
///
/// 抽出来是为了让「直连」与「经跳板」共用同一段认证代码：跳板机与目标机的
/// 认证方式可以不同（`SES-024` 行为规格第 4 条：凭据不继承），
/// 但两边都得支持密码/密钥/agent 三种。
pub enum Auth<'a> {
    Password(&'a str),
    Key(&'a PrivateKeySource),
    Agent,
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
            Forwards,
        ),
        WtError,
    > {
        let host_id = cfg.endpoint();
        let observed = Arc::new(Mutex::new(None));
        let forwards: Forwards = Arc::new(Mutex::new(std::collections::HashMap::new()));

        let handler = ClientHandler {
            host_id: host_id.clone(),
            policy: Arc::new(Mutex::new(policy)),
            observed: observed.clone(),
            forwards: forwards.clone(),
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

        let handle = resolve_established(connect_result, &host_id, &observed, &addr, timeout)?;

        Ok((handle, host_id, observed, forwards))
    }

    /// 与 `establish` 相同，但跑在一条**已经打开的承载流**上（`SES-024` 跳板机）。
    ///
    /// 承载流由跳板机的 `direct-tcpip` 通道提供，因此这条连接对目标机来说
    /// 就是一次普通的 TCP 连接——`ss` 上看到的是跳板机主动外连。
    async fn establish_over<S>(
        cfg: &SshConfig,
        policy: HostKeyPolicy,
        stream: S,
    ) -> Result<
        (
            client::Handle<ClientHandler>,
            HostKeyId,
            Arc<Mutex<Option<ObservedHostKey>>>,
            Forwards,
        ),
        WtError,
    >
    where
        S: TunnelStream + 'static,
    {
        let host_id = cfg.endpoint();
        let observed = Arc::new(Mutex::new(None));
        let forwards: Forwards = Arc::new(Mutex::new(std::collections::HashMap::new()));

        let handler = ClientHandler {
            host_id: host_id.clone(),
            policy: Arc::new(Mutex::new(policy)),
            observed: observed.clone(),
            forwards: forwards.clone(),
        };
        let config = Arc::new(client::Config::default());

        let addr = format!("{}:{}", cfg.host, cfg.port);
        let timeout = Duration::from_secs(cfg.connect_timeout_secs.max(1) as u64);
        let connect_result = tokio::time::timeout(timeout, async {
            client::connect_stream(config, stream, handler).await
        })
        .await;

        let handle = resolve_established(connect_result, &host_id, &observed, &addr, timeout)?;
        Ok((handle, host_id, observed, forwards))
    }

    /// 用密码建立连接。
    ///
    /// 失败时会区分「主机密钥不可信」与「认证失败」——这两类问题用户的处理方式完全不同。
    pub async fn connect_password(
        cfg: &SshConfig,
        password: &str,
        policy: HostKeyPolicy,
    ) -> Result<Self, WtError> {
        Self::connect(cfg, &Auth::Password(password), policy).await
    }

    /// 直连并按给定方式认证。
    pub async fn connect(
        cfg: &SshConfig,
        auth: &Auth<'_>,
        policy: HostKeyPolicy,
    ) -> Result<Self, WtError> {
        let (mut handle, host_id, observed, forwards) = Self::establish(cfg, policy).await?;
        Self::authenticate(&mut handle, cfg, auth).await?;
        Ok(Self {
            handle,
            host_id,
            observed,
            forwards,
        })
    }

    /// **经一条已有承载流**建立连接（`SES-024` 跳板机单跳的数据面）。
    ///
    /// 承载流通常来自跳板机的 `direct-tcpip` 通道。对目标机来说这就是一次
    /// 普通的 TCP 连接，因此除了「谁在连」之外没有任何差异。
    pub async fn connect_over<S>(
        stream: S,
        cfg: &SshConfig,
        auth: &Auth<'_>,
        policy: HostKeyPolicy,
    ) -> Result<Self, WtError>
    where
        S: TunnelStream + 'static,
    {
        let (mut handle, host_id, observed, forwards) =
            Self::establish_over(cfg, policy, stream).await?;
        Self::authenticate(&mut handle, cfg, auth).await?;
        Ok(Self {
            handle,
            host_id,
            observed,
            forwards,
        })
    }

    /// 三种认证方式的**唯一实现**。
    ///
    /// 直连与经跳板都必须走这里：认证失败的错误文案要是两套，
    /// 用户看到同一个问题会有两种说法，排查时容易以为是两回事。
    async fn authenticate(
        handle: &mut client::Handle<ClientHandler>,
        cfg: &SshConfig,
        auth: &Auth<'_>,
    ) -> Result<(), WtError> {
        let addr = format!("{}:{}", cfg.host, cfg.port);
        match auth {
            Auth::Password(password) => {
                match handle.authenticate_password(&cfg.user, *password).await {
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
            }
            Auth::Key(key) => {
                let parsed = keys::parse(key)?;
                let fingerprint = parsed
                    .fingerprint(russh::keys::HashAlg::Sha256)
                    .to_string();
                let auth_key = keys::to_auth_key(parsed);
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
            }
            Auth::Agent => {
                #[cfg(unix)]
                let mut agent = russh::keys::agent::client::AgentClient::connect_env()
                    .await
                    .map_err(|e| agent_unavailable(&e.to_string()))?;
                #[cfg(windows)]
                let mut agent =
                    russh::keys::agent::client::AgentClient::connect_named_pipe(
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
                    if let Ok(russh::client::AuthResult::Success) = handle
                        .authenticate_publickey_with(&cfg.user, key, None, &mut agent)
                        .await
                    {
                        return Ok(());
                    }
                    // 这把不被接受就换下一把——agent 里通常有多把
                }

                return Err(WtError::new(codes::SSH_AUTH_FAILED)
                    .message("ssh-agent 里的身份都被服务端拒绝了")
                    .detail(format!("尝试了 {} 把公钥", identities.len()))
                    .hint(
                        "确认 agent 里的公钥已加到远端的 authorized_keys",
                        HintAction::None,
                    ));
            }
        }
        Ok(())
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
        Self::connect(cfg, &Auth::Key(key), policy).await
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
    pub async fn connect_agent(cfg: &SshConfig, policy: HostKeyPolicy) -> Result<Self, WtError> {
        Self::connect(cfg, &Auth::Agent, policy).await
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
            // 只做密钥交换，不收转发
            forwards: Arc::new(Mutex::new(std::collections::HashMap::new())),
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

    /// 打开 `direct-tcpip` 通道，**原样返回 russh 的错误**。
    ///
    /// 上层对失败的解释不一样：隧道关心「目标不可达」，跳板机关心
    /// 「是不是 sshd 禁止了转发」（`SES-024` 异常表）。所以分类交给调用方，
    /// 这里不做映射——被映射成字符串的错误就再也分不出来了。
    pub(crate) async fn open_direct_tcpip_channel(
        &self,
        target_host: &str,
        target_port: u16,
        originator_address: &str,
        originator_port: u16,
    ) -> Result<russh::ChannelStream<russh::client::Msg>, russh::Error> {
        let channel = self
            .handle
            .channel_open_direct_tcpip(
                target_host,
                u32::from(target_port),
                originator_address,
                u32::from(originator_port),
            )
            .await?;
        Ok(channel.into_stream())
    }

    /// 建立一条远程转发（`-R`，`NET-002`）。
    ///
    /// **服务端**监听 `remote_host:remote_port`；有连接进来时由服务端开一条
    /// `forwarded-tcpip` 通道给我们，我们再连本地目标。返回服务端实际绑定的端口
    /// （请求 0 时由它分配）。
    ///
    /// 注意登记顺序：先让服务端开始监听、再登记本地目标。反过来会在失败时
    /// 留下一批「指向不存在的转发」的脏条目。
    pub(crate) async fn remote_forward(
        &self,
        remote_host: &str,
        remote_port: u16,
        local_host: &str,
        local_port: u16,
        counters: std::sync::Arc<crate::forward::Counters>,
    ) -> Result<u16, WtError> {
        let bound = self
            .handle
            .tcpip_forward(remote_host, u32::from(remote_port))
            .await
            .map_err(|e| {
                WtError::new(codes::TUN_CHANNEL_FAILED)
                    .message(format!("服务端拒绝在 {remote_host}:{remote_port} 上监听"))
                    .detail(e.to_string())
                    .hint(
                        "确认 sshd 允许 AllowTcpForwarding / GatewayPorts，且该端口在服务器上没被占用",
                        HintAction::None,
                    )
            })?;
        let port = u16::try_from(bound).unwrap_or(remote_port);
        self.forwards.lock().unwrap().insert(
            (remote_host.to_string(), port),
            ForwardSlot {
                local_host: local_host.to_string(),
                local_port,
                counters,
            },
        );
        Ok(port)
    }

    /// 取消一条远程转发：服务端会停止监听，表里的落地目标也一并删掉。
    pub(crate) async fn cancel_remote_forward(&self, remote_host: &str, remote_port: u16) {
        let _ = self
            .handle
            .cancel_tcpip_forward(remote_host, u32::from(remote_port))
            .await;
        self.forwards
            .lock()
            .unwrap()
            .remove(&(remote_host.to_string(), remote_port));
    }

    /// 打开一个 `direct-tcpip` 通道（`NET-001` 本地转发的数据面）。
    ///
    /// `target_host` 由**服务端**解析——这正是转发的价值：本地解析不到、也连不上的
    /// 地址，在服务器侧往往是通的。所以这里传过去的是主机名而不是解析后的 IP。
    ///
    /// 返回的流既是读也是写，直接与本地 socket 双向对接（见 `crate::forward`）。
    pub(crate) async fn open_direct_tcpip(
        &self,
        target_host: &str,
        target_port: u16,
        originator_address: &str,
        originator_port: u16,
    ) -> Result<russh::ChannelStream<russh::client::Msg>, WtError> {
        self.open_direct_tcpip_channel(
            target_host,
            target_port,
            originator_address,
            originator_port,
        )
        .await
        .map_err(|e| {
            WtError::new(codes::TUN_CHANNEL_FAILED)
                .message(format!("无法为 {target_host}:{target_port} 打开转发通道"))
                .detail(e.to_string())
                .hint(
                    "目标主机名由**服务器侧**解析；确认服务器能访问该地址，\
                     且 sshd 没有关闭 AllowTcpForwarding",
                    HintAction::None,
                )
        })
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

/// 统一的「建传输层」结果处理。
///
/// 直连（`client::connect`）与经跳板（`client::connect_stream`）的失败分类
/// 必须一致，否则同一台机器「直连报 A、经跳板报 B」，排查时会被带偏。
fn resolve_established(
    result: Result<Result<client::Handle<ClientHandler>, russh::Error>, tokio::time::error::Elapsed>,
    host_id: &HostKeyId,
    observed: &Arc<Mutex<Option<ObservedHostKey>>>,
    addr: &str,
    timeout: Duration,
) -> Result<client::Handle<ClientHandler>, WtError> {
    match result {
        Ok(Ok(h)) => Ok(h),
        Ok(Err(e)) => Err(map_connect_error(e, host_id, observed)),
        Err(_) => Err(WtError::new("SSH_CONNECT_TIMEOUT")
            .message(format!("连接 {} 超时（{} 秒）", addr, timeout.as_secs()))
            .detail("TCP 连接或密钥交换未在超时内完成")
            .hint("检查网络与防火墙", HintAction::None)
            .hint(
                "增大超时",
                HintAction::OpenSettings {
                    page: "session.network".into(),
                },
            )),
    }
}

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
