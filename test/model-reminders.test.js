const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ReminderScheduler, parseTime } = require("../reminders");
const { prepareTurn, applyResponse } = require("../semantic-reminders");
const { createReminderGenerator, configuredMcpServers } = require("../reminder-generation");
const { buildArgs } = require("../codex-runner");

const root = path.resolve(__dirname, "..", ".test-artifacts");
fs.mkdirSync(root, { recursive: true });
const directory = fs.mkdtempSync(path.join(root, "model-reminders-"));
let sequence = 0;
function fixture(extra = {}) {
  let now = parseTime("2026-10-19 08:00");
  const sent = [], calls = [], logs = [];
  const options = { filename: path.join(directory, `state-${++sequence}.json`), platform: "telegram", userId: "42",
    now: () => now, send: async (...args) => sent.push(args),
    generate: async task => { calls.push(task); return `第${calls.length}次生成的简短回复。`; },
    logger: { error: message => logs.push(message) }, ...extra };
  return { scheduler: new ReminderScheduler(options), options, sent, calls, logs, at: value => { now = parseTime(value); } };
}
const entry = (generation = "model", kind = "daily", time = "09:00", text = "写一句早安问候", id = "") => ({ id, kind, time, text, generation });
function apply(app, entries, action = "create", model = "chosen-model") {
  const turn = prepareTurn({ scheduler: app.scheduler, text: "测试请求", privateChat: true, model });
  return applyResponse(JSON.stringify({ nonce: turn.nonce, action, message: "", delivery: "current", entries }), turn, app.scheduler);
}
async function drain(app) { if (app.scheduler.modelRun) await app.scheduler.modelRun; }

test("ordinary content mentioning models stays literal, costs no generation calls and retains v1 storage", async () => {
  const app = fixture();
  assert.match(apply(app, [entry("static", "daily", "09:00", "调用模型是提醒正文")]), /已保存/);
  assert.equal(Object.hasOwn(app.scheduler.items[0], "generation"), false);
  app.at("2026-10-19 09:00"); await app.scheduler.tick();
  assert.equal(app.calls.length, 0); assert.equal(app.sent.length, 1);
  assert.ok(app.sent[0][1].endsWith("调用模型是提醒正文"));
  assert.equal(JSON.parse(fs.readFileSync(app.options.filename)).version, 1);
  assert.equal(Object.keys(app.scheduler.items[0]).length, 9);
  const native = fixture(); native.scheduler.add("daily 09:00 调用模型");
  assert.equal(Object.hasOwn(native.scheduler.items[0], "generation"), false);
});

test("each occurrence generates fresh text after a persisted claim, with the captured model and original ID", async () => {
  const app = fixture();
  const generate = app.scheduler.generate;
  app.scheduler.generate = task => {
    const stored = JSON.parse(fs.readFileSync(app.options.filename));
    assert.equal(stored.version, 3); assert.equal(stored.items[0].status, "sending");
    return generate(task);
  };
  assert.match(apply(app, [entry()]), /触发时调用模型：chosen-model/);
  const id = app.scheduler.items[0].id;
  for (const date of ["2026-10-19", "2026-10-20"]) {
    app.at(date + " 09:00"); await app.scheduler.tick(); await drain(app);
    await app.scheduler.tick();
  }
  assert.equal(app.calls.length, 2); assert.equal(app.sent.length, 2);
  assert.notEqual(app.sent[0][1], app.sent[1][1]);
  assert.ok(app.calls.every(task => task.id === id && task.generation.model === "chosen-model"));
  assert.ok(app.sent.every(([user, text]) => user === "42" && !text.includes("写一句早安问候")));
  const restored = new ReminderScheduler(app.options);
  assert.deepEqual(restored.items, app.scheduler.items);
  assert.match(restored.list(), /触发时调用模型：chosen-model/);
});

