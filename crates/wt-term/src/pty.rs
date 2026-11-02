//! 本地 PTY：起一个真实终端进程，把输出泵进环形缓冲。
//!
//! 设计依据：`docs/design/03-terminal-subsystem.md` §3（`TermTransport`）、§4（环形缓冲）。
//!
//! 分工：
//! - 本模块只负责「进程 ↔ 字节流」；
//! - 背压由 [`RingBuffer`] 的水位驱动——泵线程在 `is_paused()` 时 sleep，
//!   而不是无限往里塞（否则内存会被 `yes` 之类的输出吃光）。
//!
//! `portable-pty` 是同步 API（Windows 走 ConPTY），所以读循环跑在独立线程，
//! 不用 tokio task——把它塞进 async 运行时会阻塞 reactor。
//!
//! # ConPTY 必须应答的查询（踩过的坑）
//!
//! Windows 的 ConPTY 在启动后会先发 `ESC [ 6 n`（查询光标位置），**并等待终端回复**。
//! 不回它，子进程的输出就不会流出来——实测只能读到那 4 个字节。
//! 真实终端（Windows Terminal、mintty）都会应答；我们也必须应答。
//! 这里实现了最小集合：DSR(6n) → `ESC [ 1 ; 1 R`，DSR(5n) → `ESC [ 0 n`。
//!
//! **只能有一个人应答**。带图形界面的会话里 xterm.js 会自己应答，
//! 这时 PTY 层必须闭嘴（[`PtyConfig::answer_queries`] = `false`）：
//! 两个应答都写回 PTY 的话，多出来的那个 `ESC [ 1 ; 1 R` 会被 shell 的行编辑器
//! 当成未知转义序列，**连带吃掉紧跟其后的第一个字符**——现象是「首字符丢失」。
//! 无头场景（CLI、测试）没有终端仿真器，就由这一层应答。

#![forbid(unsafe_code)]

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use wt_common::{HintAction, WtError};

use crate::RingBuffer;


/// 共享写入端：会话与泵线程都要用（泵要应答 ConPTY 的查询）。
pub type SharedWriter = Arc<Mutex<Option<Box<dyn Write + Send>>>>;

/// 本地终端启动参数。
#[derive(Debug, Clone)]
pub struct PtyConfig {
    pub program: String,
    pub args: Vec<String>,
    pub cols: u16,
    pub rows: u16,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(String, String)>,
    /// 由 PTY 层自动应答 ConPTY 的 DSR 查询。
    ///
    /// 无头场景（CLI、测试）必须为 `true`，否则 ConPTY 会卡住；
    /// 接了终端仿真器（xterm.js）的图形会话必须为 `false`，否则会重复应答，
    /// 多出来的 `ESC[1;1R` 会吃掉用户输入的第一个字符。
    pub answer_queries: bool,
}

impl Default for PtyConfig {
    fn default() -> Self {
        Self {
            program: default_shell().0,
            args: default_shell().1,
            cols: 120,
            rows: 30,
            cwd: None,
            env: Vec::new(),
            answer_queries: true,
        }
    }
}

/// 平台默认 shell。
///
/// Windows 优先 `pwsh`（PowerShell 7），没有则 `powershell`；Unix 用 `$SHELL`。
/// **不默认用 WindShell**：用户的肌肉记忆与既有脚本都是针对系统 shell 的（`LOC-001`）。
pub fn default_shell() -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        if which("pwsh").is_some() {
            return ("pwsh.exe".into(), vec!["-NoLogo".into()]);
        }
        if which("powershell").is_some() {
            return ("powershell.exe".into(), vec!["-NoLogo".into()]);
        }
        ("cmd.exe".into(), Vec::new())
    }
    #[cfg(not(windows))]
    {
        let sh = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        (sh, Vec::new())
    }
}

fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
        if candidate.is_file() {
            return Some(candidate);
        }
        let plain = dir.join(name);
        if plain.is_file() {
            return Some(plain);
        }
    }
    None
}

