# Debian 升级到 v1.5.0

本版增加中国大陆非工作日和一天多个时间点提醒：周末及官方放假日会发送，调休工作日排除。支持“非工作日早上6点1分、11点2分提醒我测试消息”，TG、Discord 授权用户私聊均可用，不调用模型、不新增依赖、不修改 Debian cron；原有提醒管理保留。内置离线日历仅覆盖 2026 年，未覆盖年份不猜测。

使用 GitHub Release 的 `codex-bot-v1.5.0-node.tar.gz`，不要使用自动生成的 Source code 压缩包。运行包包含锁定的 JavaScript 依赖，无需在 Debian 拉源码或执行 npm 安装。仍需 Node.js 22.4 以上及原来已登录的 Codex CLI；Node 22.22.0 满足要求。

以下是操作者手动执行的步骤，不表示服务器已经升级。每步成功后才继续；任一检查、备份、下载或校验失败应停止。重启会短暂断开所选平台连接并终止运行中的 Codex 任务，先用 `/status` 确认空闲，并避开已有提醒的发送时段。升级一个平台只重启它自己的服务。

**状态兼容：** 原有版本 1 提醒无需迁移。创建或转换出非工作日任务后会写为版本 2，v1.4.0 及更早版本不能读取，取消任务也仍保留新版历史。降级必须按本文第 6 节及 [日历说明](HOLIDAY-CALENDAR.md) 导出独立兼容副本，不能直接恢复旧入口后复用版本 2 文件。

## 1. 检查实际配置与服务

示例以 `codex` 运行账号、原目录 `/home/codex/codex-tg-bot` 和 TG 服务为准。使用实际服务账号操作，先核对路径。升级 Discord 时改为它自己的 unit、配置、会话和提醒文件，不能共用 TG 状态。

```bash
BOT_DIR=/home/codex/codex-tg-bot
BOT_UNIT=codex-tg-bot.service
BOT_ENV="$BOT_DIR/.env"
SESSION_STATE="$BOT_DIR/.bot-state/sessions.json"
REMINDER_STATE="$BOT_DIR/.bot-state/telegram-reminders.json"
CODEX_HOME_DIR=/home/codex/.codex
# 已配置 HOLIDAY_CALENDAR_FILE 时填入实际绝对路径，否则留空使用运行包内置日历。
CUSTOM_CALENDAR=

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
BACKUP_DIR="$BOT_DIR/.local-backups/v1.5.0-$(date +%Y%m%d-%H%M%S)"
test ! -e "$BACKUP_DIR"
test -f "$UNIT_FILE"
test -f "$BOT_ENV"
test -d "$CODEX_HOME_DIR"
mkdir -p "$BACKUP_DIR/config" "$BACKUP_DIR/state"
cp -a -- "$BOT_ENV" "$BACKUP_DIR/config/bot.env"
if [ -f "$SESSION_STATE" ]; then cp -a -- "$SESSION_STATE" "$BACKUP_DIR/state/sessions.json"; fi
if [ -f "$REMINDER_STATE" ]; then cp -a -- "$REMINDER_STATE" "$BACKUP_DIR/state/reminders.json"; fi
if [ -n "$CUSTOM_CALENDAR" ]; then
  test -f "$CUSTOM_CALENDAR"
  cp -a -- "$CUSTOM_CALENDAR" "$BACKUP_DIR/config/china-calendar.json"
fi
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
curl -fL -o codex-bot-v1.5.0-node.tar.gz https://github.com/rshun/codex-bot/releases/download/v1.5.0/codex-bot-v1.5.0-node.tar.gz
curl -fL -o SHA256SUMS https://github.com/rshun/codex-bot/releases/download/v1.5.0/SHA256SUMS
sha256sum --check SHA256SUMS
tar -tzf codex-bot-v1.5.0-node.tar.gz

RELEASE_DIR="$BOT_DIR/releases/codex-bot-v1.5.0"
test ! -e "$RELEASE_DIR"
mkdir -p "$BOT_DIR/releases"
tar -xzf codex-bot-v1.5.0-node.tar.gz -C "$BOT_DIR/releases"
node --check "$RELEASE_DIR/index.js"
node --check "$RELEASE_DIR/discord.js"
node --check "$RELEASE_DIR/reminders.js"
node --check "$RELEASE_DIR/china-calendar.js"
node -e 'const calendar=new (require(process.argv[1]).ChinaCalendar)(process.argv[2]); console.log("Calendar years:",[...calendar.years.keys()].join(","));' "$RELEASE_DIR/china-calendar.js" "${CUSTOM_CALENDAR:-$RELEASE_DIR/china-calendar.json}"
```