test("model reminders obey the nonworking calendar, skip makeup workdays and pause outside covered years", async () => {
  const app = fixture(); app.at("2026-10-09 20:00");
  assert.match(apply(app, [entry("model", "nonworking", "06:01")]), /已保存/);
  app.at("2026-10-10 06:01"); await app.scheduler.tick(); await drain(app);
  assert.equal(app.calls.length, 0);
  app.at("2026-10-11 06:01"); await app.scheduler.tick(); await drain(app);
  assert.equal(app.calls.length, 1); assert.equal(app.sent.length, 1);
  assert.equal(app.scheduler.items[0].nextAt, "2026-10-16T22:01:00.000Z");
  const boundary = fixture(); boundary.at("2026-12-26 20:00");
  apply(boundary, [entry("model", "nonworking", "06:01")]);
  boundary.at("2026-12-27 06:01"); await boundary.scheduler.tick(); await drain(boundary);
  assert.equal(boundary.calls.length, 1); assert.equal(boundary.scheduler.items[0].status, "calendar_wait");
  boundary.at("2027-01-02 06:01"); await boundary.scheduler.tick(); await drain(boundary);
  assert.equal(boundary.calls.length, 1); assert.equal(boundary.scheduler.failed, false);
});

test("a waiting model does not block ordinary reminders, concurrent ticks do not duplicate it, and model jobs serialize", async () => {
  let finish;
  const app = fixture({ generate: task => { app.calls.push(task); return new Promise(resolve => { finish = resolve; }); } });
  apply(app, [entry(), entry("model", "daily", "09:00", "写另一句问候"), entry("static", "daily", "09:01", "普通消息")]);
  app.at("2026-10-19 09:00"); await app.scheduler.tick();
  assert.equal(app.calls.length, 1);
  assert.equal(app.scheduler.items.filter(task => task.status === "sending").length, 1);
  app.at("2026-10-19 09:01"); await Promise.all([app.scheduler.tick(), app.scheduler.tick()]);
  assert.equal(app.sent.length, 1); assert.ok(app.sent[0][1].endsWith("普通消息"));
  assert.equal(app.calls.length, 1);
  finish("完成第一条。"); await drain(app);
  await app.scheduler.tick(); assert.equal(app.calls.length, 2);
  finish("完成第二条。"); await drain(app);
  assert.equal(app.sent.length, 3);
});

test("time/content edits retain generation and model, explicit mode changes are persisted and cancellation prevents generation", async () => {
  const app = fixture(); apply(app, [entry()]); const id = app.scheduler.items[0].id;
  assert.match(apply(app, [entry("", "", "10:00", "", id)], "update", "new-model"), /已修改/);
  assert.deepEqual(app.scheduler.items[0].generation, { model: "chosen-model" });
  assert.match(apply(app, [entry("model", "", "", "换一句问候", id)], "update", "new-model"), /已修改/);
  assert.deepEqual(app.scheduler.items[0].generation, { model: "new-model" });
  assert.match(apply(app, [entry("static", "", "", "固定问候", id)], "update"), /已修改/);
  assert.equal(Object.hasOwn(app.scheduler.items[0], "generation"), false);
  assert.equal(JSON.parse(fs.readFileSync(app.options.filename)).version, 1);
  apply(app, [entry("model", "", "", "模型要求", id)], "update");
  assert.match(apply(app, [entry("", "", "", "", id)], "cancel"), /已取消/);
  app.at("2026-10-19 10:00"); await app.scheduler.tick(); await drain(app);
  assert.equal(app.calls.length, 0); assert.equal(app.sent.length, 0);
});

test("unsupported Discord generation rejects an entire mixed plan while ordinary Discord reminders keep working", async () => {
  const app = fixture({ platform: "discord" });
  assert.doesNotMatch(apply(app, [entry("static"), entry("model", "daily", "10:00")]), /已保存/);
  assert.equal(app.scheduler.items.length, 0); assert.equal(fs.existsSync(app.options.filename), false);
  assert.match(apply(app, [entry("static")]), /已保存/);
  app.at("2026-10-19 09:00"); await app.scheduler.tick();
  assert.equal(app.calls.length, 0); assert.equal(app.sent.length, 1);
});

test("generation failure/empty output never sends the prompt or retries an occurrence; recurring jobs resume next day", async () => {
  for (const output of [null, "", " ", "x".repeat(4001), new Error("synthetic private failure")]) {
    const app = fixture({ generate: async () => { if (output instanceof Error) throw output; return output; } });
    apply(app, [entry("model", "once", "2026-10-19 09:00")]);
    app.at("2026-10-19 09:00"); await app.scheduler.tick(); await drain(app); await app.scheduler.tick();
    assert.equal(app.sent.length, 0); assert.equal(app.scheduler.items[0].status, "failed");
    assert.equal(app.scheduler.items[0].lastResult, "generation_failed");
    assert.match(app.scheduler.list(), /模型生成失败/);
    assert.ok(app.logs.every(line => !line.includes("synthetic private")));
    assert.equal(new ReminderScheduler(app.options).items[0].status, "failed");
  }
  const recurring = fixture({ generate: async () => { throw new Error(); } });
  apply(recurring, [entry()]); recurring.at("2026-10-19 09:00");
  await recurring.scheduler.tick(); await drain(recurring);
  assert.equal(recurring.scheduler.items[0].status, "pending");
  assert.equal(recurring.scheduler.items[0].nextAt, "2026-10-20T01:00:00.000Z");
  assert.equal(recurring.scheduler.failed, false);
});

