#!/usr/bin/env bash
# User-operated upgrade only. Never source .env, remove files, or restore stale data.
set -Eeuo pipefail
umask 077
VERSION=1.9.0
TG_UNIT=codex-tg-bot.service
DC_UNIT=codex-discord-bot.service
SERVICE_USER=codex
BOT_DIR=${BOT_DIR:-/home/codex/codex-tg-bot}
DC_ENV=${DC_ENV:-$BOT_DIR/.env.discord}
TG_SESSION=${TG_SESSION:-$BOT_DIR/.bot-state/sessions.json}
DC_SESSION=${DC_SESSION:-$BOT_DIR/.bot-state/discord-sessions.json}
TG_REMINDER=${TG_REMINDER:-$BOT_DIR/.bot-state/telegram-reminders.json}
DC_REMINDER=${DC_REMINDER:-$BOT_DIR/.bot-state/discord-reminders.json}
TG_HOME=${TG_HOME:-/home/codex/.codex}
DC_HOME=${DC_HOME:-/home/codex/.codex}
MODE=${1:-}
BACKUP_DIR=${2:-}
fail() { printf '%s\n' "$*" >&2; exit 1; }
case "$MODE" in
  upgrade) [ "$#" -eq 1 ] || fail '用法：bash upgrade-v1.9.0.sh upgrade' ;;
  rollback) [ "$#" -eq 2 ] || fail '用法：bash upgrade-v1.9.0.sh rollback 备份目录' ;;
  *) fail '用法：bash upgrade-v1.9.0.sh upgrade | rollback 备份目录' ;;
esac
for tool in systemctl sudo curl tar sha256sum cmp mktemp cp sort wc uname; do
  command -v "$tool" >/dev/null || fail "缺少工具：$tool；未安装任何依赖"
done
case "$(uname -m)" in
  x86_64) TARGET=linux-x64 ;;
  aarch64|arm64) TARGET=linux-arm64 ;;
  *) fail '不支持的 CPU 架构' ;;
esac
ROLLBACK_BIN=${ROLLBACK_BIN:-$BOT_DIR/releases/codex-bot-v1.8.0-$TARGET/codex-bot}
if [ "$MODE" = rollback ]; then
  [ -d "$BACKUP_DIR" ] && [ ! -L "$BACKUP_DIR" ] || fail '备份目录不存在或为符号链接'
  mapfile -t paths < "$BACKUP_DIR/paths.txt"
  [ "${#paths[@]}" -eq 9 ] || fail '备份路径记录无效'
  BOT_DIR=${paths[0]}; DC_ENV=${paths[1]}; TG_SESSION=${paths[2]}; DC_SESSION=${paths[3]}
  TG_REMINDER=${paths[4]}; DC_REMINDER=${paths[5]}; TG_HOME=${paths[6]}; DC_HOME=${paths[7]}; ROLLBACK_BIN=${paths[8]}
