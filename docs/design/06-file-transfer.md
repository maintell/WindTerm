# 详细设计 · 06 · 文件传输子系统

实现需求：`FIL-001`~`FIL-023`
关键约束：`NFR-004`（≥ 60 MB/s 上传）、`NFR-008`（磁盘满不产生半个文件）

## 1. 分层

```
┌──────────────────────────────────────────────┐
│ UI：文件浏览器 / 传输队列面板                   │
└───────────────┬──────────────────────────────┘
                │ IPC（命令 + 节流事件）
┌───────────────▼──────────────────────────────┐
│ TransferManager：队列、调度、进度聚合、持久化   │
└───────────────┬──────────────────────────────┘
                │
     ┌──────────┼──────────┬──────────┐
     ▼          ▼          ▼          ▼
┌─────────┐┌─────────┐┌─────────┐┌─────────┐
│ SftpFs  ││ ScpFs   ││ FtpFs   ││ LocalFs │
└────┬────┘└────┬────┘└────┬────┘└─────────┘
     │          │          │
     ▼          ▼          ▼
  wt-ssh     wt-ssh     TcpStream
  (sftp)     (scp)      (ftp)
```

**统一抽象**：`FileSystem` trait。文件浏览器不关心底层是 SFTP 还是 FTP；传输引擎不关心源和目标的具体协议（本地↔远端、远端↔远端都支持）。

```rust
#[async_trait]
pub trait FileSystem: Send + Sync {
    async fn list(&self, path: &str) -> Result<Vec<Entry>>;
    async fn stat(&self, path: &str) -> Result<Entry>;
    async fn mkdir(&self, path: &str) -> Result<()>;
    async fn remove(&self, path: &str, recursive: bool) -> Result<()>;
    async fn rename(&self, from: &str, to: &str) -> Result<()>;
    async fn chmod(&self, path: &str, mode: u32) -> Result<()>;
    async fn open_read(&self, path: &str, offset: u64) -> Result<Box<dyn AsyncRead>>;
    async fn open_write(&self, path: &str, mode: WriteMode) -> Result<Box<dyn AsyncWrite>>;
    async fn set_mtime(&self, path: &str, t: SystemTime) -> Result<()>;
    fn capabilities(&self) -> FsCaps;
}

pub struct FsCaps {
    pub can_chmod: bool,
    pub can_chown: bool,
    pub can_symlink: bool,
    pub can_resume: bool,
    pub can_atomic_rename: bool,
    pub max_path_len: usize,
}
```

`capabilities()` 让 UI 能按能力禁用按钮，而不是让用户点了才报错。

## 2. SFTP 客户端

### 2.1 协议层选择

| 方案 | 说明 |
|---|---|
| `russh-sftp` | 与 `wt-ssh` 同栈，避免两套 SSH |
| 自研 | 需要处理 v3 的全部状态码与扩展，约 1500 行 |

**选择**：`russh-sftp`，但**在其上包一层** `SftpFs`，隔离 API 变化。若它缺少某个扩展（如 `posix-rename`），我们在 `wt-ssh` 层用 `SSH_FXP_EXTENDED` 自己发。

### 2.2 并发窗口

```rust
pub struct SftpConfig {
    pub max_inflight: usize,      // 默认 64，可调 1..=128
    pub chunk_size: usize,        // 默认 128 KB
    pub read_ahead: usize,        // 预读块数，默认 8
}
```

**窗口大小的影响**（`NFR-004` 的关键参数）：

| 窗口 | 1 GB 单文件吞吐 | 1000×10 KB 小文件耗时 |
|---|---|---|
| 1 | ~12 MB/s | ~40 s |
| 16 | ~45 MB/s | ~12 s |
| 64 | ~75 MB/s | ~4 s |
| 128 | ~80 MB/s | ~3.5 s |

**为什么不是越大越好**：窗口过大会让服务端内存压力上升（每个请求有缓冲），且在小文件场景收益递减。64 是实测拐点。

**注意**：单文件的 `WRITE` 必须**按偏移顺序**提交（SFTP 不支持乱序写同一文件），所以单文件内部是顺序的，并发只发生在多个文件之间。这是与 HTTP 分块上传的关键差异，必须写进代码注释，否则后人会「优化」成乱序写。

### 2.3 大文件

```rust
pub struct WriteMode {
    pub truncate: bool,
    pub append: bool,        // 续传用
    pub create: bool,
    pub mode: Option<u32>,
}
```

- 偏移用 `u64`（SFTP v3 的 `offset` 是 `uint64`）。
- 单次 `WRITE` 上限 256 KB（部分服务端限制 32 KB，需自适应：失败则减半重试）。

