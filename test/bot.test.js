const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { SessionStore } = require("../session-store");
const { buildArgs, runCodex } = require("../codex-runner");
const { loadConfig, splitMessage, createRedactor, createMessageHandler } = require("../index");

// Keep test artifacts for inspection; tests never delete user files or directories.
const artifactRoot = path.join(__dirname, "..", ".test-artifacts");
fs.mkdirSync(artifactRoot, { recursive: true });
const runDir = fs.mkdtempSync(path.join(artifactRoot, "run-"));
const context = { workdir: path.resolve("."), codexHome: path.join(runDir, "codex-home") };
const THREAD_A = "00000000-0000-0000-0000-000000000001";
const THREAD_B = "00000000-0000-0000-0000-000000000002";
let storeNumber = 0;
function newStore() {
  return new SessionStore(path.join(runDir, `sessions-${++storeNumber}.json`), context);
}
function message(text, { chat = 1, user = 42, topic } = {}) {
  return { text, chat: { id: chat }, from: { id: user }, message_id: 7,
    ...(topic ? { message_thread_id: topic } : {}) };
}
function fixture({ runner, store = newStore(), env = {} } = {}) {
  const sent = [];
  const logs = [];
  const calls = [];
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: "synthetic_bot_credential", ALLOWED_USER_ID: "42", ...env });
  const bot = {
    sendMessage: async (chat, text, options) => { sent.push({ chat, text, options }); },
    _request: async () => {},
  };
  const execute = runner || (async (options) => {
    calls.push(options);
    options.onThread(options.threadId || THREAD_A);
    return { ok: true, text: "模拟回答" };
  });
  const handler = createMessageHandler({ bot, store, config, runner: execute, botUsername: "example_bot",
    logger: { error: (text) => logs.push(text), warn: (text) => logs.push(text) } });
  return { handler, bot, store, sent, logs, calls, config };
}
function mockSpawn({ events = [], chunks, code = 0, error = false, hang = false, ignoreTerm = false } = {}) {
  const calls = [];
  const signals = [];
  const fn = (bin, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let input = "";
    child.stdin.on("data", (chunk) => { input += chunk.toString(); });
    child.kill = (signal) => {
      signals.push(signal);
      if (ignoreTerm && signal === "SIGTERM") return true;
      setImmediate(() => child.emit("close", null));
      return true;
    };
    calls.push({ bin, args, options, get input() { return input; } });
    child.stdin.on("finish", () => {
      setImmediate(() => {
        if (error) {
          child.emit("error", new Error("synthetic private diagnostic"));
          child.emit("close", -1);
          return;
        }
        const output = chunks || [events.map((event) => JSON.stringify(event)).join("\n") + "\n"];
        for (const chunk of output) child.stdout.write(chunk);
        child.stderr.write("synthetic private diagnostic");
        if (!hang) {
          child.stdout.end();
          child.stderr.end();
          child.emit("close", code);
        }
      });
    });
    return child;
  };
  return { fn, calls, signals };
}
function successfulEvents(thread = THREAD_A) {
  return [
    { type: "thread.started", thread_id: thread },
    { type: "item.completed", item: { type: "command_execution", aggregated_output: "private tool output" } },
    { type: "item.completed", item: { type: "agent_message", phase: "commentary", text: "处理中" } },
    { type: "item.completed", item: { type: "agent_message", phase: "final_answer", text: "你好😀" } },
    { type: "turn.completed" },
  ];
}
function runWith(mock, overrides = {}) {
  return runCodex({ bin: "/synthetic/codex", workdir: context.workdir,
    env: { TELEGRAM_BOT_TOKEN: "synthetic_bot_credential", ALLOWED_USER_ID: "42", CODEX_HOME: context.codexHome },
    prompt: "--model should remain prompt text", threadId: null, model: "model-a", timeoutMs: 1000,
    onThread: () => {}, ...overrides }, mock.fn);
}

