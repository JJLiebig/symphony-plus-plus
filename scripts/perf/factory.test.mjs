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
  { status: 503, body: "service unavailable", bytes: 19 },
  { status: 200, body: "not json", bytes: 8 },
]) {
  test(`failed board response ${response.status} retains its measurement`, async () => {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), "factory-perf-failure-"));
    const server = http.createServer((request, reply) => {
      request.resume();
      request.on("end", () => {
        reply.setHeader("x-perf-queries", "7");
        if (request.url === "/mcp") {
          reply.setHeader("mcp-session-id", "fixture-session");
          reply.end('{"jsonrpc":"2.0","result":{}}');
        } else {
          reply.writeHead(response.status);
          reply.end(response.body);
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
      const failure = rows.find(row => row.operation === "board" && row.failed);
      assert.ok(failure);
      assert.equal(failure.status, response.status);
      assert.equal(failure.concurrency, 1);
      assert.equal(failure.queries, 7);
      assert.equal(failure.bytes, response.bytes);
      assert.ok(Number.isFinite(failure.ms) && failure.ms >= 0);
    } finally {
      await new Promise(resolve => server.close(resolve));
      await fs.rm(output, { recursive: true, force: true });
    }
  });
}
