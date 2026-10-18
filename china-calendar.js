const fs = require("node:fs");
const { defaultCalendarFile, readAsset } = require("./runtime-paths");
const DAY = 86400000;
const OFFSET = 8 * 3600000;

class CalendarError extends Error {
  constructor(kind) { super(`Holiday calendar ${kind} failed.`); this.kind = kind; }
}

function beijingDay(now) { return new Date(now + OFFSET).toISOString().slice(0, 10); }

class ChinaCalendar {
  constructor(filename = defaultCalendarFile()) {
    this.years = new Map();
    try {
      if (filename && fs.statSync(filename).size > 1024 * 1024) throw new Error();
      const content = filename ? fs.readFileSync(filename) : readAsset("china-calendar.json");
      if (content.length > 1024 * 1024) throw new Error();
      const data = JSON.parse(content.toString("utf8"));
      if (data?.version !== 1 || !data.years || Array.isArray(data.years) || typeof data.years !== "object" ||
          !Object.keys(data.years).length) throw new Error();
      for (const [year, entry] of Object.entries(data.years)) {
        if (!/^20\d{2}$/.test(year) || typeof entry?.source !== "string" || !entry.source.startsWith("https://") ||
            !Array.isArray(entry.holidays) || !entry.holidays.length || !Array.isArray(entry.workdays)) throw new Error();
        const dates = [...entry.holidays, ...entry.workdays];
        if (dates.length > 366 || new Set(dates).size !== dates.length || dates.some(date => {
          if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !date.startsWith(year + "-")) return true;
          const parsed = Date.parse(date + "T00:00:00+08:00");
          return !Number.isFinite(parsed) || beijingDay(parsed) !== date;
        })) throw new Error();
        this.years.set(year, { holidays: new Set(entry.holidays), workdays: new Set(entry.workdays) });
      }
    } catch { throw new CalendarError("data"); }
  }

  isNonworking(now) {
    const date = beijingDay(now), entry = this.years.get(date.slice(0, 4));
    if (!entry) throw new CalendarError("coverage");
    if (entry.workdays.has(date)) return false;
    const weekday = new Date(now + OFFSET).getUTCDay();
    return entry.holidays.has(date) || weekday === 0 || weekday === 6;
  }

  next(time, now) {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new CalendarError("time");
    let candidate = Date.parse(`${beijingDay(now)}T${time}:00+08:00`);
    if (candidate <= now) candidate += DAY;
    for (let day = 0; day < 366; day++, candidate += DAY) {
      if (this.isNonworking(candidate)) return candidate;
    }
    throw new CalendarError("coverage");
  }
}

module.exports = { ChinaCalendar, CalendarError };
