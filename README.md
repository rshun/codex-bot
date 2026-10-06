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
```

当前依赖要求 Node.js 18 或以上；测试使用 Node.js 内置 `node:test`。CLI 的 `exec` 和 `exec resume` 都必须支持 `--json`、`--model`、`--skip-git-repo-check` 和通过 `-` 读取标准输入。版本不兼容时先停止部署，不要直接升级或安装依赖。

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
| `/id` | 查看自己的 Telegram 用户 ID |

`/new` 不删除 Codex 历史文件。模型切换命令只保存选择，账号权限、provider 兼容性及网络将在下次实际调用时验证；`/status` 展示的是请求配置，不是服务端模型确认。明确配置 `CODEX_MODEL` 可以避免依赖 CLI 对默认模型的恢复行为。

会话按 `chat_id + message_thread_id + user_id` 隔离，群组话题的回复留在原话题。支持 `/codex@Bot用户名` 等定向命令，忽略指向其他 Bot 的命令。群组中普通消息能否被接收，仍受 Telegram privacy mode 限制。

同一会话运行时，后续任务、`/new` 和模型修改会收到忙碌提示；**不会排队，也不会自动重试**，请等待回复后重发。`/status` 和只读命令仍可使用。不同会话可以并行，但共享 `WORKDIR` 下的文件，不具备文件系统隔离。

## 会话与错误处理

首轮使用 `codex exec --json`，读取 `thread.started` 后立即保存 ID；后续使用 `codex exec resume <会话ID> --json`，不使用 `--last`。只将最后一条非 commentary 的 `agent_message` 返回 Telegram，不回传工具事件和原始 stderr。

状态文件只保存会话 ID、模型覆盖以及运行目录标识。完整历史由 Codex 保存。重启、迁移或备份时，要同时保留 Bot 状态文件和对应 `CODEX_HOME` 的会话存储，并维持相同运行账号和目录。状态文件损坏或 `WORKDIR` / `CODEX_HOME` 不匹配时拒绝启动，不会覆盖原文件。

升级前的消息没有 Bot 会话关联，升级后从新会话开始，不自动挑选历史会话。会话文件缺失、模型不可用或恢复失败时，保留已知关联并提示检查，不自动退回没有上下文的新对话。运行期间状态保存失败会停止当前任务，暂停该会话继续执行；修复权限后使用 `/new` 明确开始新对话。

超时会先向当前 Codex 子进程发送 `SIGTERM`，5 秒后必要时发送 `SIGKILL`。超时可能发生在工具已部分执行之后，不能视为回滚；派生的工具进程也不保证已全部停止。先核实文件或操作结果，再决定是否重试。

Bot 不把 Telegram Token 传给 Codex 子进程；回复会屏蔽环境配置中的凭据和常见密钥、凭据赋值及连接串格式。错误日志仅记录固定类别，不记录原始异常、提示词或 stderr。这不改变 Codex 的文件访问、MCP、网络或命令执行权限，请继续沿用并审查服务账号现有权限配置。

## 本地验证

```bash
npm test
node --check index.js
node --check codex-runner.js
node --check session-store.js
git diff --check
```

自动化测试只使用模拟 Telegram 方法和 Codex 子进程，不调用模型、不使用真实凭据、不连接 Telegram。覆盖会话恢复、重启、模型切换、默认模型、会话隔离、忙碌保护、超时、错误事件、UTF-8 分片、脱敏及状态写入失败。测试文件保留在已忽略的 `.test-artifacts/` 下，不自动删除任何文件。

Debian 实际验收需要使用已运行的 Bot：

1. 发送“记住测试代号：上下文验收甲”，随后询问代号，确认前文可被引用。
2. 使用 `/model <账号支持的另一个模型ID>`，再问代号，确认切换后仍有上下文；核实 CLI 实际模型记录，不能只看 `/status`。
3. 使用 `/new`，确认下一轮不再沿用前文，同时模型选择保留。
4. 在受控重启前建立会话，重启后追问，确认状态文件和 Codex 历史都被恢复。
5. 长任务期间连发一条消息和 `/model`，确认收到忙碌提示；通过 `/status` 查看处理状态。
6. 对账号不支持但格式合法的模型，确认得到脱敏失败提示，改回可用模型后仍能恢复原会话。

## 部署与回滚

本地开发必须在开发分支进行，修改前拉取对应远端。功能经审查并合入 `master` 后，才能把该生产基线更新到 Debian。本项目不自动提交、推送、安装依赖或重启服务。

先记录 Debian 机器、Bot 实际目录、服务名称和运行账号；这些不能仅从本地默认路径推断。在 Debian 上可设置以下占位值，并只读检查：

```bash
BOT_DIR=/path/to/codex-tg-bot
BOT_UNIT=your-bot.service
cd "$BOT_DIR"
git branch --show-current
git status --short
systemctl show "$BOT_UNIT" --property=User,WorkingDirectory,FragmentPath
```

生产目录有未提交改动时先停止更新，不要覆盖。确认已审查的版本在远端 `master` 后，先备份，再 fast-forward 更新；以下步骤由操作者确认后执行：

```bash
BACKUP_DIR="$BOT_DIR/.local-backups/$(date +%Y%m%d-%H%M%S)"
umask 077
mkdir -p "$BACKUP_DIR"
cp -a index.js package.json package-lock.json .gitignore "$BACKUP_DIR/"
git rev-parse HEAD > "$BACKUP_DIR/revision.txt"
# 如已有真实配置和会话状态，也备份到同一个私有目录。
# 使用实际路径；cp -a 保留权限，不打印文件内容。
# cp -a .env "$BACKUP_DIR/"
# cp -a .bot-state "$BACKUP_DIR/"

