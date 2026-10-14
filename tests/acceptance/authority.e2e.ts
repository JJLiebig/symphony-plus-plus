import { expect } from 'e2e';
import { Client, contract } from '../support/factory.js';
import { initialize, packages, test, tool, worker } from '../support/authority.js';
import { close, head, pr, prUrl, row, test as deliveryTest } from '../support/delivery.js';

test('HTTP initialization and local origin checks prevent ambient requests from acquiring authority', async ({ processes }) => {
  const factory = processes.factory();
  const endpoint = await factory.endpoint;
  const fresh = new Client(endpoint, factory.receipt);
  const uninitialized = await fresh.raw(tool('create_work_request', {}));
  expect(uninitialized.status).toBe(400);
  expect(uninitialized.body.error.data.reason).toBe('missing_session_id');
  for (const name of ['add_work_request_comment', 'record_work_request_operator_decision']) {
    expect((await fresh.raw(tool(name, {}))).body.error.data.reason).toBe('missing_session_id');
  }
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: initialize };
  const list = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
  const concurrent = Array.from({ length: 20 }, () => new Client(endpoint, factory.receipt));
  const initialized = await Promise.all(concurrent.map((client) => client.raw(init)));
  expect(initialized.every((response) => response.status === 200 && response.sessionId)).toBe(true);
  expect(new Set(initialized.map((response) => response.sessionId)).size).toBe(20);
  for (const client of concurrent) expect((await client.rpc('tools/list')).result.tools.length).toBeGreaterThan(0);
  for (const batch of [[init], [init, list]]) {
    expect((await fresh.raw(batch)).body.error.data.reason).toBe('batch_not_supported');
  }
  expect((await fresh.raw({ ...init, params: { protocolVersion: '2025-03-26' } })).body.error.data.reason).toBe('invalid_initialize_params');
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
  const unboundResources = await fresh.rpc('resources/list');
  expect(unboundResources.result.resources.every((entry: any) => entry.uri.startsWith('sympp://health/'))).toBe(true);
  for (const uri of ['sympp://work-packages/', 'sympp://work-packages//task_plan.md', 'sympp://work-packages/missing/', 'sympp://work-packages/missing//task_plan.md', 'sympp://work-packages/missing/path/to/file.md']) {
    const invalid = await fresh.rpc('resources/read', { uri });
    expect(invalid.error.data.reason).toBe('invalid_work_package_resource_uri');
    expect(invalid.error.code).toBe(-32602);
  }
  await fresh.reject('append_progress', { summary: 'Unclaimed mutation', idempotency_key: 'unclaimed' }, 'claim_required');
  const id = await fresh.request('Trusted initialization');
  const bound = await fresh.call('get_current_assignment');
  expect((await fresh.rpc('initialize', initialize)).error.data.reason).toBe('already_initialized');
  expect((await fresh.call('get_current_assignment')).assignment.work_package_id).toBe(bound.assignment.work_package_id);
  const omittedHealthArgs = await fresh.rpc('tools/call', { name: 'sympp.health' });
  expect(omittedHealthArgs.result.structuredContent.status).toBe('ok');
  expect(JSON.stringify(omittedHealthArgs)).not.toContain(id);
  expect((await fresh.rpc('tools/call', { name: 'sympp.health', arguments: { unexpected: true } })).error.data.reason).toBe('invalid_tool_arguments');
  for (const headers of [{ origin: 'https://example.invalid' }, { 'x-forwarded-for': '127.0.0.1' }]) {
    expect((await fresh.raw(tool('add_work_request_comment', { work_request_id: id, body: 'Denied ambient note', created_by: 'attacker' }), headers)).status).toBe(403);
  }
  const comments = await fresh.call('list_comments', { target_kind: 'work_request', target_id: id });
  expect(comments.comments).toEqual([]);
  for (const batch of [[], [list], [init, list]]) {
    expect((await fresh.raw(batch)).body.error.data.reason).toBe('batch_not_supported');
  }
  expect((await fresh.raw('not json', {})).body.error.data.reason).toBe('invalid_json');
  expect((await fresh.raw(null, {}, 'GET')).status).toBe(405);
  for (const value of ['missing-session', '__sympp_mcp_current_state__', '\u00ff']) {
    const refused = await fresh.raw(tool('get_current_assignment'), { 'mcp-session-id': value });
    expect(refused.status).toBe(value === 'missing-session' ? 404 : 400);
    expect(refused.body.error.data.reason).toBe(value === 'missing-session' ? 'unknown_state_key' : 'invalid_session_id');
  }
  for (const payload of [init, list, { jsonrpc: '2.0', method: 'notifications/initialized' }]) {
    const unknown = await fresh.raw(payload, { 'mcp-session-id': 'missing-session' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.data.reason).toBe('unknown_state_key');
  }
  const notification = await fresh.raw({ jsonrpc: '2.0', method: 'notifications/initialized' });
  expect(notification.status).toBe(202);
  expect(notification.body).toBeNull();
  expect((await fresh.call('read_work_request', { work_request_id: id })).work_request.id).toBe(id);
});

test('architect scope separates same-repository discovery from foreign writes and hides sibling endpoints', async ({ processes }) => {
  const factory = processes.factory();
  const architect = await factory.client();
  const own = await architect.request('Owned request', 'ready_for_slicing', 'beta', 'example/service', [
    { repo: 'example/service', base_branch: 'integration' },
  ]);
  const [ownWp] = await packages(architect, ['Owned package']);
  const malformedQuestion = await architect.reject('ask_question', { work_request_id: own, category: 'scope',
    question: 'Continue implementation?', why_needed: 'A choice is required.',
    decision_prompt: { tl_dr: 'Private malformed prompt sentinel', details: 'Missing options' },
  }, 'decision_prompt must contain 1 to 4 options');
  expect(JSON.stringify(malformedQuestion)).not.toContain('Private malformed prompt sentinel');
  expect((await architect.call('read_work_request', { work_request_id: own })).clarification_questions).toEqual([]);
  const peer = await factory.client();
  const other = await peer.request('Other request');
  const [otherWp] = (await peer.call('slice_work_request', { work_packages: [contract('Hidden sibling')] })).work_package_ids;
  const question = (await peer.call('ask_question', {
    work_request_id: other, category: 'scope', question: 'Which behavior is required?', why_needed: 'A concrete choice is needed.',
  })).clarification_question;
  expect((await architect.call('read_work_request', { work_request_id: other })).work_request.id).toBe(other);
  for (const [name, args] of [
    ['set_work_request_status', { work_request_id: other, current_status: 'sliced', next_status: 'clarifying' }],
    ['slice_work_request', { work_request_id: other, work_packages: [contract('Stolen')] }],
    ['dispatch_work_package', { work_request_id: other, work_package_id: otherWp }],
    ['reconcile_work_request', { work_request_id: other, apply: true }],
    ['record_work_package_delivery', { work_request_id: other, work_package_id: otherWp, outcome: 'completed_no_pr', idempotency_key: 'foreign-close', evidence: { completed_no_pr: { no_pr_evidence: 'Refuse foreign closeout' } } }],
    ['sync_pr', { work_request_id: own, work_package_id: otherWp }],
  ] as const) await architect.reject(name, args, 'not_found');
  await architect.reject('dispatch_work_package', { work_request_id: own, work_package_id: 'missing-package' }, 'not_found');
  for (const [name, fields] of [
    ['answer_question', { answer: 'Stolen', answered_by: 'attacker' }],
    ['close_question', {}],
  ] as const) {
    const denied = await architect.reject(name, {
      work_request_id: own, question_id: question.id, current_status: 'open', ...fields,
    }, 'not_found');
    expect(JSON.stringify(denied)).not.toContain(other);
  }
  for (const [name, args] of [
    ['update_work_package', { expected_contract_revision: 1, patch: { title: 'Stolen' } }],
    ['skip_work_package', { current_status: 'planned' }],
  ] as const) {
    await architect.reject(name, { work_request_id: own, work_package_id: otherWp, ...args }, 'not_found');
  }
  const foreignDependency = await architect.rpc('tools/call', { name: 'upsert_dependency', arguments: {
    dependent: { kind: 'work_package', id: ownWp }, prerequisite: { kind: 'work_package', id: otherWp }, reason: 'Foreign endpoint',
  } });
  expect(foreignDependency.error.code).toBe(-32602);
  expect(foreignDependency.error.data.reason).toContain('product_tree_dependency_target_scope');
  const tree = await architect.call('read_plan', { work_request_id: own, view: 'groups_with_work_packages' });
  expect(JSON.stringify(tree)).not.toContain(otherWp);
  const unchanged = await peer.call('read_work_request', { work_request_id: other });
  expect(unchanged.work_request.title).toBe('Other request');
  expect(unchanged.work_packages[0].status).toBe('planned');
  expect(unchanged.clarification_questions.find((entry: any) => entry.id === question.id).status).toBe('open');
  await peer.call('dispatch_work_package', { work_package_id: otherWp });
  const siblingWorker = await worker(factory, otherWp, 'sibling-worker');
  const siblingGrant = (await siblingWorker.call('get_current_assignment')).assignment.grant_id;
  await architect.reject('revoke_work_package_worker_key', { work_request_id: other, work_package_id: otherWp,
    grant_id: siblingGrant, reason: 'Refuse foreign revoke',
  }, 'not_found');
  expect((await siblingWorker.call('get_current_assignment')).assignment.grant_id).toBe(siblingGrant);

  const secondary = await factory.client();
  await secondary.request('Secondary repository reader', 'ready_for_slicing', 'integration', 'example/client');
  expect((await secondary.call('read_work_request', { work_request_id: own })).work_request.id).toBe(own);
  await secondary.reject('set_work_request_status', { work_request_id: own, current_status: 'sliced', next_status: 'clarifying' }, 'not_found');
  const [secondaryWp] = (await architect.call('slice_work_request', { work_packages: [contract('Secondary delivery', { repo: 'example/client', base_branch: 'integration' })] })).work_package_ids;
  await architect.call('dispatch_work_package', { work_package_id: secondaryWp });
  const secondaryWorker = await worker(factory, secondaryWp, 'secondary-worker');
  expect((await secondaryWorker.call('read_context')).work_package.base_branch).toBe('integration');
  const scopedBoard = (await secondary.call('read_delivery_board', { work_request_id: own })).delivery_board;
  const hiddenRow = scopedBoard.work_packages.find((entry: any) => entry.id === ownWp);
  expect(hiddenRow.work_package).toBeNull();
  expect(hiddenRow['work_package_hidden?']).toBe(true);
  expect(hiddenRow.attention_reason_codes).toEqual([]);
  expect(scopedBoard.work_packages.find((entry: any) => entry.id === secondaryWp).work_package.id).toBe(secondaryWp);
  const parentGroup = (await architect.call('upsert_group', { title: 'Visible ancestor' })).group.id;
  const visibleGroup = (await architect.call('upsert_group', { title: 'Visible secondary group', parent_group_id: parentGroup })).group.id;
  const hiddenGroup = (await architect.call('upsert_group', { title: 'Confidential primary group' })).group.id;
  for (const [wp, group] of [[ownWp, hiddenGroup], [secondaryWp, visibleGroup]]) {
    await architect.call('update_work_package', { work_package_id: wp, expected_contract_revision: 1, patch: { group_id: group } });
  }
  const scopedPlan = await secondary.call('read_plan', { work_request_id: own, view: 'groups_with_work_packages' });
  expect(scopedPlan.product_tree.groups.map((entry: any) => entry.id).sort()).toEqual([parentGroup, visibleGroup].sort());
  expect(JSON.stringify(scopedPlan)).not.toContain('Confidential primary group');
  await peer.reject('update_work_package', { work_package_id: otherWp, expected_contract_revision: 1, patch: { group_id: visibleGroup } }, 'not_found');
  const dependencyArgs = { dependent: { kind: 'group', id: hiddenGroup }, prerequisite: { kind: 'work_package', id: secondaryWp }, reason: 'Scoped dependency' };
  const dependency = (await architect.call('upsert_dependency', dependencyArgs)).dependency.id;
  const beforeEdges = (await architect.call('read_plan', { work_request_id: own, view: 'groups_with_work_packages' })).product_tree.dependency_intents;
  const foreignUpdate = await architect.rpc('tools/call', { name: 'upsert_dependency', arguments: {
    ...dependencyArgs, dependency_id: dependency, prerequisite: { kind: 'work_package', id: otherWp },
  } });
  expect(foreignUpdate.error.code).toBe(-32602);
  expect(foreignUpdate.error.data.reason).toContain('product_tree_dependency_target_scope');
  expect((await architect.call('read_plan', { work_request_id: own, view: 'groups_with_work_packages' })).product_tree.dependency_intents).toEqual(beforeEdges);
  await close(architect, ownWp);
  const hiddenTerminal = await row(secondary, own, ownWp);
  expect(hiddenTerminal.work_package).toBeNull();
  expect(hiddenTerminal['work_package_hidden?']).toBe(true);
  expect(hiddenTerminal.operational_state.key).toBe('completed_no_pr');
  expect(hiddenTerminal.attention_reason_codes).toEqual([]);
  const sameRepoReader = await factory.client();
  await sameRepoReader.request('Same repository different delivery base', 'ready_for_slicing', 'integration');
  const [alternateBase] = (await architect.call('slice_work_request', { work_packages: [contract('Alternate delivery base', { base_branch: 'integration' })] })).work_package_ids;
  await architect.call('dispatch_work_package', { work_package_id: alternateBase });
  const alternateWorker = await worker(factory, alternateBase, 'alternate-base-worker');
  expect((await alternateWorker.call('read_context')).work_package.base_branch).toBe('integration');
  const baseBoard = (await sameRepoReader.call('read_delivery_board', { work_request_id: own })).delivery_board;
  expect(baseBoard.work_packages.find((entry: any) => entry.id === alternateBase).work_package.id).toBe(alternateBase);
  expect(baseBoard.work_packages.find((entry: any) => entry.id === ownWp).work_package).toBeNull();
  await sameRepoReader.reject('record_work_package_delivery', { work_request_id: own, work_package_id: ownWp, outcome: 'completed_no_pr',
    idempotency_key: 'wrong-delivery-base', evidence: { completed_no_pr: { no_pr_evidence: 'Refuse hidden-base closeout' } },
  }, 'not_found');

  for (const [repo, branch] of [['foreign/service', 'beta'], ['example/service', 'other-branch']]) {
    const outsider = await factory.client();
    const foreign = await outsider.request('Confidential outside scope', 'ready_for_slicing', branch, repo);
    await architect.reject('read_work_request', { work_request_id: foreign }, 'not_found');
    const listed = await architect.call('list_work_requests', {});
    expect(JSON.stringify(listed)).not.toContain(foreign);
  }
});

