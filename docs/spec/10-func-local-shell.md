# 10 · 功能规格 · 本地 Shell 与内置工具

承接需求：`LOC-001`~`LOC-023`

## 1. 范围与最关键的决策

MobaXterm 的本地终端是一个真正的 Cygwin bash：能 `fork()`、能跑 `gcc`、能 `make`、能 `rsync`。这带来了极强的能力，也带来了 300 MB 的体积、GPL 传染、以及 Windows 上「两套路径语义」的长期困扰。

**我们必须决定：要不要复制这个能力？**

### 1.1 决策：不打包 POSIX 运行时（ADR-0003）

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| A. 打包 Cygwin/MSYS2 | 完整 POSIX，生态齐全 | +250 MB、GPL、`fork()` 模拟性能差、两套路径、驱动级兼容问题 | ❌ |
| B. 只支持系统 shell（PowerShell/cmd/WSL） | 零成本、原生 | 没有 `ls`/`grep`/`awk`，MobaXterm 用户会立刻感到缺失 | ❌ |
| C. 自研 WindShell + Rust 工具集 + 可选 MSYS2 桥接 | 体积小（+8 MB）、无 GPL、路径语义统一、可脚本化 | 不支持 `fork()` 型工具（`make`、`gcc`）；shell 语法需自己实现 | ✅ **采用** |
| D. 检测 WSL 并代理 | 完整 Linux | 需用户装 WSL；跨文件系统性能差；不是所有用户都有 | ✅ **作为推荐路径并列提供** |

**组合策略**：

```
本地终端类型（用户可选，默认按可用性排序）
  ① WindShell（内置，零依赖）        ← 默认，提供 POSIX 风格体验
  ② PowerShell / pwsh               ← Windows 用户已有
  ③ WSL（检测到则提供，推荐给开发者） ← 完整 POSIX
  ④ Git Bash（检测到则提供）
  ⑤ 自定义命令
```

这个组合比「一个 Cygwin 打天下」更诚实：**用户知道自己得到的是什么**，而不是在一个模拟环境里遇到 `fork()` 相关的神秘失败。

### 1.2 能力边界（必须在 UI 上说明）

| 能做 | 不能做 |
|---|---|
| `ls`/`cat`/`grep`/`sed`/`awk`（基础）/`find`/`xargs`/`sort`/`uniq`/`wc`/`head`/`tail` | `fork()` 密集型工具（`make`、`gcc`、`configure`） |
| 管道、重定向、通配、变量、命令替换 | 完整的 POSIX 进程语义（作业控制为简化版） |
| 调用任意 Windows 可执行文件 | 运行 Linux ELF 二进制 |
| 路径命名空间 `/drives/c`、`//host/share` | 符号链接的完整语义（Windows 需要特权） |

**UI 表达**：本地终端首次启动时在横幅里显示当前 shell 类型与「能力说明」链接；用户尝试运行不支持的命令时给出具体建议（「`make` 需要完整 POSIX 环境，建议使用 WSL 或安装 MSYS2 桥接」）。

## 2. LOC-001 · 本地终端

| 字段 | 值 |
|---|---|
| 优先级 | P0 · 兼容性 **C2** |
| 来源 | `F:terminal` `D:1.5` `D:2.2` |

**Shell 探测顺序**（Windows）

1. `pwsh.exe`（PowerShell 7+）
2. `powershell.exe`（Windows PowerShell 5.1）
3. `cmd.exe`
4. `wsl.exe`（若存在且已安装发行版）
5. `bash.exe`（Git Bash）

**行为规格**

1. 启动时显示横幅：shell 类型、版本、当前目录、`PATH` 是否包含 Windows PATH、能力提示。
2. 工作目录：默认用户主目录；可配「上次目录」或固定目录。
3. 环境变量：继承系统环境 + 注入 `TERM=xterm-256color`、`COLORTERM=truecolor`、`WT_SESSION=<id>`。
4. Windows PATH 合并：默认**不合并**（保持 shell 自身语义）；提供开关（MobaXterm 的「Use Windows PATH」等价物），开启后追加系统 PATH。
5. 多个本地终端标签互相独立（各自一个 PTY 进程）。
6. 支持在本地终端内直接运行 Windows 程序（`ipconfig`、`notepad`），因为 shell 本身就是 Windows 进程。

