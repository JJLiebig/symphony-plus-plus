# Optional Herdr-next execution

Use this only when the user chose Herdr-core execution. Ordinary Symphony++
orchestration, its web UI, and workers using another host remain unchanged.
Small fixes need no WorkRequest or worker claim.

The installed plugin or portable Skills bundle includes
`scripts/sympp-herdr.js`. Run it with Node on the machine where the worker will
execute. It uses the existing `hc connect` API and the selected provider's own
configuration and login. It prepares workspace trust only; it never copies credentials,
dispatches a package, claims a grant, or reconfigures a running agent.

## Start and hand off

The parent first uses its existing MCP authority to dispatch the package once.
Save only the redacted `worker_bootstrap`, or the redacted dispatch response,
as a JSON file on the worker machine. Keep that file unchanged until the agent
has read it. Do not save raw grants, secrets or private handoff material.

```text
node <bundle>/scripts/sympp-herdr.js launch --provider claude --model opus --assignment worker.json --ledger <verified-ledger-identity> --cwd <worktree>
node <bundle>/scripts/sympp-herdr.js launch --provider codex --assignment worker.json --ledger <verified-ledger-identity> --cwd <worktree>
node <bundle>/scripts/sympp-herdr.js launch --provider opencode --task fix.txt --cwd <repo>
```

`--task` is an ordinary UTF-8 task file and creates no ledger work. `--ledger`
names the already verified dispatch ledger; its hash separates bindings from
other ledgers. A launch receipt is an observation, never authorization. The
helper cannot verify ledger authority and does not contact the ledger.

Terminals use readable names such as `review-drill-down-claude`, derived from
the package title (`assignment.title`, `assignment.work_package.title` or
`work_package.title`), then a leading
`You own WorkPackage <id>: <title>` prompt line. Ordinary tasks use the first
line of their task file, falling back to `task-<provider>`. Use `--name <text>`
to override that text. Names become lowercase slugs, shortened at word boundaries
where possible to the core's 32-character limit, always preserving the provider
suffix. Path-bearing or recognizable credential text is discarded. Supply only
redacted titles and task files. A short disambiguator appears before the provider
only when the core rejects a live-name collision; finished names can be reused.
Display names confer no identity: labels and receipts keep the launch identity.
Changing only `--name` reuses the same receipt and leaves its existing name intact.

All providers receive a short prompt pointing at the input file. This keeps
large assignments out of OS command-line limits and process listings. The helper
adds no permission-bypass flags; provider configuration determines prompts.
Codex uses `--no-daemon` so its work
stays in the core terminal. Claude accepts `--model opus`; OpenCode models use
`provider/model`. Omit `--model` to use the provider's configuration.

