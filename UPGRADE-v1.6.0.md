# Debian 升级到 v1.6.0

需要一次升级 TG 和 Discord 时，可使用后来新增的独立脚本 [deploy/upgrade-v1.6.0.sh](deploy/upgrade-v1.6.0.sh)，用法见 [脚本说明](deploy/UPGRADE-SCRIPT.md)。已发布的 v1.6.0 原运行包不包含此升级器；脚本单独上传，本文手动升级步骤仍有效。

本版将 TG、Discord 自然语言提醒统一为“当前 Codex 会话理解 → 结构化提案 → Bot 校验及保存 → 实际回执”，支持创建、查询、修改时间/内容及取消、追问补充和上下文指代。一次最多 8 条同类操作，全部校验后一次保存。不同措辞不再经过固定句式路由，但模型理解可能出错，应核对真实回执。调度仍只支持北京时间的单次、每天、中国大陆非工作日；每周/每月、其他时区、其他收件人、跨平台投递不支持。非工作日日历仍只内置 2026 年。

使用 Release 中的 **`codex-bot-v1.6.0-node.tar.gz`**，不要使用自动生成的 Source code 包。运行包包含锁定的 Node 依赖、语义模块、JSON Schema 和本文，无需拉源码或 npm 安装；没有新增 Node 依赖、必填配置或 Discord 斜杠命令。仍需 Node.js 22.4+、已登录 Codex CLI 和原服务账号。

**重要兼容条件：** Codex CLI 的 `exec` 和 `exec resume` 都必须支持 `--output-schema`，实际 provider/模型也须兼容。普通消息也使用此协议，不兼容会导致普通对话失败，不能只测提醒。本文不会自动安装或升级 CLI；预检失败时保持旧服务运行。自然语言现在消耗模型 token 并等待模型响应，同一会话忙碌时需等待；原生命令 `/remind`、`/reminders`、`/cancelreminder` 仍可在忙碌时使用，到点发送仍不调用模型。

以下命令由操作者在 Debian 手动执行，本地发布不代表服务器已经升级。重启会短暂中断所选平台，并终止正在运行的 Codex 任务；先通过 `/status` 确认空闲，避开提醒发送时间。每一步成功才继续，失败就停止，两个平台分别升级和验收。

## 1. 核对实际路径及 CLI

以实际服务账号操作，下列示例按原目录和 TG 编写。变量在同一 Bash 会话中保留，按实际 unit、drop-in、`.env` 核对并替换，环境变量优先于 dotenv。不要把可能含凭据的服务配置输出贴到聊天。

```bash
BOT_DIR=/home/codex/codex-tg-bot
BOT_UNIT=codex-tg-bot.service
BOT_PLATFORM=telegram
BOT_ENV="$BOT_DIR/.env"
SESSION_STATE="$BOT_DIR/.bot-state/sessions.json"
REMINDER_STATE="$BOT_DIR/.bot-state/telegram-reminders.json"
CODEX_HOME_DIR=/home/codex/.codex
CODEX_BIN=/home/codex/.local/bin/codex
# 自定义 HOLIDAY_CALENDAR_FILE 时填写实际绝对路径，否则留空。
CUSTOM_CALENDAR=

node --version
command -v curl tar sha256sum
systemctl is-active "$BOT_UNIT"
systemctl show "$BOT_UNIT" --property=User,Group,WorkingDirectory,FragmentPath,DropInPaths
df -h "$BOT_DIR"
"$CODEX_BIN" exec --help
"$CODEX_BIN" exec resume --help
```

确认两个帮助都有 `--output-schema`，并记录原 `ExecStart`、Node 路径、Codex 模型、代理、沙箱及全部生效 drop-in。服务账号必须和当前操作账号一致，或切换到它再继续。若 systemd 中另有 provider 环境、`CODEX_MODEL`、`WORKDIR` 等覆盖，后面的 CLI 预检也必须使用相同环境；不要通过 `source .env` 执行配置内容。

