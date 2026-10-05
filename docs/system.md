# Current System

Symphony++ is a local planning and orchestration cockpit. Humans see product
progress while agents receive bounded assignments from the same ledger.
Delivery tracking usually begins after a human and agent have agreed on a
sufficiently concrete goal. Ordinary coordinators and workers can operate
without a backend when persistent planning is not requested.

This guide describes implemented behavior. The approved beta direction is in
[Factory workflow](design/factory-workflow.md).

## Work Model

| Entity | Purpose |
|---|---|
| WorkRequest | Product goal, repository, base branch, constraints, clarification, decisions, plan, and delivery state. |
| Group | Optional title and nesting boundary inside a WorkRequest; no lifecycle or manual completion step. |
| WorkPackage | Canonical bounded assignment from architect planning through worker execution and delivery. |
| Solo Session | Optional persistent plans, progress, findings, decisions, blockers, and validation for ordinary single-agent work. |

A WorkPackage owns its goal, file scope, delivery repository/base, acceptance
criteria, optional validation/stop/review context, claim, worktree, branch, PR,
progress, findings, readiness, blockers, and terminal delivery evidence.
Dispatch activates that record; it does not create a second execution record.

Simple WorkRequests contain WorkPackages directly. Do not create a Group merely
to wrap one package. Dependencies between packages or Groups expand into one
effective package graph for cycle detection, unmet prerequisites, and dispatch
readiness. Visual card order and grouping do not create dependencies.

WorkRequest completion requires actual `pr_merged` or `completed_no_pr` delivery
for its current required scope and closed questions. Planned skipped packages
retire obsolete scope; skipping every package does not deliver a WorkRequest.
Abandoned work remains unresolved unless delivered successors replace it.
Superseded work requires every successor from both its immutable delivery
pointer and same-request `superseded_by`/`recut_as` lineage to deliver. Missing
or cyclic successors remain unresolved. Later retirement annotations never
erase actual historical delivery. Explicit operator completion remains available.
`sliced` remains the stored planning status; delivery does not change it.

Solo Sessions do not create a WorkRequest, WorkPackage, worker grant, or dispatch.
All ledger operations, including Solo, use MCP. The packaged
[agent skills](../plugins/symphony-plus-plus-mcp/skills/) own operating procedures.

## Review And Delivery Authority

A declared review requirement identifies a provider and optional arguments,
such as `review-suite` with its selected mode. It can also name another plugin
or a human process. Results remain with the provider and worker handoff;
Symphony++ does not require a duplicate review-completion record.

The worker procedure owns required checks and review convergence. MCP readiness
checks ledger prerequisites and current provider-backed PR metadata; a ready
state alone is not proof that every test or review requirement passed. See the
[WorkPackage skill](../plugins/symphony-plus-plus-mcp/skills/symphony-work-package/SKILL.md)
for the authoritative handoff procedure.

GitHub owns commits, PRs, checks, and merge state. Symphony++ records the delivery
outcome so its completion projection is auditable and idempotent.

## Runtime Shape

```text
Codex MCP client
  -> installed plugin bridge
  -> local HTTP MCP endpoint
  -> Symphony++ Elixir runtime
  -> local SQLite ledger
```

The first installed client starts the backend when necessary; later clients
attach to the same singleton. The launcher prefers loopback port `19998`, then
higher available ports. MCP and the packaged dashboard share that endpoint;
the runtime file records both URLs. Port `19999` belongs to source/Vite
development. See [Runtime](runtime.md) for lifecycle and installation details.

## System Boundaries

| Layer | Owns |
|---|---|
| Ledger | Requests, Groups, packages, questions, decisions, dependencies, grants, progress, and delivery evidence. |
| MCP | Discovery, claims, scoped reads/mutations, dispatch, readiness, and recovery. |
| Dashboard | Human projection of ledger, GitHub state, and runtime activity. |
| Plugin packages | Installation, launchers, and authoritative agent procedures. |
| GitHub | Branches, commits, PRs, checks, reviews, and merge truth. |

Workers claim one WorkPackage; architects claim one WorkRequest. The server
derives repository, base branch, phase, anchor, worktree, and grant context from
the ledger and validates supplied context against it. Tool discovery is not
authorization: calls still check session, role, capabilities, resource scope,
and lifecycle state. See [Security](security.md).

`SPEC.md` and the non-Symphony++ parts of `elixir/` describe upstream Symphony:
tracker polling, workspace management, Codex app-server execution, and runtime
observability. Symphony++ adds its local ledger, MCP orchestration, plugin
runtime, dashboard, and GitHub delivery workflow alongside that behavior.

`ToolCatalog` and MCP handlers own live schemas and behavior.
[`mcp_contract.json`](../elixir/priv/symphony_plus_plus/mcp_contract.json) exports
the artifact fingerprint and complete tool-name sets for non-Elixir release
smoke tests. A runtime test keeps those names aligned with `ToolCatalog`; the
artifact does not duplicate schemas.

### Qualified candidate dependencies

An architect can set `candidate_head_sha` on `upsert_dependency` after qualifying
that exact backend WorkPackage head through its native checks and review handoff.
The prerequisite must be one WorkPackage; the dependent may be a Group. A current
pin plus the backend's `ready_for_merge` state and matching branch/PR head enables
wiring and technical review before backend merge. Readiness alone does not prove
checks or review passed. Without a pin, dispatch waits for actual delivered scope,
including all required successors; skipped or abandoned attempts do not count.
Overlapping dependency constraints all apply. Set the pin to `null` to remove it.

The wiring worker records consumed inputs in existing `append_progress` provenance:

```json
{
  "summary": "Qualified wiring against the selected backend",
  "idempotency_key": "wiring-inputs-1",
  "payload": {
    "head_sha": "<current dependent PR head>",
    "dependency_inputs": [{
      "dependency_id": "<edge id>",
      "prerequisite_work_package_id": "<backend WorkPackage id>",
      "candidate_head_sha": "<pinned backend head>"
    }]
  }
}
```

`read_context` exposes `dependency_selections`; `read_plan` exposes each expanded
constraint. A changed pin or candidate head makes affected input provenance stale.
After qualifying the new input, append its selection for the current dependent head;
other edges retain their valid selections. Repinning never refreshes old evidence.
Ready packages remain immutable: create and qualify a successor before retiring the
old candidate, then select that successor and requalify affected wiring. Provider
review results stay with their provider; input provenance is not a review receipt.

Before merging, the architect checks the delivery board's `merge_eligibility`,
current selections, and native checks/review. Backend delivery must precede UI merge,
and pinned heads must still match after backend delivery. External merges are
recorded truthfully even when out of order; the board flags `delivery_order_violation`
for remediation, including after the backend eventually delivers.
