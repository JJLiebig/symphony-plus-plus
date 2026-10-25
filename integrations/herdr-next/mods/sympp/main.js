// S++ Lens: the shared S++ board, natively in Herdr. Levels run Factory > Topic > Space > Job under a
// breadcrumb; Esc goes up one. A copy opened with props.job is that job's own tab. A panel copy follows
// Herdr's focus (a job's terminal or tab, else the space, else its topic) until it is pinned. A toast
// says when something newly needs the person. Intake and answers persist through S++; terminal jumps
// and "Live" both rest on a trusted execution helper's check, never on terminal labels or text. A
// topic with a registered chief shows that chief's desk. A copy opened with props.studio is one UI
// package's studio: its worker's terminal beside a preview, in a tab named after the package.
//
// Block props: { endpoint: "http://127.0.0.1:<port>", role?: "overview" | "panel", job?: "<work request id>",
//   studio?: { job: "<work request id>", pkg: "<work package id>" },
//   dashboardUrl?, repoTopics?: { "owner/repo" | "repo": "<desk topic id or name>" },
//   hosts?: { local: { node, helper, session? }, "machine": { node, helper, session? } } }
// Hosts may also be configured explicitly in shared("sympp.hosts"). A copy without an endpoint uses the
// connection the last connected copy shared ("sympp.connection"), so a scripted studio needs only its ids.
//
// Modules: model.js (board in, view data out), levels.js (Factory, Topic and Space placement, panel
// following and new needs), job.js (the Job level's pure logic), controls.js (persisted actions),
// transport.js (native HTTP), ui.js (shared look), overview.js and jobview.js (what each level
// draws), rails.js (package rails on a shared time axis), chrome.js (what the patched desk agents
// list shows on S++ agents), studio.js and studioview.js (a UI package's studio).

import { View } from "gpui-kit";
import { v_flex, InputState, TextareaState } from "gpui-base";
import * as fs from "fs/promises";
import { props, theme, shared, setShared, spaces, panes, terminals, focused, notify, run, window as appWindow, exec, appHome, watchFolder } from "herdr";
import * as M from "./model.js";
import * as L from "./levels.js";
import * as J from "./job.js";
import * as R from "./rails.js";
import * as C from "./controls.js";
import * as Chrome from "./chrome.js";
import * as S from "./studio.js";
import { request } from "./transport.js";
import { button, message } from "./ui.js";
import * as O from "./overview.js";
import { jobView } from "./jobview.js";
import { studioView } from "./studioview.js";

const TICK = 5000;
const REPAINT = 30000;
const DAY = 24 * 3600e3;
const KEYS = { j: "down", k: "up", down: "down", up: "up" };
const TOP = { topic: null, space: null, job: null };
const CONNECTION = "sympp.connection";
const SWEEP = 60e3;
// The studio's own pane shrinks to its header, under Herdr's pane header, while a native preview
// shows below it.
const STRIP = 88;

// Removes a preview copy: a flat mods/sympp-dev-* folder, never another mod.
async function removeCopy(name) {
  if (!name.startsWith(S.DEV_PREFIX)) return;
  const dir = `${appHome()}/mods/${name}`;
  for (const file of await fs.readdir(dir)) await fs.unlink(`${dir}/${file}`);
  await fs.rmdir(dir);
}

function storedPath() {
  try {
    const path = JSON.parse(localStorage.getItem("path") ?? "null");
    return path && typeof path === "object" ? { ...TOP, ...path } : TOP;
  } catch {
    return TOP;
  }
}

export default class Lens extends View {
  init(p, cx) {
    const own = p ?? props() ?? {};
    const stored = own.endpoint ? null : shared(CONNECTION);
    const given = stored && typeof stored === "object" ? { ...stored, ...own } : own;
    this.given = given;
    this.ownConnection = Boolean(own.endpoint);
    const studio = own.studio;
    this.studio = typeof studio?.job === "string" && typeof studio?.pkg === "string" ? { job: studio.job, pkg: studio.pkg } : null;
    this.worker = { state: "checking", at: 0 };
    this.native = { state: "idle", error: null, builtAt: null, dev: null, cwd: null };
    // Whether this package's preview copy is known gone; one may be left from before Herdr
    // restarted, so a studio ends it before building afresh.
    this.ended = !this.studio;
    this.sweptAt = 0;
    this.role = given.role === "panel" ? "panel" : "overview";
    this.pinned = typeof given.job === "string" && given.job ? given.job : null;
    this.endpoint = M.normalizeEndpoint(given.endpoint);
    this.dashboard = M.dashboardUrl(this.endpoint, given.dashboardUrl);
    this.repoTopics = given.repoTopics && typeof given.repoTopics === "object" ? given.repoTopics : null;
    this.hosts = given.hosts ?? null;
    this.request = request;
    this.net = M.initialFetch();
    this.detailNet = { jobId: null, ...M.initialFetch() };
    this.reading = false;
    this.detailReading = false;
    this.turn = 0;
    this.companion = false;
    this.pkgSel = null;
    this.review = null;
    this.shown = null;
    this.rowOrder = [];
    this.agentChecks = {};
    this.checking = false;
    this.checkedFor = null;
    this.checkedAt = 0;
    // Where this copy is: its own across restarts. A panel's pin stops it following focus.
    this.path = storedPath();
    this.pin = localStorage.getItem("pin") === "1";
    this.lastFocus = null;
    this.cursor = null;
    this.rows = [];
    this.expanded = new Set();
    this.awaiting = null;
    this.seenNeeds = null;
    this.painted = Date.now();
    this.keys = cx.focus_handle();
    this.intake = false;
    this.draft = { title: this.input("Title"), repo: this.input("owner/repository or repository path"), base_branch: this.input("Base branch"), human_description: this.input("What should this job accomplish?", true) };
    this.creation = { pending: false, error: null };
    this.answers = {};
    this.jumps = {};
    cx.timer.every(TICK, (cx) => this.tick(cx));
    this.tick(cx);
  }

