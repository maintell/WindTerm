# 详细设计 · 08 · VNC 与图形会话截图

实现需求：`GUI-028`~`GUI-031`、`GUI-035`、`SES-006`
已移除：`GUI-001`~`GUI-014`、`SES-007`（X11 / X Server / XDMCP），见 ADR-0012 与 `spec/04` §12.6。

## 1. 范围与一处必须解释的空白

本文只覆盖 **VNC（RFB）客户端** 与 **图形会话截图**。

RDP 在 `design/07`；X11 相关设计（provider 抽象、`x11-req`、X11 Setup 握手、剪贴板桥、X11 输入法）**已整体删除**。

**为什么保留这段说明而不是悄悄删掉**：这个仓库的历史提交里存在过完整的 X11 设计。后来者如果只看到「没有 X11」，会怀疑是漏写；写清「曾经设计过、后来因为定位冲突删了」，才能让人相信这是决策而不是疏漏。

决策依据见 ADR-0012，一句话概括：**X11 的体验上限由第三方 X Server 决定，我们无法承诺质量；而它带来的依赖成本（首次安装、GPL、平台差异）与本产品的三个前提直接冲突。**

## 2. VNC 客户端

### 2.1 为什么自研而不是用现成 crate

| 方案 | 评估 |
|---|---|
| `vnc-rs` | 覆盖面尚可，但 API 设计以「同步阻塞」为主，与我们的 tokio 架构不匹配；且对 VeNCrypt 子类型、ARD 认证支持不全 |
| 直接绑 `libvncclient` | 引入 C 依赖；且它的线程模型与我们相反（回调式） |
| **自研** | RFB 协议本身简单（约 2000 行），且我们必须精确控制「支持哪些编码/认证」——这直接对应用户可见的兼容性列表 |

自研的代价可控，收益是**兼容性清单是我们自己写的，不是猜的**。

### 2.2 协议状态机

```
Disconnected
    │ TCP connect
Connecting
    │ 读 "RFB xxx.yyy\n"（12 字节）
ProtocolVersion
    │ 发送选定版本（3.3 / 3.7 / 3.8，取 min(服务端, 我们支持)）
SecurityHandshake
    │ 3.3: 4 字节 security type（0 = 失败，附带原因字符串）
    │ 3.7: 1 字节数量 + 列表 + 我们选 1 个
    │ 3.8: 1 字节数量 + 列表 + 我们选 1 个
Authentication
    │ None / VNC Auth / VeNCrypt / ARD
ClientInit
    │ 发送 shared flag（1 字节）
ServerInit
    │ 读宽(u16)、高(u16)、像素格式(16 字节)、名称长度(u32)、名称
Ready ◄──────────────────────────────────────────┐
    │ 发送 SetPixelFormat / SetEncodings          │
    │ 发送 FramebufferUpdateRequest（增量）        │
    └─ 循环：FramebufferUpdate → 解码 → 绘制 ─────┘
```

**版本协商的两个坑**

1. 服务端可能返回 `RFB 003.889\n`（Apple 的私有版本号）。解析时只取主次版本号的前三位，其余忽略。
2. 我们声明 3.8 但服务端只支持 3.3 时，**必须按 3.3 的握手格式重来**（3.3 的 security 段是 4 字节，3.7+ 是列表）。不能混用。

### 2.3 安全类型

```rust
pub enum SecurityType {
    None,                    // 1
    VncAuth,                 // 2
    VeNCrypt(VeNCryptSub),   // 19
    AppleRemoteDesktop,      // 30
    Tight,                   // 16（TightVNC 私有，可选支持）
}

pub enum VeNCryptSub {
    Plain = 256,      // 仅允许在 TLS 之上
    TLSNone = 257,
    TLSVnc = 258,
    TLSPlain = 259,
}
```

**VNC Auth 的实现细节（最容易出错的地方）**

