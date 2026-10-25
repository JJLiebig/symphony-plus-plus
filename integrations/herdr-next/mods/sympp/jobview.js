// The Job level: one job as a whole view. Its phase, a strip of only what needs the person, package
// rails on one real-time axis, the agents taking part and its recorded decisions. Wide views draw the
// rails with agents and decisions beside them; narrow ones stack a compact line per package.
//
// Review drill-down hook: once the view defines openReview(jobId, pkgId, round, cx), round chips
// become buttons that call it. Until then they are plain marks.

import { div } from "gpui-kit";
import { v_flex, h_flex, Button } from "gpui-base";
import * as M from "./model.js";
import * as J from "./job.js";
import * as R from "./rails.js";
import { CLEAR, MONO, tint, cap, button, field, mark, pip, presence, section, age } from "./ui.js";

const LABEL_W = 236;
const TIME_CELL = 54;
const TIME_GAP = 6;
const TIME_W = 3 * TIME_CELL + 2 * TIME_GAP;
const pct = (x) => `${(Math.max(0, Math.min(1, x)) * 100).toFixed(3)}%`;

// ctx: { now, bindings, terminals, layout: "wide" | "compact", place: "full" | "side" | "tab", offline }
export function jobView(v, t, job, ctx) {
  const people = J.participants(job, ctx.bindings, v.agentChecks, ctx.now);
  const head = [jobHeader(v, t, job, ctx), phaseStrip(t, J.phaseOf(job), ctx)];
  const work = [...attention(v, t, job, ctx), ...questions(v, t, job), packages(v, t, job, ctx)];
  const aside = [agents(v, t, job, people, ctx), decisions(v, t, job, ctx)];
  if (ctx.layout === "wide") {
    return v_flex().id("job-view").flex_1().min_h(0).min_w(0)
      .child(v_flex().flex_none().px(20).pt(14).pb(12).gap(12).border_b(1).border_color(t.border).children(head))
      .child(h_flex().flex_1().min_h(0).items_start()
        .child(v_flex().id("job-work").flex_1().min_w(0).h_full().px(16).pb(24).overflow_y_scrollbar().mode("hover").children(work))
        .child(v_flex().id("job-aside").w(272).flex_none().h_full().px(16).pb(24).border_l(1).border_color(t.border).overflow_y_scrollbar().mode("hover").children(aside)));
  }
  return v_flex().id(`job-view-${ctx.place}`).flex_1().min_h(0).min_w(0).overflow_y_scrollbar().mode("hover")
    .child(v_flex().flex_none().px(ctx.place === "side" ? 16 : 14).pt(14).pb(24).gap(12)
      .children(head)
      .child(v_flex().children([...work, ...aside])));
}

