# Codex Mac 执行节点

SG 上的 Botmux 继续独占飞书消息、会话卡片、调度和管理后台；Mac 只运行原生
Codex App Server 与主动连向 SG 的 SSH 隧道，不安装 Botmux，也不接收飞书事件。

这不是另一套 Botmux，也不是把代码或 Codex 登录凭据复制到 SG。实际模型请求、
工具、文件和 Shell 操作在 Mac 上执行。Mac 睡眠、断网或关机时不可执行；SG 上
其它机器人继续运行。

## 安装顺序

两台机器需已安装 Codex，Mac 用户到 SG 的现有 SSH 登录必须在 BatchMode 下可用。
SG 使用现有 Botmux checkout 的 ws 依赖。当前使用的是 Codex 的原生 Unix
WebSocket 端点；app-server proxy 的 control socket 是另一种传输，不混用。

在 SG 执行：

~~~bash
python3 integrations/codex-node/install-sg.py \
  --name mac --remote-workspace /Users/example/my_project \
  --remote-root /Users/example \
  --codex-version 'codex-cli <Mac 上实际版本>'
~~~

该命令输出 SG launcher、workspace alias 和 socket 路径。Mac 上复制本目录的
host.py、install-mac.py，然后执行：

~~~bash
python3 install-mac.py --ssh-host <现有 SG SSH alias> \
  --remote-socket <SG 输出的 socket> --workspace /Users/example/my_project
launchctl bootstrap gui/$(id -u) \
  ~/Library/LaunchAgents/com.botmux.codex-node.mac.plist
~~~

这是当前用户登录后的 LaunchAgent；并非开机前的系统服务。Codex 沿用 Mac 用户的
现有登录和配置。服务只使用 Unix socket，SG 端 socket 位于该账号的 0700 目录中，
由现有 SSH 认证保护，未增加公网监听或新的 SSH 登录服务。

最后在 SG 用现有 setup/onboarding 添加一个独立 Bot：

- cliId 为 codex-app，cliPathOverride 使用安装生成的 launcher。当前
  codex-app 不接受 structured cliRuntime，不把它冒充成 codex TUI。
- workingDir 和 defaultWorkingDir 指向 SG 输出的 workspace alias。
- 新建飞书应用的 owner 必须用邮箱/union_id，不能复制其它应用的 open_id。
- 不把开发机已有 Bot 改成 Mac 节点；每个机器人独立选择执行节点。
- launcher 不实现 update：这是传输入口，不是可由 SG 安装器升级的本地 Codex 分发。

Botmux 的目录存在性检查在 SG 本机执行，所以 SG workspace 是控制面的空目录
别名，proxy 将结构化 cwd 转为真实 Mac 工作目录；它不是远程文件挂载或源码同步。
通过 --remote-root 可显式补充桌面历史会话的目录根（例如自己的 Mac home）。
原生 thread/list、thread/read 返回的 cwd 会转换为私有 SG 目录别名，并先创建空
目录，使 /adopt 不会因 SG 上找不到 /Users/... 而错误回退到 SG home。只创建目录，
不创建假的 .git，不复制代码或会话文件。超出配置映射的请求直接返回 JSON-RPC
参数错误，不拖到 90 秒启动超时；不自动重放或替换 threadId。
日常任务可以直接让 Codex 在真实 Mac 工作区进入具体仓库。Botmux 自己在 SG
执行的 Git worktree、文件预览、shell helper 与技能安装不会自动搬到 Mac。

## 生命周期与边界

- Mac host 对进程使用独占锁，登录后启动，SSH 断线按有界退避重连。
- 隧道断开不重放 in-flight JSON-RPC；无法确认的 turn 交给现有 Codex runner
  按未知结果处理。恢复连接后需用户明确重试，避免重复执行。
- native App Server 常驻在 Mac。单个 SG proxy 退出只断开客户端。
- 既有桌面端 thread 的 writer ownership 不变；不强行恢复正由另一个服务端写入
  的 thread，不修改锁文件，不宣称接入能接管所有正在运行的桌面会话。
- cwd 映射覆盖 workspace 和显式配置的 remote-root；其余目录没有自动跨主机路由。
- 新 thread 以及 runner 已明确附带 developer instructions 的 resume 请求增补
  实际执行主机与 helper 边界；没有自行发起 resume。普通
  最终回复继续走 SG 的现有自动转发。没有在 Mac 暴露宿主 Botmux 管理权限。
- JSON-RPC 单条及启动缓冲上限 16 MiB；上传的受支持图片转换为原生 image 输入，
  单张最多 8 MiB。普通文件附件中的 SG 文件路径不会自动同步到 Mac。
- debug models 使用 Mac 的 model/list，仅输出模型元数据。当前 Botmux 既有模型
  下拉按 CLI 全局键探测，不是按每个 cliRuntime 单独探测；不会据此宣称 UI
  已经显示 Mac 专属的模型目录。

## 查看与停用

Mac 状态：~/.local/state/botmux-codex-node/status.json。transport.log 与 launchd.log
只在 Mac 的私有状态目录中保存；它们不是公开诊断输出。SG 可通过生成的
codex-mac --version 或 codex-mac debug models 验证当前连接。

~~~bash
launchctl bootout gui/$(id -u)/com.botmux.codex-node.mac
~~~

停用 Mac 节点不会停 SG 的 Botmux。无需删除任何 Codex 历史或登录信息。
