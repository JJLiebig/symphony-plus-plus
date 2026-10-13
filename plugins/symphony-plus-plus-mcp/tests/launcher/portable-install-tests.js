"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { codexConfig, claudeConfig } = require("../../scripts/setup-sympp.js");

const registration = { type: "stdio", command: "cmd.exe", args: ["/d", "/s", "/c", '"C:\\skill with spaces\\scripts\\start-sympp-mcp.cmd"'], env: { SYMPP_SKILLS_MANAGED: "1", SYMPP_HOME: "C:\\beta home", SYMPP_DATABASE: "C:\\beta home\\ledger.sqlite3", SYMPP_RUNTIME_FILE: "C:\\beta home\\runtime.json" } };
const unrelated = 'model = "example"\n[mcp_servers.notes]\ncommand = "notes.exe"\n';
const first = codexConfig(unrelated, registration);
assert.ok(first.startsWith(unrelated));
assert.equal(codexConfig(first, registration), first, "repeat setup must not change the config");
const moved = structuredClone(registration);
moved.args[3] = '"C:\\relocated\\scripts\\start-sympp-mcp.cmd"';
assert.ok(codexConfig(first, moved).includes("relocated"), "re-add at a new location repairs the owned registration");
assert.equal(codexConfig(codexConfig(first, moved), registration), first, "previous bundle selection repairs the same registration for rollback");
for (const config of ['[mcp_servers.symphony_plus_plus]\ncommand = "other"\n', '[mcp_servers."symphony_plus_plus".env]\nX = "1"\n', 'mcp_servers = { symphony_plus_plus = { command = "other" } }\n']) {
  assert.throws(() => codexConfig(config, registration), /already has an unmanaged/);
}
assert.throws(() => codexConfig('[plugins."symphony-plus-plus-mcp@symphony-plus-plus"]\nenabled = true\n', registration), /marketplace plugin/);
assert.ok(codexConfig('[plugins."symphony-plus-plus-mcp@symphony-plus-plus"]\nenabled = false\n', registration));
const claude = claudeConfig('{"other":true,"mcpServers":{"notes":{"command":"notes.exe"}}}', registration);
assert.equal(JSON.parse(claude).mcpServers.notes.command, "notes.exe");
assert.equal(JSON.parse(claude).other, true);
assert.equal(claudeConfig(claude, registration), claude);
assert.throws(() => claudeConfig('{"mcpServers":{"symphony_plus_plus":{"command":"other"}}}', registration), /already has/);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sympp-portable-tests-"));
const children = [];
async function main() {
  // Parse the resulting host config with an independent standard TOML parser.
  const parsed = spawnSync("python", ["-c", "import json,sys,tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))"], { input: first, encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
  const server = JSON.parse(parsed.stdout).mcp_servers.symphony_plus_plus;
  assert.equal(server.startup_timeout_sec, 360);
  assert.equal(server.tool_timeout_sec, 300);
  assert.deepEqual(server.args, registration.args);
  assert.deepEqual(server.env, registration.env);

  const bundle = path.resolve(__dirname, "../../../../skills/symphony-plus-plus");
  const fakeBin = path.join(root, "bin");
  fs.mkdirSync(fakeBin);
  for (const name of ["codex.exe", "claude.exe"]) fs.writeFileSync(path.join(fakeBin, name), "not executed");
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const env = { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, CODEX_HOME: path.join(root, "codex"), SYMPP_HOME: path.join(root, "beta"), SYMPP_DATABASE: path.join(root, "beta", "ledger.sqlite3"), SYMPP_RUNTIME_FILE: path.join(root, "beta", "state.json"), SYMPP_BACKEND_PORT: "21345" };
  const setup = args => spawnSync(process.execPath, [path.join(bundle, "scripts/setup-sympp.js"), ...args], { cwd: project, env, encoding: "utf8" });
  assert.equal(setup([]).status, 0);
  const configFile = path.join(env.CODEX_HOME, "config.toml");
  const saved = fs.readFileSync(configFile, "utf8");
  assert.equal(setup([]).status, 0);
  assert.equal(fs.readFileSync(configFile, "utf8"), saved);
  const hostEnv = JSON.parse(fs.readFileSync(path.join(project, ".mcp.json"))).mcpServers.symphony_plus_plus.env;
  assert.equal(hostEnv.SYMPP_BACKEND_PORT, "21345");
  assert.equal(hostEnv.SYMPP_RUNTIME_FILE, env.SYMPP_RUNTIME_FILE);
  assert.equal(setup(["--hos", "codex"]).status, 2);
  assert.equal(fs.readFileSync(configFile, "utf8"), saved);

  const bridge = path.resolve(__dirname, "../../scripts/start-sympp-mcp-bridge.js");
  const ownerCode = `const b=require(${JSON.stringify(bridge)}); (async()=>{await b.ensureLivenessProbe(); await b.claimPortableLedger(process.argv[1]); process.stdout.write('claimed\\n'); process.stdin.resume(); process.stdin.on('end',()=>{b.closeLivenessProbe();});})().catch(e=>{console.error(e.message);process.exit(1)});`;
  const database = path.join(root, "shared.sqlite3");
  function start(runtime) {
    const child = spawn(process.execPath, ["-e", ownerCode, runtime], { env: { ...process.env, SYMPP_DATABASE: database }, stdio: ["pipe", "pipe", "pipe"] });
    children.push(child); return child;
  }
  const firstOwner = start(path.join(root, "first", "runtime.json"));
  assert.match(String((await once(firstOwner.stdout, "data"))[0]), /claimed/);
  const sharedOwner = start(path.join(root, "first", "runtime.json"));
  assert.match(String((await once(sharedOwner.stdout, "data"))[0]), /claimed/);
  const foreign = start(path.join(root, "other", "runtime.json"));
  let errors = ""; foreign.stderr.on("data", chunk => { errors += chunk; });
  assert.equal((await once(foreign, "exit"))[0], 1);
  assert.match(errors, /already owned by another/);
  for (const child of [firstOwner, sharedOwner]) { child.stdin.end(); await once(child, "exit"); }
  const replacement = start(path.join(root, "other", "runtime.json"));
  assert.match(String((await once(replacement.stdout, "data"))[0]), /claimed/);
  replacement.stdin.end(); await once(replacement, "exit");
  console.log("Portable setup, registration repair/rollback, and cross-home ledger ownership passed.");
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const child of children) if (child.exitCode === null) child.kill();
  fs.rmSync(root, { recursive: true, force: true });
});
