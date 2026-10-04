import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv[2] || repo;
const root = await mkdtemp(join(tmpdir(), 'sympp-portable-skills-'));
const npx = resolve(dirname(process.execPath), 'node_modules/npm/bin/npx-cli.js');
const env = {
  ...process.env,
  HOME: join(root, 'home'),
  USERPROFILE: join(root, 'home'),
  CODEX_HOME: join(root, 'home/.codex'),
  CLAUDE_CONFIG_DIR: join(root, 'home/.claude'),
  npm_config_cache: join(root, 'npm-cache'),
  DISABLE_TELEMETRY: '1',
};
await mkdir(env.HOME, { recursive: true });

function cli(cwd, args) {
  const result = spawnSync(process.execPath, [npx, '--yes', 'skills@1.7.0', ...args], {
    cwd, env, encoding: 'utf8', timeout: 180000,
  });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

async function files(directory, prefix = '') {
  const result = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const name = prefix + entry.name;
    if (entry.isDirectory()) {
      for (const [child, body] of await files(path, name + '/')) result.set(child, body);
    } else {
      result.set(name, (await readFile(path, 'utf8')).replace(/\r\n/g, '\n'));
    }
  }
  return result;
}

const expected = await files(join(repo, 'skills/symphony-plus-plus'));
assert.equal(expected.size, 11);
for (const agent of ['codex', 'claude-code']) {
  const cwd = join(root, agent);
  await mkdir(cwd);
  const discovery = cli(cwd, ['add', source, '--list']);
  assert.match(discovery, /Found 1 skill\b/);
  assert.match(discovery, /symphony-plus-plus/);
  const install = ['add', source, '--agent', agent, '--skill', 'symphony-plus-plus', '--yes'];
  cli(cwd, install);
  const installed = join(cwd, agent === 'codex' ? '.agents' : '.claude', 'skills/symphony-plus-plus');
  assert.deepEqual(await files(installed), expected);
  const listed = JSON.parse(cli(cwd, ['list', '--agent', agent, '--json']));
  assert.match(JSON.stringify(listed), /symphony-plus-plus/);

  // Local installs have no remote update identity; qualify that on a Git URL.
  const remote = source !== repo;
  const update = remote ? cli(cwd, ['update', 'symphony-plus-plus', '--project', '--yes']) : '';
  if (remote) assert.doesNotMatch(update, /No installed skills found|Failed to|Cannot update|cannot be updated/i);
  await writeFile(join(installed, 'connection.md'), 'stale qualification payload\n');
  cli(cwd, install);
  assert.deepEqual(await files(installed), expected);
  cli(cwd, [...install, '--copy']);
  assert.deepEqual(await files(installed), expected);
  cli(cwd, ['remove', 'symphony-plus-plus', '--agent', agent, '--yes']);
  const detached = JSON.parse(cli(cwd, ['list', '--agent', agent, '--json']));
  assert.ok(detached.every(skill => !skill.agents.includes(agent)));
  cli(cwd, ['remove', 'symphony-plus-plus', '--yes']);
  assert.deepEqual(JSON.parse(cli(cwd, ['list', '--agent', agent, '--json'])), []);
  console.log(`${agent}: discovery, install, ${remote ? 'tracked update, ' : ''}refresh, copy, removal passed.`);
  if (update) console.log(update.trim());
}
console.log(`Payload: ${expected.size} files, ${[...expected.values()].reduce((sum, body) => sum + Buffer.byteLength(body), 0)} bytes.`);
console.log(`Qualification artifacts: ${root}`);
