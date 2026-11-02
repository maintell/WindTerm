# 附录 C · 参考资料与事实来源

## 1. 事实来源的分级

本项目对「事实」的要求分三级，文档中必须能追溯到其中一级：

| 级别 | 含义 | 标记 |
|---|---|---|
| **A 一手规范** | RFC / 官方协议文档 / 官方产品页面 | 直接引用 URL |
| **B 官方实现** | 权威实现的源码或文档（OpenSSH、微软文档、crate 文档） | 引用仓库/文档路径 |
| **C 二手归纳** | 社区资料、博客、对比文章 | 标注「需复核」 |

**规则**：涉及协议行为、安全属性、许可条款的断言，必须是 A 或 B。C 级只能用于「行业现状」类描述，且必须标注需复核。

---

## 2. MobaXterm 官方页面（A 级）

抓取日期：**2026-11-02**。快照保存在仓库 `.research/` 目录。

| 页面 | URL | 用途 | 本地快照 |
|---|---|---|---|
| 特性清单 | <https://mobaxterm.mobatek.net/features.html> | 18 个特性块 → `spec/04` 的 `F:*` 出处 | `.research/mobaxterm-features.html` / `.txt` |
| 帮助文档 | <https://mobaxterm.mobatek.net/documentation.html> | 6 章配置项 → `spec/04` 的 `D:*` 出处 | `.research/mobaxterm-documentation.html` / `.txt` |
| 插件清单 | <https://mobaxterm.mobatek.net/plugins.html> | 40 个插件 → `spec/04` 的 `P:*` 出处 | `.research/mobaxterm-plugins.html` / `.txt` |
| 下载页 | <https://mobaxterm.mobatek.net/download.html> | 版本与分发形态（便携/安装） | `.research/mobaxterm-download.html` / `.txt` |

**再抓取方式**（快照过期时）：

```powershell
$pages = @{
  'mobaxterm-features'      = 'https://mobaxterm.mobatek.net/features.html'
  'mobaxterm-documentation' = 'https://mobaxterm.mobatek.net/documentation.html'
  'mobaxterm-plugins'       = 'https://mobaxterm.mobatek.net/plugins.html'
  'mobaxterm-download'      = 'https://mobaxterm.mobatek.net/download.html'
}
# 见 scripts/fetch-mobaxterm.ps1（待建，逻辑同首次抓取）
```

**注意**：MobaXterm 的免费版与专业版能力不同，且版本间会调整限制。`spec/04` 的对照以「官网列出的特性」为准，不承诺与某个具体版本的免费版额度一致。

---

## 3. 协议规范（A 级）

### 3.1 SSH

| 文档 | 内容 | 本项目用途 |
|---|---|---|
| RFC 4251 | SSH 协议架构 | 总体模型 |
| RFC 4252 | SSH 认证协议 | `SEC-002`/`SEC-004`/`SEC-016` |
| RFC 4253 | SSH 传输层协议 | 算法协商、`SES-001` |
| RFC 4254 | SSH 连接协议 | **`direct-tcpip`、`tcpip-forward`**（`SES-024`/`NET-001` 的规范依据）。`x11-req` 一节已不适用（X11 移除，ADR-0012） |
| RFC 4419 | `diffie-hellman-group-exchange` | 兼容旧服务端 |
| RFC 5656 | ECC 算法集成 | Ed25519/ECDSA |
| RFC 8308 | `server-sig-algs` 扩展 | 密钥类型协商 |
| RFC 8332 | `rsa-sha2-256/512` | RSA 签名升级 |
| RFC 8731 | `curve25519-sha256` | 默认 KEX |
| draft-ietf-secsh-filexfer-02 | SFTP v3 | `FIL-002` |
| OpenSSH `PROTOCOL` / `PROTOCOL.*` | `posix-rename`、`fsync`、`statvfs` 等扩展 | `FIL-002` |

> **关键提示**：RFC 4254 §7.2 定义 `direct-tcpip` 的字段语义，`design/10` §1 的跳板机实现直接对应这一节。

