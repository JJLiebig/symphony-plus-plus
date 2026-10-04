# Symphony++ Solo Session

Use Solo Sessions when ordinary single-agent work or parent coordination needs
durable planning memory without WorkRequest or WorkPackage orchestration.
Persistence is optional; ordinary repo work may proceed without a Symphony++
backend when no ledger state is requested.

Do not use this as authority for assigned WorkPackages, WorkRequests,
architect orchestration, bound MCP planning resources, ledger-backed claims, or
merge gates. Use
[symphony-work-package](../symphony-work-package/procedure.md) for WorkPackages and
[symphony-architect](../symphony-architect/procedure.md) for WorkRequest orchestration.

## Source Of Truth

The Solo Session ledger replaces local `task_plan.md`, `findings.md`, and
`progress.md` for this task. Keep entries small and non-secret.
Do not create local `task_plan.md`, `findings.md`, or `progress.md` files for
Solo Session state.

Never store raw API keys, bearer/GitHub/Linear/MCP tokens, worker secrets, raw
WorkKeys, access grants, private handoff payloads, access-grant verifiers,
secret hashes, secret-bearing commands, or claim lease internals.

## Tools

Use configured MCP tools from the `symphony_plus_plus` namespace in an
unbound session for every ledger read and write. The exposed tool names are:

```text
solo_attach
solo_show
solo_list
solo_record_task_plan
solo_append_progress
solo_append_finding
solo_record_decision
solo_report_blocker
solo_resolve_blocker
solo_record_validation
solo_pause
solo_resume
solo_complete
solo_archive
```

If persistence is required and MCP tools are missing, report the unavailable
connection to the parent/operator and recover the dedicated MCP session before
continuing ledger work. Do not substitute shell business commands, direct
SQLite access, or private state files. Shell tools remain available for
installation, startup, diagnosis, upgrade, and connection recovery.

After a connection failure, reconnect and inspect the session with `solo_show`
or `solo_list` before retrying a mutation whose outcome is uncertain. Never
blindly replay it through another interface.

## Attach

Attach once near the start and retain the returned `solo_session.id`.

Derive:

- `workspace_path`: repo root from `git rev-parse --show-toplevel`, else
  absolute current directory.
- `repo`: stable remote slug or directory name.
- `base_branch`: assigned target base, upstream/default branch, or current
  branch as fallback.
- `caller_id`: stable local id like `codex:<repo>:<workspace-leaf>`.
- `title`: short task title.

Call `solo_attach` with:

```json
{"repo":"<repo>","base_branch":"<base>","workspace_path":"<absolute path>","caller_id":"<caller>","title":"<task title>"}
```

## Record

Record only meaningful state changes. Use non-secret idempotency keys.
Entry bodies are human-facing Markdown; keep summaries and status labels plain.

Use the intent-shaped MCP tools:

- `solo_record_task_plan`: phases, strategy changes, current next steps.
- `solo_append_progress`: implementation step, handoff, or status update.
- `solo_append_finding`: durable discovery, root cause, rejected hypothesis, evidence.
- `solo_record_decision`: local technical decision with rationale.
- `solo_report_blocker`: active issue requiring user/operator input.
- `solo_resolve_blocker`: append-only blocker resolution by `blocker_id`.
- `solo_record_validation`: command result, blocked validation, residual risk.

Keep large logs out of the ledger; summarize and reference local files if
needed.

## Read And Lifecycle

Use `solo_show` after pauses, before major decisions, and before final response.
Use `solo_list` to recover active sessions by repo/base/workspace/caller.
Close or move sessions with `solo_pause`, `solo_resume`,
`solo_complete`, or `solo_archive`. The tool reads the current status itself.

Lifecycle:

- `active`: work in progress.
- `paused`: intentionally stopped but resumable.
- `completed`: requested work done and validation/review status recorded.
- `archived`: stale or no-longer-needed history.
