import { expect } from 'e2e';
import { readFile, realpath } from 'node:fs/promises';
import { Client } from '../support/factory.js';
import { initialize, packages, snapshot, test, tool, worker } from '../support/authority.js';

test('competing real clients cannot steal claims and reconnect replay preserves one mutation', async ({ processes }) => {
  const factory = processes.factory();
  const architect = await factory.client();
  await architect.request('Competing claims');
  const [wp] = await packages(architect, ['Single owner']);
  const clients = await Promise.all([factory.client(), factory.client()]);
  const results = await Promise.all(clients.map((client, index) => client.rpc('tools/call', {
    name: 'claim_local_assignment', arguments: { work_package_id: wp, claimed_by: `contender-${index}` },
  })));
  const winners = results.map((result, index) => ({ result, index })).filter(({ result }) => result.result?.structuredContent?.assignment);
  expect(winners).toHaveLength(1);
  const winner = clients[winners[0].index];
  const loser = clients[1 - winners[0].index];
  expect(results[1 - winners[0].index].error).toBeTruthy();
  expect((await loser.call('get_current_assignment')).assignment).toBeNull();
  await loser.reject('append_progress', { summary: 'Stolen', idempotency_key: 'stolen' }, 'claim_required');
  const mutation = { summary: 'Accepted exactly once', body: 'A durable worker observation', idempotency_key: 'once' };
  const first = (await winner.call('append_progress', mutation)).progress_event;
  const reconnected = await factory.client();
  await reconnected.call('claim_local_assignment', { work_package_id: wp, claimed_by: `contender-${winners[0].index}` });
  expect((await reconnected.call('append_progress', mutation)).progress_event.id).toBe(first.id);
  await reconnected.reject('append_progress', { ...mutation, summary: 'Conflicting replay' }, 'idempotency_conflict');
  const document = await reconnected.call('read_work_package_document', { document: 'progress.md' });
  expect(document.progress_events.filter((event: any) => event.id === first.id)).toHaveLength(1);
  const released = await reconnected.call('release_current_assignment', { reason: 'Reconnect lifecycle' });
  expect(released.binding_cleared).toBe(true);
  expect((await reconnected.call('get_current_assignment')).assignment).toBeNull();
  await reconnected.call('claim_local_assignment', { work_package_id: wp, claimed_by: `contender-${winners[0].index}` });
  expect((await reconnected.call('append_progress', mutation)).progress_event.id).toBe(first.id);
});

test('a supported disposable offline snapshot denies MCP and dispatch without changing the source ledger', async ({ processes }) => {
  const source = processes.factory();
  const architect = await source.client();
  const request = await architect.request('Offline denial');
  const [wp] = await packages(architect, ['Snapshot work']);
  await source.stop();
  const database = await snapshot(source);
  const offline = processes.factory('offline', { database, offline: true });
  const client = new Client(await offline.endpoint, offline.receipt);
  for (const payload of [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: initialize },
    tool('claim_local_assignment', { work_package_id: wp }),
    tool('add_work_request_comment', { work_request_id: request, body: 'Must not write', created_by: 'offline' }),
  ]) {
    const refused = await client.raw(payload);
    expect(refused.status).toBe(403);
    expect(refused.body.error.data.reason).toBe('offline_sandbox');
  }
  expect((await client.operator(`/api/v1/sympp/operator/work-requests/${request}/work-packages/${wp}/dispatch`, {})).status).toBe(403);
  const restarted = processes.factory();
  const original = architect.reconnect(await restarted.endpoint);
  expect((await original.call('read_work_request', { work_request_id: request })).work_packages[0].status).toBe('ready_for_worker');
  expect((await original.call('list_comments', { target_kind: 'work_request', target_id: request })).comments).toEqual([]);
});

test('independent architect clients preserve the owner through release reconnect and rejected scope rebinding', async ({ processes }) => {
  const factory = processes.factory();
  const owner = await factory.client();
  const request = await owner.request('Architect claim continuity');
  const peer = await factory.client();
  const denied = await peer.rpc('tools/call', { name: 'claim_local_architect_assignment', arguments: { work_request_id: request, claimed_by: 'different-owner' } });
  expect(denied.error).toBeTruthy();
  expect((await owner.call('get_current_assignment')).assignment.claimed_by).toBe('acceptance-architect');
  const reconnect = await factory.client();
  const claimed = await reconnect.call('claim_local_architect_assignment', { work_request_id: request, claimed_by: 'acceptance-architect' });
  expect(claimed.assignment.work_package_id).toBe((await owner.call('get_current_assignment')).assignment.work_package_id);
  await reconnect.reject('claim_local_architect_assignment', { work_request_id: request, repo: 'foreign/service', claimed_by: 'acceptance-architect' }, 'repo_scope_mismatch');
  expect((await reconnect.call('get_current_assignment')).assignment.work_package_id).toBe(claimed.assignment.work_package_id);
  await reconnect.call('release_current_assignment', { reason: 'End current local session' });
  expect((await reconnect.call('get_current_assignment')).assignment).toBeNull();
  expect((await reconnect.call('claim_local_architect_assignment', { work_request_id: request, claimed_by: 'acceptance-architect' })).assignment.work_package_id).toBe(claimed.assignment.work_package_id);
});

