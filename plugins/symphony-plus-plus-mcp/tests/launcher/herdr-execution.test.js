"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn, spawnSync } = require("node:child_process");
const net = require("node:net");
const { once } = require("node:events");
const { createHash } = require("node:crypto");
const { createReporter } = require("../../scripts/sympp-session-location.js");
const cli = path.resolve(__dirname, "../../scripts/sympp-herdr.js");
const peer = path.join(__dirname, "herdr-execution-peer.js");

async function scenario(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sympp-herdr-"));
  const prior = { ...process.env };
  process.env.SYMPP_HOME = path.join(root, "ledger home");
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude home");
  process.env.CODEX_HOME = path.join(root, "codex home");
  process.env.OPENAI_API_KEY = "controlled-secret-never-copy";
  const bin = path.join(root, "provider bin");
  fs.mkdirSync(bin);
  for (const provider of ["codex", "claude", "opencode"]) fs.writeFileSync(path.join(bin, provider + (process.platform === "win32" ? ".cmd" : "")), "controlled executable\n", { mode: 0o755 });
  const configPeer = path.join(__dirname, "codex-config-peer.js");
  fs.writeFileSync(path.join(bin, "codex" + (process.platform === "win32" ? ".cmd" : "")), process.platform === "win32"
    ? `@"${process.execPath}" "${configPeer}"\r\n`
    : `#!/usr/bin/env node\nrequire(${JSON.stringify(configPeer)});\n`, { mode: 0o755 });
  process.env.PATH = bin + path.delimiter + (process.env.PATH || "");
  delete process.env.HC_TERMINAL_ID;
  delete process.env.HC_TERMINAL_SOCKET;
  const stateFile = path.join(root, "core.json");
  const save = (state) => fs.writeFileSync(stateFile, JSON.stringify(state));
  const state = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
  save({ core_id: "core-one", calls: [], runs: 0 });
  const task = path.join(root, 'task with spaces.txt');
  fs.writeFileSync(task, "Repair the specified fixture, then report evidence.");
  async function run(args, prelude = "") {
    // Only replace the transport executable; the public parser and process IO run unchanged.
    const entry = prelude + 'const {main,connectCore}=require(process.argv[1]); main(process.argv.slice(4), session=>connectCore(session,process.execPath,[process.argv[2],process.argv[3]]));';
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
  let claudeConfig;
  for (const provider of ["codex", "claude", "opencode"]) {
    const result = await run(["launch", "--provider", provider, "--model", "chosen/model", "--task", task, "--cwd", root, "--attempt", provider]);
    assert.equal(result.code, 0);
    assert.equal(result.body.work_package_id, null);
    const request = state().calls.filter((call) => call.method === "terminal.run").at(-1).params;
    assert.equal(request.name, `repair-the-specified-${provider}`, "shorten at a word boundary and preserve the provider");
    assert.equal(request.env.OPENAI_API_KEY, undefined);
    assert.equal(request.line, undefined);
    assert.equal(request.cwd, root);
    const program = path.join(root, "provider bin", provider + (process.platform === "win32" ? ".cmd" : "")).replace(/\\/g, "/");
    assert.equal(process.platform === "win32" ? request.argv[0].toLowerCase() : request.argv[0], process.platform === "win32" ? program.toLowerCase() : program);
    assert.deepEqual(request.argv.slice(1, provider === "codex" ? 4 : 3), provider === "codex" ? ["--no-daemon", "--model", "chosen/model"] : ["--model", "chosen/model"]);
    assert.equal(request.argv.at(-2), provider === "opencode" ? "--prompt" : "--");
    assert.ok(request.argv.at(-1).includes(JSON.stringify(task)));
    assert.ok(!request.argv.at(-1).includes("Repair the specified fixture"));
    assert.equal(result.body.pid, 900);
    assert.equal(result.body.core_id, "core-one");
    assert.equal(result.body.workspace_trust.trusted, provider !== "opencode");
    const file = path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json");
    if (provider === "codex") assert.equal(fs.existsSync(file), false);
    if (provider === "claude") claudeConfig = fs.readFileSync(file, "utf8");
    if (provider === "opencode") {
      assert.equal(result.body.workspace_trust.reason, "no_workspace_trust_prompt");
      assert.equal(fs.readFileSync(file, "utf8"), claudeConfig);
    }
  }
  assert.equal(state().runs, 3);
  assert.equal(state().transport_secret_present, false);
}));

