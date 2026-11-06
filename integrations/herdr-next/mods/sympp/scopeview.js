// Redesigned Topic/Space view and task drill-in, in three directions chosen by the scratch-only
// `lens` prop ("a" Skyline, "b" Track, "c" Sections). Topic and Space draw the same view; a space
// only narrows the tasks. Health and progress are read from shape, position and colour; words
// are kept to task titles and what the person is asked.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import * as M from "./model.js";
import * as J from "./job.js";
import * as R from "./rails.js";
import * as St from "./studio.js";
import * as S from "./scope.js";
import * as O from "./overview.js";
import { questionRow, reviewPane } from "./jobview.js";
import { CLEAR, MONO, icon, tint, button, iconButton } from "./ui.js";

export const DIRECTIONS = { a: "Skyline", b: "Track", c: "Sections" };

// One colour per health, from Herdr's theme: red only for the person, amber for trouble, the
// accent for work moving, Herdr's done green for landed work.
// A traffic light: green moving, amber slowing, grey stuck, red for the person. Landed work takes
// Herdr's own done blue and recedes.
function tone(t, h) {
  return { needs: t.blocked, stuck: t.muted, slowing: t.working, moving: t.ansi2, resting: t.dim, queued: t.dim, landed: t.done }[h] ?? t.dim;
}

// Direction C speaks Herdr's Agents list exactly: amber while working, blue when done.
function nativeTone(t, h) {
  return { needs: t.blocked, stuck: t.muted, slowing: t.working, moving: t.working, resting: t.dim, queued: t.dim, landed: t.done }[h] ?? t.dim;
}

const pct = (x) => `${(Math.max(0, Math.min(1, x)) * 100).toFixed(3)}%`;

// ---------- Shared ----------

