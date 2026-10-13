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
