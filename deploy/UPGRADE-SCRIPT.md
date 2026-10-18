# TG / Discord 一次升级到 v1.6.0

脚本文件为 [`upgrade-v1.6.0.sh`](upgrade-v1.6.0.sh)，单文件、UTF-8 / LF，依赖 Debian 已有的 Bash、Node 22.4+、sudo、systemctl、flock、tar、curl、sha256sum 和 cp。不安装依赖、不删除文件、不覆盖真实配置。它固定使用官方 v1.6.0 运行包及 SHA-256，不修改已发布标签或运行包。

面向前述两个 Node systemd 服务、升级前为 v1.5.0 的标准部署。默认以 `codex` 执行，项目目录为 `/home/codex/codex-tg-bot`，两个服务的 `WorkingDirectory` 均为此目录，配置分别为 `.env` / `.env.discord`。`WORKDIR` 是 Codex 工作区，可以按两个配置分别设置，不等同于 systemd 的 `WorkingDirectory`。

## 使用

先将脚本上传到 Debian，例如 `/home/codex/upgrade-v1.6.0.sh`，由实际服务账号运行，需要它已有相应 sudo 权限。不要把登录认证数据写入脚本。脚本当前的仓库新增状态与 GitHub Release 发布状态是分开的；v1.6.0 原运行包不包含后来新增的升级器。

```bash
# 只检查账号、路径、Node 和服务，不下载、不写文件、不调用模型。
bash /home/codex/upgrade-v1.6.0.sh check

# 一次完成备份、下载校验、预检、切换和分别重启。
bash /home/codex/upgrade-v1.6.0.sh upgrade
```

升级前在两个 Bot 中确认 `/status` 空闲，避开提醒发送时间，执行期间不发送新任务。升级会中断两个平台当前的 Codex 任务。模型预检会对两个平台各调用 fresh/resume，共 4 次默认模型请求，产生模型用量和独立 CLI 历史；不会启动 Telegram polling / Discord Gateway，也不写 Bot 会话/提醒文件。服务有会话级 `/model` 覆盖时，还需检查那些模型是否兼容 schema。

也可分两阶段：

```bash
bash /home/codex/upgrade-v1.6.0.sh preflight

# 将下面路径替换为上一条打印的实际备份目录。
bash /home/codex/upgrade-v1.6.0.sh upgrade \
  --backup-dir /home/codex/codex-tg-bot/.local-backups/dual-v1.6.0-实际UUID
```

`preflight` 会创建备份、准备版本目录并调用模型，但不更改或重启服务。继续升级会重新校验及执行模型预检，不把旧预检结果当作当前有效。配置在预检后发生变化时，升级会拒绝切换。离线部署可以先下载官方运行包，使用绝对或相对路径：

```bash
bash /home/codex/upgrade-v1.6.0.sh upgrade \
  --archive /home/codex/codex-bot-v1.6.0-node.tar.gz
```

本地包也必须匹配固定 SHA-256；不存在可跳过校验或预检的开关。已存在的版本目录不覆盖，必须与从可信归档中读取的原始清单和文件摘要全部相符，否则停止。两个入口已指向 v1.6.0 时，备份和预检完成后直接退出，不新增覆盖项或再次重启。

## 自定义路径

首次操作前核对实际服务、unit/drop-in 和配置。环境变量优先于 dotenv；如果 systemd 设置了额外的 provider、模型、代理、`WORKDIR`、日历等环境，运行预检时必须使用相同环境。脚本不会猜测 systemd 的所有环境来源，也不会执行 `source .env`。

默认变量：

| 变量 | 默认值 |
| --- | --- |
| `BOT_DIR` | `/home/codex/codex-tg-bot` |
| `NODE_BIN` | `/usr/bin/node` |
| `SERVICE_USER` | `codex` |
| `TG_UNIT` / `DC_UNIT` | `codex-tg-bot.service` / `codex-discord-bot.service` |
| `TG_ENV` / `DC_ENV` | `$BOT_DIR/.env` / `$BOT_DIR/.env.discord` |
| `TG_SESSION` / `DC_SESSION` | `$BOT_DIR/.bot-state/sessions.json` / `discord-sessions.json` |
| `TG_REMINDER` / `DC_REMINDER` | `$BOT_DIR/.bot-state/telegram-reminders.json` / `discord-reminders.json` |
| `TG_HOME` / `DC_HOME` | `/home/codex/.codex` |