test("Claude launch trusts exactly cwd in the selected profile and preserves other project fields", async () => scenario(async ({ root, task, run }) => {
  const home = path.join(root, "selected profile");
  fs.mkdirSync(home);
  const file = path.join(home, ".claude.json");
  const key = process.platform === "win32" ? root.replace(/\\/g, "/") : root;
  const before = { unknown: { keep: true }, projects: { [key]: { hasTrustDialogAccepted: false, allowedTools: ["keep"] }, sibling: { hasTrustDialogAccepted: false } } };
  fs.writeFileSync(file, JSON.stringify(before));
  const args = ["launch", "--provider", "claude", "--task", task, "--cwd", root, "--provider-home", home];
  const result = await run(args);
  assert.equal(result.code, 0);
  assert.deepEqual(result.body.workspace_trust, { trusted: true, changed: true, reason: "launch_authorized" });
  const expected = structuredClone(before);
  expected.projects[key].hasTrustDialogAccepted = true;
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), expected);
  assert.equal(fs.existsSync(path.join(root, ".git")), false, "trust does not depend on Git or a trusted main checkout");
  assert.equal(fs.existsSync(path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json")), false, "explicit profile wins over the environment");
  const unchanged = fs.readFileSync(file, "utf8");
  const second = await run([...args, "--attempt", "second"]);
  assert.deepEqual(second.body.workspace_trust, { trusted: true, changed: false, reason: "already_trusted" });
  assert.equal(fs.readFileSync(file, "utf8"), unchanged);
}));

test("Claude waits for a cooperating writer and merges its latest config", async () => scenario(async ({ root, task, run }) => {
  const home = process.env.CLAUDE_CONFIG_DIR;
  fs.mkdirSync(home);
  const file = path.join(home, ".claude.json");
  fs.writeFileSync(file, JSON.stringify({ projects: {} }));
  fs.mkdirSync(`${file}.lock`);
  const result = run(["launch", "--provider", "claude", "--task", task, "--cwd", root]);
  const writer = new Promise(resolve => setTimeout(() => {
    fs.writeFileSync(file, JSON.stringify({ projects: { unrelated: { keep: true } }, concurrent: "preserved" }));
    fs.rmdirSync(`${file}.lock`);
    resolve();
  }, 400));
  await writer;
  assert.equal((await result).code, 0);
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(after.concurrent, "preserved");
  assert.deepEqual(after.projects.unrelated, { keep: true });
  assert.equal(fs.existsSync(`${file}.lock`), false);
}));

test("an unreadable Claude config is preserved and cannot start a worker", async () => scenario(async ({ root, task, run, state }) => {
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR);
  const file = path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json");
  for (const body of ["{broken", "true", '{"projects":[]}', '{"projects":"invalid"}']) {
    fs.writeFileSync(file, body);
    const result = await run(["launch", "--provider", "claude", "--task", task, "--cwd", root]);
    assert.equal(result.code, 1);
    assert.equal(fs.readFileSync(file, "utf8"), body);
    assert.equal(state().runs, 0);
    assert.equal(fs.existsSync(`${file}.lock`), false);
  }
}));

