// S++ Lens: the shared S++ board, natively in Herdr. Levels run Factory > Topic > Space > Job; this
// copy draws the current overview (what needs you, then moving jobs) and the Job level. A copy opened
// with props.job is that job's own tab. Intake and answers persist through S++; terminal jumps and
// "Live" both rest on a trusted execution helper's check, never on terminal labels or text.
//
// Block props: { endpoint: "http://127.0.0.1:<port>", role?: "overview" | "panel", job?: "<work request id>",
//   bridge: { node, helper },
//   dashboardUrl?, repoTopics?: { "owner/repo" | "repo": "<desk topic id or name>" },
//   hosts?: { local: { node, helper, session? }, "machine": { node, helper, session? } } }
// Hosts may also be configured explicitly in shared("sympp.hosts").
//
// Modules: model.js (board in, view data out), job.js (the Job level's pure logic), controls.js
// (persisted actions), transport.js (HTTP through exec), ui.js (shared look), overview.js and
// jobview.js (what each level draws), rails.js (package rails on a shared time axis).

import { View } from "gpui-kit";
import { v_flex, h_flex, InputState, TextareaState } from "gpui-base";
import { props, theme, shared, spaces, panes, terminals, run, window as appWindow, exec } from "herdr";
import * as M from "./model.js";
import * as J from "./job.js";
import * as R from "./rails.js";
import * as C from "./controls.js";
import { createTransport } from "./transport.js";
import { button, message } from "./ui.js";
import * as O from "./overview.js";
import { jobView } from "./jobview.js";

const TICK = 5000;
const REPAINT = 30000;
const KEYS = { j: "down", k: "up", down: "down", up: "up" };

