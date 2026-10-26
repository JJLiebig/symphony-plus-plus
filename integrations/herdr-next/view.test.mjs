// Structural checks of the drawn Job level: Herdr's own `check --print-spec` builds the real view
// with fixture data at a chosen width. This proves element structure and copy, not paint or input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { previewFiles } from './preview.mjs';

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

test('a job tab draws package rails on one axis, with agents and decisions beside them', skip, async (t) => {
  const view = await render(t, { props: { job: 'wr-pr' }, width: 1400, decisionsFor: 'wr-pr' });
  for (const id of ['lens-job', 'job-view', 'phase-strip', 'attention-strip', 'rails', 'rail-axis', 'rail-legend', 'job-aside', 'job-agents', 'job-decisions',
    'rail-wp-review', 'rail-wp-build', 'rail-wp-queued', 'rail-wp-done', 'track-wp-build', 'round-wp-review-3'])
    assert.ok(view.has(id), id);
  const at = (id) => view.out.indexOf(`:id[Str("rail-${id}")]`);
  assert.ok(at('wp-review') < at('wp-build') && at('wp-build') < at('wp-queued') && at('wp-queued') < at('wp-done'), 'needs-you first, then blocking work');
  assert.ok(view.out.includes(':id[Str("axis-break-'), 'the idle stretch folds into a break');
  assert.ok(view.text('⋯ 5h') && view.text('now') && view.text('Landed 1d ago'));
  assert.ok(view.text('Queued · after Stage board'), 'a dependency wait names its prerequisite');
  assert.ok(view.text('R3') && view.text('5h 00m') && view.text('40m') && view.text('3h 20m'));
  assert.ok(view.text('Executing') && view.text('Job level first'));
  assert.ok(view.text('Which order should the levels land in?'), 'open questions stay answerable');
  assert.equal(view.has('open-tab') || view.has('back'), false, 'a job tab has no tab or back control of its own');
  assert.equal(view.has('stage-board') || view.out.includes('column-'), false, 'no stage columns');
  assert.doesNotMatch(view.out, /text "[^"]*%/, 'no progress percentages');
});

test('a round chip opens the review drill-down beside the rails, which stay drawn', skip, async (t) => {
  const view = await render(t, { props: { job: 'wr-pr' }, width: 1400, review: { jobId: 'wr-pr', pkgId: 'wp-review', round: 2 } });
  for (const id of ['rails', 'rail-wp-review', 'job-review-wp-review', 'review-wp-review', 'review-close', 'review-ladder', 'review-step-1', 'review-rounds', 'review-round-3', 'review-round-1', 'review-bump-wp-review', 'bump-wp-review'])
    assert.ok(view.has(id), id);
  assert.ok(view.out.includes('Button "round-wp-review-3"'), 'round chips are buttons');
  assert.equal(view.has('job-aside'), false, 'the drill-down takes the side column');
  assert.ok(view.text('Review · Review Suite · fast') && view.text('Waiting for the worker to decide on findings'));
  assert.ok(view.text('Tier 1 review · Signoff') && view.text('Findings (4)') && view.text('In progress') && view.text('Signoff'));
  assert.ok(view.text('Review is on round 3 · In review for 3h 20m') && view.text('Reviews this long often mean the package is too big. Consider reslicing it.'));
  const order = ['review-round-3', 'review-round-2', 'review-round-1'].map((id) => view.out.indexOf(`:id[Str("${id}")]`));
  assert.ok(order[0] < order[1] && order[1] < order[2], 'newest round first');
});

test('narrow views open the drill-down under its row', skip, async (t) => {
  const view = await render(t, { props: { job: 'wr-pr' }, width: 700, review: { jobId: 'wr-pr', pkgId: 'wp-review', round: null } });
  assert.ok(view.has('rails-compact') && view.has('review-wp-review') && view.has('review-rounds'));
  assert.equal(view.has('job-review-wp-review'), false);
  const at = (id) => view.out.indexOf(`:id[Str("${id}")]`);
  assert.ok(at('rail-wp-review') < at('review-wp-review') && at('review-wp-review') < at('rail-wp-build'), 'inline, under its own row');
});

test('narrow job tabs stack one compact line per package with the same timings', skip, async (t) => {
  const view = await render(t, { props: { job: 'wr-pr' }, width: 700, decisionsFor: 'wr-pr' });
  assert.ok(view.has('job-view-tab') && view.has('rails-compact') && view.has('rail-wp-review'));
  assert.equal(view.has('rails') || view.has('rail-axis') || view.has('job-aside'), false);
  assert.ok(view.text('Review · 40m in stage · 3h 20m in review · 5h 00m total'));
  assert.ok(view.has('job-agents') && view.has('job-decisions'));
});

test('a job without PRs shows work, then done', skip, async (t) => {
  const view = await render(t, { props: { job: 'wr-nopr' }, width: 1400 });
  assert.ok(view.has('rail-np-1') && view.has('rail-np-2') && view.text('Work'));
  assert.ok(view.text('Reading decisions…'), 'decisions for another job are not shown as this one');
});

