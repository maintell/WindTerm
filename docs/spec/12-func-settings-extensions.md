# 12 · 功能规格 · 设置、个性化与扩展

承接需求：`SET-001`~`SET-015`、`EXT-001`~`EXT-008`、`SYS-001`~`SYS-013`

## 1. 设置模型

### 1.1 三层继承

```
默认值（编译进程序）
   ▲ 被覆盖
用户设置（config.toml）
   ▲ 被覆盖
会话设置（数据库中的 session.settings）
```

**规则**

1. 任何设置项都可以被上层覆盖；UI 必须标出「此项已被会话覆盖」并提供「恢复为全局」。
2. 企业策略（`SEC-009`）是**第四层且不可被覆盖**——它在最外层，优先级最高。
3. 解析顺序：`策略 > 会话 > 用户 > 默认`。

### 1.2 SET-001 · 设置分组

| 分组 | 内容 |
|---|---|
| 常规 | 语言、启动行为、关闭行为、托盘、默认 shell、更新 |
| 外观 | 主题、字号、密度、侧栏、标签栏、紧凑模式 |
| 终端 | 字体、配色、编码、回滚、光标、响铃、日志、高亮 |
| 文件 | 默认编辑器、传输并发、冲突策略、临时目录、校验 |
| 图形 | RDP 默认值、VNC 默认值、图形会话截图 |
| 网络 | 代理、keepalive、超时、隧道默认值 |
| 安全 | 主密码、保险库、自动锁定、主机密钥、策略、审计 |
| 扩展 | 插件、仓库、权限 |
| 高级 | 配置文件路径、日志级别、实验特性、重置 |

**每项设置的 UI 必须包含**：名称、当前值、默认值、一句话说明、生效范围（全局/会话）、是否需要重启。

### 1.3 SET-002 · 设置搜索

- 顶部搜索框，输入即过滤（匹配名称、说明、关键词别名）。
- 命中项高亮；显示所在分组路径。
- 支持「跳转到该项」（滚动并聚焦）。
- 支持英文关键词搜中文界面（别名表）。

### 1.4 SET-005 · 会话级覆盖

- 会话编辑器的「终端」页提供「跟随全局 / 自定义」开关。
- 自定义时展开可覆盖项：字体、字号、编码、回滚行数、光标样式、响铃、日志、高亮规则集、粘贴行为、Backspace。
- 会话详情页显示「3 项已覆盖全局设置」并可一键查看/恢复。

## 2. 配置存储

### 2.1 SET-006 · 存储位置与格式

| 数据 | 格式 | 位置 |
|---|---|---|
| 用户设置 | TOML | `<config-dir>/config.toml` |
| 会话、文件夹、隧道、宏、标签 | SQLite | `<config-dir>/data.db` |
| 凭据 | 加密二进制 | `<config-dir>/vault.bin` |
| 主机密钥 | OpenSSH 格式文本 | `<config-dir>/known_hosts` |
| 审计日志 | JSONL | `<config-dir>/audit/` |
| 日志 | 文本 | `<config-dir>/logs/` |
| 插件 | 目录 | `<config-dir>/plugins/` |
| 缓存（缩略图、临时下载） | 文件 | `<cache-dir>/` |

**默认 `config-dir`**

| 平台 | 路径 |
|---|---|
| Windows | `%APPDATA%\WindTerm` |
| macOS | `~/Library/Application Support/WindTerm` |
| Linux | `$XDG_CONFIG_HOME/windterm`（默认 `~/.config/windterm`） |

**为什么设置用 TOML 而不是数据库**：设置需要人能读、能 diff、能进 Git、能被企业配置管理系统下发。会话需要事务与查询，所以用 SQLite。二者分离是刻意的。

**为什么不用 INI**：MobaXterm 的 INI 无法表达嵌套结构，导致它用 `[Bookmarks_1]`、`[Bookmarks_2]` 这种平铺编号，解析器极易出错（我们也必须为此写兼容层）。新格式不重复这个错误。

### 2.2 config.toml 结构示例

