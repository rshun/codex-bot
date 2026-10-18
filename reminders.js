const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { replaceStateFile } = require("./session-store");

const DAY = 86400000;
const OFFSET = 8 * 3600000;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const ID = /^[a-f0-9]{8}$/;
const HELP = [
  "定时消息（北京时间，仅私聊）：",
  "/remind YYYY-MM-DD HH:mm 内容 — 指定日期发送一次",
  "/remind daily HH:mm 内容 — 每天发送",
  "也可直接说：每天晚上9点提醒我喝水、明天早上8点半提醒我吃早餐",
  "/reminders — 查看任务及最近发送结果",
  "/cancelreminder 任务ID — 取消待发任务",
  "也可说：查看我的提醒、取消喝水提醒、取消提醒 任务ID",
  "到时发送保存的文字，不调用 Codex。Bot 需保持运行。",
].join("\n");
const LABELS = { pending: "待发送", sending: "发送中", sent: "已发送", uncertain: "发送未确认", cancelled: "已取消" };

class ReminderError extends Error {
  constructor(kind) { super(`Reminder ${kind} failed.`); this.kind = kind; }
}

function formatTime(milliseconds) {
  return new Date(milliseconds + OFFSET).toISOString().slice(0, 16).replace("T", " ");
}

function parseTime(value) {
  if (!/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return NaN;
  const milliseconds = Date.parse(value.replace(" ", "T") + ":00+08:00");
  return Number.isFinite(milliseconds) && formatTime(milliseconds) === value ? milliseconds : NaN;
}

function nextDaily(time, now) {
  const day = formatTime(now).slice(0, 10);
  const candidate = parseTime(`${day} ${time}`);
  return candidate > now ? candidate : candidate + DAY;
}

function chineseNumber(value) {
  if (/^\d{1,2}$/.test(value)) return Number(value);
  const digits = "零一二三四五六七八九";
  value = value.replace(/两/g, "二").replace(/〇/g, "零");
  if (/^[零一二三四五六七八九]$/.test(value)) return digits.indexOf(value);
  const tens = value.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
  return tens ? (tens[1] ? digits.indexOf(tens[1]) : 1) * 10 + (tens[2] ? digits.indexOf(tens[2]) : 0) : NaN;
}

// A bounded grammar: only a complete, explicit reminder request bypasses ordinary chat.
// Keep reminder content untouched; normalize only the time expression.
function parseNaturalReminder(text, now = Date.now()) {
  const request = text.trim().replace(/^(?:请帮我|帮我|请)\s*/, "");
  const management = request.replace(/[。！!]$/, "").trim();
  if (/^(?:(?:查看|查询|列出|看看)(?:一下)?\s*(?:我的\s*)?(?:(?:全部|所有)\s*)?(?:定时)?提醒(?:列表)?|我有哪些提醒|提醒列表)$/.test(management)) {
    return { command: "reminders", argument: "" };
  }
  const cancelId = management.match(/^(?:取消|撤销)\s*(?:我的)?\s*提醒\s*([a-f0-9]{8})$/i);
  if (cancelId) return { command: "cancelreminder", argument: cancelId[1].toLowerCase() };
  const cancelText = management.match(/^(?:取消|撤销)\s*(?:我的)?\s*(.*?)\s*(?:的)?提醒$/);
  if (cancelText) {
    const query = cancelText[1].trim();
    if (query && query.length <= 1000 && !/^(?:全部|所有)(?:的)?$/.test(query) && !/[?？\r\n]|提醒/.test(query)) {
      return ID.test(query.toLowerCase()) ? { command: "cancelreminder", argument: query.toLowerCase() }
        : { command: "cancelmatching", argument: query };
    }
  }
  if (/^(?:取消|撤销)[\s\S]*提醒/.test(management)) {
    return { error: "未取消提醒：请说“取消喝水提醒”或“取消提醒 任务ID”。一次只取消一个明确任务，不支持批量取消。" };
  }
  if (!/^(?:每天|每日|今天|明天|后天|今晚|明早|\d{4}[-年]|每周|每月|下周|周[一二三四五六日天]|早上|上午|中午|下午|晚上|凌晨)/.test(request) ||
      !request.includes("提醒我")) return null;
  const invalid = { error: "未创建提醒：请明确日期或每天、上午/下午及时间，例如“每天晚上9点提醒我喝水”或“明天 08:30 提醒我出门”。目前支持每天、今天、明天、后天及具体日期，均为北京时间。" };
  if (/[?？]\s*$|(?:可以吗|能行吗|行不行|好不好|对吗|怎么设置|如何设置|是什么意思|如何实现|怎么实现)[。！!]?\s*$/.test(request)) return invalid;
  const separator = request.indexOf("提醒我");
  let when = request.slice(0, separator).trim().replace(/[，,：:]$/, "").trim();
  const content = request.slice(separator + 3).trim();
  if (!content || content.includes("提醒我")) return invalid;
  when = when.replace(/^今晚/, "今天晚上").replace(/^明早/, "明天早上").replace(/^每日/, "每天");
  const schedule = when.match(/^(每天|今天|明天|后天|\d{4}年\d{1,2}月\d{1,2}日)\s*(?:的)?(.+)$/) ||
    when.match(/^(\d{4}-\d{1,2}-\d{1,2})(?:\s+|(?=凌晨|早上|上午|中午|下午|晚上))(.+)$/);
  if (!schedule) return invalid;
  const clock = schedule[2].replace(/\s/g, "").match(/^(凌晨|早上|上午|中午|下午|晚上)?(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})(?:[:：](\d{2})|[点时](?:(半|一刻|三刻)|(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})分?)?)$/);
  if (!clock) return invalid;
  let hour = chineseNumber(clock[2]);
  const minute = clock[3] !== undefined ? Number(clock[3]) : clock[4] ? { 半: 30, 一刻: 15, 三刻: 45 }[clock[4]]
    : clock[5] !== undefined ? chineseNumber(clock[5]) : 0;
  const period = clock[1];
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return invalid;
  if (period) {
    if (hour < 1 || hour > 12) return invalid;
    if (period === "凌晨") hour = hour === 12 ? 0 : hour;
    if (period === "中午") hour = hour === 1 ? 13 : hour;
    if (period === "下午" || period === "晚上") hour += 12;
    // Reject conflicting periods, especially “晚上12点” with an unclear calendar date.
    const ranges = { 凌晨: [0, 5], 早上: [6, 11], 上午: [6, 11], 中午: [11, 13], 下午: [13, 18], 晚上: [18, 23] };
    if (hour < ranges[period][0] || hour > ranges[period][1]) return invalid;
  } else if (hour > 0 && hour <= 12 && clock[3] === undefined) {
    return invalid; // “9点” needs a period; “09:00” explicitly uses the 24-hour clock.
  }
  if (hour < 0 || hour > 23) return invalid;
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  if (schedule[1] === "每天") return { argument: `daily ${time} ${content}` };
  const relative = { 今天: 0, 明天: 1, 后天: 2 };
  const date = Object.hasOwn(relative, schedule[1]) ? formatTime(now + relative[schedule[1]] * DAY).slice(0, 10)
    : schedule[1].match(/\d+/g).map((part, index) => index ? part.padStart(2, "0") : part).join("-");
  if (!Number.isFinite(parseTime(`${date} ${time}`))) return invalid;
  return { argument: `${date} ${time} ${content}` };
}

