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

See [Testing](testing.md) for native candidate acceptance, hosted evidence, and
the workstation runtime execution restriction. The commands below apply only
where executable validation is authorized.

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
npm run build:herdr
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

On Windows workstations affected by the AMD image-load crash in
[issue #716](https://github.com/JJLiebig/symphony-plus-plus/issues/716), do not
run runtime tests or crash reproductions. Use an unaffected Windows environment
for executable validation. Executable fixtures belong in system temp outside
checkouts; choose a short temp path there. Shorter paths do not fix the driver.

Backend startup probes:

```powershell
pwsh -NoProfile -File .\scripts\benchmarks\sympp-startup\measure.ps1
pwsh -NoProfile -File .\scripts\benchmarks\sympp-startup\measure.ps1 -Release
```

Backend dashboard payload profiling and its deterministic fixture live under
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

For checkout-free copy/conversion/viewing, use the
[installed Skills offline viewer](portable-skills.md#copy-convert-and-view-an-offline-ledger).
It uses the published artifact and needs Python only for copying. The source
helper below remains for explicit developer validation with an Elixir toolchain.

Source runtime validation is separate from installed beta use. Use the script
from the beta checkout containing this change. Explicit checkout paths support
an already registered beta worktree without changing the main checkout:

```powershell
$betaScript = 'C:\Code\.worktrees\symphony-plus-plus\beta\scripts\sympp-beta.ps1'
$betaPaths = @{
  RepoRoot = 'C:\Code\symphony-plus-plus'
  BetaWorktree = 'C:\Code\.worktrees\symphony-plus-plus\beta'
}
& $betaScript -Action Setup @betaPaths
& $betaScript -Action Snapshot @betaPaths
& $betaScript -Action Start @betaPaths
```

Use `Start`, `Restart`, `Status`, `Stop` or `Validate` for that source
runtime. Control actions do not update Git. `Setup` synchronizes beta and
refuses conflicting tracked changes/local commits. Open
`http://127.0.0.1:20001/sympp/board` after starting.

`Snapshot` requires Python 3 and the source runtime's Elixir toolchain. It reads
the normal live ledger through SQLite's online backup API while the live factory
keeps running. `-SourceDatabase <path>` selects another source. The staged copy
is marked offline, migrated without starting any services, and published only
after migration succeeds. Stop beta before refreshing it, then use
`-Action Snapshot -ReplaceSnapshot` to explicitly replace its existing ledger.
Missing/empty sources, source aliases, active beta runtimes and destinations
outside the beta home's `ledger` directory are refused. Replacement recovers
leftover SQLite sidecars only for a marked sandbox, and refuses one still in use.

The snapshot retains goals and recorded PR/review evidence. Complete, archive,
restore, delete and retention change only the copy. Worktree preparation and
cleanup, agent handoffs/dispatch, MCP, provider synchronization, repository and
review probes, Herdr updates and automatic browser opening are disabled. Source
builds and runtime files remain in the beta checkout/home; temporary files and
operator configuration are isolated too. `Codex` is unavailable on an offline
copy because it has no agent access.

The durable marker refuses startup without offline mode in marker-aware
versions, including `-LiveLedger`. Keep the snapshot away from older runtimes,
which cannot recognize this protection. It still contains the source ledger's
private data and credentials; keep it local and do not upload it.

Conversion uses the same versioned migrations as ordinary startup; no separate
data rewrite is needed. A future live cutover must use the original live ledger
after stopping its old runtime, with a backup and verified installed runtime.
Never promote the exercised sandbox back to live. Both the snapshot change and
the archive-setting migration must be on beta before copying if existing stored
14-day settings should convert during this migration pass.

The helper isolates ports, home, build output and sandbox database. It keeps
the normal Codex home for explicitly selected live source sessions. `Package` uses a separate developer
Codex home; it is not marketplace-installed qualification. Do not use
`-LiveLedger` for destructive validation. Live source sessions can use
`-Action Codex -LiveLedger`, optionally with `-ResumeSessionId <thread-id>`.

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
