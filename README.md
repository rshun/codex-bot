# Codex Bot

在 Debian 上运行的 Node.js Telegram Bot，通过本机 `codex exec` 执行任务。普通文本和 `/codex` 使用同一个会话，后续消息通过明确的会话 ID 恢复上下文。模型选择和会话关联会持久化，Bot 重启后可继续对话。

同仓库提供独立 Discord 入口 `discord.js`，共用 Codex、模型和用量查询逻辑。Telegram 的入口和 `.env` 用法保持不变；Discord 的配置、启动和独立服务见本文“Discord 配置与部署”。

远端仓库已更名为 [rshun/codex-bot](https://github.com/rshun/codex-bot)。已有本地及 Debian 目录继续使用 `codex-tg-bot`，服务名和配置路径无需改名。在已有仓库目录中可用以下命令同步远端地址，不会修改代码或重启服务：

```bash
git remote set-url origin git@github.com:rshun/codex-bot.git
git remote -v
```

## 运行前检查

需要项目已有的 Node.js 依赖和已登录的 Codex CLI。本次功能没有新增依赖，`package-lock.json` 保持不变。不要把本机安装的 CLI 版本当作 Debian 服务实际使用的版本。

在 **Bot 实际运行的 Debian 账号** 下检查以下命令。CLI 路径是项目默认值，如果配置了其他 `CODEX_BIN`，请替换为实际路径：

```bash
node --version
/home/codex/.local/bin/codex --version
/home/codex/.local/bin/codex exec --help
/home/codex/.local/bin/codex exec resume --help
/home/codex/.local/bin/codex app-server --help
```

当前依赖要求 Node.js 18 或以上；测试使用 Node.js 内置 `node:test`。CLI 的 `exec` 和 `exec resume` 都必须支持 `--json`、`--model`、`--skip-git-repo-check` 和通过 `-` 读取标准输入。版本不兼容时先停止部署，不要直接升级或安装依赖。

Discord 及全量测试要求 Node.js 22.4 或以上，且内置 WebSocket 未关闭；Telegram 运行入口仍支持项目原有 Node 要求。不新增依赖，锁文件不变。先检查 `npm ls node-telegram-bot-api dotenv --depth=0`；显示 `(empty)` 或 `MODULE_NOT_FOUND` 时，必须先恢复项目已有依赖。“无需重装”只适用于依赖已完整安装的机器。

`/quota` 还需要 CLI 提供 `app-server` 的 `initialize`、`account/read` 和 `account/rateLimits/read` 接口。仅有 `app-server --help` 不足以证明账号额度接口可用，部署后需用 `/quota` 验收；不支持时会提示版本或登录方式问题。

## 配置

如果已有 `.env`，先备份，再只补充需要的字段，不要用示例覆盖。首次配置可以复制 `.env.example` 为 `.env`，然后在本地填写实际值；真实配置不能提交到 Git。

| 字段 | 用途 | 默认值 |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot 凭据 | 必填 |
| `ALLOWED_USER_ID` | 唯一允许执行任务和修改会话的 Telegram 用户 ID | 必填，正整数 |
| `CODEX_BIN` | Codex CLI 可执行文件路径 | `/home/codex/.local/bin/codex` |
| `WORKDIR` | Codex 工作目录，必须已存在 | `/home/codex` |
| `CODEX_HOME` | Codex 配置、认证与会话存储目录 | 运行账号的 `~/.codex` |
| `CODEX_MODEL` | Bot 默认模型 ID | 空，交由 CLI 选择 |
| `CODEX_MODELS` | 逗号分隔的模型白名单 | 空，不限制符合格式的模型 ID |
| `CODEX_TIMEOUT_MS` | 单轮超时，1000–3600000 毫秒 | `120000` |
| `SESSION_FILE` | Bot 会话关联文件 | `index.js` 所在目录下的 `.bot-state/sessions.json` |

`CODEX_MODELS` 是本地白名单，不是对账号模型列表的实时查询。填写账号及 provider 实际支持的模型 ID；若同时设置 `CODEX_MODEL` 和白名单，默认模型也必须在名单中。

兼容性变化：未填写 `ALLOWED_USER_ID` 时，旧版允许所有用户执行任务，新版会拒绝启动。`/id` 仅返回发送者自己的用户 ID，不执行 Codex。

运行时自动创建状态目录及文件，在 Debian 上新建目录使用 `0700`，新建文件使用 `0600`。自定义 `SESSION_FILE` 时，放在私有目录，确保已加入忽略规则。已有目录的权限不会自动修改。不要共享同一个状态文件给多个 Bot 进程；本版只支持单实例。

若 systemd 启用了 `ProtectSystem=strict` 等沙箱设置，需核实 Bot 账号对状态目录及 Codex 会话目录有写入权限。修改 systemd 配置前备份并检查现有策略，不要扩大为全盘可写。

## 使用

从 Bot 项目目录启动，确保 dotenv 能找到该目录内的 `.env`：

```bash
npm start
```

不要在生产 Bot 仍运行时启动第二个实例，以免 Telegram polling 冲突和状态竞争。

| Telegram 输入 | 行为 |
| --- | --- |
| 普通文本 | 继续当前对话 |
| `/codex <任务>` | 与普通文本共用当前上下文 |
| `/start`、`/help` | 查看帮助 |
| `/model` | 查看当前模型选择 |
| `/model <模型名>` | 保存模型选择，下次调用传入 `--model`，上下文保留 |
| `/model default` | 清除会话模型覆盖，使用 `CODEX_MODEL`；若未配置，则交由 CLI 默认及恢复规则决定 |
| `/models` | 查看配置的白名单，不代表服务端实际可用模型 |
| `/new` | 清除当前会话关联，下一条消息创建新会话，模型选择保留 |
| `/status` | 查看模型选择、是否已有上下文，以及空闲或忙碌状态 |
| `/usage` | 查看当前会话最近一次 CLI 返回的 token 报告 |
| `/quota` | 查询运行账号的额度窗口、剩余百分比和重置时间 |
| `/id` | 查看自己的 Telegram 用户 ID |

`/new` 不删除 Codex 历史文件。模型切换命令只保存选择，账号权限、provider 兼容性及网络将在下次实际调用时验证；`/status` 展示的是请求配置，不是服务端模型确认。明确配置 `CODEX_MODEL` 可以避免依赖 CLI 对默认模型的恢复行为。

会话按 `chat_id + message_thread_id + user_id` 隔离，群组话题的回复留在原话题。支持 `/codex@Bot用户名` 等定向命令，忽略指向其他 Bot 的命令。群组中普通消息能否被接收，仍受 Telegram privacy mode 限制。

同一会话运行时，后续任务、`/new` 和模型修改会收到忙碌提示；**不会排队，也不会自动重试**，请等待回复后重发。`/status`、`/usage`、`/quota` 和其他只读命令仍可使用。不同会话可以并行，但共享 `WORKDIR` 下的文件，不具备文件系统隔离。

## 用量查询

`/usage` 展示最近一次任务的 CLI `turn.completed.usage` 报告：输入、缓存输入、输出、推理输出，以及输入加输出。数据随当前会话保存在 `SESSION_FILE` 中，重启后保留，切换模型不清除；`/new` 清除当前会话的报告。

这是 **CLI 最近返回的统计快照**。缓存输入不再次与输入相加，推理输出也不额外加入输入加输出。本版不把恢复会话时返回的报告重复累加，不提供跨任务、今日或历史总量，也不从旧会话文件补录。官方事件格式并未在这里验证不同 Debian CLI 版本的累计口径，所以不能把这个快照保证为单条 Telegram 消息的独立消耗。

任务失败、超时或没有返回有效统计时，记录结果状态，缺失字段显示“未知”，不能当成 0；失败任务不会继续显示前一任务的数字。任务运行中查询时，会明确显示的是上次保存的报告。用量写入失败会保留任务回答并提示检查状态目录权限，暂停该会话进一步执行；原上下文及状态文件不主动删除。

`/quota` 启动短期 `codex app-server` 子进程，完成初始化后通过 `account/read` 检查登录方式，再读取 `account/rateLimits/read`。它使用与任务执行一致的 `CODEX_BIN`、服务账号和 `CODEX_HOME`。

返回的数据包含各额度组的主窗口与次窗口：窗口时长、已用百分比、剩余百分比和重置时间。优先展示 `rateLimitsByLimitId` 的多个额度组，旧接口仅返回 `rateLimits` 时兼容单组数据；剩余百分比按 `100 - usedPercent` 计算并限制在 0–100%。缺失值显示“未知”。所有查询和重置时间按北京时间展示，窗口长度使用服务器实际返回值，不固定写成 5 小时或每周。

这是账号在多个客户端间共享的额度，不能与 token 数直接换算。当前仅支持 `account/read` 返回的 ChatGPT 账号；API Key、Bedrock、第三方 provider 或未登录账号会得到明确提示，不伪造剩余数值。不会显示账号邮箱、凭据或原始 RPC 错误内容。

额度查询默认等待最多 15 秒；查询结束会关闭子进程，忽略 EOF 时 1 秒后发送 `SIGTERM`，再等 1 秒必要时发送 `SIGKILL`。并发 `/quota` 请求共享同一次查询，结束后的下一次命令重新读取，不使用陈旧缓存。查询只使用初始化和账号读取方法，不启动模型任务、不消费重置券、不修改 Bot 会话关联。

这两个命令无需新增 `.env` 字段或依赖。仅允许 `ALLOWED_USER_ID` 使用，群组命令支持 `@Bot用户名` 和原话题回复。

## 会话与错误处理

首轮使用 `codex exec --json`，读取 `thread.started` 后立即保存 ID；后续使用 `codex exec resume <会话ID> --json`，不使用 `--last`。只将最后一条非 commentary 的 `agent_message` 返回 Telegram，不回传工具事件和原始 stderr。

状态文件只保存会话 ID、模型覆盖、最近一次 token 报告以及运行目录标识。完整历史由 Codex 保存。重启、迁移或备份时，要同时保留 Bot 状态文件和对应 `CODEX_HOME` 的会话存储，并维持相同运行账号和目录。状态文件损坏或 `WORKDIR` / `CODEX_HOME` 不匹配时拒绝启动，不会覆盖原文件。旧版不含 token 报告的状态文件兼容读取；首次写入后仍保持版本号 1，新字段是可选扩展。Windows 上原子替换遇到 `EPERM` 时最多尝试 5 次，等待总计不超过 100 毫秒；其他错误和 Debian 写入失败直接报告。

升级前的消息没有 Bot 会话关联，升级后从新会话开始，不自动挑选历史会话。会话文件缺失、模型不可用或恢复失败时，保留已知关联并提示检查，不自动退回没有上下文的新对话。运行期间状态保存失败会停止当前任务，暂停该会话继续执行；修复权限后使用 `/new` 明确开始新对话。

超时会先向当前 Codex 子进程发送 `SIGTERM`，5 秒后必要时发送 `SIGKILL`。超时可能发生在工具已部分执行之后，不能视为回滚；派生的工具进程也不保证已全部停止。先核实文件或操作结果，再决定是否重试。

Bot 不把 Telegram Token 传给 Codex 子进程；回复会屏蔽环境配置中的凭据和常见密钥、凭据赋值及连接串格式。错误日志仅记录固定类别，不记录原始异常、提示词或 stderr。这不改变 Codex 的文件访问、MCP、网络或命令执行权限，请继续沿用并审查服务账号现有权限配置。

## 本地验证

```bash
npm test
node --check index.js
node --check codex-runner.js
node --check session-store.js
node --check usage.js
node --check quota.js
node --check discord.js
node --check discord-client.js
git diff --check
```

自动化测试只使用模拟 Telegram 方法和 Codex 子进程，不调用模型、不使用真实凭据、不连接 Telegram。覆盖会话恢复、重启、模型切换、默认模型、会话隔离、忙碌保护、超时、错误事件、UTF-8 分片、脱敏及状态写入失败，也覆盖 token 快照保存、未知值、额度接口握手、多窗口、登录方式、并发查询和子进程退出。测试文件保留在已忽略的 `.test-artifacts/` 下，不自动删除任何文件。

Debian 实际验收需要使用已运行的 Bot：

1. 发送“记住测试代号：上下文验收甲”，随后询问代号，确认前文可被引用。
2. 使用 `/model <账号支持的另一个模型ID>`，再问代号，确认切换后仍有上下文；核实 CLI 实际模型记录，不能只看 `/status`。
3. 使用 `/new`，确认下一轮不再沿用前文，同时模型选择保留。
4. 在受控重启前建立会话，重启后追问，确认状态文件和 Codex 历史都被恢复。
5. 长任务期间连发一条消息和 `/model`，确认收到忙碌提示；通过 `/status` 查看处理状态。
6. 对账号不支持但格式合法的模型，确认得到脱敏失败提示，改回可用模型后仍能恢复原会话。
7. 完成一个普通任务后发送 `/usage`，确认获得 token 报告，缺失的字段显示“未知”；重启后再查询，确认报告仍保留。
8. 在 ChatGPT 登录方式下发送 `/quota`，确认显示额度窗口及北京时间重置时间。API Key/provider 登录时应收到不支持提示，而不是剩余 0%。

## Discord 配置与部署

Discord 增量在 `codex/discord` 分支开发，审查并合入远端 `master` 后才能部署生产。第一版支持一个授权用户、私聊、白名单频道/线程、文字消息和原生斜杠命令，使用单个 Gateway 连接。没有附件、语音、多人共享对话或分片功能。只需出站 HTTPS 和 WebSocket，无需新增入站端口或反向代理。

Discord 默认工作目录是 `/home/codex/discord-workdir`，状态文件是 `.bot-state/discord-sessions.json`，与 Telegram 分开。可以共用服务账号及 `CODEX_HOME`，Codex 额度和账号并发限制也共用。若主动共用 `WORKDIR`，两个服务可能同时修改同一工作树；本版没有跨进程任务锁，不应同时向同一工作树发修改任务。分开工作目录不会改变 Codex 账号既有的文件访问权限。

状态新增 `platform` 标识，旧状态默认归属 Telegram。Discord 键为 `discord:频道ID:0:用户ID`，线程有自己的频道 ID 和上下文。平台不匹配会拒绝读取。自定义状态路径也必须独立，不能给两个进程共享同一个文件。没有跨平台账号绑定或上下文共享。

**Discord 控制台准备：** 创建专用应用和 Bot，本地保存 Token；启用 Bot 的 Message Content Intent，本版即使只用斜杠命令也请求此 intent。通过 `bot` 和 `applications.commands` scopes 邀请到服务器，按需授予 View Channel、Send Messages、Read Message History、Send Messages in Threads 权限，不需要 Administrator。私有线程需要 Bot 已加入。启用客户端 Developer Mode 后复制用户、频道和线程 ID。

`DISCORD_ALLOWED_USER_ID` 必填。`DISCORD_CHANNEL_IDS` 是逗号分隔的精确频道或线程白名单，留空禁用所有服务器频道；父频道不自动授权新线程。私聊默认开启且只接受授权用户，可用 `DISCORD_ALLOW_DMS=false` 关闭。其他用户的文字消息静默忽略，斜杠命令返回未授权提示。

在 myServer 上，以实际服务账号进入项目目录。以下示例按已有 `/home/codex/codex-tg-bot` 路径编写，执行前核对服务账号、目录和 Node 二进制：

```bash
cd /home/codex/codex-tg-bot
git branch --show-current
git status --short
systemctl show codex-tg-bot.service --property=User,WorkingDirectory
node --version
npm ls node-telegram-bot-api dotenv --depth=0
```

先按本文“部署与回滚”备份，再拉取已审查的 `master`。若缺少依赖，先备份现有 `node_modules` 和依赖文件，确认接受恢复后手动执行 `npm ci --omit=dev`；该命令会重建 `node_modules`，按锁文件恢复已有依赖，不升级依赖或修改锁文件。安装失败则停止部署。

首次配置确认 `.env.discord` 尚不存在；已存在时先备份，在原文件上修改。下面的复制不覆盖已有文件：

```bash
umask 077
cp -an .env.discord.example .env.discord
mkdir -p /home/codex/discord-workdir
```

在本地编辑 `.env.discord`，填写 Token、用户 ID、频道白名单。真实配置、状态和注册备份已被忽略，不能上传聊天或 Git。`CODEX_*` 字段同 Telegram，Discord 超时上限为 600000 毫秒。默认只读入口旁的 `.env.discord`，不自动读 `.env`；`DISCORD_ENV_FILE` 可指定其他私有配置。

```bash
node --check discord.js
node --check discord-client.js
npm test
node discord.js --check-config
```

`--check-config` 只读检查配置、已有状态、工作目录、状态目录及绝对 CLI 路径的本地权限，不创建状态，不连接 Discord；不能证明网络和 Codex 登录可用。仍须以实际账号和 `CODEX_HOME` 完成本文章前面的 Codex 检查。systemd 的 Node 版本以 `ExecStart` 中的二进制为准。

**使用：** 普通文字继续当前对话；也支持 `!codex 任务`、`!model 模型ID`、`!model default`、`!new`、`!models`、`!status`、`!usage`、`!quota`、`!id`、`!help`。这些文字命令无需注册。原生斜杠命令使用 `/codex task:...` 和 `/model name:...`，其余命令同名。

服务启动不自动注册斜杠命令。需要注册时填写 `DISCORD_APPLICATION_ID`；可先填 `DISCORD_COMMAND_GUILD_ID` 在一个服务器验收，留空则注册全局命令。服务器命令不出现在私聊，私聊仍可用文字命令；全局命令在私聊的可见性也取决于应用安装及共同服务器。改变注册作用域不会自动删除原作用域的命令。

```bash
# 无需凭据、无网络请求，仅输出准备注册的定义。
node discord.js --register-commands
# 核对应用、作用域及命令后，手动确认执行：
node discord.js --register-commands --apply
```

`--apply` 更新所选作用域内九个同名命令，其他命令保留。更新前读取现有定义，写入 `.local-backups/discord-commands-*.json` 私有备份，备份失败不更新。中途失败可能只更新了一部分，检查原因后可以重新执行。不自动删除任何命令。

斜杠命令先发送延迟确认，确认失败不执行任务；回复只对发起人可见。普通文字回复对所在频道可见。长回复自动分段，关闭用户、角色和 everyone 提及。交互有有效期，即使任务成功，极慢网络下回复仍可能失败，不得因此自动重跑任务。

前台验收可运行 `npm run start:discord`，前提是 Discord 服务尚未运行；看到 `Discord gateway ready.` 只证明 Gateway 已连接。验收完退出前台进程，再交给 systemd，不能运行两个 Discord 实例。

**独立服务：** 示例为 `deploy/codex-discord-bot.service.example`。先核对其中的账号、组、Node、项目和配置路径。首次安装先确认没有旧 unit；若已存在，先备份实际 unit 并审查差异，不能直接覆盖：

```bash
systemctl show codex-discord-bot.service --property=LoadState,FragmentPath,User,WorkingDirectory
```

首次部署 `LoadState=not-found` 是正常情况。核对示例且确认目标不存在后，由操作者执行：

```bash
sudo install -m 0644 deploy/codex-discord-bot.service.example /etc/systemd/system/codex-discord-bot.service
sudo systemctl daemon-reload
sudo systemctl enable --now codex-discord-bot.service
systemctl is-active codex-discord-bot.service
journalctl -u codex-discord-bot.service -n 30 --no-pager
```

已有 Discord 服务更新时，确认空闲，备份源码、配置、独立状态及 unit，再更新审查后的文件。需要更新 unit 时执行 `daemon-reload`，确认会短暂离线并中断运行任务后，手动执行 `sudo systemctl restart codex-discord-bot.service`。示例用 `KillMode=control-group`，停止时会终止服务的 Codex 子进程。Telegram 服务配置不变；共享核心升级后的 Telegram 回归验收仍按其部署步骤进行。

验收私聊、白名单频道及线程的连续对话、模型切换、`new`、用量、额度和帮助；确认其他用户、Bot/webhook、未授权频道不执行任务，长任务期间拒绝新任务但允许状态查询，受控重启后上下文恢复。线程须单独列入白名单。本地测试使用模拟 REST/Gateway/Codex；真实账号、网络、意图和平台权限必须在 Debian 实际验收。

固定错误：`dependency_missing` 检查已有 Node 依赖；HTTP 401 检查凭据，403 检查权限；`close_4014` 检查 Message Content Intent；`node_websocket_required` 检查 Node 和启动参数。断线和无心跳 ACK 会恢复连接；连续十次恢复失败、认证/意图不允许或会话启动额度不足时停止，交由 systemd 的有限重启策略处理。不记录原始错误、Token 或 Gateway session 信息。

**READY 握手启动故障：** 初始 Discord 版的地址校验过严，会拒绝 `gateway-us-east1-b.discord.gg` 这类区域恢复地址，记录 `ready_protocol` 并退出。修复版支持 Discord 区域 Gateway，同时继续拒绝外部域名、明文 WebSocket、带凭据或非默认端口的地址。READY 缺少有效会话 ID 时记录 `ready_session_id`，恢复地址无效时记录 `ready_gateway_url`，不输出握手原文或会话凭据。[官方 Gateway 说明](https://docs.discord.com/developers/events/gateway)要求断线恢复使用 READY 返回的 `resume_gateway_url`。

该修复只涉及 Discord 客户端逻辑，不改变依赖、配置或状态格式，无需重置 Bot Token 或重新注册命令。在 myServer 的实际服务账号下，确认目录和分支正确、工作区干净，再备份旧客户端；任何检查、备份、拉取或测试失败，都不要重启：

```bash
cd /home/codex/codex-tg-bot
git branch --show-current
git status --short
# 确认当前为 master 且没有未提交修改后继续。
umask 077
READY_BACKUP_DIR="$PWD/.local-backups/$(date +%Y%m%d-%H%M%S)-discord-ready"
mkdir -p "$READY_BACKUP_DIR"
cp -a -- discord-client.js "$READY_BACKUP_DIR/discord-client.js"
git rev-parse HEAD > "$READY_BACKUP_DIR/revision.txt"
git pull --ff-only origin master
node --check discord-client.js
npm test
node discord.js --check-config
```

确认新代码已经包含区域 Gateway 修复，再手动执行下面的重启。重启会短暂中断 Discord 连接并终止其正在执行的任务，只影响 Discord 服务；Telegram 无需重启：

```bash
sudo systemctl restart codex-discord-bot.service
systemctl is-active codex-discord-bot.service
journalctl -u codex-discord-bot.service --since "5 minutes ago" --no-pager
```

验收新日志中出现 `Discord gateway ready.`，服务不再反复退出，再发送 `!status`、`!help` 和普通文字确认实际回复。若仍然失败，检查修复版的固定错误类别；不要发送 Token、READY 原文或 Gateway 会话 ID。回滚时先备份当前客户端，确认原 `READY_BACKUP_DIR` 和 `revision.txt` 属于此次更新，再由操作者手动用 `cp -a -- "$READY_BACKUP_DIR/discord-client.js" discord-client.js` 恢复，语法检查通过后受控重启。该回滚只恢复源码，Git HEAD 不变，工作区会出现已知修改，原地址校验故障也会恢复；配置、状态及 Codex 历史不覆盖。

回滚新增服务会中断 Discord 任务并离线。确认空闲、备份当前源码/配置/状态后，由操作者执行 `sudo systemctl disable --now codex-discord-bot.service`，只影响 Discord。unit、配置及状态可以保留，不需要删除。回滚已有 Discord 部署时成套恢复源码和 unit，检查后 `daemon-reload` 并受控重启；不能换入 Telegram 状态。斜杠命令独立于源码，停服务不删除命令，旧定义需按私有备份逐项审查恢复。

## 部署与回滚

### GitHub 发布包部署（服务器无需 Git 或 npm）

从 [GitHub Releases](https://github.com/rshun/codex-bot/releases) 下载对应版本的 `codex-bot-v版本-node.tar.gz` 和 `SHA256SUMS`。不要使用 GitHub 自动生成的 Source code 压缩包，它不包含运行依赖。发布包同时提供 Telegram、Discord、锁定的现有依赖、许可证、示例配置、服务示例和逐文件哈希清单 `release-manifest.json`。运行文件仍为 JavaScript；服务器需要 Node.js 22.4 或以上和已经安装、登录的 Codex CLI，部署时无需拉取仓库、构建或执行 npm 安装。

包不包含真实 `.env`、`.env.discord`、会话状态、Codex 认证/历史、测试、Git 元数据或本地备份。首次安装在稳定配置目录中创建配置；已有安装继续使用原配置和状态。以下按已有 `/home/codex/codex-tg-bot` 目录及 `codex` 账号编写，实际服务账号、Node 路径、自定义配置/状态和 unit 位置必须先核对。

**下载与校验：** 使用现有 `curl`、`tar` 和 `sha256sum`，没有这些工具时先停下核对环境，不自动安装。以下每一步成功后才继续；下载到新建目录，不覆盖已有包：

```bash
node --version
command -v curl tar sha256sum
BOT_DIR=/home/codex/codex-tg-bot
VERSION=1.0.0
PACKAGE_DIR="$BOT_DIR/.local-backups/package-v$VERSION-$(date +%Y%m%d-%H%M%S)"
umask 077
mkdir -p "$PACKAGE_DIR"
cd "$PACKAGE_DIR"
curl -fL -o "codex-bot-v$VERSION-node.tar.gz" "https://github.com/rshun/codex-bot/releases/download/v$VERSION/codex-bot-v$VERSION-node.tar.gz"
curl -fL -o SHA256SUMS "https://github.com/rshun/codex-bot/releases/download/v$VERSION/SHA256SUMS"
sha256sum --check SHA256SUMS
tar -tzf "codex-bot-v$VERSION-node.tar.gz"
```

**安装独立版本目录：** 确认校验通过、压缩包根目录是 `codex-bot-v$VERSION`。以服务账号执行，确认目标版本目录尚不存在；已存在时先检查原内容，不在原目录再次解压：

```bash
RELEASE_DIR="$BOT_DIR/releases/codex-bot-v$VERSION"
test ! -e "$RELEASE_DIR"
mkdir -p "$BOT_DIR/releases"
tar -xzf "$PACKAGE_DIR/codex-bot-v$VERSION-node.tar.gz" -C "$BOT_DIR/releases"
node --check "$RELEASE_DIR/index.js"
node --check "$RELEASE_DIR/discord.js"
node --check "$RELEASE_DIR/discord-client.js"
```

包没有测试目录，不要把在包内执行 `npm test` 当作完整验收。发布前在源码仓库运行全量测试和解压冒烟检查；服务器继续按本文 Telegram/Discord 实际验收流程验证网络、权限、CLI 登录、模型及上下文。

**保留配置与上下文：** `WorkingDirectory` 继续为稳定目录 `$BOT_DIR`，Telegram 从这里加载原 `.env`；Discord 的 `DISCORD_ENV_FILE` 指向原 `.env.discord`。两个服务都必须明确指定原来的 `SESSION_FILE`，不要使用新版本目录下的默认值，否则旧关联不会被读取。下面默认路径仅供核对，自定义路径时必须替换成现有实际值。保持原 `WORKDIR`、`CODEX_HOME` 和服务账号不变：

```bash
cd "$BOT_DIR"
DISCORD_ENV_FILE="$BOT_DIR/.env.discord" SESSION_FILE="$BOT_DIR/.bot-state/discord-sessions.json" node "$RELEASE_DIR/discord.js" --check-config
systemctl show codex-tg-bot.service --property=User,WorkingDirectory,FragmentPath
systemctl show codex-discord-bot.service --property=User,WorkingDirectory,FragmentPath
```

首次配置从包内 `.env.example`、`.env.discord.example` 复制到 `$BOT_DIR`，仅在目标不存在时复制；真实值在本地填写。`WORKDIR` 仍须事先存在。已有配置不要覆盖。包内的 `deploy/codex-tg-bot.service.example` 和 `deploy/codex-discord-bot.service.example` 已填写本版本入口，但账号、配置、状态路径和现有沙箱限制仍须逐项审查。

**切换现有服务：** 先确认 Bot 空闲，按本文备份要求将真实配置、实际状态、`CODEX_HOME` 和现有 unit 保存到受保护目录；确认备份可用。首次迁移时原源码目录和依赖可以保留。不要用示例整体覆盖已有 unit，只在备份后的实际 unit 中调整以下字段，保留原账号、代理环境及沙箱设置：

| 服务 | 需要核对的字段（示例路径） |
| --- | --- |
| Telegram | `WorkingDirectory=/home/codex/codex-tg-bot`；`ExecStart=/usr/bin/node /home/codex/codex-tg-bot/releases/codex-bot-v1.0.0/index.js`；`Environment=SESSION_FILE=/home/codex/codex-tg-bot/.bot-state/sessions.json` |
| Discord | 相同 `WorkingDirectory`；`ExecStart=/usr/bin/node /home/codex/codex-tg-bot/releases/codex-bot-v1.0.0/discord.js`；`Environment=DISCORD_ENV_FILE=/home/codex/codex-tg-bot/.env.discord`；`Environment=SESSION_FILE=/home/codex/codex-tg-bot/.bot-state/discord-sessions.json` |

systemd 中的 `Environment=SESSION_FILE` 优先于 dotenv 文件；若原配置使用自定义状态路径，必须将 unit 中的值也改为该路径。只迁移 Discord 时不修改 Telegram unit。首次安装 unit 时，确认目标不存在并核对包内对应示例后，再由操作者安装。

修改 unit 后确认会短暂中断所选平台连接并终止运行任务，再手动执行。以下只重启 Discord；迁移 Telegram 时使用它的实际服务名，分别验收：

```bash
sudo systemctl daemon-reload
sudo systemctl restart codex-discord-bot.service
systemctl is-active codex-discord-bot.service
journalctl -u codex-discord-bot.service -n 30 --no-pager
```

后续升级下载新版本、校验、解压到新目录，备份 unit 后仅切换入口路径，保持配置/状态路径稳定。**回滚**会中断所选服务的任务：先备份当前 unit，确认原备份及旧版本目录完整，再由操作者恢复原 unit 或改回旧版本 `ExecStart`，检查后 `daemon-reload` 并受控重启，按原平台验收。不要恢复旧状态覆盖升级期间产生的会话。新旧版本目录及备份均可保留，不自动删除。

### 维护者打包与发布

在已同步的开发分支修改并运行 `npm test`；全量测试还需要现有 Git 和系统 `tar`。审查合并到 `master` 后，以干净工作区运行 `npm run build:release`。构建仅读取项目既有、锁定的已安装依赖，不联网、不自动安装、不修改依赖和锁文件。依赖缺失或版本不符时拒绝构建，恢复安装必须先由操作者确认。只支持当前纯 JavaScript 依赖组合，未来新增依赖需要重新审查打包逻辑。

构建生成 `dist/codex-bot-v版本-node.tar.gz`、`dist/SHA256SUMS`，保留临时目录，重复构建遇到已有输出会拒绝覆盖。开发验证可用 `npm run build:release -- --allow-dirty --output .test-artifacts/your-new-build`，脏工作区产物带 `-dev`，不能发布成正式版本。发布前检查包清单、敏感信息、依赖许可证和解压运行结果，再为经过验证的 `master` 提交创建 `v版本` 标签，并上传两个文件到对应 GitHub Release。现阶段由维护者生成并上传包，没有自动安装依赖的 CI 流程。

### Git 仓库部署方式

本地开发必须在开发分支进行，修改前拉取对应远端。查询功能发布在 `codex/tg-context-model` 分支。**推送开发分支不会自动更新远端 `master` 或 Debian。** 先在 GitHub 审查该分支到 `master` 的 Pull Request 并合并，再按以下步骤更新生产机器；不要在 Debian 的 `master` 工作区直接开发。本项目不会自动部署、安装依赖或重启服务。

以下命令仅供操作者核实后手动执行。升级期间保持 Bot 空闲并停止发送任务；重启会短暂中断 Telegram 回复，正在执行的任务可能被中断。本次查询功能没有修改依赖、锁文件或配置字段，无需重新安装依赖。若从首版升级，还必须补充 `ALLOWED_USER_ID` 并检查状态目录权限。

先记录 Debian 机器、Bot 实际目录、服务名称和运行账号；这些不能仅从本地默认路径推断。在 Debian 上可设置以下占位值，并只读检查：

```bash
BOT_DIR=/path/to/codex-tg-bot
BOT_UNIT=your-bot.service
cd "$BOT_DIR"
git branch --show-current
git status --short
systemctl show "$BOT_UNIT" --property=User,WorkingDirectory,FragmentPath
git fetch origin
git log -3 --oneline origin/master
```

将 `BOT_DIR` 替换为真实的绝对项目路径，`BOT_UNIT` 替换为实际 systemd 服务名。确认当前分支是 `master`，`git status --short` 没有输出，运行账号和 `WorkingDirectory` 与预期一致，且 `origin/master` 已包含查询功能。如果有未提交改动或仍然只有首版提交，先停止升级。不要输出 `.env` 或 Codex 认证文件内容。

在 systemd 的实际运行账号及相同 `CODEX_HOME` 下，执行本文“运行前检查”中的 CLI 命令，确认 `exec/resume --json` 和 `app-server` 可用。不同账号的登录状态不能作为 Bot 账号的证明；`app-server --help` 也不能代替升级后的 `/quota` 实际验收。

备份使用私有目录，包含旧版运行文件、真实配置和会话状态；先确认磁盘空间和文件权限。下面默认配置文件为项目目录 `.env`，Bot 状态为 `.bot-state/sessions.json`。**自定义了路径时，先修改变量，再执行备份。** 从新版升级还应备份实际 `CODEX_HOME`，其中含有认证凭据，只能保存在受保护目录。

```bash
BOT_ENV="$BOT_DIR/.env"
BOT_STATE="$BOT_DIR/.bot-state/sessions.json"
CODEX_HOME_DIR=/path/to/actual/codex-home
BACKUP_DIR="$BOT_DIR/.local-backups/$(date +%Y%m%d-%H%M%S)"
umask 077
mkdir -p "$BACKUP_DIR/source"
for file in index.js package.json package-lock.json .gitignore codex-runner.js session-store.js usage.js quota.js discord.js discord-client.js; do
  if [ -f "$file" ]; then
    cp -a -- "$file" "$BACKUP_DIR/source/"
  fi
done
git rev-parse HEAD > "$BACKUP_DIR/revision.txt"
if [ -f "$BOT_ENV" ]; then
  cp -a -- "$BOT_ENV" "$BACKUP_DIR/bot.env"
fi
if [ -f "$BOT_STATE" ]; then
  cp -a -- "$BOT_STATE" "$BACKUP_DIR/bot-session-state.json"
fi
cp -a -- "$CODEX_HOME_DIR" "$BACKUP_DIR/codex-home"
```

逐项确认备份成功，再更新代码。如果 `CODEX_HOME_DIR` 不存在、备份失败或空间不足，停止升级并检查实际目录，不要跳过备份。从首版升级时没有 Bot 状态文件是正常情况。备份不能上传仓库或聊天。

```bash
git pull --ff-only origin master
git log -1 --oneline
node --check index.js
node --check codex-runner.js
node --check session-store.js
node --check usage.js
node --check quota.js
npm test
```

拉取、语法检查或测试任一步失败，都不要重启。测试仅使用模拟子进程，不调用真实模型，也不连接 Telegram。不要覆盖已有 `.env`；从首版升级时，在已备份配置上只补充必填用户 ID 和所需可选设置。确认全部运行文件已更新，特别是新增的 `usage.js` 和 `quota.js`。

**重启影响：** 正在进行的 Bot 任务可能中断，Telegram 短暂无法响应。先用 `/status` 确认没有运行中的任务，核实新配置和状态目录权限，再由操作者执行：

```bash
sudo systemctl restart "$BOT_UNIT"
systemctl is-active "$BOT_UNIT"
journalctl -u "$BOT_UNIT" -n 50 --no-pager
```

日志仅应包含固定错误类别。提交工单或聊天前，仍需检查并脱敏服务历史日志。随后发送 `/help`、`/status`，完成一次任务并查询 `/usage`，再查询 `/quota`；最后完成上面的上下文、模型及重启恢复验收。若 CLI 或登录方式不支持额度接口，Bot 应返回明确提示，不能以此认定查询已在生产验证成功。

如需回滚，先确认 Bot 空闲，重新备份当前运行文件和状态，避免丢失升级后产生的会话。核实原备份目录的 `revision.txt` 和 `source/` 确实属于此次升级，再由操作者恢复旧版运行文件；该操作覆盖代码，重启影响与升级相同：

```bash
# 新终端执行时，重新设置真实的 BOT_DIR、BOT_UNIT 和原 BACKUP_DIR。
cat "$BACKUP_DIR/revision.txt"
ls "$BACKUP_DIR/source"
cp -a -- "$BACKUP_DIR/source/." "$BOT_DIR/"
node --check "$BOT_DIR/index.js"
sudo systemctl restart "$BOT_UNIT"
systemctl is-active "$BOT_UNIT"
journalctl -u "$BOT_UNIT" -n 50 --no-pager
```

不自动恢复 `.env`、Bot 状态或 Codex 历史；只有确认必须恢复且当前文件已另行备份时，才逐项处理。上下文/模型版会忽略新增 token 字段，后续保存可能清除报告，但会话 ID 和模型仍可使用。首版会失去上下文和模型命令。新增模块可以保留，不需要删除。

这种恢复只回滚运行文件，不改变 Git 分支或 HEAD，因此 `git status` 会显示恢复后的本地修改。下次升级前必须先处理这些已知回滚改动，不能在脏工作区直接拉取。不要使用 `git reset --hard`、`git clean` 或强制推送，也不要用早期状态备份覆盖升级期间新产生的会话。

## Git 与敏感信息

提交源码、依赖声明、锁文件、测试、README 和 `.env.example`；忽略 `node_modules/`、真实 `.env`、`.bot-state/`、测试产物、备份和日志。自定义状态文件不要放进已跟踪路径。

提交前检查 `git diff --cached`、未跟踪的新文件和敏感关键词。禁止提交 Telegram Token、Codex 认证文件、API Key、密码或真实环境配置。示例文件只能保留占位符。

## 官方参考

- [Codex 非交互模式、JSONL 事件与会话恢复](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Codex CLI 命令与模型参数](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
- [Codex App Server 账号及额度接口](https://learn.chatgpt.com/docs/app-server)
- [Discord Gateway 与意图](https://docs.discord.com/developers/events/gateway)
- [Discord 命令注册](https://docs.discord.com/developers/interactions/application-commands)
- [Discord 交互确认和有效期](https://docs.discord.com/developers/interactions/receiving-and-responding)
- [Node 内置 WebSocket](https://nodejs.org/api/globals.html#class-websocket)
