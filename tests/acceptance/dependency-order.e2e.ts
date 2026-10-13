import { expect } from 'e2e';
import { contract, type Client } from '../support/factory.js';
import { close, head, pr, row, sync, test } from '../support/delivery.js';

const endpoint = (id: string, kind = 'work_package') => ({ kind, id });
const graph = async (client: Client, request: string) => (await client.call('read_plan', {
  work_request_id: request, view: 'groups_with_work_packages',
})).product_tree.execution_graph;

test('all dependency endpoint combinations dispatch only after canonical delivery, including successor chains', async ({ delivery: { factory } }) => {
  const architect = await factory.client();
  const request = await architect.request('Dependency delivery');
  const groups = [];
  for (const title of ['Sources', 'Middle', 'Consumers']) groups.push((await architect.call('upsert_group', { title })).group.id);
  const [a, b, c, d, e, direct, next, consumer, successor, final] = (await architect.call('slice_work_request', {
    work_packages: [
      contract('Source one', { group_id: groups[0] }), contract('Source two', { group_id: groups[0] }),
      contract('Middle one', { group_id: groups[1] }), contract('Middle two', { group_id: groups[1] }),
      contract('Group consumer', { group_id: groups[2] }), contract('Direct prerequisite'), contract('Direct dependent'),
      contract('Source group consumer'), contract('Replacement attempt'), contract('Final replacement'),
    ],
  })).work_package_ids;
  for (const [dependent, prerequisite] of [
    [endpoint(next), endpoint(direct)], [endpoint(consumer), endpoint(groups[0], 'group')],
    [endpoint(groups[1], 'group'), endpoint(next)], [endpoint(groups[2], 'group'), endpoint(groups[1], 'group')],
  ]) await architect.call('upsert_dependency', { dependent, prerequisite, reason: 'Required scope must deliver first.' });
  expect((await graph(architect, request)).effective_edges.map((edge: any) => [edge.prerequisite_work_package_id, edge.dependent_work_package_id]).sort())
    .toEqual([[direct, next], [a, consumer], [b, consumer], [next, c], [next, d], [c, e], [d, e]].sort());
  await architect.reject('dispatch_work_package', { work_package_id: next }, 'unmet_work_package_dependencies');
  await architect.call('skip_work_package', { work_package_id: direct, current_status: 'planned' });
  await architect.reject('dispatch_work_package', { work_package_id: next }, 'unmet_work_package_dependencies');
  // Retiring scope is not completion; only the delivered end of the chain satisfies it.
  await close(architect, direct, 'superseded', { successor_work_package_id: successor, superseded_reason: 'A replacement owns the same scope.' });
  await close(architect, successor, 'superseded', { successor_work_package_id: final, superseded_reason: 'The final attempt owns the same scope.' });
  await architect.reject('dispatch_work_package', { work_package_id: next }, 'unmet_work_package_dependencies');
  expect((await row(architect, request, direct)).successor.work_package_id).toBe(successor);
  expect((await row(architect, request, successor)).successor.work_package_id).toBe(final);
  await close(architect, final);
  expect((await architect.call('dispatch_work_package', { work_package_id: next })).work_package.id).toBe(next);
  for (const wp of [a, b, next, c, d, consumer, e]) {
    if (wp !== next) await architect.call('dispatch_work_package', { work_package_id: wp });
    await close(architect, wp);
  }
  expect((await graph(architect, request)).unmet_dependencies).toEqual([]);
  expect((await architect.inspect(`/api/v1/sympp/operator/work-requests/${request}`)).work_request.completed_at).toBeTruthy();
  expect((await row(architect, request, direct)).delivery_outcome).toBe('superseded');
  expect((await row(architect, request, successor)).delivery_outcome).toBe('superseded');
});

