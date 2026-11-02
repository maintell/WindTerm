# WindTerm 文档总索引

本目录是 WindTerm 的全部产品与工程文档，分为两册 + 附录：

- **第一册 `spec/` — 产品规格说明书**：回答「做什么、给谁做、做到什么程度算完成」。
- **第二册 `design/` — 详细设计**：回答「怎么做、为什么这么做、边界在哪」。
- **附录 `appendix/`**：决策记录、术语、事实来源。

## 阅读路径

不同角色不需要读全部文档：

| 角色 | 必读 | 选读 |
|---|---|---|
| 产品 / 决策者 | `spec/01` `spec/03` `spec/04` `spec/14` | `spec/02` `spec/13` |
| 新加入的工程师 | `spec/01` `spec/03` `spec/04` `design/01` `design/02` | 所属模块的 `spec/` + `design/` |
| 前端工程师 | `spec/06` `spec/08` `spec/12` `design/02` `design/03` `design/13` | `design/01` |
| 协议 / 后端工程师 | `spec/05` `spec/07` `spec/08` `spec/09` `design/05`~`design/10` | `design/04` `design/16` |
| 测试 / QA | `spec/03` `spec/13` `spec/14` `design/15` | 各功能规格的「验收标准」小节 |
| 安全 / 合规 | `spec/11` `spec/13` `design/09` `design/14` `appendix/a` | `spec/01` 许可章节 |
| 只想确认「MobaXterm 那个功能你们做不做」 | `spec/04` | — |

## 文档状态

| 文档 | 状态 | 说明 |
|---|---|---|
| `spec/00-index.md` | ✅ 完成 | |
| `spec/01-positioning.md` | ✅ 完成 | |
| `spec/02-users-and-scenarios.md` | ✅ 完成 | |
| `spec/03-requirement-model.md` | ✅ 完成 | |
| `spec/04-feature-matrix.md` | ✅ 完成 | 覆盖矩阵是需求基线，变更需走 ADR |
| `spec/05-func-sessions.md` | ✅ 完成 | 连接与会话管理 |
| `spec/06-func-terminal.md` | ✅ 完成 | 终端仿真 |
| `spec/07-func-files.md` | ✅ 完成 | 文件传输与编辑 |
| `spec/08-func-remote-desktop.md` | ✅ 完成 | 远程桌面（RDP / VNC），X11 已作废 |
| `spec/09-func-network.md` | ✅ 完成 | 网络工具与隧道 |
| `spec/10-func-local-shell.md` | ✅ 完成 | 本地 Shell 与内置工具 |
| `spec/11-func-security.md` | ✅ 完成 | 安全与凭据 |
| `spec/12-func-settings-extensions.md` | ✅ 完成 | 设置、扩展与系统集成 |
| `spec/13-nonfunctional.md` | ✅ 完成 | 26 条非功能需求 |
| `spec/14-roadmap-acceptance.md` | ✅ 完成 | M0~M4 与迁移验收 |
| `design/00-index.md` | ✅ 完成 | 设计索引、阅读路径、已知设计债务 |
| `design/01`~`design/16` | ✅ 完成 | 16 篇详细设计（`design/08` 为 VNC） |
| `appendix/a-adr-index.md` | ✅ 完成 | ADR-0001~0011（0011 待决策） |
| `appendix/b-glossary.md` | ✅ 完成 | 术语表 |
| `appendix/c-references.md` | ✅ 完成 | 事实来源分级与引用 |

**结构校验**：`pwsh ./scripts/check-docs.ps1` 已通过（10 项检查：需求 ID 闭合、P0/P1 设计承接、反向引用、无死链、ADR 一致、统计数字自洽、帮助文档 38 小节全覆盖）。
当前剩余 12 处 `【待验证】`，全部是 M0 阶段的技术假设（`spec/14` §2），按设计应在实测后清零。

图例：✅ 完成 · 🚧 编写中 · ⬜ 未开始 · 🔁 待评审 · ⛔ 已废弃

## 全局约定

### 需求编号

所有需求都有稳定 ID，格式 `<域>-<序号>`，域见 `spec/03-requirement-model.md`：

```
SES  会话与连接        TER  终端          FIL  文件传输与编辑
GUI  图形与远程桌面    NET  网络与隧道    LOC  本地环境与内置工具
SEC  安全与凭据        SET  设置与个性化  EXT  扩展与插件
SYS  系统集成          NFR  非功能
```

ID 一经分配永不复用；需求作废时保留 ID 并标注 `⛔ 作废`，避免历史讨论与提交信息失效。

### 优先级

| 标记 | 含义 | 判定标准 |
|---|---|---|
| `P0` | 必须 | 缺失则「MobaXterm 用户无法完成核心工作流」，MVP 阻塞项 |
| `P1` | 重要 | v1.0 目标；缺失会造成明显能力落差，但有可接受的工作区绕法 |
| `P2` | 增强 | v1.x 迭代；对标 MobaXterm 的加分项或体验优化 |
| `P3` | 观察 | 价值存疑或成本过高，先记录不排期 |
| `NO` | 不做 | 明确排除，必须写理由 |
| `ALT` | 替代实现 | 不照搬 MobaXterm 的做法，用不同机制达成同等或更好的结果，必须写说明 |

### 决策标记

设计文档中出现的决策标记：

- `ADR-xxxx` → 指向 `appendix/a-adr-index.md` 中的架构决策记录。**任何影响架构、许可、数据格式、安全模型的决策都必须有 ADR。**
- `【待验证】` → 依赖尚未实测的技术假设（例如某个 crate 是否支持某扩展）。这类条目在 M0 阶段必须给出实测结论并回填。

### 图表

文档中的图使用 Mermaid，保证在 Git 平台与 IDE 中可直接渲染，无需额外工具链。不要提交二进制图片作为架构图。

### 语言

正文中文。**所有标识符、类型名、字段名、crate 名、CLI 参数、协议名保持英文原样**，不做翻译，避免与代码脱节。
