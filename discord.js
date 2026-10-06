const fs = require("node:fs");
const path = require("node:path");
const { loadConfig, splitMessage, createMessageHandler } = require("./index");
const { SessionStore } = require("./session-store");
const { DiscordRest, DiscordGateway, DiscordError } = require("./discord-client");

const SNOWFLAKE = /^[1-9]\d{0,19}$/;
const COMMANDS = [
  { name: "codex", description: "继续当前 Codex 对话", options: [
    { type: 3, name: "task", description: "任务或问题", required: true, max_length: 4000 },
  ] },
  { name: "model", description: "查看或切换模型，保留上下文", options: [
    { type: 3, name: "name", description: "模型 ID；default 恢复默认", max_length: 128 },
  ] },
  { name: "new", description: "开始新对话，保留模型选择" },
  { name: "models", description: "查看模型白名单" },
  { name: "status", description: "查看会话和运行状态" },
  { name: "usage", description: "查看当前会话最近的 token 报告" },
  { name: "quota", description: "查询 Codex 账号额度和重置时间" },
  { name: "id", description: "查看自己的 Discord 用户 ID" },
  { name: "help", description: "查看 Bot 帮助" },
].map((command) => ({ type: 1, ...command }));

function loadDiscordConfig(env) {
  const config = loadConfig(env, { platform: "discord" });
  if (!SNOWFLAKE.test(config.allowedUserId)) throw new Error("DISCORD_ALLOWED_USER_ID 格式无效。");
  const channels = [...new Set((env.DISCORD_CHANNEL_IDS || "").split(",").map((id) => id.trim()).filter(Boolean))];
  if (channels.some((id) => !SNOWFLAKE.test(id))) throw new Error("DISCORD_CHANNEL_IDS 格式无效。");
  if (env.DISCORD_ALLOW_DMS && !["true", "false"].includes(env.DISCORD_ALLOW_DMS)) {
    throw new Error("DISCORD_ALLOW_DMS 必须为 true 或 false。");
  }
  if (config.timeoutMs > 600000) throw new Error("Discord CODEX_TIMEOUT_MS 不能超过 600000，以便在交互有效期内回复。");
  if (config.sessionFile === path.join(__dirname, ".bot-state", "sessions.json")) {
    throw new Error("Discord 不能使用 Telegram 默认状态文件。");
  }
  if (env.DISCORD_APPLICATION_ID && !SNOWFLAKE.test(env.DISCORD_APPLICATION_ID)) {
    throw new Error("DISCORD_APPLICATION_ID 格式无效。");
  }
  if (env.DISCORD_COMMAND_GUILD_ID && !SNOWFLAKE.test(env.DISCORD_COMMAND_GUILD_ID)) {
    throw new Error("DISCORD_COMMAND_GUILD_ID 格式无效。");
  }
  return { ...config, token: env.DISCORD_BOT_TOKEN, channels,
    allowDms: env.DISCORD_ALLOW_DMS !== "false", applicationId: env.DISCORD_APPLICATION_ID,
    commandGuildId: env.DISCORD_COMMAND_GUILD_ID };
}

function createDiscordTransport(rest) {
  const mentions = { parse: [], replied_user: false };
  return {
    async reply(msg, text) {
      for (const part of splitMessage(text, 1900)) {
        const body = { content: part, allowed_mentions: mentions };
        if (msg.interaction) {
          const { applicationId, token } = msg.interaction;
          const route = `/webhooks/${applicationId}/${encodeURIComponent(token)}`;
          if (!msg.responded) {
            await rest.request("PATCH", `${route}/messages/@original`, body);
            msg.responded = true;
          } else await rest.request("POST", route, { ...body, flags: 64 });
        } else {
          await rest.request("POST", `/channels/${msg.chat.id}/messages`, {
            ...body, message_reference: { message_id: msg.message_id, fail_if_not_exists: false },
          });
        }
      }
    },
    async markReceived(msg) {
      if (!msg.interaction) await rest.request("POST", `/channels/${msg.chat.id}/typing`);
    },
  };
}

