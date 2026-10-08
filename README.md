# Symphony++

Symphony++ is a local planning and delivery cockpit for coding agents. Its
ledger, MCP tools, and dashboard connect WorkRequests, bounded WorkPackages,
decisions, blockers, and GitHub delivery evidence.

A human and agent can explore a problem before creating a WorkRequest. An
architect then slices and oversees tracked delivery. Ordinary workers and
coordinators also work without a backend; optional Solo Sessions provide
lightweight planning memory through MCP. Symphony++ does not own model
accounts or terminal sessions.

## Install

Windows beta installation and connection for Codex or Claude Code:

Follow [Install and run](docs/runtime.md) to select separate beta homes and a
ledger, install `0.2.0-beta.1`, connect either host and open the board.
[Beta release notes](https://github.com/JJLiebig/symphony-plus-plus/releases/tag/sympp-v2-beta-20261007)
identify the exact tested build and hosts.

Portable procedures without runtime installation:

```sh
npx skills add https://github.com/JJLiebig/symphony-plus-plus/tree/beta
```

This installs procedures only. See [Portable skills](docs/portable-skills.md)
for host selection, updates, removal, and separate MCP setup.

For skill-only Codex use, choose a separate beta home and add the marketplace:

```powershell
$env:CODEX_HOME = Join-Path $env:USERPROFILE '.codex-sympp-beta'
New-Item -ItemType Directory -Force -Path $env:CODEX_HOME | Out-Null
codex plugin marketplace add https://github.com/JJLiebig/symphony-plus-plus --ref beta
codex plugin marketplace upgrade symphony-plus-plus
```

Choose the skill-only plugin for ordinary workers/coordinators:

```powershell
codex plugin add symphony-plus-plus@symphony-plus-plus
```

Update packages and open a fresh Codex session:

```powershell
codex plugin marketplace upgrade symphony-plus-plus
```

Do not install both plugins in the same Codex home unless you intentionally
want both skill prefixes visible. The MCP companion starts or reuses the local
runtime and serves its dashboard. See [Runtime](docs/runtime.md) for actual
endpoint lookup, lifecycle, beta isolation, and repair.

## Documentation

- [Documentation index](docs/README.md): current system, operations, security,
  development, and recovery.
- [Default plugin](plugins/symphony-plus-plus/README.md) and
  [MCP companion](plugins/symphony-plus-plus-mcp/README.md): package boundaries.
- [Product](PRODUCT.md) and [Design](DESIGN.md): purpose and interface principles.
- [Factory workflow](docs/design/factory-workflow.md): approved beta contract
  and editable human diagram.
- [Upstream specification](SPEC.md): upstream Symphony behavior.

## License

Apache 2.0. See [LICENSE](LICENSE).
