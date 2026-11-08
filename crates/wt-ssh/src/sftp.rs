//! SFTP 客户端：列目录、读文件、写文件。
//!
//! 设计依据：`docs/design/06-file-transfer.md` §3。
//!
//! 协议实现交给 `russh-sftp`（SFTP v3），这一层只做三件事：
//! ① 把 `russh` 的通道转成字节流；② 把错误翻译成带 `code` 的 [`WtError`]；
//! ③ 收窄对外暴露的接口——上层不需要知道 SFTP 的 handle/attrs 细节。
//!
//! # 测试策略
//!
//! 协议部分用 `tokio::io::duplex` 直接对跑（本文件底部的用例）：
//! 一边是本模块的客户端，另一边是一个内存文件系统的服务端。
//! 这比「起一个 sshd」稳定，也比打桩可信——走的是真实 SFTP 报文。
//! SSH 通道那一层（`open_subsystem`）由 `tests/sftp.rs` 覆盖。

use wt_common::{HintAction, WtError};

use crate::client::SshConnection;

/// 远端目录里的一项。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteEntry {
    /// 文件/目录名（不含路径）
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    /// 符号链接（`FIL-002`）。链接本身没有内容，`size` 通常是目标路径的长度
    pub is_symlink: bool,
    /// 链向哪里（服务端原样返回的字符串，可能是相对路径）；非链接为 `None`
    pub link_target: Option<String>,
    /// 断链：链接在，但目标不存在——界面上要标出来，否则用户点进去才报错
    pub broken: bool,
    /// 权限位（原始 `st_mode`，含 `S_IFMT` 类型位）。服务端不给就是 `None`
    pub mode: Option<u32>,
    /// 修改时间（Unix 秒）。SFTP v3 的 `mtime` 就是 `u32`，服务端不给就是 `None`。
    ///
    /// 用 `u32` 而不是 `SystemTime`：这层只做协议搬运，格式化交给界面——
    /// 时区与本地化在 Rust 侧做反而要多带一个库。2038 之后的年份这一版不管。
    pub mtime: Option<u32>,
}

/// 一条 SFTP 会话。
///
/// **持有 SSH 连接**（`owner`）：通道与连接必须同寿命。不持有的话，调用方
/// 的 `SshConnection` 一旦 drop，SFTP 通道就会在半空中失效——表现为
/// 「连上了但列目录永远不返回」，没有任何错误。
pub struct SftpClient {
    inner: russh_sftp::client::SftpSession,
    /// `None` 只出现在单测里（那条路径用内存管道，没有 SSH 连接可持有）。
    ///
    /// 这个字段**不被读取**，它的作用是「活到 SftpClient 被 drop」——
    /// 也就是所有权守卫。删掉它，连接会在 open 返回后立刻失效。
    #[allow(dead_code)]
    owner: Option<SshConnection>,
}

/// 把链接目标解析成绝对路径：相对目标相对于**链接所在目录**，不是当前目录。
fn resolve_link(dir: &str, target: &str) -> String {
    if target.starts_with('/') {
        target.to_string()
    } else {
        format!("{dir}{target}")
    }
}

/// 临时文件名后缀：纳秒 + 进程内计数，保证同一秒内多次写也不撞。
fn unique_suffix() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos}-{}", N.fetch_add(1, Ordering::Relaxed))
}

impl SftpClient {
    /// 在已有 SSH 连接上打开 sftp 子系统（接管连接所有权）。
    pub async fn open(conn: SshConnection) -> Result<Self, WtError> {
        let stream = conn.open_subsystem("sftp").await?;
        let inner = russh_sftp::client::SftpSession::new(stream)
            .await
            .map_err(|e| sftp_error("打开 SFTP 会话失败", e.to_string()))?;
        Ok(Self {
            inner,
            owner: Some(conn),
        })
    }

