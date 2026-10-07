[CmdletBinding()]
param([string]$ArtifactManifest)

$ErrorActionPreference = "Stop"
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "../../../.."))
$pluginRoot = Join-Path $repoRoot "plugins/symphony-plus-plus-mcp"
$launcher = Join-Path $pluginRoot "scripts/start-sympp-mcp.ps1"
$fixtureParent = if ($ArtifactManifest) { [IO.Path]::GetTempPath() } else { $PSScriptRoot }
$tempRoot = Join-Path $fixtureParent (".persistent-artifact-" + [guid]::NewGuid().ToString("N"))
$runtimeFile = Join-Path $tempRoot "state/runtime.json"
$backendProcessId = $null
$backendStartTicks = $null
$frontendProcessId = $null

function New-IsolatedPort([int[]]$Avoid) {
  do {
    $probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    try { $probe.Start(); $port = [int]$probe.LocalEndpoint.Port } finally { $probe.Stop() }
  } while ($port -in $Avoid -or $port -in @(19998, 19999))
  return $port
}

function Start-IsolatedProcess([string]$FilePath, [string[]]$Arguments, [hashtable]$Environment, [bool]$RedirectStreams = $true) {
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $FilePath
  foreach ($argument in $Arguments) { [void]$psi.ArgumentList.Add($argument) }
  $psi.WorkingDirectory = $repoRoot
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $RedirectStreams
  $psi.RedirectStandardOutput = $RedirectStreams
  $psi.RedirectStandardError = $RedirectStreams
  foreach ($key in @($psi.Environment.Keys)) {
    if ([string]$key -match "(?i)(TOKEN|SECRET|API_KEY|AUTHORIZATION|GITHUB|LINEAR|OPENAI)" -or
        [string]$key -in @("SYMPP_REPO_ROOT", "SYMPP_DATABASE", "SYMPP_SOURCE_FALLBACK", "SYMPP_ARTIFACT_RUNTIME", "SYMPP_BACKEND_PORT", "SYMPP_DASHBOARD_PORT", "SYMPP_BACKEND_URL", "SYMPP_DASHBOARD_ORIGIN")) {
      [void]$psi.Environment.Remove([string]$key)
    }
  }
  foreach ($entry in $Environment.GetEnumerator()) { $psi.Environment[$entry.Key] = [string]$entry.Value }
  $process = [System.Diagnostics.Process]::Start($psi)
  if (-not $process) { throw "Failed to start isolated process: $FilePath" }
  return $process
}

function Invoke-IsolatedCommand([string]$FilePath, [string[]]$Arguments, [hashtable]$Environment) {
  $process = Start-IsolatedProcess $FilePath $Arguments $Environment $false
  try {
    if (-not $process.WaitForExit(900000)) { $process.Kill($true); throw "Timed out: $FilePath" }
    if ($process.ExitCode -ne 0) { throw "$FilePath exited $($process.ExitCode)." }
  } finally {
    if (-not $process.HasExited) { $process.Kill($true) }
    $process.Dispose()
  }
}

function Send-BridgeRequest($Process, $Request) {
  $Process.StandardInput.WriteLine(($Request | ConvertTo-Json -Depth 12 -Compress))
  $Process.StandardInput.Flush()
  $line = $Process.StandardOutput.ReadLineAsync()
  if (-not $line.Wait(120000) -or $null -eq $line.Result) { throw "Bridge closed or timed out waiting for MCP response id=$($Request.id) tool=$($Request.params.name)." }
  $response = $line.Result | ConvertFrom-Json
  if ($response.error -or $response.result.isError) { throw "MCP request failed: $($line.Result)" }
  return $response
}

