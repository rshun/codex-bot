const path = require("node:path");
const os = require("node:os");
const { dataDirectory, defaultCalendarFile, checkLocalPaths } = require("./runtime-paths");
const { SessionStore, MODEL_NAME } = require("./session-store");
const { runCodex } = require("./codex-runner");
const { formatUsage } = require("./usage");
const { queryQuota, formatQuota } = require("./quota");
const { ReminderScheduler } = require("./reminders");
const { prepareTurn, parseResponse, applyResponse } = require("./semantic-reminders");
const { createReminderGenerator } = require("./reminder-generation");

function loadConfig(env, { platform = "telegram" } = {}) {
  if (!["telegram", "discord"].includes(platform)) throw new Error("无效的平台配置。");
  const tokenField = platform === "discord" ? "DISCORD_BOT_TOKEN" : "TELEGRAM_BOT_TOKEN";
  const userField = platform === "discord" ? "DISCORD_ALLOWED_USER_ID" : "ALLOWED_USER_ID";
  if (!env[tokenField] || env[tokenField].includes("这里换成") || env[tokenField].startsWith("your_")) {
    throw new Error(`请配置 ${tokenField}。`);
  }
  if (!/^[1-9]\d*$/.test(env[userField] || "")) {
    throw new Error(`请配置有效的 ${userField}；Bot 不允许匿名开放执行。`);
  }
  const defaultModel = env.CODEX_MODEL?.trim() || null;
  const models = [...new Set((env.CODEX_MODELS || "").split(",").map((value) => value.trim()).filter(Boolean))];
  if ((defaultModel && !MODEL_NAME.test(defaultModel)) || models.some((model) => !MODEL_NAME.test(model))) {
    throw new Error("CODEX_MODEL 或 CODEX_MODELS 的模型名称格式无效。");
  }
  if (models.length && defaultModel && !models.includes(defaultModel)) {
    throw new Error("CODEX_MODEL 必须包含在 CODEX_MODELS 中。");
  }
  const timeoutMs = Number(env.CODEX_TIMEOUT_MS || 120000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000) {
    throw new Error("CODEX_TIMEOUT_MS 必须为 1000 到 3600000 的整数。");
  }
  const sessionFile = path.resolve(env.SESSION_FILE || path.join(dataDirectory(), ".bot-state",
    platform === "discord" ? "discord-sessions.json" : "sessions.json"));
  const reminderFile = path.resolve(env.REMINDER_FILE || path.join(path.dirname(sessionFile), `${platform}-reminders.json`));
  const sameStateFile = process.platform === "win32" ? reminderFile.toLowerCase() === sessionFile.toLowerCase() : reminderFile === sessionFile;
  if (sameStateFile) throw new Error("REMINDER_FILE 不能与 SESSION_FILE 相同。");
  return {
    platform, allowedUserId: env[userField],
    bin: env.CODEX_BIN || "/home/codex/.local/bin/codex",
    workdir: path.resolve(env.WORKDIR || (platform === "discord" ? "/home/codex/discord-workdir" : "/home/codex")),
    codexHome: path.resolve(env.CODEX_HOME || path.join(os.homedir(), ".codex")),
    sessionFile, reminderFile, calendarFile: env.HOLIDAY_CALENDAR_FILE ? path.resolve(env.HOLIDAY_CALENDAR_FILE) : defaultCalendarFile(),
    defaultModel, models, timeoutMs, env,
  };
}

function splitMessage(text, maxLength = 3500) {
  if (!Number.isInteger(maxLength) || maxLength < 2) throw new Error("Invalid message chunk length");
  const chunks = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + maxLength, text.length);
    // Telegram text must not contain a split UTF-16 surrogate pair.
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function createRedactor(env) {
  const secrets = Object.entries(env)
    .filter(([key, value]) => /token|password|passwd|secret|api[_-]?key|authorization|cookie|credential|private[_-]?key/i.test(key) &&
      typeof value === "string" && value.length >= 6)
    .map(([, value]) => value).sort((a, b) => b.length - a.length);
  return (text) => {
    for (const secret of secrets) text = text.split(secret).join("[REDACTED]");
    return text
      .replace(/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]")
      .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED BOT TOKEN]")
      .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED KEY]")
      .replace(/\bBearer\s+[A-Za-z0-9_.-]{16,}/gi, "Bearer [REDACTED]")
      .replace(/(\b[A-Za-z0-9_.-]*(?:token|password|passwd|pwd|secret|api[_-]?key|access[_-]?key|authorization|cookie|credential|private[_-]?key)[A-Za-z0-9_.-]*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, "$1[REDACTED]")
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
  };
}

