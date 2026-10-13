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

The packaged board subscribes to `GET /api/v1/sympp/operator/dashboard/events`
instead. That stream emits `dashboard_changed` after the same changes and
registers the open board, so the backend does not open a second one when a
client attaches.

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
controls hiding terminal packages without a parent goal. Completed archived goals
retain their history until deletion; the existing deletion setting
`solo_session_delete_after_days` also governs those archives (default 30 days).

## Never-started goal retention

`settings.work_request_never_started_archive_after_days` defaults to `30` elapsed
days, configurable from 1 to 3650. A goal qualifies when it has no recorded package
dispatch or delivery, including historical evidence. Claimed architect anchors,
worker claims, runs and legacy execution states also protect started goals even
when their packages are dormant or no longer dispatched. An unclaimed planning
anchor or merely planned package does not count as execution.

Age starts at goal creation; edits do not reset it. At the exact threshold the
next successful retention pass archives the goal with `archive_reason:
"never_started"`, leaving `completed_at` null and its status unchanged. It leaves
the board and appears in `archived_work_requests`; its archive card operational state
is `archived` / `Archived`, rather than completed. Restore clears the archive and
starts a fresh full threshold window from restoration. Increasing the setting
does not automatically restore an existing never-started archive.

This rule neither queues worktree cleanup nor deletes ledger history. Archives
with this reason are excluded from subsequent automatic archived-goal deletion,
so they remain restorable indefinitely. Explicit operator deletion retains its
existing destructive behavior. Finished-goal retention, the ten-visible-completed
limit, and the existing deletion threshold are unchanged.

The migration adds the setting without changing existing settings. On the first
successful pass, existing unfinished goals at least 30 days old with no persisted
execution evidence qualify; newer or previously started goals stay visible.
No production ledger was inspected to establish an actual qualifying count.