test("session metadata survives restart and isolates chat, user, and topic", () => {
  const store = newStore();
  store.set("1:0:42", { threadId: THREAD_A, model: "model-a" });
  store.set("1:9:42", { threadId: THREAD_B, model: "model-b" });
  const loaded = new SessionStore(store.filename, context);
  assert.deepEqual(loaded.get("1:0:42"), { threadId: THREAD_A, model: "model-a" });
  assert.deepEqual(loaded.get("1:9:42"), { threadId: THREAD_B, model: "model-b" });
  assert.equal(loaded.get("2:0:42").threadId, null);
  assert.equal(loaded.get("1:0:43").threadId, null);
  const copy = loaded.get("1:0:42");
  copy.model = "model-b";
  assert.equal(loaded.get("1:0:42").model, "model-a");
});

test("corrupt and incompatible stores fail closed without overwriting contents", () => {
  const filename = path.join(runDir, "corrupt.json");
  fs.writeFileSync(filename, "{broken", "utf8");
  assert.throws(() => new SessionStore(filename, context), /无法读取/);
  assert.equal(fs.readFileSync(filename, "utf8"), "{broken");
  const store = newStore();
  store.set("1:0:42", { threadId: THREAD_A, model: null });
  assert.throws(() => new SessionStore(store.filename, { ...context, workdir: runDir }), /不匹配/);
  assert.throws(() => new SessionStore(store.filename, { ...context, codexHome: runDir }), /不匹配/);
  assert.throws(() => store.set("__proto__", { threadId: THREAD_A, model: null }));
  assert.throws(() => store.set("1:0:42", { threadId: [THREAD_A], model: null }));
});

test("failed atomic replacement does not publish in-memory state", () => {
  const directory = path.join(runDir, "replacement-directory");
  fs.mkdirSync(directory);
  const store = newStore();
  store.filename = directory;
  assert.throws(() => store.set("1:0:42", { threadId: THREAD_A, model: null }));
  assert.equal(store.get("1:0:42").threadId, null);
});

test("CLI arguments resume the explicit thread with a model override", () => {
  assert.deepEqual(buildArgs({ threadId: THREAD_A, model: "model-b" }),
    ["exec", "resume", "--json", "--skip-git-repo-check", "--model", "model-b", THREAD_A, "-"]);
  assert.deepEqual(buildArgs({ threadId: null, model: null }), ["exec", "--json", "--skip-git-repo-check", "-"]);
  assert.throws(() => buildArgs({ threadId: "--last", model: null }));
  assert.throws(() => buildArgs({ threadId: null, model: "model-a --other-option" }));
});

test("runner decodes split UTF-8 JSONL, saves thread early, and returns only final text", async () => {
  const raw = Buffer.from(successfulEvents().map((event) => JSON.stringify(event)).join("\n"));
  const split = raw.indexOf(Buffer.from("好")) + 1;
  const mock = mockSpawn({ chunks: [raw.subarray(0, 13), raw.subarray(13, split), raw.subarray(split)] });
  const saved = [];
  const result = await runWith(mock, { onThread: (thread) => saved.push(thread) });
  assert.deepEqual(result, { ok: true, threadId: THREAD_A, text: "你好😀" });
  assert.deepEqual(saved, [THREAD_A]);
  assert.equal(mock.calls[0].input, "--model should remain prompt text");
  assert.equal(mock.calls[0].options.shell, false);
  assert.equal(mock.calls[0].options.env.TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(mock.calls[0].options.env.CODEX_HOME, context.codexHome);
});

test("nonzero exit, turn failure, launch failure and malformed JSON have safe diagnostics", async () => {
  for (const options of [
    { events: successfulEvents(), code: 1 },
    { events: [{ type: "turn.failed", error: { message: "synthetic private diagnostic" } }] },
    { error: true },
    { chunks: ["not-json\n"] },
    { events: [{ type: "thread.started", thread_id: THREAD_A }] },
  ]) {
    const result = await runWith(mockSpawn(options));
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes("synthetic private diagnostic"), false);
    assert.equal(Object.hasOwn(result, "text"), false);
  }
});

