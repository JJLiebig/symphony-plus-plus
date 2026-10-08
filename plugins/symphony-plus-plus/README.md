# Symphony++ Codex Plugin

This `0.2.0-beta.1` package is skill-only. It supplies worker, coordinator and
Solo Session procedures without starting Symphony++ MCP. Ordinary work needs
no backend when persistence is not requested. Ledger operations, including
Solo Sessions, require configured MCP tools.

## Install

Use a separate beta Codex home:

```powershell
$env:CODEX_HOME = Join-Path $env:USERPROFILE '.codex-sympp-beta'
codex plugin marketplace add https://github.com/JJLiebig/symphony-plus-plus --ref beta
codex plugin add symphony-plus-plus@symphony-plus-plus
```

Update in the same home and open a fresh Codex session:

```powershell
codex plugin marketplace upgrade symphony-plus-plus
```

For persistence or assigned execution, choose the sibling
`symphony-plus-plus-mcp` package instead. Its
[installation guide](https://github.com/JJLiebig/symphony-plus-plus/blob/beta/docs/runtime.md)
covers beta homes and ledger, shared Codex/Claude runtime, dashboard and recovery.
Do not install both packages unless both skill prefixes are intended.

## Development

The marketplace routes both packages to Git `beta`. Repository refresh helpers
are for isolated developer homes, not installed runtime repair. See
[Development](https://github.com/JJLiebig/symphony-plus-plus/blob/beta/docs/development.md)
for source validation.