function createMessageHandler({ bot, store, config, botUsername = "", runner = runCodex,
                                quotaReader = queryQuota, transport, reminders, logger = console }) {
  const busy = new Set();
  const stateFailures = new Set();
  let quotaRequest;
  const redact = createRedactor(config.env);
  const help = [
    "Codex Bot 已启动，直接发送文本即可连续对话。",
    "/codex <任务> — 与普通文本共用当前会话",
    "/new — 开始新对话，保留模型选择",
    "/model — 查看模型选择",
    "/model <模型名> — 切换后续消息的模型，保留上下文",
    "/model default — 恢复默认模型配置",
    "/models — 查看配置的模型名单",
    "/status — 查看会话和运行状态",
    "/usage — 查看当前会话最近的 token 报告",
    "/quota — 查询账号额度和重置时间",
    "/remind YYYY-MM-DD HH:mm 内容 — 指定时间私聊提醒（北京时间）",
    "/remind daily HH:mm 内容 — 每天私聊提醒",
    "也可直接说：每天晚上9点提醒我喝水（北京时间，仅私聊）",
    ...(config.platform === "discord" ? [] : ["模型提醒：每天早上9点调用模型生成一句简短早安问候并发给我"]),
    "/reminders — 查看定时消息（仅私聊）",
    "/cancelreminder 任务ID — 取消定时消息（仅私聊）",
    "也可说：查看我的提醒、取消喝水提醒、取消提醒 任务ID",
    "修改时间：把喝水提醒改成每天晚上10点、把提醒 任务ID 改成明天 08:30",
    "非工作日多时间：非工作日早上6点1分、11点2分提醒我测试消息（中国大陆调休日历）",
    `/id — 查看自己的 ${config.platform === "discord" ? "Discord" : "Telegram"} 用户 ID`,
  ].join("\n");

  async function reply(msg, text) {
    if (transport) {
      try { await transport.reply(msg, redact(text)); }
      catch { logger.error("Discord reply failed."); }
      return;
    }
    const options = { reply_parameters: { message_id: msg.message_id } };
    if (msg.message_thread_id) options.message_thread_id = msg.message_thread_id;
    for (const part of splitMessage(redact(text))) {
      try { await bot.sendMessage(msg.chat.id, part, options); }
      catch { logger.error("Telegram reply failed."); return; }
    }
  }

  return async function handleMessage(msg) {
    if (typeof msg.text !== "string" || !msg.from || !msg.chat) return;
    const command = msg.text.match(/^\/([a-z]+)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i);
    if (command?.[2] && command[2].toLowerCase() !== botUsername.toLowerCase()) return;
    const name = command?.[1].toLowerCase();
    const argument = command?.[3]?.trim() || "";
    if (name === "id") return reply(msg, `你的 ${config.platform === "discord" ? "Discord" : "Telegram"} 用户 ID：${msg.from.id}`);
    if (String(msg.from.id) !== config.allowedUserId) return reply(msg, "未授权。");

    const privateChat = config.platform === "discord" ? msg.chat.type === "private"
      : String(msg.chat.id) === config.allowedUserId && (!msg.chat.type || msg.chat.type === "private");
    if (["remind", "reminders", "cancelreminder"].includes(name)) {
      if (!privateChat) return reply(msg, "定时消息请在与 Bot 的私聊中设置和管理。");
      return reply(msg, reminders ? reminders.command(name, argument) : "定时消息功能尚未启用。");
    }

    const key = `${config.platform === "discord" ? "discord:" : ""}${msg.chat.id}:${msg.message_thread_id || 0}:${msg.from.id}`;
    const session = store.get(key);
    const selectedModel = session.model || config.defaultModel;
    const modelLabel = selectedModel || "Codex CLI 默认配置（未显式指定模型）";
    if (name === "start" || name === "help") return reply(msg, help);
    if (name === "usage") {
      return reply(msg, formatUsage(session.lastUsage, busy.has(key)) +
        (stateFailures.has(key) ? "\n状态保存曾失败，以上仅为最后保存的数据。" : ""));
    }
    if (name === "quota") {
      // Coalesce concurrent requests; every response is from this query, never a stale cache.
      if (!quotaRequest) {
        quotaRequest = Promise.resolve().then(() => quotaReader({
          bin: config.bin, workdir: config.workdir, env: { ...config.env, CODEX_HOME: config.codexHome },
        })).catch(() => ({ ok: false, kind: "query" })).finally(() => { quotaRequest = undefined; });
      }
      return reply(msg, formatQuota(await quotaRequest));
    }
    if (name === "status") {
      return reply(msg, [
        `模型选择：${modelLabel}`,
        `上下文：${session.threadId ? "已有会话" : "新会话"}`,
        `状态：${stateFailures.has(key) ? "状态保存失败，暂停处理" : busy.has(key) ? "正在处理" : "空闲"}`,
      ].join("\n"));
    }
    if (name === "models") {
      return reply(msg, config.models.length
        ? `配置的模型名单：\n${config.models.join("\n")}\n使用 /model <模型名> 选择；实际可用性取决于 Codex 账号和 provider。`
        : "尚未配置 CODEX_MODELS。可使用 /model <模型名>；模型 ID 和账号可用性请在 Debian 的 Codex CLI 中确认。");
    }
    if (name === "model" && !argument) {
      return reply(msg, `模型选择：${modelLabel}\n使用 /model <模型名> 切换，或 /model default 恢复默认。`);
    }
    if (msg.text.startsWith("/") && !["codex", "model", "new"].includes(name)) {
      return reply(msg, "未知命令，使用 /help 查看用法。");
    }
    if (busy.has(key)) return reply(msg, "正在处理上一条消息，请等待回复后再发送任务或修改会话。");

    if (name === "model") {
      const model = argument === "default" ? null : argument;
      if ((model && !MODEL_NAME.test(model)) || (model && config.models.length && !config.models.includes(model))) {
        return reply(msg, "模型名称无效或不在 CODEX_MODELS 名单中，使用 /models 查看配置。");
      }
      try { store.set(key, { ...session, model }); }
      catch { return reply(msg, "模型选择保存失败，请检查状态目录权限。"); }
      return reply(msg, `后续消息将使用：${model || config.defaultModel || "Codex CLI 默认配置"}。上下文保留；模型可用性将在下次调用时验证。`);
    }
    if (name === "new") {
      try { store.set(key, { ...session, threadId: null, lastUsage: null, reminderReceipt: "" }); }
      catch { return reply(msg, "新会话状态保存失败，请检查状态目录权限。"); }
      stateFailures.delete(key);
      return reply(msg, "已开始新对话，模型选择保留。下一条消息将创建新会话。");
    }
    const prompt = name === "codex" ? argument : msg.text;
    if (!prompt.trim()) return reply(msg, "用法：/codex <任务>，或直接发送文本。");
    if (stateFailures.has(key)) return reply(msg, "状态保存曾失败，请修复状态目录权限后使用 /new 开始新对话。");
    if (selectedModel && config.models.length && !config.models.includes(selectedModel)) {
      return reply(msg, "原模型已不在 CODEX_MODELS 名单中，请先使用 /model 切换。");
    }

    busy.add(key);
    try {
      // Check persistence before launching a task, so unwritable state never causes stateless runs.
      store.set(key, session);
      try {
        if (transport) await transport.markReceived(msg);
        else await bot._request("setMessageReaction", {
          form: { chat_id: msg.chat.id, message_id: msg.message_id,
            reaction: JSON.stringify([{ type: "emoji", emoji: "👀" }]), is_big: false },
        });
      } catch { logger.warn("Message reaction failed."); }
      const turn = reminders ? prepareTurn({ scheduler: reminders, text: prompt, privateChat,
        allowActions: name !== "codex", receipt: session.reminderReceipt || "", redact,
        schemaDirectory: path.dirname(config.sessionFile), model: selectedModel }) : null;
      const result = await runner({
        bin: config.bin, workdir: config.workdir, env: { ...config.env, CODEX_HOME: config.codexHome },
        prompt: turn ? turn.prompt : prompt, threadId: session.threadId, model: selectedModel, timeoutMs: config.timeoutMs,
        ...(turn ? { outputSchema: turn.outputSchema } : {}),
        onThread: (threadId) => store.set(key, { ...session, threadId }),
      });
      let usageWarning = "";
      try {
        store.set(key, { ...store.get(key), lastUsage: {
          at: new Date().toISOString(), status: result.ok ? "completed" : "failed", tokens: result.usage || null,
        } });
      } catch {
        stateFailures.add(key);
        logger.error("Usage persistence failed.");
        usageWarning = "\n\n用量保存失败，请检查状态目录权限。任务可能已经执行，请先核实结果。";
      }
      if (result.ok) {
        let responsePlan;
        if (turn) {
          try { responsePlan = parseResponse(result.text, turn); }
          catch { /* applyResponse returns a controlled diagnostic below. */ }
        }
        // Persistence failure must never turn a model proposal into an untracked reminder write.
        if (turn && usageWarning) return await reply(msg, (responsePlan?.action === "chat" ? responsePlan.message
          : "会话用量保存失败，未执行任何定时操作。请检查状态目录权限。") + usageWarning);
        const answer = turn ? applyResponse(result.text, turn, reminders) : result.text;
        if (turn && responsePlan?.action !== "chat") {
          try { store.set(key, { ...store.get(key), reminderReceipt: redact(answer).slice(0, 16000) }); }
          catch {
            stateFailures.add(key);
            usageWarning = "\n\n回执上下文保存失败，请检查状态目录权限。以上为实际执行结果，请先核对任务列表，不要重复创建。";
          }
        }
        return await reply(msg, answer + usageWarning);
      }
      if (result.kind === "state") stateFailures.add(key);
      const errors = {
        launch: "Codex 启动失败，请检查 CODEX_BIN、WORKDIR 和执行权限。",
        input: "Codex 输入失败，请检查 CLI 运行状态。",
        execution: "Codex 执行失败，请检查模型可用性、登录状态和网络。已保存的会话保留，可重试或使用 /new。",
        protocol: "Codex 返回格式不符合预期，请检查 CLI 是否支持 exec/resume --json。不会自动改为无上下文对话。",
        state: "会话状态保存失败，本轮已停止。请修复状态目录权限后使用 /new；新创建的会话可能无法恢复。",
        timeout: `Codex 超过 ${config.timeoutMs / 1000} 秒，本轮已停止。已保存的上下文保留，但任务可能部分执行，请先核实结果。`,
        output_limit: "Codex 输出超过安全上限，本轮已停止，请缩小任务范围。",
      };
      logger.error(`Codex run failed: ${Object.hasOwn(errors, result.kind) ? result.kind : "unknown"}.`);
      return await reply(msg, (errors[result.kind] || "Codex 执行失败。") + usageWarning);
    } catch {
      logger.error("Bot task or session persistence failed.");
      return await reply(msg, "任务处理或会话状态保存失败，请检查状态目录权限和运行配置。");
    } finally {
      busy.delete(key);
    }
  };
}

