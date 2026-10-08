# Symphony++ MCP Connection

Configure MCP before the model session starts. Skills supply procedures; the
host loads tools. Skill visibility, host configuration and actual session tool
availability are separate facts.

## Windows Installed Beta

Use Git, Node.js, PowerShell 7 and Codex on Windows. The skill-only
`symphony-plus-plus` package does not start MCP; dedicated persistent sessions
use `symphony-plus-plus-mcp`. Keep ordinary reviewer sessions MCP-free.

Choose separate beta paths in PowerShell:

```powershell
$env:CODEX_HOME = Join-Path $env:USERPROFILE '.codex-sympp-beta'
$env:SYMPP_HOME = Join-Path $env:USERPROFILE '.agents/splusplus-beta'
$env:SYMPP_DATABASE = Join-Path $env:SYMPP_HOME 'symphony_plus_plus.sqlite3'
codex plugin marketplace add https://github.com/JJLiebig/symphony-plus-plus --ref beta
codex plugin add symphony-plus-plus-mcp@symphony-plus-plus
```

Retain these variables in every beta terminal. `CODEX_HOME` owns the
marketplace/configuration/cache; `SYMPP_HOME` owns launcher state;
`SYMPP_DATABASE` selects the ledger. Only changing `SYMPP_HOME` does not
isolate the ledger. Both hosts must use the same chosen paths to share work.
Use the host's normal sign-in flow in a new home; never copy credentials.

Open a fresh Codex session. The plugin's bundled `.mcp.json` starts its local
command-backed stdio bridge. No separate server command is required.

For Claude Code, install the portable procedures separately, then register
the same installed bridge from the intended project:

```powershell
$symppBridge = Join-Path $env:CODEX_HOME 'plugins/cache/symphony-plus-plus/symphony-plus-plus-mcp/0.2.0-beta.1/scripts/start-sympp-mcp.cmd'
claude mcp add symphony_plus_plus --transport stdio --scope local -e "CODEX_HOME=$env:CODEX_HOME" -e "SYMPP_HOME=$env:SYMPP_HOME" -e "SYMPP_DATABASE=$env:SYMPP_DATABASE" -- cmd.exe /d /s /c "`"$symppBridge`""
```

Follow host approval prompts and start a fresh Claude session. Local scope
keeps registration with that project. The absolute bridge path needs no source
checkout or working directory. If a later upgrade changes the package version,
register the new installed path before reopening Claude.

The beta pointer is
`https://github.com/JJLiebig/symphony-plus-plus/releases/download/sympp-v2-beta-20261007/sympp-runtime-artifacts-beta.json`.
[Release notes](https://github.com/JJLiebig/symphony-plus-plus/releases/tag/sympp-v2-beta-20261007)
identify exact tested builds/hosts. Linux/macOS archives do not establish
native host or plugin support.

## Shared Runtime And Recovery

The first client starts the packaged runtime and dashboard. Other clients
with matching settings attach; the backend stops after the last client closes.
A clean next start reuses its verified artifact. Read the actual endpoints:

```powershell
$symppRuntime = Get-Content (Join-Path $env:SYMPP_HOME 'runtime/codex-plugin.json') -Raw | ConvertFrom-Json
$symppRuntime.frontend.url
$symppRuntime.backend.mcp_url
```

The launcher prefers loopback port `19998` and falls back to an available
higher port. `SYMPP_BACKEND_PORT` requests a preferred port. Installed dashboard
and MCP share the backend; a separate Vite server is for source development.

Verify `symphony_plus_plus` tools in the actual model session before ledger
work. A health probe does not restore a claim. After reconnect, reclaim the
same assignment and inspect its canonical history before retrying uncertain
mutations. Required native review stays with its declared provider: use the
same declared base for review creation and status, discover the installed
provider, and return its review reference without a duplicate receipt.

Close clients using this beta runtime before a generation upgrade, retain the
beta environment, then run:

```powershell
codex plugin marketplace upgrade symphony-plus-plus
```

Open fresh sessions. Same-generation backend recovery reconnects existing
bridges; changed plugin generations require fresh host sessions and Claude
registration at the new path. Keep healthy sessions running when only one
client fails. Capture its exact startup error and check its chosen paths before
repair. If home resolution fails, choose explicit absolute home/database paths.

Installed caches are marketplace-owned. Never repair them from a developer
checkout, set `SYMPP_REPO_ROOT`, or use a source-root hint as installed proof.
No runtime manifest override is needed. Source validation stays in isolated
developer homes. Do not put tokens or grant secrets in shared configurations.

## Explicit Developer HTTP Connection

For source experiments, install the repository's Elixir toolchain/dependencies
and run from `elixir/`:

```sh
mix sympp.cockpit --port 19998 --database <isolated-ledger-path>
```

Configure the printed endpoint before the agent starts. For a dedicated Codex
configuration:

```toml
[mcp_servers.symphony_plus_plus]
url = "http://127.0.0.1:19998/mcp"
```

For Claude from the intended project:

```sh
claude mcp add --transport http --scope local symphony_plus_plus http://127.0.0.1:19998/mcp
```

Substitute the actual endpoint. URL-only configuration requires an already
listening backend and cannot follow managed dynamic ports or launch it. Each
host needs its own initialized session and claim on the intended ledger.
Do not treat a stateless URL probe as recovered worker authority.

## Worker Claim

Workers start by calling `claim_local_assignment` in a dedicated S++ MCP
session connected to the same ledger as dispatch. Pass `work_package_id` and,
when provided, `claimed_by`. Before claim, `get_current_assignment()` succeeds
with `assignment: null` and a claim or reclaim action. After claim, call
`get_current_assignment()` and read package context without re-listing tools.
The first successful claim atomically activates a `ready_for_worker` package.
Release changes authorization and scope without changing the advertised tool
catalog.

Replaying the same claim heartbeats the current claim lease. If the prior lease
is stale, the server may reclaim it and records audit evidence without
rewriting the current package lifecycle. If the lease is
paused or another active owner still has authority, stop and ask the
architect/operator to repair that state. A configured `state_key` only
preserves initialized handshake continuity for stateless transports; it does
not restore worker authorization by itself.
