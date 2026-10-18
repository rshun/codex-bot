const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { prepareTurn, parseResponse, applyResponse, outputSchema } = require("../semantic-reminders");
const { ReminderScheduler, parseTime } = require("../reminders");
const { SessionStore } = require("../session-store");
const { createRedactor, createMessageHandler, loadConfig } = require("../index");
const { buildArgs } = require("../codex-runner");
const { response, entry, context } = require("./support/semantic");

const root = path.join(__dirname, "..", ".test-artifacts");
fs.mkdirSync(root, { recursive: true });
const directory = fs.mkdtempSync(path.join(root, "semantic-"));
let sequence = 0;
function fixture(extra = {}) {
  let now = parseTime("2026-10-18 08:00");
  const filename = path.join(directory, `reminders-${++sequence}.json`);
  const scheduler = new ReminderScheduler({ filename, platform: "telegram", userId: "42", now: () => now, send: async () => {}, ...extra });
  return { scheduler, at: value => { now = parseTime(value); }, turn: (text = "任意用户表达", options = {}) =>
    prepareTurn({ scheduler, text, privateChat: true, ...options }) };
}
function encode(turn, action, entries = [], message = "说明", delivery = "current") {
  return JSON.stringify({ nonce: turn.nonce, action, message, delivery, entries });
}
function apply(app, action, entries = [], message, delivery) {
  const turn = app.turn(); return applyResponse(encode(turn, action, entries, message, delivery), turn, app.scheduler);
}
const drink = time => entry("daily", time, "喝水");

test("every wording uses the same schema envelope rather than a keyword or phrase gate", () => {
  const app = fixture();
  for (const text of ["每晚九点叫我喝水", "设置一个喝水的提醒，晚上九点，每天", "到明天早上八点叫我一声", "改到十点吧", "算了，撤掉刚才那个", "给我看看还安排了哪些事", "你好", "解释这段代码"]) {
    const turn = app.turn(text);
    assert.equal(turn.outputSchema, outputSchema);
    const data = context(turn);
    assert.equal(data.currentMessage, text);
    assert.equal(data.beijingNow, "2026-10-18 08:00");
    assert.match(turn.prompt, /不依赖特定关键词或语序/);
  }
  const schema = JSON.parse(fs.readFileSync(outputSchema));
  assert.deepEqual(schema.properties.action.enum, ["chat", "clarify", "list", "create", "update", "cancel"]);
  for (const threadId of [null, "00000000-0000-0000-0000-000000000001"]) {
    const args = buildArgs({ threadId, outputSchema });
    assert.equal(args[args.indexOf("--output-schema") + 1], outputSchema);
    assert.equal(args.at(-1), "-");
  }
});

test("mixed once, daily and nonworking entries are validated together and stored in one transaction", () => {
  const app = fixture(); let writes = 0;
  const persist = app.scheduler.persist.bind(app.scheduler);
  app.scheduler.persist = items => { writes++; persist(items); };
  const result = apply(app, "create", [drink("21:00"), entry("once", "2026-10-19 08:30", "出门"), entry("nonworking", "11:02", "测试消息")]);
  assert.match(result, /已保存 3 个/); assert.equal(writes, 1);
  assert.deepEqual(app.scheduler.items.map(task => task.kind), ["daily", "once", "nonworking"]);
  const restored = new ReminderScheduler({ filename: app.scheduler.filename, platform: "telegram", userId: "42", send: async () => {} });
  assert.deepEqual(restored.items, app.scheduler.items);
});

test("invalid schedules, expired dates, duplicate entries, unsupported rules and missing contents leave the entire batch untouched", () => {
  for (const bad of [entry("once", "2026-02-30 10:00", "出门"), entry("once", "2026-10-18 07:00", "出门"),
    entry("daily", "24:00", "出门"), entry("weekly", "09:00", "出门"), entry("daily", "09:00", " "),
    entry("daily", "09:00", "x".repeat(1001))]) {
    const app = fixture();
    assert.match(apply(app, "create", [drink("21:00"), bad]), /未更改/);
    assert.deepEqual(app.scheduler.items, []); assert.ok(!fs.existsSync(app.scheduler.filename));
  }
  const app = fixture();
  assert.match(apply(app, "create", [drink("21:00"), drink("21:00")]), /未更改/);
  assert.deepEqual(app.scheduler.items, []);
  assert.match(apply(app, "create", Array.from({ length: 9 }, (_, index) => drink(`0${index}:00`))), /结构无效/);
});

