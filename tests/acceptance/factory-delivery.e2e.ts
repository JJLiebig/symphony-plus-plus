import { expect } from 'e2e';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { contract } from '../support/factory.js';
import { close, head, pr, prUrl, row, sync, test } from '../support/delivery.js';
import { installReviewProvider } from '../support/browser-review-provider.js';
import { repository } from '../support/worktree-git.js';

test('deployment observations cover every delivered revision and preserve completion through rollback and unavailable history', async ({ delivery: { factory, provider } }) => {
  const architect = await factory.client();
  const request = await architect.request('Deployment truth');
  const ids = (await architect.call('slice_work_request', { work_packages: [contract('First revision'), contract('Second revision')] })).work_package_ids;
  const configRoot = join(factory.home, '.agents', 'splusplus');
  await mkdir(configRoot, { recursive: true });
  const configure = (workflow: string) => writeFile(join(configRoot, 'operator-board.json'), JSON.stringify({
    repos: { 'example/service': { deploy_workflows: { dev: workflow } } },
  }));
  const api = (path: string, value: object, exitCode = 0) => provider.apiReplies.set(path, { stdout: JSON.stringify(value), exitCode });
  api('repos/example/service', { default_branch: 'trunk' });
  const hydrated = async () => {
    const response = await architect.inspect('/api/v1/sympp/operator/dashboard/hydrated');
    return response.work_request_details.find((detail: any) => detail.work_request.id === request).work_request;
  };
  await configure('unfinished.yml');
  expect((await hydrated()).deployments['example/service'].dev.reason).toBe('unfinished');
  const question = (await architect.call('ask_question', { work_request_id: request, category: 'acceptance',
    question: 'Has the delivered scope answered the remaining operator choice?', why_needed: 'Delivery alone must not close an unanswered goal.',
  })).clarification_question.id;
  for (const [index, wp] of ids.entries()) {
    await architect.call('dispatch_work_package', { work_package_id: wp });
    const number = 710 + index;
    const sha = head(index === 0 ? 'a' : 'b');
    provider.set(number, pr(number, sha, { state: 'MERGED', mergedAt: new Date().toISOString(), mergeCommit: { oid: sha } }));
    await sync(architect, wp, number, sha);
  }
  expect((await architect.inspect(`/api/v1/sympp/operator/work-requests/${request}`)).work_request.completed_at).toBeNull();
  expect((await hydrated()).deployments['example/service'].dev.reason).toBe('unfinished');
  await architect.call('close_question', { work_request_id: request, question_id: question, current_status: 'open' });
  const completed = (await architect.inspect(`/api/v1/sympp/operator/work-requests/${request}`)).work_request.completed_at;
  expect(completed).toBeTruthy();
  const run = (id: number, sha: string, conclusion: string | null, hour = 11, patch: object = {}) => ({
    id, head_sha: sha, conclusion, status: 'completed', event: 'push',
    updated_at: `2026-10-10T${hour}:00:00Z`, repository: { full_name: 'example/service' },
    head_repository: { full_name: 'example/service' }, ...patch,
  });
  for (const sha of ['a', 'b']) {
    api(`repos/example/service/compare/${head(sha)}...${head('c')}?per_page=1`, { status: 'ahead' });
    api(`repos/example/service/compare/${head(sha)}...${head('e')}?per_page=1`, { status: 'ahead' });
  }
  api(`repos/example/service/compare/${head('a')}...${head('d')}?per_page=1`, { status: 'ahead' });
  api(`repos/example/service/compare/${head('b')}...${head('d')}?per_page=1`, { status: 'diverged' });
  const observe = async (workflow: string, runs: object[], total = runs.length) => {
    api(`repos/example/service/actions/workflows/${workflow}/runs?per_page=100&page=1`, { workflow_runs: runs, total_count: total });
    await configure(workflow);
    const current = await hydrated();
    expect(current.completed_at).toBe(completed);
    expect(current.default_branch).toBe('trunk');
    return current.deployments['example/service'].dev;
  };
  const deployed = await observe('deployed.yml', [run(1, head('c'), 'success')]);
  expect(deployed.status).toBe('ok');
  expect(deployed.revision).toBe(head('c'));
  expect((await observe('missing-revision.yml', [run(2, head('d'), 'success')])).status).toBe('pending');
  const old = run(3, head('c'), 'success');
  const rollback = run(4, head('d'), 'success', 12);
  const failed = run(5, head('e'), 'failure', 13);
  expect((await observe('rollback.yml', [old, rollback, failed])).status).toBe('failed');
  expect((await observe('failed-after-success.yml', [failed, old])).status).toBe('ok');
  const retry = run(1, head('d'), 'success', 14, { run_attempt: 2 });
  const foreign = run(6, head('c'), 'success', 15, { head_repository: { full_name: 'outsider/service' } });
  const pullRequest = run(7, head('c'), 'success', 16, { event: 'pull_request' });
  expect((await observe('retry.yml', [pullRequest, foreign, old, retry])).status).toBe('pending');
  const pages = Array.from({ length: 100 }, (_, index) => run(index + 20, head('c'), 'success'));
  api('repos/example/service/actions/workflows/pages.yml/runs?per_page=100&page=2', { workflow_runs: [retry], total_count: 101 });
  expect((await observe('pages.yml', pages, 101)).status).toBe('pending');
  const calls = provider.calls.filter((call) => call.argv[0] === 'api').length;
  await hydrated();
  expect(provider.calls.filter((call) => call.argv[0] === 'api')).toHaveLength(calls);
  for (const [workflow, page] of [
    ['duplicate-page.yml', { workflow_runs: [pages[0]], total_count: 101 }],
    ['changing-total.yml', { workflow_runs: [retry], total_count: 102 }],
    ['incomplete.yml', { workflow_runs: [], total_count: 101 }],
  ] as const) {
    api(`repos/example/service/actions/workflows/${workflow}/runs?per_page=100&page=2`, page);
    expect((await observe(workflow, pages, 101)).reason).toBe('unavailable');
  }
  await configure('permission.yml');
  api('repos/example/service/actions/workflows/permission.yml/runs?per_page=100&page=1', { message: 'Unavailable synthetic provider' }, 1);
  expect((await hydrated()).deployments['example/service'].dev.reason).toBe('unavailable');
  expect((await observe('missing-comparison.yml', [run(8, head('f'), 'success')])).reason).toBe('unavailable');
});

