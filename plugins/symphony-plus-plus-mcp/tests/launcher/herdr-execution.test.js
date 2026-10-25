"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn, spawnSync } = require("node:child_process");
const cli = path.resolve(__dirname, "../../scripts/sympp-herdr.js");
const peer = path.join(__dirname, "herdr-execution-peer.js");

async function scenario(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sympp-herdr-"));
  const prior = { ...process.env };
  process.env.SYMPP_HOME = path.join(root, "ledger home");
  process.env.OPENAI_API_KEY = "controlled-secret-never-copy";
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  for (const provider of ["codex", "claude", "opencode"]) fs.writeFileSync(path.join(bin, provider + (process.platform === "win32" ? ".cmd" : "")), "controlled executable\n", { mode: 0o755 });
  process.env.PATH = bin + path.delimiter + (process.env.PATH || "");
  delete process.env.HC_TERMINAL_ID;
  delete process.env.HC_TERMINAL_SOCKET;
  const stateFile = path.join(root, "core.json");
  const save = (state) => fs.writeFileSync(stateFile, JSON.stringify(state));
  const state = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
  save({ core_id: "core-one", calls: [], runs: 0 });
  const task = path.join(root, 'task with spaces.txt');
  fs.writeFileSync(task, "Repair the specified fixture, then report evidence.");
  async function run(args) {
    // Only replace the transport executable; the public parser and process IO run unchanged.
    const entry = 'const {main,connectCore}=require(process.argv[1]); main(process.argv.slice(4), session=>connectCore(session,process.execPath,[process.argv[2],process.argv[3]]));';
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", entry, cli, peer, stateFile, ...args, "--json"], { env: process.env, windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data) => { stdout += data; });
      child.stderr.on("data", (data) => { stderr += data; });
      child.on("error", reject);
      child.on("exit", (code) => {
        try { assert.equal(stderr, ""); resolve({ code, body: JSON.parse(stdout) }); }
        catch (error) { reject(error); }
      });
    });
  }
  try { await fn({ root, task, state, save, run }); }
  finally {
    for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key];
    Object.assign(process.env, prior);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("ordinary tasks launch every provider without S++ authority, shell interpolation or credential copying", async () => scenario(async ({ root, task, run, state }) => {
  for (const provider of ["codex", "claude", "opencode"]) {
    const result = await run(["launch", "--provider", provider, "--model", "chosen/model", "--task", task, "--cwd", root, "--attempt", provider]);
    assert.equal(result.code, 0);
    assert.equal(result.body.work_package_id, null);
    const request = state().calls.filter((call) => call.method === "terminal.run").at(-1).params;
    assert.equal(request.env.OPENAI_API_KEY, undefined);
    assert.equal(request.line, undefined);
    assert.equal(request.cwd, root);
    const program = path.join(root, "bin", provider + (process.platform === "win32" ? ".cmd" : "")).replace(/\\/g, "/");
    assert.equal(process.platform === "win32" ? request.argv[0].toLowerCase() : request.argv[0], process.platform === "win32" ? program.toLowerCase() : program);
    assert.deepEqual(request.argv.slice(1, provider === "codex" ? 4 : 3), provider === "codex" ? ["--no-daemon", "--model", "chosen/model"] : ["--model", "chosen/model"]);
    assert.equal(request.argv.at(-2), provider === "opencode" ? "--prompt" : "--");
    assert.ok(request.argv.at(-1).includes(JSON.stringify(task)));
    assert.ok(!request.argv.at(-1).includes("Repair the specified fixture"));
    assert.equal(result.body.pid, 900);
    assert.equal(result.body.core_id, "core-one");
  }
  assert.equal(state().runs, 3);
  assert.equal(state().transport_secret_present, false);
}));

test("an interrupted PID label publication repairs discovery on replay without another worker", async () => scenario(async ({ root, task, run, state, save }) => {
  save({ ...state(), lose_label_reply: true });
  const args = ["launch", "--provider", "claude", "--task", task, "--cwd", root];
  assert.equal((await run(args)).body.error, "core_unreachable");
  assert.equal(state().terminal.labels["sympp.pid"], undefined);
  save({ ...state(), lose_label_reply: false });
  const retried = await run(args);
  assert.equal(retried.code, 0);
  assert.equal(retried.body.reused, true);
  assert.equal(state().runs, 1);
  assert.equal(state().terminal.labels["sympp.pid"], "900");
}));

