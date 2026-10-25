// What S++ adds to Herdr's own chrome once the desk patches are installed (install.mjs --chrome):
// the S++ panel's button beside Files and Changes, and per-agent decorations for the Agents list.
// The patched desk mods only read these shared keys; S++ writes them outside render, and only when
// something differs.

import { discoverBindings } from "./model.js";

export const PANEL_BUTTONS = "workspace.panel_buttons";
export const AGENTS = "sympp.agents";
export const PANEL = { id: "sympp", label: "S++", icon: "mods/sympp/mark.png", iconDark: "mods/sympp/mark-dark.png" };
// An unchanged entry is restamped this often, so the Agents list can tell a current read from a
// last known one (it dims entries older than two minutes).
export const RESTAMP = 45e3;

// The registered panel buttons with S++'s own, or null when it is already there as it should be.
export function withPanelButton(current) {
  const list = Array.isArray(current) ? current : [];
  const mine = list.find((b) => b?.id === PANEL.id);
  if (mine && Object.entries(PANEL).every(([key, value]) => mine[key] === value)) return null;
  return [...list.filter((b) => b?.id !== PANEL.id), PANEL];
}

const STAGES = { build: "build", checks: "checks", review: "review", merge: "merge" };

// One entry per S++ terminal on the board, keyed by its Herdr terminal address (a remote one carries
// its machine, `vps/t7`): the package's stage, its review round, and whether the person is needed.
export function decorations(board, terminalList, at) {
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
      at,
    };
  }
  return out;
}

const same = (a, b) => a.stage === b.stage && a.round === b.round && a.needs === b.needs;

// The map to share, or null when nothing changed. An unchanged entry keeps its stamp until it is
// RESTAMP old; terminals no longer on the board drop out.
export function nextDecorations(before, fresh, now) {
  const prior = before && typeof before === "object" ? before : {};
  let changed = Object.keys(prior).some((address) => !fresh[address]);
  const next = {};
  for (const [address, entry] of Object.entries(fresh)) {
    const old = prior[address];
    const keep = old && same(old, entry) && now - old.at < RESTAMP;
    next[address] = keep ? old : entry;
    if (!keep) changed = true;
  }
  return changed ? next : null;
}
