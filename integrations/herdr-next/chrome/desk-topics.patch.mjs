import legacy from './desk-topics.legacy.mjs';
// sympp chrome 4 for the personal desk-topics mod (cloned from Herdr's spaces 0.1.4): the sympp mark on
// each topic header, opening that topic's sympp chief, or starting one when none is running, and the
// topic's chief spaces left out of the list. Optional: a desk without desk-topics gets the rest of the
// chrome. Each edit's `find` must occur exactly once in the mod; `replace` takes its place. The
// injected code imports what it uses itself; the only mod locals it touches (this, id, group, t,
// workspace, super, spaces) are in its anchors.
// The installed chrome 1, kept so an install upgrades it in place.
const chrome1 = {
  mark: 'sympp chrome 1',
  mod: 'desk-topics',
  optional: true,
  edits: [
    {
      find: `export default class Topics extends Spaces {
`,
      replace: `// sympp chrome 1: a topic with a registered sympp chief shows a crown at the right of its header, from
// the chiefs the sympp panel shares per topic (shared("sympp.chiefs"), terminal only while confirmed
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

// The installed chrome 2, kept so an install upgrades it in place.
const chrome2 = {
  mark: 'sympp chrome 2',
  mod: 'desk-topics',
  optional: true,
  previous: [chrome1, legacy],
  edits: [
    {
      find: `export default class Topics extends Spaces {
`,
      replace: `// sympp chrome 2: each topic header shows the sympp mark for that topic's sympp chief, from the chiefs the
// sympp panel shares per topic (shared("sympp.chiefs"), terminal only while confirmed running). Click
// opens the chief: its pane when it has one, else a peek. Right-click adds it to a composition. Greyed
// while the topic has no chief, dimmed while its chief isn't running.
import { div as symppDiv, image as symppImage } from "gpui-kit";
import { h_flex as symppRow } from "gpui-base";
import { shared as symppShared, terminals as symppTerminals, panes as symppPanes, run as symppRun, openOverlay as symppOverlay, theme as symppTheme } from "herdr";
function symppDark() {
  const rgb = parseInt(/^#([0-9a-f]{6})/i.exec(symppTheme().chrome ?? "")?.[1] ?? "ffffff", 16);
  return ((rgb >> 16) * 299 + ((rgb >> 8) & 255) * 587 + (rgb & 255) * 114) / 1000 < 128;
}
function symppChief(topics, topic, name, t, workspace) {
  if (!topic) return [];
  const chiefs = symppShared("sympp.chiefs")?.[topic] ?? [];
  const chief = chiefs.find((c) => c.terminal) ?? chiefs[0];
  const term = chief?.terminal && symppTerminals().find((k) => k.address === chief.terminal && k.state === "live");
  const label = !chief ? \`\${name} has no chief yet\` : term ? \`\${chief.domain} chief\` : \`\${chief.domain} chief isn't running\`;
  const stop = (_e, cx) => { topics.clearDrag(); cx.stop_propagation(); };
  return [symppDiv().flex_1(), symppRow().id(\`sympp-chief-\${topic}\`).flex_none().h(20).px(3).gap(3).items_center().rounded(4)
    .tooltip(label).accessibility_label(label)
    .when(!term, (el) => el.opacity(chief ? 0.55 : 0.3))
    .when(Boolean(term), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
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
    .child(symppImage(\`mods/sympp/mark\${symppDark() ? "-dark" : ""}.svg\`).size(13))
    .when(Boolean(term?.status) && term.status !== "idle", (el) => el.child(topics.status(term, t)))];
}

export default class Topics extends Spaces {
`,
    },
    {
      find: `        .when(Boolean(group?.folded), (el) => el.child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim))));
`,
      replace: `        .when(Boolean(group?.folded), (el) => el.child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)))
        .children(symppChief(this, group ? id : null, group?.name, t, workspace)));
`,
    },
  ],
};

// The installed chrome 3, kept so an install upgrades it in place.
const chrome3 = {
  mark: 'sympp chrome 3',
  mod: 'desk-topics',
  optional: true,
  previous: [chrome2, chrome1, legacy],
  edits: [
    {
      find: `export default class Topics extends Spaces {
`,
      replace: `// sympp chrome 3: each topic header shows the sympp mark for that topic's sympp chief, from the chiefs the
// sympp panel shares per topic (shared("sympp.chiefs"), terminal only while confirmed running). Click
// opens the chief: its pane when it has one, else a peek. Right-click adds it to a composition. Greyed
// while the topic has no chief, dimmed while its chief isn't running; click then opens sympp's Start
// chief dialog.
import { div as symppDiv, image as symppImage } from "gpui-kit";
import { h_flex as symppRow } from "gpui-base";
import { shared as symppShared, terminals as symppTerminals, panes as symppPanes, run as symppRun, openOverlay as symppOverlay, theme as symppTheme } from "herdr";
function symppDark() {
  const rgb = parseInt(/^#([0-9a-f]{6})/i.exec(symppTheme().chrome ?? "")?.[1] ?? "ffffff", 16);
  return ((rgb >> 16) * 299 + ((rgb >> 8) & 255) * 587 + (rgb & 255) * 114) / 1000 < 128;
}
function symppChief(topics, topic, name, t, workspace) {
  if (!topic) return [];
  const chiefs = symppShared("sympp.chiefs")?.[topic] ?? [];
  const chief = chiefs.find((c) => c.terminal) ?? chiefs[0];
  const term = chief?.terminal && symppTerminals().find((k) => k.address === chief.terminal && k.state === "live");
  const label = !chief ? \`\${name} has no chief yet\` : term ? \`\${chief.domain} chief\` : \`\${chief.domain} chief isn't running\`;
  const stop = (_e, cx) => { topics.clearDrag(); cx.stop_propagation(); };
  return [symppDiv().flex_1(), symppRow().id(\`sympp-chief-\${topic}\`).flex_none().h(20).px(3).gap(3).items_center().rounded(4)
    .tooltip(label).accessibility_label(label)
    .when(!term, (el) => el.opacity(chief ? 0.55 : 0.3))
    .cursor_pointer().hover((s) => s.bg(t.hover))
    .on_mouse_down("left", stop)
    .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
    .on_mouse_down("right", (e, cx) => {
      stop(e, cx);
      if (term) symppOverlay({ mod: "desk-compositions", kind: "popup", width: 524, frame: "none", props: { role: "context-menu", tab: "agent", target: { terminal: term.address } } });
    })
    .on_click((_e, cx) => {
      cx.stop_propagation();
      if (!term) return symppOverlay({ mod: "sympp", kind: "window", frame: "none", width: 1, height: 1, props: { role: "chief", topic, name } });
      if (symppPanes().some((p) => p.terminal === term.address)) { workspace(); symppRun("pane.focus", { terminal: term.address }); }
      else symppRun("terminal.peek", { terminal: term.address });
    })
    .child(symppImage(\`mods/sympp/mark\${symppDark() ? "-dark" : ""}.svg\`).size(13))
    .when(Boolean(term?.status) && term.status !== "idle", (el) => el.child(topics.status(term, t)))];
}

export default class Topics extends Spaces {
`,
    },
    {
      find: `        .when(Boolean(group?.folded), (el) => el.child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim))));
`,
      replace: `        .when(Boolean(group?.folded), (el) => el.child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)))
        .children(symppChief(this, group ? id : null, group?.name, t, workspace)));
`,
    },
  ],
};

export default {
  mark: 'sympp chrome 4',
  mod: 'desk-topics',
  optional: true,
  previous: [chrome3, chrome2, chrome1, legacy],
  edits: [
    {
      find: `export default class Topics extends Spaces {
`,
      replace: `// sympp chrome 4: each topic header shows the sympp mark for that topic's sympp chief, from the chiefs the
// sympp panel shares per topic (shared("sympp.chiefs"), terminal only while confirmed running). Click
// peeks at a running chief; shift-click switches to its space and tab. Right-click opens sympp's chief
// menu. Greyed while the topic has no chief, dimmed while its chief isn't running; click then opens
// sympp's Start chief dialog. A topic's chief spaces aren't listed: the mark leads there, a topic
// holding one keeps its header, and the header is highlighted while one is shown. With the sidebar
// collapsed, a running chief's mark takes the place of its topic's divider.
import { div as symppDiv, image as symppImage } from "gpui-kit";
import { h_flex as symppRow } from "gpui-base";
import { shared as symppShared, terminals as symppTerminals, panes as symppPanes, run as symppRun, openOverlay as symppOverlay, theme as symppTheme, spaces as symppSpaces, layout as symppLayout } from "herdr";
function symppDark() {
  const rgb = parseInt(/^#([0-9a-f]{6})/i.exec(symppTheme().chrome ?? "")?.[1] ?? "ffffff", 16);
  return ((rgb >> 16) * 299 + ((rgb >> 8) & 255) * 587 + (rgb & 255) * 114) / 1000 < 128;
}
// Each topic's chief spaces, as sympp's Start chief knows them: the ones it made for the topic
// (shared("sympp.chief.spaces"): { [space]: topic }), or named "<topic> chief" in it.
function symppChiefSpaces() {
  const made = symppShared("sympp.chief.spaces") ?? {}, names = new Map(symppSpaces().map((s) => [s.id, s.name]));
  const out = new Map();
  for (const g of symppShared("desk.topics")?.groups ?? []) for (const id of g.spaces ?? []) {
    if (made[id] === g.id || names.get(id) === \`\${g.name} chief\`) out.set(id, g.id);
  }
  return out;
}
// The rows without chief spaces; worktrees listed under one stay listed, on their own.
function symppUnlisted(rows) {
  const hidden = symppChiefSpaces();
  let gone = false;
  return rows.flatMap((r) => {
    if (!r.tree) gone = hidden.has(r.w.id);
    return !gone ? [r] : r.tree ? [{ ...r, tree: null }] : [];
  });
}
function symppDesk(node) {
  if (node?.id === "desk-views") return node.active === "desk-workspace";
  return (node?.children ?? []).some(symppDesk);
}
// The topic whose chief space is shown, if any.
function symppInside(topic) {
  const shown = symppSpaces().find((s) => s.active);
  return Boolean(topic && shown && symppChiefSpaces().get(shown.id) === topic && symppDesk(symppLayout()));
}
function symppChief(topics, topic, name, t, workspace, compact = false) {
  if (!topic) return [];
  const chiefs = symppShared("sympp.chiefs")?.[topic] ?? [];
  const chief = chiefs.find((c) => c.terminal) ?? chiefs[0];
  const term = chief?.terminal && symppTerminals().find((k) => k.address === chief.terminal && k.state === "live");
  if (compact && !term) return [];
  const label = !chief ? \`\${name} has no chief yet\` : term ? \`\${chief.domain} chief\` : \`\${chief.domain} chief isn't running\`;
  const stop = (_e, cx) => { topics.clearDrag(); cx.stop_propagation(); };
  return [...(compact ? [] : [symppDiv().flex_1()]), symppRow().id(\`sympp-chief-\${topic}\`).flex_none().h(20).px(3).gap(3).items_center().rounded(4)
    .tooltip(label).accessibility_label(label)
    .when(!term, (el) => el.opacity(chief ? 0.55 : 0.3))
    .cursor_pointer().hover((s) => s.bg(t.hover))
    .on_mouse_down("left", stop)
    .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
    .on_mouse_down("right", (e, cx) => {
      stop(e, cx);
      symppOverlay({ mod: "sympp", kind: "popup", width: 240, frame: "none", props: { role: "chief-menu", topic, name, terminal: term?.address ?? null } });
    })
    .on_click((e, cx) => {
      cx.stop_propagation();
      if (!term) return symppOverlay({ mod: "sympp", kind: "window", frame: "none", width: 1, height: 1, props: { role: "chief", topic, name } });
      if (e.modifiers?.shift && symppPanes().some((p) => p.terminal === term.address)) { workspace(); symppRun("pane.focus", { terminal: term.address }); }
      else symppRun("terminal.peek", { terminal: term.address });
    })
    .child(symppImage(\`mods/sympp/mark\${symppDark() ? "-dark" : ""}.svg\`).size(13))
    .when(Boolean(term?.status) && term.status !== "idle", (el) => el.child(topics.status(term, t)))];
}

export default class Topics extends Spaces {
`,
    },
    {
      find: `  rowsFor(topic, all = spaces().filter((w) => !this.nested?.has(w.id)).map((w, i) => ({ w, i, g: null }))) {
`,
      replace: `  rowsFor(topic, all = symppUnlisted(spaces().filter((w) => !this.nested?.has(w.id)).map((w, i) => ({ w, i, g: null })))) {
`,
    },
    {
      find: `    return h_flex().id(\`topic-\${id ?? "other"}\`).h(26).flex_none().mt(8).px(8).gap(4).items_center().rounded(5).cursor_pointer()
`,
      replace: `    return h_flex().id(\`topic-\${id ?? "other"}\`).h(26).flex_none().mt(8).px(8).gap(4).items_center().rounded(5).cursor_pointer()
      .when(symppInside(id), (el) => el.bg(t.selected))
`,
    },
    {
      find: `        .when(Boolean(group?.folded), (el) => el.child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim))));
`,
      replace: `        .when(Boolean(group?.folded), (el) => el.child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)))
        .children(symppChief(this, group ? id : null, group?.name, t, workspace)));
`,
    },
    {
      find: `      .when(collapsed, (el) => el.justify_center().child(div().w(14).h(1).bg(t.border)))
`,
      replace: `      .when(collapsed, (el) => {
        const chief = symppChief(this, group ? id : null, group?.name, t, workspace, true);
        return el.justify_center().children(chief.length ? chief : [div().w(14).h(1).bg(t.border)]);
      })
`,
    },
    {
      find: `      if (!rows.length && !this.drag) return [];
`,
      replace: `      if (!rows.length && !this.drag && ![...symppChiefSpaces().values()].includes(g?.id)) return [];
`,
    },
    {
      find: `    const ordered = super.ordered();
`,
      replace: `    const ordered = symppUnlisted(super.ordered());
`,
    },
  ],
};
