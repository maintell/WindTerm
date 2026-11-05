#!/usr/bin/env pwsh
# WindTerm 一键验收
#
# 把分散的检查合成一条命令，输出一张汇总表：单元测试 / clippy（零告警）/ 文档与需求对账，
# 加上 -WithE2e 再跑端到端验收（会自己起停窗口，约 8 分钟）。
#
# 用法：
#   pwsh ./scripts/check-all.ps1              # 快速档（不跑 e2e）
#   pwsh ./scripts/check-all.ps1 -WithE2e     # 全量档
# 退出码：0 = 全绿，1 = 有失败项

[CmdletBinding()]
param([switch]$WithE2e)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$nl = [Environment]::NewLine
$results = [System.Collections.Generic.List[object]]::new()

function Run-Step([string]$name, [scriptblock]$body) {
    Write-Host ""
    Write-Host "=== $name ===" -ForegroundColor Cyan
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $ok = $true
    $detail = ""
    try {
        $detail = (& $body) -join " "
    } catch {
        $ok = $false
        $detail = $_.Exception.Message
    }
    $sw.Stop()
    $results.Add([pscustomobject]@{
        Step   = $name
        Ok     = $ok
        Ms     = [math]::Round($sw.Elapsed.TotalSeconds, 1)
        Detail = $detail
    })
}

Run-Step '单元测试' {
    $out = & cargo test --manifest-path (Join-Path $repoRoot 'Cargo.toml') --workspace 2>&1
    if ($LASTEXITCODE -ne 0) { throw ("cargo test 失败（退出码 " + $LASTEXITCODE + "）") }
    $joined = $out -join $nl
    $passed = ([regex]::Matches($joined, 'ok\. (\d+) passed') | ForEach-Object { [int]$_.Groups[1].Value } | Measure-Object -Sum).Sum
    "通过 $passed 项"
}

Run-Step 'clippy（零告警）' {
    $out = & cargo clippy --manifest-path (Join-Path $repoRoot 'Cargo.toml') --workspace --all-targets 2>&1
    if ($LASTEXITCODE -ne 0) { throw ("clippy 编译失败（退出码 " + $LASTEXITCODE + "）") }
    $warns = @($out | Where-Object { $_ -match '^warning' -and $_ -notmatch 'generated \d+ warning' })
    if ($warns.Count -gt 0) { throw ("有 " + $warns.Count + " 条告警") }
    '零告警'
}

Run-Step '文档与需求对账' {
    & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'check-docs.ps1') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "check-docs.ps1 未通过" }
    'check-docs PASSED'
}

if ($WithE2e) {
    Run-Step '端到端验收' {
        $out = & node (Join-Path $PSScriptRoot 'e2e-desktop.mjs') 2>&1
        if ($LASTEXITCODE -ne 0) {
            $tail = ($out | Select-Object -Last 6) -join $nl
            throw ("e2e 未通过" + $nl + $tail)
        }
        $line = $out | Where-Object { $_ -match '\d+/\d+ 项通过' } | Select-Object -Last 1
        "$line"
    }
}

Write-Host ""
Write-Host "=== 汇总 ===" -ForegroundColor Cyan
$results | Format-Table -AutoSize Step, Ok, Ms, Detail | Out-String -Width 200 | Write-Host

$failed = @($results | Where-Object { -not $_.Ok })
if ($failed.Count -gt 0) {
    Write-Host ("有 " + $failed.Count + " 项未通过。") -ForegroundColor Red
    exit 1
}
Write-Host '全绿。' -ForegroundColor Green
exit 0
