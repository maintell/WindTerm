# 详细设计 · 07 · RDP 协议栈

实现需求：`GUI-015`~`GUI-027`、`GUI-033`、`GUI-034`、`SES-005`
依赖：`IronRDP`（Apache-2.0/MIT）

## 1. 封装与线程模型

```rust
// crates/wt-rdp/src/lib.rs
pub struct RdpSession {
    cmd_tx: mpsc::Sender<RdpCommand>,
    frame_rx: watch::Receiver<FrameSlot>,
    state: watch::Receiver<RdpState>,
}

pub enum RdpCommand {
    Input(RdpInput),
    Resize { width: u32, height: u32, scale: u32 },
    Clipboard(ClipboardData),
    AudioControl(AudioAction),
    Disconnect(DisconnectReason),
}
```

### 1.1 线程划分

```
┌─────────────────────────────────────────────────────┐
│ tokio task：网络 IO                                  │
│   IronRDP 的 Framed<S> 读循环 → 产生 PDU            │
└───────────────────┬─────────────────────────────────┘
                    │ PDU（含 FastPath 更新）
┌───────────────────▼─────────────────────────────────┐
│ 专用 std::thread：解码                              │
│   update → 解码为 RGBA → 合并脏矩形 → 写入双缓冲     │
└───────────────────┬─────────────────────────────────┘
                    │ FrameSlot（watch channel）
┌───────────────────▼─────────────────────────────────┐
│ IPC：前端拉取（design/02 §3.4）                      │
└─────────────────────────────────────────────────────┘
```

**为什么解码用独立 `std::thread` 而不是 tokio task**：
EGFX 的 H.264 解码是同步 CPU 密集调用（`openh264` 的 `decode_frame`），跑在 tokio worker 上会阻塞整个 reactor，导致其他会话的 SSH 心跳延迟。必须隔离。

**为什么用 `watch` channel 而不是 `mpsc`**：
前端拉取是「取最新帧」，中间帧可以丢（画面不需要每一帧都显示）。`watch` 天然只保留最新值，且不会堆积内存。

```rust
pub struct FrameSlot {
    pub seq: u64,
    pub width: u32,
    pub height: u32,
    pub pixels: Arc<[u8]>,       // RGBA，整帧
    pub dirty: Vec<Rect>,        // 脏矩形（用于局部更新）
    pub full: bool,              // 是否整帧重绘（首帧/分辨率变化）
}
```

**双缓冲**：解码线程写 `back`，写完 `swap` 到 `front` 并通知 `watch`。这样前端读到的永远是完整帧，不会撕裂。

## 2. 连接序列

```
① TCP connect
② X.224 Connection Request（协商 PROTOCOL_SSL | PROTOCOL_HYBRID | PROTOCOL_RDP）
③ 服务端 X.224 Confirm（选定协议）
④ 若 HYBRID：TLS 握手（验证证书）→ CredSSP（NTLM + 公钥绑定）
   若 SSL：    TLS 握手
   若 RDP：     标准 RDP 安全（RC4，弱，仅在服务端强制时使用并警告）
⑤ MCS Connect Initial（携带 client core/security/network/cluster 数据）
⑥ MCS Connect Response（服务端分配 channel ID）
⑦ MCS Erect Domain / Attach User
⑧ 为每个虚拟通道发 Channel Join Request
⑨ Client Info PDU（用户名/密码/域/程序/工作目录）
⑩ Licensing（若有）
⑪ Demand Active / Confirm Active（能力协商：位图缓存、EGFX、RemoteFX）
⑫ Synchronize / Control Cooperate / Control Request Control / Font List / Font Map
⑬ 进入稳定态：FastPath 更新流 + 输入事件
```

**每一步都要有超时与诊断记录**（`SES-028` 的 RDP 版本）。

### 2.1 能力协商的关键项

```rust
pub struct ClientCapabilities {
    pub bitmap_cache: bool,          // 位图缓存 v3
    pub offscreen_cache: bool,
    pub glyph_cache: bool,
    pub bitmap_codecs: BitmapCodecs, // RemoteFX / NSCODE / JPEG
    pub egfx: Option<Egfxcaps>,      // H.264 / RemoteFX Progressive / AVC444
    pub multimon: bool,
    pub display_control: bool,
    pub surface_commands: bool,
}
```

**降级顺序**（`GUI-016`）

```
EGFX(H.264) → EGFX(RemoteFX Progressive) → RemoteFX → NSCodec → Raw Bitmap
```

