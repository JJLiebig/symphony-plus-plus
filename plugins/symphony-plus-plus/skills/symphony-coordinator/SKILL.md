---
name: symphony-coordinator
description: Use when acting as a parent Codex agent coordinating ordinary repo work without required Symphony++ persistence across one or more subagents, including scouting, slicing, worker dispatch, review convergence, and PR/evidence integration.
---

# Symphony++ Coordinator

Use for ordinary repository coordination. For WorkRequests, WorkPackages,
ledger-backed claims, scoped grants, delivery boards, or MCP merge gates, use
`symphony-plus-plus-mcp:symphony-architect`.
Small clear work stays in this direct worker loop; a chief, WorkRequest or
feature-planning ceremony is optional. Escalate to an architect when scope or
unresolved product decisions require it, not because of request type or model.

## Start

- Optionally attach a coordinator-owned `symphony-plus-plus:symphony-solo-session`
  for parent planning through configured MCP tools. Do not share that session
  with workers. Persistence is optional: ordinary delegation needs no Symphony++
  backend when no ledger state is requested. Required ledger work needs MCP;
  report missing tools and recover the connection instead of substituting CLI
  business commands or private state files.
- Scout repo context before slicing.
- Identify outcome, base branch, acceptance, owned/forbidden areas, optional
  validation context, review profile, risk, and any assigned size budget.
- Resolve material ambiguity before dispatch.

## Slice

- Prefer one PR-sized slice per worker.
- Use isolated worktrees/branches for implementation or conflicting parallel
  work. Read-only scouts may use the existing checkout.
- Give workers goal, scope, base/branch/worktree, acceptance, optional
  validation and stop-condition context, review profile, any assigned budget, and expected
  PR/evidence.
- Honor assigned budgets; otherwise keep one cohesive outcome and escalate
  material scope growth or reviewability risk. Numerical budgets are optional.
- For S++ WorkPackages, provide the full scoped assignment and local worktree
  scope, including relevant prior findings/decisions. The parent owns dispatch
  authority; workers need no ledger claim or status calls.
- Use explorers for reconnaissance only.

## Dispatch

Worker prompts should include:

- `symphony-plus-plus:symphony-worker`.
- Task-specific scope, evidence, constraints, and deviations from the baseline
  worker contract.
- For manual worktrees, use `C:\Code\.worktrees\<repo>\<feature>`. After
  delivery or abandonment, remove only your clean worktree and run
  `git worktree prune`. S++-managed worktrees use their own lifecycle.

## Supervise

- Do not take over worker implementation by default.
- Answer architecture questions in the conversation; escalate human/product
  decisions to a chief when present, otherwise the user. Questions and ordinary
  waits are not blockers. Only the architect or coordinating parent explicitly
  declares/clears blockers for affected work after resolving or escalating it.
- Optional Herdr/OSC observations augment last-known state. Missing observation
  means unknown; it never blocks work or authorizes takeover.
- Treat review findings as risk signals, not scope authority.
- Stop or reslice when scope grows, workers collide, or PR budget is at risk.

## Integrate

- Verify PR/evidence against the assigned slice.
- Check changed files, acceptance, native validation/review evidence for the
  exact head, CI/check status, and residual risk. Own readiness and delivery
  reconciliation; do not request duplicate worker MCP or review receipts.
- Merge only when authorized.
- Summarize PRs/no-PR evidence and follow-ups.
