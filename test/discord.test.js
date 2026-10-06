const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createMessageHandler } = require("../index");
const { SessionStore } = require("../session-store");
const { runCodex } = require("../codex-runner");
const { loadDiscordConfig, createDiscordTransport, createDiscordDispatcher, registerCommands, COMMANDS } = require("../discord");
const { DiscordRest, DiscordGateway, gatewayUrl, INTENTS } = require("../discord-client");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..", ".test-artifacts");
fs.mkdirSync(root, { recursive: true });
const artifacts = fs.mkdtempSync(path.join(root, "discord-"));
const USER = "123456789012345678";
const BOT = "223456789012345678";
const APP = "323456789012345678";
const CHANNEL = "423456789012345678";
const OTHER = "523456789012345678";
const THREAD = "00000000-0000-0000-0000-000000000001";
let number = 0;
const environment = (extra = {}) => ({ DISCORD_BOT_TOKEN: "synthetic_discord_credential", DISCORD_ALLOWED_USER_ID: USER,
  DISCORD_CHANNEL_IDS: CHANNEL, DISCORD_APPLICATION_ID: APP, WORKDIR: artifacts,
  CODEX_HOME: path.join(artifacts, "codex-home"), SESSION_FILE: path.join(artifacts, `sessions-${++number}.json`), ...extra });
const ready = { user: { id: BOT, bot: true }, application: { id: APP } };
const message = (content, extra = {}) => ({ id: String(623456789012345678n + BigInt(++number)), channel_id: CHANNEL,
  author: { id: USER }, content, ...extra });
const interaction = (name, options = [], extra = {}) => ({ type: 2, id: String(723456789012345678n + BigInt(++number)),
  application_id: APP, channel_id: CHANNEL, token: "synthetic_interaction_credential", user: { id: USER },
  data: { name, options }, ...extra });

function fixture({ execute, env = {}, quotaReader } = {}) {
  const config = loadDiscordConfig(environment(env));
  const calls = [], runs = [], logs = [];
  const rest = { request: async (...args) => { calls.push(args); return {}; } };
  const store = new SessionStore(config.sessionFile, config);
  const runner = execute || (async (options) => {
    runs.push(options);
    options.onThread(options.threadId || THREAD);
    return { ok: true, text: "模拟回答", usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: null, reasoningOutputTokens: null } };
  });
  const logger = { log: (text) => logs.push(text), warn: (text) => logs.push(text), error: (text) => logs.push(text) };
  const handler = createMessageHandler({ config, store, transport: createDiscordTransport(rest), runner, quotaReader, logger });
  const dispatch = createDiscordDispatcher({ config, rest, handler, logger });
  return { config, calls, runs, logs, rest, store, handler, dispatch };
}

test("Discord config is independent of Telegram, validates access, and defaults to isolated state and workdir", () => {
  const config = loadDiscordConfig({ DISCORD_BOT_TOKEN: "synthetic_discord_credential", DISCORD_ALLOWED_USER_ID: USER });
  assert.equal(config.platform, "discord");
  assert.equal(config.allowDms, true);
  assert.deepEqual(config.channels, []);
  assert.equal(config.workdir, path.resolve("/home/codex/discord-workdir"));
  assert.equal(path.basename(config.sessionFile), "discord-sessions.json");
  for (const env of [{ DISCORD_CHANNEL_IDS: "invalid" }, { DISCORD_ALLOWED_USER_ID: "123abc" },
    { DISCORD_ALLOW_DMS: "yes" }, { CODEX_TIMEOUT_MS: "900000" },
    { SESSION_FILE: path.resolve(__dirname, "..", ".bot-state", "sessions.json") }, { DISCORD_APPLICATION_ID: "bad" }]) {
    assert.throws(() => loadDiscordConfig(environment(env)));
  }
  assert.throws(() => loadDiscordConfig({ TELEGRAM_BOT_TOKEN: "synthetic_telegram_credential", ALLOWED_USER_ID: USER }));
});

