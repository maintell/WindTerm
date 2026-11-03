//! SOCKS5 协议层（`NET-003` 动态转发 `-D`）。
//!
//! 只做 `CONNECT`：`BIND` / `UDP ASSOCIATE` 明确回 `0x07`，因为动态转发的用途是
//! 「让浏览器/curl/git 把流量送过 SSH」，这三种之外的能力在这里没有意义，
//! 悄悄返回成功反而会让客户端以为可用。
//!
//! 只处理**协议**，不碰 SSH：`negotiate` 跑完就拿到 `(host, port)`，
//! 建通道与回 `REPLY_SUCCEEDED` 由 `crate::forward` 负责。
//! 这样协议可以用内存管道精确测（边界：无认证/有认证/错误命令/域名地址），
//! 不需要起 SSH 服务端。

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const VERSION: u8 = 5;
const METHOD_NO_AUTH: u8 = 0x00;
const METHOD_USERPASS: u8 = 0x02;
const METHOD_NONE_ACCEPTABLE: u8 = 0xFF;

pub const CMD_CONNECT: u8 = 1;
const ATYP_IPV4: u8 = 1;
const ATYP_DOMAIN: u8 = 3;
const ATYP_IPV6: u8 = 4;

pub const REPLY_SUCCEEDED: u8 = 0x00;
pub const REPLY_GENERAL_FAILURE: u8 = 0x01;
pub const REPLY_NOT_ALLOWED: u8 = 0x02;
pub const REPLY_HOST_UNREACHABLE: u8 = 0x04;
pub const REPLY_CONNECTION_REFUSED: u8 = 0x05;
pub const REPLY_COMMAND_NOT_SUPPORTED: u8 = 0x07;
pub const REPLY_ADDRESS_NOT_SUPPORTED: u8 = 0x08;

#[derive(Debug, PartialEq, Eq)]
pub enum HandshakeError {
    /// 客户端列出的认证方式没有我们能接受的（已回 `05 FF`）
    NoAcceptableMethod,
    /// 用户名密码不对（已回 `01 01`）
    AuthFailed,
    /// `BIND` / `UDP ASSOCIATE` 等（已回 `05 07`）
    CommandNotSupported,
    /// 地址类型不认识（已回 `05 08`）
    AddressNotSupported,
    Io(String),
}

impl HandshakeError {
    pub fn to_error(self) -> String {
        match self {
            HandshakeError::NoAcceptableMethod => "客户端不支持可用的认证方式".into(),
            HandshakeError::AuthFailed => "SOCKS5 用户名或密码不对".into(),
            HandshakeError::CommandNotSupported => "只支持 CONNECT（BIND/UDP 不支持）".into(),
            HandshakeError::AddressNotSupported => "地址类型不支持".into(),
            HandshakeError::Io(e) => e,
        }
    }
}