function reach(v, t, el, key, open, label, base = CLEAR) {
  const on = v.row(key, open);
  return el.cursor_pointer().rounded(8).bg(on ? t.selected : base).border(1).border_color(on ? t.ring : CLEAR)
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

function body(v, id, rows) {
  return v_flex().id(id).flex_1().min_h(0).overflow_y_scrollbar().mode("hover")
    .child(h_flex().w_full().justify_center()
      .child(v_flex().w_full().max_w(v.compact ? 10000 : 880).px(v.compact ? 6 : 16).pt(v.compact ? 8 : 20).pb(24).gap(2).children(rows.filter(Boolean))));
}

function empty(t, text) {
  return div().px(12).py(16).text_size(12.5).text_color(t.muted).child(text);
}

// What the person is asked, one line per ask, in their own colour. The only text a task row adds.
function asks(t, job, inset) {
  return job.needs.map((need) => div().id(`ask-${need.key}`).w_full().pl(inset).text_size(12.5).text_color(t.blocked).child(S.askText(job, need)));
}

// A task's own glyph: Herdr's grammar. Moving turns, slowing is an amber square, stuck a still
// hollow ring, needs a red dot, resting a dash, landed a check.
function glyph(t, h) {
  if (h === "moving") return svg(icon("spinner")).size(12).flex_none().text_color(tone(t, h)).spin(1400);
  if (h === "needs") return div().size(8).flex_none().rounded(4).bg(t.blocked);
  if (h === "slowing") return div().size(8).flex_none().rounded(1.5).bg(tone(t, h));
  if (h === "stuck") return div().size(9).flex_none().rounded(5).border(1.5).border_color(t.muted);
  if (h === "landed") return svg(icon("check")).size(12).flex_none().text_color(tone(t, h));
  if (h === "queued") return div().size(7).flex_none().rounded(4).border(1.5).border_color(t.dim);
  return div().w(8).h(1.5).flex_none().bg(t.dim);
}

function glyphSlot(t, h) {
  return h_flex().w(14).flex_none().items_center().justify_center().child(glyph(t, h));
}

// The person's answers sit on top of the drill-in; everything else needs a click.
function needsBlock(v, t, job) {
  return job.needs.map((need) => {
    const question = need.id ? job.guidance.find((q) => q.key === need.key) : null;
    const open = question && v.answers[question.key]?.open;
    const action = question ? button(t, `need-answer-${need.key}`, "Answer", (cx) => v.openAnswer(question, cx), { strong: true })
      : v.dashboard ? button(t, `need-dashboard-${need.key}`, "Answer", (cx) => v.openDashboard(cx), { strong: true, tip: "Answer in the dashboard (O)" }) : null;
    return v_flex().id(`need-${need.key}`).flex_none().mx(4).mb(8).px(12).py(10).gap(8).rounded(8).bg(tint(t.blocked, "12"))
      .child(h_flex().gap(10).items_start()
        .child(div().pt(5).flex_none().child(glyph(t, "needs")))
        .child(div().flex_1().min_w(0).text_size(13.5).text_color(t.foreground).child(S.askText(job, need)))
        .when(Boolean(action) && !open, (el) => el.child(action)))
      .when(Boolean(open), (el) => el.child(questionRow(v, t, question, true)));
  });
}

// Behind a click on a package: its agent, its PR, its review, its studio. Never shown inline.
function pkgActions(v, t, job, pkg, ctx, inset) {
  const people = J.participants(job, ctx.bindings, v.agentChecks, ctx.now);
  const agent = people.find((p) => p.pkgId === pkg.id && p.state === "live");
  const rounds = R.roundsOf(pkg);
  const ui = typeof v.openStudio === "function" && St.uiPackage(job, pkg, ctx.bindings, ctx.terminals);
  const list = [
    agent && !ctx.offline ? button(t, `agent-${pkg.id}`, "Agent", (cx) => v.focusAgent(agent.binding, cx), { strong: true, glyph: "terminal", tip: "Open its agent" }) : null,
    pkg.pr.number ? button(t, `pr-${pkg.id}`, `PR ${pkg.pr.number}`, (cx) => { if (pkg.pr.url) cx.open_url(pkg.pr.url); }, { glyph: "git-branch", tip: pkg.pr.url ? "Open the pull request" : "No link recorded", disabled: !pkg.pr.url }) : null,
    rounds.length ? button(t, `review-${pkg.id}`, "Review", (cx) => (v.review?.pkgId === pkg.id ? v.closeReview(cx) : v.openReview(job.id, pkg.id, null, cx)), { glyph: "message-circle", strong: v.review?.pkgId === pkg.id }) : null,
    ui ? button(t, `studio-${pkg.id}`, "Studio", (cx) => v.openStudio(job, pkg, cx), { glyph: "monitor" }) : null,
  ].filter(Boolean);
  return v_flex().pl(inset).pr(8).pb(8).pt(2).gap(8)
    .child(list.length ? h_flex().gap(4).flex_wrap().children(list) : div().text_size(12).text_color(t.dim).child("No agent, PR or review yet"))
    .when(ctx.review?.id === pkg.id, (el) => el.child(reviewPane(v, t, pkg, ctx, true)));
}

function pkgRow(v, t, job, item, ctx, draw, inset) {
  const { pkg, health: h } = item;
  const on = v.pkgSel === pkg.id;
  const focused = on && v.keys.is_focused();
  const row = draw(pkg, h)
    .id(`pkg-${pkg.id}`).cursor_pointer().rounded(8)
    .bg(on ? t.selected : CLEAR).border(1).border_color(focused ? t.ring : CLEAR)
    .hover((s) => s.bg(on ? t.selected : t.hover))
    .accessibility_label(`${pkg.title}, ${M.stageText(pkg, ctx.now)}`)
    .tooltip(M.stageText(pkg, ctx.now))
    .on_click((_e, cx) => v.selectPackage(on ? null : pkg.id, cx));
  return on ? [row, pkgActions(v, t, job, pkg, ctx, inset)] : [row];
}

// ---------- A · Skyline ----------
// One column per package, tallest (furthest along) first: the task's progress is the shape's
// mass, its health the colour of what still stands in flight.

const SKY_H = 18;

function skyline(t, job, now) {
  const items = S.packageOrder(job, now).sort((a, b) => (S.STAGE_AT[b.pkg.stage] ?? 0) - (S.STAGE_AT[a.pkg.stage] ?? 0));
  const w = items.length > 24 ? 2 : items.length > 12 ? 3 : 4;
  return h_flex().id(`sky-${job.id}`).flex_none().h(SKY_H).items_end().gap(items.length > 20 ? 1 : 2)
    .children(items.map(({ pkg, health: h }) => {
      const at = S.STAGE_AT[pkg.stage] ?? 0;
      const color = h === "landed" ? tint(tone(t, h), "aa") : tone(t, h);
      return div().w(w).flex_none().rounded(1).h(pkg.stage === "queued" ? 2 : Math.max(3, Math.round(SKY_H * at))).bg(color);
    }));
}

function skyTask(v, t, item, ctx) {
  const { job, health: h } = item;
  const quiet = h === "resting" || h === "landed";
  const line = h_flex().gap(10).items_center().min_w(0)
    .child(glyphSlot(t, h))
    .child(div().flex_1().min_w(0).truncate().text_size(13).font_medium().text_color(quiet ? t.muted : t.foreground).child(job.title))
    .when(h !== "landed" && job.packages.length > 0, (el) => el.child(skyline(t, job, ctx.now)));
  const el = v_flex().id(`task-${job.id}`).flex_none().px(10).py(h === "landed" ? 6 : 9).gap(5).child(line)
    .when(h === "needs", (x) => x.children(asks(t, job, 24)));
  return reach(v, t, el, `task:${job.id}`, (cx) => v.openJob(job, { pkg: job.needs[0]?.pkgId ?? null }, cx), `${job.title}, ${h}`, h === "needs" ? tint(t.blocked, "10") : CLEAR);
}

// Four stops: build, checks, review, merge. Past stops are small and filled, the current one is
// the package's colour, later ones are faint. A landed package is all past with a check.
function ladder(t, pkg, h, CELL) {
  const at = pkg.stage === "done" ? S.STEPS.length : S.STEPS.indexOf(pkg.stage);
  const color = tone(t, h);
  const reached = at < 0 ? 0 : Math.min(at, S.STEPS.length - 1);
  const line = at < 0 ? null : div().absolute().top(7).left(CELL / 2).h(1.5).w(reached * CELL + (at >= S.STEPS.length ? CELL / 2 : 0)).bg(pkg.stage === "done" ? tint(color, "88") : t.muted);
  return div().relative().flex_none().w(CELL * S.STEPS.length).h(16)
    .child(div().absolute().top(7).left(CELL / 2).h(1.5).w(CELL * (S.STEPS.length - 1) + CELL / 2).bg(tint(t.foreground, "12")))
    .when(Boolean(line), (el) => el.child(line))
    .child(h_flex().absolute().left(0).top(0).h(16).children(S.STEPS.map((step, i) => h_flex().w(CELL).h(16).items_center().justify_center()
      .child(i === at ? div().size(9).rounded(5).bg(color)
        : i < at ? div().size(5).rounded(3).bg(pkg.stage === "done" ? color : t.muted)
          : div().size(5).rounded(3).border(1).border_color(t.dim)))));
}

// The stops' names once, over the ladders: whole words when there is room.
function ladderHead(t, CELL) {
  return h_flex().id("ladder-head").flex_none().px(10).pt(4).pb(2).gap(10)
    .child(div().w(14).flex_none()).child(div().flex_1())
    .child(h_flex().flex_none().w(CELL * S.STEPS.length).children(S.STEPS.map((step) => div().w(CELL).flex().justify_center()
      .text_size(9.5).font_family(MONO).text_color(t.dim).child(CELL >= 48 ? step : step.slice(0, 1).toUpperCase())))
      .tooltip("Build · Checks · Review · Merge"));
}

function skyJob(v, t, job, ctx) {
  const items = S.packageOrder(job, ctx.now);
  const cell = v.compact ? 30 : 56;
  const rows = items.flatMap((item) => pkgRow(v, t, job, item, ctx, (pkg, h) => h_flex().flex_none().px(10).py(7).gap(10).items_center()
    .child(glyphSlot(t, h))
    .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(h === "landed" || h === "queued" ? t.muted : t.foreground).child(pkg.title))
    .child(ladder(t, pkg, h, cell)), 34));
  return [...needsBlock(v, t, job), items.length ? ladderHead(t, cell) : empty(t, "Not sliced into packages yet"), ...rows];
}

