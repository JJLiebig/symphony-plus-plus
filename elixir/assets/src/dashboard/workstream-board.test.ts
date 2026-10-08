import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkPackageCard, WorkRequestDetail } from "@/types/dashboard";
import { EmptyWorkRequest, ProductRequestRow } from "./workstream-board";
import { ProductPlanBody } from "./workstream-product-plan";
import { architectStartPrompt, requestIdentityCopyText, visibleRequestBranch } from "./workstream-utils";
import { dashboardWorkRequestDetails, sortWorkRequestDetails } from "./workstream-data";

describe("work board request rendering", () => {
  it("renders priority WorkRequest cards before compact execution details arrive", () => {
    const [detail] = dashboardWorkRequestDetails({
      work_requests: {
        work_requests: [{ id: "wr-priority", title: "Priority request", work_package_count: 3, open_question_count: 1 }],
        total_count: 1,
      },
    });

    expect(detail).toMatchObject({
      work_request: { id: "wr-priority", title: "Priority request" },
      summary: { work_package_count: 3, open_question_count: 1 },
    });
    expect(detail?.work_packages).toBeUndefined();
  });

  it("overlays fresh priority fields while retaining compact execution children", () => {
    const [detail] = dashboardWorkRequestDetails({
      work_requests: {
        work_requests: [{ id: "wr-priority", title: "Fresh title", status: "sliced", work_package_count: 4 }],
        total_count: 1,
      },
      work_request_details: [{
        work_request: { id: "wr-priority", title: "Stale title", status: "clarifying" },
        summary: { work_package_count: 2, decision_count: 1 },
        work_packages: [{ id: "slice-1", work_request_id: "wr-priority" }],
      }],
    });

    expect(detail).toMatchObject({
      work_request: { title: "Fresh title", status: "sliced" },
      summary: { work_package_count: 4, decision_count: 1 },
      work_packages: [{ id: "slice-1" }],
    });
  });

  it("retains a full deferred detail absent from priority cards", () => {
    const details = dashboardWorkRequestDetails({
      work_requests: {
        work_requests: [{ id: "wr-priority", title: "Priority request", status: "sliced" }],
        total_count: 1,
      },
      work_request_details: [{
        work_request: { id: "wr-deferred", title: "Deferred full detail", status: "planned" },
        product_tree: { nodes: [{ id: "group-deferred", title: "Deferred group", work_package_ids: ["wp-deferred"] }] },
        work_packages: [{ id: "wp-deferred", work_request_id: "wr-deferred", title: "Deferred package" }],
      }],
    });

    expect(details).toHaveLength(2);
    expect(details.find((detail) => detail.work_request.id === "wr-deferred")).toMatchObject({
      product_tree: { nodes: [{ id: "group-deferred" }] },
      work_packages: [{ id: "wp-deferred" }],
    });
    expect(details.find((detail) => detail.work_request.id === "wr-priority")?.work_request.title).toBe("Priority request");
  });

  it("keeps active and terminal WorkRequests and sorts them by latest update descending", () => {
    const details = dashboardWorkRequestDetails({
      work_requests: {
        work_requests: [
          { id: "wr-active", title: "Active", status: "implementing", inserted_at: "2026-07-01T00:00:00Z", updated_at: "2026-07-03T00:00:00Z" },
          { id: "wr-terminal", title: "Terminal", status: "completed", completed_at: "2026-07-04T00:00:00Z", inserted_at: "2026-06-01T00:00:00Z", updated_at: "2026-07-04T00:00:00Z" },
          { id: "wr-created", title: "Created", status: "sliced", inserted_at: "2026-07-02T00:00:00Z" },
        ],
        total_count: 3,
      },
      work_request_details: [
        { work_request: { id: "wr-active" } },
        { work_request: { id: "wr-terminal" } },
        { work_request: { id: "wr-created" } },
      ],
    });

    expect(sortWorkRequestDetails(details).map((detail) => detail.work_request.id)).toEqual([
      "wr-terminal",
      "wr-active",
      "wr-created",
    ]);
  });

  it("renders the shared card header with per-package current work and the stable Group and WorkPackage tree", () => {
    const detail = graphRequestDetail();
    const tree = renderTree(detail);
    const focusCard = renderFocusRow(detail);

    expect(tree).toContain('class="v3-product-plan"');
    expect(tree).toContain('class="v3-product-node-title">Graph group</span>');
    expect(tree).toContain('data-work-package-id="wp-active"');
    expect(tree).toContain('aria-label="Open WorkPackage details for Active package"');
    expect(tree).toContain('href="https://github.com/example/fixture/pull/101"');
    expect(tree).toContain('title="Open PR #101"');
    expect(tree).not.toContain("v3-slice-kind");
    expect(focusCard).toContain("Graph request");
    expect(focusCard).toContain("fixture/repo");
    expect(focusCard).toContain("feature/focus-board");
    expect(focusCard).toContain('<span class="v3-request-frontier-group-title-label">Graph group</span>');
    expect(focusCard).toContain('class="v3-request-frontier-title" title="Active package"');
    expect(focusCard).toContain('<span class="v3-request-frontier-pr-label" aria-hidden="true">PR</span><span class="v3-request-frontier-pr-number" aria-hidden="true">#101</span>');
    expect(focusCard).toContain("PR #101");
    expect(focusCard).toContain("Show all current work (4)");
    expect(focusCard).not.toContain("Terminal stale package");
    expect(focusCard).not.toContain("v3-disclosure-reveal");
    expect(focusCard).toContain('aria-label="Open request details"');
    expect(focusCard).toContain('aria-label="Copy WorkRequest identity"');
    expect(focusCard).toContain('class="v3-request-controls"');
    expect(requestIdentityCopyText(detail)).toBe("Graph request - WR ID: wr-graph");
    expect(focusCard).not.toContain('role="progressbar"');
    expect(focusCard).not.toContain("Architect handoff");
    expect(focusCard).not.toContain("v3-execution-graph");
  });

  it("keeps Group and WorkPackage badges actionable for an explicit blocker record", () => {
    const detail: WorkRequestDetail = {
      work_request: { id: "wr-attention", title: "Attention request", status: "blocked" },
      work_packages: [{ id: "wp-blocked", work_package_id: "wp-blocked", work_request_id: "wr-attention", product_tree_node_id: "group-attention", title: "Blocked package", status: "blocked" }],
      product_tree: { nodes: [{ id: "group-attention", title: "Attention group", work_package_ids: ["wp-blocked"] }] },
    };
    const expanded = renderTree(detail, [{ id: "wp-blocked", status: "blocked", active_blockers: [{ id: "blocker-1", active: true }] }]);

    expect(expanded).toContain('aria-label="Open attention details for Attention group"');
    expect(expanded).toContain('aria-label="Open attention details for Blocked package"');
  });

  it("restores the historical nested Group tree with owned and root WorkPackages", () => {
    const detail: WorkRequestDetail = {
      work_request: { id: "wr-tree", title: "Nested tree", status: "sliced" },
      work_packages: [
        { id: "wp-parent", work_request_id: "wr-tree", title: "Parent package", product_tree_node_id: "group-parent" },
        { id: "wp-child", work_request_id: "wr-tree", title: "Child package", product_tree_node_id: "group-child" },
        { id: "wp-root", work_request_id: "wr-tree", title: "Root package" },
      ],
      product_tree: {
        root_node_ids: ["group-parent"],
        root_work_package_ids: ["wp-root"],
        nodes: [
          { id: "group-child", parent_id: "group-parent", position: 2, title: "Child group", work_package_ids: ["wp-child"] },
          { id: "group-parent", position: 1, title: "Parent group", work_package_ids: ["wp-parent"] },
        ],
      },
    };
    const html = renderTree(detail);
    const treeHtml = html.slice(html.indexOf('class="v3-product-plan"'));

    expect(html).toContain('class="v3-product-tree"');
    expect(html).toContain('style="--tree-depth:0"');
    expect(html).toContain('style="--tree-depth:1"');
    expect(html).toContain('class="v3-product-node-children"');
    expect(html).toContain('class="v3-slice-list"');
    expect(html).toContain('class="v3-direct-slices"');
    expect(treeHtml.indexOf("Parent package")).toBeLessThan(treeHtml.indexOf("Child group"));
    expect(treeHtml.indexOf("Child package")).toBeLessThan(treeHtml.indexOf("Root package"));
    expect(html).not.toContain("v3-execution-graph");
  });

  it("shows update freshness separately from the state badge instead of implying a stage duration", () => {
    const collapsed = renderFocusRow(graphRequestDetail(), [{ id: "pkg-terminal", updated_at: "2026-07-18T09:25:00Z" }]);
    const daysOld = renderFocusRow({ work_request: { id: "wr-old", title: "Old request", status: "active", updated_at: "2026-07-16T07:30:00Z" } });
    const requestNewer = renderFocusRow({
      work_request: { id: "wr-newer", title: "Recently updated request", status: "active", updated_at: "2026-07-18T09:28:00Z" },
      work_packages: [{ id: "wp-newer", work_request_id: "wr-newer", work_package_id: "pkg-newer", status: "active" }],
    }, [{ id: "pkg-newer", status: "active", updated_at: "2026-07-18T09:00:00Z" }]);

    expect(collapsed).toContain("Updated 5m ago");
    expect(daysOld).toContain("Updated 2d ago");
    expect(requestNewer).toContain("Updated 2m ago");
    expect(requestNewer).toContain('class="sr-only">Active</span>');
    expect(requestNewer).not.toContain("Active · 2m");
  });

  it("omits generic package activity that only repeats the overall request state", () => {
    const blocked = renderFocusRow({
      work_request: { id: "wr-blocked", title: "Blocked request", status: "blocked" },
      work_packages: [{ id: "wp-blocked", work_request_id: "wr-blocked", title: "Blocked package", status: "blocked" }],
    });
    const active = renderFocusRow({
      work_request: { id: "wr-active", title: "Active request", status: "active", updated_at: "2026-07-18T09:20:00Z" },
      work_packages: [{ id: "wp-active", work_request_id: "wr-active", title: "Active package", status: "active" }],
    });
    const linkedDetail: WorkRequestDetail = {
      work_request: { id: "wr-linked", title: "Linked runtime", status: "planned" },
      work_packages: [{ id: "slice-linked", work_request_id: "wr-linked", work_package_id: "wp-linked", title: "Linked active package", status: "planned" }],
    };
    const linkedPackageActive = renderFocusRow(linkedDetail, [{ id: "wp-linked", status: "active" }]);

    expect(blocked).toContain('class="sr-only">Waiting</span>');
    expect(blocked).toContain('title="Blocked">Blocked</span>');
    expect(blocked).not.toContain("border-rose-200");
    expect(blocked).not.toContain("data-first");
    expect(active).toContain('class="sr-only">Active</span>');
    expect(active).toContain("Active package");
    expect(active).not.toContain('title="Active">Active</span>');
    expect(linkedPackageActive).toContain("Linked active package");
  });

  it("hides primary branches, preserves feature branches, and renders the local empty-work prompt", () => {
    const detail: WorkRequestDetail = {
      work_request: { id: "wr-empty", title: "Empty request", repo: "fixture/repo", base_branch: "main", status: "clarifying" },
      clarification_questions: [{ id: "question-1", work_request_id: "wr-empty", status: "open" }],
      product_tree: { nodes: [] },
      work_packages: [],
    };
    const expanded = renderToStaticMarkup(createElement(EmptyWorkRequest, { workRequestId: "wr-empty" }));

    expect(visibleRequestBranch("main", "main")).toBeUndefined();
    expect(visibleRequestBranch("master", "develop")).toBeUndefined();
    expect(visibleRequestBranch("develop", "develop")).toBeUndefined();
    expect(visibleRequestBranch("feature/focus-board", "main")).toBe("feature/focus-board");
    expect(renderFocusRow(detail)).not.toContain(">main<");
    expect(expanded).toContain("No work has been created yet. Copy a prompt to start this WorkRequest with an architect agent.");
    expect(expanded).toContain("lucide-copy");
    expect(expanded).not.toContain("lucide-clipboard-copy");
    expect(expanded).not.toContain("Open Question");
    expect(expanded).not.toContain("v3-execution-graph");
    expect(architectStartPrompt("wr-empty")).toBe("Take a look at WorkRequest wr-empty using $symphony-plus-plus-mcp:symphony-architect. Check it out, bring me any questions if there are any, then let's go.");
  });
});

