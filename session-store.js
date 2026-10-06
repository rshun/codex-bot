const fs = require("node:fs");
const path = require("node:path");
const { validateReport, copyReport } = require("./usage");

const THREAD_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const SESSION_KEY = /^-?\d+:\d+:\d+$/;

function validateSession(session) {
  return session && typeof session === "object" &&
    (session.threadId === null || (typeof session.threadId === "string" && THREAD_ID.test(session.threadId))) &&
    (session.model === null || (typeof session.model === "string" && MODEL_NAME.test(session.model))) &&
    validateReport(session.lastUsage);
}

function copySession(session) {
  return { threadId: session.threadId, model: session.model,
    ...(session.lastUsage !== undefined ? { lastUsage: copyReport(session.lastUsage) } : {}) };
}

function replaceStateFile(source, destination, rename = fs.renameSync, platform = process.platform) {
  for (let attempt = 0; ; attempt++) {
    try { rename(source, destination); return; }
    catch (error) {
      // Windows may briefly lock a recently replaced file. Keep the old file intact on failure.
      if (platform !== "win32" || error.code !== "EPERM" || attempt === 4) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
    }
  }
}

class SessionStore {
  constructor(filename, { workdir, codexHome }) {
    this.filename = path.resolve(filename);
    this.context = { workdir: path.resolve(workdir), codexHome: path.resolve(codexHome) };
    this.sessions = {};
    if (!fs.existsSync(this.filename)) return;

    // Never silently replace a corrupt store or reuse it with another Codex home.
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.filename, "utf8"));
    } catch {
      throw new Error("会话状态无法读取，请备份后检查 SESSION_FILE。");
    }
    if (data?.version !== 1 || data.workdir !== this.context.workdir ||
        data.codexHome !== this.context.codexHome || !data.sessions ||
        typeof data.sessions !== "object" || Array.isArray(data.sessions)) {
      throw new Error("会话状态格式或运行目录不匹配，请检查 SESSION_FILE、WORKDIR 和 CODEX_HOME。");
    }
    for (const [key, session] of Object.entries(data.sessions)) {
      if (!SESSION_KEY.test(key) || !validateSession(session)) {
        throw new Error("会话状态包含无效记录，请备份后检查 SESSION_FILE。");
      }
      this.sessions[key] = copySession(session);
    }
  }

  get(key) {
    return copySession(this.sessions[key] || { threadId: null, model: null });
  }

  set(key, session) {
    if (!SESSION_KEY.test(key) || !validateSession(session)) {
      throw new Error("无效的会话状态。");
    }
    const sessions = { ...this.sessions, [key]: copySession(session) };
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    // Same-directory rename makes replacement atomic; publish in-memory state only after success.
    const temporary = `${this.filename}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, ...this.context, sessions }, null, 2) + "\n", {
      encoding: "utf8", mode: 0o600,
    });
    replaceStateFile(temporary, this.filename);
    this.sessions = sessions;
  }
}

module.exports = { SessionStore, THREAD_ID, MODEL_NAME, replaceStateFile };
