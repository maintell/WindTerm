#!/usr/bin/env pwsh
# 版本一致性检查（发布前必跑项，见 docs/design/14-build-release.md §7）
#
# 比对 Cargo.toml / apps/wt-desktop/tauri.conf.json 的版本号，并确认 CHANGELOG.md
# 里有该版本的 ## [x.y.z] 小节。版本号不一致会导致「安装包版本与程序内版本不同」
# 这种低级但致命的问题；runner 只编译发布，这个检查必须在本地完成。
#
# 用法：pwsh ./scripts/check-version.ps1
# 退出码：0 = 三处一致且 CHANGELOG 有对应小节；1 = 任一处不一致/缺失

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$cargoPath = Join-Path $repoRoot 'Cargo.toml'
$confPath = Join-Path $repoRoot 'apps/wt-desktop/tauri.conf.json'
$chgPath = Join-Path $repoRoot 'CHANGELOG.md'

function Fail([string]$msg) { Write-Host ('FAIL ' + $msg) -ForegroundColor Red; exit 1 }

if (-not (Test-Path $cargoPath)) { Fail '找不到 Cargo.toml' }
if (-not (Test-Path $confPath)) { Fail '找不到 apps/wt-desktop/tauri.conf.json' }
if (-not (Test-Path $chgPath)) { Fail '找不到 CHANGELOG.md（发布前必须有变更日志）' }

# Cargo.toml：[workspace.package] 下的 version = "x.y.z"
$cargoVer = [regex]::Match((Get-Content -Raw -Encoding UTF8 $cargoPath), '(?m)^\s*version\s*=\s*"([^"]+)"\s*$')
if (-not $cargoVer.Success) { Fail 'Cargo.toml 里读不到 [workspace.package] version' }
$cargoVer = $cargoVer.Groups[1].Value

# tauri.conf.json：顶层 version 字段
$confText = Get-Content -Raw -Encoding UTF8 $confPath
$confVer = [regex]::Match($confText, '"version"\s*:\s*"([^"]+)"')
if (-not $confVer.Success) { Fail 'tauri.conf.json 里读不到 version' }
$confVer = $confVer.Groups[1].Value

if ($cargoVer -ne $confVer) {
    Fail ("版本不一致：Cargo.toml=$cargoVer / tauri.conf.json=$confVer")
}

# CHANGELOG：必须有 ## [x.y.z]（允许带 - Unreleased / - YYYY-MM-DD 等后缀）小节
$chgText = Get-Content -Raw -Encoding UTF8 $chgPath
$heading = [regex]::Escape($cargoVer)
if (-not ($chgText -match ('(?m)^##\s*\[' + $heading + '\]')) ) {
    Fail ("CHANGELOG.md 缺少版本小节 ## [$cargoVer]（发布前该版本必须有变更记录）")
}

Write-Host ('PASS 版本一致：Cargo.toml / tauri.conf.json / CHANGELOG.md 均为 ' + $cargoVer) -ForegroundColor Green
exit 0