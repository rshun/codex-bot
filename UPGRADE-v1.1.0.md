# Debian 升级到 v1.1.0

本版增加 Telegram/Discord 私聊定时消息，支持指定日期和每天发送、任务持久化、查看与取消。按北京时间运行，不修改系统 cron、不调用模型生成提醒内容，也不需要新增依赖。服务器仍需 Node.js 22.4 或以上及已经登录的 Codex CLI；现有 Node 22.22.0 满足运行包要求。

以下为操作者在 Debian 上手动执行的步骤，不代表服务器已经升级。每一步成功后才继续；检查、备份、校验或配置验证失败时不要切换服务。重启所选服务会短暂中断连接并终止其运行中的任务，先用 `/status` 确认空闲；已有定时消息时也应避开发送时段。只升级 Discord 不需要重启 Telegram。

## 1. 核对实际目录、账号和状态路径

示例按 myServer、`codex` 账号、现有目录 `/home/codex/codex-tg-bot` 编写。以实际运行账号操作；自定义了目录、Node、状态或配置路径时必须先替换。不要输出真实配置或认证文件内容。

```bash
BOT_DIR=/home/codex/codex-tg-bot
BOT_UNIT=codex-discord-bot.service
node --version
command -v curl tar sha256sum
systemctl show "$BOT_UNIT" --property=User,Group,WorkingDirectory,FragmentPath,DropInPaths
```

在本地检查实际 unit，记录当前 `ExecStart`，确认需要修改的文件；若 drop-in 覆盖了入口，也要检查并备份实际生效的 drop-in。保留原账号、代理、沙箱和其他安全设置，不要用示例整份覆盖 unit。Telegram 升级时将 `BOT_UNIT` 改为实际 Telegram 服务名，分别执行和验收。

必须继续使用原 `.env`、`.env.discord`、`SESSION_FILE`、`WORKDIR` 和 `CODEX_HOME`。新定时状态默认在 `SESSION_FILE` 同目录，Telegram 为 `telegram-reminders.json`，Discord 为 `discord-reminders.json`；已有自定义 `REMINDER_FILE` 时也必须保持原路径。系统服务环境变量优先于 dotenv 文件，核对时要同时考虑两者。

## 2. 备份配置、状态、Codex 历史和 unit

以下路径均是假设值，自定义路径时先修改。不要将备份上传到聊天或仓库。先检查磁盘空间，确认 Codex 历史有可用备份；体积较大时可以使用已有可信快照，不能声称空目录是认证/历史备份。

```bash
BOT_ENV="$BOT_DIR/.env"
DISCORD_ENV="$BOT_DIR/.env.discord"
TG_STATE="$BOT_DIR/.bot-state/sessions.json"
DISCORD_STATE="$BOT_DIR/.bot-state/discord-sessions.json"
TG_REMINDERS="$BOT_DIR/.bot-state/telegram-reminders.json"
DISCORD_REMINDERS="$BOT_DIR/.bot-state/discord-reminders.json"
CODEX_HOME_DIR=/home/codex/.codex
UNIT_FILE=$(systemctl show "$BOT_UNIT" --property=FragmentPath --value)
BACKUP_DIR="$BOT_DIR/.local-backups/v1.1.0-$(date +%Y%m%d-%H%M%S)"
df -h "$BOT_DIR"
umask 077
test ! -e "$BACKUP_DIR"
mkdir -p "$BACKUP_DIR/config" "$BACKUP_DIR/state"
if [ -f "$BOT_ENV" ]; then cp -a -- "$BOT_ENV" "$BACKUP_DIR/config/telegram.env"; fi
if [ -f "$DISCORD_ENV" ]; then cp -a -- "$DISCORD_ENV" "$BACKUP_DIR/config/discord.env"; fi
if [ -f "$TG_STATE" ]; then cp -a -- "$TG_STATE" "$BACKUP_DIR/state/telegram-sessions.json"; fi
if [ -f "$DISCORD_STATE" ]; then cp -a -- "$DISCORD_STATE" "$BACKUP_DIR/state/discord-sessions.json"; fi
if [ -f "$TG_REMINDERS" ]; then cp -a -- "$TG_REMINDERS" "$BACKUP_DIR/state/telegram-reminders.json"; fi
if [ -f "$DISCORD_REMINDERS" ]; then cp -a -- "$DISCORD_REMINDERS" "$BACKUP_DIR/state/discord-reminders.json"; fi
cp -a -- "$CODEX_HOME_DIR" "$BACKUP_DIR/codex-home"
test -f "$UNIT_FILE"
sudo cp -pL -- "$UNIT_FILE" "$BACKUP_DIR/unit-original.service"
printf '%s\n' "$UNIT_FILE" > "$BACKUP_DIR/unit-path.txt"
```

