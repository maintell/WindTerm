//! 配置模型与读写。
//!
//! 设计依据：`docs/design/04-data-model.md` §5、`docs/spec/12-func-settings-extensions.md` §2。
//!
//! 三个刻意的选择：
//! 1. **TOML 而非 INI**：可表达嵌套、可 diff、可进 Git、可被企业配置管理系统下发。
//! 2. **`deny_unknown_fields`**：用户手改配置打错字段名应当报错，而不是静默忽略。
//! 3. **`toml_edit` 保存**：保留用户写的注释，否则「配置文件可手改」这个承诺是假的。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use wt_common::{HintAction, WtError};

// ─────────────────────────────────────────────────────────────
// 配置结构
// ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub general: General,
    pub terminal: TerminalCfg,
    pub appearance: Appearance,
    pub files: FilesCfg,
    pub graphics: GraphicsCfg,
    pub network: NetworkCfg,
    pub security: SecurityCfg,
    pub advanced: AdvancedCfg,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct General {
    pub language: String,
    /// `restore` | `empty` | `workspace:<id>`
    pub startup: String,
    /// `tray` | `quit` | `ask`
    pub close_action: String,
    pub check_updates: bool,
    /// 本地终端默认 shell；空 = 自动探测
    pub default_shell: String,
}

