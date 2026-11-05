//! WindTerm 领域模型：会话、文件夹、会话树、连接链路校验。
//!
//! 设计依据：`docs/design/04-data-model.md` §2、`docs/spec/05-func-sessions.md`。
//!
//! 约束（`docs/design/01-architecture.md` §3.1）：
//! - 本 crate **不引入 tokio、不读文件、不连网络**，保证领域逻辑可纯函数测试；
//! - 不依赖 `wt-store`（持久化方向是 store → core，不是反过来）。

#![forbid(unsafe_code)]

pub mod id;

pub use id::{FolderId, SessionId, TunnelId};

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use wt_common::{HintAction, WtError};

/// 领域层版本，随模型不兼容变更递增。
pub const DOMAIN_VERSION: u32 = 1;

/// 会话类型。
///
/// 注意：`Xdmcp` 已随 X11 移除（ADR-0012）。此处不保留该变体——数据层读到旧值时应
/// 映射为「不支持的会话类型」并在导入报告中说明，而不是让枚举里留一个永远不可用的值。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionKind {
    Ssh,
    Telnet,
    Rdp,
    Vnc,
    Ftp,
    Sftp,
    Mosh,
    Serial,
    Local,
}

impl SessionKind {
    /// 是否有终端界面（决定连接后是否创建 PTY/终端标签）。
    pub fn has_terminal(self) -> bool {
        matches!(
            self,
            SessionKind::Ssh
                | SessionKind::Telnet
                | SessionKind::Mosh
                | SessionKind::Serial
                | SessionKind::Local
        )
    }

    /// 是否有图形界面（决定连接后是否创建 canvas 标签）。
    pub fn has_graphics(self) -> bool {
        matches!(self, SessionKind::Rdp | SessionKind::Vnc)
    }

    /// 是否走 SSH 传输（决定能否配置跳板机、能否复用 SSH 连接池）。
    pub fn is_ssh_based(self) -> bool {
        matches!(self, SessionKind::Ssh | SessionKind::Sftp | SessionKind::Mosh)
    }

    /// 是否为明文协议（首次使用需确认风险，`SEC-009` 可禁用）。
    pub fn is_plaintext(self) -> bool {
        matches!(self, SessionKind::Telnet | SessionKind::Ftp)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            SessionKind::Ssh => "ssh",
            SessionKind::Telnet => "telnet",
            SessionKind::Rdp => "rdp",
            SessionKind::Vnc => "vnc",
            SessionKind::Ftp => "ftp",
            SessionKind::Sftp => "sftp",
            SessionKind::Mosh => "mosh",
            SessionKind::Serial => "serial",
            SessionKind::Local => "local",
        }
    }

    /// 从存储中的字符串解析。未知值返回 `None`（调用方决定是跳过还是报错）。
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "ssh" => SessionKind::Ssh,
            "telnet" => SessionKind::Telnet,
            "rdp" => SessionKind::Rdp,
            "vnc" => SessionKind::Vnc,
            "ftp" => SessionKind::Ftp,
            "sftp" => SessionKind::Sftp,
            "mosh" => SessionKind::Mosh,
            "serial" => SessionKind::Serial,
            "local" => SessionKind::Local,
            _ => return None,
        })
    }
}

/// 环境标识。用于着色与「多执行广播时的额外确认」（`SEC-011`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Environment {
    Production,
    Staging,
    Test,
    Dev,
}

impl Environment {
    pub fn is_production(self) -> bool {
        matches!(self, Environment::Production)
    }
}

/// 文件夹（会话树中的容器）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Folder {
    pub id: FolderId,
    pub parent_id: Option<FolderId>,
    pub name: String,
    pub sort_order: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<Environment>,
    #[serde(default)]
    pub collapsed: bool,
    #[serde(default = "default_rev")]
    pub rev: i64,
}

