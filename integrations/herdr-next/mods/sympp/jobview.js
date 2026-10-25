// The Job level: one job as a whole view. Its phase, what needs the person, a stage board of its
// packages, the agents taking part and its recorded decisions. Wide views draw the board in stage
// columns with agents and decisions beside it; narrow ones read top to bottom, grouped by stage.

import { div } from "gpui-kit";
import { v_flex, h_flex, Button } from "gpui-base";
import * as M from "./model.js";
import * as J from "./job.js";
import { CLEAR, MONO, tint, cap, button, field, mark, pip, presence, section, age } from "./ui.js";

// ctx: { now, bindings, terminals, layout: "board" | "list", place: "full" | "side" | "tab", offline }
export function jobView(v, t, job, ctx) {
  const board = J.stageBoard(job);
  const people = J.participants(job, ctx.bindings, v.agentChecks, ctx.now);
  const head = [jobHeader(v, t, job, ctx), phaseStrip(t, J.phaseOf(job), ctx)];
  const work = [...attention(v, t, job, ctx), ...questions(v, t, job), stages(v, t, job, board, ctx)];
  const aside = [agents(v, t, job, people, ctx), decisions(v, t, job, ctx)];
  if (ctx.layout === "board") {
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
  return h_flex().id("phase-strip").gap(4).w_full().when(ctx.layout === "board", (el) => el.max_w(720))
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

function attention(v, t, job, ctx) {
  const asks = job.needs.filter((need) => !need.id);
  const open = job.guidance;
  if (!asks.length && !open.length) return [];
  return [
    section(t, "Needs you", asks.length + open.length, t.blocked),
    v_flex().gap(8)
      .children(asks.map((need) => v_flex().id(`ask-${need.key}`).px(12).py(10).gap(5).rounded(8).bg(tint(t.blocked, "10")).border_l(1).border_color(t.blocked)
        .child(h_flex().gap(8).child(div().text_size(11.5).font_semibold().text_color(t.blocked).child(need.label)).child(div().flex_1())
          .when(need.since !== null, (row) => row.child(age(t, M.ago(need.since, ctx.now)))))
        .child(div().w_full().text_size(13.5).text_color(t.foreground).child(need.text))
        .when(Boolean(v.dashboard), (row) => row.child(h_flex().child(button(t, `ask-answer-${need.key}`, "Answer in dashboard", (cx) => v.openDashboard(cx), { strong: true }))))))
      .children(open.map((question) => v_flex().px(12).rounded(8).bg(tint(t.blocked, "10")).border_l(1).border_color(t.blocked).child(questionRow(v, t, question, true)))),
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

// ---------- Stage board ----------

function stages(v, t, job, board, ctx) {
  if (!board.columns.length) {
    return v_flex().child(section(t, "Packages")).child(div().px(4).text_size(12.5).text_color(t.muted)
      .child(job.closedAt !== null ? "Closed without packages." : "Not sliced into packages yet."));
  }
  const mixed = new Set(job.packages.map((pkg) => pkg.track === "no_pr")).size > 1;
  const cardOf = (pkg) => card(v, t, pkg, J.packageCard(pkg, J.reportFor(M.bindingsFor(ctx.bindings, job.id, pkg.id), ctx.terminals, ctx.now), ctx.now), mixed);
  if (ctx.layout === "board") {
    return v_flex().child(section(t, "Packages", job.packages.length))
      // Columns share the pane's width rather than the window's, so nothing is clipped in a split.
      .child(h_flex().id("stage-board").w_full().gap(8).items_start()
        .children(board.columns.map((column) => {
          const empty = column.packages.length === 0;
          return v_flex().id(`column-${column.key}`).gap(6).when(empty, (el) => el.w(72).flex_none()).when(!empty, (el) => el.flex_1().min_w(0))
            .child(h_flex().h(22).px(2).gap(6).items_center().border_b(1).border_color(t.border)
              .child(div().truncate().text_size(11.5).font_medium().text_color(empty ? t.dim : t.muted).child(column.label))
              .child(div().text_size(11.5).font_family(MONO).text_color(t.dim).child(String(column.packages.length))))
            .children(column.packages.map(cardOf));
        })));
  }
  return v_flex().id("stage-list").children(board.columns.filter((column) => column.packages.length).flatMap((column) => [
    section(t, column.label, column.packages.length),
    v_flex().gap(6).children(column.packages.map(cardOf)),
  ]));
}

function card(v, t, pkg, c, mixed) {
  const on = v.pkgSel === pkg.id;
  const focused = on && v.keys.is_focused();
  const quiet = pkg.stage === "done" || pkg.stage === "queued";
  const reportTone = !c.report ? t.muted : c.report.status === "blocked" || c.report.status === "error" ? t.blocked : c.report.status === "working" ? t.foreground : t.muted;
  const line = (text, tone = t.muted, extra = (el) => el) => (text ? extra(div().w_full().text_size(11.5).text_color(tone).child(text)) : null);
  return v_flex().id(`card-${pkg.id}`).w_full().px(10).py(8).gap(4).rounded(8).cursor_pointer()
    .bg(c.needsYou ? tint(t.blocked, "10") : on ? t.selected : t.surface)
    .border(1).border_color(focused ? t.ring : on ? t.accent : c.needsYou ? tint(t.blocked, "60") : t.border)
    .hover((s) => s.bg(c.needsYou ? tint(t.blocked, "18") : on ? t.selected : t.hover))
    .accessibility_label(`${pkg.title}, ${c.stage ?? "queued"}`)
    .on_click((_e, cx) => v.selectPackage(pkg.id, cx))
    .child(h_flex().gap(8).items_center()
      .child(pip(t, pkg))
      .child(div().id(`title-${pkg.id}`).flex_1().min_w(0).truncate().text_size(12.5).font_medium().text_color(quiet ? t.muted : t.foreground).tooltip(pkg.title).child(pkg.title)))
    .children([
      line([mixed && c.noPr ? "No PR" : null, c.stage].filter(Boolean).join(" · "), c.failed ? t.blocked : t.muted, (el) => el.id(`stage-${pkg.id}`).font_family(MONO).text_size(11).truncate().tooltip(c.stage ?? "")),
      c.after.length ? line(`After ${c.after.join(", ")}`) : null,
      c.holder ? line(`${c.holder.text}${c.holder.observation ? ` · ${c.holder.observation}` : ""}`, c.holder.observation ? t.muted : t.foreground) : null,
      line(J.reportText(c.report), reportTone, (el) => el.id(`report-${pkg.id}`).tooltip("The agent's own status report")),
      line(c.waiting),
      line(c.next ? `Next: ${c.next}` : null, c.needsYou ? t.blocked : t.muted, (el) => el.when(c.needsYou, (x) => x.font_medium())),
      line(c.evidence.join(" · ")),
    ].filter(Boolean));
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
