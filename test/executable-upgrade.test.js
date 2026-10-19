const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
const releases = [{ version: "1.8.0", previous: "1.7.0" }, { version: "1.9.0", previous: "1.8.0" }];
const artifacts = path.join(root, ".test-artifacts");
fs.mkdirSync(artifacts, { recursive: true });
const suite = fs.mkdtempSync(path.join(artifacts, "executable-upgrade-"));
const options = { skip: !fs.existsSync(bash) ? "Existing Bash unavailable; no dependency installation" : false };
const harness = String.raw`
if [ -n "${'${'}WINDIR:-}" ]; then
  MOCK_ROOT=$(/usr/bin/cygpath -u "$MOCK_ROOT")
  MOCK_SCRIPT=$(/usr/bin/cygpath -u "$MOCK_SCRIPT")
fi
export MOCK_ROOT
export BOT_DIR=$MOCK_ROOT/bot TG_HOME=$MOCK_ROOT/home DC_HOME=$MOCK_ROOT/home
export ROLLBACK_BIN=$MOCK_ROOT/old/codex-bot
export TG_SESSION=$BOT_DIR/.bot-state/sessions.json DC_SESSION=$BOT_DIR/.bot-state/discord-sessions.json
export TG_REMINDER=$BOT_DIR/.bot-state/telegram-reminders.json DC_REMINDER=$BOT_DIR/.bot-state/discord-reminders.json
id() { [ "$*" = '-un' ] || return 1; echo codex; }
uname() { [ "$*" = '-m' ] || return 1; echo x86_64; }
systemctl() {
  case "$1" in
    show)
      case "$*" in
        *'-p User'*) echo codex ;;
        *'-p ExecStart'*|*'-p MainPID'*)
          local conf=$MOCK_ROOT/systemd/$2.d/zzzzzz-codex-bot-v@VERSION@.conf value=
          if [ -f "$conf" ]; then value=$(command sed -n 's/^ExecStart=\(.\+\)$/\1/p' "$conf"); fi
          printf '%s\n' "${'${'}value:-$ROLLBACK_BIN original-start}" ;;
        *) return 1 ;;
      esac ;;
    cat) printf '[Service]\nExecStart=%s original-start\n' "$ROLLBACK_BIN" ;;
    is-active) return 0 ;;
    daemon-reload|restart) printf '%s\n' "$*" >> "$MOCK_ROOT/service-actions" ;;
    *) return 1 ;;
  esac
}
sudo() {
  local action=$1 arg
  shift
  if [ "$action" = systemctl ]; then systemctl "$@"; return; fi
  local mapped=()
  for arg in "$@"; do
    case "$arg" in /etc/systemd/system/*) arg=$MOCK_ROOT/systemd/${'${'}arg#/etc/systemd/system/} ;; esac
    case "$arg" in -*|'!'|--|"$MOCK_ROOT"/*) ;; *) echo 'Fixture privilege rejected' >&2; return 1 ;; esac
    mapped+=("$arg")
  done
  case "$action" in
    test) builtin test "${'${'}mapped[@]}" ;;
    mkdir|cp|cmp) command "$action" "${'${'}mapped[@]}" ;;
    *) echo 'Fixture privilege rejected' >&2; return 1 ;;
  esac
}
curl() {
  [ "${'${'}MOCK_BAD_DOWNLOAD:-0}" != 1 ] || return 1
  local out= arg
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --output ]; then out=$2; shift; fi
    arg=$1; shift
  done
  case "$out" in "$MOCK_ROOT"/*) ;; *) return 1 ;; esac
  case "$arg" in
    */codex-bot-v@VERSION@-linux-x64.tar.gz) command cp "$MOCK_ROOT/package.tar.gz" "$out" ;;
    */SHA256SUMS) command cp "$MOCK_ROOT/checksums" "$out" ;;
    *) return 1 ;;
  esac
}
if [ "$1" = prepare ]; then
  command tar -czf "$MOCK_ROOT/package.tar.gz" -C "$MOCK_ROOT/payload" codex-bot-v@VERSION@-linux-x64
else
  mode=$1; shift
  if [ "$mode" = rollback ]; then set -- "$mode" "$MOCK_ROOT/bot/.local-backups/$1"; else set -- "$mode"; fi
  source "$MOCK_SCRIPT" "$@"
fi
`;

