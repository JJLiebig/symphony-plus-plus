# S++ × Herdr-next

Status: optional native desktop integration. The backend and execution tooling
landed on S++ beta in #757–759; the native package is tracked in
[#760](https://github.com/JJLiebig/symphony-plus-plus/pull/760).
Qualification and current limits are recorded below.

## Product contract

S++ remains a standalone orchestration product with its normal graphical UI,
backend and supported execution workflows. Installing or using Herdr is not a
prerequisite for S++.

Herdr-next is the name used here for **herdr-core + herdr-app**. It is not a
third application or a new fork. Inside that environment, S++ gains a native
view and an execution host for cross-provider work such as Codex → Opus and
Opus → Codex. OpenCode and other CLIs belong behind the same host boundary;
support is qualified per provider rather than inferred from its name.

Herdr-next also remains useful without S++. A small fix can stay an ordinary
terminal conversation. S++ tracking and visualization are optional additions;
larger work can use the existing WorkRequest and WorkPackage workflow.

The native and web interfaces share S++ state. They do not create separate
backlogs, ownership records or delivery truth.

## Responsibilities

| Owner | Responsibility |
|---|---|
| S++ | Goals, packages, dependencies, assignments, decisions, delivery and evidence. |
| herdr-core | Agent processes, terminals, streams, persistence and machine connections. |
| herdr-app | Native views, navigation, focus and human controls. |
| Execution provider | Model/account access and its own conversation protocol. |
| GitHub/review providers | Their actual check, review, merge and delivery observations. |

Closing a Herdr-app window must not stop chiefs, workers or orchestration.
Multiple clients may view the same work and terminals. Client focus is not
ownership, and terminal activity is not proof of delivery.

```mermaid
flowchart LR
    Web[S++ web UI] --> SPP[S++ backend and ledger]
    Native[Herdr-app native S++ view] --> SPP
    SPP --> Standalone[Existing standalone execution path]
    SPP --> Host[Herdr-next host adapter]
    Host --> Core[herdr-core on the selected machine]
    Native --> Core
    Core --> Chief[Chief / architect / worker terminals]
    Chief --> Provider[Codex / Claude / OpenCode]
```

## Human view

The primary question is **what needs me, and what happens next?** Following a
job and reaching its active agent should take very little navigation.

One `sympp` mod draws four levels: **Factory > Topic > Space > Job**.

- **Factory:** everything the connected S++ ledger holds, needs-you first.
- **Topic:** a company or domain and its optional chief. It summarizes relevant
  work and human decisions across repositories. Reuse personal topic grouping.
- **Space:** the work relevant to a repository on a machine. A cross-repository
  request can appear here as a reference to its one canonical goal.
- **Job:** one WorkRequest as a whole view. It opens beside the overview, or in
  its own tab (`props.job`) in the job's local space when a space folder matches
  one of its repositories, else in the shown space. Do not require a tab for
  every package or equate a package with an agent; architects, workers,
  reviewers and retries have different identities.

The Job level shows, from canonical state only:

- **Phase:** Shaping, Planning, Executing, Closing or Done, from the request
  status, dispatch and required-package delivery. No percentages.
- **Needs you:** only what the person can move: escalations and guidance,
  answerable in place.
- **Package rails:** one row per package on a shared real-time axis with a now
  line. Rows that need the person come first, then packages others wait on.
  Segments start only at recorded moments (creation, dispatch, review start,
  current stage entry, delivery) and are coloured by who is acting: the agent,
  CI or the person. Waiting is dimmed; a dependency wait is dotted and names its
  prerequisite. Stretches where nobody acted fold into a labelled break, and
  work that landed before the open work began is summarized rather than drawn.
  Review rounds are R1, R2, R3 chips, amber from round three. Work without a PR
  is work, then done. Each row gives wall time, time in its stage and time in
  its review. Narrow and panel widths stack a compact line per package.
- **Review drill-down:** a round chip, a road bump's Review button or Enter on
  a reviewed row opens the package's review beside the rails (under its row
  when narrow); Esc closes it and the rails keep their place. It shows the
  provider's stage in plain words, its step ladder, the time in this round and
  overall, and each reported round newest first with lane, step, outcome,
  start, finish and duration. Rounds older than the reported history are
  counted; finding counts appear only when recorded. Stale or missing reports
  say so. Without a ladder or history it shows step x/y and the round count.
  Round three or more than three hours in review is a road bump in the rails,
  the drill-down and the attention strip; a long review suggests reslicing,
  without acting on it.
