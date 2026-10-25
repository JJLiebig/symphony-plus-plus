// Replays the sample timeline: where every package is at a step, how long it has been there,
// and the rooms it passed through. Pure, so the view and the tests read the same frames.

export const ROOMS = {
  desk: { label: "Your desk", waiting: true },
  yard: { label: "Yard", waiting: true },
  build: { label: "Build bay" },
  checks: { label: "Checks" },
  review: { label: "Review room" },
  merge: { label: "Merge dock" },
  shipped: { label: "Shipped" },
};

export function frameAt(fixture, step) {
  const last = Math.max(0, Math.min(step, fixture.events.length - 1));
  const at = fixture.events[last].at;
  const state = new Map(fixture.packages.map((pkg) => [pkg.id, {
    ...pkg, room: null, enteredAt: null, startedAt: null, shippedAt: null, visits: [],
    agent: null, agentSince: null, round: 0, stage: null, pr: null, needs: null, needsSince: null,
  }]));
  for (let i = 0; i <= last; i++) {
    const event = fixture.events[i];
    for (const [id, change] of Object.entries(event.set)) {
      const pkg = state.get(id);
      if (!pkg) continue;
      if (change.room && change.room !== pkg.room) {
        const open = pkg.visits.at(-1);
        if (open) open.to = event.at;
        pkg.visits.push({ room: change.room, from: event.at, to: null });
        pkg.room = change.room;
        pkg.enteredAt = event.at;
        if (change.room !== "yard" && pkg.startedAt === null) pkg.startedAt = event.at;
        if (change.room === "shipped") pkg.shippedAt = event.at;
        if (change.room !== "review") { pkg.round = 0; pkg.stage = null; }
        if (change.room !== "desk") { pkg.needs = null; pkg.needsSince = null; }
      }
      if ("agent" in change) {
        pkg.agent = change.agent;
        pkg.agentSince = event.at;
      }
      if (change.round !== undefined) pkg.round = change.round;
      if (change.stage !== undefined) pkg.stage = change.stage;
      if (change.pr !== undefined) pkg.pr = change.pr;
      if (change.needs !== undefined) { pkg.needs = change.needs; pkg.needsSince = event.at; }
    }
  }
  const packages = [...state.values()].map((pkg) => {
    const blocker = pkg.dependsOn ? state.get(pkg.dependsOn) : null;
    return {
      ...pkg,
      visits: pkg.visits.map((v) => ({ ...v, to: v.to ?? at })),
      inRoom: pkg.enteredAt === null ? 0 : at - pkg.enteredAt,
      wall: pkg.startedAt === null ? 0 : (pkg.shippedAt ?? at) - pkg.startedAt,
      waitingFor: blocker && blocker.room !== "shipped" ? blocker : null,
      idleFor: pkg.agent?.status === "idle" && pkg.room !== "review" ? at - pkg.agentSince : null,
      needsFor: pkg.needs ? at - pkg.needsSince : null,
    };
  });
  return { step: last, at, text: fixture.events[last].text, packages };
}

// A package's journey, split into running and waiting time per room (an idle agent is waiting).
export function journey(pkg) {
  const parts = [];
  for (const visit of pkg.visits) {
    if (visit.room === "shipped") continue;
    const idleFrom = pkg.idleFor !== null && visit === pkg.visits.at(-1) ? visit.to - pkg.idleFor : null;
    const waiting = Boolean(ROOMS[visit.room]?.waiting);
    if (idleFrom !== null && idleFrom > visit.from) parts.push({ room: visit.room, from: visit.from, to: idleFrom, waiting });
    parts.push({ room: visit.room, from: idleFrom ?? visit.from, to: visit.to, waiting: waiting || idleFrom !== null });
  }
  return parts.filter((part) => part.to > part.from);
}

export function duration(minutes) {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function clock(startClock, minutes) {
  const total = (startClock + minutes) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

// Attention first, then the most recently moved package.
export function defaultSelection(frame) {
  const needs = frame.packages.find((pkg) => pkg.needs);
  if (needs) return needs.id;
  return [...frame.packages].sort((a, b) => (b.enteredAt ?? -1) - (a.enteredAt ?? -1))[0]?.id ?? null;
}
