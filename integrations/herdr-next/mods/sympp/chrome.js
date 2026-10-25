// What S++ shares for the patched desk agents list once the S++ chrome is installed (install.mjs
// --chrome): per-agent decorations. The patched mod only reads them; S++ writes them outside render,
// and only when something differs.

import { discoverBindings } from "./model.js";

export const AGENTS = "sympp.agents";
// An unchanged entry is restamped this often, so the Agents list can tell a current read from a
// last known one (it dims entries older than two minutes).
export const RESTAMP = 45e3;

const STAGES = { build: "build", checks: "checks", review: "review", merge: "merge" };

// One entry per S++ terminal on this endpoint's board, keyed by its Herdr terminal address (a remote
// one carries its machine, `vps/t7`): the package's stage, its review round, and whether the person
// is needed.
export function decorations(board, terminalList, endpoint, at) {
  const out = {};
  for (const b of discoverBindings(null, terminalList)) {
    const job = board.jobs.find((j) => j.id === b.jobId || (b.pkgId && j.packages.some((p) => p.id === b.pkgId)));
    if (!job) continue;
    const pkg = b.pkgId ? job.packages.find((p) => p.id === b.pkgId) : null;
    if (b.pkgId && !pkg) continue;
    const stage = !pkg ? null : pkg.stage === "done" ? (pkg.outcome === "dropped" ? null : "landed") : STAGES[pkg.stage] ?? null;
    out[b.address] = {
      stage,
      round: stage === "review" ? pkg.round : null,
      needs: pkg ? job.needs.some((n) => n.pkgId === pkg.id) : job.needs.length > 0,
      endpoint,
      at,
    };
  }
  return out;
}

const same = (a, b) => a.stage === b.stage && a.round === b.round && a.needs === b.needs && a.endpoint === b.endpoint;

// The map to share, or null when nothing changed. An unchanged entry keeps its stamp until it is
// RESTAMP old; this endpoint's terminals no longer on its board drop out. Entries from other S++
// endpoints stay as they are.
export function nextDecorations(before, fresh, endpoint, now) {
  const prior = before && typeof before === "object" ? before : {};
  const next = Object.fromEntries(Object.entries(prior).filter(([address, entry]) => entry?.endpoint !== endpoint && !fresh[address]));
  let changed = Object.entries(prior).some(([address, entry]) => entry?.endpoint === endpoint && !fresh[address]);
  for (const [address, entry] of Object.entries(fresh)) {
    const old = prior[address];
    const keep = old && same(old, entry) && now - old.at < RESTAMP;
    next[address] = keep ? old : entry;
    if (!keep) changed = true;
  }
  return changed ? next : null;
}
