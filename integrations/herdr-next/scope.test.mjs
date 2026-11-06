// The Topic, Space and task views' rules: what the person is asked, what went wrong, the strip, the
// order and the folds, from the board as model.js parses it.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from './mods/sympp/model.js';
import * as L from './mods/sympp/levels.js';
import * as S from './mods/sympp/scope.js';
import { NOW, boardPayload, variantPayload, deskFixture } from './fixture.mjs';

const jobsOf = (payload) => M.parseBoard(payload).jobs;
const jobOf = (payload, id) => jobsOf(payload).find((job) => job.id === id);
const task = (payload, id) => S.taskOf(jobOf(payload, id), NOW);
const words = (t) => t.issues.map((i) => i.text);

test("the board's asks are answered through their own route, else through the chief, and an unrecorded wait says so", () => {
  const cross = task(variantPayload('busy'), 'wr-cross');
  assert.deepEqual(cross.asks.map((a) => [a.text, a.question?.route ?? null]), [
    ['Ship tokens before the API?', null],
    ['Which theme tokens?', '/api/v1/sympp/herdr/work-packages/x-web/guidance/g-web/answer'],
  ]);
  const pr = task(variantPayload('busy'), 'wr-pr');
  assert.deepEqual(pr.asks.map((a) => a.text), ['Which order should the levels land in?'], 'an unrecorded wait is not repeated beside a real question');
  const payload = variantPayload('busy');
  payload.work_request_details[0].asks = [{ id: 'w1', kind: 'human_wait', text: null, work_package_id: 'wp-review', answer_route: null }];
  assert.deepEqual(task(payload, 'wr-pr').asks.map((a) => [a.text, a.unrecorded, a.question]), [["Review lens waits on you. Its question isn't recorded.", true, null]]);
  payload.work_request_details[0].asks = [{ id: 'x', kind: 'clarification', text: 'Pick one?', work_package_id: null, answer_route: '//evil.example/answer' }];
  assert.deepEqual(task(payload, 'wr-pr').asks.map((a) => [a.text, a.question]), [['Pick one?', null]], 'an answer never goes anywhere but this factory');
});

test('an older board still asks its open clarification questions, guidance and architect asks, each once', () => {
  const pr = task(boardPayload(), 'wr-pr');
  assert.deepEqual(pr.asks.map((a) => a.text), ['Which order should the levels land in?'], 'the question replaces the generic wait');
  assert.equal(pr.asks[0].question.kind, 'question', 'and is answerable');
  assert.deepEqual(task(boardPayload(), 'wr-cross').asks.map((a) => a.text), ['Ship tokens before the API?', 'Which theme tokens?']);
});

test('what went wrong survives a question, and a quiet worker is named only when the board says so', () => {
  assert.deepEqual(words(task(variantPayload('busy'), 'wr-restore')), ['Checks failing', 'Review round 3'], 'failures first');
  const pr = task(variantPayload('busy'), 'wr-pr');
  assert.ok(pr.asks.length && words(pr).includes('Review round 3'), 'needing the person does not hide trouble');
  assert.deepEqual(words(task(variantPayload('busy'), 'wr-docs')), ['Stuck']);
  assert.deepEqual(words(task(variantPayload('busy'), 'wr-theme')), ['No recent report'], 'a stale worker');
  const payload = variantPayload('quiet');
  const theme = payload.work_request_details.find((d) => d.work_request.id === 'wr-theme').work_packages[0];
  theme.activity_signal = { observation_state: 'queued' };
  assert.deepEqual(words(task(payload, 'wr-theme')), ['No recent report'], 'a dispatched package with no worker yet');
  assert.deepEqual(task(payload, 'wr-theme').evidence[0].issues.map((i) => i.text), ['No worker yet']);
  theme.activity_signal = { observation_state: 'unknown' };
  assert.deepEqual(words(task(payload, 'wr-theme')), [], 'an unknown observation proves nothing either way');
  for (const job of jobsOf(variantPayload('quiet'))) {
    if (job.id !== 'wr-nopr') assert.deepEqual(words(S.taskOf(job, NOW)), [], `${job.id} is quiet`);
  }
});

test("the strip runs the architect's top-level groups in their order, nested groups inside, ungrouped work last", () => {
  const runs = task(variantPayload('busy'), 'wr-restore').strip;
  assert.deepEqual(runs.map((r) => r.pkgs.map((p) => p.id)), [['r-1', 'r-2', 'r-3'], ['r-4', 'r-5', 'r-6'], ['r-7', 'r-8', 'r-9']]);
  assert.deepEqual(task(boardPayload(), 'wr-pr').strip.map((r) => r.pkgs.map((p) => p.id)), [['wp-done', 'wp-build', 'wp-review', 'wp-queued']], 'without groups, one run in planned order');
});

test('needs come first, then trouble, then the rest by when they opened; a task does not move when it advances', () => {
  const { topics, spaces } = deskFixture();
  const desk = L.deskOf(topics, spaces);
  const order = (payload) => {
    const jobs = jobsOf(payload);
    return S.scopeTasks({ topic: 't-herdr' }, desk, jobs, L.placeJobs(jobs, desk), NOW).map((t) => t.job.id);
  };
  const busy = order(variantPayload('busy'));
  assert.deepEqual(busy.slice(0, 2).sort(), ['wr-cross', 'wr-pr']);
  assert.ok(busy.indexOf('wr-docs') < busy.indexOf('wr-badges'), 'trouble before the rest');
  const before = order(variantPayload('quiet'));
  const advanced = variantPayload('quiet');
  const theme = advanced.work_request_details.find((d) => d.work_request.id === 'wr-theme').work_packages[0];
  theme.board_state = { ...theme.board_state, stage: 'review', entered_at: new Date(NOW - 60e3).toISOString() };
  assert.deepEqual(order(advanced), before);
  const space = S.scopeTasks({ topic: 't-tools', space: 'vps/s-api' }, desk, jobsOf(variantPayload('busy')), null, NOW).map((t) => t.job.id);
  assert.deepEqual(space.sort(), ['wr-cross', 'wr-restore'], 'a space keeps only the tasks on its repository');
});

test('a task shows its packages at work and the ones waiting on the person; landed and queued ones fold', () => {
  const parts = S.packageParts(task(variantPayload('busy'), 'wr-restore'));
  assert.deepEqual([parts.active, parts.landed, parts.queued].map((list) => list.map((e) => e.pkg.id)), [['r-4', 'r-5', 'r-6', 'r-7'], ['r-1', 'r-2', 'r-3'], ['r-8', 'r-9']]);
  const pr = S.packageParts(task(variantPayload('busy'), 'wr-pr'));
  assert.ok(pr.active.some((e) => e.pkg.id === 'wp-review' && e.needsYou), 'the package a question is about keeps its row');
});