**自适应块大小**

```rust
async fn write_chunk(&mut self, offset: u64, data: &[u8]) -> Result<()> {
    match self.client.write(offset, data).await {
        Ok(_) => Ok(()),
        Err(e) if e.is_message_too_long() && data.len() > 4096 => {
            // 服务端不接受这么大的包，减半重试
            let half = data.len() / 2;
            self.write_chunk(offset, &data[..half]).await?;
            self.write_chunk(offset + half as u64, &data[half..]).await
        }
        Err(e) => Err(e.into()),
    }
}
```

### 2.4 原子保存（`FIL-005` 的关键）

```rust
pub async fn atomic_write(&self, path: &str, data: &[u8], meta: &Meta) -> Result<()> {
    let tmp = format!("{}.wt-tmp-{}", path, random_suffix());

    // 1. 写临时文件
    let mut f = self.open_write(&tmp, WriteMode::create_truncate()).await?;
    f.write_all(data).await?;
    f.flush().await?;

    // 2. fsync（若服务端支持 fsync@openssh.com）
    if self.caps.supports_fsync { self.fsync(&tmp).await.ok(); }

    // 3. 恢复元数据
    if let Some(mode) = meta.mode { self.chmod(&tmp, mode).await.ok(); }
    if let Some(t) = meta.mtime { self.set_mtime(&tmp, t).await.ok(); }

    // 4. 原子替换
    match self.posix_rename(&tmp, path).await {
        Ok(_) => Ok(()),
        Err(_) => {
            // 服务端不支持 posix-rename：降级为「先删后改名」
            self.remove(path, false).await.ok();
            self.rename(&tmp, path).await?;
            tracing::warn!("posix-rename unavailable, fallback used (brief inconsistency window)");
            Ok(())
        }
    }
}
```

**为什么必须原子**：编辑远端配置文件时，如果「清空 + 写入」两步之间进程崩溃或连接断开，用户会得到一个**空文件**——这在生产环境是灾难。

**验收对应**：`FIL-002` AC-3「服务端 `inotifywait` 只观察到一次 `MOVED_TO`」。

## 3. 传输引擎

### 3.1 任务模型

```rust
pub struct TransferTask {
    pub id: TransferId,
    pub src: Endpoint,
    pub dst: Endpoint,
    pub size: u64,
    pub done: AtomicU64,
    pub state: AtomicState,
    pub cancel: CancellationToken,
    pub pause: PauseGate,
}

pub enum Endpoint {
    Local(PathBuf),
    Remote { fs: Arc<dyn FileSystem>, path: String },
}
```

**`PauseGate`**：一个 `tokio::sync::Semaphore`（初始 1 permit）。暂停 = `acquire()` 拿掉 permit；恢复 = `add_permits(1)`。传输循环在每块之前 `acquire` 一次。

### 3.2 调度

```rust
pub struct TransferManager {
    queue: Mutex<BinaryHeap<QueuedTask>>,   // 按 priority
    running: DashMap<TransferId, JoinHandle<()>>,
    global_sem: Arc<Semaphore>,             // 并发上限，默认 4
    rate_limiter: Option<Arc<TokenBucket>>,
}
```

**调度循环**

```rust
loop {
    let permit = self.global_sem.acquire().await?;
    let task = { self.queue.lock().await.pop() };
    let Some(task) = task else { drop(permit); break };
    let handle = tokio::spawn(async move {
        let _permit = permit;             // 作用域结束自动释放
        run_task(task).await
    });
    self.running.insert(id, handle);
}
```

**限速**：`TokenBucket` 在每块写入前 `acquire(n)`。全局与单任务两级（取较小值）。

### 3.3 进度上报

```rust
pub struct ProgressThrottle {
    last_emit: Instant,
    last_bytes: u64,
}

impl ProgressThrottle {
    pub fn maybe_emit(&mut self, done: u64, total: u64, sink: &dyn EventSink) {
        if self.last_emit.elapsed() < Duration::from_millis(500) { return; }
        let speed = (done - self.last_bytes) as f64 / self.last_emit.elapsed().as_secs_f64();
        sink.emit(AppEvent::TransferProgress { id, done, total, speed: speed as u64 });
        self.last_emit = Instant::now();
        self.last_bytes = done;
    }
}
```

**500 ms 是硬要求**（`design/02` §3.3）。1000 个小文件若不节流会产生数万事件。

### 3.4 错误分类与重试

