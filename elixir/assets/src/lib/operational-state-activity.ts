import { deliveryEligibilityLabel, isQualifiedState, qualifiedStateLabel } from "@/lib/delivery-eligibility";
import { operationalStatusIsRunning } from "@/lib/operational-state";
import { formatStatus, statusLabel } from "@/lib/status-labels";
import type { WorkPackageActivitySignal, WorkPackageMergeEligibility, WorkPackageReviewSignal } from "@/types/dashboard";

export type WorkActivityField = { key: "owner" | "actor" | "stage" | "waiting" | "next"; label: string; value: string; human?: boolean; unknown?: boolean };

const ACTOR_LABELS: Record<string, string> = { architect: "Architect", human: "Human", prerequisite_owner: "Prerequisite owner", worker: "Worker" };
const WAITING_LABELS: Record<string, string> = {
  active_blocker: "Active blocker",
  awaiting_integration: "Architect integration",
  candidate_pin_stale: "Current candidate input",
  delivery_order_violation: "Delivery order resolution",
  dependency_cycle: "Dependency cycle resolution",
  dependency_inputs_stale: "Requalification on current inputs",
  dependency_not_delivered: "Prerequisite delivery",
  review_in_progress: "Review in progress",
  runtime_stale: "Fresh runtime observation",
  unmet_dependencies: "Prerequisite work",
  validation_pending: "Checks",
  worker_paused: "Paused worker",
};
const ACTION_LABELS: Record<string, string> = {
  answer_guidance: "answer the decision",
  check_validation: "check validation",
  deliver_prerequisites: "wait for prerequisite delivery",
  finish_worker_qualification: "finish qualification",
  fix_findings: "fix review findings",
  inspect_runtime: "inspect runtime",
  resolve_blocker: "resolve blocker",
  resolve_delivery_order_violation: "resolve delivery order",
  resolve_dependencies: "resolve dependencies",
  resume: "resume work",
  select_current_candidate_and_requalify_affected_work: "select current input and requalify",
  verify_native_checks_and_review_then_merge: "verify checks and review, then integrate",
  wait: "wait for review",
};

export function activityActorLabel(actor?: WorkPackageActivitySignal["current_actor"]) {
  const name = actor?.name || actor?.id || actor?.session_id;
  return name ? [name, actor?.role ? formatStatus(actor.role) : null].filter(Boolean).join(" / ") : "Unknown";
}

export function activityElapsedLabel(activity?: WorkPackageActivitySignal | null, review?: WorkPackageReviewSignal | null) {
  const seconds = activity?.elapsed_seconds;
  if (!activity?.started_at || seconds == null || !Number.isFinite(seconds) || seconds < 0) return "Time unknown";
  return [durationLabel(seconds), timingBasis(activity.started_at, review)].filter(Boolean).join(" ");
}

function durationLabel(seconds: number) {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}

// The projection starts review timing from the round when known, else from the provider review start.
function timingBasis(startedAt: string, review?: WorkPackageReviewSignal | null) {
  if (review?.round_started_at === startedAt) return "this round";
  if (review?.started_at === startedAt) return "in review";
  return null;
}

export function activityStageLabel(activity?: WorkPackageActivitySignal | null, review?: WorkPackageReviewSignal | null, eligibility?: WorkPackageMergeEligibility | null) {
  const stage = activity?.stage;
  const parts = [isQualifiedState(stage) ? qualifiedStateLabel(eligibility) : statusLabel(stage)];
  if (stage === "reviewing") parts.push(...reviewProgressParts(review));
  if (operationalStatusIsRunning(null, stage)) parts.push(activityElapsedLabel(activity, review));
  return parts.join(" · ");
}

function reviewProgressParts(review?: WorkPackageReviewSignal | null) {
  return [
    review?.step ? formatStatus(review.step) : null,
    review?.current != null && review.total != null && review.total > 0 ? `${review.current}/${review.total}` : null,
    review?.round ? `Round ${review.round}` : null,
  ].filter((part): part is string => Boolean(part));
}