test("resume never attaches to a different thread", async () => {
  const saved = [];
  const result = await runWith(mockSpawn({ events: successfulEvents(THREAD_B) }),
    { threadId: THREAD_A, onThread: (thread) => saved.push(thread) });
  assert.equal(result.kind, "protocol");
  assert.deepEqual(saved, []);
});

test("timeout retains a newly emitted thread ID and terminates the child", async () => {
  const saved = [];
  const mock = mockSpawn({ events: [{ type: "thread.started", thread_id: THREAD_A }], hang: true });
  const result = await runWith(mock, { timeoutMs: 30, onThread: (thread) => saved.push(thread) });
  assert.equal(result.kind, "timeout");
  assert.deepEqual(saved, [THREAD_A]);
  assert.deepEqual(mock.signals, ["SIGTERM"]);
});

test("persistence failure stops a running child and reports only its category", async () => {
  const mock = mockSpawn({ events: successfulEvents() });
  const result = await runWith(mock, { onThread: () => { throw new Error("synthetic private diagnostic"); } });
  assert.equal(result.kind, "state");
  assert.deepEqual(mock.signals, ["SIGTERM"]);
});

test("plain messages and /codex share context, including after a Bot restart", async () => {
  const first = fixture();
  await first.handler(message("第一轮"));
  await first.handler(message("/codex 第二轮"));
  assert.equal(first.calls[0].threadId, null);
  assert.equal(first.calls[1].threadId, THREAD_A);
  const restarted = fixture({ store: new SessionStore(first.store.filename, context) });
  await restarted.handler(message("第三轮"));
  assert.equal(restarted.calls[0].threadId, THREAD_A);
});

test("model switching preserves context and /new preserves the model choice", async () => {
  const app = fixture({ env: { CODEX_MODEL: "model-a", CODEX_MODELS: "model-a,model-b" } });
  await app.handler(message("第一轮"));
  await app.handler(message("/model model-b"));
  await app.handler(message("第二轮"));
  assert.equal(app.calls[1].threadId, THREAD_A);
  assert.equal(app.calls[1].model, "model-b");
  await app.handler(message("/new"));
  await app.handler(message("新任务"));
  assert.equal(app.calls[2].threadId, null);
  assert.equal(app.calls[2].model, "model-b");
  await app.handler(message("/model default"));
  await app.handler(message("恢复默认"));
  assert.equal(app.calls[3].model, "model-a");
  assert.equal(app.calls[3].threadId, THREAD_A);
});

test("invalid or restricted model IDs never change persisted selection", async () => {
  const app = fixture({ env: { CODEX_MODELS: "model-a,model-b" } });
  await app.handler(message("/model model-a"));
  await app.handler(message("/model model-c"));
  await app.handler(message("/model model-a --extra"));
  assert.equal(app.store.get("1:0:42").model, "model-a");
  await app.handler(message("/models"));
  assert.match(app.sent.at(-1).text, /model-b/);
});

test("chat and topic routing isolate conversations and keep replies in their topic", async () => {
  const app = fixture();
  await app.handler(message("私聊"));
  await app.handler(message("另一个聊天", { chat: 2 }));
  await app.handler(message("群组话题", { chat: -3, topic: 10 }));
  await app.handler(message("同话题追问", { chat: -3, topic: 10 }));
  await app.handler(message("另一个话题", { chat: -3, topic: 11 }));
  assert.deepEqual(app.calls.map((call) => call.threadId), [null, null, null, THREAD_A, null]);
  assert.equal(app.sent.at(-1).options.message_thread_id, 11);
  assert.equal(app.sent.at(-1).options.reply_parameters.message_id, 7);
});