// ---------- B · Track ----------
// One rail per task: landed in green, then what is in flight to where the work has reached, and
// a head that says how it is going. Packages in the drill-in sit on the same rail, at their stage.

function head(t, h, at, id) {
  const c = tone(t, h);
  const base = div().absolute().left(pct(at)).top(0).ml(-5).size(10).flex_none();
  if (h === "moving") return base.id(id).rounded(5).bg(c).loop("opacity", { from: 0.45, to: 1, period: 1800 });
  if (h === "needs") return base.rounded(5).bg(c).border(2).border_color(tint(c, "55"));
  if (h === "slowing") return base.rounded(2).bg(c);
  if (h === "stuck") return base.rounded(5).border(1.5).border_color(t.muted).bg(t.chrome);
  if (h === "queued" || h === "resting") return base.rounded(5).border(1.5).border_color(t.dim).bg(t.chrome);
  return null;
}

function rail(t, id, landed, flight, h, { slim = false } = {}) {
  const c = h === "stuck" ? t.muted : tone(t, h);
  const reach = Math.min(1, landed + flight);
  const done = tone(t, "landed");
  return div().id(id).relative().w_full().h(10).flex_none()
    .child(div().absolute().left(0).top(4).w_full().h(2).rounded(1).bg(tint(t.foreground, "14")))
    .when(landed > 0, (el) => el.child(div().absolute().left(0).top(slim ? 4 : 3).h(slim ? 2 : 4).w(pct(landed)).rounded(2).bg(h === "landed" ? tint(done, "55") : done)))
    .when(reach > landed, (el) => el.child(div().absolute().left(pct(landed)).top(slim ? 4 : 3).h(slim ? 2 : 4).w(pct(reach - landed)).rounded(2).bg(tint(c, h === "stuck" ? "aa" : "dd"))))
    .when(h !== "landed", (el) => el.child(head(t, h, reach, `${id}-head`)));
}