  // Data timer: the board when due; while a job view shows, its details at the same cadence, and
  // agent checks for whichever level lists agents. Otherwise it repaints now and then so ages move.
  tick(cx) {
    if (!this.endpoint) return;
    const now = Date.now();
    // A copy that starts with the app (the S++ panel) ticks before Herdr has a window.
    const active = appWindow()?.active !== false;
    const cadence = M.nextDelay(this.net, active);
    let busy = false;
    if (!this.reading && M.fetchDue(this.net, now, active)) { this.read(cx); busy = true; }
    const shown = this.shown;
    if (shown && !this.detailReading && J.detailDue(this.detailNet, shown.jobId, cadence, now)) { this.readDetail(shown.jobId, cx); busy = true; }
    const watch = this.agentWatch;
    if (watch && !this.checking && (this.checkedFor !== watch.key || now - this.checkedAt >= cadence)) this.checkAgents(watch, cx);
    if (now - this.sweptAt >= SWEEP) this.sweep(cx);
    if (this.studio) this.studioTick(cx, now);
    if (!busy && now - this.painted >= REPAINT) {
      this.painted = now;
      cx.notify();
    }
  }

  // One read at a time; a reply from an older read never replaces a newer one.
  read(cx) {
    if (this.reading || !this.endpoint) return;
    this.reading = true;
    const turn = ++this.turn;
    this.net = M.fetchStarted(this.net, Date.now());
    cx.spawn(async (cx) => {
      let outcome;
      try {
        const response = await this.request(M.boardUrl(this.endpoint));
        if (!response.ok) outcome = { error: M.httpError(response.status) };
        else {
          const payload = await response.json().catch(() => null);
          try {
            outcome = { board: M.parseBoard(payload) };
          } catch (caught) {
            outcome = { error: caught.message };
          }
        }
      } catch (caught) {
        outcome = { error: caught.userMessage || M.networkError(this.endpoint, caught) };
      }
      this.reading = false;
      if (turn !== this.turn) return;
      const now = Date.now();
      this.net = outcome.board ? M.fetchSucceeded(this.net, outcome.board, now) : M.fetchFailed(this.net, outcome.error, now);
      if (outcome.board) {
        if (this.ownConnection) this.shareConnection();
        this.announce(outcome.board);
        const agents = Chrome.nextDecorations(shared(Chrome.AGENTS), Chrome.decorations(outcome.board, terminals(), this.endpoint, now), this.endpoint, now);
        if (agents) setShared(Chrome.AGENTS, agents);
      }
      this.painted = now;
      if (this.refreshAfterRead) {
        this.refreshAfterRead = false;
        this.read(cx);
      }
      try {
        cx.notify();
      } catch {
        // The view closed or reloaded while reading; nothing is left to draw.
      }
    });
  }

  // Lets a copy opened without connection props (a scripted studio) reach the same S++.
  shareConnection() {
    const { role: _role, job: _job, studio: _studio, ...connection } = this.given;
    if (JSON.stringify(shared(CONNECTION)) !== JSON.stringify(connection)) setShared(CONNECTION, connection);
  }

  // Removes preview copies no open studio uses, e.g. after a studio tab closed: only one unused on
  // two sweeps in a row and still unused just before it goes, so a studio starting one keeps it.
  sweep(cx) {
    this.sweptAt = Date.now();
    const before = this.strays ?? new Set();
    cx.spawn(async () => {
      try {
        const unused = () => new Set(S.strayCopies(names, shared(S.STUDIOS), this.openTabs(), panes()));
        const names = await fs.readdir(`${appHome()}/mods`);
        this.strays = unused();
        for (const name of this.strays) if (before.has(name) && unused().has(name)) await removeCopy(name);
      } catch { /* the next sweep tries again */ }
    });
  }

  openTabs() {
    return this.spaceList().flatMap((s) => (s.tabs ?? []).map((tab) => tab.id));
  }

  // A toast only for a need that appeared between two successful reads of this copy. Copies share
  // what was announced, so each need is announced once however many S++ views are open.
  announce(board) {
    const { seen, fresh } = L.newNeeds(this.seenNeeds, board);
    this.seenNeeds = seen;
    if (!fresh.length) return;
    const now = Date.now();
    const before = shared("sympp.toasted");
    const told = Object.fromEntries(Object.entries(before && typeof before === "object" ? before : {}).filter(([, at]) => now - at < DAY));
    let posted = false;
    for (const need of fresh) {
      const id = L.toastId(need);
      if (told[id]) continue;
      told[id] = now;
      posted = true;
      notify({ title: need.label, body: `${need.text} · ${need.job.title}`, level: "warning", action: this.jobAction(need.job) });
    }
    if (posted) setShared("sympp.toasted", told);
  }

  // The job's open tab when there is one, else a new one.
  jobAction(job) {
    const tabs = shared("sympp.jobTabs");
    const open = new Set(this.spaceList().flatMap((s) => (s.tabs ?? []).map((tab) => tab.id)));
    const tab = Object.entries(tabs && typeof tabs === "object" ? tabs : {}).find(([id, jobId]) => jobId === job.id && open.has(id))?.[0];
    return tab ? { name: "tab.select", args: { id: tab } } : { name: "tab.new", args: J.jobTabArgs(this.given, job, this.spaceList()) };
  }

