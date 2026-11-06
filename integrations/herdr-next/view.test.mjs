// Structural checks of the drawn view: Herdr's own `check --print-spec` builds the real view with
// fixture data at a chosen width. This proves element structure and copy, not paint or input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { previewFiles, previewMain } from './preview.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const app = process.env.HERDR_APP || 'herdr-app';
const available = !spawnSync(app, ['--version'], { encoding: 'utf8', windowsHide: true }).error;

async function render(t, spec, main = null) {
  const dir = await mkdtemp(join(tmpdir(), 'sympp spec '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, body] of await previewFiles('sympp-dev-spec', join(here, '..', '..'), spec)) await writeFile(join(dir, name), body);
  if (main) await writeFile(join(dir, 'main.js'), main);
  const result = spawnSync(app, ['check', dir, '--print-spec'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const out = result.stdout;
  return { out, has: (id) => out.includes(`:id[Str("${id}")]`) || out.includes(`Button "${id}"`), text: (value) => out.includes(`text "${value}"`) };
}

const skip = { skip: !available && 'herdr-app is not installed' };

test('the factory ranks what needs you and gives one row per Herdr topic', skip, async (t) => {
  const view = await render(t, { props: {}, width: 1400 });
  for (const id of ['lens-overview', 'breadcrumb', 'crumb-factory', 'factory-main', 'factory-aside', 'needs-queue', 'topic-rows',
    'topic-t-herdr', 'topic-t-tools', 'topic-t-live', 'topic-unsorted', 'need-wr-cross:ask', 'unblocks-wr-cross:ask'])
    assert.ok(view.has(id), id);
  const at = (id) => view.out.indexOf(`:id[Str("${id}")]`);
  assert.ok(at('need-wr-cross:ask') < at('need-guidance:g-web'), 'what unblocks most comes first');
  assert.ok(view.text('Unblocks 2') && view.text('web · shares 1 job with Personal Tools') && view.text('Quiet'));
  assert.ok(view.text('1 needs you') && view.text('2 need you'));
  assert.ok(view.text("You're needed in 2"));
  assert.equal(view.has('topic-nowhere'), false, 'no row for an empty catch-all');
  const narrow = await render(t, { props: { role: 'panel' }, width: 1400 });
  assert.ok(narrow.has('factory') && narrow.has('pin') && !narrow.has('factory-aside'), 'the panel stacks and can be pinned');
});

test('a topic puts each question first with one action; other tasks carry only their name, strip and what went wrong', skip, async (t) => {
  const view = await render(t, { props: { role: 'panel' }, width: 1400, board: 'busy', path: { topic: 't-herdr' } });
  const at = (id) => view.out.indexOf(`:id[Str("${id}")]`);
  assert.ok(at('group-wr-pr') < at('group-wr-docs') && at('group-wr-cross') < at('group-wr-restore'), 'what asks the person comes first');
  assert.ok(view.has('answer-ask:q1') && view.has('answer-ask:g-web'), 'a question with an answer route is answered here');
  assert.ok(view.has('chief-ask:esc-1'), 'one without a route goes to the topic chief');
  assert.equal(view.has('ask-ask:wait-wp-review'), false, 'an unrecorded wait is not repeated beside a real question');
  assert.ok(!view.text('Stuck') && !view.text('Checks failing') && !view.text('No recent report'));
  assert.equal(view.has('issues-wr-pr') && view.has('issues-wr-cross'), false, 'a task with nothing wrong says nothing about itself');
  assert.ok(view.has('strip-wr-restore-2') && !view.has('strip-wr-restore-3'), 'the strip runs once per top-level group');
  assert.ok(view.has('later-t-herdr:') && !view.has('task-wr-badges') && !view.has('task-wr-keys'), 'planned and landed work stay folded');
  assert.ok(view.has('filter-all') && view.has('filter-s-web'), "the topic's spaces are one click away");
  const quiet = await render(t, { props: { role: 'panel' }, width: 1400, board: 'quiet', path: { topic: 't-herdr' } });
  assert.equal(quiet.out.includes(':id[Str("issues-') || quiet.out.includes(':id[Str("ask-'), false, 'nothing is said while all is well');
  assert.doesNotMatch(quiet.out, /text "\d+\/\d+/, 'no counts');
});

test('a space shows only the tasks on its repository, drawn as its topic draws them', skip, async (t) => {
  const space = await render(t, { props: {}, width: 700, board: 'busy', path: { topic: 't-tools', space: 'vps/s-api' } });
  assert.ok(space.text('api') && space.has('task-wr-cross') && space.has('task-wr-restore') && space.has('answer-ask:g-web'));
  assert.ok(space.has('filter-all') && space.has('filter-vps/s-api'), 'back to the whole topic, or on to another space');
  assert.equal(space.has('task-wr-pr') || space.has('task-wr-theme'), false);
  const empty = await render(t, { props: {}, width: 1400, path: { topic: 'unsorted', space: 's-home' } });
  assert.ok(empty.text('Nothing running here'));
});

test('a task shows its packages at work on the pipeline and folds landed and queued work', skip, async (t) => {
  for (const width of [1400, 700]) {
    const view = await render(t, { props: {}, width, board: 'busy', path: { topic: 't-herdr', job: 'wr-restore' }, pkg: 'r-4' });
    for (const id of ['strip-wr-restore', 'pkg-r-4', 'pkg-r-5', 'pkg-r-6', 'pkg-r-7', 'fold-Landed:wr-restore', 'fold-Up next:wr-restore', 'pr-step-r-4', 'pr-r-4', 'review-r-4'])
      assert.ok(view.has(id), `${id} at ${width}`);
    assert.equal(view.has('pkg-r-1') || view.has('pkg-r-9'), false, 'landed and queued packages are folded');
    assert.ok(!view.text('Checks failing') && view.text('Review · round 3'), 'the pipeline shows progress without raising an issue');
    const at = (id) => view.out.indexOf(`:id[Str("${id}")]`);
    assert.ok(at('pkg-r-4') < at('pkg-r-5') && at('pkg-r-5') < at('pkg-r-6'), 'packages stay in planned order');
  }
  const open = await render(t, { props: {}, width: 1400, board: 'busy', path: { topic: 't-herdr', job: 'wr-restore' }, expanded: ['Landed:wr-restore'] });
  assert.ok(open.has('pkg-r-1') && !open.has('pkg-r-9'), 'a fold opens on request');
});

test('a question tops its task, and its package keeps its stage', skip, async (t) => {
  const view = await render(t, { props: { role: 'panel' }, width: 1400, board: 'busy', path: { topic: 't-herdr', job: 'wr-pr' }, pkg: 'wp-review', review: { jobId: 'wr-pr', pkgId: 'wp-review', round: null } });
  const at = (id) => view.out.indexOf(`:id[Str("${id}")]`);
  assert.ok(at('ask-ask:q1') < at('pkg-wp-build') && at('pkg-wp-build') < at('pkg-wp-review'));
  assert.ok(view.has('answer-ask:q1') && view.has('review-wp-review') && view.has('review-rounds'), 'the review opens under its package');
});

test("a task's own tab has no way back, and missing or unreadable tasks say so", skip, async (t) => {
  const tab = await render(t, { props: { job: 'wr-pr' }, width: 1400 });
  assert.ok(tab.has('lens-bar') && tab.has('pkg-wp-review') && !tab.has('lens-back') && !tab.has('new-job'));
  const missing = await render(t, { props: { job: 'wr-gone' }, width: 1400 });
  assert.ok(missing.text("This job isn't here"));
  const shaping = await render(t, { props: { job: 'wr-shaping' }, width: 1400 });
  assert.ok(shaping.text('Not sliced into packages yet'));
  const stale = await render(t, { props: { job: 'wr-pr' }, width: 1400, error: "Can't reach sympp at 127.0.0.1:4000. Check the connection and retry." });
  assert.ok(stale.has('pkg-wp-review') && stale.has('read-status'), 'the last good read stays, with a status mark');
});

test('a selected UI package offers its studio; other packages do not', skip, async (t) => {
  for (const width of [1400, 700]) {
    const ui = await render(t, { props: { job: 'wr-cross' }, width, pkg: 'x-web', expanded: ['Up next:wr-cross'] });
    assert.ok(ui.has('studio-x-web'), `Token UI at ${width}`);
    const other = await render(t, { props: { job: 'wr-pr' }, width, pkg: 'wp-build' });
    assert.equal(other.has('studio-wp-build'), false, `Stage board at ${width}`);
  }
});

// The studio's own pane in each state, drawn from studioview.js with fixed inputs.
const studioCase = (s) => `import { View } from "gpui-kit";
import { theme } from "herdr";
import { studioView } from "./studioview.js";
const CASE = ${JSON.stringify(s)};
const v = { workerChecking: false, moveWorker() {}, goToWorker() {}, openPreview() {}, retry() {}, showPreview() {} };
export default class StudioCase extends View {
  render() { return studioView(v, theme(), CASE); }
}
`;

test('a studio shows a published preview with Open, says when there is none, and shrinks over a native one', skip, async (t) => {
  const base = { pkg: { title: 'Token UI' }, worker: { state: 'live', provider: 'Claude' }, place: { step: null }, kind: 'none', url: null, native: { state: 'idle', error: null, builtAt: null }, landed: false, strip: false };
  const draw = (s) => render(t, {}, studioCase({ ...base, ...s }));
  const web = await draw({ kind: 'web', url: 'http://127.0.0.1:5173/' });
  assert.ok(web.has('studio-head') && web.has('studio-card') && web.has('studio-open'));
  assert.ok(web.text('Token UI') && web.text('Claude · Live') && web.text('http://127.0.0.1:5173/') && web.text('Preview'));
  const none = await draw({});
  assert.ok(none.text("The agent hasn't published a preview yet"));
  assert.equal(none.has('studio-card') || none.has('studio-open'), false);
  const strip = await draw({ kind: 'native', native: { state: 'ready', error: null, builtAt: Date.now() }, strip: true });
  assert.ok(strip.has('studio-head') && strip.text('Sample data · updated just now'));
  assert.equal(strip.has('studio-card') || strip.out.includes('text "Building the preview'), false, 'over a native preview only the header is drawn');
  const failed = await draw({ kind: 'native', native: { state: 'error', error: 'SyntaxError: Unexpected token', builtAt: null } });
  assert.ok(failed.text("The preview didn't build") && failed.text('SyntaxError: Unexpected token'));
  const elsewhere = await draw({ place: { step: 'elsewhere', pane: 'p7', tab: 'tb5' } });
  assert.ok(elsewhere.has('studio-move') && elsewhere.has('studio-go') && elsewhere.text('Claude · in another tab'));
  const waiting = await draw({ worker: { state: 'gone', provider: null } });
  assert.ok(waiting.text('Waiting for the worker') && waiting.has('studio-retry') && waiting.text("The worker isn't running"));
  const landed = await draw({ landed: true });
  assert.ok(landed.text('Landed'));
  assert.equal(landed.has('studio-retry'), false);
});