每一级失败都记录原因，UI 的「连接信息」面板显示当前实际使用的编码。

## 3. 输入编码

```rust
pub enum RdpInput {
    Keyboard { scancode: u16, pressed: bool, extended: bool },
    Mouse { x: u16, y: u16, buttons: MouseButtons, wheel: i16 },
    Unicode { ch: u16, pressed: bool },       // 用于 IME 提交的字符
    Sync,                                      // 键盘状态同步
}
```

### 3.1 键盘映射

**必须用扫描码，不能用虚拟键码**：RDP 的 `Keyboard Event` PDU 传的是 PS/2 扫描码（set 1），服务端按自己的布局解释。

```ts
// 前端：从 KeyboardEvent 取扫描码
function toScancode(e: KeyboardEvent): { code: number; extended: boolean } | null {
  // e.code 是物理键（"KeyA"、"ArrowUp"），比 e.key 稳定
  // 用一张 code → scancode 表（约 120 项）
  return SCANCODE_MAP[e.code] ?? null;
}
```

**为什么不用 `e.keyCode`**：已被废弃，且在非 US 布局下不可靠。
**为什么不用 `e.key`**：`e.key` 是字符（受布局与修饰键影响），不是物理键。

**中文输入法**：组合期间不发送任何键盘事件；`compositionend` 后发送 `Unicode` 事件（`ch` 为 UTF-16 码元）。服务端 Windows 会把它当作字符输入。

**这是 RDP 中文输入的正确路径**，比模拟按键可靠得多。

### 3.2 特殊键

| 键 | 处理 |
|---|---|
| `Ctrl+Alt+Del` | 本地拦截（浏览器/OS 也拦），提供工具栏按钮发送 `Secure Attention` |
| `Ctrl+Alt+End` | 映射为远端 `Ctrl+Alt+Del` |
| `Alt+Tab` | 按 `forwardKeys` 配置决定本地/远端 |
| `Win` | 同上 |
| `Ctrl+Shift+Esc` | 转发 |

**工具栏按钮**是必须的：`Ctrl+Alt+Del` 在任何平台都无法被应用捕获（OS 级保留），只能靠显式按钮。

## 4. 画面管线

```rust
fn decode_loop(mut rx: mpsc::Receiver<Update>, slot: Arc<RwLock<FrameSlot>>) {
    let mut front = Frame::new(width, height);
    let mut back = Frame::new(width, height);

    while let Some(update) = rx.blocking_recv() {
        match update {
            Update::Bitmap(b) => blit_bitmap(&mut back, &b),
            Update::Rfx(r)  => decode_remotefx(&mut back, &r),
            Update::Egfx(e) => decode_egfx(&mut back, &e),      // 含 H.264
            Update::Surface(s) => apply_surface(&mut back, &s),
            Update::Palette(p) => update_palette(p),
            Update::Resize { w, h } => { front.resize(w, h); back.resize(w, h); mark_full(); }
        }
        // 合并脏矩形
        // 若脏区 > 60% 画面 → 标记整帧
        swap_and_publish(&mut front, &mut back, &slot);
    }
}
```

### 4.1 EGFX / H.264

```rust
fn decode_egfx(frame: &mut Frame, e: &EgfxUpdate) -> Result<()> {
    match e.codec {
        Codec::RemoteFx => decode_rfx_progressive(frame, e),
        Codec::Avc420 | Codec::Avc444 => {
            let yuv = self.h264.decode(&e.data)?;       // OpenH264
            yuv_to_rgba(frame, &yuv, e.rect)?;
        }
        Codec::Planar => decode_planar(frame, e),
        Codec::ClearCodec => decode_clear(frame, e),
    }
}
```

**OpenH264 的许可约束**（`spec/01` §5.3）：只能使用 Cisco 提供的官方二进制（其承担 MPEG-LA 专利费）。**不得自行编译**。构建脚本必须校验二进制的 SHA-256 并记录来源。

**H.264 不可用时**：设置里可关闭（`rdp.h264 = false`），自动退回 RemoteFX Progressive。UI 显示当前编码。

### 4.2 脏矩形合并

```rust
fn merge_dirty(rects: &mut Vec<Rect>, new: Rect) {
    // 1. 若 new 被已有矩形包含 → 丢弃
    // 2. 若 new 包含已有矩形 → 移除它们
    // 3. 若合并后面积不增 → 合并
    // 4. 否则追加
}
```