function Invoke-McpBridge([string]$FilePath, [string[]]$Arguments, [hashtable]$Environment, [switch]$CreateMarker, [string]$MarkerSessionId, [scriptblock]$OnAttached, [switch]$RecoverBackend) {
  $process = Start-IsolatedProcess $FilePath $Arguments $Environment
  try {
    $stderr = $process.StandardError.ReadToEndAsync()
    $requests = @(
      @{ jsonrpc = "2.0"; id = 1; method = "initialize"; params = @{ protocolVersion = "2025-03-26"; capabilities = @{}; clientInfo = @{ name = "persistent-runtime-smoke"; version = "1" } } },
      @{ jsonrpc = "2.0"; id = 2; method = "tools/list"; params = @{} }
    )
    $responses = foreach ($request in $requests) {
      Send-BridgeRequest $process $request
    }
    if ($CreateMarker) {
      $attached = Send-BridgeRequest $process @{ jsonrpc = "2.0"; id = 3; method = "tools/call"; params = @{ name = "solo_attach"; arguments = @{ repo = "fixture/packaged-ledger"; base_branch = "beta"; workspace_path = $tempRoot; caller_id = "artifact-smoke"; title = "Disposable persistence marker" } } }
      $MarkerSessionId = [string]$attached.result.structuredContent.solo_session.id
      if (-not $MarkerSessionId) { throw "Missing marker session identity." }
      [void](Send-BridgeRequest $process @{ jsonrpc = "2.0"; id = 4; method = "tools/call"; params = @{ name = "solo_append_progress"; arguments = @{ session_id = $MarkerSessionId; summary = "packaged database persistence marker"; idempotency_key = "artifact-persistence-marker" } } })
    }
    if ($RecoverBackend) {
      $ownedState = Get-Content -LiteralPath $Environment.SYMPP_RUNTIME_FILE -Raw | ConvertFrom-Json
      Stop-Process -Id ([int]$ownedState.backend.pid) -Force -ErrorAction Stop
    }
    if ($MarkerSessionId) {
      $marker = Send-BridgeRequest $process @{ jsonrpc = "2.0"; id = 5; method = "tools/call"; params = @{ name = "solo_show"; arguments = @{ session_id = $MarkerSessionId } } }
      if (@($marker.result.structuredContent.entries | Where-Object { $_.summary -eq "packaged database persistence marker" }).Count -ne 1) { throw "MCP persistence marker was missing or duplicated." }
    }
    $activeState = Get-Content -LiteralPath $Environment.SYMPP_RUNTIME_FILE -Raw | ConvertFrom-Json
    $activeBackend = Get-Process -Id ([int]$activeState.backend.pid) -ErrorAction Stop
    $activeBackendStartTicks = $activeBackend.StartTime.ToUniversalTime().Ticks
    $script:backendProcessId = $activeBackend.Id
    $script:backendStartTicks = $activeBackendStartTicks
    if ($OnAttached) { & $OnAttached $activeState $MarkerSessionId }
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(60000)) { $process.Kill($true); throw "Bridge did not exit after stdin closed: $FilePath" }
    $errorText = $stderr.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) { throw "$FilePath exited $($process.ExitCode): $errorText" }
    if ($responses[0].result.protocolVersion -ne "2025-03-26" -or @($responses[1].result.tools).Count -eq 0) {
      throw "Bridge did not complete real initialize plus tools/list."
    }
    return [pscustomobject]@{
      backend_pid = [int]$activeState.backend.pid
      backend_port = [int]$activeState.backend.port
      backend_start_ticks = $activeBackendStartTicks
      runtime_mode = [string]$activeState.runtime_mode
      artifact_root = [string]$activeState.artifact.root
      marker_session_id = $MarkerSessionId
    }
  } catch {
    $failure = $_.Exception.Message
    if (-not $process.HasExited) { $process.Kill($true); [void]$process.WaitForExit(5000) }
    throw "$failure Launcher: $($stderr.GetAwaiter().GetResult())"
  } finally {
    if (-not $process.HasExited) { $process.Kill($true) }
    $process.Dispose()
  }
}

function Get-Sha256([string]$Value) {
  return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Value))).ToLowerInvariant()
}

function Test-PortAvailable([int]$Port) {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
  try { $listener.Start(); return $true } catch { return $false } finally { $listener.Stop() }
}

function Wait-ManagedRuntimeStopped([int]$ProcessIdValue, [int]$Port) {
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (-not (Get-Process -Id $ProcessIdValue -ErrorAction SilentlyContinue) -and (Test-PortAvailable $Port)) { return }
    Start-Sleep -Milliseconds 100
  }
  throw "Managed runtime pid=$ProcessIdValue or listener port=$Port did not stop."
}