  // The shown job's recorded decisions; the last good list survives a failed read.
  readDetail(jobId, cx) {
    this.detailReading = true;
    const base = this.detailNet.jobId === jobId ? this.detailNet : { jobId, ...M.initialFetch() };
    this.detailNet = { ...M.fetchStarted(base, Date.now()), jobId };
    cx.spawn(async (cx) => {
      let outcome;
      try {
        const response = await this.request(`${this.endpoint}${J.detailPath(jobId)}`);
        if (!response.ok) outcome = { error: response.status === 404 ? "This job's details aren't on this S++." : M.httpError(response.status) };
        else {
          const payload = await response.json().catch(() => null);
          try { outcome = { decisions: J.decisionsOf(payload) }; } catch (caught) { outcome = { error: caught.message }; }
        }
      } catch (caught) {
        outcome = { error: caught.userMessage || M.networkError(this.endpoint, caught) };
      }
      this.detailReading = false;
      if (this.detailNet.jobId !== jobId) return;
      const now = Date.now();
      this.detailNet = { ...(outcome.decisions ? M.fetchSucceeded(this.detailNet, outcome.decisions, now) : M.fetchFailed(this.detailNet, outcome.error, now)), jobId };
      try { cx.notify(); } catch { /* closed while reading */ }
    });
  }

  // "Live" means the trusted helper confirmed this exact launch and process just now.
  checkAgents({ key, bindings }, cx) {
    this.checkedFor = key;
    this.checkedAt = Date.now();
    const due = bindings.filter((b) => b.available);
    if (!due.length) return;
    this.checking = true;
    cx.spawn(async (cx) => {
      for (const b of due) {
        let ok = false;
        try { ok = M.checkedBinding(b, await exec(b.host.node, M.bindingCheckArgs(b), { on: b.machine }), terminals()); } catch { ok = false; }
        this.agentChecks[b.address] = { ok, at: Date.now(), launchId: b.launchId, pid: b.pid };
      }
      this.checking = false;
      try { cx.notify(); } catch { /* closed while checking */ }
    });
  }

  retry(cx) {
    if (this.studio) {
      this.worker = { ...this.worker, at: 0 };
      this.buildPreview(cx);
    }
    this.net = { ...this.net, attemptAt: null };
    this.detailNet = { ...this.detailNet, attemptAt: null };
    this.checkedFor = null;
    if (this.reading) this.refreshAfterRead = true;
    else this.read(cx);
    cx.notify();
  }

  openDashboard(cx) {
    if (this.dashboard) cx.open_url(this.dashboard);
  }

  // ---------- Levels ----------

  // Moving to a level. Following focus never takes the keyboard; the person's own moves do.
  go(path, cx, { pkg = null, follow = false } = {}) {
    this.path = { topic: path.topic ?? null, space: path.space ?? null, job: path.job ?? null };
    this.cursor = null;
    this.pkgSel = pkg;
    this.review = null;
    try { localStorage.setItem("path", JSON.stringify(this.path)); } catch { /* storage is a convenience */ }
    if (follow) return;
    this.keys.focus();
    cx.notify();
  }

  goUp(cx) {
    this.go(L.up(this.path), cx);
  }

  openTopic(id, cx) {
    this.go({ topic: id }, cx);
  }

  openSpace(spaceId, topicId, cx) {
    this.go({ topic: topicId, space: spaceId }, cx);
  }

  // A job opened from a topic or space stays under it; from the factory it sits under its home topic.
  openJob(job, { pkg = null } = {}, cx) {
    const under = this.level === "topic" || this.level === "space" ? { topic: this.path.topic, space: this.path.space } : { topic: this.place?.home(job) ?? null };
    this.go({ ...under, job: job.id }, cx, { pkg });
  }

  togglePin(cx) {
    this.pin = !this.pin;
    try { localStorage.setItem("pin", this.pin ? "1" : "0"); } catch { /* storage is a convenience */ }
    this.lastFocus = null;
    cx.notify();
  }

  toggleExpanded(key, cx) {
    if (this.expanded.has(key)) this.expanded.delete(key);
    else this.expanded.add(key);
    cx.notify();
  }

  // Rows register in reading order as they draw, so keys reach every row a pointer can.
  row(key, open) {
    this.rows.push({ key, open });
    return this.cursor === key && this.keys.is_focused();
  }

  // The panel follows Herdr's focus when it changes; the person's own moves stand until it does.
  follow(board, desk, cx) {
    const f = focused();
    const tabs = shared("sympp.jobTabs");
    const seen = f ? [f.space, f.tab, f.pane, f.terminal, f.shown, tabs?.[f.tab]].join("|") : "";
    if (seen === this.lastFocus) return;
    this.lastFocus = seen;
    const next = L.followPath(L.focusTarget(f, terminals(), tabs, panes()), board.jobs, desk, this.place);
    if (next && JSON.stringify(next) !== JSON.stringify(this.path)) this.go(next, cx, { follow: true });
  }

