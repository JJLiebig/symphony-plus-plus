# MCP Connection

This skill includes the Windows x64 launcher, bridge, contract identity and
published runtime pointer. Git, Node.js 22.20+, PowerShell 7 and the selected host
must be available. No Codex marketplace or source checkout is required.

Install globally with `npx skills add JJLiebig/sympp -g`, then run:

```powershell
node $HOME/.agents/skills/sympp/scripts/setup-sympp.js
```

For a Claude-only copy, use
`$HOME/.claude/skills/sympp/scripts/setup-sympp.js`. The default detects
Codex and Claude Code on PATH; `--host codex`, `--host claude`, or `--host both`
selects explicitly. An agent may run setup when required MCP tools are missing.
Setup does not restart sessions or add tools to an already-open model session.
Report that a fresh session is needed, then verify native MCP tools there.

Set `SYMPP_HOME`, `SYMPP_DATABASE`, `SYMPP_RUNTIME_FILE` and optionally
`SYMPP_BACKEND_PORT` before setup. Both host entries capture those selections.
Codex configuration uses `CODEX_HOME`; Claude uses user scope.
For isolated trials use separate host profiles, runtime home,
ledger and port. Do not commit machine-specific MCP config to shared repositories.

Repeat setup to repair its own registration. It refuses unrelated entries.
Do not overwrite those blindly or stop healthy sessions to repair one client.
Claude local and project entries override user configuration; local entries
also override project configuration. If this project has an old
local entry, remove it with `claude mcp remove --scope local sympp`
before opening a fresh session; setup does not inspect that local store.

Setup prints runtime SHA and install digest. Close this runtime's clients,
update with `npx skills update sympp -g`,
and open fresh sessions. Re-run setup after relocation or changed configuration.
Before updating, back up the installed skill directory and its Skills lock.
Rollback re-adds that bundle or a known previous Skills-capable commit and
selects its pointer; ledger rollback may require a stopped backup. A raw ledger copy
is not a safe MCP sandbox.

For a consistent offline copy, use the installed helper with an explicit source
and a new empty home separate from every online runtime. Python 3.9+ is required
only for Snapshot; both actions require PowerShell 7 on Windows x64:

```powershell
$offlineHelper = Join-Path $HOME '.agents/skills/sympp/scripts/sympp-offline.ps1'
$offlineHome = Join-Path $env:USERPROFILE 'sympp-offline-view'
pwsh -NoProfile -File $offlineHelper -Action Snapshot -SourceDatabase 'C:\explicit\source.sqlite3' -SymppHome $offlineHome
pwsh -NoProfile -File $offlineHelper -Action View -SymppHome $offlineHome -Port 21498
```

Claude-only installs use `$HOME/.claude/skills/sympp/scripts/sympp-offline.ps1`.
Open `http://127.0.0.1:21498/sympp/board`; use an unused port different from the
online dogfood runtime. Press Ctrl+C and wait for View to exit before repeating
Snapshot with `-ReplaceSnapshot`. The source may remain open. Conversion and
viewing use the selected published artifact without a checkout or Elixir.
The copy has no MCP/agent access or external worktree/PR actions. Keep its
offline marker, never promote it to live, and keep copied private data local.

The [connection procedure](references/symphony-work-package/references/mcp_wiring.md)
covers developer connections and assignment recovery. Skill
visibility and health probes do not restore claims. Keep credentials out of
skills, prompts and shared config; ordinary reviewers need no backend.

## Linux factory server

To install an always-on factory on Linux from this Skills bundle, run
`SYMPP_SERVICE_HOST=100.123.207.19 bash ~/.agents/skills/sympp/scripts/setup-sympp-service.sh`.
See the [Linux service guide](https://github.com/JJLiebig/sympp/blob/main/docs/linux-service.md)
for prerequisites, ledger selection and the private token used by remote clients.
This command installs the server; client registration is separate.

## Connect to an existing factory

Run setup with `--server <ssh-host>` to use an always-on factory over the private
network. Setup resolves the SSH alias and reads its token once, stores that token
with user-only permissions, and registers the bridge in the selected Codex home
and Claude user scope. `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `SYMPP_HOME` select
isolated client homes. The bridge never starts a local factory in this mode.

```sh
sympp --server jjdev
```

On the factory machine itself, use `--server http://127.0.0.1:19998` (no token or
SSH needed). Remote client setup and the bridge support Windows and Linux.

For the optional Herdr panel, run
`node integrations/herdr-next/install.mjs --server jjdev --check --replace`.
The panel uses the same remote factory and does not start it when unreachable.
Rerun setup or panel installation after rotating the server token.

Setup installs `sympp` in `~/.local/bin` and adds it to the user PATH. Open a
fresh terminal from the Windows Start menu, or a Unix login shell, then use `sympp --server <ssh-host>`, `sympp` for local setup,
or `sympp status` to see the selected factory and whether it answers. Re-running
setup migrates its old managed MCP registration to `sympp`.

If setup prints `activate` on Linux/macOS, run the printed export in the shell
where you will type `sympp`; opening a tab in an existing terminal may retain
its previous PATH. `sympp status` succeeds when the factory answers with a
reachable ledger.

Run `sympp board` to open the selected factory in your default browser, signed in
using the token saved by setup. The browser session lasts 30 days; rotating the
factory token invalidates it. Plain tailnet browser visits are read-only.
