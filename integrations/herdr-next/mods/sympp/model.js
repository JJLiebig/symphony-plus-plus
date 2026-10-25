// Pure S++ Lens model: the native hydrated board in, plain view data out. No GPUI, no Herdr imports,
// so every transformation here can be asserted on its own. Semantics follow the standalone board
// (elixir/assets/src/fresh/model.ts, report.tsx, board.tsx); nothing here is a second ledger.

export const BOARD_PATH = "/api/v1/sympp/herdr/dashboard";
export const DASHBOARD_PATH = "/sympp";
export const STAGES = ["queued", "build", "checks", "review", "merge", "done"];
export const STAGE_LABEL = { queued: "Queued", build: "Building", checks: "Checks", review: "Review", merge: "Ready to merge", done: "Landed" };
export const VERDICT_LABEL = { needs_you: "Needs you", bump: "Road bump", stalled: "Stalled", on_track: "On track", idle: "Quiet", parked: "Parked", settled: "Done" };

const MINUTE = 60e3;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const LONG_REVIEW = 3 * HOUR;
const STALL_AFTER = 2 * HOUR;
const DORMANT_AFTER = 14 * DAY;
const RANK = { needs_you: 0, bump: 1, stalled: 2, on_track: 3, idle: 4, parked: 5, settled: 6 };
const OUTCOMES = { pr_merged: "merged", completed_no_pr: "finished", superseded: "dropped", abandoned: "dropped" };
// Packages without a backend stage: their recorded status, read as loosely as the web board does.
const STATUS_RULES = [
  [/^(merged|github_pr_merged)$/, "done"],
  [/merge_ready|ready_for_merge|review_complete|^reviewed$|review_owner_accepted|acceptance|ready_for_close/, "merge"],
  [/review/, "review"],
  [/validat|ci_waiting/, "checks"],
];
const ACTORS = { human: "You", architect: "Architect", worker: "Worker", prerequisite_owner: "Prerequisite owner" };
const REASONS = {
  unmet_dependencies: "Waiting on prerequisite packages",
  active_blocker: "Blocked",
  worker_paused: "Worker paused",
  runtime_stale: "Runtime observation is stale",
  review_in_progress: "Review in progress",
  awaiting_integration: "Waiting for the architect to integrate",
  validation_pending: "Checks pending",
};

// Polling: modest, slower in the background and after failures. GPUI fetch has no streaming body.
export const POLL = { live: 15e3, quiet: 60e3, background: 60e3, retry: [15e3, 30e3, 60e3] };

// ---------- Endpoint ----------

export function normalizeEndpoint(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const base = value.trim().replace(/\/+$/, "");
  return /^https?:\/\/[^/\s]+(\/[^\s]*)?$/i.test(base) ? base : null;
}

export function boardUrl(endpoint) {
  return endpoint ? `${endpoint}${BOARD_PATH}` : null;
}

export function dashboardUrl(endpoint, explicit) {
  return normalizeEndpoint(explicit) ?? (endpoint ? `${endpoint}${DASHBOARD_PATH}` : null);
}

// ---------- Fetch state ----------
// `data` is the last good read and survives failures; `error` says why the latest read failed.

export function initialFetch() {
  return { data: null, receivedAt: null, attemptAt: null, error: null, failures: 0 };
}

export function fetchStarted(state, now) {
  return { ...state, attemptAt: now };
}

export function fetchSucceeded(state, data, now) {
  return { data, receivedAt: now, attemptAt: now, error: null, failures: 0 };
}

export function fetchFailed(state, error, now) {
  return { ...state, attemptAt: now, error, failures: state.failures + 1 };
}

export function httpError(status) {
  if (status === 401 || status === 403) return `S++ refused this native read (${status}). The view only reads from a local S++ on this machine.`;
  if (status === 404) return "This S++ has no native board route (404). It needs the release with /herdr/dashboard.";
  if (status === 503) return "The S++ ledger is busy (503). Retrying.";
  return `S++ answered ${status}.`;
}

