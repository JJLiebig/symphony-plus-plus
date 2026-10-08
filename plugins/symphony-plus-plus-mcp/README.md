# Symphony++ MCP Companion

This `0.2.0-beta.1` package supplies MCP procedures and the Windows
command-backed bridge for dedicated Codex and Claude Code sessions. Its first
client starts the packaged backend/dashboard; clients with matching settings
share it. The backend closes after the last client detaches.

Use separate beta Codex and Symphony++ homes and an explicit database. Follow
[Install and run](https://github.com/JJLiebig/symphony-plus-plus/blob/beta/docs/runtime.md)
for user setup, or the self-contained
[connection procedure](skills/symphony-work-package/references/mcp_wiring.md)
for host registration and assignment recovery.

The package includes:

- The `.mcp.json` stdio bridge configuration loaded by Codex.
- Solo Session, worker, coordinator, WorkPackage and architect procedures.
- The existing Windows launcher used by both hosts.
- The [beta runtime pointer](https://github.com/JJLiebig/symphony-plus-plus/releases/download/sympp-v2-beta-20261007/sympp-runtime-artifacts-beta.json).

[Beta release notes](https://github.com/JJLiebig/symphony-plus-plus/releases/tag/sympp-v2-beta-20261007)
record the exact tested build and hosts. Linux/macOS archives do not establish
native host support.

## Package Boundary

The default `symphony-plus-plus` plugin is skill-only. Choose the companion
for persistence or assigned execution; keep ordinary review sessions on the
skill-only package. Enabling the companion starts its MCP connection at session
startup. Choose one package per home unless both skill prefixes are intended.

Skill visibility does not prove an already-open session loaded MCP tools.
Open a fresh session after installation or upgrade. Installed runtime ownership
stays with the plugin cache and marketplace clone. Do not use a developer
checkout, `SYMPP_REPO_ROOT`, source-root hints or repository cache refresh
for installed operation. Upgrade the owning marketplace and open fresh sessions.
