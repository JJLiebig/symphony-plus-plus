"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { remoteArguments, remoteWorktreeResponse } = require("../../scripts/sympp-session-location.js");

test("remote path requests become origin identities and qualified responses preserve launch data", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sympp-repo-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", root]);
  execFileSync("git", ["-C", root, "remote", "add", "origin", "https://github.com/example/service.git"]);
  const env = { SYMPP_SERVER_URL: "http://100.123.207.19:19998", SYMPP_SERVER_NAME: "jjdev" };
  const call = args => JSON.stringify({ method: "tools/call", params: { name: "create_work_request", arguments: args } });
  const input = call({ repo: root, repo_scopes: [{ repo: root }, { repo: "other/repo" }], constraints: { repo: "/deployment/path", review: { repos: ["/do-not-resolve"] } } });
  const converted = JSON.parse(await remoteArguments(input, true)).params.arguments;
  assert.equal(converted.repo, "https://github.com/example/service.git");
  assert.deepEqual(converted.repo_scopes, [{ repo: converted.repo }, { repo: "other/repo" }]);
  assert.deepEqual(converted.constraints, JSON.parse(input).params.arguments.constraints);
  assert.equal(JSON.parse(await remoteArguments(call({ repo: 0 }), true)).params.arguments.repo, 0);
  const unknown = JSON.stringify({ method: "tools/call", params: { name: "sympp.health", arguments: { repo: "/unknown-field" } } });
  assert.equal(await remoteArguments(unknown, true), unknown);

  assert.equal(await remoteArguments(input, false), input);
  const response = JSON.stringify({ result: { isError: false, structuredContent: { worktree: { status: "prepared", path: "/srv/Code/.worktrees/service/fix" }, worker_launch: { workspace_path: "/srv/Code/.worktrees/service/fix" } }, content: [] } });
  const output = JSON.parse(remoteWorktreeResponse(response, env)).result;
  assert.equal(output.content[0].text, "worktree: jjdev:/srv/Code/.worktrees/service/fix");
  assert.equal(output.structuredContent.worker_launch.workspace_path, "/srv/Code/.worktrees/service/fix");
  assert.equal(remoteWorktreeResponse(response, {}), response);
  const escaped = JSON.parse(response);
  escaped.result.structuredContent.worktree.path = '/srv/quote"repo/fix';
  assert.equal(JSON.parse(remoteWorktreeResponse(JSON.stringify(escaped), env)).result.content[0].text,
    'worktree: "jjdev:/srv/quote\\"repo/fix"');

  const local = { SYMPP_SERVER_URL: "http://127.0.0.1:19998" };
  assert.equal(JSON.parse(await remoteArguments(input, true)).params.arguments.repo, converted.repo);
  assert.equal(await remoteArguments(input, false), input);
  execFileSync("git", ["-C", root, "remote", "remove", "origin"]);
  assert.equal(await remoteArguments(input, false), input);
  const prepare = JSON.stringify({ method: "tools/call", params: { name: "prepare_work_package_worktree", arguments: { work_package_id: "wp-local", target_repo_root: root } } });
  assert.equal(await remoteArguments(prepare, false), prepare);
  assert.equal(remoteWorktreeResponse(response, local), response);
});

test("queued cleanup keeps its status and recovery action visible", () => {
  const response = JSON.stringify({ result: { structuredContent: { worktree: { status: "cleanup_queued", path: "/srv/Code/.worktrees/service/fix" }, next_action: "retry" }, content: [{ type: "text", text: "status: cleanup_queued\nnext_action: retry" }] } });
  assert.equal(remoteWorktreeResponse(response, { SYMPP_SERVER_URL: "http://100.123.207.19:19998", SYMPP_SERVER_NAME: "jjdev" }), response);
});

test("an unknown factory ownership capability stops the bridge before any MCP call", async t => {
  const http = require("node:http");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sympp-unknown-owner-"));
  let posts = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "POST") posts++;
    res.end(JSON.stringify({ status: "ok", ledger: { reachable: true }, source: { mcp_contract: { fingerprint: "a".repeat(64) } } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const env = { ...process.env, HOME: root, USERPROFILE: root, SYMPP_HOME: root,
    SYMPP_SERVER_URL: `http://127.0.0.1:${server.address().port}`, HC_TERMINAL_ID: "", HC_TERMINAL_SOCKET: "" };
  delete env.SYMPP_SERVER_TOKEN_FILE;
  const child = spawn(process.execPath, [path.resolve(__dirname, "../../scripts/start-sympp-mcp-bridge.js")], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdout.resume();
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_work_request", arguments: {} } }) + "\n");
  const exit = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  assert.notEqual(exit, 0);
  assert.match(stderr, /could not determine repository ownership/);
  assert.equal(posts, 0);
});