  // Herdr draws a mod pane only while its tab is the shown one, so a drawing job tab is the focused
  // tab. It records itself so a panel and toasts can find the job's tab.
  registerTab(cx) {
    const f = focused();
    if (!f?.tab || this.registered === f.tab || !panes().some((p) => p.tab === f.tab && !p.terminal)) return;
    this.registered = f.tab;
    const before = shared("sympp.jobTabs");
    const current = before && typeof before === "object" ? before : {};
    if (current[f.tab] === this.pinned) return;
    const open = new Set(this.spaceList().flatMap((s) => (s.tabs ?? []).map((tab) => tab.id)));
    const next = Object.fromEntries(Object.entries(current).filter(([id]) => open.has(id)));
    next[f.tab] = this.pinned;
    cx.spawn(async () => setShared("sympp.jobTabs", next));
  }

  // Herdr's own topics and spaces; the drawn-structure tests substitute fixtures here.
  deskTopics() {
    return shared("desk.topics");
  }

  spaceList() {
    return spaces();
  }

  // The agents a Topic or Space level lists, and the bindings the timer then checks, with any chiefs'.
  agentsFor(jobs, all, bindings, spaceIds, now, chiefs = []) {
    const rows = L.agentRows(jobs, all, bindings, terminals(), spaceIds, this.agentChecks, now);
    this.watch(`${this.level}:${spaceIds.join(",")}:${jobs.map((j) => j.id).join(",")}`,
      [...rows.flatMap((r) => M.bindingsFor(bindings, r.job.id, r.pkgId ?? null)), ...chiefs.flatMap((c) => c.agent.bindings)]);
    return rows;
  }

  watch(key, list) {
    this.agentWatch = { key, bindings: list.filter((b, i) => list.findIndex((o) => o.address === b.address) === i) };
  }

  // The chiefs matching a topic, each as an agent.
  chiefsOf(topic, board, desk, bindings, now) {
    return L.chiefsFor(topic, board.chiefs, desk, this.repoTopics)
      .map((chief) => ({ chief, agent: L.chiefAgent(chief, bindings, terminals(), this.agentChecks, now) }));
  }

  // An open review drill-down follows the selected package.
  selectPackage(id, cx) {
    this.pkgSel = id;
    if (this.review) this.review = { jobId: this.review.jobId, pkgId: id, round: null };
    this.keys.focus();
    cx.notify();
  }

  // A package's review drill-down, opened at a round. The rails stay drawn and scrolled as they were.
  openReview(jobId, pkgId, round, cx) {
    this.review = { jobId, pkgId, round };
    this.pkgSel = pkgId;
    this.keys.focus();
    cx.notify();
  }

  closeReview(cx) {
    this.review = null;
    this.keys.focus();
    cx.notify();
  }

  // The job's local space when one matches its repository, else the shown one.
  openInTab(job, _cx) {
    run("tab.new", J.jobTabArgs(this.given, job, spaces()));
  }

  // A UI package's studio: its open tab, else a new one in the job's local space.
  openStudio(job, pkg, _cx) {
    const tab = S.studioTabFor(shared(S.STUDIOS), this.openTabs(), pkg.id);
    if (tab) run("tab.select", { id: tab });
    else run("tab.new", S.studioTabArgs(this.given, job, pkg, this.spaceList()));
  }

  // ---------- Studio ----------

  // The studio's tab and pane once it is the package's one studio in the job's space; until then
  // null. A second studio for the package, or one opened elsewhere, hands over and closes, but only
  // while its tab holds no terminal.
  studioHere(job, pkg, cx) {
    if (this.here) return this.here;
    const f = focused();
    const paneList = panes();
    const own = f?.tab ? paneList.find((p) => p.tab === f.tab && p.mod === "sympp" && !p.terminal) : null;
    if (!own || this.handingOver) return null;
    const tab = f.tab;
    const spaceList = this.spaceList();
    const other = S.studioTabFor(shared(S.STUDIOS), this.openTabs(), pkg.id, tab);
    const mine = spaceList.find((s) => (s.tabs ?? []).some((x) => x.id === tab));
    const target = J.jobSpace(job, spaceList);
    if (!paneList.some((p) => p.tab === tab && p.terminal) && (other || (target && mine && target.id !== mine.id))) {
      this.handingOver = true;
      cx.spawn(async () => {
        if (other) run("tab.select", { id: other });
        else run("tab.new", S.studioTabArgs(this.given, job, pkg, spaceList));
        run("tab.close", { id: tab });
      });
      return null;
    }
    this.here = { tab, pane: own.pane };
    this.registerStudio(cx);
    if (mine?.tabs.find((x) => x.id === tab)?.named === false) cx.spawn(async () => run("tab.rename", { id: tab, name: S.tabName(pkg.title) }));
    return this.here;
  }

  // Records this studio and its preview copy, and marks its tab for the desk tab bar.
  registerStudio(cx) {
    const tab = this.here.tab;
    const open = this.openTabs();
    const studios = { ...S.openStudios(shared(S.STUDIOS), open), [tab]: { ...this.studio, dev: this.native.dev } };
    const before = shared(S.TAB_MARKS);
    const marks = (Array.isArray(before) ? before : []).filter((m) => m?.tab !== tab && open.includes(m?.tab));
    cx.spawn(async () => {
      setShared(S.STUDIOS, studios);
      setShared(S.TAB_MARKS, [...marks, { tab, ...S.MARK }]);
    });
  }

  // Checks the worker when first seen, again within the live window, and sooner while it isn't live.
  studioTick(cx, now) {
    const watch = this.studioWatch;
    if (!watch || this.workerChecking) return;
    if (!watch.workers.length) {
      if (this.worker.state !== "none") { this.worker = { state: "none", at: now }; cx.notify(); }
      return;
    }
    // A verified worker whose exact binding is gone (a replacement launch) is checked again now.
    const b = this.worker.binding;
    if (this.worker.state === "live" && !watch.workers.some((w) => w.address === b.address && w.launchId === b.launchId && w.pid === b.pid)) {
      this.worker = { state: "checking", at: 0 };
    }
    if (this.worker.at && now - this.worker.at < (this.worker.state === "live" ? J.LIVE_FOR : M.POLL.live)) return;
    this.checkWorker(watch.workers, cx);
  }

