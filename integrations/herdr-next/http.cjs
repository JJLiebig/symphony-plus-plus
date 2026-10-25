#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const LIMIT = 8 * 1024 * 1024; // herdr.exec's output limit and the native file-write limit.

function emit(value, code = 0) {
  const line = JSON.stringify(value);
  if (Buffer.byteLength(line) + 1 > LIMIT) return emit({ error: "S++ returned too much data for this view." }, 1);
  process.stdout.write(line + "\n");
  process.exitCode = code;
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2].startsWith("--")) {
    emit({ error: "Expected one private request-file path." }, 2);
    return;
  }
  let request, url;
  try {
    const file = process.argv[2];
    if (fs.statSync(file).size > LIMIT) throw new Error();
    request = JSON.parse(fs.readFileSync(file, "utf8"));
    url = new URL(request.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
        !url.pathname.startsWith("/api/v1/sympp/herdr/") || !["GET", "POST"].includes(request.method) ||
        (request.body !== undefined && typeof request.body !== "string")) throw new Error();
  } catch {
    emit({ error: "The S++ request is unreadable or invalid. Reinstall the native view." }, 2);
    return;
  }
  const body = request.method === "POST" ? request.body ?? "{}" : undefined;
  const headers = { accept: "application/json" };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(body);
  }
  try {
    const result = await new Promise((resolve, reject) => {
      const outgoing = (url.protocol === "https:" ? https : http).request(url, {
        method: request.method, headers, signal: AbortSignal.timeout(20000),
      }, incoming => {
        const chunks = [];
        let size = 0;
        incoming.on("data", chunk => {
          size += chunk.length;
          if (size > LIMIT) incoming.destroy(new Error("oversize"));
          else chunks.push(chunk);
        });
        incoming.on("error", reject);
        incoming.on("end", () => {
          let payload;
          try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
          catch { payload = undefined; }
          resolve({ status: incoming.statusCode, body: payload });
        });
      });
      outgoing.on("error", reject);
      outgoing.end(body);
    });
    // Redirects are returned, never followed with an operator's request body.
    emit(result);
  } catch {
    emit({ error: "Couldn't reach S++. Check the connection and retry." }, 1);
  }
}
main().catch(() => emit({ error: "Couldn't complete the S++ request." }, 1));
