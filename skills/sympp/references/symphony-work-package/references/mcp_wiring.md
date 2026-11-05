# sympp MCP Connection

Configure MCP before the model session starts. Skills supply procedures; the
host loads tools. Skill visibility, host configuration and actual session tool
availability are separate facts.

## Windows Skills CLI Installation

The portable `sympp` skill includes the same launcher and published
runtime pointer as the MCP package. Git, Node.js 22.20+, PowerShell 7 and the selected
host are required on Windows x64. No marketplace clone or Codex cache is needed.
Local setup requires Windows x64; remote clients also support Linux and macOS.

Install globally:

```powershell
npx --yes skills@1.7.0 add https://github.com/JJLiebig/sympp/tree/main -g --agent codex claude-code --skill sympp --yes
node $HOME/.agents/skills/sympp/scripts/setup-sympp.js
```

For a project install omit `-g` and use `.agents/skills/sympp/scripts/setup-sympp.js`.
Use one `--agent` for one host. For a Claude-only copy, run setup from
`.claude/skills/sympp/scripts/setup-sympp.js`. Setup detects installed
hosts; `--host codex`, `--host claude` or `--host both` selects explicitly.
An agent recovering missing MCP tools may run this installed setup command.
Then open a fresh model session; setup cannot load tools into an existing one.

Before setup, set `SYMPP_HOME`, `SYMPP_DATABASE`, `SYMPP_RUNTIME_FILE` and optional
`SYMPP_BACKEND_PORT`; both host entries capture those choices. Codex writes only
the selected `CODEX_HOME/config.toml` with 360/300-second startup/tool timeouts.
Claude uses user scope for global installs and the project's `.mcp.json` for project installs. Use a dedicated workspace, host
profiles, sympp home, ledger and port for side-by-side beta; do not reuse
the factory ledger for dogfooding. A raw copied ledger is not an MCP sandbox.

Both hosts share one managed runtime only with the same home/runtime file and
ledger. Setup refuses conflicting unmanaged registrations. It repairs only its own entry.
Keep local machine paths out of committed shared configuration.
Claude local and project entries override user configuration; local entries also override project configuration. If this project has an old
local entry, remove it with `claude mcp remove --scope local sympp`
before opening a fresh session; setup does not inspect that local store.

Close this runtime's clients, then update with
`npx --yes skills@1.7.0 update sympp -g --yes` (or `--project` for a project install) and open fresh
sessions. Skills 1.7.0 retains the beta branch. The stable install path preserves
registration; repeat setup after relocating the installation. Before updating,
back up the installed skill directory and its Skills lock. Rollback re-adds that
local bundle or a known previous Skills-capable commit using `/tree/<full-sha>`
and repeats setup. The lock does not record a resolved installation commit.
Older runtime tags contain procedures only. Ledger migrations and retention
need their own stopped-backup rollback. Setup prints the selected runtime build
and payload digest; changing launcher/procedures does not require a new runtime.

## Shared Runtime And Recovery

The first client starts the packaged runtime and dashboard. Other clients
with matching settings attach; the backend stops after the last client closes.
A clean next start resolves its branch manifest and reuses unchanged verified archive bytes. Read the actual endpoints:

```powershell
$symppRuntime = Get-Content (Join-Path $env:SYMPP_HOME 'runtime/codex-plugin.json') -Raw | ConvertFrom-Json
$symppRuntime.frontend.url
$symppRuntime.backend.mcp_url
```

The launcher prefers loopback port `19998` and falls back to an available
higher port. `SYMPP_BACKEND_PORT` requests a preferred port. Installed dashboard
and MCP share the backend; a separate Vite server is for source development.

Verify `sympp` tools in the actual model session before ledger
work. A health probe does not restore a claim. After reconnect, reclaim the
same assignment and inspect its canonical history before retrying uncertain
mutations. Required native review stays with its declared provider: use the
same declared base for review creation and status, discover the installed
provider, and return its review reference without a duplicate receipt.

Close clients using this beta runtime before a generation upgrade, retain the
beta environment, then run:

```powershell
npx skills update sympp
```

Open fresh sessions. Same-generation backend recovery reconnects existing
bridges; changed plugin generations require fresh host sessions and Claude
registration at the new path. Keep healthy sessions running when only one
client fails. Capture its exact startup error and check its chosen paths before
repair. If home resolution fails, choose explicit absolute home/database paths.

Keep the installed skill separate from developer checkouts. Do not set
`SYMPP_REPO_ROOT` or use a source-root hint as installed proof.
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
[mcp_servers.sympp]
url = "http://127.0.0.1:19998/mcp"
```

For Claude from the intended project:

```sh
claude mcp add --transport http --scope local sympp http://127.0.0.1:19998/mcp
```

Substitute the actual endpoint. URL-only configuration requires an already
listening backend and cannot follow managed dynamic ports or launch it. Each
host needs its own initialized session and claim on the intended ledger.
Do not treat a stateless URL probe as recovered worker authority.

## Optional Worker MCP Claim

Ordinary workers need no MCP connection or claim. When a worker chooses scoped
MCP access, authenticate by calling `claim_local_assignment` in a dedicated sympp MCP
session connected to the same ledger as dispatch. Pass `work_package_id` and,
when provided, `claimed_by`. Before claim, `get_current_assignment()` succeeds
with `assignment: null` and a claim or reclaim action. Reuse the successful claim
assignment; recheck only if binding evidence conflicts or the session reconnects.
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
