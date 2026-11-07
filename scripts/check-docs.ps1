#!/usr/bin/env pwsh
# WindTerm 文档结构校验
# 对应 docs/design/15-testing.md §6 的结构测试（1、3、4、5、11 项）
# 用法：pwsh ./scripts/check-docs.ps1 [-Verbose]
# 退出码：0 = 全部通过，1 = 有失败项

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$docsRoot = Join-Path $repoRoot 'docs'

$failures = [System.Collections.Generic.List[string]]::new()
$warnings = [System.Collections.Generic.List[string]]::new()

function Fail([string]$msg) { $script:failures.Add($msg) }
function Warn([string]$msg) { $script:warnings.Add($msg) }

function Get-DocFiles([string]$sub) {
    $dir = Join-Path $docsRoot $sub
    if (-not (Test-Path $dir)) { return @() }
    Get-ChildItem $dir -Filter '*.md' -File
}

# ─────────────────────────────────────────────────────────────
# 0. 基础：文件存在
# ─────────────────────────────────────────────────────────────
$required = @(
    'README.md',
    'spec/00-index.md', 'spec/01-positioning.md', 'spec/02-users-and-scenarios.md',
    'spec/03-requirement-model.md', 'spec/04-feature-matrix.md',
    'spec/05-func-sessions.md', 'spec/06-func-terminal.md', 'spec/07-func-files.md',
    'spec/08-func-remote-desktop.md', 'spec/09-func-network.md', 'spec/10-func-local-shell.md',
    'spec/11-func-security.md', 'spec/12-func-settings-extensions.md',
    'spec/13-nonfunctional.md', 'spec/14-roadmap-acceptance.md',
    'design/00-index.md', 'design/01-architecture.md', 'design/02-process-and-ipc.md',
    'design/03-terminal-subsystem.md', 'design/04-data-model.md', 'design/05-ssh-stack.md',
    'design/06-file-transfer.md', 'design/07-rdp-stack.md', 'design/08-vnc.md',
    'design/09-credentials-crypto.md', 'design/10-tunnels-jump.md',
    'design/11-local-shell-vfs.md', 'design/12-plugins-packages.md',
    'design/13-frontend-ui.md', 'design/14-build-release.md', 'design/15-testing.md',
    'design/16-observability.md',
    'appendix/a-adr-index.md', 'appendix/b-glossary.md', 'appendix/c-references.md'
)
foreach ($r in $required) {
    if (-not (Test-Path (Join-Path $docsRoot $r))) { Fail "缺少文档：docs/$r" }
}

# ─────────────────────────────────────────────────────────────
# 1. 解析矩阵，得到 ID → 优先级
# ─────────────────────────────────────────────────────────────
$matrixPath = Join-Path $docsRoot 'spec/04-feature-matrix.md'
$matrixText = Get-Content -Raw -Encoding UTF8 $matrixPath
$matrixLines = Get-Content -Encoding UTF8 $matrixPath

$rows = [System.Collections.Generic.List[pscustomobject]]::new()
foreach ($line in $matrixLines) {
    if ($line -match '^\|\s*`?([A-Z]{3})-(\d{3})`?\s*\|') {
        $cells = @(($line.Trim('|') -split '\|') | ForEach-Object { $_.Trim() })
        $domain = $matches[1]
        if ($domain -eq 'NFR') {
            # NFR 表 5 列：ID | 需求 | 阈值 | 门禁 | 规格
            if ($cells.Count -ge 5) {
                $rows.Add([pscustomobject]@{ Id = $cells[0].Trim('`'); Prio = 'NFR' })
            }
        }
        elseif ($cells.Count -ge 7) {
            # 功能域表 7 列：ID | 特性 | 出处 | 优先级 | 兼容 | 决策 | 规格
            $rows.Add([pscustomobject]@{ Id = $cells[0].Trim('`'); Prio = $cells[3] })
        }
    }
}

if ($rows.Count -eq 0) { Fail '未能从矩阵解析出任何需求行，检查表格格式' }

# ─────────────────────────────────────────────────────────────
# 2. 需求 ID 闭合
#    - 每个功能域 ID 必须出现在 spec/05~12（NFR 在 spec/13）
#    - 每个 P0/P1 必须出现在 design/
# ─────────────────────────────────────────────────────────────
$specBodyFiles = Get-DocFiles 'spec' | Where-Object { $_.Name -match '^(0[3-9]|1[0-4])-' }
$specBodyText = ($specBodyFiles | ForEach-Object { Get-Content -Raw -Encoding UTF8 $_.FullName }) -join "`n"