export function activityObservationLabel(state?: string | null) {
  return state === "stale" ? "Runtime stale" : state === "paused" ? "Runtime paused" : state === "current" ? "Runtime current" : "Runtime observation unknown";
}

export function activityNextLabel(activity?: WorkPackageActivitySignal | null) {
  const actor = activity?.next_actor ? ACTOR_LABELS[activity.next_actor] ?? formatStatus(activity.next_actor) : null;
  const action = activity?.next_action ? ACTION_LABELS[activity.next_action] ?? formatStatus(activity.next_action).toLowerCase() : null;
  if (!actor && !action) return "Unknown";
  return actor && action ? `${actor}: ${action}` : actor ?? capitalize(action!);
}

export function activityWaitingLabel(activity?: WorkPackageActivitySignal | null) {
  const reason = activity?.waiting_reason;
  if (!reason) return "Nothing recorded";
  const label = WAITING_LABELS[reason] ?? (/^[a-z0-9_]+$/.test(reason) ? formatStatus(reason) : reason);
  return activity?.next_actor === "human" ? `Human decision: ${label}` : label;
}

export function workActivityFields(activity?: WorkPackageActivitySignal | null, review?: WorkPackageReviewSignal | null, eligibility?: WorkPackageMergeEligibility | null): WorkActivityField[] {
  const owner = activity?.accountable_owner?.id;
  const actor = activityActorLabel(activity?.current_actor);
  const next = activityNextLabel(activity);
  const human = activity?.next_actor === "human";
  return [
    { key: "owner", label: "Owner", value: owner || "Unknown", unknown: !owner },
    { key: "actor", label: "Working now", value: actorWithObservation(actor, activity?.observation_state), unknown: actor === "Unknown" },
    { key: "stage", label: "Stage", value: activity?.stage ? activityStageLabel(activity, review, eligibility) : "Unknown", unknown: !activity?.stage },
    { key: "waiting", label: "Waiting on", value: activityWaitingLabel(activity), human: human && Boolean(activity?.waiting_reason) },
    { key: "next", label: "Next", value: next, human, unknown: next === "Unknown" },
  ];
}

function actorWithObservation(actor: string, observation?: string | null) {
  return observation === "stale" || observation === "paused" ? `${actor} · ${activityObservationLabel(observation).toLowerCase()}` : actor;
}

export function workActivityFacts(activity?: WorkPackageActivitySignal | null, review?: WorkPackageReviewSignal | null, eligibility?: WorkPackageMergeEligibility | null) {
  const source = activity ?? {};
  return [
    { label: "WorkPackage", value: source.work_package_id },
    ...workActivityFields(activity, review, eligibility).map(({ label, value }) => ({ label, value })),
    { label: "Observation", value: activityObservationLabel(source.observation_state) },
    { label: "Qualification", value: isQualifiedState(source.stage) ? "Qualified by its worker" : null },
    { label: "Delivery eligibility", value: eligibility || isQualifiedState(source.stage) ? deliveryEligibilityLabel(eligibility) : null },
    ...reviewFacts(review),
    { label: "Activity started", value: source.started_at },
    { label: "Last update", value: source.last_update_at },
    { label: "Latest update", value: source.last_update },
  ].filter((fact): fact is { label: string; value: string } => Boolean(fact.value));
}

function reviewFacts(review?: WorkPackageReviewSignal | null) {
  if (!review) return [];
  return [
    { label: "Review status", value: formatStatus(review.provider_status || review.status) },
    { label: "Review observation", value: formatStatus(review.observation_state || "unknown") },
    { label: "Review next", value: review.next_action ? formatStatus(review.next_action) : null },
    { label: "Review observed", value: review.observed_at },
  ];
}

export function workActivitySearchFields(activity?: WorkPackageActivitySignal | null, review?: WorkPackageReviewSignal | null, eligibility?: WorkPackageMergeEligibility | null) {
  return activity ? workActivityFields(activity, review, eligibility).map(({ value }) => value) : [];
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
