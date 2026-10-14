import { expect } from 'e2e';
import { test } from '../support/browser-candidate.js';
import { contract } from '../support/factory.js';
import { close, head, pr, prUrl, row, sync } from '../support/delivery.js';
import { installReviewProvider } from '../support/browser-review-provider.js';
import { repository } from '../support/worktree-git.js';
import { readFile } from 'node:fs/promises';

test('operator sees dependency ordering, pending qualification and actual delivered completion', async ({ candidate, app, screen, browser, agent }) => {
  const { client, provider } = candidate;
  let request: string;
  let first!: string;
  let second!: string;
  if (candidate.recording) {
    request = candidate.recorded.work_request_details.find((detail: any) => detail.work_request.title === 'Browser delivery').work_request.id;
  } else {
  request = await client.request('Browser delivery');
  [first, second] = (await client.call('slice_work_request', {
    work_packages: [contract('Service prerequisite'), contract('Dependent findings')],
  })).work_package_ids;
  await client.call('upsert_dependency', {
    dependent: { kind: 'work_package', id: second }, prerequisite: { kind: 'work_package', id: first }, reason: 'The service must land first.',
  });
  await client.reject('dispatch_work_package', { work_package_id: second }, 'unmet_work_package_dependencies');
  await candidate.capture('planned');
  }
  await app.open('/sympp/board');
  const goal = browser.locator(`[data-goal="${request}"]`);
  if (!candidate.recording) {
  await screen.getByText('Not started', { exact: false }).tap();
  await expect(goal).toContainText('0/2 done');

  await client.call('dispatch_work_package', { work_package_id: first });
  await candidate.capture('dispatched');
  await browser.reload();
  }
  if (process.env.SYMPP_BROWSER_NEGATIVE === '1') {
    await agent.act('Open the S++ settings menu for the fail-closed capability probe');
    await expect(screen.getByLabel('Finished goals are archived after', { exact: false })).toBeVisible();
    throw new Error('Unrecorded model action unexpectedly returned');
  }
  if (process.env.SYMPP_BROWSER_MECHANICAL === '1') {
    await screen.getByRole('button', 'Expanded', { exact: true }).tap();
  } else await agent.act('Select Expanded in the Show navigation');
  await expect(screen.getByRole('button', 'See all 2 packages', { exact: true })).toBeVisible();
  await screen.getByRole('button', 'See all 2 packages', { exact: true }).tap();
  await expect(goal).toContainText('Service prerequisite');
  await expect(goal).toContainText('Dependent findings');
  await expect(goal).toContainText('queued');
  await expect(goal).toContainText('0/2 done');
  if (process.env.SYMPP_BROWSER_MECHANICAL === '1') await screen.getByRole('button', 'S++ settings', { exact: true }).tap();
  else await agent.act('Open the S++ settings menu');
  await expect(screen.getByLabel('Finished goals are archived after', { exact: false })).toBeVisible();
  await screen.getByRole('button', 'S++ settings', { exact: true }).tap();
  if (candidate.recording) return;
  const worker = await candidate.factory!.client();
  await worker.call('claim_local_assignment', { work_package_id: first, claimed_by: 'browser-worker' });

  provider!.set(401, pr(401, head('a'), {
    statusCheckRollup: [{ name: 'required', status: 'IN_PROGRESS', conclusion: null }], reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED',
  }));
  await worker.call('attach_branch', { branch: 'feature/delivery-401', head_sha: head('a') });
  await worker.call('attach_pr', { url: prUrl(401), head_sha: head('a') });
  await worker.call('sync_pr', { url: prUrl(401) });
  await candidate.capture('ci-wait');
  await browser.reload();
  await screen.getByRole('button', 'Expanded', { exact: true }).tap();
  await expect(browser.locator(`[data-goal="${request}"] ol span.font-semibold`)).toContainText('Checks');
  expect((await row(client, request, first)).delivery_outcome).toBeNull();
  expect((await client.inspect(`/api/v1/sympp/operator/work-requests/${request}`)).work_request.completed_at).toBeNull();
  await worker.call('release_current_assignment', { reason: 'End the synthetic worker session before architect acceptance.' });
  await client.call('force_release_work_package_claim', { work_package_id: first, reason: 'Recycle the released synthetic worker reservation.' });
  expect((await row(client, request, first)).work_package.runtime_state['active?']).toBe(false);
  provider!.set(401, pr(401, head('a')));
  await sync(client, first, 401, head('a'));
  await candidate.capture('qualified');
  await browser.reload();
  await screen.getByRole('button', 'Expanded', { exact: true }).tap();
  await expect(goal).toContainText('0/2 done');
  expect((await row(client, request, first)).merge_eligibility.eligible).toBe(true);

  provider!.set(401, pr(401, head('a'), { state: 'MERGED', mergedAt: new Date().toISOString(), mergeCommit: { oid: head('f') } }));
  await client.call('sync_pr', { work_package_id: first });
  await candidate.capture('pr-delivered');
  await browser.reload();
  await expect(goal).toContainText('1/2 done');
  expect((await row(client, request, first)).delivery_outcome).toBe('pr_merged');
  await client.call('dispatch_work_package', { work_package_id: second });
  await close(client, second);
  await candidate.capture('finished');
  await browser.reload();
  await expect(goal).toContainText('All 2 packages have landed');
  await expect(screen.getByRole('heading', 'Landed · last 24 hours')).toBeVisible();
  expect((await client.inspect(`/api/v1/sympp/operator/work-requests/${request}`)).work_request.completed_at).toBeTruthy();

  const reviewRepo = await repository(candidate.root, 'browser-review');
  const reviewClient = await candidate.factory!.client();
  const reviewing = await reviewClient.request('Provider-reported review wait', 'ready_for_slicing', 'beta', reviewRepo.origin);
  const [reviewWp] = (await reviewClient.call('slice_work_request', {
    work_packages: [contract('Review provider findings', { review: { type: 'review-suite', args: { mode: 'fast' } } })],
  })).work_package_ids;
  await reviewClient.call('dispatch_work_package', { work_package_id: reviewWp });
  const receipt = await installReviewProvider(candidate);
  const prepared = await reviewClient.call('prepare_work_package_worktree', { work_package_id: reviewWp, target_repo_root: reviewRepo.checkout });
  expect(prepared.worktree.status).toBe('prepared');
  await candidate.capture('provider-review-wait');
  await browser.reload();
  await expect(browser.locator(`[data-goal="${reviewing}"] ol span.font-semibold`)).toContainText('Review');
  expect((await row(reviewClient, reviewing, reviewWp)).delivery_outcome).toBeNull();
  const commands = (await readFile(receipt, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  expect(commands.some((entry) => entry.command === 'codex' && JSON.stringify(entry.argv) === JSON.stringify(['plugin', 'list', '--json']))).toBe(true);
  expect(commands.some((entry) => entry.command === 'python' && JSON.stringify(entry.argv.slice(1)) === JSON.stringify(['--status', '--json', '--cd', prepared.worktree.path, '--base', 'origin/beta']))).toBe(true);
});

test('operator attention differs from explicit blockers and settings/archive actions persist', async ({ candidate, app, screen, browser }) => {
  const { client } = candidate;
  const request = await client.request('Operator choice');
  const [wp] = (await client.call('slice_work_request', { work_packages: [contract('Bounded findings')] })).work_package_ids;
  await client.call('dispatch_work_package', { work_package_id: wp });
  const prematureArchive = await client.operator(`/api/v1/sympp/operator/work-requests/${request}/archive`, {});
  expect(prematureArchive.status).toBe(422);
  expect(prematureArchive.body.error.code).toBe('not_completed');
  const anchor = (await client.call('get_current_assignment')).assignment.work_package_id;
  await client.call('append_progress', {
    work_package_id: anchor, summary: 'An operator scope choice is needed.', idempotency_key: 'browser-escalation',
    payload: { type: 'architect_operator_report', human_escalation: { question: 'Approve the bounded scope?' } },
  });
  await candidate.capture('operator-needed');
  await app.open('/sympp/board');
  const goal = browser.locator(`[data-goal="${request}"]`);
  await expect(goal).toContainText('Approve the bounded scope?');
  await expect(browser.locator('title')).toHaveText(/^\(1\)\s/);
  expect((await row(client, request, wp)).work_package.blocker_state['active?']).toBe(false);
  await client.call('append_progress', {
    work_package_id: wp, summary: 'Required schema missing.', idempotency_key: 'browser-blocker',
    payload: { type: 'blocker', active: true, blocker_id: 'schema' },
  });
  await client.call('append_progress', {
    work_package_id: anchor, summary: 'Scope approved.', idempotency_key: 'browser-escalation-resolved',
    payload: { type: 'architect_operator_report', human_escalation: null },
  });
  await candidate.capture('blocker-without-escalation');
  await browser.reload();
  await expect(goal).not.toContainText('Approve the bounded scope?');
  await expect(browser.locator('title')).toHaveText(/^(?!\(\d+\))\S/);
  expect((await row(client, request, wp)).work_package.blocker_state['active?']).toBe(true);

  await screen.getByRole('button', 'S++ settings', { exact: true }).tap();
  await screen.getByLabel('Finished goals are archived after', { exact: false }).fill('30');
  await screen.getByRole('button', 'Save', { exact: true }).tap();
  await expect.poll(async () => (await client.inspect('/api/v1/sympp/operator/dashboard/hydrated')).settings.work_request_archive_after_days).toBe(30);
  await browser.reload();
  await screen.getByRole('button', 'S++ settings', { exact: true }).tap();
  await expect(screen.getByLabel('Finished goals are archived after', { exact: false })).toHaveValue('30');
  await screen.getByRole('button', 'S++ settings', { exact: true }).tap();

  await close(client, wp);
  await browser.reload();
  await screen.getByRole('button', 'Actions for Operator choice', { exact: true }).tap();
  await screen.getByRole('button', 'Archive', { exact: false }).tap();
  await screen.getByRole('button', 'Archive? Click again', { exact: false }).tap();
  await expect(goal).toHaveCount(0);
  expect((await client.inspect(`/api/v1/sympp/operator/work-requests/${request}`)).work_request.archived_at).toBeTruthy();
  // The candidate UI has no restore control. Exercise the supported operator
  // route mechanically, then prove the restored request returns to the UI.
  expect((await client.operator(`/api/v1/sympp/operator/work-requests/${request}/restore`, {})).status).toBe(200);
  await browser.reload();
  await expect(goal).toContainText('All 1 packages have landed');
  expect((await client.inspect(`/api/v1/sympp/operator/work-requests/${request}`)).work_request.archived_at).toBeNull();

  const intake = await client.operator('/api/v1/sympp/operator/work-requests', {
    title: 'Operator intake', repo: 'example/service', base_branch: 'beta', work_type: 'feature',
    human_description: 'Synthetic operator intake.', desired_dispatch_shape: 'architect_led_feature_branch', constraints: {},
  });
  expect(intake.status).toBe(201);
  const intakeId = intake.body.work_request.work_request.id;
  await browser.reload();
  await screen.getByText('Not started', { exact: false }).tap();
  await expect(browser.locator(`[data-goal="${intakeId}"]`)).toContainText('Operator intake');
});
