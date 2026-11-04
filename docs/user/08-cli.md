# 08 命令行

`wt` 是配套 CLI，和界面共用同一个会话库与 `known_hosts`。

## 会话

```bash
wt session import --file "C:\Users\me\Documents\MobaXterm\MobaXterm.ini"
wt session list --json
```

导入的文件结构会还原成会话树；密码不导入。

## SSH

```bash
# 执行一条命令
wt ssh exec --host H --user U --password P -- uptime

# 用密钥 / agent
wt ssh exec --host H --user U --key C:/k/id_ed25519 -- uptime
wt ssh exec --host H --user U --agent -- uptime

# 交互式 shell（接管本机终端，Ctrl+C 发给远端）
wt ssh shell --host H --user U --agent
```

**跳板机**：`--jump` 可重复，按「离本机由近到远」排列，最多 5 跳；跳板机凭据必须另给，全链共用一套。

```bash
wt ssh exec --host 10.0.3.44 --user root --password P \
  --jump a@bastion1 --jump a@bastion2 --jump-password JP -- uptime
```

## 文件

```bash
wt sftp ls  --host H --user U --password P --path /var/log
wt sftp get --host H --user U --password P --remote /etc/hosts --local hosts.txt
wt sftp put --host H --user U --password P --local hosts.txt --remote /tmp/hosts.txt
```

## 自检

```bash
wt version
wt doctor
```

`doctor` 会检查终端能力、agent、路径等，报错时把输出发出来最有用。
