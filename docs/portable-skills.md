# Portable Skills Installation

On Windows x64, install Symphony++ for Claude Code, Codex, or both with the
[Skills CLI](https://github.com/vercel-labs/skills). You need Git, Node.js 22.20+
with npm/npx, PowerShell 7, and the selected host on PATH. No Elixir toolchain,
Codex marketplace, developer checkout, or Codex cache is required. Native
Linux, macOS and Windows ARM host setup is not supported by this route.

## Install and connect

From the project that will use Symphony++, choose one pair:

```powershell
# Claude Code only
npx --yes skills@1.7.0 add https://github.com/JJLiebig/symphony-plus-plus/tree/beta --agent claude-code --skill symphony-plus-plus --yes
node .claude/skills/symphony-plus-plus/scripts/setup-sympp.js --host claude

# Codex only
npx --yes skills@1.7.0 add https://github.com/JJLiebig/symphony-plus-plus/tree/beta --agent codex --skill symphony-plus-plus --yes
node .agents/skills/symphony-plus-plus/scripts/setup-sympp.js --host codex

# Both hosts
npx --yes skills@1.7.0 add https://github.com/JJLiebig/symphony-plus-plus/tree/beta --agent codex claude-code --skill symphony-plus-plus --yes
node .agents/skills/symphony-plus-plus/scripts/setup-sympp.js
```

Omitting `--host` registers installed Codex and Claude Code detected on PATH.
`--host both` requires both. The qualified CLI version recognizes `/tree/beta`
and retains that ref in `skills-lock.json` across updates. Codex uses
`.agents/skills/symphony-plus-plus`; Claude uses `.claude/skills/symphony-plus-plus`.
Shared installations may link to one canonical directory. `--copy` also works.

Setup creates the selected `CODEX_HOME` (default `~/.codex`) when needed, then
writes its `config.toml` and Claude's project `.mcp.json`, preserving unrelated
settings. It does not write Claude's user configuration. Both entries launch
the installed Node bridge with the Node executable running setup. They capture
`SYMPP_HOME`, `SYMPP_DATABASE`, `SYMPP_RUNTIME_FILE`, and any selected
backend port/log directory. Codex keeps 360-second startup and 300-second tool
timeouts. Do not commit machine-specific MCP paths to a shared repository.

Claude local registration takes precedence over project configuration. If this
project already has a local `symphony_plus_plus` entry, remove that old entry
with `claude mcp remove --scope local symphony_plus_plus` before the fresh
session. Setup checks the project file; it does not inspect Claude's local
registration store. A new dedicated beta workspace avoids that collision.

Repeated setup is a no-op and repairs owned registrations after relocation.
Unrelated `symphony_plus_plus` entries and enabled Symphony++ MCP marketplace
plugins in the selected Codex home are refused. Use a separate home/workspace,
or explicitly disable/remove the old registration after closing its sessions.
Setup does not disable plugins or stop runtimes.

Open **fresh host sessions** in this project, follow host approval prompts,
and verify `symphony_plus_plus` tools before ledger work. Setup cannot add tools
to an already-open model session. An agent following the installed skill may
run setup when MCP is missing, then report that a fresh session is required.

## Side-by-side beta and an empty dogfood ledger

Use a dedicated workspace and fresh paths. Existing main factory sessions may
remain running because these select a different ledger and runtime state:

```powershell
$betaWorkspace = Join-Path $env:USERPROFILE 'sympp-beta-dogfood'
New-Item -ItemType Directory -Path $betaWorkspace -ErrorAction Stop | Out-Null
Set-Location -LiteralPath $betaWorkspace
$env:CODEX_HOME = Join-Path $betaWorkspace '.codex-beta'
$env:CLAUDE_CONFIG_DIR = Join-Path $betaWorkspace '.claude-beta'
$env:SYMPP_HOME = Join-Path $betaWorkspace '.sympp-beta'
$env:SYMPP_DATABASE = Join-Path $env:SYMPP_HOME 'empty.sqlite3'
$env:SYMPP_RUNTIME_FILE = Join-Path $env:SYMPP_HOME 'runtime/codex-plugin.json'
$env:SYMPP_BACKEND_PORT = '21345'
$env:SYMPP_OPEN_DASHBOARD = '0'
npx --yes skills@1.7.0 add https://github.com/JJLiebig/symphony-plus-plus/tree/beta --agent codex claude-code --skill symphony-plus-plus --yes
node .agents/skills/symphony-plus-plus/scripts/setup-sympp.js --host both
codex
```

The first session creates an empty ledger. In another terminal, select the
same workspace and isolated Claude profile:

```powershell
$betaWorkspace = Join-Path $env:USERPROFILE 'sympp-beta-dogfood'
Set-Location -LiteralPath $betaWorkspace
$env:CLAUDE_CONFIG_DIR = Join-Path $betaWorkspace '.claude-beta'
claude
```

Use normal host sign-in; do not copy credentials. Claude's MCP registration is
project scoped; `CLAUDE_CONFIG_DIR` additionally selects its separate settings
and authentication profile. For one host, use its install/setup pair above.
Setup captures runtime paths, so the second terminal needs only its selected
host profile and project. Read `frontend.url` from the runtime file to open the
board; the preferred port can fall back to another available port.

An empty ledger supports real agent dogfooding. Use the separate offline viewer
below to inspect a consistent copy of populated records.

## Copy, convert, and view an offline ledger

Use the installed bundle in PowerShell 7 on Windows x64. Snapshot also requires
Python 3.9+ on PATH; View does not need Python. No checkout, Elixir toolchain,
host registration or MCP connection is needed. The first use downloads the
published runtime into the dedicated offline home.

From the project containing the installed skill, set the actual source path
explicitly. The source may stay open in its existing runtime:

```powershell
$offlineHelper = '.agents/skills/symphony-plus-plus/scripts/sympp-offline.ps1'
# Claude-only installs use .claude/skills/symphony-plus-plus/scripts/sympp-offline.ps1.
$sourceDatabase = 'C:\path\to\recorded-factory-ledger.sqlite3' # Replace with its recorded identity.
$offlineHome = Join-Path $env:USERPROFILE 'sympp-offline-view'
pwsh -NoProfile -File $offlineHelper -Action Snapshot -SourceDatabase $sourceDatabase -SymppHome $offlineHome
pwsh -NoProfile -File $offlineHelper -Action View -SymppHome $offlineHome -Port 21498
```

Choose a new, empty offline home, separate from both the factory and the empty
dogfood home above. Port `21498` is separate from that recipe's `21345`; select
another unused port if necessary. Open `http://127.0.0.1:21498/sympp/board`.
The viewer runs in this terminal. Press **Ctrl+C**, wait for it to exit, then
refresh and reopen with:

```powershell
pwsh -NoProfile -File $offlineHelper -Action Snapshot -SourceDatabase $sourceDatabase -SymppHome $offlineHome -ReplaceSnapshot
pwsh -NoProfile -File $offlineHelper -Action View -SymppHome $offlineHome -Port 21498
```

Snapshot uses SQLite's read-only online backup, marks the copy offline, runs the
published version's migrations without starting application services, and only
then publishes `ledger/snapshot.sqlite3`. A failed migration preserves the
previous snapshot. An active viewer excludes replacement. Logs, temporary
files, operator settings and downloaded artifacts stay in the offline home;
inherited runtime selections do not redirect the viewer.

Complete, archive, restore, delete and retention affect only this copy. MCP,
dispatch, session focus, worktree preparation/cleanup and external provider or
review probes are disabled. Never connect agents to the copy, clear its marker,
or promote it to live. Marker-aware runtimes refuse ordinary startup of the
copy; older runtimes cannot enforce that protection. The copy retains private
data and credentials, so keep it local. The existing
[source-beta helper](development.md#isolated-source-beta) remains a developer alternative.

## Runtime identity, sharing, and conflicts

This bundle selects beta.2 build `87d828d528b68e7b35ebb94d307a96b6f2c556ed` through
its [published artifact pointer](https://github.com/JJLiebig/symphony-plus-plus/releases/tag/sympp-v2-beta-2-20261013).
Setup prints the runtime build and bundled payload digest. Procedures and
launcher can change while the runtime build stays the same.
Changes merged to beta after this runtime build, including the later settings
UI, are absent until a new runtime is published and selected by the pointer.

Both hosts must share the same Symphony++ home, runtime file and ledger to
share a managed runtime. Startup locks serialize startup and client leases
keep it alive until the last client closes. Portable startup records live
ownership beside the ledger and refuses a different live home even on another
port. A foreign same-ledger listener is refused unless shared managed ownership
is proven. A new Windows backend also refuses an already-open ledger.
Independent ledgers remain independent.

Older marketplace launchers do not participate in the new ownership receipt.
Do not start an old launcher and a portable launcher concurrently against the
same stopped ledger. Close every old client before changing distribution; see
the [cutover runbook](runbooks/beta-release-cutover.md). Existing marketplace
installations retain their marketplace upgrade path.

## Update, rollback, and removal

Close clients using this installation and retain selected host profiles. Save
the current installed bundle outside the workspace before updating:

```powershell
$previousBundle = Join-Path $env:USERPROFILE 'sympp-previous-install'
New-Item -ItemType Directory -Path $previousBundle -ErrorAction Stop | Out-Null
# For Claude-only, use .claude/skills/symphony-plus-plus as the source.
Copy-Item -LiteralPath .agents/skills/symphony-plus-plus -Destination $previousBundle -Recurse
Copy-Item -LiteralPath skills-lock.json -Destination $previousBundle
npx --yes skills@1.7.0 update symphony-plus-plus --project --yes
```

Open fresh sessions. The stable project skill path keeps registration valid.
After relocating the workspace or changing copy/link layout, repeat setup with
the same runtime selections to repair its absolute path. Re-add `/tree/beta`
to force a payload refresh.

Rollback selects the saved installation bytes:

```powershell
npx --yes skills@1.7.0 add "$previousBundle/symphony-plus-plus" --agent codex claude-code --skill symphony-plus-plus --yes
node .agents/skills/symphony-plus-plus/scripts/setup-sympp.js --host both
```

The lock records branch and content hash, not a resolved Git commit. If you
separately recorded a known Skills-capable commit, `/tree/<full-sha>` also
selects that version. A local backup or pinned SHA does not follow beta on
update; re-add `/tree/beta` to follow beta again. The previous
bundle selects its previous runtime pointer but cannot undo migrations or
retention. Restore a stopped ledger backup when the cutover runbook requires
it. This initial Skills release has no earlier Skills-capable release: retain
the original marketplace installation and stopped-ledger backup for the first
cutover's rollback.

Before `npx --yes skills@1.7.0 remove symphony-plus-plus --yes`, close clients and
remove its MCP registration from each host. Removing skill files does not
remove host configuration.

## Maintenance and proof

Canonical procedures and launcher files remain under
`plugins/symphony-plus-plus-mcp`. `node scripts/package-portable-skills.mjs`
mirrors them and generates install identity; `--check` detects drift. Pointer
promotion updates both its URL and published `source_revision`. The bundle
contains procedures, setup/launcher support and metadata; first startup
downloads the verified runtime archive.

Windows CI installs isolated bundles through Skills 1.7.0, checks configuration
preservation/repair, and exercises the published artifact with real MCP,
shared attachment, shutdown, restart and conflicting owners. A `/tree/beta`
installation checks update keeps beta. GitHub's elevated Windows desktop uses
a test-only process creation fixture with unchanged installed launcher files
and the real published backend. Desktop user/token/job behavior, authenticated
host sessions, focus, workstation behavior and populated factory migration
remain manual qualification.

The installed offline path is also exercised with a synthetic populated
old-schema WAL ledger: unchanged source bytes and records, staged conversion,
the offline marker, populated board data, denied MCP/dispatch/focus, untouched
external-command sentinels, Ctrl+C shutdown, stopped refresh and refusal of
ordinary startup. This uses the published beta.2 artifact, not a rebuilt backend.