test('separate repository deployments preserve live attempt time and no-PR work has no invented revision', async ({ delivery: { factory, provider } }) => {
  const architect = await factory.client();
  const request = await architect.request('Independent deployments');
  const [service, client, noPr] = (await architect.call('slice_work_request', { work_packages: [
    contract('Service deployment'), contract('Client deployment', { repo: 'example/client', base_branch: 'integration' }),
    contract('Accepted investigation', { kind: 'investigation' }),
  ] })).work_package_ids;
  for (const wp of [service, client, noPr]) await architect.call('dispatch_work_package', { work_package_id: wp });
  await close(architect, noPr);
  for (const [wp, number, repo, base] of [[service, 720, 'example/service', 'beta'], [client, 721, 'example/client', 'integration']] as const) {
    provider.set(number, pr(number, head('a'), { url: `https://github.com/${repo}/pull/${number}`, baseRefName: base,
      state: 'MERGED', mergedAt: new Date().toISOString(), mergeCommit: { oid: head('a') } }));
    await architect.call('sync_pr', { work_package_id: wp, url: `https://github.com/${repo}/pull/${number}`, head_sha: head('a') });
  }
  const configRoot = join(factory.home, '.agents', 'splusplus');
  await mkdir(configRoot, { recursive: true });
  await writeFile(join(configRoot, 'operator-board.json'), JSON.stringify({ repos: {
    'example/service': { deploy_workflows: { dev: 'service.yml' } }, 'example/client': { deploy_workflows: { prod: 'client.yml' } },
  } }));
  for (const [repo, workflow, live] of [['example/service', 'service.yml', false], ['example/client', 'client.yml', true]] as const) {
    provider.apiReplies.set(`repos/${repo}`, { stdout: JSON.stringify({ default_branch: 'trunk' }), exitCode: 0 });
    provider.apiReplies.set(`repos/${repo}/actions/workflows/${workflow}/runs?per_page=100&page=1`, { exitCode: 0, stdout: JSON.stringify({ total_count: 1, workflow_runs: [{
      id: 1, head_sha: head('a'), event: 'push', status: live ? 'in_progress' : 'completed', conclusion: live ? null : 'success',
      updated_at: '2026-10-10T11:00:00Z', run_started_at: '2026-10-10T10:30:00Z', repository: { full_name: repo }, head_repository: { full_name: repo },
    }] }) });
  }
  const response = await architect.inspect('/api/v1/sympp/operator/dashboard/hydrated');
  const current = response.work_request_details.find((detail: any) => detail.work_request.id === request).work_request;
  expect(current.completed_at).toBeTruthy();
  expect(current.deployments['example/service'].dev.status).toBe('ok');
  expect(current.deployments['example/client'].prod.status).toBe('pending');
  expect(current.deployments['example/client'].prod.at).toBe('2026-10-10T10:30:00Z');
  expect(current.deployments['example/client'].dev).toBeUndefined();
  const onlyNoPr = await architect.request('No deployed revision');
  const [investigation] = (await architect.call('slice_work_request', { work_packages: [contract('No code delivery', { kind: 'investigation' })] })).work_package_ids;
  await architect.call('dispatch_work_package', { work_package_id: investigation });
  await close(architect, investigation);
  const final = await architect.inspect('/api/v1/sympp/operator/dashboard/hydrated');
  expect(final.work_request_details.find((detail: any) => detail.work_request.id === onlyNoPr).work_request.deployments).toBeUndefined();
});