test("unknown calendar coverage and a write failure cannot partially publish a mixed plan", () => {
  const app = fixture(); app.at("2026-12-31 23:59");
  assert.match(apply(app, "create", [drink("21:00"), entry("nonworking", "06:01", "假日消息")]), /日历未覆盖/);
  assert.deepEqual(app.scheduler.items, []);
  const blocked = fixture();
  fs.writeFileSync(blocked.scheduler.filename, "retain existing file");
  blocked.scheduler.filename = path.join(blocked.scheduler.filename, "child.json");
  assert.match(apply(blocked, "create", [drink("21:00")]), /保存失败/);
  assert.equal(blocked.scheduler.failed, true); assert.deepEqual(blocked.scheduler.items, []);
});

test("updates retain IDs and sending history, change content and schedule, then cancel selected tasks atomically", () => {
  const app = fixture(); apply(app, "create", [drink("21:00"), entry("daily", "08:30", "早餐")]);
  const before = structuredClone(app.scheduler.items);
  assert.match(apply(app, "update", [entry("", "22:00", "多喝温水", before[0].id)]), /已修改 1 个/);
  assert.equal(app.scheduler.items[0].id, before[0].id); assert.equal(app.scheduler.items[0].createdAt, before[0].createdAt);
  assert.equal(app.scheduler.items[0].time, "22:00"); assert.equal(app.scheduler.items[0].text, "多喝温水");
  assert.equal(app.scheduler.items[0].lastResult, before[0].lastResult);
  const snapshot = structuredClone(app.scheduler.items);
  assert.match(apply(app, "cancel", [entry("", "", "", before[0].id), entry("", "", "", "ffffffff")]), /未更改/);
  assert.deepEqual(app.scheduler.items, snapshot);
  assert.match(apply(app, "cancel", before.map(task => entry("", "", "", task.id))), /已取消 2 个/);
  assert.ok(app.scheduler.items.every(task => task.status === "cancelled"));
});

test("invalid, stale, forged or overprivileged model proposals never mutate state", () => {
  const app = fixture(); apply(app, "create", [drink("21:00")]);
  const id = app.scheduler.items[0].id;
  const before = structuredClone(app.scheduler.items);
  const turn = app.turn();
  const base = JSON.parse(encode(turn, "update", [entry("", "22:00", "", id)]));
  for (const value of ["not JSON", "```json\n" + JSON.stringify(base) + "\n```", JSON.stringify({ ...base, nonce: "past-turn" }),
    JSON.stringify({ ...base, recipient: "another-user" }), JSON.stringify({ ...base, entries: [{ ...base.entries[0], shell: "example" }] }),
    JSON.stringify({ ...base, entries: [base.entries[0], base.entries[0]] }),
    JSON.stringify({ ...base, action: "cancel", entries: [entry("daily", "", "", id)] })]) {
    assert.match(applyResponse(value, turn, app.scheduler), /未更改/);
    assert.deepEqual(app.scheduler.items, before);
  }
  for (const options of [{ privateChat: false }, { allowActions: false }]) {
    const restricted = app.turn("请求", options);
    assert.doesNotThrow(() => applyResponse(encode(restricted, "cancel", [entry("", "", "", id)]), restricted, app.scheduler));
    assert.deepEqual(app.scheduler.items, before);
  }
  assert.match(apply(app, "cancel", [entry("", "", "", id)], "", "other"), /目标平台/);
  assert.deepEqual(app.scheduler.items, before);
  app.scheduler.command("remind", "daily 09:00 新任务");
  assert.match(applyResponse(JSON.stringify(base), turn, app.scheduler), /发生变化/);
  assert.equal(app.scheduler.items[0].time, "21:00");
});

