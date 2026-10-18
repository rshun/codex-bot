const path = require("node:path");
const { configureDirectory } = require("./runtime-paths");

const version = typeof CODEX_BOT_BUILD_VERSION === "string" ? CODEX_BOT_BUILD_VERSION : require("./package.json").version;
const help = `Codex Bot ${version}
Usage: codex-bot <telegram|discord> [--config-dir DIRECTORY] [--check-config]
       codex-bot discord [--config-dir DIRECTORY] --register-commands [--apply]
       codex-bot --help | --version

Configuration directory defaults to the current working directory.
Telegram reads .env; Discord reads DISCORD_ENV_FILE or .env.discord.
Session and reminder paths remain configurable with SESSION_FILE and REMINDER_FILE.
--check-config makes no network requests, model calls or state writes.
`;

function parseArgs(args) {
  if (args.length === 1 && ["--help", "--version"].includes(args[0])) return { info: args[0] };
  const [platform, ...rest] = args;
  if (!["telegram", "discord"].includes(platform)) throw new Error("arguments");
  let configDir;
  const flags = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--config-dir" && configDir === undefined && rest[i + 1] && !rest[i + 1].startsWith("--")) configDir = path.resolve(rest[++i]);
    else if (["--check-config", "--register-commands", "--apply"].includes(arg) && !flags.includes(arg)) flags.push(arg);
    else throw new Error("arguments");
  }
  if ((platform === "telegram" && flags.some(arg => arg !== "--check-config")) ||
      (flags.includes("--check-config") && flags.length !== 1) ||
      (flags.includes("--apply") && !flags.includes("--register-commands"))) throw new Error("arguments");
  return { platform, configDir: configDir || process.cwd(), flags };
}

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.info) { console.log(options.info === "--version" ? version : help); return; }
  configureDirectory(options.configDir);
  // Preserve relative .env paths and WORKDIR resolution against the stable config
  // directory, regardless of the executable's versioned installation directory.
  process.chdir(options.configDir);
  if (options.platform === "telegram") await require("./index").main(options.flags);
  else await require("./discord").main(options.flags);
}

function reportFailure(error) {
  // Raw dependency/OS errors can contain environment values or credential URLs.
  console.error(error?.message === "arguments" ? "Invalid arguments; use codex-bot --help."
    : "Bot startup/check failed; check configuration, state, Codex CLI and permissions.");
  process.exitCode = 1;
}

if (require.main === module) main().catch(reportFailure);
module.exports = { main, parseArgs, reportFailure };
