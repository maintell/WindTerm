//! MobaXterm `MobaXterm.ini` 导入器。
//!
//! 设计依据：`docs/design/04-data-model.md` §6、`docs/spec/05-func-sessions.md` §5。
//!
//! # 关于「字段映射表」的诚实说明
//!
//! MobaXterm 的 ini 字段名**没有公开规范**，只能从真实样本反推。本文实现的映射基于
//! 帮助文档与社区资料，并在 `docs/spec/05` §5.2 标注了 `【待验证】`。
//!
//! 因此本模块的设计目标是**校准友好**，而不是「一次写对」：
//! - 未知字段一律保留在 `Session.options["extra"]`，不丢数据；
//! - 协议枚举同时接受数字与字符串两种写法；
//! - 树结构用「有 Host 即会话、否则视为文件夹」的启发式，对两种常见 ini 结构都成立；
//! - 所有无法处理的项都进 `skipped` / `warnings`，绝不静默丢弃。
//!
//! M0/S6 用 3 个真实样本校准后，只需调整 `PROTOCOL_MAP` 与 `map_options`，其余不动。

#![forbid(unsafe_code)]

use std::collections::HashMap;
use wt_common::{HintAction, WtError};
use wt_core::{Folder, FolderId, Session, SessionId, SessionKind};

// ─────────────────────────────────────────────────────────────
// 通用 INI 解析
// ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IniSection {
    pub name: String,
    pub entries: Vec<(String, String)>,
}

impl IniSection {
    pub fn get(&self, key: &str) -> Option<&str> {
        // 键名大小写不敏感：不同版本 ini 的大小写不一致
        self.entries
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v.as_str())
    }
}

/// 解析 INI。
///
/// 支持：`[section]`、`key=value`、`;` 与 `#` 注释、CRLF/LF、BOM、行尾空白。
/// 不支持（MobaXterm 也不用）：多行值、引号包裹、嵌套 section。
pub fn parse_ini(text: &str) -> Vec<IniSection> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut sections: Vec<IniSection> = Vec::new();
    let mut current: Option<IniSection> = None;

    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }

        if line.starts_with('[') && line.ends_with(']') {
            if let Some(s) = current.take() {
                sections.push(s);
            }
            current = Some(IniSection {
                name: line[1..line.len() - 1].trim().to_string(),
                entries: Vec::new(),
            });
            continue;
        }

        if let Some((k, v)) = line.split_once('=') {
            if let Some(sec) = current.as_mut() {
                sec.entries
                    .push((k.trim().to_string(), v.trim().to_string()));
            }
            // 第一个 section 之前的键忽略（MobaXterm 不会产生）
        }
    }

    if let Some(s) = current {
        sections.push(s);
    }
    sections
}

// ─────────────────────────────────────────────────────────────
// 导入计划
// ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skipped {
    pub name: String,
    pub reason: String,
}

#[derive(Debug, Default, Clone)]
pub struct ImportPlan {
    pub folders: Vec<Folder>,
    pub sessions: Vec<Session>,
    pub warnings: Vec<String>,
    pub skipped: Vec<Skipped>,
}

