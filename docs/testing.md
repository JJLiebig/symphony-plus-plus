# Testing

Native acceptance uses TesterArmy e2e against candidate source. Build in the
hosted runner using the toolchain in `elixir/mise.toml`. Put its native binaries
on `PATH` before isolating runtime homes. Set `MIX_HOME` to a disposable build-tool
directory and `MIX_ARCHIVES` to its `archives` subdirectory; install Hex and Rebar
there with `mix local.hex --force` and `mix local.rebar --force`. Run
`mix deps.get` and `mix compile --warnings-as-errors` in `elixir/`, install the
root lock with `npm ci --ignore-scripts`, then run:

```text
ACCEPTANCE_CHECKOUT_SHA=$(git rev-parse HEAD) npm run test:e2e
node scripts/acceptance/check-report.mjs
```

The `api` target has no browser, engine, executor, or model. It fixes workers to
one, retries to zero, and cache to strict read-only. No recordings are needed.
Without a configured model, accidental agent acquisition fails before model
transport is constructed. Hosted acceptance supplies `E2E_OAUTH_CREDENTIALS={}`
and no provider credentials.

The bootstrap journey starts two real `mix sympp.mcp` processes with nonexistent
temporary homes and separate SQLite paths. It checks protocol initialization,
health, version, candidate revision, and independent ledger identities. Children
receive an explicit environment allowlist and stop before their temporary trees
are removed. This qualifies the candidate STDIO boundary; installed launcher and
Windows process qualification remain separate gates.

Factory journeys start the candidate cockpit on an ephemeral loopback port with
a separate disposable SQLite ledger. They use real HTTP MCP clients for request
creation, architect claims, clarification, decisions, plan edits, grouping,
repository scope, dependency refusal, ordinary dispatch, and explicit blockers.
Human choice validation also exercises the public operator answer route with its
required same-origin header and reads persisted answers through MCP. The cockpit
uses a dashboard origin without opening a browser or building UI assets. No worker
process, worker MCP claim, live provider, or model is required for dispatch proof.
Each candidate retains a separate process log and exits before its temporary
ledger/home is removed.

Delivery journeys place a test-only `gh` subprocess on the candidate child's PATH.
It forwards actual argv to a controlled loopback HTTP provider and returns its
JSON and exit status. The factory and GitHub adapters run unchanged. This proves
adapter behavior and the external CLI protocol, not the real `gh` implementation,
GitHub HTTP compatibility, or live provider operation. No provider credentials
are supplied. MCP drives dispatch, dependency selection and reconciliation;
public operator reads observe stored qualification and request completion.
Provider and MCP receipts accompany the process logs, including failed calls.

Authority and recovery journeys use two real candidate clients for claim
contention, scoped requests, reconnects, revocation, terminal delivery, and an
actual backend restart. Candidate MCP worker claims are synthetic test clients;
they start no managed worker agents. Offline denial uses the supported snapshot
operation on the disposable ledger. Diagnostic checks opt into failed-call
capture through operator settings and inspect redacted responses, process output,
and aggregates before disabling capture again.

Grant expiry and lease pause cannot be configured through these public routes.
Keep their precise lower-level security checks, along with inaccessible historical
guidance, stored authority, and transaction qualifications. A repository-backed
failed-call journey does not qualify health calls that lack the selected ledger
context. Report that diagnostic limitation separately.

The `native acceptance` job is an explicit dependency of `make-all`. Legacy
checks remain required until the owning acceptance journey replaces their
guarantees. Preserve unique storage, concurrency, authority, process, and live
provider contracts; live external qualification remains opt-in. Define expected
outcomes from requirements or external contracts before writing replacements.
Remove implementation-shape assertions and same-guarantee duplicates only with
their owning conversion.

Keep mixed authority, historical storage, concurrency, and delivery suites when
they prove distinct boundaries. Sequential authorized clients do not prove grant
denial matrices, SQLite contention or historical migrations. A current architect
escalation report does not replace stored-guidance authorization and transaction
checks. Preserve those distinctions in the per-definition conversion evidence.

