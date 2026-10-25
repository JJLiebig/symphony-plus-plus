#!/usr/bin/env node
"use strict";

// Optional execution adapter. Ledger authority stays with the assigning parent.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const VERSION = "1.0.0";
const PROVIDERS = ["codex", "claude", "opencode"];
const PROFILE_ENV = { codex: "CODEX_HOME", claude: "CLAUDE_CONFIG_DIR", opencode: "OPENCODE_CONFIG_DIR" };
const FORWARD_ENV = ["PATH", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "SYMPP_HOME", "SYMPP_DATABASE", "SYMPP_PORT", "SYMPP_RUNTIME_CHANNEL"];
const FLAGS = {
  list: ["cwd", "fields", "json", "help"],
  launch: ["provider", "assignment", "ledger", "task", "cwd", "model", "provider-home", "space", "tab", "parent", "attempt", "session", "json", "help"],
  check: ["receipt", "session", "json", "help"],
  send: ["receipt", "message", "session", "json", "help"],
};
const HELP = {
  list: "list [--cwd <folder>] [--fields <comma-separated receipt fields>] [--json]\nLists last-known launches for this folder; check a receipt for current state.",
  launch: "launch --provider codex|claude|opencode --cwd <folder> (--assignment <bootstrap.json> --ledger <identity> | --task <task.txt>)\n  [--model <model>] [--provider-home <folder>] [--space <id>] [--tab <id>] [--parent <terminal>]\n  [--attempt <name>] [--session <core-session>] [--json]\nDefaults: provider's configured model/home; current core; attempt=first. No dispatch or claim.\nExamples:\n  launch --provider claude --model opus --assignment worker.json --ledger local-main --cwd .\n  launch --provider opencode --task fix.txt --cwd .\n  launch --provider codex --task fix.txt --cwd . --attempt retry-after-inspection",
  check: "check --receipt <receipt.json> [--session <core-session>] [--json]\nVerifies the core, terminal, process and launch labels. Does not focus or send.\nExamples:\n  check --receipt ./launch.json\n  check --receipt ./launch.json --json",
  send: "send --receipt <receipt.json> --message <text-file> [--session <core-session>] [--json]\nSends to the verified idle/working agent; refuses unknown status, blocked agents and recovered shells.\nExamples:\n  send --receipt ./launch.json --message followup.txt\n  send --receipt ./launch.json --message handoff.txt --json",
};

class Failure extends Error {
  constructor(code, help, exitCode = 1) { super(code); this.code = code; this.help = help; this.exitCode = exitCode; }
}
const fail = (code, help, exitCode) => { throw new Failure(code, help, exitCode); };
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const text = (value) => typeof value === "string" && value.trim() !== "";

function parse(argv) {
  const command = argv[0] && !argv[0].startsWith("-") ? argv.shift() : "list";
  if (!FLAGS[command]) fail("unknown_command", `Commands: ${Object.keys(FLAGS).join(", ")}. Use launch --help.`, 2);
  const options = {};
  while (argv.length) {
    const flag = argv.shift();
    const key = flag.startsWith("--") ? flag.slice(2) : "";
    if (!FLAGS[command].includes(key)) fail("unknown_argument", `Valid ${command} flags: ${FLAGS[command].map((s) => `--${s}`).join(", ")}.`, 2);
    if (key in options) fail("duplicate_argument", `Give --${key} once.`, 2);
    if (["json", "help"].includes(key)) options[key] = true;
    else {
      const value = argv.shift();
      if (!text(value) || value.startsWith("--")) fail("missing_argument", `--${key} needs a value. ${HELP[command]}`, 2);
      options[key] = value;
    }
  }
  if (options.help) return { command, options };
  if (command === "launch") {
    if (!PROVIDERS.includes(options.provider) || !options.cwd || Boolean(options.assignment) === Boolean(options.task)) fail("invalid_launch", HELP.launch, 2);
    if (options.assignment && !options.ledger) fail("ledger_required", "Pass --ledger with the assigning session's verified ledger identity.", 2);
    if (options.task && options.ledger) fail("untracked_ledger", "Use --assignment for tracked work, or omit --ledger for an ordinary task.", 2);
    if (options.tab && !options.space) fail("space_required", "--tab also needs --space; use machine-local IDs.", 2);
  }
  if (["check", "send"].includes(command) && !options.receipt) fail("receipt_required", HELP[command], 2);
  if (command === "send" && !options.message) fail("message_required", HELP.send, 2);
  return { command, options };
}

