const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ReminderScheduler, parseTime, nextDaily, formatTime, parseNaturalReminder } = require("../reminders");
const { loadConfig, createRedactor, createMessageHandler } = require("../index");
const { SessionStore } = require("../session-store");
const { loadDiscordConfig, createDiscordTransport, createDiscordDispatcher, createDiscordReminderSender } = require("../discord");

const root = path.join(__dirname, "..", ".test-artifacts");
fs.mkdirSync(root, { recursive: true });
const directory = fs.mkdtempSync(path.join(root, "reminders-"));
let number = 0;
const USER = "123456789012345678";
const CHANNEL = "223456789012345678";
const BOT = "323456789012345678";
const APP = "423456789012345678";
const start = parseTime("2026-10-18 08:00");

function fixture(extra = {}) {
  let clock = start;
  const sent = [], logs = [];
  const options = { filename: path.join(directory, `state-${++number}.json`), platform: "telegram", userId: "42",
    now: () => clock, send: async (...args) => { sent.push(args); }, logger: { error: (value) => logs.push(value) }, ...extra };
  const scheduler = new ReminderScheduler(options);
  return { scheduler, options, sent, logs, at: (value) => { clock = typeof value === "string" ? parseTime(value) : value; } };
}

test("reminder parsing validates calendar dates and uses Beijing time independently of host timezone", () => {
  assert.equal(new Date(start).toISOString(), "2026-10-18T00:00:00.000Z");
  assert.equal(formatTime(start), "2026-10-18 08:00");
  for (const input of ["2026-02-30 10:00", "2026-13-01 10:00", "2026-10-18 24:00", "2026-10-18 08:60", "2026-1-1 8:00"]) {
    assert.ok(Number.isNaN(parseTime(input)), input);
  }
  assert.ok(Number.isFinite(parseTime("2028-02-29 10:00")));
  assert.equal(formatTime(nextDaily("08:00", start)), "2026-10-19 08:00");
  assert.equal(formatTime(nextDaily("09:00", start)), "2026-10-18 09:00");
});

test("natural reminders parse explicit Chinese daily, relative-date and calendar expressions", () => {
  const cases = [
    ["每天晚上9点提醒我喝水", "daily 21:00 喝水"],
    ["请帮我每天晚上九点提醒我喝水", "daily 21:00 喝水"],
    ["每日早上八点半提醒我吃早餐", "daily 08:30 吃早餐"],
    ["每天上午十点一刻提醒我休息", "daily 10:15 休息"],
    ["每天晚上九点三刻提醒我休息", "daily 21:45 休息"],
    ["每天凌晨十二点提醒我休息", "daily 00:00 休息"],
    ["每天中午十二点提醒我吃饭", "daily 12:00 吃饭"],
    ["每天中午一点提醒我休息", "daily 13:00 休息"],
    ["每天 09:00 提醒我喝水", "daily 09:00 喝水"],
    ["每天21点提醒我喝水", "daily 21:00 喝水"],
    ["明天早上8点半提醒我出门", "2026-10-19 08:30 出门"],
    ["后天下午三点二十五分提醒我开会", "2026-10-20 15:25 开会"],
    ["今天的下午3点05分，提醒我开会", "2026-10-18 15:05 开会"],
    ["今晚9点提醒我休息", "2026-10-18 21:00 休息"],
    ["明早8点提醒我出门", "2026-10-19 08:00 出门"],
    ["2026年10月19日晚上9点提醒我喝水", "2026-10-19 21:00 喝水"],
    ["2026-10-19 08：30 提醒我出门", "2026-10-19 08:30 出门"],
    ["2026-11-1 23:30 提醒我出门", "2026-11-01 23:30 出门"],
    ["2026-11-12 03:30 提醒我出门", "2026-11-12 03:30 出门"],
    ["2026-11-1晚上9点提醒我出门", "2026-11-01 21:00 出门"],
    ["每天晚上9点提醒我第一行\n第二行：不要改内容", "daily 21:00 第一行\n第二行：不要改内容"],
  ];
  for (const [input, argument] of cases) assert.deepEqual(parseNaturalReminder(input, start), { argument }, input);
  assert.deepEqual(parseNaturalReminder("明天早上8点提醒我出门", parseTime("2026-12-31 23:59")),
    { argument: "2027-01-01 08:00 出门" });
});