test("busy conversations reject overlapping tasks and changes, but allow status", async () => {
  let finish;
  let calls = 0;
  const app = fixture({ runner: (options) => {
    calls++;
    options.onThread(THREAD_A);
    return new Promise((resolve) => { finish = resolve; });
  } });
  const first = app.handler(message("运行中"));
  await new Promise(setImmediate);
  await app.handler(message("/status"));
  assert.match(app.sent.at(-1).text, /正在处理/);
  for (const text of ["第二个任务", "/new", "/model model-b"]) {
    await app.handler(message(text));
    assert.match(app.sent.at(-1).text, /等待回复/);
  }
  assert.equal(calls, 1);
  assert.equal(app.store.get("1:0:42").model, null);
  finish({ ok: false, kind: "execution" });
  await first;
  await app.handler(message("/status"));
  assert.match(app.sent.at(-1).text, /空闲/);
});

test("authorization, commands and bot mentions never become unintended Codex prompts", async () => {
  const app = fixture();
  await app.handler(message("任务", { user: 43 }));
  assert.equal(app.sent.at(-1).text, "未授权。");
  await app.handler(message("/id", { user: 43 }));
  assert.match(app.sent.at(-1).text, /43/);
  await app.handler(message("/model@another_bot model-a"));
  await app.handler(message("/unknown"));
  await app.handler(message("/codex"));
  assert.equal(app.calls.length, 0);
  await app.handler(message("/codex@example_bot hello"));
  assert.equal(app.calls[0].prompt, "hello");
});

test("unwritable state prevents launching Codex", async () => {
  const app = fixture({ store: { get: () => ({ threadId: null, model: null }), set: () => { throw new Error("private diagnostic"); } } });
  await app.handler(message("任务"));
  assert.equal(app.calls.length, 0);
  assert.match(app.sent.at(-1).text, /保存失败/);
  assert.equal(app.sent.at(-1).text.includes("private diagnostic"), false);
});

test("state failures block further tasks until an explicit new conversation", async () => {
  let count = 0;
  const app = fixture({ runner: async () => { count++; return { ok: false, kind: "state" }; } });
  await app.handler(message("任务"));
  await app.handler(message("重试"));
  assert.equal(count, 1);
  await app.handler(message("/new"));
  await app.handler(message("新任务"));
  assert.equal(count, 2);
});

test("reply errors are contained and do not leave the conversation busy", async () => {
  const app = fixture();
  app.bot.sendMessage = async () => { throw new Error("synthetic private diagnostic"); };
  await app.handler(message("任务"));
  await app.handler(message("下一轮"));
  assert.equal(app.calls.length, 2);
  assert.equal(app.calls[1].threadId, THREAD_A);
  assert.equal(app.logs.some((line) => line.includes("synthetic private diagnostic")), false);
});

test("reply text masks known credentials and chunks preserve Unicode", async () => {
  const credential = "synthetic_bot_credential";
  const redactor = createRedactor({ TELEGRAM_BOT_TOKEN: credential });
  assert.equal(redactor(`value=${credential}`), "value=[REDACTED]");
  assert.equal(redactor("sk-" + "x".repeat(24)), "[REDACTED KEY]");
  const text = "a".repeat(3499) + "😀中文" + "b".repeat(4000);
  const chunks = splitMessage(text);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every((chunk) => chunk.length <= 3500 && !/[\uD800-\uDBFF]$/.test(chunk)));
  const app = fixture({ runner: async () => ({ ok: true, text: `value=${credential}` }) });
  await app.handler(message("任务"));
  assert.equal(app.sent.at(-1).text, "value=[REDACTED]");
});

