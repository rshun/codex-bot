# Debian 可执行程序部署

本项目支持把 TG、Discord、JavaScript 依赖和 Node.js 运行时打包成同一个 `codex-bot`。两个进程分别运行 `telegram` 和 `discord`；服务器运行 Bot 时不需要项目源码、`node_modules` 或系统 Node。Codex CLI 仍需单独安装、登录，并保留原 `CODEX_BIN`、`WORKDIR`、`CODEX_HOME`。

可执行文件内仍含 JavaScript，打包不提供源码加密承诺。Linux 包依赖系统的 glibc、libstdc++ 等 Node 所需基础库，不是完全静态文件。发布前须在目标 Debian/CPU 架构验证；`linux-x64` 对应 `uname -m` 的 `x86_64`，`linux-arm64` 对应 `aarch64`。

## 启动和检查

程序路径可以位于版本目录，配置目录保持为原来的项目目录，本地和服务器目录都不用改名：

```bash
# 将路径替换成实际解压目录；此处不修改服务。
BOT_DIR=/home/codex/codex-tg-bot
BIN=/home/codex/codex-tg-bot/releases/实际版本目录/codex-bot

"$BIN" --version
"$BIN" --help
"$BIN" telegram --config-dir "$BOT_DIR" --check-config
"$BIN" discord --config-dir "$BOT_DIR" --check-config
```

检查只读取配置、会话、提醒、日历和本地权限，不连接平台、不调用模型、不写状态。它不能证明令牌、Codex 登录或网络可用。现有状态格式不迁移、不清空；状态损坏或 `WORKDIR`/`CODEX_HOME` 不匹配时拒绝运行。

调试启动命令如下。已有 systemd 实例运行时不要同时启动同平台的第二个实例，否则可能重复消费消息或写同一份状态。

```bash
"$BIN" telegram --config-dir "$BOT_DIR"
# Discord 在另一终端运行，或只启动需要调试的平台。
"$BIN" discord --config-dir "$BOT_DIR"
```

`--config-dir` 默认为当前工作目录；该目录须已存在。Telegram 读取其中的 `.env`；Discord 读取 `DISCORD_ENV_FILE` 指定文件，否则读取该目录的 `.env.discord`。程序会把工作目录切到配置目录，因此配置中的相对路径也以此为基准。环境变量仍优先于 dotenv 文件。

默认状态路径为配置目录下 `.bot-state/sessions.json`、`.bot-state/discord-sessions.json`，对应提醒文件为同目录 `telegram-reminders.json`、`discord-reminders.json`。**迁移时必须核实旧实例实际使用的路径，并沿用原 `SESSION_FILE`、`REMINDER_FILE`，不能仅凭默认值推断。** 特别是旧 Node 发布包可能默认把状态写在旧版本目录下。

内置日历保留现有覆盖年份；配置 `HOLIDAY_CALENDAR_FILE` 时优先读取原自定义日历。无该配置时不需要外置日历文件。提醒 JSON Schema 已内置，在第一次模型对话时才写入会话状态文件所在目录的 `runtime-assets/<内容哈希>/`，供外部 Codex CLI 读取。默认位于配置目录的 `.bot-state/`，自定义状态目录也可继续使用，配置目录本身可以只读。这不改变会话或提醒格式，不会覆盖已有不同内容的 schema；资产目录需要当前服务用户可写。两个进程同时首次使用时原子发布 schema，保留小型公开临时资产，不自动删除。只读检查不会生成这些文件。

Discord 命令注册继续支持预览和显式应用；日常升级不必重新注册：

```bash
"$BIN" discord --config-dir "$BOT_DIR" --register-commands
# 需要更新命令时，确认预览后才执行；会先备份原命令。
"$BIN" discord --config-dir "$BOT_DIR" --register-commands --apply
```

## 从现有服务迁移

本节命令由 Debian 操作者执行。升级会重启 TG、Discord，可能中断正在运行的模型任务，并短暂无法接收消息。先确认两个 Bot 空闲，保留旧程序、旧 systemd 配置及当前数据；不覆盖 `.env`、不安装依赖、不删除旧目录。

1. 用 `uname -m` 确认架构，从正式 Release 下载对应可执行包与 `SHA256SUMS`。本地 `-dev` 构建仅用于验证，不视为正式发布。若尚无可执行 Release，应先完成构建和目标机验证。
2. 核对当前服务账户、`WorkingDirectory`、所有 unit/drop-in、状态文件路径及 `CODEX_HOME`。`systemctl cat` 可能包含敏感信息，只在服务器本地查看，禁止原样贴到聊天。
3. 备份配置、状态、自定义日历、完整服务配置及 Codex 历史。保持原服务账户执行下列备份，备份可能含令牌和对话，权限限制为当前用户；备份期间应无正在写入的任务。

