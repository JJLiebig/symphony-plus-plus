import * as fs from "fs/promises";
import { exec, appHome } from "herdr";
const failure = message => Object.assign(new Error(message), { userMessage: message });

// Herdr currently grants mods process/file access but no native HTTP capability.
// Keep transport in this adapter; the view and S++ authority remain independent of the host.
export function createTransport(bridge) {
  return async (url, options = {}) => {
    if (!bridge?.node || !bridge?.helper) throw failure("Reinstall the S++ view to connect it.");
    const file = `${appHome()}/data/sympp-requests/${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.json`;
    try {
      try { await fs.writeFile(file, JSON.stringify({ url, method: options.method ?? "GET", ...(options.body === undefined ? {} : { body: options.body }) })); }
      catch { throw failure("Couldn't prepare the S++ request. Reinstall the view and retry."); }
      const result = await exec(bridge.node, [bridge.helper, file]);
      let response;
      try { response = JSON.parse(result.stdout); }
      catch { throw failure("Couldn't read S++'s response. Retry after reconnecting."); }
      if (result.code !== 0) throw failure(response.error || "Couldn't connect to S++.");
      return { status: response.status, ok: response.status >= 200 && response.status < 300,
        json: async () => {
          if (!("body" in response)) throw new Error("S++ returned an unreadable response.");
          return response.body;
        } };
    } finally {
      await fs.unlink(file).catch(() => {});
    }
  };
}
