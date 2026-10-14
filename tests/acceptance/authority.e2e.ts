import { expect } from 'e2e';
import { Client, contract } from '../support/factory.js';
import { initialize, packages, test, tool, worker } from '../support/authority.js';
import { close, head, pr, prUrl, row, sync, test as deliveryTest } from '../support/delivery.js';

test('HTTP initialization and local origin checks prevent ambient requests from acquiring authority', async ({ processes }) => {
  const factory = processes.factory();
  const endpoint = await factory.endpoint;
  const fresh = new Client(endpoint, factory.receipt);
  const uninitialized = await fresh.raw(tool('create_work_request', {}));
  expect(uninitialized.status).toBe(400);
  expect(uninitialized.body.error.data.reason).toBe('missing_session_id');
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: initialize };
  for (const headers of [
    { origin: 'https://example.invalid' }, { origin: 'null' },
    { origin: 'http://127.0.0.1:1' }, { origin: new URL(endpoint).origin.replace('127.0.0.1', 'localhost') },
  ]) {
    const refused = await fresh.raw(init, headers);
    expect(refused.status).toBe(403);
    expect(refused.body.error.data.reason).toBe('origin_not_allowed');
  }
  for (const headers of [
    { host: 'example.invalid' }, { forwarded: 'for=127.0.0.1' },
    { 'x-forwarded-for': '127.0.0.1' }, { 'x-forwarded-host': 'localhost' },
    { 'x-forwarded-proto': 'http' }, { 'x-real-ip': '127.0.0.1' },
  ]) {
    const refused = await fresh.raw(init, headers);
    expect(refused.status).toBe(403);
    expect(refused.body.error.data.reason).toBe('local_only');
  }
  expect((await fresh.raw(init, { origin: new URL(endpoint).origin })).status).toBe(200);
  expect((await fresh.rpc('initialize', initialize)).error.data.reason).toBe('already_initialized');
  expect((await fresh.call('get_current_assignment')).assignment).toBeNull();
  await fresh.reject('append_progress', { summary: 'Unclaimed mutation', idempotency_key: 'unclaimed' }, 'claim_required');
  const id = await fresh.request('Trusted initialization');
  for (const headers of [{ origin: 'https://example.invalid' }, { 'x-forwarded-for': '127.0.0.1' }]) {
    expect((await fresh.raw(tool('add_work_request_comment', { work_request_id: id, body: 'Denied ambient note', created_by: 'attacker' }), headers)).status).toBe(403);
  }
  const comments = await fresh.call('list_comments', { target_kind: 'work_request', target_id: id });
  expect(comments.comments).toEqual([]);
  expect((await fresh.raw([], {})).body.error.data.reason).toBe('batch_not_supported');
  expect((await fresh.raw('not json', {})).body.error.data.reason).toBe('invalid_json');
  expect((await fresh.raw(null, {}, 'GET')).status).toBe(405);
});

