# sympp Repository Conventions

## Work Package PRs

- Use one sympp work package per PR unless the overseeing architecture agent explicitly splits or combines scope.
- Keep each worker branch scoped to its assigned package and ignore sibling worktrees or branches.
- Use PR titles in the form `[SYMPP-...] <title>`.
- Fill `.github/pull_request_template.md` concretely, including acceptance evidence, tests run, and any blocked validation.
- If Review Suite is installed, run it only in `fast` mode.
- Do not implement dependent packages or adjacent cleanup unless the architecture agent explicitly expands scope.
- A WorkRequest is the product-facing unit. Optional Groups organize larger
  plans, while canonical WorkPackages carry bounded worker execution and audit
  evidence from planning through delivery.

## Documentation And Planning Assets

- Treat `docs/` as the current human-facing product and operator guide.
- Keep approved beta target contracts under `docs/design/`, clearly labeled
  and linked from the index. Do not present target behavior as implemented.
- Treat packaged `packages/sympp/skills/**/SKILL.md` files as the authoritative
  agent procedures. Link to them instead of copying their workflows into docs.
- Use the WorkPackage ledger, MCP resources, and package-specific assignment
  text as the source of truth for worker scope, acceptance, validation, and
  readiness evidence.
- Use Git history for completed designs, cutovers, and experiments. Do not keep
  active archive or migration-diary documents.

## Worker Prompt Conventions

- Read [testing guidance](docs/testing.md) before changing tests. Define independent
  acceptance outcomes first; retain unique process/storage/security boundaries
  until their owning journey proves them. Keep conversion inventories in PR evidence.

- Keep worker prompts short and outcome-first: state the package goal, success criteria, constraints, available evidence, and required final output.
- For tool-heavy work, use brief preambles before tool calls so the operator can see the next step and why it matters.
- Include explicit dependency checks, missing-evidence behavior, validation loops, stopping conditions, and safety checks before external side effects.
- Avoid process-heavy prompt stacks or verbose formatting unless the extra structure improves comprehension.

## Runtime Boundary

- Preserve upstream Symphony and Linear behavior unless the assigned package explicitly changes it.
- Do not replace `elixir/WORKFLOW.md` with the sympp draft workflow template.
- Do not wire unfinished sympp config into runtime defaults.
- Do not create live Linear state unless the assigned package and operator explicitly require it.
- For installed sympp MCP operation, runtime scripts must resolve from the
  installed `sympp` skill, not from a developer checkout or source-root hint.
  Update with `npx skills update sympp -g`, rerun setup and open a fresh session.
  Use `SYMPP_REPO_ROOT` only for explicit developer validation, never as the
  installed-agent runtime path. Never repair an installed bundle by mixing
  checkout files with another installed revision.

## Security

- Never commit, print, or place raw API keys, bearer tokens, GitHub tokens, Linear tokens, MCP auth tokens, or worker secrets in files, prompts, logs, PR bodies, or review text.
- Document missing secret-dependent validation as blocked rather than substituting real token values.
