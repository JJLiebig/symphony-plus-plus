import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, access, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const install = (home, ...args) => spawnSync(process.execPath,
  [join(here, 'install.mjs'), '--home', home, ...args], { encoding: 'utf8', windowsHide: true });

test('factory selection reaches view props', async t => {
  const root = await mkdtemp(join(tmpdir(), 'spp factory install '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const selected = join(root, 'selected factory', 'runtime', 'codex-plugin.json');
  const fallbackHome = join(root, 'fallback factory');
  const home = join(root, 'plain');
  for (const [explicit, runtimeEnv, homeEnv, expected] of [
    [selected, 'ignored', fallbackHome, selected],
    [null, selected, fallbackHome, selected],
    [null, null, fallbackHome, join(fallbackHome, 'runtime', 'codex-plugin.json')],
    [null, null, null, undefined],
  ]) {
    const env = { ...process.env };
    delete env.SYMPP_RUNTIME_FILE;
    delete env.SYMPP_HOME;
    env.HC_SESSION = 'another-core';
    if (runtimeEnv) env.SYMPP_RUNTIME_FILE = runtimeEnv;
    if (homeEnv) env.SYMPP_HOME = homeEnv;
    const result = spawnSync(process.execPath, [join(here, 'install.mjs'), '--home', home,
      '--endpoint', 'http://127.0.0.1:21345', ...(explicit ? ['--factory', explicit] : [])],
      { env, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const line = result.stdout.split('\n').find(line => line.startsWith('args: '));
    const props = JSON.parse(JSON.parse(line.slice(6))).props;
    assert.equal(props.hosts.local.runtime, expected);
    assert.equal(props.hosts.local.node, process.execPath);
    assert.equal(props.hosts.local.helper, join(home, 'tools', 'sympp-herdr.js'));
  }
});

test('installs into a home with spaces without replacing personal layout or topics', async t => {
  const home = await mkdtemp(join(tmpdir(), 'spp native install '));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, 'layouts'));
  const layout = '{"id":"root","children":[{"content":{"terminal":"t5"}}]}\n';
  const shared = '{"desk.topics":{"groups":[{"id":"my-topic","spaces":["s1"]}]}}\n';
  await writeFile(join(home, 'layouts', 'personal.json'), layout);
  await writeFile(join(home, 'shared.json'), shared);
  await mkdir(join(home, 'tools'));
  await mkdir(join(home, 'data', 'sympp-requests'), { recursive: true });
  await writeFile(join(home, 'tools', 'sympp-http.cjs'), '// obsolete bridge');
  await writeFile(join(home, 'data', 'sympp-requests', 'old.json'), '{}');
  const desk = join(home, 'owned-desk');
  await mkdir(desk);
  await writeFile(join(desk, 'main.js'), '// personal desk');
  await mkdir(join(home, 'mods'), { recursive: true });
  for (const name of ['desk-tabs', 'desk-agents', 'desk-topics']) {
    await symlink(desk, join(home, 'mods', name), process.platform === 'win32' ? 'junction' : 'dir');
  }
  const backup = join(home, 'data', 'sympp-chrome', 'old.json');
  await mkdir(dirname(backup), { recursive: true });
  await writeFile(backup, 'old backup');
  const result = install(home, '--endpoint', 'http://127.0.0.1:19999');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(await readFile(join(home, 'layouts', 'personal.json'), 'utf8'), layout);
  assert.equal(await readFile(join(home, 'shared.json'), 'utf8'), shared);
  assert.match(result.stdout, /19999/);
  await assert.rejects(access(join(home, 'tools', 'sympp-http.cjs')));
  await assert.rejects(access(join(home, 'data', 'sympp-requests')));
  await access(join(home, 'tools', 'sympp-herdr.js'));
  assert.deepEqual(await readFile(join(home, 'mods', 'sympp', 'mark.png')), await readFile(join(here, 'mods', 'sympp', 'mark.png')));
  assert.equal(install(home, '--endpoint', 'http://127.0.0.1:19999').status, 0);

  const edited = '// personal edit\n';
  await writeFile(join(home, 'mods', 'sympp', 'main.js'), edited);
  const beforeModel = await readFile(join(home, 'mods', 'sympp', 'model.js'), 'utf8');
  const refused = install(home, '--endpoint', 'http://127.0.0.1:19999');
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /no files were changed/);
  assert.equal(await readFile(join(home, 'mods', 'sympp', 'main.js'), 'utf8'), edited);
  assert.equal(await readFile(join(home, 'mods', 'sympp', 'model.js'), 'utf8'), beforeModel);
  assert.equal(install(home, '--endpoint', 'http://127.0.0.1:19999', '--replace').status, 0);
  assert.notEqual(await readFile(join(home, 'mods', 'sympp', 'main.js'), 'utf8'), edited);
  assert.equal(await readFile(join(desk, 'main.js'), 'utf8'), '// personal desk');
  assert.equal(await readFile(backup, 'utf8'), 'old backup');

});

test('installs the lab beside the view without an endpoint or touching the view', async t => {
  const home = await mkdtemp(join(tmpdir(), 'spp native lab '));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal(install(home, '--endpoint', 'http://127.0.0.1:19999').status, 0);
  const view = await readFile(join(home, 'mods', 'sympp', 'main.js'), 'utf8');

  const result = install(home, '--lab');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /"mod\\":\\"sympp-lab\\"/);
  assert.doesNotMatch(result.stdout, /endpoint/);
  await access(join(home, 'mods', 'sympp-lab', 'main.js'));
  await access(join(home, 'mods', 'sympp-lab', 'play.svg'));
  assert.equal(await readFile(join(home, 'mods', 'sympp', 'main.js'), 'utf8'), view);

  await writeFile(join(home, 'mods', 'sympp-lab', 'fixtures.js'), '// my sample job\n');
  assert.equal(install(home, '--lab').status, 1);
  assert.equal(await readFile(join(home, 'mods', 'sympp-lab', 'fixtures.js'), 'utf8'), '// my sample job\n');
  assert.equal(install(home, '--lab', '--replace').status, 0);
});