test("generated replies are redacted, single-line and short; an ambiguous send never regenerates or resends", async () => {
  const app = fixture({ generate: async () => "SYNTHETIC_SECRET\n" + "😀".repeat(150),
    sanitize: text => text.replaceAll("SYNTHETIC_SECRET", "[REDACTED]") });
  apply(app, [entry("model", "once", "2026-10-19 09:00")]); app.at("2026-10-19 09:00");
  await app.scheduler.tick(); await drain(app);
  const body = app.sent[0][1].split("\n").slice(2).join("\n");
  assert.ok(body.startsWith("[REDACTED] ")); assert.equal(Array.from(body).length, 120);
  assert.equal(body.includes("\n"), false); assert.equal(body.includes("SYNTHETIC_SECRET"), false);
  const uncertain = fixture({ send: async () => { throw new Error(); } });
  apply(uncertain, [entry("model", "once", "2026-10-19 09:00")]); uncertain.at("2026-10-19 09:00");
  await uncertain.scheduler.tick(); await drain(uncertain); await uncertain.scheduler.tick();
  assert.equal(uncertain.calls.length, 1); assert.equal(uncertain.scheduler.items[0].status, "uncertain");
});

test("restart preserves an in-flight generation claim as uncertain and shutdown prevents a late send", async () => {
  let finish;
  const app = fixture({ generate: () => new Promise(resolve => { finish = resolve; }) });
  apply(app, [entry("model", "once", "2026-10-19 09:00")]); app.at("2026-10-19 09:00"); await app.scheduler.tick();
  const restored = new ReminderScheduler({ ...app.options, generate: async () => { throw new Error("must not regenerate"); } });
  await restored.tick(); assert.equal(restored.items[0].status, "uncertain");
  app.scheduler.stop(); finish("晚到的回复。"); await drain(app);
  assert.equal(app.sent.length, 0);
});

test("a failed claim write prevents model calls; state validation rejects forged generation records without overwriting them", async () => {
  const app = fixture(); apply(app, [entry()]);
  app.scheduler.persist = () => { throw new Error(); };
  app.at("2026-10-19 09:00"); await app.scheduler.tick();
  assert.equal(app.calls.length, 0); assert.equal(app.scheduler.failed, true);
  for (const mutate of [data => { data.version = 2; }, data => { data.items[0].generation.model = "invalid model"; },
    data => { data.items[0].generation.shell = "untrusted"; }]) {
    const copy = fixture(); apply(copy, [entry()]); const data = JSON.parse(fs.readFileSync(copy.options.filename)); mutate(data);
    const content = JSON.stringify(data); fs.writeFileSync(copy.options.filename, content);
    assert.throws(() => new ReminderScheduler(copy.options));
    assert.equal(fs.readFileSync(copy.options.filename, "utf8"), content);
  }
});

test("a failed completion write after a generated send pauses scheduling and restart never replays the claimed occurrence", async () => {
  const app = fixture(); apply(app, [entry("model", "once", "2026-10-19 09:00")]);
  const persist = app.scheduler.persist.bind(app.scheduler);
  app.scheduler.persist = items => {
    if (items[0].status !== "sending") throw new Error("synthetic completion write failure");
    persist(items);
  };
  app.at("2026-10-19 09:00"); await app.scheduler.tick(); await drain(app);
  assert.equal(app.sent.length, 1); assert.equal(app.scheduler.failed, true);
  assert.equal(JSON.parse(fs.readFileSync(app.options.filename)).items[0].status, "sending");
  const restored = new ReminderScheduler(app.options);
  await restored.tick();
  assert.equal(restored.items[0].status, "uncertain");
  assert.equal(app.calls.length, 1); assert.equal(app.sent.length, 1);
});

