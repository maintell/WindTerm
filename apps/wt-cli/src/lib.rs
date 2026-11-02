//! `wt` 命令行：把核心能力暴露成可脚本化的入口。
//!
//! 设计依据：`docs/spec/10-func-local-shell.md` §7（`LOC-023`）、`docs/spec/01` §2.4 支点二。
//!
//! 这一层的意义不只是「给用户一个 CLI」，也是我们自己的验收手段：
//! **每个 UI 能做的事，都必须能用一条命令做完**。E2E 测试因此不需要驱动 GUI。
//!
//! 当前已实现：
//! - `wt local exec -- <cmd>`：在真实 PTY 里跑一条命令，把输出转发到 stdout
//! - `wt doctor`：环境自检
//! - `wt version`

#![forbid(unsafe_code)]

use std::io::Write;
use std::time::{Duration, Instant};

use wt_term::pty::PtyConfig;
use wt_term::TermSession;

pub const EXIT_OK: i32 = 0;
pub const EXIT_USAGE: i32 = 2;
pub const EXIT_RUNTIME: i32 = 1;
pub const EXIT_TIMEOUT: i32 = 124;

/// 命令行解析结果。
#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Version,
    Doctor,
    LocalExec {
        program: String,
        args: Vec<String>,
        timeout: Duration,
        /// 保留 ANSI 控制序列（默认剥离，便于管道消费）
        raw: bool,
    },
    /// `wt ssh exec ...`：连到真实 SSH 执行一条命令
    SshExec {
        target: SshTarget,
        command: String,
    },
    /// `wt session import --file <ini> [--db <path>]`
    SessionImport {
        file: std::path::PathBuf,
        db: Option<std::path::PathBuf>,
    },
    /// `wt session list [--db <path>] [--json]`
    SessionList {
        db: Option<std::path::PathBuf>,
        json: bool,
    },
    Help,
}

/// SSH 认证方式。
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum SshAuth {
    Password(String),
    Key {
        path: std::path::PathBuf,
        passphrase: Option<String>,
    },
}

/// SSH 目标。
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct SshTarget {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: SshAuth,
    /// 跳过 known_hosts 校验（危险，仅调试用）
    pub insecure_host_key: bool,
}

/// 解析 argv（不含程序名）。
///
/// 规则刻意简单：不做 shell 解析，`--` 之后原样传给子进程——
/// 这样 `wt local exec -- grep -n foo file` 不会被我们二次解释。
pub fn parse(args: &[String]) -> Result<Command, String> {
    let Some(first) = args.first().map(String::as_str) else {
        return Ok(Command::Help);
    };

    match first {
        "version" | "--version" | "-V" => Ok(Command::Version),
        "doctor" => Ok(Command::Doctor),
        "help" | "--help" | "-h" => Ok(Command::Help),
        "local" => parse_local(&args[1..]),
        "ssh" => parse_ssh(&args[1..]),
        "session" => parse_session(&args[1..]),
        other => Err(format!("未知子命令 `{other}`")),
    }
}

fn parse_local(rest: &[String]) -> Result<Command, String> {
    // local exec [--timeout <secs>] -- <program> [args...]
    if rest.first().map(String::as_str) != Some("exec") {
        return Err("local 只支持 `exec`，用法：wt local exec -- <program> [args...]".into());
    }

    let mut timeout = Duration::from_secs(120);
    let mut raw = false;
    let mut i = 1;
    while i < rest.len() {
        match rest[i].as_str() {
            "--" => {
                i += 1;
                break;
            }
            "--timeout" => {
                let v = rest
                    .get(i + 1)
                    .ok_or_else(|| "--timeout 需要一个秒数".to_string())?;
                let secs: u64 = v
                    .parse()
                    .map_err(|_| format!("--timeout 需要整数秒，收到 `{v}`"))?;
                timeout = Duration::from_secs(secs.max(1));
                i += 2;
            }
            "--raw" => {
                raw = true;
                i += 1;
            }
            other => return Err(format!("local exec 不认识的参数 `{other}`")),
        }
    }

    let program = rest
        .get(i)
        .ok_or_else(|| "缺少要执行的程序：wt local exec -- <program> [args...]".to_string())?
        .clone();
    let args = rest[i + 1..].to_vec();

    Ok(Command::LocalExec {
        program,
        args,
        timeout,
        raw,
    })
}

