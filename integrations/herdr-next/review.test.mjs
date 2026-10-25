import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from './mods/sympp/model.js';
import * as R from './mods/sympp/rails.js';
import * as Rv from './mods/sympp/review.js';
import { NOW, boardPayload } from './fixture.mjs';

const MIN = 60e3;
const at = (minutesAgo) => new Date(NOW - minutesAgo * MIN).toISOString();
const jobOf = (id, payload = boardPayload()) => M.parseBoard(payload).jobs.find((job) => job.id === id);
const pkgOf = (job, id) => job.packages.find((pkg) => pkg.id === id);
// The review package with another review signal and stage, as S++ would send it.
const reviewing = (signal, board = { stage: 'review', track: 'pr' }) => {
  const payload = boardPayload();
  const slice = payload.work_request_details[0].work_packages.find((p) => p.id === 'wp-review');
  Object.assign(slice, { review_signal: signal, board_state: board });
  return pkgOf(jobOf('wr-pr', payload), 'wp-review');
};
const rows = (d) => d.rows.map((r) => [r.n, r.lane, r.step, r.outcome, r.findings, r.took, r.current]);

test('a churning review reads as its stage, step ladder and rounds, newest first, in plain words', () => {
  const d = Rv.reviewDetail(pkgOf(jobOf('wr-pr'), 'wp-review'), NOW);
  assert.equal(d.provider, 'Review Suite · fast');
  assert.deepEqual(d.stage, { code: 'decision-pending', text: 'Waiting for the worker to decide on findings', tone: 'waiting' });
  assert.deepEqual(d.ladder, [{ name: 'Broad discovery', state: 'done' }, { name: 'Signoff', state: 'current' }, { name: 'Github', state: 'pending' }]);
  assert.equal(d.progress, null);
  assert.deepEqual(rows(d), [
    [3, 'Tier 1 review', 'Signoff', 'In progress', null, '40m', true],
    [2, 'Follow-up', null, 'Findings', 2, '1h 00m', false],
    [1, 'Tier 1 review', 'Broad discovery', 'Findings', 4, '50m', false],
  ]);
  assert.deepEqual([d.round, d.overall, d.total, d.omitted, d.observation, d.observedAt], ['40m', '3h 20m', 3, 0, null, NOW - 2 * MIN]);
});

test('a 25-round review lists the 20 reported rounds and counts the five before them', () => {
  const history = Array.from({ length: 20 }, (_, i) => ({
    number: i + 6, round_id: `r${i + 6}`, lane: i % 2 ? 'review-followup' : 'review_t1', step: null, status: 'decided',
    outcome: i === 19 ? null : 'findings', findings: null, started_at: at(400 - i * 15), finished_at: i === 19 ? null : at(390 - i * 15),
  }));
  const d = Rv.reviewDetail(reviewing({
    type: 'review_suite', mode: 'fast', status: 'in_progress', provider_status: 'running', round: 25,
    started_at: at(600), round_started_at: at(115), round_history: history,
  }), NOW);
  assert.deepEqual([d.total, d.omitted, d.rows.length], [25, 5, 20]);
  assert.deepEqual([d.rows[0].n, d.rows[0].current, d.rows[0].outcome, d.rows.at(-1).n], [25, true, 'In progress', 6]);
  assert.ok(d.rows.slice(1).every((r) => r.outcome === 'Findings' && r.findings === null), 'finding counts appear only when recorded');
  assert.deepEqual([d.round, d.overall], ['1h 55m', '10h 00m']);
  assert.deepEqual(d.bumps.map((b) => b.text), ['Review is on round 25', 'In review for 10h 00m']);
  assert.equal(d.reslice, true);
});

test('missing times stay missing rather than being guessed', () => {
  const pkg = reviewing({
    type: 'review_suite', status: 'in_progress', provider_status: 'running', round: 2,
    round_history: [
      { number: 1, lane: null, step: null, outcome: 'clean', started_at: null, finished_at: at(30) },
      { number: 2, lane: 'review-github', outcome: null, started_at: null, finished_at: null },
    ],
  });
  const d = Rv.reviewDetail(pkg, NOW);
  assert.deepEqual(rows(d), [[2, 'GitHub review', null, 'In progress', null, null, true], [1, null, null, 'Clean', null, null, false]]);
  assert.deepEqual([d.round, d.overall, d.bumps], [null, null, []], 'no recorded start: no times and no time bump');
  assert.equal(Rv.clock(null, NOW), null);
  const finished = Rv.reviewDetail({ ...pkg, stage: 'merge', review: { ...pkg.review, startedAt: NOW - 90 * MIN, history: [{ ...pkg.review.history[0], n: 1 }] } }, NOW);
  assert.deepEqual([finished.round, finished.overall, finished.rows[0].outcome], [null, '1h 00m', 'Clean'], 'a finished review lasts until its last recorded finish');
});

