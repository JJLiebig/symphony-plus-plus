// Start chief: one line that starts a topic's chief, opened from the topic header's sympp mark while
// the topic has no running chief. Modelled on Herdr's Change anything (app.ask): an agent chip (the
// last one started comes first), a machine chip that starts on the factory's machine, and the line,
// whose text is added to the chief's brief. Enter starts the agent as a normal tab in the topic's own
// "<topic> chief" space on that machine, made once and reused, so the chief stays in its topic like
// any other space. A failure keeps the dialog and its text and says what failed.

import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { theme, props, closeOverlay, knownAgents, machines, spaces, shared, setShared, exec, hc, home, layout, run, settings } from "herdr";
import { chiefBrief, chiefArgv, chiefSpaceName, factoryMachine, chiefFolders, intoTopic } from "./chief.js";

const W = 560;
const H = 46;
// The last agents each machine reported, shown at once while knownAgents() asks again.
const KNOWN = "sympp.chief.agents";
// The agent last started as a chief.
const LAST = "sympp.chief.agent";

// A Herdr command through the app's own CLI, which says what it made or why it couldn't.
async function app(command, args) {
  const result = await exec("herdr-app", ["do", command, JSON.stringify(args)]);
  let out = null;
  try { out = JSON.parse(result.stdout); } catch {}
  if (result.code !== 0 || !out?.terminal) throw new Error(out?.error || result.stderr.trim() || "Herdr didn't say why");
  return out;
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export class ChiefStart {
  constructor(own, endpoint, cx) {
    this.topic = own.topic;
    this.name = typeof own.name === "string" && own.name ? own.name : "Topic";
    this.phase = "ask";
    this.picking = null;
    this.error = null;
    this.agents = {};
    // The last agent shows at once; checking what's installed takes a moment.
    const last = shared(LAST);
    this.agent = last?.run ? last : null;
    this.machine = null;
    // The factory's machine is still being looked up; until then, or a pick, nothing starts.
    this.finding = true;
    this.input = InputState.new({ placeholder: `Start ${this.name} chief…` });
    this.input.on("submit", (_e, cx) => this.start(cx));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
    this.load(null, cx);
    cx.spawn(async (cx) => {
      let list = [];
      try { list = JSON.parse((await hc(["machine", "ls", "--json"])).stdout).machines.filter((m) => !m.temporary); } catch {}
      const ssh = async (target) => (await exec("ssh", ["-G", target])).stdout.match(/^hostname\s+(.+)$/mi)?.[1].trim();
      const machine = await factoryMachine(endpoint, list, ssh).catch(() => undefined);
      // Picked meanwhile: keep it.
      if (machine && !this.picked) { this.machine = machine; this.load(machine, cx); }
      this.finding = false;
      cx.notify();
    });
  }

  // Each machine's agents: the last answer at once, then a fresh one.
  load(machine, cx) {
    const where = machine ?? "";
    if (!this.agents[where]) this.agents[where] = { list: shared(KNOWN)?.[where] ?? null };
    this.choose();
    cx.spawn(async (cx) => {
      try {
        const list = await knownAgents({ on: machine });
        this.agents[where] = { list };
        setShared(KNOWN, { ...shared(KNOWN), [where]: list });
      } catch {
        this.agents[where] = { list: this.agents[where].list, failed: true };
      }
      this.choose();
      cx.notify();
    });
  }

  installed() {
    return (this.agents[this.machine ?? ""]?.list ?? []).filter((a) => a.installed);
  }

  // Keeps the chosen agent where this machine has it, else the last one started, else its first.
  choose() {
    const list = this.installed();
    if (!this.agents[this.machine ?? ""]?.list) return;
    const key = this.agent?.key ?? shared(LAST)?.key;
    this.agent = list.find((a) => a.key === key) ?? list[0] ?? null;
  }

  // Enter starts only once the machine is settled and has the chosen agent installed.
  ready() {
    return (!this.finding || this.picked) && Boolean(this.agent) && this.installed().some((a) => a.key === this.agent.key);
  }

  close() {
    closeOverlay(props().overlay);
  }

  pick(kind, cx) {
    if (this.phase !== "ask") return;
    this.picking = this.picking === kind ? null : kind;
    this.input.focus();
    cx.notify();
  }

  start(cx) {
    const agent = this.agent;
    if (this.phase !== "ask" || !this.ready()) return;
    this.phase = "starting";
    this.picking = null;
    this.error = null;
    cx.notify();
    const machine = this.machine, text = this.input.value();
    cx.spawn(async (cx) => {
      try {
        const desk = shared("desk.topics");
        const all = spaces(), ids = desk?.groups?.find((g) => g.id === this.topic)?.spaces ?? [];
        const mine = all.filter((s) => ids.includes(s.id));
        let folder = "";
        for (const candidate of chiefFolders(mine, all, machine)) {
          // The folder is there when a program can start in it.
          if (await exec("git", ["--version"], { cwd: candidate, on: machine }).then(() => true, () => false)) { folder = candidate; break; }
        }
        // Else the machine's home, said outright: left out, Herdr would start in the focused pane's folder.
        if (!folder) folder = machine ? (await exec("pwd", [], { on: machine })).stdout.trim() : home();
        const argv = chiefArgv(agent, chiefBrief(this.name, text));
        const own = mine.find((s) => s.name === chiefSpaceName(this.name) && (s.machine ?? null) === machine);
        const made = own
          ? await app("tab.new", { space: own.id, name: "chief", argv, ...(folder ? { folder } : {}) })
          : await app("space.new", { name: chiefSpaceName(this.name), tab: "chief", argv, ...(folder ? { folder } : {}), machine: machine ?? "" });
        if (!own) {
          const next = intoTopic(shared("desk.topics"), this.topic, made.space);
          if (next) setShared("desk.topics", next);
        }
        setShared(LAST, { key: agent.key, name: agent.name, icon: agent.icon, tint: agent.tint, run: agent.run });
        // A desk shows its spaces' tabs in its workspace view.
        if (find(layout(), "desk-views")) run("layout.select", { stack: "desk-views", child: "desk-workspace" });
        this.close();
      } catch (error) {
        this.phase = "ask";
        // Herdr's first sentence says what failed; the rest is advice for scripts.
        this.error = `Couldn't start the chief: ${String(error?.message ?? error).split(/(?<=\.)\s/)[0]}`;
        this.input.focus();
        cx.notify();
      }
    });
  }

  agentIcon(a, size) {
    const t = theme();
    if (!a) return div().size(size);
    return a.tint ? svg(a.icon).size(size).text_color(t.foreground) : image(a.icon).size(size);
  }

  chip(id, kind, children) {
    const t = theme();
    return h_flex().id(id).flex_none().h(26).px(5).gap(4).items_center().rounded(5).cursor_pointer()
      .when(this.picking === kind, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.pick(kind, cx))
      .children(children)
      .when(this.phase === "ask", (el) => el.child(svg("mods/workspace-chrome/chevron-down.svg").size(11).text_color(t.dim)));
  }

  choices() {
    const names = machines().filter((m) => m.name && m.layout === "ready").map((m) => m.name);
    return [null, ...names, ...(this.machine && !names.includes(this.machine) ? [this.machine] : [])];
  }

  list(top, x) {
    const t = theme();
    const row = (id, selected, children, choose) => h_flex().id(id).flex_none().h(30).px(8).gap(10).items_center().rounded(6).cursor_pointer()
      .when(selected, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { choose(cx); this.picking = null; this.error = null; this.input.focus(); cx.notify(); })
      .children(children);
    const rows = this.picking === "agent"
      ? this.installed().map((a) => row(`chief-agent-${a.key}`, a.key === this.agent?.key, [this.agentIcon(a, 14), div().child(a.name)], () => { this.agent = a; }))
      : this.choices().map((m) => row(`chief-machine-${m ?? "local"}`, m === this.machine, [this.machineIcon(m, 14), div().child(m ?? "This computer")],
        (cx) => { this.picked = true; this.machine = m; this.load(m, cx); }));
    return v_flex().id("chief-list").absolute().left(x).top(top).w(240).max_h(Math.max(38, this.size.height - top - 16)).overflow_y_scroll().p(4)
      .rounded(8).border_1().border_color(t.border).bg(t.popover).shadow_lg().text_size(12.8).text_color(t.foreground)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .children(rows);
  }

  machineIcon(machine, size) {
    return svg(`mods/workspace-chrome/${machine ? "server" : "monitor"}.svg`).size(size).text_color(theme().muted);
  }

  render() {
    const t = theme();
    const z = settings().zoom ?? 1;
    this.size = this.measured && { width: this.measured.width / z, height: this.measured.height / z };
    const w = this.size && Math.min(W, this.size.width - 32);
    const x = this.size && (this.size.width - w) / 2, y = this.size && Math.round(this.size.height * 0.4 - H / 2);
    const known = this.agents[this.machine ?? ""];
    const none = known?.list ? !this.installed().length : Boolean(known?.failed);
    const box = this.size && div().id("chief-box").absolute().left(x).top(y).w(w).h(H)
      .flex().items_center().rounded(10).border_1().border_color(t.border).bg(t.popover).shadow_lg().overflow_hidden()
      .font_family(settings().font_family).text_size(13).text_color(t.foreground)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(h_flex().id("chief-line").flex_1().h_full().pl(9).pr(14).gap(6).items_center()
        .child(this.chip("chief-agent", "agent", [this.agentIcon(this.agent, 16)]))
        .child(this.chip("chief-machine", "machine", [this.machineIcon(this.machine, 13),
          div().text_size(12).text_color(t.muted).child(this.finding && !this.picked ? "" : this.machine ?? "This computer")]))
        .child(div().flex_none().pl(2).text_color(t.dim).child("❯"))
        .when(this.phase === "ask", (el) => el.child(none
          ? div().flex_1().text_color(t.dim).child(known.list ? "No agents installed" : "Couldn't check agents")
          : Input.new(this.input).flex_1().h_full().text_size(13).text_color(t.foreground)))
        .when(this.phase === "starting", (el) => el
          .child(svg("mods/workspace-chrome/spinner.svg").size(13).flex_none().text_color(t.working).spin(900))
          .child(div().flex_1().min_w(0).truncate().text_color(t.working).child(`Starting ${this.name} chief…`))));
    const below = this.size && y + H + 6;
    const error = this.size && this.error && !this.picking && div().id("chief-error").absolute().left(x).top(below).w(w).px(14)
      .text_size(12).text_color(t.blocked).child(this.error);
    const list = this.size && this.picking && this.list(below, this.picking === "agent" ? x + 9 : x + 56);
    return div().id("chief-start").track_focus(this.handle).size_full().relative()
      .on_size_change((size, cx) => { this.measured = size; cx.notify(); })
      // A press beside the box closes it (and never drags the window).
      .on_mouse_down("left", (_e, cx) => {
        cx.stop_propagation();
        if (this.picking) { this.picking = null; cx.notify(); }
        else if (this.phase === "ask") this.close();
      })
      .on_key_down((e, cx) => {
        // Tab picks the next agent (shift: the one before).
        const list = this.installed();
        if (e.key === "tab" && this.phase === "ask" && list.length > 1) {
          cx.stop_propagation();
          const i = list.findIndex((a) => a.key === this.agent?.key);
          this.agent = list[(i + (e.modifiers.shift ? -1 : 1) + list.length) % list.length];
          cx.notify();
          return;
        }
        if (e.key !== "escape") return;
        cx.stop_propagation();
        if (this.picking) { this.picking = null; cx.notify(); }
        else if (this.phase === "ask") this.close();
      })
      .child(div().absolute().inset_0().bg("#000000").opacity(0.35))
      .when(Boolean(box), (el) => el.child(box))
      .when(Boolean(error), (el) => el.child(error))
      .when(Boolean(list), (el) => el.child(list));
  }
}
