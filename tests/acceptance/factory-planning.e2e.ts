import { expect } from 'e2e';
import { writeFile } from 'node:fs/promises';
import { contract, test } from '../support/factory.js';

test('dispatch and delivery board payload measurements for a 25-package request', async ({ factory }) => {
  const architect = await factory.client();
  const description = [
    'Deliver a scoped service rollout with separate API, client, storage and operator work.',
    'Each package owns its repository and branch, required checks, review and PR handoff.',
    'Preserve dependency ordering, source attribution, delivery evidence and recovery after restart.',
    'Keep production state and provider credentials outside this disposable acceptance fixture.',
  ].join(' ').repeat(4);
  const created = await architect.call('create_work_request', {
    repo: 'example/service', base_branch: 'beta', title: 'Service rollout payload measurement',
    description, request_kind: 'feature', status: 'ready_for_slicing', claimed_by: 'acceptance-architect',
  });
  const request = created.work_request.id;
  await architect.call('claim_local_architect_assignment', { work_request_id: request, claimed_by: 'acceptance-architect' });
  const ids = (await architect.call('slice_work_request', {
    work_packages: Array.from({ length: 25 }, (_, index) => contract(`Rollout package ${index + 1}`)),
  })).work_package_ids;
  await architect.reject('dispatch_work_package', { work_package_id: ids[0], detail: 'invalid' }, 'invalid_detail');
  const dispatch = (await architect.rpc('tools/call', {
    name: 'dispatch_work_package', arguments: { work_package_id: ids[0] },
  })).result;
  const board = (await architect.rpc('tools/call', {
    name: 'read_delivery_board', arguments: { work_request_id: request },
  })).result;
  expect(dispatch.structuredContent.work_package.id).toBe(ids[0]);
  expect(board.structuredContent.delivery_board.work_packages.length).toBe(25);
  expect(dispatch.structuredContent.worker_bootstrap).toBeUndefined();
  expect(dispatch.content[0].text).toContain(dispatch.structuredContent.assignment_uri);
  const resource = await architect.rpc('resources/read', { uri: dispatch.structuredContent.assignment_uri });
  expect(resource.error).toBeUndefined();
  const bootstrap = JSON.parse(resource.result.contents[0].text);
  const assignment = bootstrap.assignment;
  expect(assignment.work_package.id).toBe(ids[0]);
  expect(assignment.work_package.allowed_file_globs).toEqual(['src/**']);
  expect(assignment.work_package.acceptance_criteria).toEqual(['The agreed behavior is available.']);
  expect(assignment.work_package.validation_steps).toEqual(['Run relevant hosted checks.']);
  expect(assignment.work_package.stop_conditions).toEqual(['Return material scope changes to the architect.']);
  expect(assignment.parent_work_request.goal).toBe(description);
  expect(assignment.work_package.product_description_ref).toBe('#/parent_work_request/goal');
  expect(assignment.work_package.engineering_scope_ref).toBe('#/work_package/goal');
  expect(JSON.stringify(bootstrap).split(description).length - 1).toBe(1);
  expect(bootstrap.launch_prompt).not.toContain(description);
  expect(bootstrap.launch_prompt).toContain('sibling `assignment`');
  const repeated = await architect.rpc('resources/read', { uri: dispatch.structuredContent.assignment_uri });
  expect(JSON.parse(repeated.result.contents[0].text)).toEqual(bootstrap);
  await architect.reject('read_delivery_board', { work_request_id: request, detail: true }, 'invalid_detail');
  const fullBoard = (await architect.rpc('tools/call', {
    name: 'read_delivery_board', arguments: { work_request_id: request, detail: 'full' },
  })).result;
  expect(board.structuredContent.delivery_board.counts).toEqual(fullBoard.structuredContent.delivery_board.counts);
  for (const row of board.structuredContent.delivery_board.work_packages) {
    const full = fullBoard.structuredContent.delivery_board.work_packages.find((item: any) => item.id === row.id);
    expect(row.raw_status).toBe(full.raw_status);
    expect(row.delivery_outcome).toBe(full.delivery_outcome);
    expect(row.attention_reason_codes).toEqual(full.attention_reason_codes);
    expect(row.merge_eligibility).toEqual(full.merge_eligibility);
    expect(row.state).toBe(full.operational_state.key);
    expect(row.work_package).toBeUndefined();
    expect(board.content[0].text).toContain(row.id);
  }
  const fullDispatch = (await architect.rpc('tools/call', {
    name: 'dispatch_work_package', arguments: { work_package_id: ids[1], detail: 'full' },
  })).result;
  expect(fullDispatch.structuredContent.worker_bootstrap.assignment.work_package.product_description).toBe(description);
  expect(fullDispatch.structuredContent.worker_bootstrap.assignment.work_package.engineering_scope).toBe('Deliver Rollout package 2');
  expect(fullDispatch.structuredContent.worker_grant.secret_in_response).toBe(false);
  const outsider = await factory.client();
  const unbound = await outsider.rpc('resources/read', { uri: dispatch.structuredContent.assignment_uri });
  expect(unbound.error).toBeTruthy();
  await outsider.request('Foreign repository request', 'ready_for_slicing', 'beta', 'example/foreign');
  const denied = await outsider.rpc('resources/read', { uri: dispatch.structuredContent.assignment_uri });
  expect(denied.error).toBeTruthy();
  expect(JSON.stringify(denied)).not.toContain(description);
  const chars = (value: unknown) => JSON.stringify(value).length;
  expect(chars(dispatch)).toBeLessThan(chars(fullDispatch) / 2);
  expect(chars(board)).toBeLessThan(chars(fullBoard) / 2);
  // Actual baseline at fc486cee (hosted combined tree f65790a9), using this fixture.
  expect(chars(dispatch)).toBeLessThan(23_384 / 2);
  expect(chars(board)).toBeLessThan(46_312 / 2);
  expect(chars(bootstrap)).toBeLessThan(10_560 / 2);
  const sizes = {
    checkout: process.env.ACCEPTANCE_CHECKOUT_SHA, packages: 25,
    dispatch: chars(dispatch), bootstrap: chars(bootstrap), assignment: chars(assignment), board: chars(board),
    fullDispatch: chars(fullDispatch), fullBoard: chars(fullBoard),
  };
  await writeFile('.e2e/payload-sizes.json', JSON.stringify(sizes, null, 2));
  console.log(`Payload character counts: ${JSON.stringify(sizes)}`);
});

