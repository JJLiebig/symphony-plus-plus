import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBoard } from './mods/sympp/model.js';
import { decorations, nextDecorations, RESTAMP } from './mods/sympp/chrome.js';
import { boardPayload, NOW } from './fixture.mjs';

test('each sympp terminal on the board gets its stage, review round and need; others get nothing', () => {
  const board = parseBoard(boardPayload());
  const terminal = (address, labels) => ({ address, labels, state: 'live' });
  const map = decorations(board, [
    terminal('t1', { 'sympp.launch_id': 'a', 'sympp.work_request_id': 'wr-pr', 'sympp.work_package_id': 'wp-build' }),
    terminal('t2', { 'sympp.launch_id': 'b', 'sympp.work_request_id': 'wr-pr', 'sympp.work_package_id': 'wp-review' }),
    terminal('t3', { 'sympp.launch_id': 'c', 'sympp.work_request_id': 'wr-pr' }),
    terminal('vps/t4', { 'sympp.session_id': 'd', 'sympp.session_work_package_id': 'wp-done' }),
    terminal('t5', { 'sympp.launch_id': 'e' }),
    terminal('t6', { 'sympp.launch_id': 'f', 'sympp.work_request_id': 'wr-gone', 'sympp.work_package_id': 'wp-gone' }),
    terminal('t7', {}),
  ], 'http://a', NOW);
  const endpoint = 'http://a';
  assert.deepEqual(map, {
    t1: { stage: 'build', round: null, needs: false, endpoint, at: NOW },
    t2: { stage: 'review', round: 3, needs: false, endpoint, at: NOW },
    t3: { stage: null, round: null, needs: true, endpoint, at: NOW },
    'vps/t4': { stage: 'landed', round: null, needs: false, endpoint, at: NOW },
  });
});

test('the shared map changes only when an entry does, is gone, or needs a fresh stamp', () => {
  const A = 'http://a';
  const entry = (stage, at, endpoint = A) => ({ stage, round: null, needs: false, endpoint, at });
  const before = { t1: entry('build', NOW), t2: entry('checks', NOW) };
  const soon = NOW + 5e3;
  assert.equal(nextDecorations(before, { t1: entry('build', soon), t2: entry('checks', soon) }, A, soon), null);
  assert.deepEqual(nextDecorations(before, { t1: entry('build', soon), t2: entry('review', soon) }, A, soon),
    { t1: entry('build', NOW), t2: entry('review', soon) });
  assert.deepEqual(nextDecorations(before, { t1: entry('build', soon) }, A, soon), { t1: entry('build', NOW) });
  const later = NOW + RESTAMP;
  assert.deepEqual(nextDecorations(before, { t1: entry('build', later), t2: entry('checks', later) }, A, later),
    { t1: entry('build', later), t2: entry('checks', later) });

  // Another factory's view keeps its own agents' entries and leaves these alone.
  const B = 'http://b';
  const theirs = { t9: entry('merge', soon, B) };
  assert.deepEqual(nextDecorations(before, theirs, B, soon), { ...before, ...theirs });
  assert.equal(nextDecorations({ ...before, ...theirs }, { t1: entry('build', soon), t2: entry('checks', soon) }, A, soon), null);
});

