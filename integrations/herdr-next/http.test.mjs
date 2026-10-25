import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = join(dirname(fileURLToPath(import.meta.url)), 'http.cjs');
async function request(t, envelope) {
  const root = await mkdtemp(join(tmpdir(), 'spp request with spaces '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'request.json');
  await writeFile(file, JSON.stringify(envelope), { mode: 0o600 });
  const child = spawn(process.execPath, [helper, file], { windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', part => stdout += part);
  child.stderr.on('data', part => stderr += part);
  const [code] = await once(child, 'exit');
  assert.equal(stderr, '');
  return { code, ...JSON.parse(stdout) };
}

test('native transport carries large literal JSON and real status without browser or proxy metadata', async t => {
  const received = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const part of req) chunks.push(part);
    const body = Buffer.concat(chunks).toString('utf8');
    received.push({ method: req.method, headers: req.headers, body });
    res.setHeader('content-type', 'application/json');
    res.statusCode = req.method === 'POST' ? 422 : 200;
    res.end(JSON.stringify(req.method === 'POST' ? { error: { message: 'Choose a valid option.' } } : { runtime: { offline: false } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/v1/sympp/herdr/dashboard`;
  assert.deepEqual(await request(t, { url, method: 'GET' }), { code: 0, status: 200, body: { runtime: { offline: false } } });
  const body = JSON.stringify({ answer: '`$() "quotes"\n âa '.repeat(10000), extra: 'tolerated' });
  const result = await request(t, { url: url.replace('/dashboard', '/work-requests/wr/questions/q/answer'), method: 'POST', body });
  assert.equal(result.code, 0);
  assert.equal(result.status, 422);
  assert.equal(result.body.error.message, 'Choose a valid option.');
  assert.ok(Buffer.from(received[1].body).equals(Buffer.from(body)), 'POST must preserve literal UTF-8 and multiline content');
  assert.equal(received[1].headers['content-type'], 'application/json');
  for (const req of received) {
    assert.equal(Object.keys(req.headers).some(key => /^(origin|sec-fetch-|forwarded|x-forwarded-|x-real-ip)/.test(key)), false);
  }
});

test('redirects cannot forward a decision and unreadable responses are not invented successes', async t => {
  let forwarded = 0;
  const server = createServer((req, res) => {
    if (req.url.endsWith('/redirect')) { res.writeHead(307, { location: '/unexpected' }); res.end(); }
    else if (req.url.endsWith('/dashboard')) { res.writeHead(503, { 'content-type': 'text/html' }); res.end('<p>Unavailable</p>'); }
    else { forwarded++; res.end('{}'); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const redirect = await request(t, { url: `${base}/api/v1/sympp/herdr/redirect`, method: 'POST', body: '{"answer":"private"}' });
  assert.equal(redirect.status, 307);
  assert.equal(forwarded, 0);
  const unavailable = await request(t, { url: `${base}/api/v1/sympp/herdr/dashboard`, method: 'GET' });
  assert.equal(unavailable.status, 503);
  assert.equal('body' in unavailable, false);
  const outside = await request(t, { url: `${base}/api/v1/sympp/operator/settings`, method: 'POST', body: '{}' });
  assert.equal(outside.code, 2);
  assert.equal(forwarded, 0);
});
