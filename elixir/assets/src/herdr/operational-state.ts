import type { PackageOperationalState } from "./work-request";

type BoardLane = "slices" | "implementing" | "finished";

const BOARD_LANES: Record<string, BoardLane> = {
  active: "implementing",
  abandoned: "finished",
  blocked: "implementing",
  ci_waiting: "implementing",
  claimed: "implementing",
  closed: "finished",
  completed: "finished",
  completed_no_pr: "finished",
  created: "implementing",
  delivered: "finished",
  implementing: "implementing",
  in_progress: "implementing",
  merge_ready: "implementing",
  merged: "finished",
  merging: "implementing",
  needs_attention: "implementing",
  needs_closeout: "implementing",
  planning: "implementing",
  ready_for_merge: "implementing",
  ready_for_worker: "implementing",
  ready_to_finish: "implementing",
  reviewing: "implementing",
  skipped: "finished",
  started_paused: "implementing",
  superseded: "finished",
};

const RUNNING_STATUSES = new Set([
  "active",
  "ci_waiting",
  "claimed",
  "implementing",
  "in_progress",
  "merging",
  "planning",
  "reviewing",
]);

export function isFinishedBoardStatus(status?: string | null) {
  return BOARD_LANES[status || ""] === "finished";
}

export function operationalStatusIsRunning(operational?: PackageOperationalState | null, fallbackStatus?: string | null) {
  return RUNNING_STATUSES.has(operational?.key || fallbackStatus || "");
}