test('plan views preserve complete authoring and confine partial readers to visible groups and dependencies', async ({ processes }) => {
  const factory = processes.factory();
  const architect = await factory.client();
  const request = await architect.request('Plan projection authority');
  const reader = await factory.client();
  await reader.request('Secondary plan reader', 'ready_for_slicing', 'integration', 'example/client');
  const views = ['groups_only', 'groups_with_work_package_refs', 'groups_with_work_packages'];
  const read = async (client: Client, view: string) => (await client.call('read_plan', { work_request_id: request, view })).product_tree;
  const group = async (title: string, parent?: string) => (await architect.call('upsert_group', {
    title, ...(parent ? { parent_group_id: parent } : {}),
  })).group.id as string;
  const empty = await group('Empty authoring group');
  const hiddenRoot = await group('Hidden root');
  const hiddenGroup = await group('Hidden package group', hiddenRoot);
  const emptyDescendant = await group('Empty hidden descendant', hiddenGroup);
  const ancestor = await group('Necessary visible ancestor');
  const visibleGroup = await group('Visible package group', ancestor);
  const mixed = await group('Mixed membership');
  const allGroups = [empty, hiddenRoot, hiddenGroup, emptyDescendant, ancestor, visibleGroup, mixed].sort();
  // Empty equals empty: both callers can see a complete pre-package authoring plan.
  for (const client of [architect, reader]) for (const view of views) {
    const plan = await read(client, view);
    expect(plan.groups.map((entry: any) => entry.id).sort()).toEqual(allGroups);
    expect(plan.summary.work_package_count).toBe(0);
  }
  const hidden = (await architect.call('slice_work_request', { work_packages: [
    contract('Hidden contract', { group_id: hiddenGroup }),
    contract('Hidden ancestor membership', { group_id: ancestor }),
    contract('Hidden mixed membership', { group_id: mixed }),
    contract('Hidden terminal contract', { group_id: hiddenGroup, kind: 'docs' }),
  ] })).work_package_ids as string[];
  for (const view of views) {
    const plan = await read(reader, view);
    expect(plan.groups).toEqual([]);
    expect(plan.root_group_ids).toEqual([]);
    expect(plan.root_work_package_ids).toEqual([]);
    expect(plan.summary.work_package_count).toBe(0);
    expect(plan.summary.group_count).toBe(0);
    for (const id of [...hidden, ...allGroups]) expect(JSON.stringify(plan)).not.toContain(id);
  }
  const secondary = { repo: 'example/client', base_branch: 'integration' };
  const [planned, mixedMember, terminal, rootMember] = (await architect.call('slice_work_request', { work_packages: [
    contract('Visible planned contract', { ...secondary, group_id: visibleGroup }),
    contract('Visible mixed contract', { ...secondary, group_id: mixed }),
    contract('Visible terminal contract', { ...secondary, group_id: visibleGroup, kind: 'docs' }),
    contract('Visible root contract', secondary),
  ] })).work_package_ids;
  const visible = [planned, mixedMember, terminal, rootMember].sort();
  const dependency = async (dependent: string, prerequisite: string, kind = 'work_package') =>
    (await architect.call('upsert_dependency', {
      dependent: { kind, id: dependent }, prerequisite: { kind, id: prerequisite }, reason: 'Required bounded scope',
    })).dependency.id as string;
  const visibleEdge = await dependency(planned, terminal);
  const groupEdge = await dependency(mixed, visibleGroup, 'group');
  const hiddenEdge = await dependency(planned, hidden[0]);
  const hiddenGroupEdge = await dependency(mixed, hiddenGroup, 'group');
  const assertPartial = async (terminalStatus: string) => {
    for (const view of views) {
      const plan = await read(reader, view);
      expect(plan.groups.map((entry: any) => entry.id).sort()).toEqual([ancestor, visibleGroup, mixed].sort());
      expect(plan.root_group_ids.sort()).toEqual([ancestor, mixed].sort());
      expect(plan.summary.work_package_count).toBe(4);
      expect(plan.summary.group_count).toBe(3);
      const mixedRow = plan.groups.find((entry: any) => entry.id === mixed);
      expect(mixedRow.work_package_count).toBe(1);
      for (const id of [...hidden, empty, hiddenRoot, hiddenGroup, emptyDescendant, hiddenEdge, hiddenGroupEdge]) expect(JSON.stringify(plan)).not.toContain(id);
      expect(JSON.stringify(plan)).not.toContain('Hidden contract');
      expect(JSON.stringify(plan)).not.toContain('Hidden terminal contract');
      if (view === 'groups_only') {
        expect(plan.root_work_package_ids).toEqual([]);
        expect(mixedRow.work_package_ids).toBeUndefined();
        expect(plan.work_packages).toBeUndefined();
        expect(plan.work_package_refs).toBeUndefined();
        expect(plan.omitted_work_package_count).toBe(4);
        expect(plan.execution_graph.omitted_work_package_count).toBe(4);
        expect(plan.dependency_intents.map((entry: any) => entry.id)).toEqual([groupEdge]);
      } else {
        expect(plan.root_work_package_ids).toEqual([rootMember]);
        expect(mixedRow.work_package_ids).toEqual([mixedMember]);
        expect(plan.groups.find((entry: any) => entry.id === ancestor).work_package_ids).toEqual([]);
        const members = view === 'groups_with_work_packages' ? plan.work_packages : plan.work_package_refs;
        expect(members.map((entry: any) => entry.id).sort()).toEqual(visible);
        expect(members.find((entry: any) => entry.id === planned).status).toBe('planned');
        expect(members.find((entry: any) => entry.id === terminal).status).toBe(terminalStatus);
        expect(plan.execution_graph.work_package_ids.sort()).toEqual(visible);
        expect(plan.dependency_intents.map((entry: any) => entry.id).sort()).toEqual([visibleEdge, groupEdge].sort());
        expect(plan.execution_graph.effective_edges.map((entry: any) => [entry.prerequisite_work_package_id, entry.dependent_work_package_id]).sort())
          .toEqual([[terminal, planned], [planned, mixedMember], [terminal, mixedMember]].sort());
      }
    }
  };
  await assertPartial('planned');
  for (const wp of [hidden[3], terminal]) {
    await architect.call('dispatch_work_package', { work_package_id: wp });
    await (await worker(factory, wp)).call('mark_ready');
    await close(architect, wp);
  }
  await assertPartial('closed');
  for (const view of views) {
    const plan = await read(architect, view);
    expect(plan.groups.map((entry: any) => entry.id).sort()).toEqual(allGroups);
    expect(plan.summary.work_package_count).toBe(8);
    if (view === 'groups_with_work_packages') {
      expect(plan.work_packages.find((entry: any) => entry.id === hidden[3]).status).toBe('closed');
    }
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
    ['record_work_package_delivery', { work_package_id: own, outcome: 'completed_no_pr', idempotency_key: 'worker-close', evidence: { completed_no_pr: { no_pr_evidence: 'Unapproved completion' } } }],
    ['reconcile_work_request', { work_request_id: request, apply: true }],
    ['revoke_work_package_worker_key', { work_package_id: sibling, reason: 'Steal authority' }],
    ['force_release_work_package_claim', { work_package_id: sibling, reason: 'Steal authority' }],
  ] as const) await client.reject(name, { work_request_id: request, ...args }, 'architect_grant_required');
  await client.reject('dispatch_work_package', { work_request_id: request, work_package_id: sibling }, 'insufficient_role');
  await client.reject('record_work_package_delivery', {}, 'architect_grant_required');
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
  const overlong = await client.rpc('tools/call', { name: 'add_comment', arguments: { body: 'x'.repeat(4001) } });
  expect(overlong.error.data.reason).toContain('body');
  expect((await client.call('list_comments')).comments).toEqual([]);
  const comment = (await client.call('add_comment', { body: 'Review sk-synthetic-secret before completion' })).comment;
  expect(comment.body).toContain('[REDACTED]');
  expect(comment.body).not.toContain('sk-synthetic-secret');
  const resolved = (await client.call('resolve_comment', { comment_id: comment.id, resolution_note: 'Addressed' })).comment;
  expect(resolved.status).toBe('resolved');
  expect(resolved.source_type).toBe('worker');
  expect(resolved.author_name).toBe('acceptance-worker');
  expect(resolved.resolved_by).toBe('acceptance-worker');
  expect(resolved.resolved_source_type).toBe('worker');
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
  expect(released.released_claim_lease_ids).toEqual([]);
  const recycled = await architect.inspect(`/api/v1/sympp/operator/work-packages/${wp}`);
  expect(recycled.summary.active_grant_count).toBe(0);
  const recycledRow = await row(architect, request, wp);
  expect(recycledRow.work_package.runtime_state.lifecycle_state).toBe('recycled');
  expect(recycledRow.work_package.runtime_state.reason_codes).toContain('worker_recycled');
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
  expect(document.progress_events.filter((event: any) => event.idempotency_key?.endsWith(':old-owner'))).toEqual([]);
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
  expect(revoked.closeout_affordance.previous_work_package_status).toBe('active');
  expect(revoked.closeout_affordance.reason_codes).toEqual(['worker_recycled', 'work_package_worker_key_revoked', 'work_package_blocked_for_recycle']);
  expect(revoked.next_action).toBe('retry_record_work_package_delivery');
  expect(revoked.audit_event.id).toBeTruthy();
  const staleMutation = await client.raw(tool('append_progress', { summary: 'Before revocation', idempotency_key: 'revoked-once' }));
  expect(staleMutation.body.error).toBeTruthy();
  expect(staleMutation.binding).toBe('clear');
  for (const [name, args] of [
    ['append_finding', { title: 'After revocation', body: 'Must not persist', idempotency_key: 'revoked-finding' }],
    ['read_work_package_document', { document: 'context.md' }],
  ] as const) expect((await client.rpc('tools/call', { name, arguments: args })).error).toBeTruthy();
  expect((await client.rpc('resources/read', { uri: `sympp://work-packages/${wp}/progress.md` })).error).toBeTruthy();
  const fresh = await factory.client();
  expect((await fresh.rpc('tools/call', { name: 'claim_local_assignment', arguments: { work_package_id: wp, claimed_by: 'replacement' } })).error).toBeTruthy();
  const document = await architect.inspect(`/api/v1/sympp/operator/work-packages/${wp}`);
  expect(document.progress.filter((event: any) => event.id === first.id)).toHaveLength(1);
  expect((await peer.call('get_current_assignment')).assignment.work_package_id).toBe(sibling);
  await factory.stop();
  const restarted = processes.factory();
  const retired = client.reconnect(await restarted.endpoint);
  expect((await retired.raw(tool('read_context'))).body.error).toBeTruthy();
  await retired.reject('list_guidance_requests', { work_request_id: request }, 'claim_required');
  expect((await retired.rpc('resources/read', { uri: 'sympp://assignment/current' })).error.data.reason).toBe('missing_session');
  expect((await peer.reconnect(await restarted.endpoint).call('get_current_assignment')).assignment.work_package_id).toBe(sibling);
  const recoveredArchitect = architect.reconnect(await restarted.endpoint);
  expect((await recoveredArchitect.call('read_work_request', { work_request_id: request })).work_packages.find((entry: any) => entry.id === wp).status).toBe('blocked');
  await close(recoveredArchitect, wp, 'superseded', { successor_work_package_id: sibling, superseded_reason: 'The sibling owns the recut scope.' });
  expect((await row(recoveredArchitect, request, wp)).delivery_outcome).toBe('superseded');
  expect((await peer.reconnect(await restarted.endpoint).call('get_current_assignment')).assignment.work_package_id).toBe(sibling);
});