```toml
[general]
language = "zh-CN"
startup = "restore"          # restore | empty | workspace:<id>
closeAction = "tray"         # tray | quit | ask
checkUpdates = true

[terminal]
fontFamily = ["JetBrains Mono", "Consolas", "monospace"]
fontSize = 13
lineHeight = 1.2
scrollback = 10000
charset = "utf-8"
cursorStyle = "block"        # block | bar | underline
bell = "visual"              # visual | none | sound | notify

[terminal.paste]
warnMultiLine = true
rightClickPaste = false
bracketedPaste = true

[appearance]
theme = "system"             # light | dark | system
density = "normal"           # compact | normal | comfortable
sidebarWidth = 260

[files]
defaultEditor = "builtin"
transferConcurrency = 4
conflictPolicy = "ask"

[graphics]
rdpDefaultColorDepth = 32
rdpDefaultEgfx = true
vncDefaultScale = "fit"
captureFormat = "png"        # png | jpeg

[network]
keepaliveSeconds = 30
connectTimeoutSeconds = 10

[advanced]
logLevel = "info"
experimental = []
```

### 2.3 SET-007 · 便携模式

- 触发：`--portable` 或存在标记文件 `<exe-dir>/portable.marker`。
- 行为：所有数据落在 `<exe-dir>/data/`；不写注册表、不写 `%APPDATA%`、不写系统临时目录（用 `data/tmp`）。
- 托盘、开机自启、协议处理等系统集成项在便携模式下禁用并说明。
- 可随时「转换为安装模式」（导出数据到标准位置）。

### 2.4 SET-008 · 共享 / 漫游配置

| 场景 | 机制 |
|---|---|
| 团队共享会话 | `SES-019` 的共享会话（只读节点） |
| 企业统一下发设置 | 系统级 `config.toml`（`%PROGRAMDATA%` / `/etc`），用户设置覆盖其上 |
| 个人多机同步 | 把 `config-dir` 指向同步盘（OneDrive/Dropbox）；需提示「不要同步 `vault.bin` 到不可信位置」 |

**冲突处理**：多机同时修改 `config.toml` 时，以文件 mtime 较新者为准，并把旧版本另存为 `config.toml.conflict-<ts>`，启动时提示「检测到配置冲突，已保留两份」。

### 2.5 SET-014 · 导入导出与重置

- 导出：`config.toml` + 会话（不含凭据）+ 宏 + 隧道 → 单个 JSON。
- 导入：合并或覆盖；冲突项列出让用户选择。
- 重置：按分组重置 / 全部重置（需输入 `RESET` 确认）。
- 「恢复出厂」不清除会话与保险库（分离关注点）。

## 3. 外观与交互

### 3.1 SET-003 · 主题与配色

| 层 | 内容 |
|---|---|
| UI 主题 | 浅色 / 深色 / 跟随系统；自定义（JSON） |
| 终端配色 | 独立于 UI 主题（`TER-005`） |
| 图标 | 内置一套；可选「简洁」与「彩色」 |

**跟随系统**：监听 OS 主题变化事件，实时切换（不重启）。

### 3.1b SYS-011 · 深色模式跟随系统

| 平台 | 机制 |
|---|---|
| Windows 10 1809+ | `HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize\AppsUseLightTheme` 变化通知（`RegNotifyChangeKeyValue`） |
| macOS | `NSApp.effectiveAppearance` 的 KVO |
| Linux | `org.freedesktop.portal.Settings` 的 `color-scheme` |

**行为规格**

1. 主题设为 `跟随系统` 时，OS 切换深浅色 → 应用在 ≤ 500 ms 内完成切换。
2. **切换不重载界面**：不重建终端、不丢失滚动缓冲、不打断连接。
3. 终端配色若设为「跟随 UI 主题」，同步切换；若指定了固定配色方案，保持不变（用户明确选了 Solarized Dark 就不要动）。
4. 切换时若正在拖动窗口/分屏，去抖 200 ms 后再应用，避免闪烁。

**验收标准**

- [ ] AC-1 在 OS 设置里切换深浅色，应用 UI 与终端背景同步变化，终端内容与滚动位置不变
- [ ] AC-2 终端指定了固定配色时，OS 切换不影响终端
- [ ] AC-3 三平台各验证一次（Windows / macOS / GNOME）

**导入**：iTerm2 `.itermcolors`、Windows Terminal schemes、VS Code 主题（仅取色，不取 UI 结构）。

### 3.2 SET-004 · 快捷键编辑器

