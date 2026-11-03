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
}

/// 一条 SFTP 会话。
pub struct SftpClient {
    inner: russh_sftp::client::SftpSession,
}

impl SftpClient {
    /// 在已有 SSH 连接上打开 sftp 子系统。
    pub async fn open(conn: &SshConnection) -> Result<Self, WtError> {
        let stream = conn.open_subsystem("sftp").await?;
        let inner = russh_sftp::client::SftpSession::new(stream)
            .await
            .map_err(|e| sftp_error("打开 SFTP 会话失败", e.to_string()))?;
        Ok(Self { inner })
    }

    /// 列出目录内容，按「目录在前、然后按名字」排序。
    pub async fn list_dir(&self, path: &str) -> Result<Vec<RemoteEntry>, WtError> {
        let entries: Vec<RemoteEntry> = self
            .inner
            .read_dir(path)
            .await
            .map_err(|e| sftp_error(&format!("无法列出目录 {path}"), e.to_string()))?
            .map(|f| {
                let meta = f.metadata();
                RemoteEntry {
                    is_dir: meta.is_dir(),
                    size: meta.len(),
                    name: f.file_name(),
                }
            })
            // 有的服务端会把 . 和 .. 也返回；界面上不需要
            .filter(|e| e.name != "." && e.name != "..")
            .collect();

        Ok(sort_entries(entries))
    }

    /// 读整个文件。
    pub async fn read_file(&self, path: &str) -> Result<Vec<u8>, WtError> {
        self.inner
            .read(path)
            .await
            .map_err(|e| sftp_error(&format!("无法读取 {path}"), e.to_string()))
    }

    /// 写整个文件（覆盖）。
    pub async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), WtError> {
        self.inner
            .write(path, data)
            .await
            .map_err(|e| sftp_error(&format!("无法写入 {path}"), e.to_string()))
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

    /// 把相对路径解析成绝对路径（远端 shell 的 `~` 之类由服务端处理）。
    pub async fn canonicalize(&self, path: &str) -> Result<String, WtError> {
        self.inner
            .canonicalize(path)
            .await
            .map_err(|e| sftp_error(&format!("无法解析路径 {path}"), e.to_string()))
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
    WtError::new("SFTP_FAILED")
        .message(message)
        .detail(detail)
        .hint("确认远端开启了 sftp 子系统（sshd 默认开启）", HintAction::None)
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
            let files = fs
                .keys()
                .filter_map(|path| path.strip_prefix(&prefix))
                .filter(|rest| !rest.is_empty() && !rest.contains('/'))
                .map(|name| File::new(name, FileAttributes::dummy()))
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
        (SftpClient { inner }, fs)
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

    #[test]
    fn sorts_directories_first_then_names() {
        let entries = vec![
            RemoteEntry { name: "zeta.txt".into(), is_dir: false, size: 1 },
            RemoteEntry { name: "Alpha".into(), is_dir: true, size: 0 },
            RemoteEntry { name: "beta.txt".into(), is_dir: false, size: 2 },
        ];
        let sorted = sort_entries(entries);
        let names: Vec<&str> = sorted.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["Alpha", "beta.txt", "zeta.txt"]);
    }
}