export function networkError(endpoint, caught) {
  const host = (endpoint ?? "").replace(/^https?:\/\//i, "");
  const detail = caught && typeof caught.message === "string" && caught.message ? ` (${caught.message})` : "";
  return `Can't reach S++ at ${host || "the configured endpoint"}${detail}.`;
}

export function nextDelay(state, active) {
  if (state.error) return POLL.retry[Math.min(state.failures - 1, POLL.retry.length - 1)] ?? POLL.retry[0];
  if (!active) return POLL.background;
  return state.data?.jobs.some((job) => job.state === "live" || job.needs.length > 0) ? POLL.live : POLL.quiet;
}

export function fetchDue(state, now, active) {
  if (state.attemptAt === null) return true;
  return now - state.attemptAt >= nextDelay(state, active);
}

// Shown data is stale once a read failed, or once it is much older than the schedule allows.
export function isStale(state, now) {
  if (!state.data) return false;
  return Boolean(state.error) || now - state.receivedAt > 3 * POLL.quiet;
}

// ---------- Board ----------

export function parseBoard(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.work_request_details)) {
    throw new Error("S++ answered with something other than a board.");
  }
  const now = ms(payload.generated_at) ?? Date.now();
  const jobs = payload.work_request_details.filter((detail) => detail?.work_request?.id).map((detail) => buildJob(detail, now));
  return { now, jobs };
}

function buildJob(detail, now) {
  const request = detail.work_request;
  const repo = request.repo_display || request.repo || "";
  const repoShort = shortRepo(repo);
  const area = Array.isArray(request.area_path) && request.area_path.length ? request.area_path : ["Unfiled", repoShort || "Unknown"];
  const groups = new Map((detail.product_tree?.nodes ?? []).map((node) => [node.id, node.title || "Untitled"]));
  const packages = (detail.work_packages ?? []).map((slice) => buildPackage(slice, groups, now)).sort((a, b) => a.seq - b.seq);
  const titles = new Map(packages.map((pkg) => [pkg.id, pkg.title]));
  for (const pkg of packages) pkg.after = pkg.unmet.map((id) => titles.get(id) ?? id);

  const report = reportOf(request.operator_report, now);
  const escalation = request.operator_report?.human_escalation;
  const ask = escalation?.question && !escalation.resolved_at ? { text: escalation.question, since: ms(escalation.raised_at) ?? now } : null;
  const needs = [
    ...(ask ? [{ key: `${request.id}:ask`, kind: "ask", label: "Architect asks", text: ask.text, since: ask.since, jobId: request.id, pkgId: null }] : []),
    ...packages.filter((pkg) => pkg.stage !== "done" && pkg.activity.nextActor === "human").map((pkg) => ({
      key: `${request.id}:${pkg.id}:guidance`,
      kind: "guidance",
      label: "Guidance needs you",
      text: pkg.activity.waiting || `${pkg.title} is waiting for your answer`,
      since: pkg.activity.lastUpdateAt,
      jobId: request.id,
      pkgId: pkg.id,
    })),
  ];

  const live = packages.filter((pkg) => pkg.stage !== "queued" && pkg.stage !== "done");
  const done = packages.filter((pkg) => pkg.stage === "done");
  const queued = packages.filter((pkg) => pkg.stage === "queued");
  const createdAt = ms(request.inserted_at) ?? now;
  const closedAt = ms(request.completed_at);
  const settled = (closedAt !== null && closedAt <= now) || (packages.length > 0 && done.length === packages.length && needs.length === 0);
  const job = {
    id: request.id,
    title: request.title || request.id,
    repo,
    repoShort,
    area,
    baseBranch: request.base_branch ?? null,
    offPrimary: offPrimary(request.base_branch, request.default_branch),
    createdAt,
    closedAt,
    report,
    ask,
    needs,
    architect: placeOf(request.architect_session_location),
    packages,
    counts: { live: live.length, queued: queued.length, done: done.length, total: packages.length },
    state: settled ? "settled" : live.length > 0 || needs.length > 0 ? "live" : "resting",
    lastMoveAt: Math.max(createdAt, ...packages.map((pkg) => pkg.since ?? 0)),
    deployFailed: deployFailed(request.deployments),
  };
  job.bumps = bumpsOf(job, now);
  job.verdict = verdictOf(job, now);
  job.lane = laneOf(job, now);
  job.brief = report.brief ? report.brief.text : draftBrief(job, now);
  return job;
}