确认备份目录原先不存在且各项备份成功；示例使用不同目标名称，避免自定义文件同名时相互覆盖。实际 drop-in 也要用不同文件名备份。v1.0.0 没有定时状态文件是正常情况，不需要手工创建空 JSON。切换到包部署时原源码或旧版本目录保留，作为回滚入口。

## 3. 下载、校验并解压到新版本目录

使用专门的 Node 运行包，不能用 GitHub 自动生成的 Source code 压缩包。运行包已包含两项锁定依赖及许可证，不需要在 Debian 执行 npm 安装或 Git 拉取。

```bash
PACKAGE_DIR="$BACKUP_DIR/download"
mkdir -p "$PACKAGE_DIR"
cd "$PACKAGE_DIR"
curl -fL -o codex-bot-v1.1.0-node.tar.gz https://github.com/rshun/codex-bot/releases/download/v1.1.0/codex-bot-v1.1.0-node.tar.gz
curl -fL -o SHA256SUMS https://github.com/rshun/codex-bot/releases/download/v1.1.0/SHA256SUMS
sha256sum --check SHA256SUMS
tar -tzf codex-bot-v1.1.0-node.tar.gz
RELEASE_DIR="$BOT_DIR/releases/codex-bot-v1.1.0"
test ! -e "$RELEASE_DIR"
mkdir -p "$BOT_DIR/releases"
tar -xzf codex-bot-v1.1.0-node.tar.gz -C "$BOT_DIR/releases"
node --check "$RELEASE_DIR/index.js"
node --check "$RELEASE_DIR/discord.js"
node --check "$RELEASE_DIR/reminders.js"
```

校验必须成功；若目标版本目录已存在，先停下检查，不要覆盖解压。包内的 `release-manifest.json` 记录版本、源码提交和逐文件 SHA-256；`UPGRADE-v1.1.0.md` 是本说明的离线副本。包不包含真实配置、状态、认证或测试目录，不要用包内 `npm test` 的空测试结果替代发布前测试。

## 4. 验证配置并切换入口

Discord 先使用原配置和明确的原状态路径检查。下面变量必须是第 2 步已核对的实际路径；检查不会连接 Discord、创建状态或发送消息：

```bash
cd "$BOT_DIR"
DISCORD_ENV_FILE="$DISCORD_ENV" SESSION_FILE="$DISCORD_STATE" REMINDER_FILE="$DISCORD_REMINDERS" node "$RELEASE_DIR/discord.js" --check-config
```

在已备份的实际 unit（或实际控制入口的 drop-in）中手动修改。对于现有 `/etc/systemd/system/` 下的 Discord unit，可用 `sudoedit /etc/systemd/system/codex-discord-bot.service`；路径不一致时使用第 1 步确认的真实文件。以下只是需要核对的字段，自定义路径不能直接照抄：

```ini
[Service]
WorkingDirectory=/home/codex/codex-tg-bot
ExecStart=/usr/bin/node /home/codex/codex-tg-bot/releases/codex-bot-v1.1.0/discord.js
Environment=DISCORD_ENV_FILE=/home/codex/codex-tg-bot/.env.discord
Environment=SESSION_FILE=/home/codex/codex-tg-bot/.bot-state/discord-sessions.json
Environment=REMINDER_FILE=/home/codex/codex-tg-bot/.bot-state/discord-reminders.json
```

