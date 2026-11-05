"use strict";

const { randomUUID } = require("crypto");
const { execFile } = require("child_process");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { connectCore } = require("./sympp-herdr.js");

function locationFromEnvironment(env, hostname, clientId) {
  const location = { client_id: clientId, machine_id: hostname.trim().toLowerCase(), machine_label: hostname };
  if (!(env.HC_TERMINAL_ID && env.HC_TERMINAL_SOCKET) && env.HERDR_ENV === "1" && env.HERDR_PANE_ID) {
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
    native_session_id: location.herdr.native_session_id || (pane.agent_session?.kind === "id" ? pane.agent_session.value : undefined),
    native_session_agent: location.herdr.native_session_agent || (pane.agent_session?.kind === "id" ? pane.agent_session.agent : undefined),
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

function isRemoteEndpoint(env) {
  if (!env.SYMPP_SERVER_URL) return false;
  return !["localhost", "127.0.0.1", "[::1]"].includes(new URL(env.SYMPP_SERVER_URL).hostname);
}

async function remoteArguments(body, factoryOwned) {
  if (!factoryOwned) return body;
  const credentialFree = value => {
    let remote;
    try { remote = new URL(value); } catch (_) { return value; }
    if (remote.password || /%3a/i.test(remote.username)) {
      throw new Error("Repository origins must not include credentials. Use a credential-free remote and configure Git authentication on the factory.");
    }
    // HTTP userinfo can be either an account or a token. It is authentication,
    // not repository identity; the factory uses its own Git credentials.
    if (["http:", "https:"].includes(remote.protocol) && remote.username) {
      remote.username = "";
      return remote.href;
    }
    return value;
  };
  const origin = cwd => new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, "remote", "get-url", "origin"],
      { timeout: 5000, maxBuffer: 8192, windowsHide: true }, (error, stdout) => {
        if (error || !stdout.trim()) reject(new Error("Repository origin is unavailable. Supply a git remote URL or owner/name."));
        else {
          try { resolve(credentialFree(stdout.trim())); } catch (failure) { reject(failure); }
        }
      });
  });
  const repo = async value => typeof value === "string" && (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) ? origin(value) : credentialFree(value);
  const repoObject = async value => {
    if (!value || typeof value !== "object" || Array.isArray(value) || !("repo" in value)) return value;
    return { ...value, repo: await repo(value.repo) };
  };
  async function rewrite(payload) {
    const params = payload?.params;
    const input = params?.arguments;
    if (payload?.method !== "tools/call" || !input || typeof input !== "object" || Array.isArray(input)) return payload;
    let args = { ...input };
    if (["create_work_request", "claim_local_architect_assignment", "solo_attach", "solo_list"].includes(params.name)) args = await repoObject(args);
    if (params.name === "create_work_request") {
      if (!Object.hasOwn(args, "repo")) args.repo = await origin(process.cwd());
      if (Array.isArray(args.repo_scopes)) args.repo_scopes = await Promise.all(args.repo_scopes.map(repoObject));
    }
    if (params.name === "register_chief" && Array.isArray(args.repos)) args.repos = await Promise.all(args.repos.map(repo));
    if (params.name === "slice_work_request" && Array.isArray(args.work_packages)) args.work_packages = await Promise.all(args.work_packages.map(repoObject));
    if (params.name === "update_work_package") args.patch = await repoObject(args.patch);
    if (["prepare_work_package_worktree", "cleanup_work_package_worktree"].includes(params.name)) delete args.target_repo_root;
    return { ...payload, params: { ...params, arguments: args } };
  }
  const payload = JSON.parse(body);
  if (Array.isArray(payload)) return body;
  return JSON.stringify(await rewrite(payload));
}