```rust
fn vnc_auth_response(password: &str, challenge: &[u8; 16]) -> [u8; 16] {
    let mut key = [0u8; 8];
    let bytes = password.as_bytes();
    for i in 0..8.min(bytes.len()) {
        key[i] = bytes[i];
    }
    // ⚠ 每个字节的位序必须反转：VNC 的 DES 实现把 LSB 当 MSB
    for b in key.iter_mut() {
        *b = b.reverse_bits();
    }
    des_ecb_encrypt_block(&key, challenge)
}
```

**位序反转是 VNC Auth 的必要步骤**。不做的话，任何密码都会认证失败，而且错误信息只有一句 `Authentication failed`——这类 bug 极难定位，必须写进代码注释与单测。

**密码长度**：协议只用前 8 字节，超长部分被丢弃。UI 必须在输入框下方说明，否则用户会以为密码错了。

### 2.4 编码

| 编码 | 编号 | 实现要点 |
|---|---|---|
| Raw | 0 | 直接拷贝；按矩形逐行 `memcpy` |
| CopyRect | 1 | 帧内拷贝；**必须先复制到临时区**再写回，否则重叠区域会花屏 |
| RRE | 2 | 背景色 + N 个子矩形（像素值 + x/y/w/h） |
| Hextile | 5 | 16×16 块，子编码位掩码（Raw/Solid/BgFg/AnySubrects/SubrectsColored） |
| TRLE | 15 | 瓦片（默认 16×16）+ RLE 调色板 |
| ZRLE | 16 | zlib 压缩的 TRLE；**每个瓦片是独立的 zlib 流** |
| Cursor | -239 | 伪编码，服务端推送光标形状 |
| DesktopSize | -223 | 伪编码，分辨率变化 |

**ZRLE 的解压陷阱**

```
每个瓦片 = zlib 流（可跨多个 FramebufferUpdate 分片）
```

部分服务端会把一个瓦片的 zlib 数据拆到多个更新里。实现必须维护**每瓦片独立的解压上下文**，不能假设「一次更新 = 完整流」。

用 `flate2::Decompress` 的 `decompress_vec` 增量喂数据，而不是 `read_to_end`。

**CopyRect 的重叠问题**

```
源矩形与目标矩形重叠时，逐行正序拷贝会破坏数据。
正确做法：
  1. 把源区域复制到临时缓冲
  2. 从临时缓冲写目标区域
或者按方向选择正序/逆序逐行拷贝（更快但易错）。
```

我们选**临时缓冲**：多一次拷贝，但不会错。VNC 的 CopyRect 通常用于滚动，区域不大，性能可接受。

### 2.5 像素格式

```rust
pub struct PixelFormat {
    pub bits_per_pixel: u8,   // 8/16/32
    pub depth: u8,            // 有效位数
    pub big_endian: bool,
    pub true_color: bool,
    pub red_max: u16, pub green_max: u16, pub blue_max: u16,
    pub red_shift: u8, pub green_shift: u8, pub blue_shift: u8,
}
```

**请求**：优先 `32bpp / depth 24 / little-endian / true-color / 8-8-8`，这样解码后就是 RGBA，前端零转换。

**降级**：服务端只支持 16bpp 时，在 Rust 侧转换（`rgb565 → rgba8888`）。绝不让前端做逐像素转换——JS 里这比 Rust 慢 5~10 倍。

**大端序**：少数服务端（老 Solaris）用 big-endian，必须按 `big_endian` 字段做字节交换。

### 2.6 渲染

```ts
// 与 RDP 共用 canvas 管线，但 RFB 的更新本身就是矩形列表，不需要脏矩形合并
for (const rect of update.rects) {
  const img = new ImageData(new Uint8ClampedArray(rect.pixels), rect.w, rect.h);
  ctx.putImageData(img, rect.x, rect.y);
}
```