function trackTask(v, t, item, ctx) {
  const { job, health: h, progress: p } = item;
  const quiet = h === "resting" || h === "landed";
  const title = div().min_w(0).truncate().text_size(13).font_medium().text_color(quiet ? t.muted : t.foreground).child(job.title);
  let el;
  if (h === "landed") {
    el = h_flex().id(`task-${job.id}`).flex_none().px(10).py(6).gap(10).items_center().child(glyphSlot(t, h)).child(title.flex_1());
  } else if (v.compact) {
    el = v_flex().id(`task-${job.id}`).flex_none().px(12).pt(9).pb(10).gap(7).child(title).child(rail(t, `rail-${job.id}`, p.landed, p.flight, h))
      .when(h === "needs", (x) => x.children(asks(t, job, 0)));
  } else {
    el = v_flex().id(`task-${job.id}`).flex_none().px(12).py(10).gap(6)
      .child(h_flex().gap(20).items_center().child(title.w(300).flex_none()).child(div().flex_1().min_w(0).child(rail(t, `rail-${job.id}`, p.landed, p.flight, h))))
      .when(h === "needs", (x) => x.children(asks(t, job, 0)));
  }
  return reach(v, t, el, `task:${job.id}`, (cx) => v.openJob(job, { pkg: job.needs[0]?.pkgId ?? null }, cx), `${job.title}, ${h}`);
}

// Stage names once, placed where each stage sits on the rail.
function ruler(t, wide) {
  const marks = S.STEPS.map((s) => [s, S.STAGE_AT[s]]);
  const scale = div().relative().h(14).w_full().children(marks.map(([name, at]) => div().absolute().top(0).left(pct(at)).ml(-(name.length * 3))
    .text_size(9.5).font_family(MONO).text_color(t.dim).child(name)));
  return wide ? h_flex().flex_none().px(12).pt(6).gap(20).child(div().w(300).flex_none()).child(div().flex_1().min_w(0).child(scale))
    : div().flex_none().px(12).pt(6).child(scale);
}

