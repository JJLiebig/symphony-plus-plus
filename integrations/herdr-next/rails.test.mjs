import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from './mods/sympp/model.js';
import * as R from './mods/sympp/rails.js';
import { NOW, boardPayload } from './fixture.mjs';

const MIN = 60e3;
const jobOf = (id) => M.parseBoard(boardPayload()).jobs.find((job) => job.id === id);
const pkgOf = (job, id) => job.packages.find((pkg) => pkg.id === id);
const shape = (segments) => segments.map((s) => [s.stage, (NOW - s.from) / MIN, (NOW - s.to) / MIN, s.actor, s.waiting]);

test('segments start only at recorded moments and say who is acting', () => {
  const job = jobOf('wr-pr');
  const rows = new Map(R.rowsOf(job, NOW).map((row) => [row.pkg.id, row.segments]));
  // Created, dispatched, review started, you asked 25m ago: no Checks segment, because no checks start was recorded.
  assert.deepEqual(shape(rows.get('wp-review')), [
    ['queued', 600, 300, 'waiting', true], ['build', 300, 200, 'provider', false], ['review', 200, 25, 'provider', false], ['review', 25, 0, 'human', false],
  ]);
  const unasked = R.segmentsOf(pkgOf(job, 'wp-review'), NOW, null).at(-1);
  assert.deepEqual([unasked.actor, unasked.needsYou], ['provider', true], 'without a recorded moment, the person is marked, not given a span');
  assert.deepEqual(shape(R.segmentsOf(pkgOf(job, 'wp-done'), NOW)), [
    ['queued', 3000, 2900, 'waiting', true], ['build', 2900, 2000, 'provider', false], ['review', 2000, 1800, 'provider', false],
  ], 'landed work ends at its recorded delivery');
  const dependency = R.segmentsOf(pkgOf(job, 'wp-queued'), NOW);
  assert.deepEqual(shape(dependency), [['queued', 600, 0, 'dependency', false]]);
  assert.equal(dependency[0].label, 'After Stage board');
  const waiting = { ...pkgOf(job, 'wp-build'), activity: { ...pkgOf(job, 'wp-build').activity, waitingCode: 'awaiting_integration' } };
  const reviewing = { ...pkgOf(job, 'wp-build'), activity: { ...pkgOf(job, 'wp-build').activity, waitingCode: 'review_in_progress' } };
  assert.equal(R.segmentsOf(reviewing, NOW).at(-1).waiting, false, 'a running review is not waiting');
  assert.equal(R.segmentsOf(waiting, NOW).at(-1).waiting, true, 'a recorded waiting reason dims the current span');
  const unrecorded = { ...pkgOf(job, 'wp-build'), stage: 'checks', untimed: true };
  assert.deepEqual(shape(R.segmentsOf(unrecorded, NOW)).at(-1), ['build', 90, 0, 'provider', false], 'an unrecorded stage start is not drawn');
  assert.equal(R.timingsOf(unrecorded, NOW).stage, null);
});

test('work without a PR is work, then done', () => {
  const job = jobOf('wr-nopr');
  assert.deepEqual(shape(R.segmentsOf(pkgOf(job, 'np-1'), NOW)).map((s) => s[0]), ['queued', 'work']);
  assert.equal(R.stageOf({ ...pkgOf(job, 'np-2'), stage: 'review' }), 'work');
  assert.equal(R.STAGE_NAME[R.stageOf(pkgOf(job, 'np-2'))], 'Work');
});

