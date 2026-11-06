// The sympp chrome: what the sympp view shares for the patched desk agents list, and the installer's
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
import { applyPatch } from './chrome.mjs';
import { boardPayload, NOW } from './fixture.mjs';
import deskTabs from './chrome/desk-tabs.patch.mjs';
import deskAgents from './chrome/desk-agents.patch.mjs';
import deskTopics from './chrome/desk-topics.patch.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const checkerEnv = { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(join(here, 'chrome', 'fixtures', 'check.cjs'))}` };
const install = (home, ...args) => spawnSync(process.execPath,
  [join(here, 'install.mjs'), '--home', home, '--app', process.execPath, ...args],
  { env: checkerEnv, encoding: 'utf8', windowsHide: true });
const ENDPOINT = ['--endpoint', 'http://127.0.0.1:19997'];
const app = process.env.HERDR_APP || 'herdr-app';
const probe = spawnSync(app, ['--version'], { env: { ...process.env, HERDR_APP_HOME: join(tmpdir(), 'sympp-check-probe') }, encoding: 'utf8', windowsHide: true });
const native = { skip: (probe.error || probe.status !== 0) && 'herdr-app is not installed' };

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
  for (const patch of [deskTabs, deskAgents, deskTopics]) {
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

test('--chrome patches the desk mods, adds the sympp panel once, and --remove-chrome undoes only that', async t => {
  const home = await deskHome(t);
  const original = await snapshot(join(home, 'mods'));
  const result = install(home, ...ENDPOINT, '--chrome');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /chrome: "installed"/);

  const tabs = await readFile(join(home, 'mods', 'desk-tabs', 'main.js'), 'utf8');
  assert.match(tabs, /shared\("workspace\.panel_buttons"\)/);
  assert.match(tabs, /symppTabMark\(c\.id\)/, 'tabs carry the marks mods register');
  assert.doesNotMatch(tabs.replaceAll('\r\n', ''), /\n/, 'keeps the mod\'s CRLF line endings');
  assert.match(await readFile(join(home, 'mods', 'desk-agents', 'main.js'), 'utf8'), /symppStage\(k\.address, Date\.now\(\)\)/);
  assert.match(await readFile(join(home, 'mods', 'desk-topics', 'main.js'), 'utf8'), /\.children\(symppChief\(this, group \? id : null, group\?\.name, t, workspace\)\)/);
  for (const patch of [deskTabs, deskAgents, deskTopics]) {
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

  // A mark switch updates the badge, studio and panel together, without repatching the desk.
  const marks = ['glyph.svg', 'glyph-dark.svg', 'glyph-ui.svg', 'glyph-ui-dark.svg', 'mark.svg', 'mark-dark.svg', 'mark.png', 'mark-dark.png'];
  const backups = await snapshot(join(home, 'data', 'sympp-chrome'));
  for (const mark of ['a', 'c', 'b', 'd', 'a']) {
    const switched = install(home, ...ENDPOINT, '--chrome', '--replace', '--mark', mark);
    assert.equal(switched.status, 0, switched.stdout + switched.stderr);
    const source = mark === 'a' ? join(here, 'mods', 'sympp') : join(here, 'marks', mark);
    for (const name of marks) assert.deepEqual(await readFile(join(home, 'mods', 'sympp', name)), await readFile(join(source, name)), `${mark}/${name}`);
    assert.equal(await readFile(join(home, 'mods', 'desk-tabs', 'main.js'), 'utf8'), tabs);
    assert.deepEqual(await snapshot(join(home, 'data', 'sympp-chrome')), backups);
    if (mark === 'a') {
      const before = await snapshot(home);
      assert.equal(install(home, ...ENDPOINT, '--chrome', '--mark', 'c').status, 1, 'switching keeps explicit replacement consent');
      assert.deepEqual(await snapshot(home), before);
    }
  }
  const restored = Object.fromEntries(Object.entries(await snapshot(home)).filter(([name]) => !name.includes('sympp-panel-backups')));
  assert.deepEqual(restored, installed, 'switching back to A restores the installed files; replacement backups remain');

  // The person resizes the panel and opens sympp in it before removing the chrome.
  layout.children[2].size = { px: 500 };
  body.active = 'sympp';
  await writeFile(join(home, 'layouts', 'desk.json'), JSON.stringify(layout, null, 2));
  const removed = install(home, '--remove-chrome');
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  for (const patch of [deskTabs, deskAgents, deskTopics]) {
    const file = join(home, 'mods', patch.mod, 'main.js');
    assert.deepEqual(await readFile(file), original[file]);
  }
  const after = JSON.parse(await readFile(join(home, 'layouts', 'desk.json'), 'utf8'));
  assert.deepEqual(after.children[2].children[0].children.map((c) => c.id), ['files', 'changes']);
  assert.equal(after.children[2].children[0].active, 'files');
  assert.deepEqual(after.children[2].size, { px: 500 });
  assert.match(install(home, '--remove-chrome').stdout, /not installed/);
});

test('a desk without desk-topics gets the rest of the chrome, and removing it leaves desk-topics absent', async t => {
  const home = await deskHome(t);
  await rm(join(home, 'mods', 'desk-topics'), { recursive: true });
  const result = install(home, ...ENDPOINT, '--chrome');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(await readFile(join(home, 'mods', 'desk-tabs', 'main.js'), 'utf8'), /sympp chrome/);
  const removed = install(home, '--remove-chrome');
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  assert.equal((await readdir(join(home, 'mods'))).includes('desk-topics'), false);
});

test('original and cached desk-agents chrome 3 upgrade without losing personal edits', async t => {
  for (const cached of [false, true]) {
    const home = await deskHome(t);
    const file = join(home, 'mods', 'desk-agents', 'main.js');
    const plain = await readFile(file, 'utf8') + '// a later personal edit\n';
    const chrome3 = deskAgents.previous.find(p => p.mark === 'sympp chrome 3');
    let old = applyPatch(plain, chrome3);
    if (cached) {
      const block = await readFile(join(here, 'chrome', 'fixtures', 'desk-agents-cached-block.txt'), 'utf8');
      old = old.replace(chrome3.edits[0].replace, block + chrome3.edits[0].find)
        .replace('    const all = terminals();\n', '    const all = terminals();\n    symppBegin(all, t);\n');
    }
    await writeFile(file, old);
    const result = install(home, ...ENDPOINT, '--chrome');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(await readFile(file, 'utf8'), applyPatch(plain, deskAgents));
    assert.equal(await readFile(join(home, 'data', 'sympp-chrome', 'desk-agents.main.js'), 'utf8'), plain);
    const again = await snapshot(home);
    assert.equal(install(home, ...ENDPOINT, '--chrome').status, 0);
    assert.deepEqual(await snapshot(home), again);
    assert.equal(install(home, '--remove-chrome').status, 0);
    assert.equal(await readFile(file, 'utf8'), plain);
  }
});

test('an older desk-topics chrome upgrades in place and keeps later edits', async t => {
  const header = '    return h_flex().id(`topic-${id ?? "other"}`).h(26).flex_none().mt(8).px(8).gap(4).items_center().rounded(5)';
  for (const older of deskTopics.previous.filter((p) => p.mark.startsWith('sympp'))) {
    const home = await deskHome(t);
    const file = join(home, 'mods', 'desk-topics', 'main.js');
    const fixture = await readFile(file, 'utf8');
    // A desk that reworked two lines chrome 4 edits after it went in: pointer only while not dragging,
    // and its drag state in a local.
    const reworked = fixture.replace(`${header}.cursor_pointer()\n`, `${header}\n      .when(!this.drag, (el) => el.cursor_pointer())\n`)
      .replace('      if (!rows.length && !this.drag) return [];\n', '      if (!rows.length && !drag) return [];\n');
    assert.notEqual(reworked, fixture);
    const plain = applyPatch(fixture, older) ? fixture : reworked;
    await writeFile(file, applyPatch(plain, older) + '// my later tweak\n');
    const result = install(home, ...ENDPOINT, '--chrome');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const upgraded = await readFile(file, 'utf8');
    assert.equal(upgraded, applyPatch(plain + '// my later tweak\n', deskTopics), older.mark);
    assert.doesNotMatch(upgraded, new RegExp(older.mark));
    assert.equal(await readFile(join(home, 'data', 'sympp-chrome', 'desk-topics.main.js'), 'utf8'), plain + '// my later tweak\n');
  }
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

test('edits made after installing are kept by installing and removing; edited sympp lines are refused', async t => {
  const home = await deskHome(t);
  const file = join(home, 'mods', 'desk-tabs', 'main.js');
  const plain = await readFile(file, 'utf8');
  assert.equal(install(home, ...ENDPOINT, '--chrome').status, 0);
  await writeFile(file, (await readFile(file, 'utf8')) + '// my later tweak\r\n');
  const tweaked = await readFile(file, 'utf8');
  const again = install(home, ...ENDPOINT, '--chrome');
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(await readFile(file, 'utf8'), tweaked, 'the patched mod keeps the later edit');
  const removed = install(home, '--remove-chrome');
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  assert.equal(await readFile(file, 'utf8'), plain + '// my later tweak\r\n', 'removal takes out only the sympp lines');

  assert.equal(install(home, ...ENDPOINT, '--chrome').status, 0);
  const agents = join(home, 'mods', 'desk-agents', 'main.js');
  await writeFile(agents, (await readFile(agents, 'utf8')).replace('symppStage(k.address, Date.now())', 'symppStage(k.address, 0)'));
  const before = await snapshot(home);
  for (const args of [[...ENDPOINT, '--chrome'], ['--remove-chrome']]) {
    const result = install(home, ...args);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /The sympp lines in desk-agents were edited/);
    assert.deepEqual(await snapshot(home), before);
  }
});

test('another installed chrome version is neither patched again nor removed', async t => {
  const home = await deskHome(t);
  assert.equal(install(home, ...ENDPOINT, '--chrome').status, 0);
  const file = join(home, 'mods', 'desk-agents', 'main.js');
  await writeFile(file, (await readFile(file, 'utf8')).replaceAll(deskAgents.mark, 'sympp chrome 0'));
  const before = await snapshot(home);
  for (const args of [[...ENDPOINT, '--chrome'], ['--remove-chrome']]) {
    const result = install(home, ...args);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /desk-agents has another version of the sympp chrome/);
    assert.deepEqual(await snapshot(home), before);
  }
});

test('a broken patch restores all previous files and removes newly installed files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'spp broken patch '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = join(root, 'integrations', 'herdr-next');
  await cp(here, candidate, { recursive: true });
  const helper = join(root, 'packages', 'sympp', 'scripts', 'sympp-herdr.js');
  await mkdir(dirname(helper), { recursive: true });
  await copyFile(join(here, '..', '..', 'packages', 'sympp', 'scripts', 'sympp-herdr.js'), helper);
  const patch = join(candidate, 'chrome', 'desk-tabs.patch.mjs');
  await writeFile(patch, (await readFile(patch, 'utf8')).replace('const registered = shared("workspace.panel_buttons");', 'const registered = ;'));
  for (const replace of [false, true]) {
    const home = await deskHome(t);
    if (replace) {
      assert.equal(install(home, ...ENDPOINT).status, 0);
      await writeFile(join(home, 'mods', 'sympp', 'main.js'), '// personal sympp version\n');
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
    'workspace.panel_buttons': [{ id: 'sympp', label: 'sympp', icon: 'mods/sympp/mark.png' }] }));
  const originals = await snapshot(join(home, 'mods'));
  const layout = await readFile(join(home, 'layouts', 'desk.json'));
  const run = (...args) => spawnSync(process.execPath, [join(here, 'install.mjs'), '--home', home, '--app', app, ...args],
    { env: { ...process.env, HERDR_APP_HOME: home }, encoding: 'utf8', windowsHide: true });
  const installed = run(...ENDPOINT, '--chrome');
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  for (const mod of ['desk-tabs', 'desk-agents', 'desk-topics', 'sympp']) {
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

test('pre-rename chrome upgrades preserving personal edits and backing up the old panel', async t => {
  const home = await deskHome(t);
  for (const patch of [deskTabs, deskAgents, deskTopics]) {
    const legacy = patch.previous.find(p => p.mark.startsWith('S++'));
    const file = join(home, 'mods', patch.mod, 'main.js');
    await writeFile(file, applyPatch(await readFile(file, 'utf8'), legacy) + '\n// my personal edit\n');
  }
  await mkdir(join(home, 'mods', 'sympp'), { recursive: true });
  await writeFile(join(home, 'mods', 'sympp', 'main.js'), '// old panel');
  const result = install(home, ...ENDPOINT, '--chrome', '--replace');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const patch of [deskTabs, deskAgents, deskTopics]) {
    const text = await readFile(join(home, 'mods', patch.mod, 'main.js'), 'utf8');
    assert.match(text, /my personal edit/);
    assert.doesNotMatch(text, /S\+\+ chrome/);
  }
  const backups = await snapshot(join(home, 'data', 'sympp-panel-backups'));
  assert.ok(Object.values(backups).some(body => body.toString() === '// old panel'));
});

// The desk-topics chrome's own code, run against stand-ins for Herdr and GPUI.
function topicsChrome(state) {
  const code = deskTopics.edits[0].replace.replace(/export default class Topics extends Spaces \{\n$/, '')
    .replace(/import \{([^}]+)\} from "([^"]+)";/g, (_m, names, from) => `const {${names.replaceAll(' as ', ': ')}} = stubs[${JSON.stringify(from)}];`);
  // An element takes any style or handler; it keeps its click and mouse-down handlers and applies `when`.
  const build = () => {
    const handlers = {};
    const el = new Proxy({}, { get: (_t, key) => key === 'handlers' ? handlers
      : key === 'when' ? (cond, f) => (cond ? f(el) : el)
      : key === 'on_click' ? (f) => { handlers.click = f; return el; }
      : key === 'on_mouse_down' ? (button, f) => { handlers[button] = f; return el; }
      : () => el });
    return el;
  };
  const stubs = {
    'gpui-kit': { div: build, image: build },
    'gpui-base': { h_flex: build },
    herdr: {
      shared: (key) => state.shared[key], terminals: () => state.terminals, panes: () => state.panes ?? [], spaces: () => state.spaces ?? [],
      layout: () => state.layout ?? null, theme: () => ({ chrome: '#ffffff' }),
      run: (command, args) => state.ran.push([command, args]), openOverlay: (o) => state.ran.push(['overlay', o.props]),
    },
  };
  return new Function('stubs', `${code}\nreturn { symppChief, symppUnlisted, symppInside };`)(stubs);
}

