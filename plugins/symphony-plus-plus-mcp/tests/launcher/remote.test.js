"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
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
    received.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    if (req.headers.authorization !== "Bearer fixture-token") return res.writeHead(401).end("Unauthorized");
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
  async function run(token, tool = "list_work_requests") {
    fs.writeFileSync(tokenFile, token);
    const child = spawn(process.execPath, [path.resolve(__dirname, "../../scripts/start-sympp-mcp-bridge.js")], {
      env: { ...process.env, HC_TERMINAL_ID: "", HERDR_ENV: "", SYMPP_REPO_ROOT: "must-not-use", SYMPP_POWERSHELL: "must-not-start",
        SYMPP_HOME: path.join(root, "runtime-must-not-exist"), SYMPP_SERVER_URL: `http://${nic}:${server.address().port}`, SYMPP_SERVER_TOKEN_FILE: tokenFile },
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    t.after(() => child.kill());
    let stdout = "", stderr = "";
    child.stdout.on("data", c => stdout += c); child.stderr.on("data", c => stderr += c);
    child.stdin.end([ { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: {} } } ].map(JSON.stringify).join("\n") + "\n");
    const [code] = await once(child, "exit");
    assert.equal(code, 0, stderr);
    assert.equal(fs.existsSync(path.join(root, "runtime-must-not-exist")), false);
    return stdout.trim().split("\n").map(JSON.parse);
  }
  const replies = await run("fixture-token");
  assert.equal(replies[1].result.extra, "preserved");
  assert.equal(received[1].headers["mcp-session-id"], "remote-session");
  assert.ok(received[1].body.params._meta, "session location accompanies the tool request");
  assert.ok(received.every(r => r.url === "/mcp"));
  const ambiguous = await run("fixture-token", "ambiguous_mutation");
  assert.equal(ambiguous[1].error.data.reason, "backend_lost_after_request_started");
  assert.equal(received.filter(r => r.body.params?.name === "ambiguous_mutation").length, 1);
  const denied = await run("wrong-token");
  assert.match(denied[0].error.data.detail, /authentication failed.*401/);
});
