"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const name = "sympp";
const oldName = "symphony_plus_plus";
const usage = "sympp [update|status] [--host auto|codex|claude|both] [--server <ssh-host|http://127.0.0.1:19998>] [--help] [--version]";
const emit = (key, value) => process.stdout.write(`${key}: ${JSON.stringify(value)}\n`);

function hostInstalled(host) {
  return spawnSync(process.platform === "win32" ? "where.exe" : "which", [host], { encoding: "utf8", windowsHide: true }).status === 0;
}

const begin = "# BEGIN sympp Skills MCP";
const end = "# END sympp Skills MCP";

// Hide multiline string bodies without changing offsets or quoted TOML keys.
function tomlSyntax(source) {
  const result = source.split("");
  let quote = null, multiline = false, comment = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (comment) { if (char === "\n") comment = false; continue; }
    if (multiline) {
      if (char !== "\n" && char !== "\r") result[i] = " ";
      if (quote === '"' && char === "\\") {
        if (source[i + 1] && !["\n", "\r"].includes(source[i + 1])) result[++i] = " ";
      } else if (source.slice(i, i + 3) === quote.repeat(3)) {
        result[i] = result[i + 1] = result[i + 2] = " "; i += 2; quote = null; multiline = false;
      }
      continue;
    }
    if (quote) {
      if (quote === '"' && char === "\\") i++;
      else if (char === quote) quote = null;
    } else if (char === "#") comment = true;
    else if (char === '"' || char === "'") {
      quote = char;
      if (source.slice(i, i + 3) === char.repeat(3)) {
        multiline = true; result[i] = result[i + 1] = result[i + 2] = " "; i += 2;
      }
    }
  }
  return result.join("");
}