```
┌──────────────────────────────────────────────────┐
│ 搜索 [____________]        作用域 [全局 ▾]         │
├──────────────────────────────────────────────────┤
│ 新建本地终端        Ctrl+Alt+T      [编辑] [清除]  │
│ 关闭当前标签        Ctrl+Alt+Q      [编辑] [清除]  │
│ 命令面板            Ctrl+Shift+P    [编辑] [清除]  │
│ 连接诊断            Ctrl+Shift+I    [编辑] [清除]  │
├──────────────────────────────────────────────────┤
│ ⚠ 冲突：Ctrl+Shift+P 同时绑定到「命令面板」与      │
│   「打印」（已禁用）                               │
│ [ 恢复默认 ]  [ 导出 ]  [ 导入 ]                   │
└──────────────────────────────────────────────────┘
```

**规则**

1. 录制模式：按下组合键即捕获；`Esc` 取消。
2. 冲突检测：实时提示，保存时阻止（或允许但标记）。
3. 保留键：不允许绑定 `Ctrl+C`（终端中断）、`Ctrl+D`、`Ctrl+Z`、`Ctrl+\`，除非用户显式确认。
4. 作用域：全局 / 仅终端 / 仅图形会话 / 仅文件视图。
5. 导入导出：JSON。

### 3.3 SET-009 · DPI 缩放

- 默认跟随系统（Windows 每显示器 DPI、macOS Retina、Linux Xft.dpi）。
- 手动覆盖 80%~250%。
- 终端字号与 UI 缩放**独立**：改 UI 缩放不应改变终端字符大小（这是常见的设计错误）。
- 多显示器 DPI 不同时，窗口跨屏要正确重算。

### 3.4 SET-010 · 紧凑模式

- 隐藏菜单栏、工具栏、侧栏、状态栏，只留标签栏（可再隐藏）。
- `Ctrl+Shift+F11` 切换；`Esc` 退出全屏但不退出紧凑模式。
- 紧凑模式下仍可通过标签栏右侧的「⋮」按钮访问全部菜单。

### 3.5 SET-011 · 工作区

- 保存：打开的会话列表、标签顺序、分屏布局、窗口位置与大小、侧栏状态。
- 恢复：一键恢复；启动时可配「恢复上次工作区」。
- 多工作区：命名保存（「生产巡检」「开发环境」），可绑定快捷键。

### 3.6 SET-015 · 字体管理

- 枚举系统等宽字体（按 `fontconfig` / `DirectWrite` / `CoreText` 判断是否等宽）。
- 预览（用当前配色渲染一段含 CJK 与符号的样例）。
- 缺失字体检测：配置里引用的字体不存在时，回退并提示。
- 内置 `JetBrains Mono`（OFL）作为兜底，保证三平台视觉一致。

### 3.7 SET-016 / SET-017 · 明确不做的两项设置

这两项在 MobaXterm 里存在，但我们决定不做。记录在此以免「没实现」被误认为「漏了」。

#### SET-016 · 屏保与内置游戏（`NO`）

MobaXterm 内置企鹅屏保与若干小游戏，Pro 版允许关闭。

| 项 | 决策 |
|---|---|
| 屏保 | 不提供 |
| 游戏菜单 | 不提供 |
| 理由 | 企业环境下这类内容会被安全/合规直接否掉；与「运维工作台」定位无关；维护成本（渲染、计时、输入）与收益完全不成比例 |

**不做「可关闭」的中间态**：如果功能存在但默认关闭，安全审计仍会把它列为「攻击面/合规风险」。从一开始就不存在是更干净的答案。

#### SET-017 · 无闪烁主窗口（`ALT`，P3）

MobaXterm 的 `Display` 设置页只有一个选项：「Flicker-free main window」，用于消除调整窗口大小、悬停按钮时的重绘闪烁，并提示「会降低界面速度」。

| 项 | 决策 |
|---|---|
| 是否提供该开关 | **不提供** |
| 原因 | 这是 Win32 GDI 时代的典型问题（未处理 `WM_ERASEBKGND`、逐控件重绘）。WebView 的内容由合成器统一上屏，天然双缓冲，不存在同类闪烁 |
| 我们的对应做法 | ① 遵循系统「减少动画」偏好（`prefers-reduced-motion`）；② 对高频变动的元素（终端容器、进度条）用 `will-change: transform` 与 `contain: strict` 避免重排；③ 分屏拖拽时用 `transform` 而非改 `width`，避免每帧布局 |
| 若真出现闪烁 | 视为缺陷修复（`NFR-021` 性能面板可观测帧率与重排次数），而不是加一个开关让用户自己关 |

**这条体现一个原则**：**能用实现解决的质量问题，不要变成用户设置。** 设置项是给「无法两全的取舍」用的，不是给「我们没做好」用的。
## 4. 国际化

### 4.1 SET-012 · 语言

| 项 | 要求 |
|---|---|
| 语言 | zh-CN（默认，按系统语言自动选）、en-US |
| 切换 | 立即生效，无需重启 |
| 覆盖 | 100% 界面字符串；错误消息；安装包 |
| 不翻译 | 协议名、算法名、字段名、日志原文、命令输出 |
| 复数/性别 | 用 ICU MessageFormat 处理 |
| 日期/数字 | 按 locale 格式化 |
| RTL | 暂不支持（记录为 P3） |

**实现约束**：所有用户可见字符串必须走 i18n 函数，禁止硬编码。CI 检查：源码中出现中文字符串字面量（除注释与测试）即失败。

## 5. SET-013 · MobaXterm 设置导入

与 `SES-020` 同一入口，额外导入：

| 类别 | 映射 |
|---|---|
| 终端字体/字号 | `terminal.fontFamily` / `fontSize` |
| 配色方案 | 尽量匹配内置方案；无法匹配时按颜色值生成自定义方案 |
| 字符集 | `terminal.charset` |
| Backspace 行为 | `terminal.backspace` |
| 右键粘贴 | `terminal.paste.rightClickPaste` |
| 多行粘贴告警 | `terminal.paste.warnMultiLine` |
| 回滚行数 | `terminal.scrollback` |
| 快捷键 | 映射到我们的动作；无法映射的列在报告中 |
| ~~X11 选项~~ | **已移除**（ADR-0012），导入时忽略并记入报告 |
| 日志目录 | `terminal.logging.directory` |
| 持久化 home | 记录为「本地终端默认目录」 |

**报告**：逐项列出「已导入 / 已映射为 X / 不支持」，不支持项说明原因。

## 6. 插件体系

### 6.1 EXT-001 · 插件包格式

**文件**：`<name>-<version>.wtpkg`（本质是 zip，扩展名区分）。

**结构**

```
manifest.json
payload/
  bin/            # 可执行文件
  lib/            # 动态库
  share/          # 数据文件
  scripts/        # WASM 脚本
