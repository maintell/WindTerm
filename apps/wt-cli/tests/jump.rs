//! `--jump` 的真实执行路径（`G14`）。
//!
//! 不是只测参数解析：用户走的是 `wt ssh exec ... --jump` 这条命令路径，
//! 所以这里让 CLI 真正做两跳——
//!
//! ```text
//! wt-cli ──SSH──> mock A（跳板机） ──direct-tcpip（真实 TCP）──> mock B（目标）
//! ```
//!
//! `connect_target` 是 `ssh exec` / `ssh shell` / `sftp` 共用的那条链路，
//! 所以两条用例分别覆盖「命令」和「文件」，避免只验到其中一条。

use wt_cli::{run_sftp, run_ssh_exec, JumpTarget, SftpAction, SshAuth, SshTarget};
use wt_ssh::testing::MockSshServer;

/// 目标机 + 指向 mock A 的跳板机。
fn target_via(jump_port: u16, target_port: u16) -> SshTarget {
    target_via_hops(&[jump_port], target_port)
}

/// 多个跳板机（`SES-025`）：`jump_ports` 按「离本机由近到远」排列。
fn target_via_hops(jump_ports: &[u16], target_port: u16) -> SshTarget {
    SshTarget {
        host: "127.0.0.1".into(),
        port: target_port,
        user: "tester".into(),
        auth: SshAuth::Password("secret".into()),
        insecure_host_key: true,
        jumps: jump_ports
            .iter()
            .map(|p| JumpTarget {
                host: "127.0.0.1".into(),
                port: *p,
                user: "tester".into(),
                // 跳板机的凭据是**自己一份**（结构上就没有「继承目标」这种写法）。
                // mock 只认 tester/secret，所以值一样，但取值路径完全独立——
                // `wrong_jump_credentials_name_the_jump_host` 就是拿这个做的判据。
                auth: SshAuth::Password("secret".into()),
            })
            .collect(),
    }
}

#[tokio::test]
async fn ssh_exec_goes_through_the_jump_host() {
    let jump = MockSshServer::start().await;
    let target = MockSshServer::start().await;

    let mut out: Vec<u8> = Vec::new();
    let code = run_ssh_exec(&target_via(jump.port, target.port), "whoami", &mut out)
        .await
        .expect("经跳板机执行应成功");

    assert_eq!(code, 0);
    // mock 的回执带 `ran:` 前缀：拿到它说明第二跳是真正的 SSH 会话，
    // 而不是「连上了跳板机就当成功」
    let text = String::from_utf8_lossy(&out);
    assert!(text.contains("ran:whoami"), "实际输出: {text:?}");
}

#[tokio::test]
async fn sftp_also_goes_through_the_jump_host() {
    let jump = MockSshServer::start().await;
    let target = MockSshServer::start().await;
    target
        .fs
        .lock()
        .await
        .insert("/behind-bastion.txt".into(), b"x".to_vec());

    let mut out: Vec<u8> = Vec::new();
    run_sftp(
        &target_via(jump.port, target.port),
        &SftpAction::Ls {
            path: "/".into(),
            json: false,
        },
        &mut out,
    )
    .await
    .expect("经跳板机列目录应成功");

    let text = String::from_utf8_lossy(&out);
    assert!(text.contains("behind-bastion.txt"), "实际输出: {text}");
}

#[tokio::test]
async fn wrong_jump_credentials_name_the_jump_host() {
    let jump = MockSshServer::start().await;
    let target = MockSshServer::start().await;

    let mut t = target_via(jump.port, target.port);
    if let Some(j) = t.jumps.first_mut() {
        j.auth = SshAuth::Password("wrong".into());
    }

    let mut out: Vec<u8> = Vec::new();
    let err = run_ssh_exec(&t, "whoami", &mut out).await.unwrap_err();

    // 认证失败必须指向**哪一跳**，否则用户会去目标机上找原因
    assert!(err.contains("第 1 跳"), "实际错误: {err}");
    assert!(err.contains("SSH_AUTH_FAILED"), "实际错误: {err}");
    assert!(
        err.contains(&format!("127.0.0.1:{}", jump.port)),
        "错误里要有跳板机地址，实际: {err}"
    );
}

#[tokio::test]
async fn ssh_exec_goes_through_two_jump_hosts() {
    // A → B → 目标（`SES-025`）：每一段都是真的 SSH 会话，
    // mock 的 direct-tcpip 连的是真实 TCP，所以「两跳」不是模拟出来的
    let jump_a = MockSshServer::start().await;
    let jump_b = MockSshServer::start().await;
    let target = MockSshServer::start().await;

    let mut out: Vec<u8> = Vec::new();
    let code = run_ssh_exec(
        &target_via_hops(&[jump_a.port, jump_b.port], target.port),
        "whoami",
        &mut out,
    )
    .await
    .expect("经两台跳板机执行应成功");

    assert_eq!(code, 0);
    let text = String::from_utf8_lossy(&out);
    assert!(text.contains("ran:whoami"), "实际输出: {text:?}");
}

#[tokio::test]
async fn second_jump_credentials_name_that_hop() {
    let jump_a = MockSshServer::start().await;
    let jump_b = MockSshServer::start().await;
    let target = MockSshServer::start().await;

    let mut t = target_via_hops(&[jump_a.port, jump_b.port], target.port);
    // 第 2 跳的凭据错：错误必须落在第 2 跳，而不是目标
    t.jumps[1].auth = SshAuth::Password("wrong".into());

    let mut out: Vec<u8> = Vec::new();
    let err = run_ssh_exec(&t, "whoami", &mut out).await.unwrap_err();
    assert!(err.contains("第 2 跳"), "实际错误: {err}");
    assert!(
        err.contains(&format!("127.0.0.1:{}", jump_b.port)),
        "错误里要有第 2 跳地址，实际: {err}"
    );
}
