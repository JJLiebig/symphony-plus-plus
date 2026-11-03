// S++ chrome 1 for the personal desk-topics mod (cloned from Herdr's spaces 0.1.4): a crown on a topic
// header for that topic's S++ chief. Optional: a desk without desk-topics gets the rest of the chrome.
// Each edit's `find` must occur exactly once in the mod; `replace` takes its place. The injected code
// imports what it uses itself; the only mod locals it touches (this, id, t, workspace) are in its anchors.
export default {
  mark: 'S++ chrome 1',
  mod: 'desk-topics',
  optional: true,
  edits: [
    {
      find: `export default class Topics extends Spaces {
`,
      replace: `// S++ chrome 1: a topic with a registered S++ chief shows a crown at the right of its header, from
// the chiefs the S++ panel shares per topic (shared("sympp.chiefs"), terminal only while confirmed
// running). Click opens the chief: its pane when it has one, else a peek. Right-click adds it to a
// composition. Dimmed and inert while the chief isn't running.
import { div as symppDiv, svg as symppSvg } from "gpui-kit";
import { h_flex as symppRow } from "gpui-base";
import { shared as symppShared, terminals as symppTerminals, panes as symppPanes, run as symppRun, openOverlay as symppOverlay } from "herdr";
function symppChief(topics, topic, t, workspace) {
  const chiefs = symppShared("sympp.chiefs")?.[topic] ?? [];
  if (!topic || !chiefs.length) return [];
  const chief = chiefs.find((c) => c.terminal) ?? chiefs[0];
  const term = chief.terminal && symppTerminals().find((k) => k.address === chief.terminal && k.state === "live");
  const label = term ? \`\${chief.domain} chief\` : \`\${chief.domain} chief isn't running\`;
  const stop = (_e, cx) => { topics.clearDrag(); cx.stop_propagation(); };
  return [symppDiv().flex_1(), symppRow().id(\`sympp-chief-\${topic}\`).flex_none().h(20).px(4).gap(3).items_center().rounded(4)
    .text_color(term ? t.muted : t.dim).when(!term, (el) => el.opacity(0.5))
    .tooltip(label).accessibility_label(label)
    .when(Boolean(term), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)))
    .on_mouse_down("left", stop)
    .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
    .on_mouse_down("right", (e, cx) => {
      stop(e, cx);
      if (term) symppOverlay({ mod: "desk-compositions", kind: "popup", width: 524, frame: "none", props: { role: "context-menu", tab: "agent", target: { terminal: term.address } } });
    })
    .on_click((_e, cx) => {
      cx.stop_propagation();
      if (!term) return;
      if (symppPanes().some((p) => p.terminal === term.address)) { workspace(); symppRun("pane.focus", { terminal: term.address }); }
      else symppRun("terminal.peek", { terminal: term.address });
    })
    .child(symppSvg("mods/sympp/crown.svg").size(12))
    .when(Boolean(term?.status) && term.status !== "idle", (el) => el.child(topics.status(term, t)))];
}

export default class Topics extends Spaces {
`,
    },
    {
      find: `        .when(Boolean(group?.folded), (el) => el.child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim))));
`,
      replace: `        .when(Boolean(group?.folded), (el) => el.child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)))
        .children(symppChief(this, group ? id : null, t, workspace)));
`,
    },
  ],
};