/// 一个已启动的本地终端。
pub struct PtySession {
    /// 用 `Option` 包住是为了能在 `close()` 里**显式、按顺序**释放（见 `release_master`）。
    master: Option<Box<dyn MasterPty + Send>>,
    writer: SharedWriter,
    child: Option<Box<dyn portable_pty::Child + Send + Sync>>,
    cols: u16,
    rows: u16,
}

impl PtySession {
    pub fn spawn(cfg: &PtyConfig) -> Result<Self, WtError> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: cfg.rows.max(1),
                cols: cfg.cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| {
                WtError::new("PTY_OPEN_FAILED")
                    .message("无法创建本地终端")
                    .detail(e.to_string())
                    .hint(
                        "检查系统是否支持 ConPTY（Windows 10 1809+）",
                        HintAction::None,
                    )
            })?;

        let mut cmd = CommandBuilder::new(&cfg.program);
        for a in &cfg.args {
            cmd.arg(a);
        }
        if let Some(cwd) = &cfg.cwd {
            cmd.cwd(cwd);
        }
        for (k, v) in &cfg.env {
            cmd.env(k, v);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        let child = pair.slave.spawn_command(cmd).map_err(|e| {
            WtError::new("PTY_SPAWN_FAILED")
                .message(format!("无法启动 {}", cfg.program))
                .detail(sanitize(e.to_string()))
                .hint("确认该 shell 已安装", HintAction::None)
        })?;

        // slave 必须在 spawn 后释放，否则 Windows 上读端不会收到 EOF
        drop(pair.slave);

        let writer = pair.master.take_writer().map_err(|e| {
            WtError::new("PTY_WRITER_FAILED")
                .message("无法获取终端写入端")
                .detail(e.to_string())
        })?;

        Ok(Self {
            master: Some(pair.master),
            writer: Arc::new(Mutex::new(Some(writer))),
            child: Some(child),
            cols: cfg.cols.max(1),
            rows: cfg.rows.max(1),
        })
    }

    /// 取读取端。只能取一次。
    pub fn take_reader(&self) -> Result<Box<dyn Read + Send>, WtError> {
        let master = self
            .master
            .as_ref()
            .ok_or_else(|| WtError::new("PTY_CLOSED").message("终端已关闭"))?;
        master.try_clone_reader().map_err(|e| {
            WtError::new("PTY_READER_FAILED")
                .message("无法获取终端读取端")
                .detail(e.to_string())
        })
    }

    /// 共享写入端（给泵线程应答 ConPTY 查询用）。
    pub fn writer_handle(&self) -> SharedWriter {
        self.writer.clone()
    }

    pub fn write(&mut self, data: &[u8]) -> Result<(), WtError> {
        write_shared(&self.writer, data)
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<(), WtError> {
        let cols = cols.max(1);
        let rows = rows.max(1);
        if cols == self.cols && rows == self.rows {
            return Ok(());
        }
        let Some(master) = self.master.as_ref() else {
            return Ok(());
        };
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| {
                WtError::new("PTY_RESIZE_FAILED")
                    .message("调整终端尺寸失败")
                    .detail(e.to_string())
            })?;
        self.cols = cols;
        self.rows = rows;
        Ok(())
    }

    pub fn try_wait(&mut self) -> Option<u32> {
        match self.child.as_mut()?.try_wait() {
            Ok(Some(status)) => Some(status.exit_code()),
            _ => None,
        }
    }

    /// 只杀子进程，不动 ConPTY master。
    pub fn kill(&mut self) -> Result<(), WtError> {
        let Some(child) = self.child.as_mut() else {
            return Ok(());
        };
        child.kill().map_err(|e| {
            WtError::new("PTY_KILL_FAILED")
                .message("结束终端进程失败")
                .detail(e.to_string())
        })
    }

    /// 释放写入端（关闭后子进程会收到 EOF）。
    pub fn release_writer(&mut self) {
        if let Some(w) = self.writer.lock().unwrap().take() {
            drop(w);
        }
    }

    /// 释放子进程句柄（不再持有，不会二次 kill）。
    pub fn release_child(&mut self) {
        self.child.take();
    }

    /// 释放 ConPTY master。
    ///
    /// # 曾经的坑（G4）
    ///
    /// 早期实现里这一步会**永久阻塞**，一度误判为 `ClosePseudoConsole` 在等 conhost 退出。
    /// 真实根因是：ConPTY 启动后先发 `ESC [ 6 n` 查询光标位置并**等待应答**；
    /// 我们不回，子进程输出就完全不出来，读端永远不返回 EOF，
    /// master 析构自然等不到句柄释放 → 表现为 `drop(session)` 挂死。
    ///
    /// 补上 [`answer_queries`] 之后，输出正常、读端正常 EOF，这里就可以真实释放。
    /// 顺序仍然重要：先杀子进程、再关 master。
    pub fn release_master(&mut self) {
        self.master.take();
    }

    /// 完整关闭：杀子进程 → 释放写入端 → 释放子句柄 → 释放 master。
    pub fn close(&mut self) {
        let _ = self.kill();
        self.release_writer();
        self.release_child();
        self.release_master();
    }

    pub fn size(&self) -> (u16, u16) {
        (self.cols, self.rows)
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        self.close();
    }
}