升级 Discord 时改用它自己的变量，不能共用 TG 状态：

```bash
BOT_UNIT=codex-discord-bot.service
BOT_PLATFORM=discord
BOT_ENV="$BOT_DIR/.env.discord"
SESSION_STATE="$BOT_DIR/.bot-state/discord-sessions.json"
REMINDER_STATE="$BOT_DIR/.bot-state/discord-reminders.json"
```

## 2. 备份配置、状态、历史和入口

原配置与 Codex 历史备份可能包含凭据，仅存放在私有目录。先确认空间及历史备份可用，已有可信快照也可替代历史复制；不要以空目录代替备份。原提醒可能在备份期间继续变化，此备份用于保全，回滚不能拿它覆盖升级后最新的发送结果。

```bash
umask 077
UNIT_FILE=$(systemctl show "$BOT_UNIT" --property=FragmentPath --value)
BACKUP_DIR="$BOT_DIR/.local-backups/v1.6.0-$(date +%Y%m%d-%H%M%S)"
(
  set -eu
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
)
```

括号内任一步失败都会退出该块，不再执行后续命令。若有实际生效的 drop-in，继续前必须逐一复制到备份目录的不同文件并记录原路径；不能只备份主 unit。保留原运行目录作为回滚入口，不删除任何文件。配置、备份、状态及登录数据不能上传仓库。

## 3. 下载、校验和解压

```bash
PACKAGE_DIR="$BACKUP_DIR/download"
RELEASE_DIR="$BOT_DIR/releases/codex-bot-v1.6.0"
(
  set -eu
  test -d "$BACKUP_DIR"
  test ! -e "$PACKAGE_DIR"
  test ! -e "$RELEASE_DIR"
  mkdir -p "$PACKAGE_DIR"
  cd "$PACKAGE_DIR"
  curl -fL -o codex-bot-v1.6.0-node.tar.gz https://github.com/rshun/codex-bot/releases/download/v1.6.0/codex-bot-v1.6.0-node.tar.gz
  curl -fL -o SHA256SUMS https://github.com/rshun/codex-bot/releases/download/v1.6.0/SHA256SUMS
  sha256sum --check SHA256SUMS
  tar -tzf codex-bot-v1.6.0-node.tar.gz
  mkdir -p "$BOT_DIR/releases"
  tar -xzf codex-bot-v1.6.0-node.tar.gz -C "$BOT_DIR/releases"
  node --check "$RELEASE_DIR/index.js"
  node --check "$RELEASE_DIR/discord.js"
  node --check "$RELEASE_DIR/semantic-reminders.js"
)
```

只有 SHA-256 校验通过才能解压；版本目录已存在时停止，不覆盖。用清单校验包内文件及版本：

```bash
node - "$RELEASE_DIR" <<'NODE'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const root = path.resolve(process.argv[2]);
const manifest = require(path.join(root, 'release-manifest.json'));
if (manifest.version !== '1.6.0' || manifest.developmentBuild) throw new Error('Wrong release');
for (const [file, expected] of Object.entries(manifest.files)) {
  const target = path.resolve(root, file);
  if (!target.startsWith(root + path.sep)) throw new Error('Invalid manifest path');
  const actual = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  if (actual !== expected) throw new Error('File checksum mismatch');
}
require(path.join(root, 'reminder-response.schema.json'));
console.log('Release manifest and schema OK');
NODE
```

## 4. 切换前验证实际 CLI/provider

先在服务器本地核对真实配置、稳定 `SESSION_FILE` / `REMINDER_FILE` 路径和自定义日历可读，原服务运行时不启动第二个 polling/Gateway 进程。Discord 可先只读检查配置：

```bash
DISCORD_ENV_FILE="$BOT_ENV" SESSION_FILE="$SESSION_STATE" REMINDER_FILE="$REMINDER_STATE" node "$RELEASE_DIR/discord.js" --check-config
```

