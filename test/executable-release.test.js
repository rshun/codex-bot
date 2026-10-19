const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { writeArchive } = require("../scripts/build-executable");
const { verifyArchive, prepareRelease } = require("../scripts/prepare-executable-release");
const base = path.resolve(__dirname, "..", ".test-artifacts");
fs.mkdirSync(base, { recursive: true });
const suite = fs.mkdtempSync(path.join(base, "release-verifier-"));
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const identity = { version: "1.9.0", commit: "a".repeat(40), target: "linux-x64" };

async function archive(changes = {}, options = {}) {
  const directory = fs.mkdtempSync(path.join(suite, "case-"));
  const files = ["codex-bot", ".env.example", ".env.discord.example", "deploy/EXECUTABLE.md", "UPGRADE-v1.9.0.md",
    "MODEL-REMINDERS.md", "SEMANTIC-REMINDERS.md", "deploy/upgrade-v1.9.0.sh",
    "deploy/codex-tg-bot.service.example", "deploy/codex-discord-bot.service.example", "licenses/Node-LICENSE",
    "licenses/dotenv-LICENSE", "licenses/node-telegram-bot-api-LICENSE"];
  const binary = Buffer.alloc(64); binary.write("\x7fELF", 0, "ascii"); binary[4] = 2; binary[5] = 1; binary.writeUInt16LE(62, 18);
  const manifest = { ...identity, developmentBuild: false, dirtyWorktree: false, nativeSmokeTested: true, files: {}, ...changes };
  for (const file of files) {
    const filename = path.join(directory, file), data = file === "codex-bot" ? binary : Buffer.from("public fixture\n");
    fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, data);
    manifest.files[file] = hash(data);
  }
  if (options.badHash) manifest.files["codex-bot"] = "0".repeat(64);
  fs.writeFileSync(path.join(directory, "release-manifest.json"), JSON.stringify(manifest));
  const output = path.join(directory, "package.tar.gz");
  await writeArchive(output, directory, "codex-bot-v1.9.0-linux-x64", "codex-bot", [...files, "release-manifest.json"]);
  return fs.readFileSync(output);
}

test("release verifier accepts only an exact tagged source identity and complete native executable package", async () => {
  const content = await archive();
  assert.equal(verifyArchive(content, identity).version, "1.9.0");
  assert.throws(() => verifyArchive(content, { ...identity, commit: "b".repeat(40) }), /manifest_identity/);
  assert.throws(() => verifyArchive(content, { ...identity, target: "linux-arm64" }), /archive_path/);
});

test("release verifier refuses preview packages, altered hashes and malformed archive headers", async () => {
  for (const changes of [{ developmentBuild: true }, { dirtyWorktree: true }, { nativeSmokeTested: false }]) {
    const content = await archive(changes);
    assert.throws(() => verifyArchive(content, identity), /manifest_identity/);
  }
  const badHash = await archive({}, { badHash: true });
  assert.throws(() => verifyArchive(badHash, identity), /manifest_hash/);
  const raw = zlib.gunzipSync(await archive()); raw[0] ^= 1;
  assert.throws(() => verifyArchive(zlib.gzipSync(raw), identity), /archive_header/);
});

test("release preparation rejects a non-version tag without creating any output", () => {
  const directory = fs.mkdtempSync(path.join(suite, "invalid-"));
  fs.writeFileSync(path.join(directory, "package.json"), '{"version":"1.9.0"}');
  const output = path.join(directory, "output");
  assert.throws(() => prepareRelease({ root: directory, tag: "master", output }), /release_tag/);
  assert.equal(fs.existsSync(output), false);
});
