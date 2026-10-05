import { formatStatus, statusLabel } from "@/lib/status-labels";
import type { WorkPackageActivitySignal, WorkPackageReviewSignal } from "@/types/dashboard";

export function activityActorLabel(actor?: WorkPackageActivitySignal["current_actor"]) {
  const name = actor?.name || actor?.id || actor?.session_id;
  return name ? [name, actor?.role ? formatStatus(actor.role) : null].filter(Boolean).join(" / ") : "Unknown";
}

export function activityElapsedLabel(activity?: WorkPackageActivitySignal | null) {
  const seconds = activity?.elapsed_seconds;
  if (!activity?.started_at || seconds == null || !Number.isFinite(seconds) || seconds < 0) return "Time unknown";
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}

export function activityStageLabel(activity?: WorkPackageActivitySignal | null, review?: WorkPackageReviewSignal | null) {
  const parts = [statusLabel(activity?.stage)];
  if (activity?.stage === "reviewing") {
    if (review?.step) parts.push(formatStatus(review.step));
    if (review?.current != null && review.total != null && review.total > 0) parts.push(`${review.current}/${review.total}`);
    if (review?.round) parts.push(`Round ${review.round}`);
    parts.push(activityElapsedLabel(activity));
  }
  return parts.join(" · ");
}

export function activityObservationLabel(state?: string | null) {
  return state === "stale" ? "Runtime stale" : state === "paused" ? "Runtime paused" : state === "current" ? "Runtime current" : "Runtime observation unknown";
}

export function workActivityFacts(activity?: WorkPackageActivitySignal | null, review?: WorkPackageReviewSignal | null) {
  const source = activity ?? {};
  return [
    ...baseActivityFacts(source, review),
    ...reviewFacts(review),
    { label: "Activity started", value: source.started_at },
    { label: "Last update", value: source.last_update_at },
    { label: "Latest update", value: source.last_update },
  ].filter((fact): fact is { label: string; value: string } => Boolean(fact.value));
}

function baseActivityFacts(activity: WorkPackageActivitySignal, review?: WorkPackageReviewSignal | null) {
  return [
    { label: "WorkPackage", value: activity.work_package_id },
    { label: "Activity", value: activityStageLabel(activity, review) },
    { label: "Owner", value: activity.accountable_owner?.id || "Unknown" },
    { label: "Current actor", value: activityActorLabel(activity.current_actor) },
    { label: "Waiting", value: activity.waiting_reason ? formatStatus(activity.waiting_reason) : "Not recorded" },
    { label: "Next", value: [activity.next_actor, activity.next_action].filter(Boolean).map((value) => formatStatus(value)).join(" / ") || "Unknown" },
    { label: "Observation", value: activityObservationLabel(activity.observation_state) },
  ];
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

export function activitySummary(activity?: WorkPackageActivitySignal | null, review?: WorkPackageReviewSignal | null) {
  if (!activity) return null;
  return workActivityFacts(activity, review).filter(({ label }) => ["Activity", "Owner", "Current actor", "Waiting", "Next", "Observation"].includes(label)).map(({ label, value }) => `${label}: ${value}`).join(" · ");
}
