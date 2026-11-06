// The redesigned Topic/Space view and task drill-in ("Track"), behind the scratch-only `lens` prop.
// Topic and Space draw the same view; a space only narrows the tasks. Each task is a title and one
// quiet line that fills as its packages land. Nothing is said while all is well: a word appears
// only when something went wrong, and the person's questions come first with an Answer each.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import * as J from "./job.js";
import * as R from "./rails.js";
import * as St from "./studio.js";
import * as S from "./scope.js";
import * as O from "./overview.js";
import { questionRow, reviewPane } from "./jobview.js";
import { CLEAR, icon, tint, button, iconButton } from "./ui.js";

const pct = (x) => `${(Math.max(0, Math.min(1, x)) * 100).toFixed(3)}%`;

// Red only for failures; amber for trouble that isn't one; grey for missing evidence.
const issueTone = (t, tone) => (tone === "fail" ? t.blocked : tone === "warn" ? t.working : t.muted);

// ---------- Shared ----------

function reach(v, t, el, key, open, label) {
  const on = v.row(key, open);
  return el.cursor_pointer().rounded(8).bg(on ? t.selected : CLEAR).border(1).border_color(on ? t.ring : CLEAR)
    .hover((s) => s.bg(on ? t.selected : t.hover))
    .accessibility_label(label)
    .on_click((_e, cx) => open(cx));
}

function bar(v, t, title, now, { create = true } = {}) {
  return h_flex().id("lens-bar").flex_none().h(40).px(v.compact ? 8 : 14).gap(6).items_center().border_b(1).border_color(t.border)
    .child(iconButton(t, "lens-back", "chevron-left", "Back (Esc)", (cx) => v.goUp(cx)))
    .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(title))
    .child(O.status(v, t, now))
    .when(create, (el) => el.child(iconButton(t, "new-job", "plus", "New task", (cx) => v.openIntake(cx))))
    .when(v.role === "panel", (el) => el.child(iconButton(t, "pin", v.pin ? "pin-off" : "pin",
      v.pin ? "Follow Herdr's focus again (P)" : "Stay here instead of following focus (P)", (cx) => v.togglePin(cx), { strong: v.pin })));
}

function body(v, id, rows, width) {
  return v_flex().id(id).flex_1().min_h(0).overflow_y_scrollbar().mode("hover")
    .child(h_flex().w_full().justify_center()
      .child(v_flex().w_full().max_w(v.compact ? 10000 : width).px(v.compact ? 6 : 16).pt(v.compact ? 8 : 20).pb(24).gap(2).children(rows.filter(Boolean))));
}

function empty(t, text) {
  return div().px(12).py(16).text_size(12.5).text_color(t.muted).child(text);
}

// The person's mark: a small accent dot, the same on a question and on the package it concerns.
function askMark(t) {
  return div().size(6).flex_none().rounded(3).bg(t.accent);
}

function issueWords(t, issues, id) {
  if (!issues.length) return null;
  return h_flex().id(id).flex_none().gap(8).items_center().children(issues.slice(0, 2).map((issue) =>
    div().flex_none().text_size(12).font_medium().text_color(issueTone(t, issue.tone)).child(issue.text)));
}

// One quiet line: the share of packages that landed. No line for work not yet sliced.
function line(t, id, share, width) {
  return div().id(id).relative().flex_none().w(width).h(4).rounded(2).bg(tint(t.foreground, "14"))
    .when(share > 0, (el) => el.child(div().absolute().left(0).top(0).h(4).w(pct(share)).rounded(2).bg(tint(t.foreground, "70"))));
}

// A question, readable, with its one Answer. Questions sympp can answer here open in place; an
// architect's ask goes to the dashboard; an unrecorded one can only be looked at in its task.
function askRow(v, t, job, ask, { pkgTitle = null } = {}) {
  const q = ask.question;
  const open = q && v.answers[q.key]?.open;
  const saved = q && v.answers[q.key]?.saved;
  const action = saved ? div().flex_none().text_size(12).text_color(t.muted).child("Saved")
    : q ? button(t, `answer-${ask.key}`, "Answer", (cx) => v.openAnswer(q, cx), { strong: true })
      : ask.unrecorded ? null
        : v.dashboard ? button(t, `answer-${ask.key}`, "Answer", (cx) => v.openDashboard(cx), { strong: true, tip: "Answer in the dashboard (O)" }) : null;
  return v_flex().id(`ask-${ask.key}`).flex_none().pl(12).pr(8).py(5).gap(8)
    .child(h_flex().gap(10).items_start()
      .child(div().pt(7).flex_none().child(askMark(t)))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().w_full().text_size(13).text_color(ask.unrecorded ? t.muted : t.foreground).child(ask.text))
        .when(Boolean(pkgTitle), (el) => el.child(div().truncate().text_size(11.5).text_color(t.muted).child(pkgTitle))))
      .when(Boolean(action) && !open, (el) => el.child(action)))
    .when(Boolean(open), (el) => el.child(div().pl(16).child(questionRow(v, t, q, true))));
}

