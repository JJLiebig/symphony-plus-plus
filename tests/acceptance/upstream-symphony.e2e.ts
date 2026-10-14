import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'e2e';
import { issue } from '../support/upstream-provider.js';
import { test } from '../support/upstream-runtime.js';

// Expectations come from SPEC sections 5-13/17, not the legacy test bodies.
test('upstream polls pages, routes eligible issues and reconciles real workspaces', async ({ upstream: u }) => {
  const p = u.provider;
  p.issues = [issue('NEW-2', { createdAt: '2026-02-01T00:00:00Z' }),
    issue('BLOCKED-1', { priority: 1, inverseRelations: { nodes: [
      { type: 'blocks', issue: { id: 'prerequisite', identifier: 'PRE-1', state: { name: 'Todo' } } },
    ] } }), issue('OLD-1'), issue('UNASSIGNED-1', { assignee: null, priority: 1 }),
    issue('TERMINAL-1', { state: { name: 'Done' } })];
  const terminal = join(u.workspaces, 'TERMINAL-1');
  await mkdir(terminal, { recursive: true });
  await writeFile(join(terminal, 'leftover'), 'previous runtime');
  await u.start();
  const first = await u.worker('OLD-1');
  expect(first.cwd).toBe(join(u.workspaces, 'OLD-1'));
  expect(p.workers.map((w) => w.cwd)).toEqual([first.cwd]);
  await expect.poll(async () => stat(terminal).then(() => true, () => false)).toBe(false);
  expect(await u.lifecycle('OLD-1')).toBe('created\nbefore\n');
  expect(p.requests.some((r) => r.variables?.after === '2')).toBe(true);
  const poll = p.requests.find((r) => r.variables?.stateNames?.includes('Todo'));
  expect(poll.variables.projectSlug).toBe('upstream-project');
  expect(poll.query).toContain('slugId');
  expect(poll.authenticated).toBe(true);
  expect(first.turns[0].params.input[0].text).toContain('Work OLD-1 / Deliver OLD-1 / upstream / attempt=');
  expect(first.turns[0].params.input[0].text).toContain('created=2026-01-01T00:00:00Z');

  p.issues.find((r) => r.id === 'OLD-1').state.name = 'In Progress';
  await expect.poll(async () => (await u.state()).running[0]?.state).toBe('In Progress');
  p.refreshFault = { status: 200, body: { errors: [{ message: 'Tracker temporarily unavailable' }] } };
  const reads = p.requests.length;
  await expect.poll(() => p.requests.slice(reads).some((r) => r.variables?.ids)).toBe(true);
  expect((await u.state()).running[0].session_id).toBe(`${first.id}-turn-1`);
  expect(first.exited).toBeUndefined();
  p.refreshFault = undefined;
  p.issues.find((r) => r.id === 'OLD-1').state.name = 'Review';
  await u.worker('NEW-2');
  expect(await u.lifecycle('OLD-1')).toContain('created\nbefore\n');
  p.issues.find((r) => r.id === 'NEW-2').state.name = 'Done';
  await expect.poll(async () => (await u.state()).counts.running).toBe(0);
  await expect.poll(async () => stat(join(u.workspaces, 'NEW-2')).then(() => true, () => false)).toBe(false);
  expect(await readFile(join(u.root, 'removed.txt'), 'utf8')).toContain('NEW-2');
  expect(p.workers).toHaveLength(2);
  expect(p.requests.find((r) => r.variables?.ids)?.query).toContain('[ID!]');
  p.issues.find((r) => r.id === 'BLOCKED-1').inverseRelations.nodes[0].issue.state.name = 'Done';
  await u.worker('BLOCKED-1');
});

test('upstream continues a thread, retries abnormal exits and recovers after restart', async ({ upstream: u }) => {
  const p = u.provider;
  p.issues = [issue('RETRY-1')];
  await u.start();
  const first = await u.worker('RETRY-1');
  await writeFile(join(first.cwd, 'local-progress.txt'), 'preserve worker progress');
  p.send(first, { method: 'turn/completed', params: { threadId: first.id, turn: { id: 'turn-1', status: 'completed' } } });
  await u.worker('RETRY-1', 2);
  expect(first.turns[1].params.threadId).toBe(first.id);
  expect(first.turns[1].params.input[0].text).toContain('Continuation guidance');
  p.send(first, { method: 'turn/completed', params: { turn: { id: 'turn-2', status: 'completed' } } });
  await expect.poll(async () => (await u.state()).retrying[0]?.attempt).toBe(1);
  await expect.poll(() => p.workers.length).toBe(2);
  const second = await u.worker('RETRY-1');
  expect(second.id).not.toBe(first.id);
  expect(second.turns[0].params.input[0].text).toContain('attempt=1');
  expect(await u.lifecycle('RETRY-1')).toBe('created\nbefore\nafter\nbefore\n');
  p.send(second, { exit: 17 });
  await expect.poll(async () => (await u.state()).retrying[0]?.attempt).toBe(2);
  const retry = (await u.request('/api/v1/RETRY-1')).body;
  expect(retry.status).toBe('retrying');
  expect(retry.last_error).toBeTruthy();
  expect(Date.parse(retry.retry.due_at)).toBeGreaterThan(Date.now() - 1000);
  await expect.poll(() => p.workers.length).toBe(3);
  await u.worker('RETRY-1');
  await u.stop();
  const beforeRestart = p.workers.length;
  await u.start();
  await expect.poll(() => p.workers.length).toBe(beforeRestart + 1);
  const recovered = await u.worker('RETRY-1');
  expect(recovered.cwd).toBe(first.cwd);
  expect(await readFile(join(recovered.cwd, 'local-progress.txt'), 'utf8')).toBe('preserve worker progress');
  expect((await u.lifecycle('RETRY-1')).split('created\n')).toHaveLength(2);
});

