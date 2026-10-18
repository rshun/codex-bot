const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { SessionStore } = require("../session-store");
const { ReminderScheduler } = require("../reminders");

const root = path.resolve(__dirname, "..", ".test-artifacts");
const directory = path.join(root, "debian-smoke");
const record = path.join(root, "debian-smoke-before.json");
function snapshot() {
  const files = {};
  function walk(folder, relative = "") {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const filename = path.join(folder, entry.name), name = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(filename, name);
      else files[name] = crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
    }
  }
  walk(directory);
  return files;
}

if (process.argv[2] === "prepare" && process.argv.length === 3) {
  if (process.platform !== "linux" || fs.existsSync(directory) || fs.existsSync(record)) throw new Error("Fresh Linux fixture required.");
  fs.mkdirSync(directory, { recursive: true });
  for (const name of ["workspace", "codex-home"]) fs.mkdirSync(path.join(directory, name));
  for (const [platform, id, envFile, tokenField, idField, session] of [
    ["telegram", "42", ".env", "TELEGRAM_BOT_TOKEN", "ALLOWED_USER_ID", "sessions.json"],
    ["discord", "43", ".env.discord", "DISCORD_BOT_TOKEN", "DISCORD_ALLOWED_USER_ID", "discord-sessions.json"],
  ]) {
    const store = new SessionStore(path.join(directory, ".bot-state", session), {
      workdir: "/fixture/workspace", codexHome: "/fixture/codex-home", platform,
    });
    store.set(`${platform === "discord" ? "discord:" : ""}${id}:${id}:0`, {
      threadId: "00000000-0000-0000-0000-000000000001", model: "test-model", reminderReceipt: "测试回执",
    });
    const reminders = new ReminderScheduler({ filename: path.join(directory, ".bot-state", `${platform}-reminders.json`),
      platform, userId: id, now: () => Date.parse("2026-10-09T20:00:00+08:00") });
    reminders.addBatch({ kind: "nonworking", times: ["06:01", "11:02"], text: "测试消息" });
    fs.writeFileSync(path.join(directory, envFile), `${tokenField}=synthetic_bot_credential\n${idField}=${id}\n` +
      "WORKDIR=/fixture/workspace\nCODEX_HOME=/fixture/codex-home\nCODEX_BIN=/bin/true\n");
  }
  fs.writeFileSync(record, JSON.stringify(snapshot()), { flag: "wx" });
  console.log("Synthetic Debian state fixtures prepared.");
} else if (process.argv[2] === "verify" && process.argv.length === 3) {
  assert.deepEqual(snapshot(), JSON.parse(fs.readFileSync(record)));
  console.log("Debian standalone checks passed; existing configuration, sessions and reminders are byte-for-byte unchanged.");
} else {
  console.error("Usage: node scripts/smoke-debian.js prepare|verify"); process.exitCode = 1;
}
