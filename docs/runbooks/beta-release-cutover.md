# Branch Updates And Factory Cutover

Main is the normal installation branch; beta is an isolated preview. Each push
builds and smokes Linux x64, Windows x64 and macOS ARM archives on hosted runners.
Successful publication updates the branch's floating runtime manifest: main uses
`stable`, beta uses `beta`. There is no manual version tag or pointer-promotion PR.
GitHub Release tags remain internal asset containers; historical releases stay intact.

An installed factory adopts the latest successfully published branch runtime on
cold start. Healthy clients keep their current runtime until all clients close.
A source install can briefly be ahead of publication; matching MCP contracts
remain required. Check the actual runtime SHA against the branch manifest rather
than assuming the source checkout and running artifact are identical.

Use [portable installation](../portable-skills.md) for install/update commands and
[the runtime guide](../runtime.md) for actual endpoint lookup. Changing the source
branch requires running Skills setup again. Marketplace metadata records its
selected ref. Branch selection is independent of ledger selection.

## Prepare A Factory Move

Before a cutover, populated records can be inspected through the
[installed offline copy/view commands](../portable-skills.md#copy-convert-and-view-an-offline-ledger)
while the factory stays open. Use a separate offline home and port, keep the
durable marker, and stop View with Ctrl+C before refreshing. This inspection
uses the selected branch's published schema and UI. An exercised snapshot is never the cutover ledger
or a substitute for the stopped backup below.

Start only after the operator approves a cutover window and the selected branch
manifest resolves to the inspected build. Automatic publication alone does not
approve a factory move. Keep the current factory homes and original ledger; the separate
offline beta home is not an upgrade source or destination.

1. Record the factory's actual `CODEX_HOME`, `SYMPP_HOME`, `SYMPP_DATABASE`, runtime
   state path (including any `SYMPP_RUNTIME_FILE` override), workflow/config,
   installed package version, marketplace ref and healthy runtime SHA. Use the
   recorded ledger identity, not an assumed default path. Record active
   WorkRequest/WorkPackage IDs and their current work so agents can recover.
2. Stop accepting new factory work, let in-flight writes finish, and close every
   Codex, Claude and other MCP client attached to this ledger, including worker
   and architect sessions. Stop any manually owned service through its owner.
   Close the board too. Allow managed shutdown after the last client detaches.
3. Verify the recorded backend has exited and no other process uses the ledger.
   A closed terminal or empty board is not proof. If shutdown fails, stop here
   and investigate the recorded process identity; do not kill every BEAM/Node
   process or start another runtime against the ledger.
4. While all writers are stopped, copy the ledger and any existing `-wal`, `-shm`
   or `-journal` sidecars together to a new private backup directory. Do not
   discard a WAL file. Copy the factory's entire `SYMPP_HOME` (runtime artifacts,
   launcher metadata, configuration and logs), the marketplace source clone,
   installed Symphony++ plugin cache and Codex `config.toml`. Also preserve the
   workflow, operator config or runtime state if outside those homes, and each
   Claude project's MCP registration. Record the original paths with the backup.
   Do not upload this backup; it can contain private ledger data and credentials.

For example, after assigning the recorded absolute paths to `$factoryDatabase`,
`$factorySymppHome`, `$factoryCodexHome` and a new `$factoryBackup` outside all
three, the stopped-ledger copy is:

```powershell
New-Item -ItemType Directory -Path $factoryBackup -ErrorAction Stop | Out-Null
$ledgerBackup = Join-Path $factoryBackup 'ledger'
New-Item -ItemType Directory -Path $ledgerBackup | Out-Null
foreach ($suffix in @('', '-wal', '-shm', '-journal')) {
  $ledgerFile = "$factoryDatabase$suffix"
  if (Test-Path -LiteralPath $ledgerFile) {
    Copy-Item -LiteralPath $ledgerFile -Destination $ledgerBackup
    $copiedFile = Join-Path $ledgerBackup (Split-Path -Leaf $ledgerFile)
    if ((Get-FileHash -LiteralPath $ledgerFile).Hash -ne (Get-FileHash -LiteralPath $copiedFile).Hash) {
      throw 'Backup copy mismatch.'
    }
  } elseif ($suffix -eq '') { throw 'Recorded factory ledger is missing.' }
}
Copy-Item -LiteralPath $factorySymppHome -Destination (Join-Path $factoryBackup 'sympp-home') -Recurse
$marketplaceSource = Join-Path $factoryCodexHome '.tmp/marketplaces/symphony-plus-plus'
$installedCache = Join-Path $factoryCodexHome 'plugins/cache/symphony-plus-plus'
Copy-Item -LiteralPath $marketplaceSource -Destination (Join-Path $factoryBackup 'marketplace') -Recurse
Copy-Item -LiteralPath $installedCache -Destination (Join-Path $factoryBackup 'plugin-cache') -Recurse
Copy-Item -LiteralPath (Join-Path $factoryCodexHome 'config.toml') -Destination $factoryBackup
```