    /// 列出目录内容，按「目录在前、然后按名字」排序。
    pub async fn list_dir(&self, path: &str) -> Result<Vec<RemoteEntry>, WtError> {
        // 用结构体而不是元组：加上 mtime 之后是六元组，位置参数既难读、clippy 也会报
        // `type_complexity`；字段名还能说明每个值是什么。
        struct RawEntry {
            name: String,
            is_dir: bool,
            is_symlink: bool,
            size: u64,
            mode: Option<u32>,
            mtime: Option<u32>,
        }
        let raw: Vec<RawEntry> = self
            .inner
            .read_dir(path)
            .await
            .map_err(|e| sftp_error(&format!("无法列出目录 {path}"), e.to_string()))?
            .map(|f| {
                let meta = f.metadata();
                RawEntry {
                    name: f.file_name(),
                    is_dir: meta.is_dir(),
                    is_symlink: meta.is_symlink(),
                    size: meta.len(),
                    mode: meta.permissions,
                    mtime: meta.mtime,
                }
            })
            // 有的服务端会把 . 和 .. 也返回；界面上不需要
            .filter(|e| e.name != "." && e.name != "..")
            .collect();

        let dir = if path.ends_with('/') {
            path.to_string()
        } else {
            format!("{path}/")
        };
        let mut entries = Vec::with_capacity(raw.len());
        for RawEntry {
            name,
            is_dir,
            is_symlink,
            size,
            mode,
            mtime,
        } in raw
        {
            let mut entry = RemoteEntry {
                name,
                is_dir,
                size,
                is_symlink,
                link_target: None,
                broken: false,
                mode,
                mtime,
            };
            if is_symlink {
                // 链接目标要单独问一次服务端（`read_dir` 只给属性，不给目标）。
                // 「断链」也不能靠猜：必须真的去 stat 一次目标，否则界面上分不出
                // 「链向一个文件」和「链向一个早就没了的路径」。
                let full = format!("{dir}{}", entry.name);
                match self.inner.read_link(&full).await {
                    Ok(target) => {
                        let resolved = resolve_link(&dir, &target);
                        entry.broken = self.inner.metadata(&resolved).await.is_err();
                        entry.link_target = Some(target);
                    }
                    // 连目标都读不到，对用户来说就是「链接不可用」
                    Err(_) => entry.broken = true,
                }
            }
            entries.push(entry);
        }

        Ok(sort_entries(entries))
    }

    /// 原子写整个文件：先写临时文件，再 `rename` 覆盖目标。
    ///
    /// **为什么不能直接 `create` 覆盖**（`FIL-002` 的关键约束）：`create` 会先把
    /// 目标截成 0 字节，写的这段时间里任何人（另一个客户端、服务端的 `inotifywait`、
    /// 甚至本进程里的文件面板）都能看到一个空文件或半截内容。`rename` 在 OpenSSH 的
    /// `sftp-server` 上直通 `rename(2)`，替换是原子的：观察者只会看到旧内容或新内容。
    ///
    /// 返回 `true` 表示走的是原子替换；`false` 表示服务端严格按 SFTP v3 在「目标已存在」
    /// 时拒绝 rename，只能退回「先删后改名」——那有一段短暂的不一致窗口，调用方应当
    /// 如实告诉用户，而不是假装原子。
    ///
    /// 权限位会被保留：临时文件是按服务端 umask 建的，直接换名会把可执行位、组权限
    /// 一起抹掉（「编辑一个 755 的脚本，存完变成 644」），所以替换前把原件的权限位
    /// `SETSTAT` 到临时文件上。服务端拒绝 `SETSTAT` 时内容照样保存、权限退回默认值
    /// ——内容比权限重要，但这一点写在这里，不假装总能保留。
    pub async fn write_file_atomic(&self, path: &str, data: &[u8]) -> Result<bool, WtError> {
        use tokio::io::AsyncWriteExt;
        // 先读原件的权限位。读不到（新文件、服务端不支持 stat、目标是符号链接）就当没有，
        // 保持原来的建文件语义。
        let prev_mode = self
            .inner
            .metadata(path)
            .await
            .ok()
            .and_then(|a| a.permissions);
        let tmp = format!("{path}.wt-tmp-{}", unique_suffix());
        let write_tmp = async {
            let mut file = self.inner.create(&tmp).await.map_err(|e| {
                sftp_error(&format!("无法创建临时文件 {tmp}"), e.to_string())
            })?;
            file.write_all(data).await.map_err(|e| {
                sftp_error(&format!("写入临时文件 {tmp} 失败"), e.to_string())
            })?;
            file.shutdown().await.map_err(|e| {
                sftp_error(&format!("关闭临时文件 {tmp} 失败"), e.to_string())
            })?;
            Ok::<(), WtError>(())
        }
        .await;
        if let Err(e) = write_tmp {
            let _ = self.remove_file(&tmp).await;
            return Err(e);
        }
        // 权限位要在替换**之前**设到临时文件上：换名的一瞬间文件就已经是最终权限，
        // 不会出现「新内容配临时权限」的窗口。按 `set_mode` 的约定补上类型位
        // （只写权限位、丢了 `S_IFREG`，有的服务端会把路径当成未知类型）。
        if let Some(mode) = prev_mode {
            let _ = self.set_mode(&tmp, (mode & 0o7777) | 0o100000).await;
        }
        match self.inner.rename(&tmp, path).await {
            Ok(()) => Ok(true),
            Err(_) => {
                // 目标已存在且服务端不肯替换：删掉再改名。中间那一瞬间目标是不存在的，
                // 所以返回 false 让上层把话说清楚。
                let _ = self.remove_file(path).await;
                match self.inner.rename(&tmp, path).await {
                    Ok(()) => Ok(false),
                    Err(e) => {
                        let _ = self.remove_file(&tmp).await;
                        Err(sftp_error(
                            &format!("无法把临时文件替换成 {path}"),
                            e.to_string(),
                        ))
                    }
                }
            }
        }
    }