test('the topic mark peeks at a running chief, switches to it on shift, otherwise starts one, and right-click opens its menu', () => {
  const state = { shared: {}, terminals: [{ address: 'jjdev/t7w', state: 'live', status: 'idle' }], ran: [] };
  const { symppChief } = topicsChrome(state);
  const click = (shift) => {
    state.ran = [];
    const [, mark] = symppChief({ clearDrag() {}, status() {} }, 'topic-k', 'Kraken', {}, () => state.ran.push(['workspace']));
    mark.handlers.click({ modifiers: { shift } }, { stop_propagation() {} });
    return state.ran;
  };
  const start = [['overlay', { role: 'chief', topic: 'topic-k', name: 'Kraken' }]];
  const menu = () => {
    state.ran = [];
    const [, mark] = symppChief({ clearDrag() {}, status() {} }, 'topic-k', 'Kraken', {}, () => {});
    mark.handlers.right({}, { stop_propagation() {} });
    return state.ran;
  };
  assert.deepEqual(menu(), [['overlay', { role: 'chief-menu', topic: 'topic-k', name: 'Kraken', terminal: null }]]);
  assert.deepEqual(click(false), start, 'no chief');
  state.shared['sympp.chiefs'] = { 'topic-k': [{ domain: 'Kraken', terminal: null }] };
  assert.deepEqual(click(true), start, 'a registered chief that isn\'t running');
  const compact = () => symppChief({ clearDrag() {}, status() {} }, 'topic-k', 'Kraken', {}, () => {}, true);
  assert.deepEqual(compact(), [], 'a collapsed sidebar keeps the divider without a running chief');
  state.shared['sympp.chiefs'] = { 'topic-k': [{ domain: 'Kraken', terminal: 'jjdev/t7w' }] };
  assert.deepEqual(click(false), [['terminal.peek', { terminal: 'jjdev/t7w' }]]);
  assert.deepEqual(click(true), [['terminal.peek', { terminal: 'jjdev/t7w' }]], 'shift without a pane to switch to');
  assert.deepEqual(menu(), [['overlay', { role: 'chief-menu', topic: 'topic-k', name: 'Kraken', terminal: 'jjdev/t7w' }]]);
  const [collapsed, ...rest] = compact();
  assert.equal(rest.length, 0, 'a collapsed sidebar shows only the mark, in place of the divider');
  state.ran = [];
  collapsed.handlers.click({ modifiers: { shift: false } }, { stop_propagation() {} });
  assert.deepEqual(state.ran, [['terminal.peek', { terminal: 'jjdev/t7w' }]]);
  state.panes = [{ pane: 'p1', terminal: 'jjdev/t7w' }];
  assert.deepEqual(click(true), [['workspace'], ['pane.focus', { terminal: 'jjdev/t7w' }]]);
  assert.deepEqual(click(false), [['terminal.peek', { terminal: 'jjdev/t7w' }]]);
});

