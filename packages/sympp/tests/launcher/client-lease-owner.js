"use strict";

const fs = require("fs");
const net = require("net");
const path = require("path");
const readline = require("readline");
const { ensureLivenessProbe, closeLivenessProbe, createLocalLease } = require("../../scripts/start-sympp-mcp-bridge.js");

async function main() {
  const [directory, clientId, mode] = process.argv.slice(2);
  await ensureLivenessProbe();
  const leasePath = createLocalLease(path.join(directory, "runtime.json"), { backend: { managed: true } }, { runtimeKey: "fixture" }, clientId);
  const lease = JSON.parse(fs.readFileSync(leasePath, "utf8"));
  if (mode === "mismatch") lease.process_liveness_token = "0".repeat(64);
  if (mode === "reused-pid") lease.process_liveness_pipe += "-dead-instance";
  if (mode === "unknown") delete lease.client_id;
  fs.writeFileSync(leasePath, JSON.stringify(lease));
  if (mode === "stalled") {
    closeLivenessProbe();
    await new Promise((resolve) => net.createServer(() => {}).listen(lease.process_liveness_pipe, resolve));
  }
  process.stdout.write("ready\n");
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", () => process.kill(process.pid, "SIGKILL"));
  input.on("close", () => process.exit(0));
}

main().catch(() => { process.stderr.write("Lease fixture failed\n"); process.exit(1); });