test("configuration fails closed for missing user authorization and invalid settings", () => {
  const env = { TELEGRAM_BOT_TOKEN: "synthetic_bot_credential", ALLOWED_USER_ID: "42" };
  assert.throws(() => loadConfig({ ...env, ALLOWED_USER_ID: "" }), /ALLOWED_USER_ID/);
  assert.throws(() => loadConfig({ ...env, CODEX_MODEL: "--bad" }), /模型名称/);
  assert.throws(() => loadConfig({ ...env, CODEX_MODEL: "model-a", CODEX_MODELS: "model-b" }), /必须包含/);
  assert.throws(() => loadConfig({ ...env, CODEX_TIMEOUT_MS: "0" }), /CODEX_TIMEOUT_MS/);
  assert.equal(loadConfig(env).defaultModel, null);
});

test("a child ignoring SIGTERM is force-terminated before releasing the task", async () => {
  const mock = mockSpawn({ hang: true, ignoreTerm: true });
  const result = await runWith(mock, { timeoutMs: 30 });
  assert.equal(result.kind, "timeout");
  assert.deepEqual(mock.signals, ["SIGTERM", "SIGKILL"]);
});

test("another chat can complete while one chat is busy without losing either mapping", async () => {
  let finish;
  const app = fixture({ runner: (options) => {
    const thread = options.prompt === "other" ? THREAD_B : THREAD_A;
    options.onThread(thread);
    return thread === THREAD_B ? Promise.resolve({ ok: true, text: "other done" })
      : new Promise((resolve) => { finish = resolve; });
  } });
  const first = app.handler(message("first"));
  await new Promise(setImmediate);
  await app.handler(message("other", { chat: 2 }));
  assert.equal(app.store.get("1:0:42").threadId, THREAD_A);
  assert.equal(app.store.get("2:0:42").threadId, THREAD_B);
  finish({ ok: true, text: "first done" });
  await first;
});

test("default selection clears the override without inventing a model ID", async () => {
  const app = fixture();
  await app.handler(message("/model model-a"));
  await app.handler(message("/model default"));
  await app.handler(message("任务"));
  assert.equal(app.calls[0].model, null);
  assert.equal(app.calls[0].env.CODEX_HOME, app.config.codexHome);
});

test("credential assignments and private keys are masked before message splitting", () => {
  const redact = createRedactor({});
  assert.equal(redact('DATABASE_PASSWORD="synthetic password value"'), "DATABASE_PASSWORD=[REDACTED]");
  assert.equal(redact("api_key=synthetic_value"), "api_key=[REDACTED]");
  assert.equal(redact("{\"token\": \"synthetic_value\"}"), '{"token": [REDACTED]}');
  assert.equal(redact("-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----"), "[REDACTED PRIVATE KEY]");
  assert.throws(() => splitMessage("😀", 1));
});

test("installed Telegram library preserves reaction and topic reply options without network calls", async () => {
  const TelegramBotModule = require("node-telegram-bot-api");
  const TelegramBot = TelegramBotModule.default || TelegramBotModule;
  const bot = new TelegramBot("synthetic_bot_credential", { polling: false });
  const requests = [];
  bot.http.request = async (method, options) => { requests.push({ method, options }); return {}; };
  const handler = createMessageHandler({ bot, store: newStore(), botUsername: "example_bot",
    config: loadConfig({ TELEGRAM_BOT_TOKEN: "synthetic_bot_credential", ALLOWED_USER_ID: "42" }),
    runner: async (options) => { options.onThread(THREAD_A); return { ok: true, text: "模拟回答" }; } });
  await handler(message("/codex@example_bot task", { chat: -3, topic: 10 }));
  assert.equal(requests[0].method, "setMessageReaction");
  assert.deepEqual(JSON.parse(requests[0].options.form.reaction), [{ type: "emoji", emoji: "👀" }]);
  const reply = requests.find((request) => request.method === "sendMessage");
  assert.equal(reply.options.form.message_thread_id, 10);
  assert.deepEqual(JSON.parse(reply.options.form.reply_parameters), { message_id: 7 });
  assert.equal(bot.isPolling(), false);
});
