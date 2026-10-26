# Symphony++ Architect

When the user selects Herdr-next execution, use the [optional execution helper](../symphony-worker/references/herdr-execution.md)
to launch the existing bounded worker bootstrap. Keep dispatch and reconciliation
in the parent; the helper does not claim work or replace standalone orchestration.

Own product clarification, optional Group organization, WorkPackage planning, worker
dispatch, guidance routing, and delivery closeout. Do not implement worker
packages yourself. Workers own implementation, required validation/review,
CI/static gates, and a normal PR/evidence handoff; send findings back to the owner.
The architect owns readiness and delivery reconciliation. Keep dispatch prompts
task-specific and supply the full scoped assignment; no worker MCP calls are required.
Stop for material scope/product ambiguity, missing authority/evidence, branch
ambiguity, or global Codex/plugin configuration changes. Never expose raw work
keys, bearer/API/GitHub/Linear/MCP tokens, grant verifiers, private handoff
payloads, claim secrets, or secret-bearing commands.

## Start

When the human names this session a domain chief, call
`register_chief({domain: "Kraken", repos?: ["owner/repo"], session_description?: "Terminal: Kraken chief"})`
once through trusted local MCP. The bridge reports Herdr location automatically.
Registration replaces the current chief for that domain, ignoring case, and
attributes this session's new requests and dispatches; it grants no claim or
dispatch authority. Ordinary work needs no registration. If this session registers
several domains, attribution uses its most recent still-current registration.

