// Pure scope model for the Topic, Space and task views. Topic and Space are one view; a space only
// narrows the tasks to its repository. Health comes from one place, each package's own evidence, so a
// task and its drill-in can never disagree. No GPUI or Herdr imports.

import { reviewBumps, shortRepo } from "./model.js";
import { NOWHERE, spaceRepo, spaceById } from "./levels.js";

// The board's own stall threshold (model.js).
const STALL_AFTER = 2 * 3600e3;
const LIVE = new Set(["build", "checks", "review", "merge"]);
const keyOf = (value) => shortRepo(value ?? "").toLowerCase();
const isOpen = (q) => q.status === "open" || q.status === "human_info_needed";

// What one package's evidence says. Issues are only what went wrong, in plain words: failures
// ("fail"), trouble that is not a failure ("warn"), or, while it is being built, a worker that stopped
// reporting or never came ("unknown"). Past the build, CI, the reviewer or the integrator acts, so no
// worker is expected. An unknown observation proves nothing either way and says nothing. Needing the
// person never hides an issue; both are kept.
export function packageEvidence(pkg, now) {
  const live = LIVE.has(pkg.stage);
  const issues = [];
  if (live && pkg.failed) issues.push({ text: "Checks failing", tone: "fail" });
  if (live) {
    // One review word per package: its round count when that is the trouble, else its length.
    const [bump] = reviewBumps(pkg, now);
    if (bump) issues.push({ text: bump.kind === "rounds" ? `Review round ${pkg.round}` : bump.text, tone: "warn" });
    if (pkg.stage === "build" && pkg.activity.observation === "stale") issues.push({ text: "No recent report", tone: "unknown" });
    else if (pkg.stage === "build" && pkg.activity.observation === "queued") issues.push({ text: "No worker yet", tone: "unknown" });
  }
  return { pkg, needsYou: pkg.stage !== "done" && pkg.activity.nextActor === "human", issues, active: live || (pkg.stage !== "done" && pkg.activity.nextActor === "human") };
}

// A question the panel can answer: the board's own route when it gives one.
function answerable(job, ask) {
  const known = [...job.questions, ...job.guidance].find((q) => q.id === ask.id);
  return { key: `ask:${ask.id}`, id: ask.id, kind: "ask", jobId: job.id, pkgId: ask.pkgId, text: ask.text, prompt: known?.prompt ?? null, status: "open", route: ask.route };
}

const unrecordedText = (job, pkgId) => {
  const pkg = pkgId ? job.packages.find((p) => p.id === pkgId) : null;
  return `${pkg ? pkg.title : "The architect"} waits on you. Its question isn't recorded.`;
};

// What the person is asked, each once. From the board's asks when it reports them, each its own ask
// even where two read alike; from an older board, its architect asks, guidance and open
// clarification questions, the same question met twice shown once. Either way a package that only
// waits on the person adds a line of its own only when no real question exists.
export function asksOf(job) {
  if (Array.isArray(job.asks)) {
    const recorded = job.asks.some((ask) => ask.text !== null);
    return job.asks.filter((ask) => ask.text !== null || !recorded).map((ask) => ({
      key: `ask:${ask.id}`, text: ask.text ?? unrecordedText(job, ask.pkgId), unrecorded: ask.text === null,
      pkgId: ask.pkgId, question: ask.route ? answerable(job, ask) : null,
    }));
  }
  const asks = [];
  for (const need of job.needs) {
    if (need.kind === "ask") asks.push({ key: need.key, text: need.text, question: null, pkgId: null });
    else if (need.id) asks.push({ key: need.key, text: need.text, question: job.guidance.find((q) => q.key === need.key) ?? null, pkgId: need.pkgId });
  }
  for (const q of job.questions.filter(isOpen)) asks.push({ key: q.key, text: q.text, question: q, pkgId: null });
  if (!asks.length) {
    for (const need of job.needs.filter((n) => n.kind === "guidance" && !n.id)) {
      asks.push({ key: need.key, text: unrecordedText(job, need.pkgId), question: null, pkgId: need.pkgId, unrecorded: true });
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

// A task as the scope shows it: its asks, what went wrong (from its packages' evidence and its own
// recorded stall or failed deploy), its strip, and where it sits.
export function taskOf(job, now) {
  const evidence = job.packages.filter((pkg) => pkg.outcome !== "dropped").map((pkg) => packageEvidence(pkg, now));
  const live = evidence.filter((e) => LIVE.has(e.pkg.stage));
  const issues = [];
  if (job.deployFailed) issues.push({ text: "Deploy failed", tone: "fail" });
  // The board's stall rule, read here without letting a pending question hide it.
  if (job.counts.live === 0 && job.counts.done > 0 && job.state !== "settled" && !job.report.parked && now - job.lastMoveAt > STALL_AFTER) issues.push({ text: "Stuck", tone: "warn" });
  if (job.report.parked) issues.push({ text: "Parked", tone: "unknown" });
  for (const e of live) for (const issue of e.issues) if (issue.tone !== "unknown") issues.push(issue);
  // Nothing at work anywhere in the task: its own word, the packages' when they agree.
  const quiet = live.map((e) => e.issues.find((i) => i.tone === "unknown")?.text);
  if (quiet.length && quiet.every(Boolean)) issues.push({ text: quiet.every((q) => q === quiet[0]) ? quiet[0] : "No recent report", tone: "unknown" });
  const rank = { fail: 0, warn: 1, unknown: 2 };
  const unique = issues.filter((issue, i) => issues.findIndex((other) => other.text === issue.text) === i).sort((a, b) => rank[a.tone] - rank[b.tone]);
  const asks = asksOf(job);
  const later = !asks.length && (job.lane === "backlog" || job.lane === "landed" || job.state === "settled");
  return { job, evidence, asks, issues: unique, strip: stripOf(job), total: evidence.length, later, band: asks.length ? 0 : unique.length ? 1 : 2 };
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
