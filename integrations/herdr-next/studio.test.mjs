// The UI studio: which packages get one, where its tab opens, how the worker is placed beside it,
// which preview it shows, and the preview copy the builder makes from a worker's worktree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as M from './mods/sympp/model.js';
import * as S from './mods/sympp/studio.js';
import { boardPayload, deskFixture } from './fixture.mjs';
import { buildPreview } from './preview.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const board = () => M.parseBoard(boardPayload());
const job = (id) => board().jobs.find((j) => j.id === id);
const worker = (address, labels = {}) => ({
  address, pid: 7, state: 'live',
  labels: { 'sympp.launch_id': 'l1', 'sympp.core_id': 'c1', 'sympp.pid': '7', 'sympp.receipt': 'C:/r.json', 'sympp.work_request_id': 'wr-pr', 'sympp.work_package_id': 'wp-build', ...labels },
});

test('UI work is a package titled with UI as a word or one whose worker published a preview', () => {
  const cross = job('wr-cross');
  const pr = job('wr-pr');
  const pkg = (j, id) => j.packages.find((p) => p.id === id);
  assert.equal(S.isUiWork(pkg(cross, 'x-web')), true, '"Token UI"');
  assert.equal(S.isUiWork({ title: 'UI studio tab: agent pane, live preview' }), true);
  for (const title of ['GUI toolkit bump', 'Build pipeline', 'Fluid layout']) assert.equal(S.isUiWork({ title }), false, title);
  const terminals = [worker('t1', { 'sympp.preview_url': 'http://127.0.0.1:5173/' })];
  const bindings = M.discoverBindings({ local: { node: 'node', helper: 'h' } }, terminals);
  assert.equal(S.uiPackage(pr, pkg(pr, 'wp-build'), bindings, terminals), true, 'a published preview marks the package');
  assert.equal(S.uiPackage(pr, pkg(pr, 'wp-build'), bindings, [worker('t1')]), false);
  assert.equal(S.uiPackage(pr, { ...pkg(pr, 'wp-build'), title: 'Stage UI', stage: 'done' }, bindings, terminals), false, 'landed work gets no studio');
});

test('only an http(s) preview a worker published is shown', () => {
  const url = (value) => S.previewUrlOf({ labels: { 'sympp.preview_url': value } });
  assert.equal(url(' http://localhost:5173/fresh?x=1 '), 'http://localhost:5173/fresh?x=1');
  assert.equal(url('https://preview.example.test'), 'https://preview.example.test');
  for (const value of ['', 'javascript:alert(1)', 'file:///C:/x.html', 'http://', 'http://a b', `https://a.test/${'x'.repeat(2100)}`]) assert.equal(url(value), null, value);
  assert.equal(S.previewUrlOf({ labels: {} }), null, 'no label means no preview yet');
});

test('a studio tab is named after its package in the job\'s local space and keeps the connection', () => {
  const cross = job('wr-cross');
  const given = { endpoint: 'http://127.0.0.1:4000', hosts: { local: { node: 'n', helper: 'h' } }, role: 'panel', job: 'wr-x', studio: { job: 'a', pkg: 'b' } };
  const pkg = { ...cross.packages.find((p) => p.id === 'x-web'), title: 'Token UI with a rather long descriptive title' };
  assert.deepEqual(S.studioTabArgs(given, cross, pkg, deskFixture().spaces), {
    name: 'Token UI with a rather long des…', space: 's-web', mod: 'sympp',
    props: { endpoint: 'http://127.0.0.1:4000', hosts: { local: { node: 'n', helper: 'h' } }, studio: { job: 'wr-cross', pkg: 'x-web' } },
  });
});

test('one studio per package: open tabs only, and never the asking tab itself', () => {
  const registry = { tb1: { job: 'wr-pr', pkg: 'wp-build', dev: null }, tb2: { job: 'wr-pr', pkg: 'wp-build', dev: null }, gone: { job: 'wr-pr', pkg: 'wp-review' } };
  assert.equal(S.studioTabFor(registry, ['tb1', 'tb2'], 'wp-build'), 'tb1');
  assert.equal(S.studioTabFor(registry, ['tb1', 'tb2'], 'wp-build', 'tb1'), 'tb2');
  assert.equal(S.studioTabFor(registry, ['tb1'], 'wp-review'), null, 'a closed tab is no studio');
  assert.deepEqual(Object.keys(S.openStudios({ ...registry, junk: 'x' }, ['tb1', 'junk'])), ['tb1']);
});