- **Agents:** the architect, a worker per package with its active run attempt,
  and the review provider by type and mode. An agent is Live only after the
  trusted helper has just verified its exact launch and process; otherwise it
  shows its last S++ sighting or Unknown. A bound agent's own status report is
  shown as such, never inferred from terminal text.
- **Decisions and questions:** the job's recorded decisions, read only while a
  job view shows, and its clarification questions, answerable in place.

The levels above a job:

- **Factory:** needs-you ranked by the unfinished packages that wait on each
  answer in the effective execution graph (a job-level ask holds all of its
  unfinished packages), then by age. Then one row per Herdr topic
  (`desk.topics`) with its needs, moving packages and repositories, plus
  unsorted spaces and work without a space when either has any. Each job has
  one home topic, its own repository's first, so it is counted once; other
  topics it touches name it as shared.
- **Topic:** work grouped by repository across the topic's spaces, with each
  space reachable; jobs homed elsewhere appear as references, planned-only
  jobs fold into a count, and settled work stays in the dashboard. Its agents
  are the jobs' architects and workers with something known about them and any
  bound agent in its spaces, with Live, Last seen or Unknown and the agent's own
  OSC report.
- **Chief desk:** a topic with a registered chief shows it first: the chief
  named like the topic (ignoring case), else one whose name leads or ends the
  topic's (Kraken and Nextide-Kraken), else one whose declared repositories
  place there as jobs do; several matches are all shown, none picked. The chief
  is Live only after the helper check of the session it registered from,
  otherwise Last seen or Unknown, with its own report and Open. Its desk lists
  the requests and packages attributed to it, newest first with their current
  phase or stage, the architects' recaps on that work, and what waits on the
  person there. A topic without a chief says to tell an agent it is that
  topic's chief. Factory topic rows show chief presence.
