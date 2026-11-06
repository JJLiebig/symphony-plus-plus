// Start chief: which machine it defaults to, where the chief starts there, its place in the topic, what
// it is told, and resuming the topic's last chief.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chiefArgv, chiefBrief, chiefFolders, factoryMachine, intoTopic, isChiefSpace, chiefMenu,
  chiefSession, chiefRunning, canResume, resumeArgv } from './mods/sympp/chief.js';

test('the machine defaults to the factory: this computer for loopback, else the machine its address names or reaches', async () => {
  const machines = [
    { name: 'ci', target: 'ci', host: 'ci-box' },
    { name: 'fly', target: null, via: 'fly ssh console', host: 'fly-1' },
    { name: 'jjdev', target: 'jjdev', host: 'nextide-ci-1' },
  ];
  const ssh = { ci: '10.0.0.5', jjdev: '100.123.207.19' };
  const resolve = async (target) => ssh[target];
  assert.equal(await factoryMachine('http://127.0.0.1:19998', machines, resolve), null);
  assert.equal(await factoryMachine('http://[::1]:19998', machines, resolve), null);
  assert.equal(await factoryMachine('http://100.123.207.19:19998', machines, resolve), 'jjdev', 'setup takes the address from the ssh host');
  assert.equal(await factoryMachine('http://NEXTIDE-CI-1:19998', machines, resolve), 'jjdev');
  assert.equal(await factoryMachine('http://10.9.9.9:19998', machines, resolve), undefined);
  assert.equal(await factoryMachine('http://10.0.0.5:19998', machines, async () => { throw new Error('no ssh'); }), undefined);
});

test("the chief starts in the folder holding the topic's checkouts, at the same place under its machine's repos root", () => {
  const space = (id, folder, machine = null, branch = 'main') => ({ id, folder, machine, branch });
  // This computer keeps its checkouts under D:\src, some in a group folder; box1 under /home/ana/work.
  const here = [space('a1', 'D:\\src\\acme\\api'), space('a2', 'D:\\src\\acme\\web'), space('t1', 'D:\\src\\tools'),
    space('w1', 'D:\\src\\.worktrees\\api\\fix'), space('n1', 'D:\\notes', null, null)];
  const box = [space('b1', '/home/ana/work/acme/api', 'box1'), space('b2', '/home/ana/work/solo', 'box1'), space('b3', '/home/ana', 'box1', null)];
  const all = [...here, ...box];
  assert.deepEqual(chiefFolders([here[0], here[1]], all, 'box1'), ['/home/ana/work/acme', '/home/ana/work'], 'one up from the repos, mapped onto the other root');
  assert.deepEqual(chiefFolders([here[0], here[1], here[3]], all, null), ['D:\\src\\acme', 'D:\\src'], 'worktrees never count');
  assert.deepEqual(chiefFolders([here[2]], all, 'box1'), ['/home/ana/work'], 'repos right in the root: the root');
  assert.deepEqual(chiefFolders([here[0], here[2]], all, 'box1'), ['/home/ana/work'], 'checkouts meeting at the root');
  assert.deepEqual(chiefFolders([box[0]], all, null), ['D:\\src\\acme', 'D:\\src'], 'from another machine onto this one');
  assert.deepEqual(chiefFolders([here[4]], all, 'box1'), ['/home/ana/work'], 'a folder that is no checkout gives no place');
  assert.deepEqual(chiefFolders([here[0]], all, 'vps'), [], 'no repos root known there: its home');
  const factory = { machine: 'vps', root: '/srv/repos' };
  assert.deepEqual(chiefFolders([here[0], here[1]], all, 'vps', factory), ['/srv/repos/acme', '/srv/repos'], "the factory's own root on its machine");
  assert.deepEqual(chiefFolders([here[0]], all, 'box1', factory), ['/home/ana/work/acme', '/home/ana/work'], "other machines keep their spaces' root");
  assert.deepEqual(chiefFolders([here[0]], all, 'box1', { machine: 'box1', root: '/srv/repos' }),
    ['/srv/repos/acme', '/srv/repos', '/home/ana/work/acme', '/home/ana/work'], "then the root the machine's spaces show, should the factory's be missing");
  assert.deepEqual(chiefFolders([here[0]], all, 'vps', { machine: undefined, root: '/srv/repos' }), [], 'not while the factory machine is unknown');
  assert.deepEqual(chiefFolders([here[0], here[1]], all, 'box1', { machine: null, root: 'E:\\factory' }), ['/home/ana/work/acme', '/home/ana/work'],
    "checkouts outside the factory's root count under the root their machine's spaces show");
  assert.deepEqual(chiefFolders([here[0]], [here[0]], null), ['D:\\src\\acme'], 'a single checkout: the folder holding it is the root');
  assert.deepEqual(chiefFolders([box[0]], [box[0], space('x', '/opt/acme', 'box1')], 'box1'), [], 'checkouts meeting only at the top of the file system give no root');
});

