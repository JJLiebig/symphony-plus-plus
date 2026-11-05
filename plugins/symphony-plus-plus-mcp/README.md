# sympp MCP Companion

This `0.2.0` package supplies MCP procedures and the Windows
command-backed bridge for dedicated Codex and Claude Code sessions. Its first
client starts the packaged backend/dashboard; clients with matching settings
share it. The backend closes after the last client detaches.

Use separate beta Codex and sympp homes and an explicit database. Follow
[Install and run](https://github.com/JJLiebig/sympp/blob/main/docs/runtime.md)
for user setup, or the self-contained
[connection procedure](skills/symphony-work-package/references/mcp_wiring.md)
for host registration and assignment recovery.

The package includes:

- The `.mcp.json` stdio bridge configuration loaded by Codex.
- Solo Session, worker, coordinator, WorkPackage and architect procedures.
- The existing Windows launcher used by both hosts.
- The [beta runtime pointer](https://github.com/JJLiebig/sympp/releases/download/sympp-runtime-beta/sympp-runtime-artifacts-beta.json).

Main and beta runtimes publish automatically from their branch pushes.
See the runtime guide for actual provenance and native qualification limits. Linux/macOS archives do not establish
native host support.

## Package boundary

This directory owns the launcher and procedures mirrored into the portable
[sympp skill](../../skills/sympp/SKILL.md). Install with `npx skills add JJLiebig/sympp`
and ask the agent to set up sympp. Setup registers `sympp` in Codex and Claude;
open a fresh session to load the tools. Use `sympp status` to check the factory.
