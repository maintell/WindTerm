# 变更日志

本文件记录 WindTerm 每个版本的用户可见变更，格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
版本号遵循 SemVer；发版 tag 为 `vX.Y.Z`，必须与 `Cargo.toml` 的 `[workspace.package].version` 与
`apps/wt-desktop/tauri.conf.json` 的 `version` 一致——一致性由 `scripts/check-version.ps1` 在
发版前本地核（`docs/design/14-build-release.md §7`：检查在本地做，runner 只编译与发布）。
每条变更必须带需求 ID。

## [0.1.0] - Unreleased（待首次发版，尚未推 `v0.1.0` tag）

> 首个技术预览版本。发版前本地检查（`scripts/check-all.ps1 -WithE2e`、
> `scripts/verify-package.ps1`、`scripts/check-version.ps1`）全部做完；
> GitHub Actions 发版流水线 `.github/workflows/release.yml` 已配好，但仓库至今 0 个 `v*` tag、
> workflow 从未被真实推标签触发过。本节在首次发版前不写发布日期。

### Added

- `SYS-008` 多平台打包（Windows 便携 zip 链路）：`release.yml` 推 `v*` 标签触发一条 Windows runner
  编译并产出便携 zip + SHA256SUMS + GitHub Release；本地 `verify-package.ps1` 复现整条打包链路
  并自校验（解包字节一致、哈希对得上、SHA256SUMS 无 BOM、解包出的 exe 真能启动并建起 WebView2
  子进程），`verify-release-ui.mjs` 再用 CDP 连进解包出的 exe 确认前端加载的是磁盘当前版本、
  不是空白页或旧缓存资源（9h 门禁守调用链与正则转义，做过变异验证）。
- `FIL-018` / `FIL-002` 上传保留本地文件修改时间（SFTP SETSTAT mtime）。
- `FIL-011` 内嵌 Monaco 编辑器：编码识别与切换、换行符识别与切换、语法高亮（语言覆盖 ≥30）、
  列编辑 / 行号 / 自动缩进 / 大文件保护。
- `FIL-005` 远端文件编辑时自动检测本地副本被外部保存并提示可写回。
- `SET-012` 带变量的状态栏模板支持英文（54 条骨架）；错误消息与失败/异常类模板仍为中文，
  不假装「支持英文界面」。
- `TER-018` 关标签前的前台命令确认：本地 shell 还有子孙进程时先弹一句再关，避免误杀正在跑的命令；
  远端会话因为拿不到对端进程状态，如实不拦（不假装知道）。
- `TER-004` 多执行目标支持**会话树**：右键文件夹「多执行到此文件夹」（含子文件夹）、多选会话
  右键「多执行到选中会话」——顺序打开范围内的 SSH 会话再设为广播目标，非 SSH 如实跳过并计数。
  此前只有「多选标签」一条路。
- `TER-024` / `TER-025` 终端颜色降级（256/16 色）、Emoji 与组合音标专项验收。
- `SES-024` 跳板机连接复用（AC-3）。
- `TER-020` 快捷键体系：32 个动作表驱动，可重绑、冲突检测、导出/导入、恢复默认。
- `TER-004` 危险命令规则集可配置、会话树多选限定广播目标。
- `SEC-015` 离线优先：CSP 只允许 self / ipc，前端无外部地址。

### Fixed

- `SYS-008` 修便携包「启动自检」只证明建了视图、不证明前端加载当前版本的假绿。
- `TER-001` 修 `Ctrl+Tab` MRU 断言的反复偶发假失败（改用稳定 `view.id` 而非易变 OSC 标题）。
- 修 `invokeWithTimeout` 超时后迟到会话 handle 未回收的理论资源缺口（防御性修复，
  **不是**连跑多轮「打开失败/建连超时」偶发的根因；根因仍未定位）。

### 已知限制（未做的 P0 子项，见 `docs/status/p0-coverage.md`）

- `SES-005` / `GUI-015` / `GUI-018` / `GUI-022` RDP/VNC 整块暂缓（用户 2026-11-06 决定）。
- `SEC-003` DSA 私钥不支持（已明确说明原因，是否引入弃用 `dsa` 依赖待政策定调）。
- `SET-013` MobaXterm 设置导入只导会话树，不导配色/字体/快捷键（需真实 `MobaXterm.ini`）。
- `SYS-008` NSIS/MSI 从未产出、macOS 公证与 Linux 包没有；`bundle.targets: ["nsis"]` 与实际
  便携 zip 产物不一致，待定调（让 CI 真跑 `tauri build` 出 NSIS，或把 targets 对齐实际产物）。