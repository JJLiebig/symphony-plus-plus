// The redesigned Topic/Space view and task drill-in ("Track"), behind the scratch-only `lens` prop,
// drawn in the web dashboard's visual language: Geist with Geist Mono for figures and labels, the
// dashboard's stage colours, square package pips, and its orange for what needs the person.
// Topic and Space draw the same view; a space only narrows the tasks. Words appear only when
// something went wrong, and the person's questions come first with an Answer each.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Button } from "gpui-base";
import { settings } from "herdr";
import * as M from "./model.js";
import * as J from "./job.js";
import * as R from "./rails.js";
import * as St from "./studio.js";
import * as S from "./scope.js";
import * as O from "./overview.js";
import { questionRow, reviewPane } from "./jobview.js";
import { CLEAR, icon, tint } from "./ui.js";

const SANS = "Geist";
const MONO = "Geist Mono";

// The dashboard's signal colours (elixir/assets/src/fresh/fresh.css), with deeper twins for light themes.
const DARK = { build: "#6ea8fe", checks: "#e5b454", review: "#b794f6", merge: "#7bd88f", you: "#ff7a45", fail: "#ff5c6c" };
const LIGHT = { build: "#2563eb", checks: "#b7791f", review: "#7c3aed", merge: "#15803d", you: "#ea580c", fail: "#dc2626" };
const signal = () => (settings()?.dark === false ? LIGHT : DARK);

const pct = (x) => `${(Math.max(0, Math.min(1, x)) * 100).toFixed(3)}%`;

// Red for failures, the checks amber for trouble that isn't one, faint for missing evidence.
const issueTone = (t, tone) => (tone === "fail" ? signal().fail : tone === "warn" ? signal().checks : t.dim);

// GPUI has no letter-spacing; the dashboard's tracked capitals are set with hair spaces instead.
const tracked = (text) => text.toUpperCase().split("").join(" ");

function micro(t, text, color, id = null) {
  const el = div().flex_none().text_size(10).font_family(SANS).font_semibold().text_color(color).accessibility_label(text).child(tracked(text));
  return id ? el.id(id) : el;
}

const mono = (size, color) => div().flex_none().font_family(MONO).text_size(size).text_color(color);

// ---------- Controls ----------

// The dashboard's quiet buttons: no border, dim until hovered.
function ghost(t, id, label, action, { glyph = null, tip = null, tone = null, strong = false, disabled = false } = {}) {
  return Button.new(id).flex().flex_none().items_center().gap(6).h(24).px(8).rounded(5).cursor_pointer()
    .font_family(SANS).text_size(12).font_medium()
    .bg(strong ? tint(t.foreground, "14") : CLEAR).text_color(tone ?? (strong ? t.foreground : t.muted))
    .hover((s) => s.bg(tint(t.foreground, "1a")).text_color(t.foreground))
    .focus((s) => s.border(1).border_color(t.accent))
    .disabled(disabled).when(disabled, (el) => el.opacity(0.45))
    .accessibility_label(tip ?? label).when(Boolean(tip), (el) => el.tooltip(tip))
    .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
    .when(Boolean(glyph), (el) => el.child(svg(icon(glyph)).size(12).flex_none()))
    .when(Boolean(label), (el) => el.child(label));
}

function glyphButton(t, id, glyph, tip, action, { on = false } = {}) {
  return Button.new(id).flex().flex_none().items_center().justify_center().size(26).rounded(6).cursor_pointer()
    .bg(on ? tint(t.foreground, "14") : CLEAR).text_color(on ? t.foreground : t.dim)
    .hover((s) => s.bg(tint(t.foreground, "14")).text_color(t.foreground))
    .focus((s) => s.border(1).border_color(t.accent))
    .accessibility_label(tip).tooltip(tip)
    .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
    .child(svg(icon(glyph)).size(14).flex_none());
}

// Answer: the person's colour, tinted, so it reads as theirs without shouting.
function answerButton(t, id, action, tip) {
  const you = signal().you;
  return Button.new(id).flex().flex_none().items_center().h(24).px(10).rounded(5).cursor_pointer()
    .font_family(SANS).text_size(12).font_semibold().text_color(you).bg(tint(you, "1f"))
    .hover((s) => s.bg(tint(you, "33")))
    .focus((s) => s.border(1).border_color(you))
    .accessibility_label(tip).tooltip(tip)
    .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
    .child("Answer");
}

// ---------- Shared ----------

