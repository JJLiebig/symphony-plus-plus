// What a task's drill-in opens in place: the answer form for a question and a package's review
// drill-down (Review Suite's stage, its step ladder and each round).

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Button } from "gpui-base";
import * as M from "./model.js";
import * as Rv from "./review.js";
import { CLEAR, MONO, icon, tint, cap, button, field, mark } from "./ui.js";

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

// ---------- Review drill-down ----------

function stageTone(t, tone) {
  return { active: t.accent, waiting: t.foreground, good: t.ansi2, bad: t.blocked }[tone] ?? t.muted;
}

// Review Suite's stage in plain words, its step ladder, then each round newest first.
export function reviewPane(v, t, pkg, ctx, narrow) {
  const d = Rv.reviewDetail(pkg, ctx.now);
  const stat = (label, value, hot) => v_flex().flex_none().gap(2)
    .child(div().text_size(11).text_color(t.muted).child(label))
    .child(div().text_size(narrow ? 15 : 18).font_family(MONO).font_medium().text_color(value === null ? t.dim : hot ? t.working : t.foreground).child(value ?? "—"));
  const observed = d.observation === "stale" ? "Stale: this may no longer match the code"
    : d.observation === "unknown" ? "No report from the review provider yet" : null;
  return v_flex().id(`review-${pkg.id}`).gap(14).pt(narrow ? 0 : 14).min_w(0)
    .child(v_flex().gap(4)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(["Review", d.provider].filter(Boolean).join(" · ")))
        .child(button(t, "review-close", narrow ? null : "Close", (cx) => v.closeReview(cx), { glyph: "x", tip: "Back to the rails (Esc)" })))
      .when(!narrow, (el) => el.child(div().w_full().truncate().text_size(15).font_semibold().text_color(t.foreground).child(pkg.title)))
      .child(h_flex().gap(7).items_center().pt(2)
        .child(stageMark(t, d.stage))
        .child(div().flex_1().min_w(0).text_size(13).font_medium().text_color(d.stage ? stageTone(t, d.stage.tone) : t.muted)
          .child(d.stage ? d.stage.text : d.reviewed ? "Stage not reported" : "No review recorded for this package")))
      .when(Boolean(observed), (el) => el.child(div().pl(15).text_size(11.5).text_color(t.muted).child(observed)))
      .when(d.observedAt !== null, (el) => el.child(div().pl(15).text_size(11).text_color(t.dim).child(`Reported ${M.ago(d.observedAt, ctx.now)}`))))
    .when(d.reviewed, (el) => el
      .child(h_flex().gap(narrow ? 18 : 28).items_start()
        .child(stat("This round", d.round, false))
        .child(stat("Overall", d.overall, false))
        .child(stat("Rounds", String(d.total), false)))
      .child(ladder(t, d))
      .child(rounds(v, t, pkg, d, ctx)));
}

function stageMark(t, stage) {
  if (!stage) return div().w(8).h(1.5).flex_none().bg(t.dim);
  const color = stageTone(t, stage.tone);
  if (stage.tone === "good") return svg(icon("check")).size(11).flex_none().text_color(color);
  if (stage.tone === "bad") return div().size(8).flex_none().rounded(1.5).bg(color);
  if (stage.tone === "waiting") return div().size(8).flex_none().rounded(4).border(1.5).border_color(color);
  return div().size(8).flex_none().rounded(4).bg(color);
}

function ladder(t, d) {
  const body = d.ladder
    ? h_flex().gap_x(14).gap_y(6).flex_wrap().children(d.ladder.map((step, i) => h_flex().id(`review-step-${i}`).gap(6).items_center()
      .accessibility_label(`${step.name}, ${step.state ?? "state not reported"}`)
      .child(step.state === "done" ? svg(icon("check")).size(11).flex_none().text_color(t.ansi2)
        : step.state === "current" ? div().size(8).flex_none().rounded(4).bg(t.accent)
          : div().size(8).flex_none().rounded(4).border(1.5).border_color(t.dim))
      .child(div().text_size(12).text_color(step.state === "current" ? t.foreground : step.state === "done" ? t.muted : t.dim)
        .when(step.state === "current", (el) => el.font_semibold()).child(step.name))))
    : div().text_size(12).text_color(d.progress ? t.foreground : t.muted).child(d.progress ?? "No steps reported");
  return v_flex().id("review-ladder").gap(7).child(div().text_size(11.5).font_medium().text_color(t.dim).child("Steps")).child(body);
}

function rounds(v, t, pkg, d, ctx) {
  const focus = v.review?.pkgId === pkg.id ? v.review.round : null;
  const when = (r) => {
    const from = Rv.clock(r.startedAt, ctx.now);
    const to = r.current ? "now" : Rv.clock(r.finishedAt, ctx.now);
    return from || to ? `${from ?? "start not recorded"} → ${to ?? "end not recorded"}` : "Times not recorded";
  };
  return v_flex().id("review-rounds").gap(2)
    .child(div().pb(5).text_size(11.5).font_medium().text_color(t.dim).child("Rounds"))
    .when(!d.rows.length, (el) => el.child(div().text_size(12).text_color(t.muted).child(d.total ? `${d.total} round${d.total === 1 ? "" : "s"} · no round history reported` : "No rounds yet")))
    .children(d.rows.map((r) => h_flex().id(`review-round-${r.n}`).gap(10).px(8).py(6).rounded(5).items_center()
      .bg(r.n === focus ? t.selected : r.current ? tint(t.accent, "10") : CLEAR)
      .accessibility_label(`Round ${r.n}, ${[r.lane, r.step].filter(Boolean).join(", ") || "lane not reported"}, ${r.outcome}, ${when(r)}${r.took ? `, ${r.took}` : ""}`)
      .child(div().w(30).flex_none().text_size(11.5).font_family(MONO).text_color(t.muted).child(`R${r.n}`))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().truncate().text_size(12).text_color(r.lane || r.step ? t.foreground : t.muted).child([r.lane, r.step].filter(Boolean).join(" · ") || "Lane not reported"))
        .child(div().truncate().text_size(11).font_family(MONO).text_color(t.dim).child(when(r))))
      .child(h_flex().flex_none().gap(5).items_center()
        .child(outcomeMark(t, r.kind))
        .child(div().text_size(11.5).text_color(r.kind ? t.foreground : t.muted).child(r.findings !== null ? `${r.outcome} (${r.findings})` : r.outcome)))
      .child(div().w(54).flex_none().flex().justify_end().text_size(11.5).font_family(MONO).text_color(r.current ? t.foreground : r.took ? t.muted : t.dim).child(r.took ?? "—"))))
    .when(d.omitted > 0, (el) => el.child(div().px(8).pt(4).text_size(11.5).text_color(t.muted)
      .child(`${d.omitted} earlier round${d.omitted === 1 ? "" : "s"} not in the reported history`)));
}

function outcomeMark(t, kind) {
  if (kind === "clean") return svg(icon("check")).size(11).flex_none().text_color(t.ansi2);
  if (kind === "findings") return div().size(7).flex_none().rounded(1.5).bg(t.working);
  if (kind === "blocked") return div().size(7).flex_none().rounded(1.5).bg(t.blocked);
  if (kind === "running") return div().size(7).flex_none().rounded(4).bg(t.accent);
  return div().w(7).h(1.5).flex_none().bg(t.dim);
}