fn parse_ssh(rest: &[String]) -> Result<Command, String> {
    if rest.first().map(String::as_str) != Some("exec") {
        return Err("ssh 目前只支持 `exec`，用法：wt ssh exec --host H -- <command...>".into());
    }

    let mut host = None;
    let mut port = 22u16;
    let mut user = None;
    let mut password = None;
    let mut key = None;
    let mut passphrase = None;
    let mut insecure = false;

    let mut i = 1;
    while i < rest.len() {
        match rest[i].as_str() {
            "--" => {
                i += 1;
                break;
            }
            "--host" | "-h" => {
                host = Some(need(rest, i, "--host")?);
                i += 2;
            }
            "--port" => {
                let v = need(rest, i, "--port")?;
                port = v
                    .parse()
                    .map_err(|_| format!("--port 需要端口号，收到 `{v}`"))?;
                i += 2;
            }
            "--user" | "-u" => {
                user = Some(need(rest, i, "--user")?);
                i += 2;
            }
            "--password" | "-p" => {
                password = Some(need(rest, i, "--password")?);
                i += 2;
            }
            "--key" | "-i" => {
                key = Some(std::path::PathBuf::from(need(rest, i, "--key")?));
                i += 2;
            }
            "--passphrase" => {
                passphrase = Some(need(rest, i, "--passphrase")?);
                i += 2;
            }
            "--insecure-host-key" => {
                insecure = true;
                i += 1;
            }
            other => return Err(format!("ssh exec 不认识的参数 `{other}`")),
        }
    }

    let command_parts = rest.get(i..).unwrap_or(&[]);
    if command_parts.is_empty() {
        return Err("缺少要执行的命令：wt ssh exec --host H -- <command...>".into());
    }

    let auth = match (key, password) {
        (Some(path), _) => SshAuth::Key { path, passphrase },
        (None, Some(pw)) => SshAuth::Password(pw),
        (None, None) => {
            return Err("需要认证方式：--password <pw> 或 --key <path>".into());
        }
    };

    Ok(Command::SshExec {
        target: SshTarget {
            host: host.ok_or_else(|| "缺少 --host".to_string())?,
            port,
            user: user.ok_or_else(|| "缺少 --user".to_string())?,
            auth,
            insecure_host_key: insecure,
        },
        // 远端 shell 会重新解析这一整串，所以按空格拼接即可
        command: command_parts.join(" "),
    })
}

fn parse_session(rest: &[String]) -> Result<Command, String> {
    match rest.first().map(String::as_str) {
        Some("import") => {
            let mut file = None;
            let mut db = None;
            let mut i = 1;
            while i < rest.len() {
                match rest[i].as_str() {
                    "--file" | "-f" => {
                        file = Some(std::path::PathBuf::from(need(rest, i, "--file")?));
                        i += 2;
                    }
                    "--db" => {
                        db = Some(std::path::PathBuf::from(need(rest, i, "--db")?));
                        i += 2;
                    }
                    "--from" => {
                        let v = need(rest, i, "--from")?;
                        if v != "mobaxterm" {
                            return Err(format!("目前只支持 --from mobaxterm，收到 `{v}`"));
                        }
                        i += 2;
                    }
                    other => return Err(format!("session import 不认识的参数 `{other}`")),
                }
            }
            Ok(Command::SessionImport {
                file: file.ok_or_else(|| "缺少 --file <MobaXterm.ini>".to_string())?,
                db,
            })
        }
        Some("list") => {
            let mut db = None;
            let mut json = false;
            let mut i = 1;
            while i < rest.len() {
                match rest[i].as_str() {
                    "--db" => {
                        db = Some(std::path::PathBuf::from(need(rest, i, "--db")?));
                        i += 2;
                    }
                    "--json" => {
                        json = true;
                        i += 1;
                    }
                    other => return Err(format!("session list 不认识的参数 `{other}`")),
                }
            }
            Ok(Command::SessionList { db, json })
        }
        _ => Err("session 只支持 `import` 与 `list`".into()),
    }
}

/// 默认数据目录（与 GUI 共用）。
pub fn config_dir() -> std::path::PathBuf {
    if let Ok(appdata) = std::env::var("APPDATA") {
        return std::path::PathBuf::from(appdata).join("WindTerm");
    }
    if let Ok(home) = std::env::var("HOME") {
        return std::path::PathBuf::from(home).join(".config").join("windterm");
    }
    std::path::PathBuf::from(".")
}

pub fn default_db_path() -> std::path::PathBuf {
    config_dir().join("data.db")
}

