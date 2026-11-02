# 详细设计 · 14 · 构建、打包与发布

实现需求：`SYS-007` `SYS-008` `SEC-014`、`NFR-022` `NFR-023`
关键约束：检查在本地做，runner 只负责编译与发布（一次发版一条流水线）

## 1. 职责划分

这条分工是刻意的，原因是成本：

| 阶段 | 在哪做 | 内容 |
|---|---|---|
| **检查** | 本地（提交前） | 格式、clippy、单测、集成测试、兼容矩阵子集、文档一致性、体积预估 |
| **编译** | CI runner | 三平台编译、签名、打包 |
| **发布** | CI runner | 上传 Release、生成 SBOM、更新清单 |

**为什么检查不在 CI**：三平台编译一次约 20~40 分钟。如果在 CI 里既编译又跑全量测试，一次失败要等 40 分钟才知道。本地 `just check` 5 分钟内能跑完全部静态检查与核心测试。

**CI 只做「本地做不到的事」**：三平台编译、代码签名、公证、上传。

## 2. 本地检查脚本

```bash
# justfile
check: fmt lint test docs size
    @echo "✅ 全部检查通过"

fmt:
    cargo fmt --all -- --check
    pnpm -C ui format:check

lint:
    cargo clippy --all-targets --all-features -- -D warnings
    cargo deny check
    pnpm -C ui lint

test:
    cargo test --workspace --all-features
    pnpm -C ui test --run
    cargo test --workspace --test e2e_local   # 不依赖外部服务端的 E2E

docs:
    pwsh ./scripts/check-docs.ps1    # ✅ 已实现：ID 闭合 + 死链 + ADR 一致 + 统计自洽
    # 待实现（随对应代码落地）：
    #   scripts/check-i18n.ps1       语言文件键对齐
    #   scripts/check-ts-types.ps1   ts-rs 生成结果与提交一致

size:
    cargo build --release --bin wt-desktop
    # 待实现：scripts/check-size.ps1，对照 NFR-022 阈值
```

> **实现状态**：只有 `check-docs.ps1` 已存在（因为文档已经存在，检查对象具备）。
> 其余脚本在对应代码出现时实现——先有检查对象再有脚本，不写空跑的脚本。
> 用 `.ps1` 而非 `.sh`：PowerShell 7 在 Windows/macOS/Linux 都可用，避免 Windows 上还要装 bash。

**`just check` 是提交前的唯一门槛。** 开发者不需要跑 CI 才知道会不会挂。

## 3. 依赖与许可门禁

```toml
# deny.toml
[licenses]
allow = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC",
         "Unicode-3.0", "Zlib", "MPL-2.0", "CC0-1.0", "Unlicense"]
deny = ["GPL-2.0", "GPL-3.0", "AGPL-3.0"]

[[licenses.exceptions]]
name = "some-crate"
allow = ["GPL-3.0"]      # 必须逐条登记，并在 spec/01 §5.2 记录

[bans]
multiple-versions = "warn"
deny = [
  { name = "openssl-sys", reason = "使用 rustls，避免系统 OpenSSL 依赖" },
]

[advisories]
db-urls = ["https://github.com/rustsec/advisory-db"]
vulnerability = "deny"
unmaintained = "warn"
```

**GPL 类依赖默认拒绝**。需要引入时必须：
1. 在 `spec/01` §5.2 表格登记；
2. 在 `deny.toml` 加例外并写理由；
3. 确认分发方式符合许可（通常是「独立进程 + 不随主包」）。

## 4. 构建产物

| 平台 | 产物 | 内容 |
|---|---|---|
| Windows x64/arm64 | `WindTerm-<ver>-x64.msi`、`WindTerm-<ver>-x64.zip` | MSI 每用户安装（无需管理员）+ 便携 zip |
| macOS universal2 | `WindTerm-<ver>.dmg` | arm64 + x86_64，已公证 |
| Linux x64/arm64 | `WindTerm-<ver>-x86_64.AppImage`、`.deb`、`.rpm` | |

### 4.1 打包配置