fi
for value in "$BOT_DIR" "$DC_ENV" "$TG_SESSION" "$DC_SESSION" "$TG_REMINDER" "$DC_REMINDER" "$TG_HOME" "$DC_HOME" "$ROLLBACK_BIN"; do
  case "$value" in /*) ;; *) fail '路径必须为绝对路径' ;; esac
  case "$value" in *[!A-Za-z0-9_./-]*) fail '路径含需单独转义的字符，已停止' ;; esac
done
[ "$(id -un)" = "$SERVICE_USER" ] || fail '请以原服务账号 codex 执行'
[ "$(systemctl show "$TG_UNIT" -p User --value)" = "$SERVICE_USER" ] || fail 'TG 服务账号不匹配'
[ "$(systemctl show "$DC_UNIT" -p User --value)" = "$SERVICE_USER" ] || fail 'Discord 服务账号不匹配'
[ -f "$BOT_DIR/.env" ] && [ -f "$DC_ENV" ] || fail '原配置文件不存在'
[ -f "$TG_SESSION" ] && [ -f "$DC_SESSION" ] || fail '原会话不存在；请核对旧进程实际状态路径'
[ "$(printf '%s\n' "$TG_SESSION" "$DC_SESSION" "$TG_REMINDER" "$DC_REMINDER" | sort -u | wc -l)" -eq 4 ] || fail '两个服务的会话/提醒路径必须相互独立'
RELEASE_NAME=codex-bot-v$VERSION-$TARGET
ARCHIVE=$RELEASE_NAME.tar.gz
RELEASE_DIR=$BOT_DIR/releases/$RELEASE_NAME
BIN=$RELEASE_DIR/codex-bot
DROPIN=zzzzzz-codex-bot-v$VERSION.conf
TG_DIR=/etc/systemd/system/$TG_UNIT.d
DC_DIR=/etc/systemd/system/$DC_UNIT.d
check_config() {
  env SESSION_FILE="$TG_SESSION" REMINDER_FILE="$TG_REMINDER" CODEX_HOME="$TG_HOME" \
    "$1" telegram --config-dir "$BOT_DIR" --check-config || return 1
  env SESSION_FILE="$DC_SESSION" REMINDER_FILE="$DC_REMINDER" CODEX_HOME="$DC_HOME" DISCORD_ENV_FILE="$DC_ENV" \
    "$1" discord --config-dir "$BOT_DIR" --check-config || return 1
}
backup_state() {
  cp -a -- "$BOT_DIR/.env" "$1/tg.env"
  cp -a -- "$DC_ENV" "$1/discord.env"
  cp -a -- "$TG_SESSION" "$1/tg-sessions.json"
  cp -a -- "$DC_SESSION" "$1/discord-sessions.json"
  if [ -f "$TG_REMINDER" ]; then cp -a -- "$TG_REMINDER" "$1/tg-reminders.json"; fi
  if [ -f "$DC_REMINDER" ]; then cp -a -- "$DC_REMINDER" "$1/discord-reminders.json"; fi
  systemctl cat "$TG_UNIT" > "$1/tg-unit.txt"
  systemctl cat "$DC_UNIT" > "$1/discord-unit.txt"
  systemctl show "$TG_UNIT" -p ExecStart --value > "$1/tg-exec-start.txt"
  systemctl show "$DC_UNIT" -p ExecStart --value > "$1/discord-exec-start.txt"
}
trap 'printf "操作失败；已保留程序、数据和备份。不要重跑覆盖，请按升级文档核对。\n" >&2' ERR
if [ "$MODE" = upgrade ]; then
  systemctl is-active --quiet "$TG_UNIT"
  systemctl is-active --quiet "$DC_UNIT"
  [ ! -e "$RELEASE_DIR" ] && [ ! -L "$RELEASE_DIR" ] || fail '目标版本目录已存在，不覆盖'
  for file in "$TG_DIR/$DROPIN" "$DC_DIR/$DROPIN"; do
    sudo test ! -e "$file" && sudo test ! -L "$file" || fail '本次覆盖项已存在，不覆盖'
  done
  mkdir -p -- "$BOT_DIR/.local-backups"
  BACKUP_DIR=$(mktemp -d "$BOT_DIR/.local-backups/upgrade-v$VERSION-XXXXXXXX")
  printf '备份目录：%s\n' "$BACKUP_DIR"
  backup_state "$BACKUP_DIR"
  printf '%s\n' "$BOT_DIR" "$DC_ENV" "$TG_SESSION" "$DC_SESSION" "$TG_REMINDER" "$DC_REMINDER" "$TG_HOME" "$DC_HOME" "$ROLLBACK_BIN" > "$BACKUP_DIR/paths.txt"
  BASE_URL=https://github.com/rshun/codex-bot/releases/download/v$VERSION
  curl --fail --location --retry 3 --output "$BACKUP_DIR/$ARCHIVE" "$BASE_URL/$ARCHIVE"
  curl --fail --location --retry 3 --output "$BACKUP_DIR/SHA256SUMS" "$BASE_URL/SHA256SUMS"
  ( cd "$BACKUP_DIR"; sha256sum --check --ignore-missing SHA256SUMS )
  tar -tzf "$BACKUP_DIR/$ARCHIVE"
  mkdir -p -- "$BOT_DIR/releases"
  tar --extract --gzip --file "$BACKUP_DIR/$ARCHIVE" --directory "$BOT_DIR/releases" --no-same-owner
  [ -x "$BIN" ] && [ "$("$BIN" --version)" = "$VERSION" ] || fail '可执行程序或版本不符'
  check_config "$BIN"
  cat > "$BACKUP_DIR/tg.conf" <<EOF
[Service]
ExecStart=
ExecStart=$BIN telegram --config-dir $BOT_DIR
Environment="SESSION_FILE=$TG_SESSION"
Environment="REMINDER_FILE=$TG_REMINDER"
Environment="CODEX_HOME=$TG_HOME"
EOF
  cat > "$BACKUP_DIR/discord.conf" <<EOF
[Service]
ExecStart=
ExecStart=$BIN discord --config-dir $BOT_DIR
Environment="DISCORD_ENV_FILE=$DC_ENV"
Environment="SESSION_FILE=$DC_SESSION"
Environment="REMINDER_FILE=$DC_REMINDER"
Environment="CODEX_HOME=$DC_HOME"
EOF
  sudo mkdir -p -- "$TG_DIR" "$DC_DIR"
  # Exclusive publication: do not overwrite a drop-in appearing after preflight.
  sudo cp --no-clobber -- "$BACKUP_DIR/tg.conf" "$TG_DIR/$DROPIN"
  sudo cp --no-clobber -- "$BACKUP_DIR/discord.conf" "$DC_DIR/$DROPIN"
  sudo cmp -- "$BACKUP_DIR/tg.conf" "$TG_DIR/$DROPIN"
  sudo cmp -- "$BACKUP_DIR/discord.conf" "$DC_DIR/$DROPIN"
  sudo systemctl daemon-reload
  for unit in "$TG_UNIT" "$DC_UNIT"; do
    effective=$(systemctl show "$unit" -p ExecStart --value)
    case "$effective" in *"$BIN "*) ;; *) fail "启动覆盖项未生效：$unit；请按文档撤销本次覆盖" ;; esac
  done
else
  [ -x "$ROLLBACK_BIN" ] || fail '旧可执行程序不存在，请保留旧版本并核对 ROLLBACK_BIN'
  [ "$("$ROLLBACK_BIN" --version)" = 1.8.0 ] || fail '自动回滚检查要求保留的v1.8.0程序，已停止'
  for name in tg discord; do
    [ -f "$BACKUP_DIR/$name-exec-start.txt" ] || fail '缺少升级前的有效启动记录，已停止'
    original=$(cat "$BACKUP_DIR/$name-exec-start.txt")
    case "$original" in *"$ROLLBACK_BIN "*) ;; *) fail '回滚检查程序与升级前实际入口不匹配，请按文档人工核对' ;; esac
  done
  # Old code must accept CURRENT state before removing our startup override.
  # v1.8.0 rejects v4 paused reminders; never convert prompts or restore stale data.
  check_config "$ROLLBACK_BIN" || fail '旧程序不能读取当前状态；未回滚、未恢复旧数据。请先按文档处理版本4兼容性'
  ACTIVE=()
  for pair in "tg:$TG_DIR/$DROPIN" "discord:$DC_DIR/$DROPIN"; do
    name=${pair%%:*}; file=${pair#*:}
    if sudo test -e "$file"; then
      sudo test ! -L "$file" || fail '覆盖项是符号链接，已停止'
      sudo cmp -- "$BACKUP_DIR/$name.conf" "$file" || fail '覆盖项已被修改，未覆盖'
      ACTIVE+=("$file")
    fi
  done
  [ "${#ACTIVE[@]}" -gt 0 ] || fail '本次覆盖项未安装，无需回滚'
  LATEST=$(mktemp -d "$BACKUP_DIR/before-rollback-XXXXXXXX")
  backup_state "$LATEST"
  printf '[Service]\n' > "$LATEST/disabled.conf"
  for i in "${!ACTIVE[@]}"; do
    sudo cp -a -- "${ACTIVE[$i]}" "$LATEST/active-$i.conf"
    sudo cp -- "$LATEST/disabled.conf" "${ACTIVE[$i]}"
  done
  sudo systemctl daemon-reload
  systemctl show "$TG_UNIT" "$DC_UNIT" -p ExecStart
fi
# Both actions restart the services. Operator must first confirm both Bots idle.
sudo systemctl restart "$TG_UNIT"
systemctl is-active --quiet "$TG_UNIT"
sudo systemctl restart "$DC_UNIT"
systemctl is-active --quiet "$DC_UNIT"
systemctl show "$TG_UNIT" "$DC_UNIT" -p MainPID -p ExecStart
printf '完成 %s；请检查平台上下文及提醒实际送达。保留备份：%s\n' "$MODE" "$BACKUP_DIR"
