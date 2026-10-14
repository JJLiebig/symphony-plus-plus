import { expect } from 'e2e';
import { readFile, realpath } from 'node:fs/promises';
import { Client, contract } from '../support/factory.js';
import { initialize, packages, snapshot, test, tool, worker } from '../support/authority.js';

test('competing real clients cannot steal claims and reconnect replay preserves one mutation', async ({ processes }) => {
  const factory = processes.factory();
  const architect = await factory.client();
  await architect.request('Competing claims');
  const [wp, implicit] = await packages(architect, ['Single owner', 'Implicit local owner']);
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
  const implicitFirst = await factory.client();
  const implicitSecond = await factory.client();
  const firstClaim = await implicitFirst.call('claim_local_assignment', { work_package_id: implicit });
  const secondClaim = await implicitSecond.call('claim_local_assignment', { work_package_id: implicit });
  expect(secondClaim.assignment.grant_id).toBe(firstClaim.assignment.grant_id);
  expect(secondClaim.assignment.claimed_by).toBe(firstClaim.assignment.claimed_by);
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
  await owner.call('set_work_request_status', { work_request_id: request, current_status: 'ready_for_slicing', next_status: 'draft' });
  expect((await owner.call('read_work_request', { work_request_id: request })).work_request.status).toBe('draft');
  await owner.call('set_work_request_status', { work_request_id: request, current_status: 'draft', next_status: 'ready_for_slicing' });
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
  expect((await client.call('summarize_failed_mcp_calls')).total_failures).toBe(0);
  expect((await client.operator('/api/v1/sympp/operator/settings', { capture_failed_mcp_calls: true })).status).toBe(200);
  const enabled = await client.raw(payload);
  const diagnostic = enabled.body.error.data.diagnostic_id;
  expect(diagnostic).toMatch(/^mcpdiag_[0-9a-f]{16}$/);
  expect(JSON.stringify(enabled.body)).not.toContain('synthetic-diagnostic-secret');
  await expect.poll(async () => (await readFile(factory.logPath, 'utf8')).includes(diagnostic)).toBe(true);
  const log = await readFile(factory.logPath, 'utf8');
  expect(log).not.toContain('synthetic-diagnostic-secret');
  expect(log).toContain('sympp_failed_mcp_call');
  expect(log).toContain('claim_required');
  expect(log).toContain('unauthorized');
  const summary = await client.call('summarize_failed_mcp_calls');
  expect(summary.total_failures).toBe(1);
  expect(JSON.stringify(summary)).not.toContain('synthetic-diagnostic-secret');
  expect((await client.operator('/api/v1/sympp/operator/settings', { capture_failed_mcp_calls: false })).status).toBe(200);
  expect((await client.raw(payload)).body.error.data.diagnostic_id).toBeUndefined();
  expect((await client.call('summarize_failed_mcp_calls')).total_failures).toBe(1);
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
  const catalog = await candidate.request('tools/list');
  expect(catalog.tools.some((entry: any) => entry.name === 'set_status')).toBe(false);
  for (const name of ['mint_worker_grant', 'list_work_packages']) expect((await candidate.rawRequest('tools/call', { name, arguments: {} })).error.code).toBe(-32601);
  expect((await candidate.rawRequest('tools/call', { name: 'read_context', arguments: {} })).error.data.reason).toBe('claim_required');
  const claimed = await candidate.request('tools/call', { name: 'claim_local_assignment', arguments: { work_package_id: wp, claimed_by: 'stdio-worker' } });
  expect(claimed.structuredContent.assignment.work_package_id).toBe(wp);
  expect((await candidate.request('tools/call', { name: 'read_context', arguments: {} })).structuredContent.work_package.id).toBe(wp);
  const note = await candidate.rawRequest('tools/call', { name: 'add_work_request_comment', arguments: { work_request_id: request, body: 'Untrusted operator', created_by: 'stdio-worker' } });
  expect(note.error).toBeTruthy();
  expect((await architect.call('list_comments', { target_kind: 'work_request', target_id: request })).comments).toEqual([]);
});

