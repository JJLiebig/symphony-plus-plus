import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkActivity } from "./work-activity";
import { WorkRequestExecutionGraph } from "./work-request-execution-graph";
import type { WorkRequestExecutionGraphModel } from "./execution-graph/model";

describe("work activity details", () => {
  it("keeps ownership and unknown timing explicit and shows native provider actions without synthesizing round or time", () => {
    const known = renderToStaticMarkup(<WorkActivity activity={{ accountable_owner: { id: "Chief" }, stage: "reviewing", started_at: "2026-10-05T01:00:00Z", elapsed_seconds: 7200, waiting_reason: "review_in_progress", next_actor: "worker", next_action: "wait", observation_state: "current" }} review={{ status: "in_progress", provider_status: "running", step: "correctness", round: "3", next_action: "fix_findings", observation_state: "stale" }} />);
    expect(known).toContain("Reviewing · Correctness · Round 3 · 2h 0m");
    expect(known).toContain("Fix Findings");
    expect(known).toContain("Stale");
    const unknown = renderToStaticMarkup(<WorkActivity activity={{ accountable_owner: { id: "Chief" }, stage: "reviewing", elapsed_seconds: 7200 }} review={{ status: "unavailable" }} />);
    expect(unknown).toContain("Chief");
    expect(unknown).toContain("Time unknown");
    expect(unknown).toContain("Runtime observation unknown");
    expect(unknown).not.toContain("Round");
    expect(unknown).not.toContain("2h");
  });
});

describe("work activity cards", () => {
  it("carries source-backed review, wait and owner facts into keyboard-accessible inspection without inferring an actor", () => {
    const workPackage: NonNullable<WorkRequestExecutionGraphModel["work_packages"]>[number] = {
      id: "wp-visible", title: "Visible review", status: "reviewing",
      activity_signal: { work_package_id: "wp-visible", accountable_owner: { id: "Chief" }, current_actor: { name: "Implementer", role: "worker" }, stage: "reviewing", started_at: "2026-10-05T01:00:00Z", elapsed_seconds: 12660, waiting_reason: "review_in_progress", next_actor: "worker", next_action: "wait", observation_state: "stale" as const },
      review_signal: { status: "in_progress" as const, step: "correctness", round: "2", current: 1, total: 2, provider_status: "running", observation_state: "current" as const },
    };
    const renderCard = (pkg: typeof workPackage) => renderToStaticMarkup(<WorkRequestExecutionGraph model={{ available: true, work_packages: [pkg] }} onSelectWorkPackage={() => undefined} />);
    const known = renderCard(workPackage);
    expect(known).toContain("Reviewing · Correctness · 1/2 · Round 2 · 3h 31m");
    expect(known).toContain("Owner: Chief");
    expect(known).toContain("Actor: Implementer / Worker");
    expect(known).toContain("Waiting: Review In Progress");
    expect(known).toContain("Next: Worker / Wait");
    expect(known).toContain("Runtime stale");
    const unknown = renderCard({ ...workPackage, activity_signal: { ...workPackage.activity_signal, current_actor: undefined, started_at: undefined, elapsed_seconds: undefined } });
    expect(unknown).toContain("Owner: Chief");
    expect(unknown).toContain("Actor: Unknown");
    expect(unknown).toContain("Time unknown");
    expect(unknown).not.toContain("3h 31m");
  });

});
