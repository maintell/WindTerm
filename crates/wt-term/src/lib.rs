//! 终端子系统的传输侧组件：环形缓冲（含背压）与 ANSI 剥离。
//!
//! 设计依据：`docs/design/03-terminal-subsystem.md` §4、§8。
//!
//! **本 crate 不做 VT 网格**（ADR-0004）：渲染与解析在前端 xterm.js。
//! 这里只负责两件 Rust 侧必须做的事：
//! 1. 把字节流缓冲好，并用「未确认字节数」驱动背压，保证**不丢字节**（`NFR-003`）；
//! 2. 把转义序列剥掉，产出可读的纯文本日志（`TER-015`）。
//!
//! 这两件事都不需要理解光标与字符宽度，因此可以在没有网格的前提下正确工作。

#![forbid(unsafe_code)]

pub mod pty;
pub mod session;

pub use session::{TermSession, TerminalSession};

// ═══════════════════════════════════════════════════════════
// 环形缓冲
// ═══════════════════════════════════════════════════════════

/// 一次写入的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PushOutcome {
    /// 因容量不足被丢弃的**最旧**字节数。
    pub dropped_bytes: u64,
    /// 被丢弃部分中的换行数（用于告诉用户「丢了大约 N 行」）。
    pub dropped_newlines: u64,
}

impl PushOutcome {
    pub fn is_lossless(&self) -> bool {
        self.dropped_bytes == 0
    }
}

/// 固定容量的字节环形缓冲。
///
/// 为什么不用 `VecDeque<u8>`：`VecDeque` 取连续段要 `make_contiguous`（会拷贝），
/// 而终端在 20 MB/s 下这点拷贝会累积成可观的 CPU。固定数组 + head/len 可以零拷贝取出连续段。
#[derive(Debug)]
pub struct RingBuffer {
    buf: Box<[u8]>,
    head: usize,
    len: usize,
    /// 已投递给前端但尚未 ack 的字节数
    unacked: usize,
    high_water: usize,
    low_water: usize,
    paused: bool,
    dropped_bytes: u64,
    dropped_newlines: u64,
}

impl RingBuffer {
    /// `capacity` 必须 > 0；`high_water`/`low_water` 会被夹到 `capacity` 以内。
    ///
    /// 默认值（`design/02` §5.2）：容量 4 MB、高水位 2 MB、低水位 512 KB。
    pub fn new(capacity: usize, high_water: usize, low_water: usize) -> Self {
        assert!(capacity > 0, "环形缓冲容量必须大于 0");
        let high = high_water.clamp(1, capacity);
        let low = low_water.clamp(1, high);
        Self {
            buf: vec![0u8; capacity].into_boxed_slice(),
            head: 0,
            len: 0,
            unacked: 0,
            high_water: high,
            low_water: low,
            paused: false,
            dropped_bytes: 0,
            dropped_newlines: 0,
        }
    }

    /// 生产默认：4 MB 容量、2 MB / 512 KB 水位。
    pub fn with_defaults() -> Self {
        Self::new(4 * 1024 * 1024, 2 * 1024 * 1024, 512 * 1024)
    }