signature.ed25519 # 对 manifest.json 的签名
```

**manifest.json**

```json
{
  "name": "acme-tools",
  "displayName": "ACME 运维工具集",
  "version": "1.2.0",
  "publisher": "ACME-IT",
  "description": "内部巡检脚本与命令",
  "license": "Apache-2.0",
  "homepage": "https://intranet.acme/tools",
  "windterm": { "minVersion": "1.0.0", "maxVersion": "2.0.0" },
  "platforms": ["windows-x64", "linux-x64", "macos-arm64"],
  "provides": {
    "commands": [
      { "name": "acme-check", "path": "bin/acme-check.exe", "description": "巡检" }
    ],
    "scripts": [
      { "name": "on-connect", "hook": "session.connected", "path": "scripts/on-connect.wasm" }
    ],
    "themes": [
      { "name": "ACME Dark", "path": "share/themes/acme-dark.json" }
    ]
  },
  "permissions": ["process:spawn", "fs:read:config", "net:outbound"],
  "checksums": { "payload/bin/acme-check.exe": "sha256:..." }
}
```

**兼容 `.mxt3`**：导入旧插件时，把 `bin/` 下的可执行文件提取到 `plugins/<name>/bin/` 并生成最小 manifest（`permissions: ["process:spawn"]`），标注「旧格式，无签名，无权限声明」并要求用户确认。

### 6.2 EXT-002 · 包管理器

```
wt pkg search <keyword>
wt pkg info <name>
wt pkg install <name>[@version]
wt pkg list [--installed]
wt pkg update [<name>]
wt pkg remove <name>
wt pkg verify
```

**索引格式**（JSON，签名）

```json
{
  "v": 1,
  "generated": "2026-11-02T00:00:00Z",
  "publisher": "WindTerm Official",
  "packages": [
    {
      "name": "acme-tools",
      "version": "1.2.0",
      "platforms": ["windows-x64"],
      "size": 1048576,
      "sha256": "...",
      "url": "https://.../acme-tools-1.2.0.wtpkg",
      "permissions": ["process:spawn"]
    }
  ],
  "signature": "<ed25519 over packages>"
}
```

**源配置**

```toml
[[pkg.sources]]
name = "official"
url = "https://pkg.windterm.dev/index.json"
trustedKeys = ["<base64 ed25519 pubkey>"]

