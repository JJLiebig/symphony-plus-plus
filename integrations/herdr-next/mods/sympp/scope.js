// Pure scope model for the Topic, Space and task views. Topic and Space are one view; a space only
// narrows the tasks to its repository. Health comes from one place, each package's own evidence, so a
// task and its drill-in can never disagree. No GPUI or Herdr imports.

import { shortRepo } from "./model.js";
import { NOWHERE, spaceRepo, spaceById } from "./levels.js";

const LIVE = new Set(["build", "checks", "review", "merge"]);
const keyOf = (value) => shortRepo(value ?? "").toLowerCase();
const isOpen = (q) => q.status === "open" || q.status === "human_info_needed";

// Package progress carries no inferred human attention.
export function packageEvidence(pkg, now, needsYou = false) {
  const live = LIVE.has(pkg.stage);
  return { pkg, needsYou, issues: [], active: live || (pkg.stage !== "done" && needsYou) };
}

// The PR's checks as one live signal, apart from the step line: "waiting" before they start, then
// "running", "passed" or "failed". A repository without CI has no signal; one the board says nothing
// about shows it once checks report.
const CHECKS = { pending: "running", passing: "passed", failing: "failed" };
export function ciOf(pkg) {
  if (pkg.ci === false || pkg.track === "no_pr" || pkg.stage === "done") return null;
  const state = CHECKS[pkg.pr.checks] ?? "waiting";
  return pkg.ci === true || state !== "waiting" ? state : null;
}

// A task's checks at a glance: any failing, else any running, else passed once any passed. A task
// with CI keeps its slot from the start, so nothing shifts when its first PR opens.
export function taskCi(packages) {
  const states = packages.map(ciOf).filter(Boolean);
  if (!states.length) return null;
  return ["failed", "running", "passed"].find((s) => states.includes(s)) ?? "waiting";
}

// Where a review stands, in a word or two, from the provider's current step.
const PHASES = { "deep-signoff": "deep sign-off", signoff: "sign-off", "sign-off": "sign-off", github: "GitHub", "broad-discovery": "discovery" };
export function reviewPhase(pkg) {
  const step = pkg.review.steps?.find((s) => s.state === "current")?.name ?? pkg.review.step;
  if (!step) return null;
  const key = String(step).trim().toLowerCase();
  return PHASES[key] ?? key.split(/[-_\s]+/).filter(Boolean).slice(0, 2).join(" ");
}

// A package in Build that no worker has taken yet.
export const unmanned = (pkg) => pkg.stage === "build" && pkg.dispatchedAt === null && !pkg.run && !pkg.activity.actor;

// A question the panel can answer: the board's own route when it gives one.
function answerable(job, ask) {
  const known = [...job.questions, ...job.guidance].find((q) => q.id === ask.id);
  return { key: `ask:${ask.id}`, id: ask.id, kind: "ask", jobId: job.id, pkgId: ask.pkgId, text: ask.text, prompt: known?.prompt ?? null, status: "open", route: ask.route };
}

export function asksOf(job) {
  if (Array.isArray(job.asks)) {
    return job.asks.filter((ask) => ask.text?.trim()).map((ask) => ({
      key: `ask:${ask.id}`, text: ask.text,
      pkgId: ask.pkgId, question: ask.route ? answerable(job, ask) : null,
    }));
  }
  const asks = [];
  for (const need of job.needs) {
    if (need.kind === "ask") asks.push({ key: need.key, text: need.text, question: null, pkgId: null });
    else if (need.id) asks.push({ key: need.key, text: need.text, question: [...job.guidance, ...job.questions].find((q) => q.key === need.key) ?? null, pkgId: need.pkgId });
  }
  for (const q of job.questions.filter(isOpen)) asks.push({ key: q.key, text: q.text, question: q, pkgId: null });
  const seen = new Set();
  return asks.filter((ask) => {
    const text = String(ask.text ?? "").trim().toLowerCase();
    if (!text || seen.has(text)) return false;
    seen.add(text);
    return true;
  });
}

// The web board's strip: one box per package, run by the architect's top-level groups in their own
// order, each run in planned order, packages outside any group last.
export function stripOf(job) {
  const counted = job.packages.filter((pkg) => pkg.outcome !== "dropped");
  const order = [...(job.phases ?? []), null];
  const runs = order.map((phase) => ({ phase, pkgs: counted.filter((pkg) => (order.includes(pkg.phase ?? null) ? pkg.phase ?? null : null) === phase) }))
    .filter((run) => run.pkgs.length);
  for (const run of runs) run.pkgs.sort((a, b) => a.seq - b.seq);
  return runs;
}

// A task shows recorded asks, progress and its place in the scope.
export function taskOf(job, now) {
  const asks = asksOf(job);
  const evidence = job.packages.filter((pkg) => pkg.outcome !== "dropped").map((pkg) => packageEvidence(pkg, now, asks.some((ask) => ask.pkgId === pkg.id)));
  const unique = [];
  const later = !asks.length && (job.lane === "backlog" || job.lane === "landed" || job.state === "settled");
  const ci = taskCi(evidence.map((e) => e.pkg));
  return { job, evidence, asks, issues: unique, strip: stripOf(job), total: evidence.length, ci, later, band: asks.length ? 0 : unique.length ? 1 : 2 };
}

// The tasks a Topic or Space shows: every task touching it, once, in a stable order. What needs
// the person comes first, then what went wrong, then the rest, each by when it was opened, so a
// task never moves just because it advanced. Work settled for over a day and dormant work leave
// for the dashboard.
export function scopeTasks(path, desk, jobs, place, now) {
  let touching;
  if (path.space) {
    const found = spaceById(desk, path.space);
    const key = found ? spaceRepo(found.space) : null;
    touching = key ? jobs.filter((job) => job.repos.some((repo) => keyOf(repo) === key)) : [];
  } else if (path.topic === NOWHERE) {
    touching = jobs.filter((job) => place.home(job) === NOWHERE);
  } else {
    touching = jobs.filter((job) => place.touches(job, path.topic));
  }
  return touching.filter((job) => job.lane !== "settled" && job.lane !== "dormant")
    .map((job) => taskOf(job, now))
    .sort((a, b) => a.band - b.band || a.job.createdAt - b.job.createdAt || String(a.job.id).localeCompare(String(b.job.id)));
}

// The drill-in's parts: the packages at work or waiting on the person each get a row, in planned
// order; landed and queued packages fold into one mark each.
export function packageParts(task) {
  const bySeq = (a, b) => a.pkg.seq - b.pkg.seq;
  return {
    active: task.evidence.filter((e) => e.active).sort(bySeq),
    landed: task.evidence.filter((e) => e.pkg.stage === "done").sort(bySeq),
    queued: task.evidence.filter((e) => !e.active && e.pkg.stage === "queued").sort(bySeq),
  };
}

// The scope's name for its bar.
export function scopeTitle(path, desk) {
  if (path.space) {
    const found = spaceById(desk, path.space);
    return found ? found.space.name || shortRepo(found.space.folder) || "Space" : "Space";
  }
  return desk.find((topic) => topic.id === path.topic)?.name ?? "Topic";
}
