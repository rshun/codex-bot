# Codex Telegram Bot

在 Debian 上运行的 Node.js Telegram Bot，通过本机 `codex exec` 执行任务。普通文本和 `/codex` 使用同一个会话，后续消息通过明确的会话 ID 恢复上下文。模型选择和会话关联会持久化，Bot 重启后可继续对话。

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

## 部署与回滚

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
for file in index.js package.json package-lock.json .gitignore codex-runner.js session-store.js usage.js quota.js; do
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
