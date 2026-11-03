//! ssh-agent 认证：能连上 agent、能给出可读的失败原因。
//!
//! 正向路径（agent 里刚好有远端接受的密钥）需要真实 agent + 真实 sshd，
//! 本机两样都不一定有，所以这里覆盖的是**能稳定验证的部分**：
//! - agent 不可用时给的是 `SSH_AGENT_UNAVAILABLE` 而不是「连接失败」；
//! - 提示里指明该去启动什么。

use wt_ssh::testing::MockSshServer;
use wt_ssh::{HostKeyPolicy, SshConfig, SshConnection};

fn cfg(port: u16) -> SshConfig {
    SshConfig {
        host: "127.0.0.1".into(),
        port,
        user: "tester".into(),
        connect_timeout_secs: 5,
        ..Default::default()
    }
}

/// agent 没跑时，错误必须指向环境问题，而不是让人去查网络。
///
/// 这个用例在**有** agent 的机器上会走另一条分支（连上了但身份不被接受），
/// 所以断言写成「要么 agent 不可用、要么认证被拒」——两者都不能是连接错误。
#[tokio::test]
async fn agent_failure_points_at_the_environment() {
    let server = MockSshServer::start().await;
    let err = SshConnection::connect_agent(&cfg(server.port), HostKeyPolicy::AcceptAll)
        .await
        .err()
        .expect("mock 不会接受 agent 里的任意密钥，应失败");

    assert!(
        err.code == "SSH_AGENT_UNAVAILABLE" || err.code == "SSH_AUTH_FAILED",
        "错误码应指向 agent 或认证，实际 {}: {}",
        err.code,
        err.message
    );
    assert!(
        !err.hints.is_empty(),
        "必须给出可执行的提示（启动什么服务 / 用 ssh-add 加什么）"
    );

    if err.code == "SSH_AGENT_UNAVAILABLE" {
        assert!(
            err.message.contains("agent"),
            "message 应提到 agent：{}",
            err.message
        );
    }
}
