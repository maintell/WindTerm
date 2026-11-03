//! PuTTY `.ppk` 私钥转换。
//!
//! 迁移用户手里多半是 `.ppk`，而 `ssh-key` 只认 OpenSSH/PEM。这里把**未加密的
//! ed25519** `.ppk` 转成 OpenSSH 文本，其余情况给出可执行的错误——
//! 「格式无法识别」对用户没有任何帮助。
//!
//! 不支持的部分（有意为之，不是遗漏）：
//! - **带口令的 .ppk**：v3 用的是 Argon2id 派生 + HMAC 校验，自己实现等于重写一遍
//!   puttygen；用户用 puttygen 转一次更快也更安全；
//! - **RSA / DSA / ECDSA 类型**：转换需要按类型拼 mpint，收益不如直接提示转换。
//!
//! 两种情况的提示都写明了「用 puttygen 转成 OpenSSH」，这是用户真正能做的动作。

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use wt_common::{HintAction, WtError};

const HEADER: &str = "PuTTY-User-Key-File-";
const BOM: &[u8] = b"\xef\xbb\xbf";

fn bad(message: &str) -> WtError {
    WtError::new("PPK_INVALID")
        .message(format!(".ppk 文件无法解析：{message}"))
        .hint(
            "确认选的是 PuTTY 的 .ppk 私钥文件；也可以用 puttygen 转成 OpenSSH 格式",
            HintAction::None,
        )
}

/// 内容看起来是不是 PuTTY 的 `.ppk`。
///
/// 只看开头几十个字节，不把整个私钥读成字符串。
pub fn is_ppk(bytes: &[u8]) -> bool {
    let bytes = bytes.strip_prefix(BOM).unwrap_or(bytes);
    bytes.starts_with(HEADER.as_bytes())
}

/// 把 `.ppk` 转成 OpenSSH 私钥文本。
pub fn convert(bytes: &[u8]) -> Result<Vec<u8>, WtError> {
    let text = std::str::from_utf8(bytes).map_err(|_| bad("不是文本文件"))?;
    let parsed = parse(text)?;

    if parsed.encryption != "none" {
        return Err(WtError::new("PPK_ENCRYPTED")
            .message("这个 .ppk 带口令保护，暂不支持直接读取")
            .detail(format!("Encryption: {}", parsed.encryption))
            .hint(
                "用 puttygen 打开后另存为 OpenSSH 格式（Conversions → Export OpenSSH key）",
                HintAction::None,
            ));
    }

    match parsed.key_type.as_str() {
        "ssh-ed25519" => convert_ed25519(&parsed),
        other => Err(WtError::new("PPK_UNSUPPORTED_TYPE")
            .message(format!("暂不支持 {other} 类型的 .ppk"))
            .hint(
                "用 puttygen 转成 OpenSSH 格式（Conversions → Export OpenSSH key）",
                HintAction::None,
            )),
    }
}

struct Ppk {
    key_type: String,
    encryption: String,
    public: Vec<u8>,
    private: Vec<u8>,
}

fn parse(text: &str) -> Result<Ppk, WtError> {
    let mut lines = text.lines().map(str::trim);
    let first = lines.next().ok_or_else(|| bad("文件是空的"))?;
    let rest = first
        .strip_prefix(HEADER)
        .ok_or_else(|| bad("缺少 PuTTY-User-Key-File 头"))?;
    let (_version, key_type) = rest.split_once(':').ok_or_else(|| bad("头部格式不对"))?;
    let key_type = key_type.trim().to_string();

    let all: Vec<&str> = lines.collect();
    let mut encryption = String::new();
    let mut public = Vec::new();
    let mut private = Vec::new();

    let mut i = 0;
    while i < all.len() {
        let Some((key, value)) = all[i].split_once(':') else {
            i += 1;
            continue;
        };
        match key.trim() {
            "Encryption" => encryption = value.trim().to_string(),
            "Public-Lines" => {
                let n = count(value)?;
                public = decode_block(&all, i, n)?;
                i += n;
            }
            "Private-Lines" => {
                let n = count(value)?;
                private = decode_block(&all, i, n)?;
                i += n;
            }
            _ => {}
        }
        i += 1;
    }

    if public.is_empty() || private.is_empty() {
        return Err(bad("缺少 Public-Lines 或 Private-Lines"));
    }
    Ok(Ppk {
        key_type,
        encryption,
        public,
        private,
    })
}

fn count(value: &str) -> Result<usize, WtError> {
    value
        .trim()
        .parse::<usize>()
        .map_err(|_| bad("行数不是数字"))
}

/// 取 `index` 之后的 `n` 行 base64 并解码。
fn decode_block(lines: &[&str], index: usize, n: usize) -> Result<Vec<u8>, WtError> {
    let mut joined = String::new();
    for k in 1..=n {
        joined.push_str(lines.get(index + k).ok_or_else(|| bad("base64 行数不足"))?);
    }
    B64.decode(joined)
        .map_err(|_| bad("base64 解码失败"))
}

/// SSH 线格式里最小的读取器：只需要读「长度 + 字节」。
struct Wire<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Wire<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    fn string(&mut self) -> Result<&'a [u8], WtError> {
        let head = self
            .buf
            .get(self.pos..self.pos + 4)
            .ok_or_else(|| bad("数据被截断"))?;
        let len = u32::from_be_bytes([head[0], head[1], head[2], head[3]]) as usize;
        self.pos += 4;
        let body = self
            .buf
            .get(self.pos..self.pos + len)
            .ok_or_else(|| bad("长度越界"))?;
        self.pos += len;
        Ok(body)
    }
}