    pub fn capacity(&self) -> usize {
        self.buf.len()
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn unacked(&self) -> usize {
        self.unacked
    }

    pub fn dropped_bytes(&self) -> u64 {
        self.dropped_bytes
    }

    pub fn dropped_newlines(&self) -> u64 {
        self.dropped_newlines
    }

    /// 是否应暂停从 socket/PTY 读取（背压）。
    pub fn is_paused(&self) -> bool {
        self.paused
    }

    /// 写入数据。容量不足时丢弃**最旧**的数据（保新不保旧：运维看日志时最新最重要）。
    pub fn push(&mut self, data: &[u8]) -> PushOutcome {
        let mut outcome = PushOutcome::default();
        if data.is_empty() {
            return outcome;
        }

        // 单次写入超过容量：只保留尾部
        if data.len() > self.buf.len() {
            let keep = self.buf.len();
            let drop_part = &data[..data.len() - keep];
            outcome.dropped_bytes = drop_part.len() as u64;
            outcome.dropped_newlines = count_newlines(drop_part);
            // 先把已有内容全部丢掉，再写入尾部
            self.clear_all_data();
            self.write_bytes(&data[data.len() - keep..]);
            self.record_drop(&outcome);
            self.update_pause();
            return outcome;
        }

        let overflow = (self.len + data.len()).saturating_sub(self.buf.len());
        if overflow > 0 {
            // 从头部丢弃 overflow 字节
            let (a, b) = self.dropped_prefix(overflow);
            outcome.dropped_bytes = overflow as u64;
            outcome.dropped_newlines = a + b;
            self.head = (self.head + overflow) % self.buf.len();
            self.len -= overflow;
            // 被丢弃的数据也应当从未确认计数中扣除（它永远不会被 ack 了）
            self.unacked = self.unacked.saturating_sub(overflow);
        }

        self.write_bytes(data);
        self.record_drop(&outcome);
        self.update_pause();
        outcome
    }

    fn record_drop(&mut self, outcome: &PushOutcome) {
        self.dropped_bytes += outcome.dropped_bytes;
        self.dropped_newlines += outcome.dropped_newlines;
    }

    fn dropped_prefix(&self, n: usize) -> (u64, u64) {
        // 统计将被丢弃的 n 字节中的换行数（最多两段）
        let cap = self.buf.len();
        let first = n.min(cap - self.head);
        let nl1 = count_newlines(&self.buf[self.head..self.head + first]);
        let rest = n - first;
        let nl2 = if rest > 0 {
            count_newlines(&self.buf[..rest])
        } else {
            0
        };
        (nl1, nl2)
    }

    fn clear_all_data(&mut self) {
        self.head = 0;
        self.len = 0;
        self.unacked = 0;
    }

    fn write_bytes(&mut self, data: &[u8]) {
        let cap = self.buf.len();
        let tail = (self.head + self.len) % cap;
        let first = data.len().min(cap - tail);
        self.buf[tail..tail + first].copy_from_slice(&data[..first]);
        if first < data.len() {
            let rest = data.len() - first;
            self.buf[..rest].copy_from_slice(&data[first..]);
        }
        self.len += data.len();
    }

    /// 取最多 `max` 字节追加到 `out`，返回实际取出的字节数。
    ///
    /// 取出即计入「未确认」，直到调用 [`ack`](Self::ack)。
    pub fn read_into(&mut self, out: &mut Vec<u8>, max: usize) -> usize {
        let n = max.min(self.len);
        if n == 0 {
            return 0;
        }
        let cap = self.buf.len();
        let first = n.min(cap - self.head);
        out.extend_from_slice(&self.buf[self.head..self.head + first]);
        if first < n {
            out.extend_from_slice(&self.buf[..n - first]);
        }
        self.head = (self.head + n) % cap;
        self.len -= n;
        self.unacked += n;
        self.update_pause();
        n
    }

    /// 前端确认已处理 `n` 字节。
    pub fn ack(&mut self, n: usize) {
        self.unacked = self.unacked.saturating_sub(n);
        self.update_pause();
    }

    /// 水位滞回：超过高水位暂停，低于低水位恢复。用两个阈值避免临界点反复抖动。
    fn update_pause(&mut self) {
        if self.unacked >= self.high_water {
            self.paused = true;
        } else if self.unacked <= self.low_water {
            self.paused = false;
        }
    }

    pub fn high_water(&self) -> usize {
        self.high_water
    }

    pub fn low_water(&self) -> usize {
        self.low_water
    }
}

fn count_newlines(bytes: &[u8]) -> u64 {
    bytes.iter().filter(|b| **b == b'\n').count() as u64
}

// ═══════════════════════════════════════════════════════════
// ANSI 剥离
// ═══════════════════════════════════════════════════════════

/// 剥离转义序列，产出纯文本。
///
/// **只做剥离，不解释语义**——所以不需要网格，也不需要处理宽字符。
/// 状态机跨 chunk 保留，因此可以对着流式数据增量调用。
#[derive(Debug, Default)]
pub struct AnsiStripper {
    state: State,
    /// OSC/DCS 内已积累的长度，用于防止未终止序列耗尽内存
    osc_len: usize,
    /// 上一次输出是否刚产生过内容（用于可选地合并 \r）
    _priv: (),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum State {
    #[default]
    Ground,
    /// 收到 ESC
    Esc,
    /// ESC 后跟中间字节（0x20..=0x2F），还需再吃一个终止字节。
    /// 例：`ESC ( B`（选择 ASCII 字符集）是**三字节**序列，只吃两个会把 `B` 当正文输出。
    EscIntermediate,
    /// ESC [ （CSI）
    Csi,
    /// ESC ] （OSC）
    Osc,
    /// OSC 内收到 ESC（可能是 ST 的前半）
    OscEsc,
    /// ESC P （DCS）
    Dcs,
    /// DCS 内收到 ESC
    DcsEsc,
}

/// 未终止的 OSC/DCS 超过该长度即放弃（防止恶意/损坏数据把内存吃光）。
const MAX_CONTROL_STRING: usize = 8 * 1024;

impl AnsiStripper {
    pub fn new() -> Self {
        Self::default()
    }