Use `--provider-home <directory>` to select an existing provider profile:
`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, or `OPENCODE_CONFIG_DIR`. The helper passes
only named non-secret environment selectors, never the parent's credentials or
complete environment. Provider authentication stays on the execution machine.
Profile configuration and MCP availability are separate from process launch;
ordinary workers need no MCP claim. An existing Codex/Claude MCP installation
can still use the optional worker adapter when explicitly requested.

## Workspace trust

A launch authorizes the selected provider to trust the exact `--cwd`, including
an ordinary folder or a new Git worktree. No trusted-main-checkout prerequisite
applies. Other folders, credentials, models and tool permissions are untouched.

Claude records `projects[path].hasTrustDialogAccepted: true` in
`CLAUDE_CONFIG_DIR/.claude.json`, or `~/.claude.json` when no profile is selected.
On Windows it uses forward slashes and preserves the launched path's drive
letter spelling, matching Claude Code. An already trusted entry is left alone;
other fields in the same entry are preserved. The helper acquires Claude's
`<config-file>.lock` directory, re-reads the config, merges only this trust flag,
atomically replaces the file and verifies the flag, with one fresh merge/retry
if verification fails. It waits for an existing lock and never steals it.

Claude Code 2.1.310 has exit writers that ignore that lock. This is an accepted
residual race: an exiting Claude session can overwrite the new trust entry and
bring back the dialog; the helper can also overwrite unrelated changes saved
by an unlocked exit writer between its read and replacement. Verification and
the single retry reduce interference but cannot prevent either lost update.
Replace this workaround when Claude provides a safe native trust writer or all
of its config writers honor the same lock. Retire it when fresh launch folders
no longer require a persisted trust record, verified with the installed CLI.

Codex uses the selected CLI's native `config/read` and `config/value/write`
app-server API to set `projects[path].trust_level = "trusted"` in its user
`config.toml`. This preserves TOML comments and other settings, uses the native
version check and atomic editor, then re-reads to verify. Its project key uses
the canonical path and Codex's Windows casing. A version conflict or refused
edit stops before the worker starts. See the [native config API](https://developers.openai.com/codex/app-server).
OpenCode has no equivalent workspace trust prompt; the helper leaves its
settings and [tool permission prompts](https://opencode.ai/docs/permissions/) unchanged.

The receipt's `workspace_trust` reports `trusted`, `changed`, and `reason`:
`launch_authorized`, `already_trusted`, or `no_workspace_trust_prompt`.
Preparation failure stops before worker launch; `workspace_trust_*` errors
identify lock contention, refused edits or verification failures.

`--parent <terminal>` gives the worker its return address. Inside the same
core, the current terminal is the default parent. A selected `--session`
requires an explicit parent if one is wanted. For a cross-provider handoff,
the parent saves the first worker's evidence and decisions in a bounded task
or assignment, then launches the next provider with that input. Read the new
worker's actual result and reconcile it through the parent's MCP session.
Provider conversation history and credentials are not transferred. A fresh
launch does not depend on the first provider accepting another turn.

Use `--space <id> --tab <id>` to place the terminal in an existing native Herdr
composition. IDs are local to that core, without the app's machine prefix.
Without placement it remains a core terminal, accessible through its parent or
`hc attach`. The helper never changes personal topics, layouts or compositions.

## Observe and continue

```text
node <bundle>/scripts/sympp-herdr.js
node <bundle>/scripts/sympp-herdr.js check --receipt <receipt.json>
node <bundle>/scripts/sympp-herdr.js send --receipt <receipt.json> --message followup.txt
```

No arguments lists last-known receipts for the current directory. `check`
reads current core identity, terminal, PID and launch label. `send` repeats that
check and uses the core's status condition at input time. Herdr-core 0.1.10
supports only exact `idle` or `working` conditions; `send` refuses all other
states, including `done`, blocked or unknown-status programs and recovered
shells. Preserve observed states without translating `done` to `idle`. Focus
the terminal for manual continuation, or launch a fresh bounded handoff. For
permission or authentication dialogs, let the person decide. A missing OSC
status is `unknown`; process launch never proves that an agent accepted or
completed work.

Receipts live under `$SYMPP_HOME/herdr-launches` (default
`~/.agents/splusplus/herdr-launches`). Repeating an identical launch reuses its
receipt. A changed request is refused. A lost spawn reply remains uncertain and
is never retried automatically. Inspect the core first; use a distinct
`--attempt <name>` only when another process is intended. A stale `.lock` file
means a launch owner crashed; inspect that receipt and core before removing
that one lock. There is no automatic takeover or model relaunch after recovery.

## Native client contract

Use `--json` for native clients; agent-facing output defaults to compact TOON.
`launch` and `check` return a v1 receipt with `launch_id`, `core_id`,
`terminal_id`, `pid`, `provider`, `model`, `role`, `work_request_id`,
`work_package_id`, hashed `ledger_id`, `cwd`, `created_at`, absolute `receipt`
path, `state`, `status`, `reason`, and `workspace_trust`. Successful launch also reports `reused`.
`check` reports `state: stale` when identity has changed. A UI may focus only a
fresh `state: live` receipt, using its own machine-qualified terminal address.

The terminal labels are `sympp.launch_id`, `sympp.provider`, `sympp.pid`,
`sympp.core_id`, the target-local `sympp.receipt` path and,
for tracked work, `sympp.role`, `sympp.work_request_id`,
`sympp.work_package_id`, `sympp.ledger_id`. Compare the live PID with
`sympp.pid`; labels survive recovery to a shell. Labels never confer authority.

A mod discovers receipts from terminal labels. Resolve its helper executable
from trusted per-machine installation/configuration, never from terminal labels.
It can call `exec("node", [helper, ...args, "--json"], {on: machine})` and
read the returned receipt with `readTextFile(path, {on: machine})`. The helper,
input file, cwd, provider profile and provider executable must all exist on that
machine. Run there instead of interpreting a Windows path on Linux or forwarding
local credentials. The core session is selected by existing `HC_SESSION` /
`HC_SOCKET`, or `--session`. Each machine can observe one shared ledger through
its configured MCP transport; this helper adds no remote ledger authentication.

## Qualification

The owning Node subprocess suite proves adapter argument/environment behavior,
bounded assignment binding, replay/conflict handling, unknown spawn outcomes,
workspace trust edits, concurrent interference, stale-shell refusal and status-conditional sends with a controlled JSON-RPC
peer. It starts no models and is not live Herdr or provider qualification.

Before claiming a provider/platform combination qualified, run it against a
scratch core and real provider CLI: initial file delivery, chosen model/profile,
visible terminal, status/permission observation, parent handoff, reconnect and
stale-shell refusal. Qualify Codex, Claude and OpenCode independently. Also
qualify target-host routing across each supported OS boundary. Preserve live
sessions and installed runtimes; use separate homes and core sessions.

Provider arguments follow the [Claude CLI reference](https://code.claude.com/docs/en/cli-reference)
and [OpenCode CLI reference](https://opencode.ai/docs/cli/); installed versions
still need live qualification.
