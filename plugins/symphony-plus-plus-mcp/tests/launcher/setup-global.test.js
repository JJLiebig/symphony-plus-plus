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
  const global = path.join(home, ".agents", "skills", "symphony-plus-plus"), local = path.join(project, ".agents", "skills", "symphony-plus-plus");
  for (const root of [global, local]) {
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, "../../scripts/setup-sympp.js"), path.join(root, "scripts", "setup-sympp.js"));
    fs.writeFileSync(path.join(root, ".sympp-install.json"), JSON.stringify({ version: "test", payload_sha256: "test" }));
  }
  fs.writeFileSync(path.join(home, ".agents", ".skill-lock.json"), JSON.stringify({ skills: { "symphony-plus-plus": { sourceType: "local" } } }));
  fs.writeFileSync(path.join(project, "skills-lock.json"), JSON.stringify({ skills: { "symphony-plus-plus": { sourceType: "local" } } }));
  const env = { ...process.env, USERPROFILE: home, HOME: home, CLAUDE_CONFIG_DIR: config, PATH: bin + path.delimiter + process.env.PATH, XDG_STATE_HOME: "" };
  const run = (root, cwd = project) => spawnSync(process.execPath, [path.join(root, "scripts", "setup-sympp.js"), "--host", "claude"], { cwd, env, encoding: "utf8" });
  const cfg = path.join(config, ".claude.json"), mcp = path.join(project, ".mcp.json");
  let result = run(global); assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /takes precedence/); assert.equal(fs.existsSync(mcp), false);
  fs.writeFileSync(mcp, "{}");
  result = run(global); assert.equal(result.status, 0, result.stdout); assert.match(result.stdout, /takes precedence/);
  fs.unlinkSync(mcp);
  const configValue = JSON.parse(fs.readFileSync(cfg));
  configValue.projects = { [project.replaceAll("\\", "/")]: { mcpServers: { symphony_plus_plus: { command: "other" } } } };
  fs.writeFileSync(cfg, JSON.stringify(configValue));
  result = run(global); assert.equal(result.status, 0, result.stdout); assert.match(result.stdout, /takes precedence/);
  const repo = path.join(tmp, "repo"), subdir = path.join(repo, "sub"); fs.mkdirSync(subdir, { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);
  configValue.projects = { [repo.replaceAll("\\", "/")]: { mcpServers: { symphony_plus_plus: { command: "other" } } } };
  fs.writeFileSync(cfg, JSON.stringify(configValue));
  result = run(global, subdir); assert.equal(result.status, 0, result.stdout); assert.match(result.stdout, /takes precedence/);
  configValue.projects = {}; fs.writeFileSync(cfg, JSON.stringify(configValue));
  let entry = JSON.parse(fs.readFileSync(cfg)).mcpServers.symphony_plus_plus;
  assert.equal(entry.args[0], path.join(global, "scripts", "start-sympp-mcp-bridge.js"));
  result = run(global); assert.match(result.stdout, /already configured/);
  entry.args[0] = path.join(tmp, "old", "start-sympp-mcp-bridge.js"); fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { symphony_plus_plus: entry } }));
  result = run(global); assert.equal(result.status, 0, result.stdout); assert.equal(JSON.parse(fs.readFileSync(cfg)).mcpServers.symphony_plus_plus.args[0], path.join(global, "scripts", "start-sympp-mcp-bridge.js"));
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { symphony_plus_plus: { command: "unrelated" } } }));
  result = run(global); assert.notEqual(result.status, 0); assert.match(result.stdout, /unrelated/); assert.equal(JSON.parse(fs.readFileSync(cfg)).mcpServers.symphony_plus_plus.command, "unrelated");
  fs.unlinkSync(cfg);
  const claudeGlobal = path.join(config, "skills", "symphony-plus-plus");
  fs.cpSync(global, claudeGlobal, { recursive: true });
  result = run(claudeGlobal); assert.equal(result.status, 0, result.stdout); assert.equal(fs.existsSync(mcp), false);
  assert.equal(JSON.parse(fs.readFileSync(cfg)).mcpServers.symphony_plus_plus.args[0], path.join(claudeGlobal, "scripts", "start-sympp-mcp-bridge.js"));
  const link = path.join(home, ".claude", "skills", "symphony-plus-plus");
  fs.mkdirSync(path.dirname(link), { recursive: true }); fs.symlinkSync(global, link, "junction");
  result = run(link); assert.equal(result.status, 0, result.stdout); assert.equal(fs.existsSync(mcp), false);
  assert.equal(JSON.parse(fs.readFileSync(cfg)).mcpServers.symphony_plus_plus.args[0], path.join(global, "scripts", "start-sympp-mcp-bridge.js"));
  result = run(local); assert.equal(result.status, 0, result.stdout); assert.equal(JSON.parse(fs.readFileSync(mcp)).mcpServers.symphony_plus_plus.args[0], path.join(local, "scripts", "start-sympp-mcp-bridge.js"));
});