下面以服务账号及同一环境发起两次合成模型请求，验证首次和恢复会话的结构化输出，会消耗少量模型额度并在 `CODEX_HOME` 留下独立测试会话。它不启动消息平台连接、不写 Bot 会话/提醒状态、不发送消息；测试使用只读沙箱，但沿用服务账号已有 Codex 配置。不要把测试结果等同于 TG/Discord 投递成功。命令失败时保持旧入口，不继续重启。

```bash
CODEX_HOME="$CODEX_HOME_DIR" CODEX_BIN="$CODEX_BIN" SESSION_FILE="$SESSION_STATE" REMINDER_FILE="$REMINDER_STATE" node - "$RELEASE_DIR" "$BOT_ENV" "$BOT_PLATFORM" <<'NODE'
const path = require('node:path'), { spawn } = require('node:child_process');
const root = process.argv[2];
require(path.join(root, 'node_modules/dotenv')).config({ path: process.argv[3], quiet: true });
const { runCodex } = require(path.join(root, 'codex-runner'));
const { outputSchema } = require(path.join(root, 'semantic-reminders'));
const discord = process.argv[4] === 'discord';
const config = discord ? require(path.join(root, 'discord')).loadDiscordConfig(process.env)
  : require(path.join(root, 'index')).loadConfig(process.env);
let threadId = null;
(async () => {
  for (const nonce of ['upgrade-fresh', 'upgrade-resume']) {
    const result = await runCodex({ bin: config.bin, workdir: config.workdir,
      env: { ...config.env, CODEX_HOME: config.codexHome }, model: config.defaultModel,
      threadId, outputSchema, timeoutMs: 120000, onThread: id => { threadId = id; },
      prompt: '不要使用工具，只输出符合 schema 的 JSON。nonce=' + nonce +
        '，action=chat，message=ok，delivery=current，entries=[]。' },
      (bin, args, options) => spawn(bin, [args[0], '--sandbox', 'read-only', ...args.slice(1)], options));
    if (!result.ok) throw new Error('CLI preflight failed');
    const data = JSON.parse(result.text);
    if (data.nonce !== nonce || data.action !== 'chat' || data.message !== 'ok' ||
        data.delivery !== 'current' || !Array.isArray(data.entries) || data.entries.length) throw new Error('Invalid structured response');
  }
  console.log('CLI structured fresh/resume preflight OK');
})().catch(() => { console.error('CLI preflight failed; keep the previous service entry.'); process.exitCode = 1; });
NODE
```

平台由前面设置的 `BOT_PLATFORM` 选择。配置解析错误也不要转贴可能含私有环境的输出。若多个会话使用不同 `/model` 覆盖，还应验证这些模型是否支持 schema。此预检不证明受 systemd 沙箱约束的整个服务环境已可用，重启后仍需验收。

## 5. 切换所选服务入口并验收

只编辑第 2 节已备份、实际控制入口的 unit 或 drop-in，不整份覆盖配置。例如主 unit 是 `/etc/systemd/system/codex-tg-bot.service` 时使用 `sudoedit /etc/systemd/system/codex-tg-bot.service`。沿用原账号、Node 路径、代理、工作目录和沙箱；仅切换运行文件，并固定原状态路径：

```ini
[Service]
WorkingDirectory=/home/codex/codex-tg-bot
ExecStart=/usr/bin/node /home/codex/codex-tg-bot/releases/codex-bot-v1.6.0/index.js
Environment=SESSION_FILE=/home/codex/codex-tg-bot/.bot-state/sessions.json
Environment=REMINDER_FILE=/home/codex/codex-tg-bot/.bot-state/telegram-reminders.json
```