async function startBot() {
  require("dotenv").config({ quiet: true });
  let config;
  let store;
  let reminders;
  try {
    config = loadConfig(process.env);
    store = new SessionStore(config.sessionFile, config);
  } catch (error) {
    // These validation errors have controlled messages; no file contents or env values are included.
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  const TelegramBotModule = require("node-telegram-bot-api");
  const TelegramBot = TelegramBotModule.default || TelegramBotModule;
  const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
  try {
    reminders = new ReminderScheduler({ filename: config.reminderFile, platform: "telegram",
      userId: config.allowedUserId, sanitize: createRedactor(config.env), calendarFile: config.calendarFile,
      generate: createReminderGenerator(config),
      send: (userId, text) => bot.sendMessage(userId, text) });
  } catch { console.error("Telegram reminder state/calendar failed; check REMINDER_FILE and HOLIDAY_CALENDAR_FILE."); process.exitCode = 1; return; }
  bot.on("polling_error", () => console.error("Telegram polling failed; check connection and bot configuration."));
  const identity = await bot.getMe();
  const handler = createMessageHandler({ bot, store, config, reminders, botUsername: identity.username });
  bot.on("message", (msg) => {
    handler(msg).catch(() => console.error("Telegram message handling failed."));
  });
  await bot.startPolling();
  reminders.start();
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { reminders.stop(); process.exit(0); });
  console.log("Codex Telegram Bot started.");
}

async function main(args = process.argv.slice(2)) {
  if (!args.length) return startBot();
  if (args.length !== 1 || args[0] !== "--check-config") throw new Error("arguments");
  require("dotenv").config({ quiet: true, debug: false });
  const config = loadConfig(process.env);
  new SessionStore(config.sessionFile, config);
  new ReminderScheduler({ filename: config.reminderFile, platform: "telegram", userId: config.allowedUserId, calendarFile: config.calendarFile });
  checkLocalPaths(config);
  console.log("Telegram configuration and local paths checked; no network requests or state writes.");
}

if (require.main === module) {
  main().catch(() => {
    console.error("Bot startup failed; check Telegram credentials and network.");
    process.exitCode = 1;
  });
}

module.exports = { loadConfig, splitMessage, createRedactor, createMessageHandler, startBot, main };