test('missing, empty and stale jobs say so', skip, async (t) => {
  const missing = await render(t, { props: { job: 'wr-gone' }, width: 1400 });
  assert.ok(missing.text("This job isn't here"));
  const shaping = await render(t, { props: { job: 'wr-shaping' }, width: 1400 });
  assert.ok(shaping.text('Shaping') && shaping.text('Not sliced into packages yet.'));
  const stale = await render(t, { props: { job: 'wr-pr' }, width: 1400, error: "Can't reach S++ at 127.0.0.1:4000. Check the connection and retry." });
  assert.ok(stale.has('rails'), 'the last good rails stay on screen');
  assert.ok(stale.out.includes('Connection lost'));
});

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

test('a topic shows its work by repository, references and agents; a space says when it has no S++ work', skip, async (t) => {
  const topic = await render(t, { props: {}, width: 1400, path: { topic: 't-herdr' } });
  for (const id of ['crumb-factory', 'crumb-topic', 'topic-main', 'repo-web', 'space-s-web', 'job-wr-pr', 'ref-web-wr-cross', 'planned-t-herdr:web', 'level-agents'])
    assert.ok(topic.has(id), id);
  assert.ok(topic.text('from Personal Tools') && topic.text('1 planned'));
  assert.equal(topic.has('job-wr-shaping'), false, 'planned jobs fold into the count');
  const space = await render(t, { props: {}, width: 700, path: { topic: 't-herdr', space: 's-web' } });
  assert.ok(space.has('crumb-space') && space.has('space-facts') && space.has('job-wr-cross') && space.text('also in api · moved 2h 00m ago'));
  assert.ok(space.text('web · this machine · main'));
  const empty = await render(t, { props: {}, width: 1400, path: { topic: 'unsorted', space: 's-home' } });
  assert.ok(empty.has('space-empty') && empty.text('No S++ work here. Ordinary Herdr work stays ordinary.'));
});

test('the Job level sits under the breadcrumb, with its own tab action and no second way back', skip, async (t) => {
  const full = await render(t, { props: {}, width: 1400, path: { topic: 't-herdr', space: 's-web', job: 'wr-pr' } });
  assert.ok(full.has('crumb-job') && full.has('crumb-space') && full.has('job-view') && full.has('rails') && full.has('open-tab'));
  assert.equal(full.has('back') || full.has('new-job'), false);
  const panel = await render(t, { props: { role: 'panel' }, width: 1400, path: { job: 'wr-pr' }, pin: true });
  assert.ok(panel.has('job-view-full') && panel.has('rails-compact'), 'the panel role always stacks');
  assert.ok(panel.text('Unpin'));
});

test('a topic with a chief shows its desk first; one without says how to make one; factory rows show chief presence', skip, async (t) => {
  const topic = await render(t, { props: {}, width: 1400, path: { topic: 't-herdr' } });
  for (const id of ['chief-herdr', 'chief-needs-herdr', 'chief-sent-herdr', 'sent-herdr-wr-cross:x-api', 'sent-herdr-wr-pr', 'sent-herdr-wr-pr:wp-build', 'chief-recaps-herdr', 'recap-herdr-wr-cross', 'need-herdr:wr-cross:ask'])
    assert.ok(topic.has(id), id);
  assert.ok(topic.text('Herdr chief') && topic.text('Last seen build-desk › Terminal: Herdr chief 15m ago') && topic.text('Registered 3d ago · web'));
  assert.ok(topic.text('Executing · 1/4 landed') && topic.text('Building · 2h 00m') && topic.text('Shared tokens'));
  assert.ok(topic.text('Token API is building; the UI waits on it and on your call.'));
  assert.equal(topic.has('open-chief-herdr') || topic.has('chief-none'), false, 'no Open without a passed check');
  const at = (id) => topic.out.indexOf(`:id[Str("${id}")]`);
  assert.ok(at('chief-herdr') < at('chief-sent-herdr') && at('chief-sent-herdr') < at('repo-web'), 'the desk comes before the work by repository');
  assert.ok(at('sent-herdr-wr-cross:x-api') < at('sent-herdr-wr-pr'), 'newest first');
  assert.ok(at('need-herdr:wr-cross:ask') < at('sent-herdr-wr-cross:x-api'), 'rows draw, and take the keys, in reading order');
  const none = await render(t, { props: {}, width: 1400, path: { topic: 't-tools' } });
  assert.ok(none.has('chief-none') && none.text("No chief yet. Tell an agent it's the Personal Tools chief."));
  assert.equal(none.out.includes(':id[Str("chief-sent-'), false, 'nothing else changes for it');
  const factory = await render(t, { props: {}, width: 1400 });
  assert.ok(factory.has('topic-chief-t-herdr') && factory.has('topic-chief-t-live') && !factory.has('topic-chief-t-tools'));
  const panel = await render(t, { props: { role: 'panel' }, width: 1400, path: { topic: 't-live' } });
  assert.ok(panel.has('chief-live') && panel.text('Unknown') && panel.text('Nothing dispatched yet.'));
});

test('a selected UI package offers its studio; other packages do not', skip, async (t) => {
  for (const width of [1400, 700]) {
    const ui = await render(t, { props: { job: 'wr-cross' }, width, pkg: 'x-web' });
    assert.ok(ui.has('studio-x-web') && ui.text('Open UI studio'), `Token UI at ${width}`);
    const other = await render(t, { props: { job: 'wr-pr' }, width, pkg: 'wp-build' });
    assert.equal(other.has('studio-wp-build') || other.text('Open UI studio'), false, `Stage board at ${width}`);
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
