//! 本地端口转发（`NET-001`）。
//!
//! 语义：`本地监听 L:LPort` → 经 SSH 会话 → 目标 `TH:TPort`。
//! 目标由**服务端**解析（`direct-tcpip`），所以这条能力真正解决的场景是
//! 「只允许从服务器访问的服务」（数据库、Redis、内网 HTTP）。
//!
//! # 为什么用 `copy_bidirectional`
//!
//! `NET-001` 要求「一端 EOF 时向另一端发 EOF，等待对端关闭，避免 RST 丢数据」。
//! `tokio::io::copy_bidirectional` 正是这个语义：每个方向读到 EOF 就
//! `shutdown()` 对应写端，另一个方向继续跑到 EOF，最后返回两向字节数。
//! 手写两条 `copy` 很容易漏掉 `shutdown`，表现是「查询大结果集时偶发截断」。
//!
//! # 计数器
//!
//! 用原子量而不是锁：`NET-004` 要求 10 条隧道实时刷新统计，锁会把读统计
//! 变成会阻塞数据面的操作。

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

use tokio::net::TcpListener;
use wt_common::{codes, HintAction, WtError};

use crate::client::SshConnection;

/// 一条转发的实时统计（`NET-001` 行为规格第 4 条）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ForwardStats {
    /// 当前活跃连接数
    pub active: usize,
    /// 累计连接数
    pub total: usize,
    /// 本地 → 远端 的字节数
    pub up_bytes: u64,
    /// 远端 → 本地 的字节数
    pub down_bytes: u64,
    /// 最近一次失败的原因（成功转发一次后清空）。
    ///
    /// 为什么必须有它：承载连接断了以后监听端口还在，每个新连接都会失败。
    /// 没有这个字段，界面只能显示「运行中」，用户看到的是「隧道好好的但连不上」——
    /// `NET-004` AC-3 要求这种状态能被看出来并给出原因。
    pub last_error: Option<String>,
}

#[derive(Debug, Default)]
struct Counters {
    active: AtomicUsize,
    total: AtomicUsize,
    up: AtomicU64,
    down: AtomicU64,
    last_error: std::sync::Mutex<Option<String>>,
}

impl Counters {
    fn snapshot(&self) -> ForwardStats {
        ForwardStats {
            active: self.active.load(Ordering::Relaxed),
            total: self.total.load(Ordering::Relaxed),
            up_bytes: self.up.load(Ordering::Relaxed),
            down_bytes: self.down.load(Ordering::Relaxed),
            last_error: self.last_error.lock().ok().and_then(|e| e.clone()),
        }
    }

    fn record_error(&self, message: &str) {
        if let Ok(mut slot) = self.last_error.lock() {
            *slot = Some(message.to_string());
        }
    }

    fn clear_error(&self) {
        if let Ok(mut slot) = self.last_error.lock() {
            *slot = None;
        }
    }
}