function jobHeader(v, t, job, ctx) {
  const now = ctx.now;
  const brief = job.report.brief;
  const pinned = ctx.place === "tab";
  const where = `${job.area.join(" › ")} · ${job.repoShort}`;
  const actions = h_flex().gap(4).items_center().flex_none()
    .when(!pinned, (el) => el.child(button(t, "open-tab", "Open in tab", (cx) => v.openInTab(job, cx), { strong: true, tip: "Open this job in its own tab (T)" })))
    .when(ctx.place !== "side", (el) => el
      .child(button(t, "job-refresh", "Refresh", (cx) => v.retry(cx), { tip: "Read S++ now (R)" }))
      .when(Boolean(v.dashboard), (row) => row.child(button(t, "job-dashboard", "Dashboard", (cx) => v.openDashboard(cx), { tip: "Open the S++ dashboard (O)" }))));
  const stale = M.isStale(v.net, now);
  return v_flex().gap(6)
    .child(h_flex().gap(10).items_center().flex_wrap()
      .when(ctx.place === "full", (el) => el.child(button(t, "back", "All jobs", (cx) => v.leaveJob(cx), { glyph: "chevron-left", tip: "Back to all jobs (Esc)" })))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(where))
      .when(ctx.offline, (el) => el.child(div().flex_none().text_size(11.5).text_color(t.muted).child("Offline copy")))
      .when(ctx.place !== "side", (el) => el.child(age(t, `${stale ? "Last read" : "Read"} ${M.ago(v.net.receivedAt, now)}`, stale ? t.blocked : t.dim)))
      .child(actions))
    .child(div().w_full().text_size(ctx.place === "side" ? 16 : 19).font_semibold().text_color(t.foreground).child(job.title))
    .child(h_flex().gap(10).items_center().flex_wrap()
      .child(h_flex().gap(6).items_center().child(mark(t, job.verdict))
        .child(div().text_size(12).font_medium().text_color(job.verdict === "needs_you" ? t.blocked : t.foreground).child(M.VERDICT_LABEL[job.verdict])))
      .when(job.offPrimary, (el) => el.child(div().text_size(11).font_family(MONO).text_color(t.muted).child(`→ ${job.baseBranch}`)))
      .child(div().text_size(11.5).text_color(t.muted).child(`opened ${M.ago(job.createdAt, now)}`))
      .when(Boolean(job.report.eta), (el) => el.child(div().text_size(11.5).text_color(t.muted).child(`ETA from the architect: ${job.report.eta.text}`))))
    .child(div().w_full().max_w(760).text_size(13).text_color(brief ? t.foreground : t.muted).child(job.brief))
    .when(Boolean(brief), (el) => el.child(div().text_size(11).text_color(t.muted).child(`Architect · ${M.ago(brief.at, now)}`)))
    .when(Boolean(job.report.parked), (el) => el.child(div().text_size(12).text_color(t.muted).child(`Parked ${M.ago(job.report.parked.at, now)}: ${job.report.parked.text}`)));
}

// Five fixed segments; the current one is the only accent. Past phases stay legible, future ones dim.
function phaseStrip(t, phase, ctx) {
  const at = J.PHASES.findIndex(([key]) => key === phase);
  return h_flex().id("phase-strip").gap(4).w_full().when(ctx.layout === "wide", (el) => el.max_w(720))
    .accessibility_label(at < 0 ? "Phase unknown" : `Phase: ${J.PHASES[at][1]}`)
    .children(J.PHASES.map(([key, label], i) => {
      const current = i === at;
      const past = at >= 0 && i < at;
      const done = phase === "done";
      return v_flex().id(`phase-${key}`).flex_1().min_w(0).gap(5)
        .child(div().h(3).w_full().rounded(2).bg(done ? t.ansi2 : current ? t.accent : past ? t.muted : t.border))
        .child(div().truncate().text_size(11.5).font_medium().text_color(current ? t.foreground : past ? t.muted : t.dim).when(current, (el) => el.font_semibold()).child(label));
    }));
}

// ---------- What needs the person ----------

// One compact line per thing only the person can move, above the rails. Answers open in place.
function attention(v, t, job, ctx) {
  if (!job.needs.length) return [];
  const titles = new Map(job.packages.map((pkg) => [pkg.id, pkg.title]));
  return [
    section(t, "Needs you", job.needs.length, t.blocked),
    v_flex().id("attention-strip").gap(6).children(job.needs.map((need) => {
      const question = need.id ? job.guidance.find((q) => q.key === need.key) : null;
      const open = question && v.answers[question.key]?.open;
      const action = question ? button(t, `need-answer-${need.key}`, "Answer", (cx) => v.openAnswer(question, cx), { strong: true })
        : need.pkgId ? button(t, `need-show-${need.key}`, "Show", (cx) => v.selectPackage(need.pkgId, cx), { strong: true })
        : v.dashboard ? button(t, `need-dashboard-${need.key}`, "Answer in dashboard", (cx) => v.openDashboard(cx), { strong: true }) : null;
      return v_flex().id(`need-${need.key}`).px(12).py(8).gap(6).rounded(6).bg(tint(t.blocked, "12"))
        .child(h_flex().gap(10).items_center().min_w(0)
          .child(mark(t, "needs_you"))
          .child(div().flex_none().text_size(11.5).font_semibold().text_color(t.blocked).child(need.label))
          .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(need.text))
          .when(Boolean(need.pkgId && titles.get(need.pkgId)), (el) => el.child(div().flex_none().max_w(180).truncate().text_size(11.5).text_color(t.muted).child(titles.get(need.pkgId))))
          .when(need.since !== null, (el) => el.child(age(t, M.ago(need.since, ctx.now))))
          .when(Boolean(action) && !open, (el) => el.child(action)))
        .when(Boolean(open), (el) => el.child(questionRow(v, t, question, true)));
    })),
  ];
}

