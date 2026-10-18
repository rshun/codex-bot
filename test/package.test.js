const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { buildRelease, collectInputs, assertSafeContent } = require("../scripts/build-release");
const root = path.resolve(__dirname, "..");
const artifacts = path.join(root, ".test-artifacts");
fs.mkdirSync(artifacts, { recursive: true });
const fixture = () => fs.mkdtempSync(path.join(artifacts, "release-"));
const hash = (content) => crypto.createHash("sha256").update(content).digest("hex");

test("release archive is complete, portable and excludes private files and source checkout metadata", () => {
  const output = fixture();
  const result = buildRelease({ output, allowDirty: true });
  const checksum = fs.readFileSync(result.checksumFile, "utf8");
  assert.equal(checksum, `${hash(fs.readFileSync(result.archive))}  ${path.basename(result.archive)}\n`);
  const extracted = path.join(output, "extracted");
  fs.mkdirSync(extracted);
  execFileSync("tar", ["-xzf", result.archive, "-C", extracted]);
  const directory = path.join(extracted, path.basename(result.directory));
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "release-manifest.json")));
  for (const [relative, digest] of Object.entries(manifest.files)) {
    assert.equal(hash(fs.readFileSync(path.join(directory, relative))), digest, relative);
    assert.ok(!/(^|\/)(?:\.git|\.bot-state|\.local-backups|\.test-artifacts|test|scripts)(?:\/|$)/.test(relative));
    assert.ok(!relative.endsWith(".map"));
    assert.notEqual(relative, ".env");
    assert.notEqual(relative, ".env.discord");
  }
  assert.deepEqual(manifest.dependencies, { dotenv: "17.4.2", "node-telegram-bot-api": "1.1.2" });
  const smoke = `
    const fs=require('node:fs'),path=require('node:path');
    const base=process.cwd();
    for(const name of ['dotenv','node-telegram-bot-api']){
      const resolved=require.resolve(path.join(base,'node_modules',name));
      if(!resolved.startsWith(base+path.sep))throw new Error('Dependency outside package');
      require(resolved);
    }
    for(const name of ['index','discord','discord-client','session-store','usage','quota','codex-runner','semantic-reminders'])require('./'+name);
    const schema=require('./reminder-response.schema.json');
    if(!schema.properties.action.enum.includes('update')||!fs.existsSync('SEMANTIC-REMINDERS.md')||!fs.existsSync('UPGRADE-v1.6.0.md'))throw new Error('Semantic reminder runtime missing');
    const {parseNaturalReminder}=require('./reminders');
    if(parseNaturalReminder('每天晚上9点提醒我喝水').argument!=='daily 21:00 喝水')throw new Error('Natural reminder missing');
    if(parseNaturalReminder('查看我的提醒').command!=='reminders')throw new Error('Natural list missing');
    if(parseNaturalReminder('取消喝水提醒').command!=='cancelmatching')throw new Error('Natural cancellation missing');
    if(parseNaturalReminder('非工作日早上6点1分、11点2分提醒我测试消息').argument.times.join(',')!=='06:01,11:02')throw new Error('Multiple nonworking times missing');
    if(require('./china-calendar').ChinaCalendar===undefined||new (require('./china-calendar').ChinaCalendar)().isNonworking(Date.parse('2026-10-10T08:00:00+08:00')))throw new Error('Makeup workday calendar missing');
    const edit=parseNaturalReminder('把喝水提醒改成每天晚上10点');
    if(edit.command!=='reschedule'||edit.argument.schedule!=='daily 22:00')throw new Error('Natural time edit missing');
    if(!fs.existsSync('UPGRADE-v1.5.0.md')||!fs.existsSync('HOLIDAY-CALENDAR.md'))throw new Error('Upgrade/calendar guide missing');
    if(require('./discord-client').gatewayUrl('wss://gateway-us-east1-b.discord.gg')!=='wss://gateway-us-east1-b.discord.gg/?v=10&encoding=json')throw new Error('READY fix missing');
  `;
  execFileSync(process.execPath, ["-e", smoke], { cwd: directory });
  const commands = JSON.parse(execFileSync(process.execPath, ["discord.js", "--register-commands"], { cwd: directory, encoding: "utf8" }));
  assert.equal(commands.length, 12);
  for (const platform of ["tg", "discord"]) {
    const unit = fs.readFileSync(path.join(directory, `deploy/codex-${platform}-bot.service.example`), "utf8");
    assert.ok(unit.includes(`/releases/${path.basename(directory)}/`));
    assert.ok(!unit.includes("@RELEASE_NAME@"));
    assert.ok(unit.includes("Environment=SESSION_FILE=/home/codex/codex-tg-bot/.bot-state/"));
  }
  const previousHash = hash(fs.readFileSync(result.archive));
  assert.throws(() => buildRelease({ output, allowDirty: true }), (error) => error.kind === "output_exists");
  assert.equal(hash(fs.readFileSync(result.archive)), previousHash);
});

test("packaging rejects credential-shaped content without logging credential values", () => {
  const synthetic = "ghp_" + "SYNTHETIC".repeat(5);
  assert.throws(() => assertSafeContent(Buffer.from(synthetic)), (error) =>
    error.kind === "possible_credential" && !error.message.includes(synthetic));
  assertSafeContent(Buffer.from("DISCORD_BOT_TOKEN=your_discord_bot_token_here\n"));
});

test("packaging refuses dependencies that differ from the lockfile", () => {
  const directory = fixture();
  fs.copyFileSync(path.join(root, "package.json"), path.join(directory, "package.json"));
  fs.copyFileSync(path.join(root, "package-lock.json"), path.join(directory, "package-lock.json"));
  const dependency = path.join(directory, "node_modules", "dotenv");
  fs.mkdirSync(dependency, { recursive: true });
  fs.writeFileSync(path.join(dependency, "package.json"), JSON.stringify({ name: "dotenv", version: "0.0.0" }));
  assert.throws(() => collectInputs(directory), (error) => error.kind === "dependency_mismatch");
});

test("packaging rejects unknown CLI arguments before creating artifacts", () => {
  const directory = fixture();
  const run = require("node:child_process").spawnSync(process.execPath,
    [path.join(root, "scripts/build-release.js"), "--output", directory, "--unknown"], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /arguments/);
  assert.deepEqual(fs.readdirSync(directory), []);
});
