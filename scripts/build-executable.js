const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { createGzip } = require("node:zlib");
const { execFileSync } = require("node:child_process");
const { collectInputs, assertSafeContent, PackageError } = require("./build-release");

const ROOT = path.resolve(__dirname, "..");
const NODE_VERSION = "24.19.0";
const TOOLS = { esbuild: "0.28.2", postject: "1.0.0-alpha.6" };
const RUNTIME = ["bot.js", "runtime-paths.js", "index.js", "discord.js", "discord-client.js", "codex-runner.js",
  "session-store.js", "usage.js", "quota.js", "reminders.js", "semantic-reminders.js", "china-calendar.js", "reminder-generation.js", "package.json"];
const ASSETS = ["china-calendar.json", "reminder-response.schema.json", "reminder-generation.schema.json"];
const hash = value => crypto.createHash("sha256").update(value).digest("hex");

function safeOutput(output, root) {
  output = path.resolve(output);
  const relative = path.relative(root, output);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new PackageError("output_outside_workspace");
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new PackageError("output_symlink");
  }
  if (fs.existsSync(output)) throw new PackageError("output_exists");
  return output;
}

function validateBinary(content, target) {
  if (target === "win32-x64") {
    if (content.length < 64 || content.toString("ascii", 0, 2) !== "MZ") throw new PackageError("node_target");
    const offset = content.readUInt32LE(0x3c);
    if (offset + 6 > content.length || content.readUInt32LE(offset) !== 0x4550 || content.readUInt16LE(offset + 4) !== 0x8664) {
      throw new PackageError("node_target");
    }
  } else if (content.length < 64 || content.toString("hex", 0, 4) !== "7f454c46" || content[4] !== 2 || content[5] !== 1 ||
      content.readUInt16LE(18) !== (target === "linux-x64" ? 62 : 183)) throw new PackageError("node_target");
}

// Use a small standard-library USTAR writer so Linux execute permissions survive
// cross-building on Windows, whose filesystem cannot represent POSIX mode bits.
async function writeArchive(archive, directory, releaseName, binaryName, files) {
  async function* entries() {
    for (const relative of [...files].sort()) {
      const filename = path.join(directory, relative);
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || !/^[A-Za-z0-9._/-]+$/.test(relative) ||
          relative.split("/").some(part => !part || part === "." || part === "..")) throw new PackageError("archive_path");
      let name = `${releaseName}/${relative}`, prefix = "";
      if (Buffer.byteLength(name) > 100) {
        const split = name.lastIndexOf("/"); prefix = name.slice(0, split); name = name.slice(split + 1);
      }
      if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new PackageError("archive_path");
      const header = Buffer.alloc(512);
      const octal = (value, offset, length) => {
        const digits = value.toString(8);
        if (digits.length >= length) throw new PackageError("archive_size");
        header.write(digits.padStart(length - 1, "0") + "\0", offset, length, "ascii");
      };
      header.write(name, 0, 100, "ascii");
      octal(relative === binaryName ? 0o755 : 0o644, 100, 8);
      octal(0, 108, 8); octal(0, 116, 8); octal(stat.size, 124, 12); octal(0, 136, 12);
      header.fill(32, 148, 156); header.write("0", 156, 1, "ascii");
      header.write("ustar\0", 257, 6, "ascii"); header.write("00", 263, 2, "ascii");
      header.write(prefix, 345, 155, "ascii");
      const checksum = header.reduce((sum, value) => sum + value, 0);
      header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
      yield header;
      for await (const chunk of fs.createReadStream(filename)) yield chunk;
      if (stat.size % 512) yield Buffer.alloc(512 - stat.size % 512);
    }
    yield Buffer.alloc(1024);
  }
  await pipeline(Readable.from(entries()), createGzip({ level: 9 }), fs.createWriteStream(archive, { flags: "wx", mode: 0o644 }));
}

