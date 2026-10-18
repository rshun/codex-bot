const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync, execFileSync } = require("node:child_process");
const { SessionStore } = require("../session-store");
const { ReminderScheduler } = require("../reminders");
const { parseArgs } = require("../bot");
const { parseBuildArgs, validateBinary, writeArchive } = require("../scripts/build-executable");

const root = path.resolve(__dirname, "..");
const artifacts = path.join(root, ".test-artifacts");
fs.mkdirSync(artifacts, { recursive: true });
const suite = fs.mkdtempSync(path.join(artifacts, "executable-"));
const fixture = () => fs.mkdtempSync(path.join(suite, "case-"));
const hash = value => crypto.createHash("sha256").update(value).digest("hex");

function cleanEnv() {
  const env = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function snapshot(directory) {
  const files = {};
  const walk = (folder, relative = "") => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const name = path.join(relative, entry.name), filename = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(filename, name);
      else files[name] = hash(fs.readFileSync(filename));
    }
  };
  walk(directory);
  return files;
}

function prepare() {
  const directory = fixture();
  const workdir = path.join(directory, "workspace"), codexHome = path.join(directory, "codex-home");
  fs.mkdirSync(workdir); fs.mkdirSync(codexHome);
  const env = { WORKDIR: workdir, CODEX_HOME: codexHome, CODEX_BIN: process.execPath,
    TELEGRAM_BOT_TOKEN: "synthetic_bot_credential", ALLOWED_USER_ID: "42",
    DISCORD_BOT_TOKEN: "synthetic_discord_credential", DISCORD_ALLOWED_USER_ID: "43" };
  // Default files and custom locations both need to survive executable migration.
  for (const platform of ["telegram", "discord"]) {
    const filename = path.join(directory, ".bot-state", platform === "telegram" ? "sessions.json" : "discord-sessions.json");
    const store = new SessionStore(filename, { workdir, codexHome, platform });
    store.set(platform === "telegram" ? "42:42:0" : "discord:43:43:0", {
      threadId: "00000000-0000-0000-0000-000000000001", model: "test-model",
    });
    const reminders = new ReminderScheduler({ filename: path.join(path.dirname(filename), `${platform}-reminders.json`),
      platform, userId: platform === "telegram" ? "42" : "43", now: () => Date.parse("2026-10-09T20:00:00+08:00") });
    reminders.addBatch({ kind: "nonworking", times: ["06:01", "11:02"], text: "测试消息" });
  }
  const common = Object.entries(env).filter(([key]) => !/TOKEN|USER_ID/.test(key));
  for (const [platform, filename, entries] of [["telegram", ".env", ["TELEGRAM_BOT_TOKEN", "ALLOWED_USER_ID"]],
    ["discord", ".env.discord", ["DISCORD_BOT_TOKEN", "DISCORD_ALLOWED_USER_ID"]]]) {
    fs.writeFileSync(path.join(directory, filename), [...common, ...entries.map(key => [key, env[key]])]
      .map(([key, value]) => `${key}=${JSON.stringify(value.replaceAll("\\", "/"))}`).join("\n") + "\n");
  }
  return { directory, env, workdir, codexHome };
}

test("CLI rejects ambiguous modes and invalid combinations before importing or starting a platform", () => {
  for (const args of [[], ["tg"], ["telegram", "--apply"], ["discord", "--apply"], ["discord", "--check-config", "--register-commands"],
    ["telegram", "--check-config", "--check-config"], ["discord", "--config-dir"], ["telegram", "--unknown"]]) {
    assert.throws(() => parseArgs(args), /arguments/);
  }
  assert.deepEqual(parseArgs(["discord", "--register-commands", "--apply"]).flags, ["--register-commands", "--apply"]);
  assert.throws(() => parseBuildArgs(["--target", "linux-x64", "--target", "linux-arm64"]), error => error.kind === "arguments");
  const wrong = Buffer.alloc(64);
  assert.throws(() => validateBinary(wrong, "linux-x64"), error => error.kind === "node_target");
});