function buildPackage(slice, groups, now) {
  const board = slice.board_state ?? null;
  const pr = slice.pr_signal ?? {};
  const review = slice.review_signal ?? {};
  const activity = slice.activity_signal ?? {};
  const outcome = OUTCOMES[slice.delivery?.outcome ?? ""] ?? (slice.operational_state?.key === "skipped" ? "dropped" : null)
    ?? (board && (board.delivered || board.stage === "done") ? (board.track === "no_pr" ? "finished" : "merged") : null);
  const stage = outcome ? "done" : board?.stage ?? statusStage(slice);
  const observed = stageTime(slice, board, stage);
  const actor = activity.current_actor ?? null;
  return {
    id: slice.work_package_id || slice.id,
    title: slice.title || slice.id,
    seq: slice.sequence ?? 0,
    group: groups.get(slice.product_tree_node_id) ?? null,
    stage,
    outcome,
    since: observed ?? ms(slice.dispatched_at) ?? ms(slice.inserted_at),
    untimed: observed === null,
    failed: pr.checks?.status === "failing",
    track: board?.track ?? null,
    round: Number(review.round) || 1,
    pr: { status: pr.status ?? null, number: pr.number ?? null, url: pr.url ?? null, checks: pr.checks?.status ?? null, checksAt: ms(pr.checks?.changed_at) },
    review: {
      status: review.status ?? null,
      mode: review.mode ?? slice.review?.args?.mode ?? null,
      step: review.step ?? null,
      current: review.current ?? null,
      total: review.total ?? null,
      observation: review.observation_state ?? null,
    },
    activity: {
      actor: actor ? { name: actor.name || actor.id || null, role: actor.role ?? null } : null,
      owner: activity.accountable_owner?.id ?? null,
      nextActor: activity.next_actor ?? null,
      next: describeNext(activity.next_actor, activity.next_action),
      waiting: describeReason(activity.waiting_reason),
      lastUpdate: activity.last_update ?? null,
      lastUpdateAt: ms(activity.last_update_at),
      observation: activity.observation_state ?? null,
    },
    unmet: slice.dependency_signal?.unmet_work_package_ids ?? [],
    after: [],
    location: placeOf(slice.session_location),
  };
}

function statusStage(slice) {
  const status = slice.status ?? "";
  const ruled = STATUS_RULES.find(([pattern]) => pattern.test(status))?.[1];
  if (ruled) return ruled;
  return ms(slice.dispatched_at) !== null ? "build" : "queued";
}

// When the package reached its stage: the backend's evidence first, then the closest observation of it.
function stageTime(slice, board, stage) {
  const pr = slice.pr_signal ?? {};
  const review = slice.review_signal ?? {};
  const delivery = slice.delivery ?? {};
  const observed = {
    build: [slice.dispatched_at],
    checks: [pr.checks?.changed_at, pr.head_changed_at],
    review: [review.round_started_at, review.started_at],
    merge: [pr.checks?.changed_at, pr.head_changed_at],
    done: [delivery.pr_merged_at, delivery.recorded_at],
  };
  return [board?.entered_at, ...(observed[stage] ?? [])].map(ms).find((at) => at !== null) ?? null;
}

function reportOf(report, now) {
  const note = (text, at) => (text ? { text, at: ms(at) ?? now } : null);
  const parking = report?.parking && !report.parking.resumed_at ? report.parking : null;
  return {
    brief: note(report?.brief?.text, report?.brief?.written_at),
    eta: note(report?.eta?.text, report?.eta?.written_at),
    parked: note(parking?.reason, parking?.parked_at),
  };
}

