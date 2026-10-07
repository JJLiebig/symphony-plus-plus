import { qualifiedStateLabel } from "@/lib/delivery-eligibility";
import type { ActiveBlockingEdge, GuidanceItem, WorkPackageCard, WorkRequestDetail, WorkRequestPackage } from "@/types/dashboard";
import { ChevronRight, Copy, GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { type CSSProperties, type ReactNode, useMemo, useState } from "react";
import { copyTextToClipboard, CardDetailSelect, DashboardUpdateAnimations } from "./runtime";
import { sortWorkRequestPackages } from "./workstream-data";
import { requestBoardState, statusBadgeWidthForLabels, type BoardRowStateKind } from "./workstream-row-state";
import { RequestAttentionBadge, RequestIdentityCopyButton, RequestInfoButton } from "./workstream-row-ui";
import { requestUpdateKey } from "./update-animations";
import { updateMotionAttributes } from "@/components/dashboard/motion-utils";
import { contextPathValue } from "./workstream-context-path";
import { isFinishedBoardStatus, operationalLabel, operationalStatusIsRunning, sliceOperationalState } from "@/lib/operational-state";
import { PullRequestBadge } from "./execution-graph/pull-request-badge";
import { requestUpdatedLabel } from "./workstream-row-age";
import { WorkActivityFields } from "./work-activity";
import { architectStartPrompt, visibleRequestBranch } from "./workstream-utils";
import { requestActionableAttentionCounts, workPackageDirectAttention, type AttentionSelect } from "./workstream-attention";
export type RequestFrontierMode = "attention" | "active" | "next" | "recent" | "waiting";
export function ProductRequestRow({
  detail,
  now,
  activeBlockingEdges, guidanceItems,
  packageById,
  focusSelected,
  index,
  onSetOpen,
  onSelectAttention,
  onSelectCard,
  primaryBranch,
  frontierMode,
  notice,
  updateAnimations,
}: {
  detail: WorkRequestDetail;
  now?: string;
  activeBlockingEdges: ActiveBlockingEdge[]; guidanceItems: GuidanceItem[];
  packageById: Map<string, WorkPackageCard>;
  focusSelected: boolean;
  index: number;
  onSetOpen: (open: boolean) => void;
  onSelectAttention: AttentionSelect;
  onSelectCard: CardDetailSelect;
  primaryBranch?: string;
  frontierMode?: RequestFrontierMode;
  notice?: ReactNode;
  updateAnimations: DashboardUpdateAnimations;
}) {
  const request = detail.work_request;
  const requestTitle = request.title || request.id;
  const requestPath = useMemo(() => [{ id: request.id, label: requestTitle }], [request.id, requestTitle]);
  const slices = useMemo(() => sortWorkRequestPackages(detail.work_packages ?? []), [detail.work_packages]);
  const counts = requestActionableAttentionCounts(detail, packageById, activeBlockingEdges, guidanceItems);
  const branch = visibleRequestBranch(request.base_branch, primaryBranch);
  const requestState = requestBoardState(detail, packageById, counts);
  const tone = requestState.tone;
  const [showAllWork, setShowAllWork] = useState(false);
  const selectWorkPackage = (id: string) => {
    const slice = slices.find((item) => item.id === id);
    const pkg = packageById.get(slice?.work_package_id || id);
    if (slice) onSelectCard({ kind: "slice", detail, slice, pkg });
    else if (pkg) onSelectCard({ kind: "package", detail, pkg });
  };
  const frontier = requestFrontier(detail, slices, packageById, activeBlockingEdges, guidanceItems, frontierMode ?? requestFrontierMode(requestState.kind), requestState.label, showAllWork);
  const rowStyle = { "--v3-row-badge-width": statusBadgeWidthForLabels([requestState.label]), animationDelay: `${index * 30}ms` } as CSSProperties;
  const toggleLabel = `${focusSelected ? "Close" : "View"} ${requestTitle}`;
  return (
    <section
        className="v3-request-row stagger-item"
        data-expanded="false"
        data-focus-selected={String(focusSelected)}
        data-request-id={request.id}
        data-v3-context-path={contextPathValue(requestPath)}
        data-tone={tone}
        style={rowStyle}
        {...updateMotionAttributes(updateAnimations.motionFor(requestUpdateKey(detail)))}
      >
        <div className="v3-request-header v3-entity-row" data-tone={tone}>
          <div className="v3-request-controls">
            <button type="button" className="v3-request-chevron-button" aria-pressed={focusSelected} aria-label={toggleLabel} onClick={() => onSetOpen(!focusSelected)}><ChevronRight className="size-4 transition-transform duration-200" /></button>
            <RequestInfoButton detail={detail} onSelectCard={onSelectCard} />
            <RequestIdentityCopyButton detail={detail} />
          </div>
          <div className="v3-request-heading">
            <RequestAttentionBadge
              activeBlockingEdges={activeBlockingEdges}
              detail={detail}
              guidanceItems={guidanceItems}
              label={requestState.label}
              onSelectAttention={onSelectAttention}
              packageById={packageById}
              state={requestState}
            />
            <button type="button" className="v3-request-main" aria-pressed={focusSelected} onClick={() => onSetOpen(!focusSelected)}>
              <RequestIdentity detail={detail} branch={branch} updated={requestUpdatedLabel(detail, packageById, now)} />
            </button>
          </div>
          {notice}
          <RequestFrontier summary={frontier} onSelectWorkPackage={selectWorkPackage} onToggleAll={() => setShowAllWork((value) => !value)} showAll={showAllWork} />
        </div>
    </section>
  );
}
function RequestIdentity({ detail, branch, updated }: { detail: WorkRequestDetail; branch?: string; updated?: string }) {
  const request = detail.work_request;
  return (
    <span className="v3-request-title-group">
      <span className="v3-request-title">{request.title || request.id}</span>
      <span className="v3-request-meta">
        <GitBranch className="size-3.5" />
        <span>{request.repo_display || request.repo || "repo"}</span>
        {branch ? <span className="v3-request-branch">{branch}</span> : null}
        {updated ? <span className="v3-request-updated">{updated}</span> : null}
      </span>
    </span>
  );
}
type RequestFrontierItem = { activity?: string; id: string; pr?: WorkRequestPackage["pr_signal"]; slice: WorkRequestPackage; signal?: WorkRequestPackage["activity_signal"]; title: string };
type RequestFrontierGroup = { id: string; items: RequestFrontierItem[]; title?: string };
type RequestFrontierSummary = { groups: RequestFrontierGroup[]; hiddenCount: number; moreLabel?: string };
const FRONTIER_VISIBLE_LIMIT = 2;
function RequestFrontier({ summary, onSelectWorkPackage, onToggleAll, showAll }: { summary: RequestFrontierSummary | null; onSelectWorkPackage: (id: string) => void; onToggleAll: () => void; showAll: boolean }) {
  if (!summary) return <div className="v3-request-frontier" />;
  return (
    <div className="v3-request-frontier" data-only-ungrouped={summary.groups.every((group) => !group.title) ? "true" : undefined}>
      <div className="v3-request-frontier-content">
      {summary.groups.map((group) => (
        <div className="v3-request-frontier-group" data-grouped={group.title ? "true" : "false"} role={group.title ? "group" : undefined} aria-label={group.title} key={group.id}>
          {group.title ? (
            <span className="v3-request-frontier-group-title" title={group.title}>
              <span className="v3-request-frontier-group-title-label">{group.title}</span>
            </span>
          ) : null}
          <ul className="v3-request-frontier-packages" data-frontier-wire-trunk={group.title ? "true" : undefined}>
            {group.items.map((item, index) => (
              <li className="v3-request-frontier-package" data-last={group.title && index === group.items.length - 1 ? "true" : undefined} key={item.id}>
                {group.title ? <span className="v3-request-frontier-wire" data-frontier-wire="true" aria-hidden="true" /> : null}
                <button type="button" className="v3-request-frontier-package-action" aria-label={`Open WorkPackage details for ${item.title}`} onClick={() => onSelectWorkPackage(item.id)} />
                <span className="v3-request-frontier-title" title={item.title}><span className="v3-request-frontier-title-copy">{item.title}</span></span>
                <span className="v3-request-frontier-meta">
                  <PullRequestBadge signal={item.pr} layout="frontier" />
                  {item.activity && !item.signal ? <span className="v3-request-frontier-activity" data-frontier-measure="state" title={item.activity}>{item.activity}</span> : null}
                </span>
                {item.signal ? <span className="v3-request-frontier-fields"><WorkActivityFields activity={item.signal} review={item.slice.review_signal} eligibility={item.slice.merge_eligibility} /></span> : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {summary.hiddenCount || showAll ? <button type="button" className="v3-request-frontier-more" aria-expanded={showAll} onClick={onToggleAll}>{showAll ? "Show less" : summary.moreLabel}</button> : null}
      </div>
    </div>
  );
}
function requestFrontier(
  detail: WorkRequestDetail,
  slices: WorkRequestPackage[],
  packageById: Map<string, WorkPackageCard>,
  activeBlockingEdges: ActiveBlockingEdge[],
  guidanceItems: GuidanceItem[],
  mode: RequestFrontierMode,
  overallLabel: string,
  showAll = false,
): RequestFrontierSummary | null {
  const matches = slices.filter((slice) => frontierSliceMatches(mode, detail, slice, packageById.get(slice.work_package_id || slice.id), activeBlockingEdges, guidanceItems));
  const parallel = mode === "recent" ? [] : slices.filter((slice) => !matches.includes(slice) && !sliceIsFinished(slice, packageById.get(slice.work_package_id || slice.id)));
  const relevant = [...matches, ...parallel];
  if (!relevant.length) return null;
  const visible = showAll ? relevant : relevant.slice(0, FRONTIER_VISIBLE_LIMIT);
  const groups = frontierGroups(detail, visible, packageById, overallLabel);
  const hiddenCount = relevant.length - visible.length;
  return { groups, hiddenCount, moreLabel: hiddenCount ? `Show all current work (${relevant.length})` : undefined };
}

function frontierGroups(
  detail: WorkRequestDetail,
  slices: WorkRequestPackage[],
  packageById: Map<string, WorkPackageCard>,
  overallLabel: string,
) {
  const groups = new Map<string, RequestFrontierGroup>();
  for (const slice of slices) {
    const identity = frontierGroupIdentity(detail, slice);
    let entry = groups.get(identity.id);
    if (!entry) {
      entry = { ...identity, items: [] };
      groups.set(identity.id, entry);
    }
    entry.items.push(frontierItem(slice, packageById, overallLabel));
  }
  return [...groups.values()];
}

function frontierGroupIdentity(detail: WorkRequestDetail, slice: WorkRequestPackage) {
  const group = workPackageOwnerNode(detail, slice);
  return { id: group?.id ?? "ungrouped", title: group?.title?.trim() || undefined };
}

function frontierItem(slice: WorkRequestPackage, packageById: Map<string, WorkPackageCard>, overallLabel: string): RequestFrontierItem {
  const pkg = packageById.get(slice.work_package_id || slice.id);
  const signal = sliceIsFinished(slice, pkg) ? undefined : slice.activity_signal ?? slice.operational_state?.activity_signal ?? pkg?.operational_state?.activity_signal ?? undefined;
  return {
    activity: frontierActivity(slice, pkg, overallLabel),
    id: slice.id,
    pr: slice.pr_signal ?? undefined,
    signal,
    slice,
    title: slice.title?.trim() || slice.id,
  };
}

function workPackageOwnerNode(detail: WorkRequestDetail, slice: WorkRequestPackage) {
  const nodes = detail.product_tree?.nodes ?? [];
  return slice.product_tree_node_id
    ? nodes.find((node) => node.id === slice.product_tree_node_id)
    : nodes.find((node) => node.work_package_ids?.some((id) => id === slice.id || id === slice.work_package_id));
}

function requestFrontierMode(kind: BoardRowStateKind): RequestFrontierMode {
  if (kind === "active") return "active";
  if (kind === "blocked" || kind === "guidance") return "attention";
  if (kind === "done") return "recent";
  if (["not_started", "planned", "ready"].includes(kind)) return "next";
  return "waiting";
}

function frontierSliceMatches(mode: RequestFrontierMode, detail: WorkRequestDetail, slice: WorkRequestPackage, pkg: WorkPackageCard | undefined, activeBlockingEdges: ActiveBlockingEdge[], guidanceItems: GuidanceItem[]) {
  if (mode === "attention") return sliceNeedsAttention(detail, slice, pkg, activeBlockingEdges, guidanceItems);
  if (mode === "active") return sliceIsRunning(slice, pkg);
  if (mode === "recent") return sliceIsFinished(slice, pkg);
  if (mode === "waiting") return sliceIsWaiting(slice, pkg);
  return !sliceIsFinished(slice, pkg) && !sliceIsRunning(slice, pkg) && !sliceNeedsAttention(detail, slice, pkg, activeBlockingEdges, guidanceItems) && !sliceIsWaiting(slice, pkg);
}

function sliceNeedsAttention(detail: WorkRequestDetail, slice: WorkRequestPackage, pkg: WorkPackageCard | undefined, activeBlockingEdges: ActiveBlockingEdge[], guidanceItems: GuidanceItem[]) {
  return Boolean(workPackageDirectAttention(detail, slice, pkg, activeBlockingEdges, guidanceItems));
}

function sliceIsWaiting(slice: WorkRequestPackage, pkg?: WorkPackageCard) {
  if (sliceHasUnsatisfiedDependencies(slice) || slice.review_signal?.status === "failed" || slice.pr_signal?.checks?.status === "failing") return true;
  const status = sliceStatus(slice, pkg).toLowerCase();
  return /blocked|deferred|paused|pending|queued|waiting/.test(status);
}

function sliceHasUnsatisfiedDependencies(slice: WorkRequestPackage) {
  const dependency = slice.dependency_signal;
  return Boolean(dependency && (dependency.required > dependency.satisfied || dependency.blocked > 0));
}

function frontierActivity(slice: WorkRequestPackage, pkg: WorkPackageCard | undefined, overallLabel: string) {
  const review = slice.review_signal;
  const checks = slice.pr_signal?.checks;
  const status = sliceStatus(slice, pkg);
  const activity = frontierFailureActivity(review, checks)
    ?? frontierCurrentActivity(slice, review, checks, status)
    ?? frontierWaitingActivity(slice)
    ?? frontierCompletionActivity(slice, review, checks)
    ?? operationalLabel(sliceOperationalState(slice, pkg), status, slice.merge_eligibility);
  return activity.trim().toLowerCase() === overallLabel.trim().toLowerCase() ? undefined : activity;
}

function frontierFailureActivity(review: WorkRequestPackage["review_signal"], checks: NonNullable<WorkRequestPackage["pr_signal"]>["checks"]) {
  if (review?.status === "failed") return `Review${signalProgress(review.current, review.total)} failed`;
  if (checks?.status === "failing") return `CI${signalProgress(checks.current, checks.total)} failed`;
  return undefined;
}

function frontierCurrentActivity(
  slice: WorkRequestPackage,
  review: WorkRequestPackage["review_signal"],
  checks: NonNullable<WorkRequestPackage["pr_signal"]>["checks"],
  status: string,
) {
  if (review?.status === "in_progress") return `Review${signalProgress(review.current, review.total)}`;
  if (checks?.status === "pending") return `CI${signalProgress(checks.current, checks.total)}`;
  if (["merge_ready", "ready_for_merge"].includes(status)) return qualifiedStateLabel(slice.merge_eligibility);
  if (slice.worker_signal?.status === "active") return "Implementing";
  return undefined;
}

function frontierWaitingActivity(slice: WorkRequestPackage) {
  if (sliceHasUnsatisfiedDependencies(slice)) {
    const dependency = slice.dependency_signal!;
    return `Waiting ${dependency.satisfied}/${dependency.required}`;
  }
  return undefined;
}

function frontierCompletionActivity(
  slice: WorkRequestPackage,
  review: WorkRequestPackage["review_signal"],
  checks: NonNullable<WorkRequestPackage["pr_signal"]>["checks"],
) {
  if (slice.pr_signal?.status === "merged") return "Merged";
  if (review?.status === "passed") return "Review passed";
  if (checks?.status === "passing") return "CI passed";
  return undefined;
}

function sliceStatus(slice: WorkRequestPackage, pkg?: WorkPackageCard) {
  return sliceOperationalState(slice, pkg)?.key || slice.work_package_status || pkg?.operational_state?.key || pkg?.status || slice.status || "planned";
}

function signalProgress(current?: number | null, total?: number | null) {
  return current == null || total == null ? "" : ` ${current}/${total}`;
}

function sliceIsRunning(slice: WorkRequestPackage, pkg?: WorkPackageCard) {
  if (sliceIsFinished(slice, pkg)) return false;
  const status = sliceStatus(slice, pkg);
  return operationalStatusIsRunning(sliceOperationalState(slice, pkg), status)
    || slice.worker_signal?.status === "active"
    || slice.review_signal?.status === "in_progress"
    || slice.pr_signal?.checks?.status === "pending";
}

function sliceIsFinished(slice: WorkRequestPackage, pkg?: WorkPackageCard) {
  const operational = sliceOperationalState(slice, pkg);
  const status = operational?.key || slice.work_package_status || pkg?.operational_state?.key || pkg?.status || slice.status || slice.delivery?.outcome;
  return isFinishedBoardStatus(status);
}

export function requestHasWork(detail: WorkRequestDetail) {
  return Boolean(detail.product_tree?.nodes?.length || detail.work_packages?.length);
}

export function EmptyWorkRequest({ workRequestId }: { workRequestId: string }) {
  const prompt = architectStartPrompt(workRequestId);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-3">
      <p className="text-sm text-muted-foreground">No work has been created yet. Copy a prompt to start this WorkRequest with an architect agent.</p>
      <Button type="button" variant="outline" size="sm" onClick={() => void copyTextToClipboard(prompt)}>
        <Copy className="size-4" />
        <span>Copy</span>
      </Button>
    </div>
  );
}