test('architect scope separates same-repository discovery from foreign writes and hides sibling endpoints', async ({ processes }) => {
  const factory = processes.factory();
  const architect = await factory.client();
  const own = await architect.request('Owned request');
  const [ownWp] = await packages(architect, ['Owned package']);
  const peer = await factory.client();
  const other = await peer.request('Other request');
  const question = (await peer.call('ask_question', {
    work_request_id: other, category: 'scope', question: 'Which behavior is required?', why_needed: 'A concrete choice is needed.',
  })).clarification_question;
  const [otherWp] = (await peer.call('slice_work_request', { work_packages: [contract('Hidden sibling')] })).work_package_ids;
  expect((await architect.call('read_work_request', { work_request_id: other })).work_request.id).toBe(other);
  for (const [name, args] of [
    ['set_work_request_status', { work_request_id: other, current_status: 'sliced', next_status: 'clarifying' }],
    ['slice_work_request', { work_request_id: other, work_packages: [contract('Stolen')] }],
    ['dispatch_work_package', { work_request_id: other, work_package_id: otherWp }],
    ['reconcile_work_request', { work_request_id: other, apply: true }],
  ] as const) await architect.reject(name, args, 'outside_session_scope');
  for (const name of ['answer_question', 'close_question']) {
    const denied = await architect.reject(name, {
      work_request_id: own, question_id: question.id, current_status: 'open', answer: 'Stolen', answered_by: 'attacker',
    }, 'not_found');
    expect(JSON.stringify(denied)).not.toContain(other);
  }
  for (const [name, args] of [
    ['update_work_package', { expected_contract_revision: 1, patch: { title: 'Stolen' } }],
    ['skip_work_package', { current_status: 'planned' }],
  ] as const) {
    await architect.reject(name, { work_request_id: own, work_package_id: otherWp, ...args }, 'not_found');
  }
  await architect.reject('upsert_dependency', {
    dependent: { kind: 'work_package', id: ownWp }, prerequisite: { kind: 'work_package', id: otherWp }, reason: 'Foreign endpoint',
  }, 'product_tree_dependency_target_scope');
  const tree = await architect.call('read_plan', { work_request_id: own, view: 'groups_with_work_packages' });
  expect(JSON.stringify(tree)).not.toContain(otherWp);
  const unchanged = await peer.call('read_work_request', { work_request_id: other });
  expect(unchanged.work_request.title).toBe('Other request');
  expect(unchanged.work_packages[0].status).toBe('planned');
  expect(unchanged.clarification_questions.find((entry: any) => entry.id === question.id).status).toBe('open');

  for (const [repo, branch] of [['foreign/service', 'beta'], ['example/service', 'other-branch']]) {
    const outsider = await factory.client();
    const foreign = await outsider.request('Confidential outside scope', 'ready_for_slicing', branch, repo);
    await architect.reject('read_work_request', { work_request_id: foreign }, 'outside_session_scope');
    const listed = await architect.call('list_work_requests', {});
    expect(JSON.stringify(listed)).not.toContain(foreign);
  }
});

test('worker mutations and resources remain confined to its package while explicit local notes preserve provenance', async ({ processes }) => {
  const factory = processes.factory();
  const architect = await factory.client();
  const request = await architect.request('Worker isolation');
  const [own, sibling] = await packages(architect, ['Own worker work', 'Confidential sibling']);
  const client = await worker(factory, own);
  const peer = await worker(factory, sibling, 'peer-worker');
  const siblingComment = (await peer.call('add_comment', { body: 'Private sibling note' })).comment;
  for (const [name, args] of [
    ['read_work_package_document', { document: 'progress.md' }],
    ['append_progress', { summary: 'Stolen', idempotency_key: 'stolen-progress' }],
    ['append_finding', { title: 'Stolen', body: 'Stolen', idempotency_key: 'stolen-finding' }],
    ['attach_branch', { branch: 'feature/authority', head_sha: 'a'.repeat(40) }],
    ['attach_pr', { url: 'https://github.com/example/service/pull/1' }],
  ] as const) await client.reject(name, { work_package_id: sibling, ...args }, 'outside_session_scope');
  await client.reject('list_comments', { target_kind: 'work_package', target_id: sibling }, 'outside_session_scope');
  await client.reject('resolve_comment', { comment_id: siblingComment.id }, 'not_found');
  await client.reject('add_comment', { target_kind: 'work_request', target_id: request, body: 'Wrong capability' }, 'outside_session_scope');
  for (const [name, args] of [
    ['dispatch_work_package', { work_package_id: sibling }],
    ['record_work_package_delivery', { work_package_id: own, outcome: 'completed_no_pr', idempotency_key: 'worker-close', evidence: { completed_no_pr: { no_pr_evidence: 'Unapproved completion' } } }],
    ['reconcile_work_request', { work_request_id: request, apply: true }],
    ['revoke_work_package_worker_key', { work_package_id: sibling, reason: 'Steal authority' }],
    ['force_release_work_package_claim', { work_package_id: sibling, reason: 'Steal authority' }],
  ] as const) await client.reject(name, args, 'architect_grant_required');
  const resources = await client.rpc('resources/list');
  expect(JSON.stringify(resources)).not.toContain(sibling);
  const foreignRead = await client.rpc('resources/read', { uri: `sympp://work-packages/${sibling}/progress.md` });
  expect(foreignRead.error).toBeTruthy();
  expect(JSON.stringify(foreignRead)).not.toContain('Private sibling note');
  const ownContext = await client.call('read_context');
  await client.reject('read_context', { work_package_id: sibling }, 'unexpected_argument');
  await client.reject('read_task_plan', { work_package_id: sibling }, 'unexpected_argument');
  expect(JSON.stringify(ownContext)).not.toContain('Confidential sibling');
  expect(JSON.stringify(ownContext)).not.toContain('Private sibling note');
  const comment = (await client.call('add_comment', { body: 'Review sk-synthetic-secret before completion' })).comment;
  expect(comment.body).toContain('[REDACTED]');
  expect(comment.body).not.toContain('sk-synthetic-secret');
  expect((await client.call('resolve_comment', { comment_id: comment.id, resolution_note: 'Addressed' })).comment.status).toBe('resolved');
  const note = await client.call('add_work_request_comment', { work_request_id: request, body: 'An explicit local operator note' });
  expect(note.comment.body).toBe('An explicit local operator note');
  expect(note.comment.author_name).toBe('acceptance-worker');
  expect((await peer.call('list_comments')).comments[0].status).toBe('open');
  expect((await peer.call('read_work_package_document', { document: 'progress.md' })).progress_events).toEqual([]);
});

