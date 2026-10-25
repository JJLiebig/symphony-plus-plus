import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { request } from './mods/sympp/transport.js';
import { postAction } from './mods/sympp/controls.js';

async function listen(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('native requests carry literal JSON and retain real success and error statuses', async t => {
  const received = [];
  const origin = await listen(t, async (req, res) => {
    const chunks = [];
    for await (const part of req) chunks.push(part);
    received.push({ method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    res.setHeader('content-type', 'application/json');
    res.statusCode = req.method === 'POST' ? 422 : 207;
    res.end(JSON.stringify(req.method === 'POST' ? { error: { message: 'Choose a valid option.' } } : { runtime: { offline: false } }));
  });
  const response = await request(`${origin}/api/v1/sympp/herdr/dashboard`);
  assert.equal(response.status, 207);
  assert.equal(response.ok, true);
  assert.deepEqual(await response.json(), { runtime: { offline: false } });
  const body = { answer: '`$() "quotes"\n âa '.repeat(10000), extra: 'tolerated' };
  await assert.rejects(postAction(origin, '/api/v1/sympp/herdr/work-requests/wr/questions/q/answer', body, request), /Choose a valid option/);
  assert.equal(received[1].body, JSON.stringify(body));
  assert.equal(received[1].headers['content-type'], 'application/json');
  assert.ok(received.every(req => req.headers.accept === 'application/json'));
  const rejected = await request(`${origin}/api/v1/sympp/herdr/work-requests`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(rejected.status, 422);
  assert.equal(rejected.ok, false);
});

test('redirected GET and POST responses fail before their payload can be accepted', async t => {
  const targets = [];
  const origin = await listen(t, (req, res) => {
    if (req.url.endsWith('/redirect')) {
      res.writeHead(307, { location: '/unexpected' });
      res.end();
    } else {
      targets.push(req.method);
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{"created":"must not be accepted"}');
    }
  });
  const url = `${origin}/api/v1/sympp/herdr/redirect`;
  for (const method of ['GET', 'POST']) {
    await assert.rejects(request(url, { method }), error => error.status === 201 && /redirected/.test(error.userMessage));
  }
  assert.deepEqual(targets, ['GET', 'POST'], 'same-origin redirects can be followed by the host but their results are rejected');

  let parsed = false;
  t.mock.method(globalThis, 'fetch', async () => ({ redirected: true, url, status: 200,
    json: async () => { parsed = true; return {}; } }));
  await assert.rejects(postAction(origin, '/api/v1/sympp/herdr/redirect', {}, request), /redirected/);
  assert.equal(parsed, false, 'the redirect flag also rejects a chain that returns to the original URL');
});

test('unreadable errors keep their HTTP status and an uncertain write is not retried', async t => {
  let writes = 0;
  const origin = await listen(t, (req, res) => {
    if (req.method === 'POST') { writes++; req.socket.destroy(); }
    else { res.writeHead(503, { 'content-type': 'text/html' }); res.end('<p>Unavailable</p>'); }
  });
  const response = await request(`${origin}/api/v1/sympp/herdr/dashboard`);
  assert.equal(response.status, 503);
  assert.equal(response.ok, false);
  await assert.rejects(response.json());
  await assert.rejects(postAction(origin, '/api/v1/sympp/herdr/work-requests', { title: 'Scratch' }, request), /Couldn't reach S\+\+/);
  assert.equal(writes, 1);
});
