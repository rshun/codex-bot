const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const script = path.join(root, "deploy", "upgrade-v1.6.0.sh");
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
const forward = value => value.replaceAll("\\", "/");
const artifacts = path.join(root, ".test-artifacts");
fs.mkdirSync(artifacts, { recursive: true });
const suite = fs.mkdtempSync(path.join(artifacts, "debian-upgrade-"));
// This suite never invokes real sudo/systemctl/Codex/curl. Every privileged operation
// is handled by a fixture-only allowlist; no generic command execution fallback exists.
const handlerSource = String.raw`
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(process.env.MOCK_ROOT), bot=path.join(root,'bot');
const systemd=path.join(root,'systemd');
let [command,...args]=process.argv.slice(2);
function safe(file){
 if(file.startsWith('/etc/systemd/system/'))file=path.join(systemd,file.slice('/etc/systemd/system/'.length));
 const target=path.resolve(file);if(!target.startsWith(root+path.sep))throw Error('Outside fixture');return target;
}
function content(unit){
 let value=fs.readFileSync(path.join(root,'base-'+unit),'utf8');
 const dir=path.join(systemd,unit+'.d');
 if(fs.existsSync(dir))for(const name of fs.readdirSync(dir).filter(name=>name.endsWith('.conf')).sort())value+='\n# '+name+'\n'+fs.readFileSync(path.join(dir,name),'utf8');
 return value;
}
function start(unit){return content(unit).split('\n').filter(line=>line.startsWith('ExecStart=')&&line!=='ExecStart=').at(-1)?.slice(10)||'';}
function systemctl(args){
 const [action,unit]=args;
 if(action==='show'){
  const prop=args.find(arg=>arg.startsWith('--property='))?.slice(11);
  if(prop==='User')console.log(process.env.SERVICE_USER);
  else if(prop==='WorkingDirectory')console.log(forward(bot));
  else if(prop==='ExecStart')console.log(start(unit));
  else throw Error('Unexpected property');
 }else if(action==='cat')process.stdout.write(content(unit));
 else if(action==='is-active')process.exit(0);
 else if(action==='daemon-reload'){}
 else if(action==='restart'){
  fs.appendFileSync(path.join(root,'restarts.jsonl'),JSON.stringify({unit,start:start(unit)})+'\n');
  const marker=path.join(root,'restart-failed-once');
  if(process.env.MOCK_FAIL_RESTART===unit&&start(unit).includes('codex-bot-v1.6.0')&&!fs.existsSync(marker)){fs.writeFileSync(marker,'1');process.exit(1);}
 }else throw Error('Unexpected systemctl action');
}
function forward(value){return value.replaceAll('\\','/');}
try{
 if(command==='systemctl')systemctl(args);
 else if(command==='sudo'){
  if(args[0]==='-v')process.exit(0);
  if(args[0]==='--')args.shift();
  const sub=args.shift();
  if(sub==='systemctl')systemctl(args);
  else if(sub==='test'){
   const negate=args[0]==='!';if(negate)args.shift();const [flag,file]=args;const target=safe(file);
   let ok=false;
   if(flag==='-e')ok=fs.existsSync(target);
   else if(flag==='-L'){try{ok=fs.lstatSync(target).isSymbolicLink();}catch{}}
   else if(flag==='-f')ok=fs.existsSync(target)&&fs.statSync(target).isFile();
   else throw Error('Unexpected test');
   process.exit((negate?!ok:ok)?0:1);
  }else if(sub==='mkdir')for(const file of args.filter(arg=>arg!=='-p'&&arg!=='--'))fs.mkdirSync(safe(file),{recursive:args.includes('-p')});
  else if(sub==='cat')process.stdout.write(fs.readFileSync(safe(args.filter(arg=>arg!=='--')[0])));
  else if(sub==='tee'){const file=safe(args[0]);fs.writeFileSync(file,fs.readFileSync(0));}
  else if(sub==='cp'){
   const files=args.filter(arg=>!arg.startsWith('-'));const [from,to]=files.map(safe);
   if(!args.includes('-n')||!fs.existsSync(to))fs.copyFileSync(from,to);
  }else throw Error('Unexpected privileged operation');
 }else if(command==='tar'){
  if(args.length!==4||args[0]!=='-xzf'||args[2]!=='-C')throw Error('Unexpected tar');
  args[1]=safe(args[1]);args[3]=safe(args[3]);
  const result=spawnSync(process.env.MOCK_TAR,args,{encoding:'utf8'});
  if(result.stdout)process.stdout.write(result.stdout);if(result.stderr)process.stderr.write(result.stderr);
  process.exit(result.status??1);
 }else if(command==='flock')process.exit(process.env.MOCK_LOCK_BUSY==='1'?1:0);
 else if(command==='sleep'){}
 else if(command==='curl')throw Error('No network in tests');
 else throw Error('Unexpected mock command');
}catch{console.error('Fixture command rejected');process.exitCode=1;}
`;