    /// 喂入一段字节，把可读文本追加到 `out`。返回本次追加的字节数。
    pub fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> usize {
        let before = out.len();

        for &b in input {
            match self.state {
                State::Ground => match b {
                    0x1b => self.state = State::Esc,
                    // 8 位 C1 控制符（部分老设备会用）一并剥离
                    0x90 => {
                        self.state = State::Dcs;
                        self.osc_len = 0;
                    }
                    0x9d => {
                        self.state = State::Osc;
                        self.osc_len = 0;
                    }
                    // 其余 C0 控制符（\r \n \t 等）保留：日志里它们有意义
                    _ => out.push(b),
                },

                State::Esc => match b {
                    b'[' => self.state = State::Csi,
                    b']' => {
                        self.state = State::Osc;
                        self.osc_len = 0;
                    }
                    b'P' => {
                        self.state = State::Dcs;
                        self.osc_len = 0;
                    }
                    // 中间字节（0x20..=0x2F）：后面还有一个终止字节
                    0x20..=0x2f => self.state = State::EscIntermediate,
                    // 其余为两字节转义（ESC = / ESC > 等），到此结束
                    _ => self.state = State::Ground,
                },

                // ESC 中间字节之后只差一个终止字节，吞掉即回到 Ground
                State::EscIntermediate => self.state = State::Ground,

                State::Csi => {
                    // CSI 以 0x40..=0x7e 的「终止字节」结束
                    if (0x40..=0x7e).contains(&b) {
                        self.state = State::Ground;
                    }
                    // 参数与中间字节继续吞
                }

                State::Osc => {
                    if b == 0x07 {
                        // BEL 终止
                        self.state = State::Ground;
                        self.osc_len = 0;
                    } else if b == 0x1b {
                        self.state = State::OscEsc;
                    } else {
                        self.osc_len += 1;
                        if self.osc_len > MAX_CONTROL_STRING {
                            // 放弃这个序列，回到 Ground，避免无限吞数据
                            self.state = State::Ground;
                            self.osc_len = 0;
                        }
                    }
                }

                State::OscEsc => {
                    if b == b'\\' {
                        self.state = State::Ground;
                        self.osc_len = 0;
                    } else {
                        // ESC 后面不是 \：回到 OSC 继续
                        self.state = State::Osc;
                        self.osc_len += 1;
                    }
                }

                State::Dcs => {
                    if b == 0x1b {
                        self.state = State::DcsEsc;
                    } else {
                        self.osc_len += 1;
                        if self.osc_len > MAX_CONTROL_STRING {
                            self.state = State::Ground;
                            self.osc_len = 0;
                        }
                    }
                }

                State::DcsEsc => {
                    if b == b'\\' {
                        self.state = State::Ground;
                        self.osc_len = 0;
                    } else {
                        self.state = State::Dcs;
                        self.osc_len += 1;
                    }
                }
            }
        }

        out.len() - before
    }

