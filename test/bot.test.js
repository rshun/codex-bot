const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { SessionStore, replaceStateFile } = require("../session-store");
const { buildArgs, runCodex } = require("../codex-runner");
const { loadConfig, splitMessage, createRedactor, createMessageHandler } = require("../index");
const { normalizeUsage, formatUsage } = require("../usage");
const { queryQuota, normalizeQuota, formatQuota } = require("../quota");

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
function fixture({ runner, quotaReader, store = newStore(), env = {} } = {}) {
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
  const handler = createMessageHandler({ bot, store, config, runner: execute, quotaReader, botUsername: "example_bot",
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
  assert.deepEqual(result, { ok: true, threadId: THREAD_A, text: "你好😀", usage: null });
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

const RAW_USAGE = { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, reasoning_output_tokens: 5 };
const TOKENS = { inputTokens: 100, cachedInputTokens: 60, outputTokens: 20, reasoningOutputTokens: 5 };
const REPORT_TIME = "2026-10-06T01:00:00.000Z";

test("usage normalization preserves zero, marks invalid/missing fields unknown, and never coerces strings", () => {
  assert.deepEqual(normalizeUsage(RAW_USAGE), TOKENS);
  assert.deepEqual(normalizeUsage({ input_tokens: 0, output_tokens: "20", cached_input_tokens: -1 }),
    { inputTokens: 0, cachedInputTokens: null, outputTokens: null, reasoningOutputTokens: null });
  for (const value of [undefined, null, [], {}, { input_tokens: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.equal(normalizeUsage(value), null);
  }
});

test("runner captures usage from resumed CLI output as one snapshot, not a repeated sum", async () => {
  const events = successfulEvents();
  events.at(-1).usage = RAW_USAGE;
  events.push({ type: "turn.completed", usage: RAW_USAGE });
  const result = await runWith(mockSpawn({ events }), { threadId: THREAD_A });
  assert.deepEqual(result.usage, TOKENS);
  const failed = await runWith(mockSpawn({ events, code: 1 }));
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.usage, TOKENS);
});

test("usage totals do not add cached input or reasoning a second time", () => {
  const text = formatUsage({ at: REPORT_TIME, status: "completed", tokens: TOKENS });
  assert.match(text, /输入 \+ 输出：120/);
  assert.match(text, /09:00:00/);
  const partial = formatUsage({ at: REPORT_TIME, status: "failed",
    tokens: { inputTokens: 0, cachedInputTokens: null, outputTokens: null, reasoningOutputTokens: null } });
  assert.match(partial, /输入：0/);
  assert.match(partial, /输出：未知/);
  assert.match(partial, /输入 \+ 输出：未知/);
});

test("token reports persist through restart and model selection, and /new clears them", async () => {
  const app = fixture({ runner: async (options) => {
    options.onThread(THREAD_A);
    return { ok: true, text: "done", usage: TOKENS };
  } });
  await app.handler(message("任务"));
  const restart = fixture({ store: new SessionStore(app.store.filename, context) });
  await restart.handler(message("/usage"));
  assert.match(restart.sent.at(-1).text, /输入 \+ 输出：120/);
  assert.equal(restart.calls.length, 0);
  const report = restart.store.get("1:0:42").lastUsage;
  report.tokens.inputTokens = 999;
  assert.equal(restart.store.get("1:0:42").lastUsage.tokens.inputTokens, 100);
  await restart.handler(message("/model model-b"));
  assert.equal(restart.store.get("1:0:42").lastUsage.tokens.inputTokens, 100);
  await restart.handler(message("/new"));
  await restart.handler(message("/usage"));
  assert.match(restart.sent.at(-1).text, /暂无报告/);
});

test("failed tasks replace stale token reports with unknown instead of displaying old counts", async () => {
  let attempts = 0;
  const app = fixture({ runner: async (options) => {
    options.onThread(THREAD_A);
    return attempts++ === 0 ? { ok: true, text: "done", usage: TOKENS }
      : { ok: false, kind: "timeout", usage: null };
  } });
  await app.handler(message("成功任务"));
  await app.handler(message("失败任务"));
  await app.handler(message("/usage"));
  assert.match(app.sent.at(-1).text, /失败或中断/);
  assert.match(app.sent.at(-1).text, /输入：未知/);
  assert.doesNotMatch(app.sent.at(-1).text, /输入：100/);
});

test("usage commands keep reports isolated and are readable during an active task", async () => {
  let finish;
  const app = fixture({ runner: (options) => {
    options.onThread(THREAD_A);
    return new Promise((resolve) => { finish = resolve; });
  } });
  app.store.set("1:0:42", { threadId: THREAD_A, model: null,
    lastUsage: { at: REPORT_TIME, status: "completed", tokens: TOKENS } });
  const task = app.handler(message("任务"));
  await new Promise(setImmediate);
  await app.handler(message("/usage"));
  assert.match(app.sent.at(-1).text, /当前任务仍在运行/);
  assert.match(app.sent.at(-1).text, /输入：100/);
  await app.handler(message("/usage", { chat: 2 }));
  assert.match(app.sent.at(-1).text, /暂无报告/);
  finish({ ok: true, text: "done", usage: TOKENS });
  await task;
});

test("usage persistence failure preserves the task answer and warns before further work", async () => {
  const store = newStore();
  const save = store.set.bind(store);
  store.set = (key, value) => {
    if (value.lastUsage) throw new Error("synthetic private diagnostic");
    save(key, value);
  };
  const app = fixture({ store });
  await app.handler(message("任务"));
  assert.match(app.sent.at(-1).text, /模拟回答/);
  assert.match(app.sent.at(-1).text, /用量保存失败/);
  await app.handler(message("第二轮"));
  assert.equal(app.calls.length, 1);
  assert.ok(app.logs.every((line) => !line.includes("synthetic private diagnostic")));
});

test("invalid persisted usage is rejected instead of silently replacing a store", () => {
  const store = newStore();
  assert.throws(() => store.set("1:0:42", { threadId: THREAD_A, model: null,
    lastUsage: { at: "invalid", status: "completed", tokens: TOKENS } }));
  assert.throws(() => store.set("1:0:42", { threadId: THREAD_A, model: null,
    lastUsage: { at: REPORT_TIME, status: "completed", tokens: { ...TOKENS, inputTokens: -1 } } }));
});

const QUOTA_RESPONSE = { rateLimits: { limitId: "codex", primary: {
  usedPercent: 25, windowDurationMins: 300, resetsAt: Date.parse(REPORT_TIME) / 1000,
}, secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: null } } };

function quotaSpawn({ account = { type: "chatgpt", email: "user@example.com" },
                      result = QUOTA_RESPONSE, errorAt, errorCode = -32601,
                      hangAt, malformed = false, ignoreEof = false, ignoreTerm = false } = {}) {
  const requests = [];
  const signals = [];
  const calls = [];
  const fn = (bin, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    calls.push({ bin, args, options });
    let input = "";
    child.kill = (signal) => {
      signals.push(signal);
      if (ignoreTerm && signal === "SIGTERM") return true;
      setImmediate(() => child.emit("close", null));
      return true;
    };
    child.stdin.on("finish", () => {
      if (!ignoreEof) setImmediate(() => { child.stdout.end(); child.emit("close", 0); });
    });
    child.stdin.on("data", (chunk) => {
      input += chunk.toString();
      let newline;
      while ((newline = input.indexOf("\n")) !== -1) {
        const message = JSON.parse(input.slice(0, newline));
        input = input.slice(newline + 1);
        requests.push(message);
        if (message.id === undefined || message.method === hangAt) continue;
        const response = message.method === errorAt
          ? { id: message.id, error: { code: errorCode, message: "synthetic private diagnostic" } }
          : { id: message.id, result: message.method === "initialize" ? { userAgent: "synthetic" }
            : message.method === "account/read" ? { account, requiresOpenaiAuth: true } : result };
        setImmediate(() => {
          child.stderr.write("synthetic private diagnostic");
          const raw = Buffer.from(malformed ? "not-json\n" :
            JSON.stringify({ method: "unrelated/notification", params: { text: "中文" } }) + "\n" + JSON.stringify(response) + "\n");
          const split = raw.indexOf(Buffer.from("文")) + 1;
          child.stdout.write(raw.subarray(0, split));
          child.stdout.write(raw.subarray(split));
        });
      }
    });
    return child;
  };
  return { fn, requests, signals, calls };
}
function readQuota(mock, overrides = {}) {
  return queryQuota({ bin: "/synthetic/codex", workdir: context.workdir,
    env: { TELEGRAM_BOT_TOKEN: "synthetic_bot_credential", CODEX_HOME: context.codexHome },
    timeoutMs: 1000, ...overrides }, mock.fn);
}

test("quota query performs the official handshake and only account read methods", async () => {
  const mock = quotaSpawn();
  const result = await readQuota(mock);
  assert.equal(result.ok, true);
  assert.deepEqual(mock.requests.map((request) => request.method),
    ["initialize", "initialized", "account/read", "account/rateLimits/read"]);
  assert.equal(mock.requests[2].params.refreshToken, false);
  assert.deepEqual(mock.calls[0].args, ["app-server"]);
  assert.equal(mock.calls[0].options.shell, false);
  assert.equal(mock.calls[0].options.env.TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(mock.calls[0].options.env.CODEX_HOME, context.codexHome);
  assert.equal(JSON.stringify(result).includes("user@example.com"), false);
  assert.equal(JSON.stringify(result).includes("synthetic private diagnostic"), false);
  assert.deepEqual(mock.signals, []);
});

test("quota output calculates remaining percent, preserves zero, and formats reset time in Shanghai", async () => {
  const text = formatQuota(await readQuota(quotaSpawn()));
  assert.match(text, /已用 25%，剩余 75%/);
  assert.match(text, /已用 0%，剩余 100%/);
  assert.match(text, /主窗口（5 小时）/);
  assert.match(text, /次窗口（7 天）/);
  assert.match(text, /09:00:00（北京时间）/);
  assert.match(text, /重置时间：未知/);
});

test("quota prefers all returned buckets over a legacy single bucket", () => {
  const normalized = normalizeQuota({ ...QUOTA_RESPONSE, rateLimitsByLimitId: {
    codex_a: { ...QUOTA_RESPONSE.rateLimits, limitId: "codex_a" },
    codex_b: { limitId: "codex_b", primary: { usedPercent: 110, windowDurationMins: 60 } },
  } });
  assert.deepEqual(normalized.buckets.map((bucket) => bucket.name), ["codex_a", "codex_b"]);
  const text = formatQuota({ ok: true, ...normalized, queriedAt: REPORT_TIME });
  assert.match(text, /已用 110%，剩余 0%/);
  assert.equal(normalizeQuota({ ...QUOTA_RESPONSE, rateLimitsByLimitId: {} }).buckets.length, 1);
});

test("missing and malformed quota metrics stay unknown rather than turning into zero", async () => {
  const absent = formatQuota(await readQuota(quotaSpawn({ result: { rateLimits: null } })));
  assert.match(absent, /暂未返回额度数据/);
  const invalid = normalizeQuota({ rateLimits: { limitId: "codex", primary: {
    usedPercent: "25", windowDurationMins: -1, resetsAt: "123",
  } } });
  const text = formatQuota({ ok: true, ...invalid, queriedAt: REPORT_TIME });
  assert.match(text, /已用 未知，剩余 未知/);
  assert.match(text, /重置时间：未知/);
});

test("not logged in and API-key/provider accounts do not query ChatGPT limits", async () => {
  for (const [account, kind] of [[null, "not_logged_in"], [{ type: "apiKey" }, "unsupported_auth"],
    [{ type: "amazonBedrock" }, "unsupported_auth"]]) {
    const mock = quotaSpawn({ account });
    const result = await readQuota(mock);
    assert.equal(result.kind, kind);
    assert.equal(mock.requests.some((request) => request.method === "account/rateLimits/read"), false);
  }
});

test("quota errors, protocol failures, and timeouts never expose raw diagnostics", async () => {
  for (const [options, kind] of [
    [{ errorAt: "account/rateLimits/read" }, "api_unavailable"],
    [{ errorAt: "account/read", errorCode: -32603 }, "query"],
    [{ malformed: true }, "protocol"],
    [{ hangAt: "initialize" }, "timeout"],
  ]) {
    const mock = quotaSpawn(options);
    const result = await readQuota(mock, { timeoutMs: 40 });
    assert.equal(result.kind, kind);
    assert.equal(JSON.stringify(result).includes("synthetic private diagnostic"), false);
    assert.equal(formatQuota(result).includes("synthetic private diagnostic"), false);
    assert.deepEqual(mock.signals, ["SIGTERM"]);
  }
});

test("quota helper is cleaned up when it ignores EOF and SIGTERM", async () => {
  const mock = quotaSpawn({ ignoreEof: true, ignoreTerm: true });
  const result = await readQuota(mock);
  assert.equal(result.ok, true);
  assert.deepEqual(mock.signals, ["SIGTERM", "SIGKILL"]);
});

test("usage and quota commands require authorization and quota never changes session state", async () => {
  let reads = 0;
  const app = fixture({ quotaReader: async () => { reads++; return { ok: true, ...normalizeQuota(QUOTA_RESPONSE), queriedAt: REPORT_TIME }; } });
  await app.handler(message("/usage", { user: 43 }));
  await app.handler(message("/quota", { user: 43 }));
  assert.equal(reads, 0);
  assert.equal(app.sent.at(-1).text, "未授权。");
  app.store.set("1:0:42", { threadId: THREAD_A, model: "model-a" });
  const before = fs.readFileSync(app.store.filename, "utf8");
  await app.handler(message("/quota@example_bot", { topic: 10 }));
  assert.equal(reads, 1);
  assert.equal(app.sent.at(-1).options.message_thread_id, 10);
  assert.equal(fs.readFileSync(app.store.filename, "utf8"), before);
  assert.equal(app.calls.length, 0);
});

test("concurrent quota commands share one fresh request and failures can be retried", async () => {
  let reads = 0;
  let finish;
  const app = fixture({ quotaReader: () => {
    reads++;
    return new Promise((resolve) => { finish = resolve; });
  } });
  const first = app.handler(message("/quota"));
  const second = app.handler(message("/quota", { chat: 2 }));
  await new Promise(setImmediate);
  assert.equal(reads, 1);
  finish({ ok: false, kind: "timeout" });
  await Promise.all([first, second]);
  assert.equal(app.sent.length, 2);
  const retry = app.handler(message("/quota"));
  await new Promise(setImmediate);
  assert.equal(reads, 2);
  finish({ ok: true, ...normalizeQuota(QUOTA_RESPONSE), queriedAt: REPORT_TIME });
  await retry;
  assert.match(app.sent.at(-1).text, /剩余 75%/);
});

test("an exception from the quota reader yields a safe reply", async () => {
  const app = fixture({ quotaReader: async () => { throw new Error("synthetic private diagnostic"); } });
  await app.handler(message("/quota"));
  assert.match(app.sent.at(-1).text, /额度查询失败/);
  assert.equal(app.sent.at(-1).text.includes("synthetic private diagnostic"), false);
});

test("Windows state replacement retries only EPERM and keeps retry duration bounded", () => {
  let calls = 0;
  const locked = Object.assign(new Error("synthetic lock"), { code: "EPERM" });
  replaceStateFile("synthetic-source", "synthetic-destination", () => {
    if (++calls < 3) throw locked;
  }, "win32");
  assert.equal(calls, 3);
  calls = 0;
  assert.throws(() => replaceStateFile("synthetic-source", "synthetic-destination", () => {
    calls++; throw locked;
  }, "linux"));
  assert.equal(calls, 1);
  calls = 0;
  assert.throws(() => replaceStateFile("synthetic-source", "synthetic-destination", () => {
    calls++; throw locked;
  }, "win32"));
  assert.equal(calls, 5);
});
