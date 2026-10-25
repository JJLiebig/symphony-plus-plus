// S++ chrome 1 for the personal desk-agents mod (cloned from Herdr's agents 0.1.4): the S++ mark on
// agents whose terminal carries S++ labels, with their package's stage from the S++ view's reads.
// Each edit's `find` must occur exactly once in the mod; `replace` takes its place.
export default {
  mod: 'desk-agents',
  edits: [
    {
      find: `export default class Agents extends View {
`,
      replace: `// S++ chrome 1: an S++ agent (its terminal carries S++ launch or session labels) shows the S++ mark.
// The S++ view's reads (shared("sympp.agents"), by terminal address) add its package's stage, the
// review round (from the third in the working color) and a dot when it needs you. A read older than
// two minutes shows dimmed, as last known.
const SYMPP_STAGES = { build: "Build", checks: "Checks", review: "Review", merge: "Ready to merge", landed: "Landed" };
function symppBadge(t, k, now) {
  const l = k?.labels ?? {};
  const launched = l["sympp.launch_id"] && (l["sympp.work_package_id"] || l["sympp.work_request_id"]);
  const session = l["sympp.session_id"] && (l["sympp.session_work_package_id"] || l["sympp.session_work_request_id"]);
  if (!launched && !session) return [];
  const d = shared("sympp.agents")?.[k.address];
  const old = !(now - d?.at <= 120000);
  const stage = SYMPP_STAGES[d?.stage] ? d.stage : null;
  const round = stage === "review" && Number.isSafeInteger(d.round) ? d.round : null;
  const tone = old ? t.dim : round >= 3 ? t.working : stage === "landed" ? t.done : t.muted;
  const said = [stage && SYMPP_STAGES[stage] + (round ? \` · round \${round}\` : ""), d?.needs && "Needs you"].filter(Boolean).join(" · ");
  return [h_flex().id(\`sympp-\${k.address}\`).flex_none().gap(3).items_center()
    .tooltip(said ? \`S++ · \${old ? "last known: " : ""}\${said}\` : "S++")
    .child(svg("mods/sympp/mark.svg").size(12).flex_none().text_color(old ? t.dim : t.muted))
    .when(Boolean(stage), el => el.child(svg(\`mods/sympp/stage-\${stage}.svg\`).size(12).flex_none().text_color(tone)))
    .when(Boolean(round), el => el.child(div().text_size(10).text_color(tone).child(String(round))))
    .when(Boolean(d?.needs), el => el.child(div().size(6).flex_none().rounded(3).bg(old ? t.dim : t.blocked)))];
}

export default class Agents extends View {
`,
    },
    {
      find: `      .child(div().flex_1().min_w(0).truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
`,
      replace: `      .child(div().flex_1().min_w(0).truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .children(symppBadge(t, k, Date.now()))
`,
    },
    {
      find: `        .when(Boolean(machine), el => el.child(div().text_size(10).text_color(t.dim).child(machine)))
`,
      replace: `        .children(symppBadge(t, all.find((k) => k.address === a.address), now))
        .when(Boolean(machine), el => el.child(div().text_size(10).text_color(t.dim).child(machine)))
`,
    },
  ],
};