function read(file, json = false) {
  try {
    const body = fs.readFileSync(file, "utf8");
    return json ? JSON.parse(body) : body;
  } catch (_) { fail("input_unreadable", "Use an existing UTF-8 file; assignment and receipt files must contain JSON.", 2); }
}

function assignment(file) {
  const input = read(file, true);
  const bootstrap = input?.worker_bootstrap || input?.dispatch?.worker_bootstrap || input;
  const wp = bootstrap?.coordinates?.primary_execution;
  const wr = bootstrap?.coordinates?.product_parent;
  if (bootstrap?.type !== "assignment" || wp?.kind !== "work_package" || wr?.kind !== "work_request" ||
      !text(wp.work_package_id) || !text(wr.work_request_id) || !text(bootstrap.launch_prompt)) {
    fail("invalid_assignment", "Save the redacted worker_bootstrap from the existing dispatch response; do not dispatch again.", 2);
  }
  return { work_package_id: wp.work_package_id, work_request_id: wr.work_request_id, role: "worker", digest: hash(JSON.stringify(bootstrap)) };
}

function providerArgv(provider, model, prompt) {
  const argv = [provider];
  if (provider === "codex") argv.push("--no-daemon");
  if (model) argv.push("--model", model);
  if (provider === "opencode") argv.push("--prompt", prompt);
  else argv.push("--", prompt);
  return argv;
}

function storeRoot() {
  return path.join(process.env.SYMPP_HOME || path.join(os.homedir(), ".agents", "splusplus"), "herdr-launches");
}

function receiptPath(id) { return path.resolve(storeRoot(), `${id}.json`); }
function save(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function loadReceipt(file) {
  const receipt = read(file, true);
  if (receipt?.schema_version !== 1 || !text(receipt.launch_id) || !text(receipt.core_id) || !text(receipt.cwd) ||
      !PROVIDERS.includes(receipt.provider) || (receipt.pid !== null && !Number.isSafeInteger(receipt.pid))) {
    fail("invalid_receipt", "Use the receipt returned by launch.", 2);
  }
  return { ...receipt, receipt: path.resolve(file) };
}

// hc connect supplies the same JSON-RPC transport on Windows, macOS and Linux.
function connectCore(session, command = "hc", prefix = []) {
  const env = { ...process.env };
  if (session) { delete env.HC_SOCKET; delete env.HC_TERMINAL_SOCKET; }
  if (!session && !env.HC_SOCKET && env.HC_TERMINAL_SOCKET) env.HC_SOCKET = env.HC_TERMINAL_SOCKET;
  const child = spawn(command, [...prefix, "connect", ...(session ? ["--session", session] : [])], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const pending = new Map();
  let next = 0;
  let dead = false;
  function lost() {
    dead = true;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Failure("core_unreachable", "Check the selected core/session, then use check --receipt <path> before retrying a launch.")); }
    pending.clear();
  }
  child.on("error", lost);
  child.on("exit", lost);
  child.stdin.on("error", lost);
  child.stderr.resume(); // Dependency output may contain paths or user data; never relay it.
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let response;
    try { response = JSON.parse(line); } catch (_) { lost(); return; }
    const item = pending.get(response.id);
    if (!item) return;
    pending.delete(response.id);
    clearTimeout(item.timer);
    if (response.error) item.reject(new Failure(/^[a-z_]+$/.test(response.error.data?.kind) ? response.error.data.kind : "core_error", "Inspect the receipt and selected core; no launch is retried automatically."));
    else item.resolve(response.result);
  });
  return {
    call(method, params = {}) {
      if (dead) return Promise.reject(new Failure("core_unreachable", "Check that hc is installed and the selected core is reachable."));
      const id = ++next;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Failure("core_timeout", "The operation may have arrived. Check its receipt before another launch or send.")); }, 15000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    close() { lines.close(); child.stdin.end(); child.kill(); lost(); },
  };
}

async function inspect(core, info, receipt) {
  if (info.id !== receipt.core_id) return { ...receipt, state: "stale", status: "unknown", reason: "different_core" };
  if (!receipt.terminal_id || !receipt.pid) return { ...receipt, state: "stale", status: "unknown", reason: "launch_uncertain" };
  let terminal;
  try { terminal = await core.call("terminal.get", { terminal: receipt.terminal_id }); }
  catch (error) { if (error.code !== "not_found") throw error; return { ...receipt, state: "stale", status: "unknown", reason: "terminal_gone" }; }
  if (terminal.pid !== receipt.pid || terminal.labels?.["sympp.launch_id"] !== receipt.launch_id) return { ...receipt, state: "stale", status: "unknown", reason: "process_changed" };
  return { ...receipt, state: terminal.state, status: terminal.status?.state || "unknown", reason: terminal.reason || null };
}