test("clarification, discussion, negative requests and list results are read-only regardless of model prose", () => {
  const app = fixture(); apply(app, "create", [drink("21:00"), drink("22:00")]);
  const before = fs.readFileSync(app.scheduler.filename, "utf8");
  for (const [action, message] of [["clarify", "有两个喝水提醒，请选任务ID"], ["chat", "解释‘每天九点提醒我’这句话"], ["chat", "好的，不取消"]]) {
    assert.ok(apply(app, action, [], message).includes(message));
    assert.equal(fs.readFileSync(app.scheduler.filename, "utf8"), before);
  }
  assert.match(apply(app, "list", [], "模型声称没有任务"), /喝水/);
  assert.ok(!apply(app, "list", [], "模型声称没有任务").includes("模型声称没有任务"));
});

test("in-flight and historical tasks cannot be cancelled, edited or reactivated by semantic plans", async () => {
  let finish;
  const app = fixture({ send: () => new Promise(resolve => { finish = resolve; }) });
  apply(app, "create", [drink("09:00")]); const id = app.scheduler.items[0].id;
  app.at("2026-10-18 09:00"); const running = app.scheduler.tick();
  assert.equal(app.scheduler.items[0].status, "sending");
  assert.match(apply(app, "update", [entry("", "10:00", "", id)]), /未更改/);
  assert.match(apply(app, "cancel", [entry("", "", "", id)]), /未更改/);
  finish(); await running;
  apply(app, "cancel", [entry("", "", "", id)]);
  assert.match(apply(app, "update", [entry("", "10:00", "", id)]), /未更改/);
  assert.equal(app.scheduler.items[0].status, "cancelled");
});

test("redaction applies to model context, stored content and receipts without exposing private tasks in group context", () => {
  const credential = "synthetic_private_value_for_testing";
  const redact = createRedactor({ API_KEY: credential });
  const app = fixture({ sanitize: redact });
  assert.match(apply(app, "create", [entry("daily", "09:00", credential)]), /REDACTED/);
  assert.ok(!fs.readFileSync(app.scheduler.filename, "utf8").includes(credential));
  const turn = app.turn(credential, { receipt: credential, redact });
  assert.ok(!turn.prompt.includes(credential));
  const group = context(app.turn("普通频道讨论", { privateChat: false }));
  assert.deepEqual(group.tasks, []);
});

test("clarification and actual Bot receipts survive restart on the same thread; /new clears only conversation", async () => {
  const app = fixture();
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: "synthetic_bot_credential", ALLOWED_USER_ID: "42",
    SESSION_FILE: path.join(directory, `sessions-${++sequence}.json`) });
  const sent = [], calls = [];
  const runner = async options => {
    calls.push(options); options.onThread("00000000-0000-0000-0000-000000000001");
    if (calls.length === 1) return response(options, "clarify", [], "每天几点提醒？");
    assert.equal(options.threadId, "00000000-0000-0000-0000-000000000001");
    assert.match(context(options).previousBotReceipt, /每天几点/);
    return response(options, "create", [drink("21:00")], "模型虚构的成功回执应被丢弃");
  };
  const makeHandler = () => createMessageHandler({ config, reminders: app.scheduler, runner,
    store: new SessionStore(config.sessionFile, config),
    bot: { sendMessage: async (id, text) => sent.push(text), _request: async () => {} } });
  const message = text => ({ text, from: { id: 42 }, chat: { id: 42, type: "private" }, message_id: 1 });
  await makeHandler()(message("每天叫我喝水"));
  assert.deepEqual(app.scheduler.items, []);
  await makeHandler()(message("晚上九点"));
  assert.match(sent.at(-1), /已保存 1 个/); assert.ok(!sent.at(-1).includes("虚构"));
  assert.equal(app.scheduler.items[0].time, "21:00");
  const persisted = new SessionStore(config.sessionFile, config).get("42:0:42");
  assert.match(persisted.reminderReceipt, /已保存 1 个/);
  await makeHandler()(message("/new"));
  const fresh = new SessionStore(config.sessionFile, config).get("42:0:42");
  assert.equal(fresh.threadId, null); assert.equal(fresh.reminderReceipt, ""); assert.equal(app.scheduler.items.length, 1);
});