test('a topic\'s chief spaces are left out of the sidebar, and its header shows while one is open', () => {
  const state = { ran: [], terminals: [],
    shared: { 'desk.topics': { groups: [{ id: 'topic-k', name: 'Kraken', spaces: ['api', 'chief', 'made', 'web'] }, { id: 'topic-o', name: 'Other', spaces: ['elsewhere'] }] },
      'sympp.chief.spaces': { made: 'topic-k', elsewhere: 'topic-k' } },
    spaces: [{ id: 'api', name: 'api' }, { id: 'chief', name: 'Kraken chief' }, { id: 'made', name: 'renamed' }, { id: 'tree', name: 'fix' },
      { id: 'web', name: 'web' }, { id: 'elsewhere', name: 'moved' }],
    layout: { id: 'root', children: [{ id: 'desk-views', active: 'desk-workspace' }] } };
  const { symppUnlisted, symppInside } = topicsChrome(state);
  const row = (id, tree = null) => ({ w: { id }, tree });
  assert.deepEqual(symppUnlisted([row('api'), row('chief'), row('tree', '└─'), row('made'), row('web'), row('elsewhere')]),
    [row('api'), row('tree'), row('web'), row('elsewhere')], 'a worktree listed under a chief space stays, on its own; a space recorded for another topic stays');
  assert.equal(symppInside('topic-k'), false);
  state.spaces.find((s) => s.id === 'chief').active = true;
  assert.equal(symppInside('topic-k'), true);
  assert.equal(symppInside('topic-o'), false);
  state.layout.children[0].active = 'desk-board';
  assert.equal(symppInside('topic-k'), false, 'not while the desk shows something else');
});