test("ambiguous, contradictory, unsupported and questioning reminders never become schedule arguments", () => {
  for (const input of ["每天9点提醒我喝水", "明天提醒我喝水", "晚上9点提醒我喝水", "每天晚上12点提醒我休息",
    "每天早上3点提醒我喝水", "每天下午9点提醒我喝水", "每天上午13点提醒我喝水", "每天25:00提醒我喝水",
    "每天晚上9点60分提醒我喝水", "每天晚上9点提醒我", "每周一晚上9点提醒我喝水",
    "2026年2月30日晚上9点提醒我喝水", "每天晚上9点提醒我喝水，可以吗？", "每天晚上9点提醒我喝水可以吗",
    "每天晚上9点提醒我喝水怎么设置", "每天晚上9点提醒我喝水，明天早上8点提醒我出门",
    "2026-11-123:30提醒我出门"]) {
    assert.match(parseNaturalReminder(input, start).error, /未创建提醒/, input);
  }
  for (const input of ["你好", "帮我分析提醒功能", "能不能每天晚上9点提醒我喝水", "如何设置每天晚上9点提醒我喝水？",
    "“每天晚上9点提醒我喝水”", "/codex 每天晚上9点提醒我喝水"]) {
    assert.equal(parseNaturalReminder(input, start), null, input);
  }
});

test("natural reminders reuse persistence, daily rollover, cancellation and private delivery", async () => {
  const app = fixture();
  app.at("2026-10-18 22:00");
  const natural = parseNaturalReminder("每天晚上9点提醒我喝水", app.options.now());
  assert.match(app.scheduler.command("remind", natural.argument), /2026-10-19 21:00（北京时间）/);
  const restored = new ReminderScheduler(app.options);
  assert.equal(restored.items[0].time, "21:00");
  assert.equal(restored.items[0].text, "喝水");
  app.at("2026-10-19 21:00");
  await restored.tick();
  assert.equal(app.sent.length, 1);
  assert.equal(app.sent[0][0], "42");
  assert.match(app.sent[0][1], /喝水/);
  assert.equal(formatTime(Date.parse(restored.items[0].nextAt)), "2026-10-20 21:00");
  restored.command("cancelreminder", restored.items[0].id);
  app.at("2026-10-20 21:00");
  await restored.tick();
  assert.equal(app.sent.length, 1);
  assert.match(app.scheduler.command("remind", parseNaturalReminder("今天早上7点提醒我出门", app.options.now()).argument), /已经过去/);
});

test("a one-off reminder persists across restart and only sends privately once after the deadline", async () => {
  const app = fixture();
  assert.match(app.scheduler.add("2026-10-18 09:00 喝水"), /已保存/);
  const restored = new ReminderScheduler(app.options);
  await restored.tick();
  assert.equal(app.sent.length, 0);
  app.at("2026-10-18 09:00");
  await restored.tick();
  assert.equal(app.sent.length, 1);
  assert.equal(app.sent[0][0], "42");
  assert.match(app.sent[0][1], /喝水/);
  await restored.tick();
  await new ReminderScheduler(app.options).tick();
  assert.equal(app.sent.length, 1);
  assert.equal(restored.items[0].status, "sent");
});

test("overdue daily reminders catch up once and calculate the next future date rather than replaying missed days", async () => {
  const app = fixture();
  app.scheduler.add("daily 09:00 站起来活动");
  app.at("2026-10-22 12:00");
  await app.scheduler.tick();
  await app.scheduler.tick();
  assert.equal(app.sent.length, 1);
  assert.equal(formatTime(Date.parse(app.scheduler.items[0].nextAt)), "2026-10-23 09:00");
  app.at("2026-10-23 09:00");
  await app.scheduler.tick();
  assert.equal(app.sent.length, 2);
  assert.equal(app.scheduler.items[0].lastResult, "sent");
});

test("expired one-off reminders catch up after downtime, while cancellation prevents delivery", async () => {
  const app = fixture();
  app.scheduler.add("2026-10-18 09:00 保留提醒");
  app.scheduler.add("2026-10-18 09:00 取消提醒");
  const id = app.scheduler.items[1].id;
  assert.match(app.scheduler.cancel(id), /已取消/);
  app.at("2026-10-20 09:00");
  await new ReminderScheduler(app.options).tick();
  assert.equal(app.sent.length, 1);
  assert.match(app.sent[0][1], /保留提醒/);
  assert.match(app.scheduler.cancel("--all"), /用法/);
});