test("platform state rejects cross-platform files but reads legacy Telegram state", () => {
  const config = loadDiscordConfig(environment());
  const discord = new SessionStore(config.sessionFile, config);
  discord.set(`discord:${CHANNEL}:0:${USER}`, { threadId: THREAD, model: null });
  assert.throws(() => new SessionStore(config.sessionFile, { ...config, platform: "telegram" }));
  assert.throws(() => discord.set(`${CHANNEL}:0:${USER}`, { threadId: THREAD, model: null }));
  const filename = path.join(artifacts, `legacy-${++number}.json`);
  fs.writeFileSync(filename, JSON.stringify({ version: 1, workdir: config.workdir, codexHome: config.codexHome,
    sessions: { "1:0:42": { threadId: THREAD, model: null } } }));
  assert.throws(() => new SessionStore(filename, config));
  assert.equal(new SessionStore(filename, { ...config, platform: "telegram" }).get("1:0:42").threadId, THREAD);
  const original = JSON.parse(fs.readFileSync(filename, "utf8"));
  for (const platform of [null, "", false, "unknown"]) {
    fs.writeFileSync(filename, JSON.stringify({ ...original, platform }));
    assert.throws(() => new SessionStore(filename, { ...config, platform: "telegram" }));
  }
});

test("Discord text and slash commands resume the same persisted context after restart", async () => {
  const app = fixture();
  await app.dispatch("READY", ready);
  await app.dispatch("MESSAGE_CREATE", message("记住代号"));
  await app.dispatch("MESSAGE_CREATE", message("继续"));
  await app.dispatch("INTERACTION_CREATE", interaction("codex", [{ type: 3, name: "task", value: "再继续" }]));
  assert.equal(app.runs.length, 3);
  assert.equal(app.runs[1].threadId, THREAD);
  assert.equal(app.runs[2].threadId, THREAD);
  const restored = new SessionStore(app.config.sessionFile, app.config);
  assert.equal(restored.get(`discord:${CHANNEL}:0:${USER}`).threadId, THREAD);
  const callback = app.calls.find((call) => call[1].includes("/callback"));
  assert.equal(callback[2].type, 5);
  assert.equal(callback[2].data.flags, 64);
  assert.equal(callback[3].immediate, true);
  assert.ok(app.calls.some((call) => call[0] === "PATCH" && call[1].endsWith("/@original")));
});

test("Discord model, usage, quota, id, and new commands reuse the core without losing context", async () => {
  const app = fixture({ quotaReader: async () => ({ ok: true, queriedAt: new Date().toISOString(), buckets: [] }) });
  await app.dispatch("READY", ready);
  await app.dispatch("MESSAGE_CREATE", message("任务"));
  await app.dispatch("MESSAGE_CREATE", message("!model example-model"));
  await app.dispatch("MESSAGE_CREATE", message("继续"));
  assert.equal(app.runs[1].model, "example-model");
  assert.equal(app.runs[1].threadId, THREAD);
  await app.dispatch("MESSAGE_CREATE", message("!usage"));
  await app.dispatch("MESSAGE_CREATE", message("!quota"));
  await app.dispatch("MESSAGE_CREATE", message("!id"));
  const replies = app.calls.filter((call) => call[1].endsWith("/messages")).map((call) => call[2].content);
  assert.ok(replies.some((text) => text.includes("输入：10")));
  assert.ok(replies.some((text) => text.includes("账号额度")));
  assert.ok(replies.some((text) => text.includes(`Discord 用户 ID：${USER}`)));
  await app.dispatch("MESSAGE_CREATE", message("!new"));
  const state = app.store.get(`discord:${CHANNEL}:0:${USER}`);
  assert.equal(state.threadId, null);
  assert.equal(state.model, "example-model");
  assert.equal(state.lastUsage, null);
});