function createDiscordDispatcher({ config, rest, handler, logger = console }) {
  let botId;
  let applicationId;
  const seen = new Set();
  const remember = (id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > 2000) seen.delete(seen.values().next().value);
    return true;
  };
  const permittedChannel = (data) => data.guild_id ? config.channels.includes(data.channel_id) : config.allowDms;
  const callback = (data, body) => rest.request("POST", `/interactions/${data.id}/${encodeURIComponent(data.token)}/callback`, body, { immediate: true });
  return async (type, data) => {
    if (type === "READY") {
      if (!SNOWFLAKE.test(data.user?.id) || !SNOWFLAKE.test(data.application?.id) || !data.user?.bot ||
          (config.applicationId && config.applicationId !== data.application.id)) {
        throw new DiscordError("identity");
      }
      botId = data.user.id;
      applicationId = data.application.id;
      return;
    }
    if (!botId) return;
    if (type === "MESSAGE_CREATE") {
      if (!SNOWFLAKE.test(data.id) || !SNOWFLAKE.test(data.channel_id) ||
          data.author?.bot || data.webhook_id || data.author?.id !== config.allowedUserId ||
          !permittedChannel(data) || typeof data.content !== "string" || !data.content.trim() || !remember(data.id)) return;
      let text = data.content.replace(new RegExp(`^<@!?${botId}>\\s*`), "");
      text = text.replace(/^!([a-z]+)(?=\s|$)/i, "/$1");
      const msg = { text, chat: { id: data.channel_id }, from: { id: data.author.id }, message_id: data.id };
      await handler(msg);
    } else if (type === "INTERACTION_CREATE") {
      if (data.type !== 2 || data.application_id !== applicationId || !SNOWFLAKE.test(data.id) ||
          !SNOWFLAKE.test(data.channel_id) || typeof data.token !== "string" ||
          !data.token.length || data.token.length > 1024 || /[\x00-\x20\x7f]/.test(data.token) || !remember(data.id)) return;
      const user = data.member?.user || data.user;
      const deny = (content) => callback(data, { type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } });
      if (user?.id !== config.allowedUserId) { await deny("未授权。"); return; }
      if (!permittedChannel(data)) { await deny("此频道或私聊未开放。"); return; }
      const name = data.data?.name;
      const definition = COMMANDS.find((command) => command.name === name);
      if (!definition) { await deny("未知命令。"); return; }
      const options = data.data.options || [];
      if (!Array.isArray(options) || options.length > 1 || options.some((option) => !option || option.type !== 3 ||
          typeof option.value !== "string" || !definition.options?.some((expected) =>
            expected.name === option.name && option.value.length <= expected.max_length))) {
        await deny("命令参数无效。"); return;
      }
      // Only launch work after Discord accepts the deferred acknowledgement.
      try { await callback(data, { type: 5, data: { flags: 64 } }); }
      catch { logger.error("Discord acknowledgement failed; task not started."); return; }
      await handler({ text: `/${name}${options.length ? ` ${options[0].value}` : ""}`,
        chat: { id: data.channel_id }, from: { id: user.id }, message_id: data.id,
        interaction: { applicationId, token: data.token } });
    }
  };
}