test('superseded and no-PR delivery retire live claims and prevent terminal worker mutations', async ({ processes }) => {
  const factory = processes.factory();
  const architect = await factory.client();
  const request = await architect.request('Retire terminal scope');
  const [superseded, completed, successor, unclaimed, detached] = (await architect.call('slice_work_request', { work_packages: [
    contract('Old scope', { kind: 'docs' }), contract('Accepted research', { kind: 'docs' }),
    contract('New scope'), contract('Unclaimed old scope'),
    contract('Completed disconnected work', { kind: 'docs' }),
  ] })).work_package_ids;
  for (const work_package_id of [superseded, completed, successor, unclaimed, detached]) await architect.call('dispatch_work_package', { work_package_id });
  const old = await worker(factory, superseded);
  const research = await worker(factory, completed, 'research-worker');
  await old.call('mark_ready');
  await architect.call('update_work_package', { work_package_id: superseded, expected_contract_revision: 1, patch: { goal: 'The scope needs an implementing revision before supersession.' } });
  expect((await row(architect, request, superseded)).raw_status).toBe('implementing');
  const supersede = (wp: string) => close(architect, wp, 'superseded', { successor_work_package_id: successor, superseded_reason: 'A bounded successor owns this scope.' });
  const invalidSuccessor = await factory.client();
  await invalidSuccessor.request('Foreign successor owner');
  const [foreign] = await packages(invalidSuccessor, ['Foreign successor']);
  await architect.reject('record_work_package_delivery', {
    work_package_id: superseded, outcome: 'superseded', idempotency_key: 'foreign-successor',
    evidence: { superseded: { successor_work_package_id: foreign, superseded_reason: 'Must be refused' } },
  }, 'successor_work_package_out_of_scope');
  expect((await old.call('get_current_assignment')).assignment.work_package_id).toBe(superseded);
  await supersede(superseded);
  await supersede(unclaimed);
  expect((await research.call('mark_ready')).work_package.status).toBe('ready_for_merge');
  await close(architect, completed);
  for (const [client, wp] of [[old, superseded], [research, completed]] as const) {
    expect((await client.rpc('tools/call', { name: 'append_progress', arguments: { summary: 'Terminal mutation', idempotency_key: 'terminal' } })).error).toBeTruthy();
    const fresh = await factory.client();
    expect((await fresh.rpc('tools/call', { name: 'claim_local_assignment', arguments: { work_package_id: wp, claimed_by: 'terminal-reclaim' } })).error).toBeTruthy();
    expect((await architect.inspect(`/api/v1/sympp/operator/work-packages/${wp}`)).progress.filter((event: any) => event.summary === 'Terminal mutation')).toEqual([]);
    expect((await architect.inspect(`/api/v1/sympp/operator/work-packages/${wp}`)).summary.active_grant_count).toBe(0);
    expect((await row(architect, request, wp)).work_package.runtime_state.reason_codes).not.toContain('claim_lease_active');
  }
  const disconnected = await worker(factory, detached, 'completed-worker');
  await disconnected.call('mark_ready');
  await disconnected.call('release_current_assignment', { reason: 'Work completed before architect delivery' });
  expect((await row(architect, request, detached)).work_package.runtime_state.reason_codes).not.toContain('claim_lease_active');
  await close(architect, detached);
  expect((await architect.inspect(`/api/v1/sympp/operator/work-packages/${detached}`)).summary.active_grant_count).toBe(0);
  const fresh = await factory.client();
  expect((await fresh.rpc('tools/call', { name: 'claim_local_assignment', arguments: { work_package_id: unclaimed } })).error).toBeTruthy();
  expect((await row(architect, request, superseded)).delivery_outcome).toBe('superseded');
  expect((await row(architect, request, completed)).delivery_outcome).toBe('completed_no_pr');
  await close(architect, successor);
  expect((await architect.operator(`/api/v1/sympp/operator/work-requests/${request}/archive`, {})).status).toBe(200);
  const refused = await architect.rpc('tools/call', { name: 'slice_work_request', arguments: { work_packages: [contract('Archived scope')] } });
  expect(refused.error).toBeTruthy();
  const archived = await fresh.reject('claim_local_architect_assignment', { work_request_id: request }, 'work_request_terminal');
  expect(archived.terminal_state).toBe('archived');
  expect(archived.action).toBe('restore_work_request_or_start_new_work_request');
});