for (const status of [
  { review: 'rvw_native_progress', mode: 'fast', status: 'running', done: false, progress: 'review 1/2 correctness', head: 'candidate-head', round: 'r1', round_started_at: '2026-10-10T10:00:00Z' },
  { review: 'rvw_native_stale', mode: 'fast', status: 'stale', done: true },
  { status: 'no_review_anchor' },
]) test(`native review observation preserves ${status.status} without inventing delivery`, async ({ delivery: { factory } }) => {
  const repo = await repository(factory.root, 'review-observation');
  const architect = await factory.client();
  const request = await architect.request('Review observation', 'ready_for_slicing', 'beta', repo.origin);
  const [wp] = (await architect.call('slice_work_request', { work_packages: [contract('Observed review', { review: { type: 'review-suite', args: { mode: 'fast' } } })] })).work_package_ids;
  await architect.call('dispatch_work_package', { work_package_id: wp });
  await architect.call('prepare_work_package_worktree', { work_package_id: wp, target_repo_root: repo.checkout });
  await installReviewProvider({ root: factory.root, factory }, status);
  await architect.inspect('/api/v1/sympp/operator/dashboard/hydrated');
  const observed = await row(architect, request, wp);
  expect(observed.delivery_outcome).toBeNull();
  const review = observed.work_package.review_signal;
  expect(review.status).toBe(status.status === 'running' ? 'in_progress' : status.status === 'stale' ? 'failed' : 'pending');
  if (status.status === 'running') {
    expect(review.current).toBe(1);
    expect(review.total).toBe(2);
    expect(review.reviewed_head).toBe('candidate-head');
    expect(review.round_started_at).toBe('2026-10-10T10:00:00Z');
  } else if (status.status === 'no_review_anchor') expect(review.observation_state).toBe('unknown');
});

