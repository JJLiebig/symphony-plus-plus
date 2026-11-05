"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("global Claude setup owns only its user entry and project setup remains local", { skip: process.platform !== "win32" }, t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sympp-setup-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, "home & test"), config = path.join(tmp, "claude"), project = path.join(tmp, "project"), bin = path.join(tmp, "bin");
  for (const dir of [home, config, project, bin]) fs.mkdirSync(dir, { recursive: true });
  const found = spawnSync("where.exe", ["claude.exe"], { encoding: "utf8" });
  if (found.status !== 0) { t.skip("Claude executable unavailable"); return; }
  fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\nexit 1\n");
  fs.writeFileSync(path.join(bin, "claude.cmd"), `@"${found.stdout.trim().split(/\r?\n/)[0]}" %*\r\n`);
  const global = path.join(home, ".agents", "skills", "sympp"), local = path.join(project, ".agents", "skills", "sympp");
  for (const root of [global, local]) {
    fs.cpSync(path.resolve(__dirname, "../../../../skills/sympp"), root, { recursive: true });
    for (const name of ["setup-sympp.js", "sympp-command.js"]) fs.copyFileSync(path.resolve(__dirname, "../../scripts", name), path.join(root, "scripts", name));
    fs.writeFileSync(path.join(root, ".sympp-install.json"), JSON.stringify({ version: "test", payload_sha256: "test" }));
  }
  fs.writeFileSync(path.join(home, ".agents", ".skill-lock.json"), JSON.stringify({ skills: { "sympp": { sourceType: "local" } } }));
  fs.writeFileSync(path.join(project, "skills-lock.json"), JSON.stringify({ skills: { "sympp": { sourceType: "local" } } }));
  const env = { ...process.env, ...isolatedPathEnv(tmp), USERPROFILE: home, HOME: home, CLAUDE_CONFIG_DIR: config, PATH: bin + path.delimiter + process.env.PATH, XDG_STATE_HOME: "", HERDR_APP_HOME: path.join(tmp, "herdr"), SYMPP_HOME: path.join(tmp, "sympp") };
  const run = (root, cwd = project) => spawnSync(process.execPath, [path.join(root, "scripts", "setup-sympp.js"), "--host", "claude"], { cwd, env, encoding: "utf8" });
  const cfg = path.join(config, ".claude.json"), mcp = path.join(project, ".mcp.json");
  let result = run(global); assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /takes precedence/); assert.equal(fs.existsSync(mcp), false);
  fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { symphony_plus_plus: { command: "old", env: { SYMPP_SKILLS_MANAGED: "1" } }, notes: { command: "notes" } } }));
  result = run(global); assert.equal(result.status, 0, result.stdout);
  assert.equal(JSON.parse(fs.readFileSync(mcp)).mcpServers.symphony_plus_plus, undefined);
  assert.equal(JSON.parse(fs.readFileSync(mcp)).mcpServers.notes.command, "notes");
  fs.writeFileSync(mcp, "{}");
  result = run(global); assert.equal(result.status, 0, result.stdout); assert.match(result.stdout, /takes precedence/);
  fs.unlinkSync(mcp);
  const configValue = JSON.parse(fs.readFileSync(cfg));
  configValue.projects = { [project.replaceAll("\\", "/")]: { mcpServers: { sympp: { command: "other" } } } };
  fs.writeFileSync(cfg, JSON.stringify(configValue));
  result = run(global); assert.equal(result.status, 0, result.stdout); assert.match(result.stdout, /takes precedence/);
  const repo = path.join(tmp, "repo"), subdir = path.join(repo, "sub"); fs.mkdirSync(subdir, { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);
  configValue.projects = { [repo.replaceAll("\\", "/")]: { mcpServers: { sympp: { command: "other" } } } };
  fs.writeFileSync(cfg, JSON.stringify(configValue));
  result = run(global, subdir); assert.equal(result.status, 0, result.stdout); assert.match(result.stdout, /takes precedence/);
  configValue.projects = {}; fs.writeFileSync(cfg, JSON.stringify(configValue));
  let entry = JSON.parse(fs.readFileSync(cfg)).mcpServers.sympp;
  assert.equal(entry.args[0], path.join(global, "scripts", "start-sympp-mcp-bridge.js"));
  result = run(global); assert.match(result.stdout, /already configured/);
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { symphony_plus_plus: entry } }));
  result = run(global); assert.equal(result.status, 0, result.stdout);
  assert.equal(JSON.parse(fs.readFileSync(cfg)).mcpServers.symphony_plus_plus, undefined);
  assert.equal(JSON.parse(fs.readFileSync(cfg)).mcpServers.sympp.env.SYMPP_SKILLS_MANAGED, "1");
  entry.args[0] = path.join(tmp, "old", "start-sympp-mcp-bridge.js"); fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { sympp: entry } }));
  result = run(global); assert.equal(result.status, 0, result.stdout); assert.equal(JSON.parse(fs.readFileSync(cfg)).mcpServers.sympp.args[0], path.join(global, "scripts", "start-sympp-mcp-bridge.js"));
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { sympp: { command: "unrelated" } } }));
  result = run(global); assert.notEqual(result.status, 0); assert.match(result.stdout, /unrelated/); assert.equal(JSON.parse(fs.readFileSync(cfg)).mcpServers.sympp.command, "unrelated");
  fs.unlinkSync(cfg);
  const claudeGlobal = path.join(config, "skills", "sympp");
  fs.cpSync(global, claudeGlobal, { recursive: true });
  result = run(claudeGlobal); assert.equal(result.status, 0, result.stdout); assert.equal(fs.existsSync(mcp), false);
  assert.equal(JSON.parse(fs.readFileSync(cfg)).mcpServers.sympp.args[0], path.join(claudeGlobal, "scripts", "start-sympp-mcp-bridge.js"));
  const link = path.join(home, ".claude", "skills", "sympp");
  fs.mkdirSync(path.dirname(link), { recursive: true }); fs.symlinkSync(global, link, "junction");
  result = run(link); assert.equal(result.status, 0, result.stdout); assert.equal(fs.existsSync(mcp), false);
  assert.equal(JSON.parse(fs.readFileSync(cfg)).mcpServers.sympp.args[0], path.join(global, "scripts", "start-sympp-mcp-bridge.js"));
  result = run(local); assert.equal(result.status, 0, result.stdout); assert.equal(JSON.parse(fs.readFileSync(mcp)).mcpServers.sympp.args[0], path.join(local, "scripts", "start-sympp-mcp-bridge.js"));
});



