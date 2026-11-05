"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function origin(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("The remote server must be an HTTP origin without credentials, path or query.");
  }
  return url.origin;
}

function serverConnection(host, run = spawnSync) {
  const port = process.env.SYMPP_REMOTE_PORT || "19998";
  const factoryHome = process.env.SYMPP_REMOTE_HOME;
  if (!/^\d+$/.test(port) || +port < 1 || +port > 65535) throw new Error("Invalid remote factory port.");
  if (factoryHome && !factoryHome.startsWith("/")) throw new Error("Remote factory home must be absolute.");
  if (!host || host.startsWith("-") || /[\s\0]/.test(host)) throw new Error("Provide an SSH host alias or an HTTP loopback origin.");
  if (host.startsWith("http://")) {
    const endpoint = origin(host);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(endpoint).hostname)) throw new Error("Use an SSH host alias for remote servers.");
    return { endpoint, token: "" };
  }
  const options = { encoding: "utf8", windowsHide: true, timeout: 30000 };
  const config = run("ssh", ["-G", host], options);
  const hostname = config.status === 0 && config.stdout.match(/^hostname\s+(.+)$/mi)?.[1].trim();
  if (!hostname) throw new Error("Could not resolve the SSH server hostname.");
  const result = run("ssh", ["-o", "BatchMode=yes", host, factoryHome ? "cat " + "'" + (factoryHome + '/remote-token').replaceAll("'", "'\\''") + "'" : "cat ~/.agents/splusplus/remote-token"], options);
  if (result.error || result.status !== 0 || !result.stdout.trim()) throw new Error("Could not read the sympp token over SSH.");
  // Remote factories expose authenticated HTTP on the private tailnet by contract.
  return { endpoint: origin(`http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`), token: result.stdout.trim() };
}

function privateWrite(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${require("node:crypto").randomUUID()}.tmp`;
  try {
    fs.closeSync(fs.openSync(temporary, "wx", 0o600));
    if (process.platform === "win32") {
      const who = spawnSync("whoami.exe", [], { encoding: "utf8", windowsHide: true });
      if (who.status !== 0) throw new Error("Could not identify the current user for token permissions.");
      const acl = spawnSync("icacls.exe", [temporary, "/inheritance:r", "/grant:r", `${who.stdout.trim()}:(F)`], { encoding: "utf8", windowsHide: true });
      if (acl.status !== 0) throw new Error("Could not restrict token permissions.");
    }
    fs.writeFileSync(temporary, body);
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function remoteConnection(endpoint, tokenFile) {
  return { origin: origin(endpoint), token: tokenFile ? fs.readFileSync(tokenFile, "utf8").trim() : "" };
}
module.exports = { serverConnection, privateWrite, remoteConnection };
