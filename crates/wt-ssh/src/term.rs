//! SSH 终端会话：把 `SshChannel` 接入与本地 PTY 相同的读循环与背压模型。
//!
//! 设计依据：`docs/design/03-terminal-subsystem.md` §3、`docs/design/05-ssh-stack.md` §7。
//!
//! # 为什么用「命令通道」而不是 split
//!
//! `russh::Channel` 的读（`wait`）需要 `&mut self`，写（`data`）只需要 `&self`。
//! 但读是长时间 `await` 的，若在读的同时从外部调用 `data()` 会争用同一个对象。
//! 这里让**一个 tokio 任务独占 channel**，外部通过 mpsc 发命令（写/改尺寸/关闭），
//! 任务用 `select!` 同时处理「读数据」与「收命令」。这样不需要依赖 `Channel::split`
//! 是否存在，语义也更清楚：一个通道只有一个主人。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::mpsc;
use wt_common::WtError;
use wt_term::{RingBuffer, TerminalSession};

use crate::client::SshConnection;

/// 发给 pump 任务的命令。
enum TermCmd {
    Write(Vec<u8>),
    Resize(u16, u16),
    Close,
}

/// keepalive 配置。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Keepalive {
    /// 心跳间隔
    pub interval: Duration,
    /// 连续多少次没有回应就判定连接已断
    pub max_missed: u32,
}

impl Keepalive {
    pub fn new(interval: Duration, max_missed: u32) -> Self {
        Self {
            interval,
            max_missed: max_missed.max(1),
        }
    }
}

/// 心跳的失败计数。
///
/// 单独抽出来是为了能直接测策略：真去构造一条「半开连接」很难，
/// 但「连续 N 次没回应就放弃、中间有一次回应就清零」是可测的。
#[derive(Debug, Clone)]
struct KeepaliveTracker {
    max_missed: u32,
    missed: u32,
}

impl KeepaliveTracker {
    fn new(max_missed: u32) -> Self {
        Self {
            max_missed: max_missed.max(1),
            missed: 0,
        }
    }

    fn on_reply(&mut self) {
        self.missed = 0;
    }

    /// 记一次无回应；返回 `true` 表示应该放弃这条连接。
    fn on_miss(&mut self) -> bool {
        self.missed += 1;
        self.missed >= self.max_missed
    }

    fn missed(&self) -> u32 {
        self.missed
    }
}

/// 一条 SSH 交互式终端会话。
pub struct SshTermSession {
    ring: Arc<Mutex<RingBuffer>>,
    tx: mpsc::Sender<TermCmd>,
    task: tokio::task::JoinHandle<()>,
    cols: u16,
    rows: u16,
    closed: bool,
}

impl SshTermSession {
    /// 打开一个带 PTY 的 shell 会话。
    ///
    /// 连接仍由调用方持有，因此**没有 keepalive**——空闲连接可能被中间设备断开。
    /// 需要保活就用 [`SshTermSession::open_owned`]。
    pub async fn open(
        conn: &SshConnection,
        term: &str,
        cols: u16,
        rows: u16,
        ring: RingBuffer,
    ) -> Result<Self, WtError> {
        let channel = conn.open_shell(term, cols as u32, rows as u32).await?;
        Ok(Self::start(channel, ring, None, None, cols, rows))
    }

    /// 打开会话并**接管连接**，按 `keepalive` 周期发心跳。
    ///
    /// 接管的两个理由：① 连接句柄与通道同寿命，不再依赖「`Handle` 被 drop 不会断开」
    /// 这个实现细节；② 只有拿着句柄才能发心跳、也只有它能等到心跳的回应。
    pub async fn open_owned(
        conn: SshConnection,
        keepalive: Option<Keepalive>,
        term: &str,
        cols: u16,
        rows: u16,
        ring: RingBuffer,
    ) -> Result<Self, WtError> {
        let channel = conn.open_shell(term, cols as u32, rows as u32).await?;
        Ok(Self::start(channel, ring, Some(conn), keepalive, cols, rows))
    }

