# 详细设计 · 10 · 隧道与连接链路

实现需求：`SES-024`~`SES-026`、`NET-001`~`NET-018`
关键约束：`spec/09` §3.4（重连期间保持监听）

## 1. `StreamProvider`：整个连接链路的复用点

所有「需要一条到某主机某端口的 TCP 流」的功能——SSH、RDP、VNC、FTP、隧道目标、端口探测——都通过同一个 trait 获取连接：

```rust
// crates/wt-core/src/stream.rs
#[async_trait]
pub trait StreamProvider: Send + Sync {
    /// 建立到 host:port 的连接
    async fn connect(&self, host: &str, port: u16) -> Result<Box<dyn AsyncStream>, WtError>;

    /// 描述这条链路（用于诊断与 UI 展示）
    fn describe(&self) -> ChainDescription;
}

pub trait AsyncStream: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> AsyncStream for T {}
```

### 1.1 实现矩阵

| 实现 | 场景 | 说明 |
|---|---|---|
| `DirectProvider` | 直连 | `TcpStream::connect` |
| `Socks5Provider` | SOCKS5 代理 | 先连代理，再 `CONNECT` |
| `Socks4Provider` | SOCKS4/4a | |
| `HttpConnectProvider` | HTTP 代理 | `CONNECT host:port HTTP/1.1` |
| `SshDirectTcpipProvider` | 经 SSH（跳板机） | 在已有 SSH 会话上开 `direct-tcpip` |
| `ChainedProvider` | 多跳 | 递归组合 |
| `ProxyCommandProvider` | 外部命令 | stdin/stdout 作为通道 |

### 1.2 链式组合

```rust
pub fn build_chain(session: &Session, ctx: &Context) -> Result<Arc<dyn StreamProvider>> {
    let mut base: Arc<dyn StreamProvider> = match &session.options.proxy {
        None => Arc::new(DirectProvider),
        Some(p) => match p.kind {
            ProxyKind::Socks5 => Arc::new(Socks5Provider::new(p)),
            ProxyKind::Http   => Arc::new(HttpConnectProvider::new(p)),
            // ...
        },
    };

    // 跳板链：从最后一跳往前包
    for jump_id in session.jump_chain.iter().rev() {
        let jump_session = ctx.store.get_session(jump_id)?;
        base = Arc::new(SshDirectTcpipProvider::new(jump_session, base));
    }

    Ok(base)
}
```

**`SshDirectTcpipProvider` 的内部**：先通过 `base` 连接到跳板机的 22 端口，完成 SSH 握手与认证（或复用连接池），然后在上面开 `direct-tcpip`。

**这解释了为什么 `SES-024` 能支持任意目标类型**：RDP 不知道自己在跳板机后面，它只拿到一条流。

### 1.3 链路描述（诊断用）

```rust
pub struct ChainDescription {
    pub hops: Vec<Hop>,
    pub total_latency: Option<Duration>,
}

pub struct Hop {
    pub kind: HopKind,          // Direct | Proxy | SshJump | Tunnel
    pub host: String,
    pub port: u16,
    pub latency: Option<Duration>,
    pub reused: bool,           // 是否复用了已有连接
}
```

UI 渲染为：

```
本地 ──SOCKS5(127.0.0.1:1080)──► ──SSH(bastion:22)──► ──SSH(bastion2:22)──► 10.0.3.44:3389
       12 ms                        340 ms（复用）        28 ms                8 ms
```

## 2. 跳板机

### 2.0 实现状态（M1）

已实现 `wt_ssh::connect_via`（`SES-024` 内核）。与本文设计的差异：