function reach(v, t, el, key, open, label) {
  const on = v.row(key, open);
  return el.cursor_pointer().rounded(6).bg(on ? tint(t.foreground, "10") : CLEAR).border(1).border_color(on ? tint(t.accent, "80") : CLEAR)
    .hover((s) => s.bg(tint(t.foreground, on ? "10" : "08")))
    .accessibility_label(label)
    .on_click((_e, cx) => open(cx));
}

function bar(v, t, title, now, { create = true } = {}) {
  return h_flex().id("lens-bar").flex_none().h(44).px(v.compact ? 8 : 16).gap(4).items_center()
    .bg(tint(t.foreground, "05")).border_b(1).border_color(tint(t.foreground, "12"))
    .child(glyphButton(t, "lens-back", "chevron-left", "Back (Esc)", (cx) => v.goUp(cx)))
    .child(div().flex_1().min_w(0).pl(2).truncate().font_family(SANS).text_size(13.5).font_semibold().text_color(t.foreground).child(title))
    .child(O.status(v, t, now))
    .when(create, (el) => el.child(glyphButton(t, "new-job", "plus", "New task", (cx) => v.openIntake(cx))))
    .when(v.role === "panel", (el) => el.child(glyphButton(t, "pin", v.pin ? "pin-off" : "pin",
      v.pin ? "Follow Herdr's focus again (P)" : "Stay here instead of following focus (P)", (cx) => v.togglePin(cx), { on: v.pin })));
}

function body(v, id, rows, width) {
  return v_flex().id(id).flex_1().min_h(0).overflow_y_scrollbar().mode("hover")
    .child(h_flex().w_full().justify_center()
      .child(v_flex().w_full().max_w(v.compact ? 10000 : width).px(v.compact ? 8 : 20).pt(v.compact ? 10 : 24).pb(28).gap(1)
        .font_family(SANS).children(rows.filter(Boolean))));
}

function empty(t, text) {
  return div().px(10).py(16).text_size(13).text_color(t.muted).child(text);
}

// A package's square pip, as on the dashboard: its stage's colour, hollow while queued, red when failing.
function pip(t, stage, { failed = false, size = 8 } = {}) {
  const c = signal();
  const base = div().size(size).flex_none().rounded(2);
  if (failed) return base.bg(c.fail);
  if (stage === "queued") return base.border(1).border_color(tint(t.foreground, "40"));
  if (stage === "done") return base.bg(tint(c.merge, "66"));
  return base.bg(c[stage] ?? t.muted);
}

// What went wrong, as the dashboard's verdict badge: a small dot and a word in the issue's colour.
function badges(t, issues, id) {
  if (!issues.length) return null;
  return h_flex().id(id).flex_none().gap(12).items_center().children(issues.slice(0, 2).map((issue) => {
    const c = issueTone(t, issue.tone);
    return h_flex().flex_none().gap(6).items_center()
      .child(div().size(6).flex_none().rounded(3).bg(c))
      .child(div().flex_none().text_size(12).font_semibold().text_color(c).child(issue.text));
  }));
}

// How much has landed: one pip per package in planned order, filled once it landed. Long tasks
// fold into a single bar so the row keeps its width.
function landedMarks(t, task, id) {
  const pkgs = task.evidence.map((e) => e.pkg).sort((a, b) => a.seq - b.seq);
  const done = tint(signal().merge, "66");
  if (pkgs.length > 16) {
    return div().id(id).relative().flex_none().w(96).h(6).rounded(2).bg(tint(t.foreground, "10"))
      .child(div().absolute().left(0).top(0).h(6).w(pct(task.landed)).rounded(2).bg(done));
  }
  return h_flex().id(id).flex_none().gap(3).items_center().children(pkgs.map((pkg) => pkg.stage === "done"
    ? div().size(8).flex_none().rounded(2).bg(done)
    : div().size(8).flex_none().rounded(2).border(1).border_color(tint(t.foreground, "30"))));
}

