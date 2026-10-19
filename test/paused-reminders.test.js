const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ReminderScheduler, parseTime, formatTime } = require("../reminders");
const { prepareTurn, applyResponse } = require("../semantic-reminders");
const { loadConfig, createMessageHandler } = require("../index");
const { SessionStore } = require("../session-store");
const { createDiscordTransport } = require("../discord");
const { context, response } = require("./support/semantic");
const root = path.resolve(__dirname, "..", ".test-artifacts");
fs.mkdirSync(root, { recursive: true });
const directory = fs.mkdtempSync(path.join(root, "paused-reminders-"));
let sequence = 0;
function fixture(extra = {}) {
  let now = parseTime("2026-10-19 08:00");
  const sent = [], calls = [];
  const options = { filename: path.join(directory, `state-${++sequence}.json`), platform: "telegram", userId: "42",
    now: () => now, send: async (_user, text) => sent.push(text), generate: async task => { calls.push(task); return "新生成的简短回复"; },
    logger: { error: () => {} }, ...extra };
  return { scheduler: new ReminderScheduler(options), options, sent, calls, at: value => { now = parseTime(value); } };
}
const entry = (id = "", kind = "", time = "", text = "", generation = "") => ({ id, kind, time, text, generation });
function apply(app, action, entries = [], options = {}) {
  const turn = prepareTurn({ scheduler: app.scheduler, text: "合成协议测试", privateChat: true, model: "test-model", ...options });
  return applyResponse(JSON.stringify({ nonce: turn.nonce, action, entries, delivery: "current", message: "" }), turn, app.scheduler);
}
function create(app, model = false, kind = "daily", time = "09:00") {
  assert.match(apply(app, "create", [entry("", kind, time, "喝水", model ? "model" : "static")]), /已保存/);
  return app.scheduler.items.at(-1).id;
}
async function tick(app) { await app.scheduler.tick(); if (app.scheduler.modelRun) await app.scheduler.modelRun; }
const state = app => fs.readFileSync(app.options.filename, "utf8");

test("static and model reminders remain paused across restart, resume only in the future and retain identity/model/history", async () => {
  for (const model of [false, true]) {
    const app = fixture(), id = create(app, model);
    app.at("2026-10-19 09:00"); await tick(app);
    const original = structuredClone(app.scheduler.items[0]);
    assert.match(apply(app, "pause", [entry(id)]), /已暂停/);
    assert.equal(JSON.parse(state(app)).version, 4);
    assert.equal(Object.keys(app.scheduler.items[0]).length, model ? 10 : 9);
    app.scheduler = new ReminderScheduler(app.options);
    app.at("2026-10-23 10:00"); await tick(app);
    assert.equal(app.sent.length, 1); assert.equal(app.calls.length, model ? 1 : 0);
    assert.match(apply(app, "resume", [entry(id)]), /不补发/);
    assert.equal(app.scheduler.items[0].nextAt, "2026-10-24T01:00:00.000Z");
    for (const key of ["id", "text", "generation", "createdAt", "lastAttempt", "lastResult"]) assert.deepEqual(app.scheduler.items[0][key], original[key]);
    await tick(app); assert.equal(app.sent.length, 1);
    app.at("2026-10-24 09:00"); await tick(app); await tick(app);
    assert.equal(app.sent.length, 2); assert.equal(app.calls.length, model ? 2 : 0);
    assert.equal(JSON.parse(state(app)).version, model ? 3 : 1);
  }
});