**验收标准**

- [ ] AC-1 在 Windows 上首次启动自动选中 `pwsh`（若存在），横幅显示版本
- [ ] AC-2 在本地终端运行 `ipconfig /all` 输出正常
- [ ] AC-3 开启「追加 Windows PATH」后，在 WindShell 中能直接运行 `git`
- [ ] AC-4 关闭该开关后，WindShell 中 `git` 不可用并提示如何开启

## 3. WindShell 规格

### 3.1 定位

一个**够用的 POSIX 风格 shell**，用于本地文件操作与工具编排。不是 bash 的替代品，不追求 100% 兼容。

### 3.2 语法支持

| 特性 | 支持 | 说明 |
|---|---|---|
| 管道 `\|` | ✅ | 任意长度 |
| 重定向 `>` `>>` `<` `2>` `2>&1` `&>` | ✅ | |
| 命令分隔 `;` `&&` `\|\|` | ✅ | |
| 通配 `*` `?` `[...]` `**` | ✅ | 由 shell 展开（Windows 程序不自己展开） |
| 变量 `$VAR` `${VAR}` `$?` `$#` `$@` | ✅ | |
| 命令替换 `$(...)` 与反引号 | ✅ | |
| 引号 `"..."` `'...'` 与转义 `\` | ✅ | |
| 环境变量赋值前缀 `FOO=bar cmd` | ✅ | |
| `~` 展开 | ✅ | |
| 花括号展开 `{a,b}` `{1..5}` | ✅ | |
| Here-doc `<<EOF` | ✅ | 常用场景（写配置文件） |
| 子 shell `( ... )` | ⚠️ 部分 | 支持，但共享同一进程 |
| 后台 `&` | ⚠️ 简化 | 支持启动后台进程，`jobs`/`fg`/`bg` 为简化实现 |
| 函数定义 | ❌ | 用脚本文件替代 |
| 数组 | ❌ | |
| `set -e` / `trap` | ❌ | 脚本中用 `&&` 链替代 |

**不支持的语法**必须给出明确错误：「WindShell 不支持函数定义，请写成脚本文件后执行」。

### 3.3 内建命令

| 命令 | 说明 |
|---|---|
| `cd` `pwd` | 支持 `/drives/c`、`//host/share`、Windows 路径混用 |
| `export` `unset` `set` `env` | |
| `alias` `unalias` | |
| `source` / `.` | 执行脚本文件 |
| `exit` `return` | |
| `echo` `printf` | 支持 `-e` 转义 |
| `test` / `[` | 常用判断（`-f` `-d` `-e` `-z` `-n` `=` `!=` `-eq` 等） |
| `history` | 本地历史 |
| `jobs` `fg` `bg` `kill` | 简化作业控制 |
| `which` `type` | |
| `wt` | 调用 WindTerm 自身的子命令（见 §7） |

**外部命令**：`PATH` 中的任意可执行文件（`.exe`/`.cmd`/`.bat`/`.ps1` 通过相应解释器）。内置工具集（`uutils`）以单个多调用二进制 `wt-coreutils.exe` 提供，通过硬链接/包装暴露为 `ls.exe`、`grep.exe` 等。

### 3.4 提示符

默认：`\u@\h:\w$ `（用户名@主机:当前目录）。可配：
- 显示 git 分支（检测 `.git` 目录，读取 `HEAD`，不调用 git 命令）
- 显示上条命令退出码（非 0 时）
- 显示时间
- 配色（与终端主题联动）

### 3.5 行编辑

| 键 | 行为 |
|---|---|
| `←` `→` `Home` `End` | 移动 |
| `Ctrl+A` / `Ctrl+E` | 行首/行尾 |
| `Alt+B` / `Alt+F` | 按词移动 |
| `Ctrl+U` / `Ctrl+K` / `Ctrl+W` | 删至行首/行尾/删词 |
| `↑` `↓` | 历史 |
| `Ctrl+R` | 反向增量搜索历史 |
| `Tab` | 补全（命令名 / 路径 / 内建选项） |
| `Ctrl+C` | 中断当前行/进程 |
| `Ctrl+D` | EOF（空行时退出） |
| `Ctrl+L` | 清屏 |

### 3.6 补全