test("model invocation uses a fresh bounded read-only session, disables configured MCP/tools and does not pass Bot credentials", async () => {
  const calls = [], config = { platform: "telegram", bin: "/synthetic/codex", sessionFile: path.join(directory, "session.json"),
    codexHome: path.join(directory, "home"), timeoutMs: 120000,
    env: { TELEGRAM_BOT_TOKEN: "synthetic_tg", DISCORD_BOT_TOKEN: "synthetic_dc", ALLOWED_USER_ID: "42", DISCORD_ALLOWED_USER_ID: "43" } };
  const generate = createReminderGenerator(config, {
    now: () => parseTime("2026-10-19 09:00"),
    execute: (bin, args, options, callback) => {
      assert.equal(bin, config.bin); assert.deepEqual(args, ["mcp", "list", "--json"]);
      assert.equal(options.env.TELEGRAM_BOT_TOKEN, undefined); assert.ok(options.timeout <= 10000);
      callback(null, JSON.stringify([{ name: "test-server", transport: { type: "stdio", command: "private-command", env: { PRIVATE_VALUE: "synthetic" } } },
        { name: "http-server", transport: { type: "streamable_http", url: "https://example.invalid/private" } }]));
    },
    runner: async options => { calls.push(options); options.onThread("00000000-0000-0000-0000-000000000001");
      return { ok: true, text: '{"reply":"早上好。"}' }; },
  });
  assert.equal(await generate({ text: "写一句问候", nextAt: "2026-10-19T01:00:00.000Z", generation: { model: "chosen-model" } }), "早上好。");
  const options = calls[0], args = buildArgs(options);
  assert.equal(options.threadId, undefined); assert.equal(options.model, "chosen-model");
  assert.ok(options.timeoutMs <= 60000); assert.equal(options.env.DISCORD_BOT_TOKEN, undefined);
  assert.equal(options.env.CODEX_HOME, config.codexHome);
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  assert.ok(args.includes("--ephemeral") && args.includes('mcp_servers.test-server={command="__codex_bot_disabled_mcp__",enabled=false,required=false}'));
  assert.ok(args.includes('mcp_servers.http-server={url="http://127.0.0.1:9",enabled=false,required=false}'));
  assert.equal(args.join(" ").includes("private-command"), false);
  assert.equal(args.join(" ").includes("example.invalid/private"), false);
  assert.ok(args.includes('approval_policy="never"') && args.includes('web_search="disabled"'));
  assert.ok(args.includes("shell_tool") && args.includes("hooks") && args.includes("plugins") && args.includes("apps"));
  assert.equal(args.at(-1), "-"); assert.equal(args.includes("resume"), false);
  assert.equal(JSON.parse(fs.readFileSync(options.outputSchema)).properties.reply.type, "string");
  assert.equal(fs.existsSync(config.sessionFile), false);
});

test("invalid configuration/model responses fail closed without raw diagnostic values", async () => {
  const restricted = createReminderGenerator({ platform: "telegram", models: ["allowed-model"] }, {
    execute: () => assert.fail("must not read config for a disallowed model"),
    runner: () => assert.fail("must not launch a disallowed model"),
  });
  await assert.rejects(restricted({ generation: { model: "removed-model" } }));
  await assert.rejects(configuredMcpServers("synthetic", {}, (_bin, _args, _options, cb) => cb(new Error("private synthetic value"))),
    error => !error.message.includes("private synthetic"));
  await assert.rejects(configuredMcpServers("synthetic", {}, (_bin, _args, _options, cb) => cb(null, "{}")));
  await assert.rejects(configuredMcpServers("synthetic", {}, (_bin, _args, _options, cb) => cb(null, '[{"name":"unsupported.server"}]')));
  for (const result of [{ ok: false }, { ok: true, text: "plain prose" }, { ok: true, text: '{"reply":""}' },
    { ok: true, text: '{"reply":"hi","shell":"untrusted"}' }]) {
    const generate = createReminderGenerator({ platform: "telegram", bin: "synthetic", timeoutMs: 1000,
      env: {}, codexHome: directory, sessionFile: path.join(directory, "not-written.json") }, {
      execute: (_bin, _args, _options, callback) => callback(null, "[]"), runner: async () => result,
    });
    await assert.rejects(generate({ text: "问候", generation: { model: null } }));
  }
});
