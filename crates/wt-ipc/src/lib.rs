//! IPC 数据面：会话注册表 + 拉取式二进制读取 + 事件节流。
//!
//! 设计依据：`docs/design/02-process-and-ipc.md` §3、§5。
//!
//! # 这一层要证明什么
//!
//! `design/02` 的核心假设是：**终端数据用「前端拉取二进制」而不是「后端推送 JSON」**。
//! 理由是推送无法天然背压，而拉取可以（不拉就不发）。
//!
//! 这个 crate 把该假设落成可测代码：
//! - `SessionRegistry::read` 返回**原始字节**（`Vec<u8>`），调用方无需 base64；
//! - 读出的字节计入「未确认」，`ack` 才释放背压；
//! - 未确认超过高水位时 `stats().paused == true`，UI 应停止拉取。
//!
//! Tauri 层只需要把这三个方法包成 `#[tauri::command]`，二进制直通由
//! `tauri::ipc::Response` 负责（`design/02` §3.4，M0/S1 待实测）。

#![forbid(unsafe_code)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use wt_common::WtError;
use wt_term::TerminalSession;

/// 不透明的会话句柄。
///
/// 用随机 ID 而不是自增整数：前端能构造出的 ID 越可预测，越容易触发「越权访问
/// 别的会话」这类问题（`design/02` §6.1）。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SessionHandle(String);

impl SessionHandle {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<&str> for SessionHandle {
    fn from(s: &str) -> Self {
        Self(s.to_string())
    }
}

impl From<String> for SessionHandle {
    fn from(s: String) -> Self {
        Self(s)
    }
}

impl std::fmt::Display for SessionHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// 会话的可观测状态。UI 用它决定「是否继续拉取」与「是否显示告警」。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionStats {
    pub buffered: usize,
    pub unacked: usize,
    pub paused: bool,
    pub dropped_bytes: u64,
    pub cols: u16,
    pub rows: u16,
}

