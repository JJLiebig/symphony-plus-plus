import fs from "node:fs";
import { performance } from "node:perf_hooks";

const base = `http://127.0.0.1:${process.env.PERF_PORT}`;
const raw = [];
let id = 0;
let dispatch = 0;
function client(concurrency) {
  let session;
  return async (method, params) => {
    const start = performance.now();
    const response = await fetch(`${base}/mcp`, { method: "POST", headers: {
      "content-type": "application/json", ...(session ? { "mcp-session-id": session } : {}),
    }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    session = response.headers.get("mcp-session-id") || session;
    const text = await response.text();
    if (!response.ok || !text) {
      raw.push({ operation: params?.name ?? method, concurrency, failed: true, status: response.status,
        ms: performance.now() - start, bytes: Buffer.byteLength(text), queries: Number(response.headers.get("x-perf-queries")) });
      throw Error(`Failed ${method} ${params?.name ?? ""}: HTTP ${response.status}`);
    }
    const result = JSON.parse(text);
    if (!response.ok || result.error || result.result?.isError) throw Error(`Failed ${method} ${params?.name ?? ""}`);
    return { ms: performance.now() - start, bytes: Buffer.byteLength(text), queries: Number(response.headers.get("x-perf-queries")) };
  };
}
try {
  for (const concurrency of [1, 10]) {
    const clients = await Promise.all(Array.from({ length: concurrency }, async () => {
      const call = client(concurrency);
      await call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "factory-perf", version: "1" } });
      await call("tools/call", { name: "claim_local_architect_assignment", arguments: { work_request_id: "WR-FIXTURE-FANOUT", claimed_by: "factory-perf" } });
      return call;
    }));
    for (const operation of ["list_work_requests", "read_plan", "read_work_request", "board", "dispatch_work_package"]) {
      for (let round = 0; round < (concurrency === 1 ? 30 : 3); round++) {
        const results = await Promise.allSettled(clients.map(async (call) => {
          let metric;
          if (operation === "board") {
            const start = performance.now();
            const response = await fetch(`${base}/api/v1/sympp/herdr/dashboard`);
            const text = await response.text();
            if (!response.ok || !Array.isArray(JSON.parse(text).work_request_details)) throw Error("Invalid board");
            metric = { ms: performance.now() - start, bytes: Buffer.byteLength(text), queries: Number(response.headers.get("x-perf-queries")) };
          } else {
            const args = operation === "list_work_requests" ? {} : { work_request_id: "WR-FIXTURE-FANOUT" };
            if (operation === "dispatch_work_package") args.work_package_id = `WP-PERF-${++dispatch}`;
            metric = await call("tools/call", { name: operation, arguments: args });
          }
          raw.push({ operation, concurrency, ...metric });
        }));
        const failure = results.find(result => result.status === "rejected");
        if (failure) throw failure.reason;
      }
    }
  }
} finally {
  fs.mkdirSync(process.env.PERF_OUTPUT, { recursive: true });
  fs.writeFileSync(`${process.env.PERF_OUTPUT}/raw.json`, JSON.stringify(raw, null, 2));
}
const summary = [];
for (const concurrency of [1, 10]) for (const operation of [...new Set(raw.map(x => x.operation))]) {
  const rows = raw.filter(x => x.concurrency === concurrency && x.operation === operation);
  const sorted = rows.map(x => x.ms).sort((a, b) => a - b);
  summary.push({ operation, concurrency, samples: rows.length, p50: sorted[Math.ceil(sorted.length * .5) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1], queries: Math.max(...rows.map(x => x.queries)), bytes: Math.max(...rows.map(x => x.bytes)) });
}
fs.writeFileSync(`${process.env.PERF_OUTPUT}/summary.json`, JSON.stringify(summary, null, 2));
// Budgets are introduced only after repeated Linux measurements; raw receipts always survive failures.
if (process.env.PERF_BUDGETS) {
  const budgets = JSON.parse(fs.readFileSync(process.env.PERF_BUDGETS));
  for (const row of summary) {
    const limit = budgets.find(x => x.operation === row.operation && x.concurrency === row.concurrency);
    if (!limit) throw Error(`Missing budget for ${row.operation}/${row.concurrency}`);
    for (const field of ["p95", "queries", "bytes"]) if (row[field] > limit[field]) throw Error(`${row.operation}/${row.concurrency} exceeds ${field} budget: ${row[field]} > ${limit[field]}`);
  }
}