test('skipping every planned package leaves the goal unfinished in persisted and visible state', async ({ factory }) => {
  const architect = await factory.client();
  const request = await architect.request('Skipped scope');
  const ids = (await architect.call('slice_work_request', { work_packages: [contract('Retired first scope'), contract('Retired second scope')] })).work_package_ids;
  for (const work_package_id of ids) await architect.call('skip_work_package', { work_package_id, current_status: 'planned' });
  expect((await architect.inspect(`/api/v1/sympp/operator/work-requests/${request}`)).work_request.completed_at).toBeNull();
  const hydrated = await architect.inspect('/api/v1/sympp/operator/dashboard/hydrated');
  expect(hydrated.work_request_details.find((detail: any) => detail.work_request.id === request).work_request.completed_at).toBeNull();
});

test('a clarified request becomes a revised plan and ordinary worker assignment', async ({ factory }) => {
  const architect = await factory.client();
  const id = await architect.request('Clarified planning', 'human_info_needed');
  const question = await architect.call('ask_question', {
    work_request_id: id, category: 'scope', question: 'Which behavior should ship?',
    why_needed: 'Agree on the bounded outcome before slicing.',
  });
  await architect.reject('slice_work_request', {
    work_packages: [contract('Premature work')],
  }, 'open_questions');
  await architect.call('answer_question', {
    work_request_id: id, question_id: question.clarification_question.id,
    expected_question_status: 'open', answer: 'Ship the agreed behavior.', answered_by: 'human-operator',
  });
  expect((await architect.call('read_work_request', { detail: 'full', work_request_id: id })).work_request.status).toBe('human_info_needed');

  const sliced = await architect.call('slice_work_request', { work_packages: [contract('Agreed scope')] });
  expect(sliced.status.work_request_status).toBe('sliced');
  const [wp] = sliced.work_package_ids;
  const before = await architect.call('read_work_request', { detail: 'full', work_request_id: id });
  expect(before.work_packages).toHaveLength(1);
  const revision = before.work_packages[0].contract_revision;
  const updated = await architect.call('update_work_package', {
    work_package_id: wp, expected_contract_revision: revision, patch: { title: 'Refined agreed scope' },
  });
  expect(updated.contract_revision).toBe(revision + 1);
  const stale = await architect.reject('update_work_package', {
    work_package_id: wp, expected_contract_revision: revision, patch: { title: 'Lost update' },
  }, 'contract_revision_conflict');
  expect(stale.current_contract_revision).toBe(revision + 1);
  expect((await architect.call('read_work_request', { detail: 'full', work_request_id: id })).work_packages[0].title).toBe('Refined agreed scope');

  const plan = await architect.call('read_task_plan', { work_package_id: wp });
  const task = await architect.call('update_task_plan', {
    work_package_id: wp, expected_version: plan.version,
    nodes: [{ title: 'Implement agreed behavior', status: 'pending' }, { title: 'Deferred detail', status: 'skipped' }],
  });
  expect(task.plan_nodes).toHaveLength(2);
  expect((await architect.call('read_task_plan', { work_package_id: wp })).text).toContain('Implement agreed behavior');
  const completed = await architect.call('update_task_plan', {
    work_package_id: wp, expected_version: task.version,
    nodes: [{ id: task.plan_nodes[0].id, status: 'done' }],
  });
  await architect.reject('update_task_plan', {
    work_package_id: wp, expected_version: task.version,
    nodes: [{ id: task.plan_nodes[0].id, status: 'pending' }],
  }, 'stale_plan_version');
  const reread = await architect.call('read_task_plan', { work_package_id: wp });
  expect(reread.version).toBe(completed.version);
  expect(reread.text).toContain('[x]');
  expect(reread.text).toContain('Deferred detail');

  // Dispatch must preserve evidence beyond the virtual document's 100-row cap.
  for (let index = 1; index <= 101; index++) await architect.call('append_finding', {
    work_package_id: wp, title: `Prior finding ${index}`, body: `Prior evidence ${index}`,
    idempotency_key: `prior-${index}`,
  });
  const dispatched = await architect.call('dispatch_work_package', { detail: 'full', work_package_id: wp });
  const prior = dispatched.worker_bootstrap.assignment.prior_findings.findings;
  expect(prior).toHaveLength(101);
  expect(prior[0].body).toBe('Prior evidence 1');
  expect(prior.at(-1).body).toBe('Prior evidence 101');
  expect(dispatched.work_package.id).toBe(wp);
  expect(dispatched.work_package.dispatched_at).toBeTruthy();
  const bootstrap = dispatched.worker_bootstrap;
  expect(bootstrap.type).toBe('assignment');
  const assignment = bootstrap.assignment.work_package;
  expect(assignment.repo).toBe('example/service');
  expect(assignment.base_branch).toBe('beta');
  expect(assignment.goal).toBe('Deliver Agreed scope');
  expect(assignment.allowed_file_globs).toEqual(['src/**']);
  expect(assignment.acceptance_criteria).toEqual(['The agreed behavior is available.']);
  expect(assignment.validation_steps).toEqual(['Run relevant hosted checks.']);
  expect(assignment.stop_conditions).toEqual(['Return material scope changes to the architect.']);
  // No worker client/claim is created. The actual dispatch contract is complete.
  expect(bootstrap.launch_prompt).toContain('No worker MCP calls');
  expect(dispatched.worker_grant.secret_in_response).toBe(false);
});

