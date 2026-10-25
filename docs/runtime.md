# Install And Run

Symphony++ `0.2.0` supports native Codex and Claude Code connections on Windows x64.
Use [Skills installation](portable-skills.md) for the normal host-neutral route.
Install main for normal work; `/tree/beta` selects an isolated preview.

Setup reads the Skills lock's selected branch and registers its runtime channel
for both hosts. Marketplace connections read the owning clone's branch metadata.
Main follows `stable`; beta follows `beta`. Hosted builds publish automatically
on branch pushes, without a manual release tag or pointer promotion.

Close every client of this factory before updating, run Skills update and setup,
and open fresh sessions. A cold factory selects the latest successfully published
branch artifact. Healthy clients share their existing runtime until they close;
there is no hot replacement. Artifact checksums, MCP contract compatibility and
actual source SHA remain verified. Publication can lag source head; read the
running SHA and manifest before relying on a newly merged feature.
For a coordinated restart of an existing Windows beta Skills factory, use the
[beta reload command](#reload-an-existing-windows-beta-factory) below.

Keep beta's home, runtime file, port and ledger separate from the original factory.
Use an empty ledger for real dogfood work. A copied live ledger is inspection-only:
[Copy and View](portable-skills.md#copy-convert-and-view-an-offline-ledger) uses
SQLite's online backup, a durable offline marker and a separate home/port. The
viewer has no MCP/agent access; Ctrl+C stops it before refresh. Never promote the
copy to live. A factory move requires the [stopped-ledger backup and cutover
procedure](runbooks/beta-release-cutover.md).

## Marketplace Alternative In A Separate Beta Home

Use PowerShell with Git, Node.js, PowerShell 7 and Codex available. Choose
separate beta paths so your stable installation and ledger remain independent:

```powershell
$env:CODEX_HOME = Join-Path $env:USERPROFILE '.codex-sympp-beta'
New-Item -ItemType Directory -Force -Path $env:CODEX_HOME | Out-Null
$env:SYMPP_HOME = Join-Path $env:USERPROFILE '.agents/splusplus-beta'
$env:SYMPP_DATABASE = Join-Path $env:SYMPP_HOME 'symphony_plus_plus.sqlite3'
codex plugin marketplace add https://github.com/JJLiebig/symphony-plus-plus --ref beta
codex plugin marketplace upgrade symphony-plus-plus
codex plugin add symphony-plus-plus-mcp@symphony-plus-plus
codex
```

Retain these variables in each beta terminal. `CODEX_HOME` selects the plugin
installation and Codex configuration; `SYMPP_HOME` selects launcher state;
`SYMPP_DATABASE` selects the ledger. Setting only `SYMPP_HOME` does not
select a separate ledger. Use the same three paths for both hosts to share work.

A fresh Codex session loads MCP tools and starts or attaches to the packaged
runtime. A separate Codex home has its own authentication; use Codex's normal
sign-in flow when required. Do not copy credentials.

For Claude Code, install the [portable procedures](portable-skills.md), then
register the same installed bridge from the intended project:

```powershell
$symppBridge = Join-Path $env:CODEX_HOME 'plugins/cache/symphony-plus-plus/symphony-plus-plus-mcp/0.2.0/scripts/start-sympp-mcp.cmd'
claude mcp add symphony_plus_plus --transport stdio --scope local -e "CODEX_HOME=$env:CODEX_HOME" -e "SYMPP_HOME=$env:SYMPP_HOME" -e "SYMPP_DATABASE=$env:SYMPP_DATABASE" -- cmd.exe /d /s /c "`"$symppBridge`""
claude
```

Follow host approval prompts. Verify `symphony_plus_plus` tools in the actual
session before ledger work. Skills alone do not connect MCP. The authoritative
[connection procedure](../plugins/symphony-plus-plus-mcp/skills/symphony-work-package/references/mcp_wiring.md)
covers host setup, claims and developer connections.

## Open The Board

The packaged backend serves the dashboard; no separate frontend is needed.
Read the actual URL after the first connection:

```powershell
$symppRuntime = Get-Content (Join-Path $env:SYMPP_HOME 'runtime/codex-plugin.json') -Raw | ConvertFrom-Json
$symppRuntime.frontend.url
$symppRuntime.backend.mcp_url
```

The launcher prefers loopback port `19998` and tries higher available ports
when needed. `SYMPP_BACKEND_PORT` requests a preferred port. Use the recorded
URL. See [Operations](operations.md) for the Work board and starting a request.

## Attach, Close And Recover

### Reload an existing Windows beta factory

From an S++ checkout on your logged-in Windows desktop, use explicit absolute
factory and Herdr-app homes:

```powershell
pwsh -File scripts/install-sympp-beta.ps1 -SymppHome C:/Users/jonat/sympp-herdr-next/.sympp-beta -HerdrAppHome C:/Users/jonat/.config/herdr-app
```

This installs the latest **published beta runtime**, plus the checkout's generated
Skills bundle and native view. Published binaries keep repeat installs fast without
a local Elixir toolchain. Publication can lag a branch push; the command reports
the exact running SHA, rather than claiming the checkout is running. To select
an already downloaded beta channel manifest, pass `-ArtifactManifest <path>`.

The factory must already use an official project-local beta Skills installation
and a managed artifact backend. Its data home must be inside that workspace,
outside the managed Skills directory, with a separate `beta` word in its final
folder (such as `.sympp-beta`), its own port, and its database inside that home. Default
production homes, stable Skills installations, global Skills, marketplace caches,
linked paths and stable ports are refused. The command never updates a plugin
cache or host registration. The checkout bundle and published artifact must share
an MCP contract; when publication lags, the command refuses before interrupting
the old runtime. The beta workspace's own Skills directory stays at its registered
path. Actual file changes are detected even if its package marker was not updated.

The archive and native files are prepared before the backend is stopped. The
installed launcher restarts the same endpoint and ledger, and readiness must
match the selected revision, contract and database. An unchanged runtime and bundle
are not replaced while the backend is running; identical native files are not
rewritten.
When the recorded backend has stopped, installation skips its readiness check and
stop step, then starts and verifies the selected runtime on the same endpoint and
ledger. This catches startup failures during installation. Without a connected
MCP client, normal idle cleanup stops it; the next client starts it again.
The old Skills directory is backed up during cutover. A failed restart or native
installation restores that
directory and restarts the retained previous artifact with its original contract.
Ledger contents are never restored or copied; startup performs only the backend's
normal additive updates.
The selected runtime stays pinned in this beta Skills installation until the
next install command selects a newer publication.

If startup reports that the Skills bundle and runtime channel have different MCP
contracts, run the beta install command above or update the project Skills with
`npx skills update symphony-plus-plus --project --yes`, then open fresh MCP client
sessions. A channel publication can move ahead of the installed bundle while the
factory is stopped.

After a Skills bundle change, **open fresh sessions for every MCP client**, including
the coordinating architect. An artifact-only restart leaves the bundle intact;
connected STDIO bridges reconnect to the same endpoint on their next request.
Requests overlapping the restart can fail; reload that client's MCP connection
if it reports an error. Check the result of an interrupted write before retrying
it. Fresh host sessions load the updated procedures and tool list.
Do not run this against a shared live beta factory until its coordinating
architect has agreed to the restart timing.

For moving an existing factory ledger from main to beta, follow the
[release and cutover runbook](runbooks/beta-release-cutover.md), including its
branch selection, stopped-ledger backup, migration effects and rollback.

The first client starts the runtime; clients with matching settings attach.
Closing one host leaves the other usable. The backend stops after the last
client detaches. A cold branch-tracking factory resolves the current channel manifest again; its
verified archive cache avoids downloading unchanged runtime bytes. Changed
package generation or launch settings require full preparation.

For a connection failure, keep healthy sessions running. Check the recorded
endpoint and host error, then reconnect the affected host. A health probe does
not restore a worker claim: reclaim the same assignment in the actual session
and read its prior evidence before retrying an uncertain write. The
[WorkPackage procedure](../plugins/symphony-plus-plus-mcp/skills/symphony-work-package/SKILL.md)
owns that recovery.

For an upgrade, close clients using this beta runtime, retain the beta
environment variables, and run:

```powershell
codex plugin marketplace upgrade symphony-plus-plus
```

Open fresh sessions. If the package version changes, update Claude's bridge
registration to the installed version before reopening Claude. Never refresh
an installed cache from a developer checkout or set `SYMPP_REPO_ROOT` for
normal installed use. The bridge resolves its owning marketplace source clone
and selects its recorded branch channel.

If startup cannot resolve a home, choose explicit absolute home and database
paths. For persistent failures, compare the installed version and release notes
and capture the exact host error before repair. Do not overwrite runtime state
or stop another healthy host to repair one failed attachment.

## Developer Diagnostics

New runtime builds use `<SYMPP_HOME>/rt/<platform>/<hash16>/runtime`, with the
release directly inside that directory. Full artifact hashes and source
provenance remain verified metadata. The current launcher uses this flattened archive layout. Do not refresh an installed
runtime with an unqualified source build.

Source validation, manual HTTP connections, beta runtime controls and
performance checks are [developer operations](development.md), separate from
installed qualification. An elevated Windows client starts a new backend
through the logged-in desktop user; the desktop shell must be available.
