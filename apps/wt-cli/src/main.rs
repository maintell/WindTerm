//! `wt` 可执行入口。
//!
//! 只做三件事：解析参数、调用库函数、把结果映射成退出码。
//! 真正的逻辑在 `lib.rs`，这样它可被测试直接调用，不必 spawn 进程。

use std::process::ExitCode;

use wt_cli::{parse, run_local_exec, Command, EXIT_OK, EXIT_RUNTIME, EXIT_TIMEOUT, EXIT_USAGE};

/// 单线程异步运行时。`ssh exec` 与 `sftp` 都要，抽出来免得两处各建一个。
fn runtime() -> Result<tokio::runtime::Runtime, ExitCode> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| {
            eprintln!("无法启动异步运行时：{e}");
            ExitCode::from(EXIT_RUNTIME as u8)
        })
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();

    let cmd = match parse(&args) {
        Ok(c) => c,
        Err(msg) => {
            eprintln!("错误：{msg}");
            eprintln!();
            eprintln!("{}", wt_cli::usage());
            return ExitCode::from(EXIT_USAGE as u8);
        }
    };

    match cmd {
        Command::Help => {
            println!("{}", wt_cli::usage());
            ExitCode::from(EXIT_OK as u8)
        }
        Command::Version => {
            println!("wt {}", env!("CARGO_PKG_VERSION"));
            ExitCode::from(EXIT_OK as u8)
        }
        Command::Doctor => match wt_cli::doctor(&mut std::io::stdout()) {
            Ok(()) => ExitCode::from(EXIT_OK as u8),
            Err(e) => {
                eprintln!("自检失败：{e}");
                ExitCode::from(EXIT_RUNTIME as u8)
            }
        },
        Command::SessionImport { file, db } => {
            let db = db.unwrap_or_else(wt_cli::default_db_path);
            let mut stdout = std::io::stdout();
            match wt_cli::import_mobaxterm(&file, &db, &mut stdout) {
                Ok(()) => ExitCode::from(EXIT_OK as u8),
                Err(msg) => {
                    eprintln!("导入失败：{msg}");
                    ExitCode::from(EXIT_RUNTIME as u8)
                }
            }
        }
        Command::SessionList { db, json } => {
            let db = db.unwrap_or_else(wt_cli::default_db_path);
            let mut stdout = std::io::stdout();
            match wt_cli::list_sessions(&db, &mut stdout, json) {
                Ok(()) => ExitCode::from(EXIT_OK as u8),
                Err(msg) => {
                    eprintln!("读取失败：{msg}");
                    ExitCode::from(EXIT_RUNTIME as u8)
                }
            }
        }
        Command::SshExec { target, command } => {
            let rt = match runtime() {
                Ok(rt) => rt,
                Err(code) => return code,
            };
            let mut stdout = std::io::stdout();
            match rt.block_on(wt_cli::run_ssh_exec(&target, &command, &mut stdout)) {
                Ok(code) => ExitCode::from(u8::try_from(code).unwrap_or(EXIT_RUNTIME as u8)),
                Err(msg) => {
                    eprintln!("SSH 执行失败：{msg}");
                    ExitCode::from(EXIT_RUNTIME as u8)
                }
            }
        }
        Command::Sftp { target, action } => {
            let rt = match runtime() {
                Ok(rt) => rt,
                Err(code) => return code,
            };
            let mut stdout = std::io::stdout();
            match rt.block_on(wt_cli::run_sftp(&target, &action, &mut stdout)) {
                Ok(()) => ExitCode::from(EXIT_OK as u8),
                Err(msg) => {
                    eprintln!("文件传输失败：{msg}");
                    ExitCode::from(EXIT_RUNTIME as u8)
                }
            }
        }
        Command::SshShell { target } => {
            let rt = match runtime() {
                Ok(rt) => rt,
                Err(code) => return code,
            };
            match rt.block_on(wt_cli::run_ssh_shell(&target)) {
                Ok(()) => ExitCode::from(EXIT_OK as u8),
                Err(msg) => {
                    eprintln!("SSH 会话失败：{msg}");
                    ExitCode::from(EXIT_RUNTIME as u8)
                }
            }
        }
        Command::LocalExec {
            program,
            args,
            timeout,
            raw,
        } => {
            let mut stdout = std::io::stdout();
            match run_local_exec(&program, &args, timeout, raw, &mut stdout) {
                Ok(code) => {
                    // 透传子进程退出码：脚本里 `wt local exec -- false` 必须返回非 0
                    ExitCode::from(u8::try_from(code).unwrap_or(EXIT_RUNTIME as u8))
                }
                Err(msg) => {
                    eprintln!("执行失败：{msg}");
                    let code = if msg.contains("超时") {
                        EXIT_TIMEOUT
                    } else {
                        EXIT_RUNTIME
                    };
                    ExitCode::from(code as u8)
                }
            }
        }
    }
}
