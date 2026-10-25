// S++ Lens: the shared S++ board, natively in Herdr. What needs you first, then the jobs that are
// moving, and one selected job with its packages, actors, next steps, waiting reasons and evidence.
// Intake and answers persist through S++; terminal jumps check a trusted execution helper first.
//
// Block props: { endpoint: "http://127.0.0.1:<port>", role?: "overview" | "panel",
//   dashboardUrl?, repoTopics?: { "owner/repo" | "repo": "<desk topic id or name>" },
//   hosts?: { local: { node, helper, session? }, "machine": { node, helper, session? } } }
// Hosts may also be configured explicitly in shared("sympp.hosts").

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Button, Input, InputState, Textarea, TextareaState } from "gpui-base";
import { props, theme, shared, spaces, terminals, run, window as appWindow, exec } from "herdr";
import * as M from "./model.js";
import * as C from "./controls.js";

const TICK = 5000;
const REPAINT = 30000;
const DONE_SHOWN = 4;
const icon = (name) => `mods/workspace-chrome/${name}.svg`;
const tint = (color, alpha) => (/^#[0-9a-f]{6}$/i.test(color ?? "") ? color + alpha : color);
const CLEAR = "#00000000";
const MONO = "Geist Mono";

export default class Lens extends View {
  init(p, cx) {
    const given = p ?? props() ?? {};
    this.role = given.role === "panel" ? "panel" : "overview";
    this.endpoint = M.normalizeEndpoint(given.endpoint);
    this.dashboard = M.dashboardUrl(this.endpoint, given.dashboardUrl);
    this.repoTopics = given.repoTopics && typeof given.repoTopics === "object" ? given.repoTopics : null;
    this.hosts = given.hosts ?? null;
    this.net = M.initialFetch();
    this.reading = false;
    this.turn = 0;
    this.selected = null;
    this.detail = false;
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

  // Data timer: reads when due, and repaints now and then so ages keep moving.
  tick(cx) {
    if (!this.endpoint) return;
    const now = Date.now();
    if (!this.reading && M.fetchDue(this.net, now, appWindow().active)) this.read(cx);
    else if (now - this.painted >= REPAINT) {
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
        const response = await fetch(M.boardUrl(this.endpoint), { headers: { accept: "application/json" } });
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
        outcome = { error: M.networkError(this.endpoint, caught) };
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

  retry(cx) {
    this.net = { ...this.net, attemptAt: null };
    if (this.reading) this.refreshAfterRead = true;
    else this.read(cx);
    cx.notify();
  }

  openDashboard(cx) {
    if (this.dashboard) cx.open_url(this.dashboard);
  }

  select(id, cx) {
    this.following = null;
    this.selected = id;
    if (this.compact) this.detail = true;
    this.keys.focus();
    cx.notify();
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
        const payload = await C.postAction(this.endpoint, "/api/v1/sympp/herdr/work-requests", C.requestBody(fields));
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
        async () => C.postAction(this.endpoint, C.answerPath(question), C.answerBody(question, draft.choice, draft.input.value())),
        () => { draft.open = false; draft.saved = true; draft.input.set_value(""); this.retry(cx); });
      cx.notify();
      await submission;
      cx.notify();
    });
  }

  focusAgent(binding, cx) {
    if (!binding.available || this.jumps[binding.address]?.pending) return;
    const action = this.jumps[binding.address] = { pending: false, error: null };
    cx.spawn(async (cx) => {
      const submission = C.submitAction(action, async () => {
        let result;
        try { result = await exec(binding.host.node, M.bindingCheckArgs(binding), { on: binding.machine }); }
        catch { throw new Error("Agent helper unavailable. Check the execution host."); }
        if (!M.checkedBinding(binding, result, terminals())) throw new Error("Agent unavailable. Refresh and try again.");
      }, () => run("agent.focus", { terminal: binding.address }));
      cx.notify();
      await submission;
      cx.notify();
    });
  }

  onKey(e, cx) {
    if (!this.keys.is_focused()) return;
    const key = e.key;
    if (key === "down" || key === "j" || key === "up" || key === "k") {
      this.selected = M.moveSelection(this.scoped, this.selected, key === "down" || key === "j" ? 1 : -1) ?? this.selected;
    } else if (key === "enter" && this.selected) this.detail = true;
    else if (key === "escape" && this.intake && !this.creation.pending) this.intake = false;
    else if (key === "escape" && (this.detail || this.currentScope?.kind === "job")) {
      this.detail = false;
      if (this.currentScope?.kind === "job") this.setScope("all", cx);
    }
    else if (key === "r") this.retry(cx);
    else if (key === "o") this.openDashboard(cx);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  // ---------- Pieces ----------

  button(t, id, label, action, { strong = false, glyph = null, tip = null, disabled = false } = {}) {
    return Button.new(id).flex().flex_none().items_center().gap(6).h(26).px(9).rounded(6).text_size(12).cursor_pointer()
      .border(1).border_color(strong ? t.input : CLEAR)
      .text_color(strong ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .focus((s) => s.border_color(t.accent))
      .disabled(disabled).when(disabled, (el) => el.opacity(0.5))
      .accessibility_label(tip ?? label)
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        action(cx);
      })
      .when(Boolean(glyph), (el) => el.child(svg(icon(glyph)).size(13).flex_none()))
      .when(Boolean(label), (el) => el.child(label));
  }

  field(t, label, state, multiline = false) {
    return v_flex().gap(6).min_w(0)
      .child(div().text_size(12).text_color(t.muted).child(label))
      .child(div().min_w(0).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child((multiline ? Textarea.new(state).h(110) : Input.new(state).h(34))
          .w_full().px(10).py(7).rounded(6).border(1).border_color(t.input).bg(t.background)
          .text_size(13).text_color(t.foreground).accessibility_label(label)));
  }

  intakeForm(t) {
    return v_flex().id("intake-form").flex_1().min_h(0).overflow_y_scrollbar().p(20).gap(18)
      .child(div().text_size(18).font_semibold().child("New job"))
      .child(this.field(t, "Title", this.draft.title))
      .child(this.field(t, "Repository", this.draft.repo))
      .child(this.field(t, "Base branch", this.draft.base_branch))
      .child(this.field(t, "Request", this.draft.human_description, true))
      .when(Boolean(this.creation.error), (el) => el.child(div().role("alert").text_size(12.5).text_color(t.blocked).child(this.creation.error)))
      .child(h_flex().gap(8).flex_wrap()
        .child(this.button(t, "create-job", this.creation.pending ? "Creating…" : "Create job", (cx) => this.createRequest(cx), { strong: true, disabled: this.creation.pending }))
        .child(this.button(t, "cancel-intake", "Back", (cx) => { this.intake = false; this.keys.focus(); cx.notify(); }, { disabled: this.creation.pending })));
  }

  questionRow(t, question) {
    const draft = this.answers[question.key];
    const open = question.status === "open" || question.status === "human_info_needed";
    const prompt = question.prompt;
    const option = (id, label, description, pros = [], cons = [], answer = null) => Button.new(`choice-${question.key}-${id}`)
      .flex().w_full().min_w(0).px(10).py(8).rounded(6).border(1).border_color(draft?.choice === id ? t.accent : t.input)
      .bg(draft?.choice === id ? t.selected : CLEAR).text_color(t.foreground).cursor_pointer()
      .hover((s) => s.bg(t.hover)).focus((s) => s.border_color(t.accent)).disabled(Boolean(draft?.pending))
      .accessibility_label(label)
      .on_click((_e, cx) => { draft.choice = id; cx.stop_propagation(); cx.notify(); })
      .child(v_flex().flex_1().min_w(0).gap(4)
        .child(div().text_size(12.5).font_medium().child(label))
        .when(Boolean(description), (el) => el.child(div().text_size(12).text_color(t.muted).child(description)))
        .when(Boolean(answer && answer !== description), (el) => el.child(div().text_size(12).text_color(t.muted).child(answer)))
        .children(pros.map((text) => div().text_size(11.5).text_color(t.muted).child(`For: ${text}`)))
        .children(cons.map((text) => div().text_size(11.5).text_color(t.muted).child(`Against: ${text}`))));
    return v_flex().id(`question-${question.key}`).gap(8).py(10).border_t(1).border_color(t.border)
      .child(div().text_size(13.5).font_medium().text_color(t.foreground).child(question.text))
      .when(Boolean(question.context), (el) => el.child(div().text_size(12).text_color(t.muted).child(question.context)))
      .when(!open, (el) => el.child(div().text_size(12).text_color(t.muted).child(question.answer || cap(question.status || "Closed"))))
      .when(open && !draft?.open, (el) => el.child(h_flex().child(draft?.saved
        ? div().text_size(12).text_color(t.muted).child("Answer saved · refreshing…")
        : this.button(t, `answer-${question.key}`, "Answer", (cx) => this.openAnswer(question, cx), { strong: true }))))
      .when(open && Boolean(draft?.open), (el) => el.child(v_flex().gap(8)
        .when(Boolean(prompt), (form) => form
          .child(div().text_size(13).font_medium().child(prompt.tl_dr))
          .child(div().text_size(12).text_color(t.muted).child(prompt.details))
          .children((prompt.options ?? []).map((o) => option(o.id, o.label, o.description, o.pros, o.cons, o.answer)))
          .child(option("__custom_redirect__", prompt.custom_redirect_label || "Another direction")))
        .child(this.field(t, prompt ? draft.choice === "__custom_redirect__" ? "Your direction" : "Note (optional)" : "Your answer", draft.input, true))
        .when(Boolean(draft.error), (form) => form.child(div().role("alert").text_size(12).text_color(t.blocked).child(draft.error)))
        .child(h_flex().gap(8).flex_wrap()
          .child(this.button(t, `save-${question.key}`, draft.pending ? "Saving…" : "Save answer", (cx) => this.saveAnswer(question, cx), { strong: true, disabled: draft.pending }))
          .child(this.button(t, `cancel-${question.key}`, "Back", (cx) => { draft.open = false; this.keys.focus(); cx.notify(); }, { disabled: draft.pending })))));
  }

  // A verdict's mark: its shape carries the meaning as much as its color.
  mark(t, verdict) {
    if (verdict === "needs_you") return div().size(8).flex_none().rounded(4).bg(t.blocked);
    if (verdict === "bump" || verdict === "stalled") return div().size(8).flex_none().rounded(2).bg(t.working);
    if (verdict === "on_track") return div().size(8).flex_none().rounded(4).bg(t.ansi2);
    if (verdict === "parked") return div().w(8).h(2).flex_none().rounded(1).bg(t.dim);
    if (verdict === "settled") return svg(icon("check")).size(11).flex_none().text_color(t.ansi2);
    return div().size(8).flex_none().rounded(4).border(1.5).border_color(t.dim);
  }

  pip(t, pkg) {
    const base = div().size(7).flex_none();
    if (pkg.stage === "done") return base.rounded(4).bg(pkg.outcome === "dropped" ? t.dim : t.ansi2);
    if (pkg.stage === "queued") return base.rounded(4).border(1.5).border_color(t.dim);
    if (pkg.failed) return base.rounded(1.5).bg(t.blocked);
    return base.rounded(4).bg(pkg.stage === "merge" ? t.accent : t.working);
  }

  // One dot per package in planned order, a gap between the architect's groups.
  strip(t, job, now) {
    const dots = [];
    job.packages.forEach((pkg, i) => {
      const gap = i > 0 && pkg.group !== job.packages[i - 1].group;
      dots.push(div().id(`pip-${job.id}-${pkg.id}`).flex_none().when(gap, (el) => el.ml(5)).tooltip(`${pkg.title}: ${M.stageText(pkg, now)}`).child(this.pip(t, pkg)));
    });
    return h_flex().flex_none().gap(3).items_center().accessibility_label(`${job.counts.done} of ${job.counts.total} packages landed`).children(dots);
  }

  section(t, label, count, tone = t.dim) {
    return h_flex().pt(18).pb(6).px(4).gap(6).items_center().flex_none()
      .child(div().text_size(11.5).font_medium().text_color(tone).child(label))
      .when(count !== null, (el) => el.child(div().text_size(11.5).text_color(t.dim).child(String(count))));
  }

  // ---------- Header ----------

  header(t, scopes, scope, all, now) {
    const compact = this.compact;
    const counts = M.verdictCounts(all);
    const stale = M.isStale(this.net, now);
    const needed = counts.needs > 0
      ? h_flex().gap(7).items_center().flex_none().child(div().size(7).rounded(4).bg(t.blocked)).child(div().text_size(12.5).font_semibold().text_color(t.blocked).child(`You're needed in ${counts.needs}`))
      : div().flex_none().text_size(12.5).text_color(t.dim).child("Nothing needs you");
    const fresh = div().flex_none().text_size(11).font_family(MONO).text_color(stale ? t.blocked : t.dim)
      .child(this.reading && !this.net.receivedAt ? "Reading…" : `${stale ? "Last read" : "Read"} ${M.ago(this.net.receivedAt, now)}`);
    const chips = h_flex().gap(2).items_center().min_w(0).flex_wrap().children(scopes.map((s) => {
      const on = s.key === scope.key;
      return Button.new(`scope-${s.key}`).flex().flex_none().items_center().gap(5).h(24).px(8).rounded(6).text_size(12).cursor_pointer()
        .border(1).border_color(CLEAR)
        .bg(on ? t.selected : CLEAR)
        .text_color(on ? t.foreground : t.muted)
        .hover((st) => st.bg(t.hover).text_color(t.foreground))
        .focus((st) => st.border_color(t.accent))
        .accessibility_label(`${s.kind === "topic" ? "Topic" : s.kind === "area" ? "Area" : "Scope"}: ${s.label}`)
        .on_click((_e, cx) => this.setScope(s.key, cx))
        .when(s.kind === "topic", (el) => el.child(svg(icon("folder")).size(12).flex_none()))
        .child(s.label);
    }));
    const actions = h_flex().gap(4).items_center().flex_none()
      .child(this.button(t, "new-job", "New job", (cx) => this.openIntake(cx), { strong: true }))
      .child(this.button(t, "refresh", "Refresh", (cx) => this.retry(cx), { tip: "Read S++ now (R)" }))
      .when(Boolean(this.dashboard), (el) => el.child(this.button(t, "dashboard", "Dashboard", (cx) => this.openDashboard(cx), { tip: "Open the S++ dashboard (O)" })));

    if (compact) {
      return v_flex().flex_none().px(12).pt(10).pb(8).gap(8).border_b(1).border_color(t.border)
        .child(h_flex().gap(8).items_center().flex_wrap().child(div().text_size(13).font_semibold().text_color(t.foreground).child("S++")).child(needed).child(div().flex_1()).child(actions))
        .child(h_flex().gap(8).items_center().flex_wrap().child(chips).child(div().flex_1()).child(fresh));
    }
    return h_flex().flex_none().py(10).px(20).gap(16).items_center().flex_wrap().border_b(1).border_color(t.border)
      .child(div().flex_none().text_size(13.5).font_semibold().text_color(t.foreground).child("S++"))
      .child(div().flex_1().min_w(0).child(chips))
      .child(needed)
      .child(fresh)
      .child(actions);
  }

  // A failed read keeps the last board on screen and says so, with the way back.
  staleBar(t, now) {
    if (!M.isStale(this.net, now)) return null;
    const lost = this.net.error ? `Connection lost · showing the read from ${M.ago(this.net.receivedAt, now)}` : `This read is ${M.ago(this.net.receivedAt, now).replace(" ago", "")} old`;
    return h_flex().flex_none().px(this.role === "panel" ? 12 : 20).py(8).gap(10).items_center().bg(tint(t.blocked, "14")).border_b(1).border_color(tint(t.blocked, "40"))
      .role("alert")
      .child(div().size(7).flex_none().rounded(1.5).bg(t.blocked))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().text_size(12.5).font_medium().text_color(t.foreground).child(lost))
        .when(Boolean(this.net.error), (el) => el.child(div().text_size(11.5).text_color(t.muted).truncate().child(this.net.error))))
      .child(this.button(t, "retry-stale", this.reading ? "Reading…" : "Retry", (cx) => this.retry(cx), { strong: true }));
  }

  // ---------- List ----------

  needRow(t, need, now) {
    const job = need.job;
    return v_flex().id(`need-${need.key}`).flex_none().px(14).py(12).gap(7).rounded(10).cursor_pointer()
      .bg(tint(t.blocked, "10")).border_l(3).border_color(t.blocked)
      .hover((s) => s.bg(tint(t.blocked, "1c")))
      .accessibility_label(`${need.label}: ${need.text}. ${job.title}`)
      .on_click((_e, cx) => {
        if (!this.order.some((j) => j.id === job.id)) this.setScope("all", cx);
        this.select(job.id, cx);
        this.detail = true;
      })
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(11.5).font_semibold().text_color(t.blocked).child(need.label))
        .child(div().flex_1())
        .when(need.since !== null, (el) => el.child(div().text_size(11).font_family(MONO).text_color(t.dim).child(M.ago(need.since, now)))))
      .child(div().w_full().text_size(14).text_color(t.foreground).child(need.text))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(`${job.area[0]} › ${job.repoShort} · ${job.title}`))
        .child(this.button(t, `view-${need.key}`, "View job", (cx) => { this.select(job.id, cx); this.detail = true; cx.notify(); }, { strong: true })));
  }

  jobRow(t, job, now) {
    const on = job.id === this.selected;
    const compact = this.compact;
    const loud = job.verdict !== "on_track" && job.verdict !== "idle" && job.verdict !== "settled";
    return h_flex().id(`job-${job.id}`).flex_none().px(12).py(compact ? 8 : 10).gap(12).items_start().rounded(8).cursor_pointer()
      .bg(on ? t.selected : CLEAR)
      .hover((s) => s.bg(on ? t.selected : t.hover))
      .accessibility_label(`${job.title}, ${M.VERDICT_LABEL[job.verdict]}`)
      .on_click((_e, cx) => this.select(job.id, cx))
      .child(div().pt(5).flex_none().child(this.mark(t, job.verdict)))
      .child(v_flex().flex_1().min_w(0).gap(5)
        .child(h_flex().gap(8).items_center()
          .child(div().min_w(0).flex_shrink(1).truncate().text_size(13.5).font_semibold().text_color(job.state === "settled" ? t.muted : t.foreground).child(job.title))
          .when(job.offPrimary, (el) => el.child(div().flex_none().text_size(11).font_family(MONO).text_color(t.dim).child(`→ ${job.baseBranch}`)))
          .child(div().flex_1())
          .when(loud, (el) => el.child(div().flex_none().text_size(11.5).font_medium().text_color(job.verdict === "needs_you" ? t.blocked : job.verdict === "parked" ? t.muted : t.foreground).child(M.VERDICT_LABEL[job.verdict])))
          .when(job.counts.total > 0, (el) => el.child(div().flex_none().text_size(11).font_family(MONO).text_color(t.dim).child(`${job.counts.done}/${job.counts.total}`))))
        .child(h_flex().gap(10).items_center()
          .when(job.counts.total > 0, (el) => el.child(this.strip(t, job, now)))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(job.brief)))
        .when(!compact, (el) => el.child(h_flex().gap(6).text_size(11).text_color(t.dim)
          .child(div().min_w(0).truncate().child(`${job.area.join(" › ")} · ${job.repoShort}`))
          .child(div().flex_none().child(`· moved ${M.ago(job.lastMoveAt, now)}`)))));
  }

  list(t, jobs, needs, now) {
    const lanes = M.lanesOf(jobs);
    const rows = [];
    if (needs.length) {
      rows.push(this.section(t, "Needs you", needs.length, t.blocked));
      rows.push(v_flex().gap(8).children(needs.map((need) => this.needRow(t, need, now))));
    }
    const lane = (label, list) => {
      if (!list.length) return;
      rows.push(this.section(t, label, list.length));
      rows.push(v_flex().gap(2).children(list.map((job) => this.jobRow(t, job, now))));
    };
    lane("Moving", lanes.moving);
    lane("Parked", lanes.parked);
    lane("Not started", lanes.backlog);
    lane("Landed · last 24 hours", lanes.landed);
    const away = [lanes.settled.length ? `${lanes.settled.length} settled` : null, lanes.dormant.length ? `${lanes.dormant.length} dormant` : null].filter(Boolean);
    if (!rows.length) rows.push(div().pt(28).px(4).text_size(13).text_color(t.dim).child(jobs.length ? "Nothing open here right now." : "No S++ jobs in this scope."));
    if (away.length) {
      rows.push(h_flex().pt(18).px(4).gap(6).items_center().text_size(11.5).text_color(t.dim)
        .child(`${away.join(" · ")}, kept in the dashboard`));
    }
    return v_flex().id(`lens-list-${this.role}`).flex_1().min_w(0).min_h(0).px(this.role === "panel" ? 8 : 16).pb(20).overflow_y_scrollbar().mode("hover").children(rows);
  }

  // ---------- Detail ----------

  line(t, label, value, tone = t.muted) {
    if (!value) return null;
    return h_flex().gap(10).items_start().text_size(11.5)
      .child(div().w(62).flex_none().text_color(t.dim).child(label))
      .child(div().flex_1().min_w(0).text_color(tone).child(value));
  }

  // Last-known backend locations are display only. Every jump checks the target-local receipt.
  reach(t, bindings, place, now, key) {
    if (bindings.length) {
      return v_flex().gap(5).children(bindings.map((b, i) => {
        const action = this.jumps[b.address];
        return v_flex().gap(4)
          .child(b.available
            ? h_flex().child(this.button(t, `go-${key}-${i}`, action?.pending ? "Checking…" : `Go to ${b.role}`, (cx) => this.focusAgent(b, cx), { strong: true, glyph: "terminal", tip: b.address, disabled: action?.pending }))
            : div().text_size(11.5).text_color(t.dim).child(b.unavailable))
          .when(Boolean(action?.error), (el) => el.child(div().role("alert").text_size(11.5).text_color(t.blocked).child(action.error)));
      }));
    }
    if (!place) return null;
    return div().id(`seen-${key}`).text_size(11.5).text_color(t.dim).tooltip("A last known location, not proof the session still runs")
      .child(`Last seen ${place.where}${place.seenAt ? ` · ${M.ago(place.seenAt, now)}` : ""}`);
  }

  packageRow(t, job, pkg, bindings, now, first) {
    const moving = pkg.stage !== "queued" && pkg.stage !== "done";
    const a = pkg.activity;
    const observation = a.observation && a.observation !== "current" ? ` (${a.observation})` : "";
    const actor = a.actor ? `${[a.actor.role ? cap(a.actor.role) : null, a.actor.name].filter(Boolean).join(" · ")}${observation}` : null;
    const evidence = M.evidenceOf(pkg).join(" · ");
    const update = a.lastUpdate ? `${a.lastUpdate}${a.lastUpdateAt ? ` · ${M.ago(a.lastUpdateAt, now)}` : ""}` : null;
    const reach = moving ? this.reach(t, M.bindingsFor(bindings, job.id, pkg.id), pkg.location, now, pkg.id) : null;
    return v_flex().flex_none().py(moving ? 10 : 6).gap(6).when(!first, (el) => el.border_t(1).border_color(t.border))
      .child(h_flex().gap(10).items_center().flex_wrap()
        .child(this.pip(t, pkg))
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_medium().text_color(pkg.stage === "done" ? t.muted : pkg.stage === "queued" ? t.muted : t.foreground).child(pkg.title))
        .when(Boolean(pkg.group), (el) => el.child(div().flex_none().max_w(120).truncate().text_size(11).text_color(t.dim).child(pkg.group)))
        .child(div().flex_none().text_size(11.5).text_color(pkg.failed ? t.blocked : t.muted).child(M.stageText(pkg, now))))
      .when(moving, (el) => el.child(v_flex().pl(17).gap(4).children([
        this.line(t, "Actor", actor),
        this.line(t, "Next", a.next, a.nextActor === "human" ? t.blocked : t.foreground),
        this.line(t, "Waiting", a.waiting),
        this.line(t, "Evidence", evidence),
        this.line(t, "Latest", update),
        reach,
      ].filter(Boolean))));
  }

  detailCard(t, job, bindings, now) {
    const sections = M.packageSections(job);
    const brief = job.report.brief;
    const done = sections.done.slice(-DONE_SHOWN);
    const part = (label, list, extra = null) => list.length ? [
      h_flex().pt(4).gap(6).items_center().child(div().text_size(11.5).font_medium().text_color(t.dim).child(label)).child(div().text_size(11.5).text_color(t.dim).child(String(list.length))),
      v_flex().children(list.map((pkg, i) => this.packageRow(t, job, pkg, bindings, now, i === 0))),
      ...(extra ? [extra] : []),
    ] : [];
    const architect = this.reach(t, M.bindingsFor(bindings, job.id, null), job.architect, now, `${job.id}-architect`);

    return v_flex().gap(16).p(20)
      .child(v_flex().gap(6)
        .child(div().text_size(11.5).text_color(t.dim).child(`${job.area.join(" › ")} · ${job.repoShort}`))
        .child(div().w_full().text_size(18).font_semibold().text_color(t.foreground).child(job.title))
        .child(h_flex().gap(10).items_center()
          .child(h_flex().gap(6).items_center().child(this.mark(t, job.verdict)).child(div().text_size(12).font_medium().text_color(job.verdict === "needs_you" ? t.blocked : t.foreground).child(M.VERDICT_LABEL[job.verdict])))
          .when(job.offPrimary, (el) => el.child(div().text_size(11).font_family(MONO).text_color(t.dim).child(`→ ${job.baseBranch}`)))
          .child(div().text_size(11.5).text_color(t.dim).child(`opened ${M.ago(job.createdAt, now)}`))))
      .child(v_flex().gap(5)
        .child(div().w_full().text_size(13.5).text_color(brief ? t.foreground : t.muted).child(job.brief))
        .child(div().text_size(11).text_color(t.dim).child(brief ? `Architect · ${M.ago(brief.at, now)}` : "From the ledger; no architect brief yet"))
        .when(Boolean(job.report.eta), (el) => el.child(div().text_size(12).text_color(t.muted).child(`ETA from the architect: ${job.report.eta.text}`)))
        .when(Boolean(job.report.parked), (el) => el.child(div().text_size(12).text_color(t.muted).child(`Parked ${M.ago(job.report.parked.at, now)}: ${job.report.parked.text}`))))
      .when(Boolean(architect), (el) => el.child(h_flex().gap(10).items_center().child(div().w(62).flex_none().text_size(11.5).text_color(t.dim).child("Architect")).child(architect)))
      .when(job.needs.some((need) => !need.id), (el) => el.child(v_flex().gap(8).children(job.needs.filter((need) => !need.id).map((need) => v_flex().px(12).py(10).gap(5).rounded(8).bg(tint(t.blocked, "10")).border_l(3).border_color(t.blocked)
        .child(h_flex().gap(8).child(div().text_size(11.5).font_semibold().text_color(t.blocked).child(need.label)).child(div().flex_1()).when(need.since !== null, (row) => row.child(div().text_size(11).font_family(MONO).text_color(t.dim).child(M.ago(need.since, now)))))
        .child(div().w_full().text_size(13.5).text_color(t.foreground).child(need.text))
        .when(Boolean(this.dashboard), (row) => row.child(h_flex().child(this.button(t, `detail-answer-${need.key}`, "Answer in dashboard", (cx) => this.openDashboard(cx), { strong: true }))))))))
      .children([...job.guidance, ...job.questions].map((question) => this.questionRow(t, question)))
      .when(job.bumps.length > 0, (el) => el.child(v_flex().gap(4).children(job.bumps.map((bump) => h_flex().gap(8).items_center().text_size(12.5).text_color(t.foreground)
        .child(div().size(6).flex_none().rounded(1.5).bg(t.working)).child(div().flex_1().min_w(0).child(bump))))))
      .when(job.counts.total === 0, (el) => el.child(div().text_size(12.5).text_color(t.dim).child("No packages yet.")))
      .children([
        ...part("Now", sections.now),
        ...part("Up next", sections.next),
        ...part("Landed", done, sections.done.length > done.length ? div().pl(17).text_size(11.5).text_color(t.dim).child(`and ${sections.done.length - done.length} earlier`) : null),
      ])
      .when(Boolean(this.dashboard), (el) => el.child(h_flex().pt(4).gap(8).items_center()
        .child(div().flex_1().text_size(11.5).text_color(t.dim).child("Closing and archiving happen in the dashboard."))
        .child(this.button(t, "detail-dashboard", "Open dashboard", (cx) => this.openDashboard(cx), { strong: true }))));
  }

  // ---------- States before a first good read ----------

  message(t, title, body, actions = []) {
    return v_flex().size_full().items_center().justify_center().gap(10).p(24)
      .child(div().text_size(15).font_semibold().text_color(t.foreground).child(title))
      .when(Boolean(body), (el) => el.child(div().max_w(460).text_size(12.5).text_color(t.muted).child(body)))
      .when(actions.length > 0, (el) => el.child(h_flex().gap(8).pt(4).children(actions)));
  }

  root(t, children) {
    return v_flex().id(`lens-${this.role}`).size_full().min_h(0).bg(this.role === "panel" ? t.chrome : t.canvas).text_color(t.foreground).text_size(13)
      .track_focus(this.keys)
      .on_mouse_down("left", () => this.keys.focus())
      .on_key_down((e, cx) => this.onKey(e, cx))
      .children(children.filter(Boolean));
  }

  render(_cx) {
    this.compact = this.role === "panel" || window.viewport_size().width < 1000;
    const t = theme();
    const now = Date.now();
    if (!this.endpoint) {
      return this.root(t, [this.message(t, "S++ isn't connected", "Give this block an endpoint prop with the local S++ address, for example http://127.0.0.1:4000.")]);
    }
    const board = this.net.data;
    if (!board) {
      if (!this.net.error) return this.root(t, [this.message(t, "Reading S++…", null)]);
      return this.root(t, [this.message(t, "Couldn't read S++", this.net.error, [
        this.button(t, "retry-first", this.reading ? "Reading…" : "Retry", (cx) => this.retry(cx), { strong: true }),
        ...(this.dashboard ? [this.button(t, "dashboard-first", "Open dashboard", (cx) => this.openDashboard(cx))] : []),
      ])]);
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
    const bindings = M.discoverBindings(this.hosts ?? shared("sympp.hosts"), terminals());
    const top = [this.header(t, scopes, scope, jobs, now), this.staleBar(t, now)];
    if (this.intake) return this.root(t, [...top, this.intakeForm(t)]);

    if (this.compact || this.detail || scope.kind === "job") {
      if ((this.detail || scope.kind === "job") && (job || this.following)) {
        return this.root(t, [...top,
          h_flex().px(8).pt(8).flex_none().child(this.button(t, "back", "All jobs", (cx) => { this.detail = false; this.following = null; if (scope.kind === "job") this.setScope("all", cx); cx.notify(); }, { glyph: "chevron-left" })),
          v_flex().id("lens-panel-detail").flex_1().min_h(0).overflow_y_scrollbar().mode("hover").child(job ? this.detailCard(t, job, bindings, now) : this.message(t, "Reading new job…", null)),
        ]);
      }
      return this.root(t, [...top, this.list(t, jobs, needs, now)]);
    }

    return this.root(t, [...top,
      h_flex().flex_1().min_h(0)
        .child(this.list(t, jobs, needs, now))
        .child(div().w(460).max_w_full().flex_shrink(1).h_full().p(10).pl(0)
          .child(v_flex().id("lens-detail").size_full().rounded(10).border(1).border_color(t.border).bg(t.surface).overflow_y_scrollbar().mode("hover")
            .child(job ? this.detailCard(t, job, bindings, now) : this.message(t, "No job selected", "Pick a job on the left to follow it.")))),
    ]);
  }
}

function cap(text) {
  const value = String(text);
  return value.charAt(0).toUpperCase() + value.slice(1);
}
