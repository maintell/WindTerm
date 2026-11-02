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
# 输出
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
