---
name: sympp
description: Coordinate sympp WorkRequests, execute assigned WorkPackages, or use optional Solo planning memory through MCP; also supports ordinary worker and parent coordination without persistence.
---

# sympp

Read the procedure matching the assignment, then follow its contract:

- WorkRequest or product planning/delivery owner: [architect](references/symphony-architect/procedure.md).
- Assigned WorkPackage: [worker](references/symphony-worker/procedure.md) and [WorkPackage](references/symphony-work-package/procedure.md).
- Parent coordinating ordinary repository work: [coordinator](references/symphony-coordinator/procedure.md).
- Bounded implementation without a WorkPackage: [worker](references/symphony-worker/procedure.md).
- Optional durable planning for ordinary work: [Solo Session](references/symphony-solo-session/procedure.md).

The parent owns slicing and integration; each worker owns its bounded task,
checks, required review, and merge-ready handoff. Persistence is optional for
ordinary work. WorkRequest/WorkPackage and requested ledger operations require
configured `sympp` MCP tools. If those tools are unavailable,
report the missing connection and recover it before ledger work. Do not use
business CLI commands, direct SQLite, or private state files as a fallback.
Operational shell tools remain available for installation, startup, diagnosis,
upgrade, and connection recovery.

If sympp tools are missing, first ask: "This machine or a server (SSH host)?"
Then run `node <installed-skill>/scripts/setup-sympp.js` for this machine, or
append `--server <ssh-host>`. Setup installs the `sympp` command. Open a fresh
agent session after setup. See [MCP connection](connection.md) for recovery.

Invoke this skill as `$sympp` in Codex or `/sympp` in
Claude Code. Procedure names in linked instructions refer to local files,
not additional skills to install. The wiring reference covers the shared Windows bridge for both hosts. Use your
host's delegation tools when available; otherwise report a required worker
dispatch as unavailable instead of taking over an architect's implementation.