test('the worker is given a pane in the studio, swapped to its left once, and left alone in another tab', () => {
  const studio = { pane: 'p1', tab: 'tb1', mod: 'sympp', terminal: null };
  assert.deepEqual(S.placement([studio], 'tb1', 'p1', 't9', false), { step: 'keep' }, 'a paneless worker comes here');
  assert.deepEqual(S.placement([studio, { pane: 'p7', tab: 'tb5', terminal: 't9' }], 'tb1', 'p1', 't9', false),
    { step: 'elsewhere', pane: 'p7', tab: 'tb5' }, 'moving a placed worker is the person\'s call');
  const right = [studio, { pane: 'p2', tab: 'tb1', terminal: 't9' }];
  assert.deepEqual(S.placement(right, 'tb1', 'p1', 't9', false), { step: 'swap', pane: 'p2' });
  assert.deepEqual(S.placement(right, 'tb1', 'p1', 't9', true), { step: null, pane: 'p2' }, 'only once, then the person\'s arrangement stands');
  assert.deepEqual(S.placement([right[1], studio], 'tb1', 'p1', 't9', false), { step: null, pane: 'p2' });
});

test('the preview pane shows a published web preview first, then a native preview, else waits', () => {
  assert.equal(S.previewKind({ url: 'http://x.test', native: 'ready' }), 'web');
  for (const native of ['ready', 'building', 'error']) assert.equal(S.previewKind({ url: null, native }), 'native', native);
  for (const native of ['idle', 'unchanged', 'none']) assert.equal(S.previewKind({ url: null, native }), 'none', native);
  assert.deepEqual(S.buildOutcome({ code: 0, stdout: '{"state":"built"}', stderr: '' }), { state: 'ready' });
  assert.deepEqual(S.buildOutcome({ code: 3, stdout: '{"state":"unchanged"}', stderr: '' }), { state: 'unchanged' });
  assert.deepEqual(S.buildOutcome({ code: 1, stdout: '', stderr: "Error: Cannot find module 'C:\\w\\integrations\\herdr-next\\preview.mjs'" }), { state: 'none' }, 'not an S++ worktree');
  assert.deepEqual(S.buildOutcome({ code: 1, stdout: '', stderr: '\nSyntaxError: Unexpected token\n    at x' }), { state: 'error', error: 'SyntaxError: Unexpected token' });
  assert.equal(S.buildOutcome({ code: 1, stdout: '', stderr: "Error: ENOENT: no such file or directory, open 'C:\\w\\integrations\\herdr-next\\fixture.mjs'" }).state, 'error',
    'a missing input is a build error the next save can fix');
  assert.equal(S.previewInput('C:\\w\\integrations\\herdr-next\\mods\\sympp\\jobview.js'), true);
  assert.equal(S.previewInput('/w/integrations/herdr-next/fixture.mjs'), true);
  for (const path of ['/w/integrations/herdr-next/mods/sympp-lab/main.js', '/w/integrations/herdr-next/chrome.test.mjs', '/w/elixir/lib/a.ex']) assert.equal(S.previewInput(path), false, path);
});

test('only preview copies no open studio uses or shows are swept, never another mod', () => {
  const registry = { tb1: { job: 'j', pkg: 'a', dev: 'sympp-dev-a' }, closed: { job: 'j', pkg: 'b', dev: 'sympp-dev-b' } };
  const names = ['sympp', 'sympp-lab', 'desk-tabs', 'sympp-dev-a', 'sympp-dev-b', 'sympp-dev-c', 'sympp-dev-d'];
  assert.deepEqual(S.strayCopies(names, registry, ['tb1'], [{ pane: 'p', tab: 'x', mod: 'sympp-dev-d' }]), ['sympp-dev-b', 'sympp-dev-c']);
  assert.equal(S.devName('wp_7Z2/pf'), 'sympp-dev-wp_7z2-pf');
});