$designFiles = Get-DocFiles 'design'
$designText = ($designFiles | ForEach-Object { Get-Content -Raw -Encoding UTF8 $_.FullName }) -join "`n"

foreach ($row in $rows) {
    $id = $row.Id
    if ($specBodyText -notmatch [regex]::Escape($id)) {
        Fail "需求 $id 在矩阵中存在，但 spec/05~14 无承接"
    }
    if ($row.Prio -match 'P0|P1') {
        if ($designText -notmatch [regex]::Escape($id)) {
            Fail "需求 $id（$($row.Prio)）无设计承接"
        }
    }
}

# 反向：design 中引用的 ID 必须存在于矩阵，或属于 §12.6 已作废需求
$allMatrixIds = [System.Collections.Generic.HashSet[string]]::new()
foreach ($row in $rows) { [void]$allMatrixIds.Add($row.Id) }

# 收集「已作废需求」ID（§12.6 表中登记的历史 ID，允许被设计文档引用）
$retiredIds = [System.Collections.Generic.HashSet[string]]::new()
$inRetired = $false
foreach ($line in $matrixLines) {
    if ($line -match '^###\s+12\.6') { $inRetired = $true; continue }
    if ($inRetired -and $line -match '^##\s') { $inRetired = $false }
    if ($inRetired -and $line -match '^\|\s*`?([A-Z]{3}-\d{3})`?\s*\|') {
        [void]$retiredIds.Add($matches[1])
    }
}
$referenced = [regex]::Matches($designText, '(?<![A-Za-z0-9])(SES|TER|FIL|GUI|NET|LOC|SEC|SET|EXT|SYS|NFR)-(\d{3})(?![\d])') |
    ForEach-Object { $_.Value } | Sort-Object -Unique
foreach ($id in $referenced) {
    if (-not $allMatrixIds.Contains($id) -and -not $retiredIds.Contains($id)) { Fail "设计文档引用了矩阵中不存在的需求 $id" }
}

# ─────────────────────────────────────────────────────────────
# 3. 规格中不允许 TBD / 待定（作为「取值」出现时才算违规；
#    规则文本里的「不允许出现待定」不算）
# ─────────────────────────────────────────────────────────────
$tbdPatterns = @(
    '\|\s*(TBD|待定)\s*\|',        # 表格单元格取值
    '^\s*[-*]?\s*(TBD|待定)\s*$',  # 独占一行
    '状态\s*[:：]\s*(TBD|待定)'      # 状态字段
)
foreach ($f in (Get-DocFiles 'spec')) {
    $ln = 0
    foreach ($line in (Get-Content -Encoding UTF8 $f.FullName)) {
        $ln++
        foreach ($pat in $tbdPatterns) {
            if ($line -match $pat) {
                Fail "spec/$($f.Name):$ln 含未决项（$($matches[0].Trim())）"
            }
        }
    }
}

# ─────────────────────────────────────────────────────────────
# 4. ADR 引用与索引一致
# ─────────────────────────────────────────────────────────────
$adrPath = Join-Path $docsRoot 'appendix/a-adr-index.md'
$adrText = Get-Content -Raw -Encoding UTF8 $adrPath
$definedAdr = [regex]::Matches($adrText, '^## (ADR-\d{4})', 'Multiline') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique

$allDocsText = ((Get-DocFiles 'spec') + (Get-DocFiles 'design') + (Get-DocFiles 'appendix')) |
    ForEach-Object { Get-Content -Raw -Encoding UTF8 $_.FullName }
$allDocsText = $allDocsText -join "`n"

$referencedAdr = [regex]::Matches($allDocsText, 'ADR-\d{4}') | ForEach-Object { $_.Value } | Sort-Object -Unique
foreach ($a in $referencedAdr) {
    if ($definedAdr -notcontains $a) { Fail "引用了未定义的 $a（appendix/a-adr-index.md 中无该条目）" }
}
foreach ($a in $definedAdr) {
    if ($referencedAdr -notcontains $a) { Warn "$a 已定义但正文未引用" }
}

