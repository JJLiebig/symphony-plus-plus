import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from './mods/sympp/model.js';
import * as L from './mods/sympp/levels.js';
import { NOW, boardPayload, deskFixture } from './fixture.mjs';

const board = () => M.parseBoard(boardPayload());
const setup = (repoTopics) => {
  const { jobs } = board();
  const { topics, spaces } = deskFixture();
  const desk = L.deskOf(topics, spaces);
  return { jobs, spaces, desk, place: L.placeJobs(jobs, desk, repoTopics) };
};
const ids = (list) => list.map((item) => item.id);
const byId = (list, id) => list.find((item) => item.id === id);

test('the factory has one row per Herdr topic, keeps unsorted spaces and counts a cross-repo job once', () => {
  const { jobs, desk, place } = setup();
  const rows = L.factoryRows(jobs, desk, place);
  assert.deepEqual(ids(rows), ['t-herdr', 't-tools', 't-live', L.UNSORTED], 'topics in Herdr order, then unsorted; nothing is without a space');
  assert.deepEqual(ids(byId(rows, 't-herdr').jobs), ['wr-pr', 'wr-shaping']);
  assert.deepEqual(ids(byId(rows, 't-tools').jobs), ['wr-cross'], 'the api repository is the cross-repo job\'s home');
  assert.deepEqual(byId(rows, 't-herdr').shared, [{ name: 'Personal Tools', count: 1 }], 'its other topic references it');
  assert.deepEqual(ids(byId(rows, L.UNSORTED).jobs), ['wr-nopr'], 'unsorted spaces still place their work');
  assert.deepEqual(byId(rows, 't-live').jobs, [], 'an empty topic keeps its row');
  assert.equal(rows.reduce((n, row) => n + row.jobs.length, 0), jobs.length, 'every open job is counted exactly once');
  assert.deepEqual([byId(rows, 't-herdr').needs, byId(rows, 't-herdr').moving], [1, 2]);
  assert.deepEqual(byId(rows, 't-tools').repos, ['api', 'web']);
  assert.equal(byId(desk, 't-herdr').spaces.length, 1, 'a topic space that no longer exists is dropped');
  assert.deepEqual(ids(byId(desk, L.UNSORTED).spaces), ['s-notes', 's-home'], 'spaces no topic claims are unsorted');

  const stray = M.parseBoard({ ...boardPayload(), work_request_details: [{ work_request: { id: 'lost', title: 'Lost', repo: 'owner/elsewhere', inserted_at: new Date(NOW).toISOString() } }] }).jobs;
  const strayRows = L.factoryRows(stray, desk, L.placeJobs(stray, desk));
  assert.deepEqual(ids(byId(strayRows, L.NOWHERE).jobs), ['lost'], 'work matching no space still shows');
});

test('placement uses explicit repository mappings first and never matches ancestor folders', () => {
  const { jobs, spaces } = setup();
  const work = L.spaceWork(spaces[0], [...jobs, { ...jobs[0], id: 'ancestor', repos: ['owner/code'] }]);
  assert.deepEqual(ids(work.jobs).sort(), ['wr-cross', 'wr-pr'], 'C:\\code\\owner\\web is web, never code');
  const mapped = setup({ 'owner/api': 't-herdr' });
  const cross = byId(mapped.jobs, 'wr-cross');
  assert.equal(mapped.place.home(cross), 't-herdr');
  assert.equal(mapped.place.touches(cross, 't-tools'), false, 'a mapped repository belongs only to its mapped topic');
});

test('needs-you ranks by downstream packages unblocked, then by the longest wait', () => {
  const { jobs } = setup();
  const queue = L.needsQueue(jobs);
  assert.deepEqual(queue.map((n) => [n.job.id, n.pkgId, n.unblocks]), [
    ['wr-cross', null, 2],
    ['wr-pr', 'wp-review', 1],
    ['wr-cross', 'x-web', 0],
  ], 'an ask holds every unfinished package of its job; guidance holds what comes after it');
  const pr = byId(jobs, 'wr-pr');
  assert.equal(L.unblocks(pr, 'wp-done'), 2, 'transitive dependents count once each');
  const finished = { ...pr, packages: pr.packages.map((pkg) => (pkg.id === 'wp-queued' ? { ...pkg, stage: 'done' } : pkg)) };
  assert.equal(L.unblocks(finished, 'wp-review'), 0, 'finished dependents are not waiting');
  assert.equal(L.unblocks({ ...pr, edges: [['wp-build', 'wp-review'], ['wp-review', 'wp-build']] }, 'wp-build'), 1, 'a cycle ends');
  const tie = [{ ...pr, id: 'a', needs: [{ key: 'a', pkgId: 'wp-review', since: NOW - 5 }] }, { ...pr, id: 'b', needs: [{ key: 'b', pkgId: 'wp-review', since: NOW - 50 }] }];
  assert.deepEqual(L.needsQueue(tie).map((n) => n.key), ['b', 'a']);
});

