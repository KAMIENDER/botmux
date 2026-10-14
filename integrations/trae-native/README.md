# TRAE 原生会话后端（实验性适配）

让 Botmux 的新会话使用开发机上的 TRAE Remote SSH 原生后端。TRAE 桌面端和 Botmux 保存并继续同一个原生会话 ID；开发机上的 systemd 用户服务负责保持原生进程运行，Mac 断开不会终止它。

这是使用已安装 TRAE 内部 IPC SDK 的独立适配器，不是 TRAE 官方公开的稳定 API。当前验证版本为 TRAE CN 3.4.2，Remote SSH 安装标识为 `667d4fc5e62308ade25d24a60929a78863d65e00`，Botmux 为 3.42.0。SDK、TRAE 二进制和登录信息都不放进仓库。

## 组成

- `provider.cjs`：Botmux 现有 [Remote Runner 协议](../../docs/remote-runner.md)的 JSONL provider。
- `native-client.cjs`：通过已安装的 `@aha-kit/ipc` / `@aha-kit/rpc` 访问原生 agent；处理有限的桌面回调。
- `workspace.cjs`：按会话目录自动读取当前项目和用户规则，限制回调的目录范围。
- `desktop/`：自己编写的一次性账号初始化扩展，通过 TRAE 命令 API 获取当前登录信息和全局配置。
- `capture-runtime.py` / `runtime.cjs` / `install.py`：记录原安装的启动参数，安装并保持用户服务。
- `session-cli.cjs`：查看原生会话、检查状态、将已有原生会话接入 Botmux。

适配器不修改 Botmux 核心、TRAE 程序或原生数据库。已验证原生 Shell 由开发机的 agent-tool-host 执行。文件读取探查未观察到模型真正调用文件工具，因此不把它记为通过的运行验证。

## 初始化

前提：Linux 开发机已经装好 TRAE Remote SSH，并用同一个内部账号成功创建过 SSH 任务。当前初始化扩展只支持内部 bytedance 账号。

1. 在开发机打包自己的扩展，输出放在仓库外：

   ```sh
   python3 integrations/trae-native/desktop/package-vsix.py /tmp/botmux-native-setup.vsix
   ```

2. 在 TRAE 的 Remote SSH IDE 窗口安装该 VSIX，运行命令 **Botmux: Initialize Native TRAE Backend**。这是显式初始化操作；扩展不会后台自动导出凭据。
3. 找到当前用户原生 Remote SSH launcher 的精确 PID（node 参数包含 `index_trae.js --start-server`），记录已有安装：

   ```sh
   python3 integrations/trae-native/capture-runtime.py <launcher-pid>
   python3 integrations/trae-native/install.py
   systemctl --user daemon-reload
   ```

   必须保留原来的 Machine ID、安装 PID/log/token 文件，桌面重连才能复用此服务。capture 脚本不会保存明文 token 启动参数，只保存已有 token 文件路径，并移除 Remote SSH 自动退出参数。

4. 让未由 systemd 管理的原生 launcher 及其子进程完全退出后，再启动服务；不要在仍有原生数据库写进程时启动第二份实例。`runtime.cjs` 会拒绝重复 writer：

   ```sh
   systemctl --user enable --now botmux-trae-native.service
   systemctl --user show botmux-trae-native.service -p MainPID -p ActiveState
   loginctl show-user "$USER" -p Linger
   ~/.local/bin/botmux-trae-native doctor
   ```

   要在退出 SSH 登录后保持用户服务运行，需要宿主用户启用 linger。初次交接原生进程应在维护窗口完成；这会暂时断开桌面 Remote SSH 连接。重新连接后应仍只有一个原生 ai-agent。

账号初始化只需做一次；切换到新的项目目录不需要再次初始化。旧 `workspaces.json` / `runtime.workspaceFolders` 仅保留初始化时的观察信息，不再限制新会话。运行凭据、动态配置和全局配置快照保存在 `~/.botmux/trae-native/`（目录 700、JSON 文件 600）。初始化使用当前账号已有 token，不扩大其有效期；过期后需刷新 TRAE 登录并再次初始化。不能用 TraeX 的 Git 登录凭据替代原生 TRAE 登录。

## Botmux 配置

备份 `~/.botmux/bots.json`，仅修改目标 Bot 的以下字段，保留其它配置：

```json
{
  "cliId": "remote-runner",
  "backendType": "remote-runner",
  "cliPathOverride": "/home/your-user/.local/bin/botmux-trae-native",
  "remoteRunner": {
    "expectedProvider": "trae-native",
    "requiredCapabilities": ["start","resume","turn","cancel","detach","reattach","status"],
    "handshakeTimeoutMs": 60000,
    "operationTimeoutMs": 30000
  }
}
```

