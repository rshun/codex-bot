const { spawn } = require("node:child_process");
const { THREAD_ID, MODEL_NAME } = require("./session-store");
const { normalizeUsage } = require("./usage");

function buildArgs({ threadId, model }) {
  if (threadId && !THREAD_ID.test(threadId)) throw new Error("Invalid thread ID");
  if (model && !MODEL_NAME.test(model)) throw new Error("Invalid model name");
  const args = ["exec"];
  if (threadId) args.push("resume");
  args.push("--json", "--skip-git-repo-check");
  if (model) args.push("--model", model);
  if (threadId) args.push(threadId);
  // Prompts use stdin so text beginning with '-' cannot become CLI options.
  args.push("-");
  return args;
}

function runCodex({ bin, workdir, env, prompt, threadId, model, timeoutMs, onThread }, spawnProcess = spawn) {
  return new Promise((resolve) => {
    let child;
    const childEnv = { ...env };
    delete childEnv.TELEGRAM_BOT_TOKEN;
    delete childEnv.ALLOWED_USER_ID;
    try {
      child = spawnProcess(bin, buildArgs({ threadId, model }), {
        cwd: workdir, env: childEnv, shell: false, stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      resolve({ ok: false, kind: "launch" });
      return;
    }

    let buffer = "";
    let answer = "";
    let usage = null;
    let currentThread = threadId || null;
    let completed = false;
    let failure;
    let killTimer;
    let closed = false;

    function stop(kind) {
      if (failure || closed) return;
      failure = kind;
      try { child.kill("SIGTERM"); } catch { /* close/error handles failure */ }
      killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* no raw error logging */ }
      }, 5000);
    }

    function parseLine(line) {
      if (!line.trim() || failure) return;
      let event;
      try { event = JSON.parse(line); } catch { stop("protocol"); return; }
      if (!event || typeof event !== "object") { stop("protocol"); return; }

      if (event.type === "thread.started") {
        if (typeof event.thread_id !== "string" || !THREAD_ID.test(event.thread_id) ||
            (currentThread && currentThread !== event.thread_id)) {
          stop("protocol");
          return;
        }
        currentThread = event.thread_id;
        // Save immediately, including when a first turn later fails or times out.
        try { onThread(currentThread); } catch { stop("state"); }
      } else if (event.type === "item.completed" && event.item?.type === "agent_message" &&
                 event.item.phase !== "commentary") {
        if (typeof event.item.text !== "string") { stop("protocol"); return; }
        if (event.item.text.length > 200000) { stop("output_limit"); return; }
        answer = event.item.text;
      } else if (event.type === "turn.completed") {
        completed = true;
        // This is a snapshot of the CLI report, never a value to re-add on resume.
        usage = normalizeUsage(event.usage);
      } else if (event.type === "turn.failed" || event.type === "error") {
        // Error payloads may contain prompts, credentials, and command output.
        stop("execution");
      }
    }

    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    child.on("error", () => { failure = failure || "launch"; });
    child.stdin.on("error", () => stop("input"));
    child.stdout.on("error", () => stop("protocol"));
    child.stderr.on("error", () => stop("execution"));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text) => {
      if (failure) return;
      buffer += text;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.length > 8 * 1024 * 1024) { stop("output_limit"); break; }
        parseLine(line);
        if (failure) { buffer = ""; break; }
      }
      if (buffer.length > 8 * 1024 * 1024) { buffer = ""; stop("output_limit"); }
    });
    // Drain stderr without storing or forwarding it to Telegram or logs.
    child.stderr.on("data", () => {});
    child.on("close", (code) => {
      if (!failure && buffer.trim()) parseLine(buffer);
      closed = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (failure || code !== 0) {
        resolve({ ok: false, kind: failure || "execution", usage });
      } else if (!completed || !currentThread) {
        resolve({ ok: false, kind: "protocol", usage });
      } else {
        resolve({ ok: true, threadId: currentThread, text: answer.trim() || "（本轮未返回文本。）", usage });
      }
    });
    child.stdin.end(prompt);
  });
}

module.exports = { buildArgs, runCodex };