test('STDIO protocol errors and batches cannot smuggle authority across requests', async ({ processes }) => {
  const factory = processes.factory();
  const architect = await factory.client();
  await architect.request('Batch authority');
  const [first, second] = await packages(architect, ['First batch claim', 'Second batch claim']);
  const candidate = processes.stdio('protocol', { database: factory.database, surface: 'worker' });
  expect((await candidate.rawRequest('initialize')).error.data.reason).toBe('missing_protocol_version');
  expect((await candidate.rawRequest('initialize', { protocolVersion: '2025-03-26' })).error.data.reason).toBe('invalid_initialize_params');
  expect((await candidate.rawRequest('initialize', [] as any)).error.data.reason).toBe('params_must_be_object');
  expect((await candidate.rawPayload({ jsonrpc: '2.0', method: 'initialize', params: initialize })).error.data.reason).toBe('initialize_requires_id');
  expect((await candidate.request('initialize', { ...initialize, protocolVersion: '2024-11-05' })).protocolVersion).toBe('2025-03-26');
  expect((await candidate.rawRequest('initialize', initialize)).error.data.reason).toBe('already_initialized');
  for (const [payload, key, reason] of [
    [{ jsonrpc: '1.0', id: 910 }, 910, 'invalid_jsonrpc_version'],
    [{ jsonrpc: '2.0', id: 911 }, 911, 'missing_method'],
    [{ jsonrpc: '2.0', id: {}, method: 'tools/call', params: { name: 'claim_local_assignment', arguments: { work_package_id: first } } }, null, 'invalid_request_id'],
    [{ jsonrpc: '2.0', id: [], method: 'tools/list' }, null, 'invalid_request_id'],
    [{ jsonrpc: '2.0', id: 912, method: 42 }, 912, 'invalid_method'],
    [{ jsonrpc: '2.0', id: 913, method: 'tools/list', params: 'bad' }, 913, 'params_must_be_object_or_array'],
    [{ id: null, method: 'initialize', params: {} }, null, 'invalid_jsonrpc_version'],
    [{ method: 'initialize', params: {} }, null, 'request_must_be_object'],
    [{ id: 916, method: 123 }, 916, 'invalid_method'],
    [[], null, 'empty_batch'],
    [[{ jsonrpc: '2.0', id: 914, method: 'initialize', params: initialize }], null, 'initialize_must_be_standalone'],
  ] as const) expect((await candidate.rawPayload(payload, key)).error.data.reason).toBe(reason);
  for (const method of ['tools/list', 'tools/call', 'resources/list', 'resources/read']) {
    expect((await candidate.rawPayload({ jsonrpc: '2.0', id: 915, method, params: [] }, 915)).error.data.reason).toBe('params_must_be_object');
  }
  expect((await candidate.request('tools/call', { name: 'get_current_assignment', arguments: {} })).structuredContent.assignment).toBeNull();
  const catalog = await candidate.request('tools/list');
  const batchTool = (id: number, name: string, args: object = {}) => ({ ...tool(name, args), id });
  const denied = await candidate.rawPayload([
    [{ jsonrpc: '2.0', id: 920, method: 'tools/list' }],
    batchTool(921, 'append_progress', { summary: 'Before claim', idempotency_key: 'batch-before' }),
    batchTool(922, 'claim_local_assignment', { work_package_id: first, claimed_by: 'batch-owner' }),
    batchTool(923, 'append_progress', { summary: 'After claim in same batch', idempotency_key: 'batch-after' }),
    batchTool(924, 'list_guidance_requests', { work_request_id: 'foreign' }),
  ]);
  expect(denied[0].error.data.reason).toBe('request_must_be_object');
  expect(denied[1].error.data.reason).toBe('claim_required');
  expect(denied[2].result.structuredContent.assignment.work_package_id).toBe(first);
  expect(denied[3].error.data.reason).toBe('claim_required');
  expect(denied[4].error.data.reason).toBe('claim_required');
  expect((await candidate.request('tools/call', { name: 'read_work_package_document', arguments: { document: 'progress.md' } })).structuredContent.progress_events).toEqual([]);
  const switched = await candidate.rawPayload([
    batchTool(925, 'read_context'),
    batchTool(926, 'claim_local_assignment', { work_package_id: first, claimed_by: 'batch-owner' }),
    batchTool(927, 'claim_local_assignment', { work_package_id: second, claimed_by: 'second-owner' }),
    { jsonrpc: '2.0', id: 928, method: 'tools/list' },
  ]);
  expect(switched[0].result.structuredContent.work_package.id).toBe(first);
  expect(switched[1].result.structuredContent.assignment.work_package_id).toBe(first);
  expect(switched[2].result.structuredContent.assignment.work_package_id).toBe(second);
  expect((await candidate.request('tools/call', { name: 'get_current_assignment', arguments: {} })).structuredContent.assignment.work_package_id).toBe(second);
  expect(await candidate.request('tools/list')).toEqual(catalog);
  // A following response is the barrier: blank/CRLF lines and notifications
  // must neither emit replies nor stop processing the stream.
  const before = (await readFile(candidate.logPath, 'utf8')).split('\n').filter((line) => line.startsWith('{') || line.startsWith('[')).length;
  candidate.process.stdin.write('\r\n' + JSON.stringify([{ jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', method: 'notifications/cancelled' }]) + '\r\n');
  await candidate.request('tools/list');
  await expect.poll(async () => (await readFile(candidate.logPath, 'utf8')).split('\n').filter((line) => line.startsWith('{') || line.startsWith('[')).length).toBe(before + 1);
});

test('failed worker rebinding preserves its current authority and successful rebinding releases only its lease', async ({ processes }) => {
  const factory = processes.factory();
  const architect = await factory.client();
  const request = await architect.request('Atomic worker rebind');
  const [first, second, taken] = await packages(architect, ['Original work', 'Next work', 'Other owner']);
  const [undispatched] = (await architect.call('slice_work_request', { work_packages: [contract('Unclaimed plan')] })).work_package_ids;
  const client = await worker(factory, first, 'moving-worker');
  const peer = await worker(factory, taken, 'peer-worker');
  const catalog = await client.rpc('tools/list');
  for (const [args, reason] of [
    [{ work_package_id: second, repo: 'foreign/service' }, 'repo_scope_mismatch'],
    [{ work_package_id: taken }, 'claim_lease_active_for_other_actor'],
    [{ work_package_id: undispatched }, 'work_package_not_dispatched'],
  ] as const) {
    await client.reject('claim_local_assignment', { ...args, claimed_by: 'moving-worker' }, reason);
    expect((await client.call('get_current_assignment')).assignment.work_package_id).toBe(first);
  }
  await client.reject('claim_local_architect_assignment', { work_request_id: request }, 'tool_not_callable');
  await client.call('claim_local_assignment', { work_package_id: second, claimed_by: 'moving-worker' });
  expect((await client.call('get_current_assignment')).assignment.work_package_id).toBe(second);
  expect((await peer.call('get_current_assignment')).assignment.work_package_id).toBe(taken);
  const recovered = await worker(factory, first, 'moving-worker');
  const recoveredEvent = (await recovered.call('append_progress', { summary: 'Original reservation recovered', idempotency_key: 'rebound' })).progress_event;
  expect((await recovered.call('read_work_package_document', { document: 'progress.md' })).progress_events.map((entry: any) => entry.id)).toContain(recoveredEvent.id);
  await client.call('release_current_assignment');
  expect((await client.call('release_current_assignment')).binding_cleared).toBe(false);
  expect((await client.rpc('tools/list')).result).toEqual(catalog.result);
});

test('HTTP client attachment telemetry and readiness preserve local request boundaries', async ({ processes }) => {
  const factory = processes.factory();
  const client = new Client(await factory.endpoint, factory.receipt);
  const readiness = await client.raw(null, {}, 'GET', '/mcp/readiness');
  expect(readiness.status).toBe(200);
  expect(readiness.body.source.revision).toBe(process.env.ACCEPTANCE_CHECKOUT_SHA);
  expect(readiness.body.ledger.identity.default_home).toBe(false);
  expect((await client.raw(tool('get_current_assignment'))).body.error.data.reason).toBe('missing_session_id');
  for (const path of ['/mcp/readiness', '/mcp/client-lease']) {
    const method = path.endsWith('readiness') ? 'GET' : 'POST';
    for (const [headers, reason] of [[{ origin: 'https://example.invalid' }, 'origin_not_allowed'], [{ 'x-forwarded-for': '127.0.0.1' }, 'local_only']] as const) {
      const refused = await client.raw({ client_id: 'denied-client', action: 'attach' }, headers, method, path);
      expect(refused.status).toBe(403);
      expect(refused.body.error.data.reason).toBe(reason);
    }
  }
  const lease = async (id: string, action: string) => {
    const response = await client.raw({ client_id: id, action }, {}, 'POST', '/mcp/client-lease');
    expect(response.status).toBe(200);
    return response.body.active_client_count;
  };
  expect(await lease('first-client', 'attach')).toBe(1);
  expect(await lease('second-client', 'attach')).toBe(2);
  expect(await lease('first-client', 'heartbeat')).toBe(2);
  expect(await lease('first-client', 'detach')).toBe(1);
  expect(await lease('second-client', 'detach')).toBe(0);
  expect((await client.raw(null, {}, 'GET', '/mcp/readiness')).body.status).toBe('ok');
});

test('public architect handoff replays one unclaimed grant and trusted mutation claims only when needed', async ({ processes }) => {
  const factory = processes.factory();
  const client = await factory.client();
  const create = async (status: string) => client.call('create_work_request', {
    repo: 'example/service', base_branch: 'beta', title: `Handoff ${status}`, description: 'Synthetic handoff proof.',
    request_kind: 'feature', status,
  });
  const initial = await create('draft');
  expect(initial.architect_handoff.status).toBe('created');
  expect(initial.architect_handoff.grant.claimed_at).toBeNull();
  const draft = initial.work_request.id;
  expect((await client.call('get_current_assignment')).assignment).toBeNull();
  await client.call('read_work_request', { work_request_id: draft });
  expect((await client.call('get_current_assignment')).assignment).toBeNull();
  const path = `/api/v1/sympp/operator/work-requests/${draft}/architect-handoff`;
  expect((await client.raw({}, { origin: 'https://example.invalid' }, 'POST', path)).status).toBe(401);
  const handoff = await client.operator(path, {});
  expect(handoff.status).toBe(200);
  const created = handoff.body.architect_handoff;
  expect(created.status).toBe('replayed');
  expect(created.grant.id).toBe(initial.architect_handoff.grant.id);
  expect(created.grant.secret_in_response).toBe(false);
  expect(created.local_architect_claim.arguments.work_request_id).toBe(draft);
  expect(JSON.stringify(created)).not.toContain('secret_hash');
  expect((await client.operator(path, {})).body.architect_handoff.grant.id).toBe(created.grant.id);
  const claim = await client.call('claim_local_architect_assignment', created.local_architect_claim.arguments);
  expect(claim.assignment.grant_id).toBe(created.grant.id);
  expect(claim.assignment.phase_id).toBe(created.phase.id);
  const owner = await client.call('claim_local_architect_assignment', {
    ...created.local_architect_claim.arguments, repo: 'example/service', base_branch: 'beta',
    phase_id: created.phase.id, architect_anchor_work_package_id: created.anchor_package.id,
  });
  expect(owner.assignment.grant_id).toBe(claim.assignment.grant_id);
  await client.call('release_current_assignment');
  const ready = (await create('ready_for_slicing')).work_request.id;
  expect((await client.call('list_work_requests', { status: 'ready_for_slicing' })).work_requests.map((entry: any) => entry.id)).toContain(ready);
  await client.call('read_delivery_board', { work_request_id: ready });
  expect((await client.call('get_current_assignment')).assignment).toBeNull();
  await client.call('slice_work_request', { work_request_id: ready, work_packages: [contract('Automatically claimed work')] });
  expect((await client.call('get_current_assignment')).assignment.grant_role).toBe('architect');
  expect((await client.call('read_work_request', { work_request_id: ready })).work_packages).toHaveLength(1);
});