test('backend restart recovers persisted bindings and work but a different ledger refuses them', async ({ processes }) => {
  const original = processes.factory();
  const architect = await original.client();
  const request = await architect.request('Durable identity');
  const [wp] = await packages(architect, ['Survives restart']);
  const client = await worker(original, wp);
  const health = await client.call('sympp.health');
  const ledgerPath = await realpath(original.database);
  const mutation = { title: 'Durable finding', body: 'Survives a real backend stop', idempotency_key: 'restart-once' };
  const finding = (await client.call('append_finding', mutation)).finding;
  await original.stop();
  const restarted = processes.factory('factory');
  const recovered = client.reconnect(await restarted.endpoint);
  expect((await recovered.call('sympp.health')).ledger.identity).toEqual(health.ledger.identity);
  expect(await realpath(restarted.database)).toBe(ledgerPath);
  expect((await recovered.call('get_current_assignment')).assignment.work_package_id).toBe(wp);
  expect((await recovered.call('append_finding', mutation)).finding.id).toBe(finding.id);
  const owner = architect.reconnect(await restarted.endpoint);
  expect((await owner.call('read_work_request', { work_request_id: request })).work_packages[0].status).toBe('active');
  const outsider = processes.factory('foreign-ledger');
  const wrongLedger = recovered.reconnect(await outsider.endpoint);
  const denied = await wrongLedger.raw(tool('append_finding', mutation));
  expect(denied.status).toBe(404);
  expect(denied.body.error.data.reason).toBe('unknown_state_key');
  const fresh = await outsider.client();
  expect(await realpath(outsider.database)).not.toBe(ledgerPath);
  expect((await fresh.rpc('tools/call', { name: 'read_work_request', arguments: { work_request_id: request } })).error.data.reason).toBe('not_found');
  expect((await fresh.call('get_current_assignment')).assignment).toBeNull();
  expect((await recovered.call('read_work_package_document', { document: 'findings.md' })).findings.filter((entry: any) => entry.id === finding.id)).toHaveLength(1);
});

test('failed-call capture is opt-in redacted and immediately disabled through operator settings', async ({ processes }) => {
  const factory = processes.factory();
  const client = await factory.client();
  const secret = 'Bearer synthetic-diagnostic-secret';
  const payload = tool('append_progress', { nested: { authorization: secret }, [secret]: secret });
  const disabled = await client.raw(payload);
  expect(disabled.body.error.data.diagnostic_id).toBeUndefined();
  expect((await readFile(factory.logPath, 'utf8')).includes('sympp_failed_mcp_call')).toBe(false);
  expect((await client.operator('/api/v1/sympp/operator/settings', { capture_failed_mcp_calls: true })).status).toBe(200);
  const enabled = await client.raw(payload);
  const diagnostic = enabled.body.error.data.diagnostic_id;
  expect(diagnostic).toMatch(/^mcpdiag_[0-9a-f]{16}$/);
  expect(JSON.stringify(enabled.body)).not.toContain('synthetic-diagnostic-secret');
  await expect.poll(async () => (await readFile(factory.logPath, 'utf8')).includes(diagnostic)).toBe(true);
  const log = await readFile(factory.logPath, 'utf8');
  expect(log).not.toContain('synthetic-diagnostic-secret');
  expect(log).toContain('sympp_failed_mcp_call');
  expect(log).toContain('invalid_params');
  const summary = await client.call('summarize_failed_mcp_calls');
  expect(JSON.stringify(summary)).not.toContain('synthetic-diagnostic-secret');
  expect((await client.operator('/api/v1/sympp/operator/settings', { capture_failed_mcp_calls: false })).status).toBe(200);
  expect((await client.raw(payload)).body.error.data.diagnostic_id).toBeUndefined();
});

test('STDIO initialization refuses unbound protected calls and cannot impersonate the trusted HTTP operator', async ({ processes }) => {
  const factory = processes.factory();
  const architect = await factory.client();
  const request = await architect.request('STDIO authority');
  const [wp] = await packages(architect, ['Local worker transport']);
  const candidate = processes.stdio('stdio-worker', { database: factory.database, surface: 'worker' });
  const before = await candidate.rawRequest('tools/call', { name: 'read_context', arguments: {} });
  expect(before.error.data.reason).toBe('server_not_initialized');
  await candidate.request('initialize', initialize);
  expect((await candidate.rawRequest('tools/call', { name: 'read_context', arguments: {} })).error.data.reason).toBe('claim_required');
  const claimed = await candidate.request('tools/call', { name: 'claim_local_assignment', arguments: { work_package_id: wp, claimed_by: 'stdio-worker' } });
  expect(claimed.structuredContent.assignment.work_package_id).toBe(wp);
  expect((await candidate.request('tools/call', { name: 'read_context', arguments: {} })).structuredContent.work_package.id).toBe(wp);
  const note = await candidate.rawRequest('tools/call', { name: 'add_work_request_comment', arguments: { work_request_id: request, body: 'Untrusted operator', created_by: 'stdio-worker' } });
  expect(note.error).toBeTruthy();
  expect((await architect.call('list_comments', { target_kind: 'work_request', target_id: request })).comments).toEqual([]);
});
