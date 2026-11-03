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
    let target_link = format!("{}:{}", target.host, target.port);

    // 第 1 跳已经在线；这里要它开一条到目标的通道。失败发生在跳板机上。
    let stream = match jump
        .open_direct_tcpip_channel(&target.host, target.port, "127.0.0.1", 0)
        .await
    {
        Ok(s) => s,
        Err(russh::Error::ChannelOpenFailure(russh::ChannelOpenFailure::AdministrativelyProhibited)) => {
            return Err(WtError::new(codes::SSH_FORWARD_DENIED).message(format!(
                "第 1 跳（{jump_link}）禁止 TCP 转发（AllowTcpForwarding no），无法通过它连接 {target_link}"
            )));
        }
        Err(e) => {
            return Err(with_hop(
                WtError::new(codes::TUN_CHANNEL_FAILED)
                    .message(format!("无法从跳板机连接到 {target_link}"))
                    .detail(e.to_string())
                    .hint(
                        "目标主机名由**跳板机侧**解析；确认跳板机能访问该地址与端口",
                        HintAction::None,
                    ),
                1,
                jump_link,
            ));
        }
    };

    // 第 2 跳：在通道上做真正的 SSH 握手与认证
    SshConnection::connect_over(stream, target, target_auth, policy)
        .await
        .map_err(|e| with_hop(e, 2, &target_link))
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
