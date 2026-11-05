"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
function installCommand(root) {
  const bin = path.join(os.homedir(), ".local", "bin");
  fs.mkdirSync(bin, { recursive: true });
  const script = path.join(root, "scripts", "sympp-command.js");
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(bin, "sympp.cmd"), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$p = [string][Environment]::GetEnvironmentVariable('Path','User'); if (@($p -split ';' | Where-Object { $_.TrimEnd('\\') -ieq $env:SYMPP_COMMAND_BIN.TrimEnd('\\') }).Count -eq 0) { [Environment]::SetEnvironmentVariable('Path', (($p.TrimEnd(';') + ';' + $env:SYMPP_COMMAND_BIN).TrimStart(';')), 'User') }"], { env: { ...process.env, SYMPP_COMMAND_BIN: bin }, encoding: "utf8", windowsHide: true });
    if (result.status !== 0) throw new Error("Could not add sympp to the user PATH.");
  } else {
    fs.writeFileSync(path.join(bin, "sympp"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o755 });
    if (!(process.env.PATH || "").split(path.delimiter).includes(bin)) {
      const profile = path.join(os.homedir(), path.basename(process.env.SHELL || "") === "zsh" ? ".zprofile" : ".profile");
      const line = 'export PATH="$HOME/.local/bin:$PATH"';
      const before = fs.existsSync(profile) ? fs.readFileSync(profile, "utf8") : "";
      if (!before.includes(line)) fs.appendFileSync(profile, `\n${line}\n`);
      process.stdout.write(`activate: ${JSON.stringify(line)}\n`);
    }
  }
}
function saveConnection(env) {
  const file = path.join(os.homedir(), ".local", "share", "sympp", "connection.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(env));
}
async function status() {
  const file = path.join(os.homedir(), ".local", "share", "sympp", "connection.json");
  if (!fs.existsSync(file)) throw new Error("Run sympp setup first.");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  const env = saved.env || saved;
  let endpoint = env.SYMPP_SERVER_URL;
  if (!endpoint && env.SYMPP_RUNTIME_FILE && fs.existsSync(env.SYMPP_RUNTIME_FILE)) endpoint = JSON.parse(fs.readFileSync(env.SYMPP_RUNTIME_FILE, "utf8")).backend?.url;
  process.stdout.write(`factory: ${JSON.stringify(endpoint || "local (not started)")}\n`);
  let answers = false;
  if (endpoint) {
    const token = env.SYMPP_SERVER_TOKEN_FILE ? fs.readFileSync(env.SYMPP_SERVER_TOKEN_FILE, "utf8").trim() : "";
    try {
      const response = await fetch(`${endpoint}/mcp/readiness`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(5000) });
      const readiness = await response.json();
      answers = response.ok && readiness.status === "ok" && readiness.ledger?.reachable === true;
    } catch {}
  }
  process.stdout.write(`answers: ${answers}\n`);
  if (!answers) process.exitCode = 1;
}
function update() {
  const file = path.join(os.homedir(), '.local', 'share', 'sympp', 'connection.json');
  if (!fs.existsSync(file)) throw new Error('Run sympp setup first.');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!saved.setup) throw new Error('Run sympp setup once to save the server and host selection, then retry sympp update.');
  const env = { ...process.env, ...saved.env, ...saved.setup.remote };
  const step = (label, command, args, options = {}) => {
    const result = spawnSync(command, args, { env, encoding: 'utf8', windowsHide: true, ...options });
    if (result.error || result.status !== 0) throw new Error(`${label} failed. ${label === 'skill' ? 'Run npx skills update sympp, then retry sympp update.' : label === 'setup' ? 'Run sympp setup again with your original server and host selection.' : 'Inspect the factory service journal over SSH, then retry sympp update.'}`);
    process.stdout.write(`${label}: updated\n`);
  };
  if (process.platform === 'win32') step('skill', 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '& npx.cmd skills update sympp; exit $LASTEXITCODE']);
  else step('skill', 'npx', ['skills', 'update', 'sympp']);
  // Spawn after the skill update so setup comes from the newly installed bundle.
  step('setup', process.execPath, [path.join(__dirname, 'setup-sympp.js'), '--host', saved.setup.hosts,
    ...(saved.setup.server ? ['--server', saved.setup.server] : [])]);
  if (saved.setup.server && !saved.setup.server.startsWith('http://')) {
    const script = fs.readFileSync(path.join(__dirname, 'update-sympp-service.sh'), 'utf8');
    const service = saved.setup.remote?.SYMPP_REMOTE_SERVICE || 'sympp';
    if (!/^[a-zA-Z0-9_-]+$/.test(service)) throw new Error('Invalid remote service name. Run sympp setup again.');
    step('factory', 'ssh', ['-o', 'BatchMode=yes', saved.setup.server, `bash -s -- ${quote(service)}`], { input: script });
  }
}
if (require.main === module) {
  Promise.resolve().then(() => process.argv[2] === "update" ? update() : process.argv[2] === "status" ? status() : require("./setup-sympp.js").main(process.argv.slice(2)))
    .catch(error => { process.stderr.write(`error: ${JSON.stringify(error.message)}\n`); process.exitCode = 1; });
}
module.exports = { installCommand, saveConnection };
