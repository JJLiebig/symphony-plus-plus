import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { expect } from 'e2e';
import { Client, contract } from '../support/factory.js';
import { test } from '../support/offline-copy.js';

// A separate required hosted job selects this journey; no platform skips count as proof.
if (process.env.SYMPP_OFFLINE_ACCEPTANCE === '1') {
  test('an online candidate can be copied and refreshed only explicitly into an offline viewer', async ({ copy }) => {
    const source = copy.start('online-home');
    const architect = await source.client();
    const request = await architect.request('Synthetic online snapshot');
    const [wp] = (await architect.call('slice_work_request', {
      work_packages: [contract('Persisted snapshot package')],
    })).work_package_ids;
    const before = await architect.call('read_work_request', { detail: 'full', work_request_id: request });
    const sourceBoard = await architect.raw(null, {}, 'GET', '/api/v1/sympp/herdr/dashboard');
    expect(sourceBoard.status).toBe(200);
    expect(sourceBoard.body.runtime).toEqual({ offline: false });
    const sourceBytes = await readFile(source.database);
    const walBytes = await readFile(source.database + '-wal');
    expect((await copy.snapshot(source)).code).toBe(0);
    expect(await readFile(source.database)).toEqual(sourceBytes);
    expect(await readFile(source.database + '-wal')).toEqual(walBytes);
    expect((await copy.command(['verify', copy.database])).code).toBe(0);
    expect((await copy.command(['verify', source.database, '--live'])).code).toBe(0);
    expect((await copy.command(['verify', copy.database, '--live'])).code).toBe(1);
    const initialCopy = await readFile(copy.database);
    const refused = await copy.snapshot(source);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('already exists');
    expect(await readFile(copy.database)).toEqual(initialCopy);

    const stored = new DatabaseSync(copy.database, { readOnly: true });
    try {
      expect(stored.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      expect(stored.prepare('SELECT title FROM sympp_work_requests WHERE id = ?').get(request)?.title).toBe('Synthetic online snapshot');
      expect(stored.prepare('SELECT title FROM sympp_work_packages WHERE id = ?').get(wp)?.title).toBe('Persisted snapshot package');
    } finally { stored.close(); }

    const offline = copy.start('viewer-profile', true);
    const viewer = new Client(await offline.endpoint, offline.receipt);
    const browserBoard = await viewer.inspect('/api/v1/sympp/operator/dashboard/hydrated');
    const nativeBoard = await viewer.raw(null, {}, 'GET', '/api/v1/sympp/herdr/dashboard');
    expect(nativeBoard.status).toBe(200);
    expect(nativeBoard.body.runtime).toEqual({ offline: true });
    const { generated_at: browserTime, ...browserProjection } = browserBoard;
    const { generated_at: nativeTime, chiefs, ...nativeProjection } = nativeBoard.body;
    expect(chiefs).toEqual([]);
    expect(nativeProjection).toEqual(browserProjection);
    const copiedRequest = nativeBoard.body.work_request_details.find((entry: any) => entry.work_request.id === request);
    expect(copiedRequest.work_packages.map((entry: any) => entry.id)).toContain(wp);
    const hydrated = JSON.stringify(browserBoard);
    expect(hydrated).toContain('Synthetic online snapshot');
    expect(hydrated).toContain('Persisted snapshot package');
    for (const route of ['/mcp', '/mcp/client-lease']) {
      expect((await viewer.raw({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, {}, 'POST', route)).status).toBe(403);
    }
    for (const route of [
      `/api/v1/sympp/operator/work-requests/${request}/work-packages/${wp}/dispatch`,
      `/api/v1/sympp/operator/work-packages/${wp}/focus`,
    ]) expect((await viewer.operator(route, {})).status).toBe(403);
    expect((await architect.call('read_work_request', { detail: 'full', work_request_id: request })).work_packages).toEqual(before.work_packages);
    await offline.stop();

    await architect.call('add_work_request_comment', { work_request_id: request, body: 'Only the explicit refresh sees this', created_by: 'acceptance' });
    expect((await copy.snapshot(source)).code).toBe(1);
    expect((await copy.snapshot(source, true)).code).toBe(0);
    const refreshed = new DatabaseSync(copy.database, { readOnly: true });
    try {
      expect(refreshed.prepare('SELECT body FROM sympp_comments WHERE target_id = ?').all(request)
        .map(row => row.body)).toContain('Only the explicit refresh sees this');
    } finally { refreshed.close(); }
    expect((await readdir(copy.home)).some(name => name.startsWith('.beta-snapshot-'))).toBe(false);
    expect(existsSync(copy.commands)).toBe(false);
    expect(source.home).not.toBe(offline.home);
    expect(source.database).not.toBe(copy.database);
    expect(source.process.pid).not.toBe(offline.process.pid);
  });
}