// Unit/integration setup tests use real hosts but stub the persistent registry
// write. Separate disposable live qualification covers actual PATH installation.
function isolatedPathEnv(root) {
  if (process.platform !== "win32") return {};
  const preload = path.join(root, "isolate-user-path.cjs");
  fs.writeFileSync(preload, `const cp = require('node:child_process');
const real = cp.spawnSync;
cp.spawnSync = (command, args, options) => command === 'powershell.exe' && args.some(arg => arg.includes('SYMPP_COMMAND_BIN'))
  ? { status: 0, stdout: '', stderr: '' } : real(command, args, options);
`);
  return { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` };
}

test('remote setup registers a launchable bridge in selected Codex and user Claude homes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sympp-remote-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, ...isolatedPathEnv(root), HOME: root, USERPROFILE: root, CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), HERDR_APP_HOME: path.join(root, 'herdr'), SYMPP_HOME: path.join(root, 'sympp') };
  fs.mkdirSync(env.SYMPP_HOME, { recursive: true });
  fs.writeFileSync(path.join(env.SYMPP_HOME, 'remote-token'), 'server-token-must-survive');
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../../scripts/setup-sympp.js'), '--host', 'both', '--server', 'http://127.0.0.1:19998'], { env, cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(path.join(env.SYMPP_HOME, 'remote-token'), 'utf8'), 'server-token-must-survive');
  assert.equal(fs.existsSync(path.join(root, '.mcp.json')), false);
  const claude = JSON.parse(fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR, '.claude.json'))).mcpServers.sympp;
  assert.equal(claude.env.SYMPP_SERVER_URL, 'http://127.0.0.1:19998');
  assert.equal(fs.readFileSync(claude.env.SYMPP_SERVER_TOKEN_FILE, 'utf8'), '');
  assert.equal(claude.env.SYMPP_DATABASE, undefined);
  assert.ok(fs.existsSync(claude.args[0]));
  const codex = fs.readFileSync(path.join(env.CODEX_HOME, 'config.toml'), 'utf8');
  assert.match(codex, /SYMPP_SERVER_URL = "http:\/\/127.0.0.1:19998"/);
  assert.doesNotMatch(codex, /SYMPP_DATABASE|SYMPP_RUNTIME_FILE/);
  fs.writeFileSync(claude.env.SYMPP_SERVER_TOKEN_FILE, 'first-client-credential');
  const second = spawnSync(process.execPath, [path.resolve(__dirname, '../../scripts/setup-sympp.js'), '--host', 'codex', '--server', 'http://127.0.0.1:19999'], {
    env: { ...env, CODEX_HOME: path.join(root, 'codex-second') }, cwd: root, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(fs.readFileSync(claude.env.SYMPP_SERVER_TOKEN_FILE, 'utf8'), 'first-client-credential');
});
