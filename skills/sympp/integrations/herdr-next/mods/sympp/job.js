// Pure task helpers: the agents taking part and their liveness, from canonical sympp state and
// Herdr's own terminal reports, and opening a task in its own tab. No GPUI or Herdr imports.

import { POLL, ago, shortRepo, bindingsFor } from "./model.js";

// A passed helper check counts as live for two quiet read intervals, then needs checking again.
export const LIVE_FOR = 2 * POLL.quiet;

// ---------- Agents ----------

// The agent's own OSC status for a terminal, as Herdr's terminals() reports it; never terminal text.
export function agentReport(terminal, now) {
  if (!terminal || typeof terminal.status !== "string" || !terminal.status) return null;
  const at = Number(terminal.status_ms);
  const report = terminal.report && typeof terminal.report === "object" ? terminal.report : null;
  return {
    status: terminal.status,
    kind: typeof report?.kind === "string" ? report.kind : null,
    msg: typeof report?.msg === "string" && report.msg.trim() ? report.msg.trim() : null,
    age: Number.isFinite(at) && at > 0 ? ago(at, now) : null,
  };
}

// The freshest report among a package's or architect's bound terminals.
export function reportFor(bindings, terminalList, now) {
  const reports = bindings.map((b) => (terminalList ?? []).find((term) => term.address === b.address))
    .filter(Boolean).sort((x, y) => (Number(y.status_ms) || 0) - (Number(x.status_ms) || 0));
  return reports.map((term) => agentReport(term, now)).find(Boolean) ?? null;
}

// Live only after a recent helper check of this exact binding passed; otherwise sympp's last sighting,
// otherwise unknown. Terminal labels and text alone never make an agent live.
export function liveness(bindings, checks, place, lastSeenAt, now) {
  const live = bindings.find((b) => {
    const check = checks[b.address];
    return b.available && check?.ok && check.launchId === b.launchId && check.pid === b.pid && now - check.at <= LIVE_FOR;
  });
  if (live) return { state: "live", binding: live };
  const seen = [place?.seenAt ?? null, lastSeenAt ?? null].filter((at) => at !== null);
  if (seen.length) return { state: "seen", at: Math.max(...seen), where: place?.where ?? null };
  if (place) return { state: "seen", at: null, where: place.where };
  return { state: "unknown" };
}

// Every terminal bound to this job: its architect and each package's agents, as bindingsFor finds them.
export function jobBindings(job, bindings) {
  const found = [null, ...job.packages.map((pkg) => pkg.id)].flatMap((pkgId) => bindingsFor(bindings, job.id, pkgId));
  return found.filter((b, i) => found.findIndex((other) => other.address === b.address && other.pkgId === b.pkgId) === i);
}

// Everyone sympp or a verified binding says takes part. sympp records no reviewer identity or claim
// history, so the review provider is named by its type and mode only.
export function participants(job, bindings, checks, now) {
  const own = (pkgId) => bindingsFor(bindings, job.id, pkgId);
  const architectBindings = own(null);
  const people = [{
    key: "architect", role: "Architect", subject: null,
    provider: architectBindings[0]?.provider ?? null,
    ...liveness(architectBindings, checks, job.architect, null, now),
  }];
  for (const pkg of job.packages) {
    const mine = own(pkg.id);
    const involved = mine.length || pkg.location || pkg.run || (pkg.stage !== "queued" && pkg.stage !== "done");
    if (!involved) continue;
    people.push({
      key: `worker:${pkg.id}`, role: "Worker", subject: pkg.title, pkgId: pkg.id,
      provider: mine[0]?.provider ?? null, name: pkg.activity.actor?.name ?? null,
      attempt: pkg.run?.attempt ?? null,
      ...liveness(mine, checks, pkg.location, pkg.run?.lastSeenAt ?? null, now),
    });
  }
  const reviews = new Map();
  for (const pkg of job.packages) {
    if (!pkg.review.type) continue;
    const key = `${pkg.review.type}:${pkg.review.mode ?? ""}`;
    const entry = reviews.get(key) ?? { key: `review:${key}`, role: "Review", provider: [sentence(pkg.review.type), pkg.review.mode].filter(Boolean).join(" · "), reviewing: 0, state: "provider" };
    if (pkg.stage === "review") entry.reviewing += 1;
    reviews.set(key, entry);
  }
  return [...people, ...reviews.values()];
}

// ---------- Opening a job in its own tab ----------

// The job's local space: one on this machine whose folder is one of the job's repositories,
// the exact path first and then the repository name; otherwise the shown space.
export function jobSpace(job, spaceList) {
  const local = (spaceList ?? []).filter((s) => !s.machine && s.folder);
  const path = (value) => String(value).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const pick = (list) => list.find((s) => s.active) ?? list[0] ?? null;
  return pick(local.filter((s) => job.repos.some((repo) => path(repo) === path(s.folder))))
    ?? pick(local.filter((s) => job.repos.some((repo) => shortRepo(repo).toLowerCase() === shortRepo(s.folder).toLowerCase())))
    ?? (spaceList ?? []).find((s) => s.active) ?? null;
}

// The new tab gets this copy's props plus the job. A panel's narrow role does not follow it there.
export function jobTabArgs(given, job, spaceList) {
  const { role: _role, job: _job, ...rest } = given ?? {};
  const space = jobSpace(job, spaceList);
  const name = job.title.length > 32 ? `${job.title.slice(0, 31)}…` : job.title;
  return { name, ...(space ? { space: space.id } : {}), mod: "sympp", props: { ...rest, job: job.id } };
}

function sentence(code) {
  const text = String(code).replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
