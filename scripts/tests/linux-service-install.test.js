"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("Skills service setup selects divergent branches and older tags, preserving dirty checkouts", { skip: process.platform !== "linux" }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sympp-service-ref-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const upstream = path.join(root, "origin"), checkout = path.join(root, "installed");
  fs.mkdirSync(upstream);
  const run = (command, args, cwd = upstream, env = process.env) => {
    const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const git = (...args) => run("git", args);
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  fs.mkdirSync(path.join(upstream, "scripts"));
  fs.writeFileSync(path.join(upstream, "scripts/install-sympp-checkout.sh"), '#!/bin/sh\ncd "$(dirname "$0")/.."\ngit rev-parse HEAD > "$INSTALLED_REVISION"\nprintf "%s" "$SYMPP_SERVICE_REF" > "$INSTALLED_REF"\n');
  git("add", "."); git("commit", "-m", "old"); git("tag", "old");
  const old = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(upstream, "version"), "main");
  git("add", "."); git("commit", "-m", "main");
  git("checkout", "-b", "feature", "old");
  fs.writeFileSync(path.join(upstream, "version"), "feature");
  git("add", "."); git("commit", "-m", "feature");
  const feature = git("rev-parse", "HEAD");
  run("git", ["clone", "--branch", "main", upstream, checkout]);
  const installer = path.resolve(__dirname, "../../packages/sympp/scripts/setup-sympp-service.sh");
  const receipt = path.join(root, "revision");
  const refReceipt = path.join(root, 'selected-ref');
  const env = { ...process.env, SYMPP_SERVICE_SOURCE: checkout, INSTALLED_REVISION: receipt, INSTALLED_REF: refReceipt };
  for (const [ref, expected] of [["feature", feature], ["old", old]]) {
    run("bash", [installer], root, { ...env, SYMPP_SERVICE_REF: ref });
    assert.equal(fs.readFileSync(receipt, "utf8").trim(), expected);
    assert.equal(fs.readFileSync(refReceipt, 'utf8'), ref);
  }
  run('bash', [installer], root, env);
  assert.equal(fs.readFileSync(refReceipt, 'utf8'), process.env.SYMPP_SERVICE_REF || 'main');
  const beforeDirty = fs.readFileSync(receipt, 'utf8').trim();
  fs.writeFileSync(path.join(checkout, "local-work"), "keep");
  const refused = spawnSync("bash", [installer], { cwd: root, env: { ...env, SYMPP_SERVICE_REF: "main" }, encoding: "utf8" });
  assert.notEqual(refused.status, 0);
  assert.equal(fs.readFileSync(path.join(checkout, "local-work"), "utf8"), "keep");
  assert.equal(fs.readFileSync(receipt, "utf8").trim(), beforeDirty);
});

test('detached checkout installs pin the selected revision and only reuse matching ref metadata', { skip: process.platform !== 'linux' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sympp-detached-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), bin = path.join(root, 'bin'), receipt = path.join(root, 'ref');
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true }); fs.mkdirSync(path.join(repo, 'elixir'));
  fs.mkdirSync(bin);
  fs.copyFileSync(path.resolve(__dirname, '../install-sympp-checkout.sh'), path.join(repo, 'scripts/install-sympp-checkout.sh'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  git('add', '.'); git('commit', '-m', 'selected revision'); git('tag', 'v1'); git('checkout', '--detach', 'v1');
  const revision = git('rev-parse', 'HEAD');
  for (const command of ['systemctl', 'ss']) fs.writeFileSync(path.join(bin, command), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'mise'), '#!/bin/sh\nprintf "%s" "$SYMPP_SERVICE_REF" > "$REF_RECEIPT"\nexit 42\n', { mode: 0o755 });
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, SYMPP_HOME: path.join(root, 'factory'), SYMPP_DATABASE: path.join(root, 'ledger.sqlite3'), SYMPP_REPOS_ROOT: path.join(root, 'repos'), SYMPP_SERVICE_REF: '', SYMPP_SERVICE_HOST: '127.0.0.1', REF_RECEIPT: receipt };
  const selected = () => {
    const result = spawnSync('bash', [path.join(repo, 'scripts/install-sympp-checkout.sh')], { env, cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 42, result.stderr); // Stop at the build boundary, before any service changes.
    return fs.readFileSync(receipt, 'utf8');
  };
  assert.equal(selected(), revision);
  git('config', 'sympp.serviceRef', 'main'); git('config', 'sympp.serviceRevision', revision);
  assert.equal(selected(), 'main');
  fs.writeFileSync(path.join(repo, 'new-version'), 'v2'); git('add', '.'); git('commit', '-m', 'operator selects another revision');
  assert.equal(selected(), git('rev-parse', 'HEAD'));
});

