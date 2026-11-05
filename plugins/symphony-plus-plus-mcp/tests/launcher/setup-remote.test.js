"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('remote setup registers a launchable bridge in selected Codex and user Claude homes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sympp-remote-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), SYMPP_HOME: path.join(root, 'sympp') };
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
