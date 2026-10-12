// Clean-slate model. A Goal is a WorkRequest; a Pkg is a WorkPackage with the stages it has moved through.
import { areaFor } from "./areas";

export type Stage = "queued" | "build" | "checks" | "review" | "merge" | "done";
export type Outcome = "merged" | "finished" | "dropped";
// `untimed` marks a stage whose start nobody observed: `from` is then only the closest known time.
export type Seg = { stage: Stage; from: number; to: number; failed: boolean; untimed?: boolean };
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
// Something the architect wrote, and when.
export type Note = { text: string; at: number };
// The architect's own words about a goal. `parked` is set only while the goal is set aside.
export type ArchitectReport = { brief: Note | null; eta: Note | null; parked: Note | null };
export type Group = { id: string; title: string; parentId: string | null };
// Where the result runs after the last merge. Not in the ledger yet; only the mock goals carry it.
export type DeployStep = { env: "Dev" | "Prod"; state: "ok" | "failed" | "pending"; at: number };
// `deploy` is present only for goals whose repository has its deploy workflows tagged.
export type Goal = { id: string; title: string; area: string[]; repo: string; baseBranch: string | null; createdAt: number; closedAt: number | null; pkgs: Pkg[]; asks: Ask[]; groups: Group[]; report?: ArchitectReport; mock?: boolean; deploy?: DeployStep[] };

export type PkgView = { pkg: Pkg; stage: Stage; since: number; untimed: boolean; failed: boolean; round: number; actor: string | null };
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
  board_state?: BoardState | null;
  pr_signal?: { number?: number | null; url?: string | null; created_at?: string | null; head_changed_at?: string | null; checks?: { status?: string | null; changed_at?: string | null } | null } | null;
  review_signal?: { mode?: string | null; round?: number | null; started_at?: string | null; round_started_at?: string | null } | null;
};
type BoardState = { stage?: Stage | null; entered_at?: string | null; track?: string | null; delivered?: boolean | null };
type Written = { text?: string | null; written_at?: string | null };
type OperatorReport = {
  brief?: Written | null;
  eta?: Written | null;
  parking?: { reason?: string | null; parked_at?: string | null; resumed_at?: string | null } | null;
  human_escalation?: { question?: string | null; raised_at?: string | null; resolved_at?: string | null } | null;
};
type Detail = {
  work_request: { id: string; title?: string | null; repo?: string | null; repo_display?: string | null; base_branch?: string | null; inserted_at?: string | null; completed_at?: string | null; status?: string | null; operator_report?: OperatorReport | null };
  work_packages?: Slice[];
  product_tree?: { nodes?: Array<{ id: string; title?: string | null; position?: number; parent_id?: string | null }> } | null;
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
    asks: asksOf(request.operator_report?.human_escalation, now),
    report: reportOf(request.operator_report, now),
    groups: [...(detail.product_tree?.nodes ?? [])].sort((left, right) => (left.position ?? 0) - (right.position ?? 0)).map((node) => ({ id: node.id, title: node.title || "Untitled", parentId: node.parent_id ?? null })),
  };
}

// Only an explicit escalation by the architect asks for the operator. An open question does not.
function asksOf(escalation: OperatorReport["human_escalation"], now: number): Ask[] {
  if (!escalation?.question) return [];
  return [{ from: ms(escalation.raised_at) ?? now, to: ms(escalation.resolved_at) ?? Infinity, title: escalation.question }];
}

function reportOf(report: OperatorReport | null | undefined, now: number): ArchitectReport | undefined {
  if (!report) return undefined;
  const note = (text?: string | null, at?: string | null): Note | null => (text ? { text, at: ms(at) ?? now } : null);
  const parking = report.parking?.resumed_at ? null : report.parking;
  return { brief: note(report.brief?.text, report.brief?.written_at), eta: note(report.eta?.text, report.eta?.written_at), parked: note(parking?.reason, parking?.parked_at) };
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
  return slice.board_state ? boardPkg(slice, slice.board_state, now) : historyPkg(slice, events, now);
}

// The backend's own reading of a package: its stage, when it got there, and whether it ends in a merge.
function boardPkg(slice: Slice, board: BoardState, now: number): Pkg {
  const pkg = { ...blankPkg(slice, now), ...signalFacts(slice), short: board.track === "no_pr" };
  const stage = board.stage ?? "queued";
  const observed = stageTime(slice, board);
  const since = observed ?? ms(slice.dispatched_at) ?? pkg.createdAt;
  pkg.outcome = outcomeOf(slice) ?? boardOutcome(board, pkg.short);
  if (pkg.outcome) return { ...pkg, endAt: since };
  if (stage === "queued") return pkg;

  pkg.segs = [{ stage, from: since, to: now, failed: slice.pr_signal?.checks?.status === "failing", untimed: observed === null }];
  pkg.rounds = Array.from({ length: Math.max(0, (slice.review_signal?.round ?? 1) - 1) }, () => since);
  return pkg;
}

function signalFacts(slice: Slice): Pick<Pkg, "reviewMode" | "prAt" | "prNumber" | "prUrl"> {
  const pr = slice.pr_signal ?? {};
  return { reviewMode: slice.review_signal?.mode ?? slice.review?.args?.mode ?? null, prAt: ms(pr.created_at), prNumber: pr.number ?? null, prUrl: pr.url ?? null };
}

function boardOutcome(board: BoardState, short: boolean): Outcome | null {
  if (!board.delivered && board.stage !== "done") return null;
  return short ? "finished" : "merged";
}

// When the package reached its stage: the backend's evidence first, then what it observed about that stage.
function stageTime(slice: Slice, board: BoardState) {
  const pr = slice.pr_signal ?? {};
  const checks = pr.checks ?? {};
  const review = slice.review_signal ?? {};
  const delivery = slice.delivery ?? {};
  const observed: Partial<Record<Stage, Array<string | null | undefined>>> = {
    build: [slice.dispatched_at],
    checks: [checks.changed_at, pr.head_changed_at, pr.created_at],
    review: [review.round_started_at, review.started_at],
    merge: [checks.changed_at, pr.head_changed_at],
    done: [delivery.pr_merged_at, delivery.recorded_at],
  };
  const stage = delivery.outcome ? "done" : (board.stage ?? "queued");
  return [board.entered_at, ...(observed[stage] ?? [])].map(ms).find((at) => at !== null) ?? null;
}

// Packages captured before the backend reported stages: the stage is read from their recorded history.
function historyPkg(slice: Slice, events: HistoryEvent[], now: number): Pkg {
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

function stageAt(pkg: Pkg, seg: Seg | undefined, ended: boolean): Pick<PkgView, "stage" | "since" | "untimed" | "failed"> {
  if (ended) return { stage: "done", since: pkg.endAt!, untimed: false, failed: false };
  if (!seg) return { stage: "queued", since: pkg.createdAt, untimed: false, failed: false };
  return { stage: seg.stage, since: seg.from, untimed: seg.untimed === true, failed: seg.failed };
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
