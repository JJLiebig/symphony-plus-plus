// The Topic, Space and task views, drawn in the web dashboard's visual language: Geist with Geist
// Mono, its stage colours, its box strip and its Build ─ PR ─ Checks ─ Review ─ Merge pipeline, and
// its orange for what needs the person. Topic and Space draw the same view; a space only narrows the
// tasks. A task is its name and its strip; a word appears only when something went wrong, and the
// person's questions come first with one action each.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Button } from "gpui-base";
import { settings, shared, terminals, run, openOverlay } from "herdr";
import * as J from "./job.js";
import * as L from "./levels.js";
import * as R from "./rails.js";
import * as St from "./studio.js";
import * as S from "./scope.js";
import * as O from "./overview.js";
import { questionRow, reviewPane } from "./jobview.js";
import { CLEAR, EXPAND, icon, tint } from "./ui.js";
import { CHIEF_SPACES, isChiefSpace } from "./chief.js";

const SANS = "Geist";
const MONO = "Geist Mono";

// The dashboard's signal colours (elixir/assets/src/fresh/fresh.css), with deeper twins for light themes.
const DARK = { build: "#6ea8fe", checks: "#e5b454", review: "#b794f6", merge: "#7bd88f", you: "#ff7a45", fail: "#ff5c6c" };
const LIGHT = { build: "#2563eb", checks: "#b7791f", review: "#7c3aed", merge: "#15803d", you: "#ea580c", fail: "#dc2626" };
const signal = () => (settings()?.dark === false ? LIGHT : DARK);

// Red for failures, the checks amber for trouble that isn't one, faint for a worker gone quiet.
const issueTone = (t, tone) => (tone === "fail" ? signal().fail : tone === "warn" ? signal().checks : t.dim);

// GPUI has no letter-spacing; the dashboard's tracked capitals are set with hair spaces instead.
const tracked = (text) => text.toUpperCase().split("").join(" ");

function micro(t, text, color) {
  return div().flex_none().text_size(10).font_family(SANS).font_semibold().text_color(color).accessibility_label(text).child(tracked(text));
}

const mono = (size, color) => div().flex_none().font_family(MONO).text_size(size).text_color(color);

// ---------- Controls ----------

