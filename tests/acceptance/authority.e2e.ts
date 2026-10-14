import { expect } from 'e2e';
import { Client, contract } from '../support/factory.js';
import { initialize, packages, test, tool, worker } from '../support/authority.js';

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
    category: 'scope', question: 'Which behavior is required?', why_needed: 'A concrete choice is needed.',
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
    ['read_context', {}], ['read_task_plan', {}],
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
