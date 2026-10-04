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

WorkRequest completion is derived from terminal WorkPackages, closed questions,
and recorded delivery evidence. `sliced` remains the stored planning status;
there is no manual `completed` status transition. This current projection must
not be confused with the target delivery semantics in the factory contract.

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
