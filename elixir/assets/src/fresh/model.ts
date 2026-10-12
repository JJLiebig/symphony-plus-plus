// Clean-slate model. A Goal is a WorkRequest; a Pkg is a WorkPackage with the stages it has moved through.
import { areaFor } from "./areas";

export type Stage = "queued" | "build" | "checks" | "review" | "merge" | "done";
export type Outcome = "merged" | "finished" | "dropped";
export type Seg = { stage: Stage; from: number; to: number; failed: boolean };
export type HistoryEvent = { t: string; s?: string; y?: string; c?: string; m?: boolean; n?: number; u?: string; a?: string; r?: string; x?: string };

export type Pkg = {
  id: string;
  title: string;
  seq: number;
  short: boolean;
  reviewMode: string | null;
  groupId: string | null;
  goalTitle: string;
  area: string[];
  createdAt: number;
  segs: Seg[];
  endAt: number | null;
  outcome: Outcome | null;
  prAt: number | null;
  prNumber: number | null;
  prUrl: string | null;
  rounds: number[];
  actors: Array<{ at: number; id: string }>;
};

export type Ask = { from: number; to: number; title: string };
export type Group = { id: string; title: string; parentId: string | null };
// Where the result runs after the last merge. Not in the ledger yet; only the mock goals carry it.
export type DeployStep = { env: "Dev" | "Prod"; state: "ok" | "failed" | "pending"; at: number };
// `deploy` is present only for goals whose repository has its deploy workflows tagged.
export type Goal = { id: string; title: string; area: string[]; repo: string; baseBranch: string | null; createdAt: number; closedAt: number | null; pkgs: Pkg[]; asks: Ask[]; groups: Group[]; mock?: boolean; deploy?: DeployStep[] };

export type PkgView = { pkg: Pkg; stage: Stage; since: number; failed: boolean; round: number; actor: string | null };
export type GoalView = { goal: Goal; live: PkgView[]; queued: Pkg[]; done: Pkg[]; ask: Ask | null; state: "live" | "resting" | "settled"; lastMoveAt: number };

type Slice = {
  id: string;
  work_package_id?: string | null;
  title?: string | null;
  kind?: string | null;
  sequence?: number;
  inserted_at?: string | null;
  dispatched_at?: string | null;
  product_tree_node_id?: string | null;
  review?: { args?: { mode?: string | null } | null } | null;
  delivery?: { outcome?: string | null; recorded_at?: string | null; pr_merged_at?: string | null } | null;
  operational_state?: { key?: string | null } | null;
};
type Detail = {
  work_request: { id: string; title?: string | null; repo?: string | null; repo_display?: string | null; base_branch?: string | null; inserted_at?: string | null; completed_at?: string | null; status?: string | null };
  work_packages?: Slice[];
  product_tree?: { nodes?: Array<{ id: string; title?: string | null; position?: number; parent_id?: string | null }> } | null;
  clarification_questions?: Array<{ question?: string | null; decision_prompt?: { tl_dr?: string } | null; inserted_at?: string | null; answered_at?: string | null; status?: string | null }>;
};
export type Hydrated = { generated_at?: string; work_request_details?: Detail[] };
type Timed = { event: HistoryEvent; at: number };

const OUTCOMES: Record<string, Outcome> = { pr_merged: "merged", completed_no_pr: "finished", superseded: "dropped", abandoned: "dropped" };
// First match wins. Statuses are whatever agents wrote, so these are deliberately loose.
const STATUS_RULES: Array<[RegExp, Stage]> = [
  [/^(merged|github_pr_merged)$/, "done"],
  [/merge_ready|ready_for_merge|review_complete|^reviewed$|review_owner_accepted|acceptance|ready_for_close/, "merge"],
  [/review/, "review"],
  [/validat|ci_waiting/, "checks"],
];

export function buildGoals(hydrated: Hydrated, history: Record<string, HistoryEvent[]>): { goals: Goal[]; now: number } {
  const now = Date.parse(hydrated.generated_at ?? "") || Date.now();
  return { goals: (hydrated.work_request_details ?? []).map((detail) => buildGoal(detail, history, now)), now };
}

