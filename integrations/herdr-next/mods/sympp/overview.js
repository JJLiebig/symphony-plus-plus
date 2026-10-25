// The current overview: what needs you first, then the jobs that are moving, with S++ scopes and
// intake. The Factory, Topic and Space levels will replace it; until then it leads into the Job level.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Button } from "gpui-base";
import * as M from "./model.js";
import { CLEAR, MONO, icon, tint, button, field, mark, pip, section } from "./ui.js";

export function header(v, t, scopes, scope, all, now) {
  const counts = M.verdictCounts(all);
  const needed = v.net.data?.offline === true ? div().flex_none().text_size(12).text_color(t.muted).child("Offline copy") : counts.needs > 0
    ? h_flex().gap(7).items_center().flex_none().child(div().size(7).rounded(4).bg(t.blocked)).child(div().text_size(12.5).font_semibold().text_color(t.blocked).child(`You're needed in ${counts.needs}`))
    : div().flex_none().text_size(12.5).text_color(t.muted).child("Nothing needs you");
  const chips = h_flex().gap(2).items_center().min_w(0).flex_wrap().children(scopes.map((s) => {
    const on = s.key === scope.key;
    return Button.new(`scope-${s.key}`).flex().flex_none().items_center().gap(5).h(24).px(8).rounded(6).text_size(12).cursor_pointer()
      .border(1).border_color(CLEAR)
      .bg(on ? t.selected : CLEAR)
      .text_color(on ? t.foreground : t.muted)
      .hover((st) => st.bg(t.hover).text_color(t.foreground))
      .focus((st) => st.border_color(t.accent))
      .accessibility_label(`${s.kind === "topic" ? "Topic" : s.kind === "area" ? "Area" : "Scope"}: ${s.label}`)
      .on_click((_e, cx) => v.setScope(s.key, cx))
      .when(s.kind === "topic", (el) => el.child(svg(icon("folder")).size(12).flex_none()))
      .child(s.label);
  }));
  const actions = h_flex().gap(4).items_center().flex_none()
    .child(button(t, "new-job", "New job", (cx) => v.openIntake(cx), { strong: true }))
    .child(button(t, "refresh", "Refresh", (cx) => v.retry(cx), { tip: "Read S++ now (R)" }))
    .when(Boolean(v.dashboard), (el) => el.child(button(t, "dashboard", "Dashboard", (cx) => v.openDashboard(cx), { tip: "Open the S++ dashboard (O)" })));

  if (v.compact) {
    return v_flex().flex_none().px(12).pt(10).pb(8).gap(8).border_b(1).border_color(t.border)
      .child(h_flex().gap(8).items_center().flex_wrap().child(div().text_size(13).font_semibold().text_color(t.foreground).child("S++")).child(needed).child(div().flex_1()).child(actions))
      .child(h_flex().gap(8).items_center().flex_wrap().child(chips).child(div().flex_1()).child(freshness(v, t, now)));
  }
  return h_flex().flex_none().py(10).px(20).gap(16).items_center().flex_wrap().border_b(1).border_color(t.border)
    .child(div().flex_none().text_size(13.5).font_semibold().text_color(t.foreground).child("S++"))
    .child(div().flex_1().min_w(0).child(chips))
    .child(needed)
    .child(freshness(v, t, now))
    .child(actions);
}

export function freshness(v, t, now) {
  const stale = M.isStale(v.net, now);
  return div().flex_none().text_size(11).font_family(MONO).text_color(stale ? t.blocked : t.dim)
    .child(v.reading && !v.net.receivedAt ? "Reading…" : `${stale ? "Last read" : "Read"} ${M.ago(v.net.receivedAt, now)}`);
}

// A failed read keeps the last board on screen and says so, with the way back.
export function staleBar(v, t, now) {
  if (!M.isStale(v.net, now)) return null;
  const lost = v.net.error ? `Connection lost · showing the read from ${M.ago(v.net.receivedAt, now)}` : `This read is ${M.ago(v.net.receivedAt, now).replace(" ago", "")} old`;
  return h_flex().flex_none().px(v.compact ? 12 : 20).py(8).gap(10).items_center().bg(tint(t.blocked, "14")).border_b(1).border_color(tint(t.blocked, "40"))
    .role("alert")
    .child(div().size(7).flex_none().rounded(1.5).bg(t.blocked))
    .child(v_flex().flex_1().min_w(0).gap(2)
      .child(div().text_size(12.5).font_medium().text_color(t.foreground).child(lost))
      .when(Boolean(v.net.error), (el) => el.child(div().text_size(11.5).text_color(t.muted).truncate().child(v.net.error))))
    .child(button(t, "retry-stale", v.reading ? "Reading…" : "Retry", (cx) => v.retry(cx), { strong: true }));
}

function needRow(v, t, need, now) {
  const job = need.job;
  return v_flex().id(`need-${need.key}`).flex_none().px(14).py(12).gap(7).rounded(10).cursor_pointer()
    .bg(tint(t.blocked, "12"))
    .hover((s) => s.bg(tint(t.blocked, "1c")))
    .accessibility_label(`${need.label}: ${need.text}. ${job.title}`)
    .on_click((_e, cx) => {
      if (!v.order.some((j) => j.id === job.id)) v.setScope("all", cx);
      v.openJob(job.id, cx);
    })
    .child(h_flex().gap(8).items_center()
      .child(mark(t, "needs_you"))
      .child(div().text_size(11.5).font_semibold().text_color(t.blocked).child(need.label))
      .child(div().flex_1())
      .when(need.since !== null, (el) => el.child(div().text_size(11).font_family(MONO).text_color(t.muted).child(M.ago(need.since, now)))))
    .child(div().w_full().text_size(14).text_color(t.foreground).child(need.text))
    .child(h_flex().gap(8).items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(`${job.area[0]} › ${job.repoShort} · ${job.title}`))
      .child(button(t, `view-${need.key}`, "View job", (cx) => v.openJob(job.id, cx), { strong: true })));
}

