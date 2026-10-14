import type { ExecutionGraphWorkPackageRef, ExecutionGraphWorkPackageSignals } from "./execution-graph/model";
import { describe, expect, it } from "vitest";

import { renderInspector, stripAnsi, terminalCellWidth } from "./render";
import type { InspectorState } from "./types";

describe("execution inspector rendering", () => {
  it("withholds merge readiness when canonical eligibility is absent", () => {
    const qualified = { ...pkg("wp-a", "Qualified UI", "ready_for_merge"), operational_state: { key: "merge_ready", label: "Ready For Merge" } };
    expect(stripAnsi(renderInspector(state([qualified]), 80, 20))).not.toMatch(/ready (for|to) merge/i);
  });

  it("keeps review round timing distinct from total review time", () => {
    const current: ExecutionGraphWorkPackageRef & ExecutionGraphWorkPackageSignals = {
      ...pkg("wp-a", "Review", "reviewing"),
      activity_signal: { stage: "reviewing", started_at: "2026-10-05T03:00:00Z", elapsed_seconds: 3600 },
      review_signal: { status: "in_progress", round: "2", started_at: "2026-10-05T01:00:00Z", round_started_at: "2026-10-05T03:00:00Z" },
    };
    expect(stripAnsi(renderInspector(state([current]), 100, 40))).toContain("Round 2 · 1h 0m this round");
    current.activity_signal = { stage: "reviewing", started_at: "2026-10-05T01:00:00Z", elapsed_seconds: 10800 };
    expect(stripAnsi(renderInspector(state([current]), 100, 40))).toContain("3h 0m in review");
  });

  it("sanitizes ledger control characters and measures wide terminal cells", () => {
    const current = pkg("wp-a", "Deploy 🚀 漢字\n\u001b]52;c;payload\u0007", "implementing");
    const next = pkg("wp-b", "Review 🧑‍💻", "planned");
    const value = state([current, next], [edge("wp-a", "wp-b")]);
    value.detail!.attention_keys = ["work_package:wp-a"];
    const output = stripAnsi(renderInspector(value, 28, 24));
    expect(output).not.toContain("\n\u001b]");
    expect(output).not.toContain("\u0007");
    expect(Math.max(...output.split("\n").map(terminalCellWidth))).toBeLessThanOrEqual(28);
  });
});

function state(workPackages: Array<ExecutionGraphWorkPackageRef & ExecutionGraphWorkPackageSignals>, effectiveEdges: ReturnType<typeof edge>[] = []): InspectorState {
  return {
    binding: {
      paneId: "pane-a",
      tabId: "tab-a",
      workspaceId: "workspace-a",
      role: "architect",
      workRequestId: "wr-a",
      endpoint: "http://127.0.0.1:19998",
      agentSessionId: "session-a",
    },
    pinned: false,
    selectedId: workPackages[0]?.id,
    detail: {
      work_request: { id: "wr-a", title: "Ship the system", repo: "repo", status: "active" },
      execution_graph: {
        available: true,
        work_packages: workPackages,
        effective_edges: effectiveEdges,
        topological_order: workPackages.map((item) => item.id),
      },
      attention_keys: [],
      worker_sessions: [],
    },
  };
}

function pkg(id: string, title: string, status: string) {
  return { id, title, status, raw_status: status, operational_state: { key: status, label: status } };
}

function edge(prerequisite_work_package_id: string, dependent_work_package_id: string) {
  return { prerequisite_work_package_id, dependent_work_package_id };
}
