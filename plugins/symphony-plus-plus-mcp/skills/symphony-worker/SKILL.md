---
name: symphony-worker
description: Use when assigned a bounded implementation, investigation, docs, or PR-sized task; deliver native checks, review, and a normal PR or evidence handoff.
---

# Symphony++ Worker

Implement the assignment, run its required native checks and review, and return
a normal PR or evidence handoff. No Symphony++ MCP calls, claim, progress ledger,
question record, or duplicate review receipt are required.

## Scope

- Understand the goal, owned/forbidden paths, acceptance, repo/base/branch/worktree,
  validation, review requirement, dependencies, prior findings/decisions, and
  stopping conditions supplied by the parent before coding.
- Stay inside that scope. Ask the parent in the conversation when context is
  missing or material product, architecture, dependency, or review ambiguity
  appears. Questions and ordinary waits are not blockers. Continue independent
  work while a decision is pending.
- The architect or coordinating parent owns dispatch authority, dependency
  decisions, explicit blocker declaration/resolution, and delivery reconciliation.
  Do not infer takeover authority from missing or stale observations.
- Honor assigned budgets; otherwise keep one cohesive outcome. Escalate material
  scope growth before implementing it. Do not invent product behavior for a review.

## Checks and Review

- Use the repository's native required tests, static checks, CI, and declared
  review provider. Preserve required commands and ordering; honor execution bans.
- Reuse still-valid evidence with its tested revision. Rerun when relevant inputs
  change, results fail, or policy requires it. Report exact failures and unrun
  requirements; never infer passing checks or review.
- Keep review evidence with its provider. For Review Suite, use the installed
  procedure and a concise brief from the assignment, including the relevant goal,
  owned scope, acceptance, and stopping conditions. No Symphony++ brief or
  completion receipt is required.
- Resolve findings inside scope; return product/contract conflicts to the parent.
  Complete the provider's convergence process on the current head.

## Delivery

Return the PR URL and exact head, changed behavior, acceptance evidence, required
checks and review results (with native links/identifiers and tested heads), and
remaining risks. For candidate dependencies, name the consumed backend/package
heads and the final dependent head. No-PR work returns direct evidence for the
parent's acceptance.

The parent reconciles readiness and delivery from that handoff and authoritative
GitHub/review evidence. Optional Herdr/OSC observations augment last-known state;
absence means unknown and does not block work or authorize takeover.

Use scoped worker MCP tools only when they help an explicitly chosen workflow;
see [the optional adapter](../symphony-work-package/SKILL.md). Authentication and
scope denials still apply when using those tools. Never substitute business CLI
commands or private state files for required parent ledger operations.

## Safety

Never print, store, commit, or paste raw API keys, bearer tokens, GitHub tokens,
Linear tokens, MCP auth tokens, worker secrets, raw WorkKeys, private handoff
payloads, grant verifiers, claim lease internals, or secret-bearing commands.
