# Security

The MCP server is the permission boundary. Skills, prompts, hooks, and the
dashboard improve workflow but cannot grant authority.

## Claims

- Ordinary workers need no MCP calls. Optional worker MCP access claims exactly
  one WorkPackage; the architect owns dispatch and delivery coordination.
- An architect claims exactly one WorkRequest.
- Trusted local architect calls acquire or recover the claim automatically
  when the WorkRequest is known. Read-only browsing does not claim work.
- `claimed_by` is an optional audit label, not a secret.
- Repository, branch, worktree, phase, and anchor values are derived from the
  ledger and treated as validation context when supplied.
- Fresh claims block competing workers and architects; stale unpaused residue can be
  reclaimed; paused claims remain operator-controlled.

## Capabilities And Scope

Authenticated workers may optionally update their own plan, progress, findings,
comments, branch, pull request, and readiness evidence. Only architects declare
and resolve work blockers; questions and ordinary waits do not change them. They cannot mint grants,
dispatch siblings, expand scope silently, merge pull requests, or record
WorkRequest delivery.

Architects may clarify and plan their WorkRequest, organize Groups, author and
dispatch WorkPackages, answer descendant guidance, approve allowed scope
expansion, and reconcile delivery. They do not gain global ledger authority.

## Secret Hygiene

Never place raw API keys, bearer tokens, GitHub or Linear tokens, MCP tokens,
grant verifiers, secret hashes, private handoff payloads, or secret-bearing
commands in:

- Agent prompts or durable ledger prose.
- Documentation, comments, pull requests, or reviews.
- Dashboard payloads or normal tool output.
- Logs, fixtures, or copied plugin assets.

Report missing secret-dependent validation as blocked. Do not substitute real
credentials into examples.

## Incidents

For suspected permission widening or secret exposure, follow
[Security incident response](runbooks/security-incident.md).