  // The worker is the package's first binding the trusted helper verifies; its receipt names its worktree.
  checkWorker(workers, cx) {
    this.workerChecking = true;
    cx.spawn(async (cx) => {
      let found = null;
      for (const b of workers) {
        try {
          const result = await exec(b.host.node, M.bindingCheckArgs(b), { on: b.machine });
          if (M.checkedBinding(b, result, terminals())) { found = { binding: b, receipt: JSON.parse(result.stdout) }; break; }
        } catch { /* try the next binding */ }
      }
      this.workerChecking = false;
      if (!found || found.binding.address !== this.worker.binding?.address) this.swapped = false;
      this.keeping = false;
      this.worker = found ? { state: "live", ...found, at: Date.now() } : { state: "gone", at: Date.now() };
      try { cx.notify(); } catch { /* closed while checking */ }
    });
  }

  // Puts the verified worker beside the studio: a pane on the right, then swapped to the left once.
  arrange(place, binding, cx) {
    const pane = this.here.pane;
    if (place.step === "keep" && !this.keeping) {
      this.keeping = true;
      cx.spawn(async () => {
        run("pane.focus", { pane });
        run("terminal.keep", { terminal: binding.address, place: "right" });
      });
    } else if (place.step === "swap") {
      this.swapped = true;
      // After the new pane has been drawn once, so Herdr knows where it is.
      cx.timer.after(250, () => {
        run("pane.focus", { pane });
        run("pane.swap", { direction: "right" });
        run("pane.focus", { pane: place.pane });
      });
    }
  }

  moveWorker(cx) {
    const address = this.worker.binding?.address;
    if (!address) return;
    this.keeping = false;
    cx.spawn(async () => run("terminal.park", { terminal: address }));
  }

  goToWorker(_cx) {
    const pane = panes().find((p) => p.terminal === this.worker.binding?.address);
    if (pane) run("pane.focus", { pane: pane.pane });
  }

  openPreview(url, cx) {
    if (url) cx.open_url(url);
  }

  // The local worktree the verified worker previews from, or null: a remote worker, or no folder.
  previewSource() {
    const { binding, receipt } = this.worker;
    return typeof receipt?.cwd === "string" && receipt.cwd && !binding.machine ? receipt.cwd : null;
  }

  // A local worker's S++ worktree: its Herdr view built on sample data as this package's preview
  // copy, and rebuilt on every save that touches it.
  startPreview(cwd, job, cx) {
    const generation = (this.previewRun ?? 0) + 1;
    this.previewRun = generation;
    if (!cwd) {
      this.native = { state: "none", error: null, builtAt: null, dev: null, cwd: null };
      this.registerStudio(cx);
      return;
    }
    this.ended = false;
    this.native = { state: "building", error: null, builtAt: null, dev: S.devName(this.studio.pkg), cwd, node: this.worker.binding.host.node, base: `origin/${job.baseBranch || "main"}` };
    this.registerStudio(cx);
    this.buildPreview(cx);
    this.watchPreview(generation, cx);
  }

  buildPreview(cx) {
    const n = this.native;
    const generation = this.previewRun;
    if (!n.dev || n.state === "none" || this.landed || this.ending) return;
    if (this.building) { this.rebuild = true; return; }
    this.building = true;
    cx.spawn(async (cx) => {
      let outcome;
      try {
        outcome = S.buildOutcome(await exec(n.node, [S.builderPath(n.cwd), "--to", `${appHome()}/mods/${n.dev}`, "--base", n.base], { cwd: n.cwd }));
      } catch {
        outcome = { state: "error", error: "Node couldn't run the preview build." };
      }
      this.building = false;
      // Ended meanwhile: the copy waits for this build before it goes.
      if (generation !== this.previewRun) {
        try { cx.notify(); } catch { /* closed while building */ }
        return;
      }
      const built = outcome.state === "ready" ? Date.now() : this.native.builtAt;
      const state = outcome.state === "unchanged" && built ? "ready" : outcome.state;
      this.native = { ...this.native, state, error: outcome.error ?? null, builtAt: built };
      if (this.rebuild) { this.rebuild = false; this.buildPreview(cx); }
      try { cx.notify(); } catch { /* closed while building */ }
    });
  }

  watchPreview(generation, cx) {
    const folder = S.builderPath(this.native.cwd).replace(/\/preview\.mjs$/, "");
    cx.spawn(async (cx) => {
      for (;;) {
        let changed;
        try { changed = await watchFolder(folder); } catch { return; }
        if (generation !== this.previewRun || this.native.state === "none" || this.landed) return;
        if (changed.some(S.previewInput)) this.buildPreview(cx);
      }
    });
  }

  // The studio's own pane is a header-high strip while a preview pane shows below it. When that
  // pane goes, Herdr gives the studio's pane the column's place and size back.
  fitStrip(shown, cx) {
    if (shown === Boolean(this.stripped)) return;
    this.stripped = shown;
    const pane = this.here.pane;
    if (shown) cx.spawn(async () => run("layout.resize", { id: pane, px: STRIP }));
  }

