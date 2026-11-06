import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from './mods/sympp/model.js';
import * as R from './mods/sympp/rails.js';
import { NOW, boardPayload } from './fixture.mjs';

const MIN = 60e3;
const jobOf = (id) => M.parseBoard(boardPayload()).jobs.find((job) => job.id === id);
const pkgOf = (job, id) => job.packages.find((pkg) => pkg.id === id);

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

test('the keys move through rows in drawn order and stop at either end', () => {
  assert.equal(R.moveRow([], 'a', 1), null);
  assert.equal(R.moveRow(['a', 'b'], null, 1), 'a', 'from nowhere to the first row');
  assert.equal(R.moveRow(['a', 'b'], 'a', 1), 'b');
  assert.equal(R.moveRow(['a', 'b'], 'b', 1), 'b', 'the last row stays put');
  assert.equal(R.moveRow(['a', 'b'], 'a', -1), 'a');
});
