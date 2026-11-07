#!/usr/bin/env pwsh
# WindTerm 一键验收
#
# 把分散的检查合成一条命令，输出一张汇总表：单元测试 / clippy（零告警）/ 文档与需求对账，
# 加上 -WithE2e 再跑端到端验收：先构建带 `e2e-mock` 的产物，再起停窗口跑，约 10 分钟。
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

Run-Step '版本一致性' {
    # 发布前必跑项（design/14 §7）：Cargo.toml / tauri.conf.json / CHANGELOG.md 三处对账。
    # check-docs.ps1 的 9i 门禁也会调它，这里单列一步让一键验收的汇总表看得见结果。
    $out = & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'check-version.ps1') 2>&1
    if ($LASTEXITCODE -ne 0) { throw ("check-version.ps1 未通过：" + (($out | Select-Object -Last 2) -join ' ')) }
    ($out | Select-Object -Last 1)
}

if ($WithE2e) {
    Run-Step '端到端验收' {
        # 必须先构建带 `e2e-mock` 的产物：`cargo test` / `clippy` 都不会写这个二进制，
        # 不构建就是在验一份**旧产物**——判断「代码改了、产物没更新」最费时间的一种假绿。
        # 构建与跑放在同一步里：构建失败这一步就抛错，绝不会带着旧二进制继续跑 e2e。
        $build = & cargo build --manifest-path (Join-Path $repoRoot 'Cargo.toml') -p wt-desktop --features e2e-mock 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw ("构建 e2e-mock 产物失败（退出码 " + $LASTEXITCODE + "）" + $nl + (($build | Select-Object -Last 6) -join $nl))
        }
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