**上限 64 个矩形**，超过则整帧重绘（矩形过多时 `putImageData` 的调用开销超过整帧传输）。

### 4.3 前端绘制

```ts
// 只绘制脏区
for (const r of meta.rects) {
  const img = new ImageData(new Uint8ClampedArray(pixels, r.offset, r.len), r.w, r.h);
  ctx.putImageData(img, r.x, r.y);
}
```

**像素格式**：Rust 侧统一输出 **RGBA8888**（`ImageData` 期望的顺序）。IronRDP 内部可能是 BGRA 或 YUV，转换在解码线程完成，避免前端做格式转换（JS 里逐像素转换会慢 5~10 倍）。

## 5. 剪贴板（CLIPRDR）

```rust
pub enum ClipboardFormat {
    UnicodeText(String),
    Html(String),
    Png(Vec<u8>),
    Dib(Vec<u8>),
    FileList(Vec<PathBuf>),     // 走驱动器重定向，不传内容
}
```

**方向控制**（`GUI-018`）

| 配置 | 行为 |
|---|---|
| `both` | 双向 |
| `to-remote` | 只允许本地 → 远端 |
| `from-remote` | 只允许远端 → 本地 |
| `disabled` | 关闭 |

**循环抑制**：本地剪贴板变化 → 发往远端 → 远端回显同内容 → 若不做抑制会无限循环。

```rust
struct ClipboardLoopGuard {
    last_local: Option<(u64, Instant)>,   // (hash, time)
    last_remote: Option<(u64, Instant)>,
}

fn should_send_local(&mut self, hash: u64) -> bool {
    if let Some((h, t)) = self.last_remote {
        if h == hash && t.elapsed() < Duration::from_millis(500) { return false; }
    }
    self.last_local = Some((hash, Instant::now()));
    true
}
```

**大内容**：文本 > 1 MB 截断并提示；图片 > 8 MB 拒绝（RDP 的 CLIPRDR 有大小限制，且大图会阻塞通道）。

## 6. 驱动器重定向（RDPDR）

```
客户端 ←→ 服务端
  RDPDR 虚拟通道承载：
    - 设备公告（Device Announce：每类设备一个 DeviceId）
    - IRP 请求（服务端发起：Create/Read/Write/QueryDirectory/SetInformation/Close）
    - IRP 响应
```

### 6.1 实现的 IRP

| IRP | 说明 | 优先级 |
|---|---|---|
| `IRP_MJ_CREATE` | 打开文件/目录 | 必须 |
| `IRP_MJ_READ` | 读 | 必须 |
| `IRP_MJ_WRITE` | 写 | 必须 |
| `IRP_MJ_CLOSE` | 关闭 | 必须 |
| `IRP_MJ_QUERY_INFORMATION` | 属性/大小/时间 | 必须 |
| `IRP_MJ_SET_INFORMATION` | 重命名/删除/设置大小 | 必须 |
| `IRP_MJ_DIRECTORY_CONTROL` | 列目录 | 必须 |
| `IRP_MJ_QUERY_VOLUME_INFORMATION` | 卷信息（总空间/可用空间） | 必须 |
| `IRP_MJ_FLUSH_BUFFERS` | flush | 可选 |
| `IRP_MJ_DEVICE_CONTROL` | IOCTL（如查询卷位图） | 可选 |

### 6.2 已知限制（必须写进 UI）

| 限制 | 影响 | 缓解 |
|---|---|---|
| 不支持文件锁语义 | 多个程序同时写会冲突 | 提示「重定向驱动器适合传文件，不适合多进程共享」 |
| 不支持 `mmap` | 数据库/大型应用会退化为慢速 IO | 同上 |
| 随机读写性能差 | 每块都要一次 IRP 往返 | 增大读缓存（默认 256 KB） |
| 路径长度限制 | 长路径可能失败 | 用 `\\?\` 前缀（Windows 端） |

**UI 提示**：会话设置里驱动器重定向下方一行小字：「重定向驱动器通过 RDP 通道传输文件，适合拷贝文件；运行数据库或大型程序会明显变慢」。

## 7. 音频（RDPSND）

```rust
pub enum AudioAction { Enable, Disable, Volume(u8) }
```

- 只实现播放（PCM → 系统音频输出），录音重定向 P3。
- 后端：`cpal` crate。
- 格式协商：优先 `PCM 44100 16bit stereo`，服务端不支持则回退。
- **缓冲**：200 ms 环形缓冲；不足时静默补零（避免爆音），溢出时丢最旧（避免延迟累积）。

## 8. 显示器控制（`GUI-024`）

```rust
pub struct MonitorLayout {
    pub monitors: Vec<Monitor>,
    pub primary: usize,
}