test("expired single reminders require an explicit future time; content edits keep them paused and never trigger catch-up", async () => {
  for (const model of [false, true]) {
    const app = fixture(), id = create(app, model, "once", "2026-10-19 09:00");
    apply(app, "pause", [entry(id)]); app.at("2026-10-20 10:00"); await tick(app);
    const before = state(app);
    for (const time of ["", "2026-10-20 09:59", "2026-02-30 11:00"]) {
      assert.match(apply(app, "resume", [entry(id, "", time)]), /未恢复任何任务/);
      assert.equal(state(app), before);
    }
    assert.match(apply(app, "update", [entry(id, "", "", "新内容")]), /已暂停/);
    assert.equal(app.scheduler.items[0].nextAt, "2026-10-19T01:00:00.000Z");
    assert.match(apply(app, "resume", [entry(id, "", "2026-10-20 11:00")]), /已恢复/);
    assert.equal(app.scheduler.items[0].status, "pending");
    await tick(app); assert.equal(app.sent.length, 0);
    app.at("2026-10-20 11:00"); await tick(app); await tick(app);
    assert.equal(app.sent.length, 1); assert.equal(app.calls.length, model ? 1 : 0);
  }
  const future = fixture(), id = create(future, false, "once", "2026-10-20 09:00");
  apply(future, "pause", [entry(id)]); const next = future.scheduler.items[0].nextAt;
  apply(future, "resume", [entry(id)]); assert.equal(future.scheduler.items[0].nextAt, next);
});

test("editing or cancelling paused tasks never implicitly resumes them, including native time edits", () => {
  const app = fixture(), id = create(app, true); apply(app, "pause", [entry(id)]);
  assert.match(apply(app, "update", [entry(id, "", "22:00", "换个问候")]), /已暂停/);
  assert.deepEqual(app.scheduler.items[0].generation, { model: "test-model" });
  assert.match(app.scheduler.command("reschedule", { query: id, schedule: "daily 23:00" }), /已暂停，未恢复/);
  assert.equal(app.scheduler.items[0].status, "paused");
  assert.match(apply(app, "update", [entry(id, "", "", "固定问候", "static")]), /已暂停/);
  assert.equal(Object.hasOwn(app.scheduler.items[0], "generation"), false);
  const before = state(app); apply(app, "pause", [entry(id)]); assert.equal(state(app), before);
  assert.match(app.scheduler.command("cancelreminder", id), /已取消/);
  const cancelled = state(app); assert.match(apply(app, "resume", [entry(id)]), /未更改/);
  assert.equal(state(app), cancelled);
});

test("nonworking resume skips makeup workdays and unknown calendar coverage does not become an ordinary daily task", async () => {
  for (const model of [false, true]) {
    const app = fixture(); app.at("2026-10-09 20:00");
    const id = create(app, model, "nonworking", "06:01"); apply(app, "pause", [entry(id)]);
    app.at("2026-10-10 12:00"); apply(app, "resume", [entry(id)]);
    assert.equal(formatTime(Date.parse(app.scheduler.items[0].nextAt)), "2026-10-11 06:01");
    await tick(app); assert.equal(app.sent.length, 0);
    app.at("2026-10-11 06:01"); await tick(app); assert.equal(app.sent.length, 1);
    apply(app, "pause", [entry(id)]); app.at("2027-01-01 00:00");
    assert.match(apply(app, "resume", [entry(id)]), /日历待更新/);
    assert.equal(app.scheduler.items[0].status, "calendar_wait");
    await tick(app); assert.equal(app.sent.length, 1);
    assert.match(apply(app, "pause", [entry(id)]), /已暂停/);
  }
});

test("lifecycle plans reject invalid fields, repeated targets, stale snapshots and partial batches without changing any task", () => {
  const app = fixture(), id = create(app), single = create(app, false, "once", "2026-10-19 09:00");
  for (const entries of [[entry(id, "", "10:00")], [entry(id, "", "", "extra")], [entry(id, "", "", "", "static")],
    [entry(id), entry("ffffffff")], [entry(id), entry(id)]]) {
    const before = state(app); assert.match(apply(app, "pause", entries), /未更改/); assert.equal(state(app), before);
  }
  assert.match(apply(app, "resume", [entry(id)]), /未更改/);
  apply(app, "pause", [entry(id), entry(single)]); app.at("2026-10-20 10:00");
  const before = state(app); assert.match(apply(app, "resume", [entry(id), entry(single)]), /未恢复任何任务/);
  assert.equal(state(app), before);
  assert.match(apply(app, "resume", [entry(id, "daily")]), /未更改/);
  const turn = prepareTurn({ scheduler: app.scheduler, text: "暂停", privateChat: true });
  app.scheduler.cancel(single);
  const current = state(app);
  assert.match(applyResponse(JSON.stringify({ nonce: turn.nonce, action: "resume", entries: [entry(id)], message: "", delivery: "current" }), turn, app.scheduler), /状态在处理期间发生变化/);
  assert.equal(state(app), current);
});

