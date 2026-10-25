// The levels above a job: Factory (what needs you, then one row per Herdr topic), Topic (its work by
// repository, and its agents) and Space (the work on one repository, and the agents there), under a
// breadcrumb bar. Rows register with the view so keys reach everything a pointer can.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Button } from "gpui-base";
import * as M from "./model.js";
import * as L from "./levels.js";
import { CLEAR, MONO, icon, tint, button, field, mark, presence, pip, section } from "./ui.js";

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
    ? button(t, "pin", v.pin ? "Unpin" : "Pin", (cx) => v.togglePin(cx), { glyph: v.pin ? "pin-off" : "pin", strong: v.pin,
      tip: v.pin ? "Follow Herdr's focus again (P)" : "Stay here instead of following focus (P)" })
    : null;
  if (slim) {
    return h_flex().flex_none().px(v.compact ? 12 : 20).py(7).gap(8).items_center().border_b(1).border_color(t.border)
      .child(path).when(Boolean(pin), (el) => el.child(pin));
  }
  const needed = v.net.data?.offline === true ? div().flex_none().text_size(12).text_color(t.muted).child("Offline copy") : needs > 0
    ? h_flex().gap(7).items_center().flex_none().child(div().size(7).rounded(4).bg(t.blocked)).child(div().text_size(12.5).font_semibold().text_color(t.blocked).child(`You're needed in ${needs}`))
    : div().flex_none().text_size(12.5).text_color(t.muted).child("Nothing needs you");
  const actions = h_flex().gap(4).items_center().flex_none()
    .child(button(t, "new-job", "New job", (cx) => v.openIntake(cx), { strong: true }))
    .child(button(t, "refresh", "Refresh", (cx) => v.retry(cx), { tip: "Read S++ now (R)" }))
    .when(Boolean(v.dashboard), (el) => el.child(button(t, "dashboard", "Dashboard", (cx) => v.openDashboard(cx), { tip: "Open the S++ dashboard (O)" })))
    .when(Boolean(pin), (el) => el.child(pin));
  if (v.compact) {
    return v_flex().flex_none().px(12).pt(8).pb(8).gap(6).border_b(1).border_color(t.border)
      .child(h_flex().gap(8).items_center().child(path))
      .child(h_flex().gap(8).items_center().flex_wrap().child(needed).child(div().flex_1()).child(freshness(v, t, now)).child(actions));
  }
  return h_flex().flex_none().py(9).px(20).gap(16).items_center().border_b(1).border_color(t.border)
    .child(path).child(needed).child(freshness(v, t, now)).child(actions);
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

// ---------- Rows ----------

// A row the keys can reach: registered in reading order, ringed while it holds the keyboard cursor.
function reachable(v, t, el, key, open, label) {
  const on = v.row(key, open);
  return el.cursor_pointer().rounded(8).bg(on ? t.selected : CLEAR).border(1).border_color(on ? t.ring : CLEAR)
    .hover((s) => s.bg(on ? t.selected : t.hover))
    .accessibility_label(label)
    .on_click((_e, cx) => open(cx));
}

function needRow(v, t, need, names, now) {
  const job = need.job;
  const also = v.place.alsoIn(job).map((id) => names.get(id)).filter(Boolean);
  const where = [job.title, names.get(v.place.home(job)), also.length ? `also in ${also.join(", ")}` : null].filter(Boolean).join(" · ");
  const open = (cx) => v.openJob(job, { pkg: need.pkgId }, cx);
  return reachable(v, t, v_flex().id(`need-${need.key}`).flex_none().px(14).py(11).gap(6), `need:${need.key}`, open, `${need.label}: ${need.text}. ${job.title}`)
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

function topicRow(v, t, row) {
  const verdict = row.needs > 0 ? "needs_you" : row.moving > 0 ? "on_track" : "idle";
  const quiet = verdict === "idle" && !row.jobs.length;
  const sub = [row.repos.join(", "), ...row.shared.map((s) => `shares ${s.count} ${s.count === 1 ? "job" : "jobs"} with ${s.name}`)].filter(Boolean).join(" · ");
  return reachable(v, t, h_flex().id(`topic-${row.id}`).flex_none().px(12).py(9).gap(10).items_start(), `topic:${row.id}`, (cx) => v.openTopic(row.id, cx),
    `${row.name}: ${row.needs} need you, ${row.moving} moving`)
    .child(div().pt(5).flex_none().child(mark(t, verdict)))
    .child(v_flex().flex_1().min_w(0).gap(3)
      .child(h_flex().gap(8).items_center()
        .child(div().min_w(0).flex_shrink(1).truncate().text_size(13.5).font_semibold().text_color(quiet ? t.muted : t.foreground).child(row.name))
        .child(div().flex_1())
        .when(row.needs > 0, (el) => el.child(div().flex_none().text_size(11.5).font_semibold().text_color(t.blocked).child(`${row.needs} ${row.needs === 1 ? "needs" : "need"} you`)))
        .when(row.moving > 0, (el) => el.child(div().flex_none().text_size(11.5).text_color(t.foreground).child(`${row.moving} moving`)))
        .when(quiet, (el) => el.child(div().flex_none().text_size(11.5).text_color(t.dim).child("Quiet"))))
      .when(Boolean(sub), (el) => el.child(div().truncate().text_size(11.5).text_color(t.muted).child(sub))));
}

// One dot per package in planned order, a gap between the architect's groups.
function strip(t, job, now) {
  const dots = job.packages.map((pkg, i) => {
    const gap = i > 0 && pkg.group !== job.packages[i - 1].group;
    return div().id(`pip-${job.id}-${pkg.id}`).flex_none().when(gap, (el) => el.ml(5)).tooltip(`${pkg.title}: ${M.stageText(pkg, now)}`).child(pip(t, pkg));
  });
  return h_flex().flex_none().gap(3).items_center().accessibility_label(`${job.counts.done} of ${job.counts.total} packages landed`).children(dots);
}

function jobRow(v, t, job, now, note = null) {
  const loud = job.verdict !== "on_track" && job.verdict !== "idle" && job.verdict !== "settled";
  return reachable(v, t, h_flex().id(`job-${job.id}`).flex_none().px(12).py(v.compact ? 8 : 10).gap(12).items_start(), `job:${job.id}`,
    (cx) => v.openJob(job, {}, cx), `${job.title}, ${M.VERDICT_LABEL[job.verdict]}`)
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
      .child(div().truncate().text_size(11).text_color(t.muted).child([note, `moved ${M.ago(job.lastMoveAt, now)}`].filter(Boolean).join(" · "))));
}