test('ordinary PR handoff observes pending qualification then reconciles an exact external merge once', async ({ delivery: { factory, provider } }) => {
  const architect = await factory.client();
  const request = await architect.request('Qualified delivery');
  const [wp] = (await architect.call('slice_work_request', { work_packages: [contract('Service change')] })).work_package_ids;
  const dispatch = await architect.call('dispatch_work_package', { work_package_id: wp, future_field: 'ignored' });
  expect(dispatch.worker_bootstrap.type).toBe('assignment');
  expect(dispatch.worker_grant.secret_in_response).toBe(false);
  const detail = () => architect.inspect(`/api/v1/sympp/operator/work-packages/${wp}`);
  const completion = async () => (await architect.inspect(`/api/v1/sympp/operator/work-requests/${request}`)).work_request.completed_at;
  expect(await completion()).toBeNull();

  provider.set(101, pr(101, head('a'), {
    statusCheckRollup: [{ status: 'IN_PROGRESS', conclusion: null }], reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED',
  }));
  await sync(architect, wp, 101, head('a'));
  const waiting = await detail();
  expect(waiting.metadata.pr.check_summary.status).toBe('pending');
  expect(waiting.metadata.pr.review_state.status).toBe('review_required');
  expect((await row(architect, request, wp)).delivery_outcome).toBeNull();
  expect(await completion()).toBeNull();
  // Readiness is the architect handoff, not a claim that native checks passed.
  expect((await row(architect, request, wp)).merge_eligibility.next_action).toBe('verify_native_checks_and_review_then_merge');

  provider.set(101, pr(101, head('a')));
  await sync(architect, wp, 101, head('a'));
  const qualified = await detail();
  expect(qualified.metadata.pr.check_summary.status).toBe('passing');
  expect(qualified.metadata.pr.review_state.status).toBe('approved');
  expect(qualified.metadata.pr.head_sha).toBe(head('a'));
  expect(qualified.metadata.pr.head_changed_at).toBe(waiting.metadata.pr.head_changed_at);
  expect(qualified.metadata.pr.checks_changed_at).not.toBe(waiting.metadata.pr.checks_changed_at);
  await sync(architect, wp, 101, head('a'));
  const repeated = await detail();
  expect(repeated.metadata.pr.head_changed_at).toBe(qualified.metadata.pr.head_changed_at);
  expect(repeated.metadata.pr.checks_changed_at).toBe(qualified.metadata.pr.checks_changed_at);
  expect((await row(architect, request, wp)).merge_eligibility.eligible).toBe(true);
  expect(await completion()).toBeNull();

  const mergeTime = new Date().toISOString();
  provider.set(101, pr(101, head('a'), { state: 'MERGED', mergedAt: mergeTime, mergeCommit: { oid: head('f') } }));
  await architect.call('sync_pr', { work_package_id: wp });
  const delivered = await row(architect, request, wp);
  expect(delivered.raw_status).toBe('merged');
  expect(delivered.delivery_outcome).toBe('pr_merged');
  expect(delivered.delivery.pr_number).toBe(101);
  expect(delivered.delivery.merge_commit_sha).toBe(head('f'));
  expect(Date.parse(delivered.delivery.pr_merged_at)).toBe(Date.parse(mergeTime));
  expect(await completion()).toBeTruthy();
  const revision = (await architect.call('read_plan', { work_request_id: request })).product_tree.latest_revision;
  await architect.call('sync_pr', { work_package_id: wp });
  const replay = await architect.call('reconcile_work_request', { work_request_id: request, apply: true });
  expect(replay.reconciliation.applied_count).toBe(0);
  expect((await row(architect, request, wp)).delivery).toEqual(delivered.delivery);
  expect((await architect.call('read_plan', { work_request_id: request })).product_tree.latest_revision).toEqual(revision);
  const calls = provider.calls.filter(({ argv }) => argv[0] === 'pr');
  expect(calls.length).toBeGreaterThan(0);
  for (const { argv } of calls) {
    expect(argv.slice(0, 6)).toEqual(['pr', 'view', '101', '--repo', 'example/service', '--json']);
    for (const field of ['headRefOid', 'files', 'statusCheckRollup', 'reviewDecision', 'mergedAt', 'mergeCommit']) expect(argv[6].split(',')).toContain(field);
  }
});