  // The preview copy's pane below the studio's, opened once it first builds; Show preview reopens it.
  previewPane(devPane, cx) {
    const pane = this.here.pane;
    if (devPane || this.devOpened || this.native.state !== "ready") return;
    this.devOpened = true;
    const { dev } = this.native;
    const generation = this.previewRun;
    // Herdr finds a new mod folder through its file watcher, a moment after the first build. By
    // then the preview may have ended.
    cx.timer.after(800, () => {
      if (generation === this.previewRun && !this.ending && !this.landed && this.native.state === "ready") run("pane.split", { pane, direction: "down", mod: dev, props: {} });
    });
  }

  showPreview(cx) {
    this.devOpened = false;
    if (this.native.state !== "ready") this.buildPreview(cx);
    cx.notify();
  }

  // Ends this package's preview copy before another worktree's starts, once the package lands or
  // when the worktree has none to build, also a copy left from before Herdr restarted: its pane
  // closes, a running build finishes, then the copy goes. True once neither is left.
  endPreview(devPane, cx) {
    if (devPane) {
      if (!this.closingDev) { this.closingDev = true; cx.spawn(async () => run("pane.close", { pane: devPane.pane })); }
      return false;
    }
    if (this.ended) return true;
    if (this.building || this.ending) return false;
    this.ending = true;
    this.rebuild = false;
    this.previewRun = (this.previewRun ?? 0) + 1;
    cx.spawn(async (cx) => {
      try { await removeCopy(S.devName(this.studio.pkg)); } catch { /* none was made, or a sweep removes it */ }
      this.ending = false;
      this.ended = true;
      this.closingDev = false;
      this.devOpened = false;
      this.native = { ...this.native, dev: null };
      this.registerStudio(cx);
      try { cx.notify(); } catch { /* closed meanwhile */ }
    });
    return false;
  }

  studioLevel(t, board, bindings, now, cx) {
    const job = board.jobs.find((j) => j.id === this.studio.job);
    const pkg = job?.packages.find((p) => p.id === this.studio.pkg);
    if (!pkg) {
      return this.root(t, [O.staleBar(this, t, now), message(t, "This package isn't here", "It isn't on this S++ board. It may have been archived, or this studio belongs to another factory.", [
        button(t, "retry-missing", this.reading ? "Reading…" : "Refresh", (cx) => this.retry(cx), { strong: true }),
      ])]);
    }
    if (!this.studioHere(job, pkg, cx)) return this.root(t, [message(t, "Opening the studio…", null)]);
    this.studioWatch = { workers: S.workerBindings(M.bindingsFor(bindings, job.id, pkg.id)).filter((b) => b.available) };
    this.studioTick(cx, now);
    this.landed = pkg.stage === "done";
    const w = this.worker;
    const live = w.state === "live";
    const paneList = panes();
    const place = live ? S.placement(paneList, this.here.tab, this.here.pane, w.binding.address, this.swapped) : null;
    const dev = S.devName(this.studio.pkg);
    const devPane = paneList.find((p) => p.tab === this.here.tab && p.mod === dev) ?? null;
    if (this.landed) this.endPreview(devPane, cx);
    else if (live) {
      this.arrange(place, w.binding, cx);
      const cwd = this.previewSource();
      const restart = this.native.state === "idle" || this.native.cwd !== cwd;
      if ((restart || this.native.state === "none") && this.endPreview(devPane, cx) && restart) this.startPreview(cwd, job, cx);
    }
    const url = live ? S.previewUrlOf(terminals().find((k) => k.address === w.binding.address)) : null;
    const kind = this.landed ? "none" : S.previewKind({ url, native: this.native.state });
    this.studioUrl = kind === "web" ? url : null;
    // Not while it closes: the resize would land on the studio pane once it has the column's place.
    this.fitStrip(Boolean(devPane) && !this.closingDev, cx);
    if (kind === "native") this.previewPane(devPane, cx);
    return this.root(t, [O.staleBar(this, t, now), studioView(this, t, {
      pkg, worker: { state: w.state, provider: w.binding?.provider ?? null }, place, kind, url,
      native: this.native, landed: this.landed, strip: Boolean(devPane) && !this.closingDev,
    })]);
  }

  input(placeholder, multiline = false) {
    const state = multiline ? TextareaState.new({ placeholder, rows: 4 }) : InputState.new({ placeholder });
    state.on("change", (_e, cx) => cx.notify());
    return state;
  }

  openIntake(cx) {
    if (!this.draft.repo.value()) {
      const here = this.path.space ? L.spaceById(L.deskOf(this.deskTopics(), this.spaceList()), this.path.space)?.space : null;
      const active = this.spaceList().find((s) => s.active);
      this.draft.repo.set_value((here ?? active)?.folder ?? "");
    }
    this.intake = true;
    this.draft.title.focus();
    cx.notify();
  }

  createRequest(cx) {
    cx.spawn(async (cx) => {
      const submission = C.submitAction(this.creation, async () => {
        const fields = Object.fromEntries(Object.entries(this.draft).map(([key, input]) => [key, input.value()]));
        const payload = await C.postAction(this.endpoint, "/api/v1/sympp/herdr/work-requests", C.requestBody(fields), this.request);
        const id = payload.work_request?.work_request?.id;
        if (!id) throw new Error("The job was submitted but its ID is missing. Refresh before submitting again.");
        return id;
      }, (id) => {
        for (const input of Object.values(this.draft)) input.set_value("");
        this.intake = false;
        this.awaiting = id;
        this.go({ topic: this.path.topic, space: this.path.space, job: id }, cx);
        this.retry(cx);
      });
      cx.notify();
      await submission;
      cx.notify();
    });
  }