test("ambiguous network failure is recorded without logging raw errors or automatically retrying", async () => {
  const app = fixture({ send: async () => { throw new Error("synthetic_private_payload"); } });
  app.scheduler.add("2026-10-18 09:00 测试");
  app.at("2026-10-18 09:00");
  await app.scheduler.tick();
  const restored = new ReminderScheduler(app.options);
  assert.equal(restored.items[0].status, "uncertain");
  let retried = false;
  restored.send = async () => { retried = true; };
  await restored.tick();
  assert.equal(retried, false);
  assert.match(restored.list(), /发送未确认/);
  assert.ok(app.logs.every((value) => !value.includes("synthetic_private_payload")));
});

test("a persisted sending claim recovers as uncertain and never resends that occurrence", async () => {
  for (const argument of ["2026-10-18 09:00 测试", "daily 09:00 测试"]) {
    const app = fixture();
    app.scheduler.add(argument);
    app.scheduler.update(app.scheduler.items[0].id, { status: "sending", lastAttempt: new Date(start).toISOString() });
    app.at("2026-10-20 12:00");
    const restored = new ReminderScheduler(app.options);
    await restored.tick();
    assert.equal(app.sent.length, 0);
    assert.equal(restored.items[0].lastResult, "uncertain");
    if (restored.items[0].kind === "daily") {
      assert.equal(restored.items[0].status, "pending");
      assert.equal(formatTime(Date.parse(restored.items[0].nextAt)), "2026-10-21 09:00");
    } else assert.equal(restored.items[0].status, "uncertain");
  }
});

test("claim write failure prevents sending; post-send write failure preserves the claim and pauses further work", async () => {
  for (const failAt of [1, 2]) {
    const app = fixture();
    app.scheduler.add("2026-10-18 09:00 测试");
    app.at("2026-10-18 09:00");
    const persist = app.scheduler.persist.bind(app.scheduler);
    let writes = 0;
    app.scheduler.persist = (items) => { if (++writes === failAt) throw new Error("synthetic_private_payload"); persist(items); };
    await app.scheduler.tick();
    assert.equal(app.sent.length, failAt === 1 ? 0 : 1);
    assert.equal(app.scheduler.failed, true);
    await app.scheduler.tick();
    assert.equal(app.sent.length, failAt === 1 ? 0 : 1);
    const disk = JSON.parse(fs.readFileSync(app.options.filename));
    assert.equal(disk.items[0].status, failAt === 1 ? "pending" : "sending");
  }
});

test("overlapping ticks, task creation and cancellation during a send do not duplicate or lose tasks", async () => {
  let finish;
  const app = fixture({ send: () => new Promise((resolve) => { finish = resolve; }) });
  app.scheduler.add("2026-10-18 09:00 第一条");
  app.scheduler.add("2026-10-18 09:00 第二条");
  app.at("2026-10-18 09:00");
  const running = app.scheduler.tick();
  await app.scheduler.tick();
  assert.match(app.scheduler.cancel(app.scheduler.items[0].id), /已经开始/);
  app.scheduler.cancel(app.scheduler.items[1].id);
  app.scheduler.add("2026-10-19 09:00 第三条");
  finish();
  await running;
  assert.deepEqual(app.scheduler.items.map((item) => item.status), ["sent", "cancelled", "pending"]);
});

test("corrupt, wrong-owner and wrong-platform reminder files fail closed without being overwritten", () => {
  const app = fixture();
  app.scheduler.add("daily 09:00 测试");
  const original = JSON.parse(fs.readFileSync(app.options.filename));
  for (const changes of [{ userId: "43" }, { platform: "discord" }, { items: [{ ...original.items[0], nextAt: "invalid" }] },
    { items: [original.items[0], original.items[0]] }, { items: [{ ...original.items[0], status: "unknown_status" }] }]) {
    const text = JSON.stringify({ ...original, ...changes });
    fs.writeFileSync(app.options.filename, text);
    assert.throws(() => new ReminderScheduler(app.options), (error) => error.kind === "state");
    assert.equal(fs.readFileSync(app.options.filename, "utf8"), text);
  }
});

test("credentials are redacted before persistence and disabled Discord DMs pause old tasks", async () => {
  const credential = "synthetic_discord_credential";
  const app = fixture({ sanitize: createRedactor({ DISCORD_BOT_TOKEN: credential }) });
  app.scheduler.add(`daily 09:00 ${credential}`);
  assert.ok(!fs.readFileSync(app.options.filename, "utf8").includes(credential));
  const disabled = new ReminderScheduler({ ...app.options, enabled: false });
  app.at("2026-10-20 12:00");
  await disabled.tick();
  assert.equal(app.sent.length, 0);
  assert.match(disabled.add("daily 09:00 测试"), /关闭/);
  assert.match(disabled.list(), /暂停/);
});

