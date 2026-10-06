const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const APP_FILES = ["index.js", "discord.js", "discord-client.js", "codex-runner.js",
  "session-store.js", "usage.js", "quota.js", "package.json", "package-lock.json",
  ".env.example", ".env.discord.example", "README.md"];
const DEPENDENCIES = ["dotenv", "node-telegram-bot-api"];
const hash = (content) => crypto.createHash("sha256").update(content).digest("hex");

class PackageError extends Error {
  constructor(kind) { super(`Release packaging failed: ${kind}.`); this.kind = kind; }
}

function readInput(root, relative) {
  const parts = relative.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[\\\x00-\x1f]/.test(part))) {
    throw new PackageError("input_path");
  }
  let filename = root;
  for (const part of parts) {
    filename = path.join(filename, part);
    if (fs.lstatSync(filename).isSymbolicLink()) throw new PackageError("input_symlink");
  }
  if (!fs.lstatSync(filename).isFile()) throw new PackageError("input_file");
  return fs.readFileSync(filename);
}

function assertSafeContent(content) {
  const value = content.toString("utf8");
  const patterns = [
    /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-)?[A-Za-z0-9_-]{24,}|AKIA[0-9A-Z]{16})\b/,
    /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/,
    /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{25,}\b/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /^\s*(?:DISCORD_BOT_TOKEN|TELEGRAM_BOT_TOKEN|API_KEY|PASSWORD|SECRET)\s*=\s*(?!your_|$).+/m,
  ];
  if (patterns.some((pattern) => pattern.test(value))) throw new PackageError("possible_credential");
}

function collectInputs(root) {
  const pkg = JSON.parse(readInput(root, "package.json"));
  const lock = JSON.parse(readInput(root, "package-lock.json"));
  const folders = Object.keys(lock.packages || {}).filter(Boolean).sort();
  const expected = DEPENDENCIES.map((name) => `node_modules/${name}`).sort();
  if (lock.lockfileVersion !== 3 || JSON.stringify(folders) !== JSON.stringify(expected) ||
      JSON.stringify(pkg.dependencies) !== JSON.stringify(lock.packages[""].dependencies)) {
    throw new PackageError("unsupported_lockfile");
  }
  const versions = {};
  for (const name of DEPENDENCIES) {
    const folder = `node_modules/${name}`;
    const installed = JSON.parse(readInput(root, `${folder}/package.json`));
    if (installed.name !== name || installed.version !== lock.packages[folder].version ||
        installed.os || installed.cpu || installed.gypfile || installed.scripts?.install) {
      throw new PackageError("dependency_mismatch");
    }
    versions[name] = installed.version;
  }
  const files = [...APP_FILES];
  for (const name of DEPENDENCIES) {
    const folder = `node_modules/${name}`;
    files.push(`${folder}/package.json`, `${folder}/${name === "dotenv" ? "LICENSE" : "LICENSE.md"}`);
    const directory = `${folder}/${name === "dotenv" ? "lib" : "dist"}`;
    const extension = name === "dotenv" ? ".js" : ".cjs";
    const walk = (relative) => {
      if (fs.lstatSync(path.join(root, relative)).isSymbolicLink()) throw new PackageError("input_symlink");
      for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new PackageError("input_symlink");
        const filename = `${relative}/${entry.name}`;
        if (entry.isDirectory()) walk(filename);
        else if (entry.name.endsWith(extension) || entry.name.endsWith(".json")) files.push(filename);
      }
    };
    walk(directory);
  }
  return { pkg, versions, files: files.sort() };
}

