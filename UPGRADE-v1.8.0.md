# Debian：TG 和 Discord 升级到 v1.8.0

本版提供内置 Node 的 amd64 (`linux-x64`) 和 arm64 (`linux-arm64`) 可执行程序。两个服务分别启动同一个程序的 `telegram`、`discord` 入口。配置、会话、提醒、Codex CLI、登录和工作区原地保留，不运行 `npm install`，不删除旧程序或系统 Node。

**升级及回滚均会依次重启 TG、Discord，可能中断模型任务。** 先在两个平台确认 `/status` 空闲，执行期间不发送新任务，避开提醒触发时间。以下命令由 Debian 操作者执行，默认账号 `codex`，项目 `/home/codex/codex-tg-bot`，服务 `codex-tg-bot.service`、`codex-discord-bot.service`。没有修改 Debian 服务器的自动操作。

## 核对原服务路径

仅在服务器本地查看，不要原样分享可能含令牌的 unit 或配置：

```bash
systemctl show codex-tg-bot.service codex-discord-bot.service -p User -p WorkingDirectory -p ExecStart
systemctl cat codex-tg-bot.service
systemctl cat codex-discord-bot.service
```

确认旧进程实际的 `SESSION_FILE`、`REMINDER_FILE`、`CODEX_HOME`、`WORKDIR` 和 Discord 配置路径。旧 Node 发布包的默认状态可能在旧版本目录下，不能改成新的空目录。下方变量必须填写旧进程的真实路径；两个会话和两个提醒路径必须彼此独立。保留原代理、模型、日历及其它 unit 环境。

预检终端须与原 unit 的额外 `Environment` / `EnvironmentFile` 设置一致。脚本不读取或执行 `.env` 内容，Bot 自己按原 dotenv 规则加载配置。如果 unit 在配置外覆盖 `WORKDIR`、代理、`CODEX_BIN` 等，先在终端按实际值设置对应变量，不输出敏感值。

## 下载、校验和升级两个服务

已有 `codex` sudo 权限时执行（已经是该账号则跳过第一条）：

```bash
sudo -iu codex
```

以下先下载脚本及校验表到独立目录，不会启动服务；查看脚本后执行。脚本自动选择 CPU 架构，下载对应包、校验 SHA256，解压到不存在的新版本目录。缺少既有工具时停止，不自动安装。

```bash
set -euo pipefail
umask 077
BOT_DIR=/home/codex/codex-tg-bot
mkdir -p "$BOT_DIR/.local-backups"
DOWNLOAD_DIR=$(mktemp -d "$BOT_DIR/.local-backups/download-v1.8.0-XXXXXXXX")
BASE_URL=https://github.com/rshun/codex-bot/releases/download/v1.8.0
curl --fail --location --retry 3 --output "$DOWNLOAD_DIR/upgrade-v1.8.0.sh" "$BASE_URL/upgrade-v1.8.0.sh"
curl --fail --location --retry 3 --output "$DOWNLOAD_DIR/SHA256SUMS" "$BASE_URL/SHA256SUMS"
( cd "$DOWNLOAD_DIR"; sha256sum --check --ignore-missing SHA256SUMS )
bash -n "$DOWNLOAD_DIR/upgrade-v1.8.0.sh"
less "$DOWNLOAD_DIR/upgrade-v1.8.0.sh"

# 必须等于旧进程实际使用的路径；有自定义路径时先修改这里。
export BOT_DIR
export DC_ENV="$BOT_DIR/.env.discord"
export TG_SESSION="$BOT_DIR/.bot-state/sessions.json"
export DC_SESSION="$BOT_DIR/.bot-state/discord-sessions.json"
export TG_REMINDER="$BOT_DIR/.bot-state/telegram-reminders.json"
export DC_REMINDER="$BOT_DIR/.bot-state/discord-reminders.json"
export TG_HOME=/home/codex/.codex
export DC_HOME=/home/codex/.codex
# 若旧v1.7.0程序不在默认版本目录，填写真实路径，以便回滚兼容性检查。
# export ROLLBACK_BIN=/实际旧程序目录/codex-bot

bash "$DOWNLOAD_DIR/upgrade-v1.8.0.sh" upgrade
```

路径须为绝对路径，仅接受字母、数字、下划线、点、斜线和连字符；其它字符需人工按 systemd 转义规则处理。脚本会核对服务账号、活动状态及原会话文件存在性。无需再次注册 Discord 命令。