// A last known address, never proof that the session still runs; it is shown, not navigated to.
function placeOf(seen) {
  if (!seen) return null;
  const herdr = seen.herdr ? [seen.herdr.workspace_label, seen.herdr.tab_label].filter(Boolean).join(" › ") || null : null;
  const where = [seen.label, herdr ?? seen.description].filter(Boolean).join(" › ");
  return where ? { where, role: seen.role ?? null, seenAt: ms(seen.last_seen_at) } : null;
}

function deployFailed(deployments) {
  return Object.values(deployments ?? {}).some((repo) => repo?.dev?.status === "failed" || repo?.prod?.status === "failed");
}

function isStalled(job, now) {
  return job.state === "resting" && job.counts.done > 0 && now - job.lastMoveAt > STALL_AFTER;
}

function bumpsOf(job, now) {
  const bumps = job.deployFailed ? ["A deploy failed"] : [];
  if (isStalled(job, now) && !job.report.parked) bumps.push(`Nothing has moved for ${span(now - job.lastMoveAt)} with ${job.counts.queued} queued`);
  for (const pkg of job.packages) {
    if (pkg.stage === "queued" || pkg.stage === "done") continue;
    if (pkg.failed) bumps.push(`Checks failing${pkg.untimed ? "" : ` for ${span(now - pkg.since)}`}: ${pkg.title}`);
    if (pkg.stage === "review" && pkg.round >= 3) bumps.push(`Review is on round ${pkg.round}: ${pkg.title}`);
    if (pkg.stage === "review" && !pkg.untimed && now - pkg.since > LONG_REVIEW) bumps.push(`In review for ${span(now - pkg.since)}: ${pkg.title}`);
  }
  return bumps;
}

function verdictOf(job, now) {
  if (job.needs.length > 0) return "needs_you";
  if (job.report.parked) return "parked";
  if (isStalled(job, now)) return "stalled";
  if (job.bumps.length > 0) return "bump";
  if (job.state === "settled") return "settled";
  return job.counts.live === 0 ? "idle" : "on_track";
}

function laneOf(job, now) {
  if (job.report.parked && job.needs.length === 0 && job.state !== "settled") return "parked";
  if (job.state === "live") return "moving";
  if (job.state === "settled") return job.deployFailed ? "moving" : now - job.lastMoveAt < DAY ? "landed" : "settled";
  if (job.counts.done === 0) return "backlog";
  return now - job.lastMoveAt < DORMANT_AFTER ? "moving" : "dormant";
}

function draftBrief(job, now) {
  const { live, queued, done, total } = job.counts;
  if (job.needs.length > 0) return `Waiting on you: ${job.needs[0].text}`;
  if (job.report.parked) return `Parked: ${job.report.parked.text}`;
  if (job.state === "settled") return total ? `All ${total} packages have landed.` : "Closed.";
  if (total === 0) return "Not sliced into packages yet.";
  if (live === 0) {
    return isStalled(job, now) ? `Nothing has moved for ${span(now - job.lastMoveAt)}. ${done} of ${total} landed.` : `Between packages: ${done} of ${total} landed, ${queued} up next.`;
  }
  if (job.bumps.length > 0) return job.bumps.length === 1 ? `${job.bumps[0]}.` : `${job.bumps[0]}, and ${job.bumps.length - 1} more.`;
  return `${live} of ${total} packages moving. ${done} landed.`;
}

// ---------- Board view ----------

// Lanes in reading order. Needs-you items are pulled out separately; their jobs still sit in "moving".
export function lanesOf(jobs) {
  const lanes = { moving: [], parked: [], backlog: [], landed: [], dormant: [], settled: [] };
  for (const job of jobs) lanes[job.lane].push(job);
  lanes.moving.sort((a, b) => RANK[a.verdict] - RANK[b.verdict] || b.lastMoveAt - a.lastMoveAt);
  for (const key of ["parked", "backlog", "landed", "dormant", "settled"]) lanes[key].sort((a, b) => b.lastMoveAt - a.lastMoveAt);
  return lanes;
}