Retain `.e2e/report.json`, traces, process logs, checkout/head/base revisions,
commands, and job timings as hosted artifacts. Distinguish literal definitions
from executed cases and logical guarantees, and handwritten support from
generated reports or replay cache. Report failures, skips, retries, and model
calls/tokens explicitly. Inventory and conversion measurements belong in PR
evidence, not current product guides.

On workstations subject to the runtime execution prohibition, all code
validation runs on GitHub-hosted CI. Local source/Git reads and edits remain
available. Do not run tests, builds, formatters, launchers, or runtime probes.

## Retention, Solo and worktrees (B2)

Retention journeys use public operator settings and lifecycle actions against
disposable candidate ledgers. Age fixtures stop the candidate before changing
timestamps; they never manufacture completion, archive, claims or dispatch.
Solo journeys exercise persistent entries, lifecycle, redaction and inactivity.
Exact time boundaries, historical migrations and precise contention remain
separate hosted storage checks.

Worktree journeys use real disposable Git repositories. They prove preparation,
replay, current remote bases, deliberate owned dirty cleanup, unsafe target
refusal and explicit recovery after a queued removal failure and restart.
The cockpit fixture does not start the background cleanup reconciler, so its
startup, scheduling and detached deletion obligations retain dedicated hosted
checks. Historical ownership, preflight persistence failure, Cargo target safety
and Windows partial removal remain separate qualifications.

## Operator board and inspector (B3)

The browser lane uses hosted-built candidate assets and real disposable candidate
MCP state. Operator settings, intake, archive and restore use the live backend;
restore currently has no board control. Controlled GitHub and review-status
programs qualify discovery, command and parser behavior, not live providers or
the owning package's actual FAST review. The same-origin asset proxy does not
qualify origin denial; keep the endpoint's security checks.

The assigned worker's bounded recording exception uses unchanged actual hosted
GET captures for read/navigation only. It rejects mutations and never emulates
state transitions. Luna low uses the existing login; generated native cache is
committed unchanged. Final hosted replay loads no GET transcript and uses the
live candidate backend. Native strict read-only cache and zero retries combine
with a public model identity whose generation/stream methods throw before
transport. Hosted replay constructs no provider or OAuth client. Require suite
success, every required agent action self-finalized, zero model calls/tokens and
unchanged cache. A native unrecorded goal must fail at the throwing descriptor;
zero counters on that failed attempt alone are insufficient proof.

The compiled inspector uses real request detail and invalidation with a synthetic
Herdr socket host. It qualifies binding, graph navigation, pinning, unknown
observations and refusal to focus an absent worker. It does not qualify a live
desktop or positive worker focus. Keep exact focus identity/races, controller
ownership, Windows protocols, terminal content isolation, review timing and
historical storage/query budgets at their distinct hosted boundaries.

## Upstream Symphony and providers (B5)

Upstream journeys launch the public Symphony CLI from candidate source with a
disposable workflow and home. Controlled Linear HTTP and app-server subprocess
peers exercise polling, workspace hooks, reconciliation, retries, workflow reload,
dynamic tools and status accounting. Public status reads and captured protocol
traffic establish outcomes without ExUnit or injected orchestrator state.
Public tracker API processes cover batched refresh and HTTP comment/state writes
that have no daemon HTTP entrypoint.

These journeys qualify adapter-owned behavior. Existing delivery journeys own
the controlled GitHub CLI boundary. Real Linear, GitHub, model-provider and SSH
compatibility remain separate opt-in qualifications; passing synthetic peers
does not establish live compatibility. Preserve distinct path/SSH/Windows safety,
simultaneous ownership and historical recovery checks where ordinary journeys
cannot reach the failure. All candidate execution occurs on hosted CI when the
workstation execution prohibition applies.