/// 完成 SOCKS5 协商与请求解析，返回目标 `(host, port)`。
///
/// `auth` 为 `Some((user, pass))` 时**强制**用户名密码认证；为 `None` 时只接受
/// 「无需认证」。不做「有凭据但两者都接受」——那会让 AC-3 的「无凭据被拒」
/// 变成没发生过。
pub async fn negotiate<S>(
    stream: &mut S,
    auth: Option<&(String, String)>,
) -> Result<(String, u16), HandshakeError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    // ── 方法协商 ──────────────────────────────────────────
    let mut head = [0u8; 2];
    read_exact(stream, &mut head).await?;
    if head[0] != VERSION {
        return Err(HandshakeError::Io(format!("不是 SOCKS5 请求（版本 {}）", head[0])));
    }
    let mut methods = vec![0u8; head[1] as usize];
    read_exact(stream, &mut methods).await?;

    let want = if auth.is_some() {
        METHOD_USERPASS
    } else {
        METHOD_NO_AUTH
    };
    if !methods.contains(&want) {
        let _ = stream.write_all(&[VERSION, METHOD_NONE_ACCEPTABLE]).await;
        let _ = stream.flush().await;
        return Err(HandshakeError::NoAcceptableMethod);
    }
    write_all(stream, &[VERSION, want]).await?;

    // ── 用户名密码认证（RFC 1929）────────────────────────
    if let Some((user, pass)) = auth {
        let mut ver = [0u8; 1];
        read_exact(stream, &mut ver).await?;
        if ver[0] != 1 {
            return Err(HandshakeError::Io(format!("认证子协议版本不对：{}", ver[0])));
        }
        let mut ulen = [0u8; 1];
        read_exact(stream, &mut ulen).await?;
        let mut u = vec![0u8; ulen[0] as usize];
        read_exact(stream, &mut u).await?;
        let mut plen = [0u8; 1];
        read_exact(stream, &mut plen).await?;
        let mut p = vec![0u8; plen[0] as usize];
        read_exact(stream, &mut p).await?;

        let ok = u == user.as_bytes() && p == pass.as_bytes();
        write_all(stream, &[1, if ok { 0 } else { 1 }]).await?;
        if !ok {
            return Err(HandshakeError::AuthFailed);
        }
    }

    // ── 请求 ────────────────────────────────────────────
    let mut req = [0u8; 4];
    read_exact(stream, &mut req).await?;
    if req[0] != VERSION {
        return Err(HandshakeError::Io(format!("请求版本不对：{}", req[0])));
    }
    if req[1] != CMD_CONNECT {
        send_reply(stream, REPLY_COMMAND_NOT_SUPPORTED).await?;
        return Err(HandshakeError::CommandNotSupported);
    }

    let host = match req[3] {
        ATYP_IPV4 => {
            let mut ip = [0u8; 4];
            read_exact(stream, &mut ip).await?;
            std::net::Ipv4Addr::from(ip).to_string()
        }
        ATYP_IPV6 => {
            let mut ip = [0u8; 16];
            read_exact(stream, &mut ip).await?;
            let v6 = std::net::Ipv6Addr::from(ip);
            // IPv6 字面量要带方括号才能交给 direct-tcpip 解析
            format!("[{v6}]")
        }
        ATYP_DOMAIN => {
            let mut len = [0u8; 1];
            read_exact(stream, &mut len).await?;
            let mut name = vec![0u8; len[0] as usize];
            read_exact(stream, &mut name).await?;
            // 域名原样交给服务端解析（`SES-024`/`NET-003` AC-2：本地 DNS 查不到也能用）
            String::from_utf8(name).map_err(|e| HandshakeError::Io(e.to_string()))?
        }
        _ => {
            send_reply(stream, REPLY_ADDRESS_NOT_SUPPORTED).await?;
            return Err(HandshakeError::AddressNotSupported);
        }
    };

    let mut port = [0u8; 2];
    read_exact(stream, &mut port).await?;
    Ok((host, u16::from_be_bytes(port)))
}

/// 回一个 `REPLY`（`BND.ADDR` 填全零，客户端不依赖它）。
pub async fn send_reply<S>(stream: &mut S, code: u8) -> Result<(), HandshakeError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    // VER REP RSV ATYP BND.ADDR(4) BND.PORT(2)
    write_all(stream, &[VERSION, code, 0, ATYP_IPV4, 0, 0, 0, 0, 0, 0]).await
}

async fn read_exact<S>(stream: &mut S, buf: &mut [u8]) -> Result<(), HandshakeError>
where
    S: AsyncRead + Unpin,
{
    stream
        .read_exact(buf)
        .await
        .map(|_| ())
        .map_err(|e| HandshakeError::Io(e.to_string()))
}