/// 一条运行中的本地转发。`stop()` 之后监听端口立刻关闭、在途连接自然跑到 EOF。
pub struct LocalForward {
    listen_addr: std::net::SocketAddr,
    counters: Arc<Counters>,
    stop: tokio::sync::watch::Sender<bool>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl LocalForward {
    /// 实际监听地址。`listen_port = 0` 时这里拿到的是系统分配的端口（`NET-001` AC-2）。
    pub fn listen_addr(&self) -> std::net::SocketAddr {
        self.listen_addr
    }

    pub fn stats(&self) -> ForwardStats {
        self.counters.snapshot()
    }

    /// 停止转发：关掉监听、等在途的连接不再接受新连接。
    ///
    /// 不等待在途连接结束——长连接（比如一条 SSH 会话里的数据库连接）可能挂很久，
    /// 让「停止隧道」按钮卡住是最糟的体验。连接会因为监听关闭而自然结束。
    pub async fn stop(mut self) {
        let _ = self.stop.send(true);
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

impl Drop for LocalForward {
    fn drop(&mut self) {
        // 忘记 stop 也不能留一个幽灵监听端口
        let _ = self.stop.send(true);
    }
}

/// 监听地址是否会被局域网访问到（`NET-001` 行为规格第 1 条：需要红色警告 + 确认）。
///
/// 判断放在这里而不是 UI 里：CLI 和界面都要用，写两遍迟早不一致。
pub fn exposes_to_lan(listen_host: &str) -> bool {
    match listen_host.trim() {
        "0.0.0.0" | "::" | "[::]" | "*" => true,
        host => !(host == "127.0.0.1" || host == "::1" || host == "localhost" || host.is_empty()),
    }
}

/// 启动一条本地转发。
///
/// `conn` 用 `Arc` 是为了让多条隧道共享同一条 SSH 连接：每连接都是一次完整的
/// 握手与认证，隧道多了代价明显，而 `russh` 的 `Handle` 本身支持并发开通道。
pub async fn start_local(
    conn: Arc<SshConnection>,
    listen_host: &str,
    listen_port: u16,
    target_host: &str,
    target_port: u16,
) -> Result<LocalForward, WtError> {
    let host = if listen_host.trim().is_empty() {
        "127.0.0.1"
    } else {
        listen_host.trim()
    };
    if target_host.trim().is_empty() {
        return Err(WtError::new("TUN_BAD_ARGUMENT")
            .message("目标主机不能为空")
            .hint("目标主机名在服务器侧解析，比如 `db` 或 `redis.internal`", HintAction::None));
    }

    let listener = TcpListener::bind((host, listen_port)).await.map_err(|e| {
        WtError::new(codes::TUN_BIND_FAILED)
            .message(format!("无法监听 {host}:{listen_port}"))
            .detail(e.to_string())
            .hint(
                "端口可能已被占用；把监听端口设为 0 可以改用系统分配的随机端口",
                HintAction::None,
            )
    })?;
    let listen_addr = listener.local_addr().map_err(|e| {
        WtError::new(codes::TUN_BIND_FAILED)
            .message("已监听但取不到本地地址")
            .detail(e.to_string())
            .hint("请把这次失败连同端口号一起报告", HintAction::None)
    })?;

    let counters = Arc::new(Counters::default());
    let (stop, mut stop_rx) = tokio::sync::watch::channel(false);
    let target = (target_host.trim().to_string(), target_port);
    let loop_counters = counters.clone();

    let task = tokio::spawn(async move {
        loop {
            tokio::select! {
                // 停止信号优先：先看这个分支，避免停止后还接一个连接进来
                changed = stop_rx.changed() => {
                    if changed.is_err() || *stop_rx.borrow() {
                        break;
                    }
                }
                accepted = listener.accept() => {
                    let Ok((socket, peer)) = accepted else {
                        // accept 失败（如对端在握手期间消失）不该终止整条隧道
                        continue;
                    };
                    loop_counters.total.fetch_add(1, Ordering::Relaxed);
                    loop_counters.active.fetch_add(1, Ordering::Relaxed);
                    let conn = conn.clone();
                    let (host, port) = target.clone();
                    let c = loop_counters.clone();
                    let cc = loop_counters.clone();
                    tokio::spawn(async move {
                        // 单条连接的错误不该影响隧道本身，但也不能静默消失：
                        // 承载连接断了以后每个新连接都会失败，界面必须能说出原因。
                        match serve_one(conn, socket, peer, host, port, cc.clone()).await {
                            Ok(()) => cc.clear_error(),
                            Err(e) => cc.record_error(&e.message),
                        }
                        c.active.fetch_sub(1, Ordering::Relaxed);
                    });
                }
            }
        }
    });

    Ok(LocalForward {
        listen_addr,
        counters,
        stop,
        task: Some(task),
    })
}

async fn serve_one(
    conn: Arc<SshConnection>,
    mut socket: tokio::net::TcpStream,
    peer: std::net::SocketAddr,
    target_host: String,
    target_port: u16,
    counters: Arc<Counters>,
) -> Result<(), WtError> {
    let mut channel = conn
        .open_direct_tcpip(
            &target_host,
            target_port,
            &peer.ip().to_string(),
            peer.port(),
        )
        .await?;
    // 双向搬运；返回的是 (本地→远端, 远端→本地) 两向字节数
    let (up, down) = tokio::io::copy_bidirectional(&mut socket, &mut channel)
        .await
        .map_err(|e| {
            WtError::new(codes::TUN_CHANNEL_FAILED)
                .message(format!("转发 {target_host}:{target_port} 时数据流中断"))
                .detail(e.to_string())
                .hint("检查服务器到目标的链路是否稳定", HintAction::None)
        })?;
    counters.up.fetch_add(up, Ordering::Relaxed);
    counters.down.fetch_add(down, Ordering::Relaxed);
    Ok(())
}
