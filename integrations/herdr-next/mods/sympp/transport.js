const failure = message => Object.assign(new Error(message), { userMessage: message });

export async function request(url, options = {}) {
  let response;
  try {
    // Caller-supplied headers also keep Herdr fetch from following cross-origin redirects.
    response = await fetch(url, { ...options, headers: { accept: "application/json", ...options.headers } });
  } catch {
    throw failure("Couldn't reach S++. Check the connection and retry.");
  }
  if (response.redirected || response.url !== url) {
    throw Object.assign(failure("S++ redirected the request. Check the local S++ connection."), { status: response.status });
  }
  return response;
}
