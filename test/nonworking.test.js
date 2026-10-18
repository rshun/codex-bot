const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ChinaCalendar, CalendarError } = require("../china-calendar");
const { ReminderScheduler, parseNaturalReminder, parseTime, formatTime } = require("../reminders");
const { loadConfig, createMessageHandler } = require("../index");

const root = path.join(__dirname, "..", ".test-artifacts");
fs.mkdirSync(root, { recursive: true });
const directory = fs.mkdtempSync(path.join(root, "nonworking-"));
let sequence = 0;
const original = "请在节假日的早上6点1分，11点2分添加添加定时任务： 在tg上发送测试消息";
function fixture(extra = {}) {
  let now = parseTime("2026-10-09 20:00");
  const sent = [], logs = [];
  const options = { filename: path.join(directory, `state-${++sequence}.json`), platform: "telegram", userId: "42",
    now: () => now, send: async (...args) => sent.push(args), logger: { error: value => logs.push(value) }, ...extra };
  return { options, sent, logs, scheduler: new ReminderScheduler(options), at: value => { now = parseTime(value); } };
}
const batch = { kind: "nonworking", times: ["06:01", "11:02"], text: "测试消息" };

test("official 2026 nonworking calendar includes weekdays off and excludes all six makeup workdays", () => {
  const calendar = new ChinaCalendar();
  for (const day of ["2026-01-02", "2026-02-23", "2026-04-06", "2026-05-05", "2026-06-19", "2026-09-25", "2026-10-07", "2026-10-11"]) {
    assert.equal(calendar.isNonworking(parseTime(day + " 08:00")), true, day);
  }
  for (const day of ["2026-01-04", "2026-02-14", "2026-02-28", "2026-05-09", "2026-09-20", "2026-10-10", "2026-10-12"]) {
    assert.equal(calendar.isNonworking(parseTime(day + " 08:00")), false, day);
  }
  assert.throws(() => calendar.isNonworking(parseTime("2027-01-02 08:00")), e => e instanceof CalendarError && e.kind === "coverage");
  assert.equal(formatTime(calendar.next("06:01", parseTime("2026-10-09 20:00"))), "2026-10-11 06:01");
});

test("calendar validation rejects overlapping dates, impossible dates and corrupt data without modifying files", () => {
  for (const entry of [{ holidays: ["2026-02-30"], workdays: [] }, { holidays: ["2026-01-01"], workdays: ["2026-01-01"] },
    { holidays: ["2027-01-01"], workdays: [] }, { holidays: "invalid", workdays: [] }, { holidays: [], workdays: [] }]) {
    const filename = path.join(directory, `calendar-${++sequence}.json`);
    const data = JSON.stringify({ version: 1, years: { 2026: { source: "https://example.invalid/calendar", ...entry } } });
    fs.writeFileSync(filename, data, { flag: "wx" });
    assert.throws(() => new ChinaCalendar(filename), CalendarError);
    assert.equal(fs.readFileSync(filename, "utf8"), data);
  }
});

test("the exact reported sentence parses both inherited morning times, duplicate verb and explicit Telegram destination", () => {
  assert.deepEqual(parseNaturalReminder(original), { command: "remindbatch", argument: batch, platform: "telegram" });
  assert.deepEqual(parseNaturalReminder("非工作日早上六点一分、十一点二分提醒我测试消息"), { command: "remindbatch", argument: batch });
  assert.deepEqual(parseNaturalReminder("每天早上6点1分，14:02提醒我测试消息"), {
    command: "remindbatch", argument: { ...batch, kind: "daily", times: ["06:01", "14:02"] } });
  assert.deepEqual(parseNaturalReminder("非工作日 06:01、06:01提醒我测试消息").argument.times, ["06:01"]);
  for (const text of ["非工作日6点1分，11点2分提醒我测试消息", "非工作日早上6点61分，11点2分提醒我测试消息",
    "非工作日早上6点1分，11点2分提醒我测试消息可以吗", "每晚9点提醒我喝水", "设置一个每天晚上9点喝水的提醒"]) {
    assert.ok(parseNaturalReminder(text).error, text);
  }
  for (const text of ["如何添加节假日定时任务", "不要在节假日添加定时任务：测试消息", "“" + original + "”", "/codex " + original]) {
    assert.equal(parseNaturalReminder(text), null, text);
  }
});

