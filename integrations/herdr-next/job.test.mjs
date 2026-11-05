import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from './mods/sympp/model.js';
import * as J from './mods/sympp/job.js';
import { NOW, boardPayload, detailPayload } from './fixture.mjs';

const jobs = () => M.parseBoard(boardPayload()).jobs;
const jobOf = (id) => jobs().find((job) => job.id === id);
const withPackages = (job, packages) => ({ ...job, packages });

test('the phase comes only from request status, dispatch and delivery', () => {
  const job = jobOf('wr-pr');
  for (const status of ['draft', 'ready_for_clarification', 'clarifying', 'human_info_needed']) assert.equal(J.phaseOf({ ...job, status }), 'shaping');
  assert.equal(J.phaseOf({ ...job, status: 'ready_for_slicing' }), 'planning');
  assert.equal(J.phaseOf(job), 'executing');
  const queuedOnly = job.packages.map((pkg) => ({ ...pkg, stage: 'queued', dispatchedAt: null, outcome: null }));
  assert.equal(J.phaseOf(withPackages(job, queuedOnly)), 'planning', 'sliced with nothing dispatched is still planning');
  const delivered = job.packages.map((pkg, i) => ({ ...pkg, stage: 'done', outcome: i === 0 ? 'dropped' : 'merged' }));
  assert.equal(J.phaseOf(withPackages(job, delivered)), 'closing', 'dropped packages are not required');
  assert.equal(J.phaseOf({ ...job, closedAt: NOW }), 'done');
  assert.equal(J.phaseOf({ ...job, status: 'something_new' }), null, 'an unknown status is not guessed');
});

test('closed execution is Done with dropped scope counted, without inventing completion', () => {
  const payload = boardPayload();
  const detail = payload.work_request_details[0];
  detail.work_request.execution_status = 'closed';
  detail.work_request.completed_at = null;
  detail.clarification_questions = [];
  detail.work_packages = ['pr_merged', 'abandoned', 'superseded', 'skipped'].map((outcome, i) => ({
    id: `closed-${i}`, title: outcome, repo: 'owner/web', raw_status: outcome === 'skipped' ? 'skipped' : 'closed',
    delivery: outcome === 'skipped' ? null : { outcome }, operational_state: { key: outcome },
  }));
  const job = M.parseBoard(payload).jobs.find((job) => job.id === 'wr-pr');
  assert.equal(J.phaseOf(job), 'done');
  assert.equal(job.closedAt, null, 'execution closure does not fabricate fulfilled scope');
  assert.equal(job.status, 'sliced');
  assert.equal(job.state, 'settled');
  assert.equal(job.counts.dropped, 3);
  assert.equal(job.counts.live, 0);
  assert.equal(job.brief, '4 packages closed; 3 dropped.');
  for (const [status, label, dropped] of [['abandoned', 'Dropped', 1], ['closed', 'Closed', 0]]) {
    detail.work_packages = [{ id: 'missing-closeout', raw_status: status, repo: 'owner/web' }];
    const raw = M.parseBoard(payload).jobs.find((job) => job.id === 'wr-pr');
    assert.equal(J.phaseOf(raw), 'done');
    assert.equal(raw.counts.live, 0);
    assert.equal(raw.counts.dropped, dropped);
    assert.equal(M.stageText(raw.packages[0], NOW), label);
    assert.equal(raw.closedAt, null);
    assert.doesNotMatch(raw.brief, /landed|finished/);
  }
});

test('an opened package says who holds the work, what waits, what is next and the evidence, in plain words', () => {
  const job = jobOf('wr-pr');
  const card = (id) => J.packageCard(job.packages.find((pkg) => pkg.id === id), null, NOW);
  const review = card('wp-review');
  assert.deepEqual(review.holder, { text: 'Worker · opus-lens', observation: 'stale' });
  assert.equal(review.waiting, 'Review in progress');
  assert.equal(review.next, 'You · answer guidance');
  assert.equal(review.needsYou, true);
  assert.deepEqual(review.evidence, ['PR #812 open', 'checks passing', 'fast review in progress']);
  assert.match(review.stage, /^Review · round 3/);
  const queued = card('wp-queued');
  assert.equal(queued.stage, null);
  assert.deepEqual(queued.after, ['Stage board']);
  assert.deepEqual(card('wp-build').holder, { text: 'Worker · codex-board', observation: null });
  assert.equal(card('wp-done').next, null);
});

test("an agent's report is its own OSC status, labelled as such, never terminal text", () => {
  const terminal = { address: 't8', status: 'blocked', status_ms: NOW - 4 * 60e3, report: { kind: 'permission', msg: ' Allow edit? ' }, title: 'I am done!' };
  const report = J.agentReport(terminal, NOW);
  assert.deepEqual(report, { status: 'blocked', kind: 'permission', msg: 'Allow edit?', age: '4m ago' });
  assert.equal(J.reportText(report), 'Agent reports blocked (permission): Allow edit? · 4m ago');
  assert.equal(J.agentReport({ address: 't9', title: 'working hard' }, NOW), null, 'no OSC status means no report');
  const older = { address: 't7', status: 'idle', status_ms: NOW - 60 * 60e3 };
  assert.equal(J.reportFor([{ address: 't7' }, { address: 't8' }], [older, terminal], NOW).status, 'blocked', 'the freshest report wins');
});

