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
    /// `wt doctor [--json]`
    Doctor {
        json: bool,
    },
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
    /// `wt ssh shell`：在本机终端里跑远端交互式 shell
    SshShell {
        target: SshTarget,
    },
    /// `wt sftp ls|get|put ...`：文件传输
    Sftp {
        target: SshTarget,
        action: SftpAction,
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
    /// 用 ssh-agent 里的身份（私钥不出 agent）
    Agent,
}

/// `wt sftp` 的动作。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SftpAction {
    /// 列目录
    Ls {
        path: String,
        /// 输出机器可读的 JSON（`spec/01` §「每个 UI 能力都要能脚本化」）
        json: bool,
    },
    /// 下载
    Get {
        remote: String,
        local: std::path::PathBuf,
    },
    /// 上传
    Put {
        local: std::path::PathBuf,
        remote: String,
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
    /// 跳板机链（`G14` / `SES-025`）。按「离本机由近到远」排列，空数组表示直连。
    pub jumps: Vec<JumpTarget>,
}

/// 一台跳板机。
///
/// 它**自带**认证方式而不是复用目标的：`SES-024` 行为规格第 4 条要求凭据不继承，
/// 跳板机与目标机往往是两套账号——继承只会让人在认证失败时找错方向。
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct JumpTarget {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: SshAuth,
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
        "doctor" => parse_doctor(&args[1..]),
        "help" | "--help" | "-h" => Ok(Command::Help),
        "local" => parse_local(&args[1..]),
        "ssh" => parse_ssh(&args[1..]),
        "sftp" => parse_sftp(&args[1..]),
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

/// 跳板机最多几跳。与 `wt_core::Session::validate_jump_chain` 的上限保持一致，
/// 免得界面能存 5 跳、命令行却只认 3 跳。
const MAX_JUMPS: usize = 5;

/// `--jump` 一族参数的暂存区（`G14` / `SES-025`）。
///
/// 先攒再算，是因为「给了 `--jump-password` 却没给 `--jump`」这种半截配置
/// 必须在解析期就报错——静默忽略会让人以为跳板机配上了，实际在直连。
#[derive(Default)]
struct JumpArgs {
    /// 可重复：按「离本机由近到远」排列
    specs: Vec<String>,
    password: Option<String>,
    key: Option<std::path::PathBuf>,
    passphrase: Option<String>,
    agent: bool,
}

impl JumpArgs {
    /// 尝试把这个参数当跳板机参数消费掉。返回 `None` 表示不归它管。
    fn take(&mut self, args: &[String], i: usize) -> Result<Option<usize>, String> {
        match args[i].as_str() {
            "--jump" | "-J" => {
                self.specs.push(need(args, i, "--jump")?);
                Ok(Some(2))
            }
            "--jump-password" => {
                self.password = Some(need(args, i, "--jump-password")?);
                Ok(Some(2))
            }
            "--jump-key" => {
                self.key = Some(std::path::PathBuf::from(need(args, i, "--jump-key")?));
                Ok(Some(2))
            }
            "--jump-passphrase" => {
                self.passphrase = Some(need(args, i, "--jump-passphrase")?);
                Ok(Some(2))
            }
            "--jump-agent" => {
                self.agent = true;
                Ok(Some(1))
            }
            _ => Ok(None),
        }
    }

    /// 收尾校验，产出跳板机链（`SES-025` 最多 5 跳，与 `wt_core` 的校验保持一致）。
    ///
    /// 凭据只给一套、全链共用：命令行上逐跳配不同口令会让参数含义变得难猜，
    /// 真正需要逐跳不同凭据时先别用 CLI（界面侧按会话各存各的）。
    fn finish(self) -> Result<Vec<JumpTarget>, String> {
        if self.specs.is_empty() {
            if self.password.is_some() || self.key.is_some() || self.agent {
                return Err("给了跳板机的凭据（--jump-password / --jump-key / --jump-agent）\
                    但没给 --jump：跳板机是哪一台？"
                    .into());
            }
            return Ok(Vec::new());
        }
        if self.specs.len() > MAX_JUMPS {
            return Err(format!(
                "--jump 最多 {MAX_JUMPS} 跳，收到 {} 个",
                self.specs.len()
            ));
        }

        let auth = match (self.agent, self.key, self.password) {
            (true, _, _) => SshAuth::Agent,
            (false, Some(path), _) => SshAuth::Key {
                path,
                passphrase: self.passphrase,
            },
            (false, None, Some(pw)) => SshAuth::Password(pw),
            (false, None, None) => {
                return Err("跳板机需要自己的认证方式：--jump-password、--jump-key 或 --jump-agent\
                     （跳板机的凭据不继承目标机的）"
                    .into())
            }
        };

        let mut hops = Vec::with_capacity(self.specs.len());
        for spec in &self.specs {
            let (user, host, port) = parse_jump_spec(spec)?;
            hops.push(JumpTarget {
                host,
                port,
                user,
                auth: auth.clone(),
            });
        }
        Ok(hops)
    }
}

/// 解析 `[user@]host[:port]`。用户名是必须的——跳板机上用哪个账号没法猜。
fn parse_jump_spec(spec: &str) -> Result<(String, String, u16), String> {
    let Some((user, rest)) = spec.rsplit_once('@') else {
        return Err(format!(
            "--jump 要写成 `user@host[:port]`（跳板机的用户名不能省），收到 `{spec}`"
        ));
    };
    let user = user.trim();
    if user.is_empty() {
        return Err(format!("--jump 的用户名是空的：`{spec}`"));
    }
    let (host, port) = split_host_port(rest.trim())?;
    Ok((user.to_string(), host, port))
}

/// `host[:port]`，支持 `[::1]:22` 这种方括号写法。
///
/// 不方括号的裸 IPv6（`::1`）会与「主机:端口」撞车，直接拒绝并要求加方括号——
/// 猜错的代价是连到 `::1` 的 1 端口，报错会指向完全无关的方向。
fn split_host_port(s: &str) -> Result<(String, u16), String> {
    if s.is_empty() {
        return Err("--jump 的主机名是空的".into());
    }
    if let Some(rest) = s.strip_prefix('[') {
        let (host, tail) = rest
            .split_once(']')
            .ok_or_else(|| format!("--jump 的 IPv6 地址缺少 `]`：`{s}`"))?;
        if host.is_empty() {
            return Err(format!("--jump 的主机名是空的：`{s}`"));
        }
        let port = match tail.strip_prefix(':') {
            Some(p) => parse_port(p, s)?,
            None if tail.is_empty() => 22,
            None => return Err(format!("--jump 的 `]` 后面只能跟 `:端口`，收到 `{tail}`")),
        };
        return Ok((host.to_string(), port));
    }
    match s.rsplit_once(':') {
        Some((host, port)) => {
            if host.contains(':') {
                return Err(format!(
                    "--jump 的 IPv6 地址要用方括号：`[{host}]:{port}`，收到 `{s}`"
                ));
            }
            if host.is_empty() {
                return Err(format!("--jump 的主机名是空的：`{s}`"));
            }
            Ok((host.to_string(), parse_port(port, s)?))
        }
        None => Ok((s.to_string(), 22)),
    }
}

fn parse_port(raw: &str, whole: &str) -> Result<u16, String> {
    raw.parse()
        .map_err(|_| format!("--jump 的端口要写成数字，收到 `{raw}`（完整值 `{whole}`）"))
}

fn parse_ssh(rest: &[String]) -> Result<Command, String> {
    let sub = rest
        .first()
        .map(String::as_str)
        .ok_or_else(|| "用法：wt ssh <exec|shell> --host H ...".to_string())?;
    if sub != "exec" && sub != "shell" {
        return Err(format!("ssh 的子命令只有 exec / shell，收到 `{sub}`"));
    }

    let mut host = None;
    let mut port = 22u16;
    let mut user = None;
    let mut password = None;
    let mut key = None;
    let mut passphrase = None;
    let mut insecure = false;
    let mut use_agent = false;
    let mut jump = JumpArgs::default();

    let mut i = 1;
    while i < rest.len() {
        if let Some(consumed) = jump.take(rest, i)? {
            i += consumed;
            continue;
        }
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
            "--agent" => {
                use_agent = true;
                i += 1;
            }
            other => return Err(format!("ssh {sub} 不认识的参数 `{other}`")),
        }
    }

    let auth = match (use_agent, key, password) {
        (true, _, _) => SshAuth::Agent,
        (false, Some(path), _) => SshAuth::Key { path, passphrase },
        (false, None, Some(pw)) => SshAuth::Password(pw),
        (false, None, None) => {
            return Err(
                "需要认证方式：--password <pw>、--key <path> 或 --agent".into(),
            );
        }
    };

    let target = SshTarget {
        host: host.ok_or_else(|| "缺少 --host".to_string())?,
        port,
        user: user.ok_or_else(|| "缺少 --user".to_string())?,
        auth,
        insecure_host_key: insecure,
        jumps: jump.finish()?,
    };

    if sub == "shell" {
        return Ok(Command::SshShell { target });
    }

    let command_parts = rest.get(i..).unwrap_or(&[]);
    if command_parts.is_empty() {
        return Err("缺少要执行的命令：wt ssh exec --host H -- <command...>".into());
    }

    Ok(Command::SshExec {
        target,
        // 远端 shell 会重新解析这一整串，所以按空格拼接即可
        command: command_parts.join(" "),
    })
}