test("invalid times, empty/long contents, task limits and session file collisions never create reminders", () => {
  const app = fixture();
  for (const argument of ["2026-02-30 09:00 测试", "2026-10-17 09:00 测试", "daily 25:00 测试", "daily 09:00 ", `daily 09:00 ${"x".repeat(1001)}`]) {
    assert.doesNotMatch(app.scheduler.add(argument), /已保存/);
  }
  assert.equal(app.scheduler.items.length, 0);
  for (let index = 0; index < 50; index++) app.scheduler.add("daily 09:00 测试");
  assert.match(app.scheduler.add("daily 10:00 超限"), /上限/);
  assert.equal(app.scheduler.items.length, 50);
  const filename = path.join(directory, "same-state.json");
  assert.throws(() => loadConfig({ TELEGRAM_BOT_TOKEN: "synthetic_credential", ALLOWED_USER_ID: "42", SESSION_FILE: filename, REMINDER_FILE: filename }));
  if (process.platform === "win32") {
    assert.throws(() => loadConfig({ TELEGRAM_BOT_TOKEN: "synthetic_credential", ALLOWED_USER_ID: "42", SESSION_FILE: filename, REMINDER_FILE: filename.toUpperCase() }));
  }
});

test("Telegram reminders require the authorized private chat, bypass Codex and can be managed while Codex is busy", async () => {
  const app = fixture();
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: "synthetic_credential", ALLOWED_USER_ID: "42", SESSION_FILE: path.join(directory, `sessions-${++number}.json`) });
  const replies = [];
  let runs = 0;
  let finish;
  const handler = createMessageHandler({ config, reminders: app.scheduler, store: new SessionStore(config.sessionFile, config),
    bot: { sendMessage: async (chat, text) => replies.push({ chat, text }), _request: async () => {} },
    runner: () => { runs++; return new Promise((resolve) => { finish = () => resolve({ ok: true, text: "完成" }); }); } });
  const message = (text, chat = 42, user = 42) => ({ text, chat: { id: chat }, from: { id: user }, message_id: 1 });
  await handler(message("/remind daily 09:00 测试", 43, 43));
  await handler(message("/remind daily 09:00 测试", -100));
  assert.equal(app.scheduler.items.length, 0);
  const running = handler(message("长任务"));
  await new Promise((resolve) => setImmediate(resolve));
  await handler(message("/remind daily 09:00 测试"));
  await handler(message("/reminders"));
  assert.equal(app.scheduler.items.length, 1);
  assert.equal(runs, 1);
  assert.match(replies.at(-1).text, /待发送/);
  finish(); await running;
});

test("Telegram natural reminders enforce private authorization, work while busy and leave normal conversation intact", async () => {
  const app = fixture();
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: "synthetic_credential", ALLOWED_USER_ID: "42", SESSION_FILE: path.join(directory, `sessions-${++number}.json`) });
  const replies = [], prompts = [];
  let finish;
  const handler = createMessageHandler({ config, reminders: app.scheduler, store: new SessionStore(config.sessionFile, config),
    bot: { sendMessage: async (chat, text) => replies.push(text), _request: async () => {} },
    runner: ({ prompt }) => { prompts.push(prompt); return new Promise((resolve) => { finish = () => resolve({ ok: true, text: "完成" }); }); } });
  const message = (text, chat = 42, user = 42) => ({ text, chat: { id: chat }, from: { id: user }, message_id: 1 });
  await handler(message("每天晚上9点提醒我喝水", 43, 43));
  assert.equal(replies.at(-1), "未授权。");
  await handler(message("每天晚上9点提醒我喝水", -100));
  assert.match(replies.at(-1), /私聊/);
  await handler(message("每天9点提醒我喝水"));
  assert.match(replies.at(-1), /未创建提醒/);
  assert.equal(app.scheduler.items.length, 0);
  assert.equal(prompts.length, 0);
  const running = handler(message("普通对话"));
  await new Promise((resolve) => setImmediate(resolve));
  await handler(message("每天晚上9点提醒我喝水"));
  assert.match(replies.at(-1), /已保存定时消息/);
  assert.match(replies.at(-1), /2026-10-18 21:00（北京时间）/);
  assert.equal(app.scheduler.items.length, 1);
  assert.equal(prompts.length, 1);
  finish(); await running;
  const discussion = handler(message("/codex 每天晚上9点提醒我喝水"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prompts.at(-1), "每天晚上9点提醒我喝水");
  finish(); await discussion;
  assert.equal(app.scheduler.items.length, 1);
});