test('invalid batches are atomic and secondary delivery preserves repository and branch boundaries', async ({ factory }) => {
  const architect = await factory.client();
  const id = await architect.request('Repository scope', 'draft', 'main');
  await architect.reject('slice_work_request', { work_packages: [contract('Premature draft')] }, 'work_request_not_authorable');
  await architect.call('set_work_request_status', { work_request_id: id, current_status: 'draft', next_status: 'ready_for_slicing' });
  const secondary = contract('Secondary implementation', { repo: 'example/client', base_branch: 'integration' });
  const invalid = { ...secondary };
  delete invalid.base_branch;
  await architect.reject('slice_work_request', { work_packages: [contract('Valid prefix'), invalid] }, 'work_package_delivery_scope_out_of_scope');
  for (const required of ['title', 'goal', 'acceptance_criteria']) {
    const incomplete: Record<string, unknown> = contract('One omitted requirement');
    delete incomplete[required];
    await architect.reject('slice_work_request', {
      work_packages: [contract('Valid prefix'), incomplete],
    }, 'invalid_work_packages');
    expect((await architect.call('read_work_request', { detail: 'full', work_request_id: id })).work_packages).toEqual([]);
  }
  await architect.reject('slice_work_request', {
    work_packages: [contract('Foreign branch', { repo: 'example/client', base_branch: 'foreign' })],
  }, 'work_package_delivery_scope_out_of_scope');
  for (const patch of [{ title: '' }, { goal: ' ' }, { acceptance_criteria: [null] }, { validation_steps: 'run checks' }, { stop_conditions: {} }]) {
    await architect.reject('slice_work_request', { work_packages: [contract('Invalid contract', patch)] }, 'invalid_work_packages');
  }
  expect((await architect.call('read_work_request', { detail: 'full', work_request_id: id })).work_packages).toEqual([]);
  const normalized = contract('Canonical primary scope', { base_branch: ' refs/remotes/origin/main ' });
  const sliced = await architect.call('slice_work_request', { work_packages: [secondary, normalized] });
  const [wp, primary] = sliced.work_package_ids;
  const read = await architect.call('read_work_request', { detail: 'full', work_request_id: id });
  expect(read.work_packages[0].repo).toBe('example/client');
  expect(read.work_packages[0].base_branch).toBe('integration');
  const dispatch = await architect.call('dispatch_work_package', { detail: 'full', work_package_id: wp });
  expect(dispatch.worker_bootstrap.assignment.work_package.repo).toBe('example/client');
  expect(dispatch.worker_bootstrap.assignment.work_package.base_branch).toBe('integration');
  expect(read.work_packages.find((wp: any) => wp.id === primary).base_branch).toBe('main');
  const primaryDispatch = await architect.call('dispatch_work_package', { detail: 'full', work_package_id: primary });
  expect(primaryDispatch.worker_bootstrap.assignment.work_package.base_branch).toBe('main');
  expect(primaryDispatch.worker_bootstrap.assignment.work_package.goal).toBe('Deliver Canonical primary scope');
  expect(primaryDispatch.worker_bootstrap.assignment.work_package.engineering_scope).toBe('Deliver Canonical primary scope');
});