test("Discord authorization, channels, DMs, bots, webhook messages, and duplicate events fail closed", async () => {
  const app = fixture({ env: { DISCORD_ALLOW_DMS: "false" } });
  await app.dispatch("READY", ready);
  for (const extra of [{ author: { id: OTHER } }, { author: { id: USER, bot: true } }, { webhook_id: OTHER },
    { guild_id: OTHER, channel_id: OTHER }, {}, { content: "" }]) {
    await app.dispatch("MESSAGE_CREATE", message("任务", extra));
  }
  assert.equal(app.runs.length, 0);
  const guildMessage = message("任务", { guild_id: OTHER });
  await app.dispatch("MESSAGE_CREATE", guildMessage);
  await app.dispatch("MESSAGE_CREATE", guildMessage);
  assert.equal(app.runs.length, 1);
  await app.dispatch("INTERACTION_CREATE", interaction("codex", [], { guild_id: OTHER, member: { user: { id: OTHER } } }));
  await app.dispatch("INTERACTION_CREATE", interaction("codex", [], { guild_id: OTHER, channel_id: OTHER }));
  assert.equal(app.runs.length, 1);
  assert.ok(app.calls.some((call) => call[2]?.data?.content === "未授权。"));
  assert.ok(app.calls.some((call) => call[2]?.data?.content === "此频道或私聊未开放。"));
});

test("Discord snowflakes remain strings and channel/thread context is isolated", async () => {
  const app = fixture({ env: { DISCORD_CHANNEL_IDS: `${CHANNEL},${OTHER}` } });
  await app.dispatch("READY", ready);
  await app.dispatch("MESSAGE_CREATE", message("父频道", { guild_id: APP }));
  await app.dispatch("MESSAGE_CREATE", message("话题", { guild_id: APP, channel_id: OTHER }));
  assert.equal(app.runs[1].threadId, null);
  assert.ok(app.store.get(`discord:${OTHER}:0:${USER}`).threadId);
  assert.ok(app.calls.some((call) => call[1] === `/channels/${OTHER}/messages`));
});

test("Discord slash work only starts after a successful acknowledgement and deduplicates commands", async () => {
  const app = fixture();
  await app.dispatch("READY", ready);
  const event = interaction("codex", [{ type: 3, name: "task", value: "任务" }]);
  app.rest.request = async () => { throw new Error("synthetic_interaction_credential"); };
  await app.dispatch("INTERACTION_CREATE", event);
  await app.dispatch("INTERACTION_CREATE", event);
  assert.equal(app.runs.length, 0);
  assert.ok(app.logs.every((text) => !text.includes("synthetic_interaction_credential")));
  app.rest.request = async (...args) => { app.calls.push(args); return {}; };
  await app.dispatch("INTERACTION_CREATE", interaction("codex", [{ type: 4, name: "task", value: 1 }]));
  assert.equal(app.runs.length, 0);
  assert.ok(app.calls.some((call) => call[2]?.data?.content === "命令参数无效。"));
});

test("Discord long replies preserve Unicode, redact the bot token, and never ping users or roles", async () => {
  const app = fixture({ execute: async (options) => {
    options.onThread(THREAD);
    return { ok: true, text: "😀".repeat(2500) + " synthetic_discord_credential @everyone" };
  } });
  await app.dispatch("READY", ready);
  await app.dispatch("INTERACTION_CREATE", interaction("codex", [{ type: 3, name: "task", value: "任务" }]));
  const replies = app.calls.filter((call) => call[1].includes("/webhooks/"));
  assert.ok(replies.length > 1);
  for (const reply of replies) {
    assert.ok(reply[2].content.length <= 1900);
    assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(reply[2].content));
    assert.deepEqual(reply[2].allowed_mentions, { parse: [], replied_user: false });
    assert.ok(!reply[2].content.includes("synthetic_discord_credential"));
    if (reply[0] === "POST") assert.equal(reply[2].flags, 64);
  }
});

test("opaque interaction tokens are encoded as one URL path segment", async () => {
  const app = fixture();
  await app.dispatch("READY", ready);
  const token = "synthetic/opaque+credential==";
  await app.dispatch("INTERACTION_CREATE", interaction("status", [], { token }));
  assert.ok(app.calls.some((call) => call[1].includes(`${encodeURIComponent(token)}/callback`)));
  assert.ok(app.calls.some((call) => call[1].includes(`${encodeURIComponent(token)}/messages/@original`)));
  assert.ok(app.calls.every((call) => !call[1].includes(token)));
});

