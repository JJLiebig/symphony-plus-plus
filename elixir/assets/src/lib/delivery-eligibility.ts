import { formatStatus } from "@/lib/status-labels";
import type { WorkPackageMergeEligibility, WorkRequestDetail } from "@/types/dashboard";

const QUALIFIED_STATES = new Set(["merge_ready", "ready_for_merge"]);
const REASON_COPY: Record<string, string> = {
  candidate_pin_stale: "candidate input changed",
  delivery_order_violation: "delivery order conflict",
  dependencies_unavailable: "eligibility unavailable",
  dependency_cycle: "dependency cycle",
  dependency_inputs_stale: "inputs need requalification",
  dependency_not_delivered: "waiting for prerequisite delivery",
};

export function isQualifiedState(status?: string | null) {
  return QUALIFIED_STATES.has(status || "");
}

// Canonical eligibility decides integration; qualification alone never reads as mergeable.
export function qualifiedBadgeLabel(eligibility?: WorkPackageMergeEligibility | null) {
  return eligibility?.eligible === true ? "Ready to merge" : "Qualified";
}

export function qualifiedStateLabel(eligibility?: WorkPackageMergeEligibility | null) {
  if (eligibility?.eligible === true) return "Ready to merge";
  if (typeof eligibility?.eligible !== "boolean") return "Qualified · eligibility unknown";
  const [reason] = eligibilityReasons(eligibility);
  return `Qualified · ${reason ?? "not eligible"}`;
}

export function deliveryEligibilityLabel(eligibility?: WorkPackageMergeEligibility | null) {
  if (typeof eligibility?.eligible !== "boolean") return "Unknown";
  if (eligibility.eligible) return "Eligible · architect verifies current evidence, then integrates";
  const reasons = eligibilityReasons(eligibility);
  if (reasons.length) return `Not eligible · ${reasons.join(", ")}`;
  return eligibility.reason_codes?.includes("not_ready") ? "Not eligible · not qualified yet" : "Not eligible";
}

export function requestMergeEligibility(detail: WorkRequestDetail): WorkPackageMergeEligibility | undefined {
  const qualified = (detail.work_packages ?? []).filter((slice) => isQualifiedState(slice.operational_state?.key || slice.work_package_status || slice.status));
  if (!qualified.length) return undefined;
  const waiting = qualified.find((slice) => slice.merge_eligibility?.eligible !== true);
  return waiting ? waiting.merge_eligibility ?? undefined : { eligible: true };
}

function eligibilityReasons(eligibility: WorkPackageMergeEligibility) {
  return (eligibility.reason_codes ?? []).filter((code) => code !== "not_ready").map((code) => REASON_COPY[code] ?? formatStatus(code).toLowerCase());
}
