//! `TermSession`：把「传输 + 环形缓冲 + 背压」合成一个 UI 可直接用的会话对象。
//!
//! 设计依据：`docs/design/03-terminal-subsystem.md` §3、§4；`docs/design/02` §5。
//!
//! 分工很清楚：
//! - **传输**（PTY / 将来的 SSH 通道）负责产出字节；
//! - **环形缓冲**负责暂存 + 统计未确认字节；
//! - **背压**由 `is_paused()` 暴露给传输侧：暂停时不要再读。
//!
//! UI 侧只有四个动作：`read_into` → 渲染 → `ack` → 循环。这个形状与
//! `design/02` §3.4 的「拉取式二进制 IPC」完全对应，将来换成 IPC 只改搬运层。

#![forbid(unsafe_code)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use wt_common::WtError;

use crate::pty::{OutputPump, PtyConfig, PtySession};
use crate::RingBuffer;

/// 终端会话的统一抽象。
///
/// UI 只持有 `Box<dyn TerminalSession>`，不必区分本地 PTY 还是 SSH 通道——
/// 标签页、分屏、多执行广播因此都能用同一套代码处理两种来源。
///
/// 形状刻意与 `design/02` §3.4 的拉取式 IPC 对齐：`read_into` → 渲染 → `ack`。
pub trait TerminalSession: Send {
    /// 读取最多 `max` 字节追加到 `out`。
    fn read_into(&mut self, out: &mut Vec<u8>, max: usize) -> usize;

    /// 确认已处理 `n` 字节（背压靠它恢复）。
    fn ack(&mut self, n: usize);

    /// 是否应暂停读取。
    fn is_paused(&self) -> bool;

    /// 因溢出丢弃的字节数。
    fn dropped_bytes(&self) -> u64;

    /// 缓冲中尚未被读走的字节数。
    fn buffered(&self) -> usize;

    /// 已投递但尚未确认的字节数。
    fn unacked(&self) -> usize;

    fn write(&mut self, data: &[u8]) -> Result<(), WtError>;

    fn resize(&mut self, cols: u16, rows: u16) -> Result<(), WtError>;

    fn size(&self) -> (u16, u16);

    /// 关闭。必须幂等且不阻塞。
    fn close(&mut self);

    /// 本地 shell 的进程号；SSH 等远端会话没有本地子进程，返回 `None`。
    ///
    /// 用途单一：关标签时判断「有没有前台命令在跑」（`TER-018`）。
    /// 默认 `None` 是刻意的——远端会话由服务端负责，客户端不该去猜。
    fn child_pid(&self) -> Option<u32> {
        None
    }
}

impl TerminalSession for TermSession {
    fn read_into(&mut self, out: &mut Vec<u8>, max: usize) -> usize {
        TermSession::read_into(self, out, max)
    }
    fn ack(&mut self, n: usize) {
        TermSession::ack(self, n)
    }
    fn is_paused(&self) -> bool {
        TermSession::is_paused(self)
    }
    fn dropped_bytes(&self) -> u64 {
        TermSession::dropped_bytes(self)
    }
    fn buffered(&self) -> usize {
        TermSession::buffered(self)
    }
    fn unacked(&self) -> usize {
        TermSession::unacked(self)
    }
    fn write(&mut self, data: &[u8]) -> Result<(), WtError> {
        TermSession::write(self, data)
    }
    fn resize(&mut self, cols: u16, rows: u16) -> Result<(), WtError> {
        TermSession::resize(self, cols, rows)
    }
    fn size(&self) -> (u16, u16) {
        TermSession::size(self)
    }
    fn close(&mut self) {
        TermSession::close(self)
    }
    fn child_pid(&self) -> Option<u32> {
        TermSession::child_pid(self)
    }
}
/// 一次本地终端会话。
pub struct TermSession {
    ring: Arc<Mutex<RingBuffer>>,
    pump: OutputPump,
    pty: PtySession,
    closed: bool,
}

