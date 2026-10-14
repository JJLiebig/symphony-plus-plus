import { expect } from 'e2e';
import { join } from 'node:path';
import { test, packages, worker } from '../support/authority.js';
import { ageHistory, archives, detail, requestPath, retention, unstarted } from '../support/retention-history.js';

test('never-started retention uses creation age and restore age without inventing completion or deleting history', async ({ processes }) => {
  let factory = processes.factory();
  let client = await factory.client();
  const old = await unstarted(client, 'Unstarted old goal');
  const fresh = await unstarted(client, 'Recent goal');
  await client.call('add_work_request_comment', { work_request_id: old, body: 'History must survive archival.' });
  expect((await client.operator(`${requestPath(old)}/archive`, {})).body.error.code).toBe('not_completed');
  await ageHistory(factory, [{ table: 'sympp_work_requests', id: old, column: 'inserted_at', days: 31 }]);
  factory = processes.factory();
  client = await factory.client();
  // This edit is deliberately recent; it must not restart creation-age retention.
  await client.call('add_work_request_comment', { work_request_id: old, body: 'Recent activity is not a restore.' });
  expect((await archives(client)).map((row: any) => row.id)).not.toContain(old);
  await retention(client);
  const archived = (await archives(client)).find((row: any) => row.id === old);
  expect(archived.archive_reason).toBe('never_started');
  expect(archived.completed_at).toBeNull();
  expect(archived.operational_state.key).toBe('archived');
  expect((await detail(client, old)).status).toBe('draft');
  expect((await archives(client)).map((row: any) => row.id)).not.toContain(fresh);
  await ageHistory(factory, [{ table: 'sympp_work_requests', id: old, column: 'archived_at', days: 90 }]);
  factory = processes.factory();
  client = await factory.client();
  await retention(client, 60);
  expect((await archives(client)).map((row: any) => row.id)).toContain(old);
  expect((await client.call('list_comments', { target_kind: 'work_request', target_id: old })).comments).toHaveLength(2);
  expect((await client.operator(`${requestPath(old)}/restore`, {})).status).toBe(200);
  await retention(client);
  expect((await archives(client)).map((row: any) => row.id)).not.toContain(old);
  expect((await detail(client, old)).completed_at).toBeNull();
  await ageHistory(factory, [{ table: 'sympp_work_requests', id: old, column: 'never_started_restored_at', days: 31 }]);
  factory = processes.factory();
  client = await factory.client();
  await retention(client);
  expect((await archives(client)).map((row: any) => row.id)).toContain(old);
  expect((await client.operator(`${requestPath(old)}/delete`, {})).status).toBe(200);
  expect((await client.operator(`${requestPath(old)}/restore`, {})).status).toBe(404);
  expect((await detail(client, fresh)).id).toBe(fresh);
});

test('actual architect and dispatch evidence protect old goals while completed retention restores and deletes deliberately', async ({ processes }) => {
  let factory = processes.factory();
  let client = await factory.client();
  const claimed = await client.request('Claimed architect protects old request');
  const dispatched = await client.request('Dispatched work protects old request');
  await packages(client, ['Actually dispatched']);
  const finished = await unstarted(client, 'Finished goal');
  const unfinished = await unstarted(client, 'Unfinished comparison');
  await client.call('add_work_request_comment', { work_request_id: finished, body: 'Keep until deliberate deletion.' });
  expect((await client.operator(`${requestPath(finished)}/state`, { state: 'completed' })).status).toBe(200);
  await ageHistory(factory, [
    ...[claimed, dispatched].map((id) => ({ table: 'sympp_work_requests' as const, id, column: 'inserted_at' as const, days: 90 })),
    { table: 'sympp_work_requests', id: finished, column: 'completed_at', days: 4 },
  ]);
  factory = processes.factory();
  client = await factory.client();
  expect((await archives(client)).map((row: any) => row.id)).not.toContain(finished);
  await retention(client);
  const ids = (await archives(client)).map((row: any) => row.id);
  expect(ids).toContain(finished);
  for (const id of [claimed, dispatched, unfinished]) expect(ids).not.toContain(id);
  expect((await client.operator(`${requestPath(finished)}/restore`, {})).status).toBe(200);
  await retention(client);
  expect((await archives(client)).map((row: any) => row.id)).not.toContain(finished);
  expect((await detail(client, finished)).completed_at).toBeTruthy();
  expect((await client.operator(`${requestPath(finished)}/archive`, {})).status).toBe(200);
  await ageHistory(factory, [{ table: 'sympp_work_requests', id: finished, column: 'archived_at', days: 31 }]);
  factory = processes.factory();
  client = await factory.client();
  await retention(client);
  expect((await client.operator(`${requestPath(finished)}/restore`, {})).status).toBe(404);
  // Deliberate deletion also supports an unfinished, never-archived goal.
  expect((await client.operator(`${requestPath(unfinished)}/delete`, {})).status).toBe(200);
  expect((await client.operator(`${requestPath(unfinished)}/restore`, {})).status).toBe(404);
  expect((await detail(client, claimed)).id).toBe(claimed);
});

