import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { WorkPackageCard, WorkRequestDetail, WorkRequestPackage } from "@/types/dashboard";

import { FocusBoard, FocusBoardFirstRun } from "./focus-board";
import { buildFocusBoardItems, requestHumanDecision } from "./focus-board-data";

// Actual compact /dashboard/deferred response from the isolated F03 ledger; see fixture _source.
const actualCompactBoard = JSON.parse(readFileSync(new URL("./fixtures/actual-compact-board.json", import.meta.url), "utf8")) as { generated_at: string; work_request_details: WorkRequestDetail[] };

describe("focus board", () => {
  it("assigns each request to one operational category and keeps only recently finished work", () => {
    const items = buildFocusBoardItems([
      request("wr-human", "Needs a decision", [slice("human", "ready_for_clarification")], { openQuestions: 1, status: "clarifying" }),
      request("wr-active", "Shipping", [slice("active", "implementing")]),
      request("wr-clarifying", "Still shaping", [], { status: "clarifying" }),
      request("wr-ready-to-clarify", "Ready to clarify", [slice("clarification-ready", "ready_for_clarification")], { status: "ready_for_clarification" }),
      request("wr-ready-for-slicing", "Ready for slicing", [], { status: "ready_for_slicing" }),
      request("wr-next", "Ready work", [slice("ready", "approved")]),
      request("wr-dependency", "Dependency wait", [slice("already-done", "delivered"), slice("waiting", "blocked", {
        dependency: { satisfied: 2, required: 2, active: 0, blocked: 1, unmet_work_package_ids: ["upstream"], inputs: [] },
      })]),
      request("wr-recent", "Just shipped", [slice("merged", "merged")], { completedAt: "2026-07-21T09:30:00Z" }),
      request("wr-delivery", "Delivery fallback", [slice("delivered", "merged", { recordedAt: "2026-07-21T09:00:00Z" })], { status: "completed" }),
      request("wr-old", "Old news", [slice("old", "merged")], { completedAt: "2026-07-19T10:00:00Z" }),
    ], "2026-07-21T10:00:00Z", new Map(), new Map([
      ["wr-human", { blockerCount: 0, guidanceCount: 1 }],
    ]));

    expect(items.map(({ id, lane }) => [id, lane])).toEqual([
      ["wr-human", "attention"],
      ["wr-active", "active"],
      ["wr-clarifying", "waiting"],
      ["wr-ready-to-clarify", "waiting"],
      ["wr-ready-for-slicing", "waiting"],
      ["wr-next", "next"],
      ["wr-dependency", "waiting"],
      ["wr-recent", "recent"],
      ["wr-delivery", "recent"],
    ]);
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  });

  it("keeps unresolved retired and partially delivered requests visible outside Recent", () => {
    const skipped = request("skipped", "All skipped", [slice("skipped", "skipped")]);
    skipped.work_request.operational_state = { key: "completed", label: "Completed" };
    const cycle = request("cycle", "Successor cycle", [slice("a", "superseded", { recordedAt: "2026-07-21T09:00:00Z" }), slice("b", "superseded")]);
    const partial = request("partial", "Some delivered", [slice("delivered", "merged", { recordedAt: "2026-07-21T09:00:00Z" }), slice("abandoned", "abandoned")]);
    expect(buildFocusBoardItems([skipped, cycle, partial], "2026-07-21T10:00:00Z").map(({ id, lane }) => [id, lane])).toEqual([
      ["skipped", "waiting"], ["cycle", "waiting"], ["partial", "waiting"],
    ]);
  });

  it("uses canonical completion time for mixed skipped and multiple-successor deliveries", () => {
    const delivered = request("completed", "Accepted scope", [
      slice("original", "superseded", { recordedAt: "2026-07-21T09:50:00Z" }),
      slice("successor-a", "completed_no_pr", { recordedAt: "2026-07-21T09:00:00Z" }),
      slice("successor-b", "merged", { recordedAt: "2026-07-21T09:30:00Z" }),
      slice("planned-skip", "skipped"),
    ], { completedAt: "2026-07-21T09:40:00Z" });
    expect(buildFocusBoardItems([delivered], "2026-07-21T10:00:00Z")).toMatchObject([
      { id: "completed", lane: "recent", finishedAt: "2026-07-21T09:40:00Z" },
    ]);
  });

  it("uses package runtime and explicit attention context for request lanes", () => {
    const detail = request("wr-runtime", "Runtime work", [slice("runtime", "planned", { packageId: "wp-runtime" })]);
    const packages = new Map<string, WorkPackageCard>([["wp-runtime", { id: "wp-runtime", status: "active" }]]);
    const dependencyBlocked = request("wr-package-blocker", "Package blocker", [slice("package-blocker", "blocked", {
      dependency: { satisfied: 0, required: 1, active: 0, blocked: 1, unmet_work_package_ids: ["upstream"], inputs: [] },
      packageId: "wp-package-blocker",
    })]);
    const blockedPackages = new Map<string, WorkPackageCard>([["wp-package-blocker", { active_blocker_count: 1, id: "wp-package-blocker", status: "blocked" }]]);

    expect(buildFocusBoardItems([detail], Date.now(), packages)[0]?.lane).toBe("active");
    expect(buildFocusBoardItems([detail], Date.now(), packages, new Map([["wr-runtime", { blockerCount: 1, guidanceCount: 0 }]]))[0]?.lane).toBe("attention");
    expect(buildFocusBoardItems([dependencyBlocked], Date.now(), blockedPackages)[0]?.lane).toBe("waiting");
  });

  it("distinguishes explicit human input from architect or prerequisite work", () => {
    const question = request("wr-question", "Needs a decision", [], { openQuestions: 1 });
    const human = request("wr-human", "Guidance", [slice("human", "reviewing", { activity: { next_actor: "human", waiting_reason: "Pick retry policy", next_action: "answer_guidance" } })]);
    const architect = request("wr-architect", "Architect work", [slice("ui", "ready_for_merge", { activity: { next_actor: "architect", waiting_reason: "dependency_not_delivered", next_action: "deliver_prerequisites" } })]);

    expect(requestHumanDecision(question)).toMatchObject({ text: "Open question", guidance: { source: "clarification" } });
    expect(requestHumanDecision(human)).toEqual({ text: "Pick retry policy" });
    expect(requestHumanDecision(architect)).toBeNull();
  });

  it("shows the package targeted by an active blocker edge under Needs attention", () => {
    const detail = request("wr-edge", "Blocked by edge", [slice("slice-edge", "planned", { packageId: "wp-edge" })]);
    const html = renderBoard([detail], {
      packages: [{ id: "wp-edge", status: "planned" }],
      activeBlockingEdges: [{
        id: "edge-1",
        blocker_id: "blocker-1",
        from: { kind: "work_package", id: "wp-upstream" },
        to: { kind: "work_package", id: "wp-edge" },
        work_request_id: "wr-edge",
        work_package_id: "wp-edge",
      }],
    });

    expect(groupHtml(html, "attention")).toContain('aria-label="Open attention details for Blocked by edge"');
    expect(groupHtml(html, "attention")).toContain('title="slice-edge"');
  });

  it("renders the actual compact response once per open request with labeled per-package activity and collapsed delivery history", () => {
    const html = renderBoard(actualCompactBoard.work_request_details, { now: actualCompactBoard.generated_at });
    const openTitles = ["F03 actual native Opus delivery", "QUALIFICATION — human decision and independent work", "QUALIFICATION — partial replacement work"];

    expect(html).toContain("<h2 id=\"focus-board-title\">Work</h2><span>3 open across repositories</span>");
    for (const title of openTitles) expect(occurrences(html, `<span class="v3-request-title">${title}</span>`)).toBe(1);
    expect(["Needs attention", "In progress", "Ready for handoff", "Waiting"].every((label) => html.includes(label))).toBe(true);
    expect(groupHtml(html, "attention")).toContain("QUALIFICATION — human decision and independent work");
    expect(groupHtml(html, "attention")).toContain("<strong>Human decision</strong><span>Choose the retry behavior for this qualification case.</span>");
    expect(groupHtml(html, "attention")).toContain("Answer decision");
    expect(groupHtml(html, "next")).toContain("QUALIFICATION — partial replacement work");
    const paused = groupHtml(html, "waiting");
    expect(paused).toContain("F03 actual native Opus delivery");
    expect(paused).toContain('<span class="work-activity-field__label">Owner</span><span class="work-activity-field__value">Unknown</span>');
    expect(paused).toContain('<span class="work-activity-field__label">Working now</span><span class="work-activity-field__value">Unknown · runtime stale</span>');
    expect(paused).toContain('<span class="work-activity-field__label">Stage</span><span class="work-activity-field__value">Active · Time unknown</span>');
    expect(paused).toContain('<span class="work-activity-field__label">Waiting on</span><span class="work-activity-field__value">Fresh runtime observation</span>');
    expect(paused).toContain('<span class="work-activity-field__label">Next</span><span class="work-activity-field__value">Inspect runtime</span>');
    expect(html).not.toContain("Ready For Worker · Time unknown");
    expect(html).toContain('aria-expanded="false" aria-controls=');
    expect(html).toContain("Recently delivered<span class=\"focus-board__count\">1</span>");
    expect(html).toContain('data-open="false" aria-hidden="true" inert=""><div class="focus-board__cards workstream-board-shell"><div class="v3-workstream-board"><section class="v3-request-row stagger-item" data-expanded="false" data-focus-selected="false" data-request-id="wr_2fyzkl6jrtdamisv"');
    expect(html).toContain("Replaced work");
    expect(html).not.toContain("Experimental");
    expect(html).not.toContain("Horizon");
  });

  it("never reads qualified compact packages as mergeable unless canonical eligibility says so", () => {
    const actual = actualCompactBoard.work_request_details.find((detail) => detail.work_request.id === "wr_2sjv3grxotyokrat")!;
    const actualSlice = actual.work_packages![0]!;
    const qualified = (id: string, merge_eligibility: WorkRequestPackage["merge_eligibility"]): WorkRequestPackage => ({
      ...actualSlice,
      id,
      work_package_id: id,
      title: `${id} package`,
      status: "ready_for_merge",
      work_package_status: "ready_for_merge",
      operational_state: { ...actualSlice.operational_state, key: "merge_ready", label: "Ready For Merge", raw_status: "ready_for_merge" },
      // Mirrors the backend activity projection: an eligibility reason outranks awaiting integration.
      activity_signal: { ...actualSlice.activity_signal, work_package_id: id, stage: "ready_for_merge", observation_state: "unknown", waiting_reason: merge_eligibility?.reason_codes?.find((code) => code !== "not_ready") ?? "awaiting_integration", next_actor: "architect", next_action: merge_eligibility?.next_action ?? undefined },
      merge_eligibility,
    });
    // Synthetic variants of the actual compact package shape using F02's canonical eligibility outcomes.
    const work_packages = [
      qualified("waiting-ui", { work_package_id: "waiting-ui", eligible: false, reason_codes: ["dependency_not_delivered"], next_action: "deliver_prerequisites" }),
      qualified("stale-ui", { work_package_id: "stale-ui", eligible: false, reason_codes: ["candidate_pin_stale", "dependency_inputs_stale"], next_action: "select_current_candidate_and_requalify_affected_work" }),
      qualified("missing-ui", undefined),
      qualified("eligible-backend", { work_package_id: "eligible-backend", eligible: true, reason_codes: [], next_action: "verify_native_checks_and_review_then_merge" }),
    ];
    const ids = work_packages.map((item) => item.id);
    const detail: WorkRequestDetail = { ...actual, work_packages, product_tree: { ...actual.product_tree, root_work_package_ids: ids, execution_graph: { ...actual.product_tree?.execution_graph, work_package_ids: ids } } };
    const html = renderBoard([detail], { now: actualCompactBoard.generated_at });
    const groups = html.slice(0, html.indexOf("focus-board__workbench-reveal"));
    const tree = html.slice(html.indexOf('class="v3-product-plan"'));
    const row = (id: string) => tree.slice(tree.indexOf(`data-work-package-id="${id}"`)).split("data-work-package-id=")[1];

    expect(groups).toContain("Show all current work (4)");
    for (const item of groups.split("<li").slice(1).filter((markup) => markup.includes("Ready to merge"))) expect(item).toContain("eligible-backend package");
    expect(row("waiting-ui")).toContain("Qualified · waiting for prerequisite delivery");
    expect(row("waiting-ui")).toContain("Prerequisite delivery");
    expect(row("waiting-ui")).toContain("Architect: wait for prerequisite delivery");
    expect(row("stale-ui")).toContain("Qualified · candidate input changed");
    expect(row("missing-ui")).toContain("Qualified · eligibility unknown");
    expect(row("eligible-backend")).toContain("Ready to merge");
    for (const id of ["waiting-ui", "stale-ui", "missing-ui"]) expect(row(id)).not.toContain("Ready to merge");
  });

  it("starts first-run work inline instead of a welcome interruption", () => {
    const html = renderToStaticMarkup(createElement(FocusBoardFirstRun, { onStartRequest: () => undefined }));

    expect(html).toContain("Start with a request");
    expect(html).toContain("Direct delivery");
    expect(html).toContain("Architect-led");
    expect(html).toContain("Start a request");
  });

  it("keeps the last facts visible with an explicit stale notice and a repository scope choice", () => {
    const details = [request("wr-a", "Alpha", [slice("a", "implementing")]), request("wr-b", "Beta", [slice("b", "implementing")], { repo: "fixture/secondary" })];
    const html = renderBoard(details, { staleSince: "2026-07-21T09:58:00Z", repositories: [{ key: "fixture/repo", label: "fixture/repo" }, { key: "fixture/secondary", label: "fixture/secondary" }] });

    expect(html).toContain('role="status">Connection interrupted. Showing the last facts received at');
    expect(html).toContain("Alpha");
    expect(html).toContain("Beta");
    expect(html).toContain('<option value="" selected="">All repositories</option>');
    expect(html).toContain('<option value="fixture/secondary">fixture/secondary</option>');
  });
});