function trackJob(v, t, job, ctx) {
  const items = S.packageOrder(job, ctx.now);
  const wide = !v.compact;
  const rows = items.flatMap((item) => pkgRow(v, t, job, item, ctx, (pkg, h) => {
    const at = S.STAGE_AT[pkg.stage] ?? 0;
    const title = div().min_w(0).truncate().text_size(12.5).text_color(h === "landed" || h === "queued" ? t.muted : t.foreground).child(pkg.title);
    const r = rail(t, `prail-${pkg.id}`, h === "landed" ? 1 : 0, h === "landed" ? 0 : at, h, { slim: true });
    return wide ? h_flex().flex_none().px(12).py(8).gap(20).items_center().child(title.w(300).flex_none()).child(div().flex_1().min_w(0).child(r))
      : v_flex().flex_none().px(12).pt(7).pb(8).gap(5).child(title).child(r);
  }, 12));
  return [...needsBlock(v, t, job), items.length ? ruler(t, wide) : empty(t, "Not sliced into packages yet"), ...rows];
}

// ---------- C · Sections ----------
// Herdr's Agents list, for tasks: grouped by how they are doing, so where a task sits says it. Each
// row ends in a short gauge of landed and in-flight work.

const SECTION = { needs: "Needs you", stuck: "Stuck", slowing: "Slowing", moving: "Moving", resting: "Not started", landed: "Landed" };

function sectionLabel(t, id, text, color) {
  return h_flex().id(id).flex_none().h(28).px(10).pt(6).items_center().text_size(11).font_medium().text_color(color).child(text);
}

function gauge(t, p, h) {
  const c = nativeTone(t, h);
  return div().relative().flex_none().w(44).h(4).rounded(2).bg(tint(t.foreground, "14"))
    .when(p.landed > 0, (el) => el.child(div().absolute().left(0).top(0).h(4).w(pct(p.landed)).rounded(2).bg(nativeTone(t, "landed"))))
    .when(p.flight > 0, (el) => el.child(div().absolute().left(pct(p.landed)).top(0).h(4).w(pct(p.flight)).rounded(2).bg(c)));
}

// Herdr's own marks: a turning spinner while moving, a "!" box for the person, rings for still work.
function nativeGlyph(t, h) {
  if (h === "needs") return div().size(14).flex_none().rounded(4).bg(tint(t.blocked, "26")).text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
  if (h === "landed") return div().size(7).flex_none().rounded(4).bg(nativeTone(t, h));
  if (h === "moving") return svg(icon("spinner")).size(12).flex_none().text_color(nativeTone(t, h)).spin(900);
  return glyph(t, h);
}

function sectionTask(v, t, item, ctx) {
  const { job, health: h, progress: p } = item;
  const quiet = h === "resting" || h === "landed";
  const el = v_flex().id(`task-${job.id}`).flex_none().px(8).py(h === "needs" ? 6 : 0).gap(3)
    .child(h_flex().h(h === "needs" ? 20 : 30).gap(9).items_center().min_w(0)
      .child(h_flex().w(14).flex_none().items_center().justify_center().child(nativeGlyph(t, h)))
      .child(div().flex_1().min_w(0).truncate().text_size(12.8).text_color(quiet ? t.muted : t.foreground).child(job.title))
      .when(h !== "landed" && p.total > 0, (x) => x.child(gauge(t, p, h))))
    .when(h === "needs", (x) => x.children(asks(t, job, 23)));
  return reach(v, t, el, `task:${job.id}`, (cx) => v.openJob(job, { pkg: job.needs[0]?.pkgId ?? null }, cx), `${job.title}, ${SECTION[h]}`);
}

function grouped(t, items, keyOf, labels, draw, colorOf) {
  const out = [];
  let last = null;
  for (const item of items) {
    const key = keyOf(item);
    if (key !== last) out.push(sectionLabel(t, `sec-${key}`, labels[key], colorOf(key)));
    last = key;
    out.push(...[].concat(draw(item)));
  }
  return out;
}