// ---------- Topic and Space ----------

function taskRow(v, t, task, wide) {
  const { job } = task;
  const quiet = task.later;
  const title = div().min_w(0).flex_shrink(1).truncate().text_size(13).font_medium().text_color(quiet ? t.muted : t.foreground).child(job.title);
  const words = issueWords(t, task.issues, `issues-${job.id}`);
  const head = wide
    ? h_flex().flex_1().min_w(0).gap(12).items_center().child(title).when(Boolean(words), (el) => el.child(words))
    : v_flex().flex_1().min_w(0).gap(2).child(title).when(Boolean(words), (el) => el.child(words));
  const el = h_flex().id(`task-${job.id}`).flex_none().px(12).py(quiet ? 6 : 9).gap(16).items_center()
    .child(head)
    .when(task.total > 0 && !quiet, (x) => x.child(line(t, `line-${job.id}`, task.landed, wide ? 200 : 72)));
  return reach(v, t, el, `task:${job.id}`, (cx) => v.openJob(job, { pkg: task.asks.find((a) => a.pkgId)?.pkgId ?? null }, cx), job.title);
}

// Planned and landed work: one collapsed row, opened on request.
function later(v, t, key, tasks, wide) {
  if (!tasks.length) return [];
  const open = v.expanded.has(key);
  const toggle = reach(v, t, h_flex().id(`later-${key}`).flex_none().mt(6).px(12).py(7).gap(8).items_center(), `later:${key}`,
    (cx) => v.toggleExpanded(key, cx), "Planned and landed")
    .child(svg(icon(open ? "chevron-down" : "chevron-right")).size(12).flex_none().text_color(t.dim))
    .child(div().text_size(12).text_color(t.muted).child("Planned and landed"));
  return [toggle, ...(open ? tasks.map((task) => taskRow(v, t, task, wide)) : [])];
}

function scopeRows(v, t, tasks, key) {
  const wide = !v.compact;
  if (!tasks.length) return [empty(t, "Nothing running here")];
  const current = tasks.filter((task) => !task.later);
  const rows = current.map((task, i) => v_flex().id(`group-${task.job.id}`).flex_none()
    .when(task.asks.length > 0 && current[i + 1] && !current[i + 1].asks.length, (el) => el.mb(10))
    .child(taskRow(v, t, task, wide))
    .children(task.asks.map((ask) => askRow(v, t, task.job, ask))));
  return [...rows, ...later(v, t, key, tasks.filter((task) => task.later), wide)];
}

// ---------- Drill-in ----------

// The stage names once, over equal columns. Wide views keep a name column on the left; narrow
// ones give the columns the full width under each package's name.
const NAME_W = 260;
const N = S.COLUMNS.length;

function columns(t, cells) {
  return h_flex().flex_1().min_w(0).children(cells);
}

function columnsHead(t, wide) {
  return h_flex().id("stage-head").flex_none().px(12).pt(10).pb(4).gap(10).items_center()
    .child(div().w(10).flex_none())
    .when(wide, (el) => el.child(div().w(NAME_W).flex_none()))
    .child(columns(t, S.COLUMNS.map((c) => div().flex_1().min_w(0).flex().justify_center()
      .text_size(11).font_medium().text_color(t.muted).child(S.COLUMN_LABEL[c]))));
}

// One marker per package, in its stage's column, over a faint guide.
function stageTrack(t, e) {
  const at = S.COLUMNS.indexOf(e.column);
  const worst = e.issues.find((i) => i.tone === "fail") ?? e.issues.find((i) => i.tone === "warn");
  const marker = e.column === "queued" ? div().size(9).rounded(5).border(1.5).border_color(t.dim)
    : e.column === "done" ? div().size(8).rounded(4).bg(t.muted)
      : div().size(10).rounded(5).bg(worst ? issueTone(t, worst.tone) : t.foreground);
  return div().relative().flex_1().min_w(0).h(16)
    .child(div().absolute().top(8).left(pct(0.5 / N)).h(1).w(pct((N - 1) / N)).bg(tint(t.foreground, "14")))
    .child(h_flex().absolute().top(0).left(0).w_full().h(16).children(S.COLUMNS.map((_c, i) =>
      h_flex().flex_1().min_w(0).h(16).items_center().justify_center().when(i === at, (el) => el.child(marker)))));
}

