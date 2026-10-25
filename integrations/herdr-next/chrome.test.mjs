// The S++ chrome: what the S++ view shares for the patched desk agents list, and the installer's
// --chrome / --remove-chrome on a personal desk home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, cp, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseBoard } from './mods/sympp/model.js';
import { decorations, nextDecorations, RESTAMP } from './mods/sympp/chrome.js';
import { boardPayload, NOW } from './fixture.mjs';
import deskTabs from './chrome/desk-tabs.patch.mjs';
import deskAgents from './chrome/desk-agents.patch.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const checkerEnv = { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(join(here, 'chrome', 'fixtures', 'check.cjs'))}` };
const install = (home, ...args) => spawnSync(process.execPath,
  [join(here, 'install.mjs'), '--home', home, '--app', process.execPath, ...args],
  { env: checkerEnv, encoding: 'utf8', windowsHide: true });
const ENDPOINT = ['--endpoint', 'http://127.0.0.1:19997'];
const app = process.env.HERDR_APP || 'herdr-app';
const probe = spawnSync(app, ['--version'], { encoding: 'utf8', windowsHide: true });
const native = { skip: (probe.error || probe.status !== 0) && 'herdr-app is not installed' };

test('each S++ terminal on the board gets its stage, review round and need; others get nothing', () => {
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
    t2: { stage: 'review', round: 3, needs: true, endpoint, at: NOW },
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

function deskLayout(tabs = 'desk-tabs', agents = 'desk-agents', body = true) {
  return {
    id: 'root', type: 'row', children: [
      { id: 'agents', type: 'block', content: { mod: agents } },
      { id: 'tabs', type: 'block', content: { mod: tabs } },
      { id: 'panel', type: 'column', size: { px: 368 }, hidden: true, children: body ? [{ id: 'panel-body', type: 'stack', active: 'changes', children: [
        { id: 'files', type: 'block', content: { mod: 'files' } }, { id: 'changes', type: 'block', content: { mod: 'changes' } },
      ] }] : [] },
    ],
  };
}

async function deskHome(t, layout = deskLayout()) {
  const home = await mkdtemp(join(tmpdir(), 'spp chrome '));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, 'layouts'), { recursive: true });
  await writeFile(join(home, 'shared.json'), JSON.stringify({ layout: 'desk' }));
  await writeFile(join(home, 'layouts', 'desk.json'), JSON.stringify(layout, null, 2));
  for (const patch of [deskTabs, deskAgents]) {
    const target = join(home, 'mods', patch.mod);
    await cp(join(here, 'chrome', 'fixtures', patch.mod), target, { recursive: true });
  }
  const tabs = join(home, 'mods', 'desk-tabs', 'main.js');
  await writeFile(tabs, (await readFile(tabs, 'utf8')).replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'));
  return home;
}

async function snapshot(dir) {
  const out = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) out[join(entry.parentPath ?? entry.path, entry.name)] = await readFile(join(entry.parentPath ?? entry.path, entry.name));
  }
  return out;
}

