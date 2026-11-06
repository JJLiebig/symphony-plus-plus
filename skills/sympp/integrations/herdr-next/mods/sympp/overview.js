// The Factory level (what needs you, then one row per Herdr topic) under its breadcrumb bar, the read
// status every view shares, and the new-task form. Topic, Space and task views are in scopeview.js.
// Rows register with the view so keys reach everything a pointer can.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Button } from "gpui-base";
import * as M from "./model.js";
import * as L from "./levels.js";
import { CLEAR, MONO, icon, tint, button, iconButton, field, mark, presence, section } from "./ui.js";

// ---------- Bar ----------

// Breadcrumb, attention and actions. On the Job level the job draws its own actions.
export function levelBar(v, t, trail, { now, needs, slim = false }) {
  const parts = trail.flatMap((c, i) => {
    const last = i === trail.length - 1;
    const crumb = last
      ? div().id(`crumb-${c.level}`).min_w(0).max_w_full().truncate().text_size(13).font_semibold().text_color(t.foreground).child(c.label)
      : Button.new(`crumb-${c.level}`).flex_none().h(24).px(6).rounded(6).text_size(12.5).cursor_pointer().text_color(t.muted)
        .border(1).border_color(CLEAR)
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).focus((s) => s.border_color(t.accent))
        .accessibility_label(`Up to ${c.label}`).tooltip("Up a level (Esc)")
        .on_click((_e, cx) => { cx.stop_propagation(); v.go(c.path, cx); })
        .child(c.label);
    return i === 0 ? [crumb] : [svg(icon("chevron-right")).size(11).flex_none().text_color(t.dim), crumb];
  });
  const path = h_flex().id("breadcrumb").gap(2).items_center().min_w(0).flex_1().flex_wrap().children(parts);
  const pin = v.role === "panel"
    ? (v.compact ? iconButton(t, "pin", v.pin ? "pin-off" : "pin", v.pin ? "Follow Herdr's focus again (P)" : "Stay here instead of following focus (P)", (cx) => v.togglePin(cx), { strong: v.pin })
      : button(t, "pin", v.pin ? "Unpin" : "Pin", (cx) => v.togglePin(cx), { glyph: v.pin ? "pin-off" : "pin", strong: v.pin,
        tip: v.pin ? "Follow Herdr's focus again (P)" : "Stay here instead of following focus (P)" }))
    : null;
  if (slim) {
    return h_flex().flex_none().px(v.compact ? 12 : 20).py(7).gap(8).items_center().border_b(1).border_color(t.border)
      .child(path).child(status(v, t, now)).when(Boolean(pin), (el) => el.child(pin));
  }
  const needed = v.net.data?.offline === true ? div().flex_none().text_size(12).text_color(t.muted).child("Offline copy") : needs > 0
    ? h_flex().gap(7).items_center().flex_none().child(div().size(7).rounded(4).bg(t.blocked)).child(div().text_size(12.5).font_semibold().text_color(t.blocked).child(`You're needed in ${needs}`))
    : null;
  if (v.compact) {
    const actions = h_flex().gap(2).items_center().flex_none()
      .child(iconButton(t, "new-job", "plus", "New job", (cx) => v.openIntake(cx)))
      .when(Boolean(v.dashboard), (el) => el.child(iconButton(t, "dashboard", "monitor", "Open the sympp dashboard (O)", (cx) => v.openDashboard(cx))))
      .when(Boolean(pin), (el) => el.child(pin));
    return v_flex().flex_none().px(12).py(6).gap(4).border_b(1).border_color(t.border)
      .child(h_flex().gap(6).items_center().child(path).child(status(v, t, now)).child(actions))
      .when(Boolean(needed), (el) => el.child(needed));
  }
  const actions = h_flex().gap(4).items_center().flex_none()
    .child(button(t, "new-job", "New job", (cx) => v.openIntake(cx), { strong: true }))
    .when(Boolean(v.dashboard), (el) => el.child(button(t, "dashboard", "Dashboard", (cx) => v.openDashboard(cx), { tip: "Open the sympp dashboard (O)" })))
    .when(Boolean(pin), (el) => el.child(pin));
  return h_flex().flex_none().py(9).px(20).gap(16).items_center().border_b(1).border_color(t.border)
    .child(path).when(Boolean(needed), (el) => el.child(needed)).child(status(v, t, now)).child(actions);
}