// Behind a click on a package: its agent, its PR, its review, its studio.
function pkgActions(v, t, job, pkg, ctx) {
  const people = J.participants(job, ctx.bindings, v.agentChecks, ctx.now);
  const agent = people.find((p) => p.pkgId === pkg.id && p.state === "live");
  const ui = typeof v.openStudio === "function" && St.uiPackage(job, pkg, ctx.bindings, ctx.terminals);
  const list = [
    agent && !ctx.offline ? button(t, `agent-${pkg.id}`, "Agent", (cx) => v.focusAgent(agent.binding, cx), { strong: true, glyph: "terminal", tip: "Open its agent" }) : null,
    pkg.pr.number ? button(t, `pr-${pkg.id}`, `PR ${pkg.pr.number}`, (cx) => { if (pkg.pr.url) cx.open_url(pkg.pr.url); }, { glyph: "git-branch", tip: pkg.pr.url ? "Open the pull request" : "No link recorded", disabled: !pkg.pr.url }) : null,
    R.roundsOf(pkg).length ? button(t, `review-${pkg.id}`, "Review", (cx) => (v.review?.pkgId === pkg.id ? v.closeReview(cx) : v.openReview(job.id, pkg.id, null, cx)), { glyph: "message-circle", strong: v.review?.pkgId === pkg.id }) : null,
    ui ? button(t, `studio-${pkg.id}`, "Studio", (cx) => v.openStudio(job, pkg, cx), { glyph: "monitor" }) : null,
  ].filter(Boolean);
  return v_flex().pl(32).pr(8).pb(8).pt(2).gap(8)
    .child(list.length ? h_flex().gap(4).flex_wrap().children(list) : div().text_size(12).text_color(t.dim).child("No agent, PR or review yet"))
    .when(ctx.review?.id === pkg.id, (el) => el.child(reviewPane(v, t, pkg, ctx, true)));
}

function pkgRow(v, t, job, e, ctx, wide) {
  const { pkg } = e;
  const on = v.pkgSel === pkg.id;
  const focused = on && v.keys.is_focused();
  const settled = e.column === "done" || e.column === "queued";
  const notes = [...e.issues, ...(e.note ? [{ text: e.note, tone: "note" }] : [])];
  const name = v_flex().min_w(0).gap(2)
    .child(div().truncate().text_size(12.5).text_color(settled ? t.muted : t.foreground).child(pkg.title))
    .when(notes.length > 0, (el) => el.child(h_flex().gap(8).min_w(0).children(notes.slice(0, 2).map((n) =>
      div().flex_none().text_size(11.5).text_color(n.tone === "note" ? t.muted : issueTone(t, n.tone)).child(n.text)))));
  const mark = h_flex().w(10).flex_none().justify_center().when(e.needsYou, (el) => el.child(askMark(t)));
  const content = wide
    ? h_flex().flex_1().min_w(0).gap(10).items_center().child(mark).child(name.w(NAME_W).flex_none()).child(stageTrack(t, e))
    : v_flex().flex_1().min_w(0).gap(5)
      .child(h_flex().gap(10).items_center().child(mark).child(name.flex_1()))
      .child(h_flex().gap(10).child(div().w(10).flex_none()).child(stageTrack(t, e)));
  const row = h_flex().id(`pkg-${pkg.id}`).flex_none().px(12).py(7).items_center().cursor_pointer().rounded(8)
    .bg(on ? t.selected : CLEAR).border(1).border_color(focused ? t.ring : CLEAR)
    .hover((s) => s.bg(on ? t.selected : t.hover))
    .accessibility_label(`${pkg.title}, ${S.COLUMN_LABEL[e.column]}${notes.length ? `, ${notes.map((n) => n.text).join(", ")}` : ""}${e.needsYou ? ", waits on you" : ""}`)
    .on_click((_e, cx) => v.selectPackage(on ? null : pkg.id, cx))
    .child(content);
  return on ? [row, pkgActions(v, t, job, pkg, ctx)] : [row];
}

// The task's own words on top (the same ones its row shows), its questions, then every package in
// planned order, each in its stage's column. Packages never move when they advance.
function jobRows(v, t, job, ctx) {
  const task = S.taskOf(job, ctx.now);
  const wide = !v.compact;
  const titles = new Map(job.packages.map((pkg) => [pkg.id, pkg.title]));
  const evidence = [...task.evidence].sort((a, b) => a.pkg.seq - b.pkg.seq);
  return [
    task.issues.length ? div().px(12).pt(2).pb(6).child(issueWords(t, task.issues, `issues-${job.id}`)) : null,
    ...task.asks.map((ask) => askRow(v, t, job, ask, { pkgTitle: ask.pkgId ? titles.get(ask.pkgId) : null })),
    evidence.length ? columnsHead(t, wide) : empty(t, "Not sliced into packages yet"),
    ...evidence.flatMap((e) => pkgRow(v, t, job, e, ctx, wide)),
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
    return [bar(v, t, job.title, now, { create: false }), body(v, "lens-job", jobRows(v, t, job, jctx), 820)];
  }
  const title = S.scopeTitle(path, desk);
  if (v.intake) return [bar(v, t, title, now), O.intakeForm(v, t)];
  const tasks = S.scopeTasks(path, desk, board.jobs, v.place, now);
  return [bar(v, t, title, now), body(v, "lens-scope", scopeRows(v, t, tasks, `${path.topic}:${path.space ?? ""}`), 720)];
}
