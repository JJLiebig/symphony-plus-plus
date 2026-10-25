"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn, spawnSync } = require("node:child_process");
const net = require("node:net");
const { once } = require("node:events");
const { createReporter } = require("../../scripts/sympp-session-location.js");
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
      const child = spawn(process.execPath, ["-e", entry, cli, peer, stateFile, ...args, "--json"], { env: process.env, cwd: root, windowsHide: true });
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
  const connect = () => require(cli).connectCore(undefined, process.execPath, [peer, stateFile]);
  try { await fn({ root, task, state, save, run, connect }); }
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

test("hand-started MCP bridges report native identity and require an authenticated live process", async () => scenario(async ({ root, task, state, save, run, connect }) => {
  const launched = await run(["launch", "--provider", "claude", "--task", task, "--cwd", root]);
  const original = { ...state().terminal.labels };
  const otherCore = path.join(root, "other-core.json");
  fs.writeFileSync(otherCore, JSON.stringify({ ...state(), core_id:"wrong-core" }));
  const reporter = createReporter({ ...process.env, HC_TERMINAL_ID: "t9", HC_TERMINAL_SOCKET: "private-core-selector",
    HC_SOCKET:"other-selector", HERDR_ENV: "1", HERDR_PANE_ID: "old-pane" }, selected =>
    selected.HC_SOCKET === "private-core-selector" ? connect() : require(cli).connectCore(undefined, process.execPath, [peer, otherCore]));
  const pipe = process.platform === "win32" ? `\\\\.\\pipe\\sympp-observed-${process.pid}` : path.join(root, "probe.sock");
  const bridge = require("../../scripts/start-sympp-mcp-bridge.js");
  await bridge.ensureLivenessProbe();
  const leaseFile = bridge.createLocalLease(path.join(root, "runtime.json"), { backend: { managed:true } }, { runtimeKey:"fixture" }, "fixture");
  const lease = JSON.parse(fs.readFileSync(leaseFile, "utf8"));
  const probe = { pipe:lease.process_liveness_pipe, token:lease.process_liveness_token };
  const token = probe.token;
  let mode = "valid";
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    if (mode !== "stalled") socket.end(mode === "valid" ? token : (token[0] === "a" ? "b" : "a") + token.slice(1));
  });
  server.listen(pipe);
  await once(server, "listening");
  try {
    const forwarded = JSON.parse(await reporter.attach(JSON.stringify({ method: "initialize", params: {} })));
    const observed = forwarded.params._meta.sympp_session_location;
    assert.equal(observed.herdr.core_id, "core-one");
    assert.equal(observed.herdr.terminal_id, "t9");
    assert.equal(observed.herdr.pid, 900, "terminal root PID is separate from the MCP process");
    assert.equal(observed.herdr.process_id, process.pid);
    assert.equal(observed.herdr.pane_id, undefined, "new core context wins over inherited legacy context");
    assert.doesNotMatch(JSON.stringify(observed), /private-core-selector|process_liveness/);

    await reporter.report({ role: "architect", work_request_id: "wr-manual" }, probe);
    const labels = state().terminal.labels;
    for (const [key, value] of Object.entries(original)) assert.equal(labels[key], value);
    const args = ["check", "--receipt", labels["sympp.session_receipt"]];
    const alive = await run(args);
    assert.equal(alive.code, 0);
    assert.equal(alive.body.state, "live");
    assert.equal(alive.body.work_request_id, "wr-manual");
    assert.equal(alive.body.role, "architect");
    assert.doesNotMatch(JSON.stringify(alive.body), /process_liveness|private-core-selector/);
    assert.ok(!JSON.stringify(alive.body).includes(token));
    assert.equal((await run(["check", "--receipt", launched.body.receipt])).body.state, "live");

    for (const denied of ["wrong", "stalled"]) {
      mode = denied;
      await reporter.report({ role: "architect", work_request_id: "wr-manual" }, { pipe, token });
      assert.equal((await run(args)).body.state, "stale", "a timeout is not authenticated liveness");
      for (const socket of sockets) socket.destroy();
    }
    mode = "valid";
    await reporter.report({ role: "architect", work_request_id: "wr-manual" }, probe);
    save({ ...state(), terminal: { ...state().terminal, pid: 901 } });
    assert.equal((await run(args)).body.reason, "process_changed");
    await reporter.report({ role: "architect", work_request_id: "replacement" }, { pipe, token });
    assert.equal(state().terminal.labels["sympp.session_work_request_id"], "wr-manual", "an old bridge cannot bind a recovered terminal");
    save({ ...state(), terminal: { ...state().terminal, pid: 900 } });
    reporter.close();
    assert.equal(fs.existsSync(labels["sympp.session_receipt"]), false, "revoke before asynchronous runtime cleanup");
    await reporter.report({ role: "architect", work_request_id: "resurrected" }, { pipe, token });
    assert.equal(fs.existsSync(labels["sympp.session_receipt"]), false);
    assert.equal((await run(args)).body.error, "input_unreadable");
  } finally {
    reporter.close();
    bridge.closeLivenessProbe();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}));

test("standalone and unavailable-core reporters preserve MCP calls without inventing bindings", async () => {
  const request = JSON.stringify({ method: "tools/call", params: { name: "get_current_assignment", arguments: {}, _meta: { extra: true } } });
  const standalone = createReporter({}, () => { throw new Error("must not contact a core"); });
  assert.equal(JSON.parse(await standalone.attach(request)).params._meta.sympp_session_location.herdr, undefined);
  const unavailable = createReporter({ HC_TERMINAL_ID: "t2", HC_TERMINAL_SOCKET: "private" }, () => ({
    call: async () => { throw new Error("core unavailable"); }, close() {},
  }));
  const forwarded = JSON.parse(await unavailable.attach(request));
  assert.equal(forwarded.params._meta.extra, true);
  assert.deepEqual(forwarded.params.arguments, {});
  assert.equal(forwarded.params._meta.sympp_session_location.herdr, undefined);
});
