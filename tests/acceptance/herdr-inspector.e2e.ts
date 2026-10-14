import { expect } from 'e2e';
import { join, basename } from 'node:path';
import { test } from '../support/browser-candidate.js';
import { InspectorHost } from '../support/inspector-host.js';
import { contract } from '../support/factory.js';
import { row } from '../support/delivery.js';

test('compiled inspector binds and pins actual request detail without stealing focus or inventing a worker', async ({ candidate, app, browser }) => {
  const { client, factory } = candidate;
  const request = await client.request('Bound inspector request');
  const [wp, left, right] = (await client.call('slice_work_request', { work_packages: [contract('Inspector findings'), contract('Inspector API'), contract('Inspector UI')] })).work_package_ids;
  for (const dependent of [left, right]) await client.call('upsert_dependency', {
    dependent: { kind: 'work_package', id: dependent }, prerequisite: { kind: 'work_package', id: wp }, reason: 'Findings must land before follow-up work.',
  });
  await client.call('dispatch_work_package', { work_package_id: wp });
  const other = await client.request('Other inspector request');
  const owner = (paneId: string, workRequestId: string) => ({
    pane_id: paneId, tab_id: 'tab-a', workspace_id: 'space-a', agent_session: { agent: 'codex', value: `session-${paneId}` },
    tokens: { sympp_role: 'architect', sympp_show_inspector: 'true', sympp_work_request_id: workRequestId },
  });
  const snapshot = {
    focused_pane_id: 'owner-a', layouts: [{ tab_id: 'tab-a', focused_pane_id: 'owner-a' }],
    panes: [owner('owner-a', request), owner('owner-b', other)],
  };
  const host = new InspectorHost(candidate.root, snapshot, join('.e2e', `${basename(candidate.root)}-inspector.jsonl`));
  try {
    await host.start(new URL(await factory!.endpoint).origin);
    await expect.poll(() => host.screen).toContain('Bound inspector request');
    await expect.poll(() => host.screen).toContain('Inspector findings');
    expect(host.screen).toContain('Inspector API');
    expect(host.screen).toContain('Inspector UI');
    expect(host.screen).toContain('Working now: Unknown');
    expect(host.screen).toContain('Runtime observation unknown');
    expect(host.screen).toContain('Worker pane missing');
    expect(host.screen).not.toContain('Other inspector request');
    expect(host.calls.filter((call) => call.method === 'pane.focus')).toEqual([]);
    expect(snapshot.focused_pane_id).toBe('owner-a');
    expect((await row(client, request, wp)).work_package.blocker_state['active?']).toBe(false);
    await app.open('/sympp/board');
    await expect(browser.locator(`[data-goal="${request}"]`)).toContainText('Inspector findings');

    host.process!.stdin.write('p');
    await expect.poll(() => host.screen).toContain('Pinned');
    await expect.poll(() => host.subscribers.size).toBe(1);
    snapshot.layouts[0].focused_pane_id = 'owner-b';
    snapshot.focused_pane_id = 'owner-b';
    const before = host.frames;
    host.event('pane.focused');
    await expect.poll(() => host.frames).toBeGreaterThan(before);
    expect(host.screen).toContain('Bound inspector request');
    expect(host.calls.filter((call) => call.method === 'pane.focus')).toEqual([]);
    host.process!.stdin.write('p');
    await expect.poll(() => host.screen).toContain('Other inspector request');
    expect(host.screen).not.toContain('Bound inspector request');
    // No real worker process was started. Explicit Enter must still refuse to
    // focus an absent worker, while the user's chosen owner stays focused.
    const entered = host.frames;
    host.process!.stdin.write('\r');
    await expect.poll(() => host.frames).toBeGreaterThan(entered);
    expect(host.calls.filter((call) => call.method === 'pane.focus')).toEqual([]);
    expect(snapshot.focused_pane_id).toBe('owner-b');
    expect(host.stderr).toBe('');
    snapshot.panes = [];
    host.event('pane.closed');
    await expect.poll(() => host.calls.filter((call) => call.method === 'plugin.pane.close').length).toBe(1);
    expect(host.calls.find((call) => call.method === 'plugin.pane.close')!.params.pane_id).toBe('inspector');
    expect(host.calls.filter((call) => call.method === 'pane.focus')).toEqual([]);
  } finally { await host.stop(); }
});