git pull --ff-only origin master
node --check index.js
node --check codex-runner.js
node --check session-store.js
```

上述备份列表适用于从首版升级；若已有新版模块，也要备份 `codex-runner.js` 和 `session-store.js`。不要覆盖已有 `.env`，只补充必填用户 ID 及所需可选设置；自定义状态路径时备份真实路径。复制整个 `CODEX_HOME` 可能包含认证凭据，只能放在受保护的备份位置，不能上传仓库或聊天。

**重启影响：** 正在进行的 Bot 任务可能中断，Telegram 短暂无法响应。先用 `/status` 确认没有运行中的任务，核实新配置和状态目录权限，再由操作者执行：

```bash
sudo systemctl restart "$BOT_UNIT"
systemctl is-active "$BOT_UNIT"
journalctl -u "$BOT_UNIT" -n 50 --no-pager
```

日志仅应包含固定错误类别。提交工单或聊天前，仍需检查并脱敏服务历史日志。随后完成上面的 Debian 实际验收。

从首版升级后的代码回滚：确认 Bot 空闲，使用记录的备份目录，把备份的 `index.js` 和 `package.json` 复制回对应位置，必要时恢复你改过的配置，再按同样影响范围确认重启。首版不导入新增模块，可以保留新增文件及状态文件，不需要删除。不要使用 `git reset --hard`、`git clean` 或强制推送。回滚至首版后会失去上下文和模型命令，保留的新状态可供以后再次升级使用。

## Git 与敏感信息

提交源码、依赖声明、锁文件、测试、README 和 `.env.example`；忽略 `node_modules/`、真实 `.env`、`.bot-state/`、测试产物、备份和日志。自定义状态文件不要放进已跟踪路径。

提交前检查 `git diff --cached`、未跟踪的新文件和敏感关键词。禁止提交 Telegram Token、Codex 认证文件、API Key、密码或真实环境配置。示例文件只能保留占位符。

## 官方参考

- [Codex 非交互模式、JSONL 事件与会话恢复](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Codex CLI 命令与模型参数](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