- **Space:** the jobs touching its repository (the folder's leaf) on its
  machine, each naming its other repositories, and the agents there. A space
  without S++ work says that ordinary Herdr work stays ordinary.

A breadcrumb (Factory > Topic > Space > Job) and Esc move up a level; rows
take ↑/↓ and Enter. Each copy keeps its place in its own `localStorage`.
A panel copy follows Herdr's focus without taking it: an S++-labelled terminal
or a job tab shows that job, else the space while S++ work touches it, else the
space's topic; focusing a mod pane keeps what it shows, and a pin stops it.
Job tabs record their Herdr tab in `shared("sympp.jobTabs")` while drawn, since
Herdr does not expose a mod pane's props. A toast posts only for a need that
appeared between two successful reads of one copy, never on the first read or
for an offline copy; copies share `shared("sympp.toasted")` so each need is
announced once. Clicking it selects the job's tab or opens one.

A job can have multiple participating terminals; its identity remains the
WorkRequest rather than a particular client tab.
Preserve existing topics, compositions, terminal placement and normal Herdr
navigation. Xeneon hardware is a later surface, outside this delivery.

Keep needs-human work prominent, active work understandable and quiet work
quiet. Use stable positions, concise state labels and meaningful transitions.
Show stale or unavailable observations explicitly. Do not fabricate agent
thoughts, progress percentages, live status or cross-provider shared memory.

## Native surface

Herdr mods describe GPUI elements in JavaScript. They are native UI, without
HTML, CSS, DOM, Node or an embedded browser. The current S++ web implementation
under `elixir/assets/src/fresh/` remains the behavioral reference and continues
to ship as the standalone interface.

The native view should reuse S++ projections and semantics rather than porting
React components or replacing the web interface. Use Herdr theme tokens,
ordinary native controls, keyboard focus and existing terminal blocks.

The existing S++ `herdr-plugin.toml`, session focus commands and inspector
include legacy Herdr assumptions. They are not the Herdr-next adapter.

## Data and identity boundary

The read-only native hydrated-board endpoint is
`GET /api/v1/sympp/herdr/dashboard`, reusing the existing projection and native
consumer authorization. It does not migrate a ledger, register a dashboard
opener, change claims or weaken operator mutation authorization.

Do not spoof browser headers to call browser-authorized operator routes.
Native intake and question/guidance answers have a separate deliberate local
authority boundary: direct loopback and a local Host, no forwarding or browser
metadata, JSON only, and no native CORS/preflight grant. This authorizes a trusted
local process; it does not authenticate an application brand. Existing browser
authorization remains separate. The answer controls follow persisted prompt
options and canonical S++ validation.

The desktop transport uses Herdr's `fetch` for board/job reads and JSON actions.
Installed Windows Herdr-app 0.1.4 permits direct loopback GET and POST without
browser or forwarding metadata. This removes the HTTP helper, private request
files and one Node process per refresh; agent navigation/execution retains its
separate Node helper. Refresh stays modest (15 seconds for active work; 60 seconds
when quiet or in the background). The ordinary web UI remains available.

The native routes return JSON directly and never redirect. Herdr fetch may follow
same-origin redirects, but its
[redirect policy](https://github.com/herdrdev/herdr-app/blob/b975f5beaa6909cd7806a40096859c5e47938a19/vendor/gpui-kit/crates/shell/src/engine/quickjs/standard/fetch.rs#L341-L355)
refuses cross-origin redirects for non-GET methods (line 341) and requests with
caller-supplied headers (line 351). Every S++ request supplies `Accept`, and POST
also supplies JSON `Content-Type`. A response marked redirected or with a URL
different from the request fails before its payload is parsed or displayed.
Actual returned HTTP status is preserved, including on that failure; the view
does not retry uncertain writes. Browser mutation authorization is unchanged.

Reuse S++'s durable session-location observations where their identity is
applicable. Herdr-next bindings must retain the core/machine identity and full
terminal address, request/package/attempt identity and role. A last-known
location is not proof that an agent is alive. Do not infer generic provider
identity from legacy Codex-only bindings or from terminal text.

The shared projection exposes `runtime.offline`. Agent navigation requires an
explicit `false`, checks that capability again at activation, then verifies the
core, terminal, PID, launch and canonical request/package identity through the
trusted installed helper. A
Copy-and-View ledger can contain the same job IDs as the online source; copied
identities cannot authorize focus.

S++ loopback access is not a remote-access strategy. A remote backend requires
an explicitly supported authenticated connection, such as a managed tunnel;
never assume the app and all cores share one localhost or filesystem.

## Execution tooling

The optional Herdr-next execution host should launch a provider with the
existing scoped S++ assignment/bootstrap in its prepared workspace, then retain
the resulting native terminal binding. Ordinary Herdr terminals remain valid
without a ledger assignment.

Cross-provider handoffs carry the bounded task, durable decisions and evidence.
They do not promise to transplant one provider's private transcript into another.
Process host, role, model and conversation identity remain separate choices.

Reuse the existing direct-work and factory workflows. Native execution must
preserve assignment ownership, retry, cancellation and cleanup semantics. A
chief is an optional scoped agent, not a mandatory supervisor for every fix.
Automatic chief recovery is a separate capability: current Herdr reboot
recovery restores shells rather than restarting the original agent.

## Delivery slices and evidence

| Slice | Acceptance | State |
|---|---|---|
| Native read boundary | Same canonical board projection, local native policy, no reads causing writes; standalone routes unchanged. | Landed in [#757](https://github.com/JJLiebig/symphony-plus-plus/pull/757); 78 API acceptance cases and all required hosted gates passed. |
| Native working view | Real S++ state, topic/repo/job scope, attention and agent navigation using existing mod APIs. | Native rendering, intake typing and keyboard traversal passed in an isolated Windows home. A real intake and structured answer persisted in the canonical ledger. Agent placement passed through the public app API with an unchanged process; a physical click after that fix, compact layout and light theme remain unqualified. |
| Job level | Job tab, phase, needs-you strip, package rails, agents, decisions and keyboard, from canonical state; one mod split into flat modules. | Open in [#766](https://github.com/JJLiebig/symphony-plus-plus/pull/766). Node tests cover phase, rails placement/order/axis, liveness, decisions cadence and tab placement; `herdr-app check --print-spec` checks the drawn structure at wide and narrow widths with fixtures. Wide and narrow, dark and light captures in an isolated Windows home and scratch core used a fixture backend. Not yet qualified: real ledger data, a Live agent with a real launch receipt, pointer and keyboard input, and layout switches, which follow window width at the next redraw. |
| Levels, panel and toasts | Factory, Topic and Space levels with a breadcrumb, a focus-following panel with a pin, and needs-you toasts, from canonical state and Herdr's own topics, spaces, focus and terminal reports. | Node tests cover placement, ranking, grouping, agents, following, toasts and navigation; `herdr-app check --print-spec` checks each level at wide and panel widths. An isolated Windows home and scratch core with a fixture backend showed the Factory (dark and light), a toast for a newly raised need, and a panel following a space, an S++-labelled terminal and a topic; a job tab registered itself and `tab.select` reached it across spaces. Not qualified: real ledger data, pointer and keyboard input, and wide Topic and Space layouts in a live window (checked structurally only). |
| Chief desk | A topic's registered chief, its dispatched work, recaps and waiting decisions, and chief presence on Factory rows, from #773's chiefs and attribution. | Node tests cover topic matching (exact, leading or ending words, repositories, ambiguity), attribution, ordering, recaps, needs and chief liveness; `herdr-app check --print-spec` checks the desk, the no-chief line and Factory marks. An isolated Windows home and scratch core showed the desk, a no-chief topic, the Factory rows and the panel width with fixture data, dark and light. Not qualified: real registrations, a Live chief with a real session receipt, Open, and input. |
| Native human actions | Intake and persisted question/guidance answers, with browser exclusion and canonical scope/status checks. | Landed in [#758](https://github.com/JJLiebig/symphony-plus-plus/pull/758); API/offline acceptance and all required hosted gates passed. |
| Native bindings/tooling | Explicit core/terminal/process bindings; optional direct work remains simple; correct focus and stale-state handling. | Landed in [#759](https://github.com/JJLiebig/symphony-plus-plus/pull/759); six controlled-core checks and all required hosted gates passed. Native receipt checks also reject mismatched canonical request/package IDs. |
| Hand-started sessions | Architects, coordinators and workers started in a native terminal report their location; Open verifies the actual MCP bridge as well as the terminal. | [#761](https://github.com/JJLiebig/symphony-plus-plus/pull/761) adds Node bridge discovery and private session receipts without changing worker launch receipts or core/app APIs. Existing bridge processes need a supported reconnect to load it; the PowerShell fallback remains legacy-only. |
| Cross-provider execution | Scoped launches and handoffs through herdr-core, provider qualification and recovery evidence. | Six controlled-core checks; real Windows Codex, Claude Opus and OpenCode launches and both fresh Codex/Opus handoffs passed in an isolated core. In-place sends to done/unknown agents remain unsupported by core 0.1.10. |
| Delivery qualification | Native view checked in an isolated home, owning source/hosted checks, review, packaged installation and real boundary evidence. | Twelve focused native tests, installed `herdr-app check` and FAST review passed. Installation into isolated and personal Herdr homes preserved layouts, topics and terminals. Exact-head hosted results are recorded in #760. Existing installed factories remain untouched; a new factory needs a fresh host session before use. |

This table records actual evidence as work lands. A design, source commit,
simulated fixture or healthy web interface alone does not qualify the native
integration or an installed execution provider.

The integration uses existing Herdr core/app model, commands and network grants.
Preserve live sessions, installed runtime identity and existing
standalone behavior throughout delivery.

The [native package guide](../../integrations/herdr-next/README.md) owns install
and opening commands. Installation preserves personal layouts and uses normal
Herdr mod tabs or split panes. The helper is installed as a script; this does
not turn a source checkout into the running S++ MCP backend. Existing factory
cutovers continue to follow the stopped-ledger procedure.

See [factory workflow](factory-workflow.md), [operator API](../operator-board-api.md),
[runtime](../runtime.md) and [testing](../testing.md) for their owning contracts.