test('force release rotates worker authority without changing delivery and allows a new owner', async ({ processes }) => {
  const factory = processes.factory();
  const architect = await factory.client();
  const request = await architect.request('Authority transfer');
  const [wp, sibling] = await packages(architect, ['Transfer ownership', 'Leave sibling alone']);
  const previous = await worker(factory, wp, 'previous-worker');
  const peer = await worker(factory, sibling, 'peer-worker');
  const mutation = { summary: 'Original observation', idempotency_key: 'transfer-once' };
  const first = (await previous.call('append_progress', mutation)).progress_event;
  await previous.call('release_current_assignment', { reason: 'Finished local session' });
  const replacement = await factory.client();
  const reserved = await replacement.rpc('tools/call', { name: 'claim_local_assignment', arguments: { work_package_id: wp, claimed_by: 'replacement-worker' } });
  expect(reserved.error).toBeTruthy();
  // This is intentionally a documented cross-WorkRequest architect operation.
  const recoveryArchitect = await factory.client();
  await recoveryArchitect.request('Independent recovery operator');
  const released = await recoveryArchitect.call('force_release_work_package_claim', { work_package_id: wp, reason: 'Replace stale reservation; Bearer synthetic-release-secret' });
  expect(released.reset_worker_grant_ids).toHaveLength(1);
  expect(JSON.stringify(released)).not.toContain('synthetic-release-secret');
  const before = (await architect.call('read_work_request', { work_request_id: request })).work_packages.find((entry: any) => entry.id === wp);
  expect(before.status).toBe('active');
  expect((await row(architect, request, wp)).delivery_outcome).toBeNull();
  await replacement.call('claim_local_assignment', { work_package_id: wp, claimed_by: 'replacement-worker' });
  expect((await replacement.call('get_current_assignment')).assignment.claimed_by).toBe('replacement-worker');
  expect((await previous.rpc('tools/call', { name: 'append_progress', arguments: { ...mutation, idempotency_key: 'old-owner' } })).error).toBeTruthy();
  expect((await replacement.call('append_progress', mutation)).progress_event.id).toBe(first.id);
  expect((await peer.call('get_current_assignment')).assignment.work_package_id).toBe(sibling);
  const document = await replacement.call('read_work_package_document', { document: 'progress.md' });
  expect(document.progress_events.filter((event: any) => event.idempotency_key === 'old-owner')).toEqual([]);
});

