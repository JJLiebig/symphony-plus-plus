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

Herdr-app must already be open. If its executable is not on `PATH`, pass
`--app <executable>`. `--home <folder>` selects an isolated Herdr-app home;
otherwise the installer follows `HERDR_APP_HOME` or `~/.config/herdr-app`.
Without `--open`, it installs the files and prints the Herdr command to open
them later.

For a native panel beside the focused terminal:

```powershell
node integrations/herdr-next/install.mjs --endpoint $origin --open panel
```

The installer adds only `mods/sympp`. It leaves layouts, topics, compositions,
settings and terminals intact. Existing mod edits are protected; use `--replace`
explicitly to install this version over a differing copy. Close an S++ pane
with Herdr's ordinary pane or tab controls.

The native view requires a backend with the native board endpoint. Updating the
view does not update or restart S++. Follow the normal
[installed runtime procedure](../../docs/runtime.md); healthy clients retain
their current runtime until a supported cutover.

## Machines and access

The endpoint belongs to the S++ factory; it is independent of the machine
hosting a terminal. Native reads and actions use the backend's direct local
consumer policy. A remote core does not make its S++ server local to the app.
Use an explicitly managed authenticated tunnel for a remote factory; do not
expose its loopback API publicly or assume every machine shares a filesystem.

Terminal bindings identify the core and the launched process. Recovered shells
are not resumed agents. A last-known S++ session location is displayed as an
observation, without claiming that its agent is still alive.

## Qualification

```text
node --test integrations/herdr-next/*.test.mjs
herdr-app check integrations/herdr-next/mods/sympp
```

Use an isolated `HERDR_APP_HOME` and core session when checking native behavior.
Native rendering and real provider launches require their own evidence;
passing model or HTTP tests does not prove either.
