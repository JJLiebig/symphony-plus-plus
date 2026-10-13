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

Setup prints runtime SHA and install digest. Close this runtime's clients,
update with `npx --yes skills@1.7.0 update symphony-plus-plus --project --yes`,
and open fresh sessions. Re-run setup after relocation or changed configuration.
Before updating, back up the installed skill directory and project lock.
Rollback re-adds that bundle or a known previous Skills-capable commit and
selects its pointer; ledger rollback may require a stopped backup. A raw ledger copy
is not a safe MCP sandbox.

The [connection procedure](references/symphony-work-package/references/mcp_wiring.md)
covers marketplace/developer alternatives and assignment recovery. Skill
visibility and health probes do not restore claims. Keep credentials out of
skills, prompts and shared config; ordinary reviewers need no backend.
