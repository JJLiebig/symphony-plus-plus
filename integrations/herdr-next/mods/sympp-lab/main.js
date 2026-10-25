// S++ Lab: a job as a factory floor, on sample data. Packages stand in rooms, walk the corridor
// between them and circle the review track once per round; a replay steps through the job.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Button } from "gpui-base";
import { theme, nextCommand } from "herdr";
import { JOB, PACKAGES, EVENTS } from "./fixtures.js";
import * as M from "./model.js";
import * as F from "./floor.js";

const FIXTURE = { packages: PACKAGES, events: EVENTS };
const LAST = EVENTS.length - 1;
const STEP_MS = 2600;
const SIZE_MS = 360;
const ORDER = ["desk", "yard", "build", "checks", "review", "merge", "shipped"];
const icon = (name) => `mods/sympp-lab/${name}.svg`;
const tint = (color, alpha) => (/^#[0-9a-f]{6}$/i.test(color ?? "") ? color + alpha : color);
const CLEAR = "#00000000";
const MONO = "Geist Mono";

const TONE = { desk: "blocked", yard: "dim", build: "ansi4", checks: "ansi3", review: "ansi5", merge: "ansi6", shipped: "done" };
const KEYS = { right: "next", l: "next", left: "prev", h: "prev", home: "first", end: "last", space: "play", m: "motion", down: "down", j: "down", up: "up", k: "up" };
const PROVIDER = { Codex: ["CX", "ansi6"], Claude: ["CL", "ansi3"], OpenCode: ["OC", "ansi5"] };

export default class Lab extends View {
  init(_props, cx) {
    this.keys = cx.focus_handle();
    this.motion = readSetting("motion") !== "off";
    this.frame = M.frameAt(FIXTURE, LAST);
    this.selected = M.defaultSelection(this.frame);
    this.kind = null;
    this.floor = null;
    this.spots = {};
    this.shown = {};
    this.legs = [];
    this.playing = null;
    // Herdr does not repaint a mod when the window resizes, so check the layout band now and then.
    cx.timer.every(1000, (cx) => {
      let width;
      try { width = window.viewport_size().width; } catch { return; }
      if (bandOf(width) !== this.band) cx.notify();
    });
    // Herdr commands ("sympp-lab.next" in keys.json or `herdr-app do`) drive the replay too.
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (this.act(command, cx)) cx.notify();
      }
    });
  }

  // ---------- Timeline ----------

  goTo(step, cx) {
    const next = M.frameAt(FIXTURE, step);
    if (next.step === this.frame.step) return;
    const rooms = Object.fromEntries(this.frame.packages.map((pkg) => [pkg.id, pkg.room]));
    this.frame = next;
    this.walk(rooms, cx);
    if (!next.packages.some((pkg) => pkg.id === this.selected && pkg.room)) this.selected = M.defaultSelection(next);
    cx.notify();
  }

  // Sends every package that changed spot along its route, one leg after another.
  walk(rooms, cx) {
    for (const task of this.legs) task.cancel();
    this.legs = [];
    const before = this.spots;
    this.spots = F.place(this.floor, this.frame.packages);
    for (const pkg of this.frame.packages) {
      const to = this.spots[pkg.id];
      if (!to) continue;
      if (!this.motion || !before[pkg.id]) {
        this.shown[pkg.id] = { ...to, ms: 0, final: true };
        continue;
      }
      const legs = F.route(this.floor, before[pkg.id], to, rooms[pkg.id], pkg.room);
      legs[legs.length - 1].final = true;
      this.shown[pkg.id] = legs[0];
      let wait = legs[0].ms;
      for (const leg of legs.slice(1)) {
        this.legs.push(cx.timer.after(wait, (cx) => {
          this.shown[pkg.id] = leg;
          cx.notify();
        }));
        wait += leg.ms;
      }
    }
  }

  play(cx) {
    if (this.playing) {
      this.pause();
      return cx.notify();
    }
    if (this.frame.step === LAST) this.goTo(0, cx);
    this.playing = cx.timer.every(STEP_MS, (cx) => {
      if (this.frame.step >= LAST) this.pause();
      else this.goTo(this.frame.step + 1, cx);
      cx.notify();
    });
    cx.notify();
  }

  pause() {
    this.playing?.cancel();
    this.playing = null;
  }

  step(delta, cx) {
    this.pause();
    this.goTo(this.frame.step + delta, cx);
    cx.notify();
  }

  jump(step, cx) {
    this.pause();
    this.goTo(step, cx);
    cx.notify();
  }

  toggleMotion(cx) {
    this.motion = !this.motion;
    writeSetting("motion", this.motion ? "on" : "off");
    if (!this.motion) {
      for (const task of this.legs) task.cancel();
      this.legs = [];
      for (const [id, spot] of Object.entries(this.spots)) this.shown[id] = { ...spot, ms: 0, final: true };
    }
    cx.notify();
  }

  select(id, cx) {
    this.selected = id;
    this.keys.focus();
    cx.notify();
  }

  // Packages in floor order, for the arrow keys.
  ordered() {
    return this.frame.packages.filter((pkg) => pkg.room)
      .sort((a, b) => ORDER.indexOf(a.room) - ORDER.indexOf(b.room) || a.enteredAt - b.enteredAt);
  }

  act(command, cx) {
    if (command === "next") this.step(1, cx);
    else if (command === "prev") this.step(-1, cx);
    else if (command === "first") this.jump(0, cx);
    else if (command === "last") this.jump(LAST, cx);
    else if (command === "play") this.play(cx);
    else if (command === "motion") this.toggleMotion(cx);
    else if (command === "down" || command === "up") {
      const list = this.ordered();
      const at = list.findIndex((pkg) => pkg.id === this.selected);
      const next = list[(at + (command === "down" ? 1 : -1) + list.length) % list.length];
      if (next) this.selected = next.id;
    } else return false;
    return true;
  }

  onKey(e, cx) {
    const command = KEYS[e.key];
    if (!command || !this.act(command, cx)) return;
    cx.stop_propagation();
    cx.notify();
  }

  // ---------- Pieces ----------

  button(t, id, label, action, { glyph = null, tip = null, on = false } = {}) {
    return Button.new(id).flex().flex_none().items_center().justify_center().gap(6).h(28).rounded(6).text_size(12).cursor_pointer()
      .when(Boolean(label), (el) => el.px(10)).when(!label, (el) => el.w(28))
      .border(1).border_color(on ? t.input : CLEAR)
      .bg(on ? t.selected : CLEAR)
      .text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .focus((s) => s.border_color(t.accent))
      .accessibility_label(tip ?? label)
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        action(cx);
      })
      .when(Boolean(glyph), (el) => el.child(svg(icon(glyph)).size(14).flex_none()))
      .when(Boolean(label), (el) => el.child(label));
  }

  // A package's state as a shape as well as a colour.
  mark(t, pkg) {
    const base = div().size(8).flex_none();
    if (pkg.needs) return base.rounded(1.5).bg(t.blocked);
    if (pkg.room === "shipped") return svg(icon("check")).size(12).flex_none().text_color(t.done);
    if (pkg.waitingFor) return div().w(8).h(2).flex_none().rounded(1).bg(t.dim);
    if (pkg.idleFor !== null) return base.rounded(4).border(1.5).border_color(t.working);
    if (pkg.agent?.status === "done") return svg(icon("check")).size(12).flex_none().text_color(t.done);
    if (pkg.agent?.status === "working") return base.rounded(4).bg(t.working);
    return base.rounded(4).border(1.5).border_color(t.dim);
  }

  agentTile(t, agent, size = 20) {
    const [initials, tone] = PROVIDER[agent.provider] ?? [agent.provider.slice(0, 2).toUpperCase(), "accent"];
    const status = agent.status === "working" ? t.working : agent.status === "blocked" ? t.blocked : agent.status === "done" ? t.done : t.idle;
    return div().relative().size(size).flex_none().rounded(5).bg(tint(t[tone], "2e")).border(1).border_color(tint(t[tone], "66"))
      .flex().items_center().justify_center()
      .child(div().text_size(size > 20 ? 10.5 : 9).font_semibold().font_family(MONO).text_color(t[tone]).child(initials))
      .child(div().absolute().right(-3).bottom(-3).size(8).rounded(4).bg(status).border(1.5).border_color(t.background)
        .when(this.motion && agent.status === "working", (el) => el.loop("opacity", { from: 0.35, to: 1, period: 1400 })));
  }

  // The package's own line: its agent's report, or why it is not moving.
  note(t, pkg) {
    if (pkg.needs) return div().truncate().text_size(11.5).font_medium().text_color(t.blocked).child(`Needs you · ${M.duration(pkg.needsFor)}`);
    if (pkg.idleFor !== null) return div().truncate().text_size(11.5).font_medium().text_color(t.working).child(`Idle ${M.duration(pkg.idleFor)} · ${pkg.agent.says}`);
    return div().truncate().text_size(11.5).text_color(t.foreground).child(`“${pkg.agent.says}”`);
  }

  badge(t, pkg) {
    const text = pkg.room === "review" && pkg.round ? `Round ${pkg.round}` : pkg.pr ? `#${pkg.pr}` : pkg.noPr ? "No PR" : null;
    if (!text) return null;
    const loud = pkg.room === "review" && pkg.round >= 3;
    return div().flex_none().px(5).h(16).rounded(4).flex().items_center().text_size(10.5).font_family(MONO)
      .border(1).border_color(loud ? tint(t.working, "80") : t.border).text_color(loud ? t.working : t.muted).child(text);
  }

  token(t, pkg, spot, related) {
    const on = pkg.id === this.selected;
    const motion = this.motion && spot.ms > 0;
    const edge = on ? t.accent : pkg.needs ? t.blocked : related ? tint(t.accent, "99") : t.border;
    const el = div().id(`pkg-${pkg.id}`).absolute().left(spot.x).top(spot.y).w(spot.w).h(spot.h)
      .when(motion, (el) => el
        .transition("left", { duration: spot.ms, easing: spot.easing })
        .transition("top", { duration: spot.ms, easing: spot.easing })
        .transition("width", { duration: SIZE_MS, easing: "ease-in-out" })
        .transition("height", { duration: SIZE_MS, easing: "ease-in-out" }))
      .overflow_hidden().cursor_pointer()
      .on_click((_e, cx) => this.select(pkg.id, cx))
      .accessibility_label(`${pkg.title}, ${M.ROOMS[pkg.room].label}`);
    // A walking card keeps its old size, so show only what the package can show now.
    const shape = spot.shape === "full" && !pkg.agent ? "slim" : spot.shape;
    if (shape === "crate") {
      return el.rounded(5).border(1).border_color(on ? t.accent : tint(t.done, "80")).bg(tint(t.done, "26"))
        .flex().items_center().justify_center().tooltip(`${pkg.title} · shipped`)
        .child(svg(icon("check")).size(13).text_color(t.done));
    }
    const card = el.rounded(8).border(on ? 1.5 : 1).border_color(edge).bg(t.background)
      .when(pkg.waitingFor !== null && !on, (c) => c.border_dashed())
      .when(on, (c) => c.shadow_md())
      .hover((s) => s.border_color(on ? t.accent : t.input))
      .px(9).py(shape === "full" ? 7 : 6).line_height("17px").flex().flex_col().gap(shape === "full" ? 4 : 2);
    const top = h_flex().gap(7).items_center().min_w(0)
      .child(this.mark(t, pkg))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_semibold().text_color(pkg.waitingFor ? t.muted : t.foreground).child(pkg.title))
      .child(div().flex_none().text_size(10.5).font_family(MONO).text_color(t.muted).child(M.duration(pkg.inRoom)));
    if (shape === "slim") {
      const why = pkg.room === "shipped" ? "Shipped" : pkg.waitingFor ? `Waits for ${pkg.waitingFor.title}` : "Queued";
      return card.child(top).child(div().pl(15).truncate().text_size(11).text_color(t.muted).child(why));
    }
    return card.child(top)
      .child(h_flex().gap(7).items_center().min_w(0)
        .child(this.agentTile(t, pkg.agent, 16))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(`${pkg.agent.provider} · ${pkg.agent.role}`))
        .children([this.badge(t, pkg)].filter(Boolean)))
      .child(this.note(t, pkg));
  }

  // ---------- Floor ----------

  floorView(t) {
    const floor = this.floor;
    const frame = this.frame;
    const c = floor.corridor;
    const lane = t.background;
    const els = [div().absolute().left(c.x).top(c.y).w(c.w).h(c.h).rounded(8).bg(lane)];
    const span = c.axis === "x" ? c.w : c.h;
    for (let p = 18; p < span - 18; p += 22) {
      els.push(c.axis === "x"
        ? div().absolute().left(c.x + p).top(c.y + c.h / 2 - 1).w(10).h(2).rounded(1).bg(t.border)
        : div().absolute().left(c.x + c.w / 2 - 1).top(c.y + p).w(2).h(10).rounded(1).bg(t.border));
    }
    const count = {};
    for (const pkg of frame.packages) if (pkg.room) count[pkg.room] = (count[pkg.room] ?? 0) + 1;
    for (const r of floor.rooms) els.push(...this.roomView(t, r, count[r.id] ?? 0, lane));

    const review = floor.room.review;
    const rider = frame.packages.find((pkg) => this.spots[pkg.id]?.stop !== undefined);
    els.push(...this.trackView(t, review.ring, rider));

    const selected = frame.packages.find((pkg) => pkg.id === this.selected);
    const related = new Set([selected?.waitingFor?.id, ...frame.packages.filter((pkg) => pkg.waitingFor?.id === this.selected).map((pkg) => pkg.id)]);
    const moving = new Set(Object.entries(this.shown).filter(([, spot]) => !spot.final).map(([id]) => id));
    const tokens = frame.packages.filter((pkg) => this.shown[pkg.id])
      .sort((a, b) => (moving.has(a.id) - moving.has(b.id)) || ((a.id === this.selected) - (b.id === this.selected)));
    for (const pkg of tokens) els.push(this.token(t, pkg, this.shown[pkg.id], related.has(pkg.id)));
    return div().relative().flex_none().w(floor.w).h(floor.h).children(els);
  }

  roomView(t, r, count, lane) {
    const tone = t[TONE[r.id]];
    const occupied = r.id === "desk" && count > 0;
    const els = [
      div().absolute().left(r.x).top(r.y).w(r.w).h(r.h).rounded(10).bg(t.surface)
        .border(occupied ? 1.5 : 1).border_color(occupied ? tint(t.blocked, "b3") : t.input),
      div().absolute().left(r.x + 1).top(r.y + 1).w(r.w - 2).h(r.h - 2).rounded(9).bg(tint(tone, occupied ? "12" : "08")),
    ];
    const vertical = r.wall === "left";
    const d = r.door;
    const c = this.floor.corridor;
    // The doorway: an opening in the wall and a short passage to the corridor.
    if (vertical) {
      const from = Math.min(c.x + c.w, d.x) - 1;
      els.push(div().absolute().left(from).top(d.y - 18).w(d.x - from + 2).h(36).bg(lane));
    } else {
      const top = r.wall === "bottom" ? d.y - 2 : c.y + c.h - 1;
      const bottom = r.wall === "bottom" ? c.y + 1 : d.y + 2;
      els.push(div().absolute().left(d.x - 22).top(top).w(44).h(bottom - top).bg(lane));
    }
    for (const bench of F.stations(r)) {
      els.push(div().absolute().left(bench.x).top(bench.y).w(bench.w).h(bench.h).rounded(8).border(1).border_dashed().border_color(tint(t.border, "80")));
    }
    const label = M.ROOMS[r.id].label;
    els.push(h_flex().absolute().left(r.x + 12).top(r.y + 11).gap(7).items_center()
      .child(div().size(8).rounded(2).bg(tone).when(occupied && this.motion, (el) => el.loop("opacity", { from: 0.4, to: 1, period: 1600 })))
      .child(div().text_size(12).font_semibold().text_color(occupied ? t.blocked : t.foreground).child(label))
      .when(count > 0, (el) => el.child(div().text_size(11).font_family(MONO).text_color(t.muted).child(String(count)))));
    return els;
  }

  // The review track: a loop each round walks, with the round count at its hub.
  trackView(t, ring, rider) {
    const tone = t[TONE.review];
    const els = [
      div().absolute().left(ring.cx - ring.rx).top(ring.cy - ring.ry).w(ring.rx * 2).h(ring.ry * 2).rounded(ring.ry)
        .border(1.5).border_dashed().border_color(tint(tone, rider ? "a6" : "4d")),
      div().absolute().left(ring.cx + ring.rx - 5).top(ring.cy - 7).w(10).text_center().text_size(10).text_color(tone).child("▾"),
      div().absolute().left(ring.cx - ring.rx - 5).top(ring.cy - 7).w(10).text_center().text_size(10).text_color(tone).child("▴"),
    ];
    if (!rider) return els;
    const done = Math.max(0, rider.round - 1);
    els.push(v_flex().absolute().left(ring.cx - 24).top(ring.cy - 22).w(48).items_center().gap(2)
      .accessibility_label(`Review round ${rider.round}`)
      .child(div().text_size(20).font_semibold().text_color(rider.round >= 3 ? t.working : t.foreground).child(String(rider.round)))
      .child(h_flex().gap(3).children(Array.from({ length: Math.min(rider.round, 6) }, (_, i) => i < done
        ? div().size(5).rounded(3).bg(tone)
        : div().size(5).rounded(3).border(1).border_color(tone)))));
    return els;
  }

  // ---------- Inspector ----------

  fact(t, label, value, tone = t.foreground) {
    return v_flex().gap(2).min_w(0)
      .child(div().text_size(11).text_color(t.muted).child(label))
      .child(div().text_size(13).font_family(MONO).text_color(tone).child(value));
  }

  callout(t, tone, title, body, action = null) {
    return v_flex().gap(4).px(12).py(10).rounded(8).bg(tint(tone, "17"))
      .child(h_flex().gap(7).items_center()
        .child(div().size(7).flex_none().rounded(1.5).bg(tone))
        .child(div().text_size(11.5).font_semibold().text_color(tone).child(title)))
      .child(div().text_size(13).text_color(t.foreground).child(body))
      .when(Boolean(action), (el) => el.child(h_flex().pt(2).child(action)));
  }

  inspector(t) {
    const pkg = this.frame.packages.find((p) => p.id === this.selected);
    if (!pkg?.room) return div();
    const room = M.ROOMS[pkg.room];
    const parts = M.journey(pkg);
    const total = parts.reduce((sum, part) => sum + (part.to - part.from), 0) || 1;
    const pr = pkg.pr ? `PR #${pkg.pr}` : pkg.noPr ? "No PR · evidence only" : null;
    return v_flex().gap(16).p(20)
      .child(v_flex().gap(6)
        .child(h_flex().gap(8).items_center().child(this.mark(t, pkg))
          .child(div().flex_1().min_w(0).text_size(16).font_semibold().text_color(t.foreground).child(pkg.title)))
        .child(h_flex().gap(8).items_center().flex_wrap()
          .child(h_flex().gap(6).items_center().child(div().size(8).rounded(2).bg(t[TONE[pkg.room]])).child(div().text_size(12).text_color(t.foreground).child(room.label)))
          .when(Boolean(pr), (el) => el.child(div().text_size(12).font_family(MONO).text_color(t.muted).child(pr)))))
      .when(Boolean(pkg.agent), (el) => el.child(h_flex().gap(10).items_start()
        .child(this.agentTile(t, pkg.agent, 28))
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(h_flex().gap(8).items_center()
            .child(div().text_size(13).font_medium().text_color(t.foreground).child(`${pkg.agent.provider} · ${pkg.agent.role}`))
            .child(div().text_size(11.5).text_color(t.muted).child(cap(pkg.agent.status))))
          .child(div().text_size(12.5).text_color(t.foreground).child(`“${pkg.agent.says}”`)))))
      .when(Boolean(pkg.needs), (el) => el.child(this.callout(t, t.blocked, `Needs you · ${M.duration(pkg.needsFor)}`, pkg.needs)))
      .when(pkg.idleFor !== null, (el) => el.child(this.callout(t, t.working, `Idle ${M.duration(pkg.idleFor)}`, `${pkg.agent?.says}. Nobody has picked it up.`)))
      .when(Boolean(pkg.waitingFor), (el) => el.child(this.callout(t, t.muted, "Waiting", `Starts when ${pkg.waitingFor.title} ships.`,
        this.button(t, "show-blocker", `Show ${pkg.waitingFor.title}`, (cx) => this.select(pkg.waitingFor.id, cx), { on: true }))))
      .child(h_flex().gap(20).flex_wrap()
        .child(this.fact(t, pkg.room === "shipped" ? "Shipped at" : "In room", pkg.room === "shipped" ? M.clock(JOB.startClock, pkg.shippedAt) : M.duration(pkg.inRoom)))
        .child(this.fact(t, pkg.startedAt === null ? "Waiting" : "Wall time", M.duration(pkg.startedAt === null ? pkg.inRoom : pkg.wall)))
        .when(pkg.room === "review" && pkg.round > 0, (el) => el.child(this.fact(t, "Round", String(pkg.round), pkg.round >= 3 ? t.working : t.foreground))))
      .when(parts.length > 0, (el) => el.child(v_flex().gap(8)
        .child(div().text_size(11).text_color(t.muted).child("Journey"))
        .child(h_flex().h(10).w_full().gap(2).children(parts.map((part) => {
          const tone = t[TONE[part.room]];
          return div().h_full().flex_none().w(`${Math.max(1.5, ((part.to - part.from) / total) * 100 - 1)}%`).rounded(2)
            .bg(part.waiting ? tint(tone, "40") : tone)
            .when(part.waiting, (seg) => seg.border(1).border_dashed().border_color(tone));
        })))
        .child(v_flex().gap(3).children(parts.map((part) => h_flex().gap(8).items_center().text_size(11.5)
          .child(div().size(6).flex_none().rounded(2).bg(part.waiting ? tint(t[TONE[part.room]], "40") : t[TONE[part.room]]))
          .child(div().flex_1().min_w(0).text_color(part.waiting ? t.muted : t.foreground).child(`${M.ROOMS[part.room].label}${part.waiting && !M.ROOMS[part.room].waiting ? " · idle" : ""}`))
          .child(div().flex_none().font_family(MONO).text_color(t.muted).child(M.duration(part.to - part.from))))))));
  }

  // ---------- Frame ----------

  header(t) {
    const needs = this.frame.packages.filter((pkg) => pkg.needs).length;
    const shipped = this.frame.packages.filter((pkg) => pkg.room === "shipped").length;
    return h_flex().flex_none().px(20).py(12).gap(16).items_center().flex_wrap().border_b(1).border_color(t.border)
      .child(v_flex().gap(2).min_w(0)
        .child(div().text_size(15).font_semibold().text_color(t.foreground).child(JOB.title))
        .child(div().text_size(11.5).text_color(t.muted).child(`${JOB.repo} · sample job`)))
      .child(div().flex_1())
      .when(needs > 0, (el) => el.child(h_flex().gap(7).items_center().flex_none()
        .child(div().size(8).rounded(1.5).bg(t.blocked))
        .child(div().text_size(12.5).font_semibold().text_color(t.blocked).child(`${needs} needs you`))))
      .child(div().flex_none().text_size(12).text_color(t.muted).child(`${shipped} of ${this.frame.packages.length} shipped`))
      .child(h_flex().flex_none().gap(6).items_baseline()
        .child(div().text_size(11.5).text_color(t.muted).child("Wall time"))
        .child(div().text_size(13).font_family(MONO).text_color(t.foreground).child(M.duration(this.frame.at))));
  }

  timeline(t) {
    const end = EVENTS[LAST].at || 1;
    const step = this.frame.step;
    const pct = (at) => `${(at / end) * 100}%`;
    const track = div().relative().h(22).w_full()
      .child(div().absolute().left(0).top(10).w_full().h(2).rounded(1).bg(t.border))
      .child(div().absolute().left(0).top(10).h(2).rounded(1).bg(t.accent).w(pct(this.frame.at))
        .when(this.motion, (el) => el.transition("width", { duration: 420, easing: "ease-in-out" })))
      .children(EVENTS.map((event, i) => div().absolute().left(pct(event.at)).top(0).w(0).h(22)
        .child(div().id(`tick-${i}`).absolute().left(-6).top(0).w(12).h(22).flex().items_center().justify_center().cursor_pointer()
          .tooltip(`${M.clock(JOB.startClock, event.at)} · ${event.text}`)
          .on_click((_e, cx) => this.jump(i, cx))
          .child(i === step
            ? div().size(10).rounded(5).bg(t.accent).border(2).border_color(t.background)
            : div().size(6).rounded(3).bg(i < step ? t.accent : t.input)))));
    return h_flex().flex_none().px(16).py(10).gap(12).items_center().border_t(1).border_color(t.border).bg(t.chrome)
      .child(h_flex().gap(2).flex_none()
        .child(this.button(t, "first", null, (cx) => this.jump(0, cx), { glyph: "first", tip: "Start (Home)" }))
        .child(this.button(t, "prev", null, (cx) => this.step(-1, cx), { glyph: "prev", tip: "Back (←)" }))
        .child(this.button(t, "play", null, (cx) => this.play(cx), { glyph: this.playing ? "pause" : "play", tip: this.playing ? "Pause (Space)" : "Replay (Space)", on: true }))
        .child(this.button(t, "next", null, (cx) => this.step(1, cx), { glyph: "next", tip: "Forward (→)" }))
        .child(this.button(t, "last", null, (cx) => this.jump(LAST, cx), { glyph: "last", tip: "Now (End)" })))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().gap(8).items_baseline().min_w(0)
          .child(div().flex_none().text_size(12).font_family(MONO).text_color(t.foreground).child(M.clock(JOB.startClock, this.frame.at)))
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(step === LAST ? t.muted : t.foreground).child(this.frame.text)))
        .child(track))
      .child(this.button(t, "motion", this.motion ? "Motion on" : "Motion off", (cx) => this.toggleMotion(cx), { tip: "Animate moves (M)", on: this.motion }));
  }

  render(_cx) {
    const t = theme();
    const width = window.viewport_size().width;
    this.band = bandOf(width);
    const kind = this.band === "wide" ? "wide" : "narrow";
    if (kind !== this.kind) {
      this.kind = kind;
      this.floor = F.plan(kind);
      for (const task of this.legs) task.cancel();
      this.legs = [];
      this.spots = F.place(this.floor, this.frame.packages);
      this.shown = Object.fromEntries(Object.entries(this.spots).map(([id, spot]) => [id, { ...spot, ms: 0, final: true }]));
    }
    const floor = div().id("lab-floor").flex_1().min_w(0).min_h(0).overflow_scrollbar()
      .child(h_flex().min_w_full().min_h_full().justify_center().items_center().p(24).child(this.floorView(t)));
    const side = this.band !== "stacked";
    const body = side
      ? h_flex().flex_1().min_h(0)
        .child(floor)
        .child(div().id("lab-inspector").w(340).flex_none().h_full().border_l(1).border_color(t.border).bg(t.surface).overflow_y_scrollbar().child(this.inspector(t)))
      : v_flex().id("lab-stack").flex_1().min_h(0).overflow_y_scrollbar()
        .child(div().id("lab-floor-narrow").w_full().overflow_x_scrollbar().child(h_flex().min_w_full().justify_center().p(16).child(this.floorView(t))))
        .child(div().border_t(1).border_color(t.border).bg(t.surface).child(this.inspector(t)));
    return v_flex().id("sympp-lab").size_full().min_h(0).bg(t.canvas).text_color(t.foreground).text_size(13)
      .track_focus(this.keys)
      .on_mouse_down("left", () => this.keys.focus())
      .on_key_down((e, cx) => this.onKey(e, cx))
      .child(this.header(t))
      .child(body)
      .child(this.timeline(t));
  }
}

// Wide floor with the inspector beside it, narrow floor with it beside, or both stacked.
function bandOf(width) {
  return width >= 1830 ? "wide" : width >= 1180 ? "side" : "stacked";
}

function cap(text) {
  const value = String(text);
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function readSetting(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeSetting(key, value) {
  try { localStorage.setItem(key, value); } catch { /* settings are a convenience */ }
}