  openAnswer(question, cx) {
    if (!this.answers[question.key]) this.answers[question.key] = { input: this.input(question.prompt ? "Optional note" : "Your answer", true), choice: null, pending: false, error: null };
    this.answers[question.key].open = true;
    if (!question.prompt) this.answers[question.key].input.focus();
    cx.notify();
  }

  saveAnswer(question, cx) {
    const draft = this.answers[question.key];
    cx.spawn(async (cx) => {
      const submission = C.submitAction(draft,
        async () => C.postAction(this.endpoint, C.answerPath(question), C.answerBody(question, draft.choice, draft.input.value()), this.request),
        () => { draft.open = false; draft.saved = true; draft.input.set_value(""); this.retry(cx); });
      cx.notify();
      await submission;
      cx.notify();
    });
  }

  focusAgent(binding, cx) {
    if (!binding?.available || this.jumps[binding.address]?.pending) return;
    const action = this.jumps[binding.address] = { pending: false, error: null };
    cx.spawn(async (cx) => {
      const submission = C.submitAction(action, async () => {
        await C.requireAgentAccess(this.endpoint, this.request);
        let result;
        try { result = await exec(binding.host.node, M.bindingCheckArgs(binding), { on: binding.machine }); }
        catch { throw new Error("Agent helper unavailable. Check the execution host."); }
        if (!M.checkedBinding(binding, result, terminals())) throw new Error("Agent unavailable. Refresh and try again.");
        return M.agentDestination(binding, panes(), spaces());
      }, destination => {
        if (destination.pane) run("pane.focus", { pane: destination.pane });
        else {
          this.companion = destination.alongside;
          run("space.select", { id: destination.space });
          run("terminal.keep", { terminal: binding.address, place: destination.alongside ? "right" : "tab" });
        }
      });
      cx.notify();
      await submission;
      cx.notify();
    });
  }

  // Enter on a package opens its review when it has review rounds, else its worker once a check
  // says it is live.
  openPackage(cx) {
    const pkg = this.currentJob?.packages.find((p) => p.id === this.pkgSel);
    if (pkg && R.roundsOf(pkg).length) {
      this.openReview(this.currentJob.id, pkg.id, null, cx);
      return true;
    }
    return this.openPackageAgent(cx);
  }

  openPackageAgent(cx) {
    const job = this.currentJob;
    if (!job || !this.pkgSel || !this.shown) return false;
    const worker = J.participants(job, this.shown.bindings, this.agentChecks, Date.now()).find((p) => p.pkgId === this.pkgSel);
    if (worker?.state !== "live" || this.net.data?.offline !== false) return false;
    this.focusAgent(worker.binding, cx);
    return true;
  }