/// 会话。
///
/// 通用连接字段用独立列（可查询、可索引），协议特有字段放 `options`（JSON，加字段不需迁移）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Session {
    pub id: SessionId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<FolderId>,
    pub name: String,
    pub kind: SessionKind,
    #[serde(default)]
    pub sort_order: i64,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<Environment>,
    /// 保险库条目 ID，**不含密文**。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_ref: Option<String>,

    /// 协议特有字段（见 `design/04` §2.3 的 JSON Schema）。
    #[serde(default)]
    pub options: serde_json::Value,
    /// 会话级设置覆盖。
    #[serde(default)]
    pub settings: serde_json::Value,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_cwd: Option<String>,

    #[serde(default = "default_rev")]
    pub rev: i64,
}

fn default_rev() -> i64 {
    1
}

impl Session {
    /// 直接跳板（`options.jumpSessionId`）。空字符串视为未配置。
    pub fn jump(&self) -> Option<SessionId> {
        self.options
            .get("jumpSessionId")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(SessionId::from)
    }

    /// 设置/清除直接跳板（`options.jumpSessionId`）。传 `None` 或空 id 等价于清除。
    ///
    /// 只暴露这一个 setter，而不是让调用方直接改 `options`：键名与
    /// 「空字符串等于未配置」这条约定必须只有一处定义，否则迟早出现
    /// 「界面写 `jumpId`、核心读 `jumpSessionId`」这种对不上的情况。
    pub fn set_jump(&mut self, jump: Option<SessionId>) {
        if !self.options.is_object() {
            self.options = serde_json::json!({});
        }
        match jump {
            Some(j) if !j.as_str().is_empty() => {
                self.options["jumpSessionId"] = serde_json::Value::String(j.as_str().to_string());
            }
            _ => {
                if let Some(map) = self.options.as_object_mut() {
                    map.remove("jumpSessionId");
                }
            }
        }
    }

    /// 目标地址的展示形式（用于 UI 与诊断）。
    pub fn endpoint_label(&self) -> String {
        match (&self.host, self.port) {
            (Some(h), Some(p)) => format!("{h}:{p}"),
            (Some(h), None) => h.clone(),
            _ => self.name.clone(),
        }
    }
}

/// 会话树节点（渲染用）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TreeNode {
    Folder {
        folder: Folder,
        children: Vec<TreeNode>,
    },
    Session(Session),
}

impl TreeNode {
    pub fn name(&self) -> &str {
        match self {
            TreeNode::Folder { folder, .. } => &folder.name,
            TreeNode::Session(s) => &s.name,
        }
    }
}

/// 构建会话树。
///
/// 规则：
/// - 根节点是 `parent_id == None` 的文件夹与会话；
/// - 同级按 `sort_order` 升序，相同则按名称；
/// - **孤儿节点**（父不存在）提升到根，并记入返回值——绝不静默丢弃用户数据。
pub fn build_tree(folders: &[Folder], sessions: &[Session]) -> (Vec<TreeNode>, Vec<String>) {
    let mut orphans = Vec::new();

    let folder_ids: HashSet<&FolderId> = folders.iter().map(|f| &f.id).collect();

    let mut folder_children: HashMap<Option<FolderId>, Vec<&Folder>> = HashMap::new();
    for f in folders {
        let parent = match &f.parent_id {
            Some(p) if folder_ids.contains(p) => Some(p.clone()),
            Some(p) => {
                orphans.push(format!(
                    "文件夹「{}」的父节点 {} 不存在，已提升到根",
                    f.name, p
                ));
                None
            }
            None => None,
        };
        folder_children.entry(parent).or_default().push(f);
    }

    let mut session_children: HashMap<Option<FolderId>, Vec<&Session>> = HashMap::new();
    for s in sessions {
        let parent = match &s.folder_id {
            Some(p) if folder_ids.contains(p) => Some(p.clone()),
            Some(p) => {
                orphans.push(format!(
                    "会话「{}」的文件夹 {} 不存在，已提升到根",
                    s.name, p
                ));
                None
            }
            None => None,
        };
        session_children.entry(parent).or_default().push(s);
    }

    fn build(
        parent: Option<FolderId>,
        folder_children: &HashMap<Option<FolderId>, Vec<&Folder>>,
        session_children: &HashMap<Option<FolderId>, Vec<&Session>>,
        depth: usize,
    ) -> Vec<TreeNode> {
        // 深度保护：外部导入的数据不可信，可能形成环
        if depth > 64 {
            return Vec::new();
        }

        let mut items: Vec<TreeNode> = Vec::new();

        if let Some(fs) = folder_children.get(&parent) {
            let mut sorted: Vec<&&Folder> = fs.iter().collect();
            sorted.sort_by_key(|f| (f.sort_order, f.name.clone()));
            for f in sorted {
                let children = build(
                    Some(f.id.clone()),
                    folder_children,
                    session_children,
                    depth + 1,
                );
                items.push(TreeNode::Folder {
                    folder: (*f).clone(),
                    children,
                });
            }
        }

        if let Some(ss) = session_children.get(&parent) {
            let mut sorted: Vec<&&Session> = ss.iter().collect();
            sorted.sort_by_key(|s| (s.sort_order, s.name.clone()));
            for s in sorted {
                items.push(TreeNode::Session((*s).clone()));
            }
        }

        items
    }

    (
        build(None, &folder_children, &session_children, 0),
        orphans,
    )
}