test('Solo evidence survives restart and lifecycle transitions without creating factory work', async ({ processes }) => {
  let factory = processes.factory();
  let client = await factory.client();
  const scope = { repo: 'example/solo', base_branch: 'beta', workspace_path: join(processes.root, 'workspace'), caller_id: 'solo-owner' };
  const session = (await client.call('solo_attach', { ...scope, title: 'Local evidence' })).solo_session;
  const id = session.id;
  expect((await client.call('solo_attach', { ...scope, repo: ` ${scope.repo} `, workspace_path: `${scope.workspace_path}/.` })).solo_session.id).toBe(id);
  await client.reject('solo_attach', { ...scope, workspace_path: '.' }, 'invalid_workspace_path');
  const active = (await client.call('solo_show', { session_id: id })).solo_session;
  expect((await client.call('solo_resume', { session_id: id })).solo_session.last_activity_at).toBe(active.last_activity_at);
  const progress = { session_id: id, summary: 'Accepted progress', status: 'active', idempotency_key: 'durable-once' };
  const first = (await client.call('solo_append_progress', progress)).entry;
  expect(first.status).toBe('in_progress');
  expect((await client.call('solo_append_progress', { ...progress, summary: 'Changed retry' })).entry.id).toBe(first.id);
  await client.call('solo_record_task_plan', { session_id: id, summary: 'Prove the outcome' });
  await client.call('solo_append_finding', { session_id: id, summary: 'A finding', severity: 'P2' });
  await client.call('solo_record_decision', { session_id: id, decision: 'Keep scope bounded', rationale: 'No factory needed' });
  const blocker = (await client.call('solo_report_blocker', { session_id: id, summary: 'Missing input', blocker_id: 'input' })).entry;
  expect(blocker.status).toBe('blocked');
  const resolved = (await client.call('solo_resolve_blocker', { session_id: id, blocker_id: 'input', resolution: 'Input arrived' })).entry;
  expect(resolved.status).toBe('resolved');
  await client.reject('solo_resolve_blocker', { session_id: id, blocker_id: 'input', resolution: 'Again' }, 'solo_blocker_not_open');
  const validation = (await client.call('solo_record_validation', { session_id: id, summary: 'Hosted proof', result: 'pass' })).entry;
  expect(validation.payload.result).toBe('passed');
  const before = await client.call('solo_show', { session_id: id });
  expect(before.entries.map((row: any) => row.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect((await client.call('solo_list', scope)).solo_sessions.map((row: any) => row.id)).toEqual([id]);
  expect((await client.call('solo_show', { session_id: id })).solo_session.last_activity_at).toBe(before.solo_session.last_activity_at);
  expect((await client.call('list_work_requests')).work_requests).toEqual([]);
  await factory.stop();
  factory = processes.factory();
  client = await factory.client();
  expect((await client.call('solo_show', { session_id: id })).entries).toEqual(before.entries);
  expect((await client.call('solo_pause', { session_id: id })).solo_session.status).toBe('paused');
  expect((await client.call('solo_attach', scope)).solo_session.id).toBe(id);
  await client.call('solo_append_progress', { session_id: id, summary: 'Paused observation', idempotency_key: 'paused-once' });
  expect((await client.call('solo_resume', { session_id: id })).solo_session.status).toBe('active');
  expect((await client.call('solo_complete', { session_id: id })).solo_session.status).toBe('completed');
  expect((await client.call('solo_append_progress', progress)).entry.id).toBe(first.id);
  const denied = await client.rpc('tools/call', { name: 'solo_append_progress', arguments: { session_id: id, summary: 'Late write' } });
  expect(denied.error).toBeTruthy();
  expect((await client.call('solo_archive', { session_id: id })).solo_session.status).toBe('archived');
  expect((await client.call('solo_append_progress', progress)).entry.id).toBe(first.id);
  expect((await client.call('solo_show', { session_id: id })).entries.slice(0, before.entries.length)).toEqual(before.entries);
  const replacement = (await client.call('solo_attach', scope)).solo_session;
  expect(replacement.id).not.toBe(id);
  expect(replacement.status).toBe('active');
  const otherEntry = (await client.call('solo_append_progress', { ...progress, session_id: replacement.id })).entry;
  expect(otherEntry.id).not.toBe(first.id);
  expect(otherEntry.sequence).toBe(1);
  for (let index = 2; index <= 55; index++) await client.call('solo_append_progress', { session_id: replacement.id, summary: `Recent ${index}` });
  const recent = await client.call('solo_show', { session_id: replacement.id });
  expect(recent.entry_count).toBe(55);
  expect(recent.entries_truncated).toBe(true);
  expect(recent.entries.map((row: any) => row.sequence)).toEqual(Array.from({ length: 50 }, (_, index) => index + 6));
});

test('Solo rejects bound mutation, preserves redacted evidence and supports every documented lifecycle edge', async ({ processes }) => {
  const factory = processes.factory();
  const client = await factory.client();
  const scope = { repo: 'example/solo', base_branch: 'beta', workspace_path: processes.root, caller_id: 'solo-boundary' };
  const id = (await client.call('solo_attach', scope)).solo_session.id;
  const secret = 'Bearer synthetic-acceptance-canary';
  const progress = { session_id: id, summary: `Redact ${secret}`, body: `Body ${secret}`,
    payload: { token: secret }, idempotency_key: 'redacted-progress' };
  const entry = (await client.call('solo_append_progress', progress)).entry;
  expect(entry.title).toBe('Redact [REDACTED]');
  expect(entry.body).toBe('Body [REDACTED]');
  expect(entry.payload.token).toBe('[REDACTED]');
  await client.reject('solo_append_progress', { session_id: id, summary: 'Reject secret key', idempotency_key: secret }, 'invalid_entry_idempotency_key');
  const architect = await factory.client();
  await architect.request('Bound sessions cannot mutate Solo');
  const [wp] = await packages(architect, ['Scoped work']);
  const bound = await worker(factory, wp);
  await bound.reject('solo_attach', scope, 'solo_tools_require_unbound_session');
  await bound.reject('solo_pause', { session_id: id }, 'solo_tools_require_unbound_session');
  expect((await client.call('solo_show', { session_id: id })).solo_session.status).toBe('active');
  await bound.call('release_current_assignment');
  expect((await bound.call('solo_attach', scope)).solo_session.id).toBe(id);
  for (const actions of [['archive'], ['pause', 'archive'], ['pause', 'complete', 'archive']] as const) {
    const current = (await client.call('solo_attach', scope)).solo_session.id;
    for (const action of actions) await client.call(`solo_${action}`, { session_id: current });
    const before = await client.call('solo_show', { session_id: current });
    await client.reject('solo_append_progress', { session_id: current, summary: 'Late mutation' }, 'session_not_mutable');
    await client.reject('solo_resume', { session_id: current }, 'invalid_transition');
    expect((await client.call('solo_show', { session_id: current })).solo_session.last_activity_at).toBe(before.solo_session.last_activity_at);
  }
  expect((await client.call('solo_show', { session_id: id })).entries).toEqual([entry]);
});

test('Solo inactivity retention archives and later deletes through operator settings while reads leave activity unchanged', async ({ processes }) => {
  let factory = processes.factory();
  let client = await factory.client();
  const sessions: string[] = [];
  for (const status of ['active', 'paused', 'completed', 'fresh']) {
    const id = (await client.call('solo_attach', { repo: 'example/solo', base_branch: 'beta', workspace_path: processes.root, caller_id: status })).solo_session.id;
    sessions.push(id);
    await client.call('solo_append_progress', { session_id: id, summary: 'History' });
    if (status === 'paused') await client.call('solo_pause', { session_id: id });
    if (status === 'completed') await client.call('solo_complete', { session_id: id });
  }
  await ageHistory(factory, sessions.slice(0, 3).map((id) => ({ table: 'sympp_solo_sessions', id, column: 'last_activity_at', days: 8 })));
  factory = processes.factory();
  client = await factory.client();
  const before = await client.call('solo_show', { session_id: sessions[0] });
  await client.call('solo_list');
  expect((await client.call('solo_show', { session_id: sessions[0] })).solo_session.last_activity_at).toBe(before.solo_session.last_activity_at);
  await retention(client);
  for (const id of sessions.slice(0, 3)) {
    const shown = await client.call('solo_show', { session_id: id });
    expect(shown.solo_session.status).toBe('archived');
    expect(shown.entries).toHaveLength(1);
  }
  expect((await client.call('solo_show', { session_id: sessions[3] })).solo_session.status).toBe('active');
  await ageHistory(factory, sessions.slice(0, 3).map((id) => ({ table: 'sympp_solo_sessions', id, column: 'last_activity_at', days: 15 })));
  factory = processes.factory();
  client = await factory.client();
  await retention(client);
  expect((await client.call('solo_list')).solo_sessions.map((row: any) => row.id)).toEqual([sessions[3]]);
  for (const id of sessions.slice(0, 3)) expect((await client.rpc('tools/call', { name: 'solo_show', arguments: { session_id: id } })).error).toBeTruthy();
});