fn convert_ed25519(ppk: &Ppk) -> Result<Vec<u8>, WtError> {
    let mut public = Wire::new(&ppk.public);
    let declared = public.string()?;
    if declared != b"ssh-ed25519" {
        return Err(bad("公钥类型与头部不一致"));
    }
    let pub_key = public.string()?;
    if pub_key.len() != 32 {
        return Err(bad("ed25519 公钥长度不是 32 字节"));
    }

    let mut private = Wire::new(&ppk.private);
    let priv_key = private.string()?;
    if priv_key.len() != 64 {
        return Err(bad("ed25519 私钥长度不是 64 字节"));
    }

    let mut bytes = [0u8; 64];
    bytes.copy_from_slice(priv_key);
    let keypair = ssh_key::private::Ed25519Keypair::from_bytes(&bytes)
        .map_err(|_| bad("ed25519 私钥内容非法"))?;
    let key = ssh_key::PrivateKey::new(keypair.into(), "")
        .map_err(|_| bad("无法构造私钥"))?;
    let pem = key
        .to_openssh(ssh_key::LineEnding::LF)
        .map_err(|_| bad("无法导出 OpenSSH 格式"))?;
    Ok(pem.as_bytes().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put_string(out: &mut Vec<u8>, data: &[u8]) {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        out.extend_from_slice(data);
    }

    /// 用固定种子拼一个未加密的 ed25519 `.ppk`。
    ///
    /// 不能随便填 64 个字节：`Ed25519Keypair::from_bytes` 会校验公钥是否由私钥推出，
    /// 所以这里从种子派生出一对真实匹配的密钥。
    fn make_ppk(encryption: &str, key_type: &str) -> Vec<u8> {
        let keypair = ssh_key::private::Ed25519Keypair::from_seed(&[0x11u8; 32]);
        let raw = keypair.to_bytes(); // 64 字节 = 私钥(32) || 公钥(32)
        let pub_part = &raw[32..];

        let mut pub_blob = Vec::new();
        put_string(&mut pub_blob, key_type.as_bytes());
        put_string(&mut pub_blob, pub_part);

        let mut priv_blob = Vec::new();
        put_string(&mut priv_blob, &raw);
        put_string(&mut priv_blob, pub_part);
        put_string(&mut priv_blob, b"test");

        let pub_b64 = B64.encode(&pub_blob);
        let priv_b64 = B64.encode(&priv_blob);
        format!(
            "PuTTY-User-Key-File-2: {key_type}\n\
             Encryption: {encryption}\n\
             Comment: test\n\
             Public-Lines: 1\n{pub_b64}\n\
             Private-Lines: 1\n{priv_b64}\n\
             Private-MAC: 00\n"
        )
        .into_bytes()
    }

    #[test]
    fn detects_ppk_by_header() {
        assert!(is_ppk(b"PuTTY-User-Key-File-2: ssh-ed25519\n"));
        assert!(is_ppk(b"\xef\xbb\xbfPuTTY-User-Key-File-3: ssh-rsa\n"));
        assert!(!is_ppk(b"-----BEGIN OPENSSH PRIVATE KEY-----"));
    }

    #[test]
    fn converts_unencrypted_ed25519_to_openssh() {
        let ppk = make_ppk("none", "ssh-ed25519");
        let pem = convert(&ppk).expect("应能转换");

        let text = String::from_utf8_lossy(&pem);
        assert!(text.contains("BEGIN OPENSSH PRIVATE KEY"), "实际: {text}");
        // 转换结果必须能被自己的解析器接受，否则等于没转
        let key = ssh_key::PrivateKey::from_openssh(&pem).expect("应能解析转换结果");
        assert_eq!(key.algorithm().as_str(), "ssh-ed25519");
    }

    #[test]
    fn encrypted_ppk_gives_actionable_error() {
        let ppk = make_ppk("aes256-cbc", "ssh-ed25519");
        let err = convert(&ppk).unwrap_err();
        assert_eq!(err.code, "PPK_ENCRYPTED");
        assert!(
            err.hints.iter().any(|h| h.label.contains("puttygen")),
            "提示里要告诉用户用 puttygen 转"
        );
    }

    #[test]
    fn rsa_ppk_is_rejected_with_guidance() {
        let ppk = make_ppk("none", "ssh-rsa");
        let err = convert(&ppk).unwrap_err();
        assert_eq!(err.code, "PPK_UNSUPPORTED_TYPE");
        assert!(err.message.contains("ssh-rsa"));
        assert!(err.hints.iter().any(|h| h.label.contains("puttygen")));
    }

    #[test]
    fn inspect_accepts_ppk_through_the_public_entry_point() {
        // 调用方（CLI / 界面）拿到的是 PrivateKeySource，不该要求它先判断格式
        let ppk = make_ppk("none", "ssh-ed25519");
        let source = crate::keys::PrivateKeySource::new(ppk, None);
        let info = crate::keys::inspect(&source).expect("inspect 应能处理 .ppk");
        assert_eq!(info.key_type, "ssh-ed25519");
        assert!(!info.encrypted);
    }

    #[test]
    fn garbage_is_rejected_clearly() {
        let err = convert(b"not a ppk at all").unwrap_err();
        assert_eq!(err.code, "PPK_INVALID");
    }
}