必须确认 SHA-256 校验成功后再解压。目标版本目录已存在时停止检查，不要覆盖。包内 `release-manifest.json` 记录源码提交、版本和逐文件 SHA-256，并包含本升级说明的离线副本。包不包含真实配置、会话、提醒状态、Codex 登录数据或测试目录。内置日历只包含已核实的 2026 年；可选 HOLIDAY_CALENDAR_FILE 可以继续指向稳定的自定义完整日历，更新前先备份并对照官方公告核实，结构检查不能证明日期与公告一致。

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
ExecStart=/usr/bin/node /home/codex/codex-tg-bot/releases/codex-bot-v1.5.0/index.js
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

TG 私聊可直接使用原始句子，也可使用简洁句式：

```text
请在节假日的早上6点1分，11点2分添加添加定时任务： 在tg上发送测试消息
```

等价的简洁写法是“非工作日早上6点1分、11点2分提醒我测试消息”。两种写法选择一种，只发送一次，避免重复创建。确认 Bot 返回“已保存 2 个定时消息”、两个不同任务 ID、内容“测试消息”和正确的下次北京时间。然后发送“查看我的提醒”核对；如需重试，先按 ID 取消原测试任务。

节假日按中国大陆非工作日解释：包含周末及官方放假日，排除调休工作日；数据来源、格式和完整 2026 年安排见 [日历说明](HOLIDAY-CALENDAR.md)。两个时间各是一条独立任务，任一时间/内容无效、日历覆盖不足或数量超限都会整体拒绝，不保存一半。明确要求向 TG 发送的句子只在 TG 私聊创建，不跨平台发送；Discord 使用不指定 TG 的简洁句式。

实际验收应确认每个时间点收到一次、调休工作日不发、普通周末和放假日发送。可选择当前已覆盖非工作日的未来几分钟进行测试（始终按北京时间），确认重启后两个任务保留；工作日测试只应核对未来计划，不以当前不发送判断故障。另测每天多时间点、按 ID 修改/取消、原一次性/每天任务、上下文、模型、`/usage` 和 `/quota`；验收后逐个取消专门的测试任务。

未知年份不猜测。创建时下一个非工作日超出覆盖范围则不创建；已有非工作日任务到达日历边界时显示“日历待更新”，其他普通任务继续。补齐完整日历后受控重启，只安排未来时间，不补未知期间消息。没有日历更新就不能承诺跨年继续发送。

非工作日任务离线恢复时不在工作日补发，不重放过去日期；在已覆盖非工作日，每个时间点最多按当天计划等待或补发一轮。每 5 秒检查一次，网络和平台队列可能延迟。发送结果不确定的那轮不自动重试，先核对私聊。日志正常不能代替真正收到消息的验证。

未识别的明确“添加定时任务”请求现在由 Bot 提示格式，不再由普通 Codex 对话误报缺少 Telegram 接口。只有成功回执及任务 ID 才表示已创建；群组/服务器频道和未授权用户不能管理。原有自然语言及斜杠命令保留，不需要重新注册 Discord 命令。

## 6. 回滚

回滚也会短暂中断所选平台及运行中的任务。确认空闲后，先另行备份当前 unit、drop-in、配置、会话和提醒状态。核对本次 `BACKUP_DIR`、原入口与备份文件确实对应当前服务，按第 2 步记录恢复实际修改的 unit/drop-in；有 drop-in 时不能只恢复主 unit。

先在服务器本地确认实际 REMINDER_FILE 的版本，不输出任务内容。**如果已为版本 2，必须先按 [日历说明的状态兼容和降级步骤](HOLIDAY-CALENDAR.md#状态兼容和降级)，在状态冻结后导出新的版本 1 兼容副本，用旧模块验证，再恢复旧入口并将旧服务 REMINDER_FILE 指向该副本；不要直接执行下面的整份 unit 恢复步骤。** 原始完整新版状态必须保留，非工作日任务在旧版中停止调度。

下面仅适用于仍使用版本 1 状态、只修改完整 unit 且没有额外改动 drop-in 的情况；UNIT_FILE 必须核对为原路径：

```bash
sudo cp -p -- "$BACKUP_DIR/unit-original.service" "$UNIT_FILE"
sudo systemctl daemon-reload
sudo systemctl restart "$BOT_UNIT"
systemctl is-active "$BOT_UNIT"
journalctl -u "$BOT_UNIT" -n 50 --no-pager
```

保留所有版本目录、日历和新旧状态文件，不用较早快照覆盖升级期间的任务修改和发送结果。旧版仅能使用一次性/每天兼容副本，非工作日任务与历史保留在完整新版文件。日后恢复新版时须人工核对旧版运行期间兼容副本的新任务、修改及发送结果，再合并恢复，不能直接切回旧快照，否则可能漏任务或重复补发。