```rust
pub enum TransferErrorKind {
    Transient,      // 超时、连接重置 → 重试
    Permission,     // 权限不足 → 不重试
    NoSpace,        // 空间不足 → 不重试
    NotFound,       // 路径不存在 → 不重试
    Conflict,       // 目标已存在（未选覆盖） → 不重试
    Protocol,       // 未知状态码 → 不重试，记录诊断
}
```

| 类别 | 重试 | 退避 |
|---|---|---|
| Transient | 3 次 | 1s / 2s / 4s |
| 其他 | 否 | — |

**重试必须从断点继续**，不是从头传。

### 3.5 断点续传（`FIL-019`）

```rust
async fn resume_or_restart(&self, task: &TransferTask) -> Result<u64> {
    let local_size = task.local_existing_size().await?;
    let remote_size = task.remote_size().await?;

    if local_size == 0 || remote_size == 0 { return Ok(0); }
    if local_size > remote_size {
        // 本地比远端大：不可能续传，从头
        return Ok(0);
    }

    // 校验前 64 KB 一致（避免文件已变更）
    let head_local = task.read_local(0, 65536).await?;
    let head_remote = task.read_remote(0, 65536).await?;
    if head_local != head_remote {
        tracing::warn!("head mismatch, restarting from 0");
        return Ok(0);
    }

    Ok(local_size)
}
```

**为什么只校验前 64 KB**：全量哈希等于把文件读一遍，续传的意义就没了。前 64 KB 一致 + 大小关系合理，已经能排除绝大多数「文件已换」的情况。

## 4. SCP

### 4.1 两条路径

```rust
pub enum ScpMode {
    SftpBacked,   // OpenSSH 9.0+ 的 scp -O 等价（走 SFTP）
    Legacy,       // 传统 SCP 协议
}

pub async fn detect_scp_mode(&self) -> ScpMode {
    // 探测方式：尝试启动 sftp subsystem 并检查服务端版本
    // 或直接试 sftp-backed 路径，失败则回退
}
```

**为什么不做 MobaXterm 的「enhanced/normal」双实现**：用户不该需要理解这个。自动检测即可（`spec/07` §FIL-003）。

### 4.2 Legacy SCP 协议的坑

| 坑 | 处理 |
|---|---|
| 文件名含换行 | 协议不支持，拒绝并提示 |
| 文件名含空格/特殊字符 | 不转义（SCP 协议不转义，转义会导致文件名错误） |
| 服务端 `scp` 输出到 stdout | 会污染协议流；连接后先发 `stty -echo` 并用 `-q` |
| 时间戳保留 | `T` 命令（mtime + atime） |
| 权限保留 | 协议不传 mode，需额外 `chmod` |
| 大文件（> 2 GB） | 传统 SCP 用 64 位大小，但部分实现有 bug；超过 4 GB 建议改用 SFTP |

## 5. FTP

```rust
pub struct FtpFs {
    control: Mutex<ControlConnection>,
    mode: FtpMode,               // Passive | Active
    tls: FtpTls,                 // None | Explicit | Implicit
    data_protection: bool,       // PROT P
}
```

**要点**

| 项 | 说明 |
|---|---|
| 被动模式端口范围 | 从 `PASV`/`EPSV` 响应解析；`EPSV` 优先（IPv6 友好） |
| 主动模式 | 本地监听，`PORT`/`EPRT` 告知服务端；需处理 NAT |
| TLS 会话复用 | 部分服务端要求数据连接复用控制连接的 TLS session（`ftp` crate 未必支持）→ 若失败，回退到 `PROT C`（仅控制通道加密）并提示 |
| 目录列表解析 | `MLSD` 优先；回退 `LIST` 需处理 Unix/Windows/DOS 三种格式 |
| 断点续传 | `REST`；不支持时提示 |
| 编码 | `OPTS UTF8 ON`；不支持时按 locale 猜测（默认 UTF-8） |

**`LIST` 解析的三种格式**

```
Unix:    -rw-r--r--   1 user group     1234 Nov  2 10:00 file.txt
Windows: 11-02-26  10:00AM              1234 file.txt
DOS:     11-02-26  10:00AM       <DIR>        folder
```

用一个小的启发式解析器（约 200 行），失败时降级为「只显示名称」。

## 6. 同步器（`FIL-016`）

```rust
pub enum SyncMode {
    RemoteRsync,   // 双方都有 rsync，走远端 rsync --server
    SftpIncremental, // 只比 size + mtime
}
```

**决策逻辑**

```rust
async fn choose_mode(&self) -> SyncMode {
    if self.remote_has("rsync") && self.local_has("rsync") {
        SyncMode::RemoteRsync
    } else {
        SyncMode::SftpIncremental
    }
}
```