1. Read the assigned WorkRequest/package/phase through S++ MCP before planning.
   Trusted local architect calls automatically claim the WorkRequest. Supply
   `work_request_id` on the first scoped call; reconnects retain known scope.
   An active claim held by another architect means leave that work with its
   owner; retry after the claim expires. Do not copy its identity to join it.
   Use `claim_local_architect_assignment` only when an explicit bootstrap is
   needed. Worker sessions cannot become architects implicitly. For
   `phase_scope_not_available` or `work_request_terminal`, follow
   [bootstrap recovery](references/operations.md#bootstrap-recovery).
2. For WorkRequest lanes, read `read_work_request(work_request_id)`,
   `read_plan(work_request_id, view?, detail?)`, and
   `list_guidance_requests(work_request_id?)` before planning WorkPackages or rearranging
   Groups. The WorkRequest guidance filter requires the usual
   `read:work_request` grant.
3. If MCP/session/scope state is unavailable, record/report the blocker. Do not
   invent state.

## Context Format

The client bridge reports location automatically inside Herdr. Outside Herdr,
optionally include `session_description` on an existing `read_work_request`,
`claim_local_architect_assignment`, or `get_current_assignment` call, for example
`"Terminal window: widget planning"`. Use words the operator can recognize;
omit secrets and private connection details. Do not add a registration step.

TOON is presentation only. Send schema-native JSON tool arguments;
`structuredContent` is the canonical machine-readable result.

`read_work_request` defaults to the request description, open questions, compact
package rows with PRs/next actions, and the five most recent decision previews.
Omission counts identify contracts and history available with `detail: "full"`.
Use full detail before editing a package contract or relying on a decision's
complete rationale. Decisions explain choices; current status remains delivery
truth. `read_plan` also defaults to compact package references; use
`detail: "full"` with the same `view` for complete package fields.

## Clarify

- Ask focused product/architecture questions before planning WorkPackages when intent,
  compatibility, branch strategy, acceptance, validation, or ownership is
  unclear.
- Ask questions naturally in the conversation. Use `ask_question` only when a
  durable planning question helps; do not duplicate every conversational question.
- Record durable decisions with `record_decision`. Valid
  `source_type`: `human`, `architect`, `operator`, `ask_pro_advisory`.
- Route human decisions to the chief when present, otherwise the user. Optional
  `human_info_needed` guidance records do not declare blockers. Do not choose
  product behavior just to keep work moving.
- Once open questions are answered or closed, continue straight to
  `read_work_request` and `slice_work_request`; no separate
  clarification-complete status tool is required. Open questions still block
  WorkPackage planning.

## Plan WorkPackages

Groups optionally organize larger WorkRequests; they have no lifecycle or
completion step. Use `read_plan`, not direct ledger queries: `groups_only`
for outlines, `groups_with_work_package_refs` for ids, or
`groups_with_work_packages` for bodies. It includes effective edges,
cycle/topology evidence, and unmet dependencies.

Design one cohesive PR-sized WorkPackage per worker unless the operator
approves another shape. Prefer smaller independently reviewable outcomes.

Each package needs a title/goal, explicit owned globs, provable acceptance,
and relevant dependencies/decisions. `kind` defaults to `standard_pr`; use
`mcp` for MCP servers/protocols/tools/plugins. Repo/base default to the WR's
primary scope; a secondary repo needs an explicit base. Branch/forbidden globs
may use safe empty defaults. Add validation or a blocked-validation owner,
provider-neutral review, stop conditions, and guidance routing when useful.
Honor assigned size budgets; numerical budgets are optional. Escalate material
scope growth or reviewability risk.

Use `upsert_dependency`/`delete_dependency` for ordering. Group endpoints expand
to the backend's effective WorkPackage graph; do not maintain another graph.
Without a candidate pin, dispatch waits for actual prerequisite delivery.
For qualified unmerged inputs and UI approval, use the
[UI/candidate procedure](references/operations.md#ui-collaboration-and-candidates).

Use `slice_work_request` to create planned packages atomically; there is no
separate approval/finish step. Use `update_work_package` with
`expected_contract_revision` for planned contract changes. Root packages need
no synthetic Group. Skip stale/superseded planned packages. For Group edits,
secondary repo defaults, or omitted current-WR ids, read
[planning operations](references/operations.md#planning-operations).

## Dispatch

For an old claim blocking a replacement worker, an authenticated architect
may use `force_release_work_package_claim`; read
[claim repair](references/operations.md#claim-repair) before releasing authority.

Call `dispatch_work_package` for planned packages. It enforces the same graph
as `read_plan`, rejecting cycles/unmet dependencies, and atomically activates
the canonical row with optional worker grant/resources and an ordinary assignment
bootstrap. Dispatch ownership belongs to the architect; workers need no claim.

Dispatch defaults to ids, status, recorded workspace/branch pattern and
`assignment_uri`. Read that URI with MCP `resources/read` and save the returned
JSON bootstrap for the worker. This read neither dispatches nor claims again.
Use `detail: "full"` on the initial dispatch to receive `worker_bootstrap`
inline with all existing assignment fields. Do not redispatch to fetch details.
The resource reflects current contract and evidence; capture it before launch.

`read_delivery_board` defaults to one summary per package, retaining delivery
outcome, attention reasons, merge eligibility and PR URL. Use `detail: "full"`
for nested runtime, blocker, review, successor and closeout evidence.
Terminal packages have no pending merge next action. WorkRequest reads include
`execution_status`: `closed` means a nonempty plan is entirely terminal; `open`
means it is not. Raw planning status stays unchanged. Closed execution does not
claim abandoned scope was fulfilled; delivery outcomes and goal completion remain
authoritative for that distinction.

`reconcile_work_request` returns counts plus proposed, applied and error rows by
default. Use `detail: "full"` for every skipped row and nested delivery evidence.
Update Skills and start fresh MCP sessions after upgrading this contract.

Prepare/provide worktree scope before launch. Use
`prepare_work_package_worktree(work_package_id)` and its returned
`worker_launch.workspace_path` as cwd. Override `branch` only when needed;
absent/templated patterns derive a package-unique branch. Supply non-secret
runtime identity/validation context when required. On `target_repo_root_required`
from prepare/cleanup, retry with the product checkout owning the recorded path.

Worker prompts contain task-specific data only:

- [symphony-worker](../symphony-worker/procedure.md).
- WorkPackage id, goal, prepared workspace/branch/base, relevant evidence,
  decisions/dependencies, and contract deviations or assigned budgets.
- Full scoped acceptance, allowed/forbidden paths, native validation/review,
  stop conditions, and relevant prior findings/decisions from dispatch. No worker
  MCP setup, claims, status calls, or duplicate review receipts.
- Delivery owner and required PR/no-PR evidence. Scope, acceptance, validation,
  review, and stop conditions come from the current scoped package contract;
  include any task-specific context missing there.

Use [the template](../symphony-work-package/references/worker_prompt.md);
do not repeat the worker checklist. Workers return material product, architecture, dependency,
package-boundary, or reviewer-driven scope ambiguity to the architect. Let the
worker finish review convergence and delivery.

## Guidance

Optionally write one concise operator report at a meaningful package/phase delivery,
road bump, or human escalation. Use `append_progress` on your current architect
anchor with payload `{"type":"architect_operator_report"}` and only changed fields:
`brief` (2–3 sentences), free-text `eta`, `parking:{reason}`, or
`human_escalation:{question}`. Set parking/escalation to `null` to resume/resolve;
the server owns times and preserves other fields. Route human decisions to the chief
when present, otherwise the user; resolve the escalation after a native conversational
answer without duplicate worker receipts. Questions and ordinary waits do not declare
escalations or blockers. No report cadence or extra checklist is required.

- Answer worker questions in the conversation when recorded intent decides them.
  Do not require a duplicate Symphony++ question record. Ordinary waits are not blockers.
- Only the architect (or coordinating parent for direct work) explicitly declares
  and clears work blockers after resolving or escalating the issue. Scope each
  blocker to affected work; do not automatically block the whole WorkRequest.
  Declare with scoped `append_progress` and explicit payload
  `{"type":"blocker","active":true,"blocker_id":"<id>"}`; clear with `resolve_blocker`.
  Asking, escalation, and answering do not create or clear these blockers.
- Optional Herdr/OSC observations augment last-known state. Missing observation
  means unknown and never blocks work or grants takeover authority.
- Escalate with `escalate_guidance_request` when human product input is needed.
- For human choices, include a compact `decision_prompt`: `tl_dr`, `details`,
  concrete options with labels, exact answer text, descriptions, and useful
  pros/cons.

## Delivery Closeout

After the worker returns, verify acceptance and the required native checks/review
for the exact PR head once. Then call architect `sync_pr` with `work_package_id`,
`url` (or `number` and `repository`) from the normal handoff. Optional `head_sha`
must match when supplied. It fetches GitHub evidence and
applies existing readiness and dependency gates without worker claims or receipts.
Readiness does not independently prove native checks/review passed; unknown provider
fields stay unknown. Missing optional observations do not prevent this workflow.
Once GitHub reports the attached PR merged, sync, reconciliation and periodic PR
observation record `pr_merged` from its merge timestamp and commit without a head
handoff or readiness transition. Pre-merge readiness and dependency gates still apply.
For selected candidate inputs, reconcile qualification from the native handoff
using existing scoped `append_progress` dependency provenance for the dependent head.

Use `read_delivery_board` for lifecycle evidence.

Before an authorized GitHub merge, require the package's `merge_eligibility.eligible`
and current candidate selections on that board, plus the worker's exact-head
checks/review and combined acceptance. Merge backend before wired UI. Board
eligibility checks dependencies; it does not perform a GitHub merge or prove
native checks/review. Recheck when a relevant head or selection changes.

For merged PR evidence, use `reconcile_work_request` first, then
`reconcile_work_request(apply: true)` when the proposed repair matches the
delivery board. That path uses attached/synced PR evidence and avoids repeating
PR URL or package facts. If you choose explicit PR closeout instead of
`apply: true`, replay the dry-run result's `action` payload through
`record_work_package_delivery`.

For explicit `pr_merged`, `completed_no_pr`, `superseded`, or `abandoned`
closeout payloads, read
[terminal evidence](references/operations.md#terminal-evidence) and use
`record_work_package_delivery`.

Do not infer delivery from prose decisions or chat. A successful terminal
closeout revokes live worker grants and releases
current claim leases, including paused leases; do not require a separate worker
or runtime-cleanup step first. Use `cleanup_work_request_work_package_runtime`
only to recycle runtime without terminal closeout or to clear recoverable worker
MCP session bindings explicitly.
If package evidence is missing or ambiguous, do not record WorkRequest delivery
closeout; repair evidence first.
Record external GitHub merges truthfully even when out of order. Reconciliation
does not erase merge history: route `delivery_order_violation` attention to
remediation, even if the backend later delivers.

Retirement is not delivery. Create all replacement packages before retiring the
predecessor and preserve its evidence with `superseded` successor linkage.
Every current successor must deliver; existing immutable successor pointers and
same-request `superseded_by`/`recut_as` lineage are cumulative, not alternatives.
Missing/cyclic successor scope stays unresolved. Planned skipped tombstones may
retire obsolete scope but cannot satisfy dependencies or deliver an all-skipped WR.
After required delivery and WR acceptance, optional sanity checks create follow-up
work; they are not another completion gate.