# ─────────────────────────────────────────────────────────────
# 5. 内部链接可达
# ─────────────────────────────────────────────────────────────
foreach ($f in ((Get-DocFiles 'spec') + (Get-DocFiles 'design') + (Get-DocFiles 'appendix'))) {
    $txt = Get-Content -Raw -Encoding UTF8 $f.FullName
    foreach ($m in [regex]::Matches($txt, '\]\(([^)]+\.md)(#[^)]*)?\)')) {
        $target = $m.Groups[1].Value
        if ($target -match '^https?://') { continue }
        $resolved = Join-Path $f.DirectoryName $target
        if (-not (Test-Path $resolved)) {
            Fail "$($f.Name) 中有死链：$target"
        }
    }
}

# ─────────────────────────────────────────────────────────────
# 6. 矩阵统计与正文数字一致
# ─────────────────────────────────────────────────────────────
$byDomain = $rows | Group-Object { $_.Id.Substring(0, 3) }
$actual = @{}
foreach ($g in $byDomain) {
    $actual[$g.Name] = @{
        Total = $g.Count
        P0    = ($g.Group | Where-Object { $_.Prio -match 'P0' }).Count
        P1    = ($g.Group | Where-Object { $_.Prio -match 'P1' }).Count
        P2    = ($g.Group | Where-Object { $_.Prio -match 'P2' }).Count
        P3    = ($g.Group | Where-Object { $_.Prio -match 'P3' }).Count
        NO    = ($g.Group | Where-Object { $_.Prio -match 'NO' }).Count
    }
}

# 逐行比对 §12.1 的统计表
foreach ($line in $matrixLines) {
    if ($line -match '^\|\s*(SES|TER|FIL|GUI|NET|LOC|SEC|SET|EXT|SYS)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|') {
        $d = $matches[1]
        $t = [int]$matches[2]; $a = [int]$matches[3]; $b = [int]$matches[4]
        $c = [int]$matches[5]; $e = [int]$matches[6]; $f2 = [int]$matches[7]
        $act = $actual[$d]
        if ($null -eq $act) { Fail "统计表中出现未知域 $d"; continue }
        if ($act.Total -ne $t -or $act.P0 -ne $a -or $act.P1 -ne $b -or $act.P2 -ne $c -or $act.P3 -ne $e -or $act.NO -ne $f2) {
            Fail ("$d 统计不一致：表内 $t/$a/$b/$c/$e/$f2，实际 $($act.Total)/$($act.P0)/$($act.P1)/$($act.P2)/$($act.P3)/$($act.NO)")
        }
    }
}

# ─────────────────────────────────────────────────────────────
# 7. 帮助文档章节覆盖表完整性（§12.4 必须覆盖 1.1~6.8 共 38 个小节）
# ─────────────────────────────────────────────────────────────
$expectedSections = @(
    '1.1','1.2','1.3','1.4','1.5','1.6',
    '2.1','2.2','2.3','2.4',
    '3.1','3.2','3.3','3.4',
    '4.1','4.2','4.3','4.4','4.5','4.6','4.7','4.8','4.9','4.10','4.11',
    '5.1','5.2','5.3','5.4','5.5',
    '6.1','6.2','6.3','6.4','6.5','6.6','6.7','6.8'
)
# 只取 §12.4 之后、§12.5 之前的行
$inSection = $false
$foundSections = [System.Collections.Generic.HashSet[string]]::new()
foreach ($line in $matrixLines) {
    if ($line -match '^###\s+12\.4') { $inSection = $true; continue }
    if ($line -match '^###\s+12\.5') { $inSection = $false; continue }
    if ($inSection -and $line -match '^\|\s*(\d+\.\d+)\s*\|') {
        [void]$foundSections.Add($matches[1])
    }
}
foreach ($s in $expectedSections) {
    if (-not $foundSections.Contains($s)) { Fail "§12.4 帮助文档覆盖表缺少小节 $s" }
}
if ($foundSections.Count -ne $expectedSections.Count) {
    Warn "§12.4 覆盖表小节数 $($foundSections.Count)，预期 $($expectedSections.Count)"
}

# ─────────────────────────────────────────────────────────────
# 8. 待验证标记清点（M0 结束前必须清零，此处只统计）
# ─────────────────────────────────────────────────────────────
$pending = 0
foreach ($f in ((Get-DocFiles 'spec') + (Get-DocFiles 'design') + (Get-DocFiles 'appendix'))) {
    $txt = Get-Content -Raw -Encoding UTF8 $f.FullName
    $n = ([regex]::Matches($txt, '【待验证】')).Count
    if ($n -gt 0) { Warn "$($f.Name) 含 $n 处【待验证】"; $pending += $n }
}