/// 会话注册表。
///
/// 用 `Mutex<HashMap>` 而不是并发 map：会话数最多几十，锁竞争可以忽略；
/// 而 `TerminalSession` 的方法都是 `&mut self`，并发 map 也帮不上忙。
#[derive(Default)]
pub struct SessionRegistry {
    sessions: Mutex<HashMap<String, Box<dyn TerminalSession>>>,
    next_id: AtomicU64,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 注册一个会话，返回句柄。
    pub fn register(&self, session: Box<dyn TerminalSession>) -> SessionHandle {
        let n = self.next_id.fetch_add(1, Ordering::Relaxed);
        // 句柄里混入进程内序号 + 时间戳，避免前端猜到别的会话
        let id = format!(
            "s{}-{:x}",
            n,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        self.sessions.lock().unwrap().insert(id.clone(), session);
        SessionHandle(id)
    }

    /// 拉取最多 `max` 字节。**返回原始字节**，不做任何编码。
    ///
    /// 空返回表示当前没有数据——UI 应当等下一帧再拉，而不是忙轮询。
    pub fn read(&self, h: &SessionHandle, max: usize) -> Result<Vec<u8>, WtError> {
        let mut map = self.sessions.lock().unwrap();
        let s = map.get_mut(h.as_str()).ok_or_else(|| unknown(h))?;
        let mut out = Vec::new();
        s.read_into(&mut out, max);
        Ok(out)
    }

    /// 确认已处理 `n` 字节。
    pub fn ack(&self, h: &SessionHandle, n: usize) -> Result<(), WtError> {
        let mut map = self.sessions.lock().unwrap();
        let s = map.get_mut(h.as_str()).ok_or_else(|| unknown(h))?;
        s.ack(n);
        Ok(())
    }

    pub fn write(&self, h: &SessionHandle, data: &[u8]) -> Result<(), WtError> {
        let mut map = self.sessions.lock().unwrap();
        let s = map.get_mut(h.as_str()).ok_or_else(|| unknown(h))?;
        s.write(data)
    }

    pub fn resize(&self, h: &SessionHandle, cols: u16, rows: u16) -> Result<(), WtError> {
        let mut map = self.sessions.lock().unwrap();
        let s = map.get_mut(h.as_str()).ok_or_else(|| unknown(h))?;
        s.resize(cols, rows)
    }

    /// 本地 shell 的进程号；远端会话或已释放的子进程返回 `None`。
    ///
    /// 只用于「关标签时确认」（`TER-018`）：调用方拿它去数子孙进程，
    /// 有前台命令在跑才弹确认框。
    pub fn child_pid(&self, h: &SessionHandle) -> Option<u32> {
        let map = self.sessions.lock().ok()?;
        map.get(h.as_str())?.child_pid()
    }

    pub fn stats(&self, h: &SessionHandle) -> Result<SessionStats, WtError> {
        let map = self.sessions.lock().unwrap();
        let s = map.get(h.as_str()).ok_or_else(|| unknown(h))?;
        let (cols, rows) = s.size();
        Ok(SessionStats {
            buffered: s.buffered(),
            unacked: s.unacked(),
            paused: s.is_paused(),
            dropped_bytes: s.dropped_bytes(),
            cols,
            rows,
        })
    }

    /// 关闭并移除会话。幂等：句柄不存在时静默返回。
    ///
    /// **先把条目取出来、松开锁，再关闭。** `close()` 要杀子进程、释放 ConPTY，
    /// 可能慢；而 `if let Some(s) = self.sessions.lock().unwrap().remove(..)` 这种写法
    /// 会让零时锁活到整个 `if let` 结束——等于攥着注册表的锁去关终端，
    /// 期间所有会话操作（开终端、读写、统计）全排队，表现是「关掉几个标签之后，
    /// 再开终端/建连一直卡住」。
    pub fn close(&self, h: &SessionHandle) {
        let removed = self.sessions.lock().unwrap().remove(h.as_str());
        if let Some(mut s) = removed {
            s.close();
        }
    }

    pub fn len(&self) -> usize {
        self.sessions.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

fn unknown(h: &SessionHandle) -> WtError {
    WtError::new("IPC_UNKNOWN_HANDLE")
        .message(format!("会话句柄 {h} 不存在或已关闭"))
        .hint(
            "重新连接会话",
            wt_common::HintAction::ApplyFix {
                fix: "session.reconnect".into(),
            },
        )
}

/// 事件节流器：同一类事件在 `min_interval` 内只放行一次。
///
/// `design/02` §3.3 要求传输进度至少 500 ms、隧道统计至少 1000 ms 节流——
/// 1000 个小文件若不节流会产生数万条事件，前端会被 JSON 解析拖死。
#[derive(Debug)]
pub struct Throttle {
    min_interval: std::time::Duration,
    last: Mutex<Option<std::time::Instant>>,
}

impl Throttle {
    pub fn new(min_interval: std::time::Duration) -> Self {
        Self {
            min_interval,
            last: Mutex::new(None),
        }
    }

    /// 是否应当放行本次事件（会推进计时）。
    pub fn allow(&self) -> bool {
        let now = std::time::Instant::now();
        let mut last = self.last.lock().unwrap();
        match *last {
            Some(t) if now.duration_since(t) < self.min_interval => false,
            _ => {
                *last = Some(now);
                true
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use wt_term::pty::PtyConfig;
    use wt_term::TermSession;

    fn echo_session(marker: &str) -> TermSession {
        let cfg = if cfg!(windows) {
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
        };
        TermSession::spawn_local(cfg).expect("启动会话")
    }

    /// 轮询拉取直到出现目标文本。模拟 UI 的「每帧拉一次」。
    fn pull_until(reg: &SessionRegistry, h: &SessionHandle, needle: &str, timeout: Duration) -> String {
        let deadline = std::time::Instant::now() + timeout;
        let mut acc = Vec::new();
        while std::time::Instant::now() < deadline {
            let chunk = reg.read(h, 64 * 1024).expect("read");
            if !chunk.is_empty() {
                reg.ack(h, chunk.len()).expect("ack");
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

    #[test]
    fn read_returns_raw_bytes_and_ack_drives_backpressure() {
        let reg = SessionRegistry::new();
        let h = reg.register(Box::new(echo_session("WT_IPC_OK")));

        let text = pull_until(&reg, &h, "WT_IPC_OK", Duration::from_secs(10));
        assert!(text.contains("WT_IPC_OK"), "应拿到原始输出，实际: {text:?}");

        // 拉取+ack 之后不应处于暂停状态
        let stats = reg.stats(&h).expect("stats");
        assert!(!stats.paused, "及时 ack 后不应暂停");
        assert_eq!(stats.dropped_bytes, 0, "不应丢字节");

        reg.close(&h);
        assert!(reg.is_empty());
    }

    #[test]
    fn read_without_ack_accumulates_unacked_then_ack_clears() {
        let reg = SessionRegistry::new();
        let h = reg.register(Box::new(echo_session("WT_IPC_BP")));

        // 先拉一次但**不** ack
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut got = 0usize;
        while std::time::Instant::now() < deadline && got == 0 {
            let chunk = reg.read(&h, 4096).expect("read");
            got = chunk.len();
            if got == 0 {
                std::thread::sleep(Duration::from_millis(15));
            }
        }
        assert!(got > 0, "应至少读到一些字节");

        // 未 ack 时未确认字节必须如实反映——字段存在但永远报 0 就是静默失效
        let stats = reg.stats(&h).expect("stats");
        assert_eq!(stats.unacked, got, "未确认字节数应等于刚投递的量");

        reg.ack(&h, got).expect("ack");
        let stats = reg.stats(&h).expect("stats");
        assert_eq!(stats.unacked, 0, "ack 后应清零");
        assert!(!stats.paused);

        reg.close(&h);
    }

    #[test]
    fn unknown_handle_is_rejected_with_actionable_error() {
        let reg = SessionRegistry::new();
        let fake = SessionHandle("nope".into());

        let err = reg.read(&fake, 10).unwrap_err();
        assert_eq!(err.code, "IPC_UNKNOWN_HANDLE");
        assert!(err.hints.iter().any(|h| h.label.contains("重新连接")));

        assert_eq!(reg.ack(&fake, 1).unwrap_err().code, "IPC_UNKNOWN_HANDLE");
        assert_eq!(reg.write(&fake, b"x").unwrap_err().code, "IPC_UNKNOWN_HANDLE");
        // close 对未知句柄是幂等的
        reg.close(&fake);
    }

    #[test]
    fn handles_are_unguessable() {
        let reg = SessionRegistry::new();
        let a = reg.register(Box::new(echo_session("A")));
        let b = reg.register(Box::new(echo_session("B")));
        assert_ne!(a, b);
        assert!(a.as_str().len() > 8, "句柄不应是可猜的短整数");
        assert!(!a.as_str().chars().all(|c| c.is_ascii_digit()));
        reg.close(&a);
        reg.close(&b);
    }

    #[test]
    fn resize_goes_through_registry() {
        let reg = SessionRegistry::new();
        let h = reg.register(Box::new(echo_session("R")));
        reg.resize(&h, 132, 43).expect("resize");
        let stats = reg.stats(&h).expect("stats");
        assert_eq!((stats.cols, stats.rows), (132, 43));
        reg.close(&h);
    }

    #[test]
    fn throttle_allows_first_then_blocks_within_window() {
        let t = Throttle::new(Duration::from_millis(100));
        assert!(t.allow(), "首次应放行");
        assert!(!t.allow(), "窗口内应拦截");
        assert!(!t.allow());
        std::thread::sleep(Duration::from_millis(120));
        assert!(t.allow(), "超过窗口应再次放行");
    }

    #[test]
    fn throttle_with_zero_interval_always_allows() {
        let t = Throttle::new(Duration::ZERO);
        assert!(t.allow());
        assert!(t.allow());
    }
}