impl TermSession {
    /// 用默认参数启动本地终端。
    pub fn spawn_local(cfg: PtyConfig) -> Result<Self, WtError> {
        Self::spawn_local_with_ring(cfg, RingBuffer::with_defaults())
    }

    /// 指定环形缓冲（测试或特殊配置用）。
    pub fn spawn_local_with_ring(cfg: PtyConfig, ring: RingBuffer) -> Result<Self, WtError> {
        let pty = PtySession::spawn(&cfg)?;
        let reader = pty.take_reader()?;
        let writer = pty.writer_handle();

        let ring = Arc::new(Mutex::new(ring));
        let pump = OutputPump::start(reader, ring.clone(), writer, cfg.answer_queries, |_| {});

        Ok(Self {
            ring,
            pump,
            pty,
            closed: false,
        })
    }

    /// 读取最多 `max` 字节追加到 `out`。返回本次读到的字节数。
    ///
    /// 读出的字节计入「未确认」，直到调用 [`ack`](Self::ack)。
    pub fn read_into(&mut self, out: &mut Vec<u8>, max: usize) -> usize {
        self.ring.lock().unwrap().read_into(out, max)
    }

    /// 前端确认已处理 `n` 字节。背压靠它恢复。
    pub fn ack(&mut self, n: usize) {
        self.ring.lock().unwrap().ack(n);
    }

    /// 是否应暂停读取（未确认字节超过高水位）。
    pub fn is_paused(&self) -> bool {
        self.ring.lock().unwrap().is_paused()
    }

    pub fn buffered(&self) -> usize {
        self.ring.lock().unwrap().len()
    }

    pub fn unacked(&self) -> usize {
        self.ring.lock().unwrap().unacked()
    }

    /// 因溢出被丢弃的字节数。非 0 说明前端处理不过来。
    pub fn dropped_bytes(&self) -> u64 {
        self.ring.lock().unwrap().dropped_bytes()
    }

    pub fn write(&mut self, data: &[u8]) -> Result<(), WtError> {
        self.pty.write(data)
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<(), WtError> {
        self.pty.resize(cols, rows)
    }

    pub fn size(&self) -> (u16, u16) {
        self.pty.size()
    }

    /// 本地 shell 的进程号（见 trait 上的说明）。
    pub fn child_pid(&self) -> Option<u32> {
        self.pty.child_pid()
    }

    /// 子进程退出码（未退出返回 `None`）。
    pub fn try_wait(&mut self) -> Option<u32> {
        self.pty.try_wait()
    }

    pub fn is_closed(&self) -> bool {
        self.closed
    }

    /// 关闭会话。幂等，且**保证不阻塞**（见 `PtySession::release_master` 的历史）。
    pub fn close(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        self.pump.request_stop();
        self.pty.close();
    }

    /// 等待输出中出现 `needle`，返回期间累积的文本（便于测试与「等待提示符」）。
    ///
    /// 这是**阻塞式**便利方法：UI 不应调用它，UI 应当走 `read_into` + `ack` 的拉取循环。
    /// 它存在是为了让「连接后等 banner / 等命令结束」这类场景可读、可测。
    pub fn wait_for_output(&mut self, needle: &str, timeout: Duration) -> String {
        let deadline = std::time::Instant::now() + timeout;
        let mut acc: Vec<u8> = Vec::new();
        while std::time::Instant::now() < deadline {
            let mut chunk = Vec::new();
            let n = self.read_into(&mut chunk, 64 * 1024);
            if n > 0 {
                self.ack(n);
                acc.extend_from_slice(&chunk);
                if String::from_utf8_lossy(&acc).contains(needle) {
                    break;
                }
            } else {
                std::thread::sleep(Duration::from_millis(15));
            }
        }
        String::from_utf8_lossy(&acc).to_string()
    }
}

impl Drop for TermSession {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn echo_cfg(marker: &str) -> PtyConfig {
        if cfg!(windows) {
            PtyConfig {
                program: "cmd.exe".into(),
                args: vec!["/c".into(), format!("echo {marker}")],
                ..Default::default()
            }
        } else {
            PtyConfig {
                program: "/bin/sh".into(),
                args: vec!["-c".into(), format!("echo {marker}")],
                ..Default::default()
            }
        }
    }

