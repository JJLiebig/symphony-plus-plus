import type { ExecutionGraphWorkPackageRef, ExecutionGraphWorkPackageSignals } from "@/dashboard/execution-graph/model";
import { describe, expect, it } from "vitest";

import { renderInspector, stripAnsi, terminalCellWidth } from "./render";
import type { InspectorState } from "./types";

describe("execution inspector rendering", () => {
  it("shows selected owner/activity separately from missing panes and keeps narrow inspection bounded", () => {
    const current: ExecutionGraphWorkPackageRef & ExecutionGraphWorkPackageSignals = {
      ...pkg("wp-a", "Review", "reviewing"),
      activity_signal: { accountable_owner: { id: "Chief" }, current_actor: { name: "Worker", role: "worker" }, stage: "reviewing", started_at: "2026-10-05T01:00:00Z", elapsed_seconds: 10800, waiting_reason: "review_in_progress", next_actor: "worker", next_action: "wait", observation_state: "stale" },
      review_signal: { status: "in_progress", step: "correctness", round: "2" },
    };
    const value = state([current]);
    value.snapshot = { panes: [] };
    const output = stripAnsi(renderInspector(value, 100, 26));
    expect(output).toContain("Owner: Chief");
    expect(output).toContain("Working now: Worker / Worker · runtime stale");
    expect(output).toContain("Correctness · Round 2 · 3h 0m");
    expect(output).toContain("Waiting on: Review in progress");
    expect(output).toContain("Next: Worker: wait for review");
    expect(output).toContain("Runtime stale");
    expect(output).toContain("Worker pane missing");
    value.detail!.worker_sessions = [{ work_package_id: "wp-a", agent_session_id: "exact-worker" }];
    expect(stripAnsi(renderInspector(value, 100, 26))).toContain("Worker pane disconnected");
    value.snapshot.panes = [{ pane_id: "exact", tab_id: "tab-a", workspace_id: "workspace-a", agent_session: { agent: "codex", value: "exact-worker" } }];
    expect(stripAnsi(renderInspector(value, 100, 26))).toContain("Worker pane connected");
    current.activity_signal = { ...current.activity_signal, current_actor: undefined, started_at: undefined, elapsed_seconds: undefined, observation_state: "unknown" };
    const unknown = stripAnsi(renderInspector(value, 100, 26));
    expect(unknown).toContain("Owner: Chief");
    expect(unknown).toContain("Working now: Unknown");
    expect(unknown).toContain("Time unknown");
    for (const width of [12, 28, 80]) {
      const narrow = stripAnsi(renderInspector(value, width, 24));
      expect(Math.max(...narrow.split("\n").map(terminalCellWidth))).toBeLessThanOrEqual(width);
      expect(narrow.split("\n").length).toBeLessThanOrEqual(24);
    }
  });

  it("reads qualified work as mergeable only from canonical eligibility", () => {
    const qualified = { ...pkg("wp-a", "Qualified UI", "ready_for_merge"), operational_state: { key: "merge_ready", label: "Ready For Merge" } };
    const waiting = stripAnsi(renderInspector(state([{ ...qualified, merge_eligibility: { eligible: false, reason_codes: ["dependency_not_delivered"] } }]), 80, 20));
    expect(waiting).toContain("Qualified");
    expect(waiting).not.toMatch(/ready (for|to) merge/i);
    expect(stripAnsi(renderInspector(state([qualified]), 80, 20))).not.toMatch(/ready (for|to) merge/i);
    expect(stripAnsi(renderInspector(state([{ ...qualified, merge_eligibility: { eligible: true } }]), 80, 20))).toContain("Ready to merge");
  });

  it("keeps a trivial WorkRequest compact", () => {
    const output = stripAnsi(renderInspector(state([pkg("wp-a", "Review", "review")]), 44));
    expect(output).toContain("Review");
    expect(output).not.toContain("Previous");
    expect(output.split("\n").length).toBeLessThan(9);
  });

  it("renders branching topology without horizontal overflow", () => {
    const current = pkg("wp-a", "Build", "implementing");
    const left = pkg("wp-b", "Review API", "planned");
    const right = pkg("wp-c", "Review UI", "planned");
    const value = state([current, left, right], [
      edge("wp-a", "wp-b"),
      edge("wp-a", "wp-c"),
    ]);
    const output = stripAnsi(renderInspector(value, 58, 24));
    expect(output).toContain("← wp-a");
    expect(output).toContain("Review API");
    expect(output).toContain("Review UI");
    expect(output.match(/planned/g)).toHaveLength(2);
    expect(Math.max(...output.split("\n").map((line) => Array.from(line).length))).toBeLessThanOrEqual(58);
  });

  it("marks a wide rank that continues on another row", () => {
    const current = pkg("wp-a", "Build", "implementing");
    const following = Array.from({ length: 4 }, (_, index) => pkg(`wp-${index + 1}`, `Review ${index + 1}`, "planned"));
    const value = state([current, ...following], following.map((item) => edge(current.id, item.id)));
    const output = stripAnsi(renderInspector(value, 58, 30));
    expect(output).toContain("↓");
  });

  it("keeps a large graph inside the current viewport", () => {
    const packages = Array.from({ length: 12 }, (_, index) => pkg(`wp-${index}`, `Package ${index}`, "implementing"));
    const edges = packages.slice(1).map((item, index) => edge(packages[index].id, item.id));
    const value = state(packages, edges);
    value.detail!.attention_keys = ["work_package:wp-0"];
    const output = stripAnsi(renderInspector(value, 28, 21));
    expect(output).toContain("Package 0");
    expect(output).toContain("Later 10");
    expect(output.split("\n").length).toBeLessThanOrEqual(21);
  });

  it("uses compact metadata below the minimum card width", () => {
    const current = pkg("wp-a", "Build", "implementing");
    const next = pkg("wp-b", "Review", "planned");
    const value = state([current, next], [edge("wp-a", "wp-b")]);
    value.detail!.attention_keys = ["work_package:wp-a"];
    const output = stripAnsi(renderInspector(value, 12, 16));
    expect(output).not.toContain("┌");
    expect(Math.max(...output.split("\n").map((line) => Array.from(line).length))).toBeLessThanOrEqual(12);
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
