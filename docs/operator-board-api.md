# Operator board API

`GET /api/v1/sympp/operator/dashboard/hydrated` returns the current board in one
response. Existing fields retain their meaning. Read each entry of
`work_request_details[].work_packages[]` for these additive fields:

| Field | Meaning |
| --- | --- |
| `board_state.stage` | `queued`, `build`, `checks`, `review`, `merge`, or `done`. |
| `board_state.entered_at` | Evidence-backed stage time, or `null` when unavailable. |
| `board_state.source` | `dispatched`, `recorded_status`, `recorded_delivery`, `created`, `recorded_pr`, or `provider`. |
| `board_state.track` | `pr` when a PR exists or the package contract requires merging; otherwise `no_pr`. |
| `board_state.outcome` | Canonical recorded delivery outcome, when present. |
| `board_state.delivered` | Whether the package merged or completed without a PR. |
| `pr_signal.created_at` | GitHub PR creation time, when available. |
| `pr_signal.updated_at` | GitHub PR update time; this is not a stage-change time. |
| `pr_signal.observed_at` | Stored provider snapshot observation time, when available. |
| `pr_signal.head_changed_at` | First observed time of the current PR/head, recorded on snapshot append. |
| `pr_signal.checks.changed_at` | First observed time of the current check status for that PR/head. |
| `review_signal.mode` | Native provider mode, falling back to the configured requirement. |

Review progress remains in `review_signal.step`, `current`, `total`, `round`,
`evidence_id`, `reviewed_head`, `started_at`, `round_started_at`, `observed_at` and
`observation_state`. `pr_signal.checks.status` remains `passing`, `pending`,
`failing`, or `unavailable`; missing checks never imply success.

A dispatched package is building from `dispatched_at`, without worker reports,
runtime observations, or a reporting cadence. Native review observations augment
this state. A recorded `superseded` or `abandoned` outcome has a null stage and
`delivered: false`. A legacy lifecycle status may identify a stage without an
entry time: unrelated package updates never supply that time. Review uses the
known round/start time. Checks stage entry remains null because a status snapshot
cannot establish review-to-checks re-entry; read `checks.changed_at` separately. These are
observations, not reconstructed transition history. Repeated snapshots with the
same PR/head/check status preserve timestamps; a changed head or PR resets them.
Existing snapshots acquire these times on their next append. Reads never write
observations or complete a WorkRequest.

Example package fragment (invented repository):

```json
{
  "id": "wp-widget",
  "board_state": {
    "stage": "checks", "entered_at": null,
    "source": "provider", "track": "pr", "outcome": null, "delivered": false
  },
  "pr_signal": {
    "status": "open", "repository": "example-org/widget-service", "number": 42,
    "created_at": "2026-10-01T09:05:00Z", "head_sha": "abc123",
    "head_changed_at": "2026-10-01T09:10:00Z",
    "checks": {"status": "pending", "changed_at": "2026-10-01T09:10:00Z"}
  }
}
```

Use `work_request_details[].product_tree`: `root_node_ids` and each node's
`parent_id` describe nesting; `position` orders siblings, while `root_node_ids`
provides the ordered root identifiers. Nodes include empty groups and `work_package_ids`; root packages appear
in `root_work_package_ids`. WorkRequest `completed_at` remains the canonical
delivery time. Deploy observations and repository default branches are not
included by this change.

`GET /api/v1/sympp/operator/events` is a notification-only server-sent event
stream for the same locally authorized browser as the dashboard. It emits
`ready` on connection, `invalidated` after known dashboard changes, and heartbeat
comments. Refetch the hydrated endpoint after either event. Connecting does not
register a dashboard opener or mutate business state. The existing
`/api/v1/sympp/herdr/events` consumer endpoint remains available. Notifications
are hints, not durable history; compare saved client-side timestamps and heads
for best-effort "since last looked" indicators.

## Finished goal retention and operator actions

`settings.work_request_archive_after_days` stays an integer day setting, now
defaulting to `3` (72 elapsed hours after `completed_at`, including the exact
boundary). Only completed goals qualify. The background retention pass runs
every 30 minutes; saving operator settings forces an immediate pass. Dashboard
reads do not run retention. Archiving happens on the next successful pass
after the threshold, rather than on an exact per-goal timer. The existing limit
of ten visible completed goals per repository/base branch can archive older
completed goals sooner.

On upgrade, the normal ledger migrations convert stored archive settings of
`14` to `3`, preserving all other values (including `1`) and settings. An explicitly chosen
`14` is indistinguishable from the former default and also converts; choose
`14` again after upgrading to retain it. The migration cannot safely reverse
that data conversion. No manual database edit is required. Already overdue
completed goals qualify on the next retention pass. The same setting also
controls hiding terminal packages without a parent goal. Archived goals retain
their history until deletion; the existing deletion setting
`solo_session_delete_after_days` also governs archived goals (default 30 days).

These existing POST routes require local operator authorization:

| Route suffix under `/api/v1/sympp/operator/work-requests/:id` | Preconditions and consequences |
| --- | --- |
| `/state` with `{"state":"completed"}` | Operator override; no delivery or inactive-worker precondition. Marks the goal complete, clears its archive state and open questions, clears package attention and queues terminal package worktree cleanup. Does not stop workers or merge PRs. Confirm the override when work is still running. |
| `/archive` | Requires completion after refreshing current evidence; otherwise returns `not_completed`. Hides the goal and queues terminal package worktree cleanup. History remains. |
| `/delete` | Requires only that the goal exists; archive and completion are **not** backend prerequisites. Permanently removes the goal and dependent ledger history/comments/grant scopes and queues linked worktree cleanup, including nonterminal packages. Confirm deletion and finish or stop active work first; it is not a safe unconditional one-click action. |
| `/restore` | Requires an existing goal. Refreshes completion, clears archive state and, for a still-completed archived goal, resets `completed_at` to give it a new retention window. Does not restore deleted worktrees or undo queued cleanup. |

Worktree cleanup runs asynchronously and defers active or paused workers while
their package records exist. Deleting those records removes that activity check,
so deletion must not be treated as a way to stop a running worker.
