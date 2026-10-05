# Operations

This page maps each job to its authoritative entrypoint. Agent procedures live
in packaged skills and are not repeated here.

## Install And Open

Install or update the marketplace package as described in the root
[`README.md`](../README.md). The launcher prefers loopback port `19998`, then tries higher available ports.
On Windows, read the active dashboard URL with:

```powershell
(Get-Content "$env:USERPROFILE\.agents\splusplus\runtime\codex-plugin.json" -Raw | ConvertFrom-Json).frontend.url
```

The installed MCP companion starts or reuses the local backend and serves the
packaged dashboard from the same runtime.

### Herdr Execution Inspector

Install the optional Herdr plugin from the repository root:

```powershell
herdr plugin install JJLiebig/symphony-plus-plus --ref main --yes
```

When a Herdr tab contains a bound Symphony++ architect or coordinator, one
execution inspector opens to its right. It follows that tab's focused bound
agent and stays compact for a trivial WorkRequest. Larger or branching work
uses the same frontier projection as the dashboard.

- `Up`/`Down` or `k`/`j`: select a WorkPackage.
- `Enter`: focus the one live Codex pane whose session exactly owns it.
- `p`: pin or unpin the current WorkRequest.
- `q`: close the inspector. It stays closed until the binding changes.

The board and inspector detail API carry the accountable ledger owner separately
from the current observed claim or run. Activity includes the actual stage,
native review progress and next action, guidance/dependency waits, latest update,
and current, paused, stale, or unknown observation state. Review elapsed time is
available only when the provider supplies a start time; missing timing stays
unknown. Opening inspector details refreshes native review observations directly.
Missing panes or actors do not transfer ownership or prove completion.

Board cards show the current activity in their existing metadata slots. Open
request or package details for the owner, current actor, review step/round,
waiting reason, next action and latest update. Request activity names the
WorkPackage it describes. The inspector shows these facts for the selected
package, with pane connected, missing or disconnected reported separately from
runtime freshness. Unknown timing and observations remain explicit.

## Choose A Flow

| Need | Entry point |
|---|---|
| Persistent single-agent planning | `symphony-plus-plus-mcp:symphony-solo-session` |
| Implement one assigned package | `symphony-plus-plus-mcp:symphony-worker` and `symphony-plus-plus-mcp:symphony-work-package` |
| Clarify and slice a WorkRequest | `symphony-plus-plus-mcp:symphony-architect` |
| Coordinate ordinary repository work without required persistence | `symphony-plus-plus:symphony-coordinator` |
| Inspect human progress | Dashboard focus board and execution graph |

All agent-facing Symphony++ ledger reads and writes use configured MCP tools.
Workers and coordinators may operate without a backend when persistence is not
requested. Shell commands remain for installation, startup, diagnosis, upgrade,
and recovery; recover MCP before continuing required ledger work.

The packaged skill is the procedure. Assignment text should contain only the
specific goal, scope, evidence, constraints, review requirement, and desired
output.

## WorkRequest Flow

1. Create a WorkRequest in the dashboard or trusted local MCP session.
2. Give an architect the returned WorkRequest claim.
3. Answer material clarification questions.
4. Let the architect create optional Groups, WorkPackages, and dependencies.
5. Dispatch dependency-ready WorkPackages to isolated workers.
6. Merge reviewed pull requests.
7. Reconcile or record terminal delivery evidence.

Use [delivery recovery](runbooks/delivery-recovery.md) when GitHub and the
ledger disagree after a merge or abandoned execution.

## Demo Ledger Visual QA

Create a disposable deterministic ledger with one of `simple`, `multi-repo`,
`superseded`, or `large`:

```powershell
cd elixir
mix sympp.demo_ledger --database .tmp/demo.sqlite3 --scenario large --force
mix sympp.cockpit --database .tmp/demo.sqlite3
```

Then run the existing browser smoke against the printed cockpit URL:

```powershell
node assets/scripts/browser-smoke.mjs --url http://127.0.0.1:19998/sympp/board
```

The scenarios only seed synthetic local ledger data; production dashboard code
does not select or depend on them.

## Runtime Problems

Use [Runtime](runtime.md) for marketplace ownership, startup, cache identity,
and diagnostics. Do not repair an installed runtime from a developer checkout.