**双缓冲**：Rust 侧维护 `front` / `back` 两块帧缓冲，一次 `FramebufferUpdate` 的全部矩形应用完再 `swap`，避免「画了一半」的撕裂。

**带宽优化**

| 手段 | 说明 |
|---|---|
| 增量请求 | 只在上一帧处理完后发新的 `FramebufferUpdateRequest`（`incremental=1`），天然背压 |
| 请求节流 | 若解码/绘制跟不上，降低请求频率（而不是堆积请求） |
| 编码优先级 | 声明顺序影响服务端选择：`ZRLE > Hextile > CopyRect > Raw` |

### 2.7 缩放

```ts
canvas.style.width  = `${displayW}px`;   // CSS 尺寸（缩放后）
canvas.style.height = `${displayH}px`;
canvas.width  = fbW;                     // 帧缓冲原始尺寸
canvas.height = fbH;
ctx.imageSmoothingEnabled = smooth;      // 平滑=双线性；否则最近邻
```

**为什么用 CSS 缩放**：GPU 加速，零 CPU 成本。代价是文字会模糊——提供「最近邻」选项给需要锐利文字的用户。

**1:1 模式**：`displayW = fbW`，此时若窗口小于帧缓冲，外层容器滚动。

### 2.8 只读模式

```rust
if self.view_only {
    // 丢弃全部输入事件，但仍发送 FramebufferUpdateRequest
    return;
}
```

UI 显示「只读」角标，并在悬停时说明「此会话为只读，键鼠事件不会发送到远端」。

### 2.9 错误映射

| 情况 | 用户可见文案 |
|---|---|
| 版本字符串非法 | 「服务端返回的协议版本无法识别（收到 `XXX`）」 |
| 无共同安全类型 | 「服务端提供的认证方式都不受支持：列出双方列表」 |
| 认证失败 | 「VNC 密码错误」+ 提示「VNC 只使用密码前 8 个字符」 |
| 无共同编码 | 「服务端不支持任何可用的图像编码」+ 列出双方支持 |
| TLS 证书错误 | 展示证书详情，要求显式信任（与 RDP 同一套策略） |
| 服务端主动断开 | 显示原因字符串（若有） |

## 3. 图形会话截图（`GUI-035`）

```rust
pub fn capture(handle: SessionHandle, rect: Option<Rect>) -> Result<Vec<u8>> {
    // 直接从 Rust 侧的 front 帧缓冲取像素，不经过前端 canvas
    let frame = sessions.front_frame(handle)?;
    let region = rect.unwrap_or(frame.bounds());
    Ok(encode_png(frame.crop(region)))
}
```

**为什么从 Rust 侧取而不是 `canvas.toDataURL()`**

| 方式 | 问题 |
|---|---|
| `canvas.toDataURL()` | ① 需要前端把 base64 传回 Rust 落盘，多一次大字符串 IPC；② WebGL 上下文在某些情况下返回空白（`preserveDrawingBuffer: false`） |
| 从帧缓冲取 | 像素本来就在 Rust 里，直接编码 PNG，零额外传输 |

**输出**：复制到剪贴板（PNG）/ 保存到文件。默认文件名含会话名与时间戳。

## 4. 与需求的对应

| 设计点 | 需求 |
|---|---|
| RFB 状态机与版本协商 | `GUI-028` AC-1 |
| 安全类型（含 DES 位序反转） | `GUI-029` |
| 编码实现与 ZRLE 增量解压 | `GUI-028` AC-2 |
| CopyRect 临时缓冲 | 画面正确性 |
| 像素格式请求与降级 | 渲染性能 |
| 增量请求节流 | 背压 |
| 剪贴板（`ServerCutText`/`ClientCutText`） | `GUI-030` |
| 缩放模式 | `GUI-031` |
| 只读模式 | `GUI-028` AC-3 |
| 截图从帧缓冲取 | `GUI-035` |
| 错误映射 | 可解释的失败（`spec/01` §6 原则 3） |