Change the setting through the local operator API (replace the base URL with
the running dashboard's origin):

```powershell
$origin = "http://127.0.0.1:4000"
Invoke-RestMethod -Method Post -Uri "$origin/api/v1/sympp/operator/settings" `
  -Headers @{Origin = $origin} -ContentType "application/json" `
  -Body '{"work_request_never_started_archive_after_days":45}'
```

Saving settings forces an immediate pass; otherwise the background cadence is
30 minutes. Dashboard reads remain read-only. No new UI control is included.

## Operator actions

These existing POST routes require local operator authorization:

| Route suffix under `/api/v1/sympp/operator/work-requests/:id` | Preconditions and consequences |
| --- | --- |
| `/state` with `{"state":"completed"}` | Operator override; no delivery or inactive-worker precondition. Marks the goal complete, clears its archive state and open questions, clears package attention and queues terminal package worktree cleanup. Does not stop workers or merge PRs. Confirm the override when work is still running. |
| `/archive` | Requires completion after refreshing current evidence; otherwise returns `not_completed`. Hides the goal and queues terminal package worktree cleanup. History remains. |
| `/delete` | Requires only that the goal exists; archive and completion are **not** backend prerequisites. Permanently removes the goal and dependent ledger history/comments/grant scopes and queues linked worktree cleanup, including nonterminal packages. Confirm deletion and finish or stop active work first; it is not a safe unconditional one-click action. |
| `/restore` | Requires an existing goal. Clears archive state. A never-started archive gets a new threshold window without completion; a still-completed archive resets `completed_at`. Does not restore deleted worktrees or undo queued cleanup. |

Worktree cleanup runs asynchronously and defers active or paused workers while
their package records exist. Deleting those records removes that activity check,
so deletion must not be treated as a way to stop a running worker.

## Session locations

The hydrated response adds `architect_session_location` to both
`work_requests.work_requests[]` and `work_request_details[].work_request`.
`work_request_details[].work_packages[].session_location` keeps its existing
machine `label` and `kind` meanings and gains the fields below for observed
MCP sessions. Fields are absent when there is no observation or existing
configured worker-session label. Existing configured labels remain supported.

| Field | Meaning |
| --- | --- |
| `machine_id` | Client hostname, trimmed and lowercased; independent of the display label. |
| `label` | `machines[machine_id].label`, otherwise the client hostname. |
| `kind` | Configured `desktop`, `laptop`, or `server`; `null` when unknown. |
| `role` | `architect`, `coordinator`, or `worker`. |
| `source` | `herdr`, `agent` (human description), or `machine` (hostname only). |
| `description` | Optional human-readable location supplied by the agent. |
| `last_seen_at` | UTC time of the latest successful scoped MCP tool call reporting this session. |
| `herdr` | Workspace, tab and pane ids, with workspace/tab labels when obtainable; empty outside Herdr. |

A claimed architect's observation takes precedence over a coordinator fallback.
The fallback is established only by the client that creates the WorkRequest;
later successful calls scoped to that same WorkRequest refresh it. Reading
somebody else's goal does not adopt its location. Worker locations come from
the authenticated package assignment. Locations are last known addresses, even
after a session ends: neither a recent timestamp nor a retained address proves
liveness. No arbitrary live/stale threshold is applied. Dashboard reads never
advance `last_seen_at`.

Example hydrated response fragment (invented names):

```json
{
  "work_request_details": [{
    "work_request": {
      "id": "wr-widget",
      "architect_session_location": {
        "machine_id": "planning-desk", "label": "Planning Desk", "kind": null,
        "role": "architect", "source": "agent",
        "description": "Terminal window: widget planning",
        "last_seen_at": "2026-10-13T09:00:00.000000Z", "herdr": {}
      }
    },
    "work_packages": [{
      "id": "wp-widget",
      "session_location": {
        "machine_id": "build-desk", "label": "Workshop", "kind": "desktop",
        "role": "worker", "source": "herdr", "description": null,
        "last_seen_at": "2026-10-13T09:01:00.000000Z",
        "herdr": {"workspace_id": "w1", "workspace_label": "Widget Service",
                  "tab_id": "w1:t2", "tab_label": "Implementation", "pane_id": "w1:p3"}
      }
    }]
  }]
}
```

The per-client Node bridge and PowerShell fallback capture `HERDR_ENV=1`,
`HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, and `HERDR_PANE_ID` from their own launch
environment. This works for any MCP client using the packaged launcher,
including architect, coordinator, and worker sessions. The shared backend's
environment is never used to identify the caller. A best-effort read-only
`herdr api snapshot` supplies labels and native session identity, refreshed at
most once a minute with a one-second timeout. Missing labels do not prevent
capture. No agent action is required inside Herdr.

Outside Herdr, add the optional `session_description` string to an existing
`create_work_request`, `claim_local_architect_assignment`,
`claim_local_assignment`, `read_work_request`, or `get_current_assignment`
call. It is retained for that client. A description does not claim ownership of
an existing goal. The coordinator fallback requires the goal to have been
created by that same client; a fresh bridge cannot adopt it by reading the goal
or supplying a description. Architect and worker locations resume through
their normal assignment claim, with a description supplied again for the new
client. No dedicated registration or worker MCP ceremony is required.
Direct clients can provide the same private transport metadata at
`params._meta.sympp_session_location`; the packaged bridge fills it automatically.
Descriptions without bridge metadata still work, with an unknown machine.

Machines need no registry entry: the first location is enough to display one.
Rename a machine through the existing `operator-board.json` map, for example
`"machines":{"build-desk":{"label":"Workshop","kind":"desktop"}}`.
The next dashboard read applies the rename to existing observations without
re-registration. Hostname changes create a different machine id; identical
hostnames on different machines cannot be distinguished by this best-effort id.
Herdr session selectors, socket paths, native session identities and client
identifiers are private persistence fields and never appear in this response.

Both backend and client bridge must contain this change. Merging into `beta`
alone does not upgrade installed artifacts or already running bridges. After a
build containing the change is published, use the normal marketplace-backed
plugin upgrade and start a fresh MCP connection/session. Do not refresh an
installed cache from a developer checkout. Existing agents begin reporting on
their next successful scoped call through the updated bridge; historical
addresses cannot be reconstructed. No release or cache upgrade is part of this PR.

## Focus an agent session

`POST /api/v1/sympp/operator/work-packages/:id/focus` focuses the package's worker.
`POST /api/v1/sympp/operator/work-requests/:id/focus` focuses the goal's architect,
or its recorded coordinator when no architect has reported a location.
Both accept an empty JSON body and require the same local browser authorization
and Origin checks as other operator actions. Unknown body fields are ignored.

Example (invented package):

```http
POST /api/v1/sympp/operator/work-packages/wp-widget/focus
Origin: http://127.0.0.1:4000
Content-Type: application/json

{}
```

```json
{"ok":true,"status":"focused","reason":null}
```

An unavailable session returns HTTP 200 with `ok: true`, `status: "not_focused"`
and one of these `reason` values; the board can show the corresponding explanation:

| Reason | Meaning |
| --- | --- |
| `session_gone` | No recorded location or no currently recognized agent with that exact identity. |
| `not_in_herdr` | The session reported a description or machine without a Herdr address. |
| `other_machine` | The session is on a different machine from the backend; remote focus is unsupported. |
| `herdr_unreachable` | The Herdr CLI or selected session is unavailable, timed out, or returned an unreadable answer. |
| `identity_mismatch` | Multiple matching sessions or identity changed during focus; no success is claimed. |

The backend uses the recorded Herdr session/socket selector, searches a fresh
snapshot for a unique native session identity (or the client's exact role and
goal/package binding), and focuses the matching current pane. Stored pane IDs
alone are never sufficient. A moved pane can still be found; a reused pane does
not identify the previous session. Herdr must currently recognize an agent,
because its native session reference can outlive that agent.

The installed Herdr CLI must be available through `HERDR_BIN_PATH` or the
backend's PATH. A probe and a focus each have a five-second timeout. This selects
the pane within Herdr; it does not launch Herdr or guarantee operating-system
window activation. Herdr has no conditional identity-and-focus operation, so a
session can change between verification and focus. The returned identity is
checked again before reporting success, but this cannot undo a focus that raced
with an occupant change.

Focusing sends no input and does not register a location, refresh its timestamp,
write ledger/audit state, or publish a dashboard invalidation. The offline beta
sandbox returns HTTP 403 before any ledger read or Herdr probe. Authorization
failures retain the operator API's HTTP 401 response.
