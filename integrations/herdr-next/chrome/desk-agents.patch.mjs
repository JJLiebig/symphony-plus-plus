// S++ chrome 2 for the personal desk-agents mod (cloned from Herdr's agents 0.1.4): the S++ glyph
// tucked behind an S++ agent's icon, with its package's stage from the S++ view's reads after the name.
// Each edit's `find` must occur exactly once in the mod; `replace` takes its place. The injected code
// imports what it uses itself; the only mod locals it touches (a, k) are in its own anchors.
export default {
  mark: 'S++ chrome 2',
  mod: 'desk-agents',
  edits: [
    {
      find: `export default class Agents extends View {
`,
      replace: `// S++ chrome 2: an S++ agent (its terminal carries S++ launch or session labels) shows the S++ glyph
// behind the right of its icon; the glyph has the icon's ring cut out, so the row shows through it.
// The S++ view's reads (shared("sympp.agents"), by terminal address) add its package's stage, the
// review round (from the third in the working color) and an orange dot when it needs you. A read
// older than two minutes shows dimmed, as last known.
import { div as symppDiv, image as symppImage, svg as symppSvg } from "gpui-kit";
import { h_flex as symppRow } from "gpui-base";
import { shared as symppShared, terminals as symppTerminals, theme as symppTheme } from "herdr";
const SYMPP_STAGES = { build: "Build", checks: "Checks", review: "Review", merge: "Ready to merge", landed: "Landed" };
// The S++ read for an S++ agent's terminal ({} before any), or null for any other terminal.
function symppAgent(address) {
  const l = symppTerminals().find((k) => k.address === address)?.labels ?? {};
  const launched = l["sympp.launch_id"] && (l["sympp.work_package_id"] || l["sympp.work_request_id"]);
  const session = l["sympp.session_id"] && (l["sympp.session_work_package_id"] || l["sympp.session_work_request_id"]);
  return launched || session ? symppShared("sympp.agents")?.[address] ?? {} : null;
}
function symppDark() {
  const rgb = parseInt(/^#([0-9a-f]{6})/i.exec(symppTheme().chrome ?? "")?.[1] ?? "ffffff", 16);
  return ((rgb >> 16) * 299 + ((rgb >> 8) & 255) * 587 + (rgb & 255) * 114) / 1000 < 128;
}
// The glyph inside a 16 px icon slot whose icon is \`icon\` px, centred: it starts 3.5 px before the
// icon's right edge (its cut-out fits a 16 px icon there) and needs 9 px more room after the slot.
function symppGlyph(address, icon) {
  if (!symppAgent(address)) return [];
  return [symppImage(\`mods/sympp/glyph\${symppDark() ? "-dark" : ""}.svg\`).w(14).h(14).absolute().top(1).left(12.5 - (16 - icon) / 2)];
}
function symppStage(address, now) {
  const d = symppAgent(address);
  if (!d) return [];
  const t = symppTheme();
  const old = d.at !== undefined && !(now - d.at <= 120000);
  const stage = SYMPP_STAGES[d.stage] ? d.stage : null;
  const round = stage === "review" && Number.isSafeInteger(d.round) ? d.round : null;
  if (!stage && !d.needs) return [];
  const tone = round >= 3 ? t.working : stage === "landed" ? t.done : t.muted;
  const said = [stage && SYMPP_STAGES[stage] + (round ? \` · round \${round}\` : ""), d.needs && "Needs you"].filter(Boolean).join(" · ");
  return [symppRow().id(\`sympp-\${address}\`).flex_none().gap(3).items_center().when(old, el => el.opacity(0.45))
    .tooltip(\`S++ · \${old ? "last known: " : ""}\${said}\`)
    .when(Boolean(stage), el => el.child(symppSvg(\`mods/sympp/stage-\${stage}.svg\`).size(12).flex_none().text_color(tone)))
    .when(Boolean(round), el => el.child(symppDiv().text_size(10).text_color(tone).child(String(round))))
    .when(Boolean(d.needs), el => el.child(symppImage("mods/sympp/needs.svg").size(7).flex_none()))];
}

export default class Agents extends View {
`,
    },
    {
      find: `      .child(div().size(16).mr(8).flex_none().flex().items_center().justify_center().when(Boolean(pic), el => el.child(pic)))
      .child(div().flex_1().min_w(0).truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
`,
      replace: `      .child(div().size(16).mr(8).flex_none().flex().items_center().justify_center()
        .children(symppGlyph(k.address, 14)).when(Boolean(symppAgent(k.address)), el => el.mr(17)).when(Boolean(pic), el => el.child(pic)))
      .child(div().flex_1().min_w(0).truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .children(symppStage(k.address, Date.now()))
`,
    },
    {
      find: `        .child(div().id(\`agent-fold-\${a.address}\`).size(16).flex_none().flex().items_center().justify_center()
`,
      replace: `        .child(div().id(\`agent-fold-\${a.address}\`).size(16).flex_none().flex().items_center().justify_center()
          .children(symppGlyph(a.address, 16)).when(Boolean(symppAgent(a.address)), el => el.mr(9))
`,
    },
    {
      find: `        .when(Boolean(machine), el => el.child(div().text_size(10).text_color(t.dim).child(machine)))
        .when(subs.length > 0, el => el.child(fold(a, subs)))
`,
      replace: `        .children(symppStage(a.address, Date.now()))
        .when(Boolean(machine), el => el.child(div().text_size(10).text_color(t.dim).child(machine)))
        .when(subs.length > 0, el => el.child(fold(a, subs)))
`,
    },
  ],
};