test('--chrome patches the desk mods, adds the S++ panel once, and --remove-chrome undoes only that', async t => {
  const home = await deskHome(t);
  const original = await snapshot(join(home, 'mods'));
  const result = install(home, ...ENDPOINT, '--chrome');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /chrome: "installed"/);

  const tabs = await readFile(join(home, 'mods', 'desk-tabs', 'main.js'), 'utf8');
  assert.match(tabs, /shared\("workspace\.panel_buttons"\)/);
  assert.doesNotMatch(tabs.replaceAll('\r\n', ''), /\n/, 'keeps the mod\'s CRLF line endings');
  assert.match(await readFile(join(home, 'mods', 'desk-agents', 'main.js'), 'utf8'), /symppBadge\(t, k, Date\.now\(\)\)/);
  for (const patch of [deskTabs, deskAgents]) {
    assert.equal(await readFile(join(home, 'data', 'sympp-chrome', `${patch.mod}.main.js`), 'utf8'),
      original[join(home, 'mods', patch.mod, 'main.js')].toString());
  }
  const layout = JSON.parse(await readFile(join(home, 'layouts', 'desk.json'), 'utf8'));
  const body = layout.children[2].children[0];
  assert.deepEqual(body.children.map((c) => c.id), ['files', 'changes', 'sympp']);
  assert.equal(body.children[2].content.mod, 'sympp');
  assert.equal(body.children[2].content.props.role, 'panel');
  assert.equal(body.children[2].content.props.endpoint, 'http://127.0.0.1:19997');

  const installed = await snapshot(home);
  const again = install(home, ...ENDPOINT, '--chrome');
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /chrome: "unchanged"/);
  assert.deepEqual(await snapshot(home), installed);

  // The person resizes the panel and opens S++ in it before removing the chrome.
  layout.children[2].size = { px: 500 };
  body.active = 'sympp';
  await writeFile(join(home, 'layouts', 'desk.json'), JSON.stringify(layout, null, 2));
  const removed = install(home, '--remove-chrome');
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  for (const patch of [deskTabs, deskAgents]) {
    const file = join(home, 'mods', patch.mod, 'main.js');
    assert.deepEqual(await readFile(file), original[file]);
  }
  const after = JSON.parse(await readFile(join(home, 'layouts', 'desk.json'), 'utf8'));
  assert.deepEqual(after.children[2].children[0].children.map((c) => c.id), ['files', 'changes']);
  assert.equal(after.children[2].children[0].active, 'files');
  assert.deepEqual(after.children[2].size, { px: 500 });
  assert.match(install(home, '--remove-chrome').stdout, /not installed/);
});

test('--chrome refuses a home without the personal desk and changes nothing', async t => {
  for (const [layout, missing] of [
    [deskLayout('tabs', 'desk-agents'), /Herdr's own tabs mod, not desk-tabs/],
    [deskLayout('desk-tabs', 'agents'), /Herdr's own agents mod, not desk-agents/],
    [deskLayout('desk-tabs', 'desk-agents', false), /no panel-body stack/],
  ]) {
    const home = await deskHome(t, layout);
    const before = await snapshot(home);
    const result = install(home, ...ENDPOINT, '--chrome');
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /no files were changed/);
    assert.match(result.stdout, missing);
    assert.deepEqual(await snapshot(home), before);
  }

  const home = await deskHome(t);
  await writeFile(join(home, 'mods', 'desk-agents', 'main.js'), '// rewritten by hand\n');
  const before = await snapshot(home);
  const result = install(home, ...ENDPOINT, '--chrome');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /desk-agents differs from the version this patch was written for/);
  assert.deepEqual(await snapshot(home), before);
});

test('an edit made after installing keeps both installing and removing from overwriting it', async t => {
  const home = await deskHome(t);
  assert.equal(install(home, ...ENDPOINT, '--chrome').status, 0);
  const file = join(home, 'mods', 'desk-tabs', 'main.js');
  await writeFile(file, (await readFile(file, 'utf8')) + '// my later tweak\r\n');
  const before = await snapshot(home);
  for (const args of [[...ENDPOINT, '--chrome'], ['--remove-chrome']]) {
    const result = install(home, ...args);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /desk-tabs was edited after the S\+\+ chrome was installed/);
    assert.deepEqual(await snapshot(home), before);
  }
});