function remoteWorktreeResponse(body, env = process.env) {
  if (!isRemoteEndpoint(env)) return body;
  try {
    const qualify = payload => {
      const result = payload?.result;
      const worktree = result?.structuredContent?.worktree;
      if (!result?.isError && ["prepared", "already_prepared"].includes(worktree?.status) && typeof worktree?.path === "string") {
        const machine = env.SYMPP_SERVER_NAME || new URL(env.SYMPP_SERVER_URL).hostname;
        const value = `${machine}:${worktree.path}`;
        const encoded = /[\u0000-\u001f"\u007f]/.test(value) ? JSON.stringify(value) : value;
        result.content = [{ type: "text", text: `worktree: ${encoded}` }];
      }
      return payload;
    };
    const payload = JSON.parse(body);
    if (Array.isArray(payload)) return body;
    return JSON.stringify(qualify(payload));
  } catch (_) { return body; }
}

function createReporter(env = process.env, connect = selected => connectCore(undefined, "hc", [], selected)) {
  const clientId = randomUUID();
  let location = locationFromEnvironment(env, os.hostname(), clientId);
  let factoryOwned = false;
  const native = Boolean(env.HC_TERMINAL_ID && env.HC_TERMINAL_SOCKET);
  const file = path.resolve(env.SYMPP_HOME || path.join(os.homedir(), ".agents", "splusplus"), "herdr-sessions", `${clientId}.json`);
  let refreshAt = 0;
  let pending = null;
  let reports = Promise.resolve();
  let revision = 0;
  let closed = false;

  async function withCore(action) {
    const core = connect({ ...env, HC_SOCKET: env.HC_TERMINAL_SOCKET });
    let timer;
    try {
      await Promise.race([
        (async () => {
          const hello = await core.call("hello", { generation: 1 });
          const terminal = await core.call("terminal.get", { terminal: env.HC_TERMINAL_ID });
          if (!hello?.core?.id || terminal.address !== env.HC_TERMINAL_ID || terminal.state !== "live" ||
              !Number.isSafeInteger(terminal.pid) || terminal.pid <= 0) return;
          const previous = location.herdr;
          if (previous?.core_id && (previous.core_id !== hello.core.id || previous.pid !== terminal.pid)) return;
          location = { ...location, herdr: { core_id: hello.core.id, terminal_id: terminal.address,
            pid: terminal.pid, process_id: process.pid, client_id: clientId } };
          await action(core, terminal);
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("core unavailable")), 1000); }),
      ]);
    } finally { clearTimeout(timer); core.close(); }
  }

  function clear() {
    revision++;
    try { fs.unlinkSync(file); } catch (_) { }
  }

  return {
    clientId,
    native,
    setFactoryOwned(value) { factoryOwned = value; },
    clear,
    close() { closed = true; clear(); },
    report(binding, probe) {
      if (!native || closed || !binding || !probe?.pipe || !probe?.token) return Promise.resolve();
      const current = ++revision;
      reports = reports.then(() => withCore(async (core, terminal) => {
        if (closed || current !== revision) return;
        // Session receipts share the verifier, without changing a worker's original launch receipt.
        const receipt = { schema_version: 1, kind: "session", launch_id: clientId, ...location.herdr,
          provider: "agent", cwd: terminal.cwd || process.cwd(), role: binding.role,
          work_request_id: binding.work_request_id || null, work_package_id: binding.work_package_id || null,
          process_liveness_pipe: probe.pipe, process_liveness_token: probe.token };
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const temporary = `${file}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(receipt), { mode: 0o600 });
        fs.renameSync(temporary, file);
        await core.call("terminal.label", { terminal: terminal.address, labels: {
          "sympp.session_id": clientId, "sympp.session_core_id": receipt.core_id,
          "sympp.session_pid": String(receipt.pid), "sympp.session_process_id": String(receipt.process_id),
          "sympp.session_receipt": file, "sympp.session_role": receipt.role,
          "sympp.session_work_request_id": receipt.work_request_id,
          "sympp.session_work_package_id": receipt.work_package_id,
        } });
      })).catch(() => {});
      return reports;
    },
    async attach(body) {
      // Labels are best effort; a missing Herdr must not hold up MCP calls.
      if (native && Date.now() >= refreshAt && !pending) {
        refreshAt = Date.now() + 60000;
        pending = withCore(async () => {}).catch(() => {}).finally(() => { pending = null; });
      } else if (!native && location.herdr && Date.now() >= refreshAt && !pending) {
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
      return withLocation(await remoteArguments(body, factoryOwned), location);
    },
  };
}

module.exports = { locationFromEnvironment, withSnapshot, withLocation, createReporter, remoteArguments, remoteWorktreeResponse };