test("CLI failures, malformed responses and usage persistence failures cannot execute proposed reminders", async () => {
  for (const mode of ["timeout", "malformed", "usage-write"]) {
    const app = fixture(), replies = [];
    const config = loadConfig({ TELEGRAM_BOT_TOKEN: "synthetic_bot_credential", ALLOWED_USER_ID: "42" });
    let writes = 0, state = { threadId: null, model: null };
    const handler = createMessageHandler({ config, reminders: app.scheduler,
      store: { get: () => ({ ...state }), set: (key, value) => {
        if (++writes === 2 && mode === "usage-write") throw new Error("private diagnostic"); state = { ...value };
      } },
      bot: { sendMessage: async (id, text) => replies.push(text), _request: async () => {} }, logger: { error: () => {} },
      runner: async options => mode === "timeout" ? { ok: false, kind: "timeout" } : mode === "malformed" ? { ok: true, text: "已创建啦" }
        : response(options, "create", [drink("21:00")]) });
    await handler({ text: "随意表达的提醒请求", from: { id: 42 }, chat: { id: 42 }, message_id: 1 });
    assert.deepEqual(app.scheduler.items, []);
    assert.ok(!replies.join("").includes("private diagnostic"));
  }
});

test("receipt persistence failure reports the committed task and blocks replay until the conversation is reset", async () => {
  const app = fixture(), replies = [];
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: "synthetic_bot_credential", ALLOWED_USER_ID: "42" });
  let state = { threadId: null, model: null }, calls = 0;
  const handler = createMessageHandler({ config, reminders: app.scheduler,
    store: { get: () => ({ ...state }), set: (key, value) => {
      if (value.reminderReceipt) throw new Error("synthetic write failure"); state = { ...value };
    } },
    bot: { sendMessage: async (id, text) => replies.push(text), _request: async () => {} },
    runner: async options => { calls++; return response(options, "create", [drink("21:00")]); } });
  const message = text => ({ text, from: { id: 42 }, chat: { id: 42 }, message_id: 1 });
  await handler(message("每天晚上九点叫我喝水"));
  assert.equal(app.scheduler.items.length, 1);
  assert.match(replies.at(-1), /已保存 1 个/); assert.match(replies.at(-1), /回执上下文保存失败/);
  assert.equal(JSON.parse(fs.readFileSync(app.scheduler.filename)).items.length, 1);
  await handler(message("重试"));
  assert.equal(calls, 1); assert.match(replies.at(-1), /状态保存曾失败/);
  await handler(message("/reminders")); assert.match(replies.at(-1), /喝水/);
});

test("semantic creation obeys both active and historical record limits without a partial write", () => {
  for (const count of [50, 500]) {
    const app = fixture(); apply(app, "create", [drink("21:00")]);
    const task = app.scheduler.items[0];
    app.scheduler.persist(Array.from({ length: count }, (_, index) => ({ ...task,
      id: index.toString(16).padStart(8, "0"), status: count === 500 ? "cancelled" : "pending" })));
    const before = fs.readFileSync(app.scheduler.filename, "utf8");
    assert.match(apply(app, "create", [drink("22:00")]), /数量已达上限/);
    assert.equal(fs.readFileSync(app.scheduler.filename, "utf8"), before);
  }
});

test("ordinary structured replies preserve the last reminder receipt and remain visible if usage storage fails", async () => {
  for (const failUsage of [false, true]) {
    const app = fixture(), replies = [];
    const config = loadConfig({ TELEGRAM_BOT_TOKEN: "synthetic_bot_credential", ALLOWED_USER_ID: "42" });
    let state = { threadId: null, model: null, reminderReceipt: "上次提醒已经保存" }, writes = 0;
    const handler = createMessageHandler({ config, reminders: app.scheduler,
      store: { get: () => ({ ...state }), set: (key, value) => {
        if (++writes === 2 && failUsage) throw new Error("synthetic failure"); state = { ...value };
      } }, logger: { error: () => {} },
      bot: { sendMessage: async (id, text) => replies.push(text), _request: async () => {} },
      runner: async options => response(options, "chat", [], "普通任务的实际回答") });
    await handler({ text: "普通问题", from: { id: 42 }, chat: { id: 42 }, message_id: 1 });
    assert.match(replies.at(-1), /普通任务的实际回答/);
    assert.equal(state.reminderReceipt, "上次提醒已经保存");
    assert.equal(writes, 2); assert.deepEqual(app.scheduler.items, []);
  }
});