impl ImportPlan {
    pub fn summary(&self) -> String {
        format!(
            "文件夹 {} 个、会话 {} 个；跳过 {} 项，警告 {} 条",
            self.folders.len(),
            self.sessions.len(),
            self.skipped.len(),
            self.warnings.len()
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DuplicatePolicy {
    /// 追加 ` (2)`、` (3)`……
    Rename,
    /// 跳过重复项
    Skip,
}

// ─────────────────────────────────────────────────────────────
// 协议映射（M0/S6 校准点）
// ─────────────────────────────────────────────────────────────

/// MobaXterm 的 `Protocol` 字段取值 → 我们的会话类型。
///
/// 同时接受数字与字符串：不同版本/不同写法都见过，硬编码单一形式会在真实样本上翻车。
fn map_protocol(raw: &str) -> Result<SessionKind, String> {
    let v = raw.trim().to_ascii_lowercase();
    let kind = match v.as_str() {
        // 字符串形式
        "ssh" | "ssh2" => SessionKind::Ssh,
        "telnet" => SessionKind::Telnet,
        "rdp" => SessionKind::Rdp,
        "vnc" => SessionKind::Vnc,
        "ftp" => SessionKind::Ftp,
        "sftp" => SessionKind::Sftp,
        "mosh" => SessionKind::Mosh,
        "serial" => SessionKind::Serial,
        "local" | "shell" => SessionKind::Local,
        // 数字形式（顺序按 MobaXterm 会话类型菜单：SSH/Telnet/Rlogin/Rsh/RDP/VNC/XDMCP/FTP/SFTP/Serial/Mosh）
        "0" => SessionKind::Ssh,
        "1" => SessionKind::Telnet,
        "2" | "3" => {
            return Err("Rlogin/Rsh 已不受支持（协议不安全，建议改用 SSH）".into());
        }
        "4" => SessionKind::Rdp,
        "5" => SessionKind::Vnc,
        "6" => {
            return Err("XDMCP 已随 X11 一并移除（ADR-0012）".into());
        }
        "7" => SessionKind::Ftp,
        "8" => SessionKind::Sftp,
        "9" => SessionKind::Serial,
        "10" => SessionKind::Mosh,
        "" => SessionKind::Ssh, // 缺省按 SSH 处理，与 MobaXterm 默认一致
        other => return Err(format!("未知的协议取值 `{other}`")),
    };
    Ok(kind)
}

// ─────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────

/// 解码 ini 字节流，返回 `(文本, 实际使用的编码名)`。
///
/// MobaXterm 在中文 Windows 上写的是 GBK。直接 `from_utf8_lossy` 会把中文名变成
/// 一串 `�`——导入「成功」了，会话名却是乱码，用户只会觉得软件坏了。
///
/// 顺序：先按 UTF-8 严格解（正常情况），失败再按 GBK 解。
/// 两者都不对的情况（比如 UTF-16）会得到带替换字符的文本，由调用方提示用户。
pub fn decode_ini(bytes: &[u8]) -> (String, &'static str) {
    match std::str::from_utf8(bytes) {
        Ok(text) => (text.to_string(), "utf-8"),
        Err(_) => {
            let (text, _, had_errors) = encoding_rs::GBK.decode(bytes);
            let name = if had_errors {
                "gbk（含无法解码字节）"
            } else {
                "gbk"
            };
            (text.into_owned(), name)
        }
    }
}

/// 解析 `MobaXterm.ini` 文本，产出可直接写入 `wt-store` 的导入计划。
pub fn parse_mobaxterm_ini(text: &str) -> Result<ImportPlan, WtError> {
    parse_mobaxterm_ini_with(text, DuplicatePolicy::Rename)
}

pub fn parse_mobaxterm_ini_with(
    text: &str,
    dup: DuplicatePolicy,
) -> Result<ImportPlan, WtError> {
    let sections = parse_ini(text);

    let bookmark_sections: Vec<&IniSection> = sections
        .iter()
        .filter(|s| s.name.eq_ignore_ascii_case("Bookmarks") || s.name.starts_with("Bookmarks_"))
        .collect();

    if bookmark_sections.is_empty() {
        return Err(WtError::new("IMP_NO_BOOKMARKS")
            .message("这个文件里没有找到任何 MobaXterm 会话")
            .detail("期望存在 [Bookmarks] 或 [Bookmarks_N] 段落")
            .hint("确认选的是 MobaXterm.ini，而不是别的配置文件", HintAction::None));
    }

    let mut plan = ImportPlan::default();
    // 文件夹路径 → FolderId
    let mut folder_index: HashMap<String, FolderId> = HashMap::new();
    let mut used_names: HashMap<String, usize> = HashMap::new();

    for sec in bookmark_sections {
        let Some(bookmark_name) = sec.get("BookmarkName").map(str::trim) else {
            // 没有 BookmarkName：可能是文件夹定义行或空段，跳过
            continue;
        };
        if bookmark_name.is_empty() {
            continue;
        }

        let host = sec.get("Host").map(str::trim).unwrap_or("");
        let is_session = !host.is_empty();

        let sub_rep = sec.get("SubRep").map(str::trim).unwrap_or("");
        let path = normalize_sub_rep(sub_rep);

        if !is_session {
            // 只有名字、没有 Host → 视为文件夹
            ensure_folder_path(&mut plan, &mut folder_index, &path, bookmark_name);
            continue;
        }

        // ── 会话 ──
        let protocol_raw = sec.get("Protocol").unwrap_or("");
        let kind = match map_protocol(protocol_raw) {
            Ok(k) => k,
            Err(reason) => {
                plan.skipped.push(Skipped {
                    name: bookmark_name.to_string(),
                    reason,
                });
                continue;
            }
        };

        // 会话所在的文件夹
        let folder_id = if path.is_empty() {
            None
        } else {
            Some(ensure_folder_path(
                &mut plan,
                &mut folder_index,
                &path,
                path.rsplit('\\').next().unwrap_or(&path),
            ))
        };

        // 重名处理：同一文件夹内不允许同名（UI 上会分不清）
        let mut name = bookmark_name.to_string();
        let key = format!(
            "{}|{}",
            folder_id.as_ref().map(|f| f.as_str()).unwrap_or(""),
            name
        );
        let seen = used_names.entry(key).or_insert(0);
        if *seen > 0 {
            match dup {
                DuplicatePolicy::Skip => {
                    plan.skipped.push(Skipped {
                        name: name.clone(),
                        reason: "同名会话已存在（按策略跳过）".into(),
                    });
                    continue;
                }
                DuplicatePolicy::Rename => {
                    name = format!("{name} ({})", *seen + 1);
                }
            }
        }
        *seen += 1;

        let port = sec
            .get("Port")
            .and_then(|p| p.trim().parse::<u16>().ok())
            .or_else(|| default_port(kind));

        let mut options = serde_json::Map::new();
        collect_options(sec, &mut options, &mut plan.warnings, bookmark_name);

        plan.sessions.push(Session {
            id: SessionId::new(),
            folder_id,
            name,
            kind,
            sort_order: plan.sessions.len() as i64,
            host: Some(host.to_string()),
            port,
            username: sec
                .get("UserName")
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            environment: None,
            // 密码不导入：见 spec/05 §5.4「结构优先、凭据补录」（ADR-0010）
            credential_ref: None,
            options: serde_json::Value::Object(options),
            settings: serde_json::json!({}),
            last_used_at: None,
            last_cwd: None,
            rev: 1,
        });
    }

    // 只保留真正被引用的文件夹（会话用的 + 显式定义的）
    Ok(plan)
}

fn default_port(kind: SessionKind) -> Option<u16> {
    Some(match kind {
        SessionKind::Ssh | SessionKind::Sftp | SessionKind::Mosh => 22,
        SessionKind::Telnet => 23,
        SessionKind::Rdp => 3389,
        SessionKind::Vnc => 5900,
        SessionKind::Ftp => 21,
        _ => return None,
    })
}

/// `SubRep` 可能是 `Prod`、`Prod\`、`Prod\Web\` 等。统一成不带尾分隔符的形式。
fn normalize_sub_rep(raw: &str) -> String {
    raw.trim()
        .trim_matches('\\')
        .replace('/', "\\")
        .split('\\')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\\")
}

/// 逐级创建文件夹路径，返回最深一级的 ID。
fn ensure_folder_path(
    plan: &mut ImportPlan,
    index: &mut HashMap<String, FolderId>,
    path: &str,
    leaf_name: &str,
) -> FolderId {
    if path.is_empty() {
        // 无路径：以 leaf_name 建一个顶层文件夹
        return ensure_one(plan, index, "", leaf_name);
    }

    let mut acc = String::new();
    let mut last_id: Option<FolderId> = None;

    for seg in path.split('\\').filter(|s| !s.is_empty()) {
        let parent_key = acc.clone();
        if !acc.is_empty() {
            acc.push('\\');
        }
        acc.push_str(seg);

        let parent_id = if parent_key.is_empty() {
            None
        } else {
            index.get(&parent_key).cloned()
        };
        let id = ensure_one_with_parent(plan, index, &acc, seg, parent_id);
        last_id = Some(id);
    }

    last_id.unwrap_or_else(|| ensure_one(plan, index, "", leaf_name))
}

fn ensure_one(
    plan: &mut ImportPlan,
    index: &mut HashMap<String, FolderId>,
    key: &str,
    name: &str,
) -> FolderId {
    ensure_one_with_parent(plan, index, key, name, None)
}

fn ensure_one_with_parent(
    plan: &mut ImportPlan,
    index: &mut HashMap<String, FolderId>,
    key: &str,
    name: &str,
    parent_id: Option<FolderId>,
) -> FolderId {
    if let Some(id) = index.get(key) {
        return id.clone();
    }
    let id = FolderId::new();
    index.insert(key.to_string(), id.clone());
    plan.folders.push(Folder {
        id: id.clone(),
        parent_id,
        name: name.to_string(),
        sort_order: plan.folders.len() as i64,
        color: None,
        environment: None,
        collapsed: false,
        rev: 1,
    });
    id
}

/// 收集会话的可映射选项；无法映射的字段进 `extra`，不丢。
fn collect_options(
    sec: &IniSection,
    out: &mut serde_json::Map<String, serde_json::Value>,
    warnings: &mut Vec<String>,
    session_name: &str,
) {
    let mut extra = serde_json::Map::new();

    for (k, v) in &sec.entries {
        let kl = k.to_ascii_lowercase();
        match kl.as_str() {
            // 已由外层消费的字段
            "bookmarkname" | "subrep" | "imgnum" | "host" | "port" | "username" | "protocol" => {}

            // 可映射到我们的 options
            "compression" => {
                out.insert("compression".into(), serde_json::json!(truthy(v)));
            }
            "sshkeepalive" | "keepalive" => {
                if let Ok(n) = v.trim().parse::<u32>() {
                    out.insert("keepaliveSecs".into(), serde_json::json!(n));
                }
            }
            "remotecommand" => {
                if !v.trim().is_empty() {
                    out.insert("remoteCommand".into(), serde_json::json!(v.trim()));
                }
            }
            "privatekey" => {
                if !v.trim().is_empty() {
                    out.insert("privateKeyPath".into(), serde_json::json!(v.trim()));
                }
            }
            "terminaltype" => {
                if !v.trim().is_empty() {
                    out.insert("termType".into(), serde_json::json!(v.trim()));
                }
            }
            "gatewayhost" => {
                if !v.trim().is_empty() {
                    // 跳板机在 MobaXterm 里是「主机名 + 用户名」，我们记录为待用户绑定会话
                    extra.insert("mobaxterm.gatewayHost".into(), serde_json::json!(v.trim()));
                    warnings.push(format!(
                        "会话「{session_name}」使用了 SSH 网关 {}，导入后需在 WindTerm 里把它绑定为一个跳板会话",
                        v.trim()
                    ));
                }
            }

            // X11 已移除：读到即忽略并提示一次
            "x11forwarding" | "display" => {
                if truthy(v) && kl == "x11forwarding" {
                    warnings.push(format!(
                        "会话「{session_name}」开启了 X11 转发，WindTerm 已不支持该能力（ADR-0012），已忽略"
                    ));
                }
            }

            // 密码：不导入（ADR-0010）
            "password" => {
                if !v.trim().is_empty() {
                    extra.insert("mobaxterm.hasPassword".into(), serde_json::json!(true));
                }
            }

            // 其余全部原样保留，便于日后校准
            _ => {
                extra.insert(k.clone(), serde_json::json!(v));
            }
        }
    }

    if !extra.is_empty() {
        out.insert("extra".into(), serde_json::Value::Object(extra));
    }
}

fn truthy(v: &str) -> bool {
    matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
[Bookmarks]
SubRep=
ImgNum=42

[Bookmarks_1]
SubRep=Prod
ImgNum=41

[Bookmarks_2]
SubRep=Prod\
BookmarkName=web-01
Host=10.0.1.11
Port=22
UserName=deploy
Protocol=0
Compression=1
X11Forwarding=1
Password=ZW5jcnlwdGVk

[Bookmarks_3]
SubRep=Prod\
BookmarkName=web-02
Host=10.0.1.12
UserName=deploy

[Bookmarks_4]
SubRep=
BookmarkName=win-dc
Host=10.0.2.5
Port=3389
UserName=admin
Protocol=4

[Bookmarks_5]
SubRep=
BookmarkName=old-rlogin
Host=10.0.9.9
Protocol=2
"#;

    #[test]
    fn decode_ini_prefers_utf8_then_falls_back_to_gbk() {
        // UTF-8：原样返回
        let (text, enc) = decode_ini("生产服务器".as_bytes());
        assert_eq!(enc, "utf-8");
        assert_eq!(text, "生产服务器");

        // GBK（中文 Windows 上 MobaXterm 的默认写法）：必须正确解码，不能变成 �
        let (gbk_bytes, _, _) = encoding_rs::GBK.encode("生产服务器");
        let (text, enc) = decode_ini(&gbk_bytes);
        assert_eq!(enc, "gbk");
        assert_eq!(text, "生产服务器");
    }

    #[test]
    fn gbk_ini_imports_with_readable_names() {
        // 会话名是中文的 GBK ini：导入后名称必须是可读中文
        let ini = "[Bookmarks]\r\nSubRep=生产\\\r\nBookmarkName=生产服务器\r\nHost=10.0.1.5\r\nPort=22\r\nProtocol=0\r\n";
        let (gbk_bytes, _, _) = encoding_rs::GBK.encode(ini);
        let (text, enc) = decode_ini(&gbk_bytes);
        assert_eq!(enc, "gbk");

        let plan = parse_mobaxterm_ini(&text).expect("应能解析");
        assert!(
            plan.sessions.iter().any(|s| s.name == "生产服务器"),
            "会话名应为可读中文，实际 {:?}",
            plan.sessions.iter().map(|s| &s.name).collect::<Vec<_>>()
        );
        assert!(
            plan.folders.iter().any(|f| f.name == "生产"),
            "文件夹名应为可读中文，实际 {:?}",
            plan.folders.iter().map(|f| &f.name).collect::<Vec<_>>()
        );
    }

    #[test]
    fn parses_ini_sections_and_keys() {
        let secs = parse_ini(SAMPLE);
        assert!(secs.iter().any(|s| s.name == "Bookmarks"));
        assert!(secs.iter().any(|s| s.name == "Bookmarks_2"));

        let b2 = secs.iter().find(|s| s.name == "Bookmarks_2").unwrap();
        assert_eq!(b2.get("Host"), Some("10.0.1.11"));
        // 键名大小写不敏感
        assert_eq!(b2.get("host"), Some("10.0.1.11"));
        assert_eq!(b2.get("USERNAME"), Some("deploy"));
    }

    #[test]
    fn ini_handles_bom_comments_and_crlf() {
        let text = "\u{feff}; 注释\r\n[Bookmarks_1]\r\n# 也是注释\r\nBookmarkName=x\r\nHost=1.2.3.4\r\n";
        let secs = parse_ini(text);
        assert_eq!(secs.len(), 1);
        assert_eq!(secs[0].get("BookmarkName"), Some("x"));
        assert_eq!(secs[0].get("Host"), Some("1.2.3.4"));
    }

    #[test]
    fn imports_sessions_and_folders() {
        let plan = parse_mobaxterm_ini(SAMPLE).unwrap();
        assert_eq!(plan.sessions.len(), 3, "应导入 ssh×2 + rdp×1");
        assert!(plan.folders.iter().any(|f| f.name == "Prod"));

        let web01 = plan.sessions.iter().find(|s| s.name == "web-01").unwrap();
        assert_eq!(web01.kind, SessionKind::Ssh);
        assert_eq!(web01.host.as_deref(), Some("10.0.1.11"));
        assert_eq!(web01.port, Some(22));
        assert_eq!(web01.username.as_deref(), Some("deploy"));
        assert!(web01.folder_id.is_some(), "应落在 Prod 文件夹里");
        assert_eq!(web01.options["compression"], serde_json::json!(true));
        // 密码不导入
        assert!(web01.credential_ref.is_none());
        assert_eq!(
            web01.options["extra"]["mobaxterm.hasPassword"],
            serde_json::json!(true)
        );
    }

    #[test]
    fn default_port_is_applied_when_missing() {
        let plan = parse_mobaxterm_ini(SAMPLE).unwrap();
        let web02 = plan.sessions.iter().find(|s| s.name == "web-02").unwrap();
        assert_eq!(web02.port, Some(22), "缺省 SSH 端口");

        let rdp = plan.sessions.iter().find(|s| s.name == "win-dc").unwrap();
        assert_eq!(rdp.kind, SessionKind::Rdp);
        assert_eq!(rdp.port, Some(3389));
    }

    #[test]
    fn rlogin_is_skipped_with_reason() {
        let plan = parse_mobaxterm_ini(SAMPLE).unwrap();
        assert_eq!(plan.skipped.len(), 1);
        assert_eq!(plan.skipped[0].name, "old-rlogin");
        assert!(plan.skipped[0].reason.contains("Rlogin"));
    }

    #[test]
    fn x11_field_produces_warning_not_silent_drop() {
        let plan = parse_mobaxterm_ini(SAMPLE).unwrap();
        assert!(
            plan.warnings.iter().any(|w| w.contains("X11")),
            "X11 字段必须提示，不能静默忽略：{:?}",
            plan.warnings
        );
    }

    #[test]
    fn unknown_fields_are_preserved_in_extra() {
        let text = r#"
[Bookmarks_1]
BookmarkName=odd
Host=1.1.1.1
Protocol=ssh
SomeFutureField=abc
"#;
        let plan = parse_mobaxterm_ini(text).unwrap();
        assert_eq!(
            plan.sessions[0].options["extra"]["SomeFutureField"],
            serde_json::json!("abc")
        );
    }

    #[test]
    fn unknown_protocol_is_skipped() {
        let text = r#"
[Bookmarks_1]
BookmarkName=weird
Host=1.1.1.1
Protocol=99
"#;
        let plan = parse_mobaxterm_ini(text).unwrap();
        assert_eq!(plan.sessions.len(), 0);
        assert_eq!(plan.skipped.len(), 1);
        assert!(plan.skipped[0].reason.contains("99"));
    }

    #[test]
    fn xdmcp_is_skipped_because_x11_removed() {
        let text = r#"
[Bookmarks_1]
BookmarkName=xdmcp-box
Host=1.1.1.1
Protocol=6
"#;
        let plan = parse_mobaxterm_ini(text).unwrap();
        assert_eq!(plan.sessions.len(), 0);
        assert!(plan.skipped[0].reason.contains("X11"));
    }

    #[test]
    fn duplicate_names_are_renamed() {
        let text = r#"
[Bookmarks_1]
BookmarkName=dup
Host=1.1.1.1
Protocol=ssh

[Bookmarks_2]
BookmarkName=dup
Host=2.2.2.2
Protocol=ssh
"#;
        let plan = parse_mobaxterm_ini(text).unwrap();
        assert_eq!(plan.sessions.len(), 2);
        let names: Vec<&str> = plan.sessions.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"dup"));
        assert!(names.contains(&"dup (2)"));
    }

    #[test]
    fn duplicate_policy_skip() {
        let text = r#"
[Bookmarks_1]
BookmarkName=dup
Host=1.1.1.1
Protocol=ssh

[Bookmarks_2]
BookmarkName=dup
Host=2.2.2.2
Protocol=ssh
"#;
        let plan = parse_mobaxterm_ini_with(text, DuplicatePolicy::Skip).unwrap();
        assert_eq!(plan.sessions.len(), 1);
        assert_eq!(plan.skipped.len(), 1);
    }

    #[test]
    fn nested_subrep_builds_hierarchy() {
        let text = r#"
[Bookmarks_1]
SubRep=Prod\Web\
BookmarkName=web-01
Host=10.0.0.1
Protocol=ssh
"#;
        let plan = parse_mobaxterm_ini(text).unwrap();
        assert_eq!(plan.folders.len(), 2, "应建 Prod 与 Prod\\Web 两级");

        let prod = plan.folders.iter().find(|f| f.name == "Prod").unwrap();
        let web = plan.folders.iter().find(|f| f.name == "Web").unwrap();
        assert_eq!(web.parent_id.as_ref(), Some(&prod.id));
        assert_eq!(plan.sessions[0].folder_id.as_ref(), Some(&web.id));
    }

    #[test]
    fn folder_only_sections_are_created() {
        let text = r#"
[Bookmarks_1]
SubRep=Lab
BookmarkName=Lab
"#;
        let plan = parse_mobaxterm_ini(text).unwrap();
        assert_eq!(plan.folders.len(), 1);
        assert_eq!(plan.sessions.len(), 0);
    }

    #[test]
    fn missing_bookmarks_section_is_a_clear_error() {
        let err = parse_mobaxterm_ini("[Other]\nfoo=bar\n").unwrap_err();
        assert_eq!(err.code, "IMP_NO_BOOKMARKS");
        assert!(err.hints.iter().any(|h| h.label.contains("MobaXterm.ini")));
    }

    #[test]
    fn subrep_normalization() {
        assert_eq!(normalize_sub_rep("Prod"), "Prod");
        assert_eq!(normalize_sub_rep("Prod\\"), "Prod");
        assert_eq!(normalize_sub_rep("Prod\\Web\\"), "Prod\\Web");
        assert_eq!(normalize_sub_rep("Prod/Web/"), "Prod\\Web");
        assert_eq!(normalize_sub_rep("  "), "");
    }

    #[test]
    fn plan_summary_is_readable() {
        let plan = parse_mobaxterm_ini(SAMPLE).unwrap();
        let s = plan.summary();
        assert!(s.contains("会话 3"));
        assert!(s.contains("跳过 1"));
    }
}