function questions(v, t, job) {
  if (!job.questions.length) return [];
  const isOpen = (q) => q.status === "open" || q.status === "human_info_needed";
  const ordered = [...job.questions.filter(isOpen), ...job.questions.filter((q) => !isOpen(q))];
  return [section(t, "Questions", job.questions.filter(isOpen).length || null), v_flex().children(ordered.map((q, i) => questionRow(v, t, q, i === 0)))];
}

export function questionRow(v, t, question, first = false) {
  const draft = v.answers[question.key];
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
  return v_flex().id(`question-${question.key}`).gap(8).py(10).when(!first, (el) => el.border_t(1).border_color(t.border))
    .child(div().text_size(13.5).font_medium().text_color(open ? t.foreground : t.muted).child(question.text))
    .when(Boolean(question.context) && open, (el) => el.child(div().text_size(12).text_color(t.muted).child(question.context)))
    .when(!open, (el) => el.child(div().text_size(12).text_color(t.muted).child(question.answer || cap(question.status || "Closed"))))
    .when(open && !draft?.open, (el) => el.child(h_flex().child(draft?.saved
      ? div().text_size(12).text_color(t.muted).child("Answer saved · refreshing…")
      : button(t, `answer-${question.key}`, "Answer", (cx) => v.openAnswer(question, cx), { strong: true }))))
    .when(open && Boolean(draft?.open), (el) => el.child(v_flex().gap(8)
      .when(Boolean(prompt), (form) => form
        .child(div().text_size(13).font_medium().child(prompt.tl_dr))
        .child(div().text_size(12).text_color(t.muted).child(prompt.details))
        .children((prompt.options ?? []).map((o) => option(o.id, o.label, o.description, o.pros, o.cons, o.answer)))
        .child(option("__custom_redirect__", prompt.custom_redirect_label || "Another direction")))
      .child(field(t, prompt ? draft.choice === "__custom_redirect__" ? "Your direction" : "Note (optional)" : "Your answer", draft.input, true))
      .when(Boolean(draft.error), (form) => form.child(div().role("alert").text_size(12).text_color(t.blocked).child(draft.error)))
      .child(h_flex().gap(8).flex_wrap()
        .child(button(t, `save-${question.key}`, draft.pending ? "Saving…" : "Save answer", (cx) => v.saveAnswer(question, cx), { strong: true, disabled: draft.pending }))
        .child(button(t, `cancel-${question.key}`, "Back", (cx) => { draft.open = false; v.keys.focus(); cx.notify(); }, { disabled: draft.pending })))));
}

// ---------- Package rails ----------

// Who is acting is the color; waiting is the same color, dimmed. Shapes repeat it for color-blind reading.
function actorColor(t, actor) {
  return { provider: t.accent, ci: t.ansi6, human: t.blocked, waiting: t.dim, dependency: t.dim }[actor] ?? t.dim;
}

function packages(v, t, job, ctx) {
  if (!job.packages.length) {
    return v_flex().child(section(t, "Packages")).child(div().px(4).text_size(12.5).text_color(t.muted)
      .child(job.closedAt !== null ? "Closed without packages." : "Not sliced into packages yet."));
  }
  const rows = R.rowsOf(job, ctx.now);
  const reportOf = (pkg) => J.reportFor(M.bindingsFor(ctx.bindings, job.id, pkg.id), ctx.terminals, ctx.now);
  if (ctx.layout === "wide") {
    const axis = R.railAxis(rows, ctx.now);
    return v_flex().id("rails")
      .child(h_flex().gap(12).items_center().child(section(t, "Packages", job.packages.length)).child(div().flex_1()).child(legend(t)))
      .child(axisHeader(t, axis, ctx))
      .children(rows.flatMap((row) => railRow(v, t, job, row, axis, reportOf(row.pkg), ctx)));
  }
  return v_flex().id("rails-compact")
    .child(section(t, "Packages", job.packages.length))
    .children(rows.map((row) => compactRow(v, t, job, row, reportOf(row.pkg), ctx)));
}

