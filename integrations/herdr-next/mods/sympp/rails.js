// Pure package rails: one row per package on a shared real-time axis. Segments start only at
// recorded moments (creation, dispatch, review start, current stage entry, recorded delivery) and
// say who was acting. Nothing is interpolated: an unrecorded stage start is said, not drawn.

import { span, reviewBumps } from "./model.js";

const HOUR = 3600e3;
// Idle stretches longer than this, with nobody acting on any row, fold into a labelled break.
export const BREAK_AFTER = 3 * HOUR;
const BREAK_SHARE = 0.05;
// Room after the now line, as a share of the drawn time.
const NOW_PAD = 0.03;
// Merging is the integrator's work; the person acts only when the canonical next actor says so.
const STAGE_ACTOR = { build: "provider", work: "provider", checks: "ci", review: "provider", merge: "provider" };
// Waiting reasons that mean a review provider or CI is acting on the package: not dimmed.
const ACTING = new Set(["review_in_progress", "validation_pending"]);
export const STAGE_NAME ={ queued: "Queued", build: "Build", work: "Work", checks: "Checks", review: "Review", merge: "Merge", done: "Done" };

// A package without a PR is work, then done.
export function stageOf(pkg, stage = pkg.stage) {
  if (pkg.track === "no_pr" && stage !== "queued" && stage !== "done") return "work";
  return stage;
}

// humanSince: when the person became the next actor, if recorded. The current span turns to "You"
// only from then; without a record, it keeps its stage's actor and is marked as needing the person.
// When the current stage began, by its own record: the backend's entry time, else dispatch for
// build work and the round or review start for review. Checks and merge have no such fallback.
export function stageEntry(pkg) {
  if (pkg.enteredAt !== null && pkg.enteredAt !== undefined) return pkg.enteredAt;
  if (pkg.stage === "build") return pkg.dispatchedAt;
  if (pkg.stage === "review") return pkg.review.roundStartedAt ?? pkg.review.startedAt;
  return null;
}

export function segmentsOf(pkg, now, humanSince = null) {
  const marks = [
    { stage: "queued", at: pkg.createdAt },
    { stage: "build", at: pkg.dispatchedAt },
    { stage: "review", at: pkg.review.startedAt },
    pkg.stage !== "done" ? { stage: pkg.stage, at: stageEntry(pkg) } : null,
    pkg.stage === "done" ? { stage: "done", at: pkg.doneAt } : null,
  ].filter((m) => m && m.at !== null && m.at !== undefined).sort((a, b) => a.at - b.at)
    .map((m) => ({ ...m, stage: stageOf(pkg, m.stage) }))
    .filter((m, i, list) => i === 0 || m.stage !== list[i - 1].stage);
  const segments = [];
  marks.forEach((mark, i) => {
    if (mark.stage === "done") return;
    const to = marks[i + 1]?.at ?? (pkg.stage === "done" ? null : now);
    if (to === null || to <= mark.at) return;
    const current = i === marks.length - 1 && pkg.stage !== "done";
    const actor = mark.stage === "queued" ? (current && pkg.after.length ? "dependency" : "waiting") : STAGE_ACTOR[mark.stage];
    const needsYou = current && actor !== "dependency" && pkg.activity.nextActor === "human";
    const label = actor === "dependency" ? `After ${pkg.after.join(", ")}` : null;
    const base = { stage: mark.stage, current, label, needsYou: false };
    if (needsYou && humanSince !== null && humanSince <= mark.at) {
      segments.push({ ...base, from: mark.at, to, actor: "human", waiting: false });
      return;
    }
    if (needsYou && humanSince !== null && humanSince < to) {
      segments.push({ ...base, current: false, from: mark.at, to: humanSince, actor, waiting: actor === "waiting" });
      segments.push({ ...base, from: humanSince, to, actor: "human", waiting: false });
      return;
    }
    const idle = current && actor !== "dependency" && Boolean(pkg.activity.waitingCode) && !ACTING.has(pkg.activity.waitingCode);
    segments.push({ ...base, from: mark.at, to, actor, waiting: actor === "waiting" || idle, needsYou });
  });
  return segments;
}