// A job that lives elsewhere: one line that opens the job itself.
function refRow(v, t, ref, names, now) {
  const { job } = ref;
  const note = ref.via ? `via ${ref.via}` : `from ${names.get(ref.from) ?? "another topic"}`;
  return reachable(v, t, h_flex().id(`ref-${ref.at || "other"}-${job.id}`).flex_none().px(12).py(6).gap(10).items_center(), `ref:${ref.at}:${job.id}`,
    (cx) => v.openJob(job, {}, cx), `${job.title}, ${note}`)
    .child(mark(t, job.verdict))
    .child(div().min_w(0).flex_shrink(1).truncate().text_size(12.5).text_color(t.foreground).child(job.title))
    .child(div().flex_none().text_size(11.5).text_color(t.muted).child(note))
    .child(div().flex_1())
    .when(job.verdict === "needs_you", (el) => el.child(div().flex_none().text_size(11.5).font_semibold().text_color(t.blocked).child(M.VERDICT_LABEL.needs_you)))
    .child(div().flex_none().text_size(11).font_family(MONO).text_color(t.dim).child(M.ago(job.lastMoveAt, now)));
}

// Jobs that are only planned fold into one count until asked for.
function planned(v, t, key, jobs, now, note) {
  if (!jobs.length) return [];
  const open = v.expanded.has(key);
  const toggle = reachable(v, t, h_flex().id(`planned-${key}`).flex_none().px(12).py(6).gap(8).items_center(), `planned:${key}`,
    (cx) => v.toggleExpanded(key, cx), `${jobs.length} planned`)
    .child(svg(icon(open ? "chevron-down" : "chevron-right")).size(12).flex_none().text_color(t.dim))
    .child(div().text_size(12).text_color(t.muted).child(`${jobs.length} planned`));
  return [toggle, ...(open ? jobs.map((job) => jobRow(v, t, job, now, note?.(job))) : [])];
}

function spaceChip(v, t, space, topicId) {
  const label = [space.name || M.shortRepo(space.folder) || "Space", space.machine].filter(Boolean).join(" · ");
  return Button.new(`space-${space.id}`).flex().flex_none().items_center().gap(5).h(22).px(7).rounded(6).text_size(11.5).cursor_pointer()
    .border(1).border_color(t.border).text_color(t.muted)
    .hover((s) => s.bg(t.hover).text_color(t.foreground)).focus((s) => s.border_color(t.accent))
    .accessibility_label(`Space ${label}`)
    .on_click((_e, cx) => { cx.stop_propagation(); v.openSpace(space.id, topicId, cx); })
    .child(svg(icon(space.machine ? "server" : "folder")).size(11).flex_none())
    .child(label);
}