test('provider errors and incomplete or wrong-head evidence cannot complete a dispatched package', async ({ delivery: { factory, provider } }) => {
  const architect = await factory.client();
  const request = await architect.request('Untrusted delivery evidence');
  const [wp] = (await architect.call('slice_work_request', { work_packages: [contract('Evidence refusal')] })).work_package_ids;
  await architect.call('dispatch_work_package', { work_package_id: wp });
  const handoff = { work_package_id: wp, url: prUrl(102), head_sha: head('a') };
  await architect.reject('sync_pr', { ...handoff, url: 'https://example.invalid/not-a-pr' }, 'invalid_pr_url');
  for (const [stdout, exitCode, reason] of [
    ['HTTP 401 private synthetic diagnostics', 1, 'gh_unauthorized'], ['HTTP 404 private synthetic diagnostics', 1, 'gh_not_found'],
    ['no such file private synthetic diagnostics', 1, 'gh_unavailable'], ['unexpected private synthetic diagnostics', 2, 'request_failed'],
    ['not JSON', 0, 'invalid_github_response'], ['[]', 0, 'invalid_github_response'],
  ] as const) {
    provider.replies.set(102, { stdout, exitCode });
    const response = await architect.rpc('tools/call', { name: 'sync_pr', arguments: handoff });
    expect(response.error?.data?.reason).toBe(reason);
    expect(provider.calls.at(-1)?.reply.exitCode).toBe(exitCode);
    expect(JSON.stringify(response)).not.toContain('private synthetic diagnostics');
    expect((await row(architect, request, wp)).delivery_outcome).toBeNull();
  }
  for (const patch of [
    { headRefOid: null }, { headRefOid: head('b') }, { baseRefName: 'other' },
    { changedFiles: 2 }, { changedFiles: undefined, files: [] }, { files: undefined }, { files: [] }, { files: [{ path: '', changeType: 'MODIFIED' }] },
    { files: [{ path: 'src/new.ts', changeType: 'RENAMED' }] }, { files: [{ path: 'src/service.ts' }] },
    { files: [{ path: 'src/service.ts', changeType: {} }] }, { url: prUrl(999), number: 999 },
  ]) {
    provider.set(102, pr(102, head('a'), patch));
    const rejected = await architect.rpc('tools/call', { name: 'sync_pr', arguments: handoff });
    expect(rejected.error).toBeTruthy();
    expect((await row(architect, request, wp)).raw_status).toBe('ready_for_worker');
    expect((await row(architect, request, wp)).delivery_outcome).toBeNull();
  }
  provider.set(102, pr(102, head('a'), { changedFiles: undefined, files: [{ path: 'src/new.ts', changeType: 'RENAMED', previous_filename: 'src/old.ts' }], additional_field: true }));
  await sync(architect, wp, 102, head('a'));
  const initial = await architect.inspect(`/api/v1/sympp/operator/work-packages/${wp}`);
  expect(initial.metadata.pr.changed_files[0].previous_path).toBe('src/old.ts');
  expect(initial.metadata.pr.changed_files_count).toBe(1);
  provider.set(102, pr(102, head('a'), {
    state: 'CLOSED', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN',
    statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'STARTUP_FAILURE' }],
  }));
  await sync(architect, wp, 102, head('a'));
  const failed = await architect.inspect(`/api/v1/sympp/operator/work-packages/${wp}`);
  expect(failed.metadata.pr.check_summary.status).toBe('failing');
  expect(failed.metadata.pr.merge_state).toEqual({ merged: false, status: 'blocked' });
  expect((await row(architect, request, wp)).delivery_outcome).toBeNull();
  // A later observation of another head never authorizes terminal reconciliation.
  provider.set(102, pr(102, head('b'), { state: 'MERGED', mergedAt: new Date().toISOString(), mergeCommit: { oid: head('f') } }));
  const wrong = await architect.rpc('tools/call', { name: 'sync_pr', arguments: { work_package_id: wp } });
  expect(wrong.error).toBeTruthy();
  expect((await row(architect, request, wp)).delivery_outcome).toBeNull();
  // Periodic observation persists the mismatched snapshot before refusing merge.
  // Repeating that observation must never promote it to authoritative head evidence.
  for (const changed of [true, false]) {
    const observed = await architect.operator('/api/v1/sympp/operator/github/sync-prs', { mode: 'auto' });
    expect(observed.status).toBe(200);
    expect(observed.body.sync.merged_count).toBe(0);
    expect(observed.body.sync.dashboard_changed).toBe(changed);
    expect(observed.body.sync.results[0].reason).toBe('head_mismatch');
    expect(observed.body.sync.results[0].expected_head_sha).toBe(head('a'));
    const stored = await architect.inspect(`/api/v1/sympp/operator/work-packages/${wp}`);
    expect(stored.progress.filter((event: any) => event.payload?.source_tool === 'sync_pr').at(-1).payload.head_sha).toBe(head('b'));
    expect((await row(architect, request, wp)).raw_status).toBe('ready_for_merge');
    expect((await row(architect, request, wp)).delivery_outcome).toBeNull();
  }
  for (const missing of [{ mergedAt: new Date().toISOString(), mergeCommit: null }, { mergedAt: null, mergeCommit: { oid: head('f') } }]) {
    provider.set(102, pr(102, head('a'), { state: 'MERGED', ...missing }));
    await architect.reject('sync_pr', { work_package_id: wp }, 'missing_strong_pr_evidence');
    expect((await row(architect, request, wp)).delivery_outcome).toBeNull();
  }
  expect((await architect.inspect(`/api/v1/sympp/operator/work-requests/${request}`)).work_request.completed_at).toBeNull();
});

