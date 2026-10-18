# Debian：TG 和 Discord 升级到 v1.7.0 可执行程序

本版提供 `codex-bot-v1.7.0-linux-x64.tar.gz`、`codex-bot-v1.7.0-linux-arm64.tar.gz`、`SHA256SUMS`。程序内置 Node；Codex CLI、认证和工作区仍使用原设置。不要卸载旧 Node，它可能仍被 Codex 启动器或回滚版本使用。

以下命令由 Debian 操作者执行，适用于服务账号 `codex`、原项目 `/home/codex/codex-tg-bot`、服务名 `codex-tg-bot.service` 和 `codex-discord-bot.service`。**升级会依次重启两个服务，可能中断正在运行的任务。** 先在两个平台确认 `/status` 空闲，执行期间不发送新任务，并避开提醒发送时间。

## 先核对实际路径

在服务器本地查看当前服务设置。unit/drop-in 可能包含敏感环境值，不要把输出原样贴到聊天：

```bash
systemctl show codex-tg-bot.service codex-discord-bot.service -p User -p Group -p WorkingDirectory -p ExecStart
systemctl cat codex-tg-bot.service
systemctl cat codex-discord-bot.service
```

核对两个 `.env` 中和 unit 中的 `SESSION_FILE`、`REMINDER_FILE`、`CODEX_HOME`，以下脚本头部的值必须等于旧进程实际使用的路径。旧 Node 发布包若未固定 `SESSION_FILE`，状态可能在旧版本程序目录下，不能改成空的新目录；脚本会在旧会话文件不存在时停止。

保持原 `WORKDIR`、模型、网络代理及其它 unit 环境设置不变。若终端环境与 unit 中的额外设置不同，先使预检终端使用同样的设置；状态中的 `WORKDIR` / `CODEX_HOME` 不匹配会拒绝升级。Discord 自定义 `.env.discord` 路径也必须填入 `DC_ENV`。

## 一次完成备份、下载、预检和切换

先切到服务账号（若已经是 `codex`，不必再切）。该账号需已有相关 sudo 权限；不新增权限、不安装任何依赖：

```bash
sudo -iu codex
```

确认下面路径后整段执行。每一步失败即停止；旧配置和数据不覆盖，旧程序和其它 drop-in 不删除。备份目录含配置和状态，权限仅限当前用户。归档只解压到全新的版本目录，已有版本或同名覆盖文件会拒绝重用。