test('explicit revocation retires live worker calls resources and persisted recovery without touching siblings', async ({ processes }) => {
  const factory = processes.factory();
  const architect = await factory.client();
  const request = await architect.request('Revoke a worker');
  const [wp, sibling] = await packages(architect, ['Recycled worker', 'Still valid']);
  const client = await worker(factory, wp);
  const peer = await worker(factory, sibling, 'peer-worker');
  const assignment = (await client.call('get_current_assignment')).assignment;
  const first = (await client.call('append_progress', { summary: 'Before revocation', idempotency_key: 'revoked-once' })).progress_event;
  const revoked = await architect.call('revoke_work_package_worker_key', { work_package_id: wp, grant_id: assignment.grant_id, reason: 'Scope was recut' });
  expect(revoked.work_package.status).toBe('blocked');
  expect(revoked.revoked_worker_grant.id).toBe(assignment.grant_id);
  for (const [name, args] of [
    ['append_progress', { summary: 'Before revocation', idempotency_key: 'revoked-once' }],
    ['append_finding', { title: 'After revocation', body: 'Must not persist', idempotency_key: 'revoked-finding' }],
    ['read_work_package_document', { document: 'context.md' }],
  ] as const) expect((await client.rpc('tools/call', { name, arguments: args })).error).toBeTruthy();
  expect((await client.rpc('resources/read', { uri: `sympp://work-packages/${wp}/progress.md` })).error).toBeTruthy();
  const fresh = await factory.client();
  expect((await fresh.rpc('tools/call', { name: 'claim_local_assignment', arguments: { work_package_id: wp, claimed_by: 'replacement' } })).error).toBeTruthy();
  const document = await architect.call('read_work_package_document', { work_package_id: wp, document: 'progress.md' });
  expect(document.progress_events.filter((event: any) => event.id === first.id)).toHaveLength(1);
  expect((await peer.call('get_current_assignment')).assignment.work_package_id).toBe(sibling);
  await factory.stop();
  const restarted = processes.factory();
  expect((await client.reconnect(await restarted.endpoint).raw(tool('read_context'))).body.error).toBeTruthy();
  expect((await peer.reconnect(await restarted.endpoint).call('get_current_assignment')).assignment.work_package_id).toBe(sibling);
  expect((await architect.reconnect(await restarted.endpoint).call('read_work_request', { work_request_id: request })).work_packages.find((entry: any) => entry.id === wp).status).toBe('blocked');
});

test('superseded and no-PR delivery retire live claims and prevent terminal worker mutations', async ({ processes }) => {
  const factory = processes.factory();
  const architect = await factory.client();
  const request = await architect.request('Retire terminal scope');
  const [superseded, completed, successor, unclaimed] = await packages(architect, ['Old scope', 'Accepted research', 'New scope', 'Unclaimed old scope']);
  const old = await worker(factory, superseded);
  const research = await worker(factory, completed, 'research-worker');
  const supersede = (wp: string) => close(architect, wp, 'superseded', { successor_work_package_id: successor, superseded_reason: 'A bounded successor owns this scope.' });
  const invalidSuccessor = await factory.client();
  await invalidSuccessor.request('Foreign successor owner');
  const [foreign] = await packages(invalidSuccessor, ['Foreign successor']);
  await architect.reject('record_work_package_delivery', {
    work_package_id: superseded, outcome: 'superseded', idempotency_key: 'foreign-successor',
    evidence: { superseded: { successor_work_package_id: foreign, superseded_reason: 'Must be refused' } },
  }, 'not_found');
  expect((await old.call('get_current_assignment')).assignment.work_package_id).toBe(superseded);
  await supersede(superseded);
  await supersede(unclaimed);
  await close(architect, completed);
  for (const [client, wp] of [[old, superseded], [research, completed]] as const) {
    expect((await client.rpc('tools/call', { name: 'append_progress', arguments: { summary: 'Terminal mutation', idempotency_key: 'terminal' } })).error).toBeTruthy();
    const fresh = await factory.client();
    expect((await fresh.rpc('tools/call', { name: 'claim_local_assignment', arguments: { work_package_id: wp, claimed_by: 'terminal-reclaim' } })).error).toBeTruthy();
    expect((await architect.call('read_work_package_document', { work_package_id: wp, document: 'progress.md' })).progress_events.filter((event: any) => event.idempotency_key === 'terminal')).toEqual([]);
  }
  const fresh = await factory.client();
  expect((await fresh.rpc('tools/call', { name: 'claim_local_assignment', arguments: { work_package_id: unclaimed } })).error).toBeTruthy();
  expect((await row(architect, request, superseded)).delivery_outcome).toBe('superseded');
  expect((await row(architect, request, completed)).delivery_outcome).toBe('completed_no_pr');
  await close(architect, successor);
  expect((await architect.operator(`/api/v1/sympp/operator/work-requests/${request}/archive`, {})).status).toBe(200);
  const refused = await architect.rpc('tools/call', { name: 'slice_work_request', arguments: { work_packages: [contract('Archived scope')] } });
  expect(refused.error).toBeTruthy();
  expect((await fresh.rpc('tools/call', { name: 'claim_local_architect_assignment', arguments: { work_request_id: request } })).error).toBeTruthy();
});