test('review rounds are chips and turn into a road bump from round three', () => {
  const job = jobOf('wr-pr');
  const rounds = R.roundsOf(pkgOf(job, 'wp-review'));
  assert.deepEqual(rounds.map((r) => [r.label, r.current, r.late]), [['R1', false, false], ['R2', false, false], ['R3', true, true]]);
  assert.deepEqual(rounds.map((r) => r.tip), ['Round 1 · findings (4) · 50m', 'Round 2 · findings (2) · 1h 00m', 'Round 3 · in progress']);
  assert.equal(rounds[1].startedAt, NOW - 120 * MIN, 'later rounds start at their recorded moment');
  assert.deepEqual(R.roundsOf(pkgOf(job, 'wp-done')).map((r) => [r.label, r.current]), [['R1', false]], 'an older signal without history still counts');
  assert.deepEqual(R.roundsOf(pkgOf(job, 'wp-queued')), []);
  const before = { ...pkgOf(job, 'wp-build'), round: 0, review: { ...pkgOf(job, 'wp-build').review, type: 'review_suite', history: [] } };
  assert.deepEqual(R.roundsOf(before), [], 'zero rounds before the first review');
});

test('each row has wall time, time in its stage and time in its review', () => {
  const job = jobOf('wr-pr');
  assert.deepEqual(R.timingsOf(pkgOf(job, 'wp-review'), NOW), { total: '5h 00m', stage: '40m', review: '3h 20m' });
  assert.deepEqual(R.timingsOf(pkgOf(job, 'wp-done'), NOW), { total: '18h 20m', stage: null, review: null });
  assert.deepEqual(R.timingsOf(pkgOf(job, 'wp-queued'), NOW), { total: null, stage: null, review: null });
});

test('rows that need the person come first, then packages others wait on', () => {
  const job = jobOf('wr-pr');
  assert.deepEqual(R.railOrder(job).map((pkg) => pkg.id), ['wp-review', 'wp-build', 'wp-queued', 'wp-done']);
  const reversed = { ...job, packages: [...job.packages].reverse() };
  assert.deepEqual(R.railOrder(reversed).map((pkg) => pkg.id), ['wp-review', 'wp-build', 'wp-queued', 'wp-done'], 'positions do not depend on payload order');
  assert.equal(R.moveRow(['a', 'b'], null, 1), 'a');
  assert.equal(R.moveRow(['a', 'b'], 'b', 1), 'b');
});

test('one shared axis starts at the unfinished work, folds idle stretches into a break and ends at now', () => {
  const rows = R.rowsOf(jobOf('wr-pr'), NOW);
  const axis = R.railAxis(rows, NOW);
  assert.equal(axis.start, NOW - 600 * MIN, 'work that landed a day earlier does not squeeze what is moving');
  assert.deepEqual(rows.filter((row) => R.beforeAxis(row, axis)).map((row) => row.pkg.id), ['wp-done']);
  assert.deepEqual(axis.breaks.map((b) => [(NOW - b.from) / MIN, (NOW - b.to) / MIN, b.label]), [[600, 300, '5h 00m']]);
  const xs = [3000, 600, 450, 300, 200, 90, 0].map((m) => axis.x(NOW - m * MIN));
  assert.equal(xs[0], 0);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] >= xs[i - 1], 'time only moves right');
  assert.equal(axis.x(NOW - 450 * MIN), axis.x(NOW - 300 * MIN), 'inside a break no time is drawn');
  const [build, review] = [axis.x(NOW - 200 * MIN) - axis.x(NOW - 300 * MIN), axis.nowX - axis.x(NOW - 200 * MIN)];
  assert.ok(Math.abs(review / build - 2) < 1e-9, 'drawn time is to scale');
  assert.ok(axis.nowX > 0.9 && axis.nowX < 1, 'the now line sits just inside the right edge');
  assert.equal(R.railAxis(rows, NOW, Infinity).breaks.length, 0);
  const landed = R.rowsOf(jobOf('wr-nopr'), NOW).filter((row) => row.pkg.stage === 'done');
  assert.equal(R.railAxis(landed, NOW).start, NOW - 600 * MIN, 'with nothing open, the whole history is shown');
  assert.equal(R.railAxis(R.rowsOf(jobOf('wr-shaping'), NOW), NOW), null);
});