test("dispatched bootstrap binds exact work once, preserves placement and explicit profile", async () => scenario(async ({ root, run, state }) => {
  const input = path.join(root, "worker.json");
  fs.writeFileSync(input, JSON.stringify({ worker_bootstrap: {
    type: "assignment", launch_prompt: "Implement the scoped assignment.", future_field: true,
    coordinates: { primary_execution: { kind: "work_package", work_package_id: "wp-one" }, product_parent: { kind: "work_request", work_request_id: "wr-one" } },
  } }));
  const args = ["launch", "--provider", "claude", "--model", "opus", "--assignment", input, "--ledger", "isolated-ledger", "--cwd", root, "--space", "s1", "--tab", "job", "--parent", "t2", "--provider-home", root];
  const first = await run(args);
  const second = await run(args);
  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  assert.equal(second.body.reused, true);
  assert.equal(second.body.launch_id, first.body.launch_id);
  assert.equal(first.body.work_package_id, "wp-one");
  assert.equal(first.body.work_request_id, "wr-one");
  assert.equal(state().runs, 1);
  const request = state().calls.find((call) => call.method === "terminal.run").params;
  assert.equal(request.labels["herdr.space"], "s1");
  assert.equal(request.labels["herdr.tab"], "job");
  assert.equal(request.env.CLAUDE_CONFIG_DIR, root);
  assert.equal(request.parent, "t2");
  assert.equal(state().terminal.labels["sympp.pid"], "900");
  assert.equal(state().terminal.labels["sympp.receipt"], first.body.receipt);
  assert.equal(state().terminal.labels["sympp.core_id"], first.body.core_id);
  assert.ok(state().calls.every((call) => call.method.startsWith("terminal.") || call.method === "hello"));
  assert.equal((await run(args.map((arg) => arg === "opus" ? "sonnet" : arg))).body.error, "launch_conflict");
}));

test("lost launch replies and stale processes never trigger duplicate execution", async () => scenario(async ({ root, task, state, save, run }) => {
  save({ ...state(), lose_reply: true });
  const args = ["launch", "--provider", "codex", "--task", task, "--cwd", root];
  assert.equal((await run(args)).body.error, "core_unreachable");
  save({ ...state(), lose_reply: false });
  assert.equal((await run(args)).body.error, "launch_uncertain");
  assert.equal(state().runs, 1);
  const other = await run([...args, "--attempt", "explicit-retry"]);
  assert.equal(other.code, 0);
  save({ ...state(), terminal: { ...state().terminal, pid: 901, status: null } });
  const checked = await run(["check", "--receipt", other.body.receipt]);
  assert.equal(checked.body.state, "stale");
  assert.equal(checked.body.reason, "process_changed");
  assert.equal((await run([...args, "--attempt", "explicit-retry"])).body.error, "process_changed");
  assert.equal(state().runs, 2);
}));

test("send validates ownership and atomic status so a recovered shell cannot receive agent text", async () => scenario(async ({ root, task, state, save, run }) => {
  const launched = await run(["launch", "--provider", "claude", "--task", task, "--cwd", root]);
  const args = ["send", "--receipt", launched.body.receipt, "--message", task];
  assert.equal((await run(args)).body.started, true);
  assert.equal(state().sent, fs.readFileSync(task, "utf8"));
  save({ ...state(), sent: null, recover_before_send: true });
  assert.equal((await run(args)).body.error, "status_mismatch");
  assert.equal(state().sent, null);
  save({ ...state(), core_id: "other-core" });
  assert.equal((await run(["check", "--receipt", launched.body.receipt])).body.reason, "different_core");
  assert.equal((await run(args)).body.error, "agent_not_ready");
}));

test("unknown flags and missing inputs fail before opening a runtime; version is standalone", () => {
  for (const args of [["launch", "--provder", "codex"], ["send", "--receipt", "missing.json"], ["launch", "--provider", "codex"]]) {
    const result = spawnSync(process.execPath, [cli, ...args, "--json"], { encoding: "utf8", env: { ...process.env, PATH: "" }, windowsHide: true });
    assert.equal(result.status, 2);
    assert.ok(JSON.parse(result.stdout).help.length > 0);
    assert.equal(result.stderr, "");
  }
  const version = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8", env: { ...process.env, PATH: "" }, windowsHide: true });
  assert.equal(version.status, 0);
  assert.equal(version.stdout, "1.0.0\n");
});