test("Discord private natural text uses the same grammar and honors disabled private sending", async () => {
  const config = loadDiscordConfig({ DISCORD_BOT_TOKEN: "synthetic_discord_credential", DISCORD_ALLOWED_USER_ID: USER,
    DISCORD_CHANNEL_IDS: CHANNEL, SESSION_FILE: path.join(directory, `discord-sessions-${++number}.json`) });
  const app = fixture({ platform: "discord", userId: USER });
  const replies = [];
  const handler = createMessageHandler({ config, reminders: app.scheduler, store: new SessionStore(config.sessionFile, config),
    transport: { reply: async (msg, text) => replies.push(text) }, runner: async () => { throw new Error("Codex must not be called"); } });
  const dispatch = createDiscordDispatcher({ config, rest: { request: async () => ({}) }, handler });
  await dispatch("READY", { user: { id: BOT, bot: true }, application: { id: APP } });
  const message = { id: "523456789012345678", channel_id: CHANNEL, author: { id: USER }, content: "每天晚上9点提醒我喝水" };
  await dispatch("MESSAGE_CREATE", { ...message, guild_id: APP });
  assert.equal(app.scheduler.items.length, 0);
  assert.match(replies.at(-1), /私聊/);
  await dispatch("MESSAGE_CREATE", { ...message, id: "623456789012345678" });
  assert.equal(app.scheduler.items.length, 1);
  assert.equal(app.scheduler.items[0].time, "21:00");
  app.scheduler.enabled = false;
  await dispatch("MESSAGE_CREATE", { ...message, id: "723456789012345678" });
  assert.match(replies.at(-1), /私聊发送已关闭/);
  assert.equal(app.scheduler.items.length, 1);
});

test("Discord native reminders are stored without interaction tokens and later sent via a fresh private Bot message", async () => {
  const config = loadDiscordConfig({ DISCORD_BOT_TOKEN: "synthetic_discord_credential", DISCORD_ALLOWED_USER_ID: USER,
    DISCORD_CHANNEL_IDS: CHANNEL, SESSION_FILE: path.join(directory, `discord-sessions-${++number}.json`) });
  const calls = [];
  const rest = { request: async (...args) => { calls.push(args); return args[1] === "/users/@me/channels" ? { id: CHANNEL } : {}; } };
  const app = fixture({ platform: "discord", userId: USER, send: createDiscordReminderSender(rest) });
  const handler = createMessageHandler({ config, store: new SessionStore(config.sessionFile, config), reminders: app.scheduler,
    transport: createDiscordTransport(rest), runner: async () => { throw new Error("Codex must not be called"); } });
  const dispatch = createDiscordDispatcher({ config, rest, handler });
  await dispatch("READY", { user: { id: BOT, bot: true }, application: { id: APP } });
  const interaction = { type: 2, id: "523456789012345678", application_id: APP, channel_id: CHANNEL,
    token: "synthetic_interaction_credential", user: { id: USER }, data: { name: "remind", options: [{ type: 3, name: "details", value: "daily 09:00 私聊提醒" }] } };
  await dispatch("INTERACTION_CREATE", { ...interaction, guild_id: "623456789012345678" });
  assert.equal(app.scheduler.items.length, 0);
  await dispatch("INTERACTION_CREATE", { ...interaction, id: "723456789012345678" });
  assert.equal(app.scheduler.items.length, 1);
  assert.ok(!fs.readFileSync(app.options.filename, "utf8").includes(interaction.token));
  app.at("2026-10-18 09:00");
  const beforeSend = calls.length;
  await app.scheduler.tick();
  const sent = calls.slice(beforeSend);
  assert.equal(sent[0][1], "/users/@me/channels");
  assert.deepEqual(sent[0][2], { recipient_id: USER });
  assert.equal(sent[1][1], `/channels/${CHANNEL}/messages`);
  assert.deepEqual(sent[1][2].allowed_mentions, { parse: [], replied_user: false });
  assert.ok(!JSON.stringify(sent).includes(interaction.token));
});

test("scheduler start is idempotent, stop clears timers and restart recovery only runs when ticking", async () => {
  let callback, cleared = 0;
  const app = fixture({ timers: { setInterval: (fn, ms) => { assert.equal(ms, 5000); callback = fn; return 1; },
    clearInterval: () => { cleared++; } } });
  app.scheduler.start(); app.scheduler.start();
  assert.equal(typeof callback, "function");
  app.scheduler.stop();
  assert.equal(cleared, 1);
  assert.equal(app.scheduler.timer, undefined);
  await app.scheduler.tick();
  assert.equal(app.sent.length, 0);
});
