import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

for (const response of [
  { operation: "board", status: 503, body: "service unavailable", queries: 7 },
  { operation: "board", status: 200, body: "not json", queries: 7 },
  { operation: "board", status: 503, body: "no query count available", queries: null },
  { operation: "list_work_requests", status: 503, body: "service unavailable", queries: 7 },
  { operation: "list_work_requests", status: 200, body: '{"error":{"code":-32603,"message":"fixture failure"}}', queries: 7 },
  { operation: "list_work_requests", status: 200, body: '{"result":{"isError":true}}', queries: 7 },
  { operation: "list_work_requests", status: 200, body: "not json", queries: 7 },
]) {
  test(`failed ${response.operation} response ${response.status} ${response.body} retains its measurement`, async () => {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), "factory-perf-failure-"));
    const server = http.createServer((request, reply) => {
      let body = "";
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        const operation = request.url === "/mcp" ? JSON.parse(body).params?.name : "board";
        if (operation === response.operation) {
          if (response.queries !== null) reply.setHeader("x-perf-queries", String(response.queries));
          reply.writeHead(response.status);
          reply.end(response.body);
        } else {
          reply.setHeader("x-perf-queries", "7");
          reply.setHeader("mcp-session-id", "fixture-session");
          reply.end('{"jsonrpc":"2.0","result":{}}');
        }
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const child = spawn(process.execPath, [fileURLToPath(new URL("./factory.mjs", import.meta.url))], {
        env: { ...process.env, PERF_PORT: String(server.address().port), PERF_OUTPUT: output },
        stdio: "ignore",
      });
      const [code] = await once(child, "exit");
      assert.equal(code, 1);
      const rows = JSON.parse(await fs.readFile(path.join(output, "raw.json"), "utf8"));
      const failure = rows.find(row => row.operation === response.operation && row.failed);
      assert.ok(failure);
      assert.equal(failure.status, response.status);
      assert.equal(failure.concurrency, 1);
      assert.equal(failure.queries, response.queries);
      assert.equal(failure.bytes, response.body.length);
      assert.ok(Number.isFinite(failure.ms) && failure.ms >= 0);
    } finally {
      await new Promise(resolve => server.close(resolve));
      await fs.rm(output, { recursive: true, force: true });
    }
  });
}
