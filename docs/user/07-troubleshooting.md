# 07 排查

## 先看错误码

界面和命令行用的是**同一套错误码**，形如 `[SSH_AUTH_FAILED]`。搜码比搜整句话准。

| 错误码 | 含义 | 怎么办 |
|---|---|---|
| `SSH_CONNECT_FAILED` | TCP 层就没通 | 主机/端口是否可达；防火墙是否放行 |
| `SSH_AUTH_FAILED` | 认证被拒 | 用户名/密码/密钥；服务端可能禁用了密码认证 |
| `SSH_AGENT_UNAVAILABLE` | 找不到 ssh-agent | Windows 开「OpenSSH Authentication Agent」服务，或用 Pageant |
| `SSH_HOSTKEY_UNKNOWN` | 主机密钥没确认过 | 核对提示里的指纹；确认后接受 |
| `SSH_HOSTKEY_CHANGED` | 主机密钥变了 | 先搞清楚为什么变（重装/换机/MITM） |
| `SSH_KEY_PASSPHRASE_REQUIRED` | 私钥有口令但没给 | 填私钥口令 |
| `SSH_FORWARD_DENIED` | 服务端禁止 TCP 转发 | `AllowTcpForwarding` / `GatewayPorts` |
| `SSH_NO_COMMON_KEX` | 算法谈不拢 | 老服务器的算法被新版默认禁用了 |
| `TUN_NO_SESSION` | 隧道没有承载会话 | 表单里重新填一次并启动（会覆盖保存） |
| `TUN_LAN_CONFIRM_REQUIRED` | 监听 `0.0.0.0` 没确认 | 勾「允许局域网访问」 |
| `SFTP_CONFLICT` | 编辑期间远端文件被改过 | 重新下载确认差异，别强行覆盖 |
| `FILE_TOO_LARGE` | 超过内嵌编辑器 2 MB 上限 | 用外部编辑器打开 |
| `FILE_NOT_UTF8` | 不是 UTF-8 文本 | 用外部编辑器，或先转码 |
| `SES_JUMP_CYCLE` | 跳板链成环 | 去掉循环引用 |
| `FOLDER_CYCLE` | 把文件夹挪进了自己的子文件夹 | 换个目标 |

## 埋点日志

设置环境变量 `WT_TRACE=1` 再启动，关键路径（连接、隧道增删、SFTP、自动拉起）会写到系统临时目录的 `wt-trace.log`。默认关闭——它每次操作都写盘。

出问题时先开它复现一次，比猜快得多。

## 常见「看起来像 bug」的

| 现象 | 其实是什么 |
|---|---|
| 状态栏说「已记录指纹」 | 首次连接正常行为 |
| 隧道停了还在列表里（灰灯） | 配置保存了，这是有意的 |
| 带认证的隧道重启后不见了 | 口令不落盘，重启需重填 |
| 上传同名文件后远端大小没变 | 检查是不是写到了别的目录；同名下载会自动改名 |
| 粘贴多行弹确认 | 防止把多行命令一次性打进远端 |