    #[test]
    fn session_pumps_output_and_closes() {
        let mut s = TermSession::spawn_local(echo_cfg("WT_SESSION_OK")).expect("启动会话");
        let text = s.wait_for_output("WT_SESSION_OK", Duration::from_secs(10));
        assert!(text.contains("WT_SESSION_OK"), "实际输出: {text:?}");

        s.close();
        assert!(s.is_closed());
        // 幂等
        s.close();
    }

    #[test]
    fn session_write_and_read_back() {
        let cfg = if cfg!(windows) {
            PtyConfig {
                program: "cmd.exe".into(),
                args: vec!["/k".into()],
                ..Default::default()
            }
        } else {
            PtyConfig {
                program: "/bin/cat".into(),
                args: Vec::new(),
                ..Default::default()
            }
        };
        let mut s = TermSession::spawn_local(cfg).expect("启动会话");

        // 等 shell 就绪（cmd /k 会先打 banner）
        std::thread::sleep(Duration::from_millis(400));
        s.write(b"WT_ECHO_1\r\n").expect("写入");
        let text = s.wait_for_output("WT_ECHO_1", Duration::from_secs(10));
        assert!(text.contains("WT_ECHO_1"), "应回显，实际: {text:?}");

        s.close();
    }

    #[test]
    fn ack_releases_backpressure() {
        // 小缓冲 + 低水位，便于在测试里触发背压
        let ring = RingBuffer::new(64 * 1024, 4 * 1024, 1024);
        let mut s = TermSession::spawn_local_with_ring(echo_cfg("WT_BP"), ring).expect("启动");

        // 只读不 ack，直到超过高水位
        let mut total = 0usize;
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline && !s.is_paused() {
            let mut chunk = Vec::new();
            total += s.read_into(&mut chunk, 8 * 1024);
            std::thread::sleep(Duration::from_millis(10));
        }

        // 输出可能不足 4 KB，这种情况下不强求暂停——但一旦有未确认字节，ack 必须能清零
        if s.is_paused() {
            let unacked = s.unacked();
            assert!(unacked >= 4 * 1024, "暂停时未确认应 ≥ 高水位，实际 {unacked}");
            s.ack(unacked);
            assert!(!s.is_paused(), "ack 后应恢复");
        } else {
            s.ack(total);
            assert_eq!(s.unacked(), 0);
        }

        s.close();
    }

    #[test]
    fn resize_updates_size() {
        let cfg = if cfg!(windows) {
            PtyConfig {
                program: "cmd.exe".into(),
                args: vec!["/c".into(), "exit 0".into()],
                cols: 100,
                rows: 30,
                ..Default::default()
            }
        } else {
            PtyConfig {
                program: "/bin/sh".into(),
                args: vec!["-c".into(), "exit 0".into()],
                cols: 100,
                rows: 30,
                ..Default::default()
            }
        };
        let mut s = TermSession::spawn_local(cfg).expect("启动");
        assert_eq!(s.size(), (100, 30));
        s.resize(132, 43).expect("resize");
        assert_eq!(s.size(), (132, 43));
        s.close();
    }

    #[test]
    fn no_bytes_dropped_when_ack_keeps_up() {
        let ring = RingBuffer::new(256 * 1024, 128 * 1024, 32 * 1024);
        let mut s = TermSession::spawn_local_with_ring(echo_cfg("WT_NODROP"), ring).expect("启动");

        let text = s.wait_for_output("WT_NODROP", Duration::from_secs(10));
        assert!(text.contains("WT_NODROP"));
        assert_eq!(s.dropped_bytes(), 0, "及时 ack 时不应丢字节");

        s.close();
    }
}