    /// 便捷方法：一次性剥离。
    pub fn strip(input: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(input.len());
        let mut s = Self::new();
        s.feed(input, &mut out);
        out
    }
}

#[cfg(test)]
mod ring_tests {
    use super::*;

    #[test]
    fn push_and_read_roundtrip() {
        let mut rb = RingBuffer::new(64, 32, 8);
        assert!(rb.push(b"hello").is_lossless());

        let mut out = Vec::new();
        assert_eq!(rb.read_into(&mut out, 64), 5);
        assert_eq!(out, b"hello");
        assert!(rb.is_empty());
        assert_eq!(rb.unacked(), 5);
    }

    #[test]
    fn read_respects_max() {
        let mut rb = RingBuffer::new(64, 32, 8);
        rb.push(b"0123456789");
        let mut out = Vec::new();
        assert_eq!(rb.read_into(&mut out, 4), 4);
        assert_eq!(out, b"0123");
        assert_eq!(rb.len(), 6);

        out.clear();
        assert_eq!(rb.read_into(&mut out, 100), 6);
        assert_eq!(out, b"456789");
    }

    #[test]
    fn wraparound_preserves_order() {
        // 每轮写 5 读 5，head 持续推进 → 必然跨过容量边界回绕。
        // 容量 16、每轮 5 字节：head 走 0,5,10,15,4,9,14,3,8,13 —— 多次回绕。
        let mut rb = RingBuffer::new(16, 16, 2);
        for round in 0..10u8 {
            rb.push(&[round; 5]);
            let mut out = Vec::new();
            assert_eq!(rb.read_into(&mut out, 5), 5);
            assert_eq!(out, vec![round; 5], "第 {round} 轮读出的内容不对");
            rb.ack(5);
            assert!(rb.is_empty());
        }
        assert_eq!(rb.dropped_bytes(), 0, "这种读写节奏不应触发溢出");
    }

    #[test]
    fn cross_boundary_read_returns_two_segments_in_order() {
        // 先把 head 推到接近尾部，使一次读取跨边界
        let mut rb = RingBuffer::new(8, 8, 2);
        let mut out = Vec::new();
        rb.push(b"abc");
        rb.read_into(&mut out, 3);
        rb.ack(3);
        out.clear();

        // 此时 head=3；写 6 字节会占 3..8 与 0..1
        rb.push(b"defghi");
        assert_eq!(rb.read_into(&mut out, 6), 6);
        assert_eq!(out, b"defghi", "跨边界的读取顺序必须正确");
    }

    #[test]
    fn ack_reduces_unacked_and_saturates() {
        let mut rb = RingBuffer::new(64, 32, 8);
        rb.push(b"abcdef");
        let mut out = Vec::new();
        rb.read_into(&mut out, 6);
        assert_eq!(rb.unacked(), 6);

        rb.ack(4);
        assert_eq!(rb.unacked(), 2);

        rb.ack(100); // 多确认不应下溢
        assert_eq!(rb.unacked(), 0);
    }

    #[test]
    fn backpressure_pauses_at_high_water_and_resumes_at_low() {
        let mut rb = RingBuffer::new(1024, 100, 20);
        rb.push(&[b'x'; 500]);
        assert!(!rb.is_paused(), "未确认为 0，不应暂停");

        let mut out = Vec::new();
        rb.read_into(&mut out, 500);
        assert!(rb.is_paused(), "未确认 500 ≥ 高水位 100，应暂停");

        // 降到低水位之上：仍暂停（滞回，避免抖动）
        rb.ack(400);
        assert_eq!(rb.unacked(), 100);
        assert!(rb.is_paused(), "刚好等于高水位仍暂停");

        rb.ack(90); // 剩 10 ≤ 低水位 20
        assert!(!rb.is_paused(), "低于低水位应恢复");
    }