直接编辑完整 unit 时替换原 `ExecStart`，不要保留两条。若修改的是 drop-in，覆盖入口须先写空的 `ExecStart=`，下一行再写新入口，其他配置保留。Telegram 对应入口改为同一版本目录的 `index.js`，保持 `WorkingDirectory` 指向原 `.env` 所在目录，`SESSION_FILE` 和 `REMINDER_FILE` 分别使用现有的 Telegram 状态路径。每个平台使用自己的文件。包内 `deploy/` 的两个服务示例可供对照，不要覆盖原有策略。

确认状态目录可由原服务账号写入；若 systemd 设置了只读沙箱，沿用原政策，只允许实际需要的私有状态目录，不扩大为全盘可写。不需要新增必填 `.env` 字段；`REMINDER_FILE` 可选，但在 unit 中显式固定便于后续升级。

最后确认可以中断所选平台，再手动重启：

```bash
sudo systemctl daemon-reload
sudo systemctl restart "$BOT_UNIT"
systemctl is-active "$BOT_UNIT"
journalctl -u "$BOT_UNIT" -n 50 --no-pager
```

Telegram 没有 `--check-config` 参数，不要在旧服务仍运行时启动第二个 polling 进程测试。升级 Telegram 时先按上述语法、账号、配置和状态检查，再切换它自己的 unit 并重启。

## 5. Discord 注册新命令与实际验收

普通文字命令 `!remind`、`!reminders`、`!cancelreminder` 不需要注册。需要原生斜杠命令时，使用原应用 ID 和原作用域，先预览后更新；更新会先备份现有命令定义，再新增/更新 12 个同名命令，保留其他命令，不自动删除旧作用域定义：

```bash
cd "$BOT_DIR"
DISCORD_ENV_FILE="$DISCORD_ENV" node "$RELEASE_DIR/discord.js" --register-commands
DISCORD_ENV_FILE="$DISCORD_ENV" node "$RELEASE_DIR/discord.js" --register-commands --apply
```

在 Bot 私聊中完成验收，不在服务器频道或群组中创建提醒。TG 先私聊 `/start`；Discord 需允许 Bot 私信且 `DISCORD_ALLOW_DMS=true`。

```text
/status
/remind 2026-10-19 09:00 喝水
/remind daily 21:30 准备休息
/reminders
/cancelreminder 任务ID
```

将日期时间换成未来几分钟的北京时间。确认创建返回 8 位 ID、私聊收到一次、列表显示结果；另建任务取消，确认不再发送。确认旧上下文、模型选择、`/usage` 和 `/quota` 仍可用。受控重启后确认未到期提醒仍在。`/new` 不会取消提醒。只保存固定文字，不调用 Codex 生成消息。

服务每 5 秒检查一次，网络或限流会延迟发送；离线后恢复会补发待发的一次性消息，每天任务只补发一轮。发送前保存领取状态，崩溃或网络错误导致结果不确定时标记“发送未确认”，该轮不会自动重试，不能保证端到端恰好一次。请先检查私聊再决定是否另建任务。日志和配置检查成功都不能代替实际收到消息的验证。

## 6. 回滚

回滚会短暂中断所选平台，并终止运行任务。先确认空闲，另行备份当前 unit、配置、会话和定时状态，保留升级后新增数据。核实原 `BACKUP_DIR`、`unit-path.txt`、`unit-original.service` 及旧版本入口确实属于此次升级；如果修改了 drop-in，按各自备份恢复实际改动的文件，不能只恢复主 unit。

确认备份和目标无误后，操作者恢复原 unit。以下仅适用于没有额外改动 drop-in 的情况，`UNIT_FILE` 须是已核对的原路径：

```bash
sudo cp -p -- "$BACKUP_DIR/unit-original.service" "$UNIT_FILE"
sudo systemctl daemon-reload
sudo systemctl restart "$BOT_UNIT"
systemctl is-active "$BOT_UNIT"
journalctl -u "$BOT_UNIT" -n 50 --no-pager
```

原入口仍保留，因此不需删除新目录或覆盖旧源码。不要恢复较早的 `.env`、会话、Codex 历史或定时状态覆盖升级期间的新数据。v1.0.0 不读取定时状态，回滚后不再调度；恢复 v1.1.0 前要审查保存的过期待发任务，可能发生补发。Discord 命令定义独立于入口，回滚不自动删除新命令。
