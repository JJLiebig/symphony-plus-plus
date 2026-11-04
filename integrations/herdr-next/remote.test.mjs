import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { remoteRequest } from './mods/sympp/transport.js';

test('installed remote connection authenticates board, actions and leases and rejects another origin', async t => {
  const home = await mkdtemp(join(tmpdir(), 'sympp-remote-panel-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['integrations/herdr-next/install.mjs', '--server', 'http://127.0.0.1:19998', '--home', home], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const props = JSON.parse(JSON.parse(result.stdout.split('\n').find(l => l.startsWith('args: ')).slice(6))).props;
  assert.equal(props.remote, true);
  assert.equal(props.hosts.local.runtime, undefined);
  const saved = JSON.parse(await readFile(join(home, 'sympp-remote.json'), 'utf8'));
  assert.equal(saved.endpoint, props.endpoint);
  const paths = [];
  const server = createServer((req, res) => {
    paths.push(req.url);
    res.writeHead(req.headers.authorization === 'Bearer panel-fixture' ? 200 : 401, { 'content-type': 'application/json' });
    res.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const request = remoteRequest(endpoint, async () => ({ endpoint, token: 'panel-fixture' }));
  for (const path of ['/api/v1/sympp/herdr/dashboard', '/api/v1/sympp/herdr/work-requests', '/mcp/client-lease']) {
    const res = await request(endpoint + path, path.endsWith('dashboard') ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 200);
  }
  await assert.rejects(request('http://other.invalid/api'), /configured server/);
  assert.equal(paths.length, 3);
  const denied = remoteRequest(endpoint, async () => ({ endpoint, token: 'wrong' }));
  assert.equal((await denied(endpoint + '/api')).status, 401);
});
