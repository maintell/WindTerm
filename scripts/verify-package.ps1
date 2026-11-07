#!/usr/bin/env pwsh
# WindTerm 便携包本地验证（SYS-008）
#
# 复现 .github/workflows/release.yml 的打包步骤，但**不推任何 tag、不发 Release**：
# release 编译 → 便携 zip → SHA256SUMS，并校验压缩包内容与哈希对得上。
# 目的是让「打包链路」有一条可重复的本地证据，而不是只能等 CI 碰运气。
#
# 用法：pwsh ./scripts/verify-package.ps1 [-SkipBuild]
#   -SkipBuild  跳过 cargo build --release（刚编过时用），只重做打包与校验
# 退出码：0 = 链路通，1 = 有环节失败

[CmdletBinding()]
param([switch] $SkipBuild)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $repoRoot 'target/release/wt-desktop.exe'
$dist = Join-Path $repoRoot 'target/dist-verify'
# 固定标签：本地验证不产生真实版本，也不与任何 git tag 挂钩
$tag = 'v0.0.0-local-verify'
$zipName = "WindTerm-$tag-windows-x64-portable.zip"

if (-not $SkipBuild) {
    Write-Host '=== release 编译 ==='
    Push-Location $repoRoot
    try {
        & cargo build --release -p wt-desktop
        if ($LASTEXITCODE -ne 0) { throw "cargo build --release 失败（退出码 $LASTEXITCODE）" }
    } finally { Pop-Location }
}
if (-not (Test-Path $exe)) { throw "找不到 release 产物：$exe（先不带 -SkipBuild 跑一次）" }

Write-Host '=== 打便携 zip + SHA256SUMS ==='
if (Test-Path $dist) { Remove-Item -LiteralPath $dist -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dist | Out-Null
Copy-Item $exe (Join-Path $dist 'WindTerm.exe')
$zip = Join-Path $dist $zipName
Compress-Archive -Path (Join-Path $dist 'WindTerm.exe') -DestinationPath $zip -Force
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
# 明确 no BOM：带 BOM 的 SHA256SUMS.txt 会让 sha256sum -c 失效
$line = "$hash  $zipName"
[IO.File]::WriteAllText((Join-Path $dist 'SHA256SUMS.txt'), $line + "`n", (New-Object System.Text.UTF8Encoding $false))

Write-Host '=== 校验 ==='
$sumFile = Join-Path $dist 'SHA256SUMS.txt'
$first3 = [IO.File]::ReadAllBytes($sumFile)[0..2]
if ($first3[0] -eq 0xEF -and $first3[1] -eq 0xBB -and $first3[2] -eq 0xBF) { throw 'SHA256SUMS.txt 带 BOM，sha256sum -c 会失效' }
$recorded = (Get-Content $sumFile -Raw).Trim().Split(' ', 2)[0]
if ($recorded -ne $hash) { throw "记录的哈希 $recorded 与实算 $hash 不一致" }
# 解包验证里面确实是 WindTerm.exe，且字节与源一致
$unzip = Join-Path $dist 'unzip-check'
Expand-Archive -Path $zip -DestinationPath $unzip -Force
$inner = Join-Path $unzip 'WindTerm.exe'
if (-not (Test-Path $inner)) { throw 'zip 里没有 WindTerm.exe' }
$srcHash = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower()
$inHash = (Get-FileHash $inner -Algorithm SHA256).Hash.ToLower()
if ($srcHash -ne $inHash) { throw 'zip 里的 exe 与 release 产物字节不一致' }

Write-Host ('exe  ' + (Get-Item $exe).Length + ' 字节')
Write-Host ('zip  ' + (Get-Item $zip).Length + ' 字节')
Write-Host ('sha256  ' + $hash)
Write-Host '便携包链路验证通过（本地，不代表已发 CI Release）。'
