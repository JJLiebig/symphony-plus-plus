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
wait on each answer, then one row per Herdr topic. A topic with a chief shows
the chief's desk first: what it dispatched and where each item is now, recaps,
and what waits on you; to make one, tell an agent it is that topic's chief. A
topic shows its work by repository and its agents; a space shows the work on
its repository. Click a
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

The installer adds `mods/sympp` and the agent helper `tools/sympp-herdr.js`.
Updating removes the former HTTP helper and its private request directory.
It leaves layouts, topics, compositions,
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
- An agent started for S++ shows a small S++ glyph tucked behind its icon in the
  Agents list, and after its name its package's stage: build, checks, review with
  its round (amber from the third), ready to merge or landed, and an orange dot
  when it needs you. A stage older than about two minutes shows dimmed as last
  known. Stages arrive from an open S++ view's board reads, the panel included,
  once it has been shown.
- A UI studio tab shows the S++ glyph in a small window tucked behind its icon.

The installer backs up the layout and both mods under `data/sympp-chrome`, adds
a `sympp` panel to the layout's `panel-body` stack, and patches the two mods in
place; running it again changes nothing. It refuses, listing what is missing,
when the layout has no `panel-body` stack, uses Herdr's own `tabs` or `agents`
mod, or either desk mod differs from what the patch expects or was edited after
installing. Other mods can add their panels the same way through
`shared("workspace.panel_buttons")` entries `{ id, label, icon, iconDark? }`: an
SVG icon is tinted like Files and Changes; a picture shows as it is, `iconDark`
on a dark theme. Tabs take marks the same way through `shared("workspace.tab_marks")`
entries `{ tab, icon, iconDark?, label }`: a tab's first mark sits behind the right
of its icon with `label` as its tooltip, so draw it 14 px with that icon's ring cut out.

Chrome installation and removal require `herdr-app` on `PATH` or `--app <executable>`.
The installer checks both desk mods and S++ after writing them. If a check fails,
it reports the mod and error and restores every changed file to its previous contents.

```powershell
node integrations/herdr-next/install.mjs --remove-chrome
```

restores both mods from their backups and removes the S++ panel from the layout,
keeping any other layout change made since. A desk with another version of the
chrome is refused; remove it with the installer that added it, then install again.
Both patches are now chrome 3 (the new S marks). Upgrade a desk with chrome 2
using its matching installer to remove it first, then install this checkout:

```powershell
git worktree add C:/Code/.worktrees/symphony-plus-plus/chrome-2-remove 77ef41d796a2a5e9688bfb97b736212a589b8849
node C:/Code/.worktrees/symphony-plus-plus/chrome-2-remove/integrations/herdr-next/install.mjs --remove-chrome
node integrations/herdr-next/install.mjs --endpoint $origin --chrome --replace
git worktree remove C:/Code/.worktrees/symphony-plus-plus/chrome-2-remove
git worktree prune
```

For chrome 1, use revision `76846ad8` for the removal worktree instead. Pass
the same `--home`, `--app` and `--session` selections to both installers when
using a nondefault desk. Removal and installation check the mods and retain
their existing rollback behavior.

Four blue-violet marks are available: **A · Cut ribbon**, **B · Open ribbon**,
**C · Fold**, and **D · Solid**. To switch all three surfaces together:

```powershell
node integrations/herdr-next/install.mjs --endpoint $origin --chrome --replace --mark a
```

Use `a`, `b`, `c` or `d`; A is the default. Repeat another choice on later installs.
Switching marks on chrome 3 needs no removal. The installer keeps its edit
protection, mod checks and rollback.

Each option has light/dark SVGs for the Agents badge and studio window, with
the provider icon's ring kept transparent, plus a panel SVG and transparent
64 px PNG export. B/C/D sources live in `marks/<letter>/`; A uses the default
assets in `mods/sympp/`.

## UI studio

A UI package gets a studio: a tab named after the package, in the job's local
space, with its worker's terminal on the left and a preview on the right, like a
chat beside its canvas. A package is UI work when its title names UI as a word
("UI studio tab", "Token UI") or its worker has published a preview. Open it with
**Open UI studio** under the selected package in a job view, or U. Opening it again
selects the open studio. An architect launching a UI worker can open the studio
with only the ids, once any S++ view has connected:

```powershell
herdr-app do tab.new '{"name":"<package title>","mod":"sympp","props":{"studio":{"job":"<work request id>","pkg":"<work package id>"}}}'
```

A studio opened outside the job's space moves there; a second one for the same
package hands over to the first. Neither closes a tab that holds a terminal.

The studio places the worker only after the execution helper has verified its
launch. A worker without a pane is brought into the studio; one shown in another
tab stays there until you choose **Move here** (or **Go to it**).

The preview shows, in order:

- **A web page** the worker published with `sympp.preview_url` on its terminal
  (see the [worker UI collaboration procedure](../../plugins/symphony-plus-plus-mcp/skills/symphony-worker/SKILL.md#ui-collaboration)),
  as its address with **Open** (O or Enter) for the browser. Herdr mods cannot
  embed a browser; a rendered picture of the page is a later addition.
- **The Herdr view itself** when the worker is local and its worktree changes
  `integrations/herdr-next/mods` against the job's base branch. The worktree's own
  `preview.mjs` builds that view on the sample board as `mods/sympp-dev-<package>`
  in the Herdr home and rebuilds on every save, so changes show within seconds. The
  copy makes no S++ reads or writes; your own `sympp` mod is never written. The
  copy goes when the package lands, or about a minute after its studio closes
  while any S++ view is open.
- Otherwise it says the agent hasn't published a preview yet.

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

Reads and actions use Herdr's `fetch` directly, without a Node process per
refresh or private request files. The installed Windows Herdr-app 0.1.4 was
qualified for loopback GET and JSON POST without browser or forwarding headers.
Responses retain their real HTTP status; the view never automatically retries
a write.

Native S++ routes do not redirect. Herdr fetch can follow same-origin redirects;
its [redirect policy](https://github.com/herdrdev/herdr-app/blob/b975f5beaa6909cd7806a40096859c5e47938a19/vendor/gpui-kit/crates/shell/src/engine/quickjs/standard/fetch.rs#L341-L355)
refuses cross-origin redirects for non-GET methods (line 341) and requests with
caller-supplied headers (line 351). Every S++ request sends `Accept`, and JSON
POSTs also send `Content-Type`. A redirect flag or changed response URL makes
the request fail before its JSON can be parsed or shown, retaining the returned
status for diagnosis.

Agent navigation and execution still need Node.js and the separate
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