    /// 改权限位（`FIL-002` 的 `SSH_FXP_SETSTAT`）。
    ///
    /// 调用方要把**类型位**一起带进来（`mode` 是完整的 `st_mode`）：只写权限位、把
    /// `S_IFREG` 写丢，有的服务端会把这个路径当成未知类型，后续操作全失败。
    pub async fn set_mode(&self, path: &str, mode: u32) -> Result<(), WtError> {
        use russh_sftp::protocol::FileAttributes;
        let mut attrs = FileAttributes::empty();
        attrs.permissions = Some(mode);
        self.inner.set_metadata(path, attrs).await.map_err(|e| {
            sftp_error(&format!("无法修改 {path} 的权限位"), e.to_string())
        })
    }

    /// 改修改时间（`FIL-002` 的 `SSH_FXP_SETSTAT`，SFTP v3 的 `mtime` 是 Unix 秒）。
    ///
    /// 「上传保留本地 mtime」（`FIL-018`）就靠它：文件写完、`rename` 之前把源文件的
    /// 修改时间设到远端，备份/增量同步才不会因为「远端时间变成上传时间」而全量重传。
    /// 不支持时由调用方降级（内容比时间重要），这里只如实把服务端错误报出去。
    pub async fn set_mtime(&self, path: &str, secs: u32) -> Result<(), WtError> {
        use russh_sftp::protocol::FileAttributes;
        let mut attrs = FileAttributes::empty();
        attrs.mtime = Some(secs);
        self.inner.set_metadata(path, attrs).await.map_err(|e| {
            sftp_error(&format!("无法修改 {path} 的修改时间"), e.to_string())
        })
    }

    /// 读整个文件。
    pub async fn read_file(&self, path: &str) -> Result<Vec<u8>, WtError> {
        self.inner
            .read(path)
            .await
            .map_err(|e| sftp_error(&format!("无法读取 {path}"), e.to_string()))
    }

    /// 打开远端文件**按块读**（大文件下载用）。
    ///
    /// `read_file` 会把整个文件读进内存：几百 MB 的日志一读就是几百 MB 常驻，
    /// 同时下两个就危险了。这里只给一个句柄，调用方按块读、边读边写盘。
    ///
    /// **调用方必须一直持着连接的那把锁直到读完**：`russh_sftp` 的会话是共享请求状态，
    /// 两个克隆同时发请求会错配应答（`SEC-002` AC-2 记着这个坑）。
    pub async fn open_read(&self, path: &str) -> Result<SftpReader, WtError> {
        let file = self
            .inner
            .open(path)
            .await
            .map_err(|e| sftp_error(&format!("无法打开 {path}"), e.to_string()))?;
        Ok(SftpReader {
            file,
            path: path.to_string(),
        })
    }

