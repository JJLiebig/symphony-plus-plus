# Handoff Format

For no-PR work, provide direct evidence and say it should close as
`completed_no_pr`, not `merged`. Mark inapplicable fields explicitly; use
`not assigned` when there is no WorkPackage.

```markdown
## Handoff

WorkPackage: <id or not assigned>
Status: <status>
PR: <url or no PR>
Head SHA: <sha or not applicable for policy-approved no-PR work>

### What changed

<Changes and changed files, or direct evidence for no-PR work>

### Acceptance criteria evidence

<Evidence for each criterion>

### Consumed inputs (when candidate dependencies apply)

<Human-approved decision IDs; dependency edge/backend WP and exact consumed head;
final dependent head; progress selection reference and affected requalification>

### Tests and static checks

<Commands, results, tested revision, reused evidence, and blocked/unrun requirements>

### CI/check status

<Current-head check status and evidence, exact failures, or explicitly no CI>

### Review evidence

<Required provider-native review result, identifier/link, and reviewed head;
or explicitly no review required>

### Findings / risks

<Residual risks and unresolved findings, or none>

### Explicitly out of scope
```
