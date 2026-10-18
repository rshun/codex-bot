# Debian 升级到 v1.2.0

本版增加 TG 和 Discord 私聊自然语言提醒，例如“每天晚上9点提醒我喝水”“明天早上八点半提醒我吃早餐”。由 Bot 按有限格式识别，时间固定为北京时间，不调用模型、不新增依赖、不修改 Debian cron。v1.1.0 已有的命令和定时状态格式保持兼容。

使用 GitHub Release 的 `codex-bot-v1.2.0-node.tar.gz`，不要使用自动生成的 Source code 压缩包。运行包包含锁定的 JavaScript 依赖，无需在 Debian 拉源码或执行 npm 安装。仍需 Node.js 22.4 以上及原来已登录的 Codex CLI；Node 22.22.0 满足要求。

以下是操作者手动执行的步骤，不表示服务器已经升级。每步成功后才继续；任一检查、备份、下载或校验失败应停止。重启会短暂断开所选平台连接并终止运行中的 Codex 任务，先用 `/status` 确认空闲，并避开已有提醒的发送时段。升级一个平台只重启它自己的服务。

## 1. 检查实际配置与服务

示例以 `codex` 运行账号、原目录 `/home/codex/codex-tg-bot` 和 TG 服务为准。使用实际服务账号操作，先核对路径。升级 Discord 时改为它自己的 unit、配置、会话和提醒文件，不能共用 TG 状态。

```bash
BOT_DIR=/home/codex/codex-tg-bot
BOT_UNIT=codex-tg-bot.service
BOT_ENV="$BOT_DIR/.env"
SESSION_STATE="$BOT_DIR/.bot-state/sessions.json"
REMINDER_STATE="$BOT_DIR/.bot-state/telegram-reminders.json"
CODEX_HOME_DIR=/home/codex/.codex

node --version
command -v curl tar sha256sum
systemctl is-active "$BOT_UNIT"
systemctl show "$BOT_UNIT" --property=User,Group,WorkingDirectory,FragmentPath,DropInPaths
df -h "$BOT_DIR"
```

在服务器本地检查实际 unit 与 drop-in，记录原 `ExecStart`；不要把可能含凭据的配置或环境输出贴到聊天。环境变量优先于 dotenv，必须核对实际 `SESSION_FILE`、`REMINDER_FILE`、`WORKDIR`、`CODEX_HOME`。继续沿用原 `.env` 或 `.env.discord`，不以包内示例覆盖真实配置。

若没有显式 `REMINDER_FILE`，原文件默认在原 `SESSION_FILE` 同目录：TG 为 `telegram-reminders.json`，Discord 为 `discord-reminders.json`。从源码部署切换到版本目录时必须固定这些原路径，不能让默认路径随版本目录改变。保留原服务账号、代理、沙箱和工作目录。

Discord 对应变量示例：

```bash
BOT_UNIT=codex-discord-bot.service
BOT_ENV="$BOT_DIR/.env.discord"
SESSION_STATE="$BOT_DIR/.bot-state/discord-sessions.json"
REMINDER_STATE="$BOT_DIR/.bot-state/discord-reminders.json"
```

## 2. 备份再操作

在同一个 Bash 会话中执行，变量必须已替换成实际值。先确认磁盘空间和 Codex 历史备份可用；体积较大时可使用已有可信快照替代复制，但不要把空目录当成认证或历史备份。备份可能包含凭据，只保留在私有目录，不上传仓库。

```bash
umask 077
UNIT_FILE=$(systemctl show "$BOT_UNIT" --property=FragmentPath --value)
BACKUP_DIR="$BOT_DIR/.local-backups/v1.2.0-$(date +%Y%m%d-%H%M%S)"
test ! -e "$BACKUP_DIR"
test -f "$UNIT_FILE"
test -f "$BOT_ENV"
test -d "$CODEX_HOME_DIR"
mkdir -p "$BACKUP_DIR/config" "$BACKUP_DIR/state"
cp -a -- "$BOT_ENV" "$BACKUP_DIR/config/bot.env"
if [ -f "$SESSION_STATE" ]; then cp -a -- "$SESSION_STATE" "$BACKUP_DIR/state/sessions.json"; fi
if [ -f "$REMINDER_STATE" ]; then cp -a -- "$REMINDER_STATE" "$BACKUP_DIR/state/reminders.json"; fi
cp -a -- "$CODEX_HOME_DIR" "$BACKUP_DIR/codex-home"
sudo cp -pL -- "$UNIT_FILE" "$BACKUP_DIR/unit-original.service"
printf '%s\n' "$UNIT_FILE" > "$BACKUP_DIR/unit-path.txt"
```

若有实际生效的 drop-in，也必须逐一备份到此目录，使用不同名称，并记录原路径及原入口。任何备份失败都不要继续。没有历史提醒文件时不必创建空 JSON。保留旧源码或旧运行包目录作为回滚入口，不删除任何状态或版本目录。

## 3. 下载并校验运行包

```bash
PACKAGE_DIR="$BACKUP_DIR/download"
mkdir -p "$PACKAGE_DIR"
cd "$PACKAGE_DIR"
curl -fL -o codex-bot-v1.2.0-node.tar.gz https://github.com/rshun/codex-bot/releases/download/v1.2.0/codex-bot-v1.2.0-node.tar.gz
curl -fL -o SHA256SUMS https://github.com/rshun/codex-bot/releases/download/v1.2.0/SHA256SUMS
sha256sum --check SHA256SUMS
tar -tzf codex-bot-v1.2.0-node.tar.gz

RELEASE_DIR="$BOT_DIR/releases/codex-bot-v1.2.0"
test ! -e "$RELEASE_DIR"
mkdir -p "$BOT_DIR/releases"
tar -xzf codex-bot-v1.2.0-node.tar.gz -C "$BOT_DIR/releases"
node --check "$RELEASE_DIR/index.js"
node --check "$RELEASE_DIR/discord.js"
node --check "$RELEASE_DIR/reminders.js"
```