function buildRelease({ root = ROOT, output = path.join(ROOT, "dist"), allowDirty = false } = {}) {
  root = path.resolve(root);
  output = path.resolve(output);
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = git(["rev-parse", "HEAD"]);
  const dirty = !!git(["status", "--porcelain", "--untracked-files=normal"]);
  if (dirty && !allowDirty) throw new PackageError("dirty_worktree");
  const { pkg, versions, files } = collectInputs(root);
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new PackageError("version");
  if (output !== root && !output.startsWith(root + path.sep)) throw new PackageError("output_outside_workspace");
  let parent = root;
  for (const part of path.relative(root, output).split(path.sep).filter(Boolean)) {
    parent = path.join(parent, part);
    if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink()) throw new PackageError("output_symlink");
  }
  const releaseName = `codex-bot-v${pkg.version}${dirty ? "-dev" : ""}`;
  const archiveName = `${releaseName}-node.tar.gz`;
  const archive = path.join(output, archiveName);
  const checksumFile = path.join(output, "SHA256SUMS");
  if (fs.existsSync(archive) || fs.existsSync(checksumFile)) throw new PackageError("output_exists");
  fs.mkdirSync(output, { recursive: true });
  const staging = fs.mkdtempSync(path.join(output, ".staging-"));
  const directory = path.join(staging, releaseName);
  fs.mkdirSync(directory, { mode: 0o755 });
  const manifest = { name: "codex-bot", version: pkg.version, commit, developmentBuild: dirty,
    builtAt: new Date().toISOString(), nodeMinimum: "22.4.0", platform: "node-portable",
    dependencies: versions, files: {} };
  const write = (relative, content) => {
    new TextDecoder("utf8", { fatal: true }).decode(content);
    assertSafeContent(content);
    const filename = path.join(directory, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o755 });
    fs.writeFileSync(filename, content, { flag: "wx", mode: 0o644 });
    manifest.files[relative] = hash(content);
  };
  for (const relative of files) write(relative, readInput(root, relative));
  for (const platform of ["tg", "discord"]) {
    const relative = `deploy/package/codex-${platform}-bot.service.example`;
    const content = readInput(root, relative).toString("utf8").replaceAll("@RELEASE_NAME@", releaseName);
    write(`deploy/codex-${platform}-bot.service.example`, Buffer.from(content));
  }
  fs.writeFileSync(path.join(directory, "release-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o644 });
  // Existing system tar is used without installing tools. Staging is retained, never deleted.
  let checksumDescriptor;
  try {
    // Reserve both output names exclusively, including when two builds start together.
    const archiveDescriptor = fs.openSync(archive, "wx", 0o644);
    fs.closeSync(archiveDescriptor);
    checksumDescriptor = fs.openSync(checksumFile, "wx", 0o644);
    execFileSync("tar", ["-czf", archive, "--format=ustar", "-C", staging, releaseName], {
      cwd: root, stdio: ["ignore", "pipe", "pipe"], timeout: 60000,
    });
    fs.writeFileSync(checksumDescriptor, `${hash(fs.readFileSync(archive))}  ${archiveName}\n`);
  } catch (error) { throw new PackageError(error.code === "EEXIST" ? "output_exists" : "archive_failed"); }
  finally { if (checksumDescriptor !== undefined) fs.closeSync(checksumDescriptor); }
  return { archive, checksumFile, directory, manifest };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    let output;
    let allowDirty = false;
    for (let index = 0; index < args.length; index++) {
      if (args[index] === "--allow-dirty" && !allowDirty) allowDirty = true;
      else if (args[index] === "--output" && !output && args[index + 1] && !args[index + 1].startsWith("--")) output = args[++index];
      else throw new PackageError("arguments");
    }
    const result = buildRelease({ ...(output ? { output } : {}), allowDirty });
    console.log(`Archive: ${result.archive}\nChecksums: ${result.checksumFile}\nSource commit: ${result.manifest.commit}`);
    if (result.manifest.developmentBuild) console.log("Development build only; do not publish as a production release.");
  } catch (error) {
    console.error(error instanceof PackageError ? error.message : "Release packaging failed; check Git, locked dependencies, files and system tar.");
    process.exitCode = 1;
  }
}

module.exports = { buildRelease, collectInputs, assertSafeContent, PackageError };
