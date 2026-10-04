---
name: symphony-worker
description: Use when spawned as an implementation worker expected to deliver a scoped task through implementation, validation, review, CI/static gates when present, and a merge-ready PR or explicit no-PR evidence packet.
---

# Symphony++ Worker

Use when you own a bounded implementation, investigation, docs, hotfix, or
PR-sized assignment.

## Contract

1. Understand scope, owned paths, forbidden paths, acceptance, optional review
   requirement, branch/base target, and any supplied validation, stop condition,
   or line/PR-size context before coding.
2. Pick the correct state layer:
   - Assigned WorkPackage: use
     `symphony-plus-plus-mcp:symphony-work-package` and claim by WorkPackage
     id.
     If that MCP adapter is unavailable, tell the supervising parent and stop;
     do not fall back to Solo.
   - No WorkPackage: when durable task memory helps, use
     `symphony-plus-plus-mcp:symphony-solo-session`.
     Each worker uses its own session; short read-only scouts need no Solo ledger.
     If optional persistence is unavailable, continue ordinary work without it.
     If ledger work is required, report missing MCP and recover the connection;
     do not use business CLI commands or private state files.
3. Implement only the assigned scope.
4. Complete the required checks in Review.
5. Return a review-green, merge-ready PR, or a no-PR evidence packet for
   investigation/docs/read-only work.

## Scope

- Stay inside the assignment boundary.
- If an MCP WorkPackage presents compact TOON context, treat it as
  agent-readable presentation only. Continue sending tool inputs as
  JSON/schema-native arguments and read tool `structuredContent` as the
  canonical machine-readable result.
- Escalate product ambiguity, architecture ambiguity, dependency surprises,
  reviewer-driven scope creep, missing evidence, or line-budget risk to the
  calling architect/operator before broadening.
- Honor assigned budgets. Otherwise keep one cohesive outcome and escalate
  material scope growth or reviewability risk; no numerical budget is required.
- Do not invent product behavior to satisfy a review.

## Review

- Define one required-check set from repository and assignment requirements:
  tests, static checks, CI/check status when present, any declared review
  requirement, and GitHub review when required. Preserve mandated commands and
  ordering. CI/checks must be green or reported with the exact failure; say
  when no CI exists.
- A passing required broad command covers its included focused tests. Run
  focused checks separately when uncovered, useful for feedback, or needed to
  diagnose a failure.
- Reuse still-valid evidence with its tested revision. Rerun checks when
  relevant inputs or execution conditions change, results fail, or policy
  requires it; do not infer passing evidence.
- For WorkPackage review requirements and brief derivation, follow the paired
  `symphony-plus-plus-mcp:symphony-work-package` adapter. Other work does not
  require a Symphony++ brief.
- After material changes, rerun any declared review for the new exact head.
- Record material findings, progress, or validation context when it helps the
  handoff. Do not add task-plan, review-package, or progress calls only to
  restate work already proved elsewhere.
- Policy-approved no-PR work may become ready without a branch head. PR-backed
  work still needs current exact-head evidence.

## Delivery

- Use the [WorkPackage handoff template](../symphony-work-package/references/handoff.md)
  for the final evidence packet, including work without an assigned WorkPackage.
- Do not record WorkRequest delivery closeout or product merge/closure unless
  explicitly assigned that architect/operator duty.

## Safety

Never print, store, commit, or paste raw API keys, bearer tokens, GitHub tokens,
Linear tokens, MCP auth tokens, worker secrets, raw WorkKeys, private handoff
payloads, grant verifiers, claim lease internals, or full secret-bearing
commands.