function legend(t) {
  const swatch = (label, color, dim = false) => h_flex().gap(5).items_center()
    .child(div().w(12).h(6).rounded(2).bg(dim ? tint(color, "45") : color))
    .child(div().text_size(11).text_color(t.muted).child(label));
  return h_flex().id("rail-legend").pt(12).gap(12).items_center().flex_wrap()
    .child(swatch("Agent", t.accent)).child(swatch("CI", t.ansi6)).child(swatch("You", t.blocked)).child(swatch("Waiting", t.dim, true))
    .child(h_flex().gap(5).items_center().child(div().w(12).h(0).border_t(1.5).border_dashed().border_color(t.muted)).child(div().text_size(11).text_color(t.muted).child("After another package")));
}

function axisHeader(t, axis, ctx) {
  const marks = R.axisLabels(axis, ctx.now).map((label) => label.kind === "now"
    ? div().absolute().left(pct(label.x)).top(0).h(18).pl(4).border_l(1).border_color(t.accent).text_size(10.5).font_family(MONO).text_color(t.accent).child(label.text)
    : label.kind === "break"
      ? div().id(`axis-break-${label.from}`).absolute().left(pct(label.x)).top(0).text_size(10.5).font_family(MONO).text_color(t.muted).tooltip(label.tip).child(label.text)
      : div().absolute().left(pct(label.x)).top(0).text_size(10.5).font_family(MONO).text_color(t.dim).child(label.text));
  return h_flex().id("rail-axis").gap(12).px(8).pb(4).items_end()
    .child(div().w(LABEL_W).flex_none())
    .child(div().relative().flex_1().min_w(0).h(18).children(marks))
    .child(h_flex().w(TIME_W).flex_none().gap(TIME_GAP).text_size(10.5)
      .child(cell(t, "total", t.dim)).child(cell(t, "stage", t.dim)).child(cell(t, "review", t.dim)));
}

// One right-aligned timing column, so numbers line up down the rails.
function cell(t, text, tone) {
  return div().w(TIME_CELL).flex_none().flex().justify_end().text_color(tone).child(text);
}

function chips(v, t, job, pkg, rounds) {
  if (!rounds.length) return null;
  const hook = typeof v.openReview === "function";
  return h_flex().gap(3).flex_none().children(rounds.map((r) => {
    const tone = r.late ? t.working : t.muted;
    const chip = (hook ? Button.new(`round-${pkg.id}-${r.n}`).cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); v.openReview(job.id, pkg.id, r.n, cx); })
      : div().id(`round-${pkg.id}-${r.n}`))
      .h(16).px(4).rounded(3).border(1).border_color(r.current ? tone : tint(tone, "60")).bg(r.current ? tint(tone, "22") : CLEAR)
      .text_size(10).font_family(MONO).text_color(r.late ? t.working : r.current ? t.foreground : t.muted)
      .accessibility_label(r.tip)
      .tooltip(r.tip)
      .child(r.label);
    return chip;
  }));
}

function timings(row) {
  const { total, stage, review } = row.timings;
  return [total ?? "—", stage ?? "—", review ?? "—"];
}