必须确认 SHA-256 校验成功后再解压。目标版本目录已存在时停止检查，不要覆盖。包内 `release-manifest.json` 记录源码提交、版本和逐文件 SHA-256，并包含本升级说明的离线副本。包不包含真实配置、会话、提醒状态、Codex 登录数据或测试目录。

若只升级 Discord，先用原配置检查；该命令不连接 Discord、不写状态，也不发送消息：

```bash
cd "$BOT_DIR"
DISCORD_ENV_FILE="$BOT_ENV" SESSION_FILE="$SESSION_STATE" REMINDER_FILE="$REMINDER_STATE" node "$RELEASE_DIR/discord.js" --check-config
```

TG 没有 `--check-config`，不要在旧服务运行时启动第二个 polling 进程测试。

## 4. 切换所选服务入口

在第 2 步已经备份的实际 unit 或实际控制入口的 drop-in 中手动修改，不能以示例整份覆盖。若为 `/etc/systemd/system/codex-tg-bot.service`，可使用 `sudoedit /etc/systemd/system/codex-tg-bot.service`；其他路径使用真实文件。

TG 需要核对的字段示例（Node 路径也按实际值替换）：

```ini
[Service]
WorkingDirectory=/home/codex/codex-tg-bot
ExecStart=/usr/bin/node /home/codex/codex-tg-bot/releases/codex-bot-v1.2.0/index.js
Environment=SESSION_FILE=/home/codex/codex-tg-bot/.bot-state/sessions.json
Environment=REMINDER_FILE=/home/codex/codex-tg-bot/.bot-state/telegram-reminders.json
```

TG 的 `WorkingDirectory` 必须继续指向原 `.env` 所在目录。Discord 使用同版本目录的 `discord.js`，同时继续固定原 `DISCORD_ENV_FILE`、Discord 的 `SESSION_FILE` 和 `REMINDER_FILE`。直接编辑完整 unit 时替换原入口，不保留两条 `ExecStart`；若用 drop-in 覆盖入口，先写空的 `ExecStart=`，下一行再写新入口。

不需要新增必填 `.env` 字段或重新注册 Discord 斜杠命令。状态目录仍需原服务账号可写，沿用现有沙箱策略，不扩大为全盘可写。确认所选平台空闲后，操作者执行：

```bash
sudo systemctl daemon-reload
sudo systemctl restart "$BOT_UNIT"
systemctl is-active "$BOT_UNIT"
journalctl -u "$BOT_UNIT" -n 50 --no-pager
```

## 5. 私聊验收

先在 TG 私聊测试；Discord 私聊也相同，但需 `DISCORD_ALLOW_DMS=true` 并允许 Bot 发私信。把一次性测试时间改为未来几分钟的北京时间，不能照抄一个已过期时间。

```text
今天 21:05 提醒我测试升级
每天晚上9点提醒我喝水
/reminders
/cancelreminder 任务ID
```

确认自然语言创建返回“已保存定时消息”、8 位任务 ID、正确的北京时间及内容；一次性提醒收到一次后，列表显示已发送。验证取消后的任务不再发送，旧提醒仍在，原上下文、模型选择、`/usage`、`/quota` 仍可用。受控重启后确认未来任务保留。

再发送“每天9点提醒我喝水”，应提示补充且不新增记录；群聊或服务器频道不能创建。中文时分及“半、一刻、三刻”可用；支持每天、今天、明天、后天、今晚、明早及具体年月日，不支持任意自然语言、每周/每月任务或一次输入多条任务。“晚上12点”等日期含糊表达不会创建。成功回执和列表才是保存依据，普通聊天中模型声称“记住了”不代表创建了任务；讨论提醒句子可加 `/codex` 前缀。

仍是保存固定文字后定时发送，不调用模型生成内容。每 5 秒检查一次，网络和限流可能延迟；Bot 离线时不能发送，恢复后会补发一次性待发消息，每天任务只补发一轮。发送结果不确定的那轮不自动重试，先核对私聊记录。日志正常不能替代真实收到消息的验证。

## 6. 回滚

回滚也会短暂中断所选平台及运行中的任务。确认空闲后，先另行备份当前 unit、drop-in、配置、会话和提醒状态。核对本次 `BACKUP_DIR`、原入口与备份文件确实对应当前服务，按第 2 步记录恢复实际修改的 unit/drop-in；有 drop-in 时不能只恢复主 unit。

以下仅适用于修改了完整 unit、未额外修改 drop-in 的情况；`UNIT_FILE` 必须已核对为原路径：

```bash
sudo cp -p -- "$BACKUP_DIR/unit-original.service" "$UNIT_FILE"
sudo systemctl daemon-reload
sudo systemctl restart "$BOT_UNIT"
systemctl is-active "$BOT_UNIT"
journalctl -u "$BOT_UNIT" -n 50 --no-pager
```

保留新目录和现有数据，不用较早备份覆盖升级期间新增的任务或发送结果。回滚到 v1.1.0 时，同一状态路径中的提醒仍会调度，创建恢复为命令形式；自然语言输入可能被当成普通 Codex 任务，因此应使用 `/remind`。回滚到 v1.0.0 则停止调度提醒，文件保留；以后恢复新版前先审查过期待发任务，可能发生补发。
