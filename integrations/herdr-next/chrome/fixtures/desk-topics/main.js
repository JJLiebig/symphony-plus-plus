import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Button, InputState, Input } from "gpui-base";
import { spaces, machines, run, exec, appHome, openOverlay, closeOverlay, props, theme, shared, setShared, layout, nextCommand } from "herdr";
import * as fs from "fs/promises";
import Spaces from "./base.js";
import { assign, orderRows } from "./model.js";
import { createSpace } from "./create-space.js";

// Space colors, the same way every mod that draws space avatars keeps them (see picker).
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const PROJECT_COLORS = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
function spaceColors() {
  const ids = new Set(spaces().map((p) => p.id));
  const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
  let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
  for (const p of spaces()) {
    if (kept[p.id] || p.name === "~") continue;
    const uses = (c) => Object.values(kept).filter((v) => v === c).length;
    kept[p.id] = PROJECT_COLORS.reduce((best, c) => (uses(c) < uses(best) ? c : best));
    changed = true;
  }
  if (changed) setShared("space.colors", kept);
  return kept;
}

// A project's own icon: a favicon, else a logo in its web folder. Images load only from
// the app's folder, so git copies it into this mod's data (a write into the mod's own
// folder would reload it).
const ICON = /(^|\/)(favicon[^/]*|(public|static)\/[^/]*logo[^/]*)\.(svg|png|ico)$/i;
const SKIP = /(^|\/)(node_modules|vendor|target|dist|build|tests?|fixtures)\//i;
const rank = (f) => [/favicon/i.test(f) ? 0 : 1, ["svg", "png", "ico"].indexOf(f.split(".").pop().toLowerCase()), f.split("/").length];
const better = (a, b) => { const x = rank(a), y = rank(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };

const state = () => shared("desk.topics") ?? { groups: [], unsorted: [] };
const store = (value) => setShared("desk.topics", value);
const workspace = () => run("layout.select", { stack: "desk-views", child: "desk-workspace" });
function workspaceShown(node) {
  if (node?.id === "desk-views") return node.active === "desk-workspace";
  return (node?.children ?? []).some(workspaceShown);
}

export default class Topics extends Spaces {
  init(p, cx) {
    this.press = null;
    this.drag = null;
    this.over = null;
    if (props()?.role === "machine-menu") {
      this.machine = null;
      this.handle = cx.focus_handle();
      this.handle.focus();
    } else if (props()?.role === "topic") {
      this.text = state().groups.find((g) => g.id === props().topic)?.name ?? "";
      this.input = InputState.new({ value: this.text, placeholder: "Topic or company name" });
      this.input.on("change", (_e, cx) => { this.text = this.input.value(); cx.notify(); });
      this.input.on("submit", () => this.saveTopic());
      this.input.focus();
    } else {
      this.icons = {}; // repo -> its icon's path, null: none (or not looked for: a machine away)
      this.kids = {}; // space -> the worktree spaces shown under it
      this.nested = new Set();
      this.trees = new Set(JSON.parse(localStorage.getItem("worktrees.folded") ?? "[]")); // spaces whose worktrees are hidden
      super.init(p, cx);
      cx.timer.every(2000, (cx) => this.findIcons(cx));
      cx.spawn(async (cx) => {
        for (;;) {
          const command = await nextCommand();
          if (command.startsWith("new-space--")) {
            const { topic, machine } = JSON.parse(decodeURIComponent(command.slice(11)));
            cx.spawn(async (cx) => { await createSpace(topic, machine); cx.notify(); });
            continue;
          }
          if (command !== "next" && command !== "prev" && !/^select-\d+$/.test(command)) continue;
          const ordered = [...state().groups.flatMap((g) => this.rowsFor(g.id)), ...this.rowsFor(null)].flatMap((r) => [r, ...(this.kids[r.w.id] ?? [])]);
          const current = ordered.findIndex((r) => r.w.active);
          const at = command.startsWith("select-") ? Number(command.slice(7)) - 1 :
            command === "next" ? (current + 1) % ordered.length : (current - 1 + ordered.length) % ordered.length;
          if (ordered[at]) { workspace(); run("space.select", { id: ordered[at].w.id }); }
          cx.notify();
        }
      });
    }
  }

  findIcons(cx) {
    for (const g of Object.values(this.git)) {
      if (!g || g.repo in this.icons) continue;
      this.icons[g.repo] = null;
      const [on, common] = JSON.parse(g.repo);
      if (on || !common.endsWith("/.git")) continue;
      const top = common.slice(0, -5), repo = g.repo;
      cx.spawn(async (cx) => {
        const files = (await exec("git", ["ls-files", "-z"], { cwd: top })).stdout.split("\0").filter((f) => ICON.test(f) && !SKIP.test(f));
        const best = files.sort(better)[0];
        const dir = `data/desk-topics/icons/${top.split("/").pop()}/`, at = `${appHome().replaceAll("\\", "/")}/${dir}`;
        if (best) {
          const r = await exec("git", ["checkout-index", "-f", `--prefix=${at}`, "--", best], { cwd: top });
          if (r.code === 0) { this.icons[repo] = dir + best; cx.notify(); }
          return;
        }
        // No icon of its own: its GitHub owner's (a fork's: the original's), kept once per owner in
        // owners/<owner>.png, so putting a better picture there replaces it. GitHub has no per-repo
        // icon, only a wide social banner. curl, because fetch() can't save bytes.
        let url = await exec("git", ["remote", "get-url", "upstream"], { cwd: top });
        if (url.code !== 0) url = await exec("git", ["remote", "get-url", "origin"], { cwd: top });
        const owner = url.code === 0 && url.stdout.match(/github\.com[:/]([^/]+)\//)?.[1];
        if (!owner) return;
        const mine = `data/desk-topics/owners/${owner}.png`, file = `${appHome().replaceAll("\\", "/")}/${mine}`;
        if (!(await fs.exists(file))) {
          const r = await exec("curl", ["-sfL", "--create-dirs", "-o", file, `https://github.com/${owner}.png?size=64`]);
          if (r.code !== 0) return;
        }
        this.icons[repo] = mine;
        cx.notify();
      });
    }
  }

  // The row's last column, as in the agents list: working spins, needs you ✕, done unseen ✓.
  status(w, t) {
    const slot = div().size(14).flex_none().flex().items_center().justify_center();
    if (w.status === "working") return slot.text_size(13).text_color(t.working).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90);
    if (w.status === "blocked") return slot.text_color(t.blocked).child(svg("mods/desk-chrome/x.svg").size(13));
    if (w.status === "done") return slot.text_color(t.done).child(svg("mods/desk-chrome/check.svg").size(13));
    return slot;
  }

  // The project's icon, else its colored initial. A worktree's is a branch, smaller.
  mark(w, g, t, kid = false) {
    if (kid) return div().size(14).flex_none().flex().items_center().justify_center().text_color(t.dim).child(svg("mods/workspace-chrome/branch.svg").size(13));
    const icon = g && this.icons[g.repo];
    if (icon) return image(icon).size(18).flex_none().rounded(4);
    const color = this.colors?.[w.id] ?? "ansi6";
    return h_flex().size(18).flex_none().rounded(5).bg(color.startsWith("#") ? color : (MARK[color] ?? t[color])).items_center().justify_center()
      .text_size(10.5).font_bold().text_color("#ffffff").child(w.name[0]?.toUpperCase() ?? "?");
  }

  topicEditor(topic = null) {
    openOverlay({ mod: "desk-topics", kind: "dialog", width: 420, props: { role: "topic", topic } });
  }

  moveSpace(space, topic, before = null) {
    store(assign(state(), space, topic, before, this.rowsFor(topic).map((r) => r.w.id)));
  }

  clearDrag() { this.press = null; this.drag = null; this.over = null; }

  beginDrag(kind, id, e) {
    this.clearDrag();
    this.press = { kind, id, position: e.position };
  }

  dragOver(id, e, cx) {
    if (!this.press) return;
    const active = Boolean(this.drag);
    // Match GPUI's native 2px drag threshold; a press or jitter is still a click.
    if (!this.drag && Math.hypot(e.position.x - this.press.position.x, e.position.y - this.press.position.y) > 2)
      this.drag = { kind: this.press.kind, id: this.press.id };
    if (this.drag && (!active || this.over !== id)) { this.over = id; cx.notify(); }
  }

  newSpace(topic, machine) {
    workspace();
    // Keep creation on the sidebar's lifetime when a machine popup closes.
    run("desk-topics.new-space--" + encodeURIComponent(JSON.stringify({ topic, machine })).replaceAll(".", "%2E"));
  }

  // + opens a menu: a new space on this computer or a machine, or a new topic.
  newSpaceButton(topic, name, t) {
    const open = (e, cx) => {
      this.clearDrag(); cx.stop_propagation();
      const at = { x: (e.bounds?.x ?? e.position.x) + (e.bounds?.width ?? 0) + 4, y: e.bounds?.y ?? e.position.y };
      openOverlay({ mod: "desk-topics", kind: "popup", width: 240, at, props: { role: "machine-menu", topic } });
    };
    return Button.new(`space-new-${topic ?? "other"}`).size(32).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer().text_color(t.muted)
      .tooltip("New space or topic").accessibility_label("New space or topic")
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", open)
      .on_mouse_down("right", open)
      .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
      .child(svg("mods/workspace-chrome/plus.svg").size(14));
  }

  machineMenu() {
    const TOPIC = "\u0000topic";
    const t = theme(), choices = [null, ...machines().filter((m) => m.name && m.layout === "ready").map((m) => m.name), TOPIC];
    const choose = (machine) => {
      if (machine === TOPIC) this.topicEditor(); else this.newSpace(props()?.topic ?? null, machine);
      closeOverlay(props().overlay);
    };
    return v_flex().id("topic-machine-menu").track_focus(this.handle).w_full().p(5).bg(t.popover).role("menu")
      .on_key_down((e, cx) => {
        const at = Math.max(0, choices.indexOf(this.machine));
        if (e.key === "down") this.machine = choices[(at + 1) % choices.length];
        else if (e.key === "up") this.machine = choices[(at - 1 + choices.length) % choices.length];
        else if (e.key === "enter") { if (choices.includes(this.machine)) choose(this.machine); }
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(div().px(8).pt(3).pb(4).text_size(11).text_color(t.dim).child("New space"))
      .children(choices.map((machine) => v_flex().id(`machine-${machine === TOPIC ? "topic" : machine ?? "local"}-hover`)
        .when(machine === TOPIC, (el) => el.mt(4).pt(4).border_t(1).border_color(t.border))
        .on_hover((on, cx) => { if (on) { this.machine = machine; cx.notify(); } })
        .child(Button.new(`machine-${machine === TOPIC ? "topic" : machine ?? "local"}`).flex().w_full().h(31).px(8).rounded(6)
        .text_size(12.8).text_color(t.foreground).bg(machine === this.machine ? t.selected : t.popover).role("menu_item")
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { cx.stop_propagation(); choose(machine); }).child(machine === TOPIC ? "New topic" : machine ?? "This computer"))));
  }

  menu(w) {
    openOverlay({ mod: "desk-compositions", kind: "popup", width: 524, frame: "none", props: { role: "context-menu", tab: "space", target: { id: w.id } } });
  }

  saveTopic() {
    if (!this.text.trim()) return;
    const next = JSON.parse(JSON.stringify(state()));
    const old = next.groups.find((g) => g.id === props().topic);
    if (old) old.name = this.text.trim();
    else next.groups.push({ id: `topic-${Date.now().toString(36)}`, name: this.text.trim(), spaces: [], folded: false });
    store(next); closeOverlay(props().overlay);
  }

  button(id, label, action) {
    const t = theme();
    return Button.new(id).px(9).py(6).rounded(6).text_size(12).text_color(t.foreground).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); action(); }).child(label);
  }

  moveTopic(topic, delta) {
    const next = JSON.parse(JSON.stringify(state()));
    const at = next.groups.findIndex((g) => g.id === topic), to = at + delta;
    if (at < 0 || to < 0 || to >= next.groups.length) return;
    next.groups.splice(to, 0, next.groups.splice(at, 1)[0]); store(next);
  }

  editor() {
    const p = props(), t = theme();
    const group = state().groups.find((g) => g.id === p.topic);
    return v_flex().w_full().p(18).gap(14).bg(t.popover).text_color(t.foreground)
      .child(div().text_size(15).font_semibold().child(group ? "Edit topic" : "New topic"))
      .child(Input.new(this.input).h(36).px(10).rounded(7).border(1).border_color(t.input).bg(t.background).text_size(13))
      .when(Boolean(group), (el) => el.child(h_flex().gap(5)
        .child(this.button("up", "Move up", () => this.moveTopic(p.topic, -1)))
        .child(this.button("down", "Move down", () => this.moveTopic(p.topic, 1)))
        .child(this.button("delete", "Remove divider", () => {
          const next = JSON.parse(JSON.stringify(state()));
          next.unsorted = [...(next.unsorted ?? []), ...(next.groups.find((g) => g.id === p.topic)?.spaces ?? [])];
          next.groups = next.groups.filter((g) => g.id !== p.topic); store(next); closeOverlay(p.overlay);
        }))))
      .child(h_flex().justify_end().gap(5)
        .child(this.button("cancel", "Cancel", () => closeOverlay(p.overlay)))
        .child(this.button("save", "Save", () => this.saveTopic())));
  }

  rowsFor(topic, all = spaces().filter((w) => !this.nested?.has(w.id)).map((w, i) => ({ w, i, g: null }))) {
    const data = state(), assigned = new Set(data.groups.flatMap((g) => g.spaces));
    const group = data.groups.find((g) => g.id === topic);
    return orderRows(all.filter((r) => group ? group.spaces.includes(r.w.id) : !assigned.has(r.w.id)), group?.spaces ?? data.unsorted ?? []);
  }

  // A quiet label: click folds, right-click edits, a space or topic dropped on it moves there.
  header(group, t, collapsed) {
    const id = group?.id ?? null;
    return h_flex().id(`topic-${id ?? "other"}`).h(26).flex_none().mt(8).px(8).gap(4).items_center().rounded(5).cursor_pointer()
      .when(Boolean(this.drag) && this.over === id, (el) => el.bg(t.hover))
      .on_mouse_down("left", (e) => this.beginDrag("topic", id, e))
      .on_mouse_move((e, cx) => this.dragOver(id, e, cx))
      .on_mouse_up("left", (_e, cx) => {
        cx.stop_propagation(); const { drag, press } = this; this.clearDrag();
        if (drag?.kind === "space") this.moveSpace(drag.id, id);
        else if (drag?.kind === "topic" && drag.id && id && drag.id !== id) {
          const next = JSON.parse(JSON.stringify(state()));
          const at = next.groups.findIndex((g) => g.id === drag.id), [from] = next.groups.splice(at, 1);
          next.groups.splice(next.groups.findIndex((g) => g.id === id), 0, from); store(next);
        } else if (!drag && press?.kind === "topic" && press.id === id && group) {
          const next = JSON.parse(JSON.stringify(state()));
          const g = next.groups.find((g) => g.id === id); g.folded = !g.folded; store(next);
        }
        cx.notify();
      })
      .on_mouse_down("right", () => { if (group) this.topicEditor(id); })
      .when(collapsed, (el) => el.justify_center().child(div().w(14).h(1).bg(t.border)))
      .when(!collapsed, (el) => el.child(div().min_w(0).truncate().text_size(10.5).font_semibold().text_color(t.dim).child((group?.name ?? "Other spaces").toUpperCase()))
        .when(Boolean(group?.folded), (el) => el.child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim))));
  }

  // A space and, unless folded, its worktrees under it.
  withKids(r, t, topic, collapsed) {
    const kids = collapsed || this.trees.has(r.w.id) ? [] : this.kids[r.w.id] ?? [];
    return [this.row(r, t, topic), ...kids.map((k) => this.row(k, t, topic, true))];
  }

  treeToggle(w, t) {
    const n = this.kids[w.id]?.length, folded = this.trees.has(w.id);
    return h_flex().id(`trees-${w.id}`).flex_none().h(20).px(4).gap(3).items_center().rounded(4).text_size(11).text_color(t.dim)
      .tooltip(`${folded ? "Show" : "Hide"} worktrees`).accessibility_label(`${folded ? "Show" : "Hide"} worktrees`)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => { this.clearDrag(); cx.stop_propagation(); })
      .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        folded ? this.trees.delete(w.id) : this.trees.add(w.id);
        localStorage.setItem("worktrees.folded", JSON.stringify([...this.trees]));
        cx.notify();
      })
      .child(svg("mods/workspace-chrome/branch.svg").size(11)).child(String(n));
  }

  row({ w, g }, t, topic, kid = false) {
    const on = w.active && workspaceShown(layout());
    if (shared("sidebar.collapsed") === true) return Button.new(`compact-${w.id}`).flex().h(30).justify_center().items_center().rounded(5)
      .bg(on ? t.selected : t.chrome).tooltip(w.machine ? `${w.name} · ${w.machine}` : w.name).accessibility_label(w.name)
      .hover((s) => s.bg(t.hover)).on_click(() => { workspace(); run("space.select", { id: w.id }); })
      .on_mouse_down("right", () => openOverlay({ mod: "desk-compositions", kind: "popup", width: 524, frame: "none", props: { role: "context-menu", tab: "space", target: { id: w.id }, topicMenu: true } }))
      // No last column here: the status takes the icon's place.
      .child(["working", "blocked", "done"].includes(w.status) ? this.status(w, t) : this.mark(w, g, t));
    return h_flex().id(`topic-space-${w.id}`).h(kid ? 28 : 30).flex_none().px(8).when(kid, (el) => el.pl(30)).gap(9).items_center().rounded(8).cursor_pointer()
      .bg(on ? t.selected : t.chrome).hover((s) => s.bg(t.hover))
      .when(this.drag?.kind === "space" && this.drag.id === w.id, (el) => el.opacity(0.6))
      .when(this.drag && this.over === w.id, (el) => el.border_t(2).border_color(t.accent))
      .on_mouse_down("left", (e) => this.beginDrag("space", w.id, e))
      .on_mouse_move((e, cx) => this.dragOver(w.id, e, cx))
      .on_mouse_up("left", (_e, cx) => {
        cx.stop_propagation(); const { drag: from, press } = this; this.clearDrag();
        if (from?.kind === "space" && from.id !== w.id) this.moveSpace(from.id, topic, w.id);
        else if (!from && press?.kind === "space" && press.id === w.id) { workspace(); run("space.select", { id: w.id }); }
        cx.notify();
      })
      .on_mouse_down("right", () => openOverlay({ mod: "desk-compositions", kind: "popup", width: 524, frame: "none", props: { role: "context-menu", tab: "space", target: { id: w.id }, topicMenu: true } }))
      .child(this.mark(w, g, t, kid))
      .child(div().min_w(0).flex_shrink(1).max_w(150).truncate().text_size(kid ? 12.5 : 13).text_color(t.foreground).child(w.name))
      .child(g ? this.gitTail(g, kid, w.name, t) : div().flex_1())
      .when(!kid && Boolean(this.kids[w.id]?.length), (el) => el.child(this.treeToggle(w, t)))
      .when(Boolean(w.machine), (el) => el.child(div().flex_none().max_w(78).truncate().text_size(11).text_color(t.dim).child(w.machine)))
      .child(this.status(w, t));
  }

  render() {
    if (props()?.role === "machine-menu") return this.machineMenu();
    if (props()?.role === "topic") return this.editor();
    const t = theme(), data = state(), collapsed = shared("sidebar.collapsed") === true;
    const folded = Boolean(shared("desk.sections")?.spaces);
    this.colors = spaceColors();
    // A worktree's space sits under its checkout's, whatever topic either is in.
    const ordered = super.ordered();
    this.kids = {};
    let parent = null;
    for (const r of ordered) if (!r.tree) parent = r; else (this.kids[parent.w.id] ??= []).push(r);
    this.nested = new Set(ordered.filter((r) => r.tree).map((r) => r.w.id));
    const all = ordered.filter((r) => !r.tree).sort((a, b) => a.i - b.i);
    // Each space's icon, for other mods (the composition picker) to show the same. Merged, so a
    // restart still looking for icons doesn't blank them; closed spaces drop out.
    const ids = new Set(spaces().map((s) => s.id)), was = shared("space.icons") ?? {};
    const icons = Object.fromEntries([...Object.entries(was).filter(([id]) => ids.has(id)),
      ...ordered.filter((r) => r.g && this.icons[r.g.repo]).map((r) => [r.w.id, this.icons[r.g.repo]])]);
    if (JSON.stringify(icons) !== JSON.stringify(was)) setShared("space.icons", icons);
    // An empty topic shows only while dragging, to drop a space into it.
    const section = (g) => {
      const rows = this.rowsFor(g?.id, all);
      if (!rows.length && !this.drag) return [];
      return [this.header(g, t, collapsed), ...(g?.folded ? [] : rows.flatMap((r) => this.withKids(r, t, g?.id, collapsed)))];
    };
    return v_flex().size_full().min_h(0).bg(t.chrome)
      .on_hover((on, cx) => { if (!on && this.press) { this.clearDrag(); cx.notify(); } })
      .on_mouse_up("left", (_e, cx) => { if (this.press) { this.clearDrag(); cx.notify(); } })
      .child(h_flex().h(33).flex_none().pl(collapsed ? 6 : 8).pr(collapsed ? 6 : 8).items_center()
        .when(!collapsed, (el) => el.child(Button.new("fold-spaces").size(32).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer().text_color(t.muted)
          .tooltip(`${folded ? "Expand" : "Collapse"} spaces`).accessibility_label(`${folded ? "Expand" : "Collapse"} spaces`)
          .hover((s) => s.bg(t.hover)).on_click(() => run("desk-compositions.toggle-section--spaces"))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(14))))
        .when(!collapsed, (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11.5).font_medium().text_color(t.dim).child("Spaces")))
        .child(this.newSpaceButton(null, null, t)))
      .when(!folded, (el) => el.child(v_flex().id("topic-list").flex_1().min_h(0).px(8).pb(12).overflow_y_scrollbar()
        .children(data.groups.flatMap(section))
        .children(data.groups.length ? section(null) : this.rowsFor(null, all).flatMap((r) => this.withKids(r, t, null, collapsed)))));
  }
}