impl Default for General {
    fn default() -> Self {
        Self {
            language: "zh-CN".into(),
            startup: "restore".into(),
            close_action: "tray".into(),
            check_updates: true,
            default_shell: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct TerminalCfg {
    pub font_family: Vec<String>,
    pub font_size: u16,
    pub line_height: f32,
    pub scrollback: u32,
    pub charset: String,
    /// `block` | `bar` | `underline`
    pub cursor_style: String,
    /// `visual` | `none` | `sound` | `notify`
    pub bell: String,
    pub paste: PasteCfg,
    pub logging: LoggingCfg,
}

impl Default for TerminalCfg {
    fn default() -> Self {
        Self {
            font_family: vec!["JetBrains Mono".into(), "Consolas".into(), "monospace".into()],
            font_size: 13,
            line_height: 1.2,
            scrollback: 10_000,
            charset: "utf-8".into(),
            cursor_style: "block".into(),
            bell: "visual".into(),
            paste: PasteCfg::default(),
            logging: LoggingCfg::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct PasteCfg {
    pub warn_multi_line: bool,
    pub right_click_paste: bool,
    pub bracketed_paste: bool,
    /// 按行粘贴的延迟（毫秒），0 = 不延迟
    pub line_delay_ms: u32,
}

impl Default for PasteCfg {
    fn default() -> Self {
        Self {
            warn_multi_line: true,
            right_click_paste: false,
            bracketed_paste: true,
            line_delay_ms: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct LoggingCfg {
    pub enabled: bool,
    pub directory: String,
    /// `plain` | `ansi` | `raw`
    pub mode: String,
    pub max_file_mb: u32,
    pub keep_files: u32,
    /// 记录输入（默认关闭，开启会记录敏感内容）
    pub record_input: bool,
}

impl Default for LoggingCfg {
    fn default() -> Self {
        Self {
            enabled: false,
            directory: String::new(),
            mode: "plain".into(),
            max_file_mb: 10,
            keep_files: 5,
            record_input: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Appearance {
    /// `light` | `dark` | `system`
    pub theme: String,
    /// `compact` | `normal` | `comfortable`
    pub density: String,
    pub sidebar_width: u16,
    /// 终端配色方案名；空 = 跟随 UI 主题
    pub terminal_color_scheme: String,
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            density: "normal".into(),
            sidebar_width: 260,
            terminal_color_scheme: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct FilesCfg {
    /// `builtin` | 外部编辑器命令
    pub default_editor: String,
    pub transfer_concurrency: u8,
    /// `ask` | `overwrite` | `skip` | `rename`
    pub conflict_policy: String,
    /// 超过该大小的文件用外部编辑器打开（MB）
    pub editor_max_mb: u32,
    pub verify_after_transfer_mb: u32,
}

impl Default for FilesCfg {
    fn default() -> Self {
        Self {
            default_editor: "builtin".into(),
            transfer_concurrency: 4,
            conflict_policy: "ask".into(),
            editor_max_mb: 20,
            verify_after_transfer_mb: 100,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct GraphicsCfg {
    pub rdp_default_color_depth: u8,
    pub rdp_default_egfx: bool,
    /// `fit` | `1:1` | `custom`
    pub vnc_default_scale: String,
    /// `png` | `jpeg`
    pub capture_format: String,
}

impl Default for GraphicsCfg {
    fn default() -> Self {
        Self {
            rdp_default_color_depth: 32,
            rdp_default_egfx: true,
            vnc_default_scale: "fit".into(),
            capture_format: "png".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct NetworkCfg {
    pub keepalive_seconds: u32,
    pub connect_timeout_seconds: u32,
    /// 代理：`none` | `socks5` | `socks4` | `http`
    pub proxy_kind: String,
    pub proxy_host: String,
    pub proxy_port: u16,
    /// 离线模式：阻断除目标连接外的全部出站
    pub offline_mode: bool,
}

impl Default for NetworkCfg {
    fn default() -> Self {
        Self {
            keepalive_seconds: 30,
            connect_timeout_seconds: 10,
            proxy_kind: "none".into(),
            proxy_host: String::new(),
            proxy_port: 0,
            offline_mode: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SecurityCfg {
    pub save_password: bool,
    /// 空闲锁定分钟数，0 = 关闭
    pub auto_lock_minutes: u32,
    pub lock_on_system_lock: bool,
    /// `master-password` | `keychain-unlock` | `keychain-only`
    pub vault_mode: String,
    pub require_host_key_check: bool,
}

impl Default for SecurityCfg {
    fn default() -> Self {
        Self {
            save_password: true,
            auto_lock_minutes: 15,
            lock_on_system_lock: true,
            vault_mode: "master-password".into(),
            require_host_key_check: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AdvancedCfg {
    /// `error` | `warn` | `info` | `debug` | `trace`
    pub log_level: String,
    pub experimental: Vec<String>,
}

impl Default for AdvancedCfg {
    fn default() -> Self {
        Self {
            log_level: "info".into(),
            experimental: Vec::new(),
        }
    }
}

// ─────────────────────────────────────────────────────────────
// 解析
// ─────────────────────────────────────────────────────────────

impl Config {
    /// 从 TOML 文本解析。字段名拼错时给出近似建议。
    pub fn from_toml_str(text: &str) -> Result<Self, WtError> {
        match toml::from_str::<Config>(text) {
            Ok(cfg) => Ok(cfg),
            Err(e) => Err(explain_parse_error(text, &e)),
        }
    }

    pub fn to_toml_string(&self) -> Result<String, WtError> {
        toml::to_string_pretty(self).map_err(|e| {
            WtError::new("CFG_SERIALIZE_FAILED")
                .message("配置序列化失败")
                .detail(e.to_string())
        })
    }
}

/// 把 toml 的解析错误翻译成带建议的用户错误。
fn explain_parse_error(text: &str, e: &toml::de::Error) -> WtError {
    let raw = e.to_string();

    // toml 0.8 的未知字段消息形如：`unknown field `termnal`, expected one of ...`
    if let Some(field) = extract_quoted(&raw, "unknown field `") {
        let candidates = known_top_level_fields();
        let suggestion = nearest(&field, &candidates);
        let mut err = WtError::new("CFG_UNKNOWN_FIELD")
            .message(format!("配置中有未知字段「{field}」"))
            .detail(raw.clone());
        if let Some(s) = suggestion {
            err = err.hint(
                format!("改成 `{s}`"),
                HintAction::ApplyFix {
                    fix: format!("config.rename:{field}->{s}"),
                },
            );
        }
        return err;
    }

    WtError::new("CFG_INVALID_TOML")
        .message("配置文件格式不正确")
        .detail(format!("{raw}\n---\n{}", preview_around(text, e.span())))
}

fn preview_around(text: &str, span: Option<std::ops::Range<usize>>) -> String {
    let Some(span) = span else {
        return String::new();
    };
    let start = span.start.saturating_sub(40);
    let end = (span.end + 40).min(text.len());
    // 保证落在 char 边界上
    let mut s = start;
    while s > 0 && !text.is_char_boundary(s) {
        s -= 1;
    }
    let mut e = end;
    while e < text.len() && !text.is_char_boundary(e) {
        e += 1;
    }
    format!("…{}…", &text[s..e])
}

fn extract_quoted(haystack: &str, marker: &str) -> Option<String> {
    let idx = haystack.find(marker)? + marker.len();
    let rest = &haystack[idx..];
    let end = rest.find('`')?;
    Some(rest[..end].to_string())
}

fn known_top_level_fields() -> Vec<&'static str> {
    vec![
        "general",
        "terminal",
        "appearance",
        "files",
        "graphics",
        "network",
        "security",
        "advanced",
    ]
}

/// 编辑距离 ≤ 2 时给出建议。
fn nearest<'a>(input: &str, candidates: &[&'a str]) -> Option<&'a str> {
    let mut best: Option<(usize, &str)> = None;
    for c in candidates {
        let d = levenshtein(input, c);
        if d <= 2 && best.map_or(true, |(bd, _)| d < bd) {
            best = Some((d, c));
        }
    }
    best.map(|(_, c)| c)
}

fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0usize; b.len() + 1];
    for i in 1..=a.len() {
        cur[0] = i;
        for j in 1..=b.len() {
            let cost = if a[i - 1] == b[j - 1] { 0 } else { 1 };
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

// ─────────────────────────────────────────────────────────────
// 分层合并
// ─────────────────────────────────────────────────────────────

/// 配置来源，按优先级从低到高排列。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    Default,
    System(PathBuf),
    User(PathBuf),
    Cli,
}

/// 深合并两个 TOML 值：`overlay` 中出现的键覆盖 `base`，未出现的保留。
pub fn merge_values(base: &mut toml::Value, overlay: &toml::Value) {
    match (base, overlay) {
        (toml::Value::Table(b), toml::Value::Table(o)) => {
            for (k, v) in o {
                match b.get_mut(k) {
                    Some(existing) => merge_values(existing, v),
                    None => {
                        b.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        (b, o) => *b = o.clone(),
    }
}

/// 按「系统级 → 用户级」顺序加载并合并。
///
/// 只覆盖**显式出现**的字段：这是「用户在 config.toml 里只写了一个字段」也能正确工作的前提。
pub fn load_layered(system: Option<(&Path, &str)>, user: Option<(&Path, &str)>) -> Result<Config, WtError> {
    let mut merged = toml::Value::try_from(Config::default()).map_err(|e| {
        WtError::new("CFG_SERIALIZE_FAILED").message("默认配置无法序列化").detail(e.to_string())
    })?;

    let mut sources = Vec::new();
    for (path, text) in [system, user].into_iter().flatten() {
        let v: toml::Value = toml::from_str(text).map_err(|e| explain_parse_error(text, &e))?;
        merge_values(&mut merged, &v);
        sources.push(Source::System(path.to_path_buf()));
    }

    let cfg: Config = merged.try_into().map_err(|e: toml::de::Error| {
        WtError::new("CFG_INVALID_TOML")
            .message("合并后的配置无法解析")
            .detail(e.to_string())
    })?;
    Ok(cfg)
}

// ─────────────────────────────────────────────────────────────
// 保存（保留注释）
// ─────────────────────────────────────────────────────────────

/// 把配置写回 TOML 文本，**保留原文件中的注释与顺序**。
pub fn apply_to_document(existing: &str, cfg: &Config) -> Result<String, WtError> {
    let mut doc: toml_edit::DocumentMut = existing.parse().unwrap_or_default();

    let as_value = toml::Value::try_from(cfg).map_err(|e| {
        WtError::new("CFG_SERIALIZE_FAILED").message("配置无法序列化").detail(e.to_string())
    })?;
    merge_into_document(&mut doc, &as_value);

    Ok(doc.to_string())
}

fn merge_into_document(doc: &mut toml_edit::DocumentMut, value: &toml::Value) {
    let toml::Value::Table(t) = value else { return };
    for (k, v) in t {
        match v {
            toml::Value::Table(sub) => {
                if !doc.contains_key(k) {
                    doc.insert(k, toml_edit::Item::Table(toml_edit::Table::new()));
                }
                if let Some(item) = doc.get_mut(k) {
                    if let Some(tbl) = item.as_table_mut() {
                        for (sk, sv) in sub {
                            set_table_value(tbl, sk, sv);
                        }
                    }
                }
            }
            _ => {
                let newv = to_edit_value(v);
                match doc.get_mut(k) {
                    Some(existing) => replace_preserving_decor(existing, newv),
                    None => {
                        doc.insert(k, toml_edit::Item::Value(newv));
                    }
                }
            }
        }
    }
}

fn set_table_value(tbl: &mut toml_edit::Table, key: &str, v: &toml::Value) {
    match v {
        toml::Value::Table(sub) => {
            if !tbl.contains_key(key) {
                tbl.insert(key, toml_edit::Item::Table(toml_edit::Table::new()));
            }
            if let Some(item) = tbl.get_mut(key) {
                if let Some(t) = item.as_table_mut() {
                    for (sk, sv) in sub {
                        set_table_value(t, sk, sv);
                    }
                }
            }
        }
        _ => {
            let newv = to_edit_value(v);
            match tbl.get_mut(key) {
                Some(existing) => replace_preserving_decor(existing, newv),
                None => {
                    tbl.insert(key, toml_edit::Item::Value(newv));
                }
            }
        }
    }
}

/// 替换值，但保留原有的装饰（行尾注释、缩进、前后空白）。
///
/// 直接 `*slot = Item::Value(new)` 会把 `# 行尾注释` 一起丢掉——
/// 那等于把用户写在配置文件里的注释吃掉，与「可手改」的承诺矛盾。
fn replace_preserving_decor(slot: &mut toml_edit::Item, mut newv: toml_edit::Value) {
    if let Some(old) = slot.as_value() {
        *newv.decor_mut() = old.decor().clone();
    }
    *slot = toml_edit::Item::Value(newv);
}
fn to_edit_value(v: &toml::Value) -> toml_edit::Value {
    match v {
        toml::Value::String(s) => toml_edit::Value::from(s.clone()),
        toml::Value::Integer(i) => toml_edit::Value::from(*i),
        toml::Value::Float(f) => toml_edit::Value::from(*f),
        toml::Value::Boolean(b) => toml_edit::Value::from(*b),
        toml::Value::Datetime(d) => toml_edit::Value::from(d.to_string()),
        toml::Value::Array(a) => {
            let mut arr = toml_edit::Array::new();
            for item in a {
                arr.push(to_edit_value(item));
            }
            toml_edit::Value::Array(arr)
        }
        toml::Value::Table(t) => {
            let mut inline = toml_edit::InlineTable::new();
            for (k, val) in t {
                inline.insert(k, to_edit_value(val));
            }
            toml_edit::Value::InlineTable(inline)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_roundtrips() {
        let cfg = Config::default();
        let text = cfg.to_toml_string().unwrap();
        let back = Config::from_toml_str(&text).unwrap();
        assert_eq!(cfg, back);
    }

    #[test]
    fn partial_toml_uses_defaults_for_missing_fields() {
        let text = r#"
[terminal]
font_size = 15
"#;
        let cfg = Config::from_toml_str(text).unwrap();
        assert_eq!(cfg.terminal.font_size, 15);
        // 未出现的字段保持默认
        assert_eq!(cfg.terminal.scrollback, 10_000);
        assert_eq!(cfg.general.language, "zh-CN");
    }

    #[test]
    fn unknown_top_level_field_is_rejected_with_suggestion() {
        let text = r#"
[termnal]
font_size = 15
"#;
        let err = Config::from_toml_str(text).unwrap_err();
        assert_eq!(err.code, "CFG_UNKNOWN_FIELD");
        assert!(err.message.contains("termnal"));
        assert!(
            err.hints.iter().any(|h| h.label.contains("terminal")),
            "应建议改成 terminal，实际 hints: {:?}",
            err.hints
        );
    }

    #[test]
    fn unknown_nested_field_is_rejected() {
        let text = r#"
[terminal]
fontsize = 15
"#;
        let err = Config::from_toml_str(text).unwrap_err();
        assert_eq!(err.code, "CFG_UNKNOWN_FIELD");
        assert!(err.message.contains("fontsize"));
    }

    #[test]
    fn invalid_toml_reports_location_preview() {
        let text = "[terminal\nfont_size = 15";
        let err = Config::from_toml_str(text).unwrap_err();
        assert_eq!(err.code, "CFG_INVALID_TOML");
        assert!(err.detail.is_some());
    }

    #[test]
    fn layered_merge_overrides_only_present_keys() {
        let system = r#"
[terminal]
font_size = 12
scrollback = 5000

[general]
language = "en-US"
"#;
        let user = r#"
[terminal]
font_size = 16
"#;
        let cfg = load_layered(
            Some((Path::new("system.toml"), system)),
            Some((Path::new("user.toml"), user)),
        )
        .unwrap();

        assert_eq!(cfg.terminal.font_size, 16, "用户覆盖生效");
        assert_eq!(cfg.terminal.scrollback, 5000, "系统级未被子覆盖");
        assert_eq!(cfg.general.language, "en-US", "系统级语言生效");
    }

    #[test]
    fn merge_values_deep_merges_tables() {
        let mut base: toml::Value = toml::from_str("[a]\nx = 1\ny = 2").unwrap();
        let overlay: toml::Value = toml::from_str("[a]\ny = 3\n[a.b]\nz = 4").unwrap();
        merge_values(&mut base, &overlay);
        let a = base.get("a").unwrap();
        assert_eq!(a.get("x").unwrap().as_integer(), Some(1));
        assert_eq!(a.get("y").unwrap().as_integer(), Some(3));
        assert_eq!(a.get("b").unwrap().get("z").unwrap().as_integer(), Some(4));
    }

    #[test]
    fn saving_preserves_comments() {
        let existing = r#"# 这是我自己加的注释，不能被冲掉
[terminal]
font_size = 13  # 行尾注释也要保留
"#;
        let mut cfg = Config::default();
        cfg.terminal.font_size = 16;

        let out = apply_to_document(existing, &cfg).unwrap();
        assert!(out.contains("# 这是我自己加的注释，不能被冲掉"), "顶部注释丢失:\n{out}");
        assert!(out.contains("# 行尾注释也要保留"), "行尾注释丢失:\n{out}");
        assert!(out.contains("font_size = 16"), "值未更新:\n{out}");
    }

    #[test]
    fn saving_into_empty_document_produces_valid_toml() {
        let out = apply_to_document("", &Config::default()).unwrap();
        let back = Config::from_toml_str(&out).unwrap();
        assert_eq!(back, Config::default());
    }

    #[test]
    fn levenshtein_basics() {
        assert_eq!(levenshtein("abc", "abc"), 0);
        assert_eq!(levenshtein("abc", "abd"), 1);
        assert_eq!(levenshtein("", "abc"), 3);
        assert_eq!(levenshtein("termnal", "terminal"), 1);
    }

    #[test]
    fn nearest_picks_close_match_only() {
        assert_eq!(nearest("termnal", &["terminal", "general"]), Some("terminal"));
        assert_eq!(nearest("zzzzzz", &["terminal", "general"]), None);
    }
}
