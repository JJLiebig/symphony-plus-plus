# Development

## Toolchain

The Elixir project pins its toolchain through `elixir/mise.toml`.

```powershell
mise trust .\elixir\mise.toml
Push-Location .\elixir
mise install
mise exec -- mix deps.get
Pop-Location
```

## Main Gate

Run the repository gate from the root:

```powershell
make all
```

For the fast Elixir-only loop, run `make -C elixir all`.

Frontend-only iteration can use:

```powershell
Push-Location .\elixir\assets
npm test
npm run quality
npm run build
Pop-Location
```

## Performance

The MCP release gate is:

```powershell
pwsh -NoProfile -File .\scripts\benchmarks\sympp-mcp\run-performance-gate.ps1
```

It uses isolated ports, homes, databases, caches, and temporary directories.
It must not touch the default dashboard ports, installed plugin state, shared
ledger, existing sessions, or credentials.

Backend startup probes:

```powershell
pwsh -NoProfile -File .\scripts\benchmarks\sympp-startup\measure.ps1
pwsh -NoProfile -File .\scripts\benchmarks\sympp-startup\measure.ps1 -Release
```

Dashboard measurements and the realistic focus-board journey live under
`scripts/benchmarks/sympp-dashboard/`.

## Release Discipline

- Validate the exact pull-request head.
- Keep runtime contract identity synchronized with the live MCP catalog.
- Build marketplace artifacts from the intended source revision.
- Treat installed-cache and fresh-session validation as release/cutover work,
  not ordinary feature-branch development.
- Do not mutate the user's installed plugin or running daemon during tests.

See [Runtime](runtime.md) for installed artifact ownership and repair.

## Isolated Source Beta

Source runtime validation is separate from installed beta use. From the stable
checkout, the existing helper creates or updates its adjacent beta worktree:

```powershell
pwsh -NoProfile -File .\scripts\sympp-beta.ps1 -Action Setup
pwsh -NoProfile -File .\scripts\sympp-beta.ps1 -Action Codex
```

Use `Start`, `Restart`, `Status`, `Stop` or `Validate` for that source
runtime. Control actions do not update Git. `Setup` synchronizes beta and
refuses conflicting tracked changes/local commits. Resume an existing thread
with `-Action Codex -ResumeSessionId <thread-id>`.

The helper isolates ports, home, build output and sandbox database. It keeps
the normal Codex home for source sessions. `Package` uses a separate developer
Codex home; it is not marketplace-installed qualification. Do not use
`-LiveLedger` for destructive validation. Inspect script help before selecting
a copied ledger or changing the lane.

Only explicit developer validation uses `SYMPP_REPO_ROOT`. Installed sessions
must resolve from their own marketplace/cache. Never refresh the normal cache
from a developer checkout.

## Documentation Changes

Current guides describe implemented behavior. Approved beta target contracts
belong under `docs/design/`, explicitly labeled and linked from the index; they
do not replace current operating procedures. Update the owning skill when agent
procedure changes, code/tests when behavior changes, and the current guides
when the human model changes. Do not keep duplicate plans, migration diaries,
or completed implementation plans in the active tree.