test('typed no-PR closeout resolves blockers once and terminal packages cannot reactivate', async ({ delivery: { factory } }) => {
  const architect = await factory.client();
  const request = await architect.request('No code needed');
  const [wp, abandoned, remaining] = (await architect.call('slice_work_request', {
    work_packages: [contract('Findings', { repo: 'example/client', base_branch: 'integration' }), contract('Unstarted attempt'), contract('Remaining work')],
  })).work_package_ids;
  for (const id of [wp, abandoned]) {
    await architect.call('dispatch_work_package', { work_package_id: id });
    await architect.call('append_progress', { work_package_id: id, summary: 'An explicit prerequisite is missing.', idempotency_key: `block-${id}`, payload: { type: 'blocker', active: true, blocker_id: 'prerequisite' } });
    expect((await row(architect, request, id)).work_package.blocker_state['active?']).toBe(true);
  }
  for (const [outcome, evidence, reason] of [
    ['merged', { merged: {} }, 'invalid_outcome'],
    ['pr_merged', { completed_no_pr: { no_pr_evidence: 'Wrong type' } }, 'conflicting_delivery_evidence'],
    ['completed_no_pr', { completed_no_pr: {} }, 'invalid_evidence'],
    ['completed_no_pr', { completed_no_pr: { no_pr_evidence: '   ' } }, 'invalid_evidence'],
  ] as const) {
    await architect.reject('record_work_package_delivery', { work_package_id: wp, outcome, evidence, idempotency_key: 'invalid-close' }, reason);
    expect((await row(architect, request, wp)).delivery_outcome).toBeNull();
    expect((await row(architect, request, wp)).work_package.blocker_state['active?']).toBe(true);
  }
  for (const [outcome, required] of [
    ['pr_merged', ['pr_url', 'pr_merged_at', 'merge_commit_sha']],
    ['completed_no_pr', ['no_pr_evidence']], ['superseded', ['successor_work_package_id', 'superseded_reason']],
    ['abandoned', ['abandoned_rationale']],
  ] as const) {
    const refused = await architect.reject('record_work_package_delivery', {
      work_package_id: wp, outcome, evidence: { [outcome]: {} }, idempotency_key: 'missing-evidence',
    }, 'invalid_evidence');
    expect(refused.missing_fields).toEqual(required);
  }
  const invalid = await architect.reject('record_work_package_delivery', {
    work_package_id: wp, outcome: 'pr_merged', idempotency_key: 'extra-evidence',
    evidence: { pr_merged: { pr_url: prUrl(105), no_pr_evidence: 'Wrong outcome.' } },
  }, 'invalid_evidence');
  expect(invalid.missing_fields).toEqual(['pr_merged_at', 'merge_commit_sha']);
  expect(invalid.unexpected_fields).toEqual(['no_pr_evidence']);
  expect(invalid.allowed_fields).toEqual(['pr_url', 'pr_number', 'pr_repository', 'pr_merged_at', 'merge_commit_sha']);
  const mergedEvidence = { pr_url: prUrl(105), pr_number: 105, pr_repository: 'example/other', pr_merged_at: new Date().toISOString(), merge_commit_sha: head('f') };
  await architect.reject('record_work_package_delivery', {
    work_package_id: remaining, outcome: 'pr_merged', idempotency_key: 'malformed-reference', evidence: { pr_merged: mergedEvidence },
  }, 'malformed_pr_evidence');
  await architect.reject('record_work_package_delivery', {
    work_package_id: wp, outcome: 'pr_merged', idempotency_key: 'flat-evidence', pr_url: prUrl(105), evidence: { pr_merged: mergedEvidence },
  }, 'unexpected_argument');
  await architect.call('append_progress', { work_package_id: remaining, summary: 'This prose says no PR is needed, but supplies no delivery evidence.', idempotency_key: 'prose-only' });
  expect((await architect.call('reconcile_work_request', { work_request_id: request, apply: true })).reconciliation.applied_count).toBe(0);
  expect((await row(architect, request, remaining)).delivery_outcome).toBeNull();
  const result = await close(architect, wp);
  const scoped = await row(architect, request, wp);
  expect(scoped.work_package.repo).toBe('example/client');
  expect(scoped.work_package.base_branch).toBe('integration');
  expect((await architect.call('read_work_request', { work_request_id: request })).work_request.base_branch).toBe('beta');
  const revision = (await architect.call('read_plan', { work_request_id: request })).product_tree.latest_revision;
  expect((await close(architect, wp)).work_package_delivery.id).toBe(result.work_package_delivery.id);
  expect((await architect.call('read_plan', { work_request_id: request })).product_tree.latest_revision).toEqual(revision);
  const conflict = await architect.rpc('tools/call', { name: 'record_work_package_delivery', arguments: {
    work_package_id: wp, outcome: 'completed_no_pr', idempotency_key: `close-${wp}`,
    evidence: { completed_no_pr: { no_pr_evidence: 'Replace original evidence' } },
  } });
  expect(conflict.error?.data?.reason).toBe('delivery_outcome_conflict');
  expect((await row(architect, request, wp)).delivery).toEqual(scoped.delivery);
  await close(architect, abandoned, 'abandoned', { abandoned_rationale: 'No implementation was started.' });
  for (const [id, status] of [[wp, 'closed'], [abandoned, 'abandoned']]) {
    const before = await row(architect, request, id);
    expect(before.raw_status).toBe(status);
    expect(before.work_package.blocker_state['active?']).toBe(false);
    await architect.call('resolve_blocker', { work_package_id: id, blocker_id: 'prerequisite', resolution: 'Closeout accepted.', summary: 'Already resolved.', idempotency_key: `terminal-resolution-${id}` });
    expect((await row(architect, request, id)).raw_status).toBe(status);
    await architect.reject('update_work_package', { work_package_id: id, expected_contract_revision: 1, patch: { title: 'Reactivate' } }, 'work_package_terminal');
    await architect.reject('skip_work_package', { work_package_id: id, current_status: status }, 'work_package_terminal');
    expect((await row(architect, request, id)).delivery).toEqual(before.delivery);
  }
  await close(architect, remaining);
  // An abandoned required scope is still unresolved, even though all statuses are terminal.
  expect((await architect.inspect(`/api/v1/sympp/operator/work-requests/${request}`)).work_request.completed_at).toBeNull();
});