// A question as the dashboard's ask: an orange rule, the question in plain ink, who asks and how
// long ago underneath, and its one Answer.
function askRow(v, t, job, ask, now, { pkgTitle = null, inset = 10 } = {}) {
  const q = ask.question;
  const open = q && v.answers[q.key]?.open;
  const saved = q && v.answers[q.key]?.saved;
  const you = signal().you;
  const who = ask.unrecorded ? "Waiting on you" : q?.kind === "question" ? "Question" : q ? "Guidance" : "Architect asks";
  const since = ask.question?.since ?? job.needs.find((n) => n.key === ask.key)?.since ?? null;
  const action = saved ? mono(11, t.dim).child("saved")
    : q ? answerButton(t, `answer-${ask.key}`, (cx) => v.openAnswer(q, cx), "Answer here")
      : ask.unrecorded ? null
        : v.dashboard ? answerButton(t, `answer-${ask.key}`, (cx) => v.openDashboard(cx), "Answer in the dashboard (O)") : null;
  return v_flex().id(`ask-${ask.key}`).flex_none().ml(inset).mr(4).mt(2).mb(10)
    .child(h_flex().items_start()
      .child(div().w(2).flex_none().self_stretch().rounded(1).bg(you))
      .child(v_flex().flex_1().min_w(0).pl(12).py(2).gap(6)
        .child(div().w_full().text_size(13.5).line_height("19px").text_color(ask.unrecorded ? t.muted : t.foreground).child(ask.text))
        .child(h_flex().gap(8).items_center().min_w(0)
          .child(div().flex_none().text_size(12).font_semibold().text_color(you).child(who))
          .when(Boolean(pkgTitle), (el) => el.child(div().min_w(0).truncate().text_size(12).text_color(t.muted).child(pkgTitle)))
          .when(since !== null, (el) => el.child(mono(11, t.dim).child(M.ago(since, now))))
          .child(div().flex_1())
          .when(Boolean(action) && !open, (el) => el.child(action)))))
    .when(Boolean(open), (el) => el.child(div().pl(14).pt(6).child(questionRow(v, t, q, true))));
}

// ---------- Topic and Space ----------

function taskRow(v, t, task, wide) {
  const { job } = task;
  const quiet = task.later;
  const title = div().min_w(0).flex_shrink(1).truncate().text_size(13.5).font_medium().text_color(quiet ? t.muted : t.foreground).child(job.title);
  const marks = task.total > 0 && !quiet ? landedMarks(t, task, `landed-${job.id}`) : null;
  const words = badges(t, task.issues, `issues-${job.id}`);
  const el = wide || !words
    ? h_flex().id(`task-${job.id}`).flex_none().px(10).py(quiet ? 6 : 10).gap(14).items_center()
      .child(title).when(Boolean(words), (x) => x.child(words)).child(div().flex_1()).when(Boolean(marks), (x) => x.child(marks))
    : v_flex().id(`task-${job.id}`).flex_none().px(10).py(10).gap(6)
      .child(h_flex().gap(14).items_center().child(title).child(div().flex_1()).when(Boolean(marks), (x) => x.child(marks)))
      .child(words);
  return reach(v, t, el, `task:${job.id}`, (cx) => v.openJob(job, { pkg: task.asks.find((a) => a.pkgId)?.pkgId ?? null }, cx), job.title);
}

// Planned and landed work: one shelf, closed until asked for, as the dashboard keeps its shelves.
function later(v, t, key, tasks, wide) {
  if (!tasks.length) return [];
  const open = v.expanded.has(key);
  const toggle = reach(v, t, h_flex().id(`later-${key}`).flex_none().mt(14).px(10).py(7).gap(8).items_center(), `later:${key}`,
    (cx) => v.toggleExpanded(key, cx), "Planned and landed")
    .child(svg(icon(open ? "chevron-down" : "chevron-right")).size(11).flex_none().text_color(t.dim))
    .child(micro(t, "Planned and landed", t.dim));
  return [toggle, ...(open ? tasks.map((task) => taskRow(v, t, task, wide)) : [])];
}

function scopeRows(v, t, tasks, key, now) {
  const wide = !v.compact;
  if (!tasks.length) return [empty(t, "Nothing running here")];
  const current = tasks.filter((task) => !task.later);
  const asking = current.filter((task) => task.asks.length);
  const rest = current.filter((task) => !task.asks.length);
  const group = (task) => v_flex().id(`group-${task.job.id}`).flex_none()
    .child(taskRow(v, t, task, wide))
    .children(task.asks.map((ask) => askRow(v, t, task.job, ask, now)));
  return [
    asking.length ? div().px(10).pb(6).child(micro(t, "Needs you", signal().you, "needs-label")) : null,
    ...asking.map(group),
    asking.length && rest.length ? div().h(14).flex_none() : null,
    ...rest.map(group),
    ...later(v, t, key, tasks.filter((task) => task.later), wide),
  ];
}

// ---------- Drill-in ----------

const NAME_W = 280;
const N = S.COLUMNS.length;