deliveryTest('architect merged recovery retires real claimed workers and preserves unrelated worker authority', async ({ delivery: { factory, provider } }) => {
  const architect = await factory.client();
  const request = await architect.request('Merged authority retirement');
  const [wp, implementing, sibling] = (await architect.call('slice_work_request', { work_packages: [
    contract('Merged change', { kind: 'docs', branch_pattern: 'feature/authority' }),
    contract('Revised implementing change', { kind: 'docs', branch_pattern: 'feature/authority' }),
    contract('Independent change'),
  ] })).work_package_ids;
  for (const id of [wp, implementing, sibling]) await architect.call('dispatch_work_package', { work_package_id: id });
  const client = await worker(factory, wp);
  const peer = await worker(factory, sibling, 'peer-worker');
  await client.call('attach_branch', { branch: 'feature/authority', head_sha: head('a') });
  await client.call('attach_pr', { url: prUrl(301), head_sha: head('a') });
  const mergedAt = new Date().toISOString();
  provider.set(301, pr(301, head('a'), { headRefName: 'feature/authority', state: 'MERGED', mergedAt, mergeCommit: { oid: head('f') } }));
  await client.call('sync_pr');
  expect((await row(architect, request, wp)).delivery_outcome).toBeNull();
  await architect.call('reconcile_work_request', { work_request_id: request, apply: false });
  expect((await client.call('get_current_assignment')).assignment.work_package_id).toBe(wp);
  expect((await architect.call('reconcile_work_request', { work_request_id: request, apply: true })).reconciliation.applied_count).toBe(1);
  expect((await row(architect, request, wp)).delivery_outcome).toBe('pr_merged');
  expect((await client.rpc('tools/call', { name: 'append_progress', arguments: { summary: 'Late mutation', idempotency_key: 'late' } })).error).toBeTruthy();
  expect((await client.rpc('resources/read', { uri: `sympp://work-packages/${wp}/context.md` })).error).toBeTruthy();
  expect((await peer.call('get_current_assignment')).assignment.work_package_id).toBe(sibling);
  expect((await architect.inspect(`/api/v1/sympp/operator/work-packages/${wp}`)).progress.filter((event: any) => event.summary === 'Late mutation')).toEqual([]);
  const revised = await worker(factory, implementing, 'revised-worker');
  await revised.call('mark_ready');
  await architect.call('update_work_package', { work_package_id: implementing, expected_contract_revision: 1, patch: { title: 'Revised delivery scope' } });
  await revised.call('attach_branch', { branch: 'feature/authority', head_sha: head('b') });
  await revised.call('attach_pr', { url: prUrl(326), head_sha: head('b') });
  provider.set(326, pr(326, head('b'), { headRefName: 'feature/authority', state: 'MERGED', mergedAt, mergeCommit: { oid: head('f') } }));
  await revised.call('sync_pr');
  expect((await row(architect, request, implementing)).raw_status).toBe('implementing');
  await close(architect, implementing, 'pr_merged', { pr_url: prUrl(326), pr_number: 326, pr_repository: 'example/service', pr_merged_at: mergedAt, merge_commit_sha: head('f') });
  const delivered = await row(architect, request, implementing);
  expect(delivered.raw_status).toBe('merged');
  expect(delivered.work_package.runtime_state['active?']).toBe(false);
  expect(delivered.work_package.runtime_state.reason_codes).not.toContain('claim_lease_active');
  expect((await revised.rpc('tools/call', { name: 'append_progress', arguments: { summary: 'Late revised mutation', idempotency_key: 'late-revised' } })).error).toBeTruthy();
  expect((await peer.call('get_current_assignment')).assignment.work_package_id).toBe(sibling);
});

test('worker plan updates are atomic and native evidence history remains complete across concurrent appends', async ({ processes }) => {
  const factory = processes.factory();
  const architect = await factory.client();
  await architect.request('Worker planning and history');
  const reviewValues = ['synthetic-review-credential', 'synthetic-review-access', 'synthetic-review-verifier'];
  const [wp, sibling] = (await architect.call('slice_work_request', { work_packages: [
    contract('Plan owner', { review: { type: 'review-suite', args: {
      mode: 'fast', credential: reviewValues[0], access_key: reviewValues[1], grant_verifier: reviewValues[2],
    } } }), contract('Other plan'),
  ] })).work_package_ids;
  for (const work_package_id of [wp, sibling]) await architect.call('dispatch_work_package', { work_package_id });
  const client = await worker(factory, wp);
  const peer = await worker(factory, sibling, 'peer-worker');
  const initial = await client.call('read_task_plan');
  for (const [args, reason] of [
    [{ summary: 'Invalid key', idempotency_key: 123 }, 'missing_idempotency_key'],
    [{ summary: 123, idempotency_key: 'invalid-summary' }, 'missing_summary'],
    [{ summary: 'Invalid payload', idempotency_key: 'invalid-payload', payload: false }, 'invalid_payload'],
  ] as const) await client.reject('append_progress', args, reason);
  expect((await client.call('read_work_package_document', { document: 'progress.md' })).progress_events).toEqual([]);
  for (const [args, reason] of [
    [{ document: '../progress.md' }, 'unknown_virtual_file'],
    [{ document: 'review.md', before_sequence: 1 }, 'unsupported_document_cursor'],
    [{ document: 'progress.md', before_sequence: 0 }, 'invalid_before_sequence'],
    [{ document: 'progress.md', before_sequence: '1' }, 'invalid_before_sequence'],
  ] as const) await client.reject('read_work_package_document', args, reason);
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
  expect((await client.call('read_task_plan')).text).toContain('Working');
  await client.reject('update_task_plan', { expected_version: before.version, nodes: [{ id: ownNode, status: 'done' }] }, 'stale_plan_version');
  expect((await peer.call('read_task_plan')).text).toContain('Sibling node');
  const peerVersion = (await peer.call('read_task_plan')).version;
  await peer.call('update_task_plan', { expected_version: peerVersion, nodes: Array.from({ length: 100 }, (_, index) => ({ title: `Bounded node ${index + 1}` })) });
  const bounded = await peer.rpc('tools/call', { name: 'read_task_plan', arguments: {} });
  expect(bounded.result.structuredContent.plan_nodes).toHaveLength(100);
  expect(bounded.result.structuredContent.omitted.plan_nodes).toBe(2);
  expect(bounded.result.content[0].text).not.toContain('Bounded node 100');
  expect(bounded.result.structuredContent.text).toContain('2 later plan nodes omitted');
  await peer.call('update_task_plan', { expected_version: bounded.result.structuredContent.version, nodes: [{ id: foreignNode, status: 'done' }] });
  expect((await peer.call('read_task_plan')).plan_nodes.find((node: any) => node.id === foreignNode).status).toBe('done');
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
  const safeIdentity = 'finding_embeddedSk-syntheticIdentifier';
  const sensitiveFinding = await client.call('append_finding', {
    id: safeIdentity, title: 'Identity survives document encoding',
    body: 'Keep identity while hiding sk-synthetic-document-secret', severity: 'sk-synthetic-severity-secret',
    idempotency_key: 'document-identity',
  });
  expect(sensitiveFinding.finding.id).toBe(safeIdentity);
  for (const document of ['context.md', 'task_plan.md', 'findings.md', 'progress.md', 'acceptance.md', 'review.md', 'handoff.md']) {
    const native = await client.rpc('tools/call', { name: 'read_work_package_document', arguments: { document } });
    const resource = await client.rpc('resources/read', { uri: `sympp://work-packages/${wp}/${document}` });
    expect(native.result.content[0].text).toBe(resource.result.contents[0].text);
    expect(resource.result.contents[0].mimeType).toBe('text/vnd.toon');
    if (document === 'findings.md' || document === 'handoff.md') {
      const finding = native.result.structuredContent.findings.find((entry: any) => entry.id === safeIdentity);
      expect(finding.id).toBe(safeIdentity);
      expect(finding.severity).toBe('[REDACTED]');
      if (document === 'findings.md') expect(finding.body).toContain('[REDACTED]');
      expect(native.result.content[0].text).toContain(safeIdentity);
      expect(native.result.content[0].text).toContain('[REDACTED]');
      for (const secret of ['sk-synthetic-document-secret', 'sk-synthetic-severity-secret']) {
        expect(JSON.stringify(native)).not.toContain(secret);
        expect(JSON.stringify(resource)).not.toContain(secret);
      }
    }
    if (document === 'context.md' || document === 'review.md') {
      expect(JSON.stringify(native)).toContain('[REDACTED]');
      for (const value of reviewValues) {
        expect(JSON.stringify(native)).not.toContain(value);
        expect(JSON.stringify(resource)).not.toContain(value);
      }
    }
  }
  const redacted = await client.rpc('tools/call', { name: 'append_progress', arguments: {
    summary: 'Recorded progress sk-synthetic-progress-token', idempotency_key: 'redacted-progress',
    payload: { accessKey: 'synthetic-access-value', apiKey: 'synthetic-api-value', grant_verifier: 'synthetic-verifier-value', private_payload: { path: 'synthetic-private-path' }, safe: 'unprojected-safe-value' },
  } });
  expect(redacted.result.structuredContent.progress_event.summary).toContain('[REDACTED]');
  const projected = await client.rpc('resources/read', { uri: `sympp://work-packages/${wp}/progress.md` });
  const explicitProgress = await client.rpc('tools/call', { name: 'read_work_package_document', arguments: { document: 'progress.md' } });
  expect(explicitProgress.result.content[0].text).toBe(projected.result.contents[0].text);
  for (const value of ['sk-synthetic-progress-token', 'synthetic-access-value', 'synthetic-api-value', 'synthetic-verifier-value', 'synthetic-private-path', 'unprojected-safe-value']) {
    expect(redacted.result.content[0].text).not.toContain(value);
    expect(JSON.stringify(explicitProgress)).not.toContain(value);
    expect(projected.result.contents[0].text).not.toContain(value);
  }
});

