import { expect } from 'e2e';
import { issue } from '../support/upstream-provider.js';
import { test } from '../support/upstream-runtime.js';

test('provider tools cross worker STDIO and Linear HTTP and recover from ordinary failures', async ({ upstream: u }) => {
  const p = u.provider;
  p.issues = [issue('TOOLS-1')];
  await u.start();
  const worker = await u.worker('TOOLS-1');
  expect(worker.messages.slice(0, 4).map((m) => m.method)).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start']);
  expect(worker.messages[0].params.capabilities.experimentalApi).toBe(true);
  expect(worker.messages[2].params.dynamicTools.some((t) => t.name === 'linear_graphql')).toBe(true);
  expect(worker.messages[2].params.cwd).toBe(worker.cwd);
  expect(worker.turns[0].params.sandboxPolicy.type).toBe('workspaceWrite');
  let id = 100;
  const call = async (tool: string, args: any) => {
    const requestId = ++id;
    p.send(worker, { id: requestId, method: 'item/tool/call', params: { threadId: worker.id, turnId: 'turn-1', callId: `call-${requestId}`, tool, arguments: args } });
    await expect.poll(() => worker.messages.find((m) => m.id === requestId)?.result).toBeDefined();
    return worker.messages.find((m) => m.id === requestId).result;
  };
  const query = 'query IndependentViewer($include: Boolean!) { viewer { id } }';
  const result = await call('linear_graphql', { query, variables: { include: true }, futureField: 'ignored' });
  expect(result.success).toBe(true);
  expect(JSON.parse(result.contentItems[0].text)).toEqual({ data: { viewer: { id: 'external-viewer' } } });
  expect(p.requests.find((r) => r.query === query).variables).toEqual({ include: true });
  p.toolReply = { status: 200, body: { data: { viewer: null }, errors: [{ message: 'Controlled denial' }] } };
  const denied = await call('linear_graphql', query);
  expect(denied.success).toBe(false);
  expect(JSON.parse(denied.contentItems[0].text).errors[0].message).toBe('Controlled denial');
  p.toolReply = { status: 400, body: { message: 'Controlled HTTP failure' } };
  expect((await call('linear_graphql', { query })).success).toBe(false);
  const sent = p.requests.filter((r) => r.query === query).length;
  for (const args of [{ query: '' }, { query, variables: [] }, 42]) {
    expect((await call('linear_graphql', args)).success).toBe(false);
  }
  expect(p.requests.filter((r) => r.query === query)).toHaveLength(sent);
  expect((await call('unsupported_tool', {})).success).toBe(false);
  p.toolReply = { status: 200, body: { data: { recovered: true }, additional: 'tolerated' } };
  expect((await call('linear_graphql', query)).success).toBe(true);
  p.send(worker, { method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
  await u.worker('TOOLS-1', 2);
});

test('provider cumulative usage reaches public status once and survives stream noise', async ({ upstream: u }) => {
  const p = u.provider;
  p.issues = [issue('USAGE-1')];
  await u.start();
  const worker = await u.worker('USAGE-1');
  const usage = (input: number, output: number) => ({ method: 'thread/tokenUsage/updated', params: {
    threadId: worker.id, turnId: 'turn-1', tokenUsage: { total: { inputTokens: input, outputTokens: output, totalTokens: input + output } },
  } });
  // Split a real line across writes; follow malformed/diagnostic lines with valid data.
  const wire = JSON.stringify(usage(10, 3));
  p.send(worker, { raw: `worker diagnostic\n{invalid-json\n${wire.slice(0, 20)}` }, { raw: `${wire.slice(20)}\n` },
    usage(10, 3), usage(5, 1), usage(18, 7),
    { method: 'codex/event/token_count', params: { msg: { info: { last_token_usage: { input_tokens: 999, output_tokens: 999, total_tokens: 1998 } } } } },
    { method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 25, windowDurationMins: 5 } } } });
  await expect.poll(async () => (await u.state()).codex_totals.total_tokens).toBe(25);
  await expect.poll(async () => (await u.state()).rate_limits?.primary?.usedPercent).toBe(25);
  const status = (await u.request('/api/v1/USAGE-1')).body;
  expect(status.running.tokens).toEqual({ input_tokens: 18, output_tokens: 7, total_tokens: 25 });
  expect(status.running.session_id).toBe(`${worker.id}-turn-1`);
  expect(status.workspace.path).toBe(worker.cwd);
  expect((await u.request('/api/v1/UNKNOWN-1')).status).toBe(404);
  expect((await u.request('/api/v1/state', 'POST')).status).toBe(405);
  p.issues[0].state.name = 'Review';
  await expect.poll(async () => (await u.state()).counts.running).toBe(0);
  expect((await u.state()).codex_totals.total_tokens).toBe(25);
});

test('provider poll failures prevent dispatch and recovery admits only current candidates', async ({ upstream: u }) => {
  const p = u.provider;
  p.issues = [issue('POLL-1')];
  p.pollFault = { status: 200, body: { errors: [{ message: 'Controlled poll failure' }] } };
  await u.start();
  await expect.poll(() => p.requests.some((r) => r.variables?.stateNames?.includes('Todo'))).toBe(true);
  expect((await u.state()).counts.running).toBe(0);
  expect(p.workers).toHaveLength(0);
  p.pollFault = undefined;
  const worker = await u.worker('POLL-1');
  p.issues[0].assignee = { id: 'other-worker' };
  await expect.poll(async () => (await u.state()).counts.running).toBe(0);
  expect(p.workers).toHaveLength(1);
  expect(await u.lifecycle('POLL-1')).toContain('created');
  p.issues[0].assignee = { id: 'worker' };
  await expect.poll(() => p.workers.length).toBe(2);
  await u.worker('POLL-1');
  p.issues = [];
  await expect.poll(async () => (await u.state()).counts.running).toBe(0);
  expect(await u.lifecycle('POLL-1')).toContain('created');
  expect(worker.cwd).toContain('POLL-1');
});

test('provider noninteractive approvals answer without stalling and safer policy refuses', async ({ upstream: u }) => {
  const p = u.provider;
  p.issues = [issue('POLICY-1')];
  await u.start();
  const worker = await u.worker('POLICY-1');
  p.send(worker, { id: 501, method: 'item/commandExecution/requestApproval', params: { command: 'echo controlled' } },
    { id: 502, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'choice', question: 'Continue?', options: [] }] } });
  await expect.poll(() => worker.messages.find((m) => m.id === 501)?.result.decision).toBe('acceptForSession');
  await expect.poll(() => worker.messages.find((m) => m.id === 502)?.result.answers.choice.answers[0]).toContain('non-interactive');
  p.issues = [];
  await expect.poll(async () => (await u.state()).counts.running).toBe(0);
  await u.configure({ codex: { approval_policy: 'on-request' } });
  p.issues = [issue('POLICY-2')];
  const safer = await u.worker('POLICY-2');
  p.send(safer, { id: 503, method: 'item/commandExecution/requestApproval', params: { command: 'echo controlled' } });
  await expect.poll(async () => (await u.state()).retrying[0]?.error).toContain('approval_required');
  expect(safer.messages.some((m) => m.id === 503)).toBe(false);
});
