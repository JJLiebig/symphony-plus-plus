# Symphony++

Symphony++ is a local planning and delivery cockpit for coding agents. Its
ledger, MCP tools, and dashboard connect WorkRequests, bounded WorkPackages,
decisions, blockers, and GitHub delivery evidence.

A human and agent can explore a problem before creating a WorkRequest. An
architect then slices and oversees tracked delivery. Ordinary workers and
coordinators also work without a backend; optional Solo Sessions provide
lightweight planning memory through MCP. Symphony++ does not own model
accounts or terminal sessions.

Ordinary workers receive an assignment, implement it, run required native checks
and review, and return a PR or evidence. The architect coordinates ownership,
dependencies, explicit blockers, readiness, and delivery; worker MCP calls and
duplicate status/review reporting are optional.

## Install

For an always-on Linux factory shared across devices, see [Linux service](docs/linux-service.md).

Windows installation and connection for Codex or Claude Code:

Follow [Portable skills](docs/portable-skills.md) for the default global install
and setup, or a project install. Main is the normal branch; beta is an isolated
preview. Close clients, update, run setup and open fresh sessions to adopt the
latest published build. See [Install and run](docs/runtime.md) for runtime details.

Existing Codex marketplace installations can update with:

```powershell
codex plugin marketplace upgrade symphony-plus-plus
```

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