```bash
BOT_DIR=/home/codex/codex-tg-bot
BACKUP_DIR="$BOT_DIR/.local-backups/executable-$(date +%Y%m%d-%H%M%S)"
umask 077
mkdir -p -- "$BACKUP_DIR"
cp -a -- "$BOT_DIR/.env" "$BOT_DIR/.env.discord" "$BACKUP_DIR/"
systemctl cat codex-tg-bot.service > "$BACKUP_DIR/tg-systemd.txt"
systemctl cat codex-discord-bot.service > "$BACKUP_DIR/discord-systemd.txt"
if [ -d "$BOT_DIR/.bot-state" ]; then
  cp -a -- "$BOT_DIR/.bot-state" "$BACKUP_DIR/bot-state"
fi
# 如果状态、自定义日历、CODEX_HOME 不在以上目录，按实际绝对路径另行 cp -a 备份。
# 这里不能假定两个服务都使用 $HOME/.codex，应先核实真实 CODEX_HOME。
```

4. 校验下载包，解压到新的版本目录。先列出归档内容，确认只有预期的程序、示例、许可和说明；不要解压覆盖原配置目录。以下变量必须替换成实际下载路径和包内顶层目录名。

```bash
DOWNLOAD_DIR=/实际下载目录
RELEASE_NAME=实际包内顶层目录名
cd "$DOWNLOAD_DIR"
sha256sum -c SHA256SUMS
tar -tzf "$RELEASE_NAME.tar.gz"
test ! -e "$BOT_DIR/releases/$RELEASE_NAME"
mkdir -p -- "$BOT_DIR/releases"
tar -xzf "$RELEASE_NAME.tar.gz" -C "$BOT_DIR/releases"
BIN="$BOT_DIR/releases/$RELEASE_NAME/codex-bot"
test -x "$BIN"
"$BIN" --version
"$BIN" telegram --config-dir "$BOT_DIR" --check-config
"$BIN" discord --config-dir "$BOT_DIR" --check-config
```

每条失败都停止，不重启。终端检查环境须与 systemd 的额外 `Environment`/`EnvironmentFile` 保持一致。若原状态路径由 unit 指定，先在终端以相同值运行检查。

5. 包内 `deploy/*.service.example` 仅作参考，**不要直接覆盖已有 unit**。保留原账户、权限、安全限制和环境设置，只新增覆盖 `ExecStart` 的 drop-in。若已有同名覆盖文件，先单独备份并核对，避免覆盖。示例通过 `sudoedit` 人工写入，实际程序路径必须替换。

```bash
sudo mkdir -p /etc/systemd/system/codex-tg-bot.service.d
sudo mkdir -p /etc/systemd/system/codex-discord-bot.service.d
sudoedit /etc/systemd/system/codex-tg-bot.service.d/zzzz-codex-executable.conf
```

TG 文件内容：

```ini
[Service]
ExecStart=
ExecStart=/home/codex/codex-tg-bot/releases/实际版本目录/codex-bot telegram --config-dir /home/codex/codex-tg-bot
# 若原来未明确配置状态路径，在此按核实后的旧路径设置，不能改为新的空文件。
# Environment=SESSION_FILE=/实际旧会话文件绝对路径
# Environment=REMINDER_FILE=/实际旧提醒文件绝对路径
```

```bash
sudoedit /etc/systemd/system/codex-discord-bot.service.d/zzzz-codex-executable.conf
```

Discord 文件内容：

```ini
[Service]
ExecStart=
ExecStart=/home/codex/codex-tg-bot/releases/实际版本目录/codex-bot discord --config-dir /home/codex/codex-tg-bot
# 同样保留原 DISCORD_ENV_FILE、SESSION_FILE、REMINDER_FILE、WORKDIR、CODEX_HOME。
```

6. 确认覆盖项优先级、实际 `ExecStart` 与两个状态路径正确后，操作者再重启。两个平台按顺序验证；任一步失败先排查或回滚。

```bash
sudo systemctl daemon-reload
systemctl show codex-tg-bot.service codex-discord-bot.service -p ExecStart
sudo systemctl restart codex-tg-bot.service
systemctl is-active codex-tg-bot.service
sudo systemctl restart codex-discord-bot.service
systemctl is-active codex-discord-bot.service
journalctl -u codex-tg-bot.service -u codex-discord-bot.service -n 60 --no-pager
```

在两个平台分别检查 `/status`、`/reminders`，确认旧模型、会话和提醒仍在。继续旧对话以验证上下文，设置一个短期测试提醒并确认实际送达。`active` 和离线检查都不能代替平台验收。新程序默认使用内置日历，不依赖旧源码文件。

## 回滚

保留旧 Node 运行时、旧程序及所有原 drop-in，便于恢复。先备份升级后最新会话和提醒，以及本次新增的两个覆盖文件；**不要用升级前的数据覆盖现在的数据**。

如果本次仅新增了上述两个文件，用 `sudoedit` 把这两个文件的内容分别改为仅一行 `[Service]`，不删除文件。这样撤销的是本次 `ExecStart` 覆盖，原 unit 和其它覆盖项重新生效。若本次修改了已有文件，则根据备份恢复其原内容，并保留修改后的副本。随后核对有效启动命令并由操作者重启：

```bash
sudo systemctl daemon-reload
systemctl show codex-tg-bot.service codex-discord-bot.service -p ExecStart
sudo systemctl restart codex-tg-bot.service
systemctl is-active codex-tg-bot.service
sudo systemctl restart codex-discord-bot.service
systemctl is-active codex-discord-bot.service
```