test("pausing refuses an in-flight model or send, and a paused later task is reread before delivery", async () => {
  for (const model of [false, true]) {
    let finish;
    const extra = model ? { generate: () => new Promise(resolve => { finish = resolve; }) }
      : { send: () => new Promise(resolve => { finish = resolve; }) };
    const app = fixture(extra), first = create(app, model), second = create(app, model);
    app.at("2026-10-19 09:00"); const running = app.scheduler.tick();
    assert.equal(app.scheduler.items[0].status, "sending");
    const before = state(app); assert.match(apply(app, "pause", [entry(first)]), /未更改/); assert.equal(state(app), before);
    assert.match(apply(app, "pause", [entry(second)]), /已暂停/);
    finish("生成结果"); await running; if (app.scheduler.modelRun) await app.scheduler.modelRun;
    assert.equal(app.scheduler.items[1].status, "paused");
    assert.equal(app.scheduler.items[1].lastAttempt, null);
  }
});

test("paused tasks reserve the existing 50-task limit and failed persistence never publishes a paused state", () => {
  const app = fixture();
  for (let i = 0; i < 50; i++) app.scheduler.add(`daily 09:00 喝水${i}`);
  for (let i = 0; i < 50; i += 8) apply(app, "pause", app.scheduler.items.slice(i, i + 8).map(task => entry(task.id)));
  assert.ok(app.scheduler.items.every(task => task.status === "paused"));
  assert.match(app.scheduler.add("daily 10:00 新任务"), /任务数量已达上限/);
  assert.match(apply(app, "create", [entry("", "daily", "10:00", "新任务", "static")]), /任务数量已达上限/);
  const blocked = fixture(), id = create(blocked), originalFile = blocked.scheduler.filename, before = state(blocked);
  blocked.scheduler.filename = path.join(originalFile, "child.json");
  assert.match(apply(blocked, "pause", [entry(id)]), /保存失败/);
  assert.equal(blocked.scheduler.items[0].status, "pending"); assert.equal(blocked.scheduler.failed, true);
  assert.equal(state(blocked), before);
});

test("paused records require v4, preserve ordinary/model record shape, and corrupt state is never overwritten", () => {
  for (const platform of ["telegram", "discord"]) {
    const app = fixture({ platform }), id = create(app); apply(app, "pause", [entry(id)]);
    assert.equal(new ReminderScheduler(app.options).items[0].status, "paused");
    const data = JSON.parse(state(app)); assert.equal(data.version, 4);
    for (const version of [1, 2, 3, 5]) {
      const content = JSON.stringify({ ...data, version }); fs.writeFileSync(app.options.filename, content);
      assert.throws(() => new ReminderScheduler(app.options)); assert.equal(state(app), content);
    }
  }
});