TG 的 `WorkingDirectory` 继续指向原 `.env` 所在目录。Discord 则使用 `discord.js`，固定原 `DISCORD_ENV_FILE` 和独立的 Discord 状态路径。若通过 drop-in 覆盖入口，先写一行空 `ExecStart=`，再写新入口；直接编辑完整 unit 时替换原行，不保留两个入口。不覆盖真实 `.env`，不改变稳定 `WORKDIR`、`CODEX_HOME` 或自定义日历路径，不扩大权限。

确认空闲且前面检查全部成功后，由操作者重启所选服务；只升级 TG 不需要重启 Discord：

```bash
sudo systemctl daemon-reload
sudo systemctl restart "$BOT_UNIT"
systemctl is-active "$BOT_UNIT"
journalctl -u "$BOT_UNIT" -n 50 --no-pager
```

在授权私聊逐项验证，使用未来几分钟的北京时间，核对成功回执和任务 ID，避免重复创建：

1. 普通对话、连续上下文、`/model` 切换、`/usage` 和 `/quota` 仍正常。
2. 用不同语序创建一次性及每天提醒，确认实际收到一次。自然语言与普通消息本轮共用一次模型调用。
3. 先说“每天提醒我喝水”，补充明确时间；收到追问前没有新任务，补充后只创建一次。
4. 唯一目标下用“把刚才那个改到……”修改时间/内容，再“取消刚才那个”。通过 `/reminders` 核对实际状态及 ID；多个候选时应先询问，不擅自挑选。
5. 测试引用、否定、解释和 `/codex` 讨论，不创建/修改/取消任务；不支持的规则或其他投递目标应说明限制。
6. 测试非工作日多时间点及未知年份处理。已有 2026 年规则继续生效，调休工作日不发送；日历不覆盖时暂停该类任务，不猜测。
7. 在受控重启后确认已有任务及会话继续有效；测试任务验收完逐一按 ID 取消，核对不再发送。忙碌时用原生命令查询管理，自然语言需等待上一轮结束。

日志、CI、发布成功都不能替代 Debian 实际收到消息。调度每 5 秒检查一次，网络可能延迟；发送结果不确定时不自动重试，先核对私聊记录。模型返回异常、持久化失败或任务状态在处理期间变化时不执行该轮提案。若显示回执上下文保存失败但任务已保存，先用 `/reminders` 检查，不能直接重复创建。

## 6. 回滚

推荐回滚到 v1.5.0，它可直接读取 v1.6.0 最新的单次/每天/非工作日提醒状态，无需导出兼容副本。会话文件仍为版本 1，可选 `reminderReceipt` 字段可被旧版忽略，旧版下次保存可能清除该回执，但会话 ID、模型和提醒仍保留。自然语言恢复旧版有限句式。

回滚前同样确认空闲，另行备份当前 unit、全部相关 drop-in、配置及最新会话/提醒文件。核对原入口目录仍存在。只恢复本次实际修改的入口配置，不恢复升级前旧状态；否则会丢失新任务、修改和发送结果，可能重复发送。

下面仅适用于只修改完整 unit、未修改任何 drop-in 的情况，`BACKUP_DIR` 与 `UNIT_FILE` 必须确认是本次备份及正确原路径。恢复会覆盖 unit 并在重启时中断所选平台：

```bash
sudo cp -p -- "$BACKUP_DIR/unit-original.service" "$UNIT_FILE"
sudo systemctl daemon-reload
sudo systemctl restart "$BOT_UNIT"
systemctl is-active "$BOT_UNIT"
journalctl -u "$BOT_UNIT" -n 50 --no-pager
```

有 drop-in 时按记录恢复实际改过的对应文件，不能只恢复主 unit。保留新旧版本目录、备份、完整状态和 Codex 历史，不删除文件。若回滚到 v1.4.0 或更早版本，提醒版本 2 的非工作日兼容限制仍适用，必须先按 [日历说明](HOLIDAY-CALENDAR.md#状态兼容和降级) 进行独立兼容导出，不能直接复用新版提醒文件。