// Rounds as the review provider counts them, with each round's recorded history when it has one.
// The third and later are a road bump.
export function roundsOf(pkg) {
  const history = new Map((pkg.review.history ?? []).map((h) => [h.n, h]));
  const reviewed = pkg.review.type || (pkg.review.status && pkg.review.status !== "unavailable") || pkg.review.startedAt !== null || history.size > 0;
  const count = Math.max(pkg.round, ...history.keys());
  if (!reviewed || count < 1 || (pkg.stage === "queued" && count <= 1 && !history.size)) return [];
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const h = history.get(n) ?? null;
    const current = n === count && pkg.stage === "review" && (!h || h.finishedAt === null);
    const outcome = h?.outcome ? `${h.outcome}${h.findings !== null ? ` (${h.findings})` : ""}` : null;
    const took = h?.startedAt !== null && h?.startedAt !== undefined && h.finishedAt !== null ? span(h.finishedAt - h.startedAt) : null;
    return {
      n, label: `R${n}`, current, late: n >= 3, startedAt: h?.startedAt ?? (current ? pkg.review.roundStartedAt : null),
      tip: [`Round ${n}`, current ? "in progress" : null, outcome, took].filter(Boolean).join(" · "),
    };
  });
}

// Wall time since dispatch, time in the current stage, time in the current review.
export function timingsOf(pkg, now) {
  const end = pkg.stage === "done" ? pkg.doneAt : now;
  const reviewFrom = pkg.review.startedAt ?? pkg.review.roundStartedAt;
  return {
    total: pkg.dispatchedAt !== null && end !== null && end >= pkg.dispatchedAt ? span(end - pkg.dispatchedAt) : null,
    stage: pkg.stage !== "done" && pkg.stage !== "queued" && stageEntry(pkg) !== null ? span(now - stageEntry(pkg)) : null,
    review: pkg.stage === "review" && reviewFrom !== null ? span(now - reviewFrom) : null,
  };
}

// Rows that need the person first, then packages others wait on, then the rest; landed work last.
// Within each group the planned sequence keeps positions stable across refreshes.
export function railOrder(job) {
  const blocking = new Set(job.packages.filter((pkg) => pkg.stage !== "done").flatMap((pkg) => pkg.unmet));
  const asked = new Set(job.guidance.map((q) => q.pkgId));
  const rank = (pkg) => {
    if (pkg.stage === "done") return 3;
    if (pkg.activity.nextActor === "human" || asked.has(pkg.id)) return 0;
    return blocking.has(pkg.id) ? 1 : 2;
  };
  return [...job.packages].sort((a, b) => rank(a) - rank(b) || a.seq - b.seq);
}

export function rowsOf(job, now) {
  const since = new Map();
  for (const need of job.needs) {
    if (need.pkgId && need.since !== null) since.set(need.pkgId, Math.min(since.get(need.pkgId) ?? Infinity, need.since));
  }
  return railOrder(job).map((pkg) => ({ pkg, segments: segmentsOf(pkg, now, since.get(pkg.id) ?? null), rounds: roundsOf(pkg), timings: timingsOf(pkg, now), bumps: reviewBumps(pkg, now) }));
}

// Axis labels that never collide: now first, then breaks, then the start of each drawn stretch.
export function axisLabels(axis, now, minGap = 0.1) {
  if (!axis) return [];
  const candidates = [
    { kind: "now", x: axis.nowX, text: "now" },
    ...axis.breaks.map((b) => ({ kind: "break", x: (b.x0 + b.x1) / 2, text: `⋯ ${short(b.to - b.from)}`, tip: `Nobody acted for ${b.label}`, from: b.from })),
    ...axis.pieces.filter((p) => p.kind === "time" && p.to > p.from).map((p) => ({ kind: "start", x: p.x0, text: `${short(now - p.from)} ago` })),
  ];
  const kept = [];
  for (const label of candidates) if (kept.every((k) => Math.abs(k.x - label.x) >= minGap)) kept.push(label);
  return kept.sort((a, b) => a.x - b.x);
}