[[pkg.sources]]
name = "acme-internal"
url = "\\\\fileserver\\windterm\\index.json"
trustedKeys = ["<base64>"]
```

**行为**

1. 安装前展示：名称、版本、发布者、权限、大小、签名状态。未签名包需显式确认。
2. 安装到 `<config-dir>/plugins/<name>/`，原子（临时目录 → rename）。
3. 卸载保留用户数据（`plugins/<name>/userdata/`），除非勾选「同时删除」。
4. 更新检查可选；企业可锁定版本（`SEC-009` 的 `allowedPluginPublishers`）。
5. 离线安装：`wt pkg install ./acme-tools-1.2.0.wtpkg`。

### 6.3 EXT-003 · 仓库与签名

- 索引与包都用 ed25519 签名。
- 客户端内置官方公钥；企业可添加自己的公钥（通过策略文件下发）。
- 校验失败 → 拒绝安装，显示「签名无效，可能被篡改」。
- 支持「允许未签名」开关（默认关闭，需策略允许）。

### 6.4 EXT-004 · 权限与沙箱

| 权限 | 含义 | 首次使用时 |
|---|---|---|
| `fs:read:config` | 读配置目录 | 提示 |
| `fs:read:home` | 读用户主目录 | 提示 |
| `fs:write` | 写文件（需指定范围） | 提示 |
| `net:outbound` | 发起网络连接 | 提示 |
| `process:spawn` | 启动子进程 | **强提示**（这是最危险的） |
| `clipboard` | 读写剪贴板 | 提示 |
| `session:read` | 读取会话元数据（不含凭据） | 提示 |
| `terminal:read` | 读取终端输出 | **强提示** |
| `terminal:write` | 向终端写入 | **强提示** |

**限制**：进程类插件不是真正的沙箱（它就是你启动的进程）。UI 必须诚实说明：「此插件以你的身份运行程序，权限等同于你本人」。WASM 脚本插件才是沙箱化的。

### 6.5 EXT-005 · 脚本扩展（WASM）

**运行时**：`wasmtime`，无 WASI 文件系统/网络默认权限（按 manifest 授予）。

**钩子**

| 钩子 | 时机 | 可做的事 |
|---|---|---|
| `session.beforeConnect` | 连接前 | 修改连接参数、拒绝连接 |
| `session.connected` | 连接后 | 记录、发通知、执行命令 |
| `session.disconnected` | 断开后 | |
| `terminal.output` | 每批输出 | 匹配关键词、触发通知（不可修改输出） |
| `command.invoke` | 自定义命令 | 实现 `wt acme:check` 这类命令 |

**限制**：CPU 时间 ≤ 100 ms/次、内存 ≤ 16 MB、不可阻塞主流程（超时即终止并记录）。

### 6.6 EXT-006 · 主题插件

主题为 JSON（UI 颜色 token + 终端配色），打包进插件。安装后出现在主题列表，标注来源。

### 6.7 EXT-007 · 自定义传输协议

`P3`。接口不稳定，暂不开放。记录设计意图：允许插件注册新会话类型（SPICE、Serial over TCP 等）。

### 6.8 EXT-008 · 企业定制器

**MobaXterm 的 Customizer 做法**：把配置硬编码进 exe，生成定制副本。问题是不可审计（你不知道它改了什么）、不可撤销、每次升级要重新生成。

**我们的做法**：生成一个**定制包**，包含：

```
acme-windterm/
  config.toml            # 预置设置
  sessions.json          # 预置会话（不含凭据）
  policy.json            # 策略 + 签名
  policy.pub             # 策略公钥
  install.ps1 / install.sh
