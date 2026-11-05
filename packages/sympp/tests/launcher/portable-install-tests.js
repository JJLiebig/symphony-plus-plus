"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sympp-portable-tests-"));
const children = [];
async function main() {
  // Keep the actual concurrent cross-home claim boundary. Setup/configuration
  // behavior is owned by installed-runtime.e2e.ts with real native hosts.
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
  const racing = [start(path.join(root, "race-a", "runtime.json")), start(path.join(root, "race-b", "runtime.json"))];
  const outcomes = await Promise.all(racing.map(child => new Promise(resolve => {
    let error = "";
    child.stderr.on("data", chunk => { error += chunk; });
    child.stdout.once("data", chunk => resolve(String(chunk).includes("claimed") ? "claimed" : "unexpected"));
    child.once("exit", code => resolve(code === 1 && /already owned by another/.test(error) ? "refused" : "unexpected"));
  })));
  assert.deepEqual([...outcomes].sort(), ["claimed", "refused"], "two simultaneous homes must serialize before either opens SQLite");
  const winner = racing[outcomes.indexOf("claimed")];
  winner.stdin.end(); await once(winner, "exit");
  console.log("Cross-home ledger ownership, stale-owner takeover and concurrent claims passed.");
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const child of children) if (child.exitCode === null) child.kill();
  fs.rmSync(root, { recursive: true, force: true });
});
