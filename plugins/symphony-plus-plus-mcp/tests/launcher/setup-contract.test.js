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