    /// 写整个文件（覆盖）。
    ///
    /// 用 `create` 而不是 `write`：`write` **不截断**——覆盖成更短的内容时，
    /// 文件尾部会留下上一次的旧字节（写 14 字节到 17 字节的文件里，末尾 3 字节还在）。
    /// 这类问题只有「覆盖成更短」时才暴露，所以下面专门有用例盯着。
    pub async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), WtError> {
        use tokio::io::AsyncWriteExt;
        let mut file = self
            .inner
            .create(path)
            .await
            .map_err(|e| sftp_error(&format!("无法创建 {path}"), e.to_string()))?;
        file.write_all(data)
            .await
            .map_err(|e| sftp_error(&format!("无法写入 {path}"), e.to_string()))?;
        file.close()
            .await
            .map_err(|e| sftp_error(&format!("无法关闭 {path}"), e.to_string()))?;
        Ok(())
    }

    /// 建目录。
    pub async fn create_dir(&self, path: &str) -> Result<(), WtError> {
        self.inner
            .create_dir(path)
            .await
            .map_err(|e| sftp_error(&format!("无法创建目录 {path}"), e.to_string()))
    }

    /// 删文件。
    pub async fn remove_file(&self, path: &str) -> Result<(), WtError> {
        self.inner
            .remove_file(path)
            .await
            .map_err(|e| sftp_error(&format!("无法删除 {path}"), e.to_string()))
    }

    /// 删目录（服务端只允许删空目录，这与 `rm -d` 一致）。
    ///
    /// 刻意不做递归删除：一次误点删掉整棵树是最难恢复的事故，
    /// 而「先删空再删目录」这个约束能拦住绝大多数手滑。
    pub async fn remove_dir(&self, path: &str) -> Result<(), WtError> {
        self.inner.remove_dir(path).await.map_err(|e| {
            sftp_error(
                &format!("无法删除目录 {path}"),
                format!("{e}（只有空目录能删除；先清空里面的内容）"),
            )
        })
    }

    /// 改名 / 移动。
    ///
    /// `rename` 在 SFTP 里同时承担改名与移动：跨目录就是用新路径调用它。
    pub async fn rename(&self, from: &str, to: &str) -> Result<(), WtError> {
        self.inner
            .rename(from, to)
            .await
            .map_err(|e| sftp_error(&format!("无法把 {from} 改名为 {to}"), e.to_string()))
    }

    /// 把相对路径解析成绝对路径（远端 shell 的 `~` 之类由服务端处理）。
    pub async fn canonicalize(&self, path: &str) -> Result<String, WtError> {
        self.inner
            .canonicalize(path)
            .await
            .map_err(|e| sftp_error(&format!("无法解析路径 {path}"), e.to_string()))
    }
}


/// 一次按块读的句柄（大文件下载）。
///
/// 它**不持有** `SftpClient`：连接的所有权在调用方手里（池里那条由 `Arc<Mutex<..>>` 把着），
/// 只要调用方在读的过程中不放开那把锁，底层通道就一直活着。
pub struct SftpReader {
    file: russh_sftp::client::fs::File,
    path: String,
}

impl SftpReader {
    /// 读一块；返回 0 表示读完（`AsyncRead` 的约定）。
    pub async fn read_chunk(&mut self, buf: &mut [u8]) -> Result<usize, WtError> {
        use tokio::io::AsyncReadExt;
        self.file
            .read(buf)
            .await
            .map_err(|e| sftp_error(&format!("读取 {} 失败", self.path), e.to_string()))
    }
}

/// 一次分块上传的写句柄（`FIL-019`：真流式上传）。
///
/// 同时持有 `SftpClient`（连接守卫）：只留 `File` 的话，SSH 连接一旦 drop，
/// 底层通道就没了，下一块写入会以一个莫名其妙的错误失败——
/// 这与 `SftpClient` 自己持有 `owner` 是同一个理由。
///
/// 它让「前端按块读文件、每次一块发过来」成为可能：整块文件不再需要进内存。
pub struct SftpWriter {
    file: russh_sftp::client::fs::File,
    written: u64,
    /// 远端路径：收尾时可能要 SETSTAT mtime（上传保留本地修改时间）
    path: String,
    /// 只作所有权守卫，不被读取
    #[allow(dead_code)]
    owner: SftpClient,
}