// The dashboard's quiet buttons: no border, dim until hovered.
function ghost(t, id, label, action, { glyph = null, tip = null, strong = false, disabled = false } = {}) {
  return Button.new(id).flex().flex_none().items_center().gap(6).h(24).px(8).rounded(5).cursor_pointer()
    .font_family(SANS).text_size(12).font_medium()
    .bg(strong ? tint(t.foreground, "14") : CLEAR).text_color(strong ? t.foreground : t.muted)
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

// The person's action on a question, in their colour, tinted so it reads as theirs without shouting.
function youButton(t, id, label, action, tip) {
  const you = signal().you;
  return Button.new(id).flex().flex_none().items_center().h(24).px(10).rounded(5).cursor_pointer()
    .font_family(SANS).text_size(12).font_semibold().text_color(you).bg(tint(you, "1f"))
    .hover((s) => s.bg(tint(you, "33")))
    .focus((s) => s.border(1).border_color(you))
    .accessibility_label(tip).tooltip(tip)
    .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
    .child(label);
}

// ---------- Shared ----------

// The selected row takes the accent, so it never reads as a zebra stripe.
function reach(v, t, el, key, open, label) {
  const on = v.row(key, open);
  return el.cursor_pointer().rounded(6).bg(on ? tint(t.accent, "24") : CLEAR).border(1).border_color(on ? tint(t.accent, "99") : CLEAR)
    .hover((s) => s.bg(on ? tint(t.accent, "2e") : tint(t.foreground, "08")))
    .accessibility_label(label)
    .on_click((_e, cx) => open(cx));
}

// A task's own tab has no level above it, so no way back.
function bar(v, t, title, now, { create = true, back = true } = {}) {
  return h_flex().id("lens-bar").flex_none().h(44).px(v.compact ? 8 : 16).gap(4).items_center()
    .bg(tint(t.foreground, "05")).border_b(1).border_color(tint(t.foreground, "12"))
    .when(back, (el) => el.child(glyphButton(t, "lens-back", "chevron-left", "Back (Esc)", (cx) => v.goUp(cx))))
    .child(div().flex_1().min_w(0).pl(back ? 2 : 6).truncate().font_family(SANS).text_size(13.5).font_semibold().text_color(t.foreground).child(title))
    .child(O.status(v, t, now))
    .when(create, (el) => el.child(glyphButton(t, "new-job", "plus", "New task", (cx) => v.openIntake(cx))))
    .when(v.role === "panel", (el) => el.child(glyphButton(t, "open-big", EXPAND, "Open as a tab", (cx) => v.openBig(cx))))
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

// ---------- Motion ----------

// Herdr animates opacity, size and position natively, but not colour. A mark whose colour changed
// fades its new look in over the old one: the render that notices the change draws the new look
// transparent, the next lets it rise, a third drops the old look underneath. A row new to a list
// rises the same way, in its place; rows never move because they advanced.
const FADE = 200;
const motionOf = (v) => (v.motion ??= { last: new Map(), fading: new Map(), lists: new Map(), pass: 0, wake: false });

// A mark that may change: `draw(value)` draws it for a value; `id` names this drawing of it.
function marked(v, key, value, draw, id) {
  const m = motionOf(v);
  const before = m.last.get(key);
  m.last.set(key, value);
  if (before !== undefined && before !== value) m.fading.set(key, { from: before, to: value, phase: 0 });
  const f = m.fading.get(key);
  if (!f || f.to !== value) {
    m.fading.delete(key);
    return draw(value);
  }
  m.wake = true;
  return div().relative().flex_none().child(draw(f.from))
    .child(div().id(`${id}-${value}`).absolute().top(0).left(0).opacity(f.phase ? 1 : 0)
      .transition("opacity", { duration: FADE, easing: "ease-out" }).child(draw(value)));
}

// A row in a list: one the list didn't have when last drawn fades in. A list's first drawing,
// e.g. on opening a level, shows as it is.
function arriving(v, list, key, el) {
  const m = motionOf(v);
  let known = m.lists.get(list);
  if (!known) m.lists.set(list, known = { pass: m.pass, keys: new Set() });
  const fresh = known.pass !== m.pass && !known.keys.has(key);
  known.keys.add(key);
  const id = `row:${list}:${key}`;
  if (fresh) m.fading.set(id, { from: null, to: true, phase: 0 });
  const f = m.fading.get(id);
  if (!f) return el;
  m.wake = true;
  return el.opacity(f.phase ? 1 : 0).transition("opacity", { duration: 240, easing: "ease-out" });
}

// After a render: how long until the motion's next step, or null when nothing is fading.
export function motionStep(v) {
  const m = v.motion;
  if (!m?.wake || m.pending) return null;
  m.wake = false;
  m.pending = true;
  return [...m.fading.values()].some((f) => !f.phase) ? 16 : FADE + 60;
}

// Raises what was drawn transparent; settles what has risen.
export function advanceMotion(v) {
  const m = v.motion;
  m.pending = false;
  const rising = [...m.fading.values()].some((f) => !f.phase);
  for (const [key, f] of m.fading) {
    if (!f.phase) f.phase = 1;
    else if (!rising) m.fading.delete(key);
  }
}

// One package's box: landed in a muted merge green; at work in its stage's colour, breathing slowly
// (red while its checks fail); in Build with no worker yet as an outline in Build's colour; still to
// come hollow. A changed look fades in.
function box(v, t, pkg, size, id) {
  const look = pkg.stage === "done" ? "done" : pkg.stage === "queued" ? "queued" : pkg.failed ? "failed" : S.unmanned(pkg) ? "empty" : pkg.stage;
  return marked(v, `box:${pkg.id}`, look, (k) => drawBox(t, k, size), id);
}

function drawBox(t, look, size) {
  const c = signal();
  const base = div().size(size).flex_none().rounded(2);
  if (look === "done") return base.bg(tint(c.merge, "66"));
  if (look === "queued") return base.border(1).border_color(tint(t.foreground, "38"));
  if (look === "failed") return base.bg(c.fail);
  if (look === "empty") return base.border(1.5).border_color(c.build);
  return base.bg(c[look] ?? t.muted).loop("opacity", { from: 0.5, to: 1, period: 3200 });
}

// The PR's checks: a hollow ring before they start, a slow amber pulse while they run, green once
// passed, red when failed. No words; the tooltip names it.
const CI_TIP = { waiting: "Checks not started", running: "Checks running", passed: "Checks passed", failed: "Checks failed" };
function ciDot(v, t, key, state, id) {
  if (!state) return null;
  return h_flex().id(id).w(8).h(8).flex_none().items_center().justify_center().tooltip(CI_TIP[state]).accessibility_label(CI_TIP[state])
    .child(marked(v, `ci:${key}`, state, (s) => drawCi(t, s), `${id}-mark`));
}

function drawCi(t, state) {
  const c = signal();
  const base = div().size(8).flex_none().rounded(4);
  if (state === "waiting") return base.border(1.5).border_color(tint(t.foreground, "55"));
  if (state === "running") return base.bg(c.checks).loop("opacity", { from: 0.25, to: 1, period: 1800 });
  return base.bg(state === "passed" ? c.merge : c.fail);
}

// The dashboard's strip: one box per package, a hairline between the architect's groups.
function strip(v, t, runs, id, size = 10) {
  return h_flex().id(id).flex_wrap().gap_y(4).items_center().min_w(0).children(runs.map((run, i) =>
    h_flex().id(`${id}-${i}`).flex_none().gap(3).items_center()
      .when(i > 0, (el) => el.ml(4).pl(5).border_l(1).border_color(tint(t.foreground, "26")))
      .children(run.pkgs.map((pkg) => h_flex().id(`${id}-box-${pkg.id}`).flex_none().tooltip(pkg.title).child(box(v, t, pkg, size, `${id}-box-${pkg.id}`))))));
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

// The topic's chief, as the topic mark reaches it: a peek at the chief while it runs (the panel shares
// it, confirmed live), else sympp's Start chief for the topic.
function openChief(topic) {
  const address = (shared("sympp.chiefs")?.[topic.id] ?? []).find((c) => c.terminal)?.terminal;
  if (address && terminals().some((k) => k.address === address && k.state === "live")) run("terminal.peek", { terminal: address });
  else openOverlay({ mod: "sympp", kind: "window", frame: "none", width: 1, height: 1, props: { role: "chief", topic: topic.id, name: topic.name } });
}

// A question as the dashboard's ask: an orange rule, the question in plain ink, and one action. One
// with an answer route is answered here; any other goes to the topic's chief, or to the dashboard
// where the task has no topic.
function askRow(v, t, ask, topic) {
  const q = ask.question;
  const open = q && v.answers[q.key]?.open;
  const saved = q && v.answers[q.key]?.saved;
  const action = saved ? mono(11, t.dim).child("saved")
    : q ? youButton(t, `answer-${ask.key}`, "Answer", (cx) => v.openAnswer(q, cx), "Answer here")
      : topic ? youButton(t, `chief-${ask.key}`, "Chief", () => openChief(topic), `Answer through the ${topic.name} chief`)
        : v.dashboard ? youButton(t, `answer-${ask.key}`, "Answer", (cx) => v.openDashboard(cx), "Answer in the dashboard (O)") : null;
  return v_flex().id(`ask-${ask.key}`).flex_none().ml(10).mr(4).mt(2).mb(8)
    .child(h_flex().items_start()
      .child(div().w(2).flex_none().self_stretch().rounded(1).bg(signal().you))
      .child(h_flex().flex_1().min_w(0).pl(12).gap(10).items_center()
        .child(div().flex_1().min_w(0).py(3).text_size(13.5).line_height("19px").text_color(ask.unrecorded ? t.muted : t.foreground).child(ask.text))
        .when(Boolean(action) && !open, (el) => el.child(action))))
    .when(Boolean(open), (el) => el.child(div().pl(14).pt(6).child(questionRow(v, t, q, true))));
}

// ---------- Topic and Space ----------

function taskRow(v, t, task, wide) {
  const { job } = task;
  const quiet = task.later;
  const title = div().min_w(0).flex_shrink(1).truncate().text_size(13.5).font_medium().text_color(quiet ? t.muted : t.foreground).child(job.title);
  const words = badges(t, task.issues, `issues-${job.id}`);
  const runs = task.total > 0 && !quiet ? strip(v, t, task.strip, `strip-${job.id}`) : null;
  // The task's checks sit at the row's right edge, wide or narrow, in a slot kept from the start.
  const ci = quiet ? null : ciDot(v, t, job.id, task.ci, `ci-${job.id}`);
  const head = h_flex().flex_1().min_w(0).gap(12).items_center().child(title).when(Boolean(words), (x) => x.child(words));
  const el = wide
    ? h_flex().id(`task-${job.id}`).flex_none().px(10).py(quiet ? 6 : 11).gap(24).items_center()
      .child(head).when(Boolean(runs), (x) => x.child(h_flex().w(380).flex_none().justify_end().child(runs)))
      .when(Boolean(ci), (x) => x.child(div().ml(-12).flex_none().child(ci)))
    : v_flex().id(`task-${job.id}`).flex_none().px(10).py(quiet ? 6 : 10).gap(8)
      .child(h_flex().gap(10).items_center().child(head).when(Boolean(ci), (x) => x.child(ci)))
      .when(Boolean(runs), (x) => x.child(runs));
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

function scopeRows(v, t, tasks, key, topic) {
  const wide = !v.compact;
  if (!tasks.length) return [empty(t, "Nothing running here")];
  const current = tasks.filter((task) => !task.later);
  const asking = current.filter((task) => task.asks.length);
  const rest = current.filter((task) => !task.asks.length);
  const group = (task) => arriving(v, `scope:${key}`, task.job.id, v_flex().id(`group-${task.job.id}`).flex_none()
    .child(taskRow(v, t, task, wide))
    .children(task.asks.map((ask) => askRow(v, t, ask, topic))));
  return [
    asking.length ? div().px(10).pb(4).child(micro(t, "Needs you", signal().you)) : null,
    ...asking.map(group),
    asking.length && rest.length ? div().h(14).flex_none() : null,
    ...rest.map(group),
    ...later(v, t, key, tasks.filter((task) => task.later), wide),
  ];
}

// ---------- Drill-in ----------

// Checks are no step of their own: CI runs again on every push, so its dot stays live beside the
// line. A package waiting on its first checks stands at PR.
const STEPS = [["Build", "build"], ["PR", "pr"], ["Review", "review"], ["Merge", "merge"]];
const SHORT = [["Work", "build"], ["Done", "done"]];
const ORDER = { queued: -1, build: 0, checks: 1, review: 2, merge: 3, done: 4 };
const STEP_OF = { build: "build", checks: "pr", review: "review", merge: "merge" };

// The dashboard's pipeline: the way travelled dim, the way ahead faint, the current step in its
// stage's colour, Review with where it stands (its round when the provider names no step). The PR
// step opens the pull request once there is one.
function pipeline(t, pkg) {
  const short = pkg.track === "no_pr";
  const steps = short ? SHORT : STEPS;
  const live = pkg.stage !== "done" && pkg.stage !== "queued";
  const at = short && live ? 0 : ORDER[pkg.stage] ?? -1;
  const c = signal();
  const parts = [];
  steps.forEach(([label, stage], i) => {
    if (i > 0) parts.push(mono(11, i <= at ? t.muted : tint(t.foreground, "3a")).child("─"));
    const current = live && (short ? i === 0 : stage === STEP_OF[pkg.stage]);
    if (current) {
      const phase = pkg.stage === "review" ? S.reviewPhase(pkg) ?? (pkg.round > 1 ? `round ${pkg.round}` : null) : null;
      parts.push(mono(11, c[pkg.stage] ?? t.foreground).font_semibold().child(phase ? `${label} · ${phase}` : label));
      return;
    }
    const tone = i < at ? t.muted : tint(t.foreground, "48");
    if (stage === "pr" && pkg.pr.url) {
      parts.push(Button.new(`pr-step-${pkg.id}`).flex_none().cursor_pointer().font_family(MONO).text_size(11).text_color(tone).underline()
        .hover((s) => s.text_color(t.foreground)).tooltip(`Open PR #${pkg.pr.number ?? ""}`.trim())
        .on_click((_e, cx) => { cx.stop_propagation(); cx.open_url(pkg.pr.url); }).child(label));
    } else parts.push(mono(11, tone).child(label));
  });
  return h_flex().flex_none().gap(6).items_center().children(parts);
}

// Behind a click on a package: its agent, its PR, its review, its studio.
function pkgActions(v, t, job, pkg, ctx) {
  const people = J.participants(job, ctx.bindings, v.agentChecks, ctx.now);
  const agent = people.find((p) => p.pkgId === pkg.id && p.state === "live");
  const ui = typeof v.openStudio === "function" && St.uiPackage(job, pkg, ctx.bindings, ctx.terminals);
  const jump = agent ? v.jumps[agent.binding.address] : null;
  const list = [
    agent && !ctx.offline ? ghost(t, `agent-${pkg.id}`, jump?.pending ? "Checking…" : "Agent", (cx) => v.focusAgent(agent.binding, cx), { glyph: "terminal", strong: true, tip: "Open its agent", disabled: Boolean(jump?.pending) }) : null,
    pkg.pr.number ? ghost(t, `pr-${pkg.id}`, `PR ${pkg.pr.number}`, (cx) => { if (pkg.pr.url) cx.open_url(pkg.pr.url); }, { glyph: "git-branch", tip: pkg.pr.url ? "Open the pull request" : "No link recorded", disabled: !pkg.pr.url }) : null,
    R.roundsOf(pkg).length ? ghost(t, `review-${pkg.id}`, "Review", (cx) => (v.review?.pkgId === pkg.id ? v.closeReview(cx) : v.openReview(job.id, pkg.id, null, cx)), { glyph: "message-circle", strong: v.review?.pkgId === pkg.id }) : null,
    ui ? ghost(t, `studio-${pkg.id}`, "Studio", (cx) => v.openStudio(job, pkg, cx), { glyph: "monitor" }) : null,
  ].filter(Boolean);
  const action = list.length ? h_flex().gap(2).flex_wrap().children(list) : null;
  if (!action && ctx.review?.id !== pkg.id) return null;
  return v_flex().pl(26).pr(8).pb(10).pt(2).gap(8)
    .when(Boolean(action), (el) => el.child(action))
    .when(Boolean(jump?.error), (el) => el.child(div().role("alert").text_size(12).text_color(signal().fail).child(jump.error)))
    .when(ctx.review?.id === pkg.id, (el) => el.child(reviewPane(v, t, pkg, ctx, true)));
}

// A package at work: its box, its name (an orange dot while it waits on the person, a faint word
// when its worker went quiet), its pipeline, beside the name when wide and under it when narrow, and
// its checks at the row's right edge. Selected, it takes the accent rather than a deeper grey, so it
// stands apart from the zebra rows even when there are only two.
function pkgRow(v, t, job, e, ctx, wide, odd) {
  const { pkg } = e;
  const on = v.pkgSel === pkg.id;
  const focused = on && v.keys.is_focused();
  const quiet = e.issues.find((i) => i.tone === "unknown");
  const name = h_flex().flex_1().min_w(0).gap(8).items_center()
    .child(div().min_w(0).flex_shrink(1).truncate().text_size(13).text_color(pkg.stage === "done" || pkg.stage === "queued" ? t.muted : t.foreground).child(pkg.title))
    .when(e.needsYou, (el) => el.child(div().size(6).flex_none().rounded(3).bg(signal().you).tooltip("Waits on you")))
    .when(Boolean(quiet), (el) => el.child(mono(11, t.dim).child(quiet.text)));
  const lead = h_flex().id(`lead-${pkg.id}`).w(10).flex_none().justify_center().child(box(v, t, pkg, 8, `lead-${pkg.id}`));
  const live = pkg.stage !== "done" && pkg.stage !== "queued";
  const ci = ciDot(v, t, pkg.id, S.ciOf(pkg), `ci-${pkg.id}`);
  const content = !live
    ? h_flex().flex_1().min_w(0).gap(10).items_center().child(lead).child(name).when(Boolean(ci), (x) => x.child(ci))
    : wide
      ? h_flex().flex_1().min_w(0).gap(10).items_center().child(lead).child(name).child(pipeline(t, pkg)).when(Boolean(ci), (x) => x.child(div().ml(4).flex_none().child(ci)))
      : v_flex().flex_1().min_w(0).gap(5)
        .child(h_flex().gap(10).items_center().child(lead).child(name).when(Boolean(ci), (x) => x.child(ci)))
        .child(h_flex().gap(10).child(div().w(10).flex_none()).child(pipeline(t, pkg)));
  const row = h_flex().id(`pkg-${pkg.id}`).flex_none().px(10).py(wide ? 7 : 8).items_center().cursor_pointer().rounded(5)
    .bg(on ? tint(t.accent, "24") : odd ? tint(t.foreground, "07") : CLEAR).border(1).border_color(on ? tint(t.accent, focused ? "cc" : "80") : CLEAR)
    .hover((s) => s.bg(on ? tint(t.accent, "2e") : tint(t.foreground, "10")))
    .accessibility_label(`${pkg.title}${e.issues.length ? `, ${e.issues.map((i) => i.text).join(", ")}` : ""}${e.needsYou ? ", waits on you" : ""}`)
    .on_click((_e, cx) => v.selectPackage(on ? null : pkg.id, cx))
    .child(content);
  const actions = on ? pkgActions(v, t, job, pkg, ctx) : null;
  const shown = arriving(v, `job:${job.id}`, pkg.id, row);
  return actions ? [shown, actions] : [shown];
}

// Landed and queued packages fold into one mark each: a label and their boxes, opened on request.
// The keys reach a fold like a package row, and Enter opens it.
function fold(v, t, job, label, parts, ctx, wide) {
  if (!parts.length) return [];
  const key = `${label}:${job.id}`;
  const open = v.expanded.has(key);
  const on = v.pkgSel === `fold:${key}` && v.keys.is_focused();
  const toggle = h_flex().id(`fold-${key}`).flex_none().mt(6).px(10).py(7).gap(10).items_center().cursor_pointer().rounded(6)
    .border(1).border_color(on ? tint(t.accent, "80") : CLEAR).hover((s) => s.bg(tint(t.foreground, "08")))
    .accessibility_label(label).on_click((_e, cx) => v.toggleExpanded(key, cx))
    .child(svg(icon(open ? "chevron-down" : "chevron-right")).size(11).flex_none().text_color(t.dim))
    .child(micro(t, label, t.dim))
    .child(strip(v, t, [{ pkgs: parts.map((e) => e.pkg) }], `fold-strip-${key}`, 8));
  return [toggle, ...(open ? parts.flatMap((e, i) => pkgRow(v, t, job, e, ctx, wide, i % 2 === 0)) : [])];
}

// The task's words and strip on top (the same ones its row shows), its questions, then the packages
// at work in planned order with landed and queued work folded below. Packages never move when they
// advance.
function jobRows(v, t, job, ctx) {
  const task = S.taskOf(job, ctx.now);
  const wide = !v.compact;
  const parts = S.packageParts(task);
  const folded = (label, list) => (list.length ? [`fold:${label}:${job.id}`, ...(v.expanded.has(`${label}:${job.id}`) ? list.map((e) => e.pkg.id) : [])] : []);
  v.rowOrder = [...parts.active.map((e) => e.pkg.id), ...folded("Landed", parts.landed), ...folded("Up next", parts.queued)];
  if (v.pkgSel && !v.rowOrder.includes(v.pkgSel)) v.pkgSel = null;
  return [
    h_flex().id("task-head").flex_none().px(10).pb(12).gap(16).items_center().flex_wrap()
      .when(task.total > 0, (el) => el.child(strip(v, t, task.strip, `strip-${job.id}`, 11)))
      .when(task.issues.length > 0, (el) => el.child(badges(t, task.issues, `issues-${job.id}`))),
    task.asks.length ? div().px(10).pb(4).child(micro(t, "Needs you", signal().you)) : null,
    ...task.asks.map((ask) => askRow(v, t, ask, ctx.topic)),
    !task.total ? empty(t, "Not sliced into packages yet") : null,
    task.asks.length && parts.active.length ? div().h(8).flex_none() : null,
    ...parts.active.flatMap((e, i) => pkgRow(v, t, job, e, ctx, wide, i % 2 === 0)),
    ...fold(v, t, job, "Landed", parts.landed, ctx, wide),
    ...fold(v, t, job, "Up next", parts.queued, ctx, wide),
  ];
}

// ---------- Levels ----------

// One task, as the panel's drill-in or as the task's own tab (`tab`: no way back, no new task).
export function taskLevel(v, t, job, ctx) {
  motionOf(v).pass += 1;
  const review = v.review?.jobId === job.id ? job.packages.find((pkg) => pkg.id === v.review.pkgId) ?? null : null;
  if (!review) v.review = null;
  v.shown = { jobId: job.id, bindings: J.jobBindings(job, ctx.bindings) };
  v.agentWatch = { key: job.id, bindings: v.shown.bindings };
  v.currentJob = job;
  const jctx = { ...ctx, offline: ctx.board.offline === true, review };
  return [bar(v, t, job.title, ctx.now, { create: false, back: !ctx.tab }), body(v, "lens-job", jobRows(v, t, job, jctx), 900)];
}

// The topic's spaces as the dashboard's area filters: All, then each space with a repository, one
// per repository; a Space is its topic with one of them chosen. Chief spaces are left out.
function filters(v, t, path, desk) {
  const topic = desk.find((x) => x.id === path.topic);
  const made = shared(CHIEF_SPACES);
  const seen = new Set();
  const spaces = (topic?.spaces ?? []).filter((s) => {
    const repo = L.spaceRepo(s);
    if (!repo || seen.has(repo) || (topic.kind === "topic" && isChiefSpace(s, topic, made))) return false;
    seen.add(repo);
    return true;
  });
  if (!spaces.length) return null;
  const pill = (id, label, on, go) => Button.new(id).flex().flex_none().items_center().h(22).px(8).rounded(5).cursor_pointer()
    .font_family(SANS).text_size(12).bg(on ? tint(t.foreground, "14") : CLEAR).text_color(on ? t.foreground : t.muted)
    .hover((s) => s.text_color(t.foreground)).focus((s) => s.border(1).border_color(t.accent))
    .accessibility_label(label).on_click((_e, cx) => { cx.stop_propagation(); go(cx); }).child(label);
  return h_flex().id("space-filters").flex_none().px(v.compact ? 12 : 20).pt(10).gap(2).flex_wrap()
    .child(pill("filter-all", "All", !path.space, (cx) => v.openTopic(topic.id, cx)))
    .children(spaces.map((s) => pill(`filter-${s.id}`, [s.name || L.spaceRepo(s), s.machine].filter(Boolean).join(" · "), path.space === s.id, (cx) => v.openSpace(s.id, topic.id, cx))));
}

// A Topic or Space: the tasks touching it. ctx: { board, desk, path, bindings, terminals, now }.
export function scopeLevel(v, t, ctx) {
  const { board, desk, path, now } = ctx;
  motionOf(v).pass += 1;
  const title = S.scopeTitle(path, desk);
  if (v.intake) return [bar(v, t, title, now), O.intakeForm(v, t)];
  const tasks = S.scopeTasks(path, desk, board.jobs, v.place, now);
  const topic = desk.find((x) => x.id === path.topic && x.kind === "topic") ?? null;
  return [bar(v, t, title, now), filters(v, t, path, desk), body(v, "lens-scope", scopeRows(v, t, tasks, `${path.topic}:${path.space ?? ""}`, topic), 820)];
}