test("Claude re-reads and retries one failed verification, then refuses persistent interference", async () => scenario(async ({ root, task, run, state }) => {
  const hook = count => `(function(){const fs=require("node:fs");const rename=fs.renameSync;let writes=0;fs.renameSync=(from,to)=>{rename(from,to);if(to.endsWith(".claude.json")&&++writes<=${count}){const config=JSON.parse(fs.readFileSync(to,"utf8"));for(const item of Object.values(config.projects))item.hasTrustDialogAccepted=false;config.concurrent="preserved";fs.writeFileSync(to,JSON.stringify(config));}};})();`;
  const args = ["launch", "--provider", "claude", "--task", task, "--cwd", root];
  const result = await run(args, hook(1));
  assert.equal(result.code, 0);
  const file = path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json");
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(after.concurrent, "preserved");
  assert.ok(Object.values(after.projects).some(project => project.hasTrustDialogAccepted === true));
  for (const project of Object.values(after.projects)) project.hasTrustDialogAccepted = false;
  fs.writeFileSync(file, JSON.stringify(after));
  const denied = await run([...args, "--attempt", "contended"], hook(2));
  assert.equal(denied.body.error, "workspace_trust_unverified");
  assert.equal(state().runs, 1, "an unverified trust edit cannot start a worker");
  assert.equal(fs.existsSync(`${file}.lock`), false);
  assert.equal(fs.readdirSync(path.dirname(file)).some(name => name.endsWith(".tmp")), false);
}));