function fixture(extra = {}) {
  const directory = fs.mkdtempSync(path.join(suite, "case-"));
  const bot = path.join(directory, "bot"), mockBin = path.join(directory, "bin");
  fs.mkdirSync(path.join(bot, ".bot-state"), { recursive: true });
  fs.mkdirSync(mockBin);
  fs.mkdirSync(path.join(directory, "home"));
  const workdir = path.join(directory, "workspace"); fs.mkdirSync(workdir);
  const handler = path.join(directory, "handler.cjs"); fs.writeFileSync(handler, handlerSource);
  for (const name of ["systemctl", "sudo", "flock", "sleep", "curl", "tar"]) {
    const filename = path.join(mockBin, name);
    fs.writeFileSync(filename, '#!/usr/bin/env bash\nexec "$MOCK_NODE" "$MOCK_HANDLER" "' + name + '" "$@"\n', { mode: 0o755 });
  }
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/token|password|secret|api[_-]?key|authorization|cookie|credential|private[_-]?key/i.test(key) ||
        /^(?:CODEX_.*|WORKDIR|SESSION_FILE|REMINDER_FILE|HOLIDAY_CALENDAR_FILE|ALLOWED_USER_ID|DISCORD_.*|PATH)$/i.test(key)) delete env[key];
  }
  const existingPath = process.env.PATH || process.env.Path || "";
  env.PATH = mockBin + path.delimiter + (process.platform === "win32" ? "C:/Program Files/Git/usr/bin;" : "") + existingPath;
  Object.assign(env, {
    MSYS_NO_PATHCONV: "1", MOCK_NODE: forward(process.execPath), MOCK_HANDLER: forward(handler), MOCK_ROOT: forward(directory),
    MOCK_BIN: forward(mockBin), MOCK_UPDATER: forward(script),
    MOCK_TAR: process.platform === "win32" ? "C:/Windows/System32/tar.exe" : "/usr/bin/tar",
    BOT_DIR: forward(bot), NODE_BIN: forward(process.execPath), SERVICE_USER: os.userInfo().username,
    TG_HOME: forward(path.join(directory, "home")), DC_HOME: forward(path.join(directory, "home")), ...extra,
  });
  for (const [platform, file, id] of [["telegram", ".env", "42"], ["discord", ".env.discord", "123456789012345678"]]) {
    const key = platform === "telegram" ? "TELEGRAM_BOT_TOKEN" : "DISCORD_BOT_TOKEN";
    const allowed = platform === "telegram" ? "ALLOWED_USER_ID" : "DISCORD_ALLOWED_USER_ID";
    fs.writeFileSync(path.join(bot, file), key + "=synthetic_bot_credential\n" + allowed + "=" + id +
      "\nCODEX_BIN=" + forward(process.execPath) + "\nWORKDIR=" + forward(workdir) + "\n");
    fs.writeFileSync(path.join(bot, ".bot-state", platform === "telegram" ? "sessions.json" : "discord-sessions.json"), JSON.stringify({
      version: 1, platform, workdir, codexHome: path.join(directory, "home"), sessions: {},
    }));
  }
  fs.writeFileSync(path.join(workdir, "exec"), String.raw`
let input='';process.stdin.on('data',data=>{input+=data;});process.stdin.on('end',()=>{
 const text=JSON.parse(input.slice(input.indexOf('{')));
 for(const event of [{type:'thread.started',thread_id:'00000000-0000-0000-0000-000000000001'},
  {type:'item.completed',item:{type:'agent_message',phase:'final_answer',text:process.env.MOCK_BAD_CODEX==='1'?'not-json':JSON.stringify(text)}},
  {type:'turn.completed'}])console.log(JSON.stringify(event));
});
`);
  for (const [unit, entry] of [["codex-tg-bot.service", "index.js"], ["codex-discord-bot.service", "discord.js"]]) {
    fs.writeFileSync(path.join(directory, "base-" + unit), "[Service]\nExecStart=" + forward(process.execPath) + " " + forward(path.join(bot, "old", entry)) + "\n");
  }
  function run(...args) {
    const launch = process.platform === "win32"
      ? 'export PATH="$(/usr/bin/cygpath -u "$MOCK_BIN"):$PATH"; source "$MOCK_UPDATER" "$@"'
      : 'export PATH="$MOCK_BIN:$PATH"; source "$MOCK_UPDATER" "$@"';
    return spawnSync(bash, ["--noprofile", "--norc", "-c", launch, "fixture", ...args.map(forward)], {
      env, encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024,
    });
  }
  const records = () => fs.existsSync(path.join(bot, ".local-backups")) ? fs.readdirSync(path.join(bot, ".local-backups"))
    .filter(name => name.startsWith("dual-v1.6.0-")).map(name => path.join(bot, ".local-backups", name)) : [];
  return { directory, bot, env, run, records };
}

