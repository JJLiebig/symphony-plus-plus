// S++ Lens: the shared S++ board, natively in Herdr. What needs you first, then the jobs that are
// moving, and one selected job with its packages, actors, next steps, waiting reasons and evidence.
// Read-only: S++ owns every change, so changes open the S++ dashboard. Terminals are reached only
// through bindings the execution adapter verified and herdr-core lists as live.
//
// Block props: { endpoint: "http://127.0.0.1:<port>", role?: "overview" | "panel",
//   dashboardUrl?, repoTopics?: { "owner/repo" | "repo": "<desk topic id or name>" },
//   bindings?: [verified binding, see model.js] } (else shared("sympp.bindings")).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Button } from "gpui-base";
import { props, theme, shared, spaces, terminals, run, window } from "herdr";
import * as M from "./model.js";

const TICK = 5000;
const REPAINT = 30000;
const BINDINGS_KEY = "sympp.bindings";
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
    this.givenBindings = Array.isArray(given.bindings) ? given.bindings : null;
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
    cx.timer.every(TICK, (cx) => this.tick(cx));
    this.tick(cx);
  }

  // Data timer: reads when due, and repaints now and then so ages keep moving.
  tick(cx) {
    if (!this.endpoint) return;
    const now = Date.now();
    if (!this.reading && M.fetchDue(this.net, now, window().active)) this.read(cx);
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
      try {
        cx.notify();
      } catch {
        // The view closed or reloaded while reading; nothing is left to draw.
      }
    });
  }

  retry(cx) {
    this.net = { ...this.net, attemptAt: null };
    this.read(cx);
    cx.notify();
  }

  openDashboard(cx) {
    if (this.dashboard) cx.open_url(this.dashboard);
  }

  select(id, cx) {
    this.selected = id;
    if (this.role === "panel") this.detail = true;
    this.keys.focus();
    cx.notify();
  }

  setScope(key, cx) {
    this.scopeKey = key;
    localStorage.setItem("scope", key);
    cx.notify();
  }

  onKey(e, cx) {
    const key = e.key;
    if (key === "down" || key === "j" || key === "up" || key === "k") {
      this.selected = M.moveSelection(this.scoped, this.selected, key === "down" || key === "j" ? 1 : -1) ?? this.selected;
    } else if (key === "enter" && this.role === "panel" && this.selected) this.detail = true;
    else if (key === "escape" && this.role === "panel" && this.detail) this.detail = false;
    else if (key === "r") this.retry(cx);
    else if (key === "o") this.openDashboard(cx);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  // ---------- Pieces ----------

  button(t, id, label, action, { strong = false, glyph = null, tip = null } = {}) {
    return Button.new(id).flex().flex_none().items_center().gap(6).h(26).px(9).rounded(6).text_size(12).cursor_pointer()
      .border(1).border_color(strong ? t.input : CLEAR)
      .text_color(strong ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .focus((s) => s.border_color(t.accent))
      .accessibility_label(tip ?? label)
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        action(cx);
      })
      .when(Boolean(glyph), (el) => el.child(svg(icon(glyph)).size(13).flex_none()))
      .when(Boolean(label), (el) => el.child(label));
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
    const compact = this.role === "panel";
    const counts = M.verdictCounts(all);
    const stale = M.isStale(this.net, now);
    const needed = counts.needs > 0
      ? h_flex().gap(7).items_center().flex_none().child(div().size(7).rounded(4).bg(t.blocked)).child(div().text_size(12.5).font_semibold().text_color(t.blocked).child(`You're needed in ${counts.needs}`))
      : div().flex_none().text_size(12.5).text_color(t.dim).child("Nothing needs you");
    const fresh = div().flex_none().text_size(11).font_family(MONO).text_color(stale ? t.blocked : t.dim)
      .child(this.reading && !this.net.receivedAt ? "Reading…" : `${stale ? "Last read" : "Read"} ${M.ago(this.net.receivedAt, now)}`);
    const chips = h_flex().gap(2).items_center().min_w(0).when(compact, (el) => el.flex_wrap()).children(scopes.map((s) => {
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
      .child(this.button(t, "refresh", "Refresh", (cx) => this.retry(cx), { tip: "Read S++ now (R)" }))
      .when(Boolean(this.dashboard), (el) => el.child(this.button(t, "dashboard", compact ? "Dashboard" : "Open dashboard", (cx) => this.openDashboard(cx), { strong: true, tip: "Changes happen in the S++ dashboard (O)" })));

    if (compact) {
      return v_flex().flex_none().px(12).pt(10).pb(8).gap(8).border_b(1).border_color(t.border)
        .child(h_flex().gap(8).items_center().child(div().text_size(13).font_semibold().text_color(t.foreground).child("S++")).child(needed).child(div().flex_1()).child(actions))
        .child(h_flex().gap(8).items_center().child(chips).child(div().flex_1()).child(fresh));
    }
    return h_flex().h(48).flex_none().px(20).gap(16).items_center().border_b(1).border_color(t.border)
      .child(div().flex_none().text_size(13.5).font_semibold().text_color(t.foreground).child("S++"))
      .child(div().flex_1().min_w(0).overflow_hidden().child(chips))
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
      })
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(11.5).font_semibold().text_color(t.blocked).child(need.label))
        .child(div().flex_1())
        .when(need.since !== null, (el) => el.child(div().text_size(11).font_family(MONO).text_color(t.dim).child(M.ago(need.since, now)))))
      .child(div().w_full().text_size(14).text_color(t.foreground).child(need.text))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(`${job.area[0]} › ${job.repoShort} · ${job.title}`))
        .when(Boolean(this.dashboard), (el) => el.child(this.button(t, `answer-${need.key}`, "Answer in dashboard", (cx) => this.openDashboard(cx), { strong: true, tip: "Answering happens in the S++ dashboard" }))));
  }

  jobRow(t, job, now) {
    const on = job.id === this.selected;
    const compact = this.role === "panel";
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

  // The way to a participating terminal: only a verified binding that herdr-core lists as live.
  // Without one, a last known location is shown as words, never as a way to a terminal.
  reach(t, bindings, place, now, key) {
    if (bindings.length) {
      return h_flex().gap(6).items_center().flex_wrap().children(bindings.map((b, i) => b.live
        ? this.button(t, `go-${key}-${i}`, `Go to ${b.role}`, () => run("agent.focus", { terminal: b.address }), { strong: true, glyph: "terminal", tip: `${b.address}${b.attempt ? ` · attempt ${b.attempt}` : ""}` })
        : div().text_size(11.5).text_color(t.dim).child(`${b.role} terminal ${b.address} is not running`)));
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
      .child(h_flex().gap(10).items_center()
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
      .when(job.needs.length > 0, (el) => el.child(v_flex().gap(8).children(job.needs.map((need) => v_flex().px(12).py(10).gap(5).rounded(8).bg(tint(t.blocked, "10")).border_l(3).border_color(t.blocked)
        .child(h_flex().gap(8).child(div().text_size(11.5).font_semibold().text_color(t.blocked).child(need.label)).child(div().flex_1()).when(need.since !== null, (row) => row.child(div().text_size(11).font_family(MONO).text_color(t.dim).child(M.ago(need.since, now)))))
        .child(div().w_full().text_size(13.5).text_color(t.foreground).child(need.text))
        .when(Boolean(this.dashboard), (row) => row.child(h_flex().child(this.button(t, `detail-answer-${need.key}`, "Answer in dashboard", (cx) => this.openDashboard(cx), { strong: true }))))))))
      .when(job.bumps.length > 0, (el) => el.child(v_flex().gap(4).children(job.bumps.map((bump) => h_flex().gap(8).items_center().text_size(12.5).text_color(t.foreground)
        .child(div().size(6).flex_none().rounded(1.5).bg(t.working)).child(div().flex_1().min_w(0).child(bump))))))
      .when(job.counts.total === 0, (el) => el.child(div().text_size(12.5).text_color(t.dim).child("No packages yet.")))
      .children([
        ...part("Now", sections.now),
        ...part("Up next", sections.next),
        ...part("Landed", done, sections.done.length > done.length ? div().pl(17).text_size(11.5).text_color(t.dim).child(`and ${sections.done.length - done.length} earlier`) : null),
      ])
      .when(Boolean(this.dashboard), (el) => el.child(h_flex().pt(4).gap(8).items_center()
        .child(div().flex_1().text_size(11.5).text_color(t.dim).child("Answers, closing and archiving happen in the dashboard."))
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
    const scope = scopes.find((s) => s.key === this.scopeKey) ?? scopes[0];
    const jobs = M.applyScope(board.jobs, scope, this.repoTopics);
    this.scoped = jobs;
    this.order = M.selectableJobs(jobs);
    this.selected = M.pickSelection(jobs, this.selected);
    const needs = M.needsOf(board.jobs);
    const job = jobs.find((j) => j.id === this.selected) ?? null;
    const bindings = M.verifiedBindings(this.givenBindings ?? shared(BINDINGS_KEY), terminals());
    const top = [this.header(t, scopes, scope, board.jobs, now), this.staleBar(t, now)];

    if (this.role === "panel") {
      if (this.detail && job) {
        return this.root(t, [...top,
          h_flex().px(8).pt(8).flex_none().child(this.button(t, "back", "All jobs", (cx) => { this.detail = false; cx.notify(); }, { glyph: "chevron-left" })),
          v_flex().id("lens-panel-detail").flex_1().min_h(0).overflow_y_scrollbar().mode("hover").child(this.detailCard(t, job, bindings, now)),
        ]);
      }
      return this.root(t, [...top, this.list(t, jobs, needs, now)]);
    }

    return this.root(t, [...top,
      h_flex().flex_1().min_h(0)
        .child(this.list(t, jobs, needs, now))
        .child(div().w(460).flex_none().h_full().p(10).pl(0)
          .child(v_flex().id("lens-detail").size_full().rounded(10).border(1).border_color(t.border).bg(t.surface).overflow_y_scrollbar().mode("hover")
            .child(job ? this.detailCard(t, job, bindings, now) : this.message(t, "No job selected", "Pick a job on the left to follow it.")))),
    ]);
  }
}

function cap(text) {
  const value = String(text);
  return value.charAt(0).toUpperCase() + value.slice(1);
}