test("Discord REST serializes normal requests, retries only bounded 429, and preserves sensitive error privacy", async () => {
  const calls = [], waits = [];
  let attempt = 0;
  const rest = new DiscordRest("synthetic_discord_credential", { sleep: async (ms) => waits.push(ms),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: ++attempt > 1, status: attempt === 1 ? 429 : 200,
        text: async () => JSON.stringify(attempt === 1 ? { retry_after: 0.1 } : { id: CHANNEL }) };
    } });
  assert.deepEqual(await rest.request("GET", "/users/@me"), { id: CHANNEL });
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [200]);
  const fail = new DiscordRest("synthetic_discord_credential", { fetchImpl: async () => ({
    ok: false, status: 401, text: async () => JSON.stringify({ message: "synthetic_discord_credential" }),
  }) });
  await assert.rejects(fail.request("GET", "/users/@me"), (error) => error.status === 401 && !error.message.includes("credential"));
  let retried = 0;
  const ack = new DiscordRest("synthetic_discord_credential", { fetchImpl: async () => {
    retried++; return { ok: false, status: 429, text: async () => '{"retry_after":1}' };
  } });
  await assert.rejects(ack.request("POST", "/callback", {}, { immediate: true }));
  assert.equal(retried, 1);
});

class FakeSocket {
  static instances = [];
  constructor(url) { this.url = url; this.listeners = {}; this.sent = []; this.closes = []; FakeSocket.instances.push(this); }
  addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
  send(text) { this.sent.push(JSON.parse(text)); }
  close(code) { this.closes.push(code); this.emit("close", { code }); }
  emit(name, data) { for (const listener of this.listeners[name] || []) listener(data); }
  packet(op, d, extra = {}) { this.emit("message", { data: JSON.stringify({ op, d, ...extra }) }); }
}

