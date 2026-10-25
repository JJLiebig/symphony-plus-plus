// S++ chrome 1 for the personal desk-tabs mod (cloned from Herdr's tabs 0.1.4): buttons for panels
// mods register in shared("workspace.panel_buttons"), S++'s own included, beside Files and Changes,
// with the same toggle. Each edit's `find` must occur exactly once in the mod; `replace` takes its place.
export default {
  mod: 'desk-tabs',
  edits: [
    {
      find: `import { spaces, panes, run, openOverlay, theme, window, shared, layout } from "herdr";
`,
      replace: `import { spaces, panes, run, openOverlay, theme, window, shared, setShared, layout } from "herdr";
`,
    },
    {
      find: `  init() { this.pressed = null; }
`,
      replace: `  init(_props, cx) {
    this.pressed = null;
    // S++ chrome 1: the S++ panel's button, registered here because this bar is always shown and
    // Herdr starts the S++ panel only once it is.
    cx.spawn(async () => {
      const list = shared("workspace.panel_buttons");
      const others = Array.isArray(list) ? list.filter(b => b?.id !== "sympp") : [];
      const sympp = { id: "sympp", label: "S++", icon: "mods/sympp/mark.png", iconDark: "mods/sympp/mark-dark.png" };
      if (JSON.stringify(Array.isArray(list) ? list.find(b => b?.id === "sympp") : null) !== JSON.stringify(sympp)) setShared("workspace.panel_buttons", [...others, sympp]);
    });
  }
`,
    },
    {
      find: `    const enabled = shared("workspace.panels") ?? ["files", "changes"];
`,
      replace: `    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    // S++ chrome 1: panels other mods register in shared("workspace.panel_buttons") as { id, label, icon,
    // iconDark? }; each shows beside Files and Changes while panel-body holds a child with that id. An SVG
    // icon is tinted like Files and Changes; a picture shows as it is, iconDark on a dark theme.
    const registered = shared("workspace.panel_buttons");
    const panelChildren = find(layout(), "panel-body")?.children ?? [];
    const extra = (Array.isArray(registered) ? registered : []).filter(b => typeof b?.id === "string" && typeof b.label === "string" && typeof b.icon === "string"
      && b.id !== "files" && b.id !== "changes" && panelChildren.some(c => c.id === b.id));
    const rgb = parseInt(/^#([0-9a-f]{6})/i.exec(t.chrome ?? "")?.[1] ?? "ffffff", 16);
    const dark = ((rgb >> 16) * 299 + ((rgb >> 8) & 255) * 587 + (rgb & 255) * 114) / 1000 < 128;
`,
    },
    {
      find: `    const panelButton = (id, label, icon) => {
`,
      replace: `    const panelButton = (id, label, icon, iconDark) => {
`,
    },
    {
      find: `        }).child(svg(icon).size(14)).child(label);
`,
      replace: `        }).child(icon.endsWith(".svg") ? svg(icon).size(14) : image(dark && iconDark ? iconDark : icon).w(14).h(14)).child(label);
`,
    },
    {
      find: `      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
`,
      replace: `      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .children(extra.map(b => panelButton(b.id, b.label, b.icon, typeof b.iconDark === "string" ? b.iconDark : null)))
`,
    },
  ],
};
