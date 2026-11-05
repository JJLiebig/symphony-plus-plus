"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn, execFileSync } = require("node:child_process");
const { once } = require("node:events");
const { serverConnection, privateWrite } = require("../../scripts/sympp-remote.js");

test("SSH alias resolves once and token storage stays private on replacement", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sympp-remote-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const result = serverConnection("factory", (cmd, args) => {
    calls.push(args);
    return { status: 0, stdout: args[0] === "-G" ? "host factory\nhostname 100.123.207.19\n" : "fixture-token\n" };
  });
  assert.equal(result.endpoint, "http://100.123.207.19:19998");
  assert.equal(calls.length, 2);
  const file = path.join(root, "token");
  privateWrite(file, result.token);
  privateWrite(file, "updated");
  assert.equal(fs.readFileSync(file, "utf8"), "updated");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(serverConnection("http://127.0.0.1:19998"), { endpoint: "http://127.0.0.1:19998", token: "" });
  assert.throws(() => serverConnection("-oProxyCommand=bad"));
  assert.throws(() => serverConnection("http://other:19998"));
});

test("remote bridge forwards MCP with authentication, sessions and metadata without a local runtime", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sympp-remote-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const received = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
    if (req.headers.authorization !== "Bearer fixture-token") return res.writeHead(401).end("Unauthorized");
    if (req.method === "GET" && req.url === "/mcp/readiness") return res.end(JSON.stringify({
      status: "ok", factory_owned_worktrees: true, ledger: { reachable: true, identity: { default_home: true } }
    }));
    if (JSON.parse(body).params?.name === "ambiguous_mutation") { req.socket.destroy(); return; }
    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "remote-session" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(body).id, result: { protocolVersion: "2025-03-26", extra: "preserved" } }));
  });
  server.listen(0, "0.0.0.0");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const nic = Object.values(os.networkInterfaces()).flat().find(x => x.family === "IPv4" && !x.internal)?.address;
  assert.ok(nic, "a non-loopback interface exercises remote URL admission");
  const tokenFile = path.join(root, "token");
  fs.writeFileSync(tokenFile, "fixture-token");
  async function run(token, tool = "list_work_requests", expectedSuccess = true, args = {}) {
    fs.writeFileSync(tokenFile, token);
    const child = spawn(process.execPath, [path.resolve(__dirname, "../../scripts/start-sympp-mcp-bridge.js")], {
      env: { ...process.env, HC_TERMINAL_ID: "", HERDR_ENV: "", SYMPP_REPO_ROOT: "must-not-use", SYMPP_POWERSHELL: "must-not-start",
        SYMPP_HOME: path.join(root, "runtime-must-not-exist"), SYMPP_SERVER_URL: `http://${nic}:${server.address().port}`, SYMPP_SERVER_TOKEN_FILE: tokenFile },
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true, cwd: root,
    });
    t.after(() => child.kill());
    let stdout = "", stderr = "";
    child.stdout.on("data", c => stdout += c); child.stderr.on("data", c => stderr += c);
    child.stdin.end([ { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } } ].map(JSON.stringify).join("\n") + "\n");
    const [code] = await once(child, "exit");
    if (expectedSuccess) assert.equal(code, 0, stderr);
    else assert.notEqual(code, 0, stderr);
    assert.equal(fs.existsSync(path.join(root, "runtime-must-not-exist")), false);
    return { replies: stdout.trim() ? stdout.trim().split("\n").map(JSON.parse) : [], stderr };
  }
  const { replies } = await run("fixture-token");
  assert.equal(replies[1].result.extra, "preserved");
  const tool = received.find(r => r.body?.method === "tools/call");
  assert.equal(tool.headers["mcp-session-id"], "remote-session");
  assert.ok(tool.body.params._meta, "session location accompanies the tool request");
  assert.deepEqual(received.map(r => r.url), ["/mcp/readiness", "/mcp", "/mcp"]);
  assert.equal(received[0].headers.authorization, "Bearer fixture-token");
  const ambiguous = await run("fixture-token", "ambiguous_mutation");
  assert.equal(ambiguous.replies[1].error.data.reason, "backend_lost_after_request_started");
  assert.equal(received.filter(r => r.body?.params?.name === "ambiguous_mutation").length, 1);
  execFileSync("git", ["init", root]);
  execFileSync("git", ["-C", root, "remote", "add", "origin", "https://fixture-user:fixture-password@example.org/team/repo.git"]);
  const credentialOrigin = await run("fixture-token", "create_work_request");
  assert.match(credentialOrigin.replies[1].error.data.detail, /Repository origins must not include credentials/);
  assert.equal(JSON.stringify(credentialOrigin).includes("fixture-password"), false);
  assert.equal(received.some(r => r.body?.params?.name === "create_work_request"), false);
  execFileSync("git", ["-C", root, "remote", "set-url", "origin", "https://fixture-account-or-token@example.org/team/repo.git"]);
  await run("fixture-token", "create_work_request");
  assert.equal(received.find(r => r.body?.params?.name === "create_work_request").body.params.arguments.repo, "https://example.org/team/repo.git");
  await run("fixture-token", "create_work_request", true, { repo: "." });
  assert.equal(received.at(-1).body.params.arguments.repo, "https://example.org/team/repo.git");
  const checkout = path.join(root, "checkout");
  execFileSync("git", ["init", checkout]);
  execFileSync("git", ["-C", checkout, "remote", "add", "origin", "https://example.org/other/checkout.git"]);
  await run("fixture-token", "create_work_request", true, { repo: "checkout" });
  assert.equal(received.at(-1).body.params.arguments.repo, "https://example.org/other/checkout.git");
  fs.mkdirSync(path.join(root, "explicit-owner", "explicit-repo"), { recursive: true });
  await run("fixture-token", "create_work_request", true, { repo: "explicit-owner/explicit-repo" });
  assert.equal(received.at(-1).body.params.arguments.repo, "explicit-owner/explicit-repo");
  const postsBeforeDenial = received.filter(r => r.url === "/mcp").length;
  const denied = await run("wrong-token", "list_work_requests", false);
  assert.match(denied.stderr, /authentication failed.*401/);
  assert.equal(denied.replies.length, 0);
  assert.equal(received.filter(r => r.url === "/mcp").length, postsBeforeDenial);
});