test('candidate pins allow dispatch but all overlapping constraints and current dependent inputs gate merge', async ({ delivery: { factory, provider } }) => {
  const architect = await factory.client();
  const request = await architect.request('Exact candidate ordering');
  const group = (await architect.call('upsert_group', { title: 'Consumers' })).group.id;
  const [backend, ui, peer] = (await architect.call('slice_work_request', {
    work_packages: [contract('Backend'), contract('Consumer', { group_id: group }), contract('Peer', { group_id: group })],
  })).work_package_ids;
  await architect.call('dispatch_work_package', { work_package_id: backend });
  provider.set(201, pr(201, head('a')));
  await sync(architect, backend, 201, head('a'));
  const pinned = { dependent: endpoint(group, 'group'), prerequisite: endpoint(backend), candidate_head_sha: head('a'), reason: 'Wire the reviewed candidate.' };
  const pin = (await architect.call('upsert_dependency', pinned)).dependency.id;
  const ordinary = (await architect.call('upsert_dependency', { dependent: endpoint(ui), prerequisite: endpoint(backend), reason: 'Also require delivered scope.' })).dependency.id;
  await architect.reject('dispatch_work_package', { work_package_id: ui }, 'unmet_work_package_dependencies');
  const overlap = (await graph(architect, request)).effective_edges.find((edge: any) => edge.dependent_work_package_id === ui);
  expect(overlap.constraints).toHaveLength(2);
  await architect.call('delete_dependency', { dependency_id: ordinary });
  const dispatch = await architect.call('dispatch_work_package', { work_package_id: ui });
  const selection = dispatch.worker_bootstrap.assignment.dependency_selections[0].constraints[0];
  expect(selection.candidate_head_sha).toBe(head('a'));
  expect(selection.candidate_state).toBe('current');
  expect(selection.selection_updated_at).toBeTruthy();
  const invalidContext = await architect.rpc('tools/call', { name: 'upsert_dependency', arguments: { ...pinned, dependency_id: pin, reason: '', decision_ref: {} } });
  expect(invalidContext.error).toBeTruthy();
  expect((await graph(architect, request)).effective_edges.find((edge: any) => edge.dependent_work_package_id === ui).constraints[0].candidate_head_sha).toBe(head('a'));
  await architect.reject('upsert_dependency', { dependent: endpoint(ui), prerequisite: endpoint(group, 'group'), candidate_head_sha: head('a'), reason: 'A group cannot identify one candidate head.' }, 'invalid_dependency');

  // A branch repair is a real current-head change; old candidate evidence cannot win.
  await architect.call('attach_branch', { work_package_id: backend, branch: 'feature/delivery-201', head_sha: head('b'), idempotency_key: 'backend-changed' });
  await architect.reject('dispatch_work_package', { work_package_id: peer }, 'unmet_work_package_dependencies');
  expect((await graph(architect, request)).effective_edges[0].constraints[0].candidate_state).toBe('stale_head');
  await architect.call('attach_branch', { work_package_id: backend, branch: 'feature/delivery-201', head_sha: head('a'), idempotency_key: 'backend-restored' });
  expect((await architect.call('dispatch_work_package', { work_package_id: peer })).work_package.id).toBe(peer);
  provider.set(202, pr(202, head('c')));
  const staleInputs = await sync(architect, ui, 202, head('c'));
  expect(staleInputs.pr_sync.readiness_reasons).toContain('dependency_inputs_stale');
  const qualify = (sha: string, inputs: object[], key: string) => architect.call('append_progress', {
    work_package_id: ui, summary: 'Architect accepted the controlled candidate qualification.', idempotency_key: key,
    payload: { head_sha: sha, dependency_inputs: inputs },
  });
  const inputs = [{ dependency_id: pin, prerequisite_work_package_id: backend, candidate_head_sha: head('a') }];
  for (const [sha, selections] of [[head('d'), inputs], [head('c'), [{ ...inputs[0], candidate_head_sha: head('b') }]]] as const) {
    const rejected = await architect.rpc('tools/call', { name: 'append_progress', arguments: {
      work_package_id: ui, summary: 'Invalid qualification', idempotency_key: 'invalid-selection', payload: { head_sha: sha, dependency_inputs: selections },
    } });
    expect(rejected.error).toBeTruthy();
  }
  await qualify(head('c'), inputs, 'consume-a');
  await sync(architect, ui, 202, head('c'));
  expect((await row(architect, request, ui)).merge_eligibility.reason_codes).toContain('dependency_not_delivered');
  provider.set(201, pr(201, head('a'), { state: 'MERGED', mergedAt: new Date().toISOString(), mergeCommit: { oid: head('e') } }));
  await architect.call('sync_pr', { work_package_id: backend });
  expect((await row(architect, request, ui)).merge_eligibility.eligible).toBe(true);
  await architect.call('attach_branch', { work_package_id: ui, branch: 'feature/delivery-202', head_sha: head('d'), idempotency_key: 'ui-changed' });
  expect((await row(architect, request, ui)).merge_eligibility.reason_codes).toContain('dependency_inputs_stale');
  // A ready contract edit withdraws readiness and increments its optimistic revision.
  const updated = await architect.call('update_work_package', { work_package_id: ui, expected_contract_revision: 1, patch: { title: 'Revised consumer contract' } });
  expect(updated.contract_revision).toBe(2);
  expect(updated.status.work_package_status).toBe('implementing');
  expect((await row(architect, request, ui)).merge_eligibility.eligible).toBe(false);
  await architect.reject('update_work_package', { work_package_id: ui, expected_contract_revision: 1, patch: { title: 'Stale write' } }, 'contract_revision_conflict');
});