test("a stopped chief's last session resumes with its own agent, told to register again", () => {
  const term = { address: 'box1/t9', state: 'live', program: { key: 'codex' }, resume_session: 'c0ffee00-0000-7000-8000-000000000001',
    cwd: '/home/ana', foreground: { cwd: '/home/ana/work/acme' } };
  const last = chiefSession(term);
  assert.deepEqual(last, { terminal: 'box1/t9', agent: 'codex', session: 'c0ffee00-0000-7000-8000-000000000001', cwd: '/home/ana/work/acme' });
  assert.equal(chiefSession({ ...term, resume_session: null }), null, 'no session saved yet');
  assert.equal(chiefSession({ ...term, program: { key: 'gemini' } }), null, 'an agent without a known resume');
  assert.equal(canResume(last), true);
  assert.equal(canResume({ terminal: 'box1/t9', agent: 'codex', session: null }), false, 'started, but never seen saving a session');
  assert.deepEqual(resumeArgv({ run: ['codex', '--no-daemon'] }, last, 'Acme'), ['codex', '--no-daemon', 'resume', last.session, chiefBrief('Acme')]);
  assert.deepEqual(resumeArgv({ run: ['claude'] }, { ...last, agent: 'claude' }, 'Acme'), ['claude', '--resume', last.session, chiefBrief('Acme')]);
});

test('a chief Start chief started counts as running from its start, and stops counting once its agent ends', () => {
  const last = { terminal: 'box1/t9', agent: 'codex', session: null, started: 1000 };
  const live = (key, state = 'live') => [{ address: 'box1/t9', state, program: { key } }];
  assert.equal(chiefRunning(last, live('shell'), 2000), true, 'starting, before its agent shows');
  assert.equal(chiefRunning(last, live('codex'), 999e3), true, 'its agent runs there');
  assert.equal(chiefRunning(last, live('shell'), 999e3), false, 'its agent ended; the shell stays');
  assert.equal(chiefRunning(last, live('codex', 'finished'), 2000), false);
  assert.equal(chiefRunning({ ...last, started: undefined }, live('shell'), 2000), false, 'recorded by the panel, not just started');
  assert.equal(chiefRunning(undefined, live('codex')), false);
});

test('a new chief space joins the end of its topic, which unfolds; a removed topic gets nothing', () => {
  const desk = { groups: [{ id: 'kraken', name: 'Kraken', spaces: ['a'], folded: true }, { id: 'other', name: 'Other', spaces: ['b'] }], unsorted: ['c', 'jjdev/sp9'] };
  assert.deepEqual(intoTopic(desk, 'kraken', 'jjdev/sp9'), {
    groups: [{ id: 'kraken', name: 'Kraken', spaces: ['a', 'jjdev/sp9'], folded: false }, { id: 'other', name: 'Other', spaces: ['b'] }], unsorted: ['c'],
  });
  assert.deepEqual(desk.unsorted, ['c', 'jjdev/sp9'], 'the shared value is not changed in place');
  assert.equal(intoTopic(desk, 'gone', 'jjdev/sp9'), null);
});

test("a topic's chief space is the one Start chief made for it, or, made before it kept a record, named for it", () => {
  const topic = { id: 'topic-k', name: 'Kraken' };
  const made = { s1: 'topic-k', s2: 'topic-other' };
  assert.equal(isChiefSpace({ id: 's1', name: 'Old Kraken chief' }, topic, made), true, 'a renamed topic keeps its chief space');
  assert.equal(isChiefSpace({ id: 's3', name: 'Kraken chief' }, topic, {}), true, 'a space from before the record');
  assert.equal(isChiefSpace({ id: 's2', name: 'api' }, topic, made), false, "another topic's chief space");
  assert.equal(isChiefSpace({ id: 's4', name: 'Kraken' }, topic, undefined), false);
});

test('the chief is told its topic is its domain, then the person\'s words, in each agent\'s first-message form', () => {
  const brief = chiefBrief('Kraken', '  Start with the open review.  ');
  assert.match(brief, /chief for the "Kraken" topic/);
  assert.match(brief, /sympp skill/);
  assert.match(brief, /register_chief, using "Kraken" as the domain/);
  assert.ok(brief.endsWith('\n\nStart with the open review.'));
  assert.equal(chiefBrief('Kraken', ' '), chiefBrief('Kraken'));
  assert.deepEqual(chiefArgv({ key: 'codex', run: ['codex'] }, 'go'), ['codex', 'go']);
  assert.deepEqual(chiefArgv({ key: 'gemini', run: ['gemini'] }, 'go'), ['gemini', '-i', 'go']);
});

test("the mark's menu offers only what applies: a running chief's space and composition, then a new chief", () => {
  const labels = (terminal, terminals, panes) => chiefMenu(terminal, terminals, panes).map((i) => i.label);
  const live = [{ address: 'jjdev/t7w', state: 'live' }];
  assert.deepEqual(labels('jjdev/t7w', live, [{ pane: 'p1', terminal: 'jjdev/t7w' }]), ['Go to chief space', 'Add to composition', 'Start new chief']);
  assert.deepEqual(labels('jjdev/t7w', live, []), ['Add to composition', 'Start new chief'], 'no pane to go to');
  assert.deepEqual(labels('jjdev/t7w', [{ address: 'jjdev/t7w', state: 'finished' }], [{ pane: 'p1', terminal: 'jjdev/t7w' }]), ['Start new chief']);
  assert.deepEqual(labels(null, live, []), ['Start new chief']);
});