    #[test]
    fn overflow_drops_oldest_and_keeps_newest() {
        let mut rb = RingBuffer::new(8, 8, 2);
        rb.push(b"AAAA");
        let outcome = rb.push(b"BBBBBB"); // 需要 10 > 8，丢最旧 2 字节
        assert_eq!(outcome.dropped_bytes, 2);

        let mut out = Vec::new();
        rb.read_into(&mut out, 100);
        assert_eq!(out, b"AABBBBBB", "应保新不保旧");
        assert_eq!(rb.dropped_bytes(), 2);
    }

    #[test]
    fn overflow_counts_dropped_newlines() {
        let mut rb = RingBuffer::new(8, 8, 2);
        rb.push(b"a\nb\nc\n"); // 6 字节，2 个换行
        let outcome = rb.push(b"dddd"); // 6+4=10 > 8，丢最旧 2 字节 "a\n"
        assert_eq!(outcome.dropped_bytes, 2);
        assert_eq!(outcome.dropped_newlines, 1);
        assert_eq!(rb.dropped_newlines(), 1);
    }

    #[test]
    fn push_larger_than_capacity_keeps_tail() {
        let mut rb = RingBuffer::new(4, 4, 1);
        let outcome = rb.push(b"0123456789");
        assert_eq!(outcome.dropped_bytes, 6);
        let mut out = Vec::new();
        rb.read_into(&mut out, 100);
        assert_eq!(out, b"6789");
    }

    #[test]
    fn empty_push_is_noop() {
        let mut rb = RingBuffer::new(8, 4, 1);
        let o = rb.push(b"");
        assert!(o.is_lossless());
        assert!(rb.is_empty());
    }

    #[test]
    fn default_buffer_sizes_match_design() {
        let rb = RingBuffer::with_defaults();
        assert_eq!(rb.capacity(), 4 * 1024 * 1024);
        assert_eq!(rb.high_water(), 2 * 1024 * 1024);
        assert_eq!(rb.low_water(), 512 * 1024);
    }

    #[test]
    fn water_marks_are_clamped() {
        let rb = RingBuffer::new(100, 999, 999);
        assert_eq!(rb.high_water(), 100);
        assert!(rb.low_water() <= rb.high_water());
    }

    #[test]
    fn no_bytes_lost_without_overflow() {
        // 分片写入 + 分片读取 + 分片 ack，全程校验字节序
        let mut rb = RingBuffer::new(1024, 800, 100);
        let mut expected = Vec::new();
        let mut got = Vec::new();
        for i in 0..200u32 {
            let chunk: Vec<u8> = (0..37).map(|j| ((i * 37 + j) % 251) as u8).collect();
            expected.extend_from_slice(&chunk);
            rb.push(&chunk);

            let mut out = Vec::new();
            let n = rb.read_into(&mut out, 50);
            got.extend_from_slice(&out[..n]);
            rb.ack(n);
        }
        let mut out = Vec::new();
        while rb.read_into(&mut out, 64) > 0 {
            got.extend_from_slice(&out);
            let n = out.len();
            rb.ack(n);
            out.clear();
        }
        assert_eq!(got, expected, "无溢出时一个字节都不能丢");
        assert_eq!(rb.dropped_bytes(), 0);
    }
}

#[cfg(test)]
mod ansi_tests {
    use super::*;

    #[test]
    fn plain_text_passes_through() {
        assert_eq!(AnsiStripper::strip(b"hello world"), b"hello world");
    }

    #[test]
    fn strips_sgr_colors() {
        let input = b"\x1b[31mred\x1b[0m normal";
        assert_eq!(AnsiStripper::strip(input), b"red normal");
    }

    #[test]
    fn strips_256_and_truecolor() {
        let input = b"\x1b[38;5;196mX\x1b[48;2;10;20;30mY\x1b[0m";
        assert_eq!(AnsiStripper::strip(input), b"XY");
    }