export function needsOf(jobs) {
  return jobs.flatMap((job) => job.needs.map((need) => ({ ...need, job }))).sort((a, b) => (a.since ?? 0) - (b.since ?? 0));
}

// Reading order of the selectable jobs, matching what the list draws.
export function selectableJobs(jobs) {
  const lanes = lanesOf(jobs);
  return [...lanes.moving, ...lanes.parked, ...lanes.backlog, ...lanes.landed];
}

export function pickSelection(jobs, current) {
  const order = selectableJobs(jobs);
  if (current && jobs.some((job) => job.id === current)) return current;
  return needsOf(jobs)[0]?.jobId ?? order[0]?.id ?? null;
}

export function moveSelection(jobs, current, delta) {
  const order = selectableJobs(jobs);
  if (order.length === 0) return null;
  const at = order.findIndex((job) => job.id === current);
  return order[at < 0 ? 0 : Math.max(0, Math.min(order.length - 1, at + delta))].id;
}

// Packages in three parts that never mix: moving now, up next, landed.
export function packageSections(job) {
  return {
    now: job.packages.filter((pkg) => pkg.stage !== "queued" && pkg.stage !== "done"),
    next: job.packages.filter((pkg) => pkg.stage === "queued"),
    done: job.packages.filter((pkg) => pkg.stage === "done"),
  };
}

export function stageText(pkg, now) {
  if (pkg.stage === "done") return pkg.outcome === "dropped" ? "Dropped" : pkg.outcome === "finished" ? "Finished" : "Merged";
  if (pkg.stage === "queued") return pkg.after.length ? `After ${pkg.after.join(", ")}` : "Queued";
  const label = pkg.failed ? "Checks failing" : pkg.stage === "review" ? `Review${pkg.round > 1 ? ` · round ${pkg.round}` : ""}` : STAGE_LABEL[pkg.stage];
  return pkg.untimed || pkg.since === null ? label : `${label} · ${span(now - pkg.since)}`;
}

// Delivery evidence as the providers reported it. Missing checks never read as passing.
export function evidenceOf(pkg) {
  const parts = [];
  if (pkg.pr.number) parts.push(`PR #${pkg.pr.number}${pkg.pr.status && pkg.pr.status !== "none" ? ` ${pkg.pr.status}` : ""}`);
  else if (pkg.track === "pr" && pkg.stage !== "done" && pkg.stage !== "queued") parts.push("No PR yet");
  if (pkg.pr.number && pkg.pr.checks) parts.push(`checks ${pkg.pr.checks}`);
  const r = pkg.review;
  if (r.status && r.status !== "unavailable" && (pkg.stage === "review" || pkg.stage === "merge")) {
    const step = r.current && r.total ? ` ${r.current}/${r.total}` : r.step ? ` ${r.step}` : "";
    parts.push(`${r.mode ? `${r.mode} ` : ""}review ${r.status.replace(/_/g, " ")}${step}${r.observation === "stale" ? " (stale)" : ""}`);
  }
  return parts;
}

export function verdictCounts(jobs) {
  const counts = { needs: 0, moving: 0, planned: 0 };
  for (const job of jobs) {
    if (job.needs.length > 0) counts.needs += 1;
    counts.moving += job.counts.live;
    if (job.lane === "backlog") counts.planned += 1;
  }
  return counts;
}

// ---------- Scope: S++ areas and personal topics ----------

// Areas come from S++'s operator config; personal topics from `shared("desk.topics")`, read only.
// A job joins a topic by explicit `repoTopics` config first ("owner/repo" or "repo" -> topic id or
// name), else when its repository's name is the name or a folder segment of a space in that topic.
export function scopesOf(jobs, deskTopics, spaceList, repoTopics) {
  const areas = [...new Set(jobs.filter((job) => job.state !== "settled").map((job) => job.area[0]))].sort();
  const groups = Array.isArray(deskTopics?.groups) ? deskTopics.groups : [];
  const topics = groups
    .filter((group) => group && group.id && group.name)
    .map((group) => ({ key: `topic:${group.id}`, label: group.name, kind: "topic", id: group.id, names: spaceNames(group.spaces, spaceList) }))
    .filter((topic) => jobs.some((job) => inTopic(job, topic, repoTopics)));
  return [{ key: "all", label: "Everything", kind: "all" }, ...areas.map((area) => ({ key: `area:${area}`, label: area, kind: "area" })), ...topics];
}