async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), 'spp preview '));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('the builder makes a sample-data copy of the view, changing only what changed and nothing else', async (t) => {
  const root = await scratch(t);
  const to = join(root, 'mods', 'sympp-dev-wp');
  const first = await buildPreview(to);
  const files = await readdir(to);
  for (const name of ['main.js', 'lens.js', 'model.js', 'studio.js', 'fixture.js', 'mod.json', 'glyph-ui.svg', 'mark.png']) assert.ok(files.includes(name), name);
  assert.equal(first.written, first.files);
  const main = await readFile(join(to, 'main.js'), 'utf8');
  assert.match(main, /import Lens from "\.\/lens\.js"/);
  assert.match(main, /this\.request = async \(\) => \{ throw SAMPLE; \}/, 'no request leaves the preview');
  assert.match(main, /tick\(\) \{\}/, 'it never reads S++');
  const lens = await readFile(join(to, 'lens.js'), 'utf8');
  assert.equal(lens, (await readFile(join(here, 'mods', 'sympp', 'main.js'), 'utf8')).replaceAll('mods/sympp/', 'mods/sympp-dev-wp/'));
  assert.doesNotMatch(await readFile(join(to, 'studioview.js'), 'utf8'), /mods\/sympp\//, 'its pictures come from the copy');

  await writeFile(join(to, 'stale.js'), 'export {}');
  const again = await buildPreview(to);
  assert.equal(again.written, 0, 'an unchanged view rewrites nothing, so Herdr reloads nothing');
  assert.equal((await readdir(to)).includes('stale.js'), false, 'files the view no longer has go');
  await assert.rejects(buildPreview(join(root, 'mods', 'sympp')), /sympp-dev-/, 'the real view is never a target');
  await assert.rejects(buildPreview(join(root, 'mods', 'desk-tabs')), /sympp-dev-/);
});

test('with a base the first copy waits until the Herdr view itself differs from it, then follows it', async (t) => {
  const repo = await scratch(t);
  const git = (...args) => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const view = join(repo, 'integrations', 'herdr-next');
  await mkdir(join(view, 'mods'), { recursive: true });
  await cp(join(here, 'mods', 'sympp'), join(view, 'mods', 'sympp'), { recursive: true });
  for (const file of ['preview.mjs', 'fixture.mjs', 'package.json']) await cp(join(here, file), join(view, file));
  await mkdir(join(repo, 'elixir'));
  await writeFile(join(repo, 'elixir', 'app.ex'), 'a');
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@example.test', '-c', 'user.name=t', 'add', '.');
  git('-c', 'user.email=t@example.test', '-c', 'user.name=t', 'commit', '-qm', 'base');
  const to = join(repo, 'home', 'mods', 'sympp-dev-x');
  const build = () => spawnSync(process.execPath, [join(view, 'preview.mjs'), '--to', to, '--base', 'main'], { encoding: 'utf8', windowsHide: true });

  await writeFile(join(repo, 'elixir', 'app.ex'), 'b');
  assert.equal(build().status, 3, 'web or backend work previews nothing native');
  await writeFile(join(view, 'mods', 'sympp', 'ui.js'), `${await readFile(join(view, 'mods', 'sympp', 'ui.js'), 'utf8')}\n// edited\n`);
  const edited = build();
  assert.equal(edited.status, 0, edited.stderr);
  assert.deepEqual(JSON.parse(edited.stdout).state, 'built');
  assert.match(await readFile(join(to, 'ui.js'), 'utf8'), /\/\/ edited/, 'an unsaved-to-git edit shows');
  git('checkout', '--', '.');
  assert.equal(build().status, 0, 'an existing copy follows edits back to the base');
  assert.doesNotMatch(await readFile(join(to, 'ui.js'), 'utf8'), /\/\/ edited/);
  await rm(to, { recursive: true });
  assert.equal(build().status, 3);
  await writeFile(join(view, 'mods', 'sympp', 'studio2.js'), 'export {}');
  assert.equal(build().status, 0, 'a new view file counts as a change');
});
