"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const name = "symphony_plus_plus";
const usage = "node <skill>/scripts/setup-sympp.js [--host auto|codex|claude|both] [--help] [--version]";
const emit = (key, value) => process.stdout.write(`${key}: ${JSON.stringify(value)}\n`);

function hostInstalled(host) {
  return spawnSync("where.exe", [host], { encoding: "utf8", windowsHide: true }).status === 0;
}

const begin = "# BEGIN Symphony++ Skills MCP";
const end = "# END Symphony++ Skills MCP";

function codexConfig(config, registration, servers = [], plugins = []) {
  const owned = /^# BEGIN Symphony\+\+ Skills MCP\r?\n[\s\S]*?^# END Symphony\+\+ Skills MCP\r?\n?/m;
  const previous = config.match(owned);
  const remaining = config.replace(owned, "");
  if (!previous && servers.some(server => server.name === name)) {
    throw new Error("Codex already has an unmanaged MCP registration. Use a separate CODEX_HOME, or explicitly remove symphony_plus_plus before setup.");
  }
  if (plugins.some(plugin => plugin.name === "symphony-plus-plus-mcp" && plugin.enabled)) throw new Error("This Codex home enables the Symphony++ MCP marketplace plugin. Use a separate CODEX_HOME, or disable that plugin before setup.");
  if (/^\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*=/m.test(remaining)) throw new Error("This Codex configuration uses an inline MCP table that setup cannot safely extend. Use a separate CODEX_HOME with standard server tables.");
  const lines = [begin, `[mcp_servers.${name}]`, `command = ${JSON.stringify(registration.command)}`,
    `args = ${JSON.stringify(registration.args)}`, "startup_timeout_sec = 360", "tool_timeout_sec = 300", "",
    `[mcp_servers.${name}.env]`, ...Object.entries(registration.env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`), end, ""];
  const block = lines.join("\n");
  return previous ? config.replace(owned, block) : config.trimEnd() + (config.trim() ? "\n\n" : "") + block;
}

function codexRead(command) {
  // Ask the host to parse its own configuration, including inline/dotted TOML.
  const result = spawnSync(command, { encoding: "utf8", windowsHide: true, shell: true });
  if (result.error || result.status !== 0) throw new Error("Codex could not read its selected configuration. Check CODEX_HOME and retry setup.");
  return JSON.parse(result.stdout);
}

function claudeConfig(config, registration) {
  const value = config ? JSON.parse(config) : {};
  const existing = value.mcpServers?.[name];
  if (existing && existing.env?.SYMPP_SKILLS_MANAGED !== "1") {
    throw new Error("This Claude project already has symphony_plus_plus. Use a separate workspace, or explicitly remove its project registration before setup.");
  }
  value.mcpServers = { ...value.mcpServers, [name]: registration };
  return JSON.stringify(value, null, 2) + "\n";
}
function runtimeChannel() {
  let directory = root;
  let entry;
  const globalRoot = path.join(os.homedir(), ".agents", "skills") + path.sep;
  const globalInstall = root.toLowerCase().startsWith(globalRoot.toLowerCase());
  while (!globalInstall) {
    const lock = path.join(directory, "skills-lock.json");
    if (fs.existsSync(lock)) { entry = JSON.parse(fs.readFileSync(lock, "utf8")).skills?.["symphony-plus-plus"]; if (entry) break; }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (!entry && !globalInstall) {
    const projectLock = path.join(process.cwd(), "skills-lock.json");
    if (fs.existsSync(projectLock)) entry = JSON.parse(fs.readFileSync(projectLock, "utf8")).skills?.["symphony-plus-plus"];
  }
  if (!entry && globalInstall) {
    const lock = process.env.XDG_STATE_HOME ? path.join(process.env.XDG_STATE_HOME, "skills", ".skill-lock.json") : path.join(os.homedir(), ".agents", ".skill-lock.json");
    if (fs.existsSync(lock)) entry = JSON.parse(fs.readFileSync(lock, "utf8")).skills?.["symphony-plus-plus"];
  }
  if (!entry) throw new Error("Cannot identify this skill's install branch. Re-add the skill, then run setup again.");
  if (entry.sourceType === "local") {
    if (process.env.SYMPP_RUNTIME_CHANNEL && !["stable", "beta"].includes(process.env.SYMPP_RUNTIME_CHANNEL)) throw new Error("Select stable or beta for this local skill copy.");
    return process.env.SYMPP_RUNTIME_CHANNEL || "stable";
  }
  if (entry.source !== "JJLiebig/symphony-plus-plus") throw new Error("Install Symphony++ from its official repository.");
  if (entry.ref === "beta") return "beta";
  if (!entry.ref || entry.ref === "main") return "stable";
  throw new Error("Install Symphony++ from the main or beta branch.");
}

function main(args) {
  const install = JSON.parse(fs.readFileSync(path.join(root, ".sympp-install.json"), "utf8"));
  if (args.length === 1 && ["--version", "-v", "-V"].includes(args[0])) { process.stdout.write(`${install.version}\n`); return; }
  if (args.length === 1 && args[0] === "--help") { emit("usage", usage); emit("help", "Run from the project that will use Symphony++. Omit --host to register installed Codex and Claude Code. Windows x64 only."); return; }
  let selection = "auto";
  if (args.length) {
    if (args.length !== 2 || args[0] !== "--host" || !["auto", "codex", "claude", "both"].includes(args[1])) {
      emit("error", "Unknown argument. Valid flags: --host auto|codex|claude|both, --help, --version."); process.exitCode = 2; return;
    }
    selection = args[1];
  }
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Symphony++ Skills setup supports Windows x64 only. Native Linux, macOS and Windows ARM host setup is not supported.");
  const commands = { codex: hostInstalled("codex"), claude: hostInstalled("claude") };
  const hosts = selection === "auto" ? Object.keys(commands).filter(host => commands[host]) : selection === "both" ? ["codex", "claude"] : [selection];
  if (!hosts.length || hosts.some(host => !commands[host])) throw new Error("The selected host is not installed on PATH. Install Codex or Claude Code, then retry setup with --host codex or --host claude.");
  const symppHome = path.resolve(process.env.SYMPP_HOME || path.join(os.homedir(), ".agents", "splusplus"));
  const env = {
    SYMPP_SKILLS_MANAGED: "1", SYMPP_RUNTIME_CHANNEL: runtimeChannel(), SYMPP_HOME: symppHome,
    SYMPP_DATABASE: path.resolve(process.env.SYMPP_DATABASE || path.join(symppHome, "symphony_plus_plus.sqlite3")),
    SYMPP_RUNTIME_FILE: path.resolve(process.env.SYMPP_RUNTIME_FILE || path.join(symppHome, "runtime", "codex-plugin.json")),
  };
  for (const key of ["SYMPP_BACKEND_PORT", "SYMPP_LOG_DIR", "SYMPP_OPEN_DASHBOARD"]) if (process.env[key]) env[key] = process.env[key];
  const registration = { type: "stdio", command: process.execPath, args: [path.join(root, "scripts", "start-sympp-mcp-bridge.js")], env };
  const plans = hosts.map(host => {
    const file = host === "codex" ? path.join(path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex")), "config.toml") : path.join(process.cwd(), ".mcp.json");
    const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    // Native Codex reads require an explicitly selected home to already exist.
    if (host === "codex") fs.mkdirSync(path.dirname(file), { recursive: true });
    const servers = host === "codex" ? codexRead("codex mcp list --json") : [];
    // Filtering the local marketplace avoids querying Codex's remote catalog.
    const plugins = host === "codex" ? codexRead("codex plugin list --marketplace symphony-plus-plus --json").installed : [];
    if (!Array.isArray(servers) || !Array.isArray(plugins)) throw new Error("Codex returned an unsupported configuration response. Update Codex and retry setup.");
    return { host, file, before, after: host === "codex" ? codexConfig(before, registration, servers, plugins) : claudeConfig(before, registration) };
  });
  for (const plan of plans) {
    if (plan.before !== plan.after) {
      fs.mkdirSync(path.dirname(plan.file), { recursive: true });
      fs.writeFileSync(plan.file, plan.after);
    }
    emit(plan.host, plan.before === plan.after ? "already configured" : "configured");
  }
  emit("channel", env.SYMPP_RUNTIME_CHANNEL);
  emit("install", install.payload_sha256);
  if (hosts.includes("claude")) emit("claude_next", "Project configuration is ready. An existing Claude local registration takes precedence: remove its symphony_plus_plus entry before opening a fresh session here.");
  emit("next", "Open fresh host sessions in this project and verify symphony_plus_plus tools before ledger work.");
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { emit("error", error.message); emit("help", usage); process.exitCode = 1; }
}
module.exports = { codexConfig, claudeConfig, runtimeChannel, main };
