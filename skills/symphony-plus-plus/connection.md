# Separate MCP connection

Portable skill installation does not provide a runtime. Use an already
running Symphony++ cockpit with the intended ledger, or start the existing
operator tooling separately. For a source development environment, install
the repository's `elixir/mise.toml` toolchain and dependencies, then from
`elixir/` run:

```sh
mix sympp.cockpit --port 19998 --database <isolated-ledger-path>
```

Source startup is developer operation, not an installed marketplace runtime.
For normal Codex marketplace operation, use the MCP companion and its existing
launcher; see the [marketplace wiring](references/symphony-work-package/references/mcp_wiring.md).
Keep installed runtimes marketplace-backed. Do not refresh the active plugin
cache from a developer checkout.

For a separately running cockpit, configure the actual endpoint before the
new agent session starts. The examples below use the explicit port above;
substitute the real endpoint when using another port. Each host needs its own
initialized MCP session and claim, connected to the same intended ledger.

Codex configuration for a dedicated home/profile:

```toml
[mcp_servers.symphony_plus_plus]
url = "http://127.0.0.1:19998/mcp"
```

Claude Code, from the intended project (project scope writes `.mcp.json`):

```sh
claude mcp add --transport http --scope project symphony_plus_plus http://127.0.0.1:19998/mcp
```

Follow host approval prompts for that new connection. Verify MCP tools are
available in the actual session before claiming or requesting persistence.
An HTTP health probe does not recover an agent's claim. On reconnection, follow
the procedure's state inspection and uncertain-mutation rules.

Never embed credentials in the skill, repository, prompts, or shared config.
Do not configure generic reviewer sessions to start the Symphony++ backend.
The portable package has been qualified for Skills CLI installation on
Windows for Codex and Claude Code; shared-ledger host runtime qualification
is a separate pilot, not evidence supplied by installing these files.