test("both nonworking times persist atomically and skip makeup Saturday before sending once each on Sunday", async () => {
  const app = fixture(); let writes = 0;
  const persist = app.scheduler.persist.bind(app.scheduler);
  app.scheduler.persist = items => { writes++; persist(items); };
  assert.match(app.scheduler.command("remindbatch", batch), /已保存 2 个/);
  assert.equal(writes, 1); assert.equal(new Set(app.scheduler.items.map(t => t.id)).size, 2);
  assert.equal(JSON.parse(fs.readFileSync(app.options.filename)).version, 2);
  const restored = new ReminderScheduler(app.options);
  app.at("2026-10-10 11:03"); await restored.tick(); assert.equal(app.sent.length, 0);
  app.at("2026-10-11 06:01"); await restored.tick(); assert.equal(app.sent.length, 1);
  app.at("2026-10-11 11:02"); await restored.tick(); await restored.tick(); assert.equal(app.sent.length, 2);
  assert.ok(app.sent.every(args => args[0] === "42" && args[1].includes("测试消息")));
  assert.equal(formatTime(Date.parse(restored.items[0].nextAt)), "2026-10-17 06:01");
});

test("missed nonworking occurrences never catch up on a working day or before today's planned time", async () => {
  const app = fixture(); app.scheduler.command("remindbatch", batch);
  app.at("2026-10-12 12:00"); const resumed = new ReminderScheduler(app.options); await resumed.tick(); assert.equal(app.sent.length, 0);
  assert.equal(formatTime(Date.parse(resumed.items[0].nextAt)), "2026-10-17 06:01");
  app.at("2026-10-18 05:00"); const later = new ReminderScheduler(app.options); await later.tick(); assert.equal(app.sent.length, 0);
  assert.equal(formatTime(Date.parse(later.items[0].nextAt)), "2026-10-18 06:01");
  app.at("2026-10-18 12:00"); await later.tick(); await later.tick(); assert.equal(app.sent.length, 2);
  assert.ok(app.sent.every(args => args[1].includes("2026-10-18")));
});

test("unknown next-year calendar pauses only nonworking tasks and cannot duplicate a completed occurrence", async () => {
  const app = fixture(); app.at("2026-12-26 20:00"); app.scheduler.command("remindbatch", batch);
  app.scheduler.add("daily 12:00 普通每天任务");
  app.at("2026-12-27 06:01"); await app.scheduler.tick(); assert.equal(app.scheduler.items[0].status, "calendar_wait");
  app.at("2026-12-27 12:00"); await app.scheduler.tick();
  assert.equal(app.sent.length, 3); assert.equal(app.scheduler.failed, false);
  assert.equal(app.scheduler.items[1].status, "calendar_wait"); assert.equal(app.scheduler.items[2].status, "pending");
  assert.match(app.scheduler.list(), /日历待更新/);
  app.at("2027-01-02 12:00"); const resumed = new ReminderScheduler(app.options); await resumed.tick();
  assert.equal(app.sent.length, 4); // Only the ordinary daily reminder catches up.
  assert.equal(resumed.items[0].status, "calendar_wait");
  assert.match(resumed.command("cancelmatching", "测试消息"), /匹配到 2 个/);
  assert.match(resumed.command("cancelreminder", resumed.items[0].id), /已取消/);
});

test("calendar refresh resumes waiting tasks only at a future covered date", async () => {
  const app = fixture(); app.at("2026-12-26 20:00"); app.scheduler.command("remindbatch", batch);
  app.at("2026-12-27 12:00"); await app.scheduler.tick(); assert.equal(app.sent.length, 2);
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "china-calendar.json")));
  data.years[2027] = { source: "https://example.invalid/synthetic-test-calendar", holidays: ["2027-12-31"], workdays: [] };
  const filename = path.join(directory, `calendar-${++sequence}.json`); fs.writeFileSync(filename, JSON.stringify(data), { flag: "wx" });
  app.at("2026-12-31 08:00"); const resumed = new ReminderScheduler({ ...app.options, calendarFile: filename });
  await resumed.tick(); assert.equal(app.sent.length, 2);
  assert.equal(formatTime(Date.parse(resumed.items[0].nextAt)), "2027-01-02 06:01");
  app.at("2027-01-02 06:01"); await resumed.tick(); assert.equal(app.sent.length, 3);
});