test('upstream reload keeps the last valid workflow and applies new prompts without restart', async ({ upstream: u }) => {
  const p = u.provider;
  p.issues = [issue('RELOAD-1')];
  await u.start();
  const first = await u.worker('RELOAD-1');
  await writeFile(u.workflow, '---\ntracker: [\n---\nBroken workflow\n');
  await expect.poll(() => u.runtimeLog()).toContain('keeping last known good configuration');
  p.issues[0].state.name = 'Review';
  p.issues.push(issue('RELOAD-2'));
  const second = await u.worker('RELOAD-2');
  expect(second.turns[0].params.input[0].text).toContain('Work RELOAD-2');
  await u.configure({ agent: { max_concurrent_agents: 2 } }, 'Changed {{ issue.identifier }}');
  p.issues.push(issue('RELOAD-3'));
  const third = await u.worker('RELOAD-3');
  expect(third.turns[0].params.input[0].text).toBe('Changed RELOAD-3');
  expect(first.cwd).not.toBe(third.cwd);
  expect((await u.state()).counts.running).toBe(2);
  await u.configure({}, '{{ unknown_contract_variable }}');
  p.issues = [issue('BAD-PROMPT-1')];
  await expect.poll(async () => (await u.state()).retrying.some((r) => r.issue_identifier === 'BAD-PROMPT-1'), { timeout: 20000 }).toBe(true);
  expect(p.worker('BAD-PROMPT-1')?.turns.length ?? 0).toBe(0);
});

test('upstream rejects unavailable workflow and missing operator acknowledgement at the CLI boundary', async ({ upstream: u }) => {
  await u.start([u.workflow]);
  await expect.poll(() => u.process?.exitCode).toBe(1);
  expect(await readFile(u.logPath, 'utf8')).toContain('without any guardrails');
  await u.stop();
  await u.start(['--i-understand-that-this-will-be-running-without-the-usual-guardrails', join(u.root, 'missing.md')]);
  await expect.poll(() => u.process?.exitCode).toBe(1);
  expect(await readFile(u.logPath, 'utf8')).toContain('Workflow file not found');
  await u.stop();
  await writeFile(u.workflow, '---\n- invalid-front-matter\n---\nInvalid\n');
  await u.start(['--i-understand-that-this-will-be-running-without-the-usual-guardrails', u.workflow]);
  await expect.poll(() => u.process?.exitCode).toBe(1);
  expect(await readFile(u.logPath, 'utf8')).toContain('Failed to start Symphony');
  await u.stop();
  await u.configure({}, '');
  u.provider.issues = [issue('DEFAULT-1', { description: null })];
  await u.start(['--i-understand-that-this-will-be-running-without-the-usual-guardrails', '--logs-root', u.root], true);
  const worker = await u.worker('DEFAULT-1');
  expect(worker.turns[0].params.input[0].text).toContain('DEFAULT-1');
  expect(worker.turns[0].params.input[0].text).toContain('Deliver DEFAULT-1');
  expect(await u.runtimeLog()).toContain('Running SymphonyElixirWeb.Endpoint');
});

test('upstream aborts failed bootstrap and run hooks, then recovers with safe cleanup', async ({ upstream: u }) => {
  const p = u.provider;
  p.issues = [issue('HOOK/1')];
  await mkdir(u.workspaces, { recursive: true });
  await writeFile(join(u.workspaces, 'HOOK_1'), 'stale non-directory workspace');
  await u.configure({ hooks: { after_create: 'exit 17' } });
  await u.start();
  await expect.poll(async () => (await u.state()).retrying[0]?.error).toContain('workspace_hook_failed');
  expect(p.workers).toHaveLength(0);
  await u.configure({ hooks: { before_run: 'exit 18' } });
  await expect.poll(async () => (await u.state()).retrying[0]?.error).toContain('before_run');
  expect(p.workers).toHaveLength(0);
  await u.configure({ hooks: { after_run: 'exit 19', before_remove: 'exit 20' } });
  const worker = await u.worker('HOOK_1');
  expect(worker.turns[0].params.title).toContain('HOOK/1');
  p.issues[0].state.name = 'Done';
  p.send(worker, { method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
  await expect.poll(async () => (await u.state()).counts.running).toBe(0);
  // A terminal issue completed by its worker is swept on the next startup.
  await u.stop();
  await u.start();
  await expect.poll(async () => stat(worker.cwd).then(() => true, () => false)).toBe(false);
});

test('upstream honors priority, age and state-specific capacity without duplicate dispatch', async ({ upstream: u }) => {
  const p = u.provider;
  await u.configure({ agent: { max_concurrent_agents: 2, max_concurrent_agents_by_state: { ToDo: 1 } } });
  p.issues = [issue('LOW-1', { priority: 3, createdAt: '2025-01-01T00:00:00Z' }),
    issue('HIGH-NEW', { priority: 1, createdAt: '2026-02-01T00:00:00Z' }),
    issue('HIGH-OLD', { priority: 1 }), issue('ACTIVE-1', { priority: 4, state: { name: 'In Progress' } })];
  await u.start();
  await u.worker('HIGH-OLD');
  await u.worker('ACTIVE-1');
  expect(p.workers).toHaveLength(2);
  expect((await u.state()).counts.running).toBe(2);
  p.issues.find((r) => r.id === 'HIGH-OLD').state.name = 'Review';
  await u.worker('HIGH-NEW');
  expect(p.workers).toHaveLength(3);
  p.issues.find((r) => r.id === 'HIGH-NEW').state.name = 'Review';
  await u.worker('LOW-1');
  expect(p.workers).toHaveLength(4);
});