async function registerCommands(config, rest, { apply = false, backupRoot = path.join(__dirname, ".local-backups") } = {}) {
  if (!apply) return COMMANDS;
  if (!config.applicationId) throw new DiscordError("application_id_required");
  const identity = await rest.request("GET", "/applications/@me");
  if (identity?.id !== config.applicationId) throw new DiscordError("application_id_mismatch");
  const route = `/applications/${config.applicationId}${config.commandGuildId ? `/guilds/${config.commandGuildId}` : ""}/commands`;
  const current = await rest.request("GET", route);
  if (!Array.isArray(current)) throw new DiscordError("command_protocol");
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const filename = path.join(backupRoot, `discord-commands-${Date.now()}.json`);
  fs.writeFileSync(filename, JSON.stringify(current, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  // Individual upserts retain unrelated commands; the private backup precedes every update.
  for (const command of COMMANDS) await rest.request("POST", route, command);
  return { backup: filename, count: COMMANDS.length };
}

function loadDiscordEnvironment() {
  return require("dotenv").config({
    path: process.env.DISCORD_ENV_FILE || path.join(__dirname, ".env.discord"), quiet: true, debug: false,
  });
}

async function startDiscord() {
  if (typeof globalThis.WebSocket !== "function") throw new DiscordError("node_websocket_required");
  const config = loadDiscordConfig(process.env);
  const store = new SessionStore(config.sessionFile, config);
  const rest = new DiscordRest(config.token);
  const transport = createDiscordTransport(rest);
  const handler = createMessageHandler({ config, store, transport });
  const dispatch = createDiscordDispatcher({ config, rest, handler });
  const gateway = new DiscordGateway({ rest, token: config.token, onDispatch: dispatch,
    onFatal: () => { process.exitCode = 1; process.exit(1); } });
  await gateway.start();
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { gateway.stop(); process.exit(0); });
  return gateway;
}

async function main(args = process.argv.slice(2)) {
  if (args.some((arg) => !["--register-commands", "--apply", "--check-config"].includes(arg)) ||
      (args.includes("--apply") && !args.includes("--register-commands")) ||
      (args.includes("--check-config") && args.length !== 1)) throw new DiscordError("arguments");
  if (args.includes("--register-commands") && !args.includes("--apply")) {
    console.log(JSON.stringify(COMMANDS, null, 2));
    return;
  }
  loadDiscordEnvironment();
  if (args.includes("--check-config")) {
    const config = loadDiscordConfig(process.env);
    new SessionStore(config.sessionFile, config);
    if (typeof globalThis.WebSocket !== "function") throw new DiscordError("node_websocket_required");
    try { fs.accessSync(config.workdir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK); }
    catch { throw new DiscordError("working_directory"); }
    try {
      let parent = path.dirname(config.sessionFile);
      while (!fs.existsSync(parent)) parent = path.dirname(parent);
      fs.accessSync(parent, fs.constants.W_OK | fs.constants.X_OK);
      if (fs.existsSync(config.sessionFile)) fs.accessSync(config.sessionFile, fs.constants.R_OK | fs.constants.W_OK);
      if (path.isAbsolute(config.bin)) fs.accessSync(config.bin, fs.constants.X_OK);
    } catch { throw new DiscordError("local_permissions"); }
    console.log("Discord configuration and local paths checked; no network requests or state writes.");
  } else if (args.includes("--register-commands")) {
    const config = loadDiscordConfig(process.env);
    const result = await registerCommands(config, new DiscordRest(config.token), { apply: args.includes("--apply") });
    if (args.includes("--apply")) console.log(`Discord commands updated: ${result.count}; backup: ${result.backup}`);
    else console.log(JSON.stringify(result, null, 2));
  } else {
    if (args.length) throw new DiscordError("arguments");
    await startDiscord();
  }
}

if (require.main === module) main().catch((error) => {
  // Never log raw errors: third-party messages may contain tokens or request URLs.
  if (error instanceof DiscordError) console.error(`Discord startup failed: ${error.kind}${error.status ? ` (${error.status})` : ""}.`);
  else if (error.code === "MODULE_NOT_FOUND") console.error("Discord startup failed: dependency_missing.");
  else console.error("Discord startup failed; check runtime, dependencies and configuration.");
  process.exitCode = 1;
});

module.exports = { loadDiscordConfig, createDiscordTransport, createDiscordDispatcher,
  registerCommands, startDiscord, COMMANDS };
