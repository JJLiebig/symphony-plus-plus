# Operations

This page maps each job to its authoritative entrypoint. Agent procedures live
in packaged skills and are not repeated here.

## Install And Open

Use [Install and run](runtime.md) for Windows beta setup, both host connections
and upgrades. With the same beta environment, read the active dashboard URL:

```powershell
(Get-Content (Join-Path $env:SYMPP_HOME 'runtime/codex-plugin.json') -Raw | ConvertFrom-Json).frontend.url
```

The installed MCP companion starts or reuses the local backend and serves the
packaged dashboard from the same runtime.

## Work Board

The board lists goals, one per WorkRequest, with the ones that need you first:
a goal whose architect asks you something, then goals with a road bump or
stalled work, then goals on track. Parked, dormant, not-started and settled
goals sit on shelves that open on demand, and recently merged work is listed
under Landed.

Each goal shows a verdict, the architect's brief and ETA, and its packages as
Done, Now and Up next along Build, PR, Checks, Review and Merge. Outline,
Briefing and Phases (keys `1` to `3`) show the same goals in different shapes;
Show sets how much each goal opens. Choose an area to narrow the board.

The header says whether you are needed and names each open question; the tab
title and icon repeat it. A line under the header sums up what changed since
you last looked, and each figure on it takes you to the goals behind it.

A session icon on a package or a goal shows where that agent was last seen.
Click it to bring the session to the front in Herdr; a note says what happened
or why it could not be opened. See
[session locations](operator-board-api.md#session-locations).

A goal can be marked done, archived or deleted from its menu, and a shelf can
be archived in one go. None of these stops a running worker or merges a pull
request. The board rereads the ledger when it changes and once a minute; if a
read fails it keeps what it last showed and says the connection is lost.

The board does not create requests. Start one from a trusted local MCP session.

An optional architect report gives the goal a brief, free-text ETA, parking
reason, and explicit question requiring a human decision. The hydrated dashboard
returns it at `work_request_details[].work_request.operator_report`;
`read_work_request` returns the same report. Each brief/ETA has `text` and
`written_at`. Parking has `reason`, `parked_at`, and `resumed_at`; escalation has
`question`, `raised_at`, and `resolved_at`. A missing report/field is absent
information; a non-null resume/resolution time means that interval is closed.
Open clarification questions and worker waits do not imply escalation. Reports
do not change blockers or completion. See the
[architect procedure](../plugins/symphony-plus-plus-mcp/skills/symphony-architect/SKILL.md#guidance)
for optional milestone updates and resolving answers given in the conversation.

### Herdr Execution Inspector

Install the optional Herdr plugin from the repository root:

```powershell
herdr plugin install JJLiebig/symphony-plus-plus --ref beta --yes
```

When a Herdr tab contains a bound Symphony++ architect or coordinator, one
execution inspector opens to its right. It follows that tab's focused bound
agent and stays compact for a trivial WorkRequest. Larger or branching work
shows its execution frontier.

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

The inspector shows these facts for the selected package, with pane connected,
missing or disconnected reported separately from
runtime freshness. Unknown timing and observations remain explicit.

## Choose A Flow

| Need | Entry point |
|---|---|
| Persistent single-agent planning | `symphony-plus-plus-mcp:symphony-solo-session` |
| Implement one assigned package | `symphony-plus-plus-mcp:symphony-worker` and `symphony-plus-plus-mcp:symphony-work-package` |
| Clarify and slice a WorkRequest | `symphony-plus-plus-mcp:symphony-architect` |
| Coordinate ordinary repository work without required persistence | `symphony-plus-plus:symphony-coordinator` |
| Inspect human progress | Work board and Herdr execution inspector |

All agent-facing Symphony++ ledger reads and writes use configured MCP tools.
Workers and coordinators may operate without a backend when persistence is not
requested. Shell commands remain for installation, startup, diagnosis, upgrade,
and recovery; recover MCP before continuing required ledger work.

The packaged skill is the procedure. Assignment text should contain only the
specific goal, scope, evidence, constraints, review requirement, and desired
output.

## WorkRequest Flow

1. Create a WorkRequest in a trusted local MCP session.
2. Give an architect the returned WorkRequest claim.
3. Answer material clarification questions.
4. Let the architect create optional Groups, WorkPackages, and dependencies.
5. Dispatch dependency-ready WorkPackages to isolated workers.
6. Merge reviewed pull requests.
7. Reconcile or record terminal delivery evidence.

Use [delivery recovery](runbooks/delivery-recovery.md) when GitHub and the
ledger disagree after a merge or abandoned execution.

## Developer Visual QA

Create a disposable deterministic ledger with one of `simple`, `multi-repo`,
`superseded`, or `large`:

```powershell
cd elixir
mix sympp.demo_ledger --database .tmp/demo.sqlite3 --scenario large --force
mix sympp.cockpit --database .tmp/demo.sqlite3
```

Open the printed cockpit URL. The scenarios only seed synthetic local ledger
data; production dashboard code does not select or depend on them.

For work on the board itself, `npm run dev:snapshot` in `elixir/assets` serves
it from a captured ledger snapshot without a backend, with replay and sample
goals.

## Runtime Problems

Use [Runtime](runtime.md) for marketplace ownership, startup, cache identity,
and diagnostics. Do not repair an installed runtime from a developer checkout.