test("all 500 stored tasks and their states are listed, and both platforms split the complete result without silently truncating older records", async () => {
  const app = fixture(), id = create(app), template = app.scheduler.items[0];
  const labels = ["待发送", "发送中", "已发送", "发送未确认", "已取消", "日历待更新", "已暂停", "模型生成失败"];
  const statuses = ["pending", "sending", "sent", "uncertain", "cancelled", "calendar_wait", "paused", "failed"];
  const tasks = Array.from({ length: 500 }, (_, i) => {
    const status = statuses[i % statuses.length], history = ["sending", "sent", "uncertain", "failed"].includes(status);
    return { ...template, id: i.toString(16).padStart(8, "0"), kind: status === "calendar_wait" ? "nonworking" : "once", time: status === "calendar_wait" ? "09:00" : null,
      text: "第" + i + "个任务 " + "测试内容".repeat(20), status,
      lastAttempt: history ? template.createdAt : null, lastResult: status === "failed" ? "generation_failed" : status === "sent" ? "sent" : status === "uncertain" ? "uncertain" : null,
      ...(status === "failed" ? { generation: { model: "test-model" } } : {}) };
  });
  app.scheduler.persist(tasks);
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: "synthetic_bot_credential", ALLOWED_USER_ID: "42", SESSION_FILE: path.join(directory, `sessions-${++sequence}.json`) });
  const chunks = [], handler = createMessageHandler({ config, reminders: app.scheduler, store: new SessionStore(config.sessionFile, config),
    runner: async options => response(options, "list"), bot: { _request: async () => {}, sendMessage: async (_user, text) => chunks.push(text) } });
  await handler({ text: "查看所有定时任务及当前状态", from: { id: 42 }, chat: { id: 42, type: "private" }, message_id: 1 });
  const text = chunks.join(""); assert.match(text, /共 500 条/);
  for (const task of tasks) assert.ok(text.includes(task.id), task.id);
  for (const label of labels) assert.ok(text.includes(label), label);
  assert.ok(chunks.length > 1 && chunks.every(chunk => chunk.length <= 3500));
  assert.equal(app.scheduler.items.length, 500); assert.ok(!text.includes("最近 20 条"));
  const discordChunks = [];
  const transport = createDiscordTransport({ request: async (_method, _route, body) => {
    discordChunks.push(body.content); assert.deepEqual(body.allowed_mentions.parse, []);
  } });
  await transport.reply({ chat: { id: "123456789012345678" }, message_id: "223456789012345678" }, text);
  assert.equal(discordChunks.join(""), text);
  assert.ok(discordChunks.length > 1 && discordChunks.every(chunk => chunk.length <= 1900));
});

test("natural operation envelopes work on TG and Discord; ambiguity, negatives, private scope and disabled delivery keep state safe", async () => {
  for (const platform of ["telegram", "discord"]) {
    const app = fixture({ platform }), id = create(app), output = [];
    const config = loadConfig(platform === "telegram" ? { TELEGRAM_BOT_TOKEN: "synthetic_bot_credential", ALLOWED_USER_ID: "42" }
      : { DISCORD_BOT_TOKEN: "synthetic_bot_credential", DISCORD_ALLOWED_USER_ID: "42" }, { platform });
    config.sessionFile = path.join(directory, `sessions-${++sequence}.json`);
    const plans = [["暂停喝水提醒", "pause"], ["恢复刚才那个提醒", "resume"], ["查看目前全部定时任务及状态", "list"]];
    const handler = createMessageHandler({ config, reminders: app.scheduler, store: new SessionStore(config.sessionFile, config),
      bot: { _request: async () => {}, sendMessage: async (_user, text) => output.push(text) },
      ...(platform === "discord" ? { transport: { markReceived: async () => {}, reply: async (_msg, text) => output.push(text) } } : {}),
      runner: async options => {
        const request = context(options).currentMessage, action = plans.find(([text]) => text === request)[1];
        return response(options, action, action === "list" ? [] : [entry(id)]);
      } });
    for (const [text, action] of plans) {
      await handler({ text, from: { id: 42 }, chat: { id: 42, type: "private" }, message_id: 1 });
      assert.equal(app.scheduler.items[0].status, action === "pause" ? "paused" : "pending");
    }
    assert.ok(output.some(text => text.includes("已暂停"))); assert.ok(output.some(text => text.includes("已恢复")));
    for (const options of [{ privateChat: false }, { allowActions: false }]) {
      const before = state(app); assert.match(apply(app, "pause", [entry(id)], options), /私聊|未更改/); assert.equal(state(app), before);
    }
    const turn = prepareTurn({ scheduler: app.scheduler, text: "不要暂停/“暂停喝水提醒”是什么意思", privateChat: true });
    const before = state(app);
    for (const action of ["chat", "clarify"]) {
      applyResponse(JSON.stringify({ nonce: turn.nonce, action, entries: [], message: "候选不明确或普通讨论", delivery: "current" }), turn, app.scheduler);
      assert.equal(state(app), before);
    }
    app.scheduler.enabled = false;
    assert.match(apply(app, "pause", [entry(id)]), /已暂停/);
    assert.match(apply(app, "resume", [entry(id)]), /私聊发送已关闭/);
    assert.equal(app.scheduler.items[0].status, "paused");
  }
});
