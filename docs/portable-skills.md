# Portable Skills Installation

Install Symphony++ procedures for Codex or Claude Code with the
[Skills CLI](https://github.com/vercel-labs/skills). Node.js, npm/npx and Git
must be available. This route is alongside the Codex marketplace; it does not
install, configure, or start the Symphony++ backend.

From the intended project directory:

```sh
npx skills add https://github.com/JJLiebig/symphony-plus-plus/tree/beta
```

The repository exposes one portable skill, `symphony-plus-plus`. For an
explicit, non-interactive host selection:

```sh
npx skills add https://github.com/JJLiebig/symphony-plus-plus/tree/beta --agent codex --skill symphony-plus-plus --yes
npx skills add https://github.com/JJLiebig/symphony-plus-plus/tree/beta --agent claude-code --skill symphony-plus-plus --yes
```

These are project installs. Codex uses `.agents/skills/symphony-plus-plus`;
Claude Code uses `.claude/skills/symphony-plus-plus`, normally linked to the
shared project `.agents/skills` directory. Add `--copy` when a standalone copy
is preferred. The examples use project scope. Avoid installing the portable
bundle and equivalent marketplace procedures in the same host unless both
entrypoints are intended.

Inspect discovery and installed host selections:

```sh
npx skills add https://github.com/JJLiebig/symphony-plus-plus/tree/beta --list
npx skills list --agent codex
npx skills list --agent claude-code
```

Update or remove the project installation from that project directory:

```sh
npx skills update symphony-plus-plus --project
npx skills remove symphony-plus-plus --yes
```

Removal without `--agent` removes the bundle and all its host links. To detach
one host while keeping the shared payload, add `--agent codex` or
`--agent claude-code`.

To refresh the installed payload even when its source revision is unchanged,
repeat its targeted `add` command. Keep the same installation mode
(`--copy`, if used) when refreshing. Use the same beta source when refreshing.

## Procedures And MCP

Invoke `$symphony-plus-plus` in Codex or `/symphony-plus-plus` in Claude Code.
The [entrypoint](../skills/symphony-plus-plus/SKILL.md) routes to complete local
procedures for architect, coordinator, worker, WorkPackage, and Solo work.
Ordinary coordination and implementation need no backend when persistence is
not requested. Ledger operations require `symphony_plus_plus` MCP tools in the
actual agent session, with the intended ledger and assignment.

Follow the packaged [connection guide](../skills/symphony-plus-plus/connection.md)
for Windows Codex/Claude connection through the installed MCP companion. Shell
startup and diagnostic tools remain supported. Business CLI commands, direct
SQLite access, and private state files are not agent ledger fallbacks.
Skill discovery does not prove MCP availability.

The existing [Codex marketplace installation](../README.md#install) retains its
skill-only and MCP companion packages. Use marketplace upgrade and a fresh
session for that route; portable installation does not modify the plugin cache.

## Distribution And Maintenance

The bundle contains 11 Markdown files: one dispatcher, one connection guide,
five procedures and four references. It includes no runtime, source tree,
plugin cache or credentials. Local links resolve within the bundle.
[Beta release notes](https://github.com/JJLiebig/symphony-plus-plus/releases/tag/sympp-v2-beta-20261007)
record the tested host/platform scope; procedure installation alone does not
prove a runtime connection.

Marketplace MCP procedures remain authoritative. After editing them, regenerate
the portable references and check the distribution:

```sh
node scripts/package-portable-skills.mjs
node scripts/package-portable-skills.mjs --check
```

The script only rewrites frontmatter, entrypoint filenames, and skill invocation
links. It does not maintain a second host-specific workflow. The owning package
test checks that the committed payload matches its source and that every local
Markdown link stays inside the bundle and resolves.