### 3.2 RDP

| 文档 | 内容 |
|---|---|
| MS-RDPBCGR | RDP 基础连接与图形（连接序列、能力协商、FastPath） |
| MS-RDPEGFX | 图形管线扩展（H.264/AVC444/RemoteFX Progressive） |
| MS-RDPECLIP | 剪贴板重定向（CLIPRDR） |
| MS-RDPEFS | 文件系统重定向（RDPDR） |
| MS-RDPELE | 授权 |
| MS-RDPEA | 音频重定向（RDPSND） |
| MS-RDPEDISP | 显示器控制（动态分辨率、多显示器） |
| MS-RDPEAR | 自动重连（ARC） |
| MS-CSSP | CredSSP（NLA） |
| MS-NLMP | NTLM |

> 微软的协议文档是公开的（Open Specifications）。实现时必须依据文档，**不得参考微软的私有实现**（`spec/01` §5.3）。

### 3.3 VNC / RFB

| 文档 | 内容 |
|---|---|
| RFC 6143 | The Remote Framebuffer Protocol（RFB 3.8） |
| RFB 3.3 / 3.7 规范 | 向后兼容（`GUI-028` 要求支持三个版本） |
| VeNCrypt 规范 | TLS 扩展与子类型 |
| TightVNC / TigerVNC 文档 | Tight/ZRLE 编码细节 |

### 3.4 X11（仅存档，本项目不实现）

X11 相关规范**不再是实现依据**（ADR-0012）。列出它们只为两点：
① 阅读 ADR-0002 与 `spec/04` §12.6 的历史记录时需要对照；
② 若未来重新评估 X11 支持，从这里起步。

| 文档 | 内容 |
|---|---|
| X Window System Protocol（X11R7） | 核心协议与 Setup 请求/响应格式（原 `design/08` §3.2 的依据，该节已随 X11 移除） |
| XDMCP 规范（X11R7 `xdmcp` 文档） | XDMCP 报文格式 |
| Xauthority 文件格式 | `~/.Xauthority` 二进制结构（`design/08` §2.2） |
| ICCCM / EWMH | 窗口管理约定（rootless 模式相关） |
| XTEST 扩展规范 | 输入注入（`GUI-009` 路径 C） |
| XIM 协议规范 | 输入法（`GUI-009` 路径 B） |

### 3.5 其他协议

| 文档 | 内容 | 用途 |
|---|---|---|
| RFC 854 | Telnet 协议 | `SES-002` |
| RFC 855 / 857 / 858 / 859 / 1073 / 1091 | Telnet 选项（ECHO/SUPPRESS-GO-AHEAD/NAWS/TERMINAL-TYPE/LINEMODE） | `SES-002` |
| RFC 959 | FTP | `SES-008` |
| RFC 4217 | FTP over TLS（FTPS） | `SES-008` |
| RFC 1928 | SOCKS5 | `NET-003` |
| RFC 1929 | SOCKS5 用户名密码认证 | `NET-003` |
| RFC 6238 | TOTP | `SEC-016` |
| RFC 9106 | Argon2 | `SEC-007` |
| draft-irtf-cfrg-xchacha | XChaCha20-Poly1305 | `SEC-007` |
| Mosh 协议（`mosh.proto`） | SSP 状态同步协议 | `SES-010` |

---

## 4. 权威实现与库（B 级）

### 4.1 本项目直接依赖