const noUpdateAnimations = {
  motionFor: () => undefined,
};

function graphRequestDetail(): WorkRequestDetail {
  return {
    work_request: {
      id: "wr-graph",
      title: "Graph request",
      repo: "fixture/repo",
      base_branch: "feature/focus-board",
      status: "implementing",
      updated_at: "2026-07-18T07:00:00Z",
    },
    work_packages: [
      {
        id: "wp-active",
        work_request_id: "wr-graph",
        product_tree_node_id: "group-a",
        sequence: 1,
        title: "Active package",
        status: "implementing",
        updated_at: "2026-07-18T09:10:00Z",
        worker_signal: {
          status: "active",
          active_since: "2026-07-18T08:00:00Z",
          last_activity: "2026-07-18T09:15:00Z",
          run_label: "fixture-worker",
        },
        pr_signal: { status: "open", number: 101, url: "https://github.com/example/fixture/pull/101" },
      },
      {
        id: "wp-review",
        work_request_id: "wr-graph",
        product_tree_node_id: "group-a",
        sequence: 2,
        title: "Review package",
        status: "reviewing",
        updated_at: "2026-07-18T09:11:00Z",
        review_signal: { status: "in_progress", current: 3, total: 4 },
        pr_signal: { status: "open", number: 102, url: "https://github.com/example/fixture/pull/102" },
      },
      {
        id: "wp-ci",
        work_request_id: "wr-graph",
        product_tree_node_id: "group-b",
        sequence: 3,
        title: "CI package",
        status: "ci_waiting",
        updated_at: "2026-07-18T09:12:00Z",
        pr_signal: { status: "open", number: 103, url: "https://github.com/example/fixture/pull/103", checks: { status: "pending", current: 2, total: 3 } },
      },
      {
        id: "wp-hidden",
        work_request_id: "wr-graph",
        product_tree_node_id: "group-b",
        sequence: 4,
        title: "Fourth active package",
        status: "implementing",
        updated_at: "2026-07-18T09:20:00Z",
        worker_signal: { status: "active" },
      },
      {
        id: "wp-old",
        work_request_id: "wr-graph",
        work_package_id: "pkg-terminal",
        product_tree_node_id: "group-a",
        sequence: 5,
        title: "Terminal stale package",
        status: "merged",
        review_signal: { status: "in_progress", current: 1, total: 2 },
      },
    ],
    product_tree: {
      available: true,
      execution_graph: {
        available: true,
        work_package_ids: ["wp-active", "wp-review", "wp-ci", "wp-hidden", "wp-old"],
        topological_order: ["wp-active", "wp-review", "wp-ci", "wp-hidden", "wp-old"],
        effective_edges: [],
        cycles: [],
      },
      nodes: [
        { id: "group-a", title: "Graph group", work_package_ids: ["wp-active", "wp-review", "wp-old"] },
        { id: "group-b", title: "Second group", work_package_ids: ["wp-ci", "wp-hidden"] },
      ],
    },
  };
}

function renderTree(detail: WorkRequestDetail, packages: WorkPackageCard[] = []) {
  return renderToStaticMarkup(createElement(ProductPlanBody, {
    detail,
    slices: detail.work_packages ?? [],
    packageById: new Map(packages.map((pkg) => [pkg.id, pkg])),
    activeBlockingEdges: [],
    guidanceItems: [],
    onSelectAttention: () => undefined,
    onSelectCard: () => undefined,
    requestPath: [{ id: detail.work_request.id, label: detail.work_request.title || detail.work_request.id }],
    updateAnimations: noUpdateAnimations,
  }));
}

function renderFocusRow(detail: WorkRequestDetail, packages: WorkPackageCard[] = []) {
  return renderToStaticMarkup(createElement(ProductRequestRow, {
    detail,
    now: "2026-07-18T09:30:00Z",
    activeBlockingEdges: [],
    guidanceItems: [],
    packageById: new Map(packages.map((pkg) => [pkg.id, pkg])),
    focusSelected: false,
    index: 0,
    onSetOpen: () => undefined,
    onSelectAttention: () => undefined,
    onSelectCard: () => undefined,
    primaryBranch: "main",
    updateAnimations: noUpdateAnimations,
  }));
}