/// 把文件夹移动到新的父节点。
///
/// 拒绝：移到自己、移到自己的后代（会形成环）。
pub fn move_folder(
    folders: &mut [Folder],
    folder_id: &FolderId,
    new_parent: Option<FolderId>,
) -> Result<(), WtError> {
    if let Some(target) = &new_parent {
        if target == folder_id {
            return Err(WtError::new("CORE_FOLDER_CYCLE")
                .message("不能把文件夹移动到自己里面")
                .hint("选择其他位置", HintAction::None));
        }

        let parent_of: HashMap<&FolderId, Option<FolderId>> =
            folders.iter().map(|f| (&f.id, f.parent_id.clone())).collect();

        let mut cursor = Some(target.clone());
        let mut guard = 0;
        while let Some(cur) = cursor {
            if &cur == folder_id {
                return Err(WtError::new("CORE_FOLDER_CYCLE")
                    .message("不能把文件夹移动到它自己的子文件夹里")
                    .detail(format!("目标 {target} 是 {folder_id} 的后代"))
                    .hint("选择其他位置", HintAction::None));
            }
            cursor = parent_of.get(&cur).cloned().flatten();
            guard += 1;
            if guard > 64 {
                return Err(WtError::new("CORE_FOLDER_CYCLE")
                    .message("文件夹层级异常（可能存在环），已中止移动"));
            }
        }
    }

    let target = folders
        .iter_mut()
        .find(|f| &f.id == folder_id)
        .ok_or_else(|| {
            WtError::new("CORE_NOT_FOUND").message(format!("文件夹 {folder_id} 不存在"))
        })?;
    target.parent_id = new_parent;
    target.rev += 1;
    Ok(())
}

/// 删除文件夹时，收集需要一并删除的节点（含所有后代）。
pub fn collect_cascade_delete(
    folders: &[Folder],
    sessions: &[Session],
    root: &FolderId,
) -> (Vec<FolderId>, Vec<SessionId>) {
    let mut folder_ids: Vec<FolderId> = Vec::new();
    let mut stack = vec![root.clone()];
    let mut seen = HashSet::new();

    while let Some(cur) = stack.pop() {
        if !seen.insert(cur.clone()) {
            continue;
        }
        folder_ids.push(cur.clone());
        for f in folders {
            if f.parent_id.as_ref() == Some(&cur) {
                stack.push(f.id.clone());
            }
        }
    }

    let session_ids = sessions
        .iter()
        .filter(|s| s.folder_id.as_ref().is_some_and(|f| folder_ids.contains(f)))
        .map(|s| s.id.clone())
        .collect();

    (folder_ids, session_ids)
}

/// 隧道类型（`NET-001` / `NET-002` / `NET-003`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TunnelKind {
    /// 本地转发 `-L`
    Local,
    /// 远程转发 `-R`（尚未实现，见 `README` 的 `G13`）
    Remote,
    /// 动态代理 SOCKS5 `-D`
    Dynamic,
}

