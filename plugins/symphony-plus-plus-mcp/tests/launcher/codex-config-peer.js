"use strict";

// Controlled Codex config protocol; real TOML editing is qualified separately.
const fs = require("node:fs");
const path = require("node:path");
const { createInterface } = require("node:readline");
const file = path.join(process.env.CODEX_HOME, "peer.json");
fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { config: {}, version: "first" };
state.credential_present = Boolean(process.env.OPENAI_API_KEY);
state.calls ||= [];
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (!request.id) return;
  const { method, params } = request;
  state.calls.push({ method, params });
  let result;
  let error;
  if (method === "initialize") result = {};
  else if (method === "config/read") result = { layers: [{ name: { type: "user", file: path.join(process.env.CODEX_HOME, "config.toml") }, config: state.config, version: state.version }] };
  else if (method === "config/value/write") {
    if (state.concurrent_update) {
      state.config.concurrent = "preserved";
      state.version = "changed";
      error = { code: -32000, data: { errorCode: "configVersionConflict" } };
    } else {
      const key = JSON.parse(params.keyPath.slice("projects.".length, -".trust_level".length));
      state.config.projects ||= {};
      state.config.projects[key] = { ...state.config.projects[key], trust_level: params.value };
      state.version = "written";
      result = { status: "ok", version: state.version };
    }
  } else error = { code: -32601 };
  fs.writeFileSync(file, JSON.stringify(state));
  process.stdout.write(JSON.stringify({ id: request.id, ...(error ? { error } : { result }) }) + "\n");
});