test('rejects credentials, unknown flags and invalid open mode before changing a home', async t => {
  const root = await mkdtemp(join(tmpdir(), 'spp native invalid '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'not-created');
  for (const args of [
    ['--endpoint', 'http://person:private@localhost:19998'],
    ['--endpoint', 'http://localhost:19998/sympp/board'],
    ['--endpoint', 'http://localhost:19998', '--opne', 'overview'],
    ['--endpoint', 'http://localhost:19998', '--open', 'bogus'],
    ['--endpoint', 'http://localhost:19998', '--mark', '../mods/sympp'],
    ['--lab', '--mark', 'a'],
    ['--chrome'],
    ['--auto-chrome'],
    ['--remove-chrome'],
  ]) {
    const result = install(home, ...args);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /person:private/);
    await assert.rejects(access(home));
  }
});

test('checked updates publish the connection and restore it and the mod after a failed check', async t => {
  const home = await mkdtemp(join(tmpdir(), 'sympp checked install '));
  t.after(() => rm(home, { recursive: true, force: true }));
  const preload = join(home, 'check.cjs');
  await writeFile(preload, `const cp = require('node:child_process');
cp.spawnSync = (_app, args, options) => {
  if (options.env.HERDR_APP_HOME !== ${JSON.stringify(home)}) throw new Error('wrong home');
  if (args[0] === '--version') return { status: 0 };
  if (args[0] !== 'check' || args[1] !== ${JSON.stringify(join(home, 'mods', 'sympp'))}) throw new Error('checked another mod');
  return { status: process.env.FAIL_CHECK ? 1 : 0, stderr: 'invalid mod' };
};`);
  const run = (endpoint, fail = false) => spawnSync(process.execPath,
    [join(here, 'install.mjs'), '--home', home, '--endpoint', endpoint, '--check', '--replace'],
    { env: { ...process.env, NODE_OPTIONS: '--require ' + JSON.stringify(preload), FAIL_CHECK: fail ? '1' : '' }, encoding: 'utf8', windowsHide: true });
  assert.equal(run('http://127.0.0.1:19999').status, 0);
  const shared = await readFile(join(home, 'shared.json'), 'utf8');
  assert.equal(JSON.parse(shared)['sympp.connection'].endpoint, 'http://127.0.0.1:19999');
  const edited = '// my edited sympp';
  await writeFile(join(home, 'mods', 'sympp', 'main.js'), edited);
  const failed = run('http://127.0.0.1:21345', true);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /all changed files were restored/);
  assert.equal(await readFile(join(home, 'shared.json'), 'utf8'), shared);
  assert.equal(await readFile(join(home, 'mods', 'sympp', 'main.js'), 'utf8'), edited);
});
