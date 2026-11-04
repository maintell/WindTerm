//! SSH 跳板机（`SES-024` 单跳）。
//!
//! 数据面是**真的两跳**：先登录跳板机，再让跳板机开一条 `direct-tcpip` 到目标，
//! 然后在这条通道上跑第二次 SSH 握手（`client::connect_stream`）。
//! 所以目标机看到的连接来自跳板机——在跳板机上 `ss -tnp` 能看到它主动外连，
//! 这正是 `SES-024` AC-1 要的现象。转发端口那种做法（`-L` + 连本地端口）
//! 目标是连上了，但主机密钥校验、agent 转发、审计都会错位。
//!
//! # 为什么错误要带「第几跳」
//!
//! 多跳链路里「认证失败」这四个字毫无信息量：可能是跳板机，也可能是目标。
//! `SES-024` AC-2 要求错误里出现「第 2 跳 bastion2:22 认证失败」，
//! 所以这里给底层错误**加上跳号与前缀**，而不是换一个笼统的错误码——
//! 那样会让「认证失败」被归成别的问题，界面上连该改密码还是改网络都分不清。

use wt_common::{codes, HintAction, WtError};

use crate::client::{Auth, SshConnection};
use crate::{HostKeyPolicy, SshConfig};

/// 给一条错误补上「第几跳（哪台）」。保留原错误码与全部提示。
fn with_hop(mut e: WtError, hop: usize, link: &str) -> WtError {
    e.message = format!("第 {hop} 跳（{link}）：{}", e.message);
    let location = format!("失败点：第 {hop} 跳 {link}");
    e.detail = Some(match e.detail.take() {
        Some(d) if !d.is_empty() => format!("{location}\n{d}"),
        _ => location,
    });
    e
}

/// 经一台已登录的跳板机连接目标（`SES-024` 单跳）。
///
/// `jump_link` 只用于错误信息（形如 `bastion1:22`），让用户知道是哪一台出了事。
/// `target_auth` 是**目标机**的凭据——`SES-024` 行为规格第 4 条要求不继承跳板机的。
pub async fn connect_via(
    jump: &SshConnection,
    jump_link: &str,
    target: &SshConfig,
    target_auth: &Auth<'_>,
    policy: HostKeyPolicy,
) -> Result<SshConnection, WtError> {
    hop_to(jump, 1, jump_link, target, target_auth, policy).await
}

/// 一跳：怎么连它 + 它自己的凭据（`SES-025` 多跳）。
///
/// 凭据逐跳分开写，不做「继承上一跳」的默认——跳板机链上每台的账号往往不同，
/// 猜错的代价是报错指向错误的机器（`SES-024` 行为规格第 4 条）。
pub struct Hop<'a> {
    pub cfg: SshConfig,
    pub auth: Auth<'a>,
}