function agentRow(v, t, a, now) {
  const action = a.binding ? v.jumps[a.binding.address] : null;
  const state = a.state === "live" ? "Live" : a.state === "seen" ? ["Last seen", a.where, a.at ? M.ago(a.at, now) : null].filter(Boolean).join(" ") : "Unknown";
  const who = [a.provider, a.name && a.name !== a.provider ? a.name : null].filter(Boolean).join(" · ");
  const report = a.report ? `${a.report.status}${a.report.msg ? `: ${a.report.msg}` : ""}${a.report.age ? ` · ${a.report.age}` : ""}` : null;
  return reachable(v, t, h_flex().id(`agent-${a.key}`).flex_none().px(8).py(7).gap(10).items_start(), `agent:${a.key}`,
    (cx) => v.openJob(a.job, { pkg: a.pkgId ?? null }, cx), `${a.role}${a.subject ? ` for ${a.subject}` : ""}, ${state}`)
    .child(div().pt(5).flex_none().child(presence(t, a.state)))
    .child(v_flex().flex_1().min_w(0).gap(2)
      .child(h_flex().gap(6).items_center().min_w(0)
        .child(div().flex_none().text_size(12.5).font_medium().text_color(t.foreground).child(a.role))
        .child(div().min_w(0).truncate().text_size(12).text_color(t.muted).child(a.subject ?? a.job.title)))
      .when(Boolean(a.subject), (el) => el.child(div().truncate().text_size(11.5).text_color(t.muted).child(a.job.title)))
      .child(div().truncate().text_size(11.5).text_color(a.state === "live" ? t.foreground : t.muted).child([state, who].filter(Boolean).join(" · ")))
      .when(Boolean(report), (el) => el.child(div().id(`agent-report-${a.key}`).truncate().text_size(11.5)
        .text_color(a.report.status === "blocked" ? t.blocked : a.report.status === "working" ? t.foreground : t.muted)
        .tooltip("The agent's own status report").child(`Reports ${report}`)))
      .when(Boolean(action?.error), (el) => el.child(div().role("alert").text_size(11.5).text_color(t.blocked).child(action.error))))
    .when(a.state === "live" && v.net.data?.offline === false, (el) => el.child(button(t, `open-${a.key}`, action?.pending ? "Checking…" : "Open", (cx) => v.focusAgent(a.binding, cx),
      { strong: true, glyph: "terminal", tip: `Open the ${a.role.toLowerCase()} terminal`, disabled: Boolean(action?.pending) })));
}

function agentList(v, t, agents, now) {
  return v_flex().id("level-agents").gap(1)
    .child(section(t, "Agents", agents.length || null))
    .when(!agents.length, (el) => el.child(div().px(4).text_size(12).text_color(t.muted).child("No S++ agents seen here.")))
    .children(agents.map((a) => agentRow(v, t, a, now)));
}

// Settled and dormant jobs stay in the dashboard; the level only counts them.
function away(t, count) {
  return count ? div().pt(16).px(4).text_size(11.5).text_color(t.muted).child(`${count} settled or dormant, kept in the dashboard`) : null;
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
  const aside = [section(t, "Topics", null), v_flex().id("topic-rows").gap(2).children(rows.map((row) => topicRow(v, t, row)))];
  return columns(v, "factory", main, aside, 400);
}

export function topicLevel(v, t, topic, groups, agents, names, now) {
  const main = [];
  for (const g of groups) {
    main.push(h_flex().id(`repo-${g.key || "other"}`).pt(18).pb(6).px(4).gap(8).items_center().flex_wrap()
      .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(g.label))
      .children(g.spaces.map((s) => spaceChip(v, t, s, topic.id))));
    main.push(...g.jobs.map((job) => jobRow(v, t, job, now, also(job, v.place, topic.id, names))));
    main.push(...g.refs.map((ref) => refRow(v, t, ref, names, now)));
    main.push(...planned(v, t, `${topic.id}:${g.key}`, g.planned, now));
  }
  const total = groups.reduce((n, g) => n + g.away, 0);
  if (!groups.length) main.push(div().pt(24).px(4).text_size(12.5).text_color(t.muted).child("No spaces or S++ work in this topic."));
  main.push(away(t, total));
  return columns(v, "topic", main, [agentList(v, t, agents, now)], 300);
}

// The other topics a job also touches, named on its row.
function also(job, place, topicId, names) {
  const others = place.alsoIn(job).concat(place.home(job)).filter((id) => id !== topicId).map((id) => names.get(id)).filter(Boolean);
  return others.length ? `also in ${[...new Set(others)].join(", ")}` : null;
}

export function spaceLevel(v, t, found, work, agents, now) {
  const { space } = found;
  const facts = [work.repo, space.machine ? `on ${space.machine}` : "this machine", space.branch].filter(Boolean).join(" · ");
  const note = (job) => {
    const others = work.elsewhere(job);
    return others.length ? `also in ${others.join(", ")}` : null;
  };
  const main = [div().id("space-facts").pt(14).px(4).text_size(11.5).font_family(MONO).text_color(t.muted).child(facts)];
  if (!work.jobs.length && !work.planned.length) {
    main.push(div().id("space-empty").pt(18).px(4).text_size(13).text_color(t.muted).child("No S++ work here. Ordinary Herdr work stays ordinary."));
  } else {
    main.push(section(t, "Work", work.jobs.length || null));
    main.push(...work.jobs.map((job) => jobRow(v, t, job, now, note(job))));
    main.push(...planned(v, t, `space:${space.id}`, work.planned, now, note));
  }
  main.push(away(t, work.away));
  return columns(v, "space", main, [agentList(v, t, agents, now)], 300);
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