# ─────────────────────────────────────────────────────────────
# ─────────────────────────────────────────────────────────────
# 9. README 里的手工数字与代码/状态表对账
#     加设置项、动作、i18n 键时最容易忘了改 README，手工数字 100% 会漂移。
#     真值一律从源文件算，README 里写死的数对不上就 Fail（第 6 项统计自洽的延伸）。
#     正则一律用 [0-9] / [ \t] 字符类，不用转义序列，避免脚本文本被二次转义吞掉。
# ─────────────────────────────────────────────────────────────
$readmePath = Join-Path $repoRoot "README.md"
$readmeText = Get-Content -Raw -Encoding UTF8 $readmePath
$htmlText = Get-Content -Raw -Encoding UTF8 (Join-Path $repoRoot "apps/wt-desktop/ui/index.html")
$mainText = Get-Content -Raw -Encoding UTF8 (Join-Path $repoRoot "apps/wt-desktop/ui/main.js")
$statusText2 = Get-Content -Raw -Encoding UTF8 (Join-Path $docsRoot "status/p0-coverage.md")

function Assert-ReadmeNumber([string]$pattern, [int]$expected, [string]$label) {
    $m = [regex]::Match($readmeText, $pattern)
    if (-not $m.Success) { Fail ("README 里找不到「{0}」的数字" -f $label); return }
    $got = [int]$m.Groups[1].Value
    if ($got -ne $expected) { Fail ("README 的「{0}」写 {1}，实际应为 {2}" -f $label, $got, $expected) }
}

