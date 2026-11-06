// sympp Lens: the shared sympp board, natively in Herdr. Levels run Factory > Topic > Space > Job; Esc
// goes up one. Topic and Space show the same tasks, a space only those on its repository; a task shows
// its packages at work. A copy opened with props.job is that job's own tab. A panel copy follows
// Herdr's focus (a job's terminal or tab, else the space, else its topic) until it is pinned. A toast
// says when something newly needs the person. Intake and answers persist through sympp; terminal jumps
// and "Live" both rest on a trusted execution helper's check, never on terminal labels or text. A
// copy opened with props.studio is one UI
// package's studio: its worker's terminal beside a preview, in a tab named after the package. A copy
// opened with props.role "chief" is the Start chief dialog for props.topic; "chief-menu" is the topic
// mark's right-click menu.
//
// Block props: { endpoint: "http://127.0.0.1:<port>", role?: "overview" | "panel" | "chief" | "chief-menu", job?: "<work request id>",
//   studio?: { job: "<work request id>", pkg: "<work package id>" },
//   dashboardUrl?, repoTopics?: { "owner/repo" | "repo": "<desk topic id or name>" },
//   hosts?: { local: { node, helper, session?, runtime? }, "machine": { node, helper, session? } } }
// With local.runtime (the factory's runtime record) a view starts that sympp when it doesn't answer.
// Hosts may also be configured explicitly in shared("sympp.hosts"). Another machine without a host runs
// the sympp skill's helper installed there (model.js). A copy without an endpoint uses the
// connection the last connected copy shared ("sympp.connection"), so a scripted studio needs only its ids.
//
// Modules: model.js (board in, view data out), levels.js (Factory, Topic and Space placement, panel
// following and new needs), scope.js (what a Topic, Space or task shows), job.js (agents and job
// tabs), controls.js (persisted actions), transport.js (native HTTP), ui.js (shared look),
// overview.js (the Factory level) and scopeview.js (the Topic, Space and task views), jobview.js (the
// answer form and review drill-down), rails.js (review rounds, row moves), chrome.js (what the patched desk agents
// list shows on sympp agents), studio.js and studioview.js (a UI package's studio), chief.js and
// chiefview.js (Start chief and the topic mark's menu).

import { View } from "gpui-kit";
import { v_flex, InputState, TextareaState } from "gpui-base";
import * as fs from "fs/promises";
import { props, theme, shared, setShared, spaces, panes, terminals, focused, notify, run, window as appWindow, exec, hc, appHome, watchFolder } from "herdr";
import * as M from "./model.js";
import * as L from "./levels.js";
import * as J from "./job.js";
import * as R from "./rails.js";
import * as C from "./controls.js";
import * as Chrome from "./chrome.js";
import * as S from "./studio.js";
import { request, remoteRequest } from "./transport.js";
import { button, message } from "./ui.js";
import * as O from "./overview.js";
import * as Lv from "./scopeview.js";
import { studioView } from "./studioview.js";
import { ChiefStart, ChiefMenu } from "./chiefview.js";
import { CHIEF_SESSIONS, CHIEF_SPACES, FACTORY_ROOT, chiefSession, chiefRunning } from "./chief.js";