export function applyScope(jobs, scope, repoTopics) {
  if (!scope || scope.kind === "all") return jobs;
  if (scope.kind === "area") return jobs.filter((job) => job.area[0] === scope.label);
  return jobs.filter((job) => inTopic(job, scope, repoTopics));
}

function inTopic(job, topic, repoTopics) {
  const explicit = repoTopics && typeof repoTopics === "object" ? repoTopics[job.repo] ?? repoTopics[job.repoShort] : undefined;
  if (typeof explicit === "string") return explicit === topic.id || explicit === topic.label;
  return Boolean(job.repoShort) && topic.names.has(job.repoShort.toLowerCase());
}

function spaceNames(ids, spaceList) {
  const wanted = new Set(Array.isArray(ids) ? ids : []);
  const names = new Set();
  for (const space of spaceList ?? []) {
    if (!wanted.has(space.id)) continue;
    if (space.name) names.add(String(space.name).toLowerCase());
    for (const part of String(space.folder ?? "").split(/[\\/]+/)) if (part) names.add(part.toLowerCase());
  }
  return names;
}

// ---------- Terminal bindings (seam for the execution adapter) ----------

// Only bindings the execution adapter explicitly verified, with the full core terminal address and
// its machine (null: this computer). `live` comes from herdr-core's own terminal list right now.
// Nothing is inferred from session locations, names, titles or terminal text.
export function verifiedBindings(raw, terminalList) {
  const state = new Map((terminalList ?? []).map((t) => [t.address, t.state]));
  return (Array.isArray(raw) ? raw : [])
    .filter((b) => b && b.verified === true && typeof b.work_request_id === "string" && typeof b.role === "string" && typeof b.address === "string" && b.address)
    .filter((b) => (b.machine ? b.address.startsWith(`${b.machine}/`) : !b.address.includes("/")))
    .map((b) => ({
      jobId: b.work_request_id,
      pkgId: typeof b.work_package_id === "string" ? b.work_package_id : null,
      attempt: typeof b.attempt_id === "string" ? b.attempt_id : null,
      role: b.role,
      machine: b.machine ?? null,
      address: b.address,
      live: state.get(b.address) === "live",
    }));
}

export function bindingsFor(bindings, jobId, pkgId) {
  return bindings.filter((b) => b.jobId === jobId && b.pkgId === (pkgId ?? null));
}

// ---------- Text ----------

export function describeReason(reason) {
  if (!reason) return null;
  if (REASONS[reason]) return REASONS[reason];
  return /^[a-z]+(_[a-z]+)+$/.test(reason) ? sentence(reason) : reason;
}

export function describeNext(actor, action) {
  if (!actor && !action) return null;
  const who = actor ? ACTORS[actor] ?? sentence(actor) : null;
  const what = action && action !== "none" ? sentence(action).toLowerCase() : null;
  return [who, what].filter(Boolean).join(" · ") || null;
}

export function span(value) {
  const minutes = Math.max(0, Math.round(value / MINUTE));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${String(minutes % 60).padStart(2, "0")}m` : `${Math.round(hours / 24)}d`;
}

export function ago(at, now) {
  if (at === null || at === undefined) return null;
  const text = span(now - at);
  return text === "now" ? "just now" : `${text} ago`;
}

function sentence(code) {
  const text = String(code).replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function shortRepo(repo) {
  return String(repo).replace(/\.git$/i, "").split(/[/:]/).filter(Boolean).pop() ?? "";
}

function offPrimary(base, defaultBranch) {
  if (!base) return false;
  return defaultBranch ? base !== defaultBranch : !/^(main|master)$/.test(base);
}

function ms(value) {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? time : null;
}
