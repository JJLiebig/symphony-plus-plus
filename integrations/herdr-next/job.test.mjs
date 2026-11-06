import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from './mods/sympp/model.js';
import * as J from './mods/sympp/job.js';
import { NOW, boardPayload } from './fixture.mjs';

const jobs = () => M.parseBoard(boardPayload()).jobs;
const jobOf = (id) => jobs().find((job) => job.id === id);
const withPackages = (job, packages) => ({ ...job, packages });

test("an agent's report is its own OSC status, labelled as such, never terminal text", () => {
  const terminal = { address: 't8', status: 'blocked', status_ms: NOW - 4 * 60e3, report: { kind: 'permission', msg: ' Allow edit? ' }, title: 'I am done!' };
  const report = J.agentReport(terminal, NOW);
  assert.deepEqual(report, { status: 'blocked', kind: 'permission', msg: 'Allow edit?', age: '4m ago' });
  assert.equal(J.agentReport({ address: 't9', title: 'working hard' }, NOW), null, 'no OSC status means no report');
  const older = { address: 't7', status: 'idle', status_ms: NOW - 60 * 60e3 };
  assert.equal(J.reportFor([{ address: 't7' }, { address: 't8' }], [older, terminal], NOW).status, 'blocked', 'the freshest report wins');
});

test('agents are Live only after a fresh matching helper check, else last seen, else unknown', () => {
  const job = jobOf('wr-pr');
  const binding = { jobId: 'wr-pr', pkgId: 'wp-build', address: 't8', available: true, launchId: 'l1', pid: 10, provider: 'Codex' };
  const fresh = { t8: { ok: true, at: NOW - 1000, launchId: 'l1', pid: 10 } };
  const worker = (bindings, checks, now = NOW) => J.participants(job, bindings, checks, now).find((p) => p.pkgId === 'wp-build');
  assert.equal(worker([binding], fresh).state, 'live');
  assert.equal(worker([binding], fresh).attempt, 2, 'the attempt comes from the active run');
  assert.equal(worker([binding], {}).state, 'seen', 'a bound terminal without a check is not live');
  assert.equal(worker([binding], { t8: { ...fresh.t8, ok: false } }).state, 'seen');
  assert.equal(worker([binding], { t8: { ...fresh.t8, pid: 11 } }).state, 'seen', 'a replaced process is not the checked one');
  assert.equal(worker([{ ...binding, available: false }], fresh).state, 'seen');
  assert.equal(worker([binding], fresh, NOW + J.LIVE_FOR + 2000).state, 'seen', 'a check goes stale');
  assert.equal(worker([binding], {}).at, NOW - 3 * 60e3, 'last seen is the active run heartbeat');
  const people = J.participants(job, [], {}, NOW);
  assert.deepEqual(people.find((p) => p.role === 'Architect'), { key: 'architect', role: 'Architect', subject: null, provider: null, state: 'seen', at: NOW - 20 * 60e3, where: 'Herdr' });
  assert.equal(people.find((p) => p.pkgId === 'wp-queued'), undefined, 'queued work has no worker yet');
  const review = people.find((p) => p.role === 'Review');
  assert.deepEqual(review, { key: 'review:review_suite:fast', role: 'Review', provider: 'Review suite · fast', reviewing: 1, state: 'provider' });
  assert.equal(J.participants(jobOf('wr-shaping'), [], {}, NOW)[0].state, 'unknown');
});

test("open in tab targets the job's local space and carries this copy's props", () => {
  const job = jobOf('wr-pr');
  const spaces = [
    { id: 'remote', machine: 'build', folder: '/src/web', active: false },
    { id: 'notes', machine: null, folder: 'C:\\code\\notes', active: true },
    { id: 'web', machine: null, folder: 'C:\\code\\owner\\web\\', active: false },
  ];
  const given = { endpoint: 'http://127.0.0.1:4000', role: 'panel', hosts: { local: { node: 'node', helper: 'h' } } };
  assert.deepEqual(J.jobTabArgs(given, job, spaces), {
    name: 'Native job tab', space: 'web', mod: 'sympp',
    props: { endpoint: 'http://127.0.0.1:4000', hosts: { local: { node: 'node', helper: 'h' } }, job: 'wr-pr' },
  });
  assert.equal(J.jobSpace(job, spaces.slice(0, 2)).id, 'notes', 'no local match: the shown space');
  assert.equal(J.jobSpace({ ...job, repos: ['C:/code/owner/web'] }, spaces).id, 'web');
  assert.equal(J.jobTabArgs({}, { ...job, title: 'x'.repeat(40) }, []).name.length, 32);
});