test('agents are Live only after a fresh matching helper check, else last seen, else unknown', () => {
  const job = jobOf('wr-pr');
  const binding = { jobId: 'wr-pr', pkgId: 'wp-build', address: 't8', available: true, launchId: 'l1', pid: 10, provider: 'Codex' };
  const fresh = { t8: { ok: true, at: NOW - 1000, launchId: 'l1', pid: 10 } };
  const worker = (bindings, checks, now = NOW) => J.participants(job, bindings, checks, now).find((p) => p.pkgId === 'wp-build');
  assert.equal(worker([binding], fresh).state, 'live');
  assert.equal(worker([binding], fresh).attempt, 2, 'the attempt comes from the active run');
  assert.equal(worker([binding], {}).state, 'seen', 'a bound terminal without a check is not live');
  assert.equal(worker([binding], { t8: { ...fresh.t8, ok: false } }).state, 'seen');
  assert.equal(worker([binding], { t8: { ...fresh.t8, pid: 11 } }).state, 'seen', 'a replaced process is not the checked one');
  assert.equal(worker([{ ...binding, available: false }], fresh).state, 'seen');
  assert.equal(worker([binding], fresh, NOW + J.LIVE_FOR + 2000).state, 'seen', 'a check goes stale');
  assert.equal(worker([binding], {}).at, NOW - 3 * 60e3, 'last seen is the active run heartbeat');
  const people = J.participants(job, [], {}, NOW);
  assert.deepEqual(people.find((p) => p.role === 'Architect'), { key: 'architect', role: 'Architect', subject: null, provider: null, state: 'seen', at: NOW - 20 * 60e3, where: 'Herdr' });
  assert.equal(people.find((p) => p.pkgId === 'wp-queued'), undefined, 'queued work has no worker yet');
  const review = people.find((p) => p.role === 'Review');
  assert.deepEqual(review, { key: 'review:review_suite:fast', role: 'Review', provider: 'Review suite · fast', reviewing: 1, state: 'provider' });
  assert.equal(J.participants(jobOf('wr-shaping'), [], {}, NOW)[0].state, 'unknown');
});

test('decisions come from the native job detail, newest first, and other payloads are refused', () => {
  assert.deepEqual(J.decisionsOf(detailPayload()).map((d) => [d.id, d.text, d.by]), [['d2', 'Job level first', 'architect'], ['d1', 'One sympp mod for every level', 'architect']]);
  assert.throws(() => J.decisionsOf({ work_request_details: [] }), /details/);
  assert.equal(J.detailPath('wr/1'), '/api/v1/sympp/herdr/work-requests/wr%2F1');
  const read = { jobId: 'wr-pr', attemptAt: NOW, error: null, failures: 0 };
  assert.equal(J.detailDue(read, 'wr-pr', M.POLL.live, NOW + 1000), false, 'never on every render');
  assert.equal(J.detailDue(read, 'wr-pr', M.POLL.live, NOW + M.POLL.live), true);
  assert.equal(J.detailDue(read, 'wr-other', M.POLL.live, NOW + 1000), true, 'a newly shown job reads at once');
  assert.equal(J.detailDue({ ...read, error: 'down', failures: 3 }, 'wr-pr', M.POLL.live, NOW + 30e3), false, 'failures back off');
});

test("open in tab targets the job's local space and carries this copy's props", () => {
  const job = jobOf('wr-pr');
  const spaces = [
    { id: 'remote', machine: 'build', folder: '/src/web', active: false },
    { id: 'notes', machine: null, folder: 'C:\\code\\notes', active: true },
    { id: 'web', machine: null, folder: 'C:\\code\\owner\\web\\', active: false },
  ];
  const given = { endpoint: 'http://127.0.0.1:4000', role: 'panel', hosts: { local: { node: 'node', helper: 'h' } } };
  assert.deepEqual(J.jobTabArgs(given, job, spaces), {
    name: 'Native job tab', space: 'web', mod: 'sympp',
    props: { endpoint: 'http://127.0.0.1:4000', hosts: { local: { node: 'node', helper: 'h' } }, job: 'wr-pr' },
  });
  assert.equal(J.jobSpace(job, spaces.slice(0, 2)).id, 'notes', 'no local match: the shown space');
  assert.equal(J.jobSpace({ ...job, repos: ['C:/code/owner/web'] }, spaces).id, 'web');
  assert.equal(J.jobTabArgs({}, { ...job, title: 'x'.repeat(40) }, []).name.length, 32);
});