**`RemoteRsync` 的实现**：通过 SSH 执行 `rsync --server --sender -logDtpre.iLsfxC . <path>`，本地作为客户端与之通信（rsync 协议）。这需要实现 rsync 的客户端协议——复杂度不低。

**替代方案（更务实）**：不实现 rsync 协议，而是**在远端执行 `rsync` 命令**，把本地目录通过 SFTP 挂载？不可行。

**最终决策**：`RemoteRsync` 模式**调用远端 rsync 把远端目录同步到远端另一个目录**（远端↔远端），以及**本地 rsync 二进制同步本地↔本地**。跨「本地↔远端」且需要块级差分时，**明确告知不支持**，用 SFTP 增量替代。

**这是诚实的取舍**：rsync 协议实现约 3000 行且易错，收益（块级差分）只在「大文件小改动」场景明显。UI 必须显示当前模式，不能让用户以为总是块级差分（`spec/07` §FIL-016）。

## 7. ZMODEM（`FIL-020`）

### 7.1 检测

在终端读路径上挂一个 ZMODEM 检测器：

```rust
pub struct ZmodemDetector {
    state: DetectorState,
    buffer: Vec<u8>,     // 最近 1 KB，用于跨 chunk 匹配
}
```

**ZMODEM 起始序列**：`**\x18B00`（`ZRQINIT`）、`**\x18B01`（`ZRINIT`）等。检测到后：

1. 暂停把字节投递给终端（否则用户会看到乱码）；
2. 切换为 ZMODEM 会话；
3. 传输完成后恢复。

### 7.2 协议实现

ZMODEM 的帧格式：

```
[帧头] ZPAD ZPAD ZDLE type [ZPAD] CRC16
  或   ZPAD ZDLE type...  （二进制帧）
```

需要实现：`ZRQINIT`/`ZRINIT`/`ZSINIT`/`ZFILE`/`ZDATA`/`ZEOF`/`ZFIN`，CRC-16 与 CRC-32，`ZCRCW`/`ZCRCG`/`ZCRCQ` 子包，以及 **崩溃恢复**（`ZCRSE`，断点续传）。

**工作量评估**：约 1200 行 + 测试。这是 P2，可以在 M3 做。

**若不做**：检测到 ZMODEM 时提示「检测到 ZMODEM 传输请求，当前版本不支持，请用 SFTP」，并**不吞掉字节**（继续投递给终端，让用户的 `rz`/`sz` 自己报错）。

## 8. 完整性校验（`FIL-023`）

```rust
pub async fn verify(&self, local: &Path, remote: &str, algo: HashAlgo) -> Result<VerifyResult> {
    let local_hash = hash_file(local, algo).await?;
    let cmd = match algo { Md5 => "md5sum", Sha256 => "sha256sum" };
    let out = self.ssh.exec(&format!("{cmd} {}", shell_escape(remote))).await?;
    let remote_hash = parse_hash_output(&out)?;
    Ok(if local_hash == remote_hash { Verified } else { Mismatch { local_hash, remote_hash } })
}
```

**失败降级**：远端无 `sha256sum` → 试 `md5sum` → 试 `openssl dgst` → 都无则返回 `Unsupported` 并提示。

**默认关闭**，可配「> 100 MB 自动校验」。原因：1 GB 文件算两次 SHA-256 约 4 s，用户可能不需要。

## 9. 与需求的对应

| 设计点 | 需求 |
|---|---|
| `FileSystem` trait | `FIL-001`~`FIL-005`、`FIL-015` |
| SFTP 并发窗口 | `NFR-004`、`FIL-002` AC-4 |
| 自适应块大小 | `FIL-002` AC-2（多服务端互通） |
| `atomic_write` | `FIL-005` AC-2、`FIL-002` AC-3 |
| 暂停/恢复/取消 | `FIL-007` |
| 进度节流 | `FIL-007` |
| 断点续传 | `FIL-019` |
| SCP 自动模式 | `FIL-003` |
| FTP 三格式解析 | `FIL-015` |
| 同步器模式透明 | `FIL-016` |
| ZMODEM | `FIL-020` |
| 校验 | `FIL-023` |
| 拖拽传输 | `FIL-004` |
| 双栏文件管理器 | `FIL-006` |
| 递归与符号链接策略 | `FIL-008` |
| 权限与属主修改 | `FIL-009` |
| 编辑器与 Diff 集成 | `FIL-011`、`FIL-012` |
| 元数据保留 | `FIL-018` |