try {
  foreach ($path in @(
      $tempRoot, (Split-Path -Parent $runtimeFile), (Join-Path $tempRoot "logs"), (Join-Path $tempRoot "trace"), (Join-Path $tempRoot "database"),
      (Join-Path $tempRoot "tmp"), (Join-Path $tempRoot "xdg/config"),
      (Join-Path $tempRoot "xdg/cache"), (Join-Path $tempRoot "xdg/data")
    )) { New-Item -ItemType Directory -Path $path -Force | Out-Null }

  $backendPort = New-IsolatedPort @()
  $dashboardPort = New-IsolatedPort @($backendPort)
  if ($ArtifactManifest) {
    $manifest = Get-Content -LiteralPath $ArtifactManifest -Raw | ConvertFrom-Json
    $archive = Join-Path (Split-Path -Parent $ArtifactManifest) $manifest.artifact.file
    $codexHome = Join-Path $tempRoot "codex"
    $installedRoot = Join-Path $codexHome "plugins/cache/symphony-plus-plus/symphony-plus-plus-mcp/0.1.10"
    $sourceRoot = Join-Path $codexHome ".tmp/marketplaces/symphony-plus-plus"
    foreach ($destination in @($installedRoot, (Join-Path $sourceRoot "plugins/symphony-plus-plus-mcp"))) {
      New-Item -ItemType Directory -Path $destination -Force | Out-Null
      Copy-Item -LiteralPath (Join-Path $pluginRoot "scripts") -Destination $destination -Recurse
    }
    New-Item -ItemType Directory -Path (Join-Path $sourceRoot "elixir/priv/symphony_plus_plus"), (Join-Path $installedRoot "assets"), (Join-Path $tempRoot "profile") -Force | Out-Null
    "[]" | Set-Content -LiteralPath (Join-Path $sourceRoot "elixir/mix.exs") -NoNewline
    @{ revision = $manifest.source_revision } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $sourceRoot ".codex-marketplace-install.json")
    $contract = [string]$manifest.launcher_contract.mcp_contract_fingerprint
    @{ mcp_contract_fingerprint = $contract } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $sourceRoot "elixir/priv/symphony_plus_plus/mcp_contract.json")
    @{
      schema_version = 1; source_revision = $manifest.source_revision; launcher_contract = $manifest.launcher_contract
      artifacts = @(@{ platform = $manifest.platform; source_revision = $manifest.source_revision; mcp_contract_fingerprint = $contract
          path = $archive; sha256 = $manifest.artifact.sha256; entrypoint = "start-runtime.ps1"
          dashboard = @{ asset_root = $manifest.dashboard.relative_path; fingerprint = $manifest.dashboard.fingerprint } })
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $installedRoot "assets/sympp-runtime-artifacts.json")
    $database = Join-Path $tempRoot "database/explicit ledger.sqlite3"
    $environment = @{
      CODEX_HOME = $codexHome; SYMPP_HOME = Join-Path $tempRoot "runtime-home"; SYMPP_RUNTIME_FILE = $runtimeFile
      SYMPP_DATABASE = $database; SYMPP_LOG_DIR = Join-Path $tempRoot "logs"; SYMPP_LAUNCHER_TRACE_DIR = Join-Path $tempRoot "trace"
      SYMPP_BACKEND_PORT = [string]$backendPort; SYMPP_DASHBOARD_PORT = [string]$backendPort; SYMPP_OPEN_DASHBOARD = "0"
      SYMPP_BACKEND_STARTUP_TIMEOUT_SEC = "120"; SYMPP_COLD_START_TIMEOUT_SEC = "180"
      HOME = Join-Path $tempRoot "profile"; USERPROFILE = Join-Path $tempRoot "profile"
      TEMP = Join-Path $tempRoot "tmp"; TMP = Join-Path $tempRoot "tmp"
    }
    $command = Join-Path $installedRoot "scripts/start-sympp-mcp.cmd"
    $cmd = (Get-Command cmd.exe -ErrorAction Stop).Source
    $assertLedger = {
      param($activeState, $sessionId)
      $readiness = Invoke-RestMethod ($activeState.backend.url + "/mcp/readiness")
      $actualPath = ([string]$readiness.ledger.identity.display_path).Replace('$HOME', $environment.USERPROFILE).Replace('/', '\')
      if ($readiness.ledger.identity.kind -ne "sqlite" -or [IO.Path]::GetFullPath($actualPath) -ine [IO.Path]::GetFullPath($database)) { throw "Packaged runtime opened a different database." }
      if ($activeState.runtime_mode -ne "artifact" -or $readiness.source.revision -ne $manifest.source_revision) { throw "Packaged runtime source identity mismatch." }
    }
    $first = Invoke-McpBridge $cmd @("/d", "/c", "call $command") $environment -CreateMarker -OnAttached {
      param($activeState, $sessionId)
      & $assertLedger $activeState $sessionId
      $second = Invoke-McpBridge $cmd @("/d", "/c", "call $command") $environment -MarkerSessionId $sessionId -OnAttached $assertLedger
      if ($second.backend_pid -ne $activeState.backend.pid) { throw "Warm client did not share the packaged backend." }
    }
    Wait-ManagedRuntimeStopped $first.backend_pid $first.backend_port
    $secondWave = Invoke-McpBridge $cmd @("/d", "/c", "call $command") $environment -MarkerSessionId $first.marker_session_id -OnAttached $assertLedger -RecoverBackend
    Wait-ManagedRuntimeStopped $secondWave.backend_pid $secondWave.backend_port
    $trace = Get-ChildItem -LiteralPath $environment.SYMPP_LAUNCHER_TRACE_DIR -File | Get-Content -Raw
    if (-not ($trace -match "prepared_runtime_start")) { throw "Second wave did not exercise prepared release restart." }
    if (-not ($trace -match "backend_recovery_leader")) { throw "Second wave did not exercise backend recovery." }
    if (-not (Test-Path -LiteralPath $database -PathType Leaf)) { throw "Explicit packaged database was not created." }
    if (Test-Path -LiteralPath (Join-Path $environment.USERPROFILE ".agents/splusplus/symphony_plus_plus.sqlite3")) { throw "Packaged runtime used the default database." }
    [pscustomobject]@{ artifact_revision = $manifest.source_revision; explicit_database_with_spaces = $true; warm_singleton = $true; prepared_restart = $true; recovery = $true; mcp_marker_persisted = $true; listeners_closed = $true } | ConvertTo-Json -Compress
    return
  }
  $sourceEnvironment = @{
    SYMPP_REPO_ROOT = $repoRoot; SYMPP_HOME = Join-Path $tempRoot "runtime-home"
    SYMPP_RUNTIME_FILE = $runtimeFile; SYMPP_LOG_DIR = Join-Path $tempRoot "logs"
    SYMPP_DATABASE = Join-Path $tempRoot "database/ledger.sqlite3"
    SYMPP_BACKEND_PORT = [string]$backendPort; SYMPP_DASHBOARD_PORT = [string]$dashboardPort
    SYMPP_OPEN_DASHBOARD = "0"; SYMPP_AUTOSTART_FRONTEND = "1"; SYMPP_MCP_BRIDGE_MODE = "http"
    SYMPP_SOURCE_FALLBACK = "1"; SYMPP_ARTIFACT_RUNTIME = "0"; SYMPP_LAUNCHER = "direct"
    SYMPP_ELIXIR_SETUP_TIMEOUT_SEC = "600"; MIX_BUILD_ROOT = Join-Path $repoRoot "elixir/_build"; HEX_OFFLINE = "1"
    TEMP = Join-Path $tempRoot "tmp"; TMP = Join-Path $tempRoot "tmp"
    XDG_CONFIG_HOME = Join-Path $tempRoot "xdg/config"; XDG_CACHE_HOME = Join-Path $tempRoot "xdg/cache"; XDG_DATA_HOME = Join-Path $tempRoot "xdg/data"
  }
  $pwsh = (Get-Command pwsh -ErrorAction Stop).Source
  [void](Invoke-IsolatedCommand $pwsh @("-NoProfile", "-File", $launcher, "-PrepareRuntimeOnly") $sourceEnvironment)
  $state = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
  $backendProcessId = [int]$state.backend.pid
  $backendStartTicks = (Get-Process -Id $backendProcessId -ErrorAction Stop).StartTime.ToUniversalTime().Ticks
  $frontendProcessId = [int]$state.frontend.pid
  Stop-Process -Id $frontendProcessId -Force -ErrorAction Stop
  Wait-ManagedRuntimeStopped $frontendProcessId $dashboardPort
  $frontendProcessId = $null
  $contract = [string]$state.backend.contract_fingerprint
  $backend = ([string]$state.backend.url).TrimEnd("/")

  $codexHome = Join-Path $tempRoot "codex"
  $installedRoot = Join-Path $codexHome "plugins/cache/symphony-plus-plus/symphony-plus-plus-mcp/0.1.9"
  $sourceRoot = Join-Path $codexHome ".tmp/marketplaces/symphony-plus-plus"
  $sourcePluginRoot = Join-Path $sourceRoot "plugins/symphony-plus-plus-mcp"
  foreach ($destination in @($installedRoot, $sourcePluginRoot)) {
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $pluginRoot "scripts") -Destination $destination -Recurse
  }
  $revision = "b" * 40
  New-Item -ItemType Directory -Path (Join-Path $sourceRoot "elixir/priv/symphony_plus_plus") -Force | Out-Null
  "[]" | Set-Content -LiteralPath (Join-Path $sourceRoot "elixir/mix.exs") -NoNewline
  @{ revision = $revision } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $sourceRoot ".codex-marketplace-install.json")
  @{ mcp_contract_fingerprint = $contract } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $sourceRoot "elixir/priv/symphony_plus_plus/mcp_contract.json")
  $artifactPayload = Join-Path $tempRoot "artifact-payload"
  $artifactArchive = Join-Path $tempRoot "artifact.zip"
  $dashboardHtml = "<title>Symphony++ Dashboard</title>"
  New-Item -ItemType Directory -Path (Join-Path $artifactPayload "dashboard") -Force | Out-Null
  @'