deliveryTest('worker provider evidence resists spoofing mismatch failure and replay while preserving ready state', async ({ delivery: { factory, provider } }) => {
  const architect = await factory.client();
  const request = await architect.request('Worker provider evidence');
  const [wp, sibling] = (await architect.call('slice_work_request', { work_packages: [contract('Provider-qualified work', {
    kind: 'mcp', policy_template: 'mcp_current_pr_state', branch_pattern: 'feature/authority',
    review: { type: 'review_suite', args: { mode: 'fast' } },
  }), contract('Confidential sibling terminal marker')] })).work_package_ids;
  await architect.call('dispatch_work_package', { work_package_id: wp });
  let client = await worker(factory, wp);
  for (const type of ['branch', 'pr']) await client.call('append_progress', { summary: `Spoof ${type}`, idempotency_key: `spoof-${type}`, payload: { type, source_tool: `attach_${type}` } });
  expect((await client.reject('mark_ready', {}, 'readiness_failed')).missing).toEqual(['branch_attached', 'pr_attached', 'current_pr_state']);
  await client.call('attach_branch', { branch: 'feature/authority', head_sha: head('a'), idempotency_key: 'branch-once' });
  await client.call('attach_pr', { url: prUrl(302), head_sha: head('a') });
  const missingState = (await client.reject('mark_ready', {}, 'readiness_failed')).missing;
  expect(missingState).toContain('current_pr_state');
  expect(missingState).not.toContain('pr_attached');
  for (const [status, checks] of [
    ['passing', [{ status: 'COMPLETED', conclusion: 'SUCCESS' }]],
    ['failing', [{ status: 'COMPLETED', conclusion: 'FAILURE' }]],
    ['pending', [{ status: 'IN_PROGRESS', conclusion: null }]],
    ['unknown', []],
  ] as const) {
    provider.set(302, pr(302, head('a'), { headRefName: 'feature/authority', statusCheckRollup: checks }));
    const before = provider.calls.filter((call) => call.argv[0] === 'pr').length;
    const observation = (await client.call('sync_pr', { idempotency_key: `provider-state-${status}` })).progress_event;
    const history = await client.call('read_work_package_document', { document: 'progress.md' });
    const payload = history.progress_events.find((entry: any) => entry.id === observation.id).payload.observation;
    expect(payload.check_summary.status).toBe(status);
    expect(payload.review_state.status).toBe('approved');
    expect(payload.merge_state).toEqual({ merged: false, status: 'clean' });
    expect(payload.provider_reference).toBe('PR_synthetic_302');
    expect(Number.isFinite(Date.parse(payload.observed_at))).toBe(true);
    expect(provider.calls.filter((call) => call.argv[0] === 'pr')).toHaveLength(before + 1);
    expect(provider.calls.at(-1)?.argv.slice(0, 5)).toEqual(['pr', 'view', '302', '--repo', 'example/service']);
  }
  provider.set(302, pr(302, head('a'), { headRefName: 'feature/authority' }));
  const args = { idempotency_key: 'provider-once', url: prUrl(302) };
  const observed = (await client.call('sync_pr', args)).progress_event;
  const providerCalls = provider.calls.length;
  provider.replies.set(302, { stdout: 'Provider offline', exitCode: 1 });
  expect((await client.call('sync_pr', args)).progress_event.id).toBe(observed.id);
  expect(provider.calls).toHaveLength(providerCalls);
  await client.call('release_current_assignment', { reason: 'Reconnect provider replay' });
  client = await worker(factory, wp);
  expect((await client.call('sync_pr', args)).progress_event.id).toBe(observed.id);
  expect(provider.calls).toHaveLength(providerCalls);
  const document = await client.call('read_work_package_document', { document: 'progress.md' });
  for (const [reply, reason] of [
    [{ stdout: 'Provider offline', exitCode: 1 }, 'provider_unavailable'],
    [{ stdout: 'not json', exitCode: 0 }, 'provider_unavailable'],
    [{ stdout: '{}', exitCode: 0 }, 'provider_malformed'],
  ] as const) {
    provider.replies.set(302, reply);
    const failed = await client.rpc('tools/call', { name: 'sync_pr', arguments: {} });
    expect(failed.error.code).toBe(-32000);
    expect(failed.error.data.layer).toBe('provider');
    expect(failed.error.data.reason).toBe(reason);
    expect(await client.call('read_work_package_document', { document: 'progress.md' })).toEqual(document);
  }
  const beforeWrongReference = provider.calls.length;
  await client.reject('sync_pr', { url: prUrl(303) }, 'pr_reference_mismatch');
  expect(provider.calls).toHaveLength(beforeWrongReference);
  provider.set(302, pr(302, head('b'), { headRefName: 'feature/authority' }));
  const mismatch = await client.reject('sync_pr', {}, 'provider_head_mismatch');
  expect(mismatch.expected_head_sha).toBe(head('a'));
  expect(mismatch.actual_head_sha).toBe(head('b'));
  expect(mismatch.recovery.next_action).toBe('prove_current_head_then_retry_sync_pr');
  expect(await client.call('read_work_package_document', { document: 'progress.md' })).toEqual(document);
  await client.reject('sync_pr', { check_summary: { status: 'passing' } }, 'unexpected_argument');
  const recovery = { url: prUrl(302), head_sha: head('a'), branch: 'feature/authority', base_branch: 'beta',
    observed_at: '', provider_reference: 'synthetic-import-302', check_summary: { status: 'passing' }, review_state: { status: 'approved' }, merge_state: { status: 'clean', merged: false } };
  const beforeImport = provider.calls.length;
  const imported = (await client.call('sync_pr', { recovery, idempotency_key: 'recovery-once' })).progress_event;
  await client.call('release_current_assignment', { reason: 'Reconnect imported observation' });
  client = await worker(factory, wp);
  const importedHistory = await client.call('read_work_package_document', { document: 'progress.md' });
  expect(importedHistory.progress_events.find((entry: any) => entry.id === imported.id).payload.observation.provider_reference).toBe('synthetic-import-302');
  expect((await client.call('sync_pr', { recovery, idempotency_key: 'recovery-once' })).progress_event.id).toBe(imported.id);
  await client.reject('sync_pr', { recovery: { ...recovery, check_summary: { status: 'failing' } }, idempotency_key: 'recovery-once' }, 'idempotency_conflict');
  await client.reject('sync_pr', { recovery: { ...recovery, check_summary: { status: 'green' } } }, 'invalid_recovery');
  await client.reject('sync_pr', { recovery: { ...recovery, merge_state: { status: 'clean', merged: true } } }, 'invalid_recovery');
  expect(provider.calls).toHaveLength(beforeImport);
  await client.call('attach_branch', { branch: 'feature/authority', head_sha: head('b') });
  expect((await client.reject('mark_ready', {}, 'readiness_failed')).missing).toContain('current_pr_state');
  await client.call('attach_pr', { url: prUrl(302), head_sha: head('b') });
  expect((await client.call('sync_pr', { recovery, idempotency_key: 'recovery-once' })).progress_event.id).toBe(imported.id);
  expect(provider.calls).toHaveLength(beforeImport);
  await client.call('sync_pr');
  await client.call('attach_pr', { url: prUrl(302), head_sha: head('b'), idempotency_key: 'reattach-after-sync' });
  expect((await client.reject('mark_ready', {}, 'readiness_failed')).missing).toContain('current_pr_state');
  await client.call('sync_pr', { recovery: { ...recovery, head_sha: head('b') }, idempotency_key: 'current-state-after-reattach' });
  expect((await client.call('mark_ready')).work_package.status).toBe('ready_for_merge');
  const beforeReadyReplay = provider.calls.length;
  expect((await client.call('sync_pr', args)).progress_event.id).toBe(observed.id);
  expect(provider.calls).toHaveLength(beforeReadyReplay);
  expect((await row(architect, request, wp)).delivery_outcome).toBeNull();
  const readyDocument = await client.call('read_work_package_document', { document: 'progress.md' });
  await client.reject('sync_pr', {}, 'pr_not_merged');
  expect(await client.call('read_work_package_document', { document: 'progress.md' })).toEqual(readyDocument);
  provider.set(302, pr(302, head('b'), { headRefName: 'feature/authority', state: 'MERGED', mergedAt: new Date().toISOString(), mergeCommit: { oid: head('f') } }));
  const merged = await client.call('sync_pr');
  expect(merged.pr_sync.status).toBe('merged');
  expect(merged.next_owner).toBe('architect');
  expect(merged.next_action).toBe('return_to_architect');
  const terminal = await architect.inspect(`/api/v1/sympp/operator/work-packages/${wp}`);
  expect(terminal.summary.active_grant_count).toBe(0);
  expect((await row(architect, request, wp)).delivery_outcome).toBe('pr_merged');
  // Linked delivery retires this worker's grant. Historical unlinked-package
  // already_merged replay remains a separate lower-level qualification.
  expect((await client.rpc('tools/call', { name: 'sync_pr', arguments: {} })).error?.code).toBe(-32001);
  expect((await client.rpc('tools/call', { name: 'append_progress', arguments: { summary: 'Late worker mutation', idempotency_key: 'after-worker-merge' } })).error).toBeTruthy();
  expect((await architect.inspect(`/api/v1/sympp/operator/work-packages/${wp}`)).progress).toEqual(terminal.progress);
  for (const hidden of [sibling, 'Confidential sibling terminal marker']) expect(JSON.stringify(merged)).not.toContain(hidden);
});