impl SftpWriter {
    /// 在远端创建（覆盖）文件，准备按块写入。
    pub async fn create(client: SftpClient, path: &str) -> Result<Self, WtError> {
        let file = client
            .inner
            .create(path)
            .await
            .map_err(|e| sftp_error(&format!("无法创建 {path}"), e.to_string()))?;
        Ok(Self {
            file,
            written: 0,
            path: path.to_string(),
            owner: client,
        })
    }

    /// 写一块，返回**累计**字节数（前端据此显示进度）。
    pub async fn write_chunk(&mut self, data: &[u8]) -> Result<u64, WtError> {
        use tokio::io::AsyncWriteExt;
        self.file
            .write_all(data)
            .await
            .map_err(|e| sftp_error("分块写入失败", e.to_string()))?;
        self.written += data.len() as u64;
        Ok(self.written)
    }

    pub fn written(&self) -> u64 {
        self.written
    }

    /// 收尾：`close` 会等远端确认，再放掉连接。
    pub async fn finish(self) -> Result<u64, WtError> {
        Ok(self.finish_with_mtime(None).await?.0)
    }

    /// 收尾并（可选）把远端文件的修改时间设成源文件的（`FIL-018`：上传保留 mtime）。
    /// 返回 `(写入字节数, 有没有保留成功)`。
    ///
    /// 顺序很关键：先 `close` 让内容落定，再 `SETSTAT mtime`——反过来的话后续写入
    /// 可能把时间又改回「刚刚」。设时间失败**不推翻已成功的上传**：内容比时间重要，
    /// 但返回 `false` 让调用方如实提示，不静默当成功。
    pub async fn finish_with_mtime(self, mtime: Option<u32>) -> Result<(u64, bool), WtError> {
        let written = self.written;
        self.file
            .close()
            .await
            .map_err(|e| sftp_error("关闭上传文件失败", e.to_string()))?;
        let mut mtime_kept = false;
        if let Some(secs) = mtime {
            // 借 owner 发 SETSTAT（set_mtime 需要 &self），同一条连接、close 之后
            mtime_kept = self.owner.set_mtime(&self.path, secs).await.is_ok();
        }
        Ok((written, mtime_kept))
    }
}

/// 目录排序：目录在前，然后按名字（大小写不敏感）。
fn sort_entries(mut entries: Vec<RemoteEntry>) -> Vec<RemoteEntry> {
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries
}

fn sftp_error(message: &str, detail: String) -> WtError {
    // 权限不足单独给一条可读的话（`FIL-001` AC-4）：这类失败最容易被界面
    // 呈现成「目录是空的」，用户会以为文件没了
    if is_permission_denied(&detail) {
        return WtError::new("SFTP_PERMISSION_DENIED")
            .message(format!("权限不足：{message}"))
            .detail(detail)
            .hint(
                "换一个有权限的账号，或让管理员调整该目录的权限",
                HintAction::None,
            );
    }
    WtError::new("SFTP_FAILED")
        .message(message)
        .detail(detail)
        .hint("确认远端开启了 sftp 子系统（sshd 默认开启）", HintAction::None)
}