function columnsHead(t, wide) {
  return h_flex().id("stage-head").flex_none().px(10).pt(14).pb(6).gap(10).items_center()
    .child(div().w(8).flex_none())
    .when(wide, (el) => el.child(div().w(NAME_W).flex_none()))
    .child(h_flex().flex_1().min_w(0).children(S.COLUMNS.map((c) => div().flex_1().min_w(0).flex().justify_center()
      .child(mono(10.5, t.dim).child(S.COLUMN_LABEL[c])))));
}

// Where one package is: the dashboard's pipeline as one row of stops. The way it came is drawn in
// dim, the way ahead faint, and the stop it is on carries its stage's colour in a soft halo.
function stageTrack(t, e) {
  const at = S.COLUMNS.indexOf(e.column);
  const failed = e.issues.some((i) => i.tone === "fail");
  const c = failed ? signal().fail : e.column === "done" ? signal().merge : signal()[e.column] ?? t.muted;
  const step = 1 / N;
  const reached = Math.max(0, at) * step;
  const current = e.column === "queued" ? pip(t, "queued", { size: 9 })
    : e.column === "done" ? div().size(9).rounded(2).bg(tint(signal().merge, "66"))
      : h_flex().size(17).rounded(5).items_center().justify_center().bg(tint(c, "2a")).child(div().size(9).rounded(2).bg(c));
  return div().relative().flex_1().min_w(0).h(18)
    .child(div().absolute().top(9).left(pct(step / 2)).h(1).w(pct(1 - step)).bg(tint(t.foreground, "10")))
    .when(at > 0, (el) => el.child(div().absolute().top(9).left(pct(step / 2)).h(1).w(pct(reached)).bg(tint(t.foreground, "40"))))
    .child(h_flex().absolute().top(0).left(0).w_full().h(18).children(S.COLUMNS.map((_c, i) =>
      h_flex().flex_1().min_w(0).h(18).items_center().justify_center()
        .when(i === at, (el) => el.child(current))
        .when(i < at, (el) => el.child(div().size(3).rounded(2).bg(tint(t.foreground, "50")))))));
}

// Behind a click on a package: its agent, its PR, its review, its studio.
function pkgActions(v, t, job, pkg, ctx) {
  const people = J.participants(job, ctx.bindings, v.agentChecks, ctx.now);
  const agent = people.find((p) => p.pkgId === pkg.id && p.state === "live");
  const ui = typeof v.openStudio === "function" && St.uiPackage(job, pkg, ctx.bindings, ctx.terminals);
  const list = [
    agent && !ctx.offline ? ghost(t, `agent-${pkg.id}`, "Agent", (cx) => v.focusAgent(agent.binding, cx), { glyph: "terminal", strong: true, tip: "Open its agent" }) : null,
    pkg.pr.number ? ghost(t, `pr-${pkg.id}`, `PR ${pkg.pr.number}`, (cx) => { if (pkg.pr.url) cx.open_url(pkg.pr.url); }, { glyph: "git-branch", tip: pkg.pr.url ? "Open the pull request" : "No link recorded", disabled: !pkg.pr.url }) : null,
    R.roundsOf(pkg).length ? ghost(t, `review-${pkg.id}`, "Review", (cx) => (v.review?.pkgId === pkg.id ? v.closeReview(cx) : v.openReview(job.id, pkg.id, null, cx)), { glyph: "message-circle", strong: v.review?.pkgId === pkg.id }) : null,
    ui ? ghost(t, `studio-${pkg.id}`, "Studio", (cx) => v.openStudio(job, pkg, cx), { glyph: "monitor" }) : null,
  ].filter(Boolean);
  return v_flex().pl(26).pr(8).pb(10).pt(2).gap(8)
    .child(list.length ? h_flex().gap(2).flex_wrap().children(list) : mono(11, t.dim).child("no agent, PR or review yet"))
    .when(ctx.review?.id === pkg.id, (el) => el.child(reviewPane(v, t, pkg, ctx, true)));
}