export default class Lens extends View {
  init(p, cx) {
    const given = p ?? props() ?? {};
    this.given = given;
    this.role = given.role === "panel" ? "panel" : "overview";
    this.pinned = typeof given.job === "string" && given.job ? given.job : null;
    this.endpoint = M.normalizeEndpoint(given.endpoint);
    this.dashboard = M.dashboardUrl(this.endpoint, given.dashboardUrl);
    this.repoTopics = given.repoTopics && typeof given.repoTopics === "object" ? given.repoTopics : null;
    this.hosts = given.hosts ?? null;
    this.request = createTransport(given.bridge);
    this.net = M.initialFetch();
    this.detailNet = { jobId: null, ...M.initialFetch() };
    this.reading = false;
    this.detailReading = false;
    this.turn = 0;
    this.selected = null;
    this.detail = false;
    this.companion = false;
    this.pkgSel = null;
    this.shown = null;
    this.agentChecks = {};
    this.checking = false;
    this.checkedFor = null;
    this.checkedAt = 0;
    this.order = [];
    this.scoped = [];
    this.scopeKey = localStorage.getItem("scope") ?? "all";
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

  // Data timer: the board when due; while a job view shows, its details and agent checks at the
  // same cadence. Otherwise it repaints now and then so ages keep moving.
  tick(cx) {
    if (!this.endpoint) return;
    const now = Date.now();
    const cadence = M.nextDelay(this.net, appWindow().active);
    let busy = false;
    if (!this.reading && M.fetchDue(this.net, now, appWindow().active)) { this.read(cx); busy = true; }
    const shown = this.shown;
    if (shown && !this.detailReading && J.detailDue(this.detailNet, shown.jobId, cadence, now)) { this.readDetail(shown.jobId, cx); busy = true; }
    if (shown && !this.checking && (this.checkedFor !== shown.jobId || now - this.checkedAt >= cadence)) this.checkAgents(shown, cx);
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
  checkAgents({ jobId, bindings }, cx) {
    this.checkedFor = jobId;
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

  select(id, cx) {
    this.following = null;
    if (id !== this.selected) this.pkgSel = null;
    this.selected = id;
    if (this.compact) this.detail = true;
    this.keys.focus();
    cx.notify();
  }

  openJob(id, cx) {
    this.select(id, cx);
    this.detail = true;
    cx.notify();
  }

  leaveJob(cx) {
    this.detail = false;
    this.following = null;
    this.pkgSel = null;
    if (this.currentScope?.kind === "job") this.setScope("all", cx);
    this.keys.focus();
    cx.notify();
  }

  selectPackage(id, cx) {
    this.pkgSel = id;
    this.keys.focus();
    cx.notify();
  }

  // The job's local space when one matches its repository, else the shown one.
  openInTab(job, _cx) {
    run("tab.new", J.jobTabArgs(this.given, job, spaces()));
  }

  setScope(key, cx) {
    this.following = null;
    this.scopeKey = key;
    localStorage.setItem("scope", key);
    cx.notify();
  }

  input(placeholder, multiline = false) {
    const state = multiline ? TextareaState.new({ placeholder, rows: 4 }) : InputState.new({ placeholder });
    state.on("change", (_e, cx) => cx.notify());
    return state;
  }

  openIntake(cx) {
    if (!this.draft.repo.value()) {
      const scope = this.currentScope;
      const active = spaces().find((s) => s.active);
      this.draft.repo.set_value(scope?.kind === "repo" ? scope.repo : active?.folder ?? "");
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
        this.scopeKey = "all";
        this.selected = id;
        this.following = id;
        this.detail = true;
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
          this.detail = destination.alongside;
          run("space.select", { id: destination.space });
          run("terminal.keep", { terminal: binding.address, place: destination.alongside ? "right" : "tab" });
        }
      });
      cx.notify();
      await submission;
      cx.notify();
    });
  }

  // Enter on a package opens its worker, only once a check says it is live.
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
    const nav = KEYS[key];
    const inJob = this.level === "job";
    if (key === "escape" && this.intake) {
      if (this.creation.pending) return;
      this.intake = false;
    } else if (this.intake) return;
    else if (inJob && nav) this.pkgSel = R.moveRow(this.rowOrder, this.pkgSel, nav === "down" ? 1 : -1) ?? this.pkgSel;
    else if (nav === "down" || nav === "up") this.selected = M.moveSelection(this.scoped, this.selected, nav === "down" ? 1 : -1) ?? this.selected;
    else if (key === "enter" && inJob) { if (!this.openPackageAgent(cx)) return; }
    else if (key === "enter" && this.selected) { this.detail = true; this.pkgSel = null; }
    else if (key === "escape" && inJob && this.pkgSel) this.pkgSel = null;
    else if (key === "escape" && inJob && !this.pinned) this.leaveJob(cx);
    else if (key === "t" && this.currentJob && !this.pinned) this.openInTab(this.currentJob, cx);
    else if (key === "r") this.retry(cx);
    else if (key === "o") this.openDashboard(cx);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  root(t, children) {
    return v_flex().id(`lens-${this.pinned ? "job" : this.role}`).size_full().min_h(0).bg(this.role === "panel" ? t.chrome : t.canvas).text_color(t.foreground).text_size(13)
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
    this.shown = { jobId: job.id, bindings: J.jobBindings(job, bindings) };
    this.currentJob = job;
    const layout = place !== "side" && !this.compact ? "wide" : "compact";
    return jobView(this, t, job, { now, bindings, terminals: terminals(), layout, place, offline: board.offline === true });
  }

  render(_cx) {
    this.compact = this.role === "panel" || this.companion || this.viewportWidth() < 1000;
    const t = theme();
    const now = Date.now();
    this.shown = null;
    this.currentJob = null;
    this.level = this.pinned ? "job" : "list";
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

    if (this.pinned) {
      const job = board.jobs.find((j) => j.id === this.pinned);
      if (!job) {
        return this.root(t, [O.staleBar(this, t, now), message(t, "This job isn't here", "It isn't on this S++ board. It may have been archived, or this tab belongs to another factory.", [
          button(t, "retry-missing", this.reading ? "Reading…" : "Refresh", (cx) => this.retry(cx), { strong: true }),
          ...(this.dashboard ? [button(t, "dashboard-missing", "Open dashboard", (cx) => this.openDashboard(cx))] : []),
        ])]);
      }
      return this.root(t, [O.staleBar(this, t, now), this.jobLevel(t, board, job, bindings, "tab", now)]);
    }

    const scopes = M.scopesOf(board.jobs, shared("desk.topics"), spaces(), this.repoTopics);
    const followed = board.jobs.find((job) => job.id === this.selected);
    if (followed) scopes.push({ key: `job:${followed.id}`, label: "Selected job", kind: "job", id: followed.id });
    const scope = scopes.find((s) => s.key === this.scopeKey) ?? scopes[0];
    this.currentScope = scope;
    const jobs = M.applyScope(board.jobs, scope, this.repoTopics);
    this.scoped = jobs;
    this.order = M.selectableJobs(jobs);
    if (this.following && board.jobs.some((job) => job.id === this.following)) this.following = null;
    this.selected = this.following ?? M.pickSelection(jobs, this.selected);
    const needs = M.needsOf(jobs);
    const job = jobs.find((j) => j.id === this.selected) ?? null;
    const top = [O.header(this, t, scopes, scope, jobs, now), O.staleBar(this, t, now)];
    if (this.intake) return this.root(t, [...top, O.intakeForm(this, t)]);

    if ((this.detail || scope.kind === "job") && (job || this.following)) {
      this.level = "job";
      return this.root(t, [O.staleBar(this, t, now), job ? this.jobLevel(t, board, job, bindings, "full", now) : message(t, "Reading new job…", null)]);
    }
    if (this.compact) return this.root(t, [...top, O.list(this, t, jobs, needs, now)]);
    return this.root(t, [...top,
      h_flex().flex_1().min_h(0)
        .child(O.list(this, t, jobs, needs, now))
        .child(v_flex().id("lens-detail").w(460).max_w_full().flex_shrink(1).h_full().border_l(1).border_color(t.border)
          .child(job ? this.jobLevel(t, board, job, bindings, "side", now) : message(t, "No job selected", "Pick a job on the left to follow it."))),
    ]);
  }
}