test('a topic groups work by repository; other topics\' jobs are references and planned jobs fold to a count', () => {
  const { jobs, desk, place } = setup();
  const herdr = L.topicWork(byId(desk, 't-herdr'), jobs, place);
  assert.deepEqual(herdr.map((g) => g.key), ['web']);
  const [web] = herdr;
  assert.deepEqual(ids(web.spaces), ['s-web']);
  assert.deepEqual(ids(web.jobs), ['wr-pr']);
  assert.deepEqual(ids(web.planned), ['wr-shaping'], 'shaping work is only planned');
  assert.deepEqual(web.refs.map((r) => [r.job.id, r.from]), [['wr-cross', 't-tools']]);
  const tools = L.topicWork(byId(desk, 't-tools'), jobs, place);
  assert.deepEqual(tools.map((g) => [g.key, ids(g.jobs), g.refs.map((r) => r.via)]), [['api', ['wr-cross'], []]],
    'its home draws it once; its web package lives in another topic');
  assert.deepEqual(L.topicWork(byId(desk, 't-live'), jobs, place), []);

  const settled = jobs.map((job) => (job.id === 'wr-cross' ? { ...job, lane: 'settled', state: 'settled' } : job));
  assert.deepEqual(L.topicWork(byId(desk, 't-herdr'), settled, place)[0].refs, [], 'settled work is not referenced elsewhere');
  assert.equal(L.topicWork(byId(desk, 't-tools'), settled, place)[0].away, 1, 'it is counted once, at home');

  const wide = { ...byId(jobs, 'wr-pr'), id: 'wide', repos: ['owner/web', 'owner/docs', 'owner/site'] };
  const many = [{ id: 'g', name: 'G', kind: 'topic', spaces: ['web', 'docs', 'site'].map((name) => ({ id: name, folder: `/code/${name}` })) }];
  const refs = L.topicWork(many[0], [wide], L.placeJobs([wide], many)).flatMap((g) => g.refs);
  assert.deepEqual(refs.map((r) => [r.at, r.via]), [['docs', 'web'], ['site', 'web']], 'each repository holds its own reference');
});

test('a space shows the jobs touching its repository with their other repositories, and empty spaces stay ordinary', () => {
  const { jobs, spaces } = setup();
  const web = L.spaceWork(spaces[0], jobs);
  assert.equal(web.repo, 'web');
  assert.deepEqual(ids(web.jobs), ['wr-pr', 'wr-cross'], 'needs-you first, latest move first');
  assert.deepEqual(web.elsewhere(byId(jobs, 'wr-cross')), ['api']);
  const api = L.spaceWork(spaces[3], jobs);
  assert.equal(api.jobs[0], byId(jobs, 'wr-cross'), 'a remote space references the same canonical job');
  assert.deepEqual(L.spaceWork(spaces[2], jobs).jobs, []);
  assert.deepEqual(L.spaceWork({ id: 'x', folder: '' }, jobs).jobs, [], 'a space without a folder has no repository');
});

