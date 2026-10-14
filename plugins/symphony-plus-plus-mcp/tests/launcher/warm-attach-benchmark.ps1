param([int]$Clients = 100)
$ErrorActionPreference = "Stop"
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "../../../.."))
$pluginRoot = Join-Path $repoRoot "plugins/symphony-plus-plus-mcp"
$scriptsRoot = Join-Path $pluginRoot "scripts"
$contractPath = Join-Path $repoRoot "elixir/priv/symphony_plus_plus/mcp_contract.json"
$contract = [string]((Get-Content -LiteralPath $contractPath -Raw | ConvertFrom-Json).mcp_contract_fingerprint)
$tempRoot = Join-Path $PSScriptRoot (".warm-production-" + [guid]::NewGuid().ToString("N"))
$runtimeFile = Join-Path $tempRoot "runtime.json"
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$pool = $null
$gate = [System.Threading.ManualResetEventSlim]::new($false)
$ready = [System.Threading.CountdownEvent]::new($Clients)
$samples = [System.Collections.Concurrent.ConcurrentQueue[double]]::new()
$remoteAttempts = [System.Collections.Concurrent.ConcurrentQueue[bool]]::new()
$leaseDeleteFailures = [System.Collections.Concurrent.ConcurrentQueue[string]]::new()
$jobs = [System.Collections.Generic.List[object]]::new()
function Get-ScriptFunctionDefinitions([string[]]$Paths) {
  $definitions = @{}
  foreach ($path in $Paths) {
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
    if ($errors.Count -ne 0) { throw "PowerShell parse failed for $path" }
    foreach ($functionAst in $ast.FindAll({
          param($node)
          $node -is [System.Management.Automation.Language.FunctionDefinitionAst]
        }, $true)) {
      $body = $functionAst.Body.Extent.Text
      $parameters = if ($functionAst.Parameters.Count -gt 0) { "param(" + (($functionAst.Parameters.Extent.Text) -join ", ") + ")`n" } else { "" }
      $definitions[$functionAst.Name] = $parameters + $body.Substring(1, $body.Length - 2)
    }
  }
  return $definitions
}
try {
  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
  $listener.Start($Clients)
  $port = [int]$listener.LocalEndpoint.Port
  if ($port -in @(19998, 19999)) { throw "Ephemeral listener selected a forbidden default port." }
  $owners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)
  if ($owners.Count -ne 1 -or [int]$owners[0] -ne $PID) { throw "Warm benchmark listener ownership is not isolated." }
  $url = "http://127.0.0.1:$port"
  $runtimeKey = "contract=$contract;backend=$url;dashboard=$url"
  [pscustomobject]@{
    plugin_root = $pluginRoot; runtime_key = $runtimeKey; runtime_mode = "external"
    backend = [pscustomobject]@{
      status = "external_loopback"; url = $url; managed = $false; pid = $null
      expected_contract_fingerprint = $contract; contract_fingerprint = $contract; source_revision = "b" * 40
    }
    frontend = [pscustomobject]@{ status = "external_loopback"; origin = $url; managed = $false; pid = $null }
  } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $runtimeFile -Encoding utf8NoBOM
  $paths = @(
    Get-ChildItem -LiteralPath $scriptsRoot -Filter "*.ps1" -File | Sort-Object Name | Select-Object -ExpandProperty FullName
  )
  $definitions = Get-ScriptFunctionDefinitions $paths
  # Hold the real lease reader in JSON conversion while another client detaches.
  $leaseReadReady = [System.Threading.ManualResetEventSlim]::new($false)
  $leaseReadRelease = [System.Threading.ManualResetEventSlim]::new($false)
  $reader = $null
  $readerRunspace = $null
  $readerResult = $null
  $probeLease = $null
  try {
    $readerState = [System.Management.Automation.Runspaces.InitialSessionState]::CreateDefault()
    foreach ($entry in $definitions.GetEnumerator()) {
      $readerState.Commands.Add([System.Management.Automation.Runspaces.SessionStateFunctionEntry]::new($entry.Key, $entry.Value))
    }
    $readerState.Commands.Add([System.Management.Automation.Runspaces.SessionStateFunctionEntry]::new("ConvertFrom-Json", @'
param([Parameter(ValueFromPipeline = $true)]$InputObject)
process {
  $LeaseReadReady.Set()
  $LeaseReadRelease.Wait()
  Microsoft.PowerShell.Utility\ConvertFrom-Json -InputObject $InputObject
}
'@))
    $readerState.Variables.Add([System.Management.Automation.Runspaces.SessionStateVariableEntry]::new("LeaseReadReady", $leaseReadReady, "lease reader barrier"))
    $readerState.Variables.Add([System.Management.Automation.Runspaces.SessionStateVariableEntry]::new("LeaseReadRelease", $leaseReadRelease, "lease reader barrier"))
    $readerRunspace = [runspacefactory]::CreateRunspace($readerState)
    $readerRunspace.Open()
    $reader = [powershell]::Create()
    $reader.Runspace = $readerRunspace
    $probePlan = [pscustomobject]@{ managed = $false; status = "external_loopback"; url = $url; source_revision = "b" * 40 }
    $probeLease = New-BridgeLease $runtimeFile $probePlan $probePlan $runtimeKey
    [void]$reader.AddScript('param($RuntimeFile) Get-ActiveBridgeLeases $RuntimeFile | Out-Null').AddArgument($runtimeFile)
    $readerResult = $reader.BeginInvoke()
    if (-not $leaseReadReady.Wait(10000)) { throw "Lease contention fixture did not reach the actual reader." }
    $Error.Clear()
    Remove-BridgeLease $probeLease
    if ([IO.File]::Exists($probeLease)) {
      $removalError = if ($Error.Count) { "hresult=$($Error[0].Exception.HResult) $($Error[0].Exception.Message)" } else { "no removal error captured" }
      throw "Concurrent lease read prevented detach removal: $removalError"
    }
  } finally {
    $leaseReadRelease.Set()
    if ($readerResult) { [void]$reader.EndInvoke($readerResult) }
    if ($reader) { $reader.Dispose() }
    if ($readerRunspace) { $readerRunspace.Dispose() }
    $leaseReadReady.Dispose()
    $leaseReadRelease.Dispose()
    if ($probeLease) { Remove-Item -LiteralPath $probeLease -Force -ErrorAction SilentlyContinue }
  }
  $definitions["Write-Diagnostic"] = 'param([string]$Message)'
  $definitions["Get-SymppBackendHealthWithRetry"] = @'
param([string]$Url, [int]$Attempts = 1, [int]$DelayMs = 1)
return [pscustomobject]@{ healthy = $true; tcp_open = $true; mcp_ready = $true; ledger_reachable = $true; ledger_identity = [pscustomobject]@{ kind = "sqlite"; default_home = $true }; status = "ok"; source_revision = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; contract_fingerprint = $ContractFingerprint }
'@
  $definitions["Invoke-HttpMcpBridge"] = @'
param([string]$McpUrl, [int]$TimeoutSec, [string]$ClientLeaseId, [int]$HeartbeatIntervalSec)
$ClientWatch.Stop()
$Samples.Enqueue($ClientWatch.Elapsed.TotalMilliseconds)
[void]$Ready.Signal()
if (-not $Gate.Wait(30000)) { throw "Timed out holding concurrent warm bridges." }
'@
  $definitions["New-McpClientLeaseId"] = 'return [guid]::NewGuid().ToString("N")'
  $definitions["Remove-BridgeLease"] += @'
if ($LeasePath -and [IO.File]::Exists($LeasePath)) {
  $detail = if ($Error.Count) { $Error[0].Exception.Message } else { "No deletion error was returned" }
  $LeaseDeleteFailures.Enqueue(([IO.Path]::GetFileName($LeasePath) + ": " + $detail))
}
'@
  foreach ($name in @("Resolve-SymppArtifactProbe", "Read-SymppArtifactManifest", "Invoke-WebRequest")) {
    $definitions[$name] = '$RemoteAttempts.Enqueue($true); throw "Warm path attempted artifact or remote resolution."'
  }
  $initialState = [System.Management.Automation.Runspaces.InitialSessionState]::CreateDefault()
  foreach ($entry in $definitions.GetEnumerator()) {
    $initialState.Commands.Add([System.Management.Automation.Runspaces.SessionStateFunctionEntry]::new($entry.Key, $entry.Value))
  }
  foreach ($variable in @{
      ContractFingerprint = $contract; Samples = $samples; RemoteAttempts = $remoteAttempts; Ready = $ready; Gate = $gate; LeaseDeleteFailures = $leaseDeleteFailures
      BoardPath = "/sympp/board"
    }.GetEnumerator()) {
    $initialState.Variables.Add([System.Management.Automation.Runspaces.SessionStateVariableEntry]::new($variable.Key, $variable.Value, "warm benchmark"))
  }
  $pool = [runspacefactory]::CreateRunspacePool(1, $Clients, $initialState, $Host)
  $pool.Open()
  $clientScript = {
    param($RuntimeFile, $PluginRoot, $Port)
    $ClientWatch = [System.Diagnostics.Stopwatch]::StartNew()
    [void](Invoke-WarmAttachFromRuntimeState -RuntimeFile $RuntimeFile -PluginRoot $PluginRoot -BackendPort $Port -DashboardPort 0 -BackendPortExplicit $true -DashboardPortExplicit $false -ConfiguredBackendUrl $null -ConfiguredDashboardOrigin $null -BridgeTimeout 30 -ClientHeartbeatInterval 5)
  }
  foreach ($index in 1..$Clients) {
    $powershell = [powershell]::Create()
    $powershell.RunspacePool = $pool
    [void]$powershell.AddScript($clientScript).AddArgument($runtimeFile).AddArgument($pluginRoot).AddArgument($port)
    $jobs.Add([pscustomobject]@{ shell = $powershell; result = $powershell.BeginInvoke() })
  }

  if (-not $ready.Wait(30000)) { throw "Timed out waiting for $Clients production warm attaches. errors=$(@($jobs.shell.Streams.Error | ForEach-Object { $_.Exception.Message + ' command=' + $_.InvocationInfo.MyCommand.Name + ' position=' + $_.InvocationInfo.PositionMessage + ' stack=' + $_.ScriptStackTrace }) -join '; ')" }
  $leaseDir = Resolve-Path (Join-Path $tempRoot "codex-plugin-leases")
  $leasesPeak = @(Get-ChildItem -LiteralPath $leaseDir -Filter "bridge-*.json" -File).Count
  $gate.Set()
  foreach ($job in $jobs) { [void]$job.shell.EndInvoke($job.result); $job.shell.Dispose() }
  $sorted = @($samples.ToArray() | Sort-Object)
  [pscustomobject]@{
    clients = $Clients
    p50_ms = [Math]::Round($sorted[[Math]::Ceiling($sorted.Count * 0.50) - 1], 2)
    p95_ms = [Math]::Round($sorted[[Math]::Ceiling($sorted.Count * 0.95) - 1], 2)
    max_ms = [Math]::Round($sorted[-1], 2)
    backend_processes = $owners.Count
    leases_peak = $leasesPeak
    leases_after = @(Get-ChildItem -LiteralPath $leaseDir -Filter "bridge-*.json" -File -ErrorAction SilentlyContinue).Count
    remote_resolution_attempts = $remoteAttempts.Count
    lease_delete_failures = @($leaseDeleteFailures.ToArray())
    worker_errors = @($jobs.shell.Streams.Error | ForEach-Object { $_.Exception.Message })
  } | ConvertTo-Json -Compress
} finally {
  $gate.Set()
  foreach ($job in $jobs) { try { $job.shell.Dispose() } catch { } }
  if ($pool) { $pool.Dispose() }
  $listener.Stop()
  $gate.Dispose()
  $ready.Dispose()
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