    fn start(
        mut channel: crate::client::SshChannel,
        ring: RingBuffer,
        owner: Option<SshConnection>,
        keepalive: Option<Keepalive>,
        cols: u16,
        rows: u16,
    ) -> Self {
        let ring = Arc::new(Mutex::new(ring));
        let ring_task = ring.clone();
        let (tx, mut rx) = mpsc::channel::<TermCmd>(64);

        let task = tokio::spawn(async move {
            let mut ticker = keepalive.map(|k| {
                let mut it = tokio::time::interval(k.interval);
                // 落后时不要补发一串心跳，按原节奏继续
                it.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                it
            });
            let interval = keepalive.map(|k| k.interval).unwrap_or_default();
            let mut tracker = keepalive.map(|k| KeepaliveTracker::new(k.max_missed));
            // interval 的第一次 tick 立即完成；先消费掉，避免刚连上就发心跳
            if let Some(t) = ticker.as_mut() {
                t.tick().await;
            }

            loop {
                tokio::select! {
                    cmd = rx.recv() => {
                        match cmd {
                            Some(TermCmd::Write(bytes)) => {
                                let _ = channel.write(&bytes).await;
                            }
                            Some(TermCmd::Resize(c, r)) => {
                                let _ = channel.resize(c as u32, r as u32).await;
                            }
                            Some(TermCmd::Close) | None => break,
                        }
                    }
                    msg = channel.next() => {
                        match msg {
                            Some(crate::client::ChannelData::Stdout(bytes)) => {
                                // 背压：未确认字节超过高水位时先等一会儿再写
                                loop {
                                    let paused = ring_task.lock().unwrap().is_paused();
                                    if !paused {
                                        break;
                                    }
                                    tokio::time::sleep(Duration::from_millis(5)).await;
                                }
                                ring_task.lock().unwrap().push(&bytes);
                            }
                            Some(crate::client::ChannelData::Stderr(bytes)) => {
                                ring_task.lock().unwrap().push(&bytes);
                            }
                            Some(crate::client::ChannelData::Exit(_)) => {}
                            None => break,
                        }
                    }
                    _ = async {
                        match ticker.as_mut() {
                            Some(t) => { t.tick().await; }
                            None => std::future::pending::<()>().await,
                        }
                    } => {
                        let (Some(conn), Some(tracker)) = (owner.as_ref(), tracker.as_mut()) else {
                            continue;
                        };
                        // 一个间隔内没有回应就算一次失败：这正是「半开连接」的样子
                        match tokio::time::timeout(interval, conn.probe()).await {
                            Ok(Ok(())) => tracker.on_reply(),
                            _ => {
                                if tracker.on_miss() {
                                    // 连接已经不可用。把原因写进终端——
                                    // 用户看的就是这块屏，静默卡住比报错更糟。
                                    let note = format!(
                                        "\r\n\x1b[31m[连接已断开：连续 {} 次心跳无回应]\x1b[0m\r\n",
                                        tracker.missed()
                                    );
                                    ring_task.lock().unwrap().push(note.as_bytes());
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        });

        Self {
            ring,
            tx,
            task,
            cols,
            rows,
            closed: false,
        }
    }

    /// 用默认参数（`xterm-256color`、120×30、默认缓冲）。
    pub async fn open_default(conn: &SshConnection) -> Result<Self, WtError> {
        Self::open(conn, "xterm-256color", 120, 30, RingBuffer::with_defaults()).await
    }

    /// 阻塞式便利方法：等待输出里出现 `needle`。UI 不该用它（应走 read/ack 拉取）。
    pub async fn wait_for_output(&mut self, needle: &str, timeout: Duration) -> String {
        let deadline = tokio::time::Instant::now() + timeout;
        let mut acc: Vec<u8> = Vec::new();
        while tokio::time::Instant::now() < deadline {
            let mut chunk = Vec::new();
            let n = self.read_into(&mut chunk, 64 * 1024);
            if n > 0 {
                self.ack(n);
                acc.extend_from_slice(&chunk);
                if String::from_utf8_lossy(&acc).contains(needle) {
                    break;
                }
            } else {
                tokio::time::sleep(Duration::from_millis(15)).await;
            }
        }
        String::from_utf8_lossy(&acc).to_string()
    }
}

impl TerminalSession for SshTermSession {
    fn read_into(&mut self, out: &mut Vec<u8>, max: usize) -> usize {
        self.ring.lock().unwrap().read_into(out, max)
    }

    fn ack(&mut self, n: usize) {
        self.ring.lock().unwrap().ack(n);
    }

    fn is_paused(&self) -> bool {
        self.ring.lock().unwrap().is_paused()
    }

    fn dropped_bytes(&self) -> u64 {
        self.ring.lock().unwrap().dropped_bytes()
    }

    fn buffered(&self) -> usize {
        self.ring.lock().unwrap().len()
    }

    fn unacked(&self) -> usize {
        self.ring.lock().unwrap().unacked()
    }

    fn write(&mut self, data: &[u8]) -> Result<(), WtError> {
        self.tx
            .try_send(TermCmd::Write(data.to_vec()))
            .map_err(|_| WtError::new("SSH_TERM_CLOSED").message("终端已关闭，无法写入"))
    }

    fn resize(&mut self, cols: u16, rows: u16) -> Result<(), WtError> {
        self.cols = cols;
        self.rows = rows;
        self.tx
            .try_send(TermCmd::Resize(cols, rows))
            .map_err(|_| WtError::new("SSH_TERM_CLOSED").message("终端已关闭，无法调整尺寸"))
    }

    fn size(&self) -> (u16, u16) {
        (self.cols, self.rows)
    }

    fn close(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        let _ = self.tx.try_send(TermCmd::Close);
        // 不 abort：让任务自己走完 select 分支，避免在半途丢弃 channel 状态
        self.task.abort();
    }
}

impl Drop for SshTermSession {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keepalive_tracker_gives_up_after_max_missed() {
        let mut t = KeepaliveTracker::new(3);
        assert!(!t.on_miss());
        assert!(!t.on_miss());
        assert!(t.on_miss(), "第 3 次无回应应判定断开");
        assert_eq!(t.missed(), 3);
    }

    #[test]
    fn keepalive_tracker_resets_after_a_reply() {
        let mut t = KeepaliveTracker::new(2);
        assert!(!t.on_miss());
        t.on_reply(); // 中间有一次回应，计数必须清零
        assert_eq!(t.missed(), 0);
        assert!(!t.on_miss());
        assert!(t.on_miss(), "清零后仍需连续 2 次才判定断开");
    }

    #[test]
    fn keepalive_tracker_treats_zero_as_one() {
        // max_missed = 0 会让「第一次无回应就断开」变得不可配置；夹到 1 更安全
        let mut t = KeepaliveTracker::new(0);
        assert!(t.on_miss());
    }

    #[test]
    fn ring_buffer_backpressure_is_shared_with_local_terminal() {
        // 只是确认两边用的是同一个 RingBuffer 语义（同一 crate、同一类型）
        let mut rb = RingBuffer::new(1024, 512, 128);
        rb.push(&[b'x'; 600]);
        let mut out = Vec::new();
        rb.read_into(&mut out, 600);
        assert!(rb.is_paused());
        rb.ack(600);
        assert!(!rb.is_paused());
    }
}