| 设计里有 | 现在 | 影响 |
|---|---|---|
| `StreamProvider` 抽象 + 链式组合（§1） | 直接调 `open_direct_tcpip_channel` + `SshConnection::connect_over` | 单跳够用；多跳（`SES-025`）要么递归包，要么补上 provider 抽象 |
| 递归多跳（最多 5 跳） | ❌ 只支持一跳 | `SES-025` 待做 |
| 连接池复用（§2.1，`SES-024` AC-3） | ❌ 每条目标连接都重新登录跳板机 | 跳板机上会看到多条 SSH 连接；AC-3 未满足 |
| 每跳错误定位（§2.3） | ✅ 错误统一加「第 N 跳（host:port）：」前缀，**保留原错误码** | 换码会让「认证失败」被归成网络问题，界面就分不清该改密码还是改网络 |
| `AllowTcpForwarding no` 专项报错 | ✅ `SSH_FORWARD_DENIED`，消息直接点名原因 | — |
| `jump.sessionId` 落库 | ✅ 已做（存在 `options.jumpSessionId`，保存时环检测 + 最多 5 跳） | 键名只在 `wt_core::Session::set_jump/jump` 一处定义，界面不直接碰 `options` |
| CLI 入口（`--jump`） | ❌ 未做 | 见 `README` 的 `G14` |

认证：`SshConnection::connect` / `connect_over` 共用同一段 `authenticate`，
三条路径（密码 / 密钥 / agent）只有一份实现，直连与经跳板的错误文案因此完全一致。

### 2.1 连接池

```rust
pub struct JumpPool {
    entries: DashMap<PoolKey, Weak<SshSession>>,
}

#[derive(Hash, Eq, PartialEq, Clone)]
pub struct PoolKey {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth_fp: String,          // 认证方式 + 密钥指纹
    pub via: Option<Box<PoolKey>>, // 递归：这一跳又是怎么连的
}
```

**`via` 递归是关键**：同一个跳板机，经不同代理连过去，是不同的池条目。

**复用判定**：`Weak::upgrade()` 成功 + `state == Ready` + 空闲 < 60 s。

### 2.2 环检测

```rust
pub fn validate_chain(sessions: &[Session]) -> Result<()> {
    let mut seen = HashSet::new();
    for s in sessions {
        if !seen.insert(&s.id) {
            return Err(WtError::new("SES_JUMP_CYCLE")
                .message("跳板链存在循环引用")
                .detail(format!("会话 {} 重复出现", s.name)));
        }
    }
    Ok(())
}
```

在**保存时**校验（`SES-024` AC-4），不是连接时。

### 2.3 每跳错误定位

```rust
pub async fn connect_chain(hops: &[Hop], target: (String, u16)) -> Result<Stream> {
    let mut stream: Box<dyn AsyncStream> = DirectProvider.connect(&hops[0].host, hops[0].port).await
        .map_err(|e| e.with_context(format!("第 1 跳（{}:{}）", hops[0].host, hops[0].port)))?;

    for (i, hop) in hops.iter().enumerate().skip(1) {
        stream = ssh_direct_tcpip(stream, hop).await
            .map_err(|e| e.with_context(format!("第 {} 跳（{}:{}）", i + 1, hop.host, hop.port)))?;
    }

    // 最后一跳到目标
    ssh_direct_tcpip(stream, target).await
        .map_err(|e| e.with_context(format!("跳板机到目标（{}:{}）", target.0, target.1)))
}
```

`with_context` 在错误消息前面加上「第 N 跳（host:port）」，满足 `SES-024` AC-2。

## 3. 隧道引擎

### 3.0 实现状态（M1）

已实现 `wt_ssh::forward`，与本文设计的差异要显式记着：

