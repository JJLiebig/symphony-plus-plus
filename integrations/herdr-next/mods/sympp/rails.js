// Pure package helpers shared by the drill-in and the keys: a package's review rounds and moving
// through rows in drawn order.

import { span } from "./model.js";

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

// Moves through rows in drawn order.
export function moveRow(order, current, delta) {
  if (order.length === 0) return null;
  const at = order.indexOf(current);
  if (at < 0) return order[0];
  return order[Math.max(0, Math.min(order.length - 1, at + delta))];
}
