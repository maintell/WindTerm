# 详细设计 · 11 · 本地 Shell 与虚拟路径

实现需求：`LOC-001`~`LOC-023`
关键 ADR：ADR-0003（不打包 POSIX 运行时）

## 1. 为什么自研 shell

Cygwin/MSYS2 的 bash 依赖 `fork()`，在 Windows 上通过 `cygwin1.dll` 模拟（复制进程内存 + 重定向句柄），代价是：

- 每次 `fork` 复制整个进程地址空间（几百 MB 的 shell 进程 fork 一次要几十毫秒）；
- 需要一整套 POSIX 兼容层（路径、权限、信号、pty）；
- 与原生 Windows 程序混跑时路径语义冲突。

自研一个「够用的」shell，只需要实现**管道 + 重定向 + 通配 + 变量 + 命令替换**，约 3000 行。它不需要 `fork()`——用 `CreateProcess` 直接启动，管道用匿名管道连接。

**代价**：不支持 shell 函数、数组、`trap`、`set -e`。这些在交互式运维场景里很少用，在脚本里很常见——所以我们提供「用 WSL/系统 shell 跑复杂脚本」的路径。

## 2. 组件

```
crates/wt-shell/src/
├── lib.rs
├── lexer.rs       词法
├── parser.rs      语法 → AST
├── ast.rs         AST 定义
├── expand.rs      变量/通配/命令替换展开
├── exec.rs        执行器（管道、重定向、内建分发）
├── builtin/       内建命令
│   ├── cd.rs  export.rs  alias.rs  history.rs  jobs.rs  test.rs  source.rs
├── vfs.rs         虚拟路径命名空间
├── prompt.rs      提示符渲染
├── lineedit.rs    行编辑（rustyline 封装）
└── complete.rs    补全
```

## 3. 词法与语法

### 3.1 词法

```rust
pub enum Token {
    Word(Word),          // 可能含变量、命令替换、通配
    Pipe,                // |
    And,                 // &&
    Or,                  // ||
    Semi,                // ;
    Amp,                 // &
    Redirect(RedirectOp, Option<Word>),  // > >> < 2> 2>&1 &>
    LParen, RParen,
    Newline,
}

pub enum RedirectOp { Out, Append, In, OutErr, AppendErr, ErrToOut, Both }
```

**词法难点**

| 难点 | 处理 |
|---|---|
| 引号内不拆分 | 词法层记录「是否被引号包裹」，展开时区别对待 |
| `$(...)` 嵌套 | 递归扫描，配平括号（注意 `$((` 算术、`$(` 命令替换的区别） |
| 转义 `\` | 在双引号内只转义 `$ \ ` "` 换行；单引号内全不转义 |
| Here-doc | 词法层识别 `<<EOF`，读到行首 `EOF` 为止 |
| 换行续行 | 行尾 `\` 时继续读下一行 |

### 3.2 AST

```rust
pub enum Ast {
    Sequence(Vec<Ast>),                     // ; 与换行分隔
    AndThen(Box<Ast>, Box<Ast>),            // &&
    OrElse(Box<Ast>, Box<Ast>),             // ||
    Pipeline(Vec<Ast>),                     // |
    Simple(SimpleCommand),                  // 命令 + 参数 + 重定向
    Subshell(Box<Ast>),                     // ( ... )
    Background(Box<Ast>),                   // &
}

pub struct SimpleCommand {
    pub assigns: Vec<(String, Word)>,       // FOO=bar 前缀
    pub argv: Vec<Word>,
    pub redirects: Vec<(RedirectOp, Option<Word>, Word)>,
}
```

### 3.3 语法（EBNF 摘要）

```ebnf
program    = sequence ;
sequence   = and_or { (";" | NEWLINE) and_or } ;
and_or     = pipeline { ("&&" | "||") pipeline } ;
pipeline   = command { "|" command } ;
command    = simple | subshell | simple "&" ;
simple     = { assign } [ word { word } ] { redirect } ;
redirect   = ( ">" | ">>" | "<" | "2>" | "2>>" | "2>&1" | "&>" ) [ word ] word ;
subshell   = "(" sequence ")" ;
```

**不支持**（解析时给出明确错误，不是静默失败）：

| 语法 | 错误 |
|---|---|
| `for` / `while` / `if` / `case` | `SHE_UNSUPPORTED_SYNTAX`「WindShell 不支持 for/while/if，请写成脚本文件或用 WSL」 |
| `func() { ... }` | 同上 |
| `arr=(a b c)` | 同上 |
| `[[ ... ]]` | 「请用 test / [」 |
| `trap` | 同上 |

## 4. 展开

```rust
pub struct Expander<'a> {
    env: &'a mut Env,
    cwd: &'a mut Path,
}

