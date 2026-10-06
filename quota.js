const { spawn } = require("node:child_process");
const { formatTime } = require("./usage");

function normalizeWindow(window) {
  if (!window || typeof window !== "object" || Array.isArray(window)) return null;
  return {
    usedPercent: typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent) &&
      window.usedPercent >= 0 ? window.usedPercent : null,
    minutes: Number.isSafeInteger(window.windowDurationMins) && window.windowDurationMins > 0
      ? window.windowDurationMins : null,
    resetsAt: Number.isSafeInteger(window.resetsAt) && window.resetsAt >= 0 && window.resetsAt <= 8640000000000
      ? window.resetsAt : null,
  };
}

function normalizeQuota(result) {
  const byId = result.rateLimitsByLimitId;
  let entries = byId && typeof byId === "object" && !Array.isArray(byId) ? Object.entries(byId) : [];
  if (!entries.length && result.rateLimits && typeof result.rateLimits === "object" && !Array.isArray(result.rateLimits)) {
    entries = [[result.rateLimits.limitId || "codex", result.rateLimits]];
  }
  const validEntries = entries.filter(([, value]) => value && typeof value === "object" && !Array.isArray(value));
  const label = (value) => typeof value === "string" && /^[A-Za-z0-9._/-]{1,128}$/.test(value) ? value : null;
  return {
    buckets: validEntries.slice(0, 20).map(([id, bucket], index) => ({
      name: label(bucket.limitName) || label(bucket.limitId) || label(id) || `额度组${index + 1}`,
      primary: normalizeWindow(bucket.primary), secondary: normalizeWindow(bucket.secondary),
    })),
    truncated: validEntries.length > 20,
  };
}

function queryQuota({ bin, workdir, env, timeoutMs = 15000 }, spawnProcess = spawn) {
  return new Promise((resolve) => {
    let child;
    const childEnv = { ...env };
    delete childEnv.TELEGRAM_BOT_TOKEN;
    delete childEnv.ALLOWED_USER_ID;
    try {
      // Default stdio transport also works with CLI versions predating --listen.
      child = spawnProcess(bin, ["app-server"], {
        cwd: workdir, env: childEnv, shell: false, stdio: ["pipe", "pipe", "pipe"],
      });
    } catch { resolve({ ok: false, kind: "launch" }); return; }

    let buffer = "";
    let waitingFor = 0;
    let outcome;
    let closed = false;
    let shutdownTimer;
    let killTimer;

    function kill(signal) {
      try { child.kill(signal); } catch { /* never log raw errors */ }
    }
    function finish(result) {
      if (outcome || closed) return;
      outcome = result;
      clearTimeout(timer);
      if (result.ok) {
        // Let EOF shut down the helper first; keep it bounded if a CLI ignores EOF.
        shutdownTimer = setTimeout(() => {
          killTimer = setTimeout(() => kill("SIGKILL"), 1000);
          kill("SIGTERM");
        }, 1000);
        child.stdin.end();
      } else {
        killTimer = setTimeout(() => kill("SIGKILL"), 1000);
        kill("SIGTERM");
      }
    }
    function send(message) {
      if (outcome || closed) return;
      try { child.stdin.write(JSON.stringify(message) + "\n"); }
      catch { finish({ ok: false, kind: "protocol" }); }
    }
    function parseLine(line) {
      if (!line.trim() || outcome) return;
      let message;
      try { message = JSON.parse(line); } catch { finish({ ok: false, kind: "protocol" }); return; }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        finish({ ok: false, kind: "protocol" }); return;
      }
      // Ignore notifications and unrelated replies, never expose their contents.
      if (message.id !== waitingFor) return;
      if (message.error) {
        finish({ ok: false, kind: message.error.code === -32601 ? "api_unavailable" : "query" });
        return;
      }
      if (!message.result || typeof message.result !== "object" || Array.isArray(message.result)) {
        finish({ ok: false, kind: "protocol" }); return;
      }
      if (waitingFor === 0) {
        send({ method: "initialized", params: {} });
        waitingFor = 1;
        send({ id: 1, method: "account/read", params: { refreshToken: false } });
      } else if (waitingFor === 1) {
        const account = message.result.account;
        if (!account) {
          finish({ ok: false, kind: message.result.requiresOpenaiAuth === false ? "unsupported_auth" : "not_logged_in" });
        } else if (account.type !== "chatgpt") {
          finish({ ok: false, kind: "unsupported_auth" });
        } else {
          waitingFor = 2;
          send({ id: 2, method: "account/rateLimits/read", params: {} });
        }
      } else {
        finish({ ok: true, ...normalizeQuota(message.result), queriedAt: new Date().toISOString() });
      }
    }

    const timer = setTimeout(() => finish({ ok: false, kind: "timeout" }), timeoutMs);
    child.on("error", () => finish({ ok: false, kind: "launch" }));
    child.stdin.on("error", () => { if (!outcome) finish({ ok: false, kind: "protocol" }); });
    child.stdout.on("error", () => finish({ ok: false, kind: "protocol" }));
    child.stderr.on("error", () => finish({ ok: false, kind: "query" }));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text) => {
      if (outcome) return;
      buffer += text;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.length > 1024 * 1024) { finish({ ok: false, kind: "protocol" }); break; }
        parseLine(line);
        if (outcome) { buffer = ""; break; }
      }
      if (buffer.length > 1024 * 1024) { buffer = ""; finish({ ok: false, kind: "protocol" }); }
    });
    child.stderr.on("data", () => {});
    child.on("close", () => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(shutdownTimer);
      clearTimeout(killTimer);
      resolve(outcome || { ok: false, kind: "protocol" });
    });
    send({ id: 0, method: "initialize", params: {
      clientInfo: { name: "codex_tg_bot", title: "Codex Telegram Bot", version: "1.0.0" },
    } });
  });
}

