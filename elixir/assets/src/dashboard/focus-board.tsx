import type { ActiveBlockingEdge, GuidanceItem, WorkPackageCard, WorkRequestDetail, WorkRequestPackage } from "@/types/dashboard";
import { Activity, ChevronRight, CircleAlert, Hourglass, Info, PackageCheck, Plus, X, type LucideIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { flushSync } from "react-dom";

import { Button } from "@/components/ui/button";
import { dashboardPrefersReducedMotion } from "@/components/dashboard/motion-utils";
import { cn } from "@/lib/utils";
import { buildFocusBoardItems, requestHasExecutionBoard, requestHumanDecision, type FocusBoardItem, type HumanDecision } from "./focus-board-data";
import { formatDate, readStoredWorkScope, repoDisplayName, repoIdentityKey, writeDashboardUiStateValue } from "./dashboard-persistence";
import type { CardDetailSelect, DashboardUpdateAnimations } from "./runtime";
import { requestActionableAttentionCounts, type AttentionJumpTarget, type AttentionSelect } from "./workstream-attention";
import { EmptyWorkRequest, ProductRequestRow, requestHasWork } from "./workstream-board";
import { sortWorkRequestDetails } from "./workstream-data";
import { statusBadgeWidthForRequestDetails } from "./workstream-row-state";
import { ProductPlanBody } from "./workstream-product-plan";
import { visibleRequestBranch } from "./workstream-utils";

const WorkRequestExecutionGraph = lazy(() => import("./work-request-execution-graph-loading"));
const FOCUS_BOARD_COLUMNS = ["pr", "state"] as const;
const ALL_REPOSITORIES = "";
const FOCUS_GROUPS: ReadonlyArray<{ lane: FocusBoardItem["lane"]; label: string; description: string; icon: LucideIcon }> = [
  { lane: "attention", label: "Needs attention", description: "Human decisions first, then blocked work and who acts next", icon: CircleAlert },
  { lane: "active", label: "In progress", description: "Being implemented, reviewed or checked", icon: Activity },
  { lane: "next", label: "Ready for handoff", description: "Ready for its next actor to pick up", icon: PackageCheck },
  { lane: "waiting", label: "Waiting", description: "Waiting on prerequisites, clarification or recovery", icon: Hourglass },
];
const WORKBENCH_MODES = [
  ["tree", "Work tree"],
  ["frontier", "Frontier"],
  ["full", "Full map"],
] as const;

type WorkbenchMode = (typeof WORKBENCH_MODES)[number][0];
type FocusBoardTransition = "close" | "open" | "swap";
export type FocusRepositoryOption = { key: string; label: string };
let activeFocusBoardTransition: ViewTransition | null = null;

export function FocusBoardLoading() {
  return (
    <section className="focus-board rounded-lg border bg-card text-card-foreground shadow-sm" aria-busy="true" aria-labelledby="focus-board-loading-title">
      <FocusBoardHeader id="focus-board-loading-title" />
    </section>
  );
}

export function FocusBoardFirstRun({ onStartRequest }: { onStartRequest: () => void }) {
  return (
    <section className="focus-board rounded-lg border bg-card text-card-foreground shadow-sm" aria-labelledby="focus-board-first-run-title">
      <FocusBoardHeader id="focus-board-first-run-title" openCount={0} />
      <div className="focus-board__first-run">
        <h3>Start with a request</h3>
        <p>Describe the outcome you want. Choose Direct delivery for small, clear work or Architect-led for larger features; agents pick it up through Symphony++ and it appears here.</p>
        <Button type="button" onClick={onStartRequest}><Plus className="size-4" />Start a request</Button>
      </div>
    </section>
  );
}

export function FocusBoard({
  details,
  now,
  packages,
  activeBlockingEdges,
  guidanceItems = [],
  jumpTarget,
  onSelectAttention,
  onSelectGuidance,
  onSelectCard,
  primaryBranchByRepo,
  repositories = [],
  staleSince,
  updateAnimations,
}: {
  details: WorkRequestDetail[];
  now?: string;
  packages: WorkPackageCard[];
  activeBlockingEdges: ActiveBlockingEdge[];
  guidanceItems?: GuidanceItem[];
  jumpTarget?: AttentionJumpTarget | null;
  onSelectAttention: AttentionSelect;
  onSelectGuidance: (item: GuidanceItem) => void;
  onSelectCard: CardDetailSelect;
  primaryBranchByRepo: Map<string, string | undefined>;
  repositories?: FocusRepositoryOption[];
  staleSince?: string | null;
  updateAnimations: DashboardUpdateAnimations;
}) {
  const [scope, changeScope] = useWorkScope(details, repositories, jumpTarget);
  const scopedDetails = useMemo(() => scope ? details.filter((detail) => repoIdentityKey(detail.work_request) === scope) : details, [details, scope]);
  const packageById = useMemo(() => new Map(packages.map((pkg) => [pkg.id, pkg])), [packages]);
  const { decisions, items } = useFocusItems(scopedDetails, now, packageById, activeBlockingEdges, guidanceItems);
  const openItems = items.filter((item) => item.lane !== "recent");
  const recentItems = items.filter((item) => item.lane === "recent");
  const boardRef = useRef<HTMLElement | null>(null);
  const handledJumpTokenRef = useRef(0);
  const itemIndexById = useMemo(() => new Map(items.map((item, index) => [item.id, index])), [items]);
  const { closeWorkbench, jumpToView, mode, renderedItem, selectedItem, setMode, updateView, workbenchVisible } = useWorkbenchSelection(items, openItems, boardRef);

  useFocusBoardColumnWidths(boardRef, items);
  useAttentionJump(boardRef, items, jumpTarget, selectedItem, mode, handledJumpTokenRef, jumpToView);

  const selectItem = (item: FocusBoardItem, open: boolean) => updateView(open ? item.id : null, mode);
  const renderItem = (item: FocusBoardItem) => (
    <ProductRequestRow
      key={item.id}
      detail={item.detail}
      now={now}
      activeBlockingEdges={activeBlockingEdges}
      guidanceItems={guidanceItems}
      packageById={packageById}
      focusSelected={selectedItem?.id === item.id}
      index={itemIndexById.get(item.id) ?? 0}
      onSetOpen={(open) => selectItem(item, open)}
      onSelectAttention={onSelectAttention}
      onSelectCard={onSelectCard}
      primaryBranch={primaryBranchByRepo.get(repoIdentityKey(item.detail.work_request))}
      frontierMode={item.lane}
      notice={<HumanDecisionNotice decision={decisions.get(item.id)} onAnswer={onSelectGuidance} />}
      updateAnimations={updateAnimations}
    />
  );
  const previewItem = focusCardPreviewQuery()
    ? items.find((item) => (item.detail.work_request.title || item.id).toLowerCase().includes(focusCardPreviewQuery()!))
    : undefined;

  if (previewItem) {
    return <section ref={boardRef} className="focus-card-preview" aria-label="WorkRequest card preview"><div className="workstream-board-shell"><div className="v3-workstream-board">{renderItem(previewItem)}</div></div></section>;
  }

  const scopeLabel = repositories.find((repo) => repo.key === scope)?.label;
  return (
    <section
      ref={boardRef}
      className="focus-board rounded-lg border bg-card text-card-foreground shadow-sm"
      aria-labelledby="focus-board-title"
      data-focus-request-id={selectedItem?.id}
    >
      <FocusBoardHeader id="focus-board-title" openCount={openItems.length} scopeLabel={scopeLabel}>
        {repositories.length > 1 ? <RepositoryScope repositories={repositories} value={scope} onChange={changeScope} /> : null}
      </FocusBoardHeader>
      {staleSince !== undefined ? (
        <p className="focus-board__stale" role="status">Connection interrupted. Showing the last facts received{staleSince ? ` at ${formatDate(staleSince)}` : ""}; they may be out of date.</p>
      ) : null}
      <div className="focus-board__groups">
        {FOCUS_GROUPS.map((group) => <FocusGroup key={group.lane} {...group} items={openItems.filter((item) => item.lane === group.lane)} renderItem={renderItem} />)}
      </div>
      <div className="focus-board__workbench-reveal v3-disclosure-reveal" data-open={workbenchVisible ? "true" : "false"} aria-hidden={!workbenchVisible} inert={!workbenchVisible}>
        <FocusWorkbench
          activeBlockingEdges={activeBlockingEdges}
          guidanceItems={guidanceItems}
          item={renderedItem}
          mode={mode}
          now={now}
          onClose={closeWorkbench}
          onModeChange={setMode}
          onSelectAttention={onSelectAttention}
          onSelectCard={onSelectCard}
          packageById={packageById}
          primaryBranch={renderedItem ? primaryBranchByRepo.get(repoIdentityKey(renderedItem.detail.work_request)) : undefined}
          updateAnimations={updateAnimations}
        />
      </div>
      <RecentDeliveries items={recentItems} renderItem={renderItem} />
    </section>
  );
}

function FocusBoardHeader({ id, openCount, scopeLabel, children }: { id: string; openCount?: number; scopeLabel?: string; children?: React.ReactNode }) {
  const summary = openCount === undefined ? "Loading latest activity…" : `${openCount} open ${scopeLabel ? `in ${scopeLabel}` : "across repositories"}`;
  return (
    <header className="focus-board__header">
      <div><h2 id={id}>Work</h2><span>{summary}</span></div>
      {children}
    </header>
  );
}

function RepositoryScope({ repositories, value, onChange }: { repositories: FocusRepositoryOption[]; value: string; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <div className="focus-board__scope">
      <label htmlFor={id}>Repository</label>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value={ALL_REPOSITORIES}>All repositories</option>
        {repositories.map((repo) => <option key={repo.key} value={repo.key}>{repo.label}</option>)}
      </select>
    </div>
  );
}

function FocusGroup({ label, description, icon: Icon, items, lane, renderItem }: { label: string; description: string; icon: LucideIcon; items: FocusBoardItem[]; lane: string; renderItem: (item: FocusBoardItem) => React.ReactNode }) {
  const headingId = useId();
  return (
    <section className="focus-board__group" data-lane={lane} aria-labelledby={headingId}>
      <header className="focus-board__group-header">
        <h3 id={headingId}><Icon className="size-4" aria-hidden="true" />{label}<span className="focus-board__count">{items.length}</span></h3>
        <p>{description}</p>
      </header>
      {items.length ? <div className="focus-board__cards workstream-board-shell"><div className="v3-workstream-board">{items.map(renderItem)}</div></div> : <p className="focus-board__clear">Nothing here right now.</p>}
    </section>
  );
}

function RecentDeliveries({ items, renderItem }: { items: FocusBoardItem[]; renderItem: (item: FocusBoardItem) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  if (!items.length) return null;
  return (
    <section className="focus-board__recent" aria-label="Recently delivered">
      <button type="button" className="focus-board__recent-toggle" aria-expanded={open} aria-controls={contentId} onClick={() => setOpen((value) => !value)}>
        <ChevronRight className={cn("size-4 transition-transform duration-200", open && "rotate-90")} aria-hidden="true" />
        Recently delivered<span className="focus-board__count">{items.length}</span>
      </button>
      <div id={contentId} className="v3-disclosure-reveal" data-open={open ? "true" : "false"} aria-hidden={!open} inert={!open}>
        <div className="focus-board__cards workstream-board-shell"><div className="v3-workstream-board">{items.map(renderItem)}</div></div>
      </div>
    </section>
  );
}

function HumanDecisionNotice({ decision, onAnswer }: { decision?: HumanDecision | null; onAnswer: (item: GuidanceItem) => void }) {
  if (!decision) return null;
  return (
    <p className="focus-board__decision" data-human="true">
      <strong>Human decision</strong>
      <span>{decision.text}</span>
      {decision.guidance ? <Button type="button" size="sm" variant="outline" onClick={() => onAnswer(decision.guidance!)}>Answer decision</Button> : null}
    </p>
  );
}

function FocusWorkbench({ activeBlockingEdges, guidanceItems, item, mode, now, onClose, onModeChange, onSelectAttention, onSelectCard, packageById, primaryBranch, updateAnimations }: {
  activeBlockingEdges: ActiveBlockingEdge[];
  guidanceItems: GuidanceItem[];
  item?: FocusBoardItem;
  mode: WorkbenchMode;
  now?: string;
  onClose: () => void;
  onModeChange: (mode: WorkbenchMode) => void;
  onSelectAttention: AttentionSelect;
  onSelectCard: CardDetailSelect;
  packageById: Map<string, WorkPackageCard>;
  primaryBranch?: string;
  updateAnimations: DashboardUpdateAnimations;
}) {
  if (!item) return <div className="focus-board__workbench focus-board__workbench--empty">No open WorkRequests.</div>;
  const detail = item.detail;
  const request = detail.work_request;
  const title = request.title || request.id;
  const hasGraph = requestHasExecutionBoard(detail);
  const viewMode = hasGraph ? mode : "tree";
  const requestPath = [{ id: request.id, label: title }];
  const branch = visibleRequestBranch(request.base_branch, primaryBranch);
  return (
    <section className="focus-board__workbench" aria-labelledby="focus-workbench-title" data-mode={viewMode} style={{ "--v3-row-badge-width": statusBadgeWidthForRequestDetails([detail], packageById) } as CSSProperties}>
      <header className="focus-board__workbench-header">
        <div><h3 id="focus-workbench-title">{title}</h3><p>{[repoDisplayName(request), branch].filter(Boolean).join(" · ")}</p></div>
        <div className="focus-board__workbench-controls">
          <div className="focus-board__mode-switch" role="group" aria-label="Work view">
            {WORKBENCH_MODES.map(([value, label]) => (
              <button key={value} type="button" aria-pressed={viewMode === value} disabled={value !== "tree" && !hasGraph} onClick={() => onModeChange(value)}>{label}</button>
            ))}
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => onSelectCard({ kind: "request", detail })}><Info className="size-4" />Decisions &amp; details</Button>
          <Button type="button" variant="ghost" size="icon" aria-label={`Close ${title}`} onClick={onClose}><X className="size-4" /></Button>
        </div>
      </header>
      <ReplacedWork detail={detail} packageById={packageById} onSelectCard={onSelectCard} />
      <div className="focus-board__workbench-body">
        {!requestHasWork(detail) ? <EmptyWorkRequest workRequestId={request.id} /> : viewMode === "tree" ? (
          <ProductPlanBody activeBlockingEdges={activeBlockingEdges} detail={detail} guidanceItems={guidanceItems} packageById={packageById} onSelectAttention={onSelectAttention} onSelectCard={onSelectCard} requestPath={requestPath} slices={detail.work_packages ?? []} updateAnimations={updateAnimations} />
        ) : (
          <div className="v3-execution-graph">
            <Suspense fallback={<div className="v3-execution-graph-loading" role="status" aria-label="Loading execution graph" />}>
              <WorkRequestExecutionGraph key={request.id} activeBlockingEdges={activeBlockingEdges} detail={detail} frontierVariant="horizon-1" guidanceItems={guidanceItems} now={now} packageById={packageById} onSelectAttention={onSelectAttention} onSelectCard={onSelectCard} requestPath={requestPath} viewMode={viewMode} />
            </Suspense>
          </div>
        )}
      </div>
    </section>
  );
}

function ReplacedWork({ detail, packageById, onSelectCard }: { detail: WorkRequestDetail; packageById: Map<string, WorkPackageCard>; onSelectCard: CardDetailSelect }) {
  const slices = detail.work_packages ?? [];
  const replaced = slices.filter((slice) => (slice.delivery?.outcome || slice.operational_state?.delivery_outcome) === "superseded");
  if (!replaced.length) return null;
  return (
    <section className="focus-board__replaced" aria-label="Replaced work">
      <h4>Replaced work</h4>
      <ul>
        {replaced.map((slice) => {
          const successorTitle = replacementTitle(slice, slices);
          return (
            <li key={slice.id}>
              <button type="button" onClick={() => onSelectCard({ kind: "slice", detail, slice, pkg: packageById.get(slice.work_package_id || slice.id) })}>{slice.title || slice.id}</button>
              <span>replaced by {successorTitle}{slice.delivery?.superseded_reason ? ` · ${slice.delivery.superseded_reason}` : ""}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function useWorkScope(details: WorkRequestDetail[], repositories: FocusRepositoryOption[], jumpTarget?: AttentionJumpTarget | null) {
  const [storedScope, setStoredScope] = useState(() => readStoredWorkScope() ?? ALL_REPOSITORIES);
  const [scopeChosenAtJump, setScopeChosenAtJump] = useState(0);
  const jumpRequest = jumpTarget && jumpTarget.token > scopeChosenAtJump ? details.find((detail) => detail.work_request.id === jumpTarget.requestId) : undefined;
  const jumpLeavesScope = Boolean(jumpRequest && repoIdentityKey(jumpRequest.work_request) !== storedScope);
  const scope = !jumpLeavesScope && repositories.some((repo) => repo.key === storedScope) ? storedScope : ALL_REPOSITORIES;
  const changeScope = (nextScope: string) => {
    setStoredScope(nextScope);
    setScopeChosenAtJump(jumpTarget?.token ?? 0);
    writeDashboardUiStateValue("workScope", nextScope || null);
  };
  return [scope, changeScope] as const;
}

function useFocusItems(details: WorkRequestDetail[], now: string | undefined, packageById: Map<string, WorkPackageCard>, activeBlockingEdges: ActiveBlockingEdge[], guidanceItems: GuidanceItem[]) {
  const decisions = useMemo(() => new Map(details.map((detail) => [detail.work_request.id, requestHumanDecision(detail, guidanceItems)])), [details, guidanceItems]);
  const items = useMemo(() => {
    const attentionCounts = new Map(details.map((detail) => [detail.work_request.id, requestActionableAttentionCounts(detail, packageById, activeBlockingEdges, guidanceItems)]));
    const needsAnswer = (item: FocusBoardItem) => Number(item.lane === "attention" && !decisions.get(item.id));
    return buildFocusBoardItems(sortWorkRequestDetails(details), now, packageById, attentionCounts).toSorted((left, right) => needsAnswer(left) - needsAnswer(right));
  }, [activeBlockingEdges, decisions, details, guidanceItems, now, packageById]);
  return { decisions, items };
}

function useWorkbenchSelection(items: FocusBoardItem[], openItems: FocusBoardItem[], boardRef: React.RefObject<HTMLElement | null>) {
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>();
  const [renderedRequestId, setRenderedRequestId] = useState<string>();
  const [workbenchOpen, setWorkbenchOpen] = useState(true);
  const [mode, setMode] = useState<WorkbenchMode>("tree");
  const defaultItem = openItems.find((item) => requestHasExecutionBoard(item.detail)) ?? openItems[0];
  const selection = focusBoardSelection(items, defaultItem, selectedRequestId, renderedRequestId, workbenchOpen);
  const updateView = (requestId: string | null, nextMode: WorkbenchMode) => {
    const transition = requestId === null ? "close" : selectedRequestId === null ? "open" : "swap";
    animateFocusBoardUpdate(transition, () => setSelectedRequestId(requestId), () => {
      if (requestId) setRenderedRequestId(requestId);
      setWorkbenchOpen(requestId !== null);
      setMode(nextMode);
    });
    if (requestId) revealWorkbench(boardRef.current);
  };
  const jumpToView = (requestId: string, nextMode: WorkbenchMode) => {
    setSelectedRequestId(requestId);
    setRenderedRequestId(requestId);
    setWorkbenchOpen(true);
    setMode(nextMode);
  };
  const closeWorkbench = () => {
    const requestId = selection.selectedItem?.id;
    updateView(null, mode);
    if (requestId) requestMainButton(boardRef.current, requestId)?.focus();
  };
  return { ...selection, closeWorkbench, jumpToView, mode, setMode, updateView };
}

function replacementTitle(slice: WorkRequestPackage, slices: WorkRequestPackage[]) {
  const successorId = slice.successor?.work_package_id || slice.delivery?.successor_work_package_id;
  const successor = successorId ? slices.find((item) => item.id === successorId || item.work_package_id === successorId) : undefined;
  return successor?.title || slice.successor?.work_package?.title || successorId || "a successor not recorded";
}

function useFocusBoardColumnWidths(boardRef: React.RefObject<HTMLElement | null>, items: FocusBoardItem[]) {
  useLayoutEffect(() => {
    const root = boardRef.current;
    if (!root) return;
    let frame: number | null = null;
    const measure = () => {
      for (const column of FOCUS_BOARD_COLUMNS) {
        const elements = [...root.querySelectorAll<HTMLElement>(`[data-frontier-measure="${column}"]`)].filter((element) => element.getClientRects().length > 0);
        const width = elements.reduce((maximum, element) => Math.max(maximum, element.scrollWidth), 0);
        root.style.setProperty(`--focus-frontier-${column}-width`, `${Math.ceil(width)}px`);
      }
    };
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    measure();
    observer?.observe(root);
    return () => { observer?.disconnect(); if (frame !== null) cancelAnimationFrame(frame); };
  }, [boardRef, items]);
}

function useAttentionJump(
  boardRef: React.RefObject<HTMLElement | null>,
  items: FocusBoardItem[],
  jumpTarget: AttentionJumpTarget | null | undefined,
  selectedItem: FocusBoardItem | undefined,
  mode: WorkbenchMode,
  handledToken: React.MutableRefObject<number>,
  updateView: (id: string, mode: WorkbenchMode) => void,
) {
  useEffect(() => {
    if (!jumpTarget || handledToken.current >= jumpTarget.token || !items.some((item) => item.id === jumpTarget.requestId)) return;
    updateView(jumpTarget.requestId, "full");
  }, [handledToken, items, jumpTarget, updateView]);
  useEffect(() => {
    if (!jumpTarget || handledToken.current >= jumpTarget.token || selectedItem?.id !== jumpTarget.requestId || mode !== "full") return;
    const root = boardRef.current;
    if (!root) return;
    const reveal = () => {
      let target: HTMLElement | null = root.querySelector(".focus-board__workbench");
      const viewport = visibleGraphViewport(root);
      if ((jumpTarget.groupIds.length || jumpTarget.workPackageId) && !viewport) return;
      for (const groupId of jumpTarget.groupIds) {
        const group = elementWithData(viewport!, "groupId", groupId);
        if (!group) return;
        const toggle = group.querySelector<HTMLButtonElement>(":scope > .execution-graph__group-header");
        if (toggle?.getAttribute("aria-expanded") === "false") { toggle.click(); return; }
        target = group;
      }
      if (jumpTarget.workPackageId) {
        const workPackage = elementWithData(viewport!, "workPackageId", jumpTarget.workPackageId);
        if (!workPackage) return;
        target = workPackage;
      }
      if (!target) return;
      handledToken.current = jumpTarget.token;
      target.dataset.attentionJump = "true";
      target.scrollIntoView({ block: "center", inline: "center", behavior: dashboardPrefersReducedMotion() ? "auto" : "smooth" });
      window.setTimeout(() => delete target!.dataset.attentionJump, 1_800);
      observer.disconnect();
    };
    const observer = new MutationObserver(reveal);
    observer.observe(root, { attributes: true, childList: true, subtree: true });
    const frame = requestAnimationFrame(reveal);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [boardRef, handledToken, jumpTarget, mode, selectedItem]);
}

function animateFocusBoardUpdate(kind: FocusBoardTransition, prepare: () => void, update: () => void) {
  if (typeof document === "undefined" || dashboardPrefersReducedMotion() || !document.startViewTransition) {
    flushSync(() => { prepare(); update(); });
    return;
  }
  flushSync(prepare);
  document.documentElement.dataset.focusBoardTransition = kind;
  const transition = document.startViewTransition(() => flushSync(update));
  activeFocusBoardTransition = transition;
  void transition.finished.finally(() => {
    if (activeFocusBoardTransition !== transition) return;
    delete document.documentElement.dataset.focusBoardTransition;
    activeFocusBoardTransition = null;
  });
}

function revealWorkbench(root: HTMLElement | null) {
  const header = root?.querySelector<HTMLElement>(".focus-board__workbench-header");
  if (!header || typeof window === "undefined") return;
  const bounds = header.getBoundingClientRect();
  if (bounds.top >= 0 && bounds.bottom <= window.innerHeight) return;
  header.scrollIntoView({ block: "nearest", behavior: dashboardPrefersReducedMotion() ? "auto" : "smooth" });
}

function requestMainButton(root: HTMLElement | null, requestId: string) {
  return [...(root?.querySelectorAll<HTMLElement>(".focus-board__groups .v3-request-row, .focus-board__recent .v3-request-row") ?? [])]
    .find((row) => row.dataset.requestId === requestId)
    ?.querySelector<HTMLButtonElement>(".v3-request-main") ?? null;
}

function focusBoardSelection(items: FocusBoardItem[], defaultItem: FocusBoardItem | undefined, selectedId: string | null | undefined, renderedId: string | undefined, open: boolean) {
  const selectedItem = selectedId === null ? undefined : items.find((item) => item.id === selectedId) ?? defaultItem;
  return {
    renderedItem: items.find((item) => item.id === renderedId) ?? selectedItem ?? defaultItem,
    selectedItem,
    workbenchVisible: Boolean(selectedItem) && open,
  };
}

function visibleGraphViewport(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>(".execution-graph__viewport")].find((viewport) => viewport.getClientRects().length > 0);
}

function elementWithData(root: HTMLElement, key: "groupId" | "workPackageId", value: string) {
  const attribute = key === "groupId" ? "group-id" : "work-package-id";
  return [...root.querySelectorAll<HTMLElement>(`[data-${attribute}]`)].find((element) => element.dataset[key] === value);
}

function focusCardPreviewQuery() {
  return import.meta.env.DEV && typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("focus-card-preview")?.trim().toLowerCase() : undefined;
}