deliveryTest('worker metadata replay and short-head matching preserve distinct readiness policies', async ({ delivery: { factory, provider } }) => {
  const architect = await factory.client();
  await architect.request('Worker metadata boundaries');
  const ids = (await architect.call('slice_work_request', { work_packages: [
    contract('Attachment is sufficient', { kind: 'mcp', branch_pattern: 'feature/authority' }),
    contract('Abbreviated commit identity', { kind: 'mcp', branch_pattern: 'feature/authority' }),
    contract('Tiny commit identity', { kind: 'mcp', branch_pattern: 'feature/authority' }),
    contract('Urgent fix', { kind: 'hotfix', branch_pattern: 'feature/authority' }),
    contract('Canonical attachment state', { kind: 'mcp', policy_template: 'mcp_current_pr_state', branch_pattern: 'feature/authority' }),
    contract('Legacy compatible URL', { kind: 'mcp', branch_pattern: 'feature/authority' }),
    contract('Legacy URL canonical state', { kind: 'mcp', policy_template: 'mcp_current_pr_state', branch_pattern: 'feature/authority' }),
    contract('Head refresh without reattachment', { kind: 'mcp', policy_template: 'mcp_current_pr_state', branch_pattern: 'feature/authority' }),
    contract('Canonical recovery readiness', { kind: 'mcp', policy_template: 'mcp_current_pr_state', branch_pattern: 'feature/authority' }),
  ] })).work_package_ids;
  for (const id of ids) await architect.call('dispatch_work_package', { work_package_id: id });
  const full = await worker(factory, ids[0]);
  const branchArgs = { branch: 'feature/authority', head_sha: head('a'), idempotency_key: 'branch-replay' };
  const branch = (await full.call('attach_branch', branchArgs)).progress_event;
  expect((await full.call('read_work_package_document', { document: 'progress.md' })).progress_events.find((entry: any) => entry.id === branch.id).payload.observation.branch).toBe('feature/authority');
  expect((await full.call('attach_branch', { ...branchArgs, work_package_id: ids[0] })).progress_event.id).toBe(branch.id);
  await full.reject('attach_branch', { ...branchArgs, head_sha: head('b') }, 'idempotency_conflict');
  const separate = (await full.call('attach_branch', { ...branchArgs, idempotency_key: 'independent-observation' })).progress_event;
  expect(separate.id).not.toBe(branch.id);
  await full.call('attach_pr', { url: prUrl(304), head_sha: head('b') });
  expect((await full.reject('mark_ready', {}, 'readiness_failed')).missing).toContain('pr_attached');
  const prArgs = { number: 304, head_sha: head('a'), idempotency_key: 'pr-replay' };
  const attached = (await full.call('attach_pr', prArgs)).progress_event;
  expect((await architect.inspect(`/api/v1/sympp/operator/work-packages/${ids[0]}`)).metadata.pr.url).toBe(prUrl(304));
  expect((await full.call('attach_pr', prArgs)).progress_event.id).toBe(attached.id);
  await full.reject('attach_pr', { ...prArgs, number: 305 }, 'idempotency_conflict');
  expect((await full.call('mark_ready')).work_package.status).toBe('ready_for_merge');
  for (const [index, length, ready] of [[1, 7, true], [2, 3, false]] as const) {
    const client = await worker(factory, ids[index], `head-worker-${index}`);
    await client.call('attach_branch', { branch: 'feature/authority', head_sha: head('b').slice(0, length) });
    await client.call('attach_pr', { url: prUrl(304 + index), head_sha: head('b') });
    const response = await client.rpc('tools/call', { name: 'mark_ready', arguments: {} });
    if (ready) expect(response.result.structuredContent.ready).toBe(true);
    else expect(response.error.data.missing).toContain('pr_attached');
  }
  const hotfix = await worker(factory, ids[3], 'hotfix-worker');
  await hotfix.call('attach_branch', { branch: 'feature/authority', head_sha: head('c') });
  await hotfix.call('attach_pr', { url: prUrl(307), head_sha: head('c') });
  provider.set(307, pr(307, head('c'), { headRefName: 'feature/authority' }));
  await hotfix.call('sync_pr');
  expect((await hotfix.call('mark_ready')).work_package.status).toBe('ready_for_merge');
  const canonical = await worker(factory, ids[4], 'canonical-worker');
  await canonical.call('attach_branch', { branch: 'feature/authority', head_sha: head('d') });
  await canonical.call('attach_pr', { url: prUrl(308), metadata: { head_sha: head('d'),
    check_summary: { conclusion: 'success' }, review_state: { state: 'approved' }, merge_state: { state: 'clean' } } });
  expect((await canonical.call('mark_ready')).work_package.status).toBe('ready_for_merge');
  const legacy = await worker(factory, ids[5], 'url-worker');
  await legacy.call('attach_branch', { branch: 'feature/authority', head_sha: head('e') });
  await legacy.call('attach_pr', { url: 'https://git.example.com/service/pulls/8', head_sha: head('e') });
  expect((await legacy.call('mark_ready')).work_package.status).toBe('ready_for_merge');
  const legacyState = await worker(factory, ids[6], 'legacy-state-worker');
  await legacyState.call('attach_branch', { branch: 'feature/authority', head_sha: head('e') });
  await legacyState.call('attach_pr', { url: 'https://git.example.com/service/pulls/9', head_sha: head('e'), metadata: {
    check_summary: { conclusion: 'success' }, review_state: { state: 'approved' }, merge_state: { state: 'clean' },
  } });
  expect((await legacyState.call('mark_ready')).work_package.status).toBe('ready_for_merge');
  for (const [index, changeHead] of [[7, true], [8, false]] as const) {
    const client = await worker(factory, ids[index], `recovery-policy-${index}`);
    await client.call('attach_branch', { branch: 'feature/authority', head_sha: head('a') });
    await client.call('attach_pr', { url: prUrl(330 + index), head_sha: head('a') });
    if (changeHead) {
      await client.call('attach_branch', { branch: 'feature/authority', head_sha: head('b') });
      expect((await client.reject('mark_ready', {}, 'readiness_failed')).missing).toContain('pr_attached');
    }
    await client.call('sync_pr', { recovery: { url: prUrl(330 + index), head_sha: head(changeHead ? 'b' : 'a'),
      check_summary: { status: 'passing' }, review_state: { status: 'approved' }, merge_state: { status: 'clean', merged: false } } });
    expect((await client.call('mark_ready')).ready).toBe(true);
  }
  const shortRepoArchitect = await factory.client();
  await shortRepoArchitect.request('Unambiguous PR identity', 'ready_for_slicing', 'beta', 'service');
  const [shortWp] = await packages(shortRepoArchitect, ['Explicit repository identity']);
  const shortRepoWorker = await worker(factory, shortWp, 'short-repo-worker');
  await shortRepoWorker.reject('attach_pr', { number: 309, head_sha: head('e') }, 'missing_repository_use_url_or_owner_repo');
  await shortRepoWorker.call('attach_pr', { number: '309', repository: 'example/service', head_sha: head('e') });
  expect((await shortRepoArchitect.inspect(`/api/v1/sympp/operator/work-packages/${shortWp}`)).metadata.pr.url).toBe(prUrl(309));
  await shortRepoWorker.call('attach_pr', { url: prUrl(310), head_sha: head('e') });
  expect((await shortRepoArchitect.inspect(`/api/v1/sympp/operator/work-packages/${shortWp}`)).metadata.pr.number).toBe(310);
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
  await close(architect, ids[2], 'abandoned', { abandoned_rationale: 'The scope was explicitly dropped; no code was changed.' });
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

test('explicit runtime cleanup validates delivery scope before retiring a live worker binding', async ({ processes }) => {
  const factory = processes.factory();
  const architect = await factory.client();
  const request = await architect.request('Explicit authority cleanup');
  const [wp, successor, sibling] = (await architect.call('slice_work_request', { work_packages: [
    contract('Obsolete scope', { kind: 'docs' }), contract('Successor scope'), contract('Unaffected scope'),
  ] })).work_package_ids;
  for (const id of [wp, successor, sibling]) await architect.call('dispatch_work_package', { work_package_id: id });
  const client = await worker(factory, wp);
  const peer = await worker(factory, sibling, 'peer-worker');
  await client.call('mark_ready');
  await architect.call('update_work_package', { work_package_id: wp, expected_contract_revision: 1, patch: { title: 'Revised obsolete scope' } });
  await architect.reject('cleanup_work_request_work_package_runtime', { work_package_id: wp, outcome: 'abandoned',
    abandoned_rationale: 'Must not classify implemented work as unstarted', reason: 'Invalid abandonment' }, 'work_package_not_abandonable');
  const grant = (await client.call('get_current_assignment')).assignment.grant_id;
  const cleanup = { work_package_id: wp, outcome: 'superseded', successor_work_package_id: successor,
    superseded_reason: 'The successor owns the revised scope.', reason: 'Retire the obsolete worker before closeout.' };
  const priorProgress = (await architect.inspect(`/api/v1/sympp/operator/work-packages/${wp}`)).progress;
  await architect.reject('cleanup_work_request_work_package_runtime', { work_package_id: wp, reason: 'Missing delivery evidence' }, 'missing_outcome');
  await client.reject('cleanup_work_request_work_package_runtime', cleanup, 'architect_grant_required');
  const foreign = await factory.client();
  await foreign.request('Foreign cleanup owner');
  await foreign.reject('cleanup_work_request_work_package_runtime', cleanup, 'not_found');
  expect((await client.call('get_current_assignment')).assignment.grant_id).toBe(grant);
  expect((await architect.inspect(`/api/v1/sympp/operator/work-packages/${wp}`)).progress).toEqual(priorProgress);
  const retired = await architect.call('cleanup_work_request_work_package_runtime', cleanup);
  expect(retired.runtime_cleanup.status).toBe('cleaned');
  expect(retired.runtime_cleanup.revoked_worker_grant_ids).toContain(grant);
  expect(retired.runtime_cleanup.released_claim_lease_ids).toHaveLength(1);
  expect(retired.runtime_cleanup.cleared_mcp_session_binding_ids).toHaveLength(1);
  expect(retired.work_package.status).toBe('implementing');
  expect((await row(architect, request, wp)).delivery_outcome).toBeNull();
  expect((await client.rpc('tools/call', { name: 'append_progress', arguments: { summary: 'Must not persist', idempotency_key: 'after-cleanup' } })).error).toBeTruthy();
  expect((await peer.call('get_current_assignment')).assignment.work_package_id).toBe(sibling);
  await close(architect, wp, 'superseded', { successor_work_package_id: successor, superseded_reason: cleanup.superseded_reason });
  expect((await row(architect, request, wp)).delivery_outcome).toBe('superseded');
  const document = await architect.inspect(`/api/v1/sympp/operator/work-packages/${wp}`);
  expect(document.progress.filter((event: any) => event.summary === 'Must not persist')).toEqual([]);
});

test('architect reports preserve server times and partial edits while rejecting forged worker authors', async ({ processes }) => {
  const factory = processes.factory();
  const architect = await factory.client();
  const request = await architect.request('Truthful operator reports');
  const [wp] = await packages(architect, ['Worker report boundary']);
  const client = await worker(factory, wp);
  const anchor = (await architect.call('get_current_assignment')).assignment.work_package_id;
  const question = (await architect.call('ask_question', { work_request_id: request, category: 'scope',
    question: 'Which release should include this?', why_needed: 'Select the intended release.' })).clarification_question;
  const report = (patch: object, key: string) => architect.call('append_progress', {
    work_package_id: anchor, summary: 'Operator update', idempotency_key: key,
    payload: { type: 'architect_operator_report', ...patch },
  });
  const read = async () => (await architect.call('read_work_request', { work_request_id: request })).work_request.operator_report;
  for (const [author, target] of [[client, wp], [client, anchor], [architect, wp]] as const) {
    expect((await author.rpc('tools/call', { name: 'append_progress', arguments: {
      work_package_id: target, summary: 'Forged report', idempotency_key: 'forged-report',
      payload: { type: 'architect_operator_report', brief: 'Forged brief' },
    } })).error).toBeTruthy();
  }
  await report({ brief: 'x'.repeat(4000), unknown: 'ignored' }, 'report-text-limit');
  expect((await read()).brief.text).toHaveLength(4000);
  await architect.reject('append_progress', { work_package_id: anchor, summary: 'Too long', idempotency_key: 'report-too-long',
    payload: { type: 'architect_operator_report', brief: 'x'.repeat(4001) },
  }, 'invalid_operator_report_brief');
  expect((await read()).brief.text).toHaveLength(4000);
  const initial = { brief: 'Core work is ready.', eta: 'After review', written_at: '2000-01-01T00:00:00Z',
    parking: { reason: 'Awaiting a release window', parked_at: '2000-01-01T00:00:00Z' },
    human_escalation: { question: 'Use this release?', raised_at: '2000-01-01T00:00:00Z' }, active: true, blocker_id: 'not-a-blocker' };
  const event = (await report(initial, 'initial-report')).progress_event;
  const eventTime = async (id: string) => (await architect.inspect(`/api/v1/sympp/operator/work-packages/${anchor}`)).progress.find((entry: any) => entry.id === id).created_at;
  const createdAt = await eventTime(event.id);
  const first = await read();
  expect(first.brief.text).toBe(initial.brief);
  expect(first.brief.written_at).toBe(createdAt);
  expect(first.parking.parked_at).toBe(createdAt);
  expect(first.human_escalation.raised_at).toBe(createdAt);
  expect(createdAt).not.toBe(initial.written_at);
  await report({ eta: 'Friday', human_escalation: { question: 'Use Friday?' } }, 'report-edit');
  const edited = await read();
  expect(edited.brief).toEqual(first.brief);
  expect(edited.parking).toEqual(first.parking);
  expect(edited.eta.text).toBe('Friday');
  expect(edited.human_escalation.raised_at).toBe(first.human_escalation.raised_at);
  expect((await report(initial, 'initial-report')).progress_event.id).toBe(event.id);
  expect(await read()).toEqual(edited);
  const resolved = (await report({ parking: null, human_escalation: null }, 'report-resolved')).progress_event;
  expect((await read()).human_escalation.resolved_at).toBe(await eventTime(resolved.id));
  expect((await read()).parking.resumed_at).toBe(await eventTime(resolved.id));
  await report({ human_escalation: { question: 'Approve a follow-up?' } }, 'report-reopened');
  expect((await read()).human_escalation.resolved_at).toBeNull();
  const dashboard = await architect.inspect('/api/v1/sympp/operator/dashboard/hydrated');
  const detail = dashboard.work_request_details.find((entry: any) => entry.work_request.id === request);
  expect(detail.work_request.operator_report).toEqual(await read());
  expect(detail.work_packages.map((entry: any) => entry.id)).not.toContain(anchor);
  const unchanged = await architect.call('read_work_request', { work_request_id: request });
  expect(unchanged.work_request.status).toBe('sliced');
  expect(unchanged.clarification_questions.find((entry: any) => entry.id === question.id).status).toBe('open');
  expect((await row(architect, request, wp)).attention_reason_codes).not.toContain('active_blocker');
});

test('architect question and decision mutations preserve provenance and redact compact responses', async ({ processes }) => {
  const factory = processes.factory();
  const architect = await factory.client();
  const request = await architect.request('Redacted clarification authority', 'ready_for_clarification');
  const status = await architect.call('set_work_request_status', { work_request_id: request, current_status: 'ready_for_clarification', next_status: 'clarifying' });
  expect(status.work_request.status).toBe('clarifying');
  expect(status.scope.repo).toBe('example/service');
  expect(status.scope.base_branch).toBe('beta');
  const ask = await architect.call('ask_question', { work_request_id: request, category: 'scope',
    question: 'Avoid Bearer raw_secret_synthetic', why_needed: 'Keep raw_secret_synthetic out of responses.',
    asked_by_agent_run_id: 'raw_secret_synthetic', decision_prompt: { tl_dr: 'Choose scope', details: 'A bounded decision is required.',
      options: [{ id: 'continue', label: 'Continue', answer: 'Proceed without raw_secret_synthetic.' }],
    },
  });
  const question = ask.clarification_question.id;
  for (const field of ['asked_by_agent_run_id', 'decision_prompt']) expect(ask.clarification_question[field]).toBeUndefined();
  expect(JSON.stringify(ask)).not.toContain('raw_secret_synthetic');
  for (const [value, got] of [['ready_for_slicing', 'ready_for_slicing'], [123, 'non_string']] as const) {
    const invalid = await architect.reject('answer_question', { work_request_id: request, question_id: question,
      expected_question_status: value, answer: 'Invalid status domain',
    }, 'invalid_question_status');
    expect(invalid.status_domain).toBe('clarification_question');
    expect(invalid.expected_statuses).toEqual(['open']);
    expect(invalid.got).toBe(got);
  }
  const answered = await architect.call('answer_question', { work_request_id: request, question_id: question,
    answer: 'Use https://example.invalid/evidence?sig=raw_secret_synthetic',
  });
  expect(answered.clarification_question.status).toBe('answered');
  expect(answered.clarification_question.answered_by).toBeUndefined();
  expect(JSON.stringify(answered)).not.toContain('raw_secret_synthetic');
  const closing = (await architect.call('ask_question', { work_request_id: request, category: 'acceptance',
    question: 'Can the obsolete alternative be closed?', why_needed: 'Retire an unused choice.',
  })).clarification_question.id;
  expect((await architect.call('close_question', { work_request_id: request, question_id: closing, current_status: 'open' })).clarification_question.status).toBe('closed');
  const deciding = (await architect.call('ask_question', { work_request_id: request, category: 'product',
    question: 'Keep this scope bounded?', why_needed: 'The answer must become decision provenance.',
  })).clarification_question.id;
  const combined = await architect.call('answer_question_and_record_decision', { work_request_id: request, question_id: deciding,
    answer: 'Keep the bounded scope.', source_type: 'architect', decision: 'Keep the bounded scope.',
    rationale: 'Adjacent work has another owner.', scope_impact: 'No scope expansion.',
  });
  expect(combined.clarification_question.status).toBe('answered');
  expect(combined.decision_log_entry.source_id).toBe(deciding);
  const ids: string[] = [combined.decision_log_entry.id];
  for (const [source, by] of [['implicit', undefined], ['override', 'synthetic-architect-override']] as const) {
    const result = await architect.call('record_decision', { work_request_id: request, source_type: 'architect', source_id: source,
      decision: 'Exclude raw_secret_synthetic from the decision', rationale: 'Keep the scope bounded.', scope_impact: 'No scope expansion.',
      ...(by ? { created_by: by } : {}),
    });
    expect(result.decision_log_entry.created_by).toBe(by ?? 'acceptance-architect');
    expect(JSON.stringify(result)).not.toContain('raw_secret_synthetic');
    ids.push(result.decision_log_entry.id);
  }
  const persisted = await architect.call('read_work_request', { work_request_id: request });
  expect(persisted.work_request.status).toBe('clarifying');
  expect(persisted.clarification_questions.map((entry: any) => entry.status)).toEqual(['answered', 'closed', 'answered']);
  expect(persisted.decision_log_entries.map((entry: any) => entry.id)).toEqual(ids);
  expect(JSON.stringify(persisted)).not.toContain('raw_secret_synthetic');
});

test('worker context exposes selected decisions and direct dependencies without sibling contracts', async ({ processes }) => {
  const factory = processes.factory();
  const architect = await factory.client();
  const request = await architect.request('Scoped decision context');
  const decision = async (text: string) => (await architect.call('record_decision', {
    work_request_id: request, source_type: 'architect', decision: text, rationale: 'Required context', scope_impact: 'Assigned scope only',
  })).decision_log_entry;
  const selected = await decision('Use the direct dependency contract.');
  const referenced = await decision('Keep referenced decisions available.');
  const hidden = await decision('Confidential sibling-only decision.');
  const [dependency, wp, sibling] = (await architect.call('slice_work_request', { work_packages: [
    contract('Delivered prerequisite'), contract('Scoped worker', { acceptance_criteria: [`Honor ${referenced.id}.`] }),
    contract('Confidential sibling', { engineering_scope: 'Private sibling implementation notes' }),
  ] })).work_package_ids;
  await architect.call('upsert_dependency', { dependent: { kind: 'work_package', id: wp }, prerequisite: { kind: 'work_package', id: dependency }, reason: 'Read prerequisite context.', decision_ref: { id: selected.id } });
  await close(architect, dependency);
  await architect.call('dispatch_work_package', { work_package_id: wp });
  const client = await worker(factory, wp);
  const context = await client.call('read_context');
  expect(context.parent_work_request.id).toBe(request);
  expect(context.direct_dependencies.map((entry: any) => entry.id)).toEqual([dependency]);
  expect(context.selected_decisions.map((entry: any) => entry.id).sort()).toEqual([selected.id, referenced.id].sort());
  for (const value of [sibling, hidden.id, 'Private sibling implementation notes', 'Confidential sibling-only decision.']) expect(JSON.stringify(context)).not.toContain(value);
});

test('explicit trusted local notes remain independent of stale worker authority and guidance capabilities stay scoped', async ({ processes }) => {
  const factory = processes.factory();
  const architect = await factory.client();
  const request = await architect.request('Local operator notes');
  const [wp] = await packages(architect, ['Worker note author']);
  const client = await worker(factory, wp);
  const assignment = (await client.call('get_current_assignment')).assignment;
  const decisionArgs = { work_request_id: request, decision: 'Use sk-synthetic-note-decision',
    rationale: 'Context sk-synthetic-note-rationale', scope_impact: 'Bounded sk-synthetic-note-scope' };
  const note = await client.call('record_work_request_operator_decision', decisionArgs);
  expect(note.decision_log_entry.source_type).toBe('operator');
  expect(note.decision_log_entry.created_by).toBe('acceptance-worker');
  expect(note.decision_log_entry.decision).toBe('Use [REDACTED]');
  expect(JSON.stringify(note)).not.toContain('sk-synthetic');
  const packageNote = (await client.call('add_comment', { body: 'Existing package note' })).comment;
  const observer = await factory.client();
  const localNote = await observer.call('add_work_request_comment', { work_request_id: request,
    body: 'Coordinate ghp_syntheticcomment before slicing', created_by: 'operator sk-synthetic-author',
  });
  expect(localNote.comment.body).toBe('Coordinate [REDACTED] before slicing');
  expect(localNote.comment.source_type).toBe('operator');
  expect(localNote.comment.author_name).toBe('operator [REDACTED]');
  expect(localNote.provenance.created_by).toBe('operator [REDACTED]');
  const localDecision = await observer.call('record_work_request_operator_decision', {
    ...decisionArgs, source_id: 'ghp_syntheticdecision', created_by: 'operator sk-synthetic-decision-author',
  });
  expect(localDecision.decision_log_entry.source_id).toBe('[REDACTED]');
  expect(localDecision.decision_log_entry.created_by).toBe('operator [REDACTED]');
  expect((await observer.call('list_comments', { target_kind: 'work_request', target_id: request })).comments.map((entry: any) => entry.id)).toContain(localNote.comment.id);
  expect((await observer.call('list_comments', { target_kind: 'work_package', target_id: wp })).comments.map((entry: any) => entry.id)).toContain(packageNote.id);
  await observer.reject('list_comments', { target_kind: 'work_request', target_id: 'missing-request' }, 'not_found');
  expect((await observer.call('get_current_assignment')).assignment).toBeNull();
  await client.reject('list_guidance_requests', {}, 'architect_grant_required');
  expect((await architect.call('list_guidance_requests')).guidance_requests).toEqual([]);
  await client.reject('answer_guidance_request', { guidance_request_id: 'missing-guidance', answer: 'Cannot promote authority' }, 'architect_grant_required');
  await client.reject('read_guidance_request', { guidance_request_id: 'missing-guidance' }, 'not_found');
  await architect.reject('read_guidance_request', { guidance_request_id: 'missing-guidance' }, 'not_found');
  await architect.reject('answer_guidance_request', { guidance_request_id: 'missing-guidance', answer: 'No historical fixture' }, 'not_found');
  await architect.call('revoke_work_package_worker_key', { work_package_id: wp, grant_id: assignment.grant_id, reason: 'Retire worker authority' });
  const comment = await client.call('add_work_request_comment', { work_request_id: request, body: 'Explicit local note after revocation', created_by: 'operator sk-synthetic-note-author' });
  expect(comment.comment.source_type).toBe('operator');
  expect(comment.comment.author_name).toBe('operator [REDACTED]');
  expect((await client.rpc('tools/call', { name: 'append_progress', arguments: { summary: 'Still denied', idempotency_key: 'revoked-note' } })).error).toBeTruthy();
  const persisted = await architect.call('read_work_request', { work_request_id: request });
  const stored = persisted.decision_log_entries.find((entry: any) => entry.id === note.decision_log_entry.id);
  expect(stored.decision).toBe('Use [REDACTED]');
  expect(stored.rationale).toBe('Context [REDACTED]');
  expect(stored.scope_impact).toBe('Bounded [REDACTED]');
  expect(JSON.stringify(stored)).not.toContain('sk-synthetic');
  expect((await architect.call('list_comments', { target_kind: 'work_request', target_id: request })).comments.map((entry: any) => entry.id)).toContain(comment.comment.id);
});

test('architect descendant planning stays scoped through terminal closeout and request archive', async ({ processes }) => {
  const factory = processes.factory();
  const architect = await factory.client();
  const request = await architect.request('Architect descendant evidence');
  const [wp] = (await architect.call('slice_work_request', { work_packages: [contract('Secondary planning', { repo: 'example/client', base_branch: 'integration' })] })).work_package_ids;
  const initial = await architect.call('read_task_plan', { work_package_id: wp });
  const updated = await architect.call('update_task_plan', { work_package_id: wp, expected_version: initial.version, nodes: [{ title: 'Inspect descendant', status: 'in_progress' }] });
  expect(updated.plan_nodes[0].title).toBe('Inspect descendant');
  const finding = (await architect.call('append_finding', { work_package_id: wp, title: 'Scoped evidence', body: 'Owned descendant', idempotency_key: 'architect-finding' })).finding;
  const progress = (await architect.call('append_progress', { work_package_id: wp, summary: 'Owned descendant progress', idempotency_key: 'architect-progress' })).progress_event;
  const detail = await architect.inspect(`/api/v1/sympp/operator/work-packages/${wp}`);
  expect(detail.findings[0].id).toBe(finding.id);
  expect(detail.progress[0].id).toBe(progress.id);
  const uri = `sympp://work-packages/${wp}/task_plan.md`;
  expect((await architect.rpc('resources/list')).result.resources.map((entry: any) => entry.uri)).toContain(uri);
  expect((await architect.rpc('resources/read', { uri })).result.contents[0].text).toContain('Inspect descendant');
  const foreign = await factory.client();
  await foreign.request('Other planning owner');
  const [otherWp] = await packages(foreign, ['Private foreign plan']);
  await architect.reject('read_task_plan', { work_package_id: otherWp }, 'not_found');
  expect(JSON.stringify(await architect.rpc('resources/list'))).not.toContain(otherWp);
  await close(architect, wp);
  for (const [name, args] of [
    ['update_task_plan', { expected_version: updated.version, nodes: [{ id: updated.plan_nodes[0].id, status: 'done' }] }],
    ['append_finding', { title: 'Late finding', body: 'Must not persist', idempotency_key: 'late-architect-finding' }],
    ['append_progress', { summary: 'Late progress', idempotency_key: 'late-architect-progress' }],
  ] as const) await architect.reject(name, { work_package_id: wp, ...args }, 'work_package_terminal');
  expect((await architect.inspect(`/api/v1/sympp/operator/work-packages/${wp}`)).findings).toHaveLength(1);
  const staleReader = await factory.client();
  await staleReader.call('claim_local_architect_assignment', { work_request_id: request, claimed_by: 'acceptance-architect' });
  expect((await architect.operator(`/api/v1/sympp/operator/work-requests/${request}/archive`, {})).status).toBe(200);
  await architect.reject('read_task_plan', { work_package_id: wp }, 'claim_lease_lost');
  await staleReader.reject('list_work_requests', {}, 'claim_lease_lost');
});

deliveryTest('worker dependency qualifications survive successor replacement only after explicit input requalification', async ({ delivery: { factory, provider } }) => {
  const architect = await factory.client();
  const request = await architect.request('Worker candidate qualification');
  const [a, b, ui, other] = (await architect.call('slice_work_request', { work_packages: ['Old backend', 'Successor backend', 'Consumer', 'Independent input'].map((title) => contract(title, { kind: 'docs', branch_pattern: 'feature/authority' })) })).work_package_ids;
  const workers = new Map<string, Client>();
  for (const [wp, number, sha] of [[a, 321, head('a')], [b, 322, head('b')], [other, 323, head('d')]] as const) {
    await architect.call('dispatch_work_package', { work_package_id: wp });
    const client = await worker(factory, wp, `worker-${number}`);
    workers.set(wp, client);
    await client.call('attach_branch', { branch: 'feature/authority', head_sha: sha });
    await client.call('attach_pr', { url: prUrl(number), head_sha: sha });
    provider.set(number, pr(number, sha, { headRefName: 'feature/authority' }));
    await client.call('sync_pr');
    await client.call('mark_ready');
  }
  await workers.get(a)!.reject('attach_branch', { branch: 'feature/authority', head_sha: head('b') }, 'already_ready');
  const pinArgs = (target: string, sha: string | null) => ({ dependent: { kind: 'work_package', id: ui }, prerequisite: { kind: 'work_package', id: target }, candidate_head_sha: sha, reason: 'Consume the specifically qualified input.' });
  const pin = (await architect.call('upsert_dependency', pinArgs(a, head('a')))).dependency.id;
  const independentPin = (await architect.call('upsert_dependency', pinArgs(other, head('d')))).dependency.id;
  await architect.call('dispatch_work_package', { work_package_id: ui });
  const consumer = await worker(factory, ui, 'consumer-worker');
  await consumer.call('attach_branch', { branch: 'feature/authority', head_sha: head('c') });
  await consumer.call('attach_pr', { url: prUrl(324), head_sha: head('c') });
  const input = (id: string, target: string, sha: string | null) => ({ dependency_id: id, prerequisite_work_package_id: target, candidate_head_sha: sha });
  const qualify = (inputs: object[], key: string) => consumer.call('append_progress', {
    summary: 'Qualified inputs', idempotency_key: key, payload: { head_sha: head('c'), dependency_inputs: inputs },
  });
  await qualify([input(pin, a, head('a')), input(independentPin, other, head('d'))], 'consume-initial');
  expect((await row(architect, request, ui)).merge_eligibility.reason_codes).not.toContain('dependency_inputs_stale');
  expect((await row(architect, request, ui)).merge_eligibility.reason_codes).toContain('dependency_not_delivered');
  await close(architect, a, 'superseded', { successor_work_package_id: b, superseded_reason: 'New backend contract replaces the original input.' });
  expect((await row(architect, request, ui)).merge_eligibility.reason_codes).toContain('candidate_pin_stale');
  await architect.call('upsert_dependency', { ...pinArgs(b, head('b')), dependency_id: pin });
  expect((await row(architect, request, ui)).merge_eligibility.reason_codes).toContain('dependency_inputs_stale');
  const stale = await consumer.rpc('tools/call', { name: 'append_progress', arguments: { summary: 'Stale input', idempotency_key: 'obsolete-input', payload: { head_sha: head('c'), dependency_inputs: [input(pin, a, head('a'))] } } });
  expect(stale.error.code).toBe(-32602);
  await qualify([input(pin, b, head('b'))], 'consume-successor');
  expect((await row(architect, request, ui)).merge_eligibility.reason_codes).not.toContain('dependency_inputs_stale');
  for (const [wp, number, sha] of [[b, 322, head('b')], [other, 323, head('d')]] as const) {
    provider.set(number, pr(number, sha, { headRefName: 'feature/authority', state: 'MERGED', mergedAt: new Date().toISOString(), mergeCommit: { oid: head('f') } }));
    await workers.get(wp)!.call('sync_pr');
  }
  await architect.call('upsert_dependency', { ...pinArgs(b, null), dependency_id: pin });
  expect((await row(architect, request, ui)).merge_eligibility.reason_codes).toContain('dependency_inputs_stale');
  await qualify([input(pin, b, null)], 'consume-delivered');
  expect((await row(architect, request, ui)).merge_eligibility.reason_codes).not.toContain('dependency_inputs_stale');
  await architect.call('upsert_dependency', { ...pinArgs(b, head('b')), dependency_id: pin });
  expect((await row(architect, request, ui)).merge_eligibility.reason_codes).toContain('dependency_inputs_stale');
  await qualify([input(pin, b, head('b'))], 'consume-restored-pin');
  expect((await consumer.call('mark_ready')).ready).toBe(true);
  expect((await row(architect, request, ui)).merge_eligibility.eligible).toBe(true);
  await architect.call('upsert_dependency', { ...pinArgs(b, head('b')), dependency_id: pin, reason: 'Clarify wording without changing selection.' });
  expect((await row(architect, request, ui)).merge_eligibility.eligible).toBe(true);
  await architect.call('upsert_dependency', { ...pinArgs(b, head('a')), dependency_id: pin });
  expect((await row(architect, request, ui)).merge_eligibility.reason_codes).toContain('candidate_pin_stale');
  await architect.call('upsert_dependency', { ...pinArgs(b, head('b')), dependency_id: pin });
  expect((await row(architect, request, ui)).merge_eligibility.reason_codes).toContain('dependency_inputs_stale');
});
