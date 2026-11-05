// The floor plan: rooms on a fixed map, where each package stands in its room, and the path a
// package walks between rooms (out through its door, along the corridor, in through the next).

export const CARD = { w: 184, full: 76, slim: 52, crate: 26 };
const PAD = 12;
const LABEL = 36;
const GAP = 10;
const RING = { rx: 110, ry: 60 };

function room(id, x, y, w, h, wall) {
  return { id, x, y, w, h, wall, area: { x: x + PAD, y: y + LABEL, w: w - PAD * 2, h: h - LABEL - PAD } };
}

// Wide: two rows of rooms either side of a corridor, the shipping dock along the right.
// Narrow: one column of rooms off a corridor on the left, your desk first.
export function plan(kind) {
  if (kind === "wide") {
    const corridor = { x: 0, y: 258, w: 1070, h: 52, axis: "x" };
    const rooms = [
      room("yard", 0, 0, 210, 250, "bottom"),
      room("build", 220, 0, 530, 250, "bottom"),
      room("checks", 760, 0, 310, 250, "bottom"),
      room("desk", 0, 318, 210, 282, "top"),
      room("review", 220, 318, 630, 282, "top"),
      room("merge", 860, 318, 210, 282, "top"),
      room("shipped", 1080, 0, 96, 600, "left"),
    ];
    const review = rooms.find((r) => r.id === "review");
    review.ring = { cx: review.x + PAD + CARD.w / 2 + RING.rx, cy: review.y + LABEL + (review.h - LABEL - PAD) / 2, ...RING };
    const benchX = review.ring.cx + RING.rx + CARD.w / 2 + PAD;
    review.bench = { x: benchX, y: review.area.y, w: review.x + review.w - PAD - benchX, h: review.area.h };
    return finish({ kind, w: 1176, h: 600, corridor, rooms });
  }
  const heights = [["desk", 124], ["yard", 164], ["build", 210], ["checks", 210], ["review", 332], ["merge", 210], ["shipped", 70]];
  const rooms = [];
  let y = 0;
  for (const [id, h] of heights) {
    rooms.push(room(id, 50, y, 490, h, "left"));
    y += h + GAP;
  }
  const h = y - GAP;
  const review = rooms.find((r) => r.id === "review");
  review.ring = { cx: review.x + PAD + CARD.w / 2 + RING.rx, cy: review.y + LABEL + RING.ry + CARD.full / 2, ...RING };
  const benchY = review.ring.cy + RING.ry + CARD.full / 2 + 12;
  review.bench = { x: review.area.x, y: benchY, w: review.area.w, h: review.y + review.h - PAD - benchY };
  return finish({ kind, w: 540, h, corridor: { x: 0, y: 0, w: 40, h, axis: "y" }, rooms });
}

function finish(floor) {
  const { corridor } = floor;
  for (const r of floor.rooms) {
    r.door = r.wall === "bottom" ? { x: r.x + r.w / 2, y: r.y + r.h }
      : r.wall === "top" ? { x: r.x + r.w / 2, y: r.y }
      : { x: r.x, y: corridor.axis === "x" ? corridor.y + corridor.h / 2 : r.y + r.h / 2 };
  }
  floor.room = Object.fromEntries(floor.rooms.map((r) => [r.id, r]));
  return floor;
}

export function shapeOf(pkg) {
  if (pkg.room === "shipped") return "crate";
  if (pkg.room === "yard" || !pkg.agent) return "slim";
  return "full";
}

function sizeOf(shape) {
  return shape === "crate" ? { w: CARD.crate, h: CARD.crate } : { w: CARD.w, h: CARD[shape] };
}

// Grid slots in an area; a crowded room overlaps its cards like a stack rather than spilling out.
function grid(area, count, w, h, gap) {
  const cols = Math.max(1, Math.floor((area.w + gap) / (w + gap)));
  const rows = Math.ceil(count / cols);
  const pitch = rows > 1 ? Math.min(h + gap, (area.h - h) / (rows - 1)) : h + gap;
  return Array.from({ length: count }, (_, i) => ({ x: area.x + (i % cols) * (w + gap), y: area.y + Math.floor(i / cols) * pitch }));
}