```bash
bash <<'BASH'
set -Eeuo pipefail
umask 077

VERSION=1.7.0
BOT_DIR=/home/codex/codex-tg-bot
SERVICE_USER=codex
TG_UNIT=codex-tg-bot.service
DC_UNIT=codex-discord-bot.service
DC_ENV="$BOT_DIR/.env.discord"
# 必须沿用旧进程的实际路径；自定义路径请在运行前修改这里。
TG_SESSION="$BOT_DIR/.bot-state/sessions.json"
DC_SESSION="$BOT_DIR/.bot-state/discord-sessions.json"
TG_REMINDER="$BOT_DIR/.bot-state/telegram-reminders.json"
DC_REMINDER="$BOT_DIR/.bot-state/discord-reminders.json"
TG_HOME=/home/codex/.codex
DC_HOME=/home/codex/.codex

for value in "$BOT_DIR" "$DC_ENV" "$TG_SESSION" "$DC_SESSION" "$TG_REMINDER" "$DC_REMINDER" "$TG_HOME" "$DC_HOME"; do
  case "$value" in /*) ;; *) echo '路径必须为绝对路径'; exit 1;; esac
  case "$value" in *[!A-Za-z0-9_./-]*) echo '路径含需单独转义的字符，已停止'; exit 1;; esac
done
test "$(id -un)" = "$SERVICE_USER"
test "$(systemctl show "$TG_UNIT" -p User --value)" = "$SERVICE_USER"
test "$(systemctl show "$DC_UNIT" -p User --value)" = "$SERVICE_USER"
systemctl is-active --quiet "$TG_UNIT"
systemctl is-active --quiet "$DC_UNIT"
test -f "$BOT_DIR/.env"
test -f "$DC_ENV"
test -f "$TG_SESSION"
test -f "$DC_SESSION"
test "$(printf '%s\n' "$TG_SESSION" "$DC_SESSION" "$TG_REMINDER" "$DC_REMINDER" | sort -u | wc -l)" -eq 4
for tool in curl tar sha256sum sudo cmp mktemp; do command -v "$tool" >/dev/null; done
case "$(uname -m)" in
  x86_64) TARGET=linux-x64 ;;
  aarch64|arm64) TARGET=linux-arm64 ;;
  *) echo '不支持的 CPU 架构'; exit 1 ;;
esac
RELEASE_NAME="codex-bot-v$VERSION-$TARGET"
ARCHIVE="$RELEASE_NAME.tar.gz"
RELEASE_DIR="$BOT_DIR/releases/$RELEASE_NAME"
BIN="$RELEASE_DIR/codex-bot"
DROPIN=zzzzzz-codex-bot-v1.7.0.conf
TG_DIR="/etc/systemd/system/$TG_UNIT.d"
DC_DIR="/etc/systemd/system/$DC_UNIT.d"
test ! -e "$RELEASE_DIR"
test ! -L "$RELEASE_DIR"
sudo test ! -e "$TG_DIR/$DROPIN"
sudo test ! -e "$DC_DIR/$DROPIN"
sudo test ! -L "$TG_DIR/$DROPIN"
sudo test ! -L "$DC_DIR/$DROPIN"

mkdir -p -- "$BOT_DIR/.local-backups"
BACKUP_DIR=$(mktemp -d "$BOT_DIR/.local-backups/upgrade-v$VERSION-XXXXXXXX")
echo "备份目录：$BACKUP_DIR"
cp -a -- "$BOT_DIR/.env" "$BACKUP_DIR/tg.env"
cp -a -- "$DC_ENV" "$BACKUP_DIR/discord.env"
cp -a -- "$TG_SESSION" "$BACKUP_DIR/tg-sessions.json"
cp -a -- "$DC_SESSION" "$BACKUP_DIR/discord-sessions.json"
if [ -f "$TG_REMINDER" ]; then cp -a -- "$TG_REMINDER" "$BACKUP_DIR/tg-reminders.json"; fi
if [ -f "$DC_REMINDER" ]; then cp -a -- "$DC_REMINDER" "$BACKUP_DIR/discord-reminders.json"; fi
systemctl cat "$TG_UNIT" > "$BACKUP_DIR/tg-unit-before.txt"
systemctl cat "$DC_UNIT" > "$BACKUP_DIR/discord-unit-before.txt"
printf '%s\n' "$BOT_DIR" "$TG_SESSION" "$DC_SESSION" "$TG_REMINDER" "$DC_REMINDER" "$TG_HOME" "$DC_HOME" > "$BACKUP_DIR/paths.txt"
# WORKDIR、CODEX_HOME 和自定义日历原地保留，不移动或覆盖。

BASE_URL="https://github.com/rshun/codex-bot/releases/download/v$VERSION"
curl --fail --location --retry 3 --output "$BACKUP_DIR/$ARCHIVE" "$BASE_URL/$ARCHIVE"
curl --fail --location --retry 3 --output "$BACKUP_DIR/SHA256SUMS" "$BASE_URL/SHA256SUMS"
( cd "$BACKUP_DIR"; sha256sum --check --ignore-missing SHA256SUMS )
tar -tzf "$BACKUP_DIR/$ARCHIVE"
mkdir -p -- "$BOT_DIR/releases"
tar --extract --gzip --file "$BACKUP_DIR/$ARCHIVE" --directory "$BOT_DIR/releases" --no-same-owner
test -x "$BIN"
test "$("$BIN" --version)" = "$VERSION"
env SESSION_FILE="$TG_SESSION" REMINDER_FILE="$TG_REMINDER" CODEX_HOME="$TG_HOME" \
  "$BIN" telegram --config-dir "$BOT_DIR" --check-config
env SESSION_FILE="$DC_SESSION" REMINDER_FILE="$DC_REMINDER" CODEX_HOME="$DC_HOME" DISCORD_ENV_FILE="$DC_ENV" \
  "$BIN" discord --config-dir "$BOT_DIR" --check-config

# 保留原 unit 和所有环境设置，仅新增启动入口及固定原路径的覆盖项。
cat > "$BACKUP_DIR/tg-v1.7.0.conf" <<EOF
[Service]
ExecStart=
ExecStart=$BIN telegram --config-dir $BOT_DIR
Environment="SESSION_FILE=$TG_SESSION"
Environment="REMINDER_FILE=$TG_REMINDER"
Environment="CODEX_HOME=$TG_HOME"
EOF
cat > "$BACKUP_DIR/discord-v1.7.0.conf" <<EOF
[Service]
ExecStart=
ExecStart=$BIN discord --config-dir $BOT_DIR
Environment="DISCORD_ENV_FILE=$DC_ENV"
Environment="SESSION_FILE=$DC_SESSION"
Environment="REMINDER_FILE=$DC_REMINDER"
Environment="CODEX_HOME=$DC_HOME"
EOF
sudo mkdir -p -- "$TG_DIR" "$DC_DIR"
sudo cp --no-clobber -- "$BACKUP_DIR/tg-v1.7.0.conf" "$TG_DIR/$DROPIN"
sudo cp --no-clobber -- "$BACKUP_DIR/discord-v1.7.0.conf" "$DC_DIR/$DROPIN"
sudo cmp -- "$BACKUP_DIR/tg-v1.7.0.conf" "$TG_DIR/$DROPIN"
sudo cmp -- "$BACKUP_DIR/discord-v1.7.0.conf" "$DC_DIR/$DROPIN"
sudo systemctl daemon-reload
# 如果存在排序更靠后的管理员覆盖项，禁止重启，先核对配置。
for unit in "$TG_UNIT" "$DC_UNIT"; do
  effective=$(systemctl show "$unit" -p ExecStart --value)
  case "$effective" in *"$BIN "*) ;; *) echo "启动覆盖项未生效：$unit；先按回滚步骤撤销本次覆盖"; exit 1;; esac
done
sudo systemctl restart "$TG_UNIT"
systemctl is-active --quiet "$TG_UNIT"
sudo systemctl restart "$DC_UNIT"
systemctl is-active --quiet "$DC_UNIT"
systemctl show "$TG_UNIT" "$DC_UNIT" -p MainPID -p ExecStart
echo "两个服务已重启；保留备份目录：$BACKUP_DIR"
BASH
```