# 9a. i18n：index.html 的 data-i18n 元素数 / 唯一键数
$dq = [char]34
$i18nPat = "data-i18n=" + $dq + "([^" + $dq + "]+)" + $dq
$i18nEls = [regex]::Matches($htmlText, $i18nPat)
$i18nKeys = @($i18nEls | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
$i18nElCount = $i18nEls.Count
$i18nKeyCount = $i18nKeys.Count
Assert-ReadmeNumber "覆盖[ \t]*([0-9]+)[ \t]*键" $i18nKeyCount "SET-012 键数"
$mEls = [regex]::Match($readmeText, "覆盖[ \t]*[0-9]+[ \t]*键[ \t]*/[ \t]*([0-9]+)[ \t]*处")
if ($mEls.Success -and ([int]$mEls.Groups[1].Value -ne $i18nElCount)) {
    Fail ("README 的 SET-012 处数写 {0}，实际应为 {1}" -f $mEls.Groups[1].Value, $i18nElCount)
}

# 9b. P0 状态数：从 p0-coverage 表算 ✅/🟡/⬜
$p0Rows = @($statusText2 -split [char]10 | Where-Object { $_ -match '^[|].*`[A-Z][A-Z]+-[0-9]+`' })
$p0Ok = @($p0Rows | Where-Object { $_ -match "✅" }).Count
$p0Wip = @($p0Rows | Where-Object { $_ -match "🟡" }).Count
$p0None = @($p0Rows | Where-Object { $_ -match "⬜" }).Count
$mState = [regex]::Match($readmeText, "([0-9]+)[ \t]*条完成[ \t]*/[ \t]*([0-9]+)[ \t]*条部分[ \t]*/[ \t]*([0-9]+)[ \t]*条未做")
if (-not $mState.Success) { Fail "README 里找不到 P0 状态数（完成/部分/未做）" }
else {
    if ([int]$mState.Groups[1].Value -ne $p0Ok) { Fail ("README P0 完成数写 {0}，实际 {1}" -f $mState.Groups[1].Value, $p0Ok) }
    if ([int]$mState.Groups[2].Value -ne $p0Wip) { Fail ("README P0 部分数写 {0}，实际 {1}" -f $mState.Groups[2].Value, $p0Wip) }
    if ([int]$mState.Groups[3].Value -ne $p0None) { Fail ("README P0 未做数写 {0}，实际 {1}" -f $mState.Groups[3].Value, $p0None) }
}

# 9b-2. 交接文档（handover.md）的 P0 状态数也必须跟真值表一致。
#      它之前把 22/16/6 写成 21/17/6、把单测写死成 314 项，都是「文档与代码不同步」
#      的典型——这次把状态数纳入门禁，改了真值表却忘了交接文档会当场判红。
$handoverPath = Join-Path $docsRoot 'status/handover.md'
if (Test-Path $handoverPath) {
    $handoverText = Get-Content -Raw -Encoding UTF8 $handoverPath
    $hState = [regex]::Match($handoverText, "([0-9]+)[ \t]*条完成[ \t]*/[ \t]*([0-9]+)[ \t]*条部分[ \t]*/[ \t]*([0-9]+)[ \t]*条未做")
    if (-not $hState.Success) {
        Fail "handover.md 里找不到 P0 状态数（完成/部分/未做）——不得删掉，应对齐 p0-coverage.md"
    } else {
        if ([int]$hState.Groups[1].Value -ne $p0Ok -or
            [int]$hState.Groups[2].Value -ne $p0Wip -or
            [int]$hState.Groups[3].Value -ne $p0None) {
            Fail ("handover.md 的 P0 状态数写 {0}/{1}/{2}，真值表实际 {3}/{4}/{5}" -f `
                $hState.Groups[1].Value, $hState.Groups[2].Value, $hState.Groups[3].Value, `
                $p0Ok, $p0Wip, $p0None)
        }
    }
    # 标题里「N 条部分完成」同样会漂，跟着一起盯
    $hWipTitle = [regex]::Match($handoverText, "([0-9]+)[ \t]*条部分完成")
    if ($hWipTitle.Success -and ([int]$hWipTitle.Groups[1].Value -ne $p0Wip)) {
        Fail ("handover.md 标题写「{0} 条部分完成」，真值表实际 {1} 条" -f $hWipTitle.Groups[1].Value, $p0Wip)
    }
    # 单测项数不写死：项目在长，写死的数字必然过时。只要求「不出现具体项数」。
    if ($handoverText -match "单测[ \t]*[0-9]+[ \t]*项") {
        Fail "handover.md 把单测项数写死了——数量随用例增长，应写「单测全绿」而不是具体数字"
    }
    # 已过时的断言：CI 工作流与 bundle.active 早就接上了，不能还写「没有」
    if ($handoverText -match "仓库没有 CI 工作流|bundle[.]active=false") {
        Fail "handover.md 仍写着「没有 CI 工作流 / bundle.active=false」，与现状矛盾（见 SYS-008 与 release.yml）"
    }
}

# 9c. 可重绑动作数：KEYMAP_DEFAULT 的键数
$kmMatch = [regex]::Match($mainText, "const KEYMAP_DEFAULT = [{].*?[}];", [System.Text.RegularExpressions.RegexOptions]::Singleline)
$kmKeys = [regex]::Matches($kmMatch.Value, "[ \t]{2}([A-Za-z][A-Za-z0-9]*):[ \t]*[{][ \t]*label:").Count
Assert-ReadmeNumber "可用（([0-9]+)[ \t]*个动作可重绑）" $kmKeys "TER-020 动作数"
# 9d. 状态栏文案 i18n（SET-012）：纯字面量的 setStatus 必须有英文词条，表里也不许留死词条
#     带变量的模板字符串不在此列（它们仍是中文，如实记在 README 缺口里），但只写字面量
#     的那批必须能翻——否则「切成 English 后状态栏还是中文」只能靠人肉发现。
$stPat = [regex]::Escape("setStatus(") + $dq + "([^" + $dq + "]*)" + $dq + [regex]::Escape(")")
$statusLiterals = @([regex]::Matches($mainText, $stPat) | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
Assert-ReadmeNumber "状态栏[ \t]*([0-9]+)[ \t]*条字面量" $statusLiterals.Count "SET-012 状态栏字面量数"
$nlCh = [string][char]10
$mainLines = $mainText.Split($nlCh)
$mapStart = -1
for ($i = 0; $i -lt $mainLines.Length; $i++) {
    if ($mainLines[$i] -match "const STATUS_EN = [{]") { $mapStart = $i; break }
}
if ($mapStart -lt 0) {
    Fail "main.js 里找不到 STATUS_EN（状态栏中文→英文词表）"
} else {
    $mapKeyPat = "^[ \t]*" + $dq + "([^" + $dq + "]+)" + $dq + ":"
    $mapKeys = [System.Collections.Generic.List[string]]::new()
    for ($j = $mapStart + 1; $j -lt $mainLines.Length; $j++) {
        $ln = $mainLines[$j]
        if ($ln -match "^[}];") { break }
        $k = [regex]::Match($ln, $mapKeyPat)
        if ($k.Success) { $mapKeys.Add($k.Groups[1].Value) }
    }
    $missingKeys = @($statusLiterals | Where-Object { $mapKeys -notcontains $_ })
    if ($missingKeys.Count -gt 0) {
        Fail ("有 {0} 条纯字面量状态文案没有英文词条：{1}" -f $missingKeys.Count, ($missingKeys -join " / "))
    }
    $deadKeys = @($mapKeys | Where-Object { $statusLiterals -notcontains $_ })
    if ($deadKeys.Count -gt 0) {
        Fail ("STATUS_EN 有 {0} 条没人用的死词条：{1}" -f $deadKeys.Count, ($deadKeys -join " / "))
    }
    Write-Host ("状态栏文案：字面量 {0} 条 / 词表 {1} 条（缺 {2}、死 {3}）" -f $statusLiterals.Count, $mapKeys.Count, $missingKeys.Count, $deadKeys.Count)
}
Write-Host ("README 对账：i18n {0} 键/{1} 处、P0 {2}/{3}/{4}、动作 {5} 项" -f $i18nKeyCount, $i18nElCount, $p0Ok, $p0Wip, $p0None, $kmKeys)
# 输出
# ─────────────────────────────────────────────────────────────
# 12b. P0 覆盖表完整（docs/status/p0-coverage.md）
#      「验收所有功能」得有一张能对账的表：每个 P0 都要在表里出现，
#      表里也不许出现不是 P0 的 ID（写错 ID 等于悄悄漏掉一条）。
# ─────────────────────────────────────────────────────────────
$p0Ids = @($rows | Where-Object { $_.Prio -match 'P0' } | ForEach-Object { $_.Id })
$statusPath = Join-Path $docsRoot 'status/p0-coverage.md'
if (-not (Test-Path $statusPath)) {
    Fail '缺少 docs/status/p0-coverage.md（P0 覆盖与验收状态表）'
} else {
    $statusText = Get-Content -Raw -Encoding UTF8 $statusPath
    foreach ($id in $p0Ids) {
        if ($statusText -notmatch [regex]::Escape($id)) {
            Fail ("P0 覆盖表里没有 {0}" -f $id)
        }
    }
    # 反向：表里出现的 ID 必须真的存在且是 P0
    $p0Set = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($id in $p0Ids) { [void]$p0Set.Add($id) }
    foreach ($m in [regex]::Matches($statusText, '\|\s*`([A-Z]{3}-\d{3})`\s*\|')) {
        $id = $m.Groups[1].Value
        if (-not $p0Set.Contains($id)) {
            Fail ("P0 覆盖表里出现了不是 P0 的 ID：{0}" -f $id)
        }
    }
}

# ─────────────────────────────────────────────────────────────
# 12c. P0 覆盖表不能自相矛盾
#      12b 只保证「每条 P0 都在表里」。这张表还要能当证据用，所以再查三条：
#      ① 每行必须是 6 段（首尾空 + id + 状态 + 依据 + 缺什么）：内联代码里的竖线不转义
#         会把整行截断，渲染出来列就错位——肉眼极容易漏；
#      ② 标 ✅ 的行不许再写「未做 / 未实现 / 没做」，那等于自己承认没做完；
#      ③ 标 🟡/⬜ 的行必须写清缺什么，空着或写「—」等于把缺口藏起来。
# ─────────────────────────────────────────────────────────────
$statusRows = @($statusText -split [char]10 | Where-Object { $_ -match '^[|].*`[A-Z][A-Z]+-[0-9]+`' })
foreach ($line in $statusRows) {
    # 只按**未转义**的竖线切：内容里的字面竖线要写成 `\|`
    $cells = @([regex]::Split($line.Trim(), '(?<!\\)\|'))
    if ($cells.Count -ne 6) {
        Fail (("P0 覆盖表有一行切成 {0} 段（应为 6），多半是内容里的竖线没转义：{1}") -f $cells.Count, $line.Substring(0, [Math]::Min(48, $line.Length)))
        continue
    }
    $rowId = $cells[1].Trim()
    $rowStatus = $cells[2].Trim()
    $rowGap = $cells[4].Trim()
    if ($rowStatus -match '✅' -and $rowGap -match '未做|未实现|没做') {
        Fail ("{0} 标了 ✅，却在「缺什么」里承认没做完：{1}" -f $rowId, $rowGap)
    }
    if ($rowStatus -match '🟡|⬜' -and ($rowGap -eq '' -or $rowGap -eq '—' -or $rowGap -eq '-')) {
        Fail ("{0} 标了未完成，却没写清缺什么" -f $rowId)
    }
}

# ─────────────────────────────────────────────────────────────
# 12d. 覆盖表引用的文件必须真实存在
#      「验收依据」里写 `xxx/tests/foo.rs` 是最强的一种声明；那个文件被删掉或改名后，
#      表里还留着它，等于拿一份不存在的证据撑结论。这条门禁专门抓这种。
# ─────────────────────────────────────────────────────────────
$refPat = '`([A-Za-z0-9_./-]+\.(?:rs|mjs|ps1|md|toml|json|js|html))`'
$refPrefixes = @('', 'crates/', 'apps/', 'docs/', 'scripts/', 'docs/status/')
foreach ($m in [regex]::Matches($statusText, $refPat)) {
    $rel = $m.Groups[1].Value
    # 纯文件名（如 `config.toml`）不是路径声明，跳过
    if ($rel -notmatch '/') { continue }
    $found = $false
    foreach ($p in $refPrefixes) {
        if (Test-Path -LiteralPath (Join-Path $repoRoot ($p + $rel))) { $found = $true; break }
    }
    if (-not $found) { Fail ("P0 覆盖表引用了不存在的文件：{0}" -f $rel) }
}

# ─────────────────────────────────────────────────────────────
# 9e. JS 里 `t("k")` / `tf("k")` 用到的词条必须存在于中英两份词表
#     页面元素有 `data-i18n` 门禁盯着，但代码里拼的文案（右键菜单等）没人管：
#     键名写错时 `t()` 会**把键名原样显示给用户**，而且不报错——典型的静默失效。
# ─────────────────────────────────────────────────────────────
$i18nBlock = [regex]::Match($mainText, 'const I18N = [{](.*?)\n[}];', [System.Text.RegularExpressions.RegexOptions]::Singleline)
if (-not $i18nBlock.Success) {
    Fail 'main.js 里找不到 I18N 词表对象'
} else {
    $i18nBody = $i18nBlock.Groups[1].Value
    $enAt = $i18nBody.IndexOf('en: {')
    if ($enAt -lt 0) {
        Fail 'I18N 里找不到 en 段'
    } else {
        $zhPart = $i18nBody.Substring(0, $enAt)
        $enPart = $i18nBody.Substring($enAt)
        $keyPat = '^[ \t]*"([^"]+)":'
        $zhSet = [System.Collections.Generic.HashSet[string]]::new()
        foreach ($ln in ($zhPart -split [char]10)) {
            $m = [regex]::Match($ln, $keyPat)
            if ($m.Success) { [void]$zhSet.Add($m.Groups[1].Value) }
        }
        $enSet = [System.Collections.Generic.HashSet[string]]::new()
        foreach ($ln in ($enPart -split [char]10)) {
            $m = [regex]::Match($ln, $keyPat)
            if ($m.Success) { [void]$enSet.Add($m.Groups[1].Value) }
        }
        $usedPat = '\btf?\("([a-z][A-Za-z0-9]*\.[A-Za-z0-9]+)"'
        $usedKeys = @([regex]::Matches($mainText, $usedPat) | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
        $missZh = @($usedKeys | Where-Object { -not $zhSet.Contains($_) })
        $missEn = @($usedKeys | Where-Object { -not $enSet.Contains($_) })
        if ($missZh.Count -gt 0) { Fail ("JS 里用了词表里没有的键（中文缺）：{0}" -f ($missZh -join ' / ')) }
        if ($missEn.Count -gt 0) { Fail ("JS 里用了词表里没有的键（英文缺）：{0}" -f ($missEn -join ' / ')) }
        Write-Host ("JS 文案：t()/tf() 用到 {0} 个键，中文词表 {1} 条 / 英文 {2} 条" -f $usedKeys.Count, $zhSet.Count, $enSet.Count)
    }
}

# ─────────────────────────────────────────────────────────────
# ─────────────────────────────────────────────────────────────
# 9f. 带变量状态栏模板的英文骨架（SET-012）：逐条要有中文样例对照
#     STATUS_TPL_EN 是「正则 → 英文」的活代码，写错了用户看到的是半句中英混排，
#     光靠肉眼查不出来。把这个离线自测接进门禁：改错骨架立即红。
# ─────────────────────────────────────────────────────────────
$statusTplCheck = Join-Path $PSScriptRoot 'check-status-tpl.mjs'
if (-not (Test-Path $statusTplCheck)) {
    Fail '缺少 scripts/check-status-tpl.mjs（状态栏模板骨架自测）'
} else {
    $nodeOut = & node $statusTplCheck 2>&1
    if ($LASTEXITCODE -ne 0) {
        Fail ("状态栏模板骨架自测未通过：" + (($nodeOut | Select-Object -Last 3) -join ' '))
    } else {
        Write-Host ("状态栏模板：" + ($nodeOut | Select-Object -Last 1))
    }
}

# ─────────────────────────────────────────────────────────────
# 9g. 超时后游离会话回收（连跑多轮打开失败的兜底）
#     invokeWithTimeout 超时后底层 invoke 仍可能注册会话（conhost 累积）。
#     check-late-session.mjs 从真源码抠出函数、注入假 invoke 跑 5 个场景。
# ─────────────────────────────────────────────────────────────
$lateCheck = Join-Path $PSScriptRoot 'check-late-session.mjs'
if (-not (Test-Path $lateCheck)) {
    Fail '缺少 scripts/check-late-session.mjs（超时后游离会话回收自测）'
} else {
    $lateOut = & node $lateCheck 2>&1
    if ($LASTEXITCODE -ne 0) {
        Fail ("超时后游离会话回收自测未通过：" + (($lateOut | Select-Object -Last 2) -join ' '))
    } else {
        Write-Host ("超时会话回收：" + ($lateOut | Select-Object -Last 1))
    }
}

# 12. 相对链接可达（NFR-026）
#     用户手册会随功能增长不断加页，链接断了没人发现。
#     只查相对路径的 .md 链接；外链不查（离线环境查不了）
# ─────────────────────────────────────────────────────────────
$allDocs = Get-ChildItem -Path $docsRoot -Recurse -Filter '*.md' -File
$linkCount = 0
foreach ($doc in $allDocs) {
    $text = Get-Content -Raw -Encoding UTF8 $doc.FullName
    foreach ($m in [regex]::Matches($text, '\]\(([^)#\s]+\.md)(#[^)]*)?\)')) {
        $target = $m.Groups[1].Value
        if ($target -match '^[a-z]+://') { continue }
        $linkCount++
        $resolved = Join-Path $doc.DirectoryName $target
        if (-not (Test-Path -LiteralPath $resolved)) {
            Fail ("{0} 里的链接指向不存在的文件：{1}" -f $doc.Name, $target)
        }
    }
}

# ─────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '===== WindTerm 文档结构校验 =====' -ForegroundColor Cyan
Write-Host ("需求条目：{0}（P0 {1} / P1 {2} / P2 {3} / P3 {4} / NO {5}）" -f `
    $rows.Count,
    ($rows | Where-Object { $_.Prio -match 'P0' }).Count,
    ($rows | Where-Object { $_.Prio -match 'P1' }).Count,
    ($rows | Where-Object { $_.Prio -match 'P2' }).Count,
    ($rows | Where-Object { $_.Prio -match 'P3' }).Count,
    ($rows | Where-Object { $_.Prio -match 'NO' }).Count)
Write-Host ("ADR：定义 {0} 条，引用 {1} 条" -f $definedAdr.Count, $referencedAdr.Count)
Write-Host ("待验证标记：{0} 处（M0 结束前需清零）" -f $pending)
Write-Host ("文档内相对链接：{0} 条" -f $linkCount)
Write-Host ("P0 覆盖表：{0} 条需求逐条对账" -f $p0Ids.Count)
Write-Host ''

if ($warnings.Count -gt 0) {
    Write-Host "--- 警告 ($($warnings.Count)) ---" -ForegroundColor Yellow
    $warnings | ForEach-Object { Write-Host "  ⚠ $_" -ForegroundColor Yellow }
    Write-Host ''
}

if ($failures.Count -gt 0) {
    Write-Host "--- 失败 ($($failures.Count)) ---" -ForegroundColor Red
    $failures | ForEach-Object { Write-Host "  ✗ $_" -ForegroundColor Red }
    Write-Host ''
    Write-Host '结果：FAILED' -ForegroundColor Red
    exit 1
}

Write-Host '结果：PASSED' -ForegroundColor Green
exit 0
