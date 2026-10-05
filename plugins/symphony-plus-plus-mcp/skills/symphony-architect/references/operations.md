# Architect operations

Read only the section needed for the current operation. Normal dispatch and
delivery invariants remain in `../SKILL.md`.

## Bootstrap recovery

A local architect claim can recover stale handoff scope when the ledger proves
one matching WorkRequest, repo, base branch, anchor, and grant. For
`phase_scope_not_available`, follow returned `missing_evidence` and `action`.
For `work_request_terminal`, ask the local operator to restore the WorkRequest
or start a new one. Do not invent state or bypass a binding denial.

## Planning operations

After claiming a WorkRequest, current-WR lifecycle tools may omit
`work_request_id`: `slice_work_request`,
`update_work_package`,
`upsert_group`,
`delete_group`,
`upsert_dependency`,
`delete_dependency`, and
`skip_work_package`, plus delivery board/reconcile, work-package
delivery closeout, runtime cleanup, worker-key revocation, and dispatch. Keep
intentional sibling reads, status/question tools, durable decisions, and package
tools explicit.

`slice_work_request` atomically creates one or more planned canonical
WorkPackages. The selected WorkRequest supplies the default primary delivery
repo and target base branch. Pass the target base branch with a secondary
  delivery repo. Package kind defaults to `standard_pr`; title, goal, owned
  globs, and acceptance criteria remain explicit. Validation steps and stop
  conditions are optional context.
Assign `group_id` only when the WorkPackage belongs in a real Group; root-level
WorkPackages need no synthetic wrapper Group.

Use `update_work_package` with `expected_contract_revision` to edit a planned
contract or move it between the WorkRequest root and an existing Group.

Use `upsert_group` for create, rename, reparent, and reorder. `delete_group`
ungroups its direct WorkPackages and child Groups into the deleted Group's
parent and removes dependency intents that named it. Groups never need manual
completion or blocker closeout.

Skip stale or superseded planned WorkPackages. The atomic planning call advances
the WorkRequest to its planned state; there is no separate approval or finish step.

## Claim repair

If a replacement worker is blocked by an old claim, call
`force_release_work_package_claim` with `work_package_id` and `reason`, then
retry `claim_local_assignment`. Any authenticated architect can release a
worker claim across WorkRequests, including active or paused claims. The old
worker loses session authority; package status and delivery evidence stay intact.

## UI collaboration and candidates

Use this lane when human UI iteration establishes product intent. Chief ownership
and a dedicated technical UI reviewer are optional; model/provider/host choice
does not determine role. Ordinary workers still own their review cycle.

1. Record explicit human UX approval with `record_decision(source_type: "human")`
   or `answer_question_and_record_decision`. Capture behavior, states, acceptance
   and required data/API shape. Reference the returned decision ID in downstream
   package contracts and dependency `decision_ref`; a prototype is not wired delivery.
2. Use `slice_work_request` for bounded backend/API and wiring/review packages;
   create all successors before retiring replaced scope. Keep approved UX intact
   while fixing technical defects. Route material intent changes to architect/human
   guidance; only affected work waits.
3. When the collaborator finishes and another actor will own technical review,
   first obtain its final head, approved decision IDs, checks/review references,
   unresolved findings and explicit fix owner. Stop its mutations, then transfer an
   active package through [claim repair](#claim-repair): architect releases the old
   claim, reviewer claims the same WP and reads its context/history. Confirm the
   new claim before continuing. This changes execution authority, not the contract
   or readiness. Do not leave two actors writing. A separate review package must
   name its implementation owner; already-ready changed work needs a successor.
4. Verify the backend worker's exact-head checks and native review handoff, then
   set `upsert_dependency(candidate_head_sha: "<40-character backend head>")`
   with a concrete prerequisite WP and the wiring WP or Group as dependent.
   The backend must be `ready_for_merge` with current matching branch/PR head;
   ready state alone is not qualification. `read_plan` exposes expanded constraints;
   overlapping pinned/unpinned edges all apply. A prerequisite Group cannot name
   one candidate. Across repositories use these explicit edges, not a Git branch stack.
5. Dispatch the wiring/review worker against that selection. Its native handoff
   names both backend pin and final UI head; it records consumed inputs through
   the [WorkPackage procedure](../../symphony-work-package/SKILL.md#candidate-inputs)
   before readiness. Requalify only evidence whose relevant inputs changed.
   Repinning A to B never revives A's consumed evidence. Clearing a consumed pin
   also requires fresh selection after prerequisite delivery.
6. Ready candidates are immutable. If backend or UI candidate A must change,
   create replacement B, preserve A's evidence and retire it with successor linkage,
   then qualify B through the normal worker path. Select the successor backend WP
   and head on affected dependencies; a ready dependent needs its own successor
   for requalification. Never reopen readiness or copy a review receipt.
7. Accept the combined candidate, then follow the
   [pre-merge delivery checks](../SKILL.md#delivery-closeout). Backend delivery
   precedes wired UI merge; a pinned head must still match after backend delivery.

## Terminal evidence

Record other terminal outcomes with `record_work_package_delivery`:

- `outcome: "pr_merged"`: `evidence` is
  `{"pr_merged":{"pr_url":"...","pr_merged_at":"...","merge_commit_sha":"..."}}`.
  `pr_number` and `pr_repository` are optional inside `pr_merged`.
- `outcome: "completed_no_pr"`: `evidence` is
  `{"completed_no_pr":{"no_pr_evidence":"..."}}`.
- `outcome: "superseded"`: `evidence` is
  `{"superseded":{"successor_work_package_id":"...","superseded_reason":"..."}}`.
- `outcome: "abandoned"`: `evidence` is
  `{"abandoned":{"abandoned_rationale":"..."}}`.