deliveryTest('provider-confirmed merge retires a claimed worker and preserves unrelated worker authority', async ({ delivery: { factory, provider } }) => {
  const architect = await factory.client();
  const request = await architect.request('Merged authority retirement');
  const [wp, sibling] = await packages(architect, ['Merged change', 'Independent change']);
  const client = await worker(factory, wp);
  const peer = await worker(factory, sibling, 'peer-worker');
  provider.set(301, pr(301, head('a')));
  await sync(architect, wp, 301, head('a'));
  provider.set(301, pr(301, head('a'), { state: 'MERGED', mergedAt: new Date().toISOString(), mergeCommit: { oid: head('f') } }));
  await architect.call('sync_pr', { work_package_id: wp });
  expect((await row(architect, request, wp)).delivery_outcome).toBe('pr_merged');
  expect((await client.rpc('tools/call', { name: 'append_progress', arguments: { summary: 'Late mutation', idempotency_key: 'late' } })).error).toBeTruthy();
  expect((await client.rpc('resources/read', { uri: `sympp://work-packages/${wp}/context.md` })).error).toBeTruthy();
  expect((await peer.call('get_current_assignment')).assignment.work_package_id).toBe(sibling);
  expect((await architect.call('read_work_package_document', { work_package_id: wp, document: 'progress.md' })).progress_events.filter((event: any) => event.idempotency_key === 'late')).toEqual([]);
});

test('worker plan updates are atomic and native evidence history remains complete across concurrent appends', async ({ processes }) => {
  const factory = processes.factory();
  const architect = await factory.client();
  await architect.request('Worker planning and history');
  const [wp, sibling] = await packages(architect, ['Plan owner', 'Other plan']);
  const client = await worker(factory, wp);
  const peer = await worker(factory, sibling, 'peer-worker');
  const initial = await client.call('read_task_plan');
  const plan = await client.call('update_task_plan', { expected_version: initial.version, nodes: [{ title: 'Own node' }] });
  const ownNode = plan.plan_nodes[0].id;
  const peerPlan = await peer.call('read_task_plan');
  const foreignNode = (await peer.call('update_task_plan', { expected_version: peerPlan.version, nodes: [{ title: 'Sibling node' }] })).plan_nodes[0].id;
  const before = await client.call('read_task_plan');
  for (const invalid of [foreignNode, 'plan_missing']) {
    await client.reject('update_task_plan', { expected_version: before.version, nodes: [{ id: ownNode, status: 'done' }, { id: invalid, title: 'Do not insert' }] }, 'unknown_plan_node');
    expect(await client.call('read_task_plan')).toEqual(before);
  }
  await client.reject('update_task_plan', { expected_version: before.version, nodes: [{ id: ownNode, status: 'invalid' }] }, 'invalid_status');
  expect(await client.call('read_task_plan')).toEqual(before);
  const changed = await client.call('update_task_plan', { expected_version: before.version, nodes: [{ id: ownNode, body: 'Working', status: 'in_progress' }, { title: 'Additional task', status: 'done' }] });
  expect(changed.plan_nodes.map((node: any) => node.status)).toEqual(['in_progress', 'done']);
  await client.reject('update_task_plan', { expected_version: before.version, nodes: [{ id: ownNode, status: 'done' }] }, 'stale_plan_version');
  expect((await peer.call('read_task_plan')).text).toContain('Sibling node');
  const first = await client.call('append_finding', { id: 'synthetic-finding', title: 'Finding', body: 'Evidence', idempotency_key: ' finding-once ' });
  expect((await client.call('append_finding', { id: 'synthetic-finding', title: 'Finding', body: 'Evidence', idempotency_key: 'finding-once' })).finding.id).toBe(first.finding.id);
  await client.reject('append_finding', { id: 'different-finding', title: 'Finding', body: 'Evidence', idempotency_key: 'finding-once' }, 'idempotency_conflict');
  await client.reject('append_finding', { id: 'synthetic-finding', title: 'Finding', body: 'Evidence', idempotency_key: 'other-key' }, 'idempotency_conflict');
  for (let index = 1; index <= 205; index++) {
    await client.call('append_progress', { summary: `Progress ${index}`, idempotency_key: `page-${index}` });
    await client.call('append_finding', { title: `Finding ${index}`, body: `Evidence ${index}`, idempotency_key: `page-${index}` });
  }
  for (const [document, collection, total] of [['progress.md', 'progress_events', 205], ['findings.md', 'findings', 206]] as const) {
    const latest = await client.call('read_work_package_document', { document, future_field: true });
    expect(latest[collection]).toHaveLength(100);
    const boundary = latest.next_before_sequence;
    await client.call('append_progress', { summary: 'Concurrent append', idempotency_key: `concurrent-${document}` });
    await client.call('append_finding', { title: 'Concurrent append', body: 'Must stay above cursor', idempotency_key: `concurrent-${document}` });
    const older = await client.call('read_work_package_document', { document, before_sequence: boundary });
    const oldest = await client.call('read_work_package_document', { document, before_sequence: older.next_before_sequence });
    const ids = [...latest[collection], ...older[collection], ...oldest[collection]].map((entry: any) => entry.id);
    // Findings also contain the concurrent append from the preceding progress pass.
    expect(new Set(ids).size).toBe(total + (document === 'findings.md' ? 1 : 0));
    expect(new Set(ids).size).toBe(ids.length);
    expect(oldest.next_before_sequence).toBeNull();
    expect(older[collection].every((entry: any) => entry.sequence < boundary)).toBe(true);
  }
  for (const document of ['context.md', 'task_plan.md', 'findings.md', 'progress.md', 'acceptance.md', 'review.md', 'handoff.md']) {
    const native = await client.rpc('tools/call', { name: 'read_work_package_document', arguments: { document } });
    const resource = await client.rpc('resources/read', { uri: `sympp://work-packages/${wp}/${document}` });
    expect(native.result.content[0].text).toBe(resource.result.contents[0].text);
  }
});

