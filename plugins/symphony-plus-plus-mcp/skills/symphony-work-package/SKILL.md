---
name: symphony-work-package
description: Use when assigned a Symphony++ WorkPackage; claims the ledger-backed local assignment by WorkPackage id and keeps scoped planning, progress, branch/PR metadata, and readiness synchronized through the Symphony++ MCP server.
---

# Symphony++ Work Package

Use this MCP state adapter for assigned WorkPackages, paired with
`symphony-plus-plus-mcp:symphony-worker`.

The MCP server is the permission boundary and the WorkPackage is the worker
scope boundary. V3 product progress lives on the WorkRequest/product tree;
this skill handles only the dispatched execution/audit record.

For workers, the WorkPackage id is the primary execution coordinate. A linked
work-package id is product-planning/audit context inferred from the current
assignment when possible; pass both ids only when a tool explicitly needs a
cross-slice target, successor relation, audit closeout, or concurrency guard.

## Start

1. Use a dedicated S++ MCP-enabled session connected to the same ledger as
   dispatch.
2. Call `get_current_assignment()`. An unbound or stale session returns
   `assignment: null` plus the profile-aware claim or reclaim action.
3. Claim the package with `claim_local_assignment` using the WorkPackage id:
   `{"work_package_id":"<WP id>"}`. Include `claimed_by` only when the
   dispatch payload or operator provided a stable worker identity.
   A successful first claim atomically activates a `ready_for_worker` package.
4. Call worker tools from the stable worker catalog that was advertised at
   initialization. Claims and releases change authorization and scope, not the
   tool catalog.
5. Reuse the successful claim's `assignment` when it identifies the expected
   WorkPackage; otherwise call `get_current_assignment()` before continuing.
   Recheck binding after reconnect, denial, or conflicting identity. Replay the
   same claim after reconnects: the server heartbeats/reclaims eligible stale
   leases without rewriting lifecycle state. Paused leases, another active
   owner, or scope mismatch require the parent/operator; stop, never mint a
   replacement or bypass a denial.
6. Call `read_context()`, which authorizes the live session and returns the
   assigned contract/binding, parent summary, direct dependencies, selected
   decisions, and architect-owned completion step; it excludes siblings and
   the WorkRequest-wide plan. Reuse complete current assignment, acceptance,
   validation, and review fields actually returned to you. Fetch missing or
   truncated fields with `read_work_package_document({"document":"acceptance.md"})`
   or `review.md`; canonical package resources remain available to resource-capable
   hosts. A summary or
   inaccessible `structuredContent` is not proof of the complete contract.
7. Read handoff, findings, and progress before continuing, including on a first
   local claim: it may inherit prior work. Context alone does not prove history
   is empty. Preserve prior decisions and investigate relevant omitted history
   before relying on an incomplete projection. Read the task plan only when it
   adds useful execution context. Use `read_work_package_document` with `document`
   set to `handoff.md`, `findings.md`, or `progress.md`; it always reads the current
   assignment. The other selectors are `context.md`, `task_plan.md`, `acceptance.md`,
   and `review.md`. `read_context` still supplies the enriched assignment/dependency
   contract, and `read_task_plan` supplies the version needed for updates.
   Histories return at most 100 rows in chronological order. To recover older rows,
   pass the returned `next_before_sequence` as `before_sequence` with the same
   document until it is null. Omitted counts refer to older rows, and concurrent
   appends do not move that boundary. Only findings, progress, and handoff artifacts
   accept a cursor; a paged handoff keeps its current contract and latest progress.
   Reconcile uncertain mutations using returned row id, sequence, redacted
   idempotency key, body, and safe typed `payload.observation` fields. Read older
   pages before retrying an uncertain append; do not substitute private-store or
   operator history lookups.
8. Do not create local `task_plan.md`, `findings.md`, or `progress.md` files as
   the source of truth.

## Context Format

TOON is presentation only. Send schema-native JSON arguments;
`structuredContent` is the canonical machine-readable result.

## Work Loop

- When a task plan helps execution, use
  `update_task_plan({"expected_version": <read version>, "nodes": [...]})`.
  Each node is `{id?, title?, body?, status?}`. Omit `id` to create it with a
  required `title`; use the returned server-owned `id` for updates. Statuses
  are `pending`, `in_progress`, `done`, and `skipped`.
- `append_finding(finding, idempotency_key)`.
- `append_progress(event, idempotency_key)`.
- `add_comment(body)`, `list_comments()`, and
  `resolve_comment(comment_id, resolution_note?)` for scoped package notes.
  Pass `target_kind` and `target_id` only for another authorized target.
- `abandon(reason)` only when this worker must terminally abandon an active or
  blocked assignment.
  Active blocker facts remain preserved in the closeout audit trail.