const variants = [["source", process.execPath, [path.join(root, "bot.js")]]];
if (process.env.CODEX_BOT_TEST_EXECUTABLE) variants.push(["standalone", path.resolve(process.env.CODEX_BOT_TEST_EXECUTABLE), []]);
for (const [label, executable, prefix] of variants) {
  const run = (args, cwd, env = cleanEnv()) => spawnSync(executable, [...prefix, ...args], {
    cwd, env, encoding: "utf8", timeout: 30000, windowsHide: true,
  });
  test(`${label}: help/version and command preview require no configuration or writes`, () => {
    const directory = fixture();
    for (const args of [["--help"], ["--version"], ["discord", "--register-commands"]]) {
      const result = run(args, directory);
      assert.equal(result.status, 0, result.stderr);
      if (args[0] === "discord") assert.equal(JSON.parse(result.stdout).length, 12);
    }
    const invalid = run(["telegram", "--apply"], directory);
    assert.equal(invalid.status, 1);
    assert.deepEqual(snapshot(directory), {});
  });

  test(`${label}: both modes read existing conversation and v2 reminders from the stable directory without changing bytes`, () => {
    const app = prepare(), elsewhere = fixture();
    const before = snapshot(app.directory);
    for (const platform of ["telegram", "discord"]) {
      const result = run([platform, "--config-dir", app.directory, "--check-config"], elsewhere);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /no network requests or state writes/);
    }
    assert.deepEqual(snapshot(app.directory), before);
    assert.deepEqual(snapshot(elsewhere), {});
    const corrupted = path.join(app.directory, ".bot-state", "discord-sessions.json");
    const content = fs.readFileSync(corrupted, "utf8").replace('"test-model"', '"bad model"');
    fs.writeFileSync(corrupted, content);
    const invalid = run(["discord", "--config-dir", app.directory, "--check-config"], elsewhere);
    assert.equal(invalid.status, 1);
    assert.equal(fs.readFileSync(corrupted, "utf8"), content);
    assert.doesNotMatch(invalid.stderr, /synthetic_|bad model/);
  });

  test(`${label}: explicit state/calendar paths and inherited environment take precedence`, () => {
    const app = prepare(), custom = fixture();
    const state = path.join(custom, "session.json"), reminder = path.join(custom, "reminder.json");
    fs.copyFileSync(path.join(app.directory, ".bot-state", "sessions.json"), state);
    fs.copyFileSync(path.join(app.directory, ".bot-state", "telegram-reminders.json"), reminder);
    const calendar = path.join(custom, "calendar.json");
    fs.copyFileSync(path.join(root, "china-calendar.json"), calendar);
    const env = { ...cleanEnv(), SESSION_FILE: state, REMINDER_FILE: reminder, HOLIDAY_CALENDAR_FILE: calendar };
    const before = snapshot(custom);
    assert.equal(run(["telegram", "--config-dir", app.directory, "--check-config"], app.directory, env).status, 0);
    assert.deepEqual(snapshot(custom), before);
    fs.writeFileSync(calendar, "{}");
    assert.equal(run(["telegram", "--config-dir", app.directory, "--check-config"], app.directory, env).status, 1);
    assert.equal(fs.readFileSync(calendar, "utf8"), "{}");
  });
}

test("embedded schema is materialized once, content-checked and never overwrites conflicting data", t => {
  const sea = require("node:sea");
  const runtime = require("../runtime-paths");
  const content = fs.readFileSync(path.join(root, "reminder-response.schema.json"));
  t.mock.method(sea, "isSea", () => true);
  t.mock.method(sea, "getAsset", name => {
    assert.equal(name, "reminder-response.schema.json");
    return content;
  });
  const directory = fixture();
  runtime.configureDirectory(directory);
  const schema = runtime.schemaFile();
  assert.equal(schema.startsWith(path.join(directory, ".bot-state", "runtime-assets") + path.sep), true);
  assert.equal(fs.readFileSync(schema, "utf8"), content.toString());
  assert.equal(runtime.schemaFile(), schema);
  fs.writeFileSync(schema, "conflicting data");
  assert.throws(() => runtime.schemaFile(), /schema validation failed/);
  assert.equal(fs.readFileSync(schema, "utf8"), "conflicting data");
});

test("executable archive keeps Linux mode 0755 on Windows and does not include unlisted private files", async () => {
  const directory = fixture(), output = fixture();
  const long = "deploy/" + "x".repeat(70) + ".md";
  fs.mkdirSync(path.join(directory, "deploy"));
  fs.writeFileSync(path.join(directory, "codex-bot"), "synthetic executable");
  fs.writeFileSync(path.join(directory, long), "说明");
  fs.writeFileSync(path.join(directory, ".env"), "private fixture data");
  const archive = path.join(output, "bot.tar.gz"), name = "codex-bot-v1.6.0-dev.1234567-linux-x64";
  await writeArchive(archive, directory, name, "codex-bot", ["codex-bot", long]);
  const content = require("node:zlib").gunzipSync(fs.readFileSync(archive));
  assert.equal(parseInt(content.toString("ascii", 100, 107), 8), 0o755);
  const list = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split(/\r?\n/);
  assert.deepEqual(list, [name + "/codex-bot", name + "/" + long]);
  assert.ok(!list.some(file => file.endsWith("/.env")));
  const extracted = path.join(output, "extracted"); fs.mkdirSync(extracted);
  execFileSync("tar", ["-xzf", archive, "-C", extracted]);
  assert.equal(fs.readFileSync(path.join(extracted, name, long), "utf8"), "说明");
  const before = fs.readFileSync(archive);
  await assert.rejects(() => writeArchive(archive, directory, name, "codex-bot", ["codex-bot"]), error => error.code === "EEXIST");
  assert.deepEqual(fs.readFileSync(archive), before);
});
