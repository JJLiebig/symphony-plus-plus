# Install And Run

Use [Skills installation](portable-skills.md) for Codex and Claude Code. Main is
the only runtime channel and publishes the stable artifacts used by Windows local
factories. Linux factories use the [service installer](linux-service.md).

Close the factory's clients before updating, run `sympp update`, and open fresh
sessions. A cold local factory selects the latest successfully published stable
artifact. Healthy clients share their existing runtime until they close. Checksums,
MCP contract compatibility and the actual source SHA remain verified. Publication
can lag main; check the running SHA before relying on a newly merged feature.

## Local Checkout Loop (Windows)

From any checkout, set `$env:SYMPP_HOME` to the existing factory's absolute home
(for example `C:\sympp-factory`), then run `just install`.
It uses the toolchain in `elixir/mise.toml`, builds current files including uncommitted
changes, regenerates Skills, and replaces the runtime on the same endpoint and ledger.
The previous runtime is retained for rollback. Herdr and agent sessions stay running;
open fresh agent sessions only when the command reports a Skills/contract change.
`HERDR_APP_HOME` selects a non-default Herdr home; existing chrome is retained.

The checkout build stays selected through idle shutdown and reboot. Its commit,
dirty flag, install time and Skills bundle hash appear in `artifact.checkout` and
the factory's `runtime/checkout-artifacts.json`. Last install wins: `npx skills update sympp -g`
returns to published builds. On the next cold start, a changed Skills bundle quietly
drops the checkout pin; an unchanged bundle keeps it. Use one Skills installation
per factory; sharing its directory between independent factories is unsupported.
Restart briefly loses client leases; the panel restarts an idle factory within about
25 seconds, and bridges cold-start it on their next request.

`just test` runs fast launcher/bridge and native-view behavior tests, checkout-pin
selection, dashboard type/lint checks and Vitest, plus Skills mirror validation.
It excludes backend ExUnit, native acceptance and release qualification; run those
when changing their surfaces. `just install` also compiles the backend release.

## Open The Board

The packaged backend serves the dashboard; no separate frontend is needed.
Read the actual URL after the first connection:

```powershell
$symppRuntime = Get-Content (Join-Path $env:SYMPP_HOME 'runtime/codex-plugin.json') -Raw | ConvertFrom-Json
$symppRuntime.frontend.url
$symppRuntime.backend.mcp_url
```

The launcher prefers loopback port `19998` and tries higher available ports
when needed. `SYMPP_BACKEND_PORT` requests a preferred port. Use the recorded
URL. See [Operations](operations.md) for the Work board and starting a request.

## Attach, Close And Recover

The first local client starts the runtime; clients with matching settings attach.
Closing one host leaves the other usable. The backend stops after the last client
detaches. The verified archive cache avoids downloading unchanged bytes.

For a connection failure, keep healthy sessions running. Check the recorded
endpoint and host error, then reconnect the affected host. Reclaim the same worker
assignment in the actual session before retrying an uncertain write. The
[WorkPackage procedure](../packages/sympp/skills/symphony-work-package/SKILL.md)
owns that recovery.

For inspection, [Copy and View](portable-skills.md#copy-convert-and-view-an-offline-ledger)
uses SQLite online backup, a durable offline marker and a separate home and port.
The viewer has no MCP or agent access. Stop it before refreshing; never promote
the copy to a live ledger.

Installed agents use the installed skill bundle. `SYMPP_REPO_ROOT` is only for
explicit developer validation. Do not overwrite runtime state or stop another
healthy host to repair one failed attachment.