async function buildExecutable({ root = ROOT, output, target = `${process.platform}-${process.arch}`,
    tools = path.join(ROOT, ".local-build-tools"), nodeBinary, nodeSha256, allowDirty = false } = {}) {
  root = path.resolve(root);
  if (!["linux-x64", "linux-arm64", "win32-x64"].includes(target)) throw new PackageError("target");
  if (process.versions.node !== NODE_VERSION) throw new PackageError("build_node_version");
  if (nodeBinary && !/^[a-f0-9]{64}$/.test(nodeSha256 || "")) throw new PackageError("node_checksum_required");
  const cross = target !== `${process.platform}-${process.arch}`;
  if (cross && !nodeBinary) throw new PackageError("target_node_required");
  const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = git(["rev-parse", "HEAD"]);
  const dirty = !!git(["status", "--porcelain", "--untracked-files=normal"]);
  if (dirty && !allowDirty) throw new PackageError("dirty_worktree");
  const { pkg, versions, files } = collectInputs(root);
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new PackageError("version");
  let taggedRelease = false;
  try { taggedRelease = git(["describe", "--tags", "--exact-match", "HEAD"]) === `v${pkg.version}`; } catch { /* Branch builds are previews. */ }
  const developmentBuild = dirty || !taggedRelease;
  const version = `${pkg.version}${developmentBuild ? `-dev.${commit.slice(0, 7)}` : ""}`;
  const name = `codex-bot-v${version}-${target}`;
  const buildDirectory = safeOutput(output || path.join(root, "dist", name), root);
  const modules = {};
  for (const [tool, expected] of Object.entries(TOOLS)) {
    const directory = path.join(path.resolve(tools), "node_modules", tool);
    if (JSON.parse(fs.readFileSync(path.join(directory, "package.json"))).version !== expected) throw new PackageError("build_tool_version");
    modules[tool] = require(directory);
  }
  const original = fs.readFileSync(nodeBinary || process.execPath);
  if (nodeBinary && hash(original) !== nodeSha256) throw new PackageError("node_checksum");
  validateBinary(original, target);
  // A cross target must be the official Node version matching the blob producer.
  // The operator verifies its checksum against that release's SHASUMS256.txt.
  if (!original.includes(Buffer.from(`v${NODE_VERSION}`))) throw new PackageError("node_version");
  const nodeFolder = path.dirname(nodeBinary || process.execPath);
  const nodeLicense = [path.join(nodeFolder, "LICENSE"), path.resolve(nodeFolder, "..", "LICENSE")].find(file => fs.existsSync(file));
  if (!nodeLicense) throw new PackageError("node_license_missing");
  const licenseContent = fs.readFileSync(nodeLicense);
  fs.mkdirSync(path.dirname(buildDirectory), { recursive: true });
  fs.mkdirSync(buildDirectory, { mode: 0o755 });
  const staging = fs.mkdtempSync(path.join(buildDirectory, ".staging-"));
  const directory = path.join(staging, name);
  fs.mkdirSync(directory);
  const bundle = path.join(staging, "bot.cjs");
  const bundled = await modules.esbuild.build({
    absWorkingDir: root, entryPoints: ["scripts/sea-entry.js"], outfile: bundle,
    bundle: true, platform: "node", format: "cjs", target: "node24", metafile: true,
    sourcemap: false, legalComments: "none", logLevel: "silent",
    define: { CODEX_BOT_BUILD_VERSION: JSON.stringify(version) },
  });
  const allowed = new Set([...RUNTIME, "scripts/sea-entry.js", ...files.filter(file => file.startsWith("node_modules/"))]);
  for (const relative of Object.keys(bundled.metafile.inputs)) {
    const normalized = relative.replaceAll("\\", "/");
    if (!allowed.has(normalized)) throw new PackageError("unexpected_bundle_input");
    assertSafeContent(fs.readFileSync(path.join(root, relative)));
  }
  assertSafeContent(fs.readFileSync(bundle));
  const assets = {};
  for (const asset of ASSETS) {
    const filename = path.join(root, asset);
    assertSafeContent(fs.readFileSync(filename));
    assets[asset] = filename;
  }
  const blob = path.join(staging, "sea.blob");
  const seaConfig = path.join(staging, "sea-config.json");
  fs.writeFileSync(seaConfig, JSON.stringify({ main: bundle, output: blob, assets,
    disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, execArgvExtension: "none" }), { flag: "wx" });
  execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
  const binaryName = target.startsWith("win32") ? "codex-bot.exe" : "codex-bot";
  const executable = path.join(directory, binaryName);
  fs.writeFileSync(executable, original, { flag: "wx", mode: 0o755 });
  await modules.postject.inject(executable, "NODE_SEA_BLOB", fs.readFileSync(blob), {
    sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  });
  if (!cross) {
    const clean = fs.mkdtempSync(path.join(staging, "smoke-"));
    const run = args => execFileSync(executable, args, { cwd: clean, encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
    if (run(["--version"]).trim() !== version || !run(["--help"]).includes("--check-config") ||
        JSON.parse(run(["discord", "--register-commands"])).length !== 12 || fs.readdirSync(clean).length) {
      throw new PackageError("executable_smoke_test");
    }
  }
  const manifest = { name: "codex-bot", version, commit, developmentBuild, dirtyWorktree: dirty, target,
    node: NODE_VERSION, nodeSha256: hash(original), buildTools: TOOLS, dependencies: versions,
    nativeSmokeTested: !cross, files: {} };
  const write = (relative, content) => {
    assertSafeContent(content);
    const filename = path.join(directory, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content, { flag: "wx", mode: 0o644 });
    manifest.files[relative] = hash(content);
  };
  manifest.files[binaryName] = hash(fs.readFileSync(executable));
  for (const relative of [".env.example", ".env.discord.example", "deploy/EXECUTABLE.md", "MODEL-REMINDERS.md", `UPGRADE-v${pkg.version}.md`, "deploy/upgrade-v1.8.0.sh"]) {
    write(relative, fs.readFileSync(path.join(root, relative)));
  }
  write("licenses/Node-LICENSE", licenseContent);
  for (const [name, license] of [["dotenv", "LICENSE"], ["node-telegram-bot-api", "LICENSE.md"]]) {
    write(`licenses/${name}-LICENSE`, fs.readFileSync(path.join(root, "node_modules", name, license)));
  }
  if (target.startsWith("linux")) for (const platform of ["tg", "discord"]) {
    write(`deploy/codex-${platform}-bot.service.example`, Buffer.from(fs.readFileSync(
      path.join(root, "deploy", "executable", `codex-${platform}-bot.service.example`), "utf8").replaceAll("@RELEASE_NAME@", name)));
  }
  fs.writeFileSync(path.join(directory, "release-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o644 });
  const archiveName = `${name}.tar.gz`;
  const archive = path.join(buildDirectory, archiveName);
  // New buildDirectory is exclusive; staging and failed artifacts are retained.
  await writeArchive(archive, directory, name, binaryName, [...Object.keys(manifest.files), "release-manifest.json"]);
  const checksumFile = path.join(buildDirectory, "SHA256SUMS");
  fs.writeFileSync(checksumFile, `${hash(fs.readFileSync(archive))}  ${archiveName}\n`, { flag: "wx" });
  return { executable, archive, checksumFile, manifest };
}

function parseBuildArgs(args) {
  const result = {};
  const keys = { "--output": "output", "--target": "target", "--tools": "tools", "--node-binary": "nodeBinary", "--node-sha256": "nodeSha256" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--allow-dirty" && !result.allowDirty) result.allowDirty = true;
    else if (keys[args[i]] && result[keys[args[i]]] === undefined && args[i + 1] && !args[i + 1].startsWith("--")) result[keys[args[i]]] = args[++i];
    else throw new PackageError("arguments");
  }
  return result;
}

if (require.main === module) Promise.resolve().then(() => buildExecutable(parseBuildArgs(process.argv.slice(2)))).then(result => {
  console.log(`Executable: ${result.executable}\nArchive: ${result.archive}\nChecksums: ${result.checksumFile}`);
  if (result.manifest.developmentBuild) console.log("Development build; do not publish as a stable release.");
  if (!result.manifest.nativeSmokeTested) console.log("Cross-built artifact: target-system execution still required.");
}).catch(error => {
  console.error(error instanceof PackageError ? error.message : "Executable build failed; check build tools, locked dependencies, runtime and files.");
  process.exitCode = 1;
});

module.exports = { buildExecutable, parseBuildArgs, validateBinary, writeArchive, NODE_VERSION, TOOLS };