test('a broken patch restores all previous files and removes newly installed files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'spp broken patch '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = join(root, 'integrations', 'herdr-next');
  await cp(here, candidate, { recursive: true });
  const helper = join(root, 'plugins', 'symphony-plus-plus-mcp', 'scripts', 'sympp-herdr.js');
  await mkdir(dirname(helper), { recursive: true });
  await copyFile(join(here, '..', '..', 'plugins', 'symphony-plus-plus-mcp', 'scripts', 'sympp-herdr.js'), helper);
  const patch = join(candidate, 'chrome', 'desk-tabs.patch.mjs');
  await writeFile(patch, (await readFile(patch, 'utf8')).replace('const registered = shared("workspace.panel_buttons");', 'const registered = ;'));
  for (const replace of [false, true]) {
    const home = await deskHome(t);
    if (replace) {
      assert.equal(install(home, ...ENDPOINT).status, 0);
      await writeFile(join(home, 'mods', 'sympp', 'main.js'), '// personal S++ version\n');
      await mkdir(join(home, 'data', 'sympp-chrome'), { recursive: true });
      await writeFile(join(home, 'data', 'sympp-chrome', 'desk-tabs.main.js'), 'previous backup');
    }
    const before = await snapshot(home);
    const result = spawnSync(process.execPath, [join(candidate, 'install.mjs'), '--home', home,
      '--app', process.execPath, ...ENDPOINT, '--chrome', '--replace'],
    { env: checkerEnv, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /desk-tabs:.*SyntaxError/);
    assert.match(result.stdout, /all changed files were restored/);
    assert.deepEqual(await snapshot(home), before);
  }
});

test('failed removal restores the installed chrome and layout', async t => {
  const home = await deskHome(t);
  assert.equal(install(home, ...ENDPOINT, '--chrome').status, 0);
  await writeFile(join(home, 'mods', 'sympp', 'main.js'), 'const broken = ;');
  const before = await snapshot(home);
  const result = install(home, '--remove-chrome');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /sympp:.*SyntaxError/);
  assert.deepEqual(await snapshot(home), before);
});

test('missing Herdr-app refuses installation and removal before writing anything', async t => {
  const home = await deskHome(t);
  for (const args of [[...ENDPOINT, '--chrome'], ['--remove-chrome']]) {
    const before = await snapshot(home);
    const result = install(home, ...args, '--app', join(home, 'missing-herdr-app'));
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /no files were changed/);
    assert.match(result.stdout, /--app/);
    assert.deepEqual(await snapshot(home), before);
    assert.equal(install(home, ...ENDPOINT, '--chrome').status, 0);
  }
});

test('current desk fixtures render after chrome install and restore byte-for-byte', native, async t => {
  const home = await deskHome(t);
  // A saved registration reaches the extra-panel filter on the first render.
  await writeFile(join(home, 'shared.json'), JSON.stringify({ layout: 'desk',
    'workspace.panel_buttons': [{ id: 'sympp', label: 'S++', icon: 'mods/sympp/mark.png' }] }));
  const originals = await snapshot(join(home, 'mods'));
  const layout = await readFile(join(home, 'layouts', 'desk.json'));
  const run = (...args) => spawnSync(process.execPath, [join(here, 'install.mjs'), '--home', home, '--app', app, ...args],
    { env: { ...process.env, HERDR_APP_HOME: home }, encoding: 'utf8', windowsHide: true });
  const installed = run(...ENDPOINT, '--chrome');
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  for (const mod of ['desk-tabs', 'desk-agents', 'sympp']) {
    const result = spawnSync(app, ['check', join(home, 'mods', mod)],
      { env: { ...process.env, HERDR_APP_HOME: home }, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  const removed = run('--remove-chrome');
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  for (const [path, bytes] of Object.entries(originals)) assert.deepEqual(await readFile(path), bytes);
  assert.deepEqual(await readFile(join(home, 'layouts', 'desk.json')), layout);

  // Only the original local and its uses change; the patch resolves panel-body itself.
  const file = join(home, 'mods', 'desk-tabs', 'main.js');
  await writeFile(file, originals[file].toString().replace('const panel =', 'const renamedPanel =')
    .replace('panel && !panel.hidden && panel.active', 'renamedPanel && !renamedPanel.hidden && renamedPanel.active'));
  const renamed = run(...ENDPOINT, '--chrome');
  assert.equal(renamed.status, 0, renamed.stdout + renamed.stderr);
});
