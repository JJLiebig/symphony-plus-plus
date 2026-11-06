// Start chief: which machine it defaults to, where the chief starts there, its place in the topic and
// what it is told.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chiefArgv, chiefBrief, chiefFolders, factoryMachine, intoTopic, isChiefSpace, chiefMenu } from './mods/sympp/chief.js';

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

test('the chief starts in the topic\'s own checkout on its machine, else that repository or the repos root there', () => {
  const space = (id, folder, machine = null) => ({ id, folder, machine });
  const remote = [space('j1', '/srv/jjdev/Code/arena-web', 'jjdev'), space('j2', '/srv/jjdev/Code/codex', 'jjdev'),
    space('j3', '/srv/jjdev/Code/.worktrees/sympp/x', 'jjdev'), space('j4', '/tmp/scratch', 'jjdev')];
  const local = [space('l1', 'C:\\Code\\sympp'), space('l2', 'C:\\Code\\.worktrees\\sympp\\chief-start')];
  const all = [...remote, ...local];
  assert.deepEqual(chiefFolders([local[0], remote[0]], all, 'jjdev'), ['/srv/jjdev/Code/arena-web']);
  assert.deepEqual(chiefFolders([local[1], local[0]], all, 'jjdev'), ['/srv/jjdev/Code/sympp', '/srv/jjdev/Code'], 'worktrees never name the repo or root');
  assert.deepEqual(chiefFolders([local[0]], all, null), ['C:\\Code\\sympp']);
  assert.deepEqual(chiefFolders([], all, null), ['C:\\Code']);
  assert.deepEqual(chiefFolders([local[0]], all, 'vps'), [], 'nothing known there: its home');
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
