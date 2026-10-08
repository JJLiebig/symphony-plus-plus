# MCP Connection

Portable installation supplies procedures only. It does not install,
configure or start a runtime.

For Windows Codex or Claude Code, use the installed MCP companion's existing
command-backed bridge. The self-contained
[connection procedure](references/symphony-work-package/references/mcp_wiring.md)
covers beta installation, host registration, shared startup, upgrades and
assignment recovery. Codex loads its bundled MCP configuration; Claude
registers the absolute installed bridge path. Both hosts use the same chosen
Codex home, Symphony++ home and explicit database to share work.

A separately running HTTP cockpit is an explicit developer/operator option,
also described there. It must be listening before the agent connects and does
not provide the installed bridge's managed lifecycle.

Verify MCP tools in the actual session before claims or persistent planning.
Skill discovery and health probes do not recover claims. Keep credentials out
of skills, prompts and shared config; ordinary reviewers need no Symphony++ backend.
