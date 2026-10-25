// Pure review drill-down: one package's review in plain words, from the review signal the provider
// reports through S++. Nothing is inferred: unrecorded findings, times, steps and rounds say so.

import { span, reviewBumps } from "./model.js";

// Review Suite's own stage, in plain words, with a tone: active, waiting, good, bad or quiet.
const STAGE = {
  running: ["Reviewers are running", "active"],
  "decision-pending": ["Waiting for the worker to decide on findings", "waiting"],
  "fix-pending": ["Waiting for fixes", "waiting"],
  "followup-pending": ["A follow-up round is due", "waiting"],
  "review-green": ["Review passed", "good"],
  "local-green-handoff": ["Passed locally, ready to hand off", "good"],
  blocked: ["Blocked", "bad"],
  crashed: ["A reviewer crashed", "bad"],
  "retry-requested": ["A retry was requested", "waiting"],
  dismissed: ["Dismissed", "quiet"],
  aborted: ["Aborted", "quiet"],
  stale: ["Out of date: the code changed after this review", "bad"],
  done: ["Done", "good"],
};
// S++'s summary, when the provider reported no stage of its own.
const STATUS = { in_progress: ["In progress", "active"], passed: ["Passed", "good"], failed: ["Failed", "bad"], pending: ["Not started", "quiet"] };
const OUTCOME = { findings: "Findings", clean: "Clean", blocked: "Blocked" };
const LANES = { "review-followup": "Follow-up", "review-github": "GitHub review", "review-deslop": "Simplification", "review-recovery": "Recovery" };
const PROVIDERS = { review_suite: "Review Suite" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function reviewed(pkg) {
  const r = pkg.review;
  return Boolean(r.type || (r.status && r.status !== "unavailable") || r.startedAt !== null || r.history.length > 0);
}

export function laneText(lane) {
  if (!lane) return null;
  const tier = /^review[_-]t(\d+)$/.exec(lane);
  return tier ? `Tier ${tier[1]} review` : LANES[lane] ?? sentence(lane);
}

export function stageOf(review) {
  const code = review.providerStatus;
  if (code) return { code, text: STAGE[code]?.[0] ?? sentence(code), tone: STAGE[code]?.[1] ?? "quiet" };
  if (!review.status || review.status === "unavailable") return null;
  return { code: null, text: STATUS[review.status]?.[0] ?? sentence(review.status), tone: STATUS[review.status]?.[1] ?? "quiet" };
}

// Everything the drill-down shows for one package. Rounds come newest first; the provider's round
// total counts every round, so rounds older than the reported history are a count, not rows.
export function reviewDetail(pkg, now) {
  const r = pkg.review;
  const history = r.history;
  const total = Math.max(pkg.round, 0, ...history.map((h) => h.n));
  const active = pkg.stage === "review";
  const rows = history.map((h) => {
    const running = active && h.n === total && h.finishedAt === null;
    return {
      n: h.n,
      lane: laneText(h.lane),
      step: h.step ? sentence(h.step) : null,
      outcome: h.outcome ? OUTCOME[h.outcome] ?? sentence(h.outcome) : running ? "In progress" : "No outcome recorded",
      kind: h.outcome ?? (running ? "running" : null),
      findings: h.findings,
      startedAt: h.startedAt,
      finishedAt: h.finishedAt,
      took: h.startedAt !== null && h.finishedAt !== null ? span(h.finishedAt - h.startedAt) : running && h.startedAt !== null ? span(now - h.startedAt) : null,
      current: running,
    };
  }).reverse();
  const lastFinish = history.at(-1)?.finishedAt ?? null;
  // The latest round runs until its recorded finish, else until now while the review is open.
  const latest = history.find((h) => h.n === total) ?? null;
  const roundFrom = latest?.startedAt ?? r.roundStartedAt;
  const roundEnd = latest && latest.finishedAt !== null ? latest.finishedAt : active ? now : null;
  const bumps = reviewBumps(pkg, now);
  return {
    reviewed: reviewed(pkg),
    provider: [r.type ? PROVIDERS[r.type] ?? sentence(r.type) : null, r.mode].filter(Boolean).join(" · ") || null,
    stage: stageOf(r),
    observation: r.observation === "stale" || r.observation === "unknown" ? r.observation : null,
    observedAt: r.observedAt,
    ladder: r.steps?.length ? r.steps.map((s) => ({ name: sentence(s.name), state: s.state })) : null,
    progress: r.steps?.length ? null : r.current !== null && r.total ? `Step ${r.current}/${r.total}${r.step ? ` · ${sentence(r.step)}` : ""}` : r.step ? sentence(r.step) : null,
    total,
    omitted: history.length ? Math.max(0, total - history.length) : 0,
    rows,
    round: roundFrom !== null && roundEnd !== null && roundEnd >= roundFrom ? span(roundEnd - roundFrom) : null,
    overall: r.startedAt === null ? null : active ? span(now - r.startedAt) : lastFinish !== null && lastFinish >= r.startedAt ? span(lastFinish - r.startedAt) : null,
    bumps,
    reslice: bumps.some((b) => b.kind === "long"),
  };
}

// Packages whose review hit a road bump, for the attention strip.
export function reviewAlerts(job, now) {
  return job.packages.map((pkg) => ({ pkg, bumps: reviewBumps(pkg, now) })).filter((a) => a.bumps.length > 0);
}

// A recorded moment as a local clock time, with the date when it is not today.
export function clock(at, now) {
  if (at === null || at === undefined) return null;
  const d = new Date(at);
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === new Date(now).toDateString() ? time : `${MONTHS[d.getMonth()]} ${d.getDate()} ${time}`;
}

function sentence(code) {
  const text = String(code).replace(/[_-]+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}