路径变量若包含空格、换行、反斜线、引号、`%` 或 `$`，不要直接套用上述生成 drop-in 的命令，需根据 systemd 的转义规则单独处理。标准示例路径不包含这些字符。

`--check-config` 只读本地文件，不调用模型、不连接平台、不验证登录或网络；完整服务联网验证在下一节完成。若安装覆盖项之后失败，停止重试整段脚本，使用记录的备份路径按回滚节处理。该脚本不自动回滚，避免掩盖失败原因。已有 `upgrade-v1.6.0.sh` 专用于旧 Node 运行包，不能用于本次可执行升级。

## 升级后验证

```bash
systemctl is-active codex-tg-bot.service codex-discord-bot.service
journalctl -u codex-tg-bot.service -u codex-discord-bot.service -n 80 --no-pager
```

日志只在服务器本地查看，分享前脱敏。两个平台分别检查 `/status` 和 `/reminders`，确认模型、会话和旧提醒仍在；继续旧对话确认上下文；各创建一个短期测试提醒确认真实送达。`active`、CI 通过和只读检查不能替代这些验证。日常使用不需要重新注册 Discord 命令。

## 回滚到原来的启动程序

回滚也会重启两个服务。先确认空闲，**保留升级后的最新状态，不恢复旧数据备份**。下面用本次备份的覆盖文件对比实际文件；若管理员已修改覆盖项则停止，人工核对，不覆盖它。

```bash
bash <<'BASH'
set -Eeuo pipefail
umask 077
# 替换成升级时打印的真实备份目录。
BACKUP_DIR=/home/codex/codex-tg-bot/.local-backups/upgrade-v1.7.0-实际后缀
TG_CONF=/etc/systemd/system/codex-tg-bot.service.d/zzzzzz-codex-bot-v1.7.0.conf
DC_CONF=/etc/systemd/system/codex-discord-bot.service.d/zzzzzz-codex-bot-v1.7.0.conf
test -f "$BACKUP_DIR/tg-v1.7.0.conf"
test -f "$BACKUP_DIR/discord-v1.7.0.conf"
ACTIVE=()
if sudo test -e "$TG_CONF"; then
  sudo cmp -- "$BACKUP_DIR/tg-v1.7.0.conf" "$TG_CONF"
  ACTIVE+=("$TG_CONF")
fi
if sudo test -e "$DC_CONF"; then
  sudo cmp -- "$BACKUP_DIR/discord-v1.7.0.conf" "$DC_CONF"
  ACTIVE+=("$DC_CONF")
fi
if [ "${#ACTIVE[@]}" -eq 0 ]; then echo '本次覆盖项尚未安装，无需回滚'; exit 0; fi
LATEST=$(mktemp -d "$BACKUP_DIR/before-rollback-XXXXXXXX")
mapfile -t ORIGINAL_PATHS < "$BACKUP_DIR/paths.txt"
test "${#ORIGINAL_PATHS[@]}" -eq 7
for i in 1 2 3 4; do
  if [ -f "${ORIGINAL_PATHS[$i]}" ]; then cp -a -- "${ORIGINAL_PATHS[$i]}" "$LATEST/state-$i.json"; fi
done
printf '[Service]\n' > "$LATEST/disabled.conf"
# 仅撤销本次覆盖，保留原 unit / 其它 drop-in 和文件本身。
for i in "${!ACTIVE[@]}"; do
  sudo cp -a -- "${ACTIVE[$i]}" "$LATEST/active-$i.conf"
  sudo cp -- "$LATEST/disabled.conf" "${ACTIVE[$i]}"
done
sudo systemctl daemon-reload
systemctl show codex-tg-bot.service codex-discord-bot.service -p ExecStart
sudo systemctl restart codex-tg-bot.service
systemctl is-active --quiet codex-tg-bot.service
sudo systemctl restart codex-discord-bot.service
systemctl is-active --quiet codex-discord-bot.service
BASH
```

旧 Node、旧程序目录和原 drop-in 必须仍在。回滚到原 v1.6.0 不需要转换会话或提醒格式；更老版本需另外核实状态兼容性。回滚后再次检查两平台的上下文和提醒。
