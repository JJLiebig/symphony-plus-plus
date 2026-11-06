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

test("the board's asks are answered through their own route, else through the chief, and an unrecorded wait stays silent", () => {
  const cross = task(variantPayload('busy'), 'wr-cross');
  assert.deepEqual(cross.asks.map((a) => [a.text, a.question?.route ?? null]), [
    ['Ship tokens before the API?', null],
    ['Which theme tokens?', '/api/v1/sympp/herdr/work-packages/x-web/guidance/g-web/answer'],
  ]);
  const pr = task(variantPayload('busy'), 'wr-pr');
  assert.deepEqual(pr.asks.map((a) => a.text), ['Which order should the levels land in?'], 'an unrecorded wait is not repeated beside a real question');
  const payload = variantPayload('busy');
  payload.work_request_details[0].asks = [{ id: 'w1', kind: 'human_wait', text: null, work_package_id: 'wp-review', answer_route: null }];
  assert.deepEqual(task(payload, 'wr-pr').asks.map((a) => [a.text, a.unrecorded, a.question]), []);
  payload.work_request_details[0].asks = [{ id: 'x', kind: 'clarification', text: 'Pick one?', work_package_id: null, answer_route: '//evil.example/answer' }];
  assert.deepEqual(task(payload, 'wr-pr').asks.map((a) => [a.text, a.question]), [['Pick one?', null]], 'an answer never goes anywhere but this factory');
  payload.work_request_details[0].asks = ['a', 'b'].map((id) => ({ id, kind: 'guidance', text: 'Ship it?', work_package_id: null, answer_route: `/api/v1/sympp/herdr/work-packages/p/guidance/${id}/answer` }));
  assert.deepEqual(task(payload, 'wr-pr').asks.map((a) => a.question.route.split('/').at(-2)), ['a', 'b'], 'two asks that read alike are both answerable');
});

test('an older board still asks its open clarification questions, guidance and architect asks, each once', () => {
  const pr = task(boardPayload(), 'wr-pr');
  assert.deepEqual(pr.asks.map((a) => a.text), ['Which order should the levels land in?'], 'the question replaces the generic wait');
  assert.equal(pr.asks[0].question.kind, 'question', 'and is answerable');
  assert.deepEqual(task(boardPayload(), 'wr-cross').asks.map((a) => a.text), ['Ship tokens before the API?', 'Which theme tokens?']);
});

test('what went wrong survives a question, and a quiet worker is named only when the board says so', () => {
  assert.deepEqual(words(task(variantPayload('busy'), 'wr-restore')), [], 'failures first');
  const pr = task(variantPayload('busy'), 'wr-pr');
  assert.ok(pr.asks.length && words(pr).length === 0, 'only the recorded question needs the human');
  assert.deepEqual(words(task(variantPayload('busy'), 'wr-docs')), []);
  assert.deepEqual(words(task(variantPayload('busy'), 'wr-theme')), [], 'a stale worker');
  const payload = variantPayload('quiet');
  const theme = payload.work_request_details.find((d) => d.work_request.id === 'wr-theme').work_packages[0];
  theme.activity_signal = { observation_state: 'queued' };
  assert.deepEqual(words(task(payload, 'wr-theme')), [], 'a dispatched package with no worker yet');
  theme.board_state = { ...theme.board_state, stage: 'review' };
  assert.deepEqual(words(task(payload, 'wr-theme')), [], 'past the build no worker is expected');
  theme.board_state = { ...theme.board_state, stage: 'build' };
  theme.activity_signal = { observation_state: 'unknown' };
  assert.deepEqual(words(task(payload, 'wr-theme')), [], 'an unknown observation proves nothing either way');
  for (const job of jobsOf(variantPayload('quiet'))) {
    if (job.id !== 'wr-nopr') assert.deepEqual(words(S.taskOf(job, NOW)), [], `${job.id} is quiet`);
  }
});

