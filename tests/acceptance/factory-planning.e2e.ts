import { expect } from 'e2e';
import { contract, test } from '../support/factory.js';

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
  expect((await architect.call('read_work_request', { work_request_id: id })).work_request.status).toBe('human_info_needed');

  const sliced = await architect.call('slice_work_request', { work_packages: [contract('Agreed scope')] });
  expect(sliced.status.work_request_status).toBe('sliced');
  const [wp] = sliced.work_package_ids;
  const before = await architect.call('read_work_request', { work_request_id: id });
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
  expect((await architect.call('read_work_request', { work_request_id: id })).work_packages[0].title).toBe('Refined agreed scope');

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

  const dispatched = await architect.call('dispatch_work_package', { work_package_id: wp });
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
  const id = await architect.request('Repository scope', 'draft');
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
    expect((await architect.call('read_work_request', { work_request_id: id })).work_packages).toEqual([]);
  }
  await architect.reject('slice_work_request', {
    work_packages: [contract('Foreign branch', { repo: 'example/client', base_branch: 'foreign' })],
  }, 'work_package_delivery_scope_out_of_scope');
  for (const patch of [{ title: '' }, { goal: ' ' }, { acceptance_criteria: [null] }, { validation_steps: 'run checks' }, { stop_conditions: {} }]) {
    await architect.reject('slice_work_request', { work_packages: [contract('Invalid contract', patch)] }, 'invalid_work_packages');
  }
  expect((await architect.call('read_work_request', { work_request_id: id })).work_packages).toEqual([]);
  const sliced = await architect.call('slice_work_request', { work_packages: [secondary] });
  const [wp] = sliced.work_package_ids;
  const read = await architect.call('read_work_request', { work_request_id: id });
  expect(read.work_packages[0].repo).toBe('example/client');
  expect(read.work_packages[0].base_branch).toBe('integration');
  const dispatch = await architect.call('dispatch_work_package', { work_package_id: wp });
  expect(dispatch.worker_bootstrap.assignment.work_package.repo).toBe('example/client');
  expect(dispatch.worker_bootstrap.assignment.work_package.base_branch).toBe('integration');
});

test('groups organize scope while the effective dependency graph prevents premature or cyclic dispatch', async ({ factory }) => {
  const architect = await factory.client();
  const id = await architect.request('Grouped plan');
  const survivingParent = (await architect.call('upsert_group', { title: 'Surviving capability' })).group.id;
  const parent = (await architect.call('upsert_group', { title: 'Prerequisites', parent_group_id: survivingParent })).group.id;
  const child = (await architect.call('upsert_group', { title: 'Nested prerequisites', parent_group_id: parent })).group.id;
  const dependentGroup = (await architect.call('upsert_group', { title: 'Consumers' })).group.id;
  const sliced = await architect.call('slice_work_request', {
    work_packages: [contract('API', { group_id: child }), contract('Client', { group_id: dependentGroup }), contract('Independent'), contract('Documentation', { group_id: parent })],
  });
  const [api, client, independent, documentation] = sliced.work_package_ids;
  const dependency = (await architect.call('upsert_dependency', {
    dependent: { kind: 'group', id: dependentGroup }, prerequisite: { kind: 'group', id: parent },
    reason: 'The consumer requires its API.',
  })).dependency.id;
  const unmet = await architect.reject('dispatch_work_package', { work_package_id: client }, 'unmet_work_package_dependencies');
  expect([...unmet.prerequisite_work_package_ids].sort()).toEqual([api, documentation].sort());
  await architect.reject('upsert_dependency', {
    dependent: { kind: 'group', id: parent }, prerequisite: { kind: 'group', id: parent }, reason: 'A group cannot depend on itself.',
  }, 'invalid_dependency');
  const graph = (await architect.call('read_plan', { work_request_id: id, view: 'groups_with_work_packages' })).product_tree.execution_graph;
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
  const beforeDelete = await architect.call('read_work_request', { work_request_id: id });
  const documentationRevision = beforeDelete.work_packages.find((wp: any) => wp.id === documentation).contract_revision;
  await architect.call('delete_group', { group_id: parent });
  const tree = (await architect.call('read_plan', { work_request_id: id, view: 'groups_with_work_packages' })).product_tree;
  expect(tree.groups.some((group: any) => group.id === parent)).toBe(false);
  expect(tree.groups.find((group: any) => group.id === child).parent_group_id).toBe(survivingParent);
  expect(tree.groups.find((group: any) => group.id === child).work_package_ids).toContain(api);
  expect(tree.groups.find((group: any) => group.id === survivingParent).work_package_ids).toContain(documentation);
  expect(tree.root_work_package_ids).toContain(client);
  expect(tree.dependency_intents.some((edge: any) => edge.id === dependency)).toBe(false);
  expect(tree.execution_graph.effective_edges).toEqual([]);
  // Deleting organization never deletes a package or fabricates delivery.
  const afterDelete = await architect.call('read_work_request', { work_request_id: id });
  expect(afterDelete.work_packages).toHaveLength(4);
  expect(afterDelete.work_packages.find((wp: any) => wp.id === documentation).contract_revision).toBe(documentationRevision + 1);
  await architect.reject('update_work_package', {
    work_package_id: documentation, expected_contract_revision: documentationRevision,
    patch: { title: 'Stale ownership edit' },
  }, 'contract_revision_conflict');
  expect((await architect.call('dispatch_work_package', { work_package_id: client })).work_package.id).toBe(client);
});
