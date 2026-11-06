// Pure scope model for the redesigned Topic, Space and task views. Topic and Space are one view; a
// space only narrows the tasks to its repository. Health comes from one place, each package's own
// evidence, so a task and its drill-in can never disagree. No GPUI or Herdr imports.

import { reviewBumps, shortRepo } from "./model.js";
import { NOWHERE, spaceRepo, spaceById } from "./levels.js";

// The drill-in's columns: where a package is, by its recorded stage.
export const COLUMNS = ["queued", "build", "checks", "review", "merge", "done"];
export const COLUMN_LABEL = { queued: "Queued", build: "Build", checks: "Checks", review: "Review", merge: "Merge", done: "Landed" };

// The board's own stall threshold (model.js).
const STALL_AFTER = 2 * 3600e3;
const keyOf = (value) => shortRepo(value ?? "").toLowerCase();
const isOpen = (q) => q.status === "open" || q.status === "human_info_needed";

// Fresh evidence: the package's activity was observed current, or its agent run was seen and isn't stale.
function fresh(pkg) {
  return pkg.activity.observation === "current" || Boolean(pkg.run && !pkg.run.stale && pkg.run.lastSeenAt !== null);
}

// What one package's evidence says. Issues are only what went wrong, in plain words: failures
// ("fail"), trouble that is not a failure ("warn"), or no fresh evidence ("unknown"). Needing the
// person never hides an issue; both are kept.
export function packageEvidence(pkg, now) {
  const live = pkg.stage !== "queued" && pkg.stage !== "done";
  const issues = [];
  if (live && pkg.failed) issues.push({ text: "Checks failing", tone: "fail" });
  if (live) {
    // One review word per package: its round count when that is the trouble, else its length.
    const [bump] = reviewBumps(pkg, now);
    if (bump) issues.push({ text: bump.kind === "rounds" ? `Review round ${pkg.round}` : bump.text, tone: "warn" });
    if (!fresh(pkg)) issues.push({ text: "No recent report", tone: "unknown" });
  }
  return {
    pkg,
    column: COLUMNS.includes(pkg.stage) ? pkg.stage : "build",
    needsYou: pkg.stage !== "done" && pkg.activity.nextActor === "human",
    issues,
    note: pkg.stage === "queued" && pkg.after.length ? `After ${pkg.after.join(", ")}` : null,
  };
}

// What the person is asked: architect asks, guidance questions and open clarification questions,
// each once. A package that only says it waits on the person adds a line of its own only when no
// real question exists, and then says plainly that the question wasn't recorded.
export function asksOf(job) {
  const asks = [];
  for (const need of job.needs) {
    if (need.kind === "ask") asks.push({ key: need.key, text: need.text, question: null, pkgId: null });
    else if (need.id) asks.push({ key: need.key, text: need.text, question: job.guidance.find((q) => q.key === need.key) ?? null, pkgId: need.pkgId });
  }
  for (const q of job.questions.filter(isOpen)) asks.push({ key: q.key, text: q.text, question: q, pkgId: null });
  if (!asks.length) {
    for (const need of job.needs.filter((n) => n.kind === "guidance" && !n.id)) {
      const pkg = job.packages.find((p) => p.id === need.pkgId);
      asks.push({ key: need.key, text: `${pkg?.title ?? "A package"} waits on you. Its question isn't recorded.`, question: null, pkgId: need.pkgId, unrecorded: true });
    }
  }
  const seen = new Set();
  return asks.filter((ask) => {
    const text = String(ask.text ?? "").trim().toLowerCase();
    if (!text || seen.has(text)) return false;
    seen.add(text);
    return true;
  });
}

// A task as the scope shows it: its asks, what went wrong (from its packages' evidence and its own
// recorded stall or failed deploy), and the share of its packages that landed.
export function taskOf(job, now) {
  const evidence = job.packages.filter((pkg) => pkg.outcome !== "dropped").map((pkg) => packageEvidence(pkg, now));
  const live = evidence.filter((e) => e.pkg.stage !== "queued" && e.pkg.stage !== "done");
  const issues = [];
  if (job.deployFailed) issues.push({ text: "Deploy failed", tone: "fail" });
  // The board's stall rule, read here without letting a pending question hide it.
  if (job.counts.live === 0 && job.counts.done > 0 && job.state !== "settled" && !job.report.parked && now - job.lastMoveAt > STALL_AFTER) issues.push({ text: "Stuck", tone: "warn" });
  if (job.report.parked) issues.push({ text: "Parked", tone: "unknown" });
  for (const e of live) for (const issue of e.issues) if (issue.tone !== "unknown") issues.push(issue);
  if (live.length && live.every((e) => e.issues.some((i) => i.tone === "unknown"))) issues.push({ text: "No recent report", tone: "unknown" });
  const rank = { fail: 0, warn: 1, unknown: 2 };
  const unique = issues.filter((issue, i) => issues.findIndex((other) => other.text === issue.text) === i).sort((a, b) => rank[a.tone] - rank[b.tone]);
  const asks = asksOf(job);
  const total = evidence.length;
  const landed = evidence.filter((e) => e.pkg.stage === "done").length;
  const later = !asks.length && (job.lane === "backlog" || job.lane === "landed" || job.state === "settled");
  return { job, evidence, asks, issues: unique, landed: total ? landed / total : 0, total, later, band: asks.length ? 0 : unique.length ? 1 : 2 };
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

// The scope's name for its bar.
export function scopeTitle(path, desk) {
  if (path.space) {
    const found = spaceById(desk, path.space);
    return found ? found.space.name || shortRepo(found.space.folder) || "Space" : "Space";
  }
  return desk.find((topic) => topic.id === path.topic)?.name ?? "Topic";
}