const STAGE_SECTION = { needs: "Needs you", merge: "Ready to merge", review: "In review", checks: "Checks", build: "Building", queued: "Up next", done: "Landed" };
const STAGE_ORDER = ["needs", "merge", "review", "checks", "build", "queued", "done"];

function sectionJob(v, t, job, ctx) {
  const items = S.packageOrder(job, ctx.now).map((item) => ({ ...item, key: item.health === "needs" ? "needs" : item.pkg.stage }))
    .sort((a, b) => STAGE_ORDER.indexOf(a.key) - STAGE_ORDER.indexOf(b.key) || a.pkg.seq - b.pkg.seq);
  const colorOf = (key) => (key === "needs" ? t.blocked : key === "done" || key === "queued" ? t.dim : t.muted);
  const rows = grouped(t, items, (item) => item.key, STAGE_SECTION, (item) => pkgRow(v, t, job, item, ctx, (pkg, h) => h_flex().flex_none().h(30).px(8).gap(9).items_center()
    .child(h_flex().w(14).flex_none().items_center().justify_center().child(nativeGlyph(t, h)))
    .child(div().flex_1().min_w(0).truncate().text_size(12.8).text_color(h === "landed" || h === "queued" ? t.muted : t.foreground).child(pkg.title))
    .when(pkg.stage === "review" && pkg.round > 1, (x) => x.child(div().flex_none().text_size(10.5).font_family(MONO).text_color(pkg.round >= 3 ? tone(t, "slowing") : t.dim).child(`R${pkg.round}`))), 31), colorOf);
  return [...needsBlock(v, t, job), ...(items.length ? rows : [empty(t, "Not sliced into packages yet")])];
}

// ---------- Levels ----------

const SCOPE = { a: skyTask, b: trackTask, c: sectionTask };
const JOB = { a: skyJob, b: trackJob, c: sectionJob };

// ctx: { board, desk, path, bindings, level, now }. Returns the root's children.
export function lensLevel(v, t, ctx) {
  const lens = DIRECTIONS[v.given.lens] ? v.given.lens : "a";
  const { board, desk, path, bindings, now } = ctx;
  if (ctx.level === "job") {
    const job = board.jobs.find((j) => j.id === path.job);
    if (!job) return [bar(v, t, "New task", now, { create: false }), empty(t, "Reading the new task…")];
    v.rowOrder = S.packageOrder(job, now).map((item) => item.pkg.id);
    if (v.pkgSel && !v.rowOrder.includes(v.pkgSel)) v.pkgSel = null;
    const review = v.review?.jobId === job.id ? job.packages.find((pkg) => pkg.id === v.review.pkgId) ?? null : null;
    if (!review) v.review = null;
    v.shown = { jobId: job.id, bindings: J.jobBindings(job, bindings) };
    v.agentWatch = { key: job.id, bindings: v.shown.bindings };
    v.currentJob = job;
    const jctx = { now, bindings, terminals: ctx.terminals, offline: board.offline === true, review };
    return [bar(v, t, job.title, now, { create: false }), body(v, `lens-job-${lens}`, JOB[lens](v, t, job, jctx))];
  }
  const title = S.scopeTitle(path, desk);
  if (v.intake) return [bar(v, t, title, now), O.intakeForm(v, t)];
  const tasks = S.scopeTasks(path, desk, board.jobs, v.place);
  const jctx = { now, bindings };
  const rows = !tasks.length ? [empty(t, "Nothing running here")]
    : lens === "c" ? grouped(t, tasks, (item) => item.health, SECTION, (item) => sectionTask(v, t, item, jctx),
      (h) => (h === "needs" ? t.blocked : h === "slowing" ? tone(t, h) : h === "moving" ? t.muted : t.dim))
      : tasks.map((item, i) => {
        const row = SCOPE[lens](v, t, item, jctx);
        // Landed work sits apart at the bottom, after a hairline.
        const first = item.health === "landed" && tasks[i - 1]?.health !== "landed" && i > 0;
        return first ? v_flex().id(`landed-${item.job.id}`).flex_none().child(div().mx(10).my(6).h(1).bg(t.border)).child(row) : row;
      });
  return [bar(v, t, title, now), body(v, `lens-scope-${lens}`, rows)];
}
