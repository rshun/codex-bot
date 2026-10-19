const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { gunzipSync } = require("node:zlib");
const { execFileSync } = require("node:child_process");
const { validateBinary } = require("./build-executable");

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
function verifyArchive(compressed, { target, version, commit }) {
  if (compressed.length > 200 * 1024 * 1024) throw new Error("archive_size");
  const content = gunzipSync(compressed, { maxOutputLength: 400 * 1024 * 1024 });
  const top = `codex-bot-v${version}-${target}`, files = new Map();
  const text = (header, start, size) => header.toString("ascii", start, start + size).split("\0")[0];
  let executableMode;
  for (let position = 0; position + 512 <= content.length;) {
    const header = content.subarray(position, position + 512);
    if (header.every(value => value === 0)) break;
    const expected = parseInt(text(header, 148, 8), 8);
    const actual = header.reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0);
    if (expected !== actual || text(header, 257, 6) !== "ustar" || ![0, 48].includes(header[156])) throw new Error("archive_header");
    const prefix = text(header, 345, 155), fullName = (prefix ? prefix + "/" : "") + text(header, 0, 100);
    const size = parseInt(text(header, 124, 12), 8);
    if (!fullName.startsWith(top + "/") || !Number.isSafeInteger(size) || size < 0 || position + 512 + size > content.length) throw new Error("archive_path");
    const name = fullName.slice(top.length + 1);
    if (!/^[A-Za-z0-9._/-]+$/.test(name) || files.has(name) || name.split("/").some(part =>
      !part || [".", "..", ".git", ".bot-state", "node_modules"].includes(part)) ||
      [".env", ".env.discord"].includes(name) || /\.(?:js|cjs|mjs|map)$/.test(name)) throw new Error("archive_content");
    files.set(name, content.subarray(position + 512, position + 512 + size));
    if (name === "codex-bot") executableMode = parseInt(text(header, 100, 8), 8);
    position += 512 + Math.ceil(size / 512) * 512;
  }
  const manifest = JSON.parse(files.get("release-manifest.json"));
  if (manifest.version !== version || manifest.commit !== commit || manifest.target !== target ||
      manifest.developmentBuild !== false || manifest.dirtyWorktree !== false || manifest.nativeSmokeTested !== true ||
      executableMode !== 0o755 || files.size !== Object.keys(manifest.files).length + 1) throw new Error("manifest_identity");
  for (const [name, digest] of Object.entries(manifest.files)) {
    if (!files.has(name) || hash(files.get(name)) !== digest) throw new Error("manifest_hash");
  }
  for (const required of ["codex-bot", ".env.example", ".env.discord.example", "deploy/EXECUTABLE.md", `UPGRADE-v${version}.md`,
    "MODEL-REMINDERS.md", "deploy/upgrade-v1.8.0.sh",
    "deploy/codex-tg-bot.service.example", "deploy/codex-discord-bot.service.example",
    "licenses/Node-LICENSE", "licenses/dotenv-LICENSE", "licenses/node-telegram-bot-api-LICENSE"]) {
    if (!files.has(required)) throw new Error("required_file");
  }
  validateBinary(files.get("codex-bot"), target);
  return manifest;
}

function prepareRelease({ root = path.resolve(__dirname, ".."), tag = process.env.RELEASE_TAG,
    artifacts = path.join(root, ".test-artifacts", "release-artifacts"), output = path.join(root, ".test-artifacts", "release-assets") } = {}) {
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"))).version;
  if (!/^v\d+\.\d+\.\d+$/.test(tag || "") || tag !== `v${version}`) throw new Error("release_tag");
  const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = git(["rev-parse", "HEAD"]);
  if (git(["rev-parse", `${tag}^{commit}`]) !== commit || git(["status", "--porcelain", "--untracked-files=normal"])) throw new Error("release_checkout");
  const packages = [];
  for (const target of ["linux-x64", "linux-arm64"]) {
    const folder = path.join(artifacts, `codex-bot-${target}`), filename = `codex-bot-v${version}-${target}.tar.gz`;
    const checksum = fs.readFileSync(path.join(folder, "SHA256SUMS"), "utf8").trim();
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+\.tar\.gz)$/.exec(checksum);
    if (!match || match[2] !== filename) throw new Error("checksum_name");
    const source = path.join(folder, filename), compressed = fs.readFileSync(source);
    if (hash(compressed) !== match[1]) throw new Error("checksum_hash");
    verifyArchive(compressed, { target, version, commit });
    packages.push({ source, filename, checksum });
  }
  fs.mkdirSync(output, { mode: 0o700 });
  for (const item of packages) fs.copyFileSync(item.source, path.join(output, item.filename), fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(path.join(output, "SHA256SUMS"), packages.map(item => item.checksum).join("\n") + "\n", { flag: "wx" });
  const guide = `UPGRADE-v${version}.md`;
  fs.copyFileSync(path.join(root, guide), path.join(output, guide), fs.constants.COPYFILE_EXCL);
  const upgrader = "upgrade-v1.8.0.sh";
  const upgradeContent = fs.readFileSync(path.join(root, "deploy", upgrader));
  fs.writeFileSync(path.join(output, upgrader), upgradeContent, { flag: "wx" });
  fs.appendFileSync(path.join(output, "SHA256SUMS"), `${hash(upgradeContent)}  ${upgrader}\n`);
  fs.appendFileSync(path.join(output, "SHA256SUMS"), `${hash(fs.readFileSync(path.join(output, guide)))}  ${guide}\n`);
  console.log(`Verified ${tag} at ${commit}: both native executable archives and upgrade guide prepared.`);
  return { output, version, commit };
}

if (require.main === module) {
  try { prepareRelease(); }
  catch { console.error("Release asset verification failed; no release was published."); process.exitCode = 1; }
}
module.exports = { verifyArchive, prepareRelease };