用现有 `botmux stop-bot <app-id>` / `botmux start-bot <app-id>` 只重启该 Bot。其它 Bot 无需重启。

安装脚本还会在 `~/.local/bin/` 没有标准入口时，创建 `botmux-remote-runner` → `botmux-trae-native` 的链接。后台 CLI 列表只检测默认程序名，忽略单个 Bot 的 `cliPathOverride`；此入口使检测对应到实际已安装的原生 provider，避免误报“未安装”。已有其它 Remote Runner 入口时保留它，不覆盖；目标 Bot 仍使用显式路径。daemon 的 PATH 需要包含 `~/.local/bin`。

新会话保留原来的 model / reasoningEffort；保留目录中模型 ID 的大小写；旧 GPT 显示名称兼容转为小写原生 ID。已实际验证 `gpt-6.1-sol/high` 和 `GPT-5.6-Sol/xhigh`。其它组合由原生后端校验。

新会话接受当前用户可访问的、已存在的绝对目录。启动时自动准备该目录的规则上下文，复用该开发机已有 SSH 任务的 remote authority，建立对应 Native Project，并注册 Session Workspace；不要求提前在桌面打开这个项目。Botmux 的 `remoteBackendState.agentThreadId` 就是该原生 ID。重连会验证账号和目录，保留 ID；rebuild 推进 generation。

## 模型自动发现

打开后台 Agent 配置时，现有模型探测会调用标准入口的 `debug models`。原生 helper 通过当前账号向常驻后端请求 `model.model_list_by_function` 的 `solo_agent` 目录，并要求刷新原生目录缓存；只返回 `status` 和 `selectable` 均为 true 的预置模型。Builder/chat 的目录不同，不与 SOLO Agent 混用。后台沿用 10 分钟成功缓存；刷新配置页会重新请求，缓存过期后自动获取更新，无需手工维护模型名单。

输出只包含模型 ID、显示名称和可见性，不导出原生目录中的连接配置或凭据。读取目录不创建会话，也不改变 Bot 的当前模型；失败保留自定义模型入口。当前适配器执行预置模型，用户自定义的带独立连接配置的模型尚未接入。

可在开发机检查同一个自动发现入口：

```sh
~/.local/bin/botmux-remote-runner debug models
```

## 接入已有 TRAE 原生会话

开发机宿主终端执行：

```sh
~/.local/bin/botmux-trae-native sessions
~/.local/bin/botmux-trae-native adopt <native-session-id> --bot <app-id>
```

`sessions` 当前显示最多 100 条。`adopt` 校验目标 Bot、账号和实际工作目录，调用现有 `session create` 注册一个未启动的 Botmux 会话，再建立权限 600 的私有绑定，最后通过 `session send` 启动。provider 从第一轮就使用原来的原生 ID，不新建空原生任务。普通聊天中粘贴一个原生 ID不具有接入能力。

接入会追加一句“原生会话接入成功”的验证回复，不执行工具。输出提供 Botmux session ID / headless ID，后续可直接 `botmux session send` 续聊。若需要绑定到飞书，应另外使用 Botmux 现有绑定/发布流程。该 helper 不发送飞书消息。原生 ID 的绑定只由开发机宿主 helper 写入；resume 仍核验账号和工作区。

当前核心 `/adopt` 卡片不支持发现 Remote Runner 原生历史；这里提供的是独立宿主 helper。旧 TraeX CLI 对话使用不同的存储，**没有自动转换成 TRAE 原生会话**。旧 CLI 文件仍保留；如需继续旧 CLI 模式，应回退该 Bot 的配置。安装的入口在 TTY/旧 CLI 参数调用下仍委托原 TraeX，以保持旧执行方式兼容。

## 运行中补充消息

原生 provider 额外声明可选 `concurrent_turns` 能力。Botmux 只对声明此能力的结构化后端放行普通交互消息的 type-ahead，其他 provider 保持串行；定时任务、工作流等 durable 输入及跨主体隔离继续使用现有串行门禁。

运行中发送新消息，provider 调用原生 `lite.send_message` 的 inbox 追加路径，要求 `accepted: true` 与精确 `message_id` 回执，再向 Botmux 确认接收。后端负责在原生可消费输入的位置处理补充，不能保证打断正在执行的工具或模型输出。适配器最多跟踪 32 个未结束输入，分别按对应原生回复查询完成或取消；Botmux 按输入顺序交付各轮终态，避免后来的回复归到上一条消息。

