// S++ chrome 1 for the personal desk-tabs mod (cloned from Herdr's tabs 0.1.4): buttons for panels
// other mods register in shared("workspace.panel_buttons"), beside Files and Changes, with the
// same toggle. Each edit's `find` must occur exactly once in the mod; `replace` takes its place.
export default {
  mod: 'desk-tabs',
  edits: [
    {
      find: `    const enabled = shared("workspace.panels") ?? ["files", "changes"];
`,
      replace: `    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    // S++ chrome 1: panels other mods register in shared("workspace.panel_buttons") as { id, label, icon };
    // each shows beside Files and Changes while panel-body holds a child with that id.
    const registered = shared("workspace.panel_buttons");
    const extra = (Array.isArray(registered) ? registered : []).filter(b => typeof b?.id === "string" && typeof b.label === "string" && typeof b.icon === "string"
      && b.id !== "files" && b.id !== "changes" && body?.children?.some(c => c.id === b.id));
`,
    },
    {
      find: `      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
`,
      replace: `      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .children(extra.map(b => panelButton(b.id, b.label, b.icon)))
`,
    },
  ],
};