/// 一条隧道的配置（`design/10` §3.1 的 `TunnelSpec`）。
///
/// `listen_port = 0` 表示「由系统分配」——**不要**在保存时把它改写成实际端口：
/// 那会把「每次随机」悄悄变成「固定某个端口」，下次启动可能撞上占用。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TunnelSpec {
    pub id: String,
    pub name: String,
    pub kind: TunnelKind,
    pub listen_host: String,
    pub listen_port: u16,
    pub target_host: Option<String>,
    pub target_port: Option<u16>,
    /// 承载它的会话（`viaSessionId`）；为空表示用连接时的临时参数
    pub via_session_id: Option<SessionId>,
    /// `manual` / `onAppStart`：应用启动后自动拉起
    pub auto_start: bool,
    /// 用户自定义分组（`NET-004`）。空表示不分组——界面退回按类型（`-L`/`-R`/`-D`）自动分。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

impl TunnelSpec {
    /// 校验配置是否自洽。
    ///
    /// 关键是**拒绝矛盾配置**：动态代理带了目标、本地转发没有目标、
    /// 或者配了还没实现的 `-R`。让这类行存进库里，用户会以为它生效了。
    pub fn validate(&self) -> Result<(), WtError> {
        if self.id.trim().is_empty() {
            return Err(WtError::new("TUN_BAD_ARGUMENT").message("隧道 id 不能为空"));
        }
        if self.name.trim().is_empty() {
            return Err(WtError::new("TUN_BAD_ARGUMENT")
                .message("隧道名称不能为空")
                .hint("给隧道起个能认出来的名字，比如「测试库」", HintAction::None));
        }
        match self.kind {
            TunnelKind::Local | TunnelKind::Remote => {
                // `-L` 的目标在服务器侧、`-R` 的目标在本机，但两者的必填项一样：
                // 没有目标就无从转发
                let host = self.target_host.as_deref().unwrap_or_default().trim();
                if host.is_empty() {
                    return Err(WtError::new("TUN_BAD_ARGUMENT")
                        .message(if self.kind == TunnelKind::Local {
                            "本地转发必须有目标主机"
                        } else {
                            "远程转发必须有本机目标主机"
                        })
                        .detail("目标主机名在服务器侧解析，比如 db 或 redis.internal"));
                }
                if self.target_port.unwrap_or(0) == 0 {
                    return Err(WtError::new("TUN_BAD_ARGUMENT")
                        .message("转发必须有目标端口")
                        .detail("端口范围 1–65535"));
                }
                Ok(())
            }
            TunnelKind::Dynamic => {
                // 动态代理的目标由客户端每次请求决定；留着一个目标字段会让人
                // 以为它是「限定只能连这个」，排查时会被自己骗
                if self.target_host.as_deref().unwrap_or_default().trim().is_empty() {
                    Ok(())
                } else {
                    Err(WtError::new("TUN_BAD_ARGUMENT")
                        .message("动态代理不需要目标主机")
                        .detail("SOCKS5 的目标由客户端每次请求决定；请清空目标字段"))
                }
            }
        }
    }

    /// `listen_port = 0` 时，这一行描述的是「系统随机端口」而不是某个固定端口。
    pub fn wants_ephemeral_port(&self) -> bool {
        self.listen_port == 0
    }
}

