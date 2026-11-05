const failure = message => Object.assign(new Error(message), { userMessage: message });

export async function request(url, options = {}) {
  let response;
  try {
    // Caller-supplied headers also keep Herdr fetch from following cross-origin redirects.
    response = await fetch(url, { ...options, headers: { accept: "application/json", ...options.headers } });
  } catch {
    throw failure("Couldn't reach sympp. Check the connection and retry.");
  }
  if (response.redirected || response.url !== url) {
    throw Object.assign(failure("sympp redirected the request. Check the local sympp connection."), { status: response.status });
  }
  return response;
}

// Bind authentication to one configured origin; never send it to a navigation target.
export function remoteRequest(endpoint, loadConfig) {
  return async (url, options = {}) => {
    if (new URL(url).origin !== endpoint) throw failure("sympp request does not match the configured server.");
    const config = await loadConfig();
    if (config.endpoint !== endpoint) throw failure("sympp server changed. Reinstall the panel connection.");
    return request(url, { ...options, headers: { ...options.headers,
      ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}) } });
  };
}