| 位置 | 候选 |
|---|---|
| 命令名 | `PATH` 中的可执行文件 + 内建命令 + 别名 |
| 路径 | 当前目录（含 `/drives`、`//host`） |
| 变量 | 已定义环境变量 |
| `wt` 子命令 | 子命令与选项 |

补全菜单：`Tab` 补全唯一项；多项时列出并高亮，再按 `Tab` 循环。

**验收标准**

- [ ] AC-1 `ls /drives/c/Windows \| grep -i win \| head -5` 正确执行
- [ ] AC-2 `FOO=bar env \| grep FOO` 输出 `FOO=bar`
- [ ] AC-3 `for` 循环不支持时给出明确错误（不静默失败）
- [ ] AC-4 `cd //server/share` 能进入网络共享（有权限时）
- [ ] AC-5 输入 `git comm<Tab>` 补全为 `git commit`（若系统有 git 且已配置补全）→ 或提示无补全规则

## 4. 虚拟路径命名空间

### 4.1 LOC-002 · `/drives`

| 路径 | 映射 |
|---|---|
| `/drives/c` | `C:\` |
| `/drives/d` | `D:\` |
| `/drives/` | 列出所有盘符 |

**约束**：只在 WindShell 与我们的工具（编辑器、文件浏览器、`wt` 子命令）中有效。**PowerShell/cmd 不识别**——UI 与文档必须明确说明，避免用户在其他 shell 里困惑。

**双向转换**：任何接受路径的 `wt` 子命令都同时接受两种形式。

### 4.2 LOC-004 · `//host/share`

UNC 路径的 POSIX 风格表达：`//server/share/path` → `\\server\share\path`。WindShell 内支持；网络发现（`//`）列出当前域/工作组可见的机器（调用 `NetServerEnum`，慢，需异步）。

### 4.3 LOC-003 · `/registry`

**不做**（`spec/03` §7）。替代：`wt reg` 子命令 + GUI 查看器。

## 5. LOC-005 / LOC-006 · 路径与打开

### `open`（LOC-005）

```
open <path|url>
```

- 文件 → 系统默认程序
- 目录 → 系统文件管理器
- URL → 系统浏览器
- 远端路径（`user@host:/path`）→ 下载到临时区后打开（只读，改动不写回；写回请用编辑器）

### `wt path`（LOC-006）

```
wt path --to-windows /drives/c/temp          → C:\temp
wt path --to-posix   C:\temp                 → /drives/c/temp
wt path --list-drives                         → JSON
wt path --system                              → 输出 Windows/System/Desktop/Profiles 等路径（JSON）
```

替代 MobaXterm 的 `cygpath`。

## 6. 内置工具集

### 6.1 LOC-008 · coreutils

| 项 | 要求 |
|---|---|
| 来源 | `uutils/coreutils`（MIT），编译为多调用二进制 |
| 分发 | 随主包，放在 `resources/coreutils/`，通过包装脚本或硬链接暴露 |
| 覆盖 | `ls cat cp mv rm mkdir rmdir ln chmod chown touch stat head tail wc sort uniq cut tr paste split join comm diff md5sum sha256sum basename dirname realpath readlink echo printf true false yes seq sleep date env printenv id whoami uname du df find xargs` |
| 不含 | `grep`/`sed`/`awk`（见下） |

**grep / sed / awk**：`uutils` 不含这三个。方案：

| 工具 | 方案 |
|---|---|
| `grep` | 自研（Rust `regex` crate），支持 `-i -v -r -l -n -E -F -c -A -B -C` |
| `sed` | 自研，支持 `s///g`、`d`、`p`、`-n`、`-i`、地址范围 |
| `awk` | **不自研**。检测系统是否有 `gawk`/`awk`；没有则提示「awk 需要完整 POSIX 环境，建议用 WSL 或安装 MSYS2 桥接」 |

> 诚实优先：一个残缺的 awk 会让脚本以难以理解的方式失败，比明确说「不支持」更糟。

### 6.2 LOC-009 · `wt ssh` / `wt scp` / `wt sftp`

复用我们的协议栈与凭据保险库，让脚本可以：

```bash
wt ssh prod-web-01 -- "systemctl status nginx"
wt scp ./dist.tar.gz prod-web-01:/tmp/
wt sftp prod-web-01 --get /var/log/app.log
```