test('agents on a level are the jobs\' agents and any bound agent there: Live, last seen or unknown, with their own report', () => {
  const { jobs } = setup();
  const pr = byId(jobs, 'wr-pr');
  const terminal = { address: 'vps/t4', status: 'working', status_ms: NOW - 60e3, report: { msg: 'Running tests' }, labels: { 'herdr.space': 's-api' } };
  const bound = { kind: 'launch', jobId: 'wr-cross', pkgId: 'x-api', address: 'vps/t4', machine: 'vps', role: 'worker', provider: 'Codex', available: true, launchId: 'l1', pid: 7 };
  const checks = { 'vps/t4': { ok: true, at: NOW - 1000, launchId: 'l1', pid: 7 } };
  const here = L.agentRows([pr], jobs, [bound], [terminal], ['vps/s-api'], checks, NOW);
  assert.deepEqual(here.map((a) => [a.job.id, a.subject, a.state]), [
    ['wr-cross', 'Token API', 'live'],
    ['wr-pr', 'Stage board', 'seen'],
    ['wr-pr', null, 'seen'],
  ], 'Live first, then the latest sighting; a worker with nothing known is left out');
  const live = here[0];
  assert.equal(live.here, true);
  assert.equal(live.report.status, 'working');
  assert.equal(live.report.msg, 'Running tests');
  assert.equal(L.terminalSpace(bound, [terminal]), 'vps/s-api', 'remote space ids carry their machine');
  assert.ok(!here.some((a) => a.role === 'Review'), 'review providers stay on the Job level');
  const unchecked = L.agentRows([], jobs, [bound], [terminal], ['vps/s-api'], {}, NOW);
  assert.equal(unchecked[0].state, 'unknown', 'a bound agent without a check or sighting is unknown, never live');
  assert.deepEqual(L.agentRows([], jobs, [bound], [terminal], ['s-web'], checks, NOW), [], 'an agent elsewhere is not here');
  assert.ok(!L.agentRows([byId(jobs, 'wr-shaping')], jobs, [], [], [], {}, NOW).length, 'unknown agents without a terminal are not listed');
});

test('the panel follows a job\'s terminal or tab, else the space while it has work, else its topic', () => {
  const { jobs, desk, place } = setup();
  const focus = (extra) => ({ space: 's-web', tab: 'tab-web', pane: 'p1', terminal: 't1', shown: null, ...extra });
  const terms = [{ address: 't1', labels: { 'sympp.work_package_id': 'x-web', 'sympp.session_work_request_id': '' } }, { address: 't2', labels: {} }];
  const panes = [{ pane: 'p1', terminal: 't1' }, { pane: 'p2', terminal: 't2' }, { pane: 'p3', terminal: null, mod: 'sympp' }];
  const follow = (f, tabs = {}) => L.followPath(L.focusTarget(f, terms, tabs, panes), jobs, desk, place);
  assert.deepEqual(follow(focus()), { topic: 't-herdr', space: 's-web', job: 'wr-cross' }, 'an S++ terminal names its job, found by package');
  assert.deepEqual(follow(focus({ pane: 'p3', terminal: null }), { 'tab-web': 'wr-pr' }), { topic: 't-herdr', space: 's-web', job: 'wr-pr' }, 'a job tab names its job');
  assert.equal(follow(focus({ pane: 'p3', terminal: null })), null, 'focusing the panel itself keeps what it shows');
  assert.deepEqual(follow(focus({ pane: 'p2', terminal: 't2' })), { topic: 't-herdr', space: 's-web', job: null }, 'a space with work');
  assert.deepEqual(follow(focus({ space: 's-home', pane: 'p2', terminal: 't2' })), { topic: L.UNSORTED, space: 's-home', job: null }, 'an unsorted space without work still shows itself');
  const quiet = jobs.filter((job) => !job.repos.includes('owner/web'));
  assert.deepEqual(L.followPath(L.focusTarget(focus({ pane: 'p2', terminal: 't2' }), terms, {}, panes), quiet, desk, L.placeJobs(quiet, desk)),
    { topic: 't-herdr', space: null, job: null }, 'a quiet space in a topic shows its topic');
  const plannedOnly = jobs.filter((job) => job.id === 'wr-shaping');
  assert.deepEqual(L.followPath(L.focusTarget(focus({ pane: 'p2', terminal: 't2' }), terms, {}, panes), plannedOnly, desk, L.placeJobs(plannedOnly, desk)),
    { topic: 't-herdr', space: 's-web', job: null }, 'planned work keeps the space');
  assert.equal(L.focusTarget(null, terms, {}, panes), null);
});

