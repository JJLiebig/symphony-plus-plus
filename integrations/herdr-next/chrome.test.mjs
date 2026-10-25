// The S++ chrome: what the S++ view shares for the patched desk agents list, and the installer's
// --chrome / --remove-chrome on a personal desk home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseBoard } from './mods/sympp/model.js';
import { decorations, nextDecorations, withPanelButton, PANEL, RESTAMP } from './mods/sympp/chrome.js';
import { boardPayload, NOW } from './fixture.mjs';
import deskTabs from './chrome/desk-tabs.patch.mjs';
import deskAgents from './chrome/desk-agents.patch.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const install = (home, ...args) => spawnSync(process.execPath,
  [join(here, 'install.mjs'), '--home', home, ...args], { encoding: 'utf8', windowsHide: true });
const ENDPOINT = ['--endpoint', 'http://127.0.0.1:19997'];

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
  ], NOW);
  assert.deepEqual(map, {
    t1: { stage: 'build', round: null, needs: false, at: NOW },
    t2: { stage: 'review', round: 3, needs: true, at: NOW },
    t3: { stage: null, round: null, needs: true, at: NOW },
    'vps/t4': { stage: 'landed', round: null, needs: false, at: NOW },
  });
});

test('the shared map changes only when an entry does, is gone, or needs a fresh stamp', () => {
  const entry = (stage, at) => ({ stage, round: null, needs: false, at });
  const before = { t1: entry('build', NOW), t2: entry('checks', NOW) };
  assert.equal(nextDecorations(before, { t1: entry('build', NOW + 5e3), t2: entry('checks', NOW + 5e3) }, NOW + 5e3), null);
  assert.deepEqual(nextDecorations(before, { t1: entry('build', NOW + 5e3), t2: entry('review', NOW + 5e3) }, NOW + 5e3),
    { t1: entry('build', NOW), t2: entry('review', NOW + 5e3) });
  assert.deepEqual(nextDecorations(before, { t1: entry('build', NOW + 5e3) }, NOW + 5e3), { t1: entry('build', NOW) });
  const later = NOW + RESTAMP;
  assert.deepEqual(nextDecorations(before, { t1: entry('build', later), t2: entry('checks', later) }, later),
    { t1: entry('build', later), t2: entry('checks', later) });

  assert.deepEqual(withPanelButton(undefined), [PANEL]);
  assert.equal(withPanelButton([{ id: 'notes', label: 'Notes', icon: 'n.svg' }, PANEL]), null);
  assert.deepEqual(withPanelButton([{ id: 'sympp', label: 'Old', icon: 'x.svg' }]), [PANEL]);
});

// A personal desk: the anchors the patches expect, in files shaped like the desk mods.
const deskMod = (patch, eol) => ['// personal mod', ...patch.edits.map((e) => e.find + '    // between'), '// end', '']
  .join('\n').replaceAll('\n', eol);
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
  for (const [patch, eol] of [[deskTabs, '\r\n'], [deskAgents, '\n']]) {
    await mkdir(join(home, 'mods', patch.mod), { recursive: true });
    await writeFile(join(home, 'mods', patch.mod, 'main.js'), deskMod(patch, eol));
  }
  return home;
}

async function snapshot(dir) {
  const out = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) out[join(entry.parentPath ?? entry.path, entry.name)] = await readFile(join(entry.parentPath ?? entry.path, entry.name), 'utf8');
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
      original[join(home, 'mods', patch.mod, 'main.js')]);
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
    assert.equal(await readFile(file, 'utf8'), original[file]);
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