| 设计里有 | 现在 | 影响 |
|---|---|---|
| `TunnelRunner` + `TunnelSpec` + `CancellationToken` | `LocalForward`（`watch::Sender<bool>` 做停止信号） | 少一个 `tokio-util` 依赖；停止语义一致 |
| `stats.last_error` | ✅ 有（`ForwardStats::last_error`，成功转发后清空） | 界面能把「运行中」降级成红点 + 原因（`NET-004` AC-3 的一半） |
| `MAX_PER_TUNNEL` 每隧道连接上限 | ✅ 有（默认 64，超限的连接立刻关闭并单独计入 `rejected`） | 常量而非按隧道配置：`TunnelSpec` 加字段要一次 schema 迁移 |
| `listener` 在重连期间保持（§3.4） | ❌ 未做 | 承载连接断开后监听仍在但每个连接都失败；靠 `last_error` 让用户看得见 |
| `-R`（§3.5）、`-D` SOCKS5（§3.6） | 两者都已实现：`-D` 是 `wt_ssh::socks5` + `start_socks5`（CONNECT-only）；`-R` 是 `start_remote`（`tcpip-forward` + 回调里接 `forwarded-tcpip`） | `-R` 依赖服务端允许 `AllowTcpForwarding`；监听非回环地址还要 `GatewayPorts`；`-D` 支持可选用户名密码认证 |
| 隧道配置落库 | ✅ 已做（`TunnelSpec` + schema v2；界面停止后保留灰灯，可「启动」/「删除」） | 承载会话记在 `viaSessionId`，启动时从保险库取密码 |
| SOCKS5 代理认证（`-D`，`NET-003` AC-3） | ✅ RFC 1929 用户名密码。**带凭据的隧道不落库**，`TunnelDto.persisted = false` 让界面提示「重启后需重填」 | 只对 `dynamic` 有效；给了用户名没给密码直接拒（`TUN_BAD_ARGUMENT`），不猜；落库等于把口令明文存盘 |
| `autoStart` / 重连期保持监听（§3.4） | `autoStart` ✅（保险库解锁后 + 打开隧道面板时触发，与手动启动共用 `start_spec`）；重连未做 | 冷启动即拉起需要交出主密码，属安全取舍，见 `G13` |

### 3.1 结构

```rust
pub struct TunnelRunner {
    id: TunnelId,
    spec: TunnelSpec,
    cancel: CancellationToken,
    stats: Arc<TunnelStats>,
    listener: Mutex<Option<TcpListener>>,   // 重连时保持
}

pub struct TunnelStats {
    active: AtomicU32,
    total: AtomicU64,
    bytes_up: AtomicU64,
    bytes_down: AtomicU64,
    last_error: Mutex<Option<(Instant, String)>>,
    started_at: Instant,
}
```

### 3.2 本地转发循环

```rust
async fn run_local(&self) -> Result<()> {
    let listener = TcpListener::bind((self.spec.listen_host, self.spec.listen_port)).await
        .map_err(|e| map_bind_error(e, &self.spec))?;

    let actual_port = listener.local_addr()?.port();
    self.stats.set_listen_port(actual_port);
    *self.listener.lock().unwrap() = Some(listener.try_clone()?);

    loop {
        tokio::select! {
            _ = self.cancel.cancelled() => break,
            accepted = listener.accept() => {
                let (client, peer) = accepted?;
                if self.stats.active() >= MAX_PER_TUNNEL {
                    tracing::warn!(?peer, "tunnel connection limit reached");
                    drop(client);       // 直接关闭，让客户端立刻知道
                    continue;
                }
                let this = self.clone();
                tokio::spawn(async move { this.handle_connection(client).await });
            }
        }
    }
    Ok(())
}

async fn handle_connection(&self, mut client: TcpStream) -> Result<()> {
    self.stats.inc_active();
    let _guard = scopeguard::guard((), |_| self.stats.dec_active());

    // 每次连接重新获取上游流（可能触发重连）
    let mut upstream = self.provider.connect(&self.spec.target_host, self.spec.target_port).await?;

    let up = copy_counted(&mut client, &mut upstream, &self.stats.bytes_up);
    let down = copy_counted(&mut upstream, &mut client, &self.stats.bytes_down);

    tokio::select! {
        r = up => r,
        r = down => r,
    }
}
```

**关键点**

| 点 | 说明 |
|---|---|
| `listener` 在重连时保持 | 见 §3.4 |
| 每次连接重新取上游 | 承载 SSH 会话可能已换了一条新连接 |
| 双向 `select!` | 任一方向结束就关闭两侧（半关闭语义见下） |
| `copy_counted` | 带字节计数的 `copy`，用固定 64 KB 缓冲 |
| 无界缓冲禁止 | 见 `spec/09` §3.2 |

### 3.3 半关闭