/// 服务端说的是不是「没权限」。不同实现对这同一件事的措辞不一样，都认。
fn is_permission_denied(detail: &str) -> bool {
    let d = detail.to_ascii_lowercase();
    d.contains("permission denied") || d.contains("permissiondenied")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Arc;

    use russh_sftp::protocol::{
        Attrs, Data, File, FileAttributes, Handle, Name, Status, StatusCode,
    };
    use tokio::sync::Mutex;

    type Fs = Arc<Mutex<HashMap<String, Vec<u8>>>>;

    /// 内存文件系统的 SFTP 服务端：只实现本模块用到的几个操作。
    ///
    /// 刻意不完整——它的价值是让「客户端真的会讲 SFTP」可验证。
    struct MemSftp {
        fs: Fs,
        dir_sent: bool,
    }

    fn ok_status(id: u32) -> Status {
        Status {
            id,
            status_code: StatusCode::Ok,
            error_message: "Ok".to_string(),
            language_tag: "en-US".to_string(),
        }
    }

    impl russh_sftp::server::Handler for MemSftp {
        type Error = StatusCode;

        fn unimplemented(&self) -> StatusCode {
            StatusCode::OpUnsupported
        }

        async fn close(&mut self, id: u32, _handle: String) -> Result<Status, StatusCode> {
            Ok(ok_status(id))
        }

        async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, StatusCode> {
            self.dir_sent = false;
            Ok(Handle { id, handle: path })
        }

        async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, StatusCode> {
            // 一次把整目录发完，第二次就是 EOF（客户端会一直读到 EOF）
            if self.dir_sent {
                return Err(StatusCode::Eof);
            }
            self.dir_sent = true;
            let prefix = if handle.ends_with('/') {
                handle.clone()
            } else {
                format!("{handle}/")
            };
            let fs = self.fs.lock().await;
            let keys: Vec<String> = fs.keys().cloned().collect();
            let files = keys
                .iter()
                .filter_map(|path| path.strip_prefix(&prefix))
                .filter(|rest| !rest.is_empty() && !rest.contains('/'))
                .map(|name| {
                    let full = format!("{prefix}{name}");
                    // 没有独立目录表，一个路径「是目录」当且仅当存在它的子项
                    let is_dir = keys.iter().any(|p| p.starts_with(&format!("{full}/")));
                    // 不能用 `FileAttributes::dummy()`：它把 permissions 写死成
                    // `0o777 | S_IFDIR`，于是每个条目都被报成目录。列目录仍然「成功」，
                    // 但 `is_dir` 全错——界面上给文件加个 `/`，而这种错测不出来。
                    let mut attrs = FileAttributes::empty();
                    attrs.permissions = Some(if is_dir {
                        0o755 | 0o040000 // S_IFDIR
                    } else {
                        0o644 | 0o100000 // S_IFREG
                    });
                    attrs.size = Some(if is_dir {
                        0
                    } else {
                        fs.get(&full).map(|v| v.len() as u64).unwrap_or(0)
                    });
                    File::new(name, attrs)
                })
                .collect::<Vec<_>>();
            Ok(Name { id, files })
        }

        async fn realpath(&mut self, id: u32, _path: String) -> Result<Name, StatusCode> {
            Ok(Name {
                id,
                files: vec![File::dummy("/")],
            })
        }

        async fn open(
            &mut self,
            id: u32,
            filename: String,
            _pflags: russh_sftp::protocol::OpenFlags,
            _attrs: FileAttributes,
        ) -> Result<Handle, StatusCode> {
            Ok(Handle {
                id,
                handle: filename,
            })
        }

        async fn read(
            &mut self,
            id: u32,
            handle: String,
            offset: u64,
            len: u32,
        ) -> Result<Data, StatusCode> {
            let fs = self.fs.lock().await;
            let Some(content) = fs.get(&handle) else {
                return Err(StatusCode::NoSuchFile);
            };
            let start = offset as usize;
            if start >= content.len() {
                return Err(StatusCode::Eof);
            }
            let end = (start + len as usize).min(content.len());
            Ok(Data {
                id,
                data: content[start..end].to_vec(),
            })
        }

        async fn write(
            &mut self,
            id: u32,
            handle: String,
            offset: u64,
            data: Vec<u8>,
        ) -> Result<Status, StatusCode> {
            let mut fs = self.fs.lock().await;
            let entry = fs.entry(handle).or_default();
            let start = offset as usize;
            if entry.len() < start + data.len() {
                entry.resize(start + data.len(), 0);
            }
            entry[start..start + data.len()].copy_from_slice(&data);
            Ok(ok_status(id))
        }

        async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, StatusCode> {
            let fs = self.fs.lock().await;
            let Some(content) = fs.get(&path) else {
                return Err(StatusCode::NoSuchFile);
            };
            let mut attrs = FileAttributes::dummy();
            attrs.size = Some(content.len() as u64);
            Ok(Attrs { id, attrs })
        }
    }

    /// 起一对「客户端 ↔ 服务端」，中间是一条内存管道。
    async fn pair() -> (SftpClient, Fs) {
        let fs: Fs = Arc::new(Mutex::new(HashMap::new()));
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        let handler = MemSftp {
            fs: fs.clone(),
            dir_sent: false,
        };
        tokio::spawn(russh_sftp::server::run(server_io, handler));
        let inner = russh_sftp::client::SftpSession::new(client_io)
            .await
            .expect("SFTP 握手应成功");
        (
            SftpClient {
                inner,
                owner: None,
            },
            fs,
        )
    }

    #[tokio::test]
    async fn lists_reads_and_writes_files() {
        let (sftp, fs) = pair().await;
        {
            let mut map = fs.lock().await;
            map.insert("/hello.txt".into(), b"hi there".to_vec());
            map.insert("/other.bin".into(), vec![0u8, 1, 2, 3]);
        }

        let entries = sftp.list_dir("/").await.expect("列目录应成功");
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"hello.txt"), "实际: {names:?}");
        assert!(names.contains(&"other.bin"), "实际: {names:?}");

        // 类型与大小必须来自服务端属性，不能靠名字猜。
        // 服务端把 permissions 写成 `0o777 | S_IFDIR`（`FileAttributes::dummy()` 就是这样）
        // 时，所有条目都会变成目录——列目录仍然「成功」，界面却给文件加个 `/`。
        let hello = entries.iter().find(|e| e.name == "hello.txt").unwrap();
        assert!(!hello.is_dir, "普通文件不该被报成目录");
        assert_eq!(hello.size, 8, "大小要来自服务端属性");

        assert_eq!(sftp.read_file("/hello.txt").await.unwrap(), b"hi there");

        sftp.write_file("/written.txt", b"from client")
            .await
            .expect("写文件应成功");
        assert_eq!(
            fs.lock().await.get("/written.txt").map(|v| v.as_slice()),
            Some(&b"from client"[..])
        );

        let after = sftp.list_dir("/").await.expect("再列目录应成功");
        assert!(after.iter().any(|e| e.name == "written.txt"));
    }

    #[tokio::test]
    async fn missing_file_is_a_clear_error() {
        let (sftp, _fs) = pair().await;
        let err = sftp.read_file("/nope.txt").await.unwrap_err();
        assert_eq!(err.code, "SFTP_FAILED");
        assert!(err.message.contains("/nope.txt"), "实际: {}", err.message);
        assert!(
            err.hints.iter().any(|h| h.label.contains("sftp")),
            "提示里要说清 sftp 子系统的事"
        );
    }

    /// 子系统通道能不能真的传字节——SFTP 全靠这条链路。
    ///
    /// 用 mock 服务端的 `echo` 子系统（原样回写）验证，不需要 sftp 服务端。
    #[cfg(feature = "test-util")]
    #[tokio::test]
    async fn subsystem_channel_carries_bytes() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        use crate::testing::MockSshServer;
        use crate::{HostKeyPolicy, SshConfig, SshConnection};

        let server = MockSshServer::start().await;
        let cfg = SshConfig {
            host: "127.0.0.1".into(),
            port: server.port,
            user: "tester".into(),
            connect_timeout_secs: 5,
            ..Default::default()
        };
        let conn = SshConnection::connect_password(&cfg, "secret", HostKeyPolicy::AcceptAll)
            .await
            .expect("连接应成功");

        let mut stream = conn.open_subsystem("echo").await.expect("应能打开子系统");
        stream.write_all(b"ping").await.expect("写入应成功");
        let mut buf = [0u8; 4];
        stream.read_exact(&mut buf).await.expect("应能读回");
        assert_eq!(&buf, b"ping");
    }

    /// 测试用的普通文件/目录条目：链接那几个字段默认「不是链接」。
    fn flat(name: &str, is_dir: bool, size: u64) -> RemoteEntry {
        RemoteEntry {
            name: name.into(),
            is_dir,
            size,
            is_symlink: false,
            link_target: None,
            broken: false,
            mode: None,
            mtime: None,
        }
    }

    #[test]
    fn sorts_directories_first_then_names() {
        let entries = vec![flat("zeta.txt", false, 1), flat("Alpha", true, 0), flat("beta.txt", false, 2)];
        let sorted = sort_entries(entries);
        let names: Vec<&str> = sorted.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["Alpha", "beta.txt", "zeta.txt"]);
    }
}