impl Expander<'_> {
    pub async fn expand(&mut self, w: &Word, ctx: ExpandCtx) -> Result<Vec<String>> {
        // 1. 变量替换（$VAR ${VAR} ${VAR:-default} ${VAR#prefix} ${VAR%suffix}）
        let s = self.expand_vars(w)?;
        // 2. 命令替换（$(cmd) 与 `cmd`）
        let s = self.expand_commands(s).await?;
        // 3. 波浪号（~ 与 ~user）
        let s = self.expand_tilde(s)?;
        // 4. 分词（未被引号包裹的空格）
        let parts = split_unquoted(&s, w.quoted_spans);
        // 5. 通配（仅当 ctx.allow_glob 且未在引号内）
        let parts = if ctx.allow_glob { self.glob(parts)? } else { parts };
        Ok(parts)
    }
}
```

**顺序很重要**：变量 → 命令替换 → 波浪号 → 分词 → 通配。顺序错了会导致 `"$VAR"` 里的空格被当成分隔符。

### 4.1 通配

```rust
fn glob(&self, pattern: &str) -> Result<Vec<String>> {
    // 支持 * ? [abc] [a-z] [!abc] **（递归）
    // 在 vfs 上做匹配，而不是 std::fs（因为要支持 /drives 与 //host）
    let matches = self.vfs.glob(pattern)?;
    if matches.is_empty() {
        Ok(vec![pattern.to_string()])     // 无匹配时保留原文（bash 默认行为）
    } else {
        Ok(matches)
    }
}
```

**`glob` 必须走 vfs**：`/drives/c/*.txt` 不能交给 `std::fs::read_dir`。

## 5. 执行器

```rust
pub struct Executor {
    env: Env,
    vfs: Arc<Vfs>,
    jobs: JobTable,
    builtins: HashMap<&'static str, Box<dyn Builtin>>,
}

impl Executor {
    pub async fn run(&mut self, ast: &Ast) -> Result<ExitStatus> {
        match ast {
            Ast::Sequence(items) => {
                let mut last = ExitStatus::SUCCESS;
                for item in items { last = self.run_boxed(item).await?; }
                Ok(last)
            }
            Ast::AndThen(a, b) => {
                if self.run_boxed(a).await?.success() { self.run_boxed(b).await } else { Ok(last) }
            }
            Ast::OrElse(a, b) => {
                if !self.run_boxed(a).await?.success() { self.run_boxed(b).await } else { Ok(last) }
            }
            Ast::Pipeline(cmds) => self.run_pipeline(cmds).await,
            Ast::Simple(cmd) => self.run_simple(cmd).await,
            Ast::Subshell(inner) => { /* 克隆 env 执行 */ }
            Ast::Background(inner) => { /* spawn 到 job table */ }
        }
    }
}
```

### 5.1 管道

```rust
async fn run_pipeline(&mut self, cmds: &[Ast]) -> Result<ExitStatus> {
    if cmds.len() == 1 { return self.run_boxed(&cmds[0]).await; }

    let mut prev_reader: Option<ChildStdout> = None;
    let mut children = Vec::new();

    for (i, cmd) in cmds.iter().enumerate() {
        let is_last = i == cmds.len() - 1;

        let (reader, writer) = if is_last { (None, None) } else { (Some(pipe()?), None) };

        let child = self.spawn_command(cmd, prev_reader.take(), reader.as_ref().map(|r| r.writer))?;
        children.push(child);
        prev_reader = reader.map(|r| r.reader);
    }

    // 等待所有子进程
    let mut status = ExitStatus::SUCCESS;
    for c in children { status = c.wait().await?; }
    Ok(status)
}
```

**Windows 的管道**：`CreatePipe` + 把写端句柄通过 `STARTUPINFO.hStdOutput` 传给子进程。`std::process::Stdio` 已经封装了这些，直接用。

### 5.2 重定向

| 语法 | 实现 |
|---|---|
| `> file` | `Stdio::from(File::create(file))` |
| `>> file` | `Stdio::from(OpenOptions::append(true).open(file))` |
| `< file` | `Stdio::from(File::open(file))` |
| `2> file` | `Stdio::from(File::create(file))` 给 stderr |
| `2>&1` | `stderr = Stdio::from(stdout_dup)` |
| `&> file` | 同上，都指向 file |

**`2>&1` 的实现**：需要把 stdout 的句柄复制一份给 stderr。`std::process` 没有直接的「复制」API，需要：
1. 先创建文件/管道；
2. 用 `try_clone()` 得到两个句柄；
3. 分别给 stdout 与 stderr。

### 5.3 内建命令

内建必须在**父进程**执行（改变 cwd/env 才有意义）。但管道里的内建需要特殊处理（例如 `ls | cd` 无意义，但 `echo x | read v` 在 bash 里也是子 shell）。

**规则**

| 位置 | 行为 |
|---|---|
| 单独命令 | 父进程执行（`cd`/`export` 生效） |
| 管道中（非最后） | 父进程执行，输出写入管道 |
| 管道中（最后） | 父进程执行，输出到 stdout |
| 重定向中 | 父进程执行，临时重定向 |

**`cd` 在管道里**：允许，但效果是「改了父 shell 的 cwd」——这与 bash 的子 shell 语义不同。**必须文档化**并在 `cd` 用于管道时给出警告。

## 6. 虚拟路径命名空间

### 6.1 设计

```rust
pub struct Vfs {
    drives: Vec<DriveInfo>,       // 缓存的盘符
    last_refresh: Instant,
}