/// portable-pty 会把 `CreateProcessW` 的原始缓冲（含 NUL 结尾）拼进错误消息，
/// 直接展示给用户会出现 `"cmd.exe\0"` 这种怪东西。这里统一清掉。
fn sanitize(msg: String) -> String {
    msg.replace('\0', "").replace("\\0", "")
}

fn write_shared(writer: &SharedWriter, data: &[u8]) -> Result<(), WtError> {
    let mut guard = writer.lock().unwrap();
    let Some(w) = guard.as_mut() else {
        return Err(WtError::new("PTY_CLOSED").message("终端已关闭"));
    };
    w.write_all(data).map_err(|e| {
        WtError::new("PTY_WRITE_FAILED")
            .message("写入终端失败")
            .detail(e.to_string())
    })?;
    w.flush().ok();
    Ok(())
}

/// 应答 ConPTY 的查询。
///
/// 目前只处理 DSR：`ESC [ 6 n`（光标位置）与 `ESC [ 5 n`（设备状态）。
/// 不回 `6n` 会让 ConPTY 卡住、子进程输出不出来——这是本模块最隐蔽的一个坑。
fn answer_queries(chunk: &[u8], writer: &SharedWriter) {
    let mut out = Vec::new();
    let mut i = 0;
    while i + 3 < chunk.len() {
        if chunk[i] == 0x1b && chunk[i + 1] == b'[' {
            match (chunk[i + 2], chunk[i + 3]) {
                (b'6', b'n') => out.extend_from_slice(b"\x1b[1;1R"),
                (b'5', b'n') => out.extend_from_slice(b"\x1b[0n"),
                _ => {}
            }
        }
        i += 1;
    }
    if !out.is_empty() {
        let _ = write_shared(writer, &out);
    }
}