  onKey(e, cx) {
    if (!this.keys.is_focused()) return;
    const key = e.key;
    if (this.studio) {
      if (key === "r") this.retry(cx);
      else if ((key === "o" || key === "enter") && this.studioUrl) this.openPreview(this.studioUrl, cx);
      else return;
      cx.stop_propagation();
      cx.notify();
      return;
    }
    const nav = KEYS[key];
    // On the Job level keys move packages and Esc clears the package first; above it they move
    // through the level's rows. Esc then goes up a level, except in a job's own tab.
    const inJob = this.level === "job";
    const packages = inJob && Boolean(this.currentJob);
    if (key === "escape" && this.intake) {
      if (this.creation.pending) return;
      this.intake = false;
    } else if (this.intake) return;
    else if (packages && nav) this.selectPackage(R.moveRow(this.rowOrder, this.pkgSel, nav === "down" ? 1 : -1) ?? this.pkgSel, cx);
    else if (inJob && nav) return;
    else if (nav) this.cursor = R.moveRow(this.rows.map((r) => r.key), this.cursor, nav === "down" ? 1 : -1) ?? this.cursor;
    else if (key === "enter" && inJob) { if (!packages || !this.openPackage(cx)) return; }
    else if (key === "enter") {
      const row = this.rows.find((r) => r.key === this.cursor);
      if (!row) return;
      row.open(cx);
    }
    else if (key === "escape" && this.review) this.review = null;
    else if (key === "escape" && inJob && this.pkgSel) this.pkgSel = null;
    else if (key === "escape" && !this.pinned && this.level !== "factory") this.goUp(cx);
    else if (key === "t" && this.currentJob && !this.pinned) this.openInTab(this.currentJob, cx);
    else if (key === "u" && packages && this.studioPackage()) this.openStudio(this.currentJob, this.studioPackage(), cx);
    else if (key === "p" && this.role === "panel" && !this.pinned) this.togglePin(cx);
    else if (key === "r") this.retry(cx);
    else if (key === "o") this.openDashboard(cx);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  // The selected package when the job view offers it a studio.
  studioPackage() {
    const job = this.currentJob;
    const pkg = job?.packages.find((p) => p.id === this.pkgSel);
    return pkg && this.shown && S.uiPackage(job, pkg, this.shown.bindings, terminals()) ? pkg : null;
  }

  root(t, children) {
    return v_flex().id(`lens-${this.studio ? "studio" : this.pinned ? "job" : this.role}`).size_full().min_h(0).bg(this.role === "panel" ? t.chrome : t.canvas).text_color(t.foreground).text_size(13)
      .track_focus(this.keys)
      .on_mouse_down("left", (_e, cx) => { this.keys.focus(); cx.notify(); })
      .on_key_down((e, cx) => this.onKey(e, cx))
      .children(children.filter(Boolean));
  }

  viewportWidth() {
    return window.viewport_size().width;
  }

  // The Job level for one job; it also records what the timer reads and the keys move through.
  jobLevel(t, board, job, bindings, place, now) {
    this.rowOrder = R.railOrder(job).map((pkg) => pkg.id);
    if (this.pkgSel && !this.rowOrder.includes(this.pkgSel)) this.pkgSel = null;
    const review = this.review?.jobId === job.id ? job.packages.find((pkg) => pkg.id === this.review.pkgId) ?? null : null;
    if (!review) this.review = null;
    this.shown = { jobId: job.id, bindings: J.jobBindings(job, bindings) };
    this.agentWatch = { key: job.id, bindings: this.shown.bindings };
    this.currentJob = job;
    const layout = place !== "side" && !this.compact ? "wide" : "compact";
    return jobView(this, t, job, { now, bindings, terminals: terminals(), layout, place, offline: board.offline === true, review });
  }

  render(cx) {
    this.compact = this.role === "panel" || this.companion || this.viewportWidth() < 1000;
    const t = theme();
    const now = Date.now();
    this.shown = null;
    this.agentWatch = null;
    this.currentJob = null;
    this.rows = [];
    this.level = this.pinned ? "job" : "factory";
    if (!this.endpoint) {
      return this.root(t, [message(t, "S++ isn't connected", "Give this block an endpoint prop with the local S++ address, for example http://127.0.0.1:4000.")]);
    }
    const board = this.net.data;
    if (!board) {
      if (!this.net.error) return this.root(t, [message(t, "Reading S++…", null)]);
      return this.root(t, [message(t, "Couldn't read S++", this.net.error, [
        button(t, "retry-first", this.reading ? "Reading…" : "Retry", (cx) => this.retry(cx), { strong: true }),
        ...(this.dashboard ? [button(t, "dashboard-first", "Open dashboard", (cx) => this.openDashboard(cx))] : []),
      ])]);
    }
    const bindings = M.discoverBindings(this.hosts ?? shared("sympp.hosts"), terminals()).map((binding) => board.offline === false
      ? binding : { ...binding, available: false, unavailable: board.offline ? "Offline copy" : "Update S++ for agent access" });

    if (this.studio) return this.studioLevel(t, board, bindings, now, cx);

    if (this.pinned) {
      this.registerTab(cx);
      const job = board.jobs.find((j) => j.id === this.pinned);
      if (!job) {
        return this.root(t, [O.staleBar(this, t, now), message(t, "This job isn't here", "It isn't on this S++ board. It may have been archived, or this tab belongs to another factory.", [
          button(t, "retry-missing", this.reading ? "Reading…" : "Refresh", (cx) => this.retry(cx), { strong: true }),
          ...(this.dashboard ? [button(t, "dashboard-missing", "Open dashboard", (cx) => this.openDashboard(cx))] : []),
        ])]);
      }
      return this.root(t, [O.staleBar(this, t, now), this.jobLevel(t, board, job, bindings, "tab", now)]);
    }

    const desk = L.deskOf(this.deskTopics(), this.spaceList());
    this.place = L.placeJobs(board.jobs, desk, this.repoTopics);
    if (this.role === "panel" && !this.pin) this.follow(board, desk, cx);
    if (this.awaiting && board.jobs.some((job) => job.id === this.awaiting)) this.awaiting = null;
    const path = this.path = L.resolvePath(this.path, desk, board.jobs, this.awaiting);
    this.level = L.levelOf(path);
    const trail = L.crumbs(path, desk, board.jobs);
    const needs = M.verdictCounts(board.jobs).needs;
    const names = new Map(desk.map((topic) => [topic.id, topic.name]));

    if (this.level === "job") {
      const job = board.jobs.find((j) => j.id === path.job);
      return this.root(t, [O.levelBar(this, t, trail, { now, needs, slim: true }), O.staleBar(this, t, now),
        job ? this.jobLevel(t, board, job, bindings, "full", now) : message(t, "Reading new job…", null)]);
    }
    const top = [O.levelBar(this, t, trail, { now, needs }), O.staleBar(this, t, now)];
    if (this.intake) return this.root(t, [...top, O.intakeForm(this, t)]);
    if (this.level === "factory") {
      const rows = L.factoryRows(board.jobs, desk, this.place).map((row) => ({ ...row, chiefs: this.chiefsOf(row, board, desk, bindings, now) }));
      this.watch("factory", rows.flatMap((row) => row.chiefs.flatMap((c) => c.agent.bindings)));
      return this.root(t, [...top, O.factoryLevel(this, t, board.jobs, rows, now)]);
    }
    if (this.level === "topic") {
      const topic = desk.find((x) => x.id === path.topic);
      const groups = L.topicWork(topic, board.jobs, this.place);
      const desks = this.chiefsOf(topic, board, desk, bindings, now).map((c) => ({ ...c, desk: L.chiefDesk(c.chief, board.jobs, now) }));
      const agents = this.agentsFor(groups.flatMap((g) => g.jobs), board.jobs, bindings, topic.spaces.map((s) => s.id), now, desks);
      return this.root(t, [...top, O.topicLevel(this, t, topic, groups, agents, desks, names, now)]);
    }
    const found = L.spaceById(desk, path.space);
    const work = L.spaceWork(found.space, board.jobs);
    const agents = this.agentsFor(work.jobs, board.jobs, bindings, [found.space.id], now);
    return this.root(t, [...top, O.spaceLevel(this, t, found, work, agents, now)]);
  }
}
