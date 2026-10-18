#!/usr/bin/env bash
# Standalone Debian updater. No dependency installs, file deletion, or state restoration.
set -Eeuo pipefail
umask 077
VERSION=1.6.0
ARCHIVE_NAME=codex-bot-v1.6.0-node.tar.gz
EXPECTED_SHA=e20db6106dd7afc4e73594ccb9bf412cabeb0c1410e9e0279e75aff2100db863
EXPECTED_COMMIT=a314bc997b42d0c31174144b2e7e76e64e87c4a3
ACTION=${1:-help}
if (( $# )); then shift; fi
BACKUP_DIR=
LOCAL_ARCHIVE=
APPLYING=0
PHASE=arguments

say() { printf '%s\n' "$*"; }
fail() { say "错误：$*" >&2; exit 1; }
usage() {
  cat <<'HELP'
用法：bash upgrade-v1.6.0.sh 模式 [选项]
  check                         只检查本地路径、账号及服务，不写入、不调用模型
  preflight [--archive FILE]     备份、准备运行包、检查状态和模型，不切换服务
  upgrade [--archive FILE]       备份、预检、升级 TG 和 Discord
  upgrade --backup-dir DIR      使用此前 preflight 的备份记录继续升级
  rollback --backup-dir DIR     撤销本次覆盖项，恢复升级前入口，保留最新状态
选项：--backup-dir DIR、--archive FILE、--help
环境变量可配置 BOT_DIR、NODE_BIN、SERVICE_USER、TG_UNIT、DC_UNIT、TG_ENV、DC_ENV、
TG_SESSION、DC_SESSION、TG_REMINDER、DC_REMINDER、TG_HOME、DC_HOME。
升级前请确认两个 Bot 均空闲，执行期间不要发送新任务。会重启两个服务。
preflight/upgrade 默认分别验证两个平台默认模型的首次及恢复会话，消耗模型用量。
必须以服务账号执行，并已具备所需 sudo 权限；不自动修改账号权限。
HELP
}
case "$ACTION" in help|--help|-h) usage; exit 0;; check|preflight|upgrade|rollback) ;; *) usage >&2; exit 2;; esac
while (( $# )); do
  case "$1" in
    --backup-dir) (( $# >= 2 )) || fail '缺少备份路径'; [[ -z "$BACKUP_DIR" ]] || fail '备份路径重复'; BACKUP_DIR=$2; shift 2;;
    --archive) (( $# >= 2 )) || fail '缺少运行包路径'; [[ -z "$LOCAL_ARCHIVE" ]] || fail '运行包路径重复'; LOCAL_ARCHIVE=$2; shift 2;;
    --help) usage; exit 0;;
    *) fail '未知选项';;
  esac
done
[[ "$ACTION" != rollback || -n "$BACKUP_DIR" ]] || fail '回滚必须指定 --backup-dir'
[[ "$ACTION" != check || ( -z "$BACKUP_DIR" && -z "$LOCAL_ARCHIVE" ) ]] || fail 'check 不接受运行包或备份路径'
[[ "$ACTION" != rollback || -z "$LOCAL_ARCHIVE" ]] || fail '回滚不接受运行包'

BOT_DIR=${BOT_DIR:-/home/codex/codex-tg-bot}
NODE_BIN=${NODE_BIN:-/usr/bin/node}
SERVICE_USER=${SERVICE_USER:-codex}
TG_UNIT=${TG_UNIT:-codex-tg-bot.service}
DC_UNIT=${DC_UNIT:-codex-discord-bot.service}
TG_ENV=${TG_ENV:-$BOT_DIR/.env}
DC_ENV=${DC_ENV:-$BOT_DIR/.env.discord}
TG_SESSION=${TG_SESSION:-$BOT_DIR/.bot-state/sessions.json}
DC_SESSION=${DC_SESSION:-$BOT_DIR/.bot-state/discord-sessions.json}
TG_REMINDER=${TG_REMINDER:-$BOT_DIR/.bot-state/telegram-reminders.json}
DC_REMINDER=${DC_REMINDER:-$BOT_DIR/.bot-state/discord-reminders.json}
TG_HOME=${TG_HOME:-/home/codex/.codex}
DC_HOME=${DC_HOME:-/home/codex/.codex}
RELEASE_DIR=$BOT_DIR/releases/codex-bot-v1.6.0
RUN_ID=
FIELDS=(BOT_DIR NODE_BIN SERVICE_USER TG_UNIT DC_UNIT TG_ENV DC_ENV TG_SESSION DC_SESSION TG_REMINDER DC_REMINDER TG_HOME DC_HOME RELEASE_DIR RUN_ID)

root() { sudo -- "$@"; }
digest() { local value; value=$(sha256sum) || return; printf '%s' "${value%% *}"; }
tg_dropin() { printf '/etc/systemd/system/%s.d/zzzz-codex-bot-v1.6.0-%s.conf' "$TG_UNIT" "$RUN_ID"; }
dc_dropin() { printf '/etc/systemd/system/%s.d/zzzz-codex-bot-v1.6.0-%s.conf' "$DC_UNIT" "$RUN_ID"; }

# Metadata is parsed as data, never sourced/evaluated as shell code.
metadata() {
  local operation=$1; shift
  "$NODE_BIN" - "$operation" "$BACKUP_DIR" "$BOT_DIR" "$@" <<'NODE'
const fs=require('node:fs'),path=require('node:path');
const [operation,backup,bot,...values]=process.argv.slice(2);
const names=['BOT_DIR','NODE_BIN','SERVICE_USER','TG_UNIT','DC_UNIT','TG_ENV','DC_ENV','TG_SESSION','DC_SESSION','TG_REMINDER','DC_REMINDER','TG_HOME','DC_HOME','RELEASE_DIR','RUN_ID'];
const invalid=value=>typeof value!=='string'||!value||/[\x00-\x1f\x7f"\\%$]/.test(value);
function validate(settings){
  if(names.some(key=>invalid(settings[key])))throw Error();
  for(const key of names.filter(key=>!['SERVICE_USER','TG_UNIT','DC_UNIT','RUN_ID'].includes(key)))if(!path.isAbsolute(settings[key]))throw Error();
  if(!/^[a-z_][a-z0-9_-]*[$]?$/.test(settings.SERVICE_USER)||
    ![settings.TG_UNIT,settings.DC_UNIT].every(value=>/^[A-Za-z0-9_.@-]+\.service$/.test(value))||settings.TG_UNIT===settings.DC_UNIT||
    !/^[a-f0-9-]{36}$/.test(settings.RUN_ID)||path.resolve(settings.BOT_DIR)!==path.resolve(bot)||
    path.resolve(settings.RELEASE_DIR)!==path.resolve(bot,'releases','codex-bot-v1.6.0')||
    new Set([settings.TG_SESSION,settings.DC_SESSION,settings.TG_REMINDER,settings.DC_REMINDER].map(value=>path.resolve(value))).size!==4)throw Error();
}
try{
  if(operation==='validate'){
    validate(Object.fromEntries(names.map((name,index)=>[name,values[index]])));
    process.exit(0);
  }
  const base=path.resolve(bot,'.local-backups');
  const resolved=path.resolve(backup);
  if(!resolved.startsWith(base+path.sep)||!/^dual-v1\.6\.0-[a-f0-9-]{36}$/.test(path.basename(resolved))||
    fs.realpathSync(resolved)!==resolved||fs.realpathSync(base)!==base)throw Error();
  const stat=fs.statSync(resolved);
  if(process.platform!=='win32'&&(stat.uid!==process.getuid()||(stat.mode&0o077)!==0))throw Error();
  const filename=path.join(resolved,'upgrade-receipt.json');
  if(operation==='write'){
    const settings=Object.fromEntries(names.map((name,index)=>[name,values[index]]));validate(settings);
    if(path.basename(resolved)!=='dual-v1.6.0-'+settings.RUN_ID)throw Error();
    fs.writeFileSync(filename,JSON.stringify({version:1,targetVersion:'1.6.0',
      sourceCommit:'a314bc997b42d0c31174144b2e7e76e64e87c4a3',createdAt:new Date().toISOString(),settings},null,2)+'\n',{flag:'wx',mode:0o600});
  }else if(operation==='read'){
    if(fs.lstatSync(filename).isSymbolicLink()||fs.statSync(filename).size>32768)throw Error();
    const data=JSON.parse(fs.readFileSync(filename,'utf8'));
    if(data.version!==1||data.targetVersion!=='1.6.0'||data.sourceCommit!=='a314bc997b42d0c31174144b2e7e76e64e87c4a3')throw Error();
    validate(data.settings);
    if(path.basename(resolved)!=='dual-v1.6.0-'+data.settings.RUN_ID)throw Error();
    process.stdout.write(names.map(name=>data.settings[name]).join('\n')+'\n');
  }else throw Error();
}catch{console.error('备份记录无效、路径不匹配或目录权限不安全，未修改服务。');process.exitCode=1;}
NODE
}

load_record() {
  local loaded index; local -a values
  loaded=$(metadata read) || return 1
  mapfile -t values <<< "$loaded"
  [[ ${#values[@]} == ${#FIELDS[@]} ]] || return 1
  for index in "${!FIELDS[@]}"; do printf -v "${FIELDS[$index]}" '%s' "${values[$index]}"; done
}

make_stages() {
  # Settings reject control characters, quotes, backslashes and systemd specifiers.
  cat <<EOF
# Codex Bot v1.6.0 updater: $RUN_ID
[Service]
ExecStart=
ExecStart="$NODE_BIN" "$RELEASE_DIR/index.js"
Environment="SESSION_FILE=$TG_SESSION" "REMINDER_FILE=$TG_REMINDER"
EOF
}
make_dc_stage() {
  cat <<EOF
# Codex Bot v1.6.0 updater: $RUN_ID
[Service]
ExecStart=
ExecStart="$NODE_BIN" "$RELEASE_DIR/discord.js"
Environment="DISCORD_ENV_FILE=$DC_ENV" "SESSION_FILE=$DC_SESSION" "REMINDER_FILE=$DC_REMINDER"
EOF
}
make_disabled() { printf '# Codex Bot v1.6.0 rollback: %s\n[Service]\n' "$RUN_ID"; }

copy_states() {
  local destination=$1
  cp -pL -- "$TG_SESSION" "$destination/telegram-sessions.json" || return 1
  cp -pL -- "$DC_SESSION" "$destination/discord-sessions.json" || return 1
  if [[ -f "$TG_REMINDER" ]]; then cp -pL -- "$TG_REMINDER" "$destination/telegram-reminders.json" || return 1; fi
  if [[ -f "$DC_REMINDER" ]]; then cp -pL -- "$DC_REMINDER" "$destination/discord-reminders.json" || return 1; fi
}

check_owned() {
  local target=$1 wanted=$2 actual disabled
  root test ! -L "$target" || return 1
  if ! root test -e "$target"; then return 0; fi
  actual=$(root cat -- "$target" | digest) || return 1
  disabled=$(make_disabled | digest) || return 1
  [[ "$actual" == "$wanted" || "$actual" == "$disabled" ]]
}

rollback_services() {
  local tg dc tg_hash dc_hash saved
  tg=$(tg_dropin); dc=$(dc_dropin)
  if ! root test -e "$tg" && ! root test -e "$dc"; then
    root test ! -L "$tg" && root test ! -L "$dc" || return 1
    say '没有本次覆盖项，无需修改或重启服务。'
    return 0
  fi
  tg_hash=$(make_stages | digest) || return 1
  dc_hash=$(make_dc_stage | digest) || return 1
  check_owned "$tg" "$tg_hash" && check_owned "$dc" "$dc_hash" || {
    say '本次覆盖文件内容不一致或为链接；停止回滚，请人工核对，未覆盖文件。' >&2; return 1;
  }
  saved=$BACKUP_DIR/rollback-$("$NODE_BIN" -p 'require("node:crypto").randomUUID()') || return 1
  mkdir -- "$saved" || return 1
  copy_states "$saved" || return 1
  if root test -e "$tg"; then
    root cp -p -- "$tg" "$saved/telegram-dropin.conf" || return 1
    make_disabled | root tee "$tg" >/dev/null || return 1
  fi
  if root test -e "$dc"; then
    root cp -p -- "$dc" "$saved/discord-dropin.conf" || return 1
    make_disabled | root tee "$dc" >/dev/null || return 1
  fi
  root systemctl daemon-reload || return 1
  local failed=0
  root systemctl restart "$TG_UNIT" || failed=1
  root systemctl restart "$DC_UNIT" || failed=1
  sleep 10
  systemctl is-active --quiet "$TG_UNIT" || failed=1
  systemctl is-active --quiet "$DC_UNIT" || failed=1
  [[ "$failed" == 0 ]] || return 1
  printf '%s\n' 'rolled-back' >> "$BACKUP_DIR/events.log" || return 1
  say "已撤销本次覆盖项并重启两个服务，最新状态未还原；回滚现场：$saved"
}

on_error() {
  local status=${1:-$?}
  trap - ERR INT TERM
  set +e
  say "阶段 $PHASE 失败，流程已停止。" >&2
  if [[ "$ACTION" == upgrade && "$APPLYING" == 1 ]]; then
    say '正在尝试撤销本次覆盖项并恢复两个服务……' >&2
    if rollback_services; then say '自动回滚完成。' >&2
    else say '自动回滚未完成：保留现场，请检查本次备份和两个服务状态。' >&2; fi
  fi
  [[ -z "$BACKUP_DIR" ]] || say "备份目录：$BACKUP_DIR" >&2
  exit "$status"
}
trap on_error ERR
trap 'on_error 130' INT
trap 'on_error 143' TERM

basic_check() {
  local -a settings=(); local field
  for field in "${FIELDS[@]}"; do settings+=("${!field}"); done
  settings[14]=${RUN_ID:-00000000-0000-0000-0000-000000000000}
  metadata validate "${settings[@]}"
  [[ "$(id -un)" == "$SERVICE_USER" ]] || fail '必须使用实际服务账号执行'
  [[ -d "$BOT_DIR" && -x "$NODE_BIN" ]] || fail '项目目录或 Node 路径无效'
  "$NODE_BIN" -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<4))process.exit(1)'
  command -v sudo systemctl sha256sum cp >/dev/null
  for file in "$TG_ENV" "$DC_ENV" "$TG_SESSION" "$DC_SESSION"; do
    [[ -f "$file" && -r "$file" ]] || fail '配置/会话文件缺失或不可读，请核对实际路径，不要创建空状态绕过'
  done
  [[ -d "$TG_HOME" && -d "$DC_HOME" ]] || fail 'Codex 历史目录缺失'
  for unit in "$TG_UNIT" "$DC_UNIT"; do
    [[ "$(systemctl show "$unit" --property=User --value)" == "$SERVICE_USER" ]] || fail '服务账号不匹配'
    [[ "$(systemctl show "$unit" --property=WorkingDirectory --value)" == "$BOT_DIR" ]] || fail '服务 WorkingDirectory 不匹配'
    if [[ "$ACTION" != rollback ]]; then systemctl is-active --quiet "$unit"; fi
  done
}

[[ -x "$NODE_BIN" ]] || fail 'Node 不可执行'
absolute_path() {
  "$NODE_BIN" -e 'process.stdout.write(require("node:path").resolve(process.argv[1]).split(require("node:path").sep).join("/"))' -- "$1"
}
SCRIPT_FILE=$(absolute_path "${BASH_SOURCE[0]}")
if [[ -n "$LOCAL_ARCHIVE" ]]; then LOCAL_ARCHIVE=$(absolute_path "$LOCAL_ARCHIVE"); fi
if [[ -n "$BACKUP_DIR" ]]; then BACKUP_DIR=$(absolute_path "$BACKUP_DIR"); fi
if [[ -n "$BACKUP_DIR" ]]; then load_record; fi
PHASE=local-check
basic_check
if [[ "$ACTION" == check ]]; then
  say '本地检查通过；未写文件、下载、调用模型或修改服务。请确认 systemd 环境覆盖和变量一致。'
  exit 0
fi
sudo -v
command -v flock >/dev/null
mkdir -p -- "$BOT_DIR/.local-backups"
[[ ! -L "$BOT_DIR/.local-backups/.upgrade-v1.6.0.lock" ]] || fail '锁文件不能为链接'
exec 9>"$BOT_DIR/.local-backups/.upgrade-v1.6.0.lock"
flock -n 9 || fail '另一个升级或回滚正在执行'
cd "$BOT_DIR"
if [[ "$ACTION" == rollback ]]; then PHASE=rollback; rollback_services; exit 0; fi

if [[ -z "$BACKUP_DIR" ]]; then
  PHASE=backup
  RUN_ID=$("$NODE_BIN" -p 'require("node:crypto").randomUUID()')
  BACKUP_DIR=$BOT_DIR/.local-backups/dual-v1.6.0-$RUN_ID
  mkdir -- "$BACKUP_DIR"
  mkdir -- "$BACKUP_DIR/state" "$BACKUP_DIR/download"
  say "备份目录：$BACKUP_DIR"
  settings=(); for field in "${FIELDS[@]}"; do settings+=("${!field}"); done
  metadata write "${settings[@]}"
  cp -p -- "$SCRIPT_FILE" "$BACKUP_DIR/upgrade-v1.6.0.sh"
  cp -pL -- "$TG_ENV" "$BACKUP_DIR/telegram.env"
  cp -pL -- "$DC_ENV" "$BACKUP_DIR/discord.env"
  copy_states "$BACKUP_DIR/state"
  root systemctl cat "$TG_UNIT" > "$BACKUP_DIR/telegram-systemd-before.txt"
  root systemctl cat "$DC_UNIT" > "$BACKUP_DIR/discord-systemd-before.txt"
  cp -a -- "$TG_HOME" "$BACKUP_DIR/codex-home-tg"
  if [[ "$DC_HOME" != "$TG_HOME" ]]; then cp -a -- "$DC_HOME" "$BACKUP_DIR/codex-home-discord"; fi
  printf '%s\n' 'backup-complete' >> "$BACKUP_DIR/events.log"
else
  grep -qx 'backup-complete' "$BACKUP_DIR/events.log" || fail '备份未完成，不能继续升级'
  [[ ! -e "$BACKUP_DIR/applied" ]] || fail '该记录已切换过服务，请使用 rollback 或新建预检记录'
fi

PHASE=prepare-package
command -v tar curl >/dev/null
if [[ -n "$LOCAL_ARCHIVE" ]]; then
  cp -n -- "$LOCAL_ARCHIVE" "$BACKUP_DIR/download/$ARCHIVE_NAME"
elif [[ ! -f "$BACKUP_DIR/download/$ARCHIVE_NAME" ]]; then
  curl -fLsS -o "$BACKUP_DIR/download/$ARCHIVE_NAME" \
    "https://github.com/rshun/codex-bot/releases/download/v$VERSION/$ARCHIVE_NAME" 2>/dev/null
fi
printf '%s  %s\n' "$EXPECTED_SHA" "$BACKUP_DIR/download/$ARCHIVE_NAME" | sha256sum --check -
PACKAGE_REFERENCE=$BACKUP_DIR/verified-$("$NODE_BIN" -p 'require("node:crypto").randomUUID()')
mkdir -- "$PACKAGE_REFERENCE"
tar -xzf "$BACKUP_DIR/download/$ARCHIVE_NAME" -C "$PACKAGE_REFERENCE"
if [[ ! -e "$RELEASE_DIR" && ! -L "$RELEASE_DIR" ]]; then
  mkdir -p -- "$BOT_DIR/releases"
  tar -xzf "$BACKUP_DIR/download/$ARCHIVE_NAME" -C "$BOT_DIR/releases"
fi
[[ ! -L "$RELEASE_DIR" ]] || fail '版本目录不能为链接'

PHASE=preflight
"$NODE_BIN" - "$RELEASE_DIR" "$TG_ENV" "$DC_ENV" "$TG_SESSION" "$DC_SESSION" \
  "$TG_REMINDER" "$DC_REMINDER" "$TG_HOME" "$DC_HOME" "$BACKUP_DIR" "$PACKAGE_REFERENCE/codex-bot-v1.6.0" <<'NODE'
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const [root,tgEnv,dcEnv,tgSession,dcSession,tgReminder,dcReminder,tgHome,dcHome,backup,reference]=process.argv.slice(2);
(async()=>{
  const trusted=fs.readFileSync(path.join(reference,'release-manifest.json'));
  if(!trusted.equals(fs.readFileSync(path.join(root,'release-manifest.json'))))throw Error();
  const manifest=JSON.parse(trusted);
  if(manifest.version!=='1.6.0'||manifest.developmentBuild||manifest.commit!=='a314bc997b42d0c31174144b2e7e76e64e87c4a3')throw Error();
  for(const [file,hash]of Object.entries(manifest.files)){
    const target=path.resolve(root,file);
    if(!target.startsWith(path.resolve(root)+path.sep)||fs.realpathSync(target)!==target||
      crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')!==hash)throw Error();
  }
  const dotenv=require(path.join(root,'node_modules/dotenv'));
  const {loadConfig}=require(path.join(root,'index'));
  const {loadDiscordConfig}=require(path.join(root,'discord'));
  const {SessionStore}=require(path.join(root,'session-store'));
  const {ReminderScheduler}=require(path.join(root,'reminders'));
  const {runCodex}=require(path.join(root,'codex-runner'));
  const {outputSchema,parseResponse}=require(path.join(root,'semantic-reminders'));
  for(const [platform,file,session,reminder,home]of [['telegram',tgEnv,tgSession,tgReminder,tgHome],['discord',dcEnv,dcSession,dcReminder,dcHome]]){
    const env={...dotenv.parse(fs.readFileSync(file)),...process.env,SESSION_FILE:session,REMINDER_FILE:reminder,CODEX_HOME:home};
    const config=platform==='discord'?loadDiscordConfig(env):loadConfig(env);
    new SessionStore(config.sessionFile,config);
    new ReminderScheduler({filename:config.reminderFile,platform,userId:config.allowedUserId,calendarFile:config.calendarFile,send:async()=>{}});
    if(path.resolve(config.calendarFile)!==path.join(root,'china-calendar.json')){
      const name=platform+'-calendar-'+crypto.randomUUID()+'.json';
      fs.copyFileSync(config.calendarFile,path.join(backup,name),fs.constants.COPYFILE_EXCL);
    }
    fs.accessSync(config.workdir,fs.constants.R_OK|fs.constants.W_OK|fs.constants.X_OK);
    let threadId=null;
    for(const stage of ['fresh','resume']){
      const nonce=crypto.randomUUID();console.log(platform+': '+stage+' 模型预检');
      const result=await runCodex({bin:config.bin,workdir:config.workdir,env:config.env,model:config.defaultModel,
        threadId,outputSchema,timeoutMs:120000,onThread:id=>{threadId=id;},
        prompt:'不要使用工具，仅输出这个JSON对象：'+JSON.stringify({nonce,action:'chat',message:'ok',delivery:'current',entries:[]})},
        (bin,args,options)=>spawn(bin,[args[0],'--sandbox','read-only',...args.slice(1)],options));
      if(!result.ok)throw Error();
      const plan=parseResponse(result.text,{nonce,allowActions:false});
      if(plan.message!=='ok'||plan.delivery!=='current')throw Error();
    }
  }
  console.log('运行包、原状态和两个平台默认模型预检通过。');
})().catch(()=>{console.error('预检失败，未切换服务；检查路径、CLI、登录及模型兼容性。');process.exitCode=1;});
NODE
printf '%s\n' 'preflight-complete' >> "$BACKUP_DIR/events.log"
if [[ "$ACTION" == preflight ]]; then
  say "预检完成，未切换或重启服务。继续升级：bash upgrade-v1.6.0.sh upgrade --backup-dir '$BACKUP_DIR'"
  exit 0
fi
if systemctl show "$TG_UNIT" --property=ExecStart --value | grep -Fq -- "$RELEASE_DIR/index.js" &&
   systemctl show "$DC_UNIT" --property=ExecStart --value | grep -Fq -- "$RELEASE_DIR/discord.js"; then
  say "两个服务入口已指向 v1.6.0，预检通过；未新增覆盖项或重启。备份：$BACKUP_DIR"
  exit 0
fi

PHASE=verify-original-config
[[ "$(root systemctl cat "$TG_UNIT" | digest)" == "$(digest < "$BACKUP_DIR/telegram-systemd-before.txt")" ]]
[[ "$(root systemctl cat "$DC_UNIT" | digest)" == "$(digest < "$BACKUP_DIR/discord-systemd-before.txt")" ]]
basic_check
tg=$(tg_dropin); dc=$(dc_dropin)
root test ! -e "$tg"; root test ! -L "$tg"
root test ! -e "$dc"; root test ! -L "$dc"
make_stages > "$BACKUP_DIR/telegram-dropin.conf"
make_dc_stage > "$BACKUP_DIR/discord-dropin.conf"
PHASE=apply
APPLYING=1
root mkdir -p "/etc/systemd/system/$TG_UNIT.d" "/etc/systemd/system/$DC_UNIT.d"
root cp -n -- "$BACKUP_DIR/telegram-dropin.conf" "$tg"
root cp -n -- "$BACKUP_DIR/discord-dropin.conf" "$dc"
root test -f "$tg"; root test ! -L "$tg"
root test -f "$dc"; root test ! -L "$dc"
[[ "$(root cat -- "$tg" | digest)" == "$(make_stages | digest)" ]]
[[ "$(root cat -- "$dc" | digest)" == "$(make_dc_stage | digest)" ]]
printf '%s\n' 'applied' > "$BACKUP_DIR/applied"
root systemctl daemon-reload
systemctl show "$TG_UNIT" --property=ExecStart --value | grep -Fq -- "$RELEASE_DIR/index.js"
systemctl show "$DC_UNIT" --property=ExecStart --value | grep -Fq -- "$RELEASE_DIR/discord.js"
PHASE=restart
root systemctl restart "$TG_UNIT"
sleep 10
systemctl is-active --quiet "$TG_UNIT"
root systemctl restart "$DC_UNIT"
sleep 10
systemctl is-active --quiet "$DC_UNIT"
APPLYING=0
printf '%s\n' 'upgrade-complete' >> "$BACKUP_DIR/events.log"
say "两个服务已切换到 v1.6.0。备份：$BACKUP_DIR"
say '请在两个平台验收普通对话、上下文、提醒的实际发送、修改和取消；active 不代表投递已验证。'
say "回滚：bash upgrade-v1.6.0.sh rollback --backup-dir '$BACKUP_DIR'"