## 生命周期与边界

- 原生后端在开发机常驻，Mac 只是客户端。开发机本身关机、网络或登录失效仍会影响运行。
- 允许两边接续同一会话；不要同时提交两轮。后端明确拒绝的请求不会自动重放。传输超时、接受后掉线等无法确认结果的情况会标记 ambiguous，并关闭该 provider 的写入能力。
- 每轮 final 都核验持久历史中 reply_to_message_id 对应的已完成 assistant 回复，避免把另一客户端的完成事件当成本轮结果。周期性历史查询也能补回建立事件订阅前就已完成的回复。
- 原生端取消一轮后，以该输入对应的持久 assistant 状态确认取消，释放这一轮并允许新消息继续原会话；不会把已确认的取消当成永久错误。事件订阅结束或丢失时仍查询精确回复，避免误认另一客户端的 done。未知结果保持写入保护，只有确认对应回复已完成或取消后，新输入才可恢复；不自动重放旧任务。
- 关闭 Botmux 会话使用原生 stop，再确认 `status:closed`；不删除原生历史。空闲 detach 保留原生会话，冷启动 resume 读取原 ID。Mac 断线不依赖 detach。
- 当前桌面回调覆盖动态配置、自动发现规则、有限目录读取、SSH workspace 注册和有限的终端环境。每次规则请求重新扫描用户 `user_rules.md` / `user_rules/` 和当前项目 `.trae/rules/`；按全局开关导入 `AGENTS.md` / Claude 规则，文件请求读取该项目内的上级规则。新增、删除和修改规则不需重新初始化。全局开关仍来自账号初始化快照，修改它们后需重新初始化；旧快照缺少开关时使用已核对的 TRAE CN 3.4.2 默认值（AGENTS 开、Claude 关）。
- 其它 VSCode 回调明确报 unsupported，不伪造工具成功。未验证或接入完整桌面 MCP、浏览器、审批 UI、Web 终端画面及 Botmux actor / execution 进程树身份桥接；不能把它们算作已支持。此改动也不保证原有工作流工具在原生 Shell 中具有相同身份能力。
- 只把非敏感 Botmux 路由上下文传给原生 terminal contributed env；不注入或伪造 actor 身份、不暴露凭据。
- native SDK 从唯一当前用户的原生 ai-agent 安装目录加载；出现两个 writer 就失败，不能猜选其中一个。

## 维护与回退

TRAE 升级可能更换安装路径、SDK 或内部接口。先暂停目标 Bot，停止该用户服务，完成 TRAE 原生安装/登录并重新 capture + initialize，再安装服务定义、交接 launcher、重启和验证。不要直接升级后同时启动新旧两个 ai-agent。仍需实际验证创建、工具执行、桌面显示、同 ID 续聊和离线运行。

回退时暂停目标 Bot，只从私有备份恢复该 Bot 的旧 cliId/backendType/path/remoteRunner 字段，再启动 Bot。其它 Bot 的配置不应被旧整文件覆盖。停止本服务前先断开所有复用它的 TRAE 客户端；停止后原生数据仍留在原来的 TRAE 用户目录。

## 已完成的运行验证（2026-10-13）

没有运行编译或自动测试套件。实际运行证据分别包括：

- 原生 IPC 执行消息并得到已完成回复。
- 原生 Shell 在开发机 agent-tool-host 执行且 exit 0。
- Mac Remote SSH 显式断开后仍能执行 Shell，重连复用同一个 systemd MainPID，桌面可见断线期间的回复。
- 原生 SSH 任务在桌面项目列表显示，并能从桌面继续。
- Botmux 真正的 `session start --headless` 执行原生 Shell，返回 `BOTMUX_NATIVE_OK`，持久状态保存原生会话 ID。
- 宿主 helper 接入已有原生任务，Botmux 读到桌面之前的英文标记并返回；只重启目标 Bot 后再次续聊仍保留原生 ID 和上下文。
- Botmux 关闭验证会话成功，原生历史仍可读取。
- 在未加入初始化目录列表的 `/home/hejiadong.1024/project/ai_review_self_iteration` 中，真实 headless 运行自动创建原生会话并返回 `AUTO_WORKSPACE_OK`；没有手动打开或初始化该项目。此项验证没有执行工具或业务任务。
- 原生 SOLO Agent 模型目录自动返回 20 个当前可选预置模型，包括 GPT-6.1-Sol、GPT-6-Astra 和 GPT-5.6 系列；无需保存一份静态模型名单。
