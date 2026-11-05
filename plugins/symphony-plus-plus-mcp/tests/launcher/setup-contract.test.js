"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { codexConfig, claudeConfig } = require("../../scripts/setup-sympp.js");
const registration = { command: "node", args: ["bridge.js"], env: { SYMPP_SKILLS_MANAGED: "1" } };

test("migration replaces owned blocks while preserving unrelated registrations and refusing collisions", () => {
  const unrelated = '[mcp_servers.notes]\ncommand = "notes"\n';
  const legacy = '# BEGIN Symphony++ Skills MCP\n[mcp_servers.symphony_plus_plus]\ncommand = "old"\n# END Symphony++ Skills MCP\n';
  const migrated = codexConfig(unrelated + legacy, registration);
  assert.ok(migrated.startsWith(unrelated));
  assert.doesNotMatch(migrated, /symphony_plus_plus/);
  assert.equal(codexConfig(migrated, registration), migrated);
  const augmented = 'model = "example-model"\n' + codexConfig("", registration) + '\n# operator note\n';
  assert.equal(codexConfig(augmented, registration), augmented);
  for (const table of ['[mcp_servers.sympp]', '[mcp_servers."sympp"]', "['mcp_servers'.'sympp']", '[mcp_servers.sympp.env]']) {
    assert.throws(() => codexConfig(migrated + table + '\n', registration), /unmanaged/);
  }
  for (const dotted of ['mcp_servers.sympp.command = "other"', '[mcp_servers]\nsympp.command = "other"', '[mcp_servers]\nsympp = { command = "other" }']) {
    assert.throws(() => codexConfig(dotted + '\n', registration), /unmanaged/);
  }
  assert.throws(() => codexConfig('mcp_servers = { sympp = {} }\n', registration), /inline MCP/);
  const owned = { ...registration, env: { SYMPP_SKILLS_MANAGED: "1" } };
  const value = JSON.parse(claudeConfig(JSON.stringify({ mcpServers: { symphony_plus_plus: owned, notes: { command: "notes" } } }), registration));
  assert.equal(value.mcpServers.symphony_plus_plus, undefined);
  assert.equal(value.mcpServers.notes.command, "notes");
  const unowned = JSON.parse(claudeConfig(JSON.stringify({ mcpServers: { symphony_plus_plus: { command: "other" } } }), registration));
  assert.equal(unowned.mcpServers.symphony_plus_plus.command, "other");
  assert.throws(() => claudeConfig(JSON.stringify({ mcpServers: { sympp: { command: "other" } } }), registration), /already has/);
});

test("TOML instruction examples are inert and preserved during managed migration", () => {
  for (const delimiter of ['"""', "'".repeat(3)]) {
    const instruction = `instructions = ${delimiter}\n[mcp_servers.sympp]\n# BEGIN sympp Skills MCP\nexample\n# END sympp Skills MCP\n${delimiter}\n`;
    const result = codexConfig(instruction, registration);
    assert.ok(result.startsWith(instruction));
    assert.equal(codexConfig(result, registration), result);
  }
});


test("status refuses degraded or unauthenticated factories and accepts a reachable ledger", async t => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const { spawn } = require("node:child_process"), http = require("node:http"), { once } = require("node:events");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sympp-status-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let code = 200, body;
  const server = http.createServer((req, res) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); });
  server.listen(0, "0.0.0.0"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const file = path.join(home, ".local/share/sympp/connection.json"); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ SYMPP_SERVER_URL: `http://127.0.0.1:${server.address().port}` }));
  for (const [statusCode, readiness, expected] of [
    [200, { status: "degraded", ledger: { reachable: false } }, 1],
    [401, { error: "unauthorized" }, 1],
    [200, { status: "ok", ledger: { reachable: true } }, 0],
  ]) {
    code = statusCode; body = readiness;
    const child = spawn(process.execPath, [path.resolve(__dirname, "../../scripts/sympp-command.js"), "status"], {
      env: { ...process.env, HOME: home, USERPROFILE: home }, windowsHide: true,
    });
    let stdout = ""; child.stdout.on("data", value => stdout += value);
    assert.equal((await once(child, "close"))[0], expected);
    assert.match(stdout, new RegExp(`answers: ${expected === 0}`));
  }
});
