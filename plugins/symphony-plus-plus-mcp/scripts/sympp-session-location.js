"use strict";

const { randomUUID } = require("crypto");
const { execFile } = require("child_process");
const os = require("os");

function locationFromEnvironment(env, hostname, clientId) {
  const location = { client_id: clientId, machine_id: hostname.trim().toLowerCase(), machine_label: hostname };
  if (env.HERDR_ENV === "1" && env.HERDR_PANE_ID) {
    location.herdr = {
      workspace_id: env.HERDR_WORKSPACE_ID,
      tab_id: env.HERDR_TAB_ID,
      pane_id: env.HERDR_PANE_ID,
      session: env.HERDR_SESSION,
      socket_path: env.HERDR_SOCKET_PATH,
      native_session_id: env.CODEX_THREAD_ID,
      native_session_agent: env.CODEX_THREAD_ID ? "codex" : undefined,
    };
  }
  return location;
}

function withSnapshot(location, response) {
  const snapshot = response && response.result && response.result.snapshot;
  if (!snapshot || !location.herdr) return location;
  const panes = snapshot.panes || [];
  const pane = panes.find((item) => item.tokens && item.tokens.sympp_session_location_id === location.client_id) ||
    panes.find((item) => item.pane_id === location.herdr.pane_id);
  if (!pane) return location;
  const workspace = (snapshot.workspaces || []).find((item) => item.workspace_id === pane.workspace_id);
  const tab = (snapshot.tabs || []).find((item) => item.tab_id === pane.tab_id);
  return { ...location, herdr: { ...location.herdr,
    workspace_id: pane.workspace_id, workspace_label: workspace && workspace.label,
    tab_id: pane.tab_id, tab_label: tab && tab.label, pane_id: pane.pane_id,
    native_session_id: location.herdr.native_session_id || (pane.agent_session?.kind === "session_id" ? pane.agent_session.value : undefined),
    native_session_agent: location.herdr.native_session_agent || (pane.agent_session?.kind === "session_id" ? pane.agent_session.agent : undefined),
  } };
}

function withLocation(body, location) {
  try {
    const payload = JSON.parse(body);
    if (!payload || Array.isArray(payload) || !["initialize", "tools/call"].includes(payload.method)) return body;
    payload.params = { ...payload.params, _meta: { ...payload.params?._meta, sympp_session_location: location } };
    return JSON.stringify(payload);
  } catch (_) { return body; }
}

function createReporter(env = process.env) {
  const clientId = randomUUID();
  let location = locationFromEnvironment(env, os.hostname(), clientId);
  let refreshAt = 0;
  let pending = null;
  return {
    clientId,
    async attach(body) {
      // Labels are best effort; a missing Herdr must not hold up MCP calls.
      if (location.herdr && Date.now() >= refreshAt && !pending) {
        refreshAt = Date.now() + 60000;
        pending = new Promise((resolve) => {
          execFile(env.HERDR_BIN_PATH || (process.platform === "win32" ? "herdr.exe" : "herdr"), ["api", "snapshot"],
            { env, timeout: 1000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
              if (!error) {
                try { location = withSnapshot(location, JSON.parse(stdout)); } catch (_) { }
              }
              resolve();
            });
        }).finally(() => { pending = null; });
      }
      if (pending) await pending;
      return withLocation(body, location);
    },
  };
}

module.exports = { locationFromEnvironment, withSnapshot, withLocation, createReporter };