test('a toast is due only for a need that appeared between two successful reads, never first or offline', () => {
  const first = board();
  const start = L.newNeeds(null, first);
  assert.deepEqual(start.fresh, [], 'the first read only records');
  assert.deepEqual(L.newNeeds(start.seen, first).fresh, [], 'a repaint or unchanged read says nothing');
  const payload = boardPayload();
  payload.guidance_requests.guidance_requests.push({ id: 'g-new', work_package_id: 'np-2', status: 'human_info_needed', question: 'Publish where?', updated_at: new Date(NOW).toISOString() });
  const next = M.parseBoard(payload);
  const { fresh } = L.newNeeds(start.seen, next);
  assert.deepEqual(fresh.map((n) => [n.key, n.job.id]), [['guidance:g-new', 'wr-nopr']]);
  assert.deepEqual(L.newNeeds(start.seen, { ...next, offline: true }).fresh, [], 'an offline copy never announces');
  assert.notEqual(L.toastId(fresh[0]), L.toastId({ ...fresh[0], since: NOW + 1 }), 'a need raised again later is a new item');

  const later = (minutes) => new Date(NOW + minutes * 60e3).toISOString();
  const reraised = boardPayload();
  reraised.work_request_details.find((d) => d.work_request.id === 'wr-cross').work_request.operator_report.human_escalation.raised_at = later(1);
  assert.deepEqual(L.newNeeds(start.seen, M.parseBoard(reraised)).fresh.map((n) => n.key), ['wr-cross:ask'], 'an escalation raised again between reads is new');
  const moved = boardPayload();
  const review = moved.work_request_details[0].work_packages.find((pkg) => pkg.id === 'wp-review');
  review.activity_signal = { ...review.activity_signal, last_update_at: later(1) };
  assert.deepEqual(L.newNeeds(start.seen, M.parseBoard(moved)).fresh, [], 'a need whose activity moved is not new');
});

test('the breadcrumb runs Factory > Topic > Space > Job, Esc goes up one level and gone places fall back', () => {
  const { jobs, desk } = setup();
  const path = { topic: 't-herdr', space: 's-web', job: 'wr-pr' };
  assert.deepEqual(L.crumbs(path, desk, jobs).map((c) => [c.level, c.label]), [['factory', 'Factory'], ['topic', 'Herdr'], ['space', 'web'], ['job', 'Native job tab']]);
  assert.equal(L.levelOf(path), 'job');
  assert.equal(L.levelOf(L.up(path)), 'space');
  assert.equal(L.levelOf(L.up(L.up(path))), 'topic');
  assert.equal(L.levelOf(L.up(L.up(L.up(path)))), 'factory');
  assert.deepEqual(L.resolvePath({ topic: 't-gone', space: null, job: null }, desk, jobs), { topic: null, space: null, job: null });
  assert.deepEqual(L.resolvePath({ topic: 't-tools', space: 's-web', job: 'wr-archived' }, desk, jobs), { topic: 't-herdr', space: 's-web', job: null }, 'a space sits under its own topic');
  assert.equal(L.resolvePath({ job: 'wr-new' }, desk, jobs, 'wr-new').job, 'wr-new', 'a just-created job waits for the board');
});

test('a topic\'s chief is the one named like it, else one whose name leads or ends it, else by its repositories; several are all shown', () => {
  const { desk } = setup();
  const { chiefs } = board();
  const topic = (name, spaces = []) => ({ id: name, name, kind: 'topic', spaces });
  const chief = (domain, repos = []) => ({ domain, key: domain.toLowerCase(), repos, location: null, session: null });
  const of = (t, list, d = desk) => L.chiefsFor(t, list, d).map((c) => c.domain);
  assert.deepEqual(of(byId(desk, 't-herdr'), chiefs), ['Herdr'], 'names match ignoring case');
  assert.deepEqual(of(byId(desk, 't-live'), chiefs), ['Live'], 'Live ends Nextide-Live');
  assert.deepEqual(of(byId(desk, 't-tools'), chiefs), [], 'a topic nothing matches has no chief');
  assert.deepEqual(of(byId(desk, L.UNSORTED), chiefs), [], 'unsorted spaces are not a topic');
  assert.deepEqual(of(topic('Nextide-Kraken'), [chief('kraken'), chief('Personal')]), ['kraken']);
  assert.deepEqual(of(topic('Kraken'), [chief('Nextide-Kraken')]), ['Nextide-Kraken'], 'either name may be the longer');
  assert.deepEqual(of(topic('Personal Tools'), [chief('personal-tools'), chief('Tools')]), ['personal-tools'], 'the exact name wins over a word');
  assert.deepEqual(of(topic('Nextide-Kraken'), [chief('Nextide'), chief('Kraken')]), ['Nextide', 'Kraken'], 'two at the same rule are both shown');
  assert.deepEqual(of(topic('Krakenite'), [chief('Kraken')]), [], 'a word is whole, never part of one');
  const two = [topic('Nextide'), topic('Nextide-Live')];
  assert.deepEqual(of(two[1], [chief('Nextide')], two), [], 'a chief named exactly like another topic belongs there');
  const tools = byId(desk, 't-tools');
  assert.deepEqual(of(tools, [chief('Platform', ['owner/api'])]), ['Platform'], 'its repositories place it where jobs on them place');
  assert.deepEqual(of(tools, [chief('Platform', ['owner/api']), chief('Tools')]), ['Tools'], 'a name match comes before repositories');
  assert.deepEqual(L.chiefsFor(tools, [chief('Platform', ['owner/api'])], desk, { 'owner/api': 't-herdr' }), [], 'explicit repository mappings apply');
});