pub struct Monitor {
    pub left: i32, pub top: i32,
    pub width: u32, pub height: u32,
    pub scale: u32,          // 100 / 125 / 150 / 175 / 200
    pub orientation: Orientation,
}
```

**动态分辨率**：窗口尺寸变化 → 去抖 300 ms → 发送 `DISPLAYCONTROL_MONITOR_LAYOUT`。服务端会返回新的位图尺寸。

**为什么去抖 300 ms**：拖动窗口时每帧都发会让服务端反复重建桌面，画面会闪烁数秒。

## 9. 证书校验（`GUI-034`）

```rust
pub struct CertInfo {
    pub subject: String,
    pub issuer: String,
    pub not_before: SystemTime,
    pub not_after: SystemTime,
    pub sha256: String,
    pub self_signed: bool,
    pub chain_valid: bool,
}

pub enum CertDecision {
    TrustOnce,
    TrustAndRemember { host: String, port: u16, sha256: String },
    Reject,
}
```

**规则**

1. 证书链有效且主机名匹配 → 直接通过，不打扰用户。
2. 自签/不受信 → 弹出对话框，展示 `CertInfo`，要求 `TrustOnce` 或 `TrustAndRemember`。
3. **没有**「永久忽略所有证书错误」的全局开关。
4. 已记住的指纹与当前不符 → 视为「变更」，红色阻断，需删除旧记录才能继续。

**存储**：`<config-dir>/trusted_certs.json`（不是保险库——证书指纹不是秘密，且需要可审计）。

## 10. 重连（`GUI-033`）

```rust
pub struct AutoReconnectCookie {
    pub logon_id: u32,
    pub random_bits: [u8; 32],
}
```

服务端在连接时通过 `Save Session Info PDU` 下发。重连时在 `Client Info PDU` 的 `ARC_CS_PRIVATE_PACKET` 字段回传，服务端据此恢复会话。

**流程**

```
断开检测 → 保留 FrameSlot（画面冻结）
        → 退避重连（复用 SES-027 策略）
        → 成功：若服务端接受 ARC → 会话恢复（原桌面）
                 否则 → 新会话（提示「已建立新会话，原会话可能仍占用」）
        → 失败达上限：保留窗口，显示「已断开」+ 重试/重新登录/关闭
```

**注意**：ARC 只在「同一用户、同一服务器、短时间」内有效。超时后服务端会分配新会话。

## 11. 错误映射

| NTSTATUS / 错误 | 用户可见文案 |
|---|---|
| `0xC000006D` | 用户名或密码错误 |
| `0xC000006A` | 密码错误 |
| `0xC0000234` | 账号已被锁定 |
| `0xC0000072` | 账号已被禁用 |
| `0xC000015B` | 该账号不允许此登录类型（检查「允许通过远程桌面服务登录」策略） |
| `0xC000041D` | 服务器未启用远程桌面 |
| `0x00000000` + 立即断开 | 已达最大连接数（检查 `fSingleSessionPerUser` 或授权） |
| TLS 证书错误 | 展示证书详情（`GUI-034`） |
| NLA 协商失败 | 「服务器要求网络级身份验证，但协商失败」+ 建议开启 CredSSP |
| 协议协商失败 | 「服务器不支持所选安全协议」+ 列出双方支持的协议 |

## 12. 与需求的对应

| 设计点 | 需求 |
|---|---|
| 独立解码线程 | `NFR-005`、`NFR-006` |
| `watch` 通道 + 双缓冲 | 画面不撕裂 |
| 能力协商降级 | `GUI-016` |
| 扫描码输入 | `GUI-026` 键盘正确性 |
| Unicode 输入 | `GUI-015` `GUI-026` 中文输入（RDP 侧） |
| 脏矩形合并 | `NFR-005` |
| CLIPRDR + 循环抑制 | `GUI-018` |
| RDPDR | `GUI-017` |
| RDPSND | `GUI-025` |
| MonitorLayout | `GUI-024` |
| 证书策略 | `GUI-034` |
| ARC 重连 | `GUI-033` |
| 错误翻译 | `SES-005` AC-4 |
| CredSSP / NLA | `GUI-022` |
| 控制台会话（`/admin`） | `GUI-023` |
