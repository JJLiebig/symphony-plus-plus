# Install And Run Symphony++

The beta package is `0.2.0-beta.2`. These native connections are for Windows
Codex and Claude Code. [Beta release notes](https://github.com/JJLiebig/symphony-plus-plus/releases/tag/sympp-v2-beta-2-20261013)
record the build, hosted checks, and native qualification limits. Linux/macOS runtime archives do not
establish native plugin or host support.

## Install With Skills CLI

The [portable installation guide](portable-skills.md) has exact Claude-only,
Codex-only and combined install commands, plus an isolated empty-ledger dogfood
recipe. `npx --yes skills@1.7.0 add .../tree/beta` installs the procedures and
launcher; one `node <installed-skill>/scripts/setup-sympp.js` command registers
detected hosts. It selects the published beta.2 build
`87d828d528b68e7b35ebb94d307a96b6f2c556ed`, with no marketplace or source checkout.

This route uses `CODEX_HOME` only for Codex configuration. Claude uses the project
`.mcp.json`. Setup captures shared home, explicit ledger and runtime-file paths,
so fresh terminals use the intended runtime. Open fresh host sessions after
setup. Separate beta profiles, home, ledger and port allow the existing main
factory to keep running. Never use the factory ledger for an empty-ledger trial.

Update with `npx --yes skills@1.7.0 update symphony-plus-plus --project --yes`
and fresh sessions. Repeat setup after relocating the installation. Rollback
re-adds a saved bundle or previous Skills-capable commit, selecting its artifact
pointer; database rollback remains a separate stopped-backup operation.

For populated records, the [installed offline viewer](portable-skills.md#copy-convert-and-view-an-offline-ledger)
copies an explicit source through SQLite's online backup and converts the copy
with this published artifact. Its separate home and port support viewing while
the source runtime remains open. Python is needed only for copying. The viewer
has no MCP/agent access; Ctrl+C stops it before refresh. Never promote the copy
to live. Procedures installed from beta can be newer than beta.2's runtime and
UI; branch installation alone does not install later settings UI changes.

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
$symppBridge = Join-Path $env:CODEX_HOME 'plugins/cache/symphony-plus-plus/symphony-plus-plus-mcp/0.2.0-beta.2/scripts/start-sympp-mcp.cmd'
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

For moving an existing factory ledger from main to beta, follow the
[release and cutover runbook](runbooks/beta-release-cutover.md), including its
publication gate, stopped-ledger backup, migration effects and rollback.

The first client starts the runtime; clients with matching settings attach.
Closing one host leaves the other usable. The backend stops after the last
client detaches. The next session can restart the verified artifact without
downloading the channel manifest again. Changed package generation or launch
settings require full preparation.

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
and shipped beta artifact pointer.

If startup cannot resolve a home, choose explicit absolute home and database
paths. For persistent failures, compare the installed version and release notes
and capture the exact host error before repair. Do not overwrite runtime state
or stop another healthy host to repair one failed attachment.

## Developer Diagnostics

New runtime builds use `<SYMPP_HOME>/rt/<platform>/<hash16>/runtime`, with the
release directly inside that directory. Full artifact hashes and source
provenance remain verified metadata. Beta.2 pairs this flattened archive layout
with the updated launcher; beta.1 used the old layout. Do not refresh an installed
runtime with an unqualified source build.

Source validation, manual HTTP connections, beta runtime controls and
performance checks are [developer operations](development.md), separate from
installed qualification. An elevated Windows client starts a new backend
through the logged-in desktop user; the desktop shell must be available.