test('client update rebuilds the saved checkout with its factory repository root', { skip: process.platform !== 'linux' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sympp-service-update-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const upstream = path.join(root, 'origin'), checkout = path.join(root, 'source'), bin = path.join(root, 'bin');
  fs.mkdirSync(path.join(upstream, 'scripts'), { recursive: true });
  fs.mkdirSync(bin);
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: upstream, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  fs.writeFileSync(path.join(upstream, 'scripts/install-sympp-checkout.sh'), '#!/bin/sh\nprintf "%s\\n" "$SYMPP_REPOS_ROOT" > "$RECEIPT"\n');
  git('add', '.'); git('commit', '-m', 'installer'); git('clone', upstream, checkout);
  fs.writeFileSync(path.join(upstream, 'version'), 'updated');
  git('add', '.'); git('commit', '-m', 'update');
  const expectedHead = git('rev-parse', 'HEAD');
  const reposRoot = path.join(root, 'factory repos'), receipt = path.join(root, 'receipt');
  const environment = path.join(root, 'environment'), fragment = path.join(root, 'config/systemd/user/qa.service');
  fs.mkdirSync(path.dirname(fragment), { recursive: true }); fs.writeFileSync(fragment, '');
  const values = { SYMPP_HOME: path.join(root, 'factory'), SYMPP_DATABASE: path.join(root, 'factory/ledger.sqlite3'), SYMPP_SERVICE_HOST: '127.0.0.1', SYMPP_REPOS_ROOT: reposRoot, SYMPP_SERVICE_SOURCE: checkout, SYMPP_SERVICE_REF: 'main' };
  fs.writeFileSync(environment, Object.entries(values).map(([key, value]) => JSON.stringify(key + '=' + value)).join(' '));
  fs.writeFileSync(path.join(bin, 'systemctl'), '#!/bin/sh\ncase "$*" in *Environment*) cat "$ENVIRONMENT_FILE";; *FragmentPath*) printf "%s\\n" "$FRAGMENT_FILE";; *) exit 1;; esac\n', { mode: 0o755 });
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, ENVIRONMENT_FILE: environment, FRAGMENT_FILE: fragment, RECEIPT: receipt, SYMPP_REPOS_ROOT: path.join(root, 'wrong shell root') };
  const updater = path.resolve(__dirname, '../../packages/sympp/scripts/update-sympp-service.sh');
  const result = spawnSync('bash', [updater, 'qa'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(receipt, 'utf8').trim(), reposRoot);
  assert.equal(git('-C', checkout, 'rev-parse', 'HEAD'), expectedHead);
});

test('board opens the saved factory with a private fragment and never logs its credential', { skip: process.platform !== 'linux' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sympp-board-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'), config = path.join(root, '.local/share/sympp/connection.json');
  fs.mkdirSync(bin); fs.mkdirSync(path.dirname(config), { recursive: true });
  const token = require('node:crypto').randomBytes(32).toString('base64url');
  const tokenFile = path.join(root, 'token'), receipt = path.join(root, 'opened');
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  const code = require('node:crypto').randomBytes(32).toString('base64url');
  let authorization;
  const server = require('node:http').createServer((request, response) => {
    authorization = request.headers.authorization;
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/api/v1/sympp/board-sign-in-code');
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ code }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(config, JSON.stringify({ env: { SYMPP_SERVER_URL: endpoint, SYMPP_SERVER_TOKEN_FILE: tokenFile } }));
  fs.writeFileSync(path.join(bin, 'xdg-open'), '#!/bin/sh\nprintf "%s" "$1" > "$RECEIPT"\n', { mode: 0o755 });
  const result = await require('node:util').promisify(require('node:child_process').execFile)(process.execPath, [path.resolve(__dirname, '../../packages/sympp/scripts/sympp-command.js'), 'board'], {
    env: { ...process.env, HOME: root, PATH: bin + path.delimiter + process.env.PATH, RECEIPT: receipt }, encoding: 'utf8',
  });
  assert.equal(authorization, `Bearer ${token}`);
  const url = new URL(fs.readFileSync(receipt, 'utf8'));
  assert.equal(url.origin, endpoint); assert.equal(url.pathname, '/sympp/board'); assert.equal(url.search, '');
  assert.equal(new URLSearchParams(url.hash.slice(1)).get('sympp-code'), code);
  assert.equal(result.stdout.includes(token) || result.stderr.includes(token), false);
});