function railRow(v, t, job, row, axis, report, ctx) {
  const { pkg } = row;
  const on = v.pkgSel === pkg.id;
  const focused = on && v.keys.is_focused();
  const c = J.packageCard(pkg, report, ctx.now);
  const stageName = R.STAGE_NAME[R.stageOf(pkg)] ?? cap(pkg.stage);
  const sub = [pkg.stage === "done" ? M.stageText(pkg, ctx.now) : stageName, c.holder?.text,
    c.after.length ? `after ${c.after.join(", ")}` : null,
    pkg.stage !== "done" && pkg.stage !== "queued" && R.stageEntry(pkg) === null ? "start not recorded" : null].filter(Boolean).join(" · ");
  const before = R.beforeAxis(row, axis);
  const marks = before ? [] : [div().absolute().left(0).top(11).w_full().h(1).bg(tint(t.border, "80"))];
  if (before) {
    marks.push(div().absolute().left(0).top(4).text_size(11).text_color(t.dim).child(pkg.doneAt !== null ? `Landed ${M.ago(pkg.doneAt, ctx.now)}` : "Before this view"));
  } else if (axis) {
    for (const gap of axis.breaks) marks.push(div().absolute().left(pct(gap.x0)).w(pct(gap.x1 - gap.x0)).top(2).h(20).border_l(1).border_r(1).border_dashed().border_color(t.border));
    for (const s of row.segments) {
      if (s.to <= axis.start) continue;
      const x0 = axis.x(Math.max(s.from, axis.start));
      const w = Math.max(axis.x(s.to) - x0, 0.004);
      const color = actorColor(t, s.actor);
      const tip = `${R.STAGE_NAME[s.stage]}${s.label ? ` · ${s.label}` : ""} · ${M.span(s.to - s.from)}${s.waiting && s.actor !== "waiting" ? " · waiting" : ""}`;
      marks.push(s.actor === "dependency"
        ? div().id(`seg-${pkg.id}-${s.from}`).absolute().left(pct(x0)).w(pct(w)).top(6).h(12).tooltip(tip)
          .child(div().absolute().left(0).top(5).w_full().h(0).border_t(1.5).border_dashed().border_color(t.muted))
        : div().id(`seg-${pkg.id}-${s.from}`).absolute().left(pct(x0)).w(pct(w)).top(8).h(8).rounded(2)
          .bg(s.waiting ? tint(color, "45") : color).border_r(1).border_color(t.canvas).tooltip(tip));
      // Needs the person, but since when was not recorded: a "You" cap at now, not a guessed span.
      if (s.needsYou) marks.push(div().absolute().left(pct(axis.nowX)).top(6).w(4).h(12).rounded(1).bg(t.blocked));
    }
    // Each later review round starts at its recorded moment.
    for (const r of row.rounds) {
      if (r.n > 1 && r.startedAt !== null && r.startedAt >= axis.start) {
        marks.push(div().id(`tick-${pkg.id}-${r.n}`).absolute().left(pct(axis.x(r.startedAt))).top(4).w(2).h(16).rounded(1)
          .bg(r.late ? t.working : tint(t.foreground, "70")).tooltip(r.tip));
      }
    }
    if (pkg.doneAt !== null && pkg.doneAt >= axis.start) marks.push(div().absolute().left(pct(axis.x(pkg.doneAt))).top(7).size(10).rounded(5).bg(pkg.outcome === "dropped" ? t.dim : t.ansi2));
    marks.push(div().absolute().left(pct(axis.nowX)).top(0).h(24).w(1).bg(tint(t.accent, "90")));
  }
  const [total, stage, review] = timings(row);
  const rowEl = h_flex().id(`rail-${pkg.id}`).h(46).px(8).gap(12).items_center().rounded(6).cursor_pointer()
    .bg(c.needsYou ? tint(t.blocked, "0c") : on ? t.selected : CLEAR)
    .border(1).border_color(focused ? t.ring : on ? t.accent : CLEAR)
    .hover((s) => s.bg(on ? t.selected : t.hover))
    .accessibility_label(`${pkg.title}, ${sub}. Total ${total}, in stage ${stage}, in review ${review}`)
    .on_click((_e, cx) => v.selectPackage(pkg.id, cx))
    .child(v_flex().w(LABEL_W).flex_none().min_w(0).gap(3)
      .child(h_flex().gap(7).items_center().min_w(0)
        .child(pip(t, pkg))
        .child(div().id(`title-${pkg.id}`).flex_1().min_w(0).truncate().text_size(12.5).font_medium().text_color(pkg.stage === "done" || pkg.stage === "queued" ? t.muted : t.foreground).tooltip(pkg.title).child(pkg.title))
        .children([chips(v, t, job, pkg, row.rounds)].filter(Boolean)))
      .child(div().pl(14).truncate().text_size(11).text_color(c.needsYou ? t.blocked : c.report ? reportTone(t, c.report) : t.muted)
        .child(c.needsYou && c.next ? `Next: ${c.next}` : c.report ? `${stageName} · ${J.reportText(c.report)}` : sub)))
    .child(div().id(`track-${pkg.id}`).relative().flex_1().min_w(0).h(24).children(marks))
    .child(h_flex().w(TIME_W).flex_none().gap(TIME_GAP).text_size(11).font_family(MONO)
      .child(cell(t, total, row.timings.total ? t.foreground : t.dim))
      .child(cell(t, stage, row.timings.stage ? t.muted : t.dim))
      .child(cell(t, review, row.timings.review ? t.muted : t.dim)));
  return on ? [rowEl, rowDetail(t, pkg, c)] : [rowEl];
}