```rust
async fn copy_counted<R, W>(r: &mut R, w: &mut W, counter: &AtomicU64) -> Result<()>
where R: AsyncRead + Unpin, W: AsyncWrite + Unpin
{
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = r.read(&mut buf).await?;
        if n == 0 {
            w.shutdown().await?;     // 传递 EOF，而不是直接 close
            return Ok(());
        }
        w.write_all(&buf[..n]).await?;
        counter.fetch_add(n as u64, Ordering::Relaxed);
    }
}
```

**为什么 `shutdown()` 而不是 `drop()`**：`drop` 会发 `RST`，可能丢掉对端还没读完的数据。`shutdown` 发 `FIN`，让对端正常读到 EOF。这在数据库/HTTP 场景会造成「连接被重置」的假象。

### 3.4 重连期间保持监听（`spec/09` §3.4 的实现）

这是本设计最重要的细节。

```rust
async fn supervise(&self) -> Result<()> {
    loop {
        match self.run_local().await {
            Ok(()) => break,                       // 正常取消
            Err(e) if e.is_fatal() => {
                self.stats.set_error(e.clone());
                return Err(e);                     // 端口占用/权限 → 不重试
            }
            Err(e) => {
                self.stats.set_error(e);
                // 关键：监听 socket 仍在（run_local 里的 listener 被保存），
                // 这里只是重新建立上游连接的能力
                self.wait_backoff().await;
            }
        }
    }
    Ok(())
}
```

**「保持监听」的具体含义**

| 做法 | 客户端表现 | 结论 |
|---|---|---|
| 重连时关闭监听再重开 | 立刻 `Connection refused`，客户端报错退出 | ❌ |
| 保持监听，新连接排队等待上游就绪 | 客户端卡住 1~3 s 然后成功 | ✅ 采用 |
| 保持监听，新连接立刻返回空流 | 客户端收到 EOF，报「连接被关闭」 | ❌ |

**排队实现**

```rust
async fn handle_connection(&self, mut client: TcpStream) -> Result<()> {
    // 等待上游可用，最多 30 s
    let mut upstream = match timeout(Duration::from_secs(30), self.wait_upstream()).await {
        Ok(Ok(s)) => s,
        _ => {
            tracing::warn!("upstream unavailable, dropping client");
            return Ok(());      // 关闭客户端连接
        }
    };
    // ...
}
```

`wait_upstream` 用一个 `tokio::sync::Notify` + 状态标志：上游就绪时 `notify_waiters()`。

### 3.5 远程转发（`-R`）

```rust
async fn run_remote(&self) -> Result<()> {
    // 1. 请求远端监听
    let actual_port = self.ssh.request_remote_forward(&self.spec.listen_host, self.spec.listen_port).await
        .map_err(|e| match e {
            ForwardError::AdministrativelyProhibited =>
                WtError::new("TUN_FORWARD_DENIED").message("服务器禁止远程端口转发（AllowTcpForwarding no）"),
            ForwardError::PortInUse =>
                WtError::new("TUN_REMOTE_PORT_IN_USE").message(format!("远端端口 {} 已被占用", self.spec.listen_port)),
            _ => e.into(),
        })?;

    // 2. 处理服务端发起的 forwarded-tcpip 通道
    //    （由 SshHandler::server_channel_open_forwarded_tcpip 回调）
    loop {
        let channel = self.rx.recv().await?;
        let local = TcpStream::connect((&self.spec.target_host, self.spec.target_port)).await?;
        tokio::spawn(pipe(channel, local));
    }
}
```

**`GatewayPorts no` 的处理**：请求 `0.0.0.0` 会被拒。错误信息必须包含 `GatewayPorts`（`NET-002` AC-2）。

### 3.6 动态转发（`-D`，SOCKS5）