function buildGoal(detail: Detail, history: Record<string, HistoryEvent[]>, now: number): Goal {
  const request = detail.work_request;
  const title = request.title || request.id;
  const repo = request.repo_display || request.repo || "";
  const area = areaFor(repo);

  return {
    id: request.id,
    title,
    area,
    repo,
    baseBranch: request.base_branch ?? null,
    createdAt: ms(request.inserted_at) ?? now,
    closedAt: ms(request.completed_at),
    pkgs: (detail.work_packages ?? []).map((slice) => ({ ...buildPkg(slice, history[slice.work_package_id || slice.id] ?? [], now), goalTitle: title, area })),
    asks: (detail.clarification_questions ?? []).map((question) => buildAsk(question, now)),
    groups: [...(detail.product_tree?.nodes ?? [])].sort((left, right) => (left.position ?? 0) - (right.position ?? 0)).map((node) => ({ id: node.id, title: node.title || "Untitled", parentId: node.parent_id ?? null })),
  };
}

function buildAsk(question: NonNullable<Detail["clarification_questions"]>[number], now: number): Ask {
  const from = ms(question.inserted_at) ?? now;
  return { from, to: ms(question.answered_at) ?? (question.status === "open" ? Infinity : from), title: question.decision_prompt?.tl_dr || question.question || "Question" };
}

function blankPkg(slice: Slice, now: number): Pkg {
  return {
    id: slice.work_package_id || slice.id,
    title: slice.title || slice.id,
    seq: slice.sequence ?? 0,
    short: slice.kind === "investigation",
    reviewMode: slice.review?.args?.mode ?? null,
    groupId: slice.product_tree_node_id ?? null,
    goalTitle: "",
    area: [],
    createdAt: ms(slice.inserted_at) ?? now,
    segs: [],
    endAt: null,
    outcome: null,
    prAt: null,
    prNumber: null,
    prUrl: null,
    rounds: [],
    actors: [],
  };
}

function outcomeOf(slice: Slice): Outcome | null {
  return OUTCOMES[slice.delivery?.outcome ?? ""] ?? (slice.operational_state?.key === "skipped" ? "dropped" : null);
}

function endOf(slice: Slice, events: HistoryEvent[], now: number) {
  return ms(slice.delivery?.pr_merged_at) ?? ms(slice.delivery?.recorded_at) ?? ms(events.at(-1)?.t) ?? now;
}

// Work starts when the package is dispatched: a dispatched package is building, whether or not it has reported yet.
function startOf(slice: Slice, timed: Timed[], endAt: number | null) {
  const dispatched = ms(slice.dispatched_at);
  const starts = [dispatched !== null && (endAt === null || dispatched <= endAt) ? dispatched : null, timed[0]?.at ?? null].filter((at) => at !== null);
  return starts.length > 0 ? Math.min(...starts) : null;
}

function buildPkg(slice: Slice, events: HistoryEvent[], now: number): Pkg {
  const pkg = blankPkg(slice, now);
  pkg.outcome = outcomeOf(slice);
  pkg.endAt = pkg.outcome ? endOf(slice, events, now) : null;
  const until = pkg.endAt ?? Infinity;
  const timed = events.map((event) => ({ event, at: Date.parse(event.t) })).filter(({ at }) => at <= until);
  const startAt = startOf(slice, timed, pkg.endAt);
  if (startAt === null) return pkg;

  pkg.segs = segsOf(pkg, timed, startAt, pkg.endAt ?? now);
  if (pkg.prAt === null && pkg.outcome === "finished") pkg.short = true;
  return pkg;
}

function segsOf(pkg: Pkg, timed: Timed[], startAt: number, until: number): Seg[] {
  const segs: Seg[] = [];
  let current: Seg = { stage: "build", from: startAt, to: until, failed: false };

  for (const { event, at } of timed) {
    notePassiveFacts(pkg, event, at);
    const next = nextStage(event, current.stage, pkg.prAt !== null);
    const failed = event.y === "pr" && event.c === "failing";
    if (next && (next !== current.stage || failed !== current.failed)) {
      segs.push({ ...current, to: at });
      current = { stage: next, from: at, to: until, failed };
    }
  }
  return [...segs, current];
}

