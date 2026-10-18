# Debian 升级到 v1.3.0

本版在自然语言创建提醒的基础上，增加“查看我的提醒”“取消喝水提醒”和“取消提醒 任务ID”。TG、Discord 授权用户私聊均可用，不调用模型、不新增依赖、不修改 Debian cron。已有命令、提醒状态格式和北京时间规则保持兼容；多个内容匹配时不取消任务，需按 ID 明确选择。

使用 GitHub Release 的 `codex-bot-v1.3.0-node.tar.gz`，不要使用自动生成的 Source code 压缩包。运行包包含锁定的 JavaScript 依赖，无需在 Debian 拉源码或执行 npm 安装。仍需 Node.js 22.4 以上及原来已登录的 Codex CLI；Node 22.22.0 满足要求。

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
BACKUP_DIR="$BOT_DIR/.local-backups/v1.3.0-$(date +%Y%m%d-%H%M%S)"
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
curl -fL -o codex-bot-v1.3.0-node.tar.gz https://github.com/rshun/codex-bot/releases/download/v1.3.0/codex-bot-v1.3.0-node.tar.gz
curl -fL -o SHA256SUMS https://github.com/rshun/codex-bot/releases/download/v1.3.0/SHA256SUMS
sha256sum --check SHA256SUMS
tar -tzf codex-bot-v1.3.0-node.tar.gz

RELEASE_DIR="$BOT_DIR/releases/codex-bot-v1.3.0"
test ! -e "$RELEASE_DIR"
mkdir -p "$BOT_DIR/releases"
tar -xzf codex-bot-v1.3.0-node.tar.gz -C "$BOT_DIR/releases"
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
ExecStart=/usr/bin/node /home/codex/codex-tg-bot/releases/codex-bot-v1.3.0/index.js
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

先在 TG 私聊测试；Discord 私聊也相同，但需 `DISCORD_ALLOW_DMS=true` 并允许 Bot 发私信。已有提醒不需要重新创建。

```text
查看我的提醒
每天晚上9点提醒我测试取消
每天晚上10点提醒我测试取消
取消测试取消提醒
取消提醒 任务ID
```

第一句应显示最近 20 条记录（包含历史结果）。两个测试任务创建成功后，按内容取消应返回两个候选且不改变状态；把“任务ID”换成其中一个实际 ID，再取消并核对只有该任务显示已取消。对剩余测试任务发送“取消测试取消提醒”，唯一匹配后应取消成功。不要用正式任务试验批量行为。

再创建一个未来几分钟的北京时间一次性提醒，例如“今天 21:05 提醒我测试升级”（须替换为未来时间），确认到时私聊收到一次，列表显示已发送。另建一条测试任务后按内容取消，确认不会再发送；受控重启后确认取消结果及未来任务仍保留。核对旧上下文、模型选择、`/usage`、`/quota` 和原斜杠命令仍可用。

按内容取消使用字面包含匹配，英文不区分大小写，不猜测同义词或解析正则。只匹配待发或发送中的任务，忽略历史记录；无匹配不修改，多匹配列出最多 20 条候选。“取消所有提醒”“取消喝水提醒可以吗”等输入不执行取消；群组/服务器频道、未授权用户也不能管理。已经开始发送的消息无法撤回，需等本次完成后再取消后续轮次。只有返回“已取消定时消息”才表示取消成功。

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

保留新目录和现有数据，不用较早备份覆盖升级期间新增的任务或发送结果。回滚到 v1.2.0 时，同一状态路径中的提醒仍会调度，自然语言创建也保留；查看和取消应改用 `/reminders`、`/cancelreminder 任务ID`，因为自然语言管理可能被当成普通 Codex 任务。回滚到 v1.1.0 时创建也恢复为 `/remind`。回滚到 v1.0.0 则停止调度提醒，文件保留；以后恢复新版前先审查过期待发任务，可能发生补发。