// The opened row: everything the row line had no room for, in plain words.
function rowDetail(t, pkg, c) {
  const line = (text, tone = t.muted, extra = (el) => el) => (text ? extra(div().w_full().text_size(11.5).text_color(tone).child(text)) : null);
  return v_flex().id(`detail-${pkg.id}`).pl(LABEL_W + 20).pr(TIME_W).pt(2).pb(10).gap(3).children([
    line(c.stage, c.failed ? t.blocked : t.muted, (el) => el.font_family(MONO).text_size(11)),
    c.holder ? line(`${c.holder.text}${c.holder.observation ? ` · ${c.holder.observation}` : ""}`, c.holder.observation ? t.muted : t.foreground) : null,
    line(J.reportText(c.report), reportTone(t, c.report), (el) => el.id(`report-${pkg.id}`).tooltip("The agent's own status report")),
    line(c.waiting),
    line(c.next ? `Next: ${c.next}` : null, c.needsYou ? t.blocked : t.muted),
    line(c.evidence.join(" · ")),
    c.after.length ? line(`After ${c.after.join(", ")}`) : null,
  ].filter(Boolean));
}

function reportTone(t, report) {
  if (!report) return t.muted;
  if (report.status === "blocked" || report.status === "error") return t.blocked;
  return report.status === "working" ? t.foreground : t.muted;
}

// Narrow and panel widths: one compact line per package with the same timings, no axis.
function compactRow(v, t, job, row, report, ctx) {
  const { pkg } = row;
  const on = v.pkgSel === pkg.id;
  const focused = on && v.keys.is_focused();
  const c = J.packageCard(pkg, report, ctx.now);
  const stageName = pkg.stage === "done" ? M.stageText(pkg, ctx.now) : R.STAGE_NAME[R.stageOf(pkg)] ?? cap(pkg.stage);
  const { total, stage, review } = row.timings;
  const times = [stageName, stage ? `${stage} in stage` : pkg.stage !== "done" && pkg.stage !== "queued" ? "start not recorded" : null,
    review ? `${review} in review` : null, total ? `${total} total` : null].filter(Boolean).join(" · ");
  const status = report ? J.reportText(report) : c.needsYou && c.next ? `Next: ${c.next}` : c.after.length ? `After ${c.after.join(", ")}` : c.waiting ?? c.holder?.text ?? null;
  return v_flex().id(`rail-${pkg.id}`).px(10).py(8).gap(4).rounded(6).cursor_pointer()
    .bg(c.needsYou ? tint(t.blocked, "0c") : on ? t.selected : CLEAR)
    .border(1).border_color(focused ? t.ring : on ? t.accent : CLEAR)
    .hover((s) => s.bg(on ? t.selected : t.hover))
    .on_click((_e, cx) => v.selectPackage(pkg.id, cx))
    .child(h_flex().gap(7).items_center().min_w(0)
      .child(pip(t, pkg))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_medium().text_color(pkg.stage === "done" || pkg.stage === "queued" ? t.muted : t.foreground).child(pkg.title))
      .children([chips(v, t, job, pkg, row.rounds)].filter(Boolean)))
    .child(div().pl(14).text_size(11).font_family(MONO).text_color(t.muted).child(times))
    .when(Boolean(status), (el) => el.child(div().pl(14).truncate().text_size(11.5).text_color(report ? reportTone(t, report) : c.needsYou ? t.blocked : t.muted).child(status)))
    .when(on, (el) => el.child(v_flex().pl(14).gap(3).children([
      c.holder ? div().text_size(11.5).text_color(t.muted).child(`${c.holder.text}${c.holder.observation ? ` · ${c.holder.observation}` : ""}`) : null,
      c.waiting ? div().text_size(11.5).text_color(t.muted).child(c.waiting) : null,
      c.next ? div().text_size(11.5).text_color(c.needsYou ? t.blocked : t.muted).child(`Next: ${c.next}`) : null,
      c.evidence.length ? div().text_size(11.5).text_color(t.muted).child(c.evidence.join(" · ")) : null,
    ].filter(Boolean))));
}