async fn write_all<S>(stream: &mut S, buf: &[u8]) -> Result<(), HandshakeError>
where
    S: AsyncWrite + Unpin,
{
    stream
        .write_all(buf)
        .await
        .map_err(|e| HandshakeError::Io(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    /// 客户端侧：发协商 + 请求，收集服务端写回的应答字节。
    ///
    /// 服务端只回协商/认证/拒绝这几类应答；成功应答由调用方（`forward`）
    /// 在通道开好之后才发，所以这里看不到 `REPLY_SUCCEEDED`。
    async fn handshake_with(
        client_bytes: Vec<u8>,
        auth: Option<(String, String)>,
    ) -> (Result<(String, u16), HandshakeError>, Vec<u8>) {
        let (mut client, mut server) = duplex(4096);
        let mut task = tokio::spawn(async move { negotiate(&mut server, auth.as_ref()).await });

        client.write_all(&client_bytes).await.unwrap();
        let mut reply = Vec::new();
        let _ = tokio::time::timeout(
            std::time::Duration::from_millis(120),
            AsyncReadExt::read_to_end(&mut client, &mut reply),
        )
        .await;
        let result = (&mut task).await.unwrap();
        (result, reply)
    }

    #[tokio::test]
    async fn parses_connect_to_domain() {
        // greeting: VER NMETHODS METHODS
        let mut bytes = vec![5, 1, 0];
        // request: VER CMD RSV ATYP LEN 域名 PORT
        bytes.extend_from_slice(&[5, CMD_CONNECT, 0, ATYP_DOMAIN, 9]);
        bytes.extend_from_slice(b"db.local1");
        bytes.extend_from_slice(&3306u16.to_be_bytes());

        let (result, reply) = handshake_with(bytes, None).await;
        assert_eq!(result.unwrap(), ("db.local1".to_string(), 3306));
        // 方法协商的应答必须在最前面：05 00
        assert_eq!(&reply[..2], &[5, 0], "实际：{reply:?}");
    }

    #[tokio::test]
    async fn parses_ipv4_and_ipv6() {
        let mut req = vec![5, 1, 0]; // greeting
        req.extend_from_slice(&[5, CMD_CONNECT, 0, ATYP_IPV4, 10, 0, 0, 5]);
        req.extend_from_slice(&80u16.to_be_bytes());
        let (result, _) = handshake_with(req, None).await;
        assert_eq!(result.unwrap(), ("10.0.0.5".to_string(), 80));

        let mut req6 = vec![5, 1, 0]; // greeting
        req6.extend_from_slice(&[5, CMD_CONNECT, 0, ATYP_IPV6]);
        req6.extend_from_slice(&[0u8; 15]);
        req6.push(1);
        req6.extend_from_slice(&443u16.to_be_bytes());
        let (result6, _) = handshake_with(req6, None).await;
        let (host, port) = result6.unwrap();
        assert_eq!(port, 443);
        assert!(host.starts_with('[') && host.ends_with(']'), "IPv6 要带方括号：{host}");
    }

    #[tokio::test]
    async fn rejects_bind_with_command_not_supported() {
        let mut req = vec![5, 1, 0]; // greeting
        req.extend_from_slice(&[5, 2, 0, ATYP_IPV4, 127, 0, 0, 1]); // CMD=2 (BIND)
        req.extend_from_slice(&8080u16.to_be_bytes());
        let (result, reply) = handshake_with(req, None).await;
        assert_eq!(result.unwrap_err(), HandshakeError::CommandNotSupported);
        // 05 07 = 命令不支持
        assert!(reply.windows(2).any(|w| w == [5, 7]), "实际：{reply:?}");
    }

    #[tokio::test]
    async fn requires_userpass_when_configured() {
        // 客户端只报「无需认证」，但我们要求认证 → 05 FF
        let (result, reply) = handshake_with(vec![5, 1, 0], Some(("u".into(), "p".into()))).await;
        assert_eq!(result.unwrap_err(), HandshakeError::NoAcceptableMethod);
        assert!(reply.windows(2).any(|w| w == [5, 0xFF]), "实际：{reply:?}");
    }

    #[tokio::test]
    async fn rejects_wrong_credentials_with_status_1() {
        // 05 01 02（声明支持 userpass）+ 01 01 'u' 01 'x'
        let req = vec![5, 1, 2, 1, 1, b'u', 1, b'x'];
        let (result, reply) = handshake_with(req, Some(("u".into(), "p".into()))).await;
        assert_eq!(result.unwrap_err(), HandshakeError::AuthFailed);
        // 认证子协议回 01 01 = 失败
        assert!(reply.windows(2).any(|w| w == [1, 1]), "实际：{reply:?}");
    }

    #[tokio::test]
    async fn accepts_correct_credentials_then_connect() {
        let mut req = vec![5, 1, 2, 1, 1, b'u', 1, b'p'];
        req.extend_from_slice(&[5, 1, 0, ATYP_DOMAIN, 4]);
        req.extend_from_slice(b"host");
        req.extend_from_slice(&22u16.to_be_bytes());
        let (result, reply) = handshake_with(req, Some(("u".into(), "p".into()))).await;
        assert_eq!(result.unwrap(), ("host".to_string(), 22));
        // 认证成功会回 01 00
        assert!(reply.windows(2).any(|w| w == [1, 0]), "实际：{reply:?}");
    }
}