Check that every required copy completed and retain the hashes. A stopped,
complete backup is required even when intending only a short trial: the first
beta connection can migrate the ledger and normal operation can apply retention.

## Skills CLI cutover

The preferred host-neutral route is the [Skills install](../portable-skills.md).
It uses the selected branch's automatically published artifact. An empty-ledger side-by-side beta trial is independent of this
factory cutover. A raw factory copy is not a safe MCP dogfood ledger; offline
snapshot/view rules remain in [development](../development.md#isolated-source-beta).

After the stopped-ledger backup above and an approved cutover window:

1. Retain the original marketplace registration/configuration and artifacts for
   rollback. In the selected replacement Codex home, explicitly disable/remove
   its old Symphony++ MCP plugin or manual entry. In the project being converted,
   remove its old Claude local entry with
   `claude mcp remove --scope local symphony_plus_plus`; local entries take
   precedence over the project file and setup cannot detect them. Setup refuses
   conflicting project entries.
2. In the intended project, select the recorded `SYMPP_HOME`, `SYMPP_DATABASE`
   and `SYMPP_RUNTIME_FILE`, then run the combined Skills install and setup
   commands in the portable guide. This registers one stable installed launcher
   for both hosts. Do not set `SYMPP_REPO_ROOT` or change the ledger path.
3. Open one fresh host session. Require artifact mode, the inspected branch
   manifest's runtime SHA, and the original ledger identity.
   For this route `plugin_root` must be the installed skill directory, not a
   marketplace cache. Run the actual-session checks below before the second host.
4. Open the second host and verify shared work and one runtime. Reclaim existing
   assignments before resuming. Never run old and new launchers concurrently
   against the same stopped ledger: older launchers do not honor portable ledger
   ownership receipts. A detected live old owner is refused.

For future Skills upgrades, close clients, back up the installed skill directory
and `skills-lock.json` using the [portable guide](../portable-skills.md), run
`npx --yes skills@1.7.0 update symphony-plus-plus --project --yes`, and reopen
sessions. Repeat setup after updating to capture the recorded branch and repair its owned entry.
Source rollback alone does not pin a floating runtime. Preserve the previous build's
manifest and archive alongside its installed bundle and recorded actual SHA. A
hosted artifact run retains these files; download the recorded run before its
retention expires. Restore the matched files and point the installation's existing
`.sympp-runtime-artifacts.json` override at that saved manifest/archive. Verify its
SHA before reopening. Remove this local override only when returning to branch
updates. Restore the stopped ledger and sidecars when migrations or retention
require it; the original marketplace/configuration/artifact backup remains the
rollback for a first distribution change.

## Marketplace alternative: upgrade and reconnect

Use the same factory environment in every replacement host. Clear developer-only
`SYMPP_REPO_ROOT`, source-root hints and artifact overrides from that environment.
Do not change the ledger path or reuse a sandbox marker. The marketplace source
clone is under `$factoryCodexHome/.tmp/marketplaces/symphony-plus-plus`; normal
runtime execution must come from the installed cache and downloaded artifact.

The following uses the existing Codex marketplace commands. Switching an existing
marketplace between main and beta requires removing its old source registration
before adding the intended ref (`main` normally, `beta` for an isolated preview). Run outside the marketplace directory because
replacement renames/removes that directory:

```powershell
$env:CODEX_HOME = $factoryCodexHome
$env:SYMPP_HOME = $factorySymppHome
$env:SYMPP_DATABASE = $factoryDatabase
Set-Location -LiteralPath $env:USERPROFILE
codex plugin marketplace remove symphony-plus-plus
codex plugin marketplace add https://github.com/JJLiebig/symphony-plus-plus --ref main
codex plugin marketplace upgrade symphony-plus-plus
codex plugin add symphony-plus-plus-mcp@symphony-plus-plus
codex plugin list --marketplace symphony-plus-plus --json
```

Stop on any nonzero exit. If marketplace configuration is managed by a higher
configuration layer, change the source in that layer instead of bypassing its
refusal. Reinstall the skill-only `symphony-plus-plus` plugin too if it was
previously installed. Confirm the selected branch and actual runtime match the inspected manifest,
the clone contains the shared channel configuration and no checkout-backed source hint was
introduced. Do not run a refresh/pin helper from a developer checkout.

For a subsequent upgrade on the selected branch, the supported helper is
`scripts/upgrade-spp.ps1` **from this marketplace source clone**, with no custom
flags (`-WhatIf` previews). It stops, upgrades and immediately prepares/restarts
the installed runtime. It is not a backup step. Do not use
`sympp-mcp-cutover.ps1` for this packaged migration: its missing-runtime fallback
can set up and launch a source runtime.

Update Claude's project-local bridge registration to the new installed version
using the [MCP connection procedure](../../plugins/symphony-plus-plus-mcp/skills/symphony-work-package/references/mcp_wiring.md).
Open one fresh dedicated Codex session first. Verify it before reopening other
hosts. Restart all architect and worker model sessions for the new tool schemas;
transport reconnection in an old session does not reload its tool inventory.
Reclaim the same assignment and read its canonical history before retrying an
uncertain write, following the owning packaged skill.

## Verify before resuming work

Read the new runtime state from the recorded state path and query its recorded
`backend.url` plus `/mcp/readiness`. Require healthy status, the original ledger
identity and **runtime** `$buildSha`. Also verify the contract fingerprint against
the inspected artifact. A compatible contract alone can reuse an older backend;
the correct SHA is a separate cutover requirement. Verify `runtime_mode` is
`artifact`, `plugin_root` is inside the intended installed cache and the artifact
root belongs to the intended factory home. Stop if it is a source runtime,
another ledger or an old build.

In the actual fresh session, confirm native MCP tools load and read a known
WorkRequest and WorkPackage. Follow the new runtime state's `frontend.url` and
confirm the new operator board is served, known work/history/blockers are
readable, navigation reaches details, labels are sensible and icons load. Last
seen is displayed in local time at minute precision; backend timestamps remain
canonical. Check an intended same-machine session-focus action and its honest
unavailable behavior for a missing/remote session. This action focuses a native
terminal and is an operator check, not archive inspection.

Then reconnect the second host and verify it sees the same ledger and build.
Inspect the archive view and retention settings before dispatching new work.
Record any failures; only resume factory execution after operator acceptance.

## Migrations and rollback

First access runs outstanding versioned migrations through `Ecto.Migrator`.
Relative to the published stable source above, beta adds:

| Migration | Effect |
|---|---|
| `20261005040000` | Adds candidate-head SHA and selection timestamp to dependency edges. |
| `20261013120000` | Converts every stored 14-day WorkRequest archive setting to 3 days; other values remain. Its down migration raises because an original custom 3-day value cannot be distinguished. |
| `20261013130000` | Adds 30-day never-started archival setting and restore timestamp. |
| `20261013140000` | Creates session locations and their target/role and client indexes. |

Recompare the migration directory from the **actual previous runtime SHA** to the
frozen build before cutover. An older factory may have more outstanding
migrations. This source audit did not inspect the live database or its applied
migration table, so it cannot assert which rows will change.

The archive-setting migration is irreversible through `down`. Retention is a
separate effect: finished requests use their stored archive setting, with 3 days
as the new default. Existing custom values other than 14 remain, and the existing
ten-visible-completed cap can archive sooner. Never-started requests become
eligible after 30 days from creation or explicit restore, and
their archive reason excludes them from automatic deletion. Existing archived
completed requests remain subject to deletion using the stored retention window
(`solo_session_delete_after_days`, default 30 days). Solo-session cleanup and
worktree cleanup also run. Retention runs periodically and saving operator
settings forces a pass; do not assume a safe grace period after startup.
Archival can be restored in the UI; deleted records require backup, and restoring
the ledger cannot recreate deleted Git worktrees or reverse external agent work.

If verification fails, keep work paused, close all beta clients and verify the
beta backend is stopped. Preserve the failed ledger/home and logs separately.
Restore the pre-cutover **ledger plus its matching sidecars**, original factory
home, original marketplace source snapshot, installed plugin cache and saved
configuration/Claude registration to their recorded paths. Move the failed files
aside first so beta-created WAL/SHM files cannot be mixed with the old database;
verify all resolved move/restore targets against the recorded backup manifest.
Restore any external workflow/operator config too. Do not overlay a backup onto
a running database or invoke down migrations.

Open fresh sessions against the restored installed marketplace/cache, verify the
original runtime SHA and original ledger identity, then recover the assignments
through their owning skills. Do not run marketplace upgrade during rollback: the
branch channel is mutable and may now resolve to another build. Restoring
the paired marketplace/cache/artifact backup preserves the prior installation.
Any post-backup ledger writes are lost; capture needed evidence before restoring
and reconcile external commits/PRs before resuming.

## Qualification still needed

- Hosted PR checks do not exercise this workstation's GPU/driver environment.
  Local executable validation is prohibited on the affected workstation; this
  preparation performed source review only.
- Windows launcher CI skips desktop tests. A hosted runtime route/MCP smoke does
  not prove installed Codex/Claude generation upgrade, elevated desktop launch,
  shared-client shutdown, real session focus or native UI usability here.
- Both main and beta PRs run the three-platform artifact workflow. Hosted Windows
  process qualification uses a controlled process-creation seam; desktop ownership
  and this workstation's native launch remain separate qualifications.
- The populated factory ledger, its settings, backlog, migration duration,
  retention effects, backups and restore have not been exercised by this audit.
- Operator mappings, external deployment observations, host permissions,
  authentication and real network/proxy behavior require checks in the intended
  environment. Linux/macOS archives do not establish native host support.

Choose a quiet cutover window with a complete backup, accept retention and
restore-based rollback effects, and resume with one bounded request after actual
session checks pass. Keep the original factory untouched until its move is approved.
