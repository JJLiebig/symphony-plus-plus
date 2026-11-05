"use strict";

// Controlled protocol peer, not a provider or real Herdr qualification.
const fs = require("node:fs");
const { createInterface } = require("node:readline");
const file = process.argv[2];
const state = JSON.parse(fs.readFileSync(file, "utf8"));
state.transport_secret_present = Boolean(process.env.OPENAI_API_KEY);
const write = () => fs.writeFileSync(file, JSON.stringify(state));
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  const { method, params } = request;
  state.calls.push({ method, params });
  let result;
  let error;
  switch (method) {
    case "hello": result = { generation: 1, core: { id: state.core_id, name: "controlled" } }; break;
    case "terminal.run":
      if (!params.argv[0].includes("/")) { error = { data: { kind: "template_collision" } }; break; }
      if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(params.name)) { error = { data: { kind: "invalid_params" } }; break; }
      if (state.terminals?.some(terminal => terminal.state === "live" && terminal.name === params.name)) {
        error = { data: { kind: "name_taken" } }; break;
      }
      state.runs++;
      state.terminal = { address: "t9", name: params.name, pid: 900, state: "live", labels: params.labels, status: state.report === false ? null : { state: "idle", app: params.argv[0] } };
      (state.terminals ||= []).push(state.terminal);
      result = state.terminal;
      if (state.lose_reply) { write(); process.exit(0); }
      break;
    case "terminal.label":
      if (state.lose_label_reply) { write(); process.exit(0); }
      Object.assign(state.terminal.labels, params.labels); result = state.terminal; break;
    case "terminal.get":
      if (state.terminal) result = state.terminal;
      else error = { data: { kind: "not_found" }, message: "dependency output must stay private" };
      break;
    case "terminal.send":
      if (state.recover_before_send) { state.terminal.pid++; state.terminal.status = null; }
      if (params.if !== state.terminal.status?.state) error = { data: { kind: "status_mismatch" } };
      else { state.sent = params.text; result = { started: true, turn: 1 }; }
      break;
    default: error = { data: { kind: "unknown_method" } };
  }
  write();
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...(error ? { error } : { result }) }) + "\n");
});