```bash
NODE_BIN=/usr/local/bin/node \
TG_SESSION=/home/codex/private/tg-sessions.json \
DC_SESSION=/home/codex/private/discord-sessions.json \
bash /home/codex/upgrade-v1.6.0.sh check
```

升级时使用同样的变量。原会话文件必须存在，不能创建空状态绕过；从未产生过会话的全新服务不在此升级器范围内。路径要求绝对路径，不支持引号、反斜杠、控制字符或 systemd 特殊展开字符。备份目录及父目录不能为链接，两个平台四个状态路径必须各不相同。

## 备份和恢复

备份位于 `$BOT_DIR/.local-backups/dual-v1.6.0-UUID`，新目录权限为 `0700`，包含配置、原状态、Codex 历史、自定义日历副本、原 unit 及全部 drop-in 的合并内容快照、本次脚本副本、升级记录及本次覆盖配置。共用同一路径的 `CODEX_HOME` 只备份一次。备份可能很大且包含凭据，应预留空间，仅私有保留，禁止上传。原服务仍可能更新状态，备份并非冻结的跨文件事务。

脚本使用 flock 阻止同一项目的并发升级/回滚。每次生成唯一 drop-in，只覆盖入口和稳定配置/状态路径；原 unit、原有 drop-in、真实 `.env`、工作区和权限策略保持原样。创建时不覆盖同名已有文件。

切换或重启失败时会尝试自动撤销本次覆盖项并重启两个服务，主命令仍以非零状态退出。自动回滚失败会保留现场并提示检查；SIGKILL、断电等中断无法保证自动回滚，需要用输出的备份目录手动运行：

```bash
# 使用实际备份目录；自定义 BOT_DIR 时也要提供相同 BOT_DIR。
bash /home/codex/upgrade-v1.6.0.sh rollback \
  --backup-dir /home/codex/codex-tg-bot/.local-backups/dual-v1.6.0-实际UUID
```

回滚也会中断任务。它先保存最新状态与当前覆盖文件，只撤销由本次记录标识、且内容未被人工修改的覆盖项，保留文件及版本目录，让原 unit 和其他 drop-in 的设置重新生效。不恢复旧会话、旧提醒或旧 Codex 历史，不丢弃升级期间的新任务和发送结果。没有本次覆盖项时不重启；人工改过的覆盖文件、异常链接、损坏或越界的备份记录都会拒绝处理。记录通过 JSON 校验，不作为 shell 代码执行。

如果当前脚本已被替换，可以使用备份中的 `upgrade-v1.6.0.sh` 执行回滚。升级前若早于 v1.5.0，非工作日状态版本 2 不一定可读，应先按 [日历兼容说明](../HOLIDAY-CALENDAR.md#状态兼容和降级) 设计降级，不直接使用本回滚流程。

## 验收

脚本成功只表示入口切换及 `is-active` 检查通过，不能证明消息平台真实投递成功。完成后分别检查：

```bash
systemctl show codex-tg-bot.service codex-discord-bot.service \
  --property=Id,MainPID,ExecMainStatus,NRestarts
sudo journalctl -u codex-tg-bot.service -n 50 --no-pager
sudo journalctl -u codex-discord-bot.service -n 50 --no-pager
```

在两个平台验证普通连续对话、模型、`/usage`，创建未来几分钟提醒，核对实际收到一次，然后修改、取消并查看列表。自然语言同一会话忙碌时需等待，原生命令仍可用。内置中国大陆调休日历只覆盖 2026 年，未知年份不猜测。详细运行包兼容条件和手动操作见 [v1.6.0 升级文档](../UPGRADE-v1.6.0.md)。

本地测试使用隔离的文件、sudo/systemctl/下载替身和模拟 Codex 输出，验证脚本控制流及失败保护，不连接 Debian 或消息平台。正式服务器仍需实际验收。