function short(ms) {
  const hours = ms / HOUR;
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60e3))}m`;
  return hours < 48 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)}d`;
}

// One axis for every row. It starts where the unfinished work starts, so work that landed earlier
// does not squeeze what is moving now. Stretches where nobody acts on any row for longer than
// BREAK_AFTER fold into equal fixed-width breaks; the rest is drawn to scale. x() maps a time to 0..1.
export function railAxis(rows, now, breakAfter = BREAK_AFTER) {
  const marks = rows.flatMap((row) => [...row.segments.map((s) => s.from), row.pkg.doneAt].filter((at) => at !== null && at !== undefined));
  if (!marks.length) return null;
  const open = rows.filter((row) => row.pkg.stage !== "done" && row.segments.length);
  const start = open.length ? Math.min(...open.map((row) => row.segments[0].from)) : Math.min(...marks);
  const end = Math.max(now, ...marks);
  const all = rows.flatMap((row) => row.segments).filter((s) => s.to > start);
  const active = all.filter((s) => !s.waiting && s.actor !== "dependency").map((s) => [Math.max(s.from, start), s.to]);
  for (const row of rows) if (row.pkg.doneAt !== null && row.pkg.doneAt !== undefined && row.pkg.doneAt >= start) active.push([row.pkg.doneAt, row.pkg.doneAt]);
  active.push([end, end]);
  active.sort((a, b) => a[0] - b[0]);
  const gaps = [];
  let reach = start;
  for (const [from, to] of active) {
    if (from - reach > breakAfter) gaps.push({ from: reach, to: from });
    reach = Math.max(reach, to);
  }
  const drawn = end - start - gaps.reduce((sum, g) => sum + (g.to - g.from), 0);
  const breakShare = Math.min(BREAK_SHARE, 0.3 / Math.max(1, gaps.length));
  const timeShare = (1 - breakShare * gaps.length) / (1 + NOW_PAD);
  const unit = drawn > 0 ? timeShare / drawn : 0;
  const pieces = [];
  let at = start;
  let x = drawn > 0 ? 0 : timeShare;
  for (const gap of [...gaps, { from: end, to: end, last: true }]) {
    if (gap.from > at || gap.last) {
      pieces.push({ kind: "time", from: at, to: gap.from, x0: x, x1: x + (gap.from - at) * unit });
      x += (gap.from - at) * unit;
    }
    if (gap.last) break;
    pieces.push({ kind: "break", from: gap.from, to: gap.to, x0: x, x1: x + breakShare, label: span(gap.to - gap.from) });
    x += breakShare;
    at = gap.to;
  }
  const map = (t) => {
    const piece = pieces.find((p) => t >= p.from && t <= p.to) ?? (t < start ? pieces[0] : pieces[pieces.length - 1]);
    if (piece.kind === "break" || piece.to === piece.from) return t <= piece.from ? piece.x0 : piece.x1;
    return piece.x0 + ((Math.min(Math.max(t, piece.from), piece.to) - piece.from) / (piece.to - piece.from)) * (piece.x1 - piece.x0);
  };
  return { start, end: now, pieces, breaks: pieces.filter((p) => p.kind === "break"), x: map, nowX: map(now) };
}

// A row whose whole rail lies before the axis starts: it says when it landed instead.
export function beforeAxis(row, axis) {
  return Boolean(axis) && row.segments.every((s) => s.to <= axis.start) && (row.pkg.doneAt === null || row.pkg.doneAt < axis.start);
}

// Moves through rows in drawn order.
export function moveRow(order, current, delta) {
  if (order.length === 0) return null;
  const at = order.indexOf(current);
  if (at < 0) return order[0];
  return order[Math.max(0, Math.min(order.length - 1, at + delta))];
}