- Use ordinary collaboration or the final worker message for execution
  problems. Use comments only when the package note should remain in S++.
  Workers do not create or resolve human blockers.

Human-facing bodies, comments, findings, progress details, and
guidance context are Markdown. Keep titles, ids, statuses, branch names, and
other compact labels plain.

Ask the parent/architect for direction via messaging or comments: include the
decision, evidence, impact, and smallest useful answer/options. Architect
escalation to `human_info_needed` is a blocker.

Stay inside the assignment; inspect siblings only through authorized scoped
context.

## Branch, PR, Review

- `attach_branch(head_sha)` once implementation branch exists. Pass `branch`
  only when the package branch pattern is templated or absent.
- `attach_pr(url, head_sha)` after PR creation. Include current check, review,
  or merge metadata in the same call when it is already available.
- Use `sync_pr()` with no state arguments to fetch and refresh only the
  currently attached PR through its provider. Use explicit `url`/`number` only
  to repair missing attachment identity. Put manual canonical state only in
  the schema-validated `recovery` import; never infer freshness from an
  unavailable provider or an unknown state.
- If `review.md` declares a review requirement, use that provider and its
  optional arguments. Review results stay with that provider and the worker
  handoff; Symphony++ does not require a duplicate completion record.
- When that provider is Review Suite, derive one concise Markdown brief from
  the already-scoped WorkPackage resources. Treat the available WorkPackage
  title, engineering scope, allowed file scope, and acceptance criteria as the
  PR-level contract. Include stop conditions only when the assignment context
  supplies them, and the parent title and goal only to explain intent. Pass the
  brief through Review Suite's ordinary `--review-brief` or structured input.
  Do not persist a duplicate goal or add a Review Suite-specific API.
- On a tool-only host, discover the declared provider through its installed native
  entrypoint. For Review Suite, `codex plugin list --json` identifies the enabled
  `review-suite@review-suite` plugin's `source.path`; use its `scripts/review.py`
  with `--cd <worktree>`, the declared mode, base, and review brief. Follow the
  provider's returned actions and report its review id, result, and reviewed head.
  If the declared provider is missing, return that gate to the architect; do not
  install another provider or invent a completion receipt.
- Classify the provider's structured review result before handoff.
  A worker may commit `CONTINUE` only while the frozen WorkPackage contract is
  unchanged. Return findings, contract ambiguity, `REPLAN`, or `RESLICE` to
  the architect. Do not create a replacement cycle or package.
- If `review.md` says no review is required, do not invent one.

## Ready

Before `mark_ready()`:

- Provider-backed branch, PR, current-head state, blockers, and investigation
  findings are current.
- Any external/provider review required by `review.md` is settled.
- Candidate inputs are current and recorded for this dependent head as described
  [below](#candidate-inputs); stale inputs return to qualification, not bookkeeping.
- Do not add task-plan or progress calls only to restate facts already proved
  elsewhere.
- No active blocker remains.
  Human blockers require the architect or trusted local operator.

Return ready or terminal packages to the architect named by `next_owner`; the
worker does not need or receive architect tools for that handoff.

## Candidate inputs

When `read_context()` returns candidate `dependency_selections`, consume only
the current available selection. Verify checks/review for the exact backend input
and your final dependent head; ready state alone is not proof of qualification.
After wiring/technical review, before `mark_ready()`, record the consumed selection
with existing `append_progress` input provenance:

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

Include each consumed candidate constraint, including expanded/overlapping edges.
Use a new idempotency key for a new qualification. Pin/head changes invalidate
affected selections; after requalification append current inputs for your current
head. Unchanged selections on that head remain valid. If the architect clears a
previously consumed pin, wait for prerequisite delivery and record fresh selection
with `candidate_head_sha: null`. Never-pinned edges need delivery only.

Provider-native review/handoff names backend WP/head and final UI head; this
progress payload records inputs, not review completion. Do not copy review receipts.
If an already-ready candidate needs changes or new input qualification, ask the
architect for successor scope; readiness cannot be reopened. A claim transfer does
not authorize contract changes. Technical defects stay fixable; material changes
to approved UX require architect/human guidance and its durable decision reference.

## Safety

Worker grants and local claim leases are scoped to exactly one WorkPackage.
Workers cannot mint keys, approve scope, merge PRs, advance phase state, or use
architect tools. `state_key` preserves initialized MCP handshake continuity
only; the ledger-backed claim is the worker authority.

Never print, store, commit, or paste raw grant secrets, worker secrets,
private handoff payloads, bearer/API/GitHub/Linear tokens, MCP auth tokens,
secret-bearing commands, grant verifiers, or claim lease internals.

## References

- When composing dispatch text: `references/worker_prompt.md`.
- For MCP setup or connection repair: `references/mcp_wiring.md`.
- When preparing the final evidence packet: `references/handoff.md`.