回滚到同一状态格式的 v1.6.0 Node 包不需要转换数据。更早版本的日历提醒兼容性需另行核实。现有 `upgrade-v1.6.0.sh` 是固定 SHA 的 **Node 发布包升级器**，不会自动升级为可执行版本，不能拿它安装可执行包。

## 构建

### GitHub Actions（本项目采用）

工作流为 [build-executable.yml](../.github/workflows/build-executable.yml)。推送 `codex/debian-executable` 分支会自动构建；版本标签推送和手动 `workflow_dispatch` 也支持。只有当该工作流已经进入默认分支后，GitHub 才会显示相应手动运行入口。默认只生成 Actions artifacts；在版本标签上手动运行并明确勾选 `publish_release` 时，才验证标签/版本/源提交与包内全部哈希、创建草稿、下载比对附件并发布 GitHub Release。工作流不部署服务器。

两个原生 runner 分别构建 `linux-x64`、`linux-arm64`，临时安装锁定的现有运行依赖及隔离构建工具，运行完整回归，验证归档校验值，再运行提取后的程序。另用固定镜像摘要的 Debian 12 容器检查两个平台入口：镜像含系统基础库，不含 Node/npm；校验时关闭网络、使用只读系统，并以测试数据所有者的 UID/GID 读取合成的旧配置、会话、v2 提醒。检查前后对比数据字节，不接入真实 Bot 或模型。所有安装只发生在 GitHub 临时 runner 中。

在仓库 Actions 的 **Build Debian executables** 成功运行页面，下载 `codex-bot-linux-x64` 或 `codex-bot-linux-arm64` artifact。GitHub 下载的是 ZIP，解开后有运行包 `.tar.gz` 和 `SHA256SUMS`；再按本文校验和部署。Artifacts 保留 30 天，长期下载入口需后续正式发布到 Release。

开发分支产物标记 `-dev.<commit>`。只有干净工作区、包版本和当前提交的 `v<版本>` 标签一致时才标记正式版；本次构建不会替换已有 v1.6.0 Release。原生构建及容器验证成功仍不代表已在用户 Debian 上完成网络、上下文和提醒实际送达验收。

### 本机构建（可选）

运行依赖和 `package-lock.json` 不变。构建工具隔离在忽略目录 `.local-build-tools/`，不进入发布包。**按项目规范，以下安装命令需先获得用户确认，由用户执行或明确授权代理执行；脚本自身不会自动安装或下载任何工具。**

```bash
# 仅在构建机执行，Node 版本必须为 24.19.0；不要在生产服务目录安装。
npm install --prefix .local-build-tools --no-audit --no-fund --save-exact esbuild@0.28.2 postject@1.0.0-alpha.6
# 项目原有锁定依赖也必须已经就绪；如需恢复，同样应先获得确认。
node scripts/build-executable.js --target linux-x64 --tools .local-build-tools
```

建议在 Linux 对应架构本机构建，这会自动运行无网络的版本、帮助、Discord 命令预览冒烟检查。Windows 本机可构建 `--target win32-x64` 用于验证，同一构建脚本也支持跨平台生成 Linux 包：

```text
node scripts/build-executable.js --target linux-x64 --tools .local-build-tools --node-binary /下载并校验的/node-v24.19.0-linux-x64/bin/node --node-sha256 该node文件的64位SHA256
```

目标 Node 必须来自官方同版本发行包。先用官方 `SHASUMS256.txt` 校验完整 Node 归档，再对解压后的 `bin/node` 计算 SHA256 传给构建器；归档 SHA 与单独 node 文件 SHA 不相同。目标归档中的 `LICENSE` 必须保留。工具会检查文件校验值、ELF/PE 架构和版本标识，不会联网获取目标 Node。SEA 使用 `useSnapshot=false`、`useCodeCache=false`，遵循官方跨平台规则；跨构建不能运行目标文件，会在清单中标注 `nativeSmokeTested=false`，仍须在目标 Debian 上验证。

有未提交改动时，构建默认拒绝运行；可用 `--allow-dirty` 生成测试包。`--output` 可指定仓库内尚不存在的目录，已有输出不覆盖。构建失败也保留 staging 供检查，不自动删除。归档显式保留程序的 Linux `0755` 执行权限。产物含可执行文件、配置示例、两份 systemd 示例、许可、部署说明、版本/架构/源提交/依赖和文件哈希清单，以及归档的 `SHA256SUMS`。不会包含真实配置、状态、Codex 认证、构建工具、源码目录或 `node_modules` 目录。

本机构建后可令 `CODEX_BOT_TEST_EXECUTABLE` 指向实际程序，再运行 `node --test test/executable.test.js`，重复无网络的配置、会话和提醒兼容性检查；测试机仍需 Node 来运行测试框架，部署机器运行程序本身不需要。

参考：[Node.js SEA](https://nodejs.org/download/release/v24.19.0/docs/api/single-executable-applications.html)、[esbuild](https://esbuild.github.io/api/#bundle)、[postject](https://github.com/nodejs/postject)。