"use strict";
const http=require("http"),a=process.argv.slice(2),arg=n=>a[a.indexOf(n)+1],port=Number(arg("--port")),contract=arg("--contract"),revision=arg("--revision"),session="artifact-fixture";
const body=r=>new Promise(q=>{const c=[];r.on("data",x=>c.push(x));r.on("end",()=>q(Buffer.concat(c).toString("utf8")));});
const send=(r,s,v,h={})=>{const b=typeof v==="string"?v:JSON.stringify(v);r.writeHead(s,{"Content-Type":"application/json","Content-Length":Buffer.byteLength(b),...h});r.end(b);};
const server=http.createServer(async(req,res)=>{
  if(req.url==="/shutdown"){send(res,200,{status:"stopping"});return server.close(()=>process.exit(0));}
  if(req.url==="/mcp/readiness")return send(res,200,{status:"ok",ledger:{reachable:true,identity:{kind:"sqlite",display_path:process.env.SYMPP_DATABASE}},dashboard:{ready:true},source:{revision,mcp_contract:{fingerprint:contract}}});
  if(req.url==="/sympp/board")return send(res,200,"<title>Symphony++ Dashboard</title>",{"Content-Type":"text/html"});
  if(req.url==="/mcp/client-lease"){await body(req);return send(res,200,{stale_after_ms:600000});}
  if(req.url==="/mcp"){const p=JSON.parse(await body(req)),result=p.method==="initialize"?{protocolVersion:"2025-03-26",capabilities:{},serverInfo:{name:"artifact-fixture",version:"1"}}:p.method==="tools/list"?{tools:[{name:"fixture",description:"fixture",inputSchema:{type:"object"}}]}:null;return result?send(res,200,{jsonrpc:"2.0",id:p.id,result},{"Mcp-Session-Id":session}):send(res,404,{error:"missing"});}
  send(res,404,{error:"not found"});
});
server.listen(port,"127.0.0.1");
'@ | Set-Content -LiteralPath (Join-Path $artifactPayload "backend.js") -NoNewline
  "@echo off`r`nnode `"%~dp0backend.js`" %*`r`n" | Set-Content -LiteralPath (Join-Path $artifactPayload "start-runtime.cmd") -NoNewline
  $dashboardHtml | Set-Content -LiteralPath (Join-Path $artifactPayload "dashboard/index.html") -NoNewline
  Compress-Archive -Path (Join-Path $artifactPayload "*") -DestinationPath $artifactArchive
  $artifactSha = (Get-FileHash -LiteralPath $artifactArchive -Algorithm SHA256).Hash.ToLowerInvariant()
  $dashboardFingerprint = Get-Sha256 "index.html $(Get-Sha256 $dashboardHtml)"
  New-Item -ItemType Directory -Path (Join-Path $installedRoot "assets") -Force | Out-Null
  @{
    schema_version = 1; source_revision = $revision; launcher_contract = @{ mcp_contract_fingerprint = $contract }
    artifacts = @(@{ platform = "windows-x86_64"; source_revision = $revision; mcp_contract_fingerprint = $contract
        path = $artifactArchive; sha256 = $artifactSha; entrypoint = "start-runtime.cmd"
        runtime_args = @("--port", "{port}", "--contract", $contract, "--revision", $revision, "start-runtime.cmd")
        dashboard = @{ asset_root = "dashboard"; fingerprint = $dashboardFingerprint } })
  } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $installedRoot "assets/sympp-runtime-artifacts.json")
  $installedPath = [System.IO.Path]::GetFullPath($installedRoot).ToLowerInvariant()
  $generationKey = Get-Sha256 "$installedPath`n$revision`n$contract"
  $validationFile = Join-Path $sourceEnvironment.SYMPP_HOME ("runtime/launcher-validation/" + (Get-Sha256 $installedPath).Substring(0, 12) + ".json")
  New-Item -ItemType Directory -Path (Split-Path -Parent $validationFile) -Force | Out-Null
  @{ schema_version = 1; plugin_root = $installedRoot; source_root = $sourceRoot; generation_key = $generationKey; revision = $revision; contract_fingerprint = $contract } |
    ConvertTo-Json -Compress | Set-Content -LiteralPath $validationFile

  $runtimeKey = "contract=$($contract.ToLowerInvariant());backend=$($backend.ToLowerInvariant());dashboard=$($backend.ToLowerInvariant())"
  $state.plugin_root = $installedRoot
  $state.runtime_kind = "artifact"
  $state.runtime_mode = "artifact"
  $state.runtime_key = $runtimeKey
  $state.frontend.status = "artifact_static"
  $state.frontend.origin = $backend
  $state.frontend.url = "$backend/sympp/board"
  $state.frontend.port = $backendPort
  $state.frontend.managed = $false
  $state.frontend.pid = $null
  $state | Add-Member -NotePropertyName publication -NotePropertyValue ([pscustomobject]@{ status = "ready"; controls = [pscustomobject]@{ database = $sourceEnvironment.SYMPP_DATABASE } }) -Force
  $state | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $runtimeFile

  $installedEnvironment = @{
    SYMPP_HOME = $sourceEnvironment.SYMPP_HOME; SYMPP_RUNTIME_FILE = $runtimeFile
    SYMPP_DATABASE = $sourceEnvironment.SYMPP_DATABASE
    SYMPP_LOG_DIR = $sourceEnvironment.SYMPP_LOG_DIR; SYMPP_LAUNCHER_TRACE_DIR = Join-Path $tempRoot "trace"
    SYMPP_STARTUP_LOCK_TIMEOUT_SEC = "30"; SYMPP_MCP_HTTP_TIMEOUT_SEC = "60"
  }
  $cmd = (Get-Command cmd.exe -ErrorAction Stop).Source
  $installedCommand = Join-Path $installedRoot "scripts/start-sympp-mcp.cmd"
  $firstWave = Invoke-McpBridge $cmd @("/d", "/c", "call $installedCommand") $installedEnvironment
  if ($firstWave.backend_pid -ne $backendProcessId) { throw "Installed command attached to unexpected backend pid=$($firstWave.backend_pid)." }
  Wait-ManagedRuntimeStopped $backendProcessId $backendPort
  $firstBackendProcessId = $backendProcessId
  $backendProcessId = $null

  $laterInstalledEnvironment = $installedEnvironment.Clone()
  $laterInstalledEnvironment.SYMPP_BACKEND_PORT = "0"
  $laterInstalledEnvironment.SYMPP_AUTOSTART_FRONTEND = "0"
  $laterInstalledEnvironment.SYMPP_ELIXIR_SETUP_TIMEOUT_SEC = "30"
  $laterInstalledEnvironment.SYMPP_BACKEND_STARTUP_TIMEOUT_SEC = "60"
  $laterInstalledEnvironment.SYMPP_BACKEND_PORT_RELEASE_TIMEOUT_SEC = "1"
  $laterInstalledEnvironment.SYMPP_STARTUP_LOCK_TIMEOUT_SEC = "180"
  $laterInstalledEnvironment.SYMPP_COLD_START_TIMEOUT_SEC = "90"
  $laterInstalledEnvironment.SYMPP_POWERSHELL = $pwsh
  $laterInstalledEnvironment.TEMP = $sourceEnvironment.TEMP
  $laterInstalledEnvironment.TMP = $sourceEnvironment.TMP
  $secondWave = Invoke-McpBridge $cmd @("/d", "/c", "call $installedCommand") $laterInstalledEnvironment
  $backendProcessId = $secondWave.backend_pid
  $backendStartTicks = $secondWave.backend_start_ticks
  if ($backendProcessId -eq $firstBackendProcessId) { throw "Later installed command wave reused backend pid=$backendProcessId." }
  if ($secondWave.backend_port -in @(19998, 19999)) { throw "Explicit dynamic launch used reserved port $($secondWave.backend_port)." }
  $artifactCacheRoot = [System.IO.Path]::GetFullPath((Join-Path $sourceEnvironment.SYMPP_HOME "artifacts/mcp"))
  if ($secondWave.runtime_mode -ne "artifact" -or -not ([System.IO.Path]::GetFullPath($secondWave.artifact_root).StartsWith($artifactCacheRoot, [StringComparison]::OrdinalIgnoreCase))) {
    throw "Later installed command wave was not artifact-backed."
  }
  Wait-ManagedRuntimeStopped $backendProcessId $secondWave.backend_port
  $backendProcessId = $null

  [void](Invoke-IsolatedCommand $pwsh @("-NoProfile", "-File", $launcher, "-PrepareRuntimeOnly") $sourceEnvironment)
  $sourceState = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
  $sourceProcessId = [int]$sourceState.backend.pid
  $frontendProcessId = [int]$sourceState.frontend.pid
  $backendProcessId = $sourceProcessId
  $backendStartTicks = (Get-Process -Id $sourceProcessId -ErrorAction Stop).StartTime.ToUniversalTime().Ticks
  [void](Invoke-McpBridge $pwsh @("-NoProfile", "-File", $launcher) $sourceEnvironment)
  Wait-ManagedRuntimeStopped $sourceProcessId $backendPort
  Wait-ManagedRuntimeStopped $frontendProcessId $dashboardPort
  $backendProcessId = $null
  $frontendProcessId = $null

  [pscustomobject]@{
    installed_waves = 2; initialize_and_tools_list = 3; installed_pids_distinct = $true
    explicit_backend_port_dynamic = $true
    artifact_last_detach_stopped = $true; listeners_closed = $true
    source_last_detach_stopped = $true; isolated_runtime_ledger_ports = $true
  } | ConvertTo-Json -Compress
} finally {
  if ($ArtifactManifest -and (Test-Path -LiteralPath $runtimeFile)) {
    $ownedState = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
    $ownedBackend = Get-Process -Id ([int]$ownedState.backend.pid) -ErrorAction SilentlyContinue
    if ($ownedBackend -and [string]$ownedState.publication.backend.process_start_time_utc_ticks -eq [string]$ownedBackend.StartTime.ToUniversalTime().Ticks) {
      $backendProcessId = $ownedBackend.Id
      $backendStartTicks = $ownedBackend.StartTime.ToUniversalTime().Ticks
    }
  }
  if ($frontendProcessId) { Stop-Process -Id $frontendProcessId -Force -ErrorAction SilentlyContinue }
  if ($backendProcessId -and $backendStartTicks) {
    $backendProcess = Get-Process -Id $backendProcessId -ErrorAction SilentlyContinue
    if ($backendProcess -and $backendProcess.StartTime.ToUniversalTime().Ticks -eq $backendStartTicks) { Stop-Process -Id $backendProcessId -Force }
  }
  $ownedRoot = [System.IO.Path]::GetFullPath($fixtureParent).TrimEnd("\") + "\"
  if (-not ([System.IO.Path]::GetFullPath($tempRoot).StartsWith($ownedRoot, [StringComparison]::OrdinalIgnoreCase))) { throw "Cleanup abort: temp root escaped its fixture directory." }
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
