# MCP Connection

This skill includes the Windows x64 launcher, bridge, contract identity and
published runtime pointer. Git, Node.js 22.20+, PowerShell 7 and the selected host
must be available. No Codex marketplace or source checkout is required.

From the project that will use Symphony++, run:

```powershell
node .agents/skills/symphony-plus-plus/scripts/setup-sympp.js
```

For a Claude-only copy, use
`.claude/skills/symphony-plus-plus/scripts/setup-sympp.js`. The default detects
Codex and Claude Code on PATH; `--host codex`, `--host claude`, or `--host both`
selects explicitly. An agent may run setup when required MCP tools are missing.
Setup does not restart sessions or add tools to an already-open model session.
Report that a fresh session is needed, then verify native MCP tools there.

Set `SYMPP_HOME`, `SYMPP_DATABASE`, `SYMPP_RUNTIME_FILE` and optionally
`SYMPP_BACKEND_PORT` before setup. Both host entries capture those selections.
Codex configuration uses `CODEX_HOME`; Claude uses this project's `.mcp.json`.
For side-by-side beta use a separate workspace, host profiles, runtime home,
ledger and port. Do not commit machine-specific MCP config to shared repositories.

Repeat setup to repair its own registration. It refuses unrelated entries and
enabled Symphony++ MCP marketplace registration in the selected Codex home.
Do not overwrite those blindly or stop healthy sessions to repair one client.
Claude local entries override project configuration. If this project has an old
local entry, remove it with `claude mcp remove --scope local symphony_plus_plus`
before opening a fresh session; setup does not inspect that local store.

Setup prints runtime SHA and install digest. Close this runtime's clients,
update with `npx --yes skills@1.7.0 update symphony-plus-plus --project --yes`,
and open fresh sessions. Re-run setup after relocation or changed configuration.
Before updating, back up the installed skill directory and project lock.
Rollback re-adds that bundle or a known previous Skills-capable commit and
selects its pointer; ledger rollback may require a stopped backup. A raw ledger copy
is not a safe MCP sandbox.

For a consistent offline copy, use the installed helper with an explicit source
and a new empty home separate from every online runtime. Python 3.9+ is required
only for Snapshot; both actions require PowerShell 7 on Windows x64:

```powershell
$offlineHelper = '.agents/skills/symphony-plus-plus/scripts/sympp-offline.ps1'
$offlineHome = Join-Path $env:USERPROFILE 'sympp-offline-view'
pwsh -NoProfile -File $offlineHelper -Action Snapshot -SourceDatabase 'C:\explicit\source.sqlite3' -SymppHome $offlineHome
pwsh -NoProfile -File $offlineHelper -Action View -SymppHome $offlineHome -Port 21498
```

Claude-only installs use `.claude/skills/symphony-plus-plus/scripts/sympp-offline.ps1`.
Open `http://127.0.0.1:21498/sympp/board`; use an unused port different from the
online dogfood runtime. Press Ctrl+C and wait for View to exit before repeating
Snapshot with `-ReplaceSnapshot`. The source may remain open. Conversion and
viewing use the selected published artifact without a checkout or Elixir.
The copy has no MCP/agent access or external worktree/PR actions. Keep its
offline marker, never promote it to live, and keep copied private data local.
Branch updates can change these procedures while still selecting beta.2;
later runtime and settings UI changes need a new published artifact.

The [connection procedure](references/symphony-work-package/references/mcp_wiring.md)
covers marketplace/developer alternatives and assignment recovery. Skill
visibility and health probes do not restore claims. Keep credentials out of
skills, prompts and shared config; ordinary reviewers need no backend.