function notePassiveFacts(pkg: Pkg, event: HistoryEvent, at: number) {
  if (event.y === "pr") notePr(pkg, event, at);
  if (/review.*fix|fix.*review/.test(event.s ?? "")) pkg.rounds.push(at);
  if (event.a && (event.r === "worker" || pkg.actors.length === 0)) pkg.actors.push({ at, id: event.a });
}

function notePr(pkg: Pkg, event: HistoryEvent, at: number) {
  pkg.prAt ??= at;
  pkg.prNumber ??= event.n ?? null;
  pkg.prUrl ??= event.u ?? null;
}

function nextStage(event: HistoryEvent, current: Stage, hasPr: boolean): Stage | null {
  if (event.m) return "done";
  if (event.y === "pr") return prStage(event.c, current);
  const stage = STATUS_RULES.find(([pattern]) => pattern.test(event.s ?? ""))?.[1] ?? null;
  return stage === "checks" && !hasPr ? null : stage;
}

function prStage(checks: string | undefined, current: Stage): Stage {
  if (checks === "failing" || checks === "pending") return "checks";
  return current === "merge" ? "merge" : "review";
}

export function viewAt(goals: Goal[], at: number): GoalView[] {
  return goals.filter((goal) => goal.createdAt <= at).map((goal) => goalViewAt(goal, at));
}

function goalViewAt(goal: Goal, at: number): GoalView {
  const pkgs = goal.pkgs.filter((pkg) => pkg.createdAt <= at);
  const views = pkgs.map((pkg) => pkgViewAt(pkg, at));
  const live = views.filter((view) => view.stage !== "queued" && view.stage !== "done");
  const done = views.filter((view) => view.stage === "done").map((view) => view.pkg);
  const ask = goal.asks.find((entry) => entry.from <= at && at < entry.to) ?? null;
  const closed = goal.closedAt !== null && goal.closedAt <= at;
  const allDone = pkgs.length > 0 && done.length === pkgs.length && !ask;

  return {
    goal,
    live,
    queued: views.filter((view) => view.stage === "queued").map((view) => view.pkg),
    done,
    ask,
    state: goalState(closed || allDone, live.length > 0 || ask !== null),
    lastMoveAt: Math.max(goal.createdAt, ...views.map((view) => view.since)),
  };
}

function goalState(finished: boolean, busy: boolean): GoalView["state"] {
  if (finished) return "settled";
  return busy ? "live" : "resting";
}

function pkgViewAt(pkg: Pkg, at: number): PkgView {
  const ended = pkg.endAt !== null && at >= pkg.endAt;
  const seg = ended ? undefined : pkg.segs.findLast((entry) => entry.from <= at);

  return {
    pkg,
    ...stageAt(pkg, seg, ended),
    round: 1 + pkg.rounds.filter((round) => round <= at).length,
    actor: pkg.actors.findLast((actor) => actor.at <= at)?.id ?? null,
  };
}

function stageAt(pkg: Pkg, seg: Seg | undefined, ended: boolean): Pick<PkgView, "stage" | "since" | "failed"> {
  if (ended) return { stage: "done", since: pkg.endAt!, failed: false };
  if (!seg) return { stage: "queued", since: pkg.createdAt, failed: false };
  return { stage: seg.stage, since: seg.from, failed: seg.failed };
}

export function deployAt(goal: Goal, at: number) {
  return (goal.deploy ?? []).filter((step) => step.at <= at);
}

export function liveCountAt(goals: Goal[], at: number) {
  return goals.reduce((sum, goal) => sum + goal.pkgs.filter((pkg) => isLiveAt(pkg, at)).length, 0);
}

// A package that never reported an end stops counting as live a day after its last stage change.
function isLiveAt(pkg: Pkg, at: number) {
  if (pkg.segs.length === 0 || pkg.segs[0].from > at) return false;
  return pkg.endAt === null ? at - pkg.segs.at(-1)!.from < 24 * 3600e3 : at < pkg.endAt;
}

export function span(msValue: number) {
  const minutes = Math.max(0, Math.round(msValue / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${String(minutes % 60).padStart(2, "0")}m` : `${Math.round(hours / 24)}d`;
}

function ms(value?: string | null) {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? time : null;
}