```jsonc
// apps/wt-desktop/tauri.conf.json（节选）
{
  "productName": "WindTerm",
  "identifier": "dev.windterm.app",
  "bundle": {
    "active": true,
    "targets": ["msi", "nsis", "dmg", "appimage", "deb", "rpm"],
    "resources": [
      "resources/coreutils/*",
      "resources/fonts/JetBrainsMono-*.ttf",
      "resources/themes/*.json"
    ],
    "windows": {
      "wix": { "language": ["zh-CN", "en-US"] },
      "webviewInstallMode": { "type": "downloadBootstrapper" }
    },
    "macOS": {
      "minimumSystemVersion": "12.0",
      "entitlements": "entitlements.plist"
    },
    "linux": {
      "deb": { "depends": ["libwebkit2gtk-4.1-0", "libgtk-3-0"] }
    }
  }
}
```

**WebView2 的处理**：`downloadBootstrapper` 表示「安装时若缺失则下载」。企业内网无外网时需要「离线安装包」变体（内嵌 Evergreen Standalone Installer，约 +130 MB）——作为单独产物提供，不进主包（`NFR-022`）。

### 4.2 体积控制

| 组成 | 目标 | 手段 |
|---|---|---|
| Rust 主程序 | 25 MB | `opt-level = "s"`、`lto = "fat"`、`strip = "symbols"`、`panic = "unwind"`（不能用 abort，见 `design/01` §2.1） |
| 前端资源 | 8 MB | 代码分割、tree-shaking、字体子集化 |
| coreutils | 6 MB | 多调用二进制 + `upx`（可选，注意杀软误报） |
| 字体 | 2 MB | 只打包 Regular + Bold 的 Latin + CJK 子集 |
| 图标 | 0.5 MB | SVG → PNG 多尺寸，只保留必要尺寸 |

**CI 体积检查**：超过阈值 5% 时列出增长来源（`cargo bloat --release --crates`）。

## 5. 供应链安全

| 措施 | 实现 |
|---|---|
| 依赖锁定 | 提交 `Cargo.lock` 与 `pnpm-lock.yaml`；构建用 `--locked` / `--frozen-lockfile` |
| 工具链固定 | `rust-toolchain.toml` 指定精确版本 |
| 可复现构建 | `SOURCE_DATE_EPOCH`、`--remap-path-prefix`、固定 `RUSTFLAGS` |
| SBOM | `cargo cyclonedx` 生成，随 Release 上传 |
| 第三方二进制校验 | OpenH264 等：记录来源 URL + SHA-256，构建时校验 |
| 签名 | Windows Authenticode（EV 证书）；macOS Developer ID + notarytool；Linux 提供 `.sig`（minisign） |
| 更新清单签名 | ed25519，公钥内置 |

**OpenH264 的特殊处理**（`spec/01` §5.3）

```bash
# 只使用 Cisco 官方二进制，不自行编译
OPENH264_VERSION=2.4.1
OPENH264_SHA256=...   # 记录在 scripts/third-party.lock

curl -L -o openh264.dll \
  "https://ciscobinary.openh264.org/libopenh264-${OPENH264_VERSION}-win64.dll.bz2"
echo "${OPENH264_SHA256}  openh264.dll" | sha256sum -c -
```

**不得**用 `cargo build` 从源码编译 OpenH264——那会失去 Cisco 承担的专利授权。

## 6. 发布流水线

### 6.1 触发条件

```yaml
# .github/workflows/release.yml
on:
  push:
    tags: ["v*"]          # 唯一的自动触发
  workflow_dispatch:
    inputs:
      tag:
        description: "必须是已存在的发版 tag"
        required: true
```

**明确不做的事**

| 不做 | 理由 |
|---|---|
| `push: branches: [main]` 触发打包 | 每次提交都编译三平台，浪费且无意义 |
| `pull_request` 触发打包 | PR 只需要检查，不需要产物 |
| 多套 workflow 并行打包 | 一次发版只能有一条流水线（避免重复上传同一批资产） |

### 6.2 并发组

```yaml
concurrency:
  group: release        # 固定名，不按 event_name 区分
  cancel-in-progress: false
```

**固定组名是关键**：若按 `github.event_name` 区分，`push tag` 与 `workflow_dispatch` 会各成一组并行跑，两个 job 同时上传同一批资产 → 冲突或覆盖。

### 6.3 手动派发的前置校验