/// `wt sftp ls|get|put`：文件传输。
///
/// 认证与 `ssh exec` 完全一致（密码 / 私钥），参数也刻意保持一致，
/// 免得用户在两处记两套。
fn parse_sftp(rest: &[String]) -> Result<Command, String> {
    let action = rest
        .first()
        .map(String::as_str)
        .ok_or_else(|| "用法：wt sftp <ls|get|put> --host H --user U ...".to_string())?;

    let mut host = None;
    let mut port = 22u16;
    let mut user = None;
    let mut password = None;
    let mut key = None;
    let mut passphrase = None;
    let mut insecure = false;
    let mut use_agent = false;
    let mut path = None;
    let mut remote = None;
    let mut local = None;
    let mut jump = JumpArgs::default();
    // `sftp ls --json`：输出机器可读结果
    let mut json = false;

    let mut i = 1;
    while i < rest.len() {
        if let Some(consumed) = jump.take(rest, i)? {
            i += consumed;
            continue;
        }
        match rest[i].as_str() {
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
            "--agent" => {
                use_agent = true;
                i += 1;
            }
            "--path" => {
                path = Some(need(rest, i, "--path")?);
                i += 2;
            }
            "--remote" => {
                remote = Some(need(rest, i, "--remote")?);
                i += 2;
            }
            "--local" => {
                local = Some(std::path::PathBuf::from(need(rest, i, "--local")?));
                i += 2;
            }
            // `sftp ls --json`：输出机器可读结果（脚本与 AI Agent 用），
            // 字段与界面那份 DTO 一致，不另造一套
            "--json" => {
                json = true;
                i += 1;
            }
            other => return Err(format!("sftp 不认识的参数 `{other}`")),
        }
    }

    // 先校验子命令再校验认证：`sftp rm` 该报「子命令不认识」，
    // 而不是「缺认证方式」——后者会把用户引到错误的方向
    let action = match action {
        "ls" => SftpAction::Ls {
            path: path.unwrap_or_else(|| ".".to_string()),
            json,
        },
        "get" => SftpAction::Get {
            remote: remote.ok_or_else(|| "sftp get 需要 --remote <远端路径>".to_string())?,
            local: local.ok_or_else(|| "sftp get 需要 --local <本地路径>".to_string())?,
        },
        "put" => SftpAction::Put {
            local: local.ok_or_else(|| "sftp put 需要 --local <本地路径>".to_string())?,
            remote: remote.ok_or_else(|| "sftp put 需要 --remote <远端路径>".to_string())?,
        },
        other => return Err(format!("sftp 的子命令只有 ls/get/put，收到 `{other}`")),
    };

    let auth = match (use_agent, key, password) {
        (true, _, _) => SshAuth::Agent,
        (false, Some(path), _) => SshAuth::Key { path, passphrase },
        (false, None, Some(pw)) => SshAuth::Password(pw),
        (false, None, None) => {
            return Err("需要认证方式：--password <pw>、--key <path> 或 --agent".into());
        }
    };

    Ok(Command::Sftp {
        target: SshTarget {
            host: host.ok_or_else(|| "缺少 --host".to_string())?,
            port,
            user: user.ok_or_else(|| "缺少 --user".to_string())?,
            auth,
            insecure_host_key: insecure,
            jumps: jump.finish()?,
        },
        action,
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
    // 中文 Windows 上 MobaXterm 写 GBK：先按 UTF-8 严格解，失败再按 GBK，
    // 不能让中文会话名变成一串 �
    let (text, encoding) = wt_import::decode_ini(&bytes);
    if encoding != "utf-8" {
        writeln!(out, "按 {encoding} 解码").map_err(|e| e.to_string())?;
    }

    let plan = wt_import::parse_mobaxterm_ini(&text).map_err(|e| e.to_string())?;

    let mut store = wt_store::Store::open(db).map_err(|e| e.to_string())?;

    // 去重：同一个 ini 被导入两次不应产生两套会话。
    // 判据与重映射逻辑在 `wt_store::dedup_against`，界面导入走的是同一份实现。
    let existing = store.load_snapshot().map_err(|e| e.to_string())?;
    let deduped = wt_store::dedup_against(&existing, &plan.folders, &plan.sessions);
    let reused_folders = deduped.reused_folders;
    let duplicates = deduped.duplicates;

    let report = store
        .import(&deduped.folders, &deduped.sessions)
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
    let conn = connect_target(target).await?;

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

/// 预处理过的认证方式。
///
/// 抽出来的原因：经跳板时要**同时**握着一份跳板机的 `Auth<'_>` 和一份目标的，
/// 而 `Auth` 借用私钥源——直接写在 `match` 里，两个引用的生命周期会在
/// `connect_via` 调用点多绕一圈，很容易写成「先用后丢」。
enum PreparedAuth {
    Password(String),
    Key(wt_ssh::PrivateKeySource),
    Agent,
}

impl PreparedAuth {
    fn load(auth: &SshAuth) -> Result<Self, String> {
        Ok(match auth {
            SshAuth::Password(pw) => Self::Password(pw.clone()),
            SshAuth::Key { path, passphrase } => {
                let pem = std::fs::read(path)
                    .map_err(|e| format!("读取私钥失败 {}: {e}", path.display()))?;
                Self::Key(wt_ssh::PrivateKeySource::new(pem, passphrase.clone()))
            }
            SshAuth::Agent => Self::Agent,
        })
    }

    fn as_auth(&self) -> wt_ssh::Auth<'_> {
        match self {
            Self::Password(pw) => wt_ssh::Auth::Password(pw),
            Self::Key(src) => wt_ssh::Auth::Key(src),
            Self::Agent => wt_ssh::Auth::Agent,
        }
    }
}

/// 主机密钥策略。每跳各自算一份：`Known` 里装着 `KnownHosts`，不能两跳共用一份。
fn host_key_policy(target: &SshTarget) -> wt_ssh::HostKeyPolicy {
    if target.insecure_host_key {
        return wt_ssh::HostKeyPolicy::AcceptAll;
    }
    let text = std::fs::read_to_string(known_hosts_path()).unwrap_or_default();
    let (kh, _warnings) = wt_ssh::KnownHosts::parse(&text);
    wt_ssh::HostKeyPolicy::Known(Box::new(kh))
}


/// 按 `SshTarget` 建连（密码 / 私钥 / agent），有跳板机时逐跳穿透（`SES-025`）。
///
/// `ssh exec`、`ssh shell` 与 `sftp` 共用：三处各写一遍迟早会出现
/// 「一个校验主机密钥、一个不校验」或「一个走跳板、一个忘了走」。
async fn connect_target(target: &SshTarget) -> Result<wt_ssh::SshConnection, String> {
    use wt_ssh::{Hop, SshConfig};

    let cfg = SshConfig {
        host: target.host.clone(),
        port: target.port,
        user: target.user.clone(),
        ..Default::default()
    };
    // 认证参数的预处理结果要活到握手结束，所以先各准备一份再借用
    let mut prepared = Vec::with_capacity(target.jumps.len() + 1);
    for jump in &target.jumps {
        prepared.push(PreparedAuth::load(&jump.auth)?);
    }
    let auth = PreparedAuth::load(&target.auth)?;

    let hooks: Vec<Hop<'_>> = target
        .jumps
        .iter()
        .zip(&prepared)
        .map(|(jump, a)| Hop {
            cfg: SshConfig {
                host: jump.host.clone(),
                port: jump.port,
                user: jump.user.clone(),
                ..Default::default()
            },
            auth: a.as_auth(),
        })
        .collect();

    // 每跳各自校验主机密钥：不因为「它只是路过」就放宽
    wt_ssh::connect_chain(&hooks, &cfg, &auth.as_auth(), host_key_policy(target))
        .await
        .map_err(|e| e.to_string())
}

/// 文件传输：`ls` / `get` / `put`。
/// `wt ssh shell`：在本机终端里跑一个远端交互式 shell。
///
/// 与 `ssh exec` 的区别：这里接管本机终端（raw 模式），字节双向直通，
/// 所以远端发来的光标移动、颜色、清屏都能正常渲染。
///
/// # raw 模式是必须的
///
/// 默认的规范模式（canonical）会缓冲整行、并拦截 Ctrl+C / Ctrl+Z，
/// 远端 shell 就收不到这些控制字符——行编辑、中断、挂起全部失效。
/// 进入 raw 模式后 stdin 变成原始字节流，我们原样转发。
///
/// # 退出
///
/// 远端关闭通道即退出；本机 stdin 读到 EOF（Ctrl+D / 管道结束）也退出。
/// Ctrl+C 不在这里处理——它作为 `0x03` 发给远端，由远端的 shell 决定含义，
/// 这才是终端该有的行为。
pub async fn run_ssh_shell(target: &SshTarget) -> Result<(), String> {
    let conn = connect_target(target).await?;

    let (cols, rows) = crossterm::terminal::size().unwrap_or((80, 24));
    let mut channel = conn
        .open_shell("xterm-256color", cols as u32, rows as u32)
        .await
        .map_err(|e| e.to_string())?;

    crossterm::terminal::enable_raw_mode()
        .map_err(|e| format!("无法进入终端原始模式：{e}"))?;
    // 无论怎么退出都要恢复终端，否则用户的 shell 会留在 raw 模式里
    let _guard = RawModeGuard;

    let mut out = std::io::stdout();
    let result = pump_shell(&mut channel, Box::new(std::io::stdin()), &mut out).await;

    // 恢复终端后再断开，让最后的输出正常落到屏幕上
    drop(_guard);
    conn.disconnect().await;
    result
}

/// shell 通道的双向泵：本端输入 → 远端，远端输出 → 本端。
///
/// 抽出来是为了**能测**：`run_ssh_shell` 还要接管本机终端（raw 模式、窗口尺寸），
/// 那部分在自动化环境里跑不了；而「字节有没有真的过去、回来、有没有丢尾巴」是纯逻辑。
///
/// 输入读到 EOF 时**先告诉远端**（`Ctrl+D`）再继续收输出。直接 break 会把远端
/// 最后吐的那几行丢掉——退出时看不到结果，比卡住还难查。
pub async fn pump_shell(
    channel: &mut wt_ssh::SshChannel,
    mut input: Box<dyn std::io::Read + Send>,
    out: &mut dyn std::io::Write,
) -> Result<(), String> {
    use std::io::Read;

    // 输入读取是阻塞的，放独立线程；主循环只管 select
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match input.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let mut input_open = true;
    loop {
        tokio::select! {
            input = rx.recv(), if input_open => {
                match input {
                    Some(bytes) => {
                        if channel.write(&bytes).await.is_err() {
                            break;
                        }
                    }
                    None => {
                        // 本端不再输入：告诉远端，然后专心收它的输出
                        input_open = false;
                        let _ = channel.eof().await;
                    }
                }
            }
            msg = channel.next() => {
                match msg {
                    Some(wt_ssh::ChannelData::Stdout(b))
                    | Some(wt_ssh::ChannelData::Stderr(b)) => {
                        if out.write_all(&b).is_err() {
                            break;
                        }
                        let _ = out.flush();
                    }
                    Some(wt_ssh::ChannelData::Exit(_)) => {}
                    None => break,
                }
            }
        }
    }
    Ok(())
}

/// 退出时恢复终端模式。
struct RawModeGuard;

impl Drop for RawModeGuard {
    fn drop(&mut self) {
        let _ = crossterm::terminal::disable_raw_mode();
    }
}

pub async fn run_sftp(
    target: &SshTarget,
    action: &SftpAction,
    out: &mut dyn Write,
) -> Result<(), String> {
    let conn = connect_target(target).await?;
    let sftp = wt_ssh::SftpClient::open(conn)
        .await
        .map_err(|e| e.to_string())?;

    match action {
        SftpAction::Ls { path, json } => {
            let entries = sftp.list_dir(path).await.map_err(|e| e.to_string())?;
            if *json {
                // 字段与界面那份 DTO 一致（`RemoteEntryDto`）：脚本拿到的和看到的同一套
                let rows: Vec<serde_json::Value> = entries
                    .iter()
                    .map(|e| {
                        serde_json::json!({
                            "name": e.name,
                            "isDir": e.is_dir,
                            "size": e.size,
                            "isSymlink": e.is_symlink,
                            "linkTarget": e.link_target,
                            "broken": e.broken,
                            "mode": e.mode,
                            "mtime": e.mtime,
                        })
                    })
                    .collect();
                writeln!(
                    out,
                    "{}",
                    serde_json::to_string_pretty(&rows).map_err(|e| e.to_string())?
                )
                .map_err(|e| e.to_string())?;
            } else {
                for e in entries {
                    let kind = if e.is_dir { "d" } else { "-" };
                    writeln!(out, "{kind} {:>10} {}", e.size, e.name).map_err(|e| e.to_string())?;
                }
            }
        }
        SftpAction::Get { remote, local } => {
            // 边读边写盘：`read_file` 会把整个文件读进内存，几百 MB 的日志就危险了。
            // 这里没有连接池的锁要拿——CLI 这条连接是它自己独占的。
            use std::io::Write;
            let mut file = std::fs::File::create(local)
                .map_err(|e| format!("创建本地文件失败 {}: {e}", local.display()))?;
            let mut reader = sftp.open_read(remote).await.map_err(|e| e.to_string())?;
            let mut buf = vec![0u8; 64 * 1024];
            let mut total: u64 = 0;
            loop {
                let n = reader
                    .read_chunk(&mut buf)
                    .await
                    .map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                file.write_all(&buf[..n])
                    .map_err(|e| format!("写入本地文件失败 {}: {e}", local.display()))?;
                total += n as u64;
            }
            writeln!(out, "已下载 {remote} → {}（{total} 字节）", local.display())
                .map_err(|e| e.to_string())?;
        }
        SftpAction::Put { local, remote } => {
            let data = std::fs::read(local)
                .map_err(|e| format!("读取本地文件失败 {}: {e}", local.display()))?;
            sftp.write_file(remote, &data)
                .await
                .map_err(|e| e.to_string())?;
            writeln!(
                out,
                "已上传 {} → {remote}（{} 字节）",
                local.display(),
                data.len()
            )
            .map_err(|e| e.to_string())?;
        }
    }

    // 连接归 SftpClient 所有，随它一起释放；显式 disconnect 需要额外句柄，
    // 而进程马上退出，交给 drop 即可。
    Ok(())
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

/// `wt doctor [--json]` 的参数解析。
///
/// 以前这里直接 `Ok(Command::Doctor)`，多写的参数被**静默忽略**——`wt doctor --nope`
/// 照样返回 0。用户以为带上了开关，实际什么也没发生，这正是本项目最反感的那类失效。
fn parse_doctor(rest: &[String]) -> Result<Command, String> {
    let mut json = false;
    for a in rest {
        match a.as_str() {
            "--json" => json = true,
            other => return Err(format!("doctor 不认识的参数 `{other}`（只支持 --json）")),
        }
    }
    Ok(Command::Doctor { json })
}

/// 环境自检：把「能不能用」的关键前提逐条打出来。
///
/// `json = true` 时输出一个对象（字段固定），给脚本与 CI 用；否则是人看的几行。
pub fn doctor(out: &mut dyn Write, json: bool) -> Result<(), String> {
    let (shell, args) = wt_term::pty::default_shell();
    let pty = if cfg!(windows) { "ConPTY" } else { "openpty" };
    if json {
        let payload = serde_json::json!({
            "version": env!("CARGO_PKG_VERSION"),
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "shell": shell,
            "shellArgs": args,
            "pty": pty,
        });
        writeln!(
            out,
            "{}",
            serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?
        )
        .map_err(|e| e.to_string())?;
        return Ok(());
    }
    writeln!(out, "wt {}", env!("CARGO_PKG_VERSION")).map_err(|e| e.to_string())?;
    writeln!(out, "os           : {}", std::env::consts::OS).map_err(|e| e.to_string())?;
    writeln!(out, "arch         : {}", std::env::consts::ARCH).map_err(|e| e.to_string())?;
    writeln!(out, "default shell: {shell} {}", args.join(" ")).map_err(|e| e.to_string())?;
    writeln!(out, "pty support  : {pty}").map_err(|e| e.to_string())?;
    Ok(())
}

pub fn usage() -> String {
    [
        "wt —— WindTerm 命令行",
        "",
        "用法：",
        "  wt version                     打印版本",
        "  wt doctor                      环境自检",
        "  wt ssh exec --host <H> --user <U> (--password <PW> | --key <PATH> | --agent)",
        "              [--port <P>] [--passphrase <PP>] [--insecure-host-key]",
        "              -- <command...>",
        "                                 连接真实 SSH 执行命令（默认校验 known_hosts）",
        "                                 --agent：用 ssh-agent 里的身份，私钥不出 agent",
        "  wt ssh shell --host <H> --user <U> (--password <PW> | --key <PATH> | --agent)",
        "              [--port <P>] [--insecure-host-key]",
        "                                 远端交互式 shell（接管本机终端，Ctrl+C 发给远端）",
        "  wt ssh exec|shell / wt sftp ... 都可加 --jump user@host[:port]",
        "              (--jump-password <PW> | --jump-key <PATH> [--jump-passphrase <PP>] | --jump-agent)",
        "                                 先登录跳板机，再经它连目标（单跳；目标由跳板机侧解析）",
        "                                 跳板机的凭据必须另给，不继承目标机的",
        "  wt session import --file <MobaXterm.ini> [--db <path>]",
        "                                 导入 MobaXterm 会话（结构优先，密码需重输）",
        "  wt session list [--db <path>] [--json]",
        "                                 列出已导入的会话树",
        "  wt sftp ls --host <H> --user <U> (--password <PW> | --key <PATH> | --agent)",
        "             [--port <P>] [--path <远端目录>]",
        "  wt sftp get ... --remote <远端文件> --local <本地路径>",
        "  wt sftp put ... --local <本地路径> --remote <远端文件>",
        "                                 文件传输（认证参数与 ssh exec 一致）",
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
    fn sftp_ls_defaults_to_current_dir() {
        let cmd = parse(&s(&[
            "sftp", "ls", "--host", "h", "--user", "u", "--password", "p",
        ]))
        .expect("应能解析");
        match cmd {
            Command::Sftp {
                target,
                action: SftpAction::Ls { path, json },
            } => {
                assert_eq!(path, ".");
                assert!(!json, "默认不该输出 JSON");
                assert_eq!(target.port, 22);
                assert_eq!(target.host, "h");
            }
            _ => panic!("应解析成 sftp ls"),
        }
    }

    #[test]
    fn sftp_get_requires_remote_and_local() {
        let err = parse(&s(&[
            "sftp", "get", "--host", "h", "--user", "u", "--password", "p",
        ]))
        .unwrap_err();
        assert!(err.contains("--remote"), "实际: {err}");
    }

    #[test]
    fn sftp_put_parses_both_paths() {
        let cmd = parse(&s(&[
            "sftp",
            "put",
            "--host",
            "h",
            "--user",
            "u",
            "--key",
            "id_ed25519",
            "--local",
            "a.txt",
            "--remote",
            "/tmp/a.txt",
        ]))
        .expect("应能解析");
        match cmd {
            Command::Sftp {
                action: SftpAction::Put { local, remote },
                target,
            } => {
                assert!(local.to_string_lossy().ends_with("a.txt"));
                assert_eq!(remote, "/tmp/a.txt");
                assert!(matches!(target.auth, SshAuth::Key { .. }));
            }
            _ => panic!("应解析成 sftp put"),
        }
    }

    #[test]
    fn sftp_unknown_subcommand_is_a_clear_error() {
        let err = parse(&s(&["sftp", "rm"])).unwrap_err();
        assert!(err.contains("ls/get/put"), "实际: {err}");
    }

    #[test]
    fn parses_ssh_shell_without_a_command() {
        let cmd = parse(&s(&[
            "ssh", "shell", "--host", "h", "--user", "u", "--agent",
        ]))
        .expect("应能解析");
        match cmd {
            Command::SshShell { target } => {
                assert_eq!(target.host, "h");
                assert_eq!(target.port, 22);
                assert!(matches!(target.auth, SshAuth::Agent));
            }
            _ => panic!("应解析成 ssh shell"),
        }
    }

    #[test]
    fn ssh_unknown_subcommand_lists_both() {
        let err = parse(&s(&["ssh", "sftp"])).unwrap_err();
        assert!(err.contains("exec") && err.contains("shell"), "实际: {err}");
    }

    #[test]
    fn parses_version_and_doctor() {
        assert_eq!(parse(&s(&["version"])).unwrap(), Command::Version);
        assert_eq!(parse(&s(&["--version"])).unwrap(), Command::Version);
        assert_eq!(
        parse(&s(&["doctor"])).unwrap(),
        Command::Doctor { json: false }
    );
    // 多写的参数不能静默忽略：`wt doctor --nope` 以前照样返回 0，用户以为开关生效了
    assert!(parse(&s(&["doctor", "--nope"])).is_err());
    assert_eq!(
        parse(&s(&["doctor", "--json"])).unwrap(),
        Command::Doctor { json: true }
    );
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
        doctor(&mut buf, false).unwrap();
        let text = String::from_utf8_lossy(&buf);
        assert!(text.contains("default shell"));
        assert!(text.contains("pty support"));
    }

    #[test]
    fn doctor_json_is_machine_readable() {
        // `--json` 是给脚本与 CI 用的：输出必须是能解析的 JSON，字段固定。
        let mut buf: Vec<u8> = Vec::new();
        doctor(&mut buf, true).unwrap();
        let text = String::from_utf8_lossy(&buf);
        let v: serde_json::Value = serde_json::from_str(text.trim())
            .unwrap_or_else(|e| panic!("输出不是合法 JSON：{e}；实际：{text}"));
        for key in ["version", "os", "arch", "shell", "shellArgs", "pty"] {
            assert!(v.get(key).is_some(), "缺字段 {key}：{text}");
        }
        assert!(v["shellArgs"].is_array(), "shellArgs 应该是数组：{text}");
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
            jumps: Vec::new(),
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
            jumps: Vec::new(),
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
            jumps: Vec::new(),
        };

        let mut out: Vec<u8> = Vec::new();
        let code = run_ssh_exec(&target, "id", &mut out).await.expect("应成功");
        assert_eq!(code, 0);
        assert!(String::from_utf8_lossy(&out).contains("ran:id"));

        let _ = std::fs::remove_file(&path);
    }

    // ─────────────────────────────────────────────────────────
    // `--jump`（`G14`）
    // ─────────────────────────────────────────────────────────

    #[tokio::test]
    async fn shell_pump_sends_input_and_keeps_the_tail() {
        // `wt ssh shell` 的交互部分要接管本机终端（raw 模式），自动化里跑不了；
        // 但「键入了什么、远端回了什么」是纯逻辑，这里用内存输入输出验一遍。
        let server = wt_ssh::testing::MockSshServer::start().await;
        let target = SshTarget {
            host: "127.0.0.1".into(),
            port: server.port,
            user: "tester".into(),
            auth: SshAuth::Password("secret".into()),
            insecure_host_key: true,
            jumps: Vec::new(),
        };
        let conn = connect_target(&target).await.expect("建连");
        let mut channel = conn
            .open_shell("xterm-256color", 80, 24)
            .await
            .expect("开 shell");

        let mut out: Vec<u8> = Vec::new();
        // 输入以 EOF 结束：泵必须先把 EOF 告诉远端，再把它最后的输出收完
        let input = Box::new(std::io::Cursor::new(b"hello\n".to_vec()));
        pump_shell(&mut channel, input, &mut out)
            .await
            .expect("泵应正常收尾");

        let text = String::from_utf8_lossy(&out);
        assert!(text.contains("WELCOME"), "少了服务端横幅：{text:?}");
        assert!(
            text.contains("echo:hello"),
            "输入没有真的过去，或回显被 EOF 之后丢掉了：{text:?}"
        );
    }

    #[test]
    fn parses_jump_into_the_target() {
        let cmd = parse(&s(&[
            "ssh", "exec", "--host", "10.0.3.44", "--user", "root", "--password", "pw",
            "--jump", "admin@bastion:2222", "--jump-password", "jp", "--", "uptime",
        ]))
        .expect("应能解析");
        let Command::SshExec { target, .. } = cmd else {
            panic!("应解析成 ssh exec");
        };
        let jump = target.jumps.into_iter().next().expect("应带跳板机");
        assert_eq!(jump.host, "bastion");
        assert_eq!(jump.port, 2222);
        assert_eq!(jump.user, "admin");
        assert_eq!(jump.auth, SshAuth::Password("jp".into()));
        // 目标的凭据不受影响——两边各一份
        assert_eq!(target.auth, SshAuth::Password("pw".into()));
    }

    #[test]
    fn jump_port_defaults_to_22() {
        let cmd = parse(&s(&[
            "ssh", "shell", "--host", "h", "--user", "u", "--agent", "--jump", "a@b",
            "--jump-agent",
        ]))
        .unwrap();
        let Command::SshShell { target } = cmd else {
            panic!("应解析成 ssh shell");
        };
        let jump = target.jumps.into_iter().next().expect("应带跳板机");
        assert_eq!((jump.host.as_str(), jump.port), ("b", 22));
        assert_eq!(jump.auth, SshAuth::Agent);
    }

    #[test]
    fn jump_is_available_for_sftp_too() {
        let cmd = parse(&s(&[
            "sftp", "ls", "--host", "h", "--user", "u", "--password", "p",
            "--jump", "a@b", "--jump-key", "C:/k/id_ed25519",
        ]))
        .unwrap();
        let Command::Sftp { target, .. } = cmd else {
            panic!("应解析成 sftp");
        };
        let jump = target.jumps.into_iter().next().expect("sftp 也应带跳板机");
        assert_eq!(jump.auth, SshAuth::Key {
            path: std::path::PathBuf::from("C:/k/id_ed25519"),
            passphrase: None,
        });
    }

    #[test]
    fn jump_without_its_own_auth_is_rejected() {
        // 不能悄悄用目标的凭据：跳板机与目标机往往是两套账号
        let err = parse(&s(&[
            "ssh", "exec", "--host", "h", "--user", "u", "--password", "p", "--jump", "a@b",
            "--", "x",
        ]))
        .unwrap_err();
        assert!(err.contains("不继承"), "实际: {err}");
    }

    #[test]
    fn jump_credentials_without_jump_are_rejected() {
        // 半截配置必须报错，否则用户以为配上了、实际在直连
        let err = parse(&s(&[
            "ssh", "exec", "--host", "h", "--user", "u", "--password", "p",
            "--jump-password", "jp", "--", "x",
        ]))
        .unwrap_err();
        assert!(err.contains("--jump"), "实际: {err}");
    }

    #[test]
    fn jump_spec_needs_a_user() {
        let err = parse(&s(&[
            "ssh", "exec", "--host", "h", "--user", "u", "--password", "p",
            "--jump", "bastion", "--jump-password", "jp", "--", "x",
        ]))
        .unwrap_err();
        assert!(err.contains("user@host"), "实际: {err}");
    }

    #[test]
    fn jump_spec_accepts_bracketed_ipv6() {
        let cmd = parse(&s(&[
            "ssh", "exec", "--host", "h", "--user", "u", "--password", "p",
            "--jump", "a@[::1]:2200", "--jump-password", "jp", "--", "x",
        ]))
        .unwrap();
        let Command::SshExec { target, .. } = cmd else {
            panic!("应解析成 ssh exec");
        };
        let jump = target.jumps.into_iter().next().expect("应带跳板机");
        assert_eq!((jump.host.as_str(), jump.port), ("::1", 2200));
    }

    #[test]
    fn parses_multiple_jumps_in_order() {
        // `--jump` 可重复，顺序按「离本机由近到远」（`SES-025`）
        let cmd = parse(&s(&[
            "ssh", "exec", "--host", "t", "--user", "u", "--password", "p",
            "--jump", "a@j1", "--jump", "a@j2:2200", "--jump-password", "jp", "--", "x",
        ]))
        .unwrap();
        let Command::SshExec { target, .. } = cmd else {
            panic!("应解析成 ssh exec");
        };
        assert_eq!(target.jumps.len(), 2);
        assert_eq!((target.jumps[0].host.as_str(), target.jumps[0].port), ("j1", 22));
        assert_eq!((target.jumps[1].host.as_str(), target.jumps[1].port), ("j2", 2200));
    }

    #[test]
    fn rejects_more_than_five_jumps() {
        // 与 wt_core 的上限保持一致：界面存得下 5 跳，命令行也不能更少
        let mut argv = s(&["ssh", "exec", "--host", "t", "--user", "u", "--password", "p"]);
        for i in 0..6 {
            argv.push("--jump".into());
            argv.push(format!("a@j{i}"));
        }
        argv.push("--jump-password".into());
        argv.push("jp".into());
        let err = parse(&argv).unwrap_err();
        assert!(err.contains("最多 5 跳"), "实际: {err}");
    }

    #[test]
    fn jump_spec_rejects_bare_ipv6() {
        // `::1` 与「主机:端口」撞车，猜错会连到 `::` 的 1 端口
        let err = parse(&s(&[
            "ssh", "exec", "--host", "h", "--user", "u", "--password", "p",
            "--jump", "a@::1", "--jump-password", "jp", "--", "x",
        ]))
        .unwrap_err();
        assert!(err.contains("方括号"), "实际: {err}");
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