function validISO(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validTask(task) {
  return task && typeof task === "object" && typeof task.id === "string" && ID.test(task.id) &&
    ["once", "daily"].includes(task.kind) &&
    (task.kind === "daily" ? typeof task.time === "string" && TIME.test(task.time) : task.time === null) &&
    typeof task.text === "string" && !!task.text.trim() && task.text.length <= 1000 &&
    validISO(task.nextAt) && validISO(task.createdAt) && Object.hasOwn(LABELS, task.status) &&
    (task.lastAttempt === null || validISO(task.lastAttempt)) &&
    [null, "sent", "uncertain"].includes(task.lastResult) &&
    (task.status !== "sending" || task.lastAttempt !== null) &&
    (task.kind !== "daily" || (["pending", "sending", "cancelled"].includes(task.status) && formatTime(Date.parse(task.nextAt)).slice(11) === task.time)) &&
    (task.lastResult === null || task.lastAttempt !== null) &&
    Object.keys(task).length === 9;
}

class ReminderScheduler {
  constructor({ filename, platform, userId, send, sanitize = (text) => text, enabled = true,
                now = Date.now, logger = console, timers = { setInterval, clearInterval } }) {
    if (!["telegram", "discord"].includes(platform) || !/^[1-9]\d{0,19}$/.test(userId)) throw new ReminderError("configuration");
    this.filename = path.resolve(filename);
    Object.assign(this, { platform, userId, send, sanitize, enabled, now, logger, timers });
    this.items = [];
    this.failed = false;
    this.ticking = false;
    this.recovered = false;
    this.stopping = false;
    if (!fs.existsSync(this.filename)) return;
    try {
      if (fs.statSync(this.filename).size > 2 * 1024 * 1024) throw new Error();
      const data = JSON.parse(fs.readFileSync(this.filename, "utf8"));
      if (data?.version !== 1 || data.platform !== platform || data.userId !== userId ||
          !Array.isArray(data.items) || data.items.length > 500 || data.items.some((item) => !validTask(item)) ||
          new Set(data.items.map((item) => item.id)).size !== data.items.length) throw new Error();
      this.items = data.items;
    } catch { throw new ReminderError("state"); }
  }

  persist(items) {
    if (this.failed) throw new ReminderError("state");
    try {
      fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, platform: this.platform,
        userId: this.userId, items }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      replaceStateFile(temporary, this.filename);
      this.items = items;
    } catch {
      this.failed = true;
      throw new ReminderError("state");
    }
  }

  update(id, changes) {
    this.persist(this.items.map((item) => item.id === id ? { ...item, ...changes } : item));
  }

  add(argument) {
    if (!this.enabled) return "私聊发送已关闭，请先启用 DISCORD_ALLOW_DMS。";
    const daily = argument.match(/^daily\s+((?:[01]\d|2[0-3]):[0-5]\d)\s+([\s\S]+)$/i);
    const once = argument.match(/^(\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d)\s+([\s\S]+)$/);
    if (!daily && !once) return HELP;
    const now = this.now();
    const next = daily ? nextDaily(daily[1], now) : parseTime(once[1]);
    if (!Number.isFinite(next) || next <= now) return "时间无效或已经过去，请使用未来的北京时间。";
    const original = (daily ? daily[2] : once[2]).trim();
    if (!original || original.length > 1000) return "提醒内容须为 1–1000 个字符。";
    if (this.items.length >= 500 || this.items.filter((item) => ["pending", "sending"].includes(item.status)).length >= 50) {
      return "任务数量已达上限（50 个待发任务、500 条总记录），请先取消不需要的任务；总记录满时联系维护者备份归档。";
    }
    const text = this.sanitize(original);
    if (!text.trim() || text.length > 1000) return "脱敏后的提醒内容过长，请缩短内容。";
    let id;
    do { id = randomUUID().slice(0, 8); } while (this.items.some((item) => item.id === id));
    const task = { id, kind: daily ? "daily" : "once", time: daily ? daily[1] : null, text,
      nextAt: new Date(next).toISOString(), createdAt: new Date(now).toISOString(),
      status: "pending", lastAttempt: null, lastResult: null };
    this.persist([...this.items, task]);
    return `已保存定时消息：${id}\n${daily ? `每天 ${daily[1]}；下次` : "发送时间"}：${formatTime(next)}（北京时间）\n届时私聊发送：${text}\n取消：/cancelreminder ${id}`;
  }

  list() {
    const lines = [...this.items].reverse().slice(0, 20).map((item) =>
      `${item.id} · ${LABELS[item.status]} · ${item.kind === "daily" ? `每天 ${item.time}，下次 ` : ""}${formatTime(Date.parse(item.nextAt))}` +
      (item.lastResult ? ` · 最近${LABELS[item.lastResult]}` : "") + `\n${item.text}`);
    return [this.failed ? "状态保存失败，定时发送已暂停；请检查权限并重启。" : "定时消息（北京时间，最近 20 条）：",
      ...(!this.enabled ? ["私聊发送已关闭，待发任务暂停。"] : []),
      ...(lines.length ? lines : ["暂无定时消息。"]),
      "发送未确认的那一轮不会自动重发；可先检查私聊记录。"].join("\n");
  }

  cancel(id) {
    if (!ID.test(id)) return "用法：/cancelreminder 8位任务ID";
    const task = this.items.find((item) => item.id === id);
    if (!task) return "未找到该定时消息。";
    if (task.status === "sending") return "本次消息已经开始发送，无法撤回；请稍后取消后续任务。";
    if (task.status !== "pending") return "该任务已经结束或取消。";
    this.update(id, { status: "cancelled" });
    return `已取消定时消息：${id}`;
  }

  cancelMatching(query) {
    if (typeof query !== "string" || !query.trim() || query.length > 1000) return "请提供要取消的提醒内容，未取消任何任务。";
    query = query.trim();
    // Search only active tasks, using literal contents rather than model guesses or regular expressions.
    const matches = this.items.filter((item) => ["pending", "sending"].includes(item.status) &&
      item.text.toLowerCase().includes(query.toLowerCase()));
    if (!matches.length) return "未找到匹配的待发提醒，未取消任何任务。请说“查看我的提醒”核对内容，或使用“取消提醒 任务ID”。";
    if (matches.length > 1) {
      const lines = matches.slice(0, 20).map((item) =>
        `${item.id} · ${LABELS[item.status]} · ${item.kind === "daily" ? `每天 ${item.time}；下次 ` : ""}${formatTime(Date.parse(item.nextAt))}（北京时间）\n${item.text}`);
      return [`匹配到 ${matches.length} 个待发或发送中的提醒，未取消任何任务。请发送“取消提醒 任务ID”明确选择：`,
        ...lines, ...(matches.length > 20 ? ["这里只显示前 20 条，请用更具体的提醒内容缩小范围。"] : [])].join("\n");
    }
    return `${this.cancel(matches[0].id)}\n内容：${matches[0].text}`;
  }

  command(name, argument) {
    try {
      if (name === "remind") return this.add(argument);
      if (name === "reminders") return this.list();
      if (name === "cancelmatching") return this.cancelMatching(argument);
      return this.cancel(argument);
    } catch { return "定时任务保存失败，调度已暂停；请检查状态目录权限并重启 Bot。"; }
  }

  async tick() {
    if (this.ticking || this.failed || !this.enabled || this.stopping) return;
    this.ticking = true;
    try {
      if (!this.recovered) {
        for (const item of this.items.slice()) {
          if (item.status !== "sending") continue;
          this.update(item.id, { status: item.kind === "daily" ? "pending" : "uncertain", lastResult: "uncertain",
            ...(item.kind === "daily" ? { nextAt: new Date(nextDaily(item.time, Math.max(this.now(), Date.parse(item.nextAt)))).toISOString() } : {}) });
        }
        this.recovered = true;
      }
      for (const snapshot of this.items.slice()) {
        if (this.stopping || this.failed) break;
        const task = this.items.find((item) => item.id === snapshot.id);
        if (task.status !== "pending" || Date.parse(task.nextAt) > this.now()) continue;
        // Save the claim BEFORE sending. A crash or an ambiguous network result must not cause a duplicate.
        this.update(task.id, { status: "sending", lastAttempt: new Date(this.now()).toISOString() });
        let result = "sent";
        try {
          await this.send(this.userId, `⏰ 定时消息 · ${task.id}\n计划时间：${formatTime(Date.parse(task.nextAt))}（北京时间）\n${this.sanitize(task.text)}`);
        } catch { result = "uncertain"; this.logger.error("Reminder delivery failed or unconfirmed."); }
        this.update(task.id, { status: task.kind === "daily" ? "pending" : result, lastResult: result,
          ...(task.kind === "daily" ? { nextAt: new Date(nextDaily(task.time, Math.max(this.now(), Date.parse(task.nextAt)))).toISOString() } : {}) });
      }
    } catch {
      this.failed = true;
      this.logger.error("Reminder state persistence failed; scheduler paused.");
    } finally { this.ticking = false; }
  }

  start() {
    if (this.timer !== undefined) return;
    this.stopping = false;
    this.timer = this.timers.setInterval(() => { void this.tick(); }, 5000);
    this.timer.unref?.();
    void this.tick();
  }

  stop() {
    this.stopping = true;
    if (this.timer !== undefined) this.timers.clearInterval(this.timer);
    this.timer = undefined;
  }
}

module.exports = { ReminderScheduler, ReminderError, parseTime, nextDaily, formatTime, parseNaturalReminder, HELP };
