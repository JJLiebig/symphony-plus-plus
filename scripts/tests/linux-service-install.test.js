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