function releaseArchive() {
  const details = path.join(artifacts, "v1.6.0-build.json");
  if (fs.existsSync(details)) {
    const filename = JSON.parse(fs.readFileSync(details)).archive;
    if (fs.existsSync(filename)) return filename;
  }
  return process.env.CODEX_BOT_V160_ARCHIVE || null;
}
const options = { skip: !fs.existsSync(bash) ? "Existing Bash is unavailable; no tools are installed" : false };
const packageOptions = { skip: options.skip || (!releaseArchive() ? "Set CODEX_BOT_V160_ARCHIVE to the official v1.6.0 archive for offline deployment tests" : false) };
const ok = result => assert.equal(result.status, 0, result.stdout + result.stderr + (result.error?.message || ""));

test("standalone updater help, syntax and read-only check do not create backups or restart services", options, () => {
  ok(spawnSync(bash, ["-n", script], { encoding: "utf8" }));
  const app = fixture(); ok(app.run("--help")); ok(app.run("check"));
  assert.deepEqual(app.records(), []);
  assert.ok(!fs.existsSync(path.join(app.directory, "restarts.jsonl")));
  assert.notEqual(app.run("rollback").status, 0);
});

test("invalid archive and a busy upgrade lock cannot change services", options, () => {
  const app = fixture(); const archive = path.join(app.directory, "invalid.tar.gz"); fs.writeFileSync(archive, "not a release");
  assert.notEqual(app.run("upgrade", "--archive", archive).status, 0);
  assert.ok(!fs.existsSync(path.join(app.directory, "restarts.jsonl")));
  assert.ok(!fs.existsSync(path.join(app.directory, "systemd")));
  const busy = fixture({ MOCK_LOCK_BUSY: "1" });
  assert.notEqual(busy.run("upgrade", "--archive", archive).status, 0); assert.deepEqual(busy.records(), []);
});

test("preflight can resume into a dual-service upgrade, and rollback preserves current state and all files", packageOptions, () => {
  const app = fixture(); ok(app.run("preflight", "--archive", path.relative(process.cwd(), releaseArchive())));
  assert.ok(!fs.existsSync(path.join(app.directory, "restarts.jsonl")));
  const [backup] = app.records(); assert.ok(backup);
  ok(app.run("rollback", "--backup-dir", backup));
  assert.ok(!fs.existsSync(path.join(app.directory, "restarts.jsonl")));
  ok(app.run("upgrade", "--backup-dir", backup));
  const beforeRepeat = fs.readFileSync(path.join(app.directory, "restarts.jsonl"));
  ok(app.run("upgrade", "--archive", releaseArchive()));
  assert.deepEqual(fs.readFileSync(path.join(app.directory, "restarts.jsonl")), beforeRepeat);
  const state = path.join(app.bot, ".bot-state", "sessions.json");
  const updated = JSON.parse(fs.readFileSync(state)); updated.sessions = { "42:0:42": { threadId: null, model: null } };
  fs.writeFileSync(state, JSON.stringify(updated)); const before = fs.readFileSync(state);
  ok(app.run("rollback", "--backup-dir", backup));
  assert.deepEqual(fs.readFileSync(state), before);
  const restarts = fs.readFileSync(path.join(app.directory, "restarts.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(restarts.length, 4);
  assert.ok(restarts.slice(0, 2).every(value => value.start.includes("codex-bot-v1.6.0")));
  assert.ok(restarts.slice(2).every(value => value.start.includes("/old/")));
  assert.ok(fs.existsSync(path.join(app.bot, "releases", "codex-bot-v1.6.0", "index.js")));
  const receipt = JSON.parse(fs.readFileSync(path.join(backup, "upgrade-receipt.json")));
  for (const unit of [receipt.settings.TG_UNIT, receipt.settings.DC_UNIT]) {
    const dir = path.join(app.directory, "systemd", unit + ".d");
    assert.equal(fs.readdirSync(dir).length, 1);
    assert.ok(!fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), "utf8").includes("ExecStart="));
  }
});