function scheduler() {
  const pending = new Map();
  let index = 0;
  const add = (fn, ms, interval) => { pending.set(++index, { fn, ms, interval }); return index; };
  return {
    setTimeout: (fn, ms) => add(fn, ms, false), setInterval: (fn, ms) => add(fn, ms, true),
    clearTimeout: (id) => pending.delete(id), clearInterval: (id) => pending.delete(id), pending,
    run(predicate) {
      const entry = [...pending].find(([, value]) => predicate(value));
      assert.ok(entry, "expected timer");
      const [id, value] = entry;
      if (!value.interval) pending.delete(id);
      value.fn();
    },
  };
}
function gatewayFixture() {
  const timers = scheduler(), events = [], fatal = [], logs = [];
  const gateway = new DiscordGateway({ token: "synthetic_discord_credential", timers, random: () => 0, WebSocketImpl: FakeSocket,
    rest: { request: async () => ({ url: "wss://gateway.discord.gg", shards: 1, session_start_limit: { remaining: 10 } }) },
    onDispatch: (type, data) => events.push({ type, data }), onFatal: (kind) => fatal.push(kind),
    logger: { log: (value) => logs.push(value), error: (value) => logs.push(value) } });
  return { gateway, timers, events, fatal, logs };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("regional READY gateways connect and resume without exposing session credentials", async () => {
  for (const host of ["gateway-us-east1-b.discord.gg", "gateway-us-east1-c.discord.gg", "gateway-us-east1-d.discord.gg"]) {
    const app = gatewayFixture();
    await app.gateway.start();
    const socket = FakeSocket.instances.at(-1);
    socket.packet(10, { heartbeat_interval: 1000 });
    socket.packet(0, { ...ready, session_id: "synthetic_session", resume_gateway_url: `wss://${host}` }, { s: 1, t: "READY" });
    await tick();
    assert.deepEqual(app.fatal, []);
    assert.equal(app.events[0].type, "READY");
    socket.packet(7, null);
    app.timers.run((timer) => !timer.interval && timer.ms === 1000);
    const resumed = FakeSocket.instances.at(-1);
    assert.equal(resumed.url, `wss://${host}/?v=10&encoding=json`);
    resumed.packet(10, { heartbeat_interval: 1000 });
    assert.deepEqual(resumed.sent[0], { op: 6, d: { token: "synthetic_discord_credential", session_id: "synthetic_session", seq: 1 } });
    assert.ok(app.logs.every((line) => !line.includes("synthetic_session") && !line.includes("synthetic_discord_credential")));
    app.gateway.stop();
    assert.equal(app.timers.pending.size, 0);
  }
});

test("Discord Gateway identifies, heartbeats, resumes with the last sequence, and drops duplicate dispatches", async () => {
  const app = gatewayFixture();
  await app.gateway.start();
  const socket = FakeSocket.instances.at(-1);
  socket.packet(10, { heartbeat_interval: 1000 });
  assert.equal(socket.sent[0].op, 2);
  assert.equal(socket.sent[0].d.intents, INTENTS);
  socket.packet(0, { ...ready, session_id: "synthetic_session", resume_gateway_url: "wss://region.gateway.discord.gg" }, { s: 1, t: "READY" });
  app.timers.run((timer) => timer.ms === 0);
  assert.deepEqual(socket.sent.at(-1), { op: 1, d: 1 });
  socket.packet(11, null);
  socket.packet(7, null);
  app.timers.run((timer) => !timer.interval && timer.ms === 1000);
  const resumed = FakeSocket.instances.at(-1);
  assert.ok(resumed.url.includes("region.gateway.discord.gg"));
  resumed.packet(10, { heartbeat_interval: 1000 });
  assert.deepEqual(resumed.sent[0], { op: 6, d: { token: "synthetic_discord_credential", session_id: "synthetic_session", seq: 1 } });
  resumed.packet(0, {}, { s: 2, t: "RESUMED" });
  resumed.packet(0, {}, { s: 3, t: "MESSAGE_CREATE" });
  resumed.packet(0, {}, { s: 3, t: "MESSAGE_CREATE" });
  await tick();
  assert.equal(app.events.filter((event) => event.type === "MESSAGE_CREATE").length, 1);
  app.gateway.stop();
  assert.equal(app.timers.pending.size, 0);
});

test("Discord Gateway reconnects a missing heartbeat ACK and stops on disallowed intents or authentication", async () => {
  const app = gatewayFixture();
  await app.gateway.start();
  const socket = FakeSocket.instances.at(-1);
  socket.packet(10, { heartbeat_interval: 1000 });
  app.timers.run((timer) => timer.ms === 0);
  app.timers.run((timer) => timer.interval);
  assert.ok(socket.closes.includes(4000));
  app.timers.run((timer) => !timer.interval && timer.ms < 30000);
  const next = FakeSocket.instances.at(-1);
  next.emit("close", { code: 4014, reason: "synthetic_discord_credential" });
  assert.deepEqual(app.fatal, ["close_4014"]);
  assert.ok(app.logs.every((text) => !text.includes("credential")));
  assert.equal(app.timers.pending.size, 0);
});

test("Discord Gateway rejects credential-exfiltrating URLs and session/shard limits before connecting", async () => {
  for (const url of ["wss://evil.example", "ws://gateway.discord.gg", "wss://gateway.discord.gg.evil.example", "wss://your_username:your_password_here@gateway.discord.gg",
    "wss://gateway-us-east1-b.discord.gg.evil.example", "wss://gateway-us-east1-b.evil.example",
    "wss://evil-discord.gg", "wss://gateway-.discord.gg", "wss://gateway--us-east1-b.discord.gg",
    "wss://gateway-us-east1-b.discord.gg:8443", "ws://gateway-us-east1-b.discord.gg",
    "wss://your_username:your_password_here@gateway-us-east1-b.discord.gg"]) {
    assert.throws(() => gatewayUrl(url));
  }
  const app = gatewayFixture();
  app.gateway.rest.request = async () => ({ url: "wss://gateway.discord.gg", shards: 1, session_start_limit: { remaining: 0 } });
  await assert.rejects(app.gateway.start());
  app.gateway.rest.request = async () => ({ url: "wss://gateway.discord.gg", shards: 2, session_start_limit: { remaining: 10 } });
  await assert.rejects(app.gateway.start());
});

test("malformed READY fields stop with distinct safe diagnostics and never dispatch READY", async () => {
  const cases = [
    [null, "ready_session_id"],
    [{ ...ready, session_id: "", resume_gateway_url: "wss://gateway.discord.gg" }, "ready_session_id"],
    [{ ...ready, session_id: 123, resume_gateway_url: "wss://gateway.discord.gg" }, "ready_session_id"],
    [{ ...ready, session_id: "synthetic_session" }, "ready_gateway_url"],
    [{ ...ready, session_id: "synthetic_session", resume_gateway_url: "wss://evil.example/synthetic_discord_credential" }, "ready_gateway_url"],
  ];
  for (const [data, kind] of cases) {
    const app = gatewayFixture();
    await app.gateway.start();
    const socket = FakeSocket.instances.at(-1);
    socket.packet(10, { heartbeat_interval: 1000 });
    socket.packet(0, data, { s: 1, t: "READY" });
    await tick();
    assert.deepEqual(app.fatal, [kind]);
    assert.deepEqual(app.events, []);
    assert.equal(app.gateway.sessionId, null);
    assert.equal(app.gateway.resumeUrl, null);
    assert.equal(app.timers.pending.size, 0);
    assert.deepEqual(socket.closes, [1000]);
    assert.deepEqual(app.logs, [`Discord gateway stopped: ${kind}.`]);
  }
});

test("slash registration previews without network and backs up before individual upserts", async () => {
  const config = loadDiscordConfig(environment());
  const calls = [];
  const backupRoot = path.join(artifacts, "command-backups");
  const rest = { request: async (method, route, body) => {
    calls.push({ method, route, body });
    if (route === "/applications/@me") return { id: APP };
    if (method === "GET") return [{ name: "unrelated-command" }];
    assert.equal(fs.readdirSync(backupRoot).length, 1, "backup must exist before registration");
    return {};
  } };
  assert.deepEqual(await registerCommands(config, rest), COMMANDS);
  assert.equal(calls.length, 0);
  const result = await registerCommands(config, rest, { apply: true, backupRoot });
  assert.equal(result.count, 9);
  assert.deepEqual(JSON.parse(fs.readFileSync(result.backup, "utf8")), [{ name: "unrelated-command" }]);
  assert.equal(calls.filter((call) => call.method === "POST").length, 9);
  assert.equal(calls.filter((call) => ["DELETE", "PUT"].includes(call.method)).length, 0);
});

test("Codex child receives neither platform's bot credentials", async () => {
  let childEnv;
  const result = await runCodex({ bin: "mock", workdir: artifacts, env: {
    TELEGRAM_BOT_TOKEN: "synthetic_telegram_credential", DISCORD_BOT_TOKEN: "synthetic_discord_credential",
    DISCORD_ALLOWED_USER_ID: USER, ALLOWED_USER_ID: "42",
  }, prompt: "任务", timeoutMs: 1000, onThread: () => {} }, (_, __, options) => {
    childEnv = options.env;
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => {};
    child.stdin.on("finish", () => setImmediate(() => {
      child.stdout.write(JSON.stringify({ type: "thread.started", thread_id: THREAD }) + "\n");
      child.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\n");
      child.emit("close", 0);
    }));
    return child;
  });
  assert.equal(result.ok, true);
  assert.equal(childEnv.TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(childEnv.DISCORD_BOT_TOKEN, undefined);
  assert.equal(childEnv.DISCORD_ALLOWED_USER_ID, undefined);
  assert.equal(childEnv.ALLOWED_USER_ID, undefined);
});

test("Discord busy tasks reject new work while status remains available", async () => {
  let finish;
  const app = fixture({ execute: (options) => {
    options.onThread(THREAD);
    return new Promise((resolve) => { finish = resolve; });
  } });
  await app.dispatch("READY", ready);
  const first = app.dispatch("MESSAGE_CREATE", message("长任务"));
  await tick();
  await app.dispatch("INTERACTION_CREATE", interaction("codex", [{ type: 3, name: "task", value: "另一个任务" }]));
  await app.dispatch("MESSAGE_CREATE", message("!status"));
  assert.ok(app.calls.some((call) => call[2]?.content?.includes("正在处理上一条")));
  assert.ok(app.calls.some((call) => call[2]?.content?.includes("状态：正在处理")));
  finish({ ok: true, text: "完成" });
  await first;
});

test("interaction ACK bypasses a blocked ordinary REST request", async () => {
  let finish;
  const order = [];
  const rest = new DiscordRest("synthetic_discord_credential", { fetchImpl: async (url) => {
    order.push(url);
    if (url.endsWith("/messages")) await new Promise((resolve) => { finish = resolve; });
    return { ok: true, status: 204, text: async () => "" };
  } });
  const sending = rest.request("POST", "/messages", { content: "任务结果" });
  await tick();
  await rest.request("POST", "/callback", { type: 5 }, { immediate: true });
  assert.equal(order.length, 2);
  finish();
  await sending;
});

test("invalid Gateway session starts fresh and stale sockets cannot dispatch events", async () => {
  const app = gatewayFixture();
  await app.gateway.start();
  const old = FakeSocket.instances.at(-1);
  old.packet(10, { heartbeat_interval: 1000 });
  old.packet(0, { ...ready, session_id: "synthetic_session", resume_gateway_url: "wss://gateway.discord.gg" }, { s: 10, t: "READY" });
  await tick();
  old.packet(9, false);
  old.packet(0, {}, { s: 11, t: "MESSAGE_CREATE" });
  app.timers.run((timer) => !timer.interval && timer.ms < 30000);
  const fresh = FakeSocket.instances.at(-1);
  fresh.packet(10, { heartbeat_interval: 1000 });
  assert.equal(fresh.sent[0].op, 2);
  assert.equal(app.gateway.sequence, null);
  await tick();
  assert.equal(app.events.filter((event) => event.type === "MESSAGE_CREATE").length, 0);
  app.gateway.stop();
});

test("Gateway fails closed when READY identity handling fails", async () => {
  const app = gatewayFixture();
  app.gateway.onDispatch = async () => { throw new Error("synthetic_discord_credential"); };
  await app.gateway.start();
  const socket = FakeSocket.instances.at(-1);
  socket.packet(10, { heartbeat_interval: 1000 });
  socket.packet(0, { ...ready, session_id: "synthetic_session", resume_gateway_url: "wss://gateway.discord.gg" }, { s: 1, t: "READY" });
  await tick();
  assert.deepEqual(app.fatal, ["identity"]);
  assert.equal(app.timers.pending.size, 0);
  assert.ok(app.logs.every((line) => !line.includes("credential")));
});

test("Discord CLI preview needs no credentials, and config check writes no state or contacts APIs", () => {
  const script = path.join(__dirname, "..", "discord.js");
  const config = environment({ CODEX_BIN: process.execPath });
  const filename = path.join(artifacts, `private-config-${++number}.env`);
  fs.writeFileSync(filename, Object.entries(config).map(([key, value]) => `${key}=${value}`).join("\n"));
  const minimalEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  const preview = spawnSync(process.execPath, [script, "--register-commands"], { env: minimalEnv, encoding: "utf8" });
  assert.equal(preview.status, 0);
  assert.deepEqual(JSON.parse(preview.stdout), COMMANDS);
  const checked = spawnSync(process.execPath, [script, "--check-config"], {
    env: { ...minimalEnv, DISCORD_ENV_FILE: filename }, encoding: "utf8",
  });
  assert.equal(checked.status, 0);
  assert.ok(checked.stdout.includes("no network requests or state writes"));
  assert.equal(fs.existsSync(config.SESSION_FILE), false);
  assert.ok(!checked.stdout.includes(config.DISCORD_BOT_TOKEN));
  const badArgs = spawnSync(process.execPath, [script, "--register-commands", "--unknown"], { env: minimalEnv, encoding: "utf8" });
  assert.equal(badArgs.status, 1);
  assert.ok(badArgs.stderr.includes("arguments"));
});
