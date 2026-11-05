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
  git("init", "-b", "beta");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  fs.mkdirSync(path.join(upstream, "scripts"));
  fs.writeFileSync(path.join(upstream, "scripts/install-sympp-checkout.sh"), '#!/bin/sh\ncd "$(dirname "$0")/.."\ngit rev-parse HEAD > "$INSTALLED_REVISION"\n');
  git("add", "."); git("commit", "-m", "old"); git("tag", "old");
  const old = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(upstream, "version"), "beta");
  git("add", "."); git("commit", "-m", "beta");
  git("checkout", "-b", "feature", "old");
  fs.writeFileSync(path.join(upstream, "version"), "feature");
  git("add", "."); git("commit", "-m", "feature");
  const feature = git("rev-parse", "HEAD");
  run("git", ["clone", "--branch", "beta", upstream, checkout]);
  const installer = path.resolve(__dirname, "../../plugins/symphony-plus-plus-mcp/scripts/setup-sympp-service.sh");
  const receipt = path.join(root, "revision");
  const env = { ...process.env, SYMPP_SERVICE_SOURCE: checkout, INSTALLED_REVISION: receipt };
  for (const [ref, expected] of [["feature", feature], ["old", old]]) {
    run("bash", [installer], root, { ...env, SYMPP_SERVICE_REF: ref });
    assert.equal(fs.readFileSync(receipt, "utf8").trim(), expected);
  }
  fs.writeFileSync(path.join(checkout, "local-work"), "keep");
  const refused = spawnSync("bash", [installer], { cwd: root, env: { ...env, SYMPP_SERVICE_REF: "beta" }, encoding: "utf8" });
  assert.notEqual(refused.status, 0);
  assert.equal(fs.readFileSync(path.join(checkout, "local-work"), "utf8"), "keep");
  assert.equal(fs.readFileSync(receipt, "utf8").trim(), old);
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
  git('init', '-b', 'beta'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  fs.writeFileSync(path.join(upstream, 'scripts/install-sympp-checkout.sh'), '#!/bin/sh\nprintf "%s\\n" "$SYMPP_REPOS_ROOT" > "$RECEIPT"\n');
  git('add', '.'); git('commit', '-m', 'installer'); git('clone', upstream, checkout);
  fs.writeFileSync(path.join(upstream, 'version'), 'updated');
  git('add', '.'); git('commit', '-m', 'update');
  const expectedHead = git('rev-parse', 'HEAD');
  const reposRoot = path.join(root, 'factory repos'), receipt = path.join(root, 'receipt');
  const environment = path.join(root, 'environment'), fragment = path.join(root, 'config/systemd/user/qa.service');
  fs.mkdirSync(path.dirname(fragment), { recursive: true }); fs.writeFileSync(fragment, '');
  const values = { SYMPP_HOME: path.join(root, 'factory'), SYMPP_DATABASE: path.join(root, 'factory/ledger.sqlite3'), SYMPP_SERVICE_HOST: '127.0.0.1', SYMPP_REPOS_ROOT: reposRoot, SYMPP_SERVICE_SOURCE: checkout, SYMPP_SERVICE_REF: 'beta' };
  fs.writeFileSync(environment, Object.entries(values).map(([key, value]) => JSON.stringify(key + '=' + value)).join(' '));
  fs.writeFileSync(path.join(bin, 'systemctl'), '#!/bin/sh\ncase "$*" in *Environment*) cat "$ENVIRONMENT_FILE";; *FragmentPath*) printf "%s\\n" "$FRAGMENT_FILE";; *) exit 1;; esac\n', { mode: 0o755 });
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, ENVIRONMENT_FILE: environment, FRAGMENT_FILE: fragment, RECEIPT: receipt, SYMPP_REPOS_ROOT: path.join(root, 'wrong shell root') };
  const updater = path.resolve(__dirname, '../../plugins/symphony-plus-plus-mcp/scripts/update-sympp-service.sh');
  const result = spawnSync('bash', [updater, 'qa'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(receipt, 'utf8').trim(), reposRoot);
  assert.equal(git('-C', checkout, 'rev-parse', 'HEAD'), expectedHead);
});
