# Symphony++ Work Package

The parent's assignment is the worker contract. Follow
[symphony-worker](../symphony-worker/procedure.md) to implement, check, review, and return
the PR or direct evidence. The architect owns ledger coordination and acceptance.
No worker MCP call is required to start or deliver work.

## Optional MCP Use

Use these tools only when scoped ledger access adds useful execution context.
The server remains the permission boundary; an assignment alone grants no MCP
write authority.

- In a dedicated MCP-enabled session on the dispatch ledger, claim the assigned
  WorkPackage with `claim_local_assignment({"work_package_id":"<id>"})`.
  Include `claimed_by` only when the parent supplies a stable identity.
  Inside Herdr, the client bridge reports the session location automatically.
  Outside Herdr, optionally add `session_description` to this existing claim,
  for example `"Terminal window: widget implementation"`. Do not add an MCP
  call just to report a location.
- Reuse the returned assignment. Recheck binding with `get_current_assignment`
  only after reconnect, denial, or conflicting identity. A paused or different
  owner requires the parent; never bypass a denial or mint a replacement.
- `read_context` and `read_work_package_document` read current scoped state.
  The latter supports `context.md`, `acceptance.md`, `review.md`, `handoff.md`,
  `findings.md`, `progress.md`, and `task_plan.md`. Histories may have older pages;
  use `next_before_sequence` only when the missing history matters.
- Optional task-plan, finding, progress, comment, branch/PR, and readiness tools
  remain available to authenticated workers. Do not call them just to repeat
  native GitHub, review, or conversational evidence.
- TOON is presentation only. Send schema-native JSON; `structuredContent` is the
  canonical result. Do not use business CLI commands or private ledger files.

Questions stay in the conversation. Workers do not declare or resolve work
blockers. Asking, waiting, or escalating to a human does not change blocker state.
The architect explicitly scopes a blocker to affected work, resolves or escalates
it, and clears it when the issue is settled. A chief routes human decisions when
present.

## Parent Reconciliation

The architect verifies the normal handoff and provider-native evidence, reconciles
PR readiness with `sync_pr`, and owns terminal delivery. Candidate input selections
and qualification stay parent-owned; workers report consumed heads in their native
review/handoff. Do not add duplicate review receipts or worker status ceremony.

Optional observations do not grant execution authority. Missing Herdr/OSC evidence
means last-known or unknown, never a work blocker or permission to take over.

## Safety

Worker MCP grants and claim leases authorize exactly one WorkPackage. Workers
cannot mint keys, approve scope, dispatch siblings, merge PRs, or use architect
operations. A `state_key` preserves initialized transport continuity only.

Never print, store, commit, or paste raw grant secrets, private handoff payloads,
bearer/API/GitHub/Linear/MCP tokens, secret-bearing commands, grant verifiers,
or claim lease internals.

## References

- Assignment template: `references/worker_prompt.md`.
- Optional MCP setup/repair: `references/mcp_wiring.md`.
- Handoff examples: `references/handoff.md`.