    #[test]
    fn keeps_carriage_return_and_newline() {
        // 纯文本日志保留 \r：模拟覆盖需要网格，代价远超收益（design/03 §8.1）
        assert_eq!(AnsiStripper::strip(b"a\r\nb\tc"), b"a\r\nb\tc");
    }

    #[test]
    fn handles_sequence_split_across_chunks() {
        let mut s = AnsiStripper::new();
        let mut out = Vec::new();
        s.feed(b"hello \x1b[3", &mut out);
        s.feed(b"1mred\x1b[0m world", &mut out);
        assert_eq!(out, b"hello red world");
    }

    #[test]
    fn strips_osc_title_terminated_by_bel() {
        let input = b"\x1b]2;MY TITLE\x07content";
        assert_eq!(AnsiStripper::strip(input), b"content");
    }

    #[test]
    fn strips_osc_terminated_by_st() {
        let input = b"\x1b]7;file://host/path\x1b\\after";
        assert_eq!(AnsiStripper::strip(input), b"after");
    }

    #[test]
    fn osc_split_across_chunks() {
        let mut s = AnsiStripper::new();
        let mut out = Vec::new();
        s.feed(b"a\x1b]0;tit", &mut out);
        s.feed(b"le\x1b", &mut out);
        s.feed(b"\\b", &mut out);
        assert_eq!(out, b"ab");
    }

    #[test]
    fn unterminated_osc_is_abandoned_not_swallowed_forever() {
        let mut s = AnsiStripper::new();
        let mut out = Vec::new();
        s.feed(b"\x1b]0;", &mut out);
        // 灌入超过上限的垃圾
        s.feed(&vec![b'x'; MAX_CONTROL_STRING + 100], &mut out);
        // 之后必须能恢复正常输出
        s.feed(b"RECOVERED", &mut out);
        assert!(
            String::from_utf8_lossy(&out).contains("RECOVERED"),
            "未终止的 OSC 不能把后续输出一起吞掉"
        );
    }

    #[test]
    fn strips_two_byte_escapes() {
        // ESC ( B = 选择 ASCII 字符集
        assert_eq!(AnsiStripper::strip(b"a\x1b(Bb"), b"ab");
        // ESC = / ESC >
        assert_eq!(AnsiStripper::strip(b"\x1b=a\x1b>b"), b"ab");
    }

    #[test]
    fn strips_8bit_c1_osc() {
        // 0x9D 是 8 位形式的 OSC
        let input = b"a\x9d0;title\x07b";
        assert_eq!(AnsiStripper::strip(input), b"ab");
    }

    #[test]
    fn strips_dcs() {
        let input = b"a\x1bPq#0;2;0;0;0\x1b\\b";
        assert_eq!(AnsiStripper::strip(input), b"ab");
    }

    #[test]
    fn returns_written_count() {
        let mut s = AnsiStripper::new();
        let mut out = Vec::new();
        let n = s.feed(b"\x1b[31mabc\x1b[0m", &mut out);
        assert_eq!(n, 3);
    }

    #[test]
    fn handles_vim_style_output() {
        // 一段真实的 vim 重绘序列（简化）
        let input = b"\x1b[?1049h\x1b[22;0;0t\x1b[1;24r\x1b(B\x1b[m\x1b[4l\x1b[?7h\x1b[?1h\x1b=\r\nfile content\r\n\x1b[?1l\x1b>\x1b[?1049l";
        let out = AnsiStripper::strip(input);
        let text = String::from_utf8_lossy(&out);
        assert!(text.contains("file content"));
        assert!(!text.contains('\x1b'), "不应残留 ESC：{text:?}");
    }

    #[test]
    fn empty_input_is_fine() {
        let mut s = AnsiStripper::new();
        let mut out = Vec::new();
        assert_eq!(s.feed(b"", &mut out), 0);
        assert!(out.is_empty());
    }
}