test('groups organize scope while the effective dependency graph prevents premature or cyclic dispatch', async ({ factory }) => {
  const architect = await factory.client();
  const id = await architect.request('Grouped plan');
  const survivingParent = (await architect.call('upsert_group', { title: 'Surviving capability' })).group.id;
  const parent = (await architect.call('upsert_group', { title: 'Prerequisites', parent_group_id: survivingParent })).group.id;
  const child = (await architect.call('upsert_group', { title: 'Nested prerequisites', parent_group_id: parent })).group.id;
  const dependentGroup = (await architect.call('upsert_group', { title: 'Consumers' })).group.id;
  const sliced = await architect.call('slice_work_request', {
    work_packages: [contract('API', { group_id: child }), contract('Client', { group_id: dependentGroup }), contract('Independent'), contract('Documentation', { group_id: parent }), contract('Peer API', { group_id: child })],
  });
  const [api, client, independent, documentation, peerApi] = sliced.work_package_ids;
  await architect.call('upsert_dependency', {
    dependent: { kind: 'group', id: child }, prerequisite: { kind: 'group', id: parent },
    reason: 'Child implementations require the parent documentation, not themselves or each other.',
  });
  const overlap = (await architect.call('read_plan', { detail: 'full', work_request_id: id, view: 'groups_with_work_packages' })).product_tree.execution_graph;
  expect(overlap.effective_edges.map((edge: any) => [edge.prerequisite_work_package_id, edge.dependent_work_package_id]).sort())
    .toEqual([[documentation, api], [documentation, peerApi]].sort());
  expect(overlap.cycles).toEqual([]);
  for (const childPackage of [api, peerApi]) {
    const blocked = await architect.reject('dispatch_work_package', { work_package_id: childPackage }, 'unmet_work_package_dependencies');
    expect(blocked.prerequisite_work_package_ids).toEqual([documentation]);
  }
  expect((await architect.call('dispatch_work_package', { work_package_id: documentation })).work_package.id).toBe(documentation);
  const dependency = (await architect.call('upsert_dependency', {
    dependent: { kind: 'group', id: dependentGroup }, prerequisite: { kind: 'group', id: parent },
    reason: 'The consumer requires its API.',
  })).dependency.id;
  const unmet = await architect.reject('dispatch_work_package', { work_package_id: client }, 'unmet_work_package_dependencies');
  expect([...unmet.prerequisite_work_package_ids].sort()).toEqual([api, peerApi, documentation].sort());
  await architect.reject('upsert_dependency', {
    dependent: { kind: 'group', id: parent }, prerequisite: { kind: 'group', id: parent }, reason: 'A group cannot depend on itself.',
  }, 'invalid_dependency');
  const graph = (await architect.call('read_plan', { detail: 'full', work_request_id: id, view: 'groups_with_work_packages' })).product_tree.execution_graph;
  expect(graph.effective_edges.some((edge: any) => edge.dependent_work_package_id === client && edge.prerequisite_work_package_id === api)).toBe(true);
  expect((await architect.call('dispatch_work_package', { work_package_id: independent })).work_package.id).toBe(independent);

  const reverse = (await architect.call('upsert_dependency', {
    dependent: { kind: 'work_package', id: api }, prerequisite: { kind: 'work_package', id: client },
    reason: 'A contradictory planning intent must prevent execution.',
  })).dependency.id;
  await architect.reject('dispatch_work_package', { work_package_id: api }, 'execution_graph_cycle');
  await architect.call('delete_dependency', { dependency_id: reverse });
  await architect.reject('upsert_dependency', {
    dependency_id: 'missing-dependency', dependent: { kind: 'work_package', id: client },
    prerequisite: { kind: 'work_package', id: api }, reason: 'A stale update must not insert.',
  }, 'not_found');

  await architect.call('update_work_package', {
    work_package_id: client, expected_contract_revision: 1, patch: { group_id: null },
  });
  const beforeDelete = await architect.call('read_work_request', { detail: 'full', work_request_id: id });
  const documentationRevision = beforeDelete.work_packages.find((wp: any) => wp.id === documentation).contract_revision;
  await architect.call('delete_group', { group_id: parent });
  const tree = (await architect.call('read_plan', { detail: 'full', work_request_id: id, view: 'groups_with_work_packages' })).product_tree;
  expect(tree.groups.some((group: any) => group.id === parent)).toBe(false);
  expect(tree.groups.find((group: any) => group.id === child).parent_group_id).toBe(survivingParent);
  expect(tree.groups.find((group: any) => group.id === child).work_package_ids).toContain(api);
  expect(tree.groups.find((group: any) => group.id === survivingParent).work_package_ids).toContain(documentation);
  expect(tree.root_work_package_ids).toContain(client);
  expect(tree.dependency_intents.some((edge: any) => edge.id === dependency)).toBe(false);
  expect(tree.execution_graph.effective_edges).toEqual([]);
  // Deleting organization never deletes a package or fabricates delivery.
  const afterDelete = await architect.call('read_work_request', { detail: 'full', work_request_id: id });
  expect(afterDelete.work_packages).toHaveLength(5);
  expect(afterDelete.work_packages.find((wp: any) => wp.id === documentation).contract_revision).toBe(documentationRevision + 1);
  await architect.reject('update_work_package', {
    work_package_id: documentation, expected_contract_revision: documentationRevision,
    patch: { title: 'Stale ownership edit' },
  }, 'contract_revision_conflict');
  expect((await architect.call('dispatch_work_package', { work_package_id: client })).work_package.id).toBe(client);
});