```rust
async fn handle_socks5(&self, mut client: TcpStream) -> Result<()> {
    // 1. 版本与方法协商
    let mut head = [0u8; 2];
    client.read_exact(&mut head).await?;
    if head[0] != 5 { return Err(anyhow!("not socks5")); }
    let n = head[1] as usize;
    let mut methods = vec![0u8; n];
    client.read_exact(&mut methods).await?;

    // 2. 选择认证方式
    if self.auth.is_some() {
        if !methods.contains(&2) { client.write_all(&[5, 0xFF]).await?; return Ok(()); }
        client.write_all(&[5, 2]).await?;
        self.do_userpass(&mut client).await?;
    } else {
        if !methods.contains(&0) { client.write_all(&[5, 0xFF]).await?; return Ok(()); }
        client.write_all(&[5, 0]).await?;
    }

    // 3. 请求
    let mut req = [0u8; 4];
    client.read_exact(&mut req).await?;
    if req[1] != 1 {      // 只支持 CONNECT
        client.write_all(&[5, 7, 0, 1, 0,0,0,0, 0,0]).await?;
        return Ok(());
    }

    let (host, port) = read_addr(&mut client, req[3]).await?;

    // 4. 连接（由远端解析域名：domain 类型直接透传）
    match self.provider.connect(&host, port).await {
        Ok(mut upstream) => {
            client.write_all(&[5, 0, 0, 1, 0,0,0,0, 0,0]).await?;
            pipe(client, upstream).await
        }
        Err(_) => {
            client.write_all(&[5, 5, 0, 1, 0,0,0,0, 0,0]).await?;   // connection refused
            Ok(())
        }
    }
}
```

**关键**：地址类型为 `DOMAINNAME`（0x03）时，把域名原样交给 `provider.connect`——由远端解析（`NET-003` AC-2）。

## 4. 内置服务端

### 4.1 共同约束

```rust
pub struct ServerSpec {
    pub kind: ServerKind,
    pub root: PathBuf,
    pub listen: SocketAddr,
    pub auth: ServerAuth,
    pub read_only: bool,
    pub auto_stop: Option<Duration>,
}
```

**所有内置服务端必须满足**

| 约束 | 实现 |
|---|---|
| 默认只听 `127.0.0.1` | `ServerSpec::default()` |
| 改 `0.0.0.0` 需确认 | UI 层（`SEC-011`） |
| 路径穿越防护 | 见下 |
| 自动停止 | 定时器 + 会话结束 |
| 访问日志 | 写入内存环形缓冲 + 可选文件 |

**路径穿越防护**

```rust
fn resolve_safe(root: &Path, requested: &str) -> Result<PathBuf> {
    let decoded = percent_decode(requested)?;
    if decoded.contains('\0') { return Err(Forbidden); }
    let joined = root.join(decoded.trim_start_matches('/'));
    let canonical = joined.canonicalize()?;          // 解析 .. 与符号链接
    let root_canon = root.canonicalize()?;
    if !canonical.starts_with(&root_canon) { return Err(Forbidden); }
    Ok(canonical)
}
```

**`canonicalize` 是必须的**：仅做字符串检查（拒绝 `..`）会被符号链接绕过。

### 4.2 HTTP 服务端

用 `axum`：

```rust
let app = Router::new()
    .route("/", get(index))
    .route("/{*path}", get(serve_file).put(upload_file))
    .layer(middleware::from_fn_with_state(state, auth_layer))
    .layer(TraceLayer::new_for_http());
```

**必须实现的细节**

| 项 | 说明 |
|---|---|
| `Range` 请求 | 断点续传与大文件播放 |
| `ETag` / `Last-Modified` | 缓存 |
| `Content-Disposition` | 下载文件名 |
| 目录列表 HTML | 可开关；转义文件名（防 XSS） |
| 上传 | 默认关闭；开启需确认；限制大小 |
| 认证 | Basic Auth，密码用 `argon2` 校验（不存明文） |

### 4.3 FTP / SSH 服务端

- FTP：`libunftp`（若成熟）或自研控制通道 + 复用 `FileSystem`。
- SSH：用 `russh` 的 server 端，只启用 `publickey` 与 `sftp` subsystem。

**SSH 服务端的安全约束**

| 约束 | 理由 |
|---|---|
| 只允许公钥 | 避免弱口令被爆破 |
| 默认只读 SFTP | 开 shell 等于给对端一个登录点 |
| 启动时显示指纹 | 让用户能核对 |
| 最长 24 h 自动停 | 避免忘记关闭 |

## 5. 网络诊断工具