/// 把 PTY 输出泵进环形缓冲的后台线程。
pub struct OutputPump {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl OutputPump {
    /// 启动泵。
    ///
    /// `writer` 用于应答 ConPTY 的查询（见 [`answer_queries`]）；
    /// `auto_answer` 为 `false` 时把应答交给上层终端仿真器（见 [`PtyConfig::answer_queries`]）；
    /// `on_data` 在每次写入后回调（可用于唤醒 UI 或计数）。
    pub fn start<F>(
        mut reader: Box<dyn Read + Send>,
        ring: Arc<Mutex<RingBuffer>>,
        writer: SharedWriter,
        auto_answer: bool,
        mut on_data: F,
    ) -> Self
    where
        F: FnMut(usize) + Send + 'static,
    {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_flag = stop.clone();

        let handle = thread::spawn(move || {
            let mut buf = [0u8; 16 * 1024];
            loop {
                if stop_flag.load(Ordering::Relaxed) {
                    break;
                }

                // 背压：未确认字节超过高水位时先不读，让内核缓冲把压力传回源头
                {
                    let guard = ring.lock().unwrap();
                    if guard.is_paused() {
                        drop(guard);
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                }

                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF：子进程退出
                    Ok(n) => {
                        if auto_answer {
                            answer_queries(&buf[..n], &writer);
                        }
                        ring.lock().unwrap().push(&buf[..n]);
                        on_data(n);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        });

        Self {
            stop,
            handle: Some(handle),
        }
    }

    /// 泵线程是否已结束。用于判断「读端是否还阻塞着」。
    pub fn is_finished(&self) -> bool {
        self.handle.as_ref().map(|h| h.is_finished()).unwrap_or(true)
    }

    /// 请求停止。
    ///
    /// **不 join**：泵线程很可能正阻塞在 `reader.read()` 上，`join()` 会永久挂住。
    pub fn request_stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }

    /// 请求停止并放弃等待。
    pub fn stop(&mut self) {
        self.request_stop();
        let _ = self.handle.take();
    }
}

impl Drop for OutputPump {
    fn drop(&mut self) {
        self.request_stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn wait_for(ring: &Arc<Mutex<RingBuffer>>, needle: &str, timeout: Duration) -> String {
        let deadline = Instant::now() + timeout;
        let mut acc = Vec::new();
        while Instant::now() < deadline {
            {
                let mut g = ring.lock().unwrap();
                let mut chunk = Vec::new();
                let n = g.read_into(&mut chunk, 64 * 1024);
                if n > 0 {
                    g.ack(n);
                    acc.extend_from_slice(&chunk);
                }
            }
            if String::from_utf8_lossy(&acc).contains(needle) {
                return String::from_utf8_lossy(&acc).to_string();
            }
            thread::sleep(Duration::from_millis(20));
        }
        String::from_utf8_lossy(&acc).to_string()
    }

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
    fn default_shell_is_detected() {
        let (program, _) = default_shell();
        assert!(!program.is_empty());
    }

    /// 把写入内容捕获到内存，用于验证应答逻辑（不依赖真实 PTY）。
    struct CaptureWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for CaptureWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn answers_conpty_cursor_query() {
        let captured = Arc::new(Mutex::new(Vec::new()));
        let writer: SharedWriter = Arc::new(Mutex::new(Some(Box::new(CaptureWriter(captured.clone())))));

        answer_queries(b"\x1b[6n", &writer);
        answer_queries(b"prefix\x1b[5nsuffix", &writer);

        let out = String::from_utf8_lossy(&captured.lock().unwrap()).to_string();
        assert!(out.contains("\x1b[1;1R"), "应应答光标位置查询，实际 {out:?}");
        assert!(out.contains("\x1b[0n"), "应应答设备状态查询，实际 {out:?}");
    }

    /// 契约：关掉 PTY 层自动应答后，由「终端仿真器」应答 DSR，输出仍要能流出来。
    ///
    /// 图形界面走的就是这条路径（xterm.js 自己会应答）。这里用轮询循环扮演仿真器：
    /// 读到 `ESC[6n` 就回 `ESC[1;1R`。
    ///
    /// 另一半（两个应答都写回去会吃掉用户输入的第一个字符）由
    /// `scripts/e2e-desktop.mjs` 端到端覆盖。
    #[cfg(windows)]
    #[test]
    fn emulator_can_own_dsr_answers() {
        let cfg = PtyConfig {
            program: "cmd.exe".into(),
            args: vec!["/c".into(), "echo WT_DSR_OK".into()],
            answer_queries: false,
            ..Default::default()
        };
        let mut session = PtySession::spawn(&cfg).expect("应能启动 PTY");
        let reader = session.take_reader().expect("应能取读取端");
        let ring = Arc::new(Mutex::new(RingBuffer::new(64 * 1024, 32 * 1024, 8 * 1024)));
        let pump =
            OutputPump::start(reader, ring.clone(), session.writer_handle(), false, |_| {});

        let deadline = Instant::now() + Duration::from_secs(10);
        let mut acc = Vec::new();
        let mut answered = false;
        while Instant::now() < deadline {
            {
                let mut g = ring.lock().unwrap();
                let mut chunk = Vec::new();
                let n = g.read_into(&mut chunk, 64 * 1024);
                if n > 0 {
                    g.ack(n);
                    acc.extend_from_slice(&chunk);
                }
            }
            let text = String::from_utf8_lossy(&acc).to_string();
            if !answered && text.contains("\x1b[6n") {
                session.write(b"\x1b[1;1R").expect("应能写回应答");
                answered = true;
            }
            if text.contains("WT_DSR_OK") {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }

        pump.request_stop();
        session.close();

        let text = String::from_utf8_lossy(&acc).to_string();
        assert!(answered, "应看到 ConPTY 的光标位置查询，实际: {text:?}");
        assert!(text.contains("WT_DSR_OK"), "仿真器应答后应读到输出，实际: {text:?}");
    }

    #[test]
    fn spawns_shell_and_pumps_output() {
        let mut session = PtySession::spawn(&echo_cfg("WT_PTY_MARKER")).expect("应能启动 PTY");
        let reader = session.take_reader().expect("应能取读取端");

        let ring = Arc::new(Mutex::new(RingBuffer::new(256 * 1024, 128 * 1024, 32 * 1024)));
        let pump = OutputPump::start(reader, ring.clone(), session.writer_handle(), true, |_| {});

        let text = wait_for(&ring, "WT_PTY_MARKER", Duration::from_secs(10));
        assert!(
            text.contains("WT_PTY_MARKER"),
            "应读到命令输出，实际: {text:?}"
        );

        pump.request_stop();
        session.close();
    }

    #[test]
    fn write_reaches_child_process() {
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

        let mut session = PtySession::spawn(&cfg).expect("启动");
        let reader = session.take_reader().expect("读取端");
        let ring = Arc::new(Mutex::new(RingBuffer::new(256 * 1024, 128 * 1024, 32 * 1024)));
        let pump = OutputPump::start(reader, ring.clone(), session.writer_handle(), true, |_| {});

        thread::sleep(Duration::from_millis(300));
        session.write(b"WT_WRITE_OK\r\n").expect("写入");

        let text = wait_for(&ring, "WT_WRITE_OK", Duration::from_secs(10));
        assert!(
            text.contains("WT_WRITE_OK"),
            "子进程应回显输入，实际: {text:?}"
        );

        pump.request_stop();
        session.close();
    }

    #[test]
    fn resize_is_applied_and_idempotent() {
        let cfg = if cfg!(windows) {
            PtyConfig {
                program: "cmd.exe".into(),
                args: vec!["/c".into(), "exit 0".into()],
                cols: 80,
                rows: 24,
                ..Default::default()
            }
        } else {
            PtyConfig {
                program: "/bin/sh".into(),
                args: vec!["-c".into(), "exit 0".into()],
                cols: 80,
                rows: 24,
                ..Default::default()
            }
        };

        let mut session = PtySession::spawn(&cfg).expect("启动");
        assert_eq!(session.size(), (80, 24));
        session.resize(120, 40).expect("resize");
        assert_eq!(session.size(), (120, 40));
        session.resize(120, 40).expect("重复 resize");
        session.close();
    }

    /// G4 的回归护栏：反复开关本地终端必须快速返回，不能阻塞。
    ///
    /// 曾经因为没应答 ConPTY 的 `ESC[6n`，关闭会永久挂住；那种情况下这个用例会超时失败。
    #[test]
    fn close_is_fast_and_repeatable() {
        let started = Instant::now();
        for i in 0..5 {
            let mut session = PtySession::spawn(&echo_cfg("WT_CLOSE")).expect("启动");
            let reader = session.take_reader().expect("读取端");
            let ring = Arc::new(Mutex::new(RingBuffer::new(64 * 1024, 32 * 1024, 8 * 1024)));
            let pump = OutputPump::start(reader, ring.clone(), session.writer_handle(), true, |_| {});
            let _ = wait_for(&ring, "WT_CLOSE", Duration::from_secs(10));
            pump.request_stop();
            session.close();
            assert!(session.size().0 > 0, "第 {i} 次关闭后仍可读尺寸");
        }
        let elapsed = started.elapsed();
        assert!(
            elapsed < Duration::from_secs(10),
            "5 次开关应在 10 秒内完成，实际 {elapsed:?}"
        );
    }}