// One dot per package in planned order, a gap between the architect's groups.
function strip(t, job, now) {
  const dots = job.packages.map((pkg, i) => {
    const gap = i > 0 && pkg.group !== job.packages[i - 1].group;
    return div().id(`pip-${job.id}-${pkg.id}`).flex_none().when(gap, (el) => el.ml(5)).tooltip(`${pkg.title}: ${M.stageText(pkg, now)}`).child(pip(t, pkg));
  });
  return h_flex().flex_none().gap(3).items_center().accessibility_label(`${job.counts.done} of ${job.counts.total} packages landed`).children(dots);
}

function jobRow(v, t, job, now) {
  const on = job.id === v.selected;
  const loud = job.verdict !== "on_track" && job.verdict !== "idle" && job.verdict !== "settled";
  return h_flex().id(`job-${job.id}`).flex_none().px(12).py(v.compact ? 8 : 10).gap(12).items_start().rounded(8).cursor_pointer()
    .bg(on ? t.selected : CLEAR)
    .border(1).border_color(on && v.keys.is_focused() ? t.ring : CLEAR)
    .hover((s) => s.bg(on ? t.selected : t.hover))
    .accessibility_label(`${job.title}, ${M.VERDICT_LABEL[job.verdict]}`)
    .on_click((_e, cx) => v.select(job.id, cx))
    .child(div().pt(5).flex_none().child(mark(t, job.verdict)))
    .child(v_flex().flex_1().min_w(0).gap(5)
      .child(h_flex().gap(8).items_center()
        .child(div().min_w(0).flex_shrink(1).truncate().text_size(13.5).font_semibold().text_color(job.state === "settled" ? t.muted : t.foreground).child(job.title))
        .when(job.offPrimary, (el) => el.child(div().flex_none().text_size(11).font_family(MONO).text_color(t.muted).child(`→ ${job.baseBranch}`)))
        .child(div().flex_1())
        .when(loud, (el) => el.child(div().flex_none().text_size(11.5).font_medium().text_color(job.verdict === "needs_you" ? t.blocked : job.verdict === "parked" ? t.muted : t.foreground).child(M.VERDICT_LABEL[job.verdict])))
        .when(job.counts.total > 0, (el) => el.child(div().flex_none().text_size(11).font_family(MONO).text_color(t.muted).child(`${job.counts.done}/${job.counts.total}`))))
      .child(h_flex().gap(10).items_center()
        .when(job.counts.total > 0, (el) => el.child(strip(t, job, now)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(job.brief)))
      .when(!v.compact, (el) => el.child(h_flex().gap(6).text_size(11).text_color(t.muted)
        .child(div().min_w(0).truncate().child(`${job.area.join(" › ")} · ${job.repoShort}`))
        .child(div().flex_none().child(`· moved ${M.ago(job.lastMoveAt, now)}`)))));
}

export function list(v, t, jobs, needs, now) {
  const lanes = M.lanesOf(jobs);
  const rows = [];
  if (needs.length) {
    rows.push(section(t, "Needs you", needs.length, t.blocked));
    rows.push(v_flex().gap(8).children(needs.map((need) => needRow(v, t, need, now))));
  }
  const lane = (label, entries) => {
    if (!entries.length) return;
    rows.push(section(t, label, entries.length));
    rows.push(v_flex().gap(2).children(entries.map((job) => jobRow(v, t, job, now))));
  };
  lane("Moving", lanes.moving);
  lane("Parked", lanes.parked);
  lane("Not started", lanes.backlog);
  lane("Landed · last 24 hours", lanes.landed);
  const away = [lanes.settled.length ? `${lanes.settled.length} settled` : null, lanes.dormant.length ? `${lanes.dormant.length} dormant` : null].filter(Boolean);
  if (!rows.length) rows.push(div().pt(28).px(4).text_size(13).text_color(t.muted).child(jobs.length ? "Nothing open here right now." : "No S++ jobs in this scope."));
  if (away.length) {
    rows.push(h_flex().pt(18).px(4).gap(6).items_center().text_size(11.5).text_color(t.muted)
      .child(`${away.join(" · ")}, kept in the dashboard`));
  }
  return v_flex().id(`lens-list-${v.role}`).flex_1().min_w(0).min_h(0).px(v.role === "panel" ? 8 : 16).pb(20).overflow_y_scrollbar().mode("hover").children(rows);
}

export function intakeForm(v, t) {
  return v_flex().id("intake-form").flex_1().min_h(0).overflow_y_scrollbar().p(20).gap(18)
    .child(div().text_size(18).font_semibold().child("New job"))
    .child(field(t, "Title", v.draft.title))
    .child(field(t, "Repository", v.draft.repo))
    .child(field(t, "Base branch", v.draft.base_branch))
    .child(field(t, "Request", v.draft.human_description, true))
    .when(Boolean(v.creation.error), (el) => el.child(div().role("alert").text_size(12.5).text_color(t.blocked).child(v.creation.error)))
    .child(h_flex().gap(8).flex_wrap()
      .child(button(t, "create-job", v.creation.pending ? "Creating…" : "Create job", (cx) => v.createRequest(cx), { strong: true, disabled: v.creation.pending }))
      .child(button(t, "cancel-intake", "Back", (cx) => { v.intake = false; v.keys.focus(); cx.notify(); }, { disabled: v.creation.pending })));
}
