import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect } from 'e2e';
import { test } from '../support/task-tools.js';

test('specs CLI rejects missing public specs and applies only the declared exemptions', async ({ tasks }) => {
  const source = join(tasks.root, 'source');
  const exemptions = join(tasks.root, 'exemptions.txt');
  await mkdir(source);
  await writeFile(join(source, 'sample.ex'), `defmodule AcceptanceSpecs do
  @spec documented(term()) :: term()
  def documented(value), do: value
  def legacy(value), do: helper(value)
  defp helper(value), do: value
  @impl true
  def init(state), do: {:ok, state}
end
`);
  const rejected = await tasks.run(['specs.check', '--paths', source]);
  expect(rejected.code).not.toBe(0);
  expect(rejected.output).toContain('AcceptanceSpecs.legacy/1');
  expect(rejected.output).toContain('1 missing @spec');
  await writeFile(exemptions, '# reviewed legacy API\n\nAcceptanceSpecs.legacy/1\n');
  expect((await tasks.run(['specs.check', '--paths', source, '--exemptions-file', exemptions])).code).toBe(0);
  // A missing or unrelated exemption cannot suppress the actual failure.
  expect((await tasks.run(['specs.check', '--paths', source, '--exemptions-file', `${exemptions}.absent`])).code).not.toBe(0);
  await writeFile(exemptions, 'AcceptanceSpecs.other/1\n');
  expect((await tasks.run(['specs.check', '--paths', source, '--exemptions-file', exemptions])).code).not.toBe(0);
});

test('demo CLI requires an explicit database and force before replacing selected data', async ({ tasks }) => {
  expect((await tasks.run(['sympp.demo_ledger'])).code).not.toBe(0);
  const database = join(tasks.root, 'selected.sqlite3');
  const other = join(tasks.root, 'unselected.sqlite3');
  for (const path of [database, other]) {
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE operator_marker(value TEXT); INSERT INTO operator_marker VALUES (\'preserve\')');
    db.close();
  }
  const original = await readFile(database);
  const untouched = await readFile(other);
  const refused = await tasks.run(['sympp.demo_ledger', '--database', database]);
  expect(refused.code).not.toBe(0);
  expect(refused.output).toContain('already exists');
  expect(await readFile(database)).toEqual(original);
  const seeded = await tasks.run(['sympp.demo_ledger', '--database', database, '--force']);
  expect(seeded.code).toBe(0);
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    expect(db.prepare('SELECT COUNT(*) AS count FROM sympp_work_requests').get()!.count).toBeGreaterThan(0);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'operator_marker'").all()).toEqual([]);
    // Preserve the raw-secret guard against actual persisted demo data and CLI output.
    for (const table of ['sympp_work_requests', 'sympp_work_packages', 'sympp_progress_events',
      'sympp_findings', 'sympp_artifacts', 'sympp_solo_sessions', 'sympp_solo_session_entries']) {
      const text = JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all());
      expect(/ghp_|bearer |api_key|access_token|secret_hash/i.test(text)).toBe(false);
    }
    expect(/ghp_|bearer |api_key|access_token|secret_hash/i.test(seeded.output)).toBe(false);
  } finally { db.close(); }
  expect(await readFile(other)).toEqual(untouched);
});

test('cockpit CLI refuses public hosts and remote origins before starting a ledger', async ({ tasks }) => {
  for (const args of [['--host', '0.0.0.0'], ['--dashboard-origin', 'http://example.com:5174']]) {
    const result = await tasks.run(['sympp.cockpit', '--database', join(tasks.root, 'refused.sqlite3'), ...args]);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('loopback');
  }
  const fromEnv = await tasks.run(['sympp.cockpit'], { SYMPP_DASHBOARD_ORIGIN: 'http://example.com:5174' });
  expect(fromEnv.code).not.toBe(0);
  expect(fromEnv.output).toContain('loopback');
});