test('without steps or history the drill-down falls back to step x/y and the round count', () => {
  const d = Rv.reviewDetail(reviewing({ type: 'review_suite', mode: 'fast', status: 'in_progress', current: 2, total: 4, step: 'signoff', round: 2 }), NOW);
  assert.deepEqual(d.stage, { code: null, text: 'In progress', tone: 'active' });
  assert.deepEqual([d.ladder, d.progress, d.total, d.omitted, d.rows], [null, 'Step 2/4 · Signoff', 2, 0, []]);
  assert.equal(Rv.reviewDetail(reviewing({ type: 'review_suite', status: 'in_progress' }), NOW).total, 1, 'an older signal without a count is one round');
});

test('stale and missing observations say so, and unknown stages keep their own words', () => {
  const stale = Rv.reviewDetail(reviewing({ type: 'review_suite', status: 'failed', provider_status: 'stale', observation_state: 'stale', round: 2 }), NOW);
  assert.deepEqual([stale.stage.text, stale.stage.tone, stale.observation], ['Out of date: the code changed after this review', 'bad', 'stale']);
  assert.equal(Rv.reviewDetail(reviewing({ type: 'review_suite', status: 'pending', observation_state: 'unknown' }), NOW).observation, 'unknown');
  assert.deepEqual(Rv.stageOf({ providerStatus: 'paused-by-operator' }), { code: 'paused-by-operator', text: 'Paused by operator', tone: 'quiet' });
  for (const code of ['decision-pending', 'fix-pending', 'followup-pending', 'review-green', 'local-green-handoff', 'retry-requested'])
    assert.notEqual(Rv.stageOf({ providerStatus: code }).text.toLowerCase(), code.replace(/-/g, ' '), `${code} has its own words`);
});

test('a package without a PR or a review says so, and one with a review drills down the same way', () => {
  const plain = Rv.reviewDetail(pkgOf(jobOf('wr-nopr'), 'np-2'), NOW);
  assert.deepEqual([plain.reviewed, plain.stage, plain.rows, plain.bumps, plain.round, plain.overall, plain.total], [false, null, [], [], null, null, 1]);
  const payload = boardPayload();
  const slice = payload.work_request_details[1].work_packages.find((p) => p.id === 'np-2');
  Object.assign(slice, { board_state: { stage: 'review', track: 'no_pr' }, review_signal: { type: 'review_suite', status: 'in_progress', round: 1, started_at: at(20), round_history: [{ number: 1, lane: 'review_t1', started_at: at(20) }] } });
  const reviewed = Rv.reviewDetail(pkgOf(jobOf('wr-nopr', payload), 'np-2'), NOW);
  assert.deepEqual([reviewed.reviewed, reviewed.rows.length, reviewed.overall], [true, 1, '20m']);
});

test('round three and three hours in review are road bumps in the rails, the drill-down and the attention strip', () => {
  const job = jobOf('wr-pr');
  assert.deepEqual(Rv.reviewAlerts(job, NOW).map((a) => [a.pkg.id, a.bumps.map((b) => b.text)]), [['wp-review', ['Review is on round 3', 'In review for 3h 20m']]]);
  assert.deepEqual(R.rowsOf(job, NOW).find((row) => row.pkg.id === 'wp-review').bumps.map((b) => b.kind), ['rounds', 'long']);
  assert.ok(job.bumps.includes('In review for 3h 20m: Review lens'), 'the review start counts, not the latest stage entry');
  const calm = reviewing({ type: 'review_suite', status: 'in_progress', round: 2, started_at: at(179), round_started_at: at(30) });
  assert.deepEqual(M.reviewBumps(calm, NOW), []);
  assert.deepEqual(M.reviewBumps({ ...pkgOf(job, 'wp-review'), stage: 'merge' }, NOW), [], 'a finished review is no longer a bump');
});

test('recorded moments read as clock times, with the date once they are not today', () => {
  assert.match(Rv.clock(NOW - 40 * MIN, NOW), /^\d\d:\d\d$/);
  assert.match(Rv.clock(NOW - 3 * 24 * 60 * MIN, NOW), /^[A-Z][a-z]{2} \d{1,2} \d\d:\d\d$/);
});
