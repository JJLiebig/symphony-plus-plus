# Operator board labels

Area paths and machine labels belong to the operator, outside the repository.
Create `operator-board.json` in `SYMPP_HOME`, or in `~/.agents/splusplus` when
`SYMPP_HOME` is unset. `SYMPP_OPERATOR_CONFIG` can select a different file.
Set these variables in the environment of the dashboard backend process.

```json
{
  "repos": {
    "example-org/widget-service": {
      "area": ["Example Company", "Widgets"]
    }
  },
  "machines": {
    "build-desk": {
      "label": "Build Desk",
      "kind": "desktop"
    }
  }
}
```

Use the canonical lowercase GitHub `owner/repository` as the repository key.
The dashboard resolves known remote and local checkout aliases through its
existing repository identity catalog. An area has one to three nonblank text
levels. Without a valid explicit mapping, `area_path` is `null`; the UI may
display that request as Unfiled. Owner names never become area labels implicitly.

Machine keys must exactly match the `worker_host` already observed on an active
worker agent run. Labels are free text; kind is `desktop`, `laptop`, or `server`.
The backend does not discover or guess a host or kind. A missing host, session
ID or valid machine mapping leaves `session_location` absent. Stale and finished
runs, paused workers and terminal packages have no session location. Labels do
not affect package state, blockers, delivery or completion.

The hydrated dashboard returns:

- `work_requests.work_requests[].area_path` on cards.
- `work_request_details[].work_request.area_path` on request details.
- `work_request_details[].work_packages[].session_location` as
  `{"label":"Build Desk","kind":"desktop"}` when known.

The priority and deferred dashboard reads use the same labels. The config is
read once per request, before the hydrated database transaction. Edits appear
on the next read. Missing, unreadable or malformed files return no labels;
unknown fields are ignored. Reads never create or repair the file.

## Set up the file

This PowerShell 7 recipe creates a new file seeded from an invented repository's
owner. Replace the repository and observed worker host with your own values.
It refuses to replace an existing file; edit that file directly instead.

```powershell
$repoSlug = 'example-org/widget-service'
$observedWorkerHost = 'build-desk'
$boardHome = if ($env:SYMPP_HOME) { $env:SYMPP_HOME } else { Join-Path $HOME '.agents/splusplus' }
$boardPath = if ($env:SYMPP_OPERATOR_CONFIG) { $env:SYMPP_OPERATOR_CONFIG } else { Join-Path $boardHome 'operator-board.json' }
if (Test-Path -LiteralPath $boardPath) { throw "Edit the existing file: $boardPath" }
$ownerLabel = ($repoSlug -split '/')[0]
$boardConfig = @{
  repos = @{ $repoSlug.ToLowerInvariant() = @{ area = @($ownerLabel) } }
  machines = @{ $observedWorkerHost = @{ label = 'Build Desk'; kind = 'desktop' } }
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $boardPath) | Out-Null
$boardConfig | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $boardPath -Encoding utf8
```

Open the resulting file in your editor to rename the owner seed or add product
and team levels. Keep the file outside Git; each dashboard backend reads its
own operator configuration.