- 认证走保险库（无密码提示，适合 CI/脚本）。
- `--json` 输出结构化结果。
- 退出码语义：`0` 成功、`1` 通用失败、`2` 认证失败、`3` 连接失败、`4` 命令返回非 0（透传远端退出码时用 `--propagate-exit`）。

### 6.3 LOC-010 / LOC-011 / LOC-012 / LOC-013 · rsync / git / vim / 脚本运行时

| 需求 | 决策 |
|---|---|
| `LOC-010` rsync | 不捆绑。`wt sync`（SFTP 增量）替代，见 `FIL-016` |
| `LOC-011` git | 不捆绑。检测系统 git；未安装时提示下载 PortableGit |
| `LOC-012` vim | 不捆绑。内嵌编辑器支持 vi 键位模式；远端 vim 通过 SSH 正常使用 |
| `LOC-013` Python/Node/Perl/Ruby | 不捆绑。`wt exec` 调用系统已装运行时；插件脚本用 WASM（`EXT-005`） |
| `LOC-021` mathomatic | **不做**（`NO`）。与本产品场景无关，属 MobaXterm 的历史遗留捆绑。用户可用 Python/`bc` |
| `LOC-022` fdupes | **不做**（`NO`）。与远程运维无关，用系统工具即可 |

**理由**：这些运行时每个都是几十到几百 MB，且版本更新频繁。捆绑等于把「版本管理」这个无底洞搬进我们的发布流程。用户的机器上通常已经有它们。

## 7. LOC-023 · `wt` CLI 总览

`wt` 是 WindTerm 的命令行入口，覆盖 UI 的全部能力（这是 `spec/01` §2.4 支点二）。

### 7.1 命令结构

```
wt <group> <action> [options]

group:
  connect     连接会话
  session     会话 CRUD
  tunnel      隧道管理
  exec        在会话上执行命令
  ssh/scp/sftp  协议客户端
  files       文件操作
  sync        同步
  edit/view   打开编辑器/查看器
  pkg         包管理
  macro       宏
  key         密钥
  config      配置
  diag        诊断
  bench       性能基准
  doctor      环境自检
```

### 7.2 常用命令

```bash
wt connect prod-web-01                    # 打开 UI 并连接
wt connect prod-web-01 --headless --exec "uptime"   # 无 UI 执行
wt session list --json
wt session add --name web-02 --host 10.0.1.12 --user deploy --key k1
wt tunnel up test-db
wt tunnel list --json
wt exec prod-web-01 -- "df -h"
wt diag prod-web-01 --json
wt bench startup --runs 30
wt doctor
```

### 7.3 全局选项

| 选项 | 说明 |
|---|---|
| `--config-dir <path>` | 配置目录 |
| `--portable` | 便携模式 |
| `--profile <name>` | 多套配置切换 |
| `--json` | 结构化输出（所有命令必须支持） |
| `--quiet` / `--verbose` | 日志级别 |
| `--no-color` | 禁用颜色 |
| `--log <path>` | 写调试日志 |

### 7.4 与 MobaXterm 命令行开关的对照

| MobaXterm | WindTerm 等价 | 说明 |
|---|---|---|
| `<script_file>` | `wt shell --script <file>` | 启动时执行脚本 |
| `-exec "<cmd>"` | `wt exec --local "<cmd>"` | |
| `-newtab ["<cmd>"]` | `wt new-tab ["<cmd>"]` | 单实例下在已有窗口开新标签 |
| `-bookmark "<name>"` | `wt connect <name-or-id>` | 支持子文件夹（MobaXterm 只支持一级） |
| `-runmacro "<name>"` | `wt macro run <name>` | |
| `-openfolder "<name>"` | `wt session open-folder <name>` | |
| `-hideterm` | `wt --minimized` | |
| `-exitwhendone` | `wt ... --exit-when-done` | |
| `-i "<ini>"` | `--config-dir <dir>` | 我们不用 ini，用目录 |
| `-log` | `--log <path>` | |
| `-installshellext` | `wt shell-ext install` | |
| `-installprotohandler` | `wt protocol install` | |
| `-config` | `wt settings` | |
| `-shortcuts` | `wt settings --page shortcuts` | |
| `-doc` | `wt doc` | 打开本地文档 |
| `-picview` | `wt view <file>` | |
| `-edit "<file>"` | `wt edit <file>` | |
| `-compfiles "<a>" "<b>"` | `wt diff <a> <b>` | |
| `-compfolders` | `wt diff --folders <a> <b>` | |
| `-noX` | **不需要** | X11 已移除（ADR-0012），无 X Server 可禁用 |
| `-dpi 120` | `--dpi 120` | |
| `-justunpack` | **不需要** | 我们不用「解压到 TEMP」模式，见 `spec/12` §8.8 |