```yaml
jobs:
  guard:
    if: github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - name: 校验 ref 指向发版 tag
        run: |
          TAG="${{ inputs.tag }}"
          if ! git rev-parse "refs/tags/$TAG" >/dev/null 2>&1; then
            echo "::error::tag $TAG 不存在"; exit 1
          fi
          if [[ ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+ ]]; then
            echo "::error::tag $TAG 不符合 vX.Y.Z 格式"; exit 1
          fi
```

**没有这个校验，手动派发可以指向任意分支，产出「看起来像发版」的包。**

### 6.4 矩阵构建

```yaml
  build:
    needs: guard
    if: always() && (needs.guard.result == 'success' || needs.guard.result == 'skipped')
    strategy:
      fail-fast: false
      matrix:
        include:
          - { os: windows-latest, target: x86_64-pc-windows-msvc,  arch: x64 }
          - { os: windows-latest, target: aarch64-pc-windows-msvc, arch: arm64 }
          - { os: macos-14,       target: universal-apple-darwin,   arch: universal }
          - { os: ubuntu-22.04,   target: x86_64-unknown-linux-gnu, arch: x64 }
          - { os: ubuntu-22.04,   target: aarch64-unknown-linux-gnu, arch: arm64 }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with: { targets: ${{ matrix.target }} }
      - uses: pnpm/action-setup@v4
      - run: pnpm -C ui install --frozen-lockfile
      - run: pnpm -C ui build
      - run: cargo build --release --locked --target ${{ matrix.target }}
      - run: ./scripts/package.sh ${{ matrix.target }}
      - uses: actions/upload-artifact@v4
        with: { name: dist-${{ matrix.arch }}, path: dist/ }
```

**runner 里不跑测试**：测试在本地已跑过；CI 再跑一遍只会拉长反馈时间，且 CI 环境与本地不一致时会产生「本地绿 CI 红」的噪音。唯一例外是**冒烟测试**（安装包能装、能启动），在发布后由独立的 `smoke` job 做。

### 6.5 发布 job

```yaml
  publish:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
      - name: 生成 SBOM
        run: cargo cyclonedx --format json --output sbom.json
      - name: 生成更新清单
        run: ./scripts/gen-manifest.sh > manifest.json
      - name: 签名清单
        run: minisign -Sm manifest.json -s "$MINISIGN_KEY"
      - uses: softprops/action-gh-release@v2
        with:
          files: |
            dist/**/*.msi
            dist/**/*.zip
            dist/**/*.dmg
            dist/**/*.AppImage
            dist/**/*.deb
            dist/**/*.rpm
            manifest.json
            manifest.json.minisig
            sbom.json
```

## 7. 版本号与变更日志

| 项 | 规则 |
|---|---|
| 版本号 | SemVer；预发布用 `-beta.1` |
| Tag | `v1.2.3`（必须与 `Cargo.toml` 的 `version` 一致） |
| 一致性检查 | `scripts/check-version.sh` 比对 `Cargo.toml` / `tauri.conf.json` / `CHANGELOG.md` |
| CHANGELOG | 每个版本一个 `## [x.y.z] - YYYY-MM-DD` 小节；分类 `Added/Changed/Fixed/Removed/Security` |
| 变更条目 | 必须带需求 ID（`feat(SES-024): ...`） |

**`check-version.sh` 是发布前必跑项**——版本号不一致会导致「安装包版本与程序内版本不同」这种低级但致命的问题。

## 8. 发布后验证

```bash
# 干净环境（无开发工具）安装 → 启动 → 冒烟
wt doctor                    # 环境自检
wt bench startup --runs 3    # 启动可用
wt session list              # 数据层可用
```

**三平台各跑一次**，结果记录在 Release notes 的「验证」小节。

## 9. 与需求的对应

| 设计点 | 需求 |
|---|---|
| 本地检查门槛 | `NFR-019` 结构测试 |
| 依赖/许可门禁 | `SEC-014`、`spec/01` §5 |
| 三平台产物 | `SYS-008` |
| 体积控制 | `NFR-022` |
| WebView2 引导 | `SYS-008` |
| SBOM/可复现/签名 | `SEC-014` |
| 更新清单签名 | `SYS-007` |
| tag 触发 + 单一并发组 | 发布纪律（`spec/14` §8） |
| 版本一致性 | 发布门槛 |