test('cockpit CLI opens only on opt-in and explicit disable overrides the environment', async ({ tasks }) => {
  const log = join(tasks.root, 'opener.jsonl');
  const opener = join(tasks.bin, 'xdg-open');
  await writeFile(opener, '#!/bin/sh\nprintf "%s\\n" "$1" >> "$ACCEPTANCE_OPEN_LOG"\n');
  await chmod(opener, 0o755);
  for (const [name, flags, env, opens] of [
    ['default', [], {}, false],
    ['flag', ['--open-dashboard'], {}, true],
    ['environment', [], { SYMPP_OPEN_DASHBOARD: '1' }, true],
    ['disabled', ['--no-open-dashboard'], { SYMPP_OPEN_DASHBOARD: '1' }, false],
  ] as const) {
    await writeFile(log, '');
    const child = tasks.start(['sympp.cockpit', '--database', join(tasks.root, `${name}.sqlite3`),
      '--port', '0', '--dashboard-origin', 'http://127.0.0.1:1', ...flags], { ...env, ACCEPTANCE_OPEN_LOG: log });
    // Opening is synchronous in the task; its completion message is the barrier.
    await expect.poll(() => child.output, { timeout: 30_000 }).toContain('Dashboard browser');
    const origin = child.output.match(/Symphony\+\+ API bridge: (http:\/\/127\.0\.0\.1:\d+)/)![1];
    expect((await fetch(`${origin}/mcp/readiness`)).status).toBe(200);
    const urls = (await readFile(log, 'utf8')).trim();
    expect(urls).toBe(opens ? 'http://127.0.0.1:1/sympp/board' : '');
    await child.stop();
  }
});

test('workspace hook CLI scopes PR closure and tolerates provider failures', async ({ tasks }) => {
  const log = join(tasks.root, 'provider.jsonl');
  const gh = join(tasks.bin, 'gh');
  const git = join(tasks.bin, 'git');
  await writeFile(gh, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.ACCEPTANCE_HOOK_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'auth') process.exit(process.env.ACCEPTANCE_HOOK_MODE === 'auth-fails' ? 1 : 0);
if (args[1] === 'list') {
  if (process.env.ACCEPTANCE_HOOK_MODE === 'list-fails') process.exit(1);
  console.log('101\\n102'); process.exit(0);
}
if (args[1] === 'close') process.exit(args[2] === '102' ? 17 : 0);
process.exit(99);
`);
  await writeFile(git, '#!/bin/sh\nif [ "$ACCEPTANCE_HOOK_MODE" != "blank-branch" ]; then printf "feature/acceptance\\n"; fi\n');
  await chmod(gh, 0o755);
  await chmod(git, 0o755);
  for (const mode of ['implicit', 'explicit', 'auth-fails', 'list-fails', 'blank-branch']) {
    await writeFile(log, '');
    const args = ['workspace.before_remove', ...(mode === 'explicit' ? ['--branch', 'feature/selected'] : [])];
    const result = await tasks.run(args, { ACCEPTANCE_HOOK_MODE: mode, ACCEPTANCE_HOOK_LOG: log });
    expect(result.code).toBe(0);
    const calls = (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const closes = calls.filter((args: string[]) => args[1] === 'close');
    if (mode === 'explicit' || mode === 'implicit') {
      const branch = mode === 'explicit' ? 'feature/selected' : 'feature/acceptance';
      expect(calls.find((args: string[]) => args[1] === 'list')).toEqual([
        'pr', 'list', '--repo', 'openai/symphony', '--head', branch, '--state', 'open', '--json', 'number', '--jq', '.[].number',
      ]);
      expect(closes.map((args: string[]) => args[2])).toEqual(['101', '102']);
      expect(closes.every((args: string[]) => args[3] === '--repo' && args[4] === 'openai/symphony')).toBe(true);
      expect(result.output).toContain('Closed PR #101');
      expect(result.output).toContain('Failed to close PR #102');
    } else {
      expect(closes).toEqual([]);
      if (mode === 'blank-branch') expect(calls).toEqual([]);
      if (mode === 'auth-fails') expect(calls).toEqual([['auth', 'status']]);
    }
  }
});