// Where the read stands, in one 14 px slot so nothing around it moves: a spinner while sympp is read or
// started, a red dot (its tip says why; a click reads again) once reads keep failing, else nothing.
export function status(v, t, now) {
  const slot = div().id("read-status").size(14).flex_none().flex().items_center().justify_center();
  if (v.reading || v.starting) return slot.tooltip(v.starting ? "Starting sympp…" : "Reading sympp…").child(svg(icon("spinner")).size(12).text_color(t.dim).spin(900));
  if (!M.isStale(v.net, now)) return slot;
  const tip = v.net.error ? `${v.net.error} Showing the read from ${M.ago(v.net.receivedAt, now)}. Click to retry (R).` : `Last read ${M.ago(v.net.receivedAt, now)}. Click to retry (R).`;
  return slot.cursor_pointer().tooltip(tip).accessibility_label(tip)
    .on_click((_e, cx) => { cx.stop_propagation(); v.retry(cx); })
    .child(div().size(7).rounded(4).bg(t.blocked));
}

// The same status where a view has no bar of its own (a job tab, a studio): over its top-right corner.
export function floatingStatus(v, t, now) {
  return div().absolute().top(8).right(10).child(status(v, t, now));
}

// ---------- Rows ----------

// A row the keys can reach: registered in reading order, ringed while it holds the keyboard cursor.
function reachable(v, t, el, key, open, label) {
  const on = v.row(key, open);
  return el.cursor_pointer().rounded(8).bg(on ? t.selected : CLEAR).border(1).border_color(on ? t.ring : CLEAR)
    .hover((s) => s.bg(on ? t.selected : t.hover))
    .accessibility_label(label)
    .on_click((_e, cx) => open(cx));
}

// A desk scopes its rows' keys, since the same need can sit on two chiefs' desks.
function needRow(v, t, need, names, now, scope = "") {
  const job = need.job;
  const also = v.place.alsoIn(job).map((id) => names.get(id)).filter(Boolean);
  const where = [job.title, names.get(v.place.home(job)), also.length ? `also in ${also.join(", ")}` : null].filter(Boolean).join(" · ");
  const open = (cx) => v.openJob(job, { pkg: need.pkgId }, cx);
  return reachable(v, t, v_flex().id(`need-${scope}${need.key}`).flex_none().px(14).py(11).gap(6), `need:${scope}${need.key}`, open, `${need.label}: ${need.text}. ${job.title}`)
    .bg(tint(t.blocked, "12"))
    .hover((s) => s.bg(tint(t.blocked, "1c")))
    .child(h_flex().gap(8).items_center()
      .child(mark(t, "needs_you"))
      .child(div().text_size(11.5).font_semibold().text_color(t.blocked).child(need.label))
      .child(div().flex_1())
      .when(need.unblocks > 0, (el) => el.child(div().id(`unblocks-${need.key}`).flex_none().text_size(11).font_medium().text_color(t.foreground)
        .tooltip("Packages waiting on this answer").child(`Unblocks ${need.unblocks}`)))
      .when(need.since !== null, (el) => el.child(div().flex_none().text_size(11).font_family(MONO).text_color(t.muted).child(M.ago(need.since, now)))))
    .child(div().w_full().text_size(13.5).text_color(t.foreground).child(need.text))
    .child(div().w_full().truncate().text_size(11.5).text_color(t.muted).child(where));
}