```

安装脚本把定制包放到系统级位置。升级应用时定制包不受影响。

**能力**

| 能力 | 实现 |
|---|---|
| 预置会话 | `sessions.json` 首次启动导入 |
| 预置设置 | 系统级 `config.toml` |
| 锁定策略 | 签名 `policy.json` |
| 自定义品牌 | 应用名、图标、关于页文案（需重新签名安装包） |
| 内网更新源 | `policy.updateSource` |
| 禁用功能 | 策略规则 |

## 7. 系统集成

### 7.1 SYS-001 / SYS-002 / SYS-012 · 托盘、热键、通知

**托盘**

- 图标状态：正常 / 有未读通知 / 有隧道运行。
- 菜单：显示主窗口、会话快捷列表（最近 10 个）、隧道状态、设置、退出。
- 关闭窗口行为可配：`最小化到托盘`（默认）/ `退出` / `询问`。
- 首次最小化到托盘时提示一次「WindTerm 仍在后台运行」。

**全局热键**

- 弹出终端（`TER-029`）、显示主窗口、快速连接。
- 注册失败时明确提示「热键 Ctrl+` 已被其他程序占用」，并提供「换一个」。

**系统通知**

- 触发：长任务完成（传输/命令）、连接断开、隧道异常、宏执行完成。
- 可分类开关；可设「免打扰时段」。

### 7.2 SYS-003 · URL 协议处理

```
windterm://connect?session=prod-web-01
windterm://connect?host=10.0.1.11&user=root&type=ssh
windterm://tunnel/up?name=test-db
```

**安全硬要求**：任何 `windterm://` 链接在打开前必须显示确认对话框，展示将要连接的**主机与用户**，用户确认后才执行。原因：网页可以构造恶意链接让用户连到攻击者的服务器并输入密码。

- 注册/注销由 `wt protocol install/uninstall` 完成。
- 企业策略可禁用该协议处理。

### 7.3 SYS-004 · 资源管理器集成

- 右键菜单项：「在此打开 WindTerm」（目录）/「用 WindTerm 编辑」（文件）。
- 安装/卸载：`wt shell-ext install/uninstall`。
- 只写 `HKCU`（不需要管理员）；不安装 shell 扩展 DLL（避免 Explorer 崩溃风险），只用注册表命令项。

### 7.4 SYS-005 · 单实例与命令行

- 默认单实例：第二次启动时把参数转交给已有实例（本地 socket / 命名管道），然后退出。
- `--new-instance` 强制多实例。
- 参数解析见 `spec/10` §7.4 的对照表。
- 参数错误时输出用法并以退出码 2 结束。

### 7.5 SYS-006 · 崩溃恢复

- 每 10 s 持久化「运行中会话快照」（会话 ID、标签顺序、分屏布局）。
- 异常退出后启动时提示：「上次有 5 个会话未正常关闭，是否恢复？」
- 恢复内容：会话与布局（**不恢复终端内容**——那需要持续落盘，代价过大且涉及敏感信息）。
- 崩溃时生成最小诊断包（不含凭据与终端内容），路径显示给用户，由用户决定是否上报。

### 7.6 SYS-007 · 自动更新

| 项 | 要求 |
|---|---|
| 检查 | 启动后延迟 30 s 检查一次，之后每 24 h；可关闭 |
| 清单 | 签名 JSON：版本、平台、URL、sha256、发布日期、更新说明 |
| 下载 | 后台下载到临时目录，校验 sha256 + 签名 |
| 安装 | 提示「重启以完成更新」；Windows 用独立 updater 进程替换文件 |
| 内网源 | 策略可指定 `updateSource` |
| 降级 | 不允许自动降级；手动可安装旧版本 |
| 离线 | 可手动下载安装包升级 |

### 7.7 SYS-008 · 多平台打包

| 平台 | 产物 | 说明 |
|---|---|---|
| Windows | `.msi`（每用户安装，无需管理员）+ `.zip`（便携） | 代码签名 |
| macOS | `.dmg`（universal2：arm64 + x86_64） | Developer ID 签名 + 公证 |
| Linux | `.AppImage` + `.deb` + `.rpm` | 提供 `.sig` |