脚本打印本次 `备份目录`，其中保留原配置、两个会话和提醒文件、完整 systemd 配置、原路径记录及新增覆盖项。原 `WORKDIR`、`CODEX_HOME`、自定义日历不移动或覆盖；若需完整灾备，应在空闲时另行按实际路径备份 Codex 历史、工作区和自定义日历，它们可能很大且包含私人信息。

程序解压到 `releases/codex-bot-v1.8.0-linux-x64/` 或 `linux-arm64/`，TG、Discord 仍为两个独立进程。只新增两个 `zzzzzz-codex-bot-v1.8.0.conf`，保留原 unit 和其它 drop-in；同名文件已存在就拒绝，不覆盖。`--check-config` 只读本地文件，不连接平台、不验证登录、不调用模型。脚本不自动回滚，任一步失败即停；安装覆盖后失败时不要重跑整段，按下节撤销本次覆盖。

## 升级后验证

```bash
systemctl is-active codex-tg-bot.service codex-discord-bot.service
systemctl show codex-tg-bot.service codex-discord-bot.service -p MainPID -p ExecStart
journalctl -u codex-tg-bot.service -u codex-discord-bot.service -n 80 --no-pager
```

日志只在服务器本地查看，分享前脱敏。在两个平台分别检查 `/status`、`/reminders`，继续原对话确认上下文，再各创建一个普通短期提醒确认真实送达。

TG 再测试“每天早上9点调用模型生成一句简短早安问候并发给我”（可替换为即将到来的时间）。回执应显示“触发时调用模型”、模型、生成要求和下一次时间。未要求调用模型的新提醒继续发送固定内容。查看/修改/取消可继续自然语言操作。后台生成会消耗额度，独立于日常聊天 `/usage`，每次生成最长60秒；失败记录在提醒列表，不发送生成提示词。详情见 [模型提醒说明](MODEL-REMINDERS.md)。

生成要求目标机 Codex CLI 支持只读沙箱、临时会话、结构化输出和禁用相关工具的选项；沿用原 provider/登录。配置或模型不兼容时本轮失败，不放宽权限。发布回归和本地真实CLI样例不替代目标机兼容性及平台送达验收。

## 回滚

**启用模型提醒后文件升为版本3，v1.7.0及更早程序无法读取。取消任务仍保留历史，不能因此直接降级。** 不把生成要求转成固定消息，不恢复升级前备份而丢弃新任务。需保留最新数据，先由维护者明确处理所有模型任务、历史及失败结果，或继续使用v1.8.0处理故障；本次不提供自动有损降级。

在尚未启用模型提醒、当前数据仍能被旧程序接受时，可运行以下撤销命令。它会先用保留的v1.7.0可执行程序对**当前**两平台配置和状态做只读检查；检查失败时不改服务、不重启。旧程序默认位于 `releases/codex-bot-v1.7.0-架构/codex-bot`，升级前可用 `ROLLBACK_BIN` 指定实际路径，值会存入备份记录。

```bash
# 替换为升级时打印的真实备份目录；须在原服务账号下执行。
BACKUP_DIR=/home/codex/codex-tg-bot/.local-backups/upgrade-v1.8.0-实际后缀
bash "$DOWNLOAD_DIR/upgrade-v1.8.0.sh" rollback "$BACKUP_DIR"
systemctl is-active codex-tg-bot.service codex-discord-bot.service
journalctl -u codex-tg-bot.service -u codex-discord-bot.service -n 80 --no-pager
```

另开终端时须把 `DOWNLOAD_DIR` 设为先前的脚本下载目录，也可使用可执行包内 `deploy/upgrade-v1.8.0.sh`。脚本不删除覆盖项，而是在保存副本后将本次覆盖改为只有 `[Service]`；原 unit 和其它 drop-in 重新生效。覆盖项若已被管理员修改或为符号链接则停止，不覆盖它。

回滚前再备份最新配置和状态，不恢复旧数据。原程序、原unit/drop-in及所需系统Node必须保留。原来使用Node包且没有旧可执行程序时，不能直接套用自动回滚；应先用原Node入口的只读预检验证当前数据兼容，再按 [可执行部署说明](deploy/EXECUTABLE.md) 人工撤销本次两个覆盖项。回滚后继续核对两平台上下文和提醒实际送达。
