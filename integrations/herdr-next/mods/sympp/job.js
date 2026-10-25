// Pure Job level: one job's phase, package detail, participating agents and decisions, from canonical
// S++ state and Herdr's own terminal reports. No GPUI or Herdr imports, so it is tested on its own.

import { POLL, ago, shortRepo, stageText, evidenceOf, bindingsFor } from "./model.js";

export const PHASES = [["shaping", "Shaping"], ["planning", "Planning"], ["executing", "Executing"], ["closing", "Closing"], ["done", "Done"]];
const SHAPING = new Set(["draft", "ready_for_clarification", "clarifying", "human_info_needed"]);
const OBSERVATION = { stale: "stale", paused: "paused", unknown: "unknown" };
// A passed helper check counts as live for two quiet read intervals, then needs checking again.
export const LIVE_FOR = 2 * POLL.quiet;

// ---------- Phase ----------

// Canonical request status and package delivery only; never a percentage or a guess.
export function phaseOf(job) {
  if (job.closedAt !== null) return "done";
  if (SHAPING.has(job.status)) return "shaping";
  if (job.status === "ready_for_slicing") return "planning";
  if (job.status !== "sliced") return null;
  const required = job.packages.filter((pkg) => pkg.outcome !== "dropped");
  if (required.length > 0 && required.every((pkg) => pkg.stage === "done")) return "closing";
  return job.packages.some((pkg) => pkg.dispatchedAt !== null || pkg.stage !== "queued") ? "executing" : "planning";
}

// ---------- Package detail ----------

// What a package row says when opened, in reading order: plain words from canonical signals.
export function packageCard(pkg, report, now) {
  const a = pkg.activity;
  const observation = OBSERVATION[a.observation] ?? null;
  const holder = a.actor ? [a.actor.role ? sentence(a.actor.role) : null, a.actor.name].filter(Boolean).join(" · ") : null;
  return {
    id: pkg.id,
    title: pkg.title,
    stage: pkg.stage === "queued" ? null : stageText(pkg, now),
    dropped: pkg.outcome === "dropped",
    failed: pkg.failed,
    noPr: pkg.track === "no_pr",
    holder: holder ? { text: holder, observation } : observation && pkg.stage !== "queued" && pkg.stage !== "done" ? { text: "No holder", observation } : null,
    report,
    waiting: pkg.stage === "done" ? null : a.waiting,
    next: pkg.stage === "done" ? null : a.next,
    needsYou: pkg.stage !== "done" && a.nextActor === "human",
    evidence: evidenceOf(pkg),
    after: pkg.stage === "done" ? [] : pkg.after,
  };
}

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

export function reportText(report) {
  if (!report) return null;
  return `Agent reports ${report.status}${report.kind ? ` (${report.kind})` : ""}${report.msg ? `: ${report.msg}` : ""}${report.age ? ` · ${report.age}` : ""}`;
}

// The freshest report among a package's or architect's bound terminals.
export function reportFor(bindings, terminalList, now) {
  const reports = bindings.map((b) => (terminalList ?? []).find((term) => term.address === b.address))
    .filter(Boolean).sort((x, y) => (Number(y.status_ms) || 0) - (Number(x.status_ms) || 0));
  return reports.map((term) => agentReport(term, now)).find(Boolean) ?? null;
}

// Live only after a recent helper check of this exact binding passed; otherwise S++'s last sighting,
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

// Everyone S++ or a verified binding says takes part. S++ records no reviewer identity or claim
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

// ---------- Decisions ----------

export function decisionsOf(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.decision_logs)) throw new Error("S++ answered with something other than this job's details.");
  return payload.decision_logs.filter((d) => d?.id && d.decision).map((d) => ({
    id: d.id, seq: Number(d.sequence) || 0, text: d.decision, rationale: d.rationale || null,
    impact: d.scope_impact || null, by: d.created_by || null, at: ms(d.created_at ?? d.inserted_at),
  })).sort((a, b) => b.seq - a.seq);
}

export function detailPath(jobId) {
  return `/api/v1/sympp/herdr/work-requests/${encodeURIComponent(jobId)}`;
}

// The job's details follow the board's cadence and back off after failures. A new job reads at once.
export function detailDue(state, jobId, cadence, now) {
  if (state.jobId !== jobId || state.attemptAt === null) return true;
  const wait = state.error ? POLL.retry[Math.min(state.failures - 1, POLL.retry.length - 1)] ?? POLL.retry[0] : cadence;
  return now - state.attemptAt >= wait;
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

function ms(value) {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? time : null;
}