### 5.1 统一结果模型

```rust
pub struct DiagResult {
    pub tool: String,
    pub target: String,
    pub steps: Vec<DiagStep>,
    pub conclusion: String,
    pub raw: Option<String>,       // 原始输出（可复制）
}

pub struct DiagStep {
    pub name: String,
    pub ok: bool,
    pub duration: Duration,
    pub detail: String,
    pub error: Option<String>,
}
```

**为什么统一**：UI 只需一个渲染器；导出 JSON 后脚本可消费（`NET-016` 的 `--json`）。

### 5.2 端口探测（`NET-017`）

```rust
pub async fn probe(provider: &dyn StreamProvider, host: &str, port: u16, tls: bool) -> DiagResult {
    let mut steps = vec![];

    // 1. DNS（仅在 provider 是 Direct 时有意义）
    if provider.is_direct() {
        let t = Instant::now();
        let addrs = tokio::net::lookup_host((host, port)).await;
        steps.push(step("DNS 解析", addrs.is_ok(), t.elapsed(), ...));
    } else {
        steps.push(DiagStep::skipped("DNS 解析", "目标主机名由远端解析"));
    }

    // 2. TCP
    let t = Instant::now();
    let stream = provider.connect(host, port).await;
    steps.push(step("TCP 连接", stream.is_ok(), t.elapsed(), ...));

    // 3. 应用层（读 banner，1 s 超时）
    if let Ok(mut s) = stream {
        let mut buf = [0u8; 256];
        match timeout(Duration::from_secs(1), s.read(&mut buf)).await {
            Ok(Ok(n)) if n > 0 => steps.push(step("应用层", true, ..., format!("banner: {}", lossy(&buf[..n])))),
            _ => steps.push(DiagStep::skipped("应用层", "无 banner（服务端不主动问候）")),
        }
    }

    DiagResult { tool: "port-probe".into(), target: format!("{host}:{port}"), steps, .. }
}
```

**双视角对比**（`NET-017` 增强）：同一目标分别用 `DirectProvider` 和 `SshDirectTcpipProvider` 探测，并排展示。这是排障时最有用的信息。

### 5.3 抓包（`NET-012`）

```rust
pub fn capture(iface: &str, filter: &str, sink: impl Fn(Packet)) -> Result<CaptureHandle>;
```

| 平台 | 库 |
|---|---|
| Windows | `pcap` crate（绑定 Npcap 的 `wpcap.dll`） |
| macOS / Linux | `pcap` crate（libpcap） |

**依赖检测**

```rust
pub fn check_pcap() -> PcapStatus {
    #[cfg(windows)]
    {
        if !Path::new(r"C:\Windows\System32\Npcap\wpcap.dll").exists()
            && !Path::new(r"C:\Windows\System32\wpcap.dll").exists() {
            return PcapStatus::Missing { download: "https://npcap.com/#download" };
        }
    }
    match pcap::Device::list() {
        Ok(devices) => PcapStatus::Ready(devices),
        Err(_) => PcapStatus::PermissionDenied,
    }
}
```

**权限不足的处理**：macOS/Linux 需要 `CAP_NET_RAW` 或 root。提示用户「抓包需要提升权限」并提供指引，而不是报「操作失败」。

## 6. 与需求的对应

| 设计点 | 需求 |
|---|---|
| `StreamProvider` | `SES-024/025/026`、`GUI-015`、`NET-001` |
| 链式组合 | `SES-025` 多跳 |
| 池 + `via` 递归 | `SES-024` AC-3 |
| 环检测 | `SES-024` AC-4 |
| 每跳错误定位 | `SES-024` AC-2 |
| 保持监听 + 排队 | `spec/09` §3.4 |
| 半关闭 `shutdown` | 数据完整性 |
| SOCKS5 域名透传 | `NET-003` AC-2 |
| 路径穿越防护 | `NET-007` AC |
| 统一诊断模型 | `NET-016/017` |
| 双视角探测 | `NET-017` 增强 |
| 抓包依赖检测 | `NET-012` |
| 隧道生命周期与自动启动 | `NET-005` |