function topicRow(v, t, row, now) {
  const verdict = row.needs > 0 ? "needs_you" : row.moving > 0 ? "on_track" : "idle";
  const quiet = verdict === "idle" && !row.jobs.length;
  const sub = [row.repos.join(", "), ...row.shared.map((s) => `shares ${s.count} ${s.count === 1 ? "job" : "jobs"} with ${s.name}`)].filter(Boolean).join(" · ");
  return reachable(v, t, h_flex().id(`topic-${row.id}`).flex_none().px(12).py(9).gap(10).items_start(), `topic:${row.id}`, (cx) => v.openTopic(row.id, cx),
    `${row.name}: ${row.needs} need you, ${row.moving} moving`)
    .child(div().pt(5).flex_none().child(mark(t, verdict)))
    .child(v_flex().flex_1().min_w(0).gap(3)
      .child(h_flex().gap(8).items_center()
        .child(div().min_w(0).flex_shrink(1).truncate().text_size(13.5).font_semibold().text_color(quiet ? t.muted : t.foreground).child(row.name))
        .when(row.chiefs.length > 0, (el) => el.child(chiefMark(t, row, now)))
        .child(div().flex_1())
        .when(row.needs > 0, (el) => el.child(div().flex_none().text_size(11.5).font_semibold().text_color(t.blocked).child(`${row.needs} ${row.needs === 1 ? "needs" : "need"} you`)))
        .when(row.moving > 0, (el) => el.child(div().flex_none().text_size(11.5).text_color(t.foreground).child(`${row.moving} moving`)))
        .when(quiet, (el) => el.child(div().flex_none().text_size(11.5).text_color(t.dim).child("Quiet"))))
      .when(Boolean(sub), (el) => el.child(div().truncate().text_size(11.5).text_color(t.muted).child(sub))));
}






// Live, or the last sighting with where and when, or Unknown.
function stateText(a, now) {
  return a.state === "live" ? "Live" : a.state === "seen" ? ["Last seen", a.where, a.at ? M.ago(a.at, now) : null].filter(Boolean).join(" ") : "Unknown";
}





// ---------- Chief ----------


// A topic row's chief: its presence mark, or a count when several match.
function chiefMark(t, row, now) {
  const [first] = row.chiefs;
  const tip = row.chiefs.length > 1 ? `${row.chiefs.map((c) => c.chief.domain).join(", ")} all match this topic` : `${first.chief.domain} chief · ${stateText(first.agent, now)}`;
  return h_flex().id(`topic-chief-${row.id}`).flex_none().gap(5).items_center().tooltip(tip)
    .child(presence(t, first.agent.state))
    .child(div().text_size(11.5).text_color(first.agent.state === "live" ? t.foreground : t.muted).child(row.chiefs.length > 1 ? `${row.chiefs.length} chiefs` : "Chief"));
}








// ---------- Levels ----------

// Wide levels put the work on the left and a narrower column beside it; compact ones stack.
function columns(v, id, main, aside, asideWidth) {
  const scroll = (el) => el.overflow_y_scrollbar().mode("hover");
  if (v.compact) {
    return scroll(v_flex().id(id).flex_1().min_h(0).px(v.role === "panel" ? 8 : 14).pb(20).children([...main, ...aside].filter(Boolean)));
  }
  return h_flex().id(id).flex_1().min_h(0).items_start().gap(24).px(16)
    .child(scroll(v_flex().id(`${id}-main`).flex_1().min_w(0).h_full().pb(24).children(main.filter(Boolean))))
    .child(scroll(v_flex().id(`${id}-aside`).w(asideWidth).flex_none().h_full().pb(24).children(aside.filter(Boolean))));
}

export function factoryLevel(v, t, jobs, rows, now) {
  const names = new Map(rows.map((r) => [r.id, r.name]));
  const needs = L.needsQueue(jobs);
  const main = [section(t, "Needs you", needs.length || null, needs.length ? t.blocked : t.dim),
    needs.length ? v_flex().id("needs-queue").gap(8).children(needs.map((need) => needRow(v, t, need, names, now)))
      : div().px(4).text_size(12.5).text_color(t.muted).child("Nothing needs you.")];
  const aside = [section(t, "Topics", null), v_flex().id("topic-rows").gap(2).children(rows.map((row) => topicRow(v, t, row, now)))];
  return columns(v, "factory", main, aside, 400);
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