function codexConfig(config, registration) {
  const owned = /^# BEGIN (?:Symphony\+\+|sympp) Skills MCP\r?\n[\s\S]*?^# END (?:Symphony\+\+|sympp) Skills MCP\r?\n?/gm;
  const matches = [...tomlSyntax(config).matchAll(owned)];
  let remaining = config;
  for (const match of [...matches].reverse()) {
    remaining = remaining.slice(0, match.index) + remaining.slice(match.index + match[0].length);
  }
  const syntax = tomlSyntax(remaining);
  if (/^\s*\[\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*(?:sympp|"sympp"|'sympp')\s*(?:\.|\])/m.test(syntax) ||
      /^\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*(?:sympp|"sympp"|'sympp')\s*(?:\.|=)/m.test(syntax) ||
      /^\s*\[\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\][^\n]*\n(?:(?!^\s*\[)[\s\S])*?^\s*(?:sympp|"sympp"|'sympp')\s*(?:\.|=)/m.test(syntax)) {
    throw new Error("Codex already has an unmanaged sympp MCP registration. Remove it explicitly before setup.");
  }
  if (/^\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*=/m.test(syntax)) throw new Error("This Codex configuration uses an inline MCP table that setup cannot safely extend. Use a separate CODEX_HOME with standard server tables.");
  const lines = [begin, `[mcp_servers.${name}]`, `command = ${JSON.stringify(registration.command)}`,
    `args = ${JSON.stringify(registration.args)}`, "startup_timeout_sec = 360", "tool_timeout_sec = 300", "",
    `[mcp_servers.${name}.env]`, ...Object.entries(registration.env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`), end, ""];
  const block = lines.join("\n");
  if (matches.length) {
    let updated = config;
    for (let i = matches.length - 1; i >= 0; i--) {
      const match = matches[i];
      updated = updated.slice(0, match.index) + (i === 0 ? block : "") + updated.slice(match.index + match[0].length);
    }
    return updated;
  }
  return remaining.trimEnd() + (remaining.trim() ? "\n\n" : "") + block;
}

function claudeConfig(config, registration) {
  const value = config ? JSON.parse(config) : {};
  const existing = value.mcpServers?.[name];
  if (existing && existing.env?.SYMPP_SKILLS_MANAGED !== "1") {
    throw new Error("This Claude project already has sympp. Use a separate workspace, or explicitly remove its project registration before setup.");
  }
  if (value.mcpServers?.[oldName]?.env?.SYMPP_SKILLS_MANAGED === "1") delete value.mcpServers[oldName];
  value.mcpServers = { ...value.mcpServers, [name]: registration };
  return JSON.stringify(value, null, 2) + "\n";
}
function isGlobalInstall() {
  const install = fs.realpathSync(root).toLowerCase();
  return [path.join(os.homedir(), ".agents", "skills"), path.join(os.homedir(), ".claude", "skills"), ...(process.env.CLAUDE_CONFIG_DIR ? [path.join(process.env.CLAUDE_CONFIG_DIR, "skills")] : [])]
    .some(dir => fs.existsSync(dir) && install.startsWith(fs.realpathSync(dir).toLowerCase() + path.sep));
}

function runtimeChannel() {
  let directory = root;
  let entry;
  const globalInstall = isGlobalInstall();
  while (!globalInstall) {
    const lock = path.join(directory, "skills-lock.json");
    if (fs.existsSync(lock)) { entry = JSON.parse(fs.readFileSync(lock, "utf8")).skills?.["sympp"]; if (entry) break; }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (!entry && !globalInstall) {
    const projectLock = path.join(process.cwd(), "skills-lock.json");
    if (fs.existsSync(projectLock)) entry = JSON.parse(fs.readFileSync(projectLock, "utf8")).skills?.["sympp"];
  }
  if (!entry && globalInstall) {
    const lock = process.env.XDG_STATE_HOME ? path.join(process.env.XDG_STATE_HOME, "skills", ".skill-lock.json") : path.join(os.homedir(), ".agents", ".skill-lock.json");
    if (fs.existsSync(lock)) entry = JSON.parse(fs.readFileSync(lock, "utf8")).skills?.["sympp"];
  }
  if (!entry) throw new Error("Cannot identify this skill's install branch. Re-add the skill, then run setup again.");
  if (entry.sourceType === "local") {
    if (process.env.SYMPP_RUNTIME_CHANNEL && !["stable", "beta"].includes(process.env.SYMPP_RUNTIME_CHANNEL)) throw new Error("Select stable or beta for this local skill copy.");
    return process.env.SYMPP_RUNTIME_CHANNEL || "stable";
  }
  if (entry.source !== "JJLiebig/sympp") throw new Error("Install sympp from its official repository.");
  if (entry.ref === "beta") return "beta";
  if (!entry.ref || entry.ref === "main") return "stable";
  throw new Error("Install sympp from the main or beta branch.");
}

function main(args) {
  const install = JSON.parse(fs.readFileSync(path.join(root, fs.existsSync(path.join(root, ".sympp-install.json")) ? ".sympp-install.json" : ".codex-plugin/plugin.json"), "utf8"));
  if (args.length === 1 && ["--version", "-v", "-V"].includes(args[0])) { process.stdout.write(`${install.version}\n`); return; }
  if (args.length === 1 && args[0] === "--help") { emit("usage", usage); emit("help", "Run from the project that will use sympp. Omit --host to register installed Codex and Claude Code. Local setup: Windows x64. Remote setup: Windows and Linux."); return; }
  let selection = "auto", server;
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === "--host" && ["auto", "codex", "claude", "both"].includes(args[i + 1])) selection = args[i + 1];
    else if (args[i] === "--server" && args[i + 1]) server = args[i + 1];
    else { emit("error", "Unknown argument. " + usage); process.exitCode = 2; return; }
  }
  if (!server && (process.platform !== "win32" || process.arch !== "x64")) throw new Error("Local sympp Skills setup supports Windows x64 only. Use --server for an existing factory.");
  const commands = { codex: hostInstalled("codex"), claude: hostInstalled("claude") };
  const hosts = selection === "auto" ? Object.keys(commands).filter(host => commands[host]) : selection === "both" ? ["codex", "claude"] : [selection];
  if (!hosts.length || hosts.some(host => !commands[host])) throw new Error("The selected host is not installed on PATH. Install Codex or Claude Code, then retry setup with --host codex or --host claude.");
  const symppHome = path.resolve(process.env.SYMPP_HOME || path.join(os.homedir(), ".agents", "splusplus"));
  let env = {
    SYMPP_SKILLS_MANAGED: "1", SYMPP_RUNTIME_CHANNEL: server ? "remote" : runtimeChannel(), SYMPP_HOME: symppHome,
    SYMPP_DATABASE: path.resolve(process.env.SYMPP_DATABASE || path.join(symppHome, "symphony_plus_plus.sqlite3")),
    SYMPP_RUNTIME_FILE: path.resolve(process.env.SYMPP_RUNTIME_FILE || path.join(symppHome, "runtime", "codex-plugin.json")),
  };
  for (const key of ["SYMPP_BACKEND_PORT", "SYMPP_LOG_DIR", "SYMPP_OPEN_DASHBOARD"]) if (process.env[key]) env[key] = process.env[key];
  let remote;
  if (server) {
    const { serverConnection } = require("./sympp-remote.js");
    remote = serverConnection(server);
    const tokenFile = path.join(symppHome, `remote-client-${require("node:crypto").createHash("sha256").update(remote.endpoint).digest("hex").slice(0, 16)}.token`);
    env = { SYMPP_SKILLS_MANAGED: "1", SYMPP_HOME: symppHome, SYMPP_SERVER_URL: remote.endpoint, SYMPP_SERVER_NAME: server.startsWith("http://") ? new URL(server).hostname : server, SYMPP_SERVER_TOKEN_FILE: tokenFile };
  }
  const registration = { type: "stdio", command: fs.realpathSync.native(process.execPath), args: [path.join(root, "scripts", "start-sympp-mcp-bridge.js")], env };
  const globalClaude = (Boolean(server) || isGlobalInstall()) && hosts.includes("claude");
  let claudeUser, claudeCommand, claudeShadow, claudeOld;
  if (globalClaude) {
    const file = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(os.homedir(), ".claude.json");
    const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    claudeUser = config.mcpServers?.[name];
    claudeOld = config.mcpServers?.[oldName]?.env?.SYMPP_SKILLS_MANAGED === "1";
    const git = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", windowsHide: true });
    const gitDir = git.status === 0 ? git.stdout.trim() : "";
    const projectDir = path.basename(gitDir).toLowerCase() === ".git" ? path.dirname(gitDir) : process.cwd();
    const cwd = fs.realpathSync(projectDir).replaceAll("\\", "/").toLowerCase();
    claudeShadow = fs.existsSync(path.join(process.cwd(), ".mcp.json")) || Object.entries(config.projects || {}).some(([dir, project]) => dir.replaceAll("\\", "/").toLowerCase() === cwd && project.mcpServers?.[name]);
    if (claudeUser && claudeUser.env?.SYMPP_SKILLS_MANAGED !== "1") {
      throw new Error("Claude already has an unrelated user registration for sympp. Explicitly remove it before setup.");
    }
    const found = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["claude"], { encoding: "utf8", windowsHide: true });
    claudeCommand = found.stdout.trim().split(/\r?\n/).find(file => process.platform !== "win32" || /\.(?:exe|cmd|bat)$/i.test(file));
    if (found.status !== 0 || !claudeCommand) throw new Error("Claude executable not found. Install Claude Code and retry setup.");
  }
  const plans = [];
  if (globalClaude) {
    const file = path.join(process.cwd(), ".mcp.json");
    if (fs.existsSync(file)) {
      const before = fs.readFileSync(file, "utf8"), value = JSON.parse(before);
      if (value.mcpServers?.[oldName]?.env?.SYMPP_SKILLS_MANAGED === "1") {
        delete value.mcpServers[oldName];
        plans.push({ host: "claude_project", file, before, after: JSON.stringify(value, null, 2) + "\n" });
      }
    }
  }
  plans.push(...hosts.filter(host => host !== "claude" || !globalClaude).map(host => {
    const file = host === "codex" ? path.join(path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex")), "config.toml") : path.join(process.cwd(), ".mcp.json");
    const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    return { host, file, before, after: host === "codex" ? codexConfig(before, registration) : claudeConfig(before, registration) };
  }));
  if (remote) require("./sympp-remote.js").privateWrite(env.SYMPP_SERVER_TOKEN_FILE, remote.token);
  for (const plan of plans) {
    if (plan.before !== plan.after) {
      fs.mkdirSync(path.dirname(plan.file), { recursive: true });
      fs.writeFileSync(plan.file, plan.after);
    }
    emit(plan.host, plan.before === plan.after ? "already configured" : "configured");
  }
  if (globalClaude) {
    const unchanged = !claudeOld && claudeUser && JSON.stringify(claudeUser) === JSON.stringify(registration);
    if (!unchanged) {
      const run = args => {
        const result = /\.(?:cmd|bat)$/i.test(claudeCommand)
          ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$a = ConvertFrom-Json $env:SYMPP_SETUP_ARGS; & $env:SYMPP_SETUP_COMMAND @a; exit $LASTEXITCODE"], { encoding: "utf8", windowsHide: true, env: { ...process.env, SYMPP_SETUP_COMMAND: claudeCommand, SYMPP_SETUP_ARGS: JSON.stringify(args) } })
          : spawnSync(claudeCommand, args, { encoding: "utf8", windowsHide: true });
        if (result.error || result.status !== 0) throw new Error("Claude could not update its user registration. Check Claude configuration and retry setup.");
      };
      if (claudeOld) run(["mcp", "remove", "--scope", "user", oldName]);
      if (claudeUser) run(["mcp", "remove", "--scope", "user", name]);
      run(["mcp", "add", "--scope", "user", ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]), "--", name, registration.command, ...registration.args]);
    }
    emit("claude", unchanged ? "already configured" : "configured");
    if (claudeShadow) emit("claude_next", "A local or project sympp registration in this folder takes precedence over the user registration.");
  }
  require("./sympp-command.js").installCommand(root);
  const panel = fs.existsSync(path.join(root, 'integrations')) ? path.join(root, 'integrations/herdr-next/install.mjs') : path.resolve(root, '../../integrations/herdr-next/install.mjs');
  const herdrHome = path.resolve(process.env.HERDR_APP_HOME || path.join(os.homedir(), '.config', 'herdr-app'));
  const probe = spawnSync('herdr-app', ['--version'], { env: { ...process.env, HERDR_APP_HOME: herdrHome }, encoding: 'utf8', windowsHide: true });
  if (!probe.error && probe.status === 0) {
    const runtime = fs.existsSync(env.SYMPP_RUNTIME_FILE || '') ? JSON.parse(fs.readFileSync(env.SYMPP_RUNTIME_FILE, 'utf8')) : null;
    const endpoint = remote?.endpoint || runtime?.backend?.url || `http://127.0.0.1:${Number(env.SYMPP_BACKEND_PORT) || '19998'}`;
    const result = spawnSync(process.execPath, [panel, '--endpoint', endpoint, '--home', herdrHome, '--replace', '--auto-chrome',
      ...(remote ? ['--token-file', env.SYMPP_SERVER_TOKEN_FILE] : ['--factory', env.SYMPP_RUNTIME_FILE])], { encoding: 'utf8', windowsHide: true });
    if (result.error || result.status !== 0) throw new Error('Herdr panel setup failed. Run the installed integrations/herdr-next/install.mjs with --chrome to inspect the desk, then retry sympp setup. ' + (result.stdout || '').trim());
    emit('herdr', 'configured');
  }
  let skillCwd = root;
  while (!fs.existsSync(path.join(skillCwd, 'skills-lock.json')) && path.dirname(skillCwd) !== skillCwd) skillCwd = path.dirname(skillCwd);
  if (!fs.existsSync(path.join(skillCwd, 'skills-lock.json'))) skillCwd = process.cwd();
  require("./sympp-command.js").saveConnection({ env, setup: { cwd: process.cwd(), skillCwd, global: isGlobalInstall(), hosts: selection, ...(server ? { server } : {}), remote: Object.fromEntries(['SYMPP_REMOTE_HOME', 'SYMPP_REMOTE_PORT', 'SYMPP_REMOTE_SERVICE'].filter(key => process.env[key]).map(key => [key, process.env[key]])) } });
  emit("channel", server ? "remote" : env.SYMPP_RUNTIME_CHANNEL);
  emit("install", install.payload_sha256);
  if (hosts.includes("claude") && !globalClaude) emit("claude_next", "Project configuration is ready. An existing Claude local registration takes precedence: remove its sympp entry before opening a fresh session here.");
  emit("next", "Open fresh host sessions in this project and verify sympp tools before ledger work.");
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { emit("error", error.message); emit("help", usage); process.exitCode = 1; }
}
module.exports = { codexConfig, claudeConfig, runtimeChannel, main };
