# S++ in Herdr-next

The optional native view runs inside **herdr-app**. S++ keeps its standalone
backend, ledger, web UI and orchestration workflows. Agent terminals run in
**herdr-core**, independently of the desktop window.

Implementation and delivery status live in the
[S++ × Herdr-next contract](../../docs/design/herdr-next-integration.md).

## Install the view

Use the URL recorded by your running S++ factory, rather than assuming a port:

```powershell
$runtime = Get-Content (Join-Path $env:SYMPP_HOME 'runtime/codex-plugin.json') -Raw | ConvertFrom-Json
$origin = ([Uri]$runtime.frontend.url).GetLeftPart([System.UriPartial]::Authority)
node integrations/herdr-next/install.mjs --endpoint $origin --open overview
```

The view opens at the Factory: what needs you, ranked by how many packages
wait on each answer, then one row per Herdr topic. A topic shows its work by
repository and its agents; a space shows the work on its repository. Click a
row or the breadcrumb, or use ↑/↓ (j/k), Enter and Esc. Each copy remembers
where it was. A toast appears when something newly needs you; click it to open
the job's tab.

Herdr-app must already be open. If its executable is not on `PATH`, pass
`--app <executable>`. `--home <folder>` selects an isolated Herdr-app home;
otherwise the installer follows `HERDR_APP_HOME` or `~/.config/herdr-app`.
For a nondefault local core, pass `--session <name>`; the installer otherwise
retains its `HC_SESSION` when set.
Without `--open`, it installs the files and prints the Herdr command to open
them later.

For a native panel beside the focused terminal:

```powershell
node integrations/herdr-next/install.mjs --endpoint $origin --open panel
```

The panel follows what you focus in its tab: an S++ agent's terminal or a job
tab shows that job; otherwise the space, or its topic when no S++ work touches
the space. It never takes focus. Pin (P) keeps it where it is.

The installer adds `mods/sympp`, two scripts under `tools/`, and a private
request directory under `data/`. It leaves layouts, topics, compositions,
settings and terminals intact. Existing edits are protected; use `--replace`
explicitly to install this version over a differing copy. Close an S++ pane
with Herdr's ordinary pane or tab controls.

## S++ in your desk tabs and agents

On a personal desk layout (its own `desk-tabs` bar and `desk-agents` list),
`--chrome` adds S++ to them:

```powershell
node integrations/herdr-next/install.mjs --endpoint $origin --chrome
```

- **S++** sits beside Files and Changes and toggles the S++ panel the same way.
- An agent started for S++ shows the S++ mark in the Agents list, with its
  package's stage: build, checks, review with its round (amber from the third),
  ready to merge or landed, and a red dot when it needs you. A stage older than
  about two minutes shows dimmed as last known. Stages arrive from an open S++
  view's board reads, the panel included, once it has been shown.

The installer backs up the layout and both mods under `data/sympp-chrome`, adds
a `sympp` panel to the layout's `panel-body` stack, and patches the two mods in
place; running it again changes nothing. It refuses, listing what is missing,
when the layout has no `panel-body` stack, uses Herdr's own `tabs` or `agents`
mod, or either desk mod differs from what the patch expects or was edited after
installing. Other mods can add their panels the same way through
`shared("workspace.panel_buttons")` entries `{ id, label, icon }`.

```powershell
node integrations/herdr-next/install.mjs --remove-chrome
```

restores both mods from their backups and removes the S++ panel from the layout,
keeping any other layout change made since.

The native view requires a backend with the native board endpoint. Updating the
view with this installer does not update or restart S++. For an existing Windows
beta factory, update both with one command from an S++ checkout:

```powershell
pwsh -File scripts/install-sympp-beta.ps1 -SymppHome C:/Users/jonat/sympp-herdr-next/.sympp-beta -HerdrAppHome C:/Users/jonat/.config/herdr-app
```

It installs the latest published beta backend, this checkout's project-local beta
Skills bundle and native files,
replacing the S++ mod while retaining personal layouts, topics and terminals.
It opens no new tabs. Herdr-app watches mod files and reloads changed views;
reopen the S++ tab or pane if a view stays stale. An unchanged backend stays running.
Coordinate restart timing with agents using the beta factory, and open fresh MCP
sessions when its Skills bundle changes. A failed cutover restores the prior
bundle and runtime together. The
[beta reload procedure](../../docs/runtime.md#reload-an-existing-windows-beta-factory)
describes isolation checks, contract changes, reconnects and failure recovery.

For normal installations, follow the
[installed runtime procedure](../../docs/runtime.md); healthy clients retain
their current runtime until a supported cutover.

## Factory-floor lab

A separate prototype shows one job as a factory floor on a built-in sample job.
Packages stand in rooms (Your desk, Yard, Build bay, Checks, Review room,
Merge dock, Shipped), walk the corridor between them and circle the review
track once per round. It needs no S++ backend and never replaces the view:

```powershell
node integrations/herdr-next/install.mjs --lab --open overview
```

`--home`, `--app`, `--open panel` and `--replace` work as above. Without
`--open`, open it later in Herdr with
`herdr-app do tab.new '{"name":"S++ Lab","mod":"sympp-lab"}'`.

The replay bar steps through the job; Motion turns animation off, since Herdr
animations do not follow the system's reduced-motion setting. Keys: ←/→ step,
Home/End jump to the start or now, Space replays, ↑/↓ select a package and M
toggles motion. The same actions are Herdr commands (`sympp-lab.next`,
`.prev`, `.first`, `.last`, `.play`, `.motion`, `.up`, `.down`) for
`keys.json` or `herdr-app do`.

## Machines and access

The endpoint belongs to the S++ factory; it is independent of the machine
hosting a terminal. Native reads and actions use the backend's direct local
consumer policy. A remote core does not make its S++ server local to the app.
Use an explicitly managed authenticated tunnel for a remote factory; do not
expose its loopback API publicly or assume every machine shares a filesystem.

Terminal bindings identify the core and the launched process. Recovered shells
are not resumed agents. A last-known S++ session location is displayed as an
observation, without claiming that its agent is still alive.

Native agent jumps require an online factory and a fresh process identity check.
An offline copy can retain identical job IDs; it cannot authorize agent access.

The desktop view needs local Node.js. Herdr currently exposes `fetch` but gives
mods no network grants ([upstream proposal](https://github.com/herdrdev/herdr-app/issues/14)).
This package therefore uses an explicit installed HTTP adapter through existing
`exec`, with one process per refresh. Requests use private files rather than
command arguments, are removed after completion, and are never automatically
replayed. A crash can leave a request file in that private directory. Responses
keep their real HTTP status; redirects are not followed.

Agent execution uses the separate
[optional Herdr-next execution procedure](../../plugins/symphony-plus-plus-mcp/skills/symphony-worker/references/herdr-execution.md).
Fresh cross-provider handoffs carry a bounded task and evidence. Continuing an
existing agent depends on its reported status and the core's supported send
conditions; it is not a shared provider transcript.

## Qualification

```text
node --test integrations/herdr-next/*.test.mjs
herdr-app check integrations/herdr-next/mods/sympp
herdr-app check integrations/herdr-next/mods/sympp-lab
```

Use an isolated `HERDR_APP_HOME` and core session when checking native behavior.
Native rendering and real provider launches require their own evidence;
passing model or HTTP tests does not prove either.