test("Codex uses its versioned native writer for only project trust and refuses a concurrent conflict", async () => scenario(async ({ root, task, run, state }) => {
  const home = process.env.CODEX_HOME;
  fs.mkdirSync(home);
  const file = path.join(home, "peer.json");
  const cwd = path.join(root, "Äpp");
  fs.mkdirSync(cwd);
  const canonical = fs.realpathSync.native(cwd);
  const key = process.platform === "win32" ? canonical.replace(/[A-Z]/g, letter => letter.toLowerCase()) : canonical;
  const before = { config: { model: "keep", projects: { [key]: { trust_level: "untrusted", keep: true }, sibling: { trust_level: "untrusted" } } }, version: "first" };
  fs.writeFileSync(file, JSON.stringify(before));
  const args = ["launch", "--provider", "codex", "--task", task, "--cwd", cwd];
  const result = await run(args);
  assert.equal(result.code, 0);
  assert.equal(result.body.workspace_trust.trusted, true);
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  const expected = structuredClone(before.config);
  expected.projects[key].trust_level = "trusted";
  assert.deepEqual(after.config, expected);
  assert.equal(after.credential_present, false);
  assert.deepEqual(after.calls.find(call => call.method === "config/value/write").params, {
    keyPath: `projects.${JSON.stringify(key)}.trust_level`, value: "trusted", mergeStrategy: "replace", expectedVersion: "first",
  });
  const reused = await run([...args, "--attempt", "already"]);
  assert.equal(reused.body.workspace_trust.reason, "already_trusted");
  fs.writeFileSync(file, JSON.stringify({ ...before, concurrent_update: true }));
  assert.equal((await run([...args, "--attempt", "conflict"])).body.error, "workspace_trust_failed");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).config.concurrent, "preserved");
  assert.equal(state().runs, 2);
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

test("dispatched bootstrap binds exact work once, preserves placement, profile and worker preview", async () => scenario(async ({ root, run, state, save }) => {
  const input = path.join(root, "worker.json");
  fs.writeFileSync(input, JSON.stringify({ worker_bootstrap: {
    type: "assignment", launch_prompt: "Implement the scoped assignment.", future_field: true,
    coordinates: { primary_execution: { kind: "work_package", work_package_id: "wp-one" }, product_parent: { kind: "work_request", work_request_id: "wr-one" } },
  } }));
  const args = ["launch", "--provider", "claude", "--model", "opus", "--assignment", input, "--ledger", "isolated-ledger", "--cwd", root, "--space", "s1", "--tab", "job", "--parent", "t2", "--provider-home", root];
  const first = await run(args);
  const preview = "http://127.0.0.1:5173/";
  save({ ...state(), terminal: { ...state().terminal, labels: { ...state().terminal.labels, "sympp.preview_url": preview } } });
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
  assert.equal(state().terminal.labels["sympp.preview_url"], preview, "launch reuse preserves the worker's published preview");
  assert.equal((await run(["check", "--receipt", first.body.receipt])).body.state, "live");
  assert.ok(state().calls.every((call) => call.method.startsWith("terminal.") || call.method === "hello"));
  assert.equal((await run(args.map((arg) => arg === "opus" ? "sonnet" : arg))).body.error, "launch_conflict");
}));

test("assignment titles and leading ownership prompts name the worker without changing its binding", async () => scenario(async ({ root, run, state }) => {
  const input = path.join(root, "worker.json");
  const bootstrap = {
    type: "assignment", launch_prompt: "You own WorkPackage wp-one: Prompt title (parent WorkRequest wr-one).\nDo the work.",
    coordinates: { primary_execution: { kind: "work_package", work_package_id: "wp-one" }, product_parent: { kind: "work_request", work_request_id: "wr-one" } },
  };
  const cases = [
    [{ dispatch: { worker_bootstrap: { ...bootstrap, assignment: { title: "  Review drill-down  " } } } }, "review-drill-down-claude"],
    [{ worker_bootstrap: { ...bootstrap, assignment: { work_package: { title: "Native dispatch title" } } } }, "native-dispatch-title-claude"],
    [{ worker_bootstrap: { ...bootstrap, work_package: { title: "Package title" } } }, "package-title-claude"],
    [{ work_package: { title: "Outer package" }, dispatch: { worker_bootstrap: bootstrap } }, "outer-package-claude"],
    [bootstrap, "prompt-title-claude"],
  ];
  for (const [index, [body, expected]] of cases.entries()) {
    fs.writeFileSync(input, JSON.stringify(body));
    const result = await run(["launch", "--provider", "claude", "--assignment", input, "--ledger", "isolated", "--cwd", root, "--attempt", String(index)]);
    assert.equal(result.code, 0);
    assert.equal(state().terminal.name, expected);
    assert.equal(state().terminal.labels["sympp.work_package_id"], "wp-one");
  }
}));

test("name override is cosmetic and keeps legacy launch and request hashes and the same receipt", async () => scenario(async ({ root, task, run, state }) => {
  const args = ["launch", "--provider", "opencode", "--task", task, "--cwd", root];
  const first = await run([...args, "--name", "  Réview drill-down!  "]);
  assert.equal(first.code, 0);
  assert.equal(state().terminal.name, "review-drill-down-opencode");
  const hash = value => createHash("sha256").update(value).digest("hex");
  assert.equal(first.body.launch_id, hash(JSON.stringify(["core-one", null, task, "first"])));
  const program = state().calls.find(call => call.method === "terminal.run").params.argv[0];
  const before = fs.readFileSync(first.body.receipt, "utf8");
  assert.equal(JSON.parse(before).request_hash, hash(JSON.stringify([hash(fs.readFileSync(task, "utf8")), root, "opencode", program, null, null, null, null, null])));
  const second = await run([...args, "--name", "Different display"]);
  assert.equal(second.body.reused, true);
  assert.equal(second.body.launch_id, first.body.launch_id);
  assert.equal(second.body.receipt, first.body.receipt);
  assert.equal(fs.readFileSync(first.body.receipt, "utf8"), before);
  assert.equal(state().runs, 1);
}));

test("task first line and safe fallback names omit paths, credentials and unusable text", async () => scenario(async ({ root, task, run, state, save }) => {
  const cases = [
    ["First line\r\nDo not copy the rest", "first-line-opencode"],
    ["\nOnly the first line counts", "task-opencode"],
    ["Read C:\\private\\task.txt", "task-opencode"],
    ["Read /private/task.txt", "task-opencode"],
    ["token=controlled-private-value", "task-opencode"],
    ["Bearer controlled-private-value", "task-opencode"],
    ["sk-controlled-private-value", "task-opencode"],
    ["!!!", "task-opencode"],
    ["Averylongunbrokenwordthatneedstruncation", "averylongunbrokenwordth-opencode"],
  ];
  for (const [index, [body, expected]] of cases.entries()) {
    fs.writeFileSync(task, body);
    save({ ...state(), terminals: [] });
    const result = await run(["launch", "--provider", "opencode", "--task", task, "--cwd", root, "--attempt", String(index)]);
    assert.equal(result.code, 0);
    assert.equal(state().terminal.name, expected);
  }
  const unsafeOverride = await run(["launch", "--provider", "opencode", "--task", task, "--cwd", root, "--attempt", "override", "--name", "Read /private/input"]);
  assert.equal(unsafeOverride.code, 0);
  assert.equal(state().terminal.name, "task-opencode");
}));

test("core name collisions disambiguate only rejected launches and reuse names of finished terminals", async () => scenario(async ({ root, task, run, state, save }) => {
  fs.writeFileSync(task, "Review drill-down");
  const args = ["launch", "--provider", "opencode", "--task", task, "--cwd", root];
  const first = await run(args);
  assert.equal(first.code, 0);
  assert.equal(state().terminal.name, "review-drill-down-opencode");
  const hash = value => createHash("sha256").update(value).digest("hex");
  const nextId = hash(JSON.stringify(["core-one", null, task, "second"]));
  const occupied = `review-drill-${nextId.slice(0, 6)}-opencode`;
  save({ ...state(), terminals: [...state().terminals, { name: occupied, state: "live" }] });
  const second = await run([...args, "--attempt", "second"]);
  assert.equal(second.code, 0);
  assert.equal(state().terminal.name, `review-drill-${nextId.slice(0, 6)}-2-opencode`);
  assert.equal(state().runs, 2, "name rejection starts no program");
  assert.equal(state().calls.filter(call => call.method === "terminal.run").length, 4);
  save({ ...state(), terminals: state().terminals.map(terminal => ({ ...terminal, state: "finished" })) });
  assert.equal((await run([...args, "--attempt", "third"])).code, 0);
  assert.equal(state().terminal.name, "review-drill-down-opencode");
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
  save({ ...state(), terminal: { ...state().terminal, pid: 901, status: { state: "idle" }, labels: { ...state().terminal.labels, "sympp.preview_url": "http://127.0.0.1:5173/" } } });
  const checked = await run(["check", "--receipt", other.body.receipt]);
  assert.equal(checked.body.state, "stale");
  assert.equal(checked.body.reason, "process_changed");
  assert.equal((await run(["send", "--receipt", other.body.receipt, "--message", task])).body.error, "agent_not_ready");
  assert.equal(state().sent, undefined, "a preview label cannot authorize input to a replaced process");
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

    const chiefBinding = bridge.decodeHerdrBinding(Buffer.from(JSON.stringify({ role: "chief", domain: "Herdr" })).toString("base64url"));
    await reporter.report(chiefBinding, probe);
    const chiefLabels = state().terminal.labels;
    assert.equal(chiefLabels["sympp.session_id"], observed.client_id);
    assert.equal(chiefLabels["sympp.session_role"], "chief");
    const chief = await run(["check", "--receipt", chiefLabels["sympp.session_receipt"]]);
    assert.equal(chief.code, 0);
    assert.equal(chief.body.state, "live");
    assert.equal(chief.body.role, "chief");
    assert.equal(chief.body.work_request_id, null);
    assert.equal(chief.body.work_package_id, null);
    for (const [key, value] of Object.entries(original)) assert.equal(chiefLabels[key], value);

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
    assert.equal((await run(["list", "--cwd", root])).body.count, 1, "observing a bridge does not create another agent launch");

    await reporter.report({ role:"worker", work_package_id:"wp-manual" }, probe);
    const worker = await run(args);
    assert.equal(worker.body.state, "live");
    assert.equal(worker.body.work_request_id, null, "worker grants need not include a WorkRequest scope");
    assert.equal(worker.body.work_package_id, "wp-manual");
    await reporter.report({ role:"architect", work_request_id:"wr-manual" }, probe);

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