async function launch(core, info, options) {
  const cwd = path.resolve(options.cwd);
  const input = path.resolve(options.assignment || options.task);
  const source = options.assignment ? assignment(input) : { role: null, work_request_id: null, work_package_id: null, digest: hash(read(input)) };
  const ledger = options.assignment ? hash(options.ledger) : null;
  const launchId = hash(JSON.stringify([info.id, ledger, source.work_package_id || input, options.attempt || "first"]));
  const file = receiptPath(launchId);
  const requestHash = hash(JSON.stringify([source.digest, cwd, options.provider, options.model || null, options["provider-home"] || null, options.parent || null, options.space || null, options.tab || null]));
  fs.mkdirSync(storeRoot(), { recursive: true });
  const lock = `${file}.lock`;
  let handle;
  try { handle = fs.openSync(lock, "wx", 0o600); }
  catch (error) { if (error.code === "EEXIST") fail("launch_in_progress", "Another launch owns this receipt. Check it before retrying; a crashed owner needs manual inspection."); throw error; }
  try {
    if (fs.existsSync(file)) {
      const previous = loadReceipt(file);
      if (previous.request_hash !== requestHash) fail("launch_conflict", "The existing attempt has different input. Inspect it, then choose a new --attempt only when another process is intended.");
      const current = await inspect(core, info, previous);
      if (current.state === "stale") fail(current.reason, `Inspect receipt ${JSON.stringify(file)}. Use a new --attempt only after resolving the previous launch.`);
      return { ...current, reused: true };
    }
    const receipt = {
      schema_version: 1, launch_id: launchId, core_id: info.id, terminal_id: null, pid: null,
      provider: options.provider, model: options.model || null, role: source.role,
      work_request_id: source.work_request_id, work_package_id: source.work_package_id, ledger_id: ledger,
      cwd, created_at: new Date().toISOString(), receipt: file, request_hash: requestHash,
      state: "stale", status: "unknown", reason: "launch_uncertain",
    };
    const labels = { "sympp.launch_id": launchId, "sympp.provider": options.provider, "sympp.core_id": info.id, "sympp.receipt": file };
    for (const key of ["role", "work_request_id", "work_package_id", "ledger_id"]) if (receipt[key]) labels[`sympp.${key}`] = receipt[key];
    if (options.space) labels["herdr.space"] = options.space;
    if (options.tab) labels["herdr.tab"] = options.tab;
    const parent = options.parent || (!options.session && process.env.HC_TERMINAL_SOCKET ? process.env.HC_TERMINAL_ID : null);
    const prompt = options.assignment
      ? `Read the redacted Symphony++ assignment JSON at ${JSON.stringify(input)}. Follow worker_bootstrap.launch_prompt (possibly under dispatch), or launch_prompt when the file is the bootstrap itself. The parent owns dispatch and ledger reconciliation; do not dispatch or claim again.`
      : `Read your task from ${JSON.stringify(input)} and carry it out. This is ordinary work; no Symphony++ tracking is required.`;
    const returnTo = parent ? ` Report results or questions to your parent with hc send ${JSON.stringify(parent)}; include the evidence and paths they need.` : "";
    const env = Object.fromEntries(FORWARD_ENV.filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
    if (options["provider-home"]) env[PROFILE_ENV[options.provider]] = path.resolve(options["provider-home"]);
    save(file, receipt); // A lost spawn reply must not silently launch a second worker.
    const result = await core.call("terminal.run", {
      argv: providerArgv(options.provider, options.model, prompt + returnTo), cwd, env, labels,
      name: `sympp-${launchId.slice(0, 24)}`, parent: parent || undefined,
      no_parent: !parent, no_notify: false, wait: false, keep: Boolean(options.space),
    });
    const terminal = result;
    if (!text(terminal?.address) || !Number.isSafeInteger(terminal.pid) || terminal.pid <= 0) fail("launch_unconfirmed", `Check receipt ${JSON.stringify(file)} and the selected core; no second process was requested.`);
    Object.assign(receipt, { terminal_id: terminal.address, pid: terminal.pid, state: terminal.state, status: terminal.status?.state || "unknown", reason: terminal.reason || null });
    save(file, receipt);
    await core.call("terminal.label", { terminal: terminal.address, labels: { "sympp.pid": String(terminal.pid) } });
    return { ...receipt, reused: false };
  } finally { fs.closeSync(handle); fs.unlinkSync(lock); }
}

function list(options) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const fields = options.fields?.split(",") || ["provider", "terminal_id", "state", "receipt"];
  const names = fs.existsSync(storeRoot()) ? fs.readdirSync(storeRoot()).filter((name) => name.endsWith(".json")) : [];
  const rows = names.map((name) => loadReceipt(path.join(storeRoot(), name))).filter((item) => item.cwd === cwd);
  const allowed = ["launch_id", "core_id", "terminal_id", "pid", "provider", "model", "role", "work_request_id", "work_package_id", "ledger_id", "created_at", "receipt", "state", "status", "reason", "cwd"];
  if (fields.some((field) => !allowed.includes(field))) fail("unknown_field", `Fields: ${allowed.join(", ")}.`, 2);
  return { bin: __filename.replace(os.homedir(), "~"), description: "Launch and inspect optional Herdr agents without changing ledger authority.", count: rows.length, observation: "last_known", launches: rows.map((row) => Object.fromEntries(fields.map((key) => [key, row[key] ?? null]))), help: rows.length ? "check --receipt <receipt.json> for current state" : "launch --help to start an ordinary task or an assigned worker" };
}