test('clearing a candidate and expanding to a group requires fresh qualification of every prerequisite', async ({ delivery: { factory, provider } }) => {
  const architect = await factory.client();
  const request = await architect.request('Expanded cleared pin');
  const group = (await architect.call('upsert_group', { title: 'Prerequisites' })).group.id;
  const [a, b, ui] = (await architect.call('slice_work_request', {
    work_packages: [contract('First', { group_id: group }), contract('Second', { group_id: group }), contract('Consumer')],
  })).work_package_ids;
  const args = { dependent: endpoint(ui), prerequisite: endpoint(a), candidate_head_sha: head('a'), reason: 'Use current scope.' };
  const dependency = (await architect.call('upsert_dependency', args)).dependency.id;
  await close(architect, a);
  await close(architect, b);
  // A completed no-PR package has no candidate head; removing the pin is explicit.
  await architect.reject('dispatch_work_package', { work_package_id: ui }, 'unmet_work_package_dependencies');
  await architect.call('upsert_dependency', { ...args, dependency_id: dependency, prerequisite: endpoint(group, 'group'), candidate_head_sha: null });
  await architect.call('dispatch_work_package', { work_package_id: ui });
  provider.set(203, pr(203, head('c')));
  await sync(architect, ui, 203, head('c'));
  expect((await row(architect, request, ui)).merge_eligibility.eligible).toBe(false);
  for (const prerequisite of [a, b]) {
    await architect.call('append_progress', {
      work_package_id: ui, summary: 'Accept qualification of the delivered prerequisite.', idempotency_key: `qualify-${prerequisite}`,
      payload: { head_sha: head('c'), dependency_inputs: [{ dependency_id: dependency, prerequisite_work_package_id: prerequisite, candidate_head_sha: null }] },
    });
    if (prerequisite === a) expect((await row(architect, request, ui)).merge_eligibility.reason_codes).toContain('dependency_inputs_stale');
  }
  await sync(architect, ui, 203, head('c'));
  expect((await graph(architect, request)).effective_edges.every((edge: any) => edge.constraints.every((entry: any) => entry.input_current))).toBe(true);
  expect((await row(architect, request, ui)).merge_eligibility.eligible).toBe(true);
});

test('out-of-order external merge remains truthful through dry-run, apply and later prerequisite delivery', async ({ delivery: { factory, provider } }) => {
  const architect = await factory.client();
  const request = await architect.request('External merge order');
  const [backend, ui] = (await architect.call('slice_work_request', { work_packages: [contract('Prerequisite'), contract('Dependent')] })).work_package_ids;
  // Dispatch happened before the architect discovered the dependency.
  await architect.call('dispatch_work_package', { work_package_id: ui });
  await architect.call('upsert_dependency', { dependent: endpoint(ui), prerequisite: endpoint(backend), reason: 'Prerequisite must deliver first.' });
  provider.set(204, pr(204, head('d')));
  expect((await sync(architect, ui, 204, head('d'))).pr_sync.readiness_reasons).toContain('dependencies_unavailable');
  expect((await row(architect, request, ui)).merge_eligibility.eligible).toBe(false);
  const mergeTime = new Date().toISOString();
  provider.set(204, pr(204, head('d'), { state: 'MERGED', mergedAt: mergeTime, mergeCommit: { oid: head('f') } }));
  await sync(architect, ui, 204, head('d'));
  const dry = await architect.call('reconcile_work_request', { work_request_id: request });
  expect(dry.reconciliation.proposed_count).toBe(1);
  expect(dry.reconciliation.applied_count).toBe(0);
  expect((await row(architect, request, ui)).delivery_outcome).toBeNull();
  const applied = await architect.call('reconcile_work_request', { work_request_id: request, apply: true });
  expect(applied.reconciliation.applied_count).toBe(1);
  const merged = await row(architect, request, ui);
  expect(merged.raw_status).toBe('merged');
  expect(merged.delivery_outcome).toBe('pr_merged');
  expect(merged.attention_reason_codes).toContain('delivery_order_violation');
  expect(Date.parse(merged.delivery.pr_merged_at)).toBe(Date.parse(mergeTime));
  expect((await architect.inspect(`/api/v1/sympp/operator/work-requests/${request}`)).work_request.completed_at).toBeNull();
  await close(architect, backend);
  const after = await row(architect, request, ui);
  expect(after.delivery).toEqual(merged.delivery);
  expect(after.merge_eligibility.reason_codes).toContain('delivery_order_violation');
  expect((await architect.call('reconcile_work_request', { work_request_id: request, apply: true })).reconciliation.applied_count).toBe(0);
  expect((await row(architect, request, ui)).delivery).toEqual(merged.delivery);
});
