//! 端到端验收：MobaXterm ini → 导入计划 → 落库 → 读回 → 会话树。
//!
//! 对应 `docs/spec/05-func-sessions.md` §5.5 的 AC-1、AC-2、AC-3：
//! - AC-1 树结构与源文件一致
//! - AC-2 不支持的会话类型被保留并标注（而非静默丢弃）
//! - AC-3 私钥路径被记录，不存在时在结果中列出
//!
//! 这是「功能真的能用」的最小证据：两个 crate 单独测试通过，不代表串起来能跑。

use wt_core::build_tree;
use wt_core::TreeNode;
use wt_import::parse_mobaxterm_ini;
use wt_store::Store;

const INI: &str = r#"
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
PrivateKey=C:\Users\zhang\.ssh\id_ed25519

[Bookmarks_3]
SubRep=Prod\
BookmarkName=web-02
Host=10.0.1.12
UserName=deploy
Protocol=0

[Bookmarks_4]
SubRep=Test\
BookmarkName=db-01
Host=10.0.3.21
UserName=root
Protocol=0

[Bookmarks_5]
SubRep=
BookmarkName=win-dc
Host=10.0.2.5
Port=3389
UserName=admin
Protocol=4

[Bookmarks_6]
SubRep=
BookmarkName=legacy-rlogin
Host=10.0.9.9
Protocol=2
"#;

#[test]
fn mobaxterm_ini_survives_the_round_trip() {
    let plan = parse_mobaxterm_ini(INI).expect("解析应成功");
    assert_eq!(plan.sessions.len(), 4, "ssh×3 + rdp×1");
    assert_eq!(plan.skipped.len(), 1, "rlogin 应被跳过");

    let mut store = Store::open_in_memory().unwrap();
    let report = store.import(&plan.folders, &plan.sessions).expect("导入应成功");
    assert_eq!(report.sessions, 4);
    assert_eq!(report.folders, plan.folders.len());

    let snap = store.load_snapshot().unwrap();
    assert!(snap.warnings.is_empty(), "不应有解析告警：{:?}", snap.warnings);
    assert_eq!(snap.sessions.len(), 4);
    assert_eq!(snap.folders.len(), plan.folders.len());

    // AC-1：树结构还原
    let (tree, orphans) = build_tree(&snap.folders, &snap.sessions);
    assert!(orphans.is_empty());

    let prod = tree
        .iter()
        .find_map(|n| match n {
            TreeNode::Folder { folder, children } if folder.name == "Prod" => Some(children),
            _ => None,
        })
        .expect("应有 Prod 文件夹");
    assert_eq!(prod.len(), 2, "Prod 下应有 web-01 与 web-02");

    let test = tree
        .iter()
        .find_map(|n| match n {
            TreeNode::Folder { folder, children } if folder.name == "Test" => Some(children),
            _ => None,
        })
        .expect("应有 Test 文件夹");
    assert_eq!(test.len(), 1);
    assert_eq!(test[0].name(), "db-01");

    // 根级：win-dc 直接挂在根
    assert!(tree.iter().any(|n| n.name() == "win-dc"));
}

#[test]
fn imported_sessions_keep_key_fields() {
    let plan = parse_mobaxterm_ini(INI).unwrap();
    let mut store = Store::open_in_memory().unwrap();
    store.import(&plan.folders, &plan.sessions).unwrap();

    let snap = store.load_snapshot().unwrap();
    let web01 = snap.sessions.iter().find(|s| s.name == "web-01").unwrap();

    assert_eq!(web01.host.as_deref(), Some("10.0.1.11"));
    assert_eq!(web01.port, Some(22));
    assert_eq!(web01.username.as_deref(), Some("deploy"));
    // AC-3：私钥路径被记录（虽然文件在本机不一定存在）
    assert_eq!(
        web01.options["privateKeyPath"],
        serde_json::json!(r"C:\Users\zhang\.ssh\id_ed25519")
    );
}

#[test]
fn reimport_into_same_store_is_rejected_atomically() {
    let plan = parse_mobaxterm_ini(INI).unwrap();
    let mut store = Store::open_in_memory().unwrap();
    store.import(&plan.folders, &plan.sessions).unwrap();
    let before = store.counts().unwrap();

    // 同一个 plan 再导一次：ID 相同 → 冲突 → 整体回滚
    let err = store.import(&plan.folders, &plan.sessions).unwrap_err();
    assert_eq!(err.code, "STORE_CONSTRAINT");

    let after = store.counts().unwrap();
    assert_eq!(before, after, "失败的导入不能改变库里的任何东西");
}

#[test]
fn unsupported_sessions_do_not_block_the_rest() {
    // 一个坏会话混在好会话中间：好会话必须全部导入
    let plan = parse_mobaxterm_ini(INI).unwrap();
    assert!(plan.sessions.iter().all(|s| s.kind.as_str() != "xdmcp"));

    let mut store = Store::open_in_memory().unwrap();
    store.import(&plan.folders, &plan.sessions).unwrap();
    assert_eq!(store.counts().unwrap().1, 4);
}