function toon(value, depth = 0) {
  const indent = "  ".repeat(depth);
  const scalar = (item) => JSON.stringify(item);
  return Object.entries(value).map(([key, item]) => {
    if (Array.isArray(item)) {
      const fields = Object.keys(item[0] || {});
      return `${indent}${key}[${item.length}]${fields.length ? `{${fields.join(",")}}` : ""}:` + item.map((row) => `\n${indent}  ${fields.map((field) => scalar(row[field])).join(",")}`).join("");
    }
    return `${indent}${key}: ${scalar(item)}`;
  }).join("\n");
}

async function main(argv = process.argv.slice(2), connect = connectCore) {
  if (argv.length === 1 && ["--version", "-v", "-V"].includes(argv[0])) { process.stdout.write(VERSION + "\n"); return; }
  let core;
  let json = argv.includes("--json");
  try {
    const { command, options } = parse([...argv]);
    if (options.help) { process.stdout.write(HELP[command] + "\n"); return; }
    let result;
    if (command === "list") result = list(options);
    else {
      // Validate files before opening the runtime connection.
      const receipt = command !== "launch" ? loadReceipt(options.receipt) : null;
      const message = command === "send" ? read(options.message) : null;
      if (command === "launch") {
        options.assignment ? assignment(options.assignment) : read(options.task);
        try { if (!fs.statSync(path.resolve(options.cwd)).isDirectory()) throw new Error(); }
        catch (_) { fail("folder_unavailable", "--cwd must be an existing directory on the execution machine.", 2); }
      }
      core = connect(options.session);
      const hello = await core.call("hello", { generation: 1 });
      if (!text(hello?.core?.id)) fail("core_identity_missing", "Use a compatible Herdr-core installation.");
      if (command === "launch") result = await launch(core, hello.core, options);
      else {
        result = await inspect(core, hello.core, receipt);
        if (command === "send") {
          if (result.state !== "live" || !["idle", "working"].includes(result.status)) fail("agent_not_ready", "Check the receipt and focus the agent for manual input; automatic sends require a verified idle or working report.");
          // The core checks status at input time too, so recovery to a shell cannot consume the message.
          const sent = await core.call("terminal.send", { terminal: result.terminal_id, text: message, if: result.status, force: false });
          result = { ...result, sent: true, started: sent.started ?? null };
        }
      }
    }
    const { request_hash, ...publicResult } = result;
    process.stdout.write((json ? JSON.stringify(publicResult) : toon(publicResult)) + "\n");
  } catch (error) {
    const output = error instanceof Failure ? { error: error.code, help: error.help } : { error: "operation_failed", help: "Check the input files and selected execution machine. No dependency output is exposed." };
    process.stdout.write((json ? JSON.stringify(output) : toon(output)) + "\n");
    process.exitCode = error instanceof Failure ? error.exitCode : 1;
  } finally { core?.close(); }
}

if (require.main === module) main();
module.exports = { main, connectCore, providerArgv, inspect, parse, toon };