| 组件 | 仓库 / 文档 | 用途 | 许可 |
|---|---|---|---|
| `russh` | <https://github.com/Eugeny/russh> | SSH 协议栈 | Apache-2.0 |
| `IronRDP` | <https://github.com/Devolutions/IronRDP> | RDP | Apache-2.0 / MIT |
| `rusqlite` | <https://github.com/rusqlite/rusqlite> | SQLite 绑定 | MIT |
| `argon2` | <https://github.com/RustCrypto/password-hashes> | Argon2id | MIT/Apache-2.0 |
| `chacha20poly1305` | <https://github.com/RustCrypto/AEADs> | XChaCha20-Poly1305 | MIT/Apache-2.0 |
| `ssh-key` | <https://github.com/RustCrypto/SSH> | 私钥格式解析 | MIT/Apache-2.0 |
| `uutils/coreutils` | <https://github.com/uutils/coreutils> | 内置工具集 | MIT |
| `wasmtime` | <https://github.com/bytecodealliance/wasmtime> | WASM 运行时 | Apache-2.0 |
| Tauri 2 | <https://tauri.app/> | 应用框架 | MIT/Apache-2.0 |
| `@xterm/xterm` | <https://github.com/xtermjs/xterm.js> | 终端内核 | MIT |
| CodeMirror 6 | <https://codemirror.net/> | 编辑器 | MIT |
| SolidJS | <https://www.solidjs.com/> | 前端框架 | MIT |

**依赖升级时必须重新核对许可**（`design/14` §3 的 `deny.toml` 会拦住 GPL 类变更）。

### 4.2 行为参考（不直接依赖，但用于验证）

| 项目 | 用途 |
|---|---|
| OpenSSH 源码 | 验证算法列表、known_hosts 格式、`scp` 行为、`tcpip-forward` 实现 |
| PuTTY 源码 | 验证 PPK 格式、终端行为 |
| FreeRDP | 验证 RDP 能力协商与错误码 |
| TigerVNC | 验证 RFB 编码实现 |
| WezTerm / Alacritty | 参考终端渲染与性能优化 |
| Tabby / Electerm | 参考终端类应用的 UI 组织 |
| ~~X410 / Xming 文档~~ | 不再参考（X11 移除） |

---

## 5. 安全与工程实践（A/B 级）

| 主题 | 来源 |
|---|---|
| 密码存储建议 | OWASP Password Storage Cheat Sheet（Argon2id 参数下限） |
| SSH 加固 | Mozilla OpenSSH 指南、各发行版 `sshd_config` 默认值 |
| 供应链 | SLSA、CycloneDX 规范、`cargo-deny` / `cargo-audit` 文档 |
| 可访问性 | WCAG 2.1、WAI-ARIA Authoring Practices |
| 可复现构建 | `reproducible-builds.org` |

---

## 6. 竞品事实（C 级，需复核）

`spec/01` §2.2 的竞品对照表基于公开资料归纳，**实施前必须复核**。复核清单：

| 产品 | 需确认的点 |
|---|---|
| MobaXterm | 免费版限制的具体额度（会话数、隧道数、宏） |
| SecureCRT | 是否支持 X11 转发（**已不影响本项目**，X11 移除后此项对比作废） |
| Xshell + Xftp | 是否内置 X Server（**已不影响本项目**） |
| Tabby | 是否有 RDP 插件（生态变化快） |
| WindTerm (kingToolbox) | 是否已支持 RDP |
| Termius | 是否支持 SFTP 之外的图形能力 |
| Remmina | RDP/VNC 的完整度（原「X11 支持形态」一项作废） |
| mRemoteNG | 是否有 SFTP |
| Royal TS | 三平台覆盖的具体版本 |
| FinalShell | 是否支持图形转发 |

**复核方式**：查阅各产品官方文档的功能页，记录 URL 与日期，更新 `spec/01` §2.2。

---

## 7. 本文档的自我约束

| 约束 | 检查方式 |
|---|---|
| 每条协议断言可追溯到 A/B 级来源 | 人工评审 + 结构测试（要求协议章节含来源引用） |
| C 级来源必须标注「需复核」 | 结构测试：`spec/01` §2.2 表格必须含复核提示 |
| 引用的 URL 可访问 | `scripts/check-links.sh`（外部链接只告警不阻塞） |
| 抓取的快照可复现 | `.research/` 保留原始 HTML + 提取脚本 |
| 不引用未读过的文档 | 人工评审（这条只能靠人） |

**最后一条最重要**：本项目的规格大量依赖对 MobaXterm 行为的准确描述。如果引用了没读过的文档，整个覆盖矩阵就失去意义。
