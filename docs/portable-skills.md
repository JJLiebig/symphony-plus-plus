# Portable Skills Installation

On Windows x64, install sympp for Claude Code, Codex, or both with the
[Skills CLI](https://github.com/vercel-labs/skills). You need Git, Node.js 22.20+
with npm/npx, PowerShell 7, and the selected host on PATH. No Elixir toolchain or Codex marketplace is required for Windows local setup.
Windows and Linux clients can connect to a Linux factory with `--server`.

## Install and connect

Install globally for both hosts, then connect them from any project:

```powershell
npx skills add JJLiebig/sympp -g
node $HOME/.agents/skills/sympp/scripts/setup-sympp.js
```

Omitting `--host` registers installed hosts; `--host both` requires both.
Setup writes Codex's selected `CODEX_HOME/config.toml` and registers Claude
at user scope.
Both entries capture the installed bridge and selected `SYMPP_*` settings.
Claude local and project registrations take precedence over user registrations.
Do not commit machine-specific MCP paths to a shared repository.

Setup also installs or updates the Herdr panel when Herdr-app is on PATH, keeping
backups of replaced panel files. On a personal desk it adds the panel button and
agent badges; other layouts keep their own files and can open the view with
`herdr-app do tab.new '{"name":"sympp","mod":"sympp"}'`.

Run `sympp update` to update the skill, reconnect the selected hosts and panel,
and rebuild/restart the remote factory over the saved SSH host. It stops at the
first failed step. Open fresh agent sessions afterward.

Repeated setup is a no-op and repairs owned registrations after relocation.
Unrelated `sympp` entries in the selected host configuration are refused. Use a separate home/workspace,
or explicitly disable/remove the old registration after closing its sessions.
Setup does not disable plugins or stop runtimes.

Open **fresh host sessions** in this project, follow host approval prompts,
and verify `sympp` tools before ledger work. Setup cannot add tools
to an already-open model session. An agent following the installed skill may
run setup when MCP is missing, then report that a fresh session is required.

## Copy, convert, and view an offline ledger

Use the installed bundle in PowerShell 7 on Windows x64. Snapshot also requires
Python 3.9+ on PATH; View does not need Python. No checkout, Elixir toolchain,
host registration or MCP connection is needed. The first use downloads the
published runtime into the dedicated offline home.

From the project containing the installed skill, set the actual source path
explicitly. The source may stay open in its existing runtime:

```powershell
$offlineHelper = Join-Path $HOME '.agents/skills/sympp/scripts/sympp-offline.ps1'
# Claude-only installs use $HOME/.claude/skills/sympp/scripts/sympp-offline.ps1.
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
data and credentials, so keep it local.

## Runtime identity, sharing, and conflicts

Main selects the floating `stable` runtime channel.
Setup always selects stable for a local factory and prints its payload digest. The payload hash and MCP contract identify
the installed bundle; the verified artifact manifest and health response identify
the actual runtime SHA.

Branch pushes publish automatically after hosted platform builds. On cold start,
the factory resolves the latest successfully published manifest, reusing verified
archive bytes when unchanged. Healthy attached clients keep their actual current
backend until the last client closes. Source installation can precede publication;
check actual runtime provenance before assuming a new feature is available.

Both hosts must share the same sympp home, runtime file and ledger to
share a managed runtime. Startup locks serialize startup and client leases
keep it alive until the last client closes. Portable startup records live
ownership beside the ledger and refuses a different live home even on another
port. A foreign same-ledger listener is refused unless shared managed ownership
is proven. A new Windows backend also refuses an already-open ledger.
Independent ledgers remain independent.

## Update, rollback, and removal

Close clients using this installation and retain selected host profiles. For a
global install, back up `$HOME/.agents/skills/sympp` and
`$HOME/.agents/.skill-lock.json` (or `$env:XDG_STATE_HOME/skills/.skill-lock.json`
when set), then run:

```powershell
npx skills update sympp -g
node $HOME/.agents/skills/sympp/scripts/setup-sympp.js
```

Rollback needs the saved installation and its matching runtime. Source bytes
alone still follow a floating channel. Preserve the previous runtime manifest,
archive and stopped ledger backup before updating. Skills locks record the
branch and content hash rather than a resolved Git SHA.

Before `npx skills remove sympp -g`, close clients and
remove its MCP registration from each host. Removing skill files does not
remove host configuration.

## Maintenance and proof

Canonical procedures and launcher files remain under
`packages/sympp`. `node scripts/package-portable-skills.mjs`
mirrors them and generates content identity; `--check` detects drift. The stable
manifest URL ships in the payload; runtime source SHA comes from the selected
verified artifact. The bundle
contains procedures, setup/launcher support and metadata; first startup
downloads the verified runtime archive.

Windows CI installs isolated bundles through Skills 1.7.0, checks configuration
preservation/repair, and exercises real old and current-candidate artifacts with MCP,
shared attachment, shutdown, restart and conflicting owners. GitHub's elevated Windows desktop uses
a test-only process creation fixture with unchanged installed launcher files
and real verified backend releases. Cold refresh proves changed runtime SHA
with unchanged content identity; warm clients keep their current backend. Desktop user/token/job behavior, authenticated
host sessions, focus, workstation behavior and populated factory migration
remain manual qualification.

The installed offline path is also exercised with a synthetic populated
old-schema WAL ledger: unchanged source bytes and records, staged conversion,
the offline marker, populated board data, denied MCP/dispatch/focus, untouched
external-command sentinels, Ctrl+C shutdown, stopped refresh and refusal of
ordinary startup. This uses the selected branch artifact, not a local source build.

Setup installs `sympp` in `~/.local/bin` and adds it to the user PATH. Open a
fresh terminal from the Windows Start menu, or a Unix login shell, then use `sympp --server <ssh-host>`, `sympp` for local setup,
or `sympp status` to see the selected factory and whether it answers. Re-running
setup migrates its old managed MCP registration to `sympp`.

If setup prints `activate` on Linux/macOS, run the printed export in the shell
where you will type `sympp`; opening a tab in an existing terminal may retain
its previous PATH. `sympp status` succeeds when the factory answers with a
reachable ledger.