function pkgRow(v, t, job, e, ctx, wide, odd) {
  const { pkg } = e;
  const on = v.pkgSel === pkg.id;
  const focused = on && v.keys.is_focused();
  const settled = e.column === "done" || e.column === "queued";
  const failed = e.issues.some((i) => i.tone === "fail");
  const notes = [...e.issues, ...(e.note ? [{ text: e.note, tone: "note" }] : [])];
  const name = v_flex().min_w(0).gap(3)
    .child(h_flex().gap(7).items_center().min_w(0)
      .child(div().min_w(0).truncate().text_size(13).text_color(settled ? t.muted : t.foreground).child(pkg.title))
      .when(e.needsYou, (el) => el.child(div().size(6).flex_none().rounded(3).bg(signal().you).tooltip("Waits on you"))))
    .when(notes.length > 0, (el) => el.child(h_flex().gap(10).min_w(0).children(notes.slice(0, 2).map((n) =>
      mono(11, n.tone === "note" ? t.dim : issueTone(t, n.tone)).when(n.tone !== "note", (x) => x.font_semibold()).child(n.text)))));
  const lead = h_flex().w(8).flex_none().justify_center().child(pip(t, e.column, { failed }));
  const content = wide
    ? h_flex().flex_1().min_w(0).gap(10).items_center().child(lead).child(name.w(NAME_W).flex_none()).child(stageTrack(t, e))
    : v_flex().flex_1().min_w(0).gap(6)
      .child(h_flex().gap(10).items_center().child(lead).child(name.flex_1()))
      .child(h_flex().gap(10).child(div().w(8).flex_none()).child(stageTrack(t, e)));
  const row = h_flex().id(`pkg-${pkg.id}`).flex_none().px(10).py(wide ? 6 : 8).items_center().cursor_pointer().rounded(5)
    .bg(on ? tint(t.foreground, "12") : odd ? tint(t.foreground, "07") : CLEAR).border(1).border_color(focused ? tint(t.accent, "80") : CLEAR)
    .hover((s) => s.bg(tint(t.foreground, "10")))
    .accessibility_label(`${pkg.title}, ${S.COLUMN_LABEL[e.column]}${notes.length ? `, ${notes.map((n) => n.text).join(", ")}` : ""}${e.needsYou ? ", waits on you" : ""}`)
    .on_click((_e, cx) => v.selectPackage(on ? null : pkg.id, cx))
    .child(content);
  return on ? [row, pkgActions(v, t, job, pkg, ctx)] : [row];
}

// The task's own words on top (the same ones its row shows), its questions, then every package in
// planned order, each on its stage. Packages never move when they advance.
function jobRows(v, t, job, ctx) {
  const task = S.taskOf(job, ctx.now);
  const wide = !v.compact;
  const titles = new Map(job.packages.map((pkg) => [pkg.id, pkg.title]));
  const evidence = [...task.evidence].sort((a, b) => a.pkg.seq - b.pkg.seq);
  return [
    task.issues.length ? div().px(10).pb(10).child(badges(t, task.issues, `issues-${job.id}`)) : null,
    task.asks.length ? div().px(10).pb(6).child(micro(t, "Needs you", signal().you, "needs-label")) : null,
    ...task.asks.map((ask) => askRow(v, t, job, ask, ctx.now, { pkgTitle: ask.pkgId ? titles.get(ask.pkgId) : null })),
    evidence.length ? columnsHead(t, wide) : empty(t, "Not sliced into packages yet"),
    ...evidence.flatMap((e, i) => pkgRow(v, t, job, e, ctx, wide, i % 2 === 0)),
  ];
}

// ---------- Levels ----------

// ctx: { board, desk, path, bindings, terminals, level, now }. Returns the root's children.
export function lensLevel(v, t, ctx) {
  const { board, desk, path, bindings, now } = ctx;
  if (ctx.level === "job") {
    const job = board.jobs.find((j) => j.id === path.job);
    if (!job) return [bar(v, t, "New task", now, { create: false }), empty(t, "Reading the new task…")];
    v.rowOrder = job.packages.filter((pkg) => pkg.outcome !== "dropped").sort((a, b) => a.seq - b.seq).map((pkg) => pkg.id);
    if (v.pkgSel && !v.rowOrder.includes(v.pkgSel)) v.pkgSel = null;
    const review = v.review?.jobId === job.id ? job.packages.find((pkg) => pkg.id === v.review.pkgId) ?? null : null;
    if (!review) v.review = null;
    v.shown = { jobId: job.id, bindings: J.jobBindings(job, bindings) };
    v.agentWatch = { key: job.id, bindings: v.shown.bindings };
    v.currentJob = job;
    const jctx = { now, bindings, terminals: ctx.terminals, offline: board.offline === true, review };
    return [bar(v, t, job.title, now, { create: false }), body(v, "lens-job", jobRows(v, t, job, jctx), 900)];
  }
  const title = S.scopeTitle(path, desk);
  if (v.intake) return [bar(v, t, title, now), O.intakeForm(v, t)];
  const tasks = S.scopeTasks(path, desk, board.jobs, v.place, now);
  return [bar(v, t, title, now), body(v, "lens-scope", scopeRows(v, t, tasks, `${path.topic}:${path.space ?? ""}`, now), 760)];
}