**WebView 依赖**

| 平台 | 依赖 | 处理 |
|---|---|---|
| Windows | WebView2 Runtime | Win11 内置；Win10 检测并引导安装（Evergreen Bootstrapper） |
| macOS | WKWebView | 系统内置 |
| Linux | WebKitGTK 4.1 | 依赖声明；AppImage 内打包 |

### 7.8 SYS-013 · 无管理员权限运行

| 功能 | 需要管理员？ |
|---|---|
| SSH/SFTP/RDP/VNC/隧道 | 否 |
| 本地终端 | 否 |
| 安装（每用户） | 否 |
| 抓包 | 是（或安装 Npcap 时） |
| 全局热键 | 否 |
| 系统级策略文件 | 是（写入时） |
| 自动更新（替换程序文件） | 视安装位置 |

**MobaXterm 的 `-justunpack` 问题**：它把运行时解压到 `%TEMP%`，企业 GPO 禁止从 TEMP 执行程序时就会失败，需要 `-justunpack` 变通。我们的设计从根上避免：**安装版把全部运行时资源放在安装目录，不依赖 TEMP**；便携版放在程序目录。

## 8. 可访问性

### 8.1 SYS-009 · 键盘与屏幕阅读器

| 项 | 要求 |
|---|---|
| 全键盘可达 | 所有功能不依赖鼠标；焦点顺序合理；焦点可见（≥ 2px 描边） |
| 屏幕阅读器 | 终端内容可朗读（按行/按屏），提供「朗读模式」开关 |
| 语义化 | 按钮/列表/树有正确的 role 与 label |
| 快捷键提示 | 菜单项显示快捷键；命令面板显示快捷键 |
| 缩放 | UI 缩放 250% 时布局不破 |

### 8.2 SYS-010 · 高对比度与色觉友好

- 高对比主题（WCAG AAA 对比度）。
- 状态不只靠颜色：连接状态同时用图标（●/◐/○）与文字。
- 配色方案标注是否色盲友好（红绿色盲模拟检查）。
- 遵循系统「减少动画」设置。

## 9. 验收汇总

| 需求 | 关键 AC | 归属 |
|---|---|---|
| `SET-001` | 每个设置项有说明与生效范围 | §1.2 |
| `SET-004` | 冲突检测生效；保留键不可绑定（除非确认） | §3.2 |
| `SET-006` | 配置目录可由 `--config-dir` 改变；TOML 可手改并生效 | §2.1 |
| `SET-007` | 便携模式下不写 AppData/注册表（用 Process Monitor 验证） | §2.3 |
| `SET-012` | 中英切换立即生效；无硬编码字符串（CI 检查） | §4 |
| `SET-013` | 导入后终端字体/配色/快捷键与 MobaXterm 视觉一致 | §5 |
| `EXT-001` | `.wtpkg` 安装后命令可用；`.mxt3` 可导入并提示 | §6.1 |
| `EXT-003` | 篡改包的签名校验失败并拒绝 | §6.3 |
| `EXT-005` | WASM 钩子超时被终止，不影响主流程 | §6.5 |
| `SYS-003` | `windterm://` 链接必须确认后才连接 | §7.2 |
| `SYS-005` | 第二次启动把参数转交给已有实例 | §7.4 |
| `SYS-007` | 篡改更新包被拒绝；内网源可用 | §7.6 |
| `SYS-008` | 三平台产物均可安装并启动 | §7.7 |

## 10. 设计映射

| 需求 | 设计文档 |
|---|---|
| `SET-001`~`SET-006` 设置模型 | `design/04` §4 配置模型 |
| `SET-007`~`SET-008` 位置与共享 | `design/04` §5 路径解析 |
| `SET-009`~`SET-011` 外观 | `design/13` §3 布局、§7 主题 |
| `SET-012` i18n | `design/13` §8 |
| `SET-013` 导入 | `design/04` §6 迁移器 |
| `EXT-001`~`EXT-006` | `design/12` |
| `EXT-008` 定制器 | `design/12` §7 |
| `SYS-001`~`SYS-007` | `design/13` §9、`design/14` §6 |
| `SYS-008` 打包 | `design/14` §4 |
| `SYS-009`~`SYS-010` 可访问性 | `design/13` §10 |