const TICK = 5000;
const REPAINT = 30000;
const DAY = 24 * 3600e3;
const KEYS = { j: "down", k: "up", down: "down", up: "up" };
const TOP = { topic: null, space: null, job: null };
const CONNECTION = "sympp.connection";
// For other mods (the status bar): the live jobs, [{ id, title, stage, needs, failed }] with stage the
// furthest a live package reached; and their ask to show one in the panel, { job, at }.
const BOARD = "sympp.board";
const OPEN = "sympp.open";
// For the spaces sidebar's chief button: each Herdr topic's chiefs, { [topic id]: [{ domain,
// terminal }] }, terminal only while the helper confirms the chief live.
const CHIEFS = "sympp.chiefs";
// How often a running chief's saved session is read: until one is known, then once it is.
const SESSION_READ = [10e3, 60e3];
const STAGES = ["build", "checks", "review", "merge"];
const SWEEP = 60e3;
// A copy starting sympp records when ("sympp.starting"); other copies leave it to that one meanwhile.
const STARTING = "sympp.starting";
const START_WAIT = 60e3;
// How often an open view renews its sympp client lease; sympp drops one unrenewed for 10 minutes.
const LEASE = 60e3;
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
    if (own.role === "chief" || own.role === "chief-menu") {
      this.chief = own.role === "chief" ? new ChiefStart(own, given.endpoint, cx) : new ChiefMenu(own, cx);
      return;
    }
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
    this.request = given.remote ? remoteRequest(this.endpoint, async () => JSON.parse(await fs.readFile(`${appHome()}/sympp-remote.json`, "utf8"))) : request;
    this.net = M.initialFetch();
    this.reading = false;
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
    this.leaseId = `herdr-app-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    this.leasedAt = 0;
    cx.timer.every(TICK, (cx) => this.tick(cx));
    this.tick(cx);
    this.started = Date.now();
    if (this.role === "panel") cx.timer.every(250, (cx) => this.checkOpen(cx));
  }

  // Another mod asked the panel to show a job (shared OPEN); asks from before this copy started are old.
  checkOpen(cx) {
    const ask = shared(OPEN);
    if (!ask?.job || !(ask.at > (this.openedAt ?? this.started))) return;
    this.openedAt = ask.at;
    const job = this.net.data?.jobs.find((j) => j.id === ask.job);
    if (job) this.openJob(job, {}, cx);
  }

  // Data timer: the board when due, and agent checks for whichever view has agents to reach.
  // Otherwise it repaints now and then so ages move.
  tick(cx) {
    if (!this.endpoint) return;
    const now = Date.now();
    // A copy that starts with the app (the sympp panel) ticks before Herdr has a window.
    const active = appWindow()?.active !== false;
    const cadence = M.nextDelay(this.net, active);
    let busy = false;
    if (!this.reading && M.fetchDue(this.net, now, active)) { this.read(cx); busy = true; }
    this.shareChiefs(now);
    const watch = this.withChiefs(this.agentWatch);
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
        if (!this.given.remote && this.hosts?.local?.runtime) {
          try {
            const runtime = JSON.parse(await fs.readFile(this.hosts.local.runtime, 'utf8'));
            const endpoint = M.normalizeEndpoint(runtime.backend?.url);
            if (endpoint) { this.endpoint = endpoint; this.dashboard = M.dashboardUrl(endpoint, this.given.dashboardUrl); }
          } catch { /* The factory may not have published its runtime yet. */ }
        }
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
        outcome = { error: caught.userMessage || M.networkError(this.endpoint, caught), unreachable: caught.status === undefined };
      }
      this.reading = false;
      if (turn !== this.turn) return;
      const now = Date.now();
      this.net = outcome.board ? M.fetchSucceeded(this.net, outcome.board, now) : M.fetchFailed(this.net, outcome.error, now);
      if (outcome.unreachable) this.startServer(cx);
      if (outcome.board) {
        this.outage = false;
        this.startFailed = false;
        this.holdLease(outcome.board, now, cx);
        if (this.ownConnection) this.shareConnection();
        this.announce(outcome.board);
        const agents = Chrome.nextDecorations(shared(Chrome.AGENTS), Chrome.decorations(outcome.board, terminals(), this.endpoint, now), this.endpoint, now);
        if (agents) setShared(Chrome.AGENTS, agents);
        const live = outcome.board.jobs.filter((j) => j.state === "live").map((j) => {
          const moving = j.packages.filter((p) => STAGES.includes(p.stage));
          return { id: j.id, title: j.title, stage: STAGES[Math.max(-1, ...moving.map((p) => STAGES.indexOf(p.stage)))] ?? null,
            needs: j.needs.length > 0, failed: moving.some((p) => p.failed) };
        });
        if (JSON.stringify(shared(BOARD)) !== JSON.stringify(live)) setShared(BOARD, live);
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

  // A local sympp that doesn't answer starts through its helper, once per outage (Retry asks again), and
  // only from one copy at a time: the others see the shared start and wait for it.
  startServer(cx) {
    const host = this.hosts?.local;
    if (this.given.remote || !host?.runtime || this.starting || this.outage) return;
    const at = shared(STARTING);
    if (typeof at === "number" && Date.now() - at < START_WAIT) return;
    this.outage = true;
    this.starting = true;
    this.startFailed = false;
    setShared(STARTING, Date.now());
    cx.spawn(async (cx) => {
      let result = null;
      try { result = await exec(host.node, [host.helper, "start", "--runtime", host.runtime]); } catch { result = null; }
      this.starting = false;
      this.startFailed = result?.code !== 0;
      setShared(STARTING, 0);
      this.net = { ...this.net, attemptAt: null };
      if (this.reading) this.refreshAfterRead = true;
      else this.read(cx);
      try { cx.notify(); } catch { /* closed while starting */ }
    });
  }

  // While a view is open sympp counts Herdr as a client, so it stays up after the last agent session
  // closes; the lease lapses on its own if Herdr quits before letting go.
  holdLease(board, now, cx) {
    if (board.offline !== false || now - this.leasedAt < LEASE) return;
    const action = this.leasedAt ? "heartbeat" : "attach";
    this.leasedAt = now;
    cx.spawn(async () => {
      try { if (!(await this.lease(action)).ok) this.leasedAt = 0; } catch { this.leasedAt = 0; }
    });
  }

  lease(action) {
    return this.request(`${this.endpoint}/mcp/client-lease`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_id: this.leaseId, action }),
    });
  }

  async close() {
    if (this.leasedAt) await this.lease("detach").catch(() => null);
  }

  // Lets a copy opened without connection props (a scripted studio) reach the same sympp.
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
  // what was announced, so each need is announced once however many sympp views are open.
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
    this.checkedFor = null;
    this.outage = false;
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

  watch(key, list) {
    this.agentWatch = { key, bindings: list.filter((b, i) => list.findIndex((o) => o.address === b.address) === i) };
  }

  bindingsOf(board) {
    return M.discoverBindings(this.hosts ?? shared("sympp.hosts"), terminals()).map((binding) => board.offline === false
      ? binding : { ...binding, available: false, unavailable: board.offline ? "Offline copy" : "Update sympp for agent access" });
  }

  // The panel keeps every topic's chiefs checked, whichever level it shows, and shares them.
  // Written outside render, and only when something differs.
  shareChiefs(now) {
    const board = this.net.data;
    if (this.role !== "panel" || this.studio || !board) return;
    const desk = L.deskOf(this.deskTopics(), this.spaceList()), bindings = this.bindingsOf(board);
    const out = {}, list = terminals(), sessions = shared(CHIEF_SESSIONS) ?? {};
    this.chiefWatch = [];
    for (const topic of desk.filter((x) => x.kind === "topic")) {
      const chiefs = this.chiefsOf(topic, board, desk, bindings, now);
      this.chiefWatch.push(...chiefs.flatMap((c) => c.agent.bindings));
      if (chiefs.length) out[topic.id] = chiefs.map(({ chief, agent }) =>
        ({ domain: chief.domain, terminal: agent.state === "live" ? agent.binding.address : null }));
      // The chief Start chief started last is the topic's chief while it runs, registered or not, and
      // ahead of an older registration still running.
      const latest = sessions[topic.id];
      if (chiefRunning(latest, list, now)) {
        out[topic.id] = [{ domain: topic.name, terminal: latest.terminal }, ...(out[topic.id] ?? []).filter((c) => c.terminal !== latest.terminal)];
      }
      const live = out[topic.id]?.find((c) => c.terminal);
      if (live) this.readSession(topic.id, live.terminal, now);
    }
    if (JSON.stringify(shared(CHIEFS) ?? {}) !== JSON.stringify(out)) setShared(CHIEFS, out);
    // A chief space that fell out of its topic goes back, where the desk keeps it unlisted.
    const home = L.homeChiefSpaces(this.deskTopics(), shared(CHIEF_SPACES), this.spaceList().map((s) => s.id));
    if (home) setShared("desk.topics", home);
    if ((shared(FACTORY_ROOT) ?? null) !== board.reposRoot) setShared(FACTORY_ROOT, board.reposRoot);
  }

  // A running chief's session as Herdr saved it, kept once it stops so its mark can resume it. Only
  // herdr-core's own terminal record carries it.
  readSession(topic, address, now) {
    const known = shared(CHIEF_SESSIONS)?.[topic], reads = (this.sessionReads ??= {});
    if (now - (reads[address] ?? 0) < SESSION_READ[known?.terminal === address && known.session ? 1 : 0]) return;
    reads[address] = now;
    hc(["get", address, "--json"]).then((result) => {
      const program = terminals().find((k) => k.address === address)?.program;
      const session = chiefSession({ ...JSON.parse(result.stdout), address, program });
      const all = shared(CHIEF_SESSIONS) ?? {}, current = all[topic];
      // Never in place of another chief started since and running.
      if (current && current.terminal !== address && chiefRunning(current, terminals())) return;
      if (session && JSON.stringify(current) !== JSON.stringify(session)) setShared(CHIEF_SESSIONS, { ...all, [topic]: session });
    }).catch(() => {});
  }

  withChiefs(watch) {
    const chiefs = this.chiefWatch ?? [];
    if (!chiefs.length) return watch;
    const list = [...(watch?.bindings ?? []), ...chiefs];
    return { key: `${watch?.key ?? "none"}+chiefs`, bindings: list.filter((b, i) => list.findIndex((o) => o.address === b.address) === i) };
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

  // A local worker's sympp worktree: its Herdr view built on sample data as this package's preview
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
      return this.root(t, [message(t, "This package isn't here", "It isn't on this sympp board. It may have been archived, or this studio belongs to another factory.", [
        button(t, "retry-missing", this.reading ? "Reading…" : "Refresh", (cx) => this.retry(cx), { strong: true }),
      ]), O.floatingStatus(this, t, now)]);
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
    return this.root(t, [studioView(this, t, {
      pkg, worker: { state: w.state, provider: w.binding?.provider ?? null }, place, kind, url,
      native: this.native, landed: this.landed, strip: Boolean(devPane) && !this.closingDev,
    }), O.floatingStatus(this, t, now)]);
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

  render(cx) {
    if (this.chief) return this.chief.render();
    this.compact = this.role === "panel" || this.companion || this.viewportWidth() < 1000;
    const t = theme();
    const now = Date.now();
    this.shown = null;
    this.agentWatch = null;
    this.currentJob = null;
    this.rows = [];
    this.level = this.pinned ? "job" : "factory";
    if (!this.endpoint) {
      return this.root(t, [message(t, "sympp isn't connected", "Give this block an endpoint prop with the local sympp address, for example http://127.0.0.1:4000.")]);
    }
    const board = this.net.data;
    if (!board) {
      if (!this.net.error) return this.root(t, [message(t, "Reading sympp…", null)]);
      if (!this.given.remote && (this.starting || now - (shared(STARTING) || 0) < START_WAIT)) return this.root(t, [message(t, "Starting sympp…", null)]);
      return this.root(t, [message(t, this.startFailed ? "Couldn't start sympp" : "Couldn't read sympp", this.startFailed ? null : this.net.error, [
        button(t, "retry-first", this.reading ? "Reading…" : "Retry", (cx) => this.retry(cx), { strong: true }),
        ...(this.dashboard ? [button(t, "dashboard-first", "Open dashboard", (cx) => this.openDashboard(cx))] : []),
      ])]);
    }
    const bindings = this.bindingsOf(board);

    if (this.studio) return this.studioLevel(t, board, bindings, now, cx);

    if (this.pinned) {
      this.registerTab(cx);
      const job = board.jobs.find((j) => j.id === this.pinned);
      if (!job) {
        return this.root(t, [message(t, "This job isn't here", "It isn't on this sympp board. It may have been archived, or this tab belongs to another factory.", [
          button(t, "retry-missing", this.reading ? "Reading…" : "Refresh", (cx) => this.retry(cx), { strong: true }),
          ...(this.dashboard ? [button(t, "dashboard-missing", "Open dashboard", (cx) => this.openDashboard(cx))] : []),
        ]), O.floatingStatus(this, t, now)]);
      }
      return this.root(t, Lv.taskLevel(this, t, job, { board, bindings, terminals: terminals(), now, tab: true, topic: null }));
    }

    const desk = L.deskOf(this.deskTopics(), this.spaceList());
    this.place = L.placeJobs(board.jobs, desk, this.repoTopics);
    if (this.role === "panel" && !this.pin) this.follow(board, desk, cx);
    if (this.awaiting && board.jobs.some((job) => job.id === this.awaiting)) this.awaiting = null;
    const path = this.path = L.resolvePath(this.path, desk, board.jobs, this.awaiting);
    this.level = L.levelOf(path);
    const trail = L.crumbs(path, desk, board.jobs);
    const needs = M.verdictCounts(board.jobs).needs;

    if (this.level === "job") {
      const job = board.jobs.find((j) => j.id === path.job);
      if (job) {
        const home = desk.find((x) => x.id === (path.topic ?? this.place.home(job)) && x.kind === "topic") ?? null;
        return this.root(t, Lv.taskLevel(this, t, job, { board, bindings, terminals: terminals(), now, topic: home }));
      }
      return this.root(t, [O.levelBar(this, t, trail, { now, needs, slim: true }), message(t, "Reading new job…", null)]);
    }
    if (this.level !== "factory") return this.root(t, Lv.scopeLevel(this, t, { board, desk, path, bindings, terminals: terminals(), now }));
    const top = [O.levelBar(this, t, trail, { now, needs })];
    if (this.intake) return this.root(t, [...top, O.intakeForm(this, t)]);
    const rows = L.factoryRows(board.jobs, desk, this.place).map((row) => ({ ...row, chiefs: this.chiefsOf(row, board, desk, bindings, now) }));
    this.watch("factory", rows.flatMap((row) => row.chiefs.flatMap((c) => c.agent.bindings)));
    return this.root(t, [...top, O.factoryLevel(this, t, board.jobs, rows, now)]);
  }
}