deliveryTest('worker provider evidence resists spoofing mismatch failure and replay while preserving ready state', async ({ delivery: { factory, provider } }) => {
  const architect = await factory.client();
  const request = await architect.request('Worker provider evidence');
  const [wp] = await packages(architect, ['Provider-qualified work']);
  const client = await worker(factory, wp);
  for (const type of ['branch', 'pr']) await client.call('append_progress', { summary: `Spoof ${type}`, idempotency_key: `spoof-${type}`, payload: { type, source_tool: `attach_${type}` } });
  expect((await client.rpc('tools/call', { name: 'mark_ready', arguments: {} })).error).toBeTruthy();
  await client.call('attach_branch', { branch: 'feature/authority', head_sha: head('a'), idempotency_key: 'branch-once' });
  await client.call('attach_pr', { url: prUrl(302), head_sha: head('a') });
  provider.set(302, pr(302, head('a'), { headRefName: 'feature/authority' }));
  const args = { idempotency_key: 'provider-once', url: prUrl(302) };
  const observed = (await client.call('sync_pr', args)).progress_event;
  const providerCalls = provider.calls.length;
  provider.replies.set(302, { stdout: 'Provider offline', exitCode: 1 });
  expect((await client.call('sync_pr', args)).progress_event.id).toBe(observed.id);
  expect(provider.calls).toHaveLength(providerCalls);
  const document = await client.call('read_work_package_document', { document: 'progress.md' });
  for (const reply of [{ stdout: 'Provider offline', exitCode: 1 }, { stdout: 'not json', exitCode: 0 }]) {
    provider.replies.set(302, reply);
    expect((await client.rpc('tools/call', { name: 'sync_pr', arguments: {} })).error).toBeTruthy();
    expect(await client.call('read_work_package_document', { document: 'progress.md' })).toEqual(document);
  }
  await client.reject('sync_pr', { url: prUrl(303) }, 'pr_reference_mismatch');
  provider.set(302, pr(302, head('b'), { headRefName: 'feature/authority' }));
  await client.reject('sync_pr', {}, 'provider_head_mismatch');
  expect(await client.call('read_work_package_document', { document: 'progress.md' })).toEqual(document);
  await client.reject('sync_pr', { check_summary: { status: 'passing' } }, 'unexpected_argument');
  const recovery = { url: prUrl(302), head_sha: head('a'), branch: 'feature/authority', base_branch: 'beta',
    observed_at: '', check_summary: { status: 'passing' }, review_state: { status: 'approved' }, merge_state: { status: 'clean', merged: false } };
  const imported = (await client.call('sync_pr', { recovery, idempotency_key: 'recovery-once' })).progress_event;
  expect((await client.call('sync_pr', { recovery, idempotency_key: 'recovery-once' })).progress_event.id).toBe(imported.id);
  await client.reject('sync_pr', { recovery: { ...recovery, check_summary: { status: 'failing' } }, idempotency_key: 'recovery-once' }, 'idempotency_conflict');
  await client.reject('sync_pr', { recovery: { ...recovery, check_summary: { status: 'green' } } }, 'invalid_recovery');
  await client.call('attach_branch', { branch: 'feature/authority', head_sha: head('b') });
  expect((await client.rpc('tools/call', { name: 'mark_ready', arguments: {} })).error).toBeTruthy();
  await client.call('attach_pr', { url: prUrl(302), head_sha: head('b') });
  await client.call('sync_pr');
  expect((await client.call('mark_ready')).work_package.status).toBe('ready_for_merge');
  expect((await row(architect, request, wp)).delivery_outcome).toBeNull();
  expect((await client.call('sync_pr', args)).progress_event.id).toBe(observed.id);
});

