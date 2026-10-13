# Publish and adopt a beta runtime

This is an operator procedure, not a record of a completed release. Publication
and factory cutover require separate operator approval. Preparing this guide does
not authorize either. Keep the original live ledger; never promote an exercised
offline sandbox into the factory.

## Release identity and prerequisites

Read-only release evidence on 13 October 2026:

| Channel | Package | Published runtime source |
|---|---|---|
| Stable | `0.1.10` | `6a3c2486624d391e9818e6ed267675384489b10e` |
| Beta | `0.2.0-beta.2` | `87d828d528b68e7b35ebb94d307a96b6f2c556ed` |

The current beta release is `sympp-v2-beta-2-20261013`. The publication examples
below use that release's identity; it is already published, so do not dispatch
them again. A future publication needs a new candidate version and unused tag.
Recheck both before use. The release workflow can overwrite assets on an existing
tag.

Before freezing a build, confirm all of the following:

- The executable-smoke fixture fix from #717 is present on beta by content.
- Board wayfinding and the packaged-board swap have both merged. The served
  `priv/static/index.html` must be the new board; #731 and #732 must be ancestors.
- The preparation, old-dashboard removal (#735), and version preparation below
  have merged, with their required hosted checks and fast reviews complete.
  The approved beta.2 freeze includes the finished board cleanup.
- The operator has explicitly authorized publication. No tag, release dispatch,
  runtime start, plugin refresh or live-ledger operation belongs to preparation.

At publication time, update both `plugins/symphony-plus-plus*/.codex-plugin/plugin.json`
versions to `0.2.0-beta.2` in a small PR against beta. Update the package READMEs,
root README, `docs/runtime.md`, and the installed bridge version in the packaged
`symphony-work-package/references/mcp_wiring.md` and its portable mirror under
`skills/symphony-plus-plus/references/`. Label the release as pending until it is
published. Leave `plugins/symphony-plus-plus-mcp/assets/sympp-runtime-artifacts.json`
on the existing release during the build. `elixir/mix.exs` is the backend
application version, not the plugin release version; do not change it for this.

Record the final 40-character beta build SHA only after these merges. It is not
known in this preparation guide. Freeze beta through publication and pointer
promotion: do not fold another backend, launcher or UI change into that window.
Record the final PR's green hosted check runs and actual tested checkout commit
(including its synthetic merge commit when CI checks out one). Before freezing,
prove its tree equals the final beta tree with `git diff --exit-code
<tested-checkout-sha> <frozen-beta-sha> --`. If the trees differ, take the changed
tree through a reviewed, tested PR before freezing. `make-all.yml` runs on PRs
and main pushes, not beta pushes or manual dispatch. This is tested-tree reuse,
not a claim that the final merged SHA ran the full suite. The release build and
smokes below run against the exact frozen runtime SHA.

## Publish from the frozen SHA

Run from a release worktree, after approval. These commands publish a prerelease:

```powershell
$releaseRepo = 'JJLiebig/symphony-plus-plus'
$releaseTag = 'sympp-v2-beta-2-20261013' # Recheck that this tag is unused.
git fetch origin beta
$buildSha = (git rev-parse origin/beta).Trim()
git ls-remote --tags origin "refs/tags/$releaseTag"
gh release list --repo $releaseRepo --limit 20
# Stop if the tag/release exists or the frozen prerequisite evidence differs.
gh workflow run sympp-runtime-release.yml --repo $releaseRepo --ref beta `
  -f "release_tag=$releaseTag" -f channel=beta `
  -f "source_ref=$buildSha" -f prerelease=true
gh run list --repo $releaseRepo --workflow sympp-runtime-release.yml --limit 5
# Select the run whose head SHA and dispatch inputs match the frozen record.
gh run watch <release-run-id> --repo $releaseRepo --exit-status
```

The dispatch uses the frozen beta branch for the workflow definition and the
explicit SHA for its build checkout. The
[release workflow](../../.github/workflows/sympp-runtime-release.yml) checks
out `source_ref`, builds and smokes Linux x64, Windows x64 and macOS ARM64, then
publishes all three archives and `sympp-runtime-artifacts-beta.json`. It creates
the tag at the build SHA when it creates the release. A `sympp-v2-*` tag does not
match its tag-push triggers; use the explicit dispatch above. Do not separately
push a `v*` or `sympp-runtime-*` tag, which selects the stable channel by default.
If any job fails, leave the pointer unchanged and inspect that run before retrying.

### Inspect the Windows archive before promoting the pointer

Download to a fresh evidence directory and inspect files only. Do not run the
archive, its entrypoints, BEAM, Node, Elixir or local build/test helpers.

```powershell
$releaseEvidence = Join-Path $env:TEMP $releaseTag
New-Item -ItemType Directory -Path $releaseEvidence -ErrorAction Stop | Out-Null
gh release download $releaseTag --repo $releaseRepo --dir $releaseEvidence `
  --pattern sympp-runtime-artifacts-beta.json `
  --pattern "sympp-runtime-$buildSha-windows-x64.*"
$channel = Get-Content (Join-Path $releaseEvidence 'sympp-runtime-artifacts-beta.json') -Raw | ConvertFrom-Json
$windows = @($channel.artifacts | Where-Object { $_.platform.os -eq 'windows' })
if ($windows.Count -ne 1) { throw 'Expected exactly one Windows artifact.' }
$archive = Join-Path $releaseEvidence "sympp-runtime-$buildSha-windows-x64.zip"
$actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $windows[0].archive.sha256) { throw 'Archive hash mismatch.' }
# Optional: expand into a short evidence path, or inspect ZIP entry bytes directly.
# Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $releaseEvidence 'contents')
```

Retain the run URL, tag target, asset hashes and this inspection record:

1. The aggregate manifest, Windows build manifest and extracted
   `runtime-manifest.json` all identify `$buildSha`, candidate package version,
   Windows platform and the frozen source's MCP contract fingerprint. Check the
   downloaded build manifest hash against the channel, and the extracted payload
   manifest hash against the build manifest. The remote tag must resolve to
   `$buildSha`; a local tag can be stale.
2. Inspect **both** `dashboard-static/index.html` and
   `lib/symphony_elixir-*/priv/static/index.html`, their `.vite/manifest.json`,
   referenced JS/CSS and packaged icons. The latter is the page the backend
   serves. Follow its imports into the board bundle and verify the frozen swap
   PR's entrypoint, API-base handling, navigation and icon references; finding
   an `index.html` alone is insufficient. Record the concrete asset names and
   hashes. Check that the two static trees agree.
3. Confirm `lib/symphony_elixir-*/ebin/Elixir.SymphonyElixir.SymphonyPlusPlus.SessionLocations.beam`
   and `Elixir.SymphonyElixir.SymphonyPlusPlus.SessionFocus.beam` are present, as
   well as the session-location migration under that application's
   `priv/symphony_plus_plus/repo/migrations/`. Tie these to #731/#732 ancestry and
   the exact build workflow. This proves packaged provenance and presence, not
   native session focus behavior.
4. Verify the archive has the flattened release layout (`bin`, `lib`, `releases`
   and entrypoints at its root) and contains no placeholder `WORKFLOW.md`.

Only after this passes, create a pointer-only PR against beta changing the URL in
`plugins/symphony-plus-plus-mcp/assets/sympp-runtime-artifacts.json` to:

```text
https://github.com/JJLiebig/symphony-plus-plus/releases/download/sympp-v2-beta-2-20261013/sympp-runtime-artifacts-beta.json
```

Use the actual approved tag if it differs. Update current release links in the
docs and both MCP-wiring copies, remove pending labels, and complete hosted
checks and fast review before merging. The pointer commit is an **installation
revision**; `$buildSha` remains the **runtime build revision**. Installed artifact
selection deliberately permits this difference and gates compatibility on the MCP
contract fingerprint. Do not pin the installed cache to `$buildSha` or rebuild
only to make these two SHAs equal. See
[artifact selection](../../plugins/symphony-plus-plus-mcp/scripts/sympp-mcp-artifact-manifest.ps1).

During any future publication, the moving beta source can have a different
contract from the previous artifact. Until publication and pointer promotion
finish, upgrading may fail artifact selection. Keep existing installations
running and do not advertise the candidate as installable during this window.
A pointer to an unpublished URL would add another failure and is unnecessary.

### Release notes

Replace the workflow's generic notes after publishing, using a reviewed file:

```powershell
gh release edit $releaseTag --repo $releaseRepo `
  --title 'Symphony V2 beta — 0.2.0-beta.2' --prerelease `
  --notes-file <reviewed-release-notes-file>
```

Include the exact build SHA, pointer-promotion SHA, hosted run links, archive
inspection evidence, new served operator board, session-location capture/focus,
retention changes below, and this runbook. State unresolved qualification limits.
Beta.1's Windows evidence covered named builds and an empty isolated old-version
upgrade; it did not prove this release or migration of populated business records.
Do not claim beta.2 native qualification from those older results.

## Stop and back up the factory

Start only after the operator approves a cutover window and the promoted beta
pointer resolves to the inspected build. Publication alone does not approve a
factory move. Keep the current factory homes and original ledger; the separate
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
It uses the already-published beta.2 artifact; adding this distribution requires
no new release. An empty-ledger side-by-side beta trial is independent of this
factory cutover. A raw factory copy is not a safe MCP dogfood ledger; offline
snapshot/view rules remain in [development](../development.md#isolated-source-beta).

After the stopped-ledger backup above and an approved cutover window:

1. Retain the original marketplace registration/configuration and artifacts for
   rollback. In the selected replacement Codex home, explicitly disable/remove
   its old Symphony++ MCP plugin or manual entry. Remove the old Claude entry
   only in the project being converted. Setup refuses conflicting entries.
2. In the intended project, select the recorded `SYMPP_HOME`, `SYMPP_DATABASE`
   and `SYMPP_RUNTIME_FILE`, then run the combined Skills install and setup
   commands in the portable guide. This registers one stable installed launcher
   for both hosts. Do not set `SYMPP_REPO_ROOT` or change the ledger path.
3. Open one fresh host session. Require artifact mode, runtime build
   `87d828d528b68e7b35ebb94d307a96b6f2c556ed`, and the original ledger identity.
   For this route `plugin_root` must be the installed skill directory, not a
   marketplace cache. Run the actual-session checks below before the second host.
4. Open the second host and verify shared work and one runtime. Reclaim existing
   assignments before resuming. Never run old and new launchers concurrently
   against the same stopped ledger: older launchers do not honor portable ledger
   ownership receipts. A detected live old owner is refused.

For future Skills upgrades, close clients, save `skills-lock.json`, run
`npx --yes skills@1.7.0 update symphony-plus-plus --project --yes`, and reopen
sessions. If install location changes, repeat setup to repair its owned entry.
Rollback re-adds the previous Skills-capable full commit SHA. This first Skills
release has no earlier Skills-capable release, so restore the paired original
marketplace/configuration/artifact backup for its rollback. Restore the stopped
ledger and sidecars too when migrations or retention require it.

## Marketplace alternative: upgrade and reconnect

Use the same factory environment in every replacement host. Clear developer-only
`SYMPP_REPO_ROOT`, source-root hints and artifact overrides from that environment.
Do not change the ledger path or reuse a sandbox marker. The marketplace source
clone is under `$factoryCodexHome/.tmp/marketplaces/symphony-plus-plus`; normal
runtime execution must come from the installed cache and downloaded artifact.

The following uses the existing Codex marketplace commands. Switching an existing
marketplace from main to beta requires removing its old source registration
before adding the different ref. Run outside the marketplace directory because
replacement renames/removes that directory:

```powershell
$env:CODEX_HOME = $factoryCodexHome
$env:SYMPP_HOME = $factorySymppHome
$env:SYMPP_DATABASE = $factoryDatabase
Set-Location -LiteralPath $env:USERPROFILE
codex plugin marketplace remove symphony-plus-plus
codex plugin marketplace add https://github.com/JJLiebig/symphony-plus-plus --ref beta
codex plugin marketplace upgrade symphony-plus-plus
codex plugin add symphony-plus-plus-mcp@symphony-plus-plus
codex plugin list --marketplace symphony-plus-plus --json
```

Stop on any nonzero exit. If marketplace configuration is managed by a higher
configuration layer, change the source in that layer instead of bypassing its
refusal. Reinstall the skill-only `symphony-plus-plus` plugin too if it was
previously installed. Confirm the resolved version is the published candidate,
the clone contains the promoted pointer and no checkout-backed source hint was
introduced. Do not run a refresh/pin helper from a developer checkout.

For a subsequent upgrade already on beta, the supported helper is
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
stable tag/channel is mutable and may now resolve to another build. Restoring
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
- Beta PRs do not automatically run the three-platform artifact workflow. The
  explicit release build/smoke and archive inspection remain release gates.
- The populated factory ledger, its settings, backlog, migration duration,
  retention effects, backups and restore have not been exercised by this audit.
- Operator mappings, external deployment observations, host permissions,
  authentication and real network/proxy behavior require checks in the intended
  environment. Linux/macOS archives do not establish native host support.

Recommended operator decisions: authorize publication only after the freeze
gates; choose a quiet cutover window with a complete backup; accept the retention
change and restore-based rollback cost; resume with one bounded piece of work
after the native checks pass. If those risks are unacceptable, keep the current
factory installation until the missing qualification is done on an approved host.