function formatQuota(result) {
  if (!result.ok) {
    const errors = {
      launch: "额度查询启动失败，请检查 CODEX_BIN、WORKDIR 和执行权限。",
      not_logged_in: "运行 Bot 的 Codex 账号尚未登录，请在 Debian 的同一运行账号下检查登录状态。",
      unsupported_auth: "当前登录方式不支持 ChatGPT 账号额度查询。API Key、Bedrock 或第三方 provider 的额度请到对应平台查询。",
      api_unavailable: "当前 Codex CLI 不支持所需额度接口，请核实 Debian 的 CLI 版本。",
      query: "额度查询失败，请检查 Codex 登录状态、账号权限和网络。",
      timeout: "额度查询超时，请稍后重试。",
      protocol: "额度查询协议不符合预期，请核实 Codex app-server 的版本和兼容性。",
    };
    return errors[result.kind] || "额度查询失败。";
  }
  const lines = ["ChatGPT / Codex 账号额度", `查询时间：${formatTime(result.queriedAt)}（北京时间）`];
  if (!result.buckets.length) lines.push("账号已登录，但服务暂未返回额度数据；未知不代表剩余 0%。");
  const percent = (value) => value === null ? "未知" : `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
  for (const bucket of result.buckets) {
    lines.push(`\n${bucket.name}`);
    let anyWindow = false;
    for (const [key, name] of [["primary", "主窗口"], ["secondary", "次窗口"]]) {
      const window = bucket[key];
      if (!window) continue;
      anyWindow = true;
      const duration = window.minutes === null ? "时长未知" : window.minutes % 1440 === 0
        ? `${window.minutes / 1440} 天` : window.minutes % 60 === 0 ? `${window.minutes / 60} 小时` : `${window.minutes} 分钟`;
      const remaining = window.usedPercent === null ? null : Math.max(0, Math.min(100, 100 - window.usedPercent));
      lines.push(`${name}（${duration}）：已用 ${percent(window.usedPercent)}，剩余 ${percent(remaining)}`,
        `重置时间：${window.resetsAt === null ? "未知" : `${formatTime(window.resetsAt * 1000)}（北京时间）`}`);
    }
    if (!anyWindow) lines.push("额度窗口：未知");
  }
  if (result.truncated) lines.push("仅显示前 20 个额度组。");
  lines.push("\n这是账号共享额度，包含其他客户端的消耗；不能与 token 数直接换算。");
  return lines.join("\n");
}

module.exports = { queryQuota, normalizeQuota, formatQuota };
