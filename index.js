require("dotenv").config();

const TelegramBotModule = require("node-telegram-bot-api");
const TelegramBot = TelegramBotModule.default || TelegramBotModule;
const { spawn } = require("child_process");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID;
const CODEX_BIN = process.env.CODEX_BIN || "/home/codex/.local/bin/codex";
const WORKDIR = process.env.WORKDIR || "/home/codex";

if (!TOKEN || TOKEN.includes("这里换成")) {
  console.error("ERROR: TELEGRAM_BOT_TOKEN is not configured in .env");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

function isAllowed(msg) {
  if (!ALLOWED_USER_ID) return true;
  return String(msg.from.id) === String(ALLOWED_USER_ID);
}

function splitMessage(text, maxLength = 3500) {
  const chunks = [];
  for (let i = 0; i < text.length; i += maxLength) {
    chunks.push(text.slice(i, i + maxLength));
  }
  return chunks;
}

async function markReceived(msg) {
  try {
    await bot._request("setMessageReaction", {
      form: {
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        reaction: JSON.stringify([
          { type: "emoji", emoji: "👀" }
        ]),
        is_big: false,
      },
    });
  } catch (err) {
    console.warn("Message reaction failed:", err.code || "unknown error");
  }
}

bot.onText(/^\/start$/, async (msg) => {
  if (!isAllowed(msg)) {
    return bot.sendMessage(msg.chat.id, "Unauthorized.");
  }

  await bot.sendMessage(
    msg.chat.id,
    [
      "Codex Bot is running.",
      "",
      "Usage:",
      "/codex hello",
      "/id"
    ].join("\n")
  );
});

bot.onText(/^\/id$/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    `Your Telegram user id is: ${msg.from.id}`
  );
});

bot.onText(/^\/codex(?:\s+([\s\S]+))?$/, async (msg, match) => {
  if (!isAllowed(msg)) {
    return bot.sendMessage(msg.chat.id, "Unauthorized.");
  }

  const prompt = match[1];

  if (!prompt) {
    return bot.sendMessage(msg.chat.id, "Usage: /codex your task");
  }

  await markReceived(msg);

  const args = [
    "exec",
    "--skip-git-repo-check",
    prompt
  ];

  const child = spawn(CODEX_BIN, args, {
    cwd: WORKDIR,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let spawnError;

  child.on("error", (err) => {
    spawnError = err;
    console.error("Codex launch failed:", err.code || "unknown error");
  });

  const timer = setTimeout(() => {
    child.kill("SIGTERM");
  }, 120000);

  child.stdout.on("data", (data) => {
    stdout += data.toString();
  });

  child.stderr.on("data", (data) => {
    stderr += data.toString();
  });

  child.on("close", async (code) => {
    clearTimeout(timer);

    let output = stdout.trim();

    if (spawnError) {
      output = `Codex 启动失败（${spawnError.code || "unknown error"}），请检查程序路径和权限。`;
    }

    if (code !== 0 && stderr.trim()) {
      output += `\n\n[stderr]\n${stderr.trim()}`;
    }

    if (!output) {
      output = code === 0 ? "(No output.)" : `(No output. Exit code: ${code})`;
    } else if (code !== 0) {
      output += `\n\nExit code: ${code}`;
    }

    for (const part of splitMessage(output)) {
      try {
        await bot.sendMessage(msg.chat.id, part);
      } catch (err) {
        console.error("Telegram reply failed:", err.code || "unknown error");
      }
    }
  });
});

bot.on("message", async (msg) => {
  if (!msg.text) return;
  if (msg.text.startsWith("/")) return;

  if (!isAllowed(msg)) {
    return bot.sendMessage(msg.chat.id, "Unauthorized.");
  }

  const prompt = msg.text;

  await markReceived(msg);

  const args = [
    "exec",
    "--skip-git-repo-check",
    prompt
  ];

  const child = spawn(CODEX_BIN, args, {
    cwd: WORKDIR,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let spawnError;

  child.on("error", (err) => {
    spawnError = err;
    console.error("Codex launch failed:", err.code || "unknown error");
  });

  const timer = setTimeout(() => {
    child.kill("SIGTERM");
  }, 120000);

  child.stdout.on("data", (data) => {
    stdout += data.toString();
  });

  child.stderr.on("data", (data) => {
    stderr += data.toString();
  });

  child.on("close", async (code) => {
    clearTimeout(timer);

    let output = stdout.trim();

    if (spawnError) {
      output = `Codex 启动失败（${spawnError.code || "unknown error"}），请检查程序路径和权限。`;
    }

    if (code !== 0 && stderr.trim()) {
      output += `\n\n[stderr]\n${stderr.trim()}`;
    }

    if (!output) {
      output = code === 0 ? "(No output.)" : `(No output. Exit code: ${code})`;
    } else if (code !== 0) {
      output += `\n\nExit code: ${code}`;
    }

    for (const part of splitMessage(output)) {
      try {
        await bot.sendMessage(msg.chat.id, part);
      } catch (err) {
        console.error("Telegram reply failed:", err.code || "unknown error");
      }
    }
  });
});

console.log("Codex Telegram Bot started.");