/// 校验跳板链：不存在环，且不超过 5 跳。
///
/// `chain_of` 返回某会话直接依赖的跳板（通常来自 `options.jumpSessionId`）。
pub fn validate_jump_chain<F>(start: &SessionId, chain_of: F) -> Result<Vec<SessionId>, WtError>
where
    F: Fn(&SessionId) -> Vec<SessionId>,
{
    let mut chain = Vec::new();
    let mut seen = HashSet::new();
    let mut cursor = start.clone();

    loop {
        let next = chain_of(&cursor);
        let Some(jump) = next.into_iter().next() else {
            break;
        };

        if !seen.insert(jump.clone()) {
            return Err(WtError::new("SES_JUMP_CYCLE")
                .message("跳板链存在循环引用")
                .detail(format!("会话 {jump} 重复出现"))
                .hint(
                    "编辑会话的跳板设置，去掉循环",
                    HintAction::OpenSettings {
                        page: "session.jump".into(),
                    },
                ));
        }
        if jump == *start {
            return Err(WtError::new("SES_JUMP_CYCLE")
                .message("跳板链指回了自己")
                .detail(format!("会话 {jump} 把自己设为跳板")));
        }

        chain.push(jump.clone());
        cursor = jump;

        if chain.len() > 5 {
            return Err(WtError::new("SES_JUMP_TOO_LONG")
                .message("跳板链最多 5 跳")
                .detail(format!("当前已超过 5 跳：{}", chain.len()))
                .hint("减少跳数", HintAction::None));
        }
    }

    Ok(chain)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn folder(id: &str, parent: Option<&str>, name: &str, order: i64) -> Folder {
        Folder {
            id: FolderId::from(id),
            parent_id: parent.map(FolderId::from),
            name: name.into(),
            sort_order: order,
            color: None,
            environment: None,
            collapsed: false,
            rev: 1,
        }
    }

    fn session(id: &str, folder: Option<&str>, name: &str, order: i64) -> Session {
        Session {
            id: SessionId::from(id),
            folder_id: folder.map(FolderId::from),
            name: name.into(),
            kind: SessionKind::Ssh,
            sort_order: order,
            host: Some("10.0.1.11".into()),
            port: Some(22),
            username: Some("deploy".into()),
            environment: None,
            credential_ref: None,
            options: json!({}),
            settings: json!({}),
            last_used_at: None,
            last_cwd: None,
            rev: 1,
        }
    }

    #[test]
    fn builds_nested_tree_with_order() {
        let folders = vec![
            folder("f1", None, "生产", 0),
            folder("f2", Some("f1"), "Web", 0),
            folder("f3", None, "测试", 1),
        ];
        let sessions = vec![
            session("s1", Some("f2"), "web-02", 1),
            session("s2", Some("f2"), "web-01", 0),
            session("s3", None, "root-box", 0),
        ];

        let (tree, orphans) = build_tree(&folders, &sessions);
        assert!(orphans.is_empty());
        assert_eq!(tree.len(), 3); // 生产 / 测试 / root-box

        let TreeNode::Folder { folder, children } = &tree[0] else {
            panic!("第一个节点应为文件夹");
        };
        assert_eq!(folder.name, "生产");
        assert_eq!(children.len(), 1);

        let TreeNode::Folder {
            children: web_children,
            ..
        } = &children[0]
        else {
            panic!("子节点应为文件夹");
        };
        // 同级按 sort_order：web-01(0) 在 web-02(1) 之前
        assert_eq!(web_children[0].name(), "web-01");
        assert_eq!(web_children[1].name(), "web-02");
    }

    #[test]
    fn orphan_nodes_are_promoted_not_dropped() {
        let folders = vec![folder("f1", Some("missing"), "孤儿文件夹", 0)];
        let sessions = vec![session("s1", Some("missing"), "孤儿会话", 0)];

        let (tree, orphans) = build_tree(&folders, &sessions);
        assert_eq!(tree.len(), 2, "孤儿必须被提升到根，不能丢");
        assert_eq!(orphans.len(), 2);
        assert!(orphans[0].contains("父节点"));
        assert!(orphans[1].contains("文件夹"));
    }

    #[test]
    fn move_folder_rejects_self() {
        let mut folders = vec![folder("f1", None, "A", 0)];
        let err =
            move_folder(&mut folders, &FolderId::from("f1"), Some(FolderId::from("f1")))
                .unwrap_err();
        assert_eq!(err.code, "CORE_FOLDER_CYCLE");
    }

    #[test]
    fn move_folder_rejects_descendant() {
        let mut folders = vec![
            folder("f1", None, "A", 0),
            folder("f2", Some("f1"), "B", 0),
            folder("f3", Some("f2"), "C", 0),
        ];
        let err =
            move_folder(&mut folders, &FolderId::from("f1"), Some(FolderId::from("f3")))
                .unwrap_err();
        assert_eq!(err.code, "CORE_FOLDER_CYCLE");
        assert!(err.detail.unwrap().contains("后代"));
    }

    #[test]
    fn move_folder_succeeds_and_bumps_rev() {
        let mut folders = vec![folder("f1", None, "A", 0), folder("f2", None, "B", 0)];
        move_folder(&mut folders, &FolderId::from("f2"), Some(FolderId::from("f1"))).unwrap();
        let moved = folders.iter().find(|f| f.id == FolderId::from("f2")).unwrap();
        assert_eq!(moved.parent_id, Some(FolderId::from("f1")));
        assert_eq!(moved.rev, 2);
    }

    #[test]
    fn cascade_delete_collects_descendants() {
        let folders = vec![
            folder("f1", None, "A", 0),
            folder("f2", Some("f1"), "B", 0),
            folder("f3", Some("f2"), "C", 0),
            folder("f4", None, "D", 0),
        ];
        let sessions = vec![
            session("s1", Some("f1"), "x", 0),
            session("s2", Some("f3"), "y", 0),
            session("s3", Some("f4"), "z", 0),
        ];

        let (fids, sids) = collect_cascade_delete(&folders, &sessions, &FolderId::from("f1"));
        assert_eq!(fids.len(), 3);
        assert!(fids.contains(&FolderId::from("f3")));
        assert_eq!(sids.len(), 2);
        assert!(
            !sids.contains(&SessionId::from("s3")),
            "别的文件夹的会话不能删"
        );
    }

    #[test]
    fn jump_chain_detects_cycle() {
        let chain = |id: &SessionId| -> Vec<SessionId> {
            match id.as_str() {
                "a" => vec![SessionId::from("b")],
                "b" => vec![SessionId::from("a")],
                _ => vec![],
            }
        };
        let err = validate_jump_chain(&SessionId::from("a"), chain).unwrap_err();
        assert_eq!(err.code, "SES_JUMP_CYCLE");
    }

    #[test]
    fn tunnel_spec_validation_rejects_contradictions() {
        let base = TunnelSpec {
            id: "t1".into(),
            name: "测试库".into(),
            kind: TunnelKind::Local,
            listen_host: "127.0.0.1".into(),
            listen_port: 0,
            target_host: Some("db".into()),
            target_port: Some(3306),
            via_session_id: None,
            auto_start: false,
            group: None,
        };
        assert!(base.validate().is_ok(), "正常的本地转发应当通过");
        assert!(base.wants_ephemeral_port(), "端口 0 表示系统分配");

        // 本地转发缺目标 → 拒绝：留着会变成「点了启动却立刻失败」的坏配置
        let mut no_target = base.clone();
        no_target.target_host = None;
        assert_eq!(no_target.validate().unwrap_err().code, "TUN_BAD_ARGUMENT");

        let mut no_port = base.clone();
        no_port.target_port = Some(0);
        assert_eq!(no_port.validate().unwrap_err().code, "TUN_BAD_ARGUMENT");

        // 动态代理不能带目标：带了会让人以为「只能连这个」
        let mut dyn_with_target = base.clone();
        dyn_with_target.kind = TunnelKind::Dynamic;
        assert_eq!(
            dyn_with_target.validate().unwrap_err().code,
            "TUN_BAD_ARGUMENT"
        );

        let mut dyn_ok = base.clone();
        dyn_ok.kind = TunnelKind::Dynamic;
        dyn_ok.target_host = None;
        dyn_ok.target_port = None;
        assert!(dyn_ok.validate().is_ok());
        assert_eq!(dyn_ok.listen_port, 0, "动态代理同样支持随机端口");

        // -R 已实现：必填项与 -L 一样（目标变成「本机目标」），不再拒绝
        let mut remote = base.clone();
        remote.kind = TunnelKind::Remote;
        assert!(remote.validate().is_ok(), "-R 现在应当通过校验");
        let mut remote_no_target = remote.clone();
        remote_no_target.target_host = None;
        assert_eq!(
            remote_no_target.validate().unwrap_err().code,
            "TUN_BAD_ARGUMENT",
            "-R 没有本机目标时应拒绝"
        );

        let mut no_name = base.clone();
        no_name.name = "  ".into();
        assert_eq!(no_name.validate().unwrap_err().code, "TUN_BAD_ARGUMENT");
    }

    #[test]
    fn set_jump_roundtrips_and_clears() {
        let mut s = Session {
            id: SessionId::from("t"),
            folder_id: None,
            name: "target".into(),
            kind: SessionKind::Ssh,
            sort_order: 0,
            host: Some("10.0.0.5".into()),
            port: Some(22),
            username: None,
            environment: None,
            credential_ref: None,
            // 别的选项必须被保留：清跳板不该顺手抹掉用户其它配置
            options: serde_json::json!({ "keepMe": "yes" }),
            settings: Default::default(),
            last_used_at: None,
            last_cwd: None,
            rev: 1,
        };
        assert_eq!(s.jump(), None);

        s.set_jump(Some(SessionId::from("bastion")));
        assert_eq!(s.jump().map(|j| j.as_str().to_string()), Some("bastion".into()));
        assert_eq!(s.options["keepMe"], "yes", "其它选项不能被抹掉");

        // 空 id 与 None 都表示「不经跳板」
        s.set_jump(Some(SessionId::from("")));
        assert_eq!(s.jump(), None);
        assert_eq!(s.options["keepMe"], "yes");

        s.set_jump(Some(SessionId::from("bastion2")));
        s.set_jump(None);
        assert_eq!(s.jump(), None);
        assert_eq!(s.options["keepMe"], "yes");
    }

    #[test]
    fn jump_chain_accepts_linear() {
        let chain = |id: &SessionId| -> Vec<SessionId> {
            match id.as_str() {
                "target" => vec![SessionId::from("bastion2")],
                "bastion2" => vec![SessionId::from("bastion1")],
                _ => vec![],
            }
        };
        let got = validate_jump_chain(&SessionId::from("target"), chain).unwrap();
        assert_eq!(
            got,
            vec![SessionId::from("bastion2"), SessionId::from("bastion1")]
        );
    }

    #[test]
    fn jump_chain_limits_depth() {
        let chain = |id: &SessionId| -> Vec<SessionId> {
            let n: u32 = id.as_str().trim_start_matches('h').parse().unwrap_or(0);
            vec![SessionId::from(format!("h{}", n + 1))]
        };
        let err = validate_jump_chain(&SessionId::from("h0"), chain).unwrap_err();
        assert_eq!(err.code, "SES_JUMP_TOO_LONG");
    }

    #[test]
    fn session_kind_capabilities() {
        assert!(SessionKind::Ssh.has_terminal());
        assert!(SessionKind::Rdp.has_graphics());
        assert!(!SessionKind::Rdp.has_terminal());
        assert!(SessionKind::Sftp.is_ssh_based());
        assert!(SessionKind::Telnet.is_plaintext());
        assert!(!SessionKind::Vnc.is_plaintext());
    }

    #[test]
    fn session_kind_roundtrip_includes_no_xdmcp() {
        let s = serde_json::to_string(&SessionKind::Rdp).unwrap();
        assert_eq!(s, "\"rdp\"");
        // XDMCP 已移除：反序列化必须失败，避免旧数据被静默接受
        assert!(serde_json::from_str::<SessionKind>("\"xdmcp\"").is_err());
        assert_eq!(SessionKind::parse("xdmcp"), None);
        assert_eq!(SessionKind::parse("ssh"), Some(SessionKind::Ssh));
    }

    #[test]
    fn jump_reads_option_and_ignores_empty() {
        let mut s = session("s1", None, "a", 0);
        assert_eq!(s.jump(), None);
        s.options = json!({ "jumpSessionId": "" });
        assert_eq!(s.jump(), None);
        s.options = json!({ "jumpSessionId": "bastion" });
        assert_eq!(s.jump(), Some(SessionId::from("bastion")));
    }
}