test("batch validation, coverage and persistence failure cannot leave half a request saved", () => {
  const app = fixture();
  assert.match(app.scheduler.command("remindbatch", { ...batch, times: ["06:01", "25:00"] }), /未创建/);
  assert.equal(app.scheduler.items.length, 0);
  app.at("2026-12-31 08:00"); assert.match(app.scheduler.command("remindbatch", batch), /日历未覆盖/);
  assert.equal(fs.existsSync(app.options.filename), false);
  app.at("2026-10-09 20:00"); app.scheduler.add("daily 21:00 原任务");
  const before = fs.readFileSync(app.options.filename, "utf8"); app.scheduler.failed = true;
  assert.match(app.scheduler.command("remindbatch", batch), /保存失败/);
  assert.equal(app.scheduler.items.length, 1); assert.equal(fs.readFileSync(app.options.filename, "utf8"), before);
  const full = fixture();
  for (let i = 0; i < 49; i++) full.scheduler.add(`daily 21:00 任务${i}`);
  const existing = fs.readFileSync(full.options.filename, "utf8");
  assert.match(full.scheduler.command("remindbatch", batch), /未创建任何任务/);
  assert.equal(fs.readFileSync(full.options.filename, "utf8"), existing);
});

test("uncertain nonworking sends and persisted sending claims are not replayed", async () => {
  const app = fixture({ send: async () => { throw new Error("synthetic network detail"); } });
  app.scheduler.command("remindbatch", { ...batch, times: ["06:01"] });
  app.at("2026-10-11 06:01"); await app.scheduler.tick();
  assert.equal(app.scheduler.items[0].lastResult, "uncertain"); assert.ok(!app.logs.join().includes("synthetic"));
  const task = app.scheduler.items[0]; app.scheduler.update(task.id, { status: "sending", lastAttempt: new Date(app.options.now()).toISOString() });
  const recovered = new ReminderScheduler(app.options); await recovered.tick();
  assert.equal(recovered.items[0].lastResult, "uncertain"); assert.equal(recovered.items[0].status, "pending");
  assert.equal(app.logs.length, 1);
});

test("nonworking edits explicitly preserve or change the rule and retain the original task ID", () => {
  const app = fixture(); app.scheduler.command("remindbatch", { ...batch, times: ["06:01"] }); const id = app.scheduler.items[0].id;
  const intent = parseNaturalReminder(`把提醒 ${id} 改成非工作日 07:00`, app.options.now());
  assert.match(app.scheduler.command(intent.command, intent.argument), /中国大陆非工作日 07:00/);
  assert.equal(new ReminderScheduler(app.options).items[0].kind, "nonworking");
  assert.match(app.scheduler.command("reschedule", { query: id, schedule: "daily 07:00" }), /新计划：每天/);
  assert.equal(app.scheduler.items[0].id, id); assert.equal(JSON.parse(fs.readFileSync(app.options.filename)).version, 1);
});

test("semantic nonworking plans require current private delivery and persist both times", async () => {
  const { response, entry, context } = require("./support/semantic");
  const app = fixture(), replies = [];
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: "synthetic_credential", ALLOWED_USER_ID: "42" });
  let session = { threadId: null, model: null };
  const handler = createMessageHandler({ config, reminders: app.scheduler,
    store: { get: () => ({ ...session }), set: (key, value) => { session = { ...value }; } },
    bot: { sendMessage: async (id, text) => replies.push(text), _request: async () => {} },
    runner: async options => response(options, "create", batch.times.map(time => entry("nonworking", time, batch.text)), "",
      context(options).currentMessage.includes("discord") ? "other" : "current") });
  const message = (text, id = 42, user = 42) => ({ text, chat: { id }, from: { id: user }, message_id: 1 });
  await handler(message(original, -100)); assert.match(replies.at(-1), /私聊/); assert.equal(app.scheduler.items.length, 0);
  await handler(message(original, 43, 43)); assert.equal(replies.at(-1), "未授权。");
  await handler(message(original.replace("tg", "discord"))); assert.match(replies.at(-1), /目标平台/); assert.equal(app.scheduler.items.length, 0);
  await handler(message(original)); assert.match(replies.at(-1), /已保存 2 个/); assert.equal(app.scheduler.items.length, 2);
});
