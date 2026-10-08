import type { GuidanceItem, WorkPackageCard, WorkRequestDetail } from "@/types/dashboard";

import { clarificationGuidanceItem } from "./dashboard-data";
import { stripMarkdown } from "./dashboard-text";
import type { RequestFrontierMode } from "./workstream-board";
import { requestBoardState, workPackageIsTerminal, workRequestIsTerminal, type BoardRowStateKind } from "./workstream-row-state";
import type { ActionableAttentionCounts } from "./workstream-attention";

export type FocusBoardLane = RequestFrontierMode;
export type FocusBoardItem = { detail: WorkRequestDetail; finishedAt?: string; id: string; lane: FocusBoardLane };
export type HumanDecision = { text: string; guidance?: GuidanceItem };

const CLARIFICATION_STATES = new Set(["clarifying", "ready_for_clarification"]);
const PRE_RUN_STATES = new Set([...CLARIFICATION_STATES, "ready_for_slicing"]);
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

export function buildFocusBoardItems(
  details: WorkRequestDetail[],
  now: string | number | Date = Date.now(),
  packageById = new Map<string, WorkPackageCard>(),
  attentionCountsByRequestId = new Map<string, ActionableAttentionCounts>(),
): FocusBoardItem[] {
  const nowMs = new Date(now).getTime();
  const items: FocusBoardItem[] = [];
  for (const detail of details) {
    const requestId = detail.work_request.id;
    const counts = attentionCountsByRequestId.get(requestId) ?? { blockerCount: 0, guidanceCount: 0 };
    const state = requestBoardState(detail, packageById, counts);
    if (workRequestIsTerminal(detail)) {
      const finishedAt = terminalTimestamp(detail);
      if (finishedAt && timestampIsRecent(finishedAt, nowMs)) items.push({ detail, finishedAt, id: requestId, lane: "recent" });
    } else {
      items.push({ detail, id: requestId, lane: requestLane(detail, state.kind) });
    }
  }
  return items;
}

// Only explicit human input counts: open request questions, human-info guidance, or a package whose canonical next actor is human.
export function requestHumanDecision(detail: WorkRequestDetail, guidanceItems: GuidanceItem[] = []): HumanDecision | null {
  return questionDecision(detail, guidanceItems) ?? guidanceDecision(detail, guidanceItems) ?? activityDecision(detail);
}

function questionDecision(detail: WorkRequestDetail, guidanceItems: GuidanceItem[]): HumanDecision | null {
  const question = detail.clarification_questions?.find((item) => item.status === "open");
  if (!question) return null;
  const guidance = guidanceItems.find((item) => item.source === "clarification" && item.question.id === question.id) ?? clarificationGuidanceItem(detail, question);
  return { text: question.decision_prompt?.tl_dr || stripMarkdown(question.question) || "Open question", guidance };
}

function guidanceDecision(detail: WorkRequestDetail, guidanceItems: GuidanceItem[]): HumanDecision | null {
  const packageIds = new Set(currentPackages(detail).flatMap((slice) => [slice.id, slice.work_package_id]));
  const guidance = guidanceItems.find((item) => item.source === "guidance" && item.guidance.status === "human_info_needed" && packageIds.has(item.packageId));
  if (guidance?.source !== "guidance") return null;
  return { text: guidance.guidance.human_info_reason || guidance.title, guidance };
}

function activityDecision(detail: WorkRequestDetail): HumanDecision | null {
  const activity = currentPackages(detail).find((slice) => slice.activity_signal?.next_actor === "human")?.activity_signal;
  return activity ? { text: activity.waiting_reason || "Human input requested" } : null;
}

// Retired or delivered packages keep their guidance rows, but they no longer ask anyone for input.
function currentPackages(detail: WorkRequestDetail) {
  return (detail.work_packages ?? []).filter((slice) => !workPackageIsTerminal(slice));
}

export function requestHasExecutionBoard(detail: WorkRequestDetail) {
  if (!detail.product_tree) return (detail.summary?.work_package_count ?? detail.work_request.work_package_count ?? 0) > 0;
  const graph = detail.product_tree.execution_graph;
  return graph?.available === true
    && !graph.cycles?.length
    && Boolean(detail.product_tree.nodes?.length || graph.work_package_ids?.length);
}

function requestLane(detail: WorkRequestDetail, kind: BoardRowStateKind): Exclude<FocusBoardLane, "recent"> {
  if (kind === "blocked" || kind === "guidance") return "attention";
  const requestState = detail.work_request.operational_state?.key || detail.work_request.status || "created";
  if (PRE_RUN_STATES.has(requestState)) return "waiting";
  if (kind === "active") return "active";
  if (kind === "ready") return "next";
  return "waiting";
}

function terminalTimestamp(detail: WorkRequestDetail) {
  if (validTimestamp(detail.work_request.completed_at)) return detail.work_request.completed_at!;
  const packageDeliveries = (detail.work_packages ?? []).map((slice) => slice.delivery);
  const deliveryRows = (detail.delivery_board?.work_packages ?? []).map((row) => row.delivery);
  let latest: string | undefined;
  for (const delivery of [...packageDeliveries, ...deliveryRows]) {
    for (const value of [delivery?.pr_merged_at, delivery?.recorded_at]) {
      if (validTimestamp(value) && (!latest || Date.parse(value) > Date.parse(latest))) latest = value;
    }
  }
  return latest;
}

function timestampIsRecent(timestamp: string, nowMs: number) {
  const elapsed = nowMs - Date.parse(timestamp);
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= RECENT_WINDOW_MS;
}

function validTimestamp(value?: string | null): value is string {
  return Boolean(value && Number.isFinite(Date.parse(value)));
}
