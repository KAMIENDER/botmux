# Botmux 定制仓库

- Fork：<https://github.com/KAMIENDER/botmux>，默认分支 `custom`。
- 上游：<https://github.com/deepcoldy/botmux>，跟踪 `master`。
- `master` 保持上游代码；`custom` 从当前部署版本 `v3.42.0` 起维护定制改动。
- 本地源码：`/Users/bytedance/my_project/botmux`。
- SG 开发机源码：`/home/hejiadong.1024/my_project/botmux`。
- 日常修改、审阅和提交优先在 SG 开发机完成；本地 checkout 作为副本，推送后同步。

## 当前改动

1. `/adopt` 支持读取 TraeX paginated 历史中的 `history_mutation` append 消息，继续保留已有会话归属过滤。
2. `fork.json` 指定本仓库的发布来源，二进制构建时将其写入产物。
3. 定制二进制的更新、版本选择、更新日志、回滚列表和下载均使用本仓库的 GitHub Releases；没有自己的 Release 时返回不可用，不回退到官方 npm。
4. 官方发布工作流在 fork 中关闭；`Fork Release` 复用上游 glibc 2.28 构建流程，单独发布 Linux x64 二进制及 `botmux-linux-x64.sha256`，不发布 npm。

源代码运行时使用 `BOTMUX_RELEASE_REPO=KAMIENDER/botmux`；发布二进制已内置该来源，无需设置这个环境变量。当前 fork 的部署渠道仅支持独立二进制，不能用 `npm i -g botmux` 安装定制版。

## 按需同步上游

先审阅并保存工作区改动，再在 `custom` 执行：

```bash
bash scripts/sync-upstream.sh
```

脚本抓取上游 master 并准备合并，保留我们的定制提交；不会自动提交、推送或部署。修改重叠时需要处理冲突；如果上游已经实现同一修复，应检查并移除重复的定制逻辑。

fork 的纯上游 `master` 可单独同步：

```bash
gh repo sync KAMIENDER/botmux --source deepcoldy/botmux --branch master
```

不要对 `custom` 使用强制同步或 reset 到上游，它承载我们的定制代码。

## 发布与部署

1. 审阅、提交并推送 `custom` 的改动。
2. 在本仓库 Actions 手动运行 **Fork Release**，分支选择 `custom`，输入一个未使用的稳定版本号 `X.Y.Z`。使用自己的版本序列，并在 Release 中记录对应源码提交。
3. 等待二进制和校验文件都发布完成，再按指定版本安装。

```bash
curl -fsSL https://raw.githubusercontent.com/KAMIENDER/botmux/custom/install.sh -o /tmp/botmux-fork-install.sh
BOTMUX_VERSION=vX.Y.Z sh /tmp/botmux-fork-install.sh
```

安装后需重启相关 bot，才能加载新二进制。发布和部署是单独动作；仅同步源码不会改变正在运行的服务。

本仓库保留上游 MIT 许可证和版权声明。不要将 `~/.botmux` 的机器人密钥、运行配置或会话历史复制进 Git 仓库。


## TRAE Codebase Git 登录自动续期（Linux 开发机）

当前是独立的主机维护脚本，不依赖 Botmux 二进制发版或 Codex App。只管理已经登录的 git_codebase / cloud_cli_jwt 凭据；不会替换 PAT、SSO 或其他登录方式，也不会创建新身份。

~~~bash
/usr/bin/python3 scripts/install-traex-auth-renew.py
systemctl --user list-timers botmux-traex-auth-renew.timer
cat ~/.local/state/botmux/traex-auth-renew/status.json
~~~

安装脚本将执行文件复制到 ~/.local/lib/botmux/traex-auth-renew.py，创建并启用同名的用户 systemd service/timer。修改脚本后需重新运行安装脚本，源码提交/同步不会自动修改已部署文件。用户 manager 需持续运行；当前 SG 开发机已经启用 linger。

- 每 6 小时检查一次，剩余不足 48 小时才运行原生 traex login --git-code。首次启用也会立即检查。
- 先在临时 TRAE_HOME 登录，确认同一账号、同一区域且有效期延长，再以原子替换更新正式 auth.json。失败保留正式文件，下次检查再尝试；不重启 bot 或 CLI。
- 自身运行锁避免重叠，写入时使用 TRAE 的 auth.json.lock，期间其他登录改过正式凭据就放弃本次替换。
- 登录最多等待 60 秒；服务限制 90 秒。状态只记录时间和固定原因码，不保存凭据或原生登录输出。
- Codebase Git 自身的认证也必须可用。该认证失效、网络异常或 CLI 登录协议变化时，续期可能失败，应检查状态文件并恢复原生登录。

查看当前到期时间，或手动通过相同脚本续一次：

~~~bash
/usr/bin/python3 ~/.local/lib/botmux/traex-auth-renew.py --check
/usr/bin/python3 ~/.local/lib/botmux/traex-auth-renew.py --force
systemctl --user show botmux-traex-auth-renew.service -p Result -p ExecMainStatus
~~~

停用：

~~~bash
systemctl --user disable --now botmux-traex-auth-renew.timer
systemctl --user stop botmux-traex-auth-renew.service
~~~

本脚本不会发送飞书消息。默认失败记录在本机状态文件和服务日志中。