/// 导入 MobaXterm 配置并打印报告。
pub fn import_mobaxterm(
    file: &std::path::Path,
    db: &std::path::Path,
    out: &mut dyn Write,
) -> Result<(), String> {
    let bytes = std::fs::read(file).map_err(|e| format!("读取失败 {}: {e}", file.display()))?;
    // MobaXterm 在中文 Windows 上可能写 GBK；这里先按 UTF-8 解，失败再用替换字符兜底，
    // 真正的编码探测留给后续迭代（当前只影响注释与少数字段名）。
    let text = String::from_utf8_lossy(&bytes).to_string();

    let plan = wt_import::parse_mobaxterm_ini(&text).map_err(|e| e.to_string())?;

    let mut store = wt_store::Store::open(db).map_err(|e| e.to_string())?;

    // 去重：同一个 ini 被导入两次不应产生两套会话。
    // 判据用 (名称, 主机, 端口)——这是用户能感知的「同一个会话」。
    let existing = store.load_snapshot().map_err(|e| e.to_string())?;
    let seen: std::collections::HashSet<(String, Option<String>, Option<u16>)> = existing
        .sessions
        .iter()
        .map(|s| (s.name.clone(), s.host.clone(), s.port))
        .collect();

    // 文件夹同样要去重：按 (父目录, 名称) 复用已有文件夹，
    // 否则重复导入会堆出同名目录树（会话被跳过，目录却翻倍）。
    let mut existing_folders: std::collections::HashMap<(Option<String>, String), wt_core::FolderId> =
        std::collections::HashMap::new();
    for f in &existing.folders {
        existing_folders.insert(
            (f.parent_id.as_ref().map(|p| p.as_str().to_string()), f.name.clone()),
            f.id.clone(),
        );
    }

    let mut folder_remap: std::collections::HashMap<String, wt_core::FolderId> =
        std::collections::HashMap::new();
    let mut new_folders = Vec::new();
    let mut reused_folders = 0usize;

    // plan.folders 由导入器按「父先于子」生成，单趟即可完成映射
    for f in &plan.folders {
        let mapped_parent = f
            .parent_id
            .as_ref()
            .map(|p| {
                folder_remap
                    .get(p.as_str())
                    .cloned()
                    .unwrap_or_else(|| p.clone())
            });
        let key = (mapped_parent.as_ref().map(|p| p.as_str().to_string()), f.name.clone());

        if let Some(existing_id) = existing_folders.get(&key) {
            folder_remap.insert(f.id.as_str().to_string(), existing_id.clone());
            reused_folders += 1;
        } else {
            let mut nf = f.clone();
            nf.parent_id = mapped_parent;
            folder_remap.insert(f.id.as_str().to_string(), nf.id.clone());
            new_folders.push(nf);
        }
    }

    let mut kept = Vec::new();
    let mut duplicates = Vec::new();
    for mut s in plan.sessions {
        let key = (s.name.clone(), s.host.clone(), s.port);
        if seen.contains(&key) {
            duplicates.push(s.name.clone());
            continue;
        }
        if let Some(fid) = &s.folder_id {
            if let Some(mapped) = folder_remap.get(fid.as_str()) {
                s.folder_id = Some(mapped.clone());
            }
        }
        kept.push(s);
    }

    let report = store
        .import(&new_folders, &kept)
        .map_err(|e| e.to_string())?;


    writeln!(out, "导入完成：文件夹 {} 个、会话 {} 个", report.folders, report.sessions)
        .map_err(|e| e.to_string())?;
    if reused_folders > 0 {
        writeln!(out, "  复用已有文件夹 {reused_folders} 个").map_err(|e| e.to_string())?;
    }
    if !duplicates.is_empty() {
        writeln!(
            out,
            "  已跳过 {} 个已存在的会话：{}",
            duplicates.len(),
            duplicates.join("、")
        )
        .map_err(|e| e.to_string())?;
    }

    for w in &plan.warnings {
        writeln!(out, "  提示：{w}").map_err(|e| e.to_string())?;
    }
    for s in &plan.skipped {
        writeln!(out, "  跳过：{} —— {}", s.name, s.reason).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 列出会话树。
pub fn list_sessions(db: &std::path::Path, out: &mut dyn Write, json: bool) -> Result<(), String> {
    let store = wt_store::Store::open(db).map_err(|e| e.to_string())?;
    let snap = store.load_snapshot().map_err(|e| e.to_string())?;

    if json {
        let payload = serde_json::json!({
            "folders": snap.folders.len(),
            "sessions": snap.sessions.iter().map(|s| serde_json::json!({
                "id": s.id.as_str(),
                "name": s.name,
                "type": s.kind.as_str(),
                "host": s.host,
                "port": s.port,
            })).collect::<Vec<_>>(),
            "warnings": snap.warnings,
        });
        writeln!(out, "{}", serde_json::to_string_pretty(&payload).unwrap_or_default())
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    let (tree, orphans) = wt_core::build_tree(&snap.folders, &snap.sessions);
    writeln!(out, "共 {} 个文件夹、{} 个会话", snap.folders.len(), snap.sessions.len())
        .map_err(|e| e.to_string())?;
    render_tree(&tree, 0, out)?;

    for o in orphans {
        writeln!(out, "  警告：{o}").map_err(|e| e.to_string())?;
    }
    for w in &snap.warnings {
        writeln!(out, "  警告：{w}").map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn render_tree(nodes: &[wt_core::TreeNode], depth: usize, out: &mut dyn Write) -> Result<(), String> {
    for n in nodes {
        let pad = "  ".repeat(depth);
        match n {
            wt_core::TreeNode::Folder { folder, children } => {
                writeln!(out, "{pad}[{}]/", folder.name).map_err(|e| e.to_string())?;
                render_tree(children, depth + 1, out)?;
            }
            wt_core::TreeNode::Session(s) => {
                let ep = s.endpoint_label();
                writeln!(out, "{pad}{} ({}) {ep}", s.name, s.kind.as_str())
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

fn need(rest: &[String], i: usize, flag: &str) -> Result<String, String> {
    rest.get(i + 1)
        .cloned()
        .ok_or_else(|| format!("{flag} 需要一个值"))
}

/// known_hosts 的默认位置（与 GUI 共用，避免两套信任库）。
pub fn known_hosts_path() -> std::path::PathBuf {
    if let Ok(appdata) = std::env::var("APPDATA") {
        return std::path::PathBuf::from(appdata)
            .join("WindTerm")
            .join("known_hosts");
    }
    if let Ok(home) = std::env::var("HOME") {
        return std::path::PathBuf::from(home)
            .join(".config")
            .join("windterm")
            .join("known_hosts");
    }
    std::path::PathBuf::from("known_hosts")
}

/// 连接真实 SSH 执行一条命令。
pub async fn run_ssh_exec(
    target: &SshTarget,
    command: &str,
    out: &mut dyn Write,
) -> Result<i32, String> {
    use wt_ssh::{HostKeyPolicy, KnownHosts, PrivateKeySource, SshConfig, SshConnection};

    let cfg = SshConfig {
        host: target.host.clone(),
        port: target.port,
        user: target.user.clone(),
        ..Default::default()
    };

    let policy = if target.insecure_host_key {
        HostKeyPolicy::AcceptAll
    } else {
        let path = known_hosts_path();
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        let (kh, _warnings) = KnownHosts::parse(&text);
        HostKeyPolicy::Known(Box::new(kh))
    };

    let conn = match &target.auth {
        SshAuth::Password(pw) => SshConnection::connect_password(&cfg, pw, policy).await,
        SshAuth::Key { path, passphrase } => {
            let pem = std::fs::read(path)
                .map_err(|e| format!("读取私钥失败 {}: {e}", path.display()))?;
            let src = PrivateKeySource::new(pem, passphrase.clone());
            SshConnection::connect_publickey(&cfg, &src, policy).await
        }
    }
    .map_err(|e| e.to_string())?;

    let result = conn.exec(command).await.map_err(|e| e.to_string())?;

    if !result.stdout.is_empty() {
        out.write_all(&result.stdout).map_err(|e| e.to_string())?;
    }
    if !result.stderr.is_empty() {
        out.write_all(&result.stderr).map_err(|e| e.to_string())?;
    }
    out.flush().ok();
    conn.disconnect().await;

    Ok(result.exit_code.unwrap_or(0) as i32)
}

/// 在真实 PTY 里执行一条命令，把输出写到 `out`，返回退出码。
///
/// 这是「读 → 渲染 → ack」循环的最小实现，与 UI 走的是同一条路径：
/// 只要这里不丢字节，UI 也不会丢。
pub fn run_local_exec(
    program: &str,
    args: &[String],
    timeout: Duration,
    raw: bool,
    out: &mut dyn Write,
) -> Result<i32, String> {
    // CLI 的输出通常是管道/文件，混入 `ESC[6n`、`ESC[?25h` 这类控制序列会让 grep 失效。
    // 默认剥离；需要原始字节时用 `--raw`。
    let mut stripper = wt_term::AnsiStripper::new();
    let cfg = PtyConfig {
        program: program.to_string(),
        args: args.to_vec(),
        cols: 200,
        rows: 50,
        cwd: None,
        env: Vec::new(),
        // 无头场景没有终端仿真器，必须由 PTY 层应答 ConPTY 的 DSR 查询
        answer_queries: true,
    };

    let mut session =
        TermSession::spawn_local(cfg).map_err(|e| format!("启动失败: {e}"))?;

    let started = Instant::now();
    let mut drained_after_exit = false;

    loop {
        let mut chunk = Vec::new();
        let n = session.read_into(&mut chunk, 64 * 1024);
        if n > 0 {
            emit(&mut stripper, &chunk, raw, out)?;
            session.ack(n);
            continue;
        }

        if let Some(code) = session.try_wait() {
            // 子进程已退出，但 ConPTY 的输出可能还在路上：
            // 必须在「静默 300ms」后才认为读完，否则会丢尾部输出（实测会丢掉整条 echo）。
            let mut last_data = Instant::now();
            let hard_deadline = Instant::now() + Duration::from_secs(3);
            loop {
                let mut rest = Vec::new();
                let m = session.read_into(&mut rest, 64 * 1024);
                if m > 0 {
                    emit(&mut stripper, &rest, raw, out)?;
                    session.ack(m);
                    last_data = Instant::now();
                    continue;
                }
                if last_data.elapsed() > Duration::from_millis(300)
                    || Instant::now() > hard_deadline
                {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            out.flush().ok();
            session.close();
            return Ok(code as i32);
        }

        if started.elapsed() > timeout {
            session.close();
            return Err(format!(
                "超时（{} 秒）：命令可能仍在运行或等待输入",
                timeout.as_secs()
            ));
        }

        if !drained_after_exit {
            drained_after_exit = true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// 把一段输出写到目标流；`raw=false` 时先剥离 ANSI。
fn emit(
    stripper: &mut wt_term::AnsiStripper,
    chunk: &[u8],
    raw: bool,
    out: &mut dyn Write,
) -> Result<(), String> {
    if raw {
        out.write_all(chunk).map_err(|e| format!("写出失败: {e}"))?;
    } else {
        let mut clean = Vec::with_capacity(chunk.len());
        stripper.feed(chunk, &mut clean);
        out.write_all(&clean)
            .map_err(|e| format!("写出失败: {e}"))?;
    }
    out.flush().ok();
    Ok(())
}

/// 环境自检：把「能不能用」的关键前提逐条打出来。
pub fn doctor(out: &mut dyn Write) -> Result<(), String> {
    let (shell, args) = wt_term::pty::default_shell();
    writeln!(out, "wt {}", env!("CARGO_PKG_VERSION")).map_err(|e| e.to_string())?;
    writeln!(out, "os           : {}", std::env::consts::OS).map_err(|e| e.to_string())?;
    writeln!(out, "arch         : {}", std::env::consts::ARCH).map_err(|e| e.to_string())?;
    writeln!(out, "default shell: {shell} {}", args.join(" ")).map_err(|e| e.to_string())?;
    writeln!(out, "pty support  : {}", if cfg!(windows) { "ConPTY" } else { "openpty" })
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn usage() -> String {
    [
        "wt —— WindTerm 命令行",
        "",
        "用法：",
        "  wt version                     打印版本",
        "  wt doctor                      环境自检",
        "  wt ssh exec --host <H> --user <U> (--password <PW> | --key <PATH>)",
        "              [--port <P>] [--passphrase <PP>] [--insecure-host-key]",
        "              -- <command...>",
        "                                 连接真实 SSH 执行命令（默认校验 known_hosts）",
        "  wt session import --file <MobaXterm.ini> [--db <path>]",
        "                                 导入 MobaXterm 会话（结构优先，密码需重输）",
        "  wt session list [--db <path>] [--json]",
        "                                 列出已导入的会话树",
        "  wt local exec [--timeout 秒] [--raw] -- <program> [args...]",
        "                                 在真实终端里执行命令并转发输出",
        "                                 （默认剥离 ANSI，--raw 保留原始字节）",
        "",
        "注意：程序必须是可执行文件，不能用 shell 内建命令（echo/cd 等）。",
        "",
        "示例：",
        "  wt local exec -- git --version",
        "  wt local exec --timeout 10 -- grep -n TODO src/main.rs",
        "  wt local exec -- cmd /c \"echo hello\"      (Windows)",
        "  wt local exec -- sh -c \"echo hello\"       (Unix)",
    ]
    .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn parses_version_and_doctor() {
        assert_eq!(parse(&s(&["version"])).unwrap(), Command::Version);
        assert_eq!(parse(&s(&["--version"])).unwrap(), Command::Version);
        assert_eq!(parse(&s(&["doctor"])).unwrap(), Command::Doctor);
        assert_eq!(parse(&s(&["help"])).unwrap(), Command::Help);
        assert_eq!(parse(&[]).unwrap(), Command::Help);
    }

    #[test]
    fn parses_local_exec_with_program_and_args() {
        let cmd = parse(&s(&["local", "exec", "--", "grep", "-n", "TODO", "a.rs"])).unwrap();
        match cmd {
            Command::LocalExec {
                program,
                args,
                timeout,
                raw,
            } => {
                assert_eq!(program, "grep");
                assert_eq!(args, vec!["-n", "TODO", "a.rs"]);
                assert_eq!(timeout, Duration::from_secs(120));
                assert!(!raw, "默认应剥离 ANSI");
            }
            other => panic!("解析错误: {other:?}"),
        }
    }

    #[test]
    fn parses_timeout_option() {
        let cmd = parse(&s(&["local", "exec", "--timeout", "5", "--", "sleep", "1"])).unwrap();
        match cmd {
            Command::LocalExec { timeout, program, .. } => {
                assert_eq!(timeout, Duration::from_secs(5));
                assert_eq!(program, "sleep");
            }
            other => panic!("解析错误: {other:?}"),
        }
    }

    #[test]
    fn rejects_unknown_subcommand_and_missing_program() {
        assert!(parse(&s(&["nope"])).is_err());
        assert!(parse(&s(&["local", "exec", "--"])).is_err());
        assert!(parse(&s(&["local", "exec"])).is_err());
        assert!(parse(&s(&["local", "run"])).is_err());
    }

    #[test]
    fn rejects_bad_timeout() {
        let err = parse(&s(&["local", "exec", "--timeout", "abc", "--", "x"])).unwrap_err();
        assert!(err.contains("整数秒"), "实际: {err}");
    }

    #[test]
    fn usage_mentions_all_subcommands() {
        let u = usage();
        assert!(u.contains("wt version"));
        assert!(u.contains("wt doctor"));
        assert!(u.contains("wt local exec"));
    }

    #[test]
    fn parses_raw_flag() {
        let cmd = parse(&s(&["local", "exec", "--raw", "--", "git", "--version"])).unwrap();
        match cmd {
            Command::LocalExec { raw, program, .. } => {
                assert!(raw);
                assert_eq!(program, "git");
            }
            other => panic!("解析错误: {other:?}"),
        }
    }

    #[test]
    fn strips_ansi_by_default_keeps_raw_when_asked() {
        // 直接验证 emit：带颜色的输入，默认应只剩文本
        let input = b"\x1b[31mRED\x1b[0m plain";

        let mut clean = Vec::new();
        let mut st = wt_term::AnsiStripper::new();
        emit(&mut st, input, false, &mut clean).unwrap();
        assert_eq!(String::from_utf8_lossy(&clean), "RED plain");

        let mut raw = Vec::new();
        let mut st2 = wt_term::AnsiStripper::new();
        emit(&mut st2, input, true, &mut raw).unwrap();
        assert!(raw.starts_with(b"\x1b[31m"), "raw 模式应保留控制序列");
    }

    #[test]
    fn run_local_exec_captures_output_and_exit_code() {
        let mut buf: Vec<u8> = Vec::new();
        let code = if cfg!(windows) {
            run_local_exec(
                "cmd.exe",
                &s(&["/c", "echo WT_CLI_OK"]),
                Duration::from_secs(20),
                false,
                &mut buf,
            )
            .expect("执行应成功")
        } else {
            run_local_exec(
                "/bin/sh",
                &s(&["-c", "echo WT_CLI_OK"]),
                Duration::from_secs(20),
                false,
                &mut buf,
            )
            .expect("执行应成功")
        };

        assert_eq!(code, 0);
        let text = String::from_utf8_lossy(&buf);
        assert!(text.contains("WT_CLI_OK"), "应捕获输出，实际: {text:?}");
    }

    #[test]
    fn run_local_exec_propagates_nonzero_exit() {
        let mut buf: Vec<u8> = Vec::new();
        let code = if cfg!(windows) {
            run_local_exec(
                "cmd.exe",
                &s(&["/c", "exit 3"]),
                Duration::from_secs(20),
                false,
                &mut buf,
            )
            .unwrap()
        } else {
            run_local_exec(
                "/bin/sh",
                &s(&["-c", "exit 3"]),
                Duration::from_secs(20),
                false,
                &mut buf,
            )
            .unwrap()
        };
        assert_eq!(code, 3, "退出码必须透传");
    }

    #[test]
    fn doctor_reports_shell_and_pty() {
        let mut buf: Vec<u8> = Vec::new();
        doctor(&mut buf).unwrap();
        let text = String::from_utf8_lossy(&buf);
        assert!(text.contains("default shell"));
        assert!(text.contains("pty support"));
    }
}

#[cfg(test)]
mod ssh_tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn parses_ssh_exec_with_password() {
        let cmd = parse(&s(&[
            "ssh", "exec", "--host", "10.0.0.5", "--user", "root", "--password", "pw", "--",
            "uptime",
        ]))
        .unwrap();
        match cmd {
            Command::SshExec { target, command } => {
                assert_eq!(target.host, "10.0.0.5");
                assert_eq!(target.port, 22);
                assert_eq!(target.user, "root");
                assert_eq!(target.auth, SshAuth::Password("pw".into()));
                assert!(!target.insecure_host_key);
                assert_eq!(command, "uptime");
            }
            other => panic!("解析错误: {other:?}"),
        }
    }

    #[test]
    fn parses_ssh_exec_with_key_and_options() {
        let cmd = parse(&s(&[
            "ssh", "exec", "--host", "h", "--port", "2222", "--user", "u", "--key",
            "C:/k/id_ed25519", "--passphrase", "pp", "--insecure-host-key", "--", "ls", "-l",
        ]))
        .unwrap();
        match cmd {
            Command::SshExec { target, command } => {
                assert_eq!(target.port, 2222);
                match target.auth {
                    SshAuth::Key { path, passphrase } => {
                        assert!(path.to_string_lossy().contains("id_ed25519"));
                        assert_eq!(passphrase.as_deref(), Some("pp"));
                    }
                    other => panic!("认证方式错误: {other:?}"),
                }
                assert!(target.insecure_host_key);
                assert_eq!(command, "ls -l", "多段命令应按空格拼接");
            }
            other => panic!("解析错误: {other:?}"),
        }
    }

    #[test]
    fn rejects_incomplete_ssh_commands() {
        assert!(parse(&s(&["ssh", "run"])).is_err());
        assert!(parse(&s(&["ssh", "exec", "--user", "u", "--password", "p", "--", "x"])).is_err());
        assert!(parse(&s(&["ssh", "exec", "--host", "h", "--password", "p", "--"])).is_err());
        assert!(parse(&s(&["ssh", "exec", "--host", "h", "--user", "u", "--", "x"])).is_err());
    }

    #[test]
    fn known_hosts_path_is_absolute() {
        let p = known_hosts_path();
        assert!(p.is_absolute() || p.to_string_lossy() == "known_hosts");
    }

    #[tokio::test]
    async fn ssh_exec_against_mock_server() {
        let server = wt_ssh::testing::MockSshServer::start().await;

        let target = SshTarget {
            host: "127.0.0.1".into(),
            port: server.port,
            user: "tester".into(),
            auth: SshAuth::Password("secret".into()),
            insecure_host_key: true,
        };

        let mut out: Vec<u8> = Vec::new();
        let code = run_ssh_exec(&target, "uname -a", &mut out)
            .await
            .expect("应执行成功");

        assert_eq!(code, 0);
        let text = String::from_utf8_lossy(&out);
        assert!(text.contains("ran:uname -a"), "实际输出: {text:?}");
    }

    #[tokio::test]
    async fn ssh_exec_reports_auth_failure() {
        let server = wt_ssh::testing::MockSshServer::start().await;
        let target = SshTarget {
            host: "127.0.0.1".into(),
            port: server.port,
            user: "tester".into(),
            auth: SshAuth::Password("wrong".into()),
            insecure_host_key: true,
        };

        let mut out: Vec<u8> = Vec::new();
        let err = run_ssh_exec(&target, "true", &mut out).await.unwrap_err();
        assert!(err.contains("SSH_AUTH_FAILED"), "实际错误: {err}");
    }

    #[tokio::test]
    async fn ssh_exec_with_publickey() {
        let server = wt_ssh::testing::MockSshServer::start().await;
        let pem = wt_ssh::testing::MockSshServer::fresh_openssh_key(None);
        let path = std::env::temp_dir().join(format!("wt-cli-key-{}", std::process::id()));
        std::fs::write(&path, pem).expect("写私钥");

        let target = SshTarget {
            host: "127.0.0.1".into(),
            port: server.port,
            user: "tester".into(),
            auth: SshAuth::Key {
                path: path.clone(),
                passphrase: None,
            },
            insecure_host_key: true,
        };

        let mut out: Vec<u8> = Vec::new();
        let code = run_ssh_exec(&target, "id", &mut out).await.expect("应成功");
        assert_eq!(code, 0);
        assert!(String::from_utf8_lossy(&out).contains("ran:id"));

        let _ = std::fs::remove_file(&path);
    }
}
#[cfg(test)]
mod session_tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

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

[Bookmarks_3]
SubRep=
BookmarkName=win-dc
Host=10.0.2.5
Port=3389
UserName=admin
Protocol=4

[Bookmarks_4]
SubRep=
BookmarkName=old-rlogin
Host=10.0.9.9
Protocol=2
"#;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("wt-cli-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn parses_session_import_and_list() {
        let cmd = parse(&s(&["session", "import", "--file", "x.ini"])).unwrap();
        match cmd {
            Command::SessionImport { file, db } => {
                assert!(file.to_string_lossy().ends_with("x.ini"));
                assert!(db.is_none());
            }
            other => panic!("解析错误: {other:?}"),
        }

        let cmd = parse(&s(&["session", "list", "--json"])).unwrap();
        match cmd {
            Command::SessionList { json, db } => {
                assert!(json);
                assert!(db.is_none());
            }
            other => panic!("解析错误: {other:?}"),
        }

        assert!(parse(&s(&["session", "import"])).is_err(), "缺 --file 应报错");
        assert!(parse(&s(&["session", "nope"])).is_err());
        assert!(parse(&s(&["session", "import", "--from", "putty", "--file", "x"])).is_err());
    }

    #[test]
    fn imports_mobaxterm_then_lists_tree() {
        let dir = temp_dir("import");
        let ini = dir.join("MobaXterm.ini");
        std::fs::write(&ini, INI).unwrap();
        let db = dir.join("data.db");

        let mut out: Vec<u8> = Vec::new();
        import_mobaxterm(&ini, &db, &mut out).expect("导入应成功");
        let text = String::from_utf8_lossy(&out);
        assert!(text.contains("会话 2"), "应导入 2 个会话，实际: {text}");
        assert!(text.contains("跳过"), "rlogin 应被跳过并说明: {text}");

        let mut listed: Vec<u8> = Vec::new();
        list_sessions(&db, &mut listed, false).expect("列出应成功");
        let tree = String::from_utf8_lossy(&listed);
        assert!(tree.contains("Prod"), "应显示文件夹: {tree}");
        assert!(tree.contains("web-01"), "应显示会话: {tree}");
        assert!(tree.contains("win-dc"), "根级会话应显示: {tree}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_json_output_is_parseable() {
        let dir = temp_dir("json");
        let ini = dir.join("MobaXterm.ini");
        std::fs::write(&ini, INI).unwrap();
        let db = dir.join("data.db");
        let mut sink: Vec<u8> = Vec::new();
        import_mobaxterm(&ini, &db, &mut sink).unwrap();

        let mut out: Vec<u8> = Vec::new();
        list_sessions(&db, &mut out, true).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&out).expect("应是合法 JSON");
        assert_eq!(v["sessions"].as_array().unwrap().len(), 2);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reimport_same_file_skips_duplicates() {
        let dir = temp_dir("dup");
        let ini = dir.join("MobaXterm.ini");
        std::fs::write(&ini, INI).unwrap();
        let db = dir.join("data.db");

        let mut out: Vec<u8> = Vec::new();
        import_mobaxterm(&ini, &db, &mut out).unwrap();

        let mut second: Vec<u8> = Vec::new();
        import_mobaxterm(&ini, &db, &mut second).expect("重复导入不应报错");
        let text = String::from_utf8_lossy(&second);
        assert!(text.contains("文件夹 0"), "重复导入不应新增文件夹: {text}");
        assert!(text.contains("会话 0"), "重复导入不应新增会话: {text}");
        assert!(text.contains("已跳过 2 个"), "应报告跳过数量: {text}");
        assert!(text.contains("复用已有文件夹"), "应报告复用: {text}");

        // 库里仍然只有 2 个会话
        let mut listed: Vec<u8> = Vec::new();
        list_sessions(&db, &mut listed, true).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&listed).unwrap();
        assert_eq!(v["sessions"].as_array().unwrap().len(), 2);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn import_missing_file_is_a_clear_error() {
        let dir = temp_dir("missing");
        let db = dir.join("data.db");
        let mut out: Vec<u8> = Vec::new();
        let err = import_mobaxterm(&dir.join("nope.ini"), &db, &mut out).unwrap_err();
        assert!(err.contains("读取失败"), "实际: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}