test('blocked handoff accepts new PR and head observations without reviving an older candidate', async ({ delivery: { factory, provider } }) => {
  const architect = await factory.client();
  const request = await architect.request('Replacement PR observation');
  const [wp] = (await architect.call('slice_work_request', { work_packages: [contract('Changing candidate')] })).work_package_ids;
  await architect.call('dispatch_work_package', { work_package_id: wp });
  await architect.call('append_progress', { work_package_id: wp, summary: 'An ordinary wait is not a blocker.', idempotency_key: 'ordinary-wait', payload: { type: 'waiting', active: true, source_tool: 'report_blocker', blocker_id: 'ordinary' } });
  await architect.call('append_progress', { work_package_id: wp, summary: 'Resolve scope before accepting handoff.', idempotency_key: 'block-scope', payload: { type: 'blocker', active: true, blocker_id: 'scope' } });
  let priorHeadChanged: string | undefined;
  for (const [number, sha] of [[103, head('a')], [103, head('b')], [104, head('c')], [104, head('a')]] as const) {
    provider.set(number, pr(number, sha, sha === head('b') ? { state: 'MERGED', mergedAt: new Date().toISOString(), mergeCommit: { oid: head('e') } } : {}));
    const waiting = await sync(architect, wp, number, sha);
    expect(waiting.pr_sync.readiness_reasons).toContain('no_active_blockers');
    const detail = await architect.inspect(`/api/v1/sympp/operator/work-packages/${wp}`);
    expect(detail.metadata.pr.head_sha).toBe(sha);
    expect(detail.metadata.pr.number).toBe(number);
    expect(detail.metadata.pr.head_changed_at).not.toBe(priorHeadChanged);
    priorHeadChanged = detail.metadata.pr.head_changed_at;
    expect((await row(architect, request, wp)).delivery_outcome).toBeNull();
  }
  await architect.call('resolve_blocker', { work_package_id: wp, blocker_id: 'scope', resolution: 'Scope accepted.', summary: 'Continue handoff.', idempotency_key: 'resolve-scope' });
  expect((await sync(architect, wp, 104, head('a'))).pr_sync.readiness_reasons).toEqual([]);
  expect((await row(architect, request, wp)).merge_eligibility.eligible).toBe(true);
  provider.set(103, pr(103, head('b'), { state: 'MERGED', mergedAt: new Date().toISOString(), mergeCommit: { oid: head('e') } }));
  await architect.reject('sync_pr', { work_package_id: wp }, 'pr_not_merged');
  expect(provider.calls.at(-1)?.argv[2]).toBe('104');
  expect((await row(architect, request, wp)).delivery_outcome).toBeNull();
  provider.set(104, pr(104, head('a'), { state: 'MERGED', mergedAt: new Date().toISOString(), mergeCommit: { oid: head('f') } }));
  await architect.call('sync_pr', { work_package_id: wp });
  expect((await row(architect, request, wp)).delivery.pr_number).toBe(104);
  await architect.call('resolve_blocker', { work_package_id: wp, blocker_id: 'scope', resolution: 'Already closed.', summary: 'Late resolution.', idempotency_key: 'late-resolution' });
  expect((await row(architect, request, wp)).raw_status).toBe('merged');
  expect((await architect.inspect(`/api/v1/sympp/operator/work-requests/${request}`)).work_request.completed_at).toBeTruthy();
  await factory.stop();
  let disconnected: unknown;
  try { await architect.rpc('tools/list'); } catch (error) { disconnected = error; }
  expect(disconnected).toBeTruthy();
  const receipts = (await readFile(factory.receipt, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  expect(receipts.at(-2).phase).toBe('request');
  expect(receipts.at(-2).method).toBe('tools/list');
  expect(receipts.at(-1).phase).toBe('failure');
  expect(receipts.at(-1).error).toBe(String(disconnected));
});