test("a coherently edited installed manifest cannot replace the trusted archive, and invalid model output leaves services untouched", packageOptions, () => {
  const crypto = require("node:crypto");
  const app = fixture(); ok(app.run("preflight", "--archive", releaseArchive()));
  const [backup] = app.records();
  const release = path.join(app.bot, "releases", "codex-bot-v1.6.0");
  const entry = path.join(release, "index.js"); fs.appendFileSync(entry, "\n// local modification\n");
  const manifestFile = path.join(release, "release-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  manifest.files["index.js"] = crypto.createHash("sha256").update(fs.readFileSync(entry)).digest("hex");
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  assert.notEqual(app.run("upgrade", "--backup-dir", backup).status, 0);
  assert.ok(!fs.existsSync(path.join(app.directory, "restarts.jsonl")));
  const invalid = fixture({ MOCK_BAD_CODEX: "1" });
  assert.notEqual(invalid.run("upgrade", "--archive", releaseArchive()).status, 0);
  assert.ok(!fs.existsSync(path.join(invalid.directory, "systemd")));
  assert.ok(!fs.existsSync(path.join(invalid.directory, "restarts.jsonl")));
});

test("changing original unit configuration after preflight prevents installation", packageOptions, () => {
  const app = fixture(); ok(app.run("preflight", "--archive", releaseArchive()));
  const [backup] = app.records();
  fs.appendFileSync(path.join(app.directory, "base-codex-tg-bot.service"), "# operator changed original unit\n");
  assert.notEqual(app.run("upgrade", "--backup-dir", backup).status, 0);
  assert.ok(!fs.existsSync(path.join(app.directory, "systemd")));
  assert.ok(!fs.existsSync(path.join(app.directory, "restarts.jsonl")));
});

test("a Discord restart failure automatically restores both original entries and returns failure", packageOptions, () => {
  const app = fixture({ MOCK_FAIL_RESTART: "codex-discord-bot.service" });
  const result = app.run("upgrade", "--archive", releaseArchive());
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /自动回滚完成/);
  const restarts = fs.readFileSync(path.join(app.directory, "restarts.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(restarts.slice(-2).every(value => value.start.includes("/old/")));
});

test("rollback refuses edited override files and invalid receipt paths without writing services", packageOptions, () => {
  const app = fixture(); ok(app.run("upgrade", "--archive", releaseArchive()));
  const [backup] = app.records(); const receiptPath = path.join(backup, "upgrade-receipt.json");
  const receipt = JSON.parse(fs.readFileSync(receiptPath));
  const target = path.join(app.directory, "systemd", receipt.settings.DC_UNIT + ".d", "zzzz-codex-bot-v1.6.0-" + receipt.settings.RUN_ID + ".conf");
  fs.appendFileSync(target, "# operator edit\n");
  const before = fs.readFileSync(target), restarts = fs.readFileSync(path.join(app.directory, "restarts.jsonl"));
  assert.notEqual(app.run("rollback", "--backup-dir", backup).status, 0);
  assert.deepEqual(fs.readFileSync(target), before); assert.deepEqual(fs.readFileSync(path.join(app.directory, "restarts.jsonl")), restarts);
  receipt.settings.DC_UNIT = "../../foreign.service"; fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  assert.notEqual(app.run("rollback", "--backup-dir", backup).status, 0);
  assert.deepEqual(fs.readFileSync(target), before);
});