pub enum PathNs {
    Posix(String),                 // /drives/c/foo
    Unc { host: String, share: String, rest: String },   // //host/share/foo
    Windows(PathBuf),              // C:\foo
}

impl Vfs {
    /// 把任意形式的路径规范化为「可交给 std::fs 的真实路径」
    pub fn resolve(&self, input: &str) -> Result<ResolvedPath> {
        match classify(input) {
            PathNs::Posix(p) if p.starts_with("/drives/") => {
                let rest = &p["/drives/".len()..];
                let (letter, tail) = rest.split_once('/').unwrap_or((rest, ""));
                if letter.len() != 1 { return Err(not_found(p)); }
                Ok(ResolvedPath::Windows(format!("{}:\\{}", letter.to_uppercase(), tail.replace('/', "\\"))))
            }
            PathNs::Posix(p) if p.starts_with("//") => {
                let rest = &p[2..];
                let mut parts = rest.splitn(3, '/');
                let host = parts.next().unwrap_or("");
                let share = parts.next().unwrap_or("");
                let tail = parts.next().unwrap_or("");
                Ok(ResolvedPath::Windows(format!(r"\\{host}\{share}\{}", tail.replace('/', "\\"))))
            }
            PathNs::Posix(p) => {
                // 其他 /xxx 视为「相对虚拟根」→ 映射到 data 目录下的 vroot
                Ok(ResolvedPath::Windows(self.vroot.join(p.trim_start_matches('/')).to_string_lossy().into()))
            }
            PathNs::Unc { .. } | PathNs::Windows(_) => Ok(ResolvedPath::Windows(input.to_string())),
            PathNs::Relative(r) => Ok(ResolvedPath::Relative(r)),
        }
    }

    /// 反向：Windows 路径 → POSIX 风格（用于提示符显示）
    pub fn to_posix(&self, p: &Path) -> String;
}
```

### 6.2 为什么需要 `/` 虚拟根

MobaXterm 的 `/` 是一个真实的 Cygwin 根（包含 `/bin`、`/etc`、`/usr`）。我们没有 Cygwin，所以 `/` 需要一个落点。

**设计**：`/` 映射到 `<config-dir>/vroot/`，初始为空。用户可以：
- 在里面放脚本、配置；
- 通过 `wt pkg` 安装的工具软链到 `/bin`。

**不伪造 `/bin/ls`**：内置 coreutils 通过 `PATH` 暴露（`<install-dir>/coreutils/`），不在 `/bin` 下造一个假目录。理由：造假的目录结构会让用户误以为有完整的 POSIX 环境。

### 6.3 盘符刷新

```rust
impl Vfs {
    fn refresh_drives(&mut self) {
        if self.last_refresh.elapsed() < Duration::from_secs(5) { return; }
        #[cfg(windows)]
        {
            self.drives = (b'A'..=b'Z')
                .filter_map(|c| {
                    let p = format!("{}:\\", c as char);
                    if Path::new(&p).exists() { Some(DriveInfo { letter: c as char, path: p }) } else { None }
                })
                .collect();
        }
        self.last_refresh = Instant::now();
    }
}
```

**5 秒缓存**：`Path::exists` 对网络盘会阻塞（超时可达 30 s）。缓存避免每次 `ls /drives` 都卡住。

**网络盘的额外处理**：`/drives/z` 若是断开的映射盘，`exists()` 会阻塞。用 `GetDriveType` 先判断类型，网络盘加超时（用线程 + `recv_timeout`）。

## 7. 行编辑与补全

### 7.1 行编辑

用 `rustyline`（跨平台、支持 Windows 控制台）。

```rust
let mut rl = rustyline::Editor::<WindHelper, ()>::new()?;
rl.set_helper(Some(WindHelper { vfs, complete }));
loop {
    let line = rl.readline(&prompt)?;
    rl.add_history_entry(&line);
    exec(line).await?;
}
```

**关键配置**

| 项 | 值 | 原因 |
|---|---|---|
| `CompletionType::List` | 列表补全 | 与 bash 一致 |
| `EditMode::Emacs` | 默认 Emacs | |
| `history_ignore_dups` | true | |
| `max_history_size` | 10000 | |

### 7.2 补全

```rust
impl Completer for WindHelper {
    fn complete(&self, line: &str, pos: usize, ctx: &Context) -> Result<(usize, Vec<Pair>)> {
        let tokens = tokenize_partial(line, pos);

        if tokens.len() == 1 {
            // 补全命令名：内建 + PATH 中的可执行文件
            let mut cands = self.builtins.clone();
            cands.extend(self.path_executables());
            filter_prefix(cands, tokens[0])
        } else {
            // 补全路径：走 vfs
            let prefix = tokens.last().unwrap();
            let entries = self.vfs.list_dir_of(prefix)?;
            filter_prefix(entries, prefix)
        }
    }
}
```

**`wt` 子命令补全**：解析 `wt` 的子命令树，提供二级/三级补全。这是「AI Agent 体验」的一部分——`wt` 的每个子命令都能被补全发现。

## 8. 提示符

```rust
pub struct PromptConfig {
    pub template: String,        // 默认 "\u@\h:\w$ "
    pub show_git: bool,
    pub show_exit_code: bool,
    pub show_time: bool,
}
```

**渲染**

| 占位符 | 内容 |
|---|---|
| `\u` | 用户名 |
| `\h` | 主机名（短） |
| `\H` | 主机名（全） |
| `\w` | 当前目录（`~` 缩写） |
| `\W` | 当前目录（仅末级） |
| `\t` / `\T` | 时间 |
| `\$` | `#`（管理员）或 `$` |
| `\e` | ESC（用于颜色） |

