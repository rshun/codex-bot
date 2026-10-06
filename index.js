const path = require("node:path");
const os = require("node:os");
const { SessionStore, MODEL_NAME } = require("./session-store");
const { runCodex } = require("./codex-runner");
const { formatUsage } = require("./usage");
const { queryQuota, formatQuota } = require("./quota");

function loadConfig(env) {
  if (!env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN.includes("这里换成") ||
      env.TELEGRAM_BOT_TOKEN.startsWith("your_")) {
    throw new Error("请配置 TELEGRAM_BOT_TOKEN。");
  }
  if (!/^[1-9]\d*$/.test(env.ALLOWED_USER_ID || "")) {
    throw new Error("请配置有效的 ALLOWED_USER_ID；Bot 不允许匿名开放执行。");
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
  return {
    allowedUserId: env.ALLOWED_USER_ID,
    bin: env.CODEX_BIN || "/home/codex/.local/bin/codex",
    workdir: path.resolve(env.WORKDIR || "/home/codex"),
    codexHome: path.resolve(env.CODEX_HOME || path.join(os.homedir(), ".codex")),
    sessionFile: path.resolve(env.SESSION_FILE || path.join(__dirname, ".bot-state", "sessions.json")),
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
                                quotaReader = queryQuota, logger = console }) {
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
    "/id — 查看自己的 Telegram 用户 ID",
  ].join("\n");

  async function reply(msg, text) {
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
    if (name === "id") return reply(msg, `你的 Telegram 用户 ID：${msg.from.id}`);
    if (String(msg.from.id) !== config.allowedUserId) return reply(msg, "未授权。");

    const key = `${msg.chat.id}:${msg.message_thread_id || 0}:${msg.from.id}`;
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
      try { store.set(key, { ...session, threadId: null, lastUsage: null }); }
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
        await bot._request("setMessageReaction", {
          form: { chat_id: msg.chat.id, message_id: msg.message_id,
            reaction: JSON.stringify([{ type: "emoji", emoji: "👀" }]), is_big: false },
        });
      } catch { logger.warn("Message reaction failed."); }
      const result = await runner({
        bin: config.bin, workdir: config.workdir, env: { ...config.env, CODEX_HOME: config.codexHome },
        prompt, threadId: session.threadId, model: selectedModel, timeoutMs: config.timeoutMs,
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
      if (result.ok) return await reply(msg, result.text + usageWarning);
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
  bot.on("polling_error", () => console.error("Telegram polling failed; check connection and bot configuration."));
  const identity = await bot.getMe();
  const handler = createMessageHandler({ bot, store, config, botUsername: identity.username });
  bot.on("message", (msg) => {
    handler(msg).catch(() => console.error("Telegram message handling failed."));
  });
  await bot.startPolling();
  console.log("Codex Telegram Bot started.");
}

if (require.main === module) {
  startBot().catch(() => {
    console.error("Bot startup failed; check Telegram credentials and network.");
    process.exitCode = 1;
  });
}

module.exports = { loadConfig, splitMessage, createRedactor, createMessageHandler };