test("a task's checks are one live signal, with a slot from the start only where its repository runs CI", () => {
  const busy = variantPayload('busy');
  const ci = (id) => task(busy, id).ci;
  assert.equal(ci('wr-restore'), 'failed', 'any failing check wins');
  assert.equal(ci('wr-status'), 'running', 'then any running one, during review too');
  assert.equal(ci('wr-pr'), 'passed', 'a package with no PR yet does not hold back the ones that passed');
  assert.equal(ci('wr-cross'), 'waiting', 'a repository with CI keeps the slot before any PR opens');
  assert.equal(ci('wr-notes'), null, 'a repository without CI has no slot, even with a PR open');
  assert.equal(ci('wr-nopr'), null, 'nor does work that opens no PR');
  const unknown = variantPayload('busy');
  for (const d of unknown.work_request_details) for (const p of d.work_packages ?? []) delete p.repo_signal;
  assert.equal(task(unknown, 'wr-cross').ci, null, 'without the flag, no slot until checks report');
  assert.equal(task(unknown, 'wr-restore').ci, 'failed');
  const unread = (ci) => S.ciOf({ ci, track: 'pr', stage: 'review', pr: { checks: 'unavailable' } });
  assert.deepEqual([unread(true), unread(null)], ['unknown', null], 'checks that cannot be read keep the slot but claim nothing');
});

test('a review says where it stands in a word or two, and a Build package no worker took reads as empty', () => {
  const pkgs = Object.fromEntries(jobsOf(variantPayload('busy')).flatMap((job) => job.packages).map((p) => [p.id, p]));
  assert.deepEqual(['s-2', 'r-4', 's-1', 'wp-review'].map((id) => S.reviewPhase(pkgs[id])), ['base sign-off', 'deep sign-off', 'GitHub', 'base sign-off']);
  assert.equal(S.reviewPhase(pkgs['r-7']), null, 'no step reported, no phase');
  assert.deepEqual(['s-3', 'r-6', 't-1'].map((id) => S.unmanned(pkgs[id])), [true, false, false]);
});

test("the strip runs the architect's top-level groups in their order, nested groups inside, ungrouped work last", () => {
  const runs = task(variantPayload('busy'), 'wr-restore').strip;
  assert.deepEqual(runs.map((r) => r.pkgs.map((p) => p.id)), [['r-1', 'r-2', 'r-3'], ['r-4', 'r-5', 'r-6'], ['r-7', 'r-8', 'r-9']]);
  assert.deepEqual(task(boardPayload(), 'wr-pr').strip.map((r) => r.pkgs.map((p) => p.id)), [['wp-done', 'wp-build', 'wp-review', 'wp-queued']], 'without groups, one run in planned order');
  const flat = variantPayload('busy');
  const tree = flat.work_request_details.find((d) => d.work_request.id === 'wr-restore').product_tree;
  tree.nodes = [...tree.nodes].reverse().map(({ id, title }) => ({ id, title }));
  assert.deepEqual(task(flat, 'wr-restore').strip.map((r) => r.pkgs.map((p) => p.id)), [['r-1', 'r-2', 'r-3'], ['r-4', 'r-6'], ['r-5'], ['r-7', 'r-8', 'r-9']],
    'a board without ancestry or positions runs each group apart, in the order its packages are planned');
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
  assert.ok(pr.active.some((e) => e.pkg.id === 'wp-review' && !e.needsYou), 'a textless human next actor never creates attention');
});


test('a recorded question keeps landed work visible and keeps its age across polls', () => {
  const payload = variantPayload('busy');
  const detail = payload.work_request_details[0];
  detail.work_packages = detail.work_packages.map((p) => ({ ...p, board_state: { stage: 'done', track: 'pr', delivered: true } }));
  detail.clarification_questions[0].inserted_at = new Date(NOW - 3600e3).toISOString();
  const before = jobOf(payload, 'wr-pr');
  payload.generated_at = new Date(NOW + 2 * 86400e3).toISOString();
  const after = jobOf(payload, 'wr-pr');
  assert.equal(after.lane, 'moving');
  assert.equal(after.verdict, 'needs_you');
  assert.equal(S.taskOf(after, NOW).asks[0].text, 'Which order should the levels land in?');
  assert.equal(after.needs[0].since, NOW - 3600e3);
  assert.equal(L.toastId(after.needs[0]), L.toastId(before.needs[0]));
});