test('a chief\'s desk lists what it dispatched where it is now, newest first, with recaps and what waits on the person', () => {
  const { jobs } = setup();
  const [herdr, live] = board().chiefs;
  const desk = L.chiefDesk(herdr, jobs, NOW);
  assert.deepEqual(desk.work.map((w) => [w.key, w.now, w.packages.map((p) => p.key)]), [
    ['wr-cross:x-api', 'Building · 2h 00m', []],
    ['wr-pr', 'Executing · 1/4 landed', ['wr-pr:wp-build']],
  ], 'a package dispatched in someone else\'s request stands alone; a request lists its own dispatched packages');
  assert.equal(desk.work[1].packages[0].now, 'Building · 1h 30m');
  assert.deepEqual(desk.recaps.map((r) => [r.job.id, r.text]), [['wr-cross', 'Token API is building; the UI waits on it and on your call.']]);
  assert.deepEqual(desk.needs.map((n) => n.key), L.needsQueue([byId(jobs, 'wr-cross'), byId(jobs, 'wr-pr')]).map((n) => n.key), 'what waits on the person there, ranked like the factory queue');
  assert.equal(desk.needs.length, 3);
  assert.deepEqual(L.chiefDesk(live, jobs, NOW), { work: [], recaps: [], needs: [] }, 'attribution is by domain, never by topic or repository');
});

test('a chief is Live only after a helper check of its own registered session, else last seen, else unknown', () => {
  const [herdr, live] = board().chiefs;
  const labels = {
    'sympp.session_id': 'chief-herdr', 'sympp.session_core_id': 'core-1', 'sympp.session_pid': '70', 'sympp.session_process_id': '71',
    'sympp.session_receipt': String.raw`C:\private\chief.json`, 'sympp.session_role': 'coordinator', 'sympp.session_work_request_id': 'wr-pr',
  };
  const terminal = { address: 't7', pid: 70, state: 'live', status: 'working', status_ms: NOW - 60e3, report: { msg: 'Slicing the board' }, labels };
  const other = { ...terminal, address: 't8', labels: { ...labels, 'sympp.session_core_id': 'core-2' } };
  const bindings = M.discoverBindings({ local: { node: 'node', helper: 'h' } }, [terminal, other]);
  assert.deepEqual(M.chiefBindings(bindings, herdr).map((b) => b.address), ['t7'], 'the same session id on another core is not the chief');
  const seen = L.chiefAgent(herdr, bindings, [terminal], {}, NOW);
  assert.deepEqual([seen.state, seen.where, seen.at], ['seen', 'build-desk › Terminal: Herdr chief', NOW - 15 * 60e3], 'its labels alone never make it live');
  assert.deepEqual([seen.role, seen.provider, seen.report.status, seen.report.msg], ['coordinator', null, 'working', 'Slicing the board']);
  const checks = { t7: { ok: true, at: NOW - 1000, launchId: 'chief-herdr', pid: 70 } };
  const checked = L.chiefAgent(herdr, bindings, [terminal], checks, NOW);
  assert.equal(checked.state, 'live');
  assert.equal(checked.binding.address, 't7', 'Open goes through the checked binding');
  assert.equal(L.chiefAgent(herdr, bindings, [terminal], { t7: { ...checks.t7, at: NOW - 10 * 60e3 } }, NOW).state, 'seen', 'an old check has expired');
  assert.equal(L.chiefAgent(live, bindings, [terminal], checks, NOW).state, 'unknown', 'no location and no session is unknown');
});
