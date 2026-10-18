# v1.7.0

TG 和 Discord 可以使用同一个 Debian 可执行程序分别启动，无需在服务器部署 JavaScript 源码或安装项目的 npm 依赖。程序内置 Node 运行时，Codex CLI 及登录状态仍单独保留；若现有 Codex 启动器依赖系统 Node，也应继续保留它。

- 提供 `linux-x64`（amd64）和 `linux-arm64` 可执行包，以及统一的 `SHA256SUMS`。
- 支持 `codex-bot telegram`、`codex-bot discord`、`--config-dir` 和无网络、无状态写入的 `--check-config`。
- 现有 `.env` / `.env.discord`、会话、模型选择和提醒状态格式继续兼容。迁移须沿用原 `SESSION_FILE`、`REMINDER_FILE`、`WORKDIR`、`CODEX_HOME`，不自动迁移或覆盖数据。
- 日历和提醒 schema 内置；schema 在需要时原子生成到会话状态目录，支持只读配置目录。
- GitHub 原生双架构构建，校验归档、文件清单和可执行权限，并在不含 Node/npm、关闭网络的 Debian 12 容器中验证两个入口与旧状态数据。

下载后先按 `uname -m` 选择架构并校验 SHA256。完整的双服务备份、预检、升级、验证与回滚命令见附件 `UPGRADE-v1.7.0.md`，或仓库中的同名文档。已有服务运行时，不要手动并行启动同平台的第二个进程。

升级会重启两个服务，可能中断当前模型任务。CI 验证不代表已完成用户服务器的升级、平台联网或真实提醒送达验收。
