// Structural checks of the drawn Job level: Herdr's own `check --print-spec` builds the real view
// with fixture data at a chosen width. This proves element structure and copy, not paint or input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const app = process.env.HERDR_APP || 'herdr-app';
const available = !spawnSync(app, ['--version'], { encoding: 'utf8', windowsHide: true }).error;

const wrapper = (spec) => `import Lens from "./lens.js";
import * as M from "./model.js";
import * as J from "./job.js";
import { NOW, boardPayload, detailPayload } from "./fixture.js";
const CASE = ${JSON.stringify(spec)};
export default class SpecLens extends Lens {
  init(_p, cx) {
    // Ages and timings are drawn at the fixture's moment, not the machine's clock.
    Date.now = () => NOW;
    super.init({ endpoint: "http://127.0.0.1:4000", bridge: { node: "node", helper: "h" }, ...CASE.props }, cx);
    const now = Date.now();
    this.net = M.fetchSucceeded(this.net, M.parseBoard(boardPayload()), now);
    if (CASE.error) this.net = M.fetchFailed(this.net, CASE.error, now);
    if (CASE.select) this.selected = CASE.select;
    if (CASE.detail) this.detail = true;
    this.detailNet = { ...M.fetchSucceeded(M.initialFetch(), J.decisionsOf(detailPayload()), now), jobId: CASE.decisionsFor ?? null };
  }
  tick() {}
  viewportWidth() { return CASE.width; }
}
`;

async function render(t, spec) {
  const dir = await mkdtemp(join(tmpdir(), 'sympp spec '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(here, 'mods', 'sympp');
  for (const name of await readdir(source)) {
    if (name.endsWith('.js') || name === 'mod.json') await copyFile(join(source, name), join(dir, name === 'main.js' ? 'lens.js' : name));
  }
  await copyFile(join(here, 'fixture.mjs'), join(dir, 'fixture.js'));
  await writeFile(join(dir, 'main.js'), wrapper(spec));
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

test('the overview leads into the Job level and offers its own tab', skip, async (t) => {
  const side = await render(t, { props: {}, width: 1400, select: 'wr-pr' });
  assert.ok(side.has('lens-detail') && side.has('job-view-side') && side.has('rails-compact') && side.has('open-tab'));
  assert.ok(side.has('job-wr-pr'), 'the job list stays beside it');
  const full = await render(t, { props: {}, width: 1400, select: 'wr-pr', detail: true });
  assert.ok(full.has('job-view') && full.has('rails') && full.has('back') && full.has('open-tab'));
  const panel = await render(t, { props: { role: 'panel' }, width: 1400, select: 'wr-pr', detail: true });
  assert.ok(panel.has('job-view-full') && panel.has('rails-compact'), 'the panel role always stacks');
});