> 迁移建议：提供 `wt migrate-cli` 子命令，把 MobaXterm 的命令行写法自动转换为我们的写法，输出到剪贴板（用于替换脚本里的调用）。

## 8. LOC-014 · SSH 密钥生成器

| 字段 | 值 |
|---|---|
| 优先级 | P0 · 兼容性 C1 |
| 来源 | `D:6.3.2` `D:4.1`（MobaKeyGen） |

**生成**

| 项 | 选项 |
|---|---|
| 算法 | Ed25519（默认）/ ECDSA（256/384/521）/ RSA（2048/3072/4096）/ DSA（仅导入，不生成） |
| 注释 | 默认 `user@host-date` |
| 口令 | 可选；强度提示；支持空口令但警告 |
| 保存 | 私钥保存到保险库（推荐）或文件；公钥可复制/保存 |

**导入**

- 格式：OpenSSH（新格式 `-----BEGIN OPENSSH PRIVATE KEY-----`）、PEM（PKCS#1/PKCS#8）、PuTTY `.ppk`（v2/v3）、RFC 4716（`---- BEGIN SSH2 PUBLIC KEY ----`）。
- 导入后显示：算法、位数、指纹（SHA256 + MD5）、注释、是否加密。
- 口令保护的私钥：提示输入口令并可「记住到保险库」。

**导出**

- OpenSSH 私钥、公钥（`authorized_keys` 格式）、PuTTY `.ppk`。
- **不提供**导出为无口令私钥的「一键操作」，需显式确认并警告。

**其他**

- 显示公钥指纹并支持复制（用于比对服务器端 `known_hosts`）。
- 生成后提供「安装到服务器」向导：通过 SSH 连接，把公钥追加到 `~/.ssh/authorized_keys`（处理权限与目录创建）。

## 9. LOC-015 ~ LOC-020 · 系统工具

| 需求 | 命令 | 说明 |
|---|---|---|
| `LOC-015` | `wt sysinfo [--json]` | OS/内核/CPU/内存/磁盘/网卡/已装字体/运行时长 |
| `LOC-016` | `wt ps` / `wt kill <pid>` | 进程树、CPU/内存、命令行；按端口反查进程 |
| `LOC-017` | `wt reg ls/get/set` | 注册表操作（Windows 专用）；写操作需确认 |
| `LOC-018` | `wt shortcut create --session <id>` | 创建桌面快捷方式 |
| `LOC-019` | `wt edit <file\|user@host:/path>` | 打开编辑器 |
| `LOC-020` | `wt view <file\|url\|user@host:/path>` | 打开图片查看器 |

## 10. 验收汇总

| 需求 | 关键 AC | 归属 |
|---|---|---|
| `LOC-001` | AC-1~4 | §2 |
| WindShell | AC-1~5 | §3.6 |
| `LOC-002` | `/drives/c` 与 `C:\` 互转正确，含中文路径 | §4.1 |
| `LOC-005` | `open` 打开文件/目录/URL 三类 | §5 |
| `LOC-008` | 40 个 coreutils 命令各有一条冒烟用例通过 | §6.1 |
| `LOC-014` | 生成 Ed25519/RSA/ECDSA 三种密钥，可被 OpenSSH 接受 | §8 |
| `LOC-023` | `--json` 在全部子命令上可用 | §7 |

## 11. 设计映射

| 需求 | 设计文档 |
|---|---|
| `LOC-001` Shell 探测与 PTY | `design/11` §2 |
| WindShell | `design/11` §3（词法/语法/执行器） |
| `LOC-002`~`LOC-004` 路径命名空间 | `design/11` §4 |
| `LOC-008` 工具集 | `design/11` §5 |
| `LOC-014` 密钥 | `design/09` §5 |
| `LOC-023` CLI | `design/11` §7、`design/02` §7 |
