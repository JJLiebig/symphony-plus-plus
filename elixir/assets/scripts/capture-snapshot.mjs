#!/usr/bin/env node
/* global console, fetch, process, setTimeout */
// Captures a frozen, read-only copy of the operator API for frontend work.
// It only issues GET requests and never opens the event stream.
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const origin = option("origin") || process.env.SYMPP_API_ORIGIN || "http://127.0.0.1:19998";
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const outputDir = path.resolve(option("out") || path.join(os.homedir(), ".agents", "splusplus-beta", "snapshots", `cockpit-${stamp}`));
const pauseMs = Number(option("pause-ms") || 60);
const apiBase = "/api/v1/sympp/operator";
const requests = [];

await mkdir(outputDir, { recursive: true });

const dashboard = await capture("/dashboard", "dashboard.json");
const deferred = await capture("/dashboard/deferred", "dashboard.deferred.json");
await capture("/dashboard/hydrated", "dashboard.hydrated.json");
const archived = await capture("/dashboard?surface=archived", "dashboard.archived.json");
const solo = await capture("/dashboard?surface=solo", "dashboard.solo.json");

const details = deferred?.work_request_details ?? [];
const workRequestIds = unique([
  ...(dashboard?.work_requests?.work_requests ?? []).map((request) => request.id),
  ...details.map((detail) => detail.work_request?.id),
]);
const workPackageIds = unique([
  ...(deferred?.work_packages ?? []).map((pkg) => pkg.id),
  ...details.flatMap((detail) => (detail.work_packages ?? []).map((slice) => slice.work_package_id)),
]);
const soloSessionIds = unique((solo?.solo_sessions?.solo_sessions ?? []).map((session) => session.id));

for (const id of workRequestIds) await capture(`/work-requests/${encodeURIComponent(id)}`, path.join("work-requests", `${id}.json`));
for (const id of workPackageIds) await capture(`/work-packages/${encodeURIComponent(id)}`, path.join("work-packages", `${id}.json`));
for (const id of soloSessionIds) await capture(`/solo-sessions/${encodeURIComponent(id)}`, path.join("solo-sessions", `${id}.json`));

const failed = requests.filter((request) => request.status !== 200);
await writeFile(
  path.join(outputDir, "manifest.json"),
  JSON.stringify(
    {
      captured_at: new Date().toISOString(),
      generated_at: dashboard?.generated_at ?? null,
      origin,
      counts: {
        work_requests: workRequestIds.length,
        work_packages: workPackageIds.length,
        solo_sessions: soloSessionIds.length,
        archived_work_requests: archived?.archived_work_requests?.work_requests?.length ?? 0,
      },
      failed,
    },
    null,
    2,
  ),
);

console.log(JSON.stringify({ outputDir, requests: requests.length, failed: failed.length }, null, 2));
if (!dashboard) process.exitCode = 1;

async function capture(apiPath, file) {
  const response = await fetch(`${origin}${apiBase}${apiPath}`, { headers: { accept: "application/json", origin } });
  const text = await response.text();
  requests.push({ path: apiPath, status: response.status, bytes: text.length });
  await new Promise((resolve) => setTimeout(resolve, pauseMs));
  if (!response.ok) return null;

  const target = path.join(outputDir, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text);
  return JSON.parse(text);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function option(name) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}