// ---------- Agents and decisions ----------

function agents(v, t, job, people, ctx) {
  const rows = people.map((p) => {
    const action = p.binding ? v.jumps[p.binding.address] : null;
    const state = p.state === "live" ? "Live"
      : p.state === "seen" ? `Last seen${p.where ? ` ${p.where}` : ""}${p.at ? ` · ${M.ago(p.at, ctx.now)}` : ""}`
      : p.state === "provider" ? (p.reviewing ? `Reviewing ${p.reviewing}` : "Not reviewing now") : "Unknown";
    const who = [p.provider, p.name && p.name !== p.provider ? p.name : null, p.attempt ? `attempt ${p.attempt}` : null].filter(Boolean).join(" · ");
    return h_flex().id(`agent-${p.key}`).gap(10).py(7).px(6).rounded(6).items_start()
      .when(Boolean(p.pkgId) && v.pkgSel === p.pkgId, (el) => el.bg(t.selected))
      .child(div().pt(5).flex_none().child(presence(t, p.state)))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().gap(6).items_center().min_w(0)
          .child(div().flex_none().text_size(12.5).font_medium().text_color(t.foreground).child(p.role))
          .when(Boolean(p.subject), (el) => el.child(div().min_w(0).truncate().text_size(12).text_color(t.muted).child(p.subject))))
        .when(Boolean(who), (el) => el.child(div().truncate().text_size(11.5).text_color(t.muted).child(who)))
        .child(div().text_size(11.5).text_color(p.state === "live" ? t.foreground : t.muted).child(state))
        .when(Boolean(action?.error), (el) => el.child(div().role("alert").text_size(11.5).text_color(t.blocked).child(action.error))))
      .when(p.state === "live" && !ctx.offline, (el) => el.child(button(t, `open-${p.key}`, action?.pending ? "Checking…" : "Open", (cx) => v.focusAgent(p.binding, cx),
        { strong: true, glyph: "terminal", tip: `Open the ${p.role.toLowerCase()} terminal`, disabled: Boolean(action?.pending) })));
  });
  return v_flex().id("job-agents")
    .child(section(t, "Agents", null))
    .when(ctx.offline, (el) => el.child(div().pb(4).text_size(11.5).text_color(t.muted).child("Offline copy · no agent access")))
    .children(rows);
}

function decisions(v, t, job, ctx) {
  const net = v.detailNet.jobId === job.id ? v.detailNet : null;
  const list = net?.data ?? null;
  const stale = Boolean(net?.error && list);
  let body;
  if (!list && (!net || !net.error)) body = [div().text_size(12).text_color(t.muted).child("Reading decisions…")];
  else if (!list) body = [div().text_size(12).text_color(t.muted).child(net.error)];
  else if (!list.length) body = [div().text_size(12).text_color(t.muted).child("No decisions recorded.")];
  else body = list.map((d, i) => v_flex().id(`decision-${d.id}`).gap(3).py(8).when(i > 0, (el) => el.border_t(1).border_color(t.border))
    .child(div().w_full().text_size(12.5).text_color(t.foreground).child(d.text))
    .when(Boolean(d.rationale), (el) => el.child(div().w_full().text_size(11.5).text_color(t.muted).child(d.rationale)))
    .when(Boolean(d.impact), (el) => el.child(div().w_full().text_size(11.5).text_color(t.muted).child(`Scope: ${d.impact}`)))
    .child(age(t, [d.by, d.at ? M.ago(d.at, ctx.now) : null].filter(Boolean).join(" · "), t.dim)));
  return v_flex().id("job-decisions")
    .child(h_flex().gap(8).items_center().child(section(t, "Decisions", list?.length || null))
      .when(stale, (el) => el.child(div().pt(12).text_size(11).text_color(t.blocked).child(`From ${M.ago(net.receivedAt, ctx.now)}`))))
    .children(body);
}