// The empty benches a room holds when nobody is at them, so a room reads as a place.
export function stations(r) {
  if (r.id === "shipped") return [];
  const area = r.bench ?? r.area;
  const h = CARD[r.id === "yard" ? "slim" : "full"];
  const cols = Math.max(1, Math.floor((area.w + GAP) / (CARD.w + GAP)));
  const rows = Math.max(1, Math.floor((area.h + GAP) / (h + GAP)));
  return grid(area, cols * rows, CARD.w, h, GAP).map((p) => ({ ...p, w: CARD.w, h }));
}

// Twelve stops round the review track, clockwise from the top: reviewing at 0, fixing at 6.
export function ringStops(ring) {
  const s = ring.rx - ring.ry;
  const d = ring.ry * Math.SQRT1_2;
  const right = [[0, -ring.ry], [s, -ring.ry], [s + d, -d], [ring.rx, 0], [s + d, d], [s, ring.ry]];
  const left = right.map(([x, y]) => [-x, -y]);
  return [...right, ...left].map(([x, y]) => ({ x: ring.cx + x, y: ring.cy + y }));
}

export const STOP = { review: 0, fix: 6 };

// Where every package stands now: { id: { x, y, w, h, shape, stop? } }.
export function place(floor, packages) {
  const spots = {};
  const byRoom = {};
  for (const pkg of packages) {
    if (!pkg.room) continue;
    (byRoom[pkg.room] ??= []).push(pkg);
  }
  for (const [id, list] of Object.entries(byRoom)) {
    const r = floor.room[id];
    list.sort((a, b) => a.enteredAt - b.enteredAt);
    let rest = list;
    // One package rides the review track; an idle one waits on the bench until it is free.
    const rider = r.ring && list.find((pkg) => pkg.agent?.status !== "idle");
    if (rider) {
      const stop = STOP[rider.stage] ?? STOP.review;
      const point = ringStops(r.ring)[stop];
      spots[rider.id] = { x: point.x - CARD.w / 2, y: point.y - CARD.full / 2, w: CARD.w, h: CARD.full, shape: "full", stop, round: rider.round };
      rest = list.filter((pkg) => pkg !== rider);
    }
    if (!rest.length) continue;
    const shape = shapeOf(rest[0]);
    const { w, h } = sizeOf(shape);
    const slots = grid(r.bench ?? r.area, rest.length, w, h, shape === "crate" ? 6 : GAP);
    rest.forEach((pkg, i) => {
      const own = shapeOf(pkg);
      spots[pkg.id] = { ...slots[i], ...sizeOf(own), shape: own };
    });
  }
  return spots;
}

// The legs a package walks from one spot to the next. Each leg is a target and how long to take.
export function route(floor, from, to, fromRoom, toRoom) {
  if (!from || fromRoom === toRoom) {
    if (from && from.stop !== undefined && to.stop !== undefined && (from.stop !== to.stop || from.round !== to.round)) {
      return lap(floor.room[toRoom].ring, from, to);
    }
    return [{ ...to, ms: 420, easing: "ease-in-out" }];
  }
  const { corridor } = floor;
  const lane = (door) => corridor.axis === "x"
    ? { x: door.x, y: corridor.y + corridor.h / 2 }
    : { x: corridor.x + corridor.w / 2, y: door.y };
  const a = lane(floor.room[fromRoom].door);
  const b = lane(floor.room[toRoom].door);
  const travel = Math.hypot(b.x - a.x, b.y - a.y);
  const at = (p, size) => ({ ...size, x: p.x - size.w / 2, y: p.y - size.h / 2 });
  return [
    { ...at(a, from), ms: 260, easing: "ease-in" },
    { ...at(b, from), ms: Math.round(Math.min(900, Math.max(240, travel * 0.9))), easing: "linear" },
    { ...to, ms: 340, easing: "ease-out" },
  ];
}

// Clockwise round the track; a new round with no change of stop is one full lap.
function lap(ring, from, to) {
  const stops = ringStops(ring);
  let steps = (to.stop - from.stop + stops.length) % stops.length;
  if (steps === 0) steps = stops.length;
  const legs = [];
  for (let i = 1; i <= steps; i++) {
    const p = stops[(from.stop + i) % stops.length];
    const last = i === steps;
    legs.push({ ...to, x: p.x - to.w / 2, y: p.y - to.h / 2, ms: last ? 220 : 130, easing: last ? "ease-out" : "linear" });
  }
  return legs;
}