function fixture(release) {
  const script = path.join(root, "deploy", `upgrade-v${release.version}.sh`);
  const packageName = `codex-bot-v${release.version}-linux-x64`;
  const directory = fs.mkdtempSync(path.join(suite, "case-"));
  for (const name of ["bot/.bot-state", "home", "old", `payload/${packageName}`]) fs.mkdirSync(path.join(directory, name), { recursive: true });
  const states = ["sessions.json", "discord-sessions.json", "telegram-reminders.json", "discord-reminders.json"];
  for (const name of states) fs.writeFileSync(path.join(directory, "bot/.bot-state", name), '{"version":1,"synthetic":"retained"}\n');
  fs.writeFileSync(path.join(directory, "bot/.env"), "synthetic private config\n");
  fs.writeFileSync(path.join(directory, "bot/.env.discord"), "synthetic private config\n");
  const binary = version => `#!/usr/bin/env bash\nif [ "$1" = --version ]; then echo ${version}; exit; fi\nprintf '%s\\n' "$*" >> "$MOCK_ROOT/checks"\nif [ "${version}" = ${release.previous} ] && [ "$1" = telegram ] && [ -f "$MOCK_ROOT/reject-old-state" ]; then exit 1; fi\nexit 0\n`;
  fs.writeFileSync(path.join(directory, "old/codex-bot"), binary(release.previous), { mode: 0o755 });
  fs.writeFileSync(path.join(directory, `payload/${packageName}/codex-bot`), binary(release.version), { mode: 0o755 });
  const env = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE"]) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { MOCK_ROOT: directory.replaceAll("\\", "/"), MOCK_SCRIPT: script.replaceAll("\\", "/") });
  const run = (...args) => spawnSync(bash, ["--noprofile", "--norc", "-c", harness.replaceAll("@VERSION@", release.version), "fixture", ...args], { env, encoding: "utf8", timeout: 30000 });
  const prepared = run("prepare"); assert.equal(prepared.status, 0, prepared.stderr);
  const digest = crypto.createHash("sha256").update(fs.readFileSync(path.join(directory, "package.tar.gz"))).digest("hex");
  fs.writeFileSync(path.join(directory, "checksums"), digest + `  ${packageName}.tar.gz\n`);
  return { directory, env, run, states: () => states.map(name => fs.readFileSync(path.join(directory, "bot/.bot-state", name), "utf8")),
    backups: () => fs.readdirSync(path.join(directory, "bot/.local-backups")),
    actions: () => fs.existsSync(path.join(directory, "service-actions")) ? fs.readFileSync(path.join(directory, "service-actions"), "utf8") : "" };
}
const ok = result => assert.equal(result.status, 0, result.stdout + result.stderr);

for (const release of releases) {

test(`${release.version}: executable upgrader syntax and simulated dual-service upgrade/rollback preserve all current data`, options, () => {
  ok(spawnSync(bash, ["-n", path.join(root, "deploy", `upgrade-v${release.version}.sh`)], { encoding: "utf8" }));
  const app = fixture(release), before = app.states();
  ok(app.run("upgrade")); const [backup] = app.backups();
  assert.equal((app.actions().match(/restart /g) || []).length, 2);
  assert.deepEqual(app.states(), before);
  assert.ok(fs.readFileSync(path.join(app.directory, "checks"), "utf8").includes("discord --config-dir"));
  const latest = '{"version":1,"synthetic":"newer-current-state"}\n';
  fs.writeFileSync(path.join(app.directory, "bot/.bot-state/sessions.json"), latest);
  ok(app.run("rollback", backup));
  assert.equal((app.actions().match(/restart /g) || []).length, 4);
  assert.equal(app.states()[0], latest);
  for (const unit of ["codex-tg-bot.service", "codex-discord-bot.service"]) {
    assert.equal(fs.readFileSync(path.join(app.directory, "systemd", unit + `.d/zzzzzz-codex-bot-v${release.version}.conf`), "utf8"), "[Service]\n");
  }
});

test(`${release.version}: old-code rejection of current incompatible state prevents rollback writes and service restarts`, options, () => {
  const app = fixture(release); ok(app.run("upgrade")); const [backup] = app.backups(), before = app.actions();
  fs.writeFileSync(path.join(app.directory, "reject-old-state"), "1");
  const result = app.run("rollback", backup);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /旧程序不能读取当前状态/);
  assert.equal(app.actions(), before);
  assert.match(fs.readFileSync(path.join(app.directory, `systemd/codex-tg-bot.service.d/zzzzzz-codex-bot-v${release.version}.conf`), "utf8"), /ExecStart=/);
});

test(`${release.version}: download failure and an existing release cannot overwrite startup settings or restart services`, options, () => {
  const app = fixture(release), before = app.states(); app.env.MOCK_BAD_DOWNLOAD = "1";
  assert.notEqual(app.run("upgrade").status, 0);
  assert.equal(app.actions(), ""); assert.deepEqual(app.states(), before);
  app.env.MOCK_BAD_DOWNLOAD = "0";
  fs.mkdirSync(path.join(app.directory, `bot/releases/codex-bot-v${release.version}-linux-x64`), { recursive: true });
  const result = app.run("upgrade"); assert.notEqual(result.status, 0);
  assert.match(result.stderr, /目标版本目录已存在/); assert.equal(app.actions(), "");
});

if (release.version === "1.9.0") test("1.9.0: rollback refuses a check binary that differs from the recorded original startup program", options, () => {
  const app = fixture(release); ok(app.run("upgrade")); const [backup] = app.backups(), before = app.actions();
  fs.writeFileSync(path.join(app.directory, "bot/.local-backups", backup, "tg-exec-start.txt"), "/synthetic/different-program telegram\n");
  const result = app.run("rollback", backup);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /与升级前实际入口不匹配/);
  assert.equal(app.actions(), before);
});

}