test('docs and investigation workers become ready with truthful evidence and abandon cannot keep mutation authority', async ({ processes }) => {
  const factory = processes.factory();
  const architect = await factory.client();
  const request = await architect.request('Non-code readiness');
  const ids = (await architect.call('slice_work_request', { work_packages: [
    contract('Document the decision', { kind: 'docs' }), contract('Investigate behavior', { kind: 'investigation' }), contract('Abandon obsolete work'),
  ] })).work_package_ids;
  for (const id of ids) await architect.call('dispatch_work_package', { work_package_id: id });
  const docs = await worker(factory, ids[0], 'docs-worker');
  const investigation = await worker(factory, ids[1], 'investigation-worker');
  const abandoned = await worker(factory, ids[2], 'abandoned-worker');
  expect((await docs.call('mark_ready')).work_package.status).toBe('ready_for_merge');
  const missing = await investigation.reject('mark_ready', {}, 'readiness_failed');
  expect(missing.missing).toContain('findings_documented');
  await investigation.call('append_finding', { title: 'Cause found', body: 'No code change is necessary.', idempotency_key: 'research' });
  expect((await investigation.call('mark_ready')).work_package.status).toBe('ready_for_merge');
  expect((await abandoned.call('abandon', { reason: 'Scope no longer needed' })).work_package.status).toBe('abandoned');
  expect((await abandoned.rpc('tools/call', { name: 'append_progress', arguments: { summary: 'Must not reactivate', idempotency_key: 'after-abandon' } })).error).toBeTruthy();
  await close(architect, ids[2], 'abandoned', { rationale: 'The scope was explicitly dropped; no code was changed.' });
  expect((await row(architect, request, ids[2])).delivery_outcome).toBe('abandoned');
});

test('claim scope hints reject different repository branch and request before granting worker authority', async ({ processes }) => {
  const factory = processes.factory();
  const architect = await factory.client();
  const request = await architect.request('Claim scope');
  const [wp] = await packages(architect, ['Scoped worker']);
  const outsider = await factory.client();
  const foreign = await outsider.request('Foreign claim target');
  for (const [hints, reason] of [
    [{ repo: 'foreign/service' }, 'repo_scope_mismatch'],
    [{ base_branch: 'wrong-base' }, 'base_branch_scope_mismatch'],
    [{ branch: 'wrong-branch' }, 'branch_scope_mismatch'],
    [{ work_request_id: foreign }, 'work_request_package_link_mismatch'],
  ] as const) {
    const client = await factory.client();
    await client.reject('claim_local_assignment', { work_package_id: wp, claimed_by: 'scope-attacker', ...hints }, reason);
    expect((await client.call('get_current_assignment')).assignment).toBeNull();
    expect((await architect.call('read_work_request', { work_request_id: request })).work_packages[0].status).toBe('ready_for_worker');
  }
  const valid = await worker(factory, wp);
  expect((await valid.call('read_context')).work_package.id).toBe(wp);
  const wrongArchitect = await factory.client();
  for (const [hints, reason] of [
    [{ repo: 'foreign/service' }, 'repo_scope_mismatch'],
    [{ base_branch: 'wrong-base' }, 'base_branch_scope_mismatch'],
    [{ phase_id: 'foreign-phase' }, 'phase_scope_mismatch'],
    [{ architect_anchor_work_package_id: wp }, 'architect_anchor_scope_mismatch'],
  ] as const) await wrongArchitect.reject('claim_local_architect_assignment', { work_request_id: request, claimed_by: 'scope-attacker', ...hints }, reason);
});
