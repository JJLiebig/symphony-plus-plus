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

The `native acceptance` job is an explicit dependency of `make-all`. Legacy
checks remain required until the owning acceptance journey replaces their
guarantees. Preserve unique storage, concurrency, authority, process, and live
provider contracts; live external qualification remains opt-in. Define expected
outcomes from requirements or external contracts before writing replacements.
Remove implementation-shape assertions and same-guarantee duplicates only with
their owning conversion.

Retain `.e2e/report.json`, traces, process logs, checkout/head/base revisions,
commands, and job timings as hosted artifacts. Distinguish literal definitions
from executed cases and logical guarantees, and handwritten support from
generated reports or replay cache. Report failures, skips, retries, and model
calls/tokens explicitly. Inventory and conversion measurements belong in PR
evidence, not current product guides.

On workstations subject to the runtime execution prohibition, all code
validation runs on GitHub-hosted CI. Local source/Git reads and edits remain
available. Do not run tests, builds, formatters, launchers, or runtime probes.