/// 经一串跳板机连接目标（`SES-025`）。
///
/// `hops` 按「离客户端由近到远」排列：`hops[0]` 是本机直连的那台，
/// `hops.last()` 是目标的直接上一跳。空数组等于直连目标。
///
/// 每一跳都是**真的 SSH 会话**：上一跳开 `direct-tcpip` 到下一跳，在这条通道上
/// 再做一次完整握手与认证。所以沿途每台机器都只看到「它的上一跳」，
/// 这是 `SES-024` AC-1 要的现象，也是它比「本地 -L 逐段转发」更正确的地方——
/// 后者会让主机密钥校验、agent 转发、审计全部错位。
pub async fn connect_chain(
    hops: &[Hop<'_>],
    target: &SshConfig,
    target_auth: &Auth<'_>,
    policy: HostKeyPolicy,
) -> Result<SshConnection, WtError> {
    let Some((first, rest)) = hops.split_first() else {
        // 没有跳板机就是直连：调用方不必自己分支
        return SshConnection::connect(target, target_auth, policy).await;
    };

    let mut link = format!("{}:{}", first.cfg.host, first.cfg.port);
    // 第 1 跳由本机直接建连（它自己也是一台要认证的机器）
    let mut conn = SshConnection::connect(&first.cfg, &first.auth, policy.clone())
        .await
        .map_err(|e| with_hop(e, 1, &link))?;

    for (i, hop) in rest.iter().enumerate() {
        let next_link = format!("{}:{}", hop.cfg.host, hop.cfg.port);
        // 上一跳把 TCP 打到下一跳，第 i+2 跳就在这条通道上握手
        conn = hop_to(&conn, i + 1, &link, &hop.cfg, &hop.auth, policy.clone()).await?;
        link = next_link;
    }

    // 最后一段：从最后一跳连到目标
    hop_to(&conn, hops.len(), &link, target, target_auth, policy).await
}

/// 从 `from` 这台（第 `from_hop` 跳）开通道到 `to`，并在通道上完成握手与认证。
///
/// 抽出来是为了让单跳（`connect_via`）与多跳（`connect_chain`）共用同一段：
/// 两处各写一遍，错误文案与跳号迟早会分叉。
async fn hop_to(
    from: &SshConnection,
    from_hop: usize,
    from_link: &str,
    to: &SshConfig,
    to_auth: &Auth<'_>,
    policy: HostKeyPolicy,
) -> Result<SshConnection, WtError> {
    let to_link = format!("{}:{}", to.host, to.port);
    let stream = from
        .open_direct_tcpip_channel(&to.host, to.port, "127.0.0.1", 0)
        .await
        .map_err(|e| forward_error(e, from_hop, from_link, &to_link))?;
    SshConnection::connect_over(stream, to, to_auth, policy)
        .await
        .map_err(|e| with_hop(e, from_hop + 1, &to_link))
}

/// 「从这一跳到下一跳打不通」的错误：受管跳禁止转发要点名 `AllowTcpForwarding`。
fn forward_error(e: russh::Error, hop: usize, from_link: &str, to_link: &str) -> WtError {
    match e {
        russh::Error::ChannelOpenFailure(russh::ChannelOpenFailure::AdministrativelyProhibited) => {
            WtError::new(codes::SSH_FORWARD_DENIED).message(format!(
                "第 {hop} 跳（{from_link}）禁止 TCP 转发（AllowTcpForwarding no），无法通过它连接 {to_link}"
            ))
        }
        other => with_hop(
            WtError::new(codes::TUN_CHANNEL_FAILED)
                .message(format!("无法从跳板机连接到 {to_link}"))
                .detail(other.to_string())
                .hint(
                    "目标主机名由**跳板机侧**解析；确认跳板机能访问该地址与端口",
                    HintAction::None,
                ),
            hop,
            from_link,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hop_prefix_keeps_code_and_appends_location() {
        let e = WtError::new(codes::SSH_AUTH_FAILED)
            .message("密码认证被服务端拒绝")
            .detail("用户 tester 在 b:22 上认证失败");
        let e = with_hop(e, 2, "b:22");
        // 错误码必须保留：换成笼统的跳板错误会让「认证失败」被归成别的问题
        assert_eq!(e.code, codes::SSH_AUTH_FAILED);
        assert!(e.message.starts_with("第 2 跳（b:22）："), "实际：{}", e.message);
        assert!(e.message.contains("密码认证"), "实际：{}", e.message);
        let detail = e.detail.unwrap_or_default();
        assert!(detail.contains("失败点：第 2 跳 b:22"), "实际：{detail}");
        // 原有的 detail 不能被吞掉
        assert!(detail.contains("用户 tester"), "实际：{detail}");
    }

    #[test]
    fn hop_prefix_works_without_detail() {
        let e = with_hop(WtError::new("SSH_CONNECT_FAILED").message("连不上"), 1, "a:22");
        let detail = e.detail.unwrap_or_default();
        assert!(detail.contains("失败点：第 1 跳 a:22"), "实际：{detail}");
    }
}