**Git 分支**：读 `.git/HEAD`（不调用 git 命令，避免每次提示符都启动进程）：

```rust
fn git_branch(dir: &Path) -> Option<String> {
    let mut d = dir;
    loop {
        let head = d.join(".git/HEAD");
        if head.exists() {
            let s = fs::read_to_string(head).ok()?;
            return s.strip_prefix("ref: refs/heads/").map(|b| b.trim().to_string());
        }
        d = d.parent()?;
    }
}
```

**性能**：提示符渲染必须 < 1 ms。`git_branch` 每次要读文件——用 500 ms 缓存。

## 9. 与系统 shell 的桥接

```rust
pub enum ShellKind {
    WindShell,
    PowerShell { exe: PathBuf },
    Cmd,
    Wsl { distro: Option<String> },
    GitBash { exe: PathBuf },
    Custom { exe: PathBuf, args: Vec<String> },
}
```

**选择逻辑**（`LOC-001`）

```rust
pub fn detect_default() -> ShellKind {
    #[cfg(windows)]
    {
        if which("pwsh").is_some() { return ShellKind::PowerShell { exe: which("pwsh").unwrap() }; }
        if which("powershell").is_some() { return ShellKind::PowerShell { exe: ... }; }
        ShellKind::Cmd
    }
    #[cfg(unix)]
    {
        ShellKind::Custom { exe: PathBuf::from(std::env::var("SHELL").unwrap_or("/bin/bash".into())), args: vec![] }
    }
}
```

**为什么默认不是 WindShell**：用户的肌肉记忆与既有脚本都是针对系统 shell 的。WindShell 是「没有更好选择时」的选项，不是默认强加。

**UI**：本地终端新建时提供下拉，默认选中探测结果，并显示「WindShell（内置，无需安装）」作为可选。

## 10. 与需求的对应

| 设计点 | 需求 |
|---|---|
| 词法/语法/执行器 | `LOC-001`、WindShell 规格 §3.2 |
| 管道与重定向 | WindShell §3.2 AC-1 |
| 不支持语法的明确错误 | `LOC-001` 能力边界 |
| 通配走 vfs | `LOC-002` |
| `/drives` 解析 | `LOC-002` |
| `//host/share` | `LOC-004` |
| 盘符缓存 | 网络盘不阻塞 |
| 行编辑与补全 | `LOC-001` AC-1~4 |
| 提示符 + git 分支 | 体验 |
| Shell 探测 | `LOC-001` AC-1 |
| `open` / `wt path` | `LOC-005/006` |
| 路径双向转换 | `LOC-006` |
| 执行 Windows 程序 | `LOC-007` |
| 内置 coreutils | `LOC-008` |
| 内置 ssh/scp/sftp CLI | `LOC-009` |
| 密钥生成器 | `LOC-014` |
| 文本编辑 CLI | `LOC-019` |