function renderBoard(details: WorkRequestDetail[], props: Partial<Parameters<typeof FocusBoard>[0]> = {}) {
  return renderToStaticMarkup(createElement(FocusBoard, {
    details,
    packages: [],
    activeBlockingEdges: [],
    onSelectAttention: () => undefined,
    onSelectGuidance: () => undefined,
    onSelectCard: () => undefined,
    primaryBranchByRepo: new Map(),
    updateAnimations: { motionFor: () => undefined },
    ...props,
  }));
}

function groupHtml(html: string, lane: string) {
  const start = html.indexOf(`data-lane="${lane}"`);
  return html.slice(start, html.indexOf("</section></div></div></section>", start) + 1 || undefined);
}

function occurrences(html: string, value: string) {
  return html.split(value).length - 1;
}

function request(
  id: string,
  title: string,
  workPackages: WorkRequestPackage[],
  options: { completedAt?: string; openQuestions?: number; repo?: string; status?: string } = {},
): WorkRequestDetail {
  const groupIds = [...new Set(workPackages.map((item) => item.product_tree_node_id).filter((value): value is string => Boolean(value)))];
  return {
    work_request: {
      id,
      title,
      repo: options.repo ?? "fixture/repo",
      repo_key: options.repo ?? "fixture/repo",
      status: options.status ?? "sliced",
      completed_at: options.completedAt,
      open_question_count: options.openQuestions,
      work_package_count: workPackages.length,
    },
    summary: { open_question_count: options.openQuestions, work_package_count: workPackages.length },
    clarification_questions: options.openQuestions
      ? Array.from({ length: options.openQuestions }, (_, index) => ({ id: `question-${id}-${index}`, work_request_id: id, status: "open" }))
      : undefined,
    work_packages: workPackages,
    product_tree: {
      nodes: groupIds.map((groupId, position) => ({
        id: groupId,
        position,
        title: groupId,
        work_package_ids: workPackages.filter((item) => item.product_tree_node_id === groupId).map((item) => item.id),
      })),
    },
  };
}

function slice(
  id: string,
  status: string,
  options: {
    activity?: WorkRequestPackage["activity_signal"];
    dependency?: WorkRequestPackage["dependency_signal"];
    group?: string;
    packageId?: string;
    recordedAt?: string;
    review?: WorkRequestPackage["review_signal"];
    worker?: WorkRequestPackage["worker_signal"];
  } = {},
): WorkRequestPackage {
  return {
    id,
    work_request_id: "fixture",
    product_tree_node_id: options.group,
    work_package_id: options.packageId,
    title: id,
    status,
    activity_signal: options.activity,
    dependency_signal: options.dependency,
    review_signal: options.review,
    worker_signal: options.worker,
    delivery: options.recordedAt ? { outcome: status, recorded_at: options.recordedAt } : undefined,
  };
}
