const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const sea = require("node:sea");

let directory;
const ASSETS = new Set(["china-calendar.json", "reminder-response.schema.json"]);

function configureDirectory(value) {
  const resolved = fs.realpathSync(path.resolve(value));
  if (!fs.statSync(resolved).isDirectory()) throw new Error("Configuration directory unavailable.");
  directory = resolved;
}

function dataDirectory() { return directory || (sea.isSea() ? process.cwd() : __dirname); }
function defaultCalendarFile() { return sea.isSea() ? undefined : path.join(__dirname, "china-calendar.json"); }

function readAsset(name) {
  if (!ASSETS.has(name)) throw new Error("Unknown runtime asset.");
  return sea.isSea() ? Buffer.from(sea.getAsset(name)) : fs.readFileSync(path.join(__dirname, name));
}

// Codex is a separate process and needs a real --output-schema file. Only this
// public, embedded asset is materialized; configuration and user state stay external.
function schemaFile(stateDirectory = path.join(dataDirectory(), ".bot-state")) {
  if (!sea.isSea()) return path.join(__dirname, "reminder-response.schema.json");
  const content = readAsset("reminder-response.schema.json");
  const digest = createHash("sha256").update(content).digest("hex");
  // Use the existing state location, so a read-only config directory remains
  // usable when SESSION_FILE/REMINDER_FILE point at a separate writable volume.
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  let parent = fs.realpathSync(stateDirectory);
  for (const part of ["runtime-assets", digest]) {
    parent = path.join(parent, part);
    try { fs.mkdirSync(parent, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const stat = fs.lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o022)))) {
      throw new Error("Runtime asset directory permissions invalid.");
    }
  }
  const filename = path.join(parent, "reminder-response.schema.json");
  try { fs.lstatSync(filename); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const temporary = path.join(parent, `.schema-${randomUUID()}.tmp`);
    fs.writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    // Hard-link publication is atomic and cannot replace another process's file.
    // Retain the small public temporary asset instead of deleting files.
    try { fs.linkSync(temporary, filename); } catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== content.length ||
      (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o022))) ||
      !fs.readFileSync(filename).equals(content)) throw new Error("Runtime schema validation failed.");
  return filename;
}

function checkLocalPaths(config) {
  try {
    fs.accessSync(config.workdir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    for (const filename of [config.sessionFile, config.reminderFile]) {
      let parent = path.dirname(filename);
      while (!fs.existsSync(parent)) parent = path.dirname(parent);
      fs.accessSync(parent, fs.constants.W_OK | fs.constants.X_OK);
      if (fs.existsSync(filename)) fs.accessSync(filename, fs.constants.R_OK | fs.constants.W_OK);
    }
    if (path.isAbsolute(config.bin)) fs.accessSync(config.bin, fs.constants.X_OK);
    else if (!String(config.env.PATH || "").split(path.delimiter).filter(Boolean).some(folder => {
      try { fs.accessSync(path.join(folder, config.bin), fs.constants.X_OK); return true; } catch { return false; }
    })) throw new Error();
  } catch { throw new Error("Local paths or permissions invalid; check WORKDIR, CODEX_BIN and state paths."); }
}

module.exports = { configureDirectory, dataDirectory, defaultCalendarFile, readAsset, schemaFile, checkLocalPaths };
