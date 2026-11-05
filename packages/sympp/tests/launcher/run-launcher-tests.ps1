param([switch]$SkipDesktopTests)

[System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = [System.Diagnostics.ProcessPriorityClass]::BelowNormal
$ErrorActionPreference = "Stop"
function Assert-True($Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}
$inheritedPriority = & (Get-Command pwsh -ErrorAction Stop).Source -NoProfile -NonInteractive -Command '[System.Diagnostics.Process]::GetCurrentProcess().PriorityClass'
Assert-True ([System.Diagnostics.Process]::GetCurrentProcess().PriorityClass -eq [System.Diagnostics.ProcessPriorityClass]::BelowNormal) "Launcher test parent must run BelowNormal"
Assert-True ($inheritedPriority -eq "BelowNormal") "Launcher test descendants must inherit BelowNormal priority"
function Import-ScriptFunction([string]$Path, [string]$Name) {
  $tokens = $null
  $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
  Assert-True ($errors.Count -eq 0) "PowerShell parse failed for $Path"
  $functionAst = $ast.Find({
      param($node)
      $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $Name
    }, $true)
  Assert-True ($null -ne $functionAst) "Missing function $Name in $Path"
  $definition = [regex]::Replace($functionAst.Extent.Text, '^function\s+[A-Za-z0-9_-]+', "function script:$Name")
  Invoke-Expression $definition
}
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "../../../.."))
$scriptPath = Join-Path $repoRoot "packages/sympp/scripts/start-sympp-mcp.ps1"
$helperPath = Join-Path $repoRoot "packages/sympp/scripts/sympp-mcp-launcher-helpers.ps1"
$runtimePath = Join-Path $repoRoot "packages/sympp/scripts/sympp-launcher-runtime.ps1"
$artifactRuntimePath = Join-Path $repoRoot "packages/sympp/scripts/sympp-mcp-artifact-runtime.ps1"
$processRuntimePath = Join-Path $repoRoot "packages/sympp/scripts/sympp-mcp-process-runtime.ps1"
. $runtimePath
. $helperPath
. (Join-Path $repoRoot "packages/sympp/scripts/sympp-mcp-artifact-manifest.ps1")
. $processRuntimePath
Import-ScriptFunction $scriptPath "Test-HealthySymppDashboard"
$BoardPath = "/sympp/board"
$script:DashboardResponse = @{ StatusCode = 200; Content = Get-Content -LiteralPath (Join-Path $repoRoot "elixir/assets/index.html") -Raw }
function Invoke-WebRequest { return $script:DashboardResponse }
Assert-True (Test-HealthySymppDashboard "http://127.0.0.1:21000") "The shipped dashboard HTML must pass launcher readiness"
$script:DashboardResponse.StatusCode = 503
Assert-True (-not (Test-HealthySymppDashboard "http://127.0.0.1:21000")) "A failed dashboard response must not pass readiness"
$script:DashboardResponse = @{ StatusCode = 200; Content = "<html><title>Unrelated application</title></html>" }
Assert-True (-not (Test-HealthySymppDashboard "http://127.0.0.1:21000")) "An unrelated HTML listener must not pass dashboard readiness"
Remove-Item Function:Invoke-WebRequest
$script:SymppSessionLocation = @{ client_id = "client-ps"; machine_id = "build-desk"; machine_label = "Build-Desk" }
$locatedRequest = Add-SymppSessionLocation '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_context","arguments":{},"_meta":{"another":true}}}' | ConvertFrom-Json
Assert-True ($locatedRequest.params._meta.another -and $locatedRequest.params._meta.sympp_session_location.client_id -eq "client-ps") "PowerShell location transport must preserve other MCP metadata"
Assert-True ($locatedRequest.params.name -eq "read_context" -and $locatedRequest.params._meta.sympp_session_location.machine_id -eq "build-desk") "PowerShell location transport must preserve the tool and client machine"
$script:SymppSessionLocation = $null
& (Join-Path $PSScriptRoot "port-selection-tests.ps1")
$herdrBindingJson = '{"role":"architect","work_request_id":"wr-test","show_inspector":true}'
$herdrBindingEncoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($herdrBindingJson)).TrimEnd("=").Replace("+", "-").Replace("/", "_")
$herdrBinding = ConvertFrom-SymppHerdrBinding $herdrBindingEncoded
Assert-True ($herdrBinding.role -eq "architect" -and $herdrBinding.work_request_id -eq "wr-test" -and $herdrBinding.show_inspector) "PowerShell bridge must decode the shared Herdr binding header"
$script:SymppHerdrInspectorProcess = [pscustomobject]@{ HasExited = $true; ExitCode = 0 }
$script:SymppHerdrInspectorInflightRevision = 1
$script:SymppHerdrInspectorRevision = 2
$script:SymppHerdrInspectorPending = $true
$script:SymppHerdrProcess = [pscustomobject]@{}
Update-SymppHerdrInspectorProcess
Assert-True $script:SymppHerdrInspectorPending "A completed inspector sync must retain a newer pending binding revision"
$script:SymppHerdrProcess = $null
$script:SymppHerdrInspectorRevision = 0
$script:SymppHerdrInspectorInflightRevision = 0
$script:SymppHerdrInspectorPending = $false
& (Get-Command node.exe -ErrorAction Stop).Source (Join-Path $PSScriptRoot "herdr-binding-tests.js")
$herdrNodeExitCode = $LASTEXITCODE
Assert-True ($herdrNodeExitCode -eq 0) "Node bridge must translate Herdr binding metadata"
$faultedRead = [System.Threading.Tasks.TaskCompletionSource[string]]::new()
$faultedRead.SetException([System.IO.IOException]::new("test read failure"))
$faultedState = [pscustomobject]@{ pending_task = $faultedRead.Task; buffered_lines = [System.Collections.Generic.Queue[string]]::new(); eof = $false }
$faultedResult = Receive-McpStdinLine $faultedState 1
Assert-True ($faultedResult.ready -and $null -eq $faultedResult.line -and $faultedState.eof) "Faulted stdin reads must become EOF"
$firstRead = [System.Threading.Tasks.TaskCompletionSource[string]]::new(); $firstRead.SetResult("first")
$secondRead = [System.Threading.Tasks.TaskCompletionSource[string]]::new(); $secondRead.SetResult("second")
$pendingRead = [System.Threading.Tasks.TaskCompletionSource[string]]::new()
$boundedReader = [pscustomobject]@{ next_task = $secondRead.Task; pending_task = $pendingRead.Task }
$boundedReader | Add-Member -MemberType ScriptMethod -Name ReadLineAsync -Value { $next = $this.next_task; $this.next_task = $this.pending_task; return $next }
$boundedState = [pscustomobject]@{ reader = $boundedReader; pending_task = $firstRead.Task; buffered_lines = [System.Collections.Generic.Queue[string]]::new(); eof = $false }
[void](Update-McpStdinReadState $boundedState)
Assert-True ($boundedState.buffered_lines.Count -eq 1 -and $boundedState.pending_task.IsCompleted) "STDIN polling must leave pipe backpressure after one buffered line"
Assert-True (-not (Test-McpBackendUnavailableResponse ([pscustomobject]@{ ok = $false; statusCode = 503 }))) "HTTP errors must remain backend responses"
Assert-True (Test-McpBackendUnavailableResponse ([pscustomobject]@{ ok = $false; statusCode = $null })) "Transport failures without a status must trigger recovery"
foreach ($name in @(
    "Get-McpContractFingerprintFromContractFile",
    "Resolve-LocalMcpContractFingerprint",
    "New-RuntimeKey", "Get-RuntimeStateKey", "Get-PortFromOrigin", "Test-EndpointMatches", "Test-BackendShouldShutdownOnIdle",
    "Test-PortSelectionAllowsReuse", "Test-BackendContractMatches", "Resolve-SymppDatabasePath", "Test-SymppDatabasePathsMatch", "Test-BackendLaunchCompatible",
    "Test-RuntimeStateExternalLoopback", "Test-RuntimeEntryEndpointMatches", "Test-SymppReleaseWrapperCommandLine", "Test-SymppBackendCommandLine", "Get-ProcessCommandIdentity", "New-SymppPublicationControls", "Test-SymppPublicationControlsMatch",
    "Test-SymppPublishedRuntimeReadyLocally", "Resolve-SymppPendingBackendProcess", "Test-SymppStartingBackendOwned", "New-ReusedBackendPlan", "New-ReusedDashboardPlan",
    "Resolve-LocalWarmAttachIdentity", "Resolve-FastAttachRuntimePlan", "Resolve-DashboardPlan", "Set-SymppSourceRevisionEnvironment"
  )) {
  Import-ScriptFunction $scriptPath $name
}
foreach ($name in @("Get-SymppArtifactDirectoryFingerprint", "Test-SymppArtifactDashboardReady", "Remove-SymppArtifactExtractionStaging", "Expand-SymppArtifactArchive", "Test-ArtifactBackendProvidesDashboard", "Resolve-LaunchArtifactSelection")) {
  Import-ScriptFunction $artifactRuntimePath $name
}
foreach ($name in @("New-SymppBackendHealth", "Test-LoopbackHttpTcpOpen", "Get-SymppBackendHealth")) {
  Import-ScriptFunction $scriptPath $name
}
$script:healthHttpAttempted = $false
function Invoke-WebRequest { $script:healthHttpAttempted = $true; throw "HTTP probe observed" }
try {
  Assert-True (-not (Get-SymppBackendHealth 'http://[').healthy) "A malformed persisted URL must remain an unhealthy probe instead of terminating startup"
  foreach ($address in @([Net.IPAddress]::Loopback, [Net.IPAddress]::IPv6Loopback)) {
    $listener = [Net.Sockets.TcpListener]::new($address, 0)
    try {
      $listener.Start()
      $listenerPort = $listener.LocalEndpoint.Port
      $origin = "http://$($listener.LocalEndpoint)"
      Assert-True ($PID -in @(Get-TcpPortOwners $listenerPort).pid) "Listener discovery must find the real IPv4 and IPv6 owner"
      foreach ($liveOrigin in @($origin, "http://localhost:$($listener.LocalEndpoint.Port)")) {
        $script:healthHttpAttempted = $false
        $null = Get-SymppBackendHealth $liveOrigin
        Assert-True $script:healthHttpAttempted "A listening IPv4, IPv6, or localhost port must still receive an HTTP health probe"
      }
    } finally { $listener.Stop() }
    $script:healthHttpAttempted = $false
    $closedHealth = Get-SymppBackendHealth $origin
    Assert-True (@(Get-TcpPortOwners $listenerPort).Count -eq 0) "Closed ports must have no owners"
    Assert-True (-not $closedHealth.healthy -and -not $closedHealth.tcp_open) "A closed listener must be unhealthy"
    Assert-True (-not $script:healthHttpAttempted) "A closed listener must skip the redundant HTTP connection timeout"
  }
} finally { Remove-Item Function:Invoke-WebRequest }
function Write-Diagnostic([string]$Message) { }
function Write-CompatibleSourceMismatchDiagnostic { }

& {
  foreach ($name in @("Stop-ManagedRuntimeProcess", "Test-ManagedRuntimeCommandLine", "Test-ManagedRuntimePortCommandLine")) {
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$null, [ref]$null)
    $fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
    Invoke-Expression $fn.Extent.Text
  }
  $testPath = 'C:\cache\rt\windows-x86_64\0123456789abcdef\runtime\erts-16.0\bin\erl.exe'
  function Test-SymppWindowsPlatform { $true }
  function Get-CimInstance { throw 'CIM unavailable' }
  function Get-Process { [pscustomobject]@{ Path = $testPath } }
  function Test-ProcessOwnsTcpPort { $true }
  function Stop-Process { param($Id, [switch]$Force) $script:nativeCleanupStoppedPid = $Id }
  $script:nativeCleanupStoppedPid = 0
  Assert-True (Stop-ManagedRuntimeProcess 'backend' 12345 19999) 'An artifact listener identified without CIM must still shut down'
  Assert-True ($script:nativeCleanupStoppedPid -eq 12345) 'Cleanup must stop the identified listener'
  $testPath = 'C:\Program Files\Erlang\erts-16.0\bin\erl.exe'
  $script:nativeCleanupStoppedPid = 0
  Assert-True (-not (Stop-ManagedRuntimeProcess 'backend' 12345 19999)) 'A foreign Erlang path must not authorize shutdown'
  Assert-True ($script:nativeCleanupStoppedPid -eq 0) 'Foreign Erlang must remain running'
}

$pluginRoot = Join-Path $repoRoot "packages/sympp"
$fingerprint = Resolve-LocalMcpContractFingerprint $pluginRoot
Assert-True (-not [string]::IsNullOrWhiteSpace($fingerprint)) "Current local MCP contract must resolve without artifact metadata"
$backendUrl = "http://127.0.0.1:19998"
$runtimeKey = New-RuntimeKey $backendUrl $backendUrl $fingerprint
$state = [pscustomobject]@{
  plugin_root = $pluginRoot
  runtime_key = $runtimeKey
  runtime_mode = "artifact"
  backend = [pscustomobject]@{
    status = "started"; url = $backendUrl; managed = $true; pid = $PID
    expected_contract_fingerprint = $fingerprint; contract_fingerprint = $fingerprint; source_revision = "b" * 40
  }
  frontend = [pscustomobject]@{ status = "artifact_static"; origin = $backendUrl; managed = $false; pid = $null }
}
$identity = Resolve-LocalWarmAttachIdentity $state $pluginRoot 19998 19999 $false $false $null $null
Assert-True ($null -ne $identity) "Current-contract artifact-static runtime should be eligible for PowerShell fallback warm attach"
$previousDatabase = $env:SYMPP_DATABASE
$previousRepoRoot = $env:SYMPP_REPO_ROOT
$previousBackendUrl = $env:SYMPP_BACKEND_URL
try {
  $env:SYMPP_REPO_ROOT = $null
  $env:SYMPP_BACKEND_URL = $null
  $env:SYMPP_DATABASE = Join-Path $env:USERPROFILE "fixture ledger/first.sqlite3"
  $databaseControls = New-SymppPublicationControls 19998 19999 $false $false $null $null
  $databaseState = $state | ConvertTo-Json -Depth 8 | ConvertFrom-Json
  $databaseState | Add-Member -NotePropertyName publication -NotePropertyValue ([pscustomobject]@{ controls = $databaseControls })
  Assert-True ($null -ne (Resolve-LocalWarmAttachIdentity $databaseState $pluginRoot 19998 19999 $false $false $null $null)) "Same explicit database must retain recorded attachment"
  $databaseHealth = New-SymppBackendHealth $true $null $null $true $true $true "ok" $fingerprint ([pscustomobject]@{ kind = "sqlite"; display_path = '$HOME/fixture ledger/first.sqlite3' })
  Assert-True (Test-BackendLaunchCompatible $databaseHealth $fingerprint) "Live safe home-relative identity must match the requested database"
  $databaseControls.database = $databaseControls.database.ToUpperInvariant().Replace('\', '/')
  Assert-True (Test-SymppPublicationControlsMatch $databaseControls (New-SymppPublicationControls 19998 19999 $false $false $null $null)) "Windows case and separator changes must match publication controls"
  $env:SYMPP_DATABASE = Join-Path $env:USERPROFILE "fixture ledger/different.sqlite3"
  Assert-True (-not (Test-BackendLaunchCompatible $databaseHealth $fingerprint)) "A healthy same-contract backend with another database must be incompatible"
  Assert-True ($null -eq (Resolve-LocalWarmAttachIdentity $databaseState $pluginRoot 19998 19999 $false $false $null $null)) "Different explicit database must reject recorded attachment"
  Assert-True (-not (Test-SymppPublicationControlsMatch $databaseControls (New-SymppPublicationControls 19998 19999 $false $false $null $null))) "Database mismatch must reject publication and prepared restart"
  $env:SYMPP_DATABASE = " "
  Assert-True (-not (Test-BackendLaunchCompatible $databaseHealth $fingerprint)) "Blank installed request cannot adopt another live ledger"
  $env:SYMPP_DATABASE = $null
  Assert-True (-not (Test-BackendLaunchCompatible $databaseHealth $fingerprint)) "Unset installed request cannot adopt another live ledger"
  $defaultHealth = New-SymppBackendHealth $true $null $null $true $true $true "ok" $fingerprint ([pscustomobject]@{ kind = "sqlite"; default_home = $true })
  Assert-True (Test-BackendLaunchCompatible $defaultHealth $fingerprint) "Default installed ledger remains attachable"
  $env:SYMPP_REPO_ROOT = $repoRoot
  Assert-True (Test-BackendLaunchCompatible $databaseHealth $fingerprint) "Deliberate source attachment keeps its ledger choice"
  $env:SYMPP_REPO_ROOT = $null
  $env:SYMPP_BACKEND_URL = $backendUrl
  Assert-True (Test-BackendLaunchCompatible $databaseHealth $fingerprint) "Deliberate backend attachment keeps its ledger choice"
  $env:SYMPP_DATABASE = Join-Path $env:USERPROFILE "fixture ledger/different.sqlite3"
  Assert-True (-not (Test-BackendLaunchCompatible $databaseHealth $fingerprint)) "Explicit database still constrains deliberate backend attachment"
} finally {
  $env:SYMPP_DATABASE = $previousDatabase
  $env:SYMPP_REPO_ROOT = $previousRepoRoot
  $env:SYMPP_BACKEND_URL = $previousBackendUrl
}
$publishedControls = New-SymppPublicationControls 19998 19999 $false $false $null $null
$publishedState = $state | ConvertTo-Json -Depth 8 | ConvertFrom-Json
$publishedState.backend.managed = $false
$publishedState.backend.status = "external_loopback"
$publishedState.frontend.status = "external_loopback"
$publishedState | Add-Member -NotePropertyName publication -NotePropertyValue ([pscustomobject]@{ status = "ready"; generation_key = "published-generation"; controls = $publishedControls })
$publishedIdentity = [pscustomobject]@{ generation_key = "published-generation"; contract_fingerprint = $fingerprint }
$staleFingerprint = $(if ($fingerprint[0] -eq "0") { "1" } else { "0" }) + $fingerprint.Substring(1)
function Get-SymppBackendHealthWithRetry { return $script:publishedExternalHealth }
try {
  $script:publishedExternalHealth = [pscustomobject]@{ healthy = $false; contract_fingerprint = $fingerprint }
  Assert-True (-not (Test-SymppPublishedRuntimeReadyLocally $publishedState $pluginRoot $null $publishedControls)) "A stopped external backend must not satisfy initial ready publication"
  $script:publishedExternalHealth = [pscustomobject]@{ healthy = $true; contract_fingerprint = $staleFingerprint }
  Assert-True (-not (Test-SymppPublishedRuntimeReadyLocally $publishedState $pluginRoot $null $publishedControls)) "A live incompatible external backend must not satisfy initial ready publication"
  $script:publishedExternalHealth = [pscustomobject]@{ healthy = $true; contract_fingerprint = $fingerprint; ledger_identity = [pscustomobject]@{ kind = "sqlite"; default_home = $true } }
  Assert-True (Test-SymppPublishedRuntimeReadyLocally $publishedState $pluginRoot $null $publishedControls) "A live compatible external backend should satisfy local readiness"
  Assert-True (Test-SymppPublishedRuntimeReadyLocally $publishedState $pluginRoot $publishedIdentity $publishedControls) "A live compatible external backend should satisfy ready publication"
  $mismatchedIdentity = [pscustomobject]@{ generation_key = "other-generation"; contract_fingerprint = $fingerprint }
  Assert-True (-not (Test-SymppPublishedRuntimeReadyLocally $publishedState $pluginRoot $mismatchedIdentity $publishedControls)) "A different installed generation must reject the publication"
  $publishedPlan = Resolve-FastAttachRuntimePlan $publishedState $publishedState.backend.source_revision $fingerprint 0 0 $false $false $null $null $script:publishedExternalHealth $true $true
  Assert-True ($null -ne $publishedPlan) "A live compatible external publication should produce a follower attach plan"
} finally {
  Remove-Item Function:Get-SymppBackendHealthWithRetry
}
Assert-True ($null -eq (Resolve-LocalWarmAttachIdentity $state $pluginRoot 20000 19999 $true $false $null $null)) "Explicit backend port mismatch must reject fallback warm attach"
Assert-True ($null -eq (Resolve-LocalWarmAttachIdentity $state (Join-Path $pluginRoot "other") 19998 19999 $false $false $null $null)) "Different plugin payload must reject fallback warm attach"
$staleState = $state | ConvertTo-Json -Depth 8 | ConvertFrom-Json
$staleState.runtime_key = New-RuntimeKey $backendUrl $backendUrl $staleFingerprint
$staleState.backend.expected_contract_fingerprint = $staleFingerprint
$staleState.backend.contract_fingerprint = $staleFingerprint
Assert-True ($null -eq (Resolve-LocalWarmAttachIdentity $staleState $pluginRoot 19998 19999 $false $false $null $null)) "Stale fallback state must take the cold validation path"
$health = [pscustomobject]@{ healthy = $true; source_revision = $state.backend.source_revision; contract_fingerprint = $fingerprint; ledger_identity = [pscustomobject]@{ kind = "sqlite"; default_home = $true } }
$plan = Resolve-FastAttachRuntimePlan $state $state.backend.source_revision $fingerprint 0 0 $false $false $null $null $health $true $true
Assert-True ($null -ne $plan -and -not $plan.dashboard_plan.managed) "Artifact-static runtime should produce an unmanaged-dashboard fallback plan"
Assert-True (Test-BackendShouldShutdownOnIdle $state.backend $state.frontend) "Managed backends without a managed dashboard must shut down on idle in source and artifact modes"
Assert-True (Test-SymppBackendCommandLine 'cmd.exe /c C:\cache\rt\windows-x86_64\0123456789abcdef\runtime\start-runtime.cmd') "Supported artifact command wrappers must remain recoverable before binding"
Assert-True (Test-SymppBackendCommandLine 'C:\cache\rt\windows-x86_64\0123456789abcdef\runtime\erts-16.0\bin\erl.exe') "A packaged Erlang executable identifies the artifact listener without command-line discovery"
Assert-True (-not (Test-SymppBackendCommandLine 'C:\other\rt\unmanaged\erts-16.0\bin\erl.exe')) "An arbitrary rt directory must not identify a managed artifact listener"
Assert-True (-not (Test-SymppBackendCommandLine 'C:\Program Files\Erlang\erts-16.0\bin\erl.exe')) "A foreign Erlang executable must not identify a managed artifact listener"
$sourceState = [pscustomobject]@{ runtime_kind = "managed"; backend = [pscustomobject]@{ url = "http://127.0.0.1:20000" } }
$reusedSourcePlan = [pscustomobject]@{ reused = $true; should_start = $false; url = "http://127.0.0.1:20000" }
Assert-True (-not (Test-ArtifactBackendProvidesDashboard $sourceState $reusedSourcePlan "source")) "Reused source backends must not be promoted to artifact mode"
$sourceDashboardState = [pscustomobject]@{
  backend = [pscustomobject]@{ url = "http://127.0.0.1:20000" }
  frontend = [pscustomobject]@{ origin = "http://127.0.0.1:20001"; managed = $true; pid = 123 }
}
function Test-HealthySymppDashboard([string]$Origin) { return $true }
function Test-SymppDashboardMcpProxyMatches([string]$Origin, [string]$ExpectedContractFingerprint) { return $false }
$restartDashboardPlan = Resolve-DashboardPlan 20001 $null "http://127.0.0.1:20000" ("b" * 40) $sourceDashboardState $true ("b" * 40) $fingerprint $true $true
Assert-True ($restartDashboardPlan.reused -and $restartDashboardPlan.managed -and $restartDashboardPlan.pid -eq 123) "Backend restart must preserve a healthy recorded managed dashboard while its proxy is temporarily unavailable"

$pendingBase = Join-Path ([System.IO.Path]::GetTempPath()) "sympp-pending-launch-$([guid]::NewGuid().ToString('N'))"
$pendingRoot = Join-Path $pendingBase "rt/windows-x64/0123456789abcdef/runtime"
$leader = $null; $wrapperPid = 0; $unrelated = $null; $ownedPid = 0
try {
  New-Item -ItemType Directory -Path $pendingRoot -Force | Out-Null
  $runtimeCmd = Join-Path $pendingRoot "start-runtime.cmd"
  $wrapperScript = Join-Path $pendingRoot "wrapper.ps1"
  $wrapperReady = Join-Path $pendingRoot "wrapper-ready"
  $wrapperRelease = Join-Path $pendingRoot "wrapper-release"
  $wrapperChild = Join-Path $pendingRoot "wrapper-child.json"
  $backendReady = Join-Path $pendingRoot "backend-ready"
  $backendRelease = Join-Path $pendingRoot "backend-release"
  $leaderCmd = Join-Path $pendingRoot "leader.cmd"
  Set-Content -LiteralPath (Join-Path $pendingRoot "hold.ps1") -Value 'while (-not (Test-Path -LiteralPath $env:SYMPP_TEST_BACKEND_RELEASE)) { Start-Sleep -Milliseconds 25 }'
  Set-Content -LiteralPath (Join-Path $pendingRoot "backend.ps1") -Value @(
    '[System.IO.File]::WriteAllText($env:SYMPP_TEST_BACKEND_READY, "ready")'
    '& (Join-Path $PSScriptRoot "hold.ps1")'
  )
  Set-Content -LiteralPath $runtimeCmd -Value "@echo off`r`npowershell.exe -NoProfile -NonInteractive -File `"%~dp0backend.ps1`"" -NoNewline
  Set-Content -LiteralPath $wrapperScript -Value @(
    '[System.IO.File]::WriteAllText($env:SYMPP_TEST_WRAPPER_READY, "ready")'
    'while (-not (Test-Path -LiteralPath $env:SYMPP_TEST_WRAPPER_RELEASE)) { Start-Sleep -Milliseconds 25 }'
    '$child = Start-Process cmd.exe -ArgumentList @("/d", "/s", "/c", "call `"$env:SYMPP_TEST_RUNTIME_CMD`"") -WorkingDirectory $env:SYMPP_TEST_RUNTIME_ROOT -WindowStyle Hidden -PassThru'
    '[System.IO.File]::WriteAllText(($env:SYMPP_TEST_WRAPPER_CHILD + ".tmp"), (@{ pid = $child.Id; parent_pid = $PID } | ConvertTo-Json -Compress))'
    '[System.IO.File]::Move(($env:SYMPP_TEST_WRAPPER_CHILD + ".tmp"), $env:SYMPP_TEST_WRAPPER_CHILD)'
  )
  Set-Content -LiteralPath $leaderCmd -Value "@echo off`r`npowershell.exe -NoProfile -NonInteractive -File `"%~dp0wrapper.ps1`"`r`npowershell.exe -NoProfile -NonInteractive -File `"%~dp0hold.ps1`"" -NoNewline
  $env:SYMPP_TEST_WRAPPER_READY = $wrapperReady; $env:SYMPP_TEST_WRAPPER_RELEASE = $wrapperRelease
  $env:SYMPP_TEST_RUNTIME_CMD = $runtimeCmd; $env:SYMPP_TEST_RUNTIME_ROOT = $pendingRoot
  $env:SYMPP_TEST_WRAPPER_CHILD = $wrapperChild
  $env:SYMPP_TEST_BACKEND_READY = $backendReady; $env:SYMPP_TEST_BACKEND_RELEASE = $backendRelease
  $publishedAt = [DateTimeOffset]::UtcNow
  $leader = Start-Process cmd.exe -ArgumentList @('/d', '/s', '/c', "call `"$leaderCmd`"") -WorkingDirectory $pendingRoot -WindowStyle Hidden -PassThru
  $leaderIdentity = Get-ProcessStartIdentity $leader
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds(10)
  while (-not (Test-Path -LiteralPath $wrapperReady) -and [DateTimeOffset]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 25 }
  $wrapper = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($leader.Id)" -ErrorAction SilentlyContinue | Where-Object { [string]$_.CommandLine -match 'wrapper\.ps1' } | Select-Object -First 1
  Assert-True ($null -ne $wrapper) "Pending-launch fixture did not create the published wrapper"
  $wrapperPid = [int]$wrapper.ProcessId
  $wrapperProcess = Get-Process -Id $wrapperPid
  $wrapperIdentity = Get-ProcessStartIdentity $wrapperProcess
  Set-Content -LiteralPath $wrapperRelease -Value "ready" -NoNewline
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds(10)
  while ((-not (Test-Path -LiteralPath $wrapperChild) -or -not (Test-Path -LiteralPath $backendReady)) -and [DateTimeOffset]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 25
  }
  # The producer supplies fixture identity; real recovery below still proves CIM lineage.
  $reportedChild = if (Test-Path -LiteralPath $wrapperChild) { Get-Content -LiteralPath $wrapperChild -Raw | ConvertFrom-Json } else { $null }
  if ($reportedChild) { $ownedPid = [int]$reportedChild.pid }
  Assert-True ($null -ne $reportedChild) "Backend child publication failed: wrapper=$wrapperPid exited=$($wrapperProcess.HasExited)"
  Assert-True (Test-Path -LiteralPath $backendReady) "Backend child readiness failed: wrapper=$wrapperPid child=$ownedPid"
  Assert-True ($reportedChild.parent_pid -eq $wrapperPid) "Backend child publication named the wrong wrapper: expected=$wrapperPid actual=$($reportedChild.parent_pid)"
  $ownedProcess = Get-Process -Id $ownedPid -ErrorAction Stop
  Assert-True (-not $ownedProcess.HasExited) "Published backend child exited before recovery: child=$ownedPid"
  Assert-True ($wrapperProcess.WaitForExit(10000)) "Published wrapper exit failed after child readiness: wrapper=$wrapperPid child=$ownedPid"
  Stop-Process -Id $leader.Id -Force; [void]$leader.WaitForExit(5000)
  $unrelated = Start-Process cmd.exe -ArgumentList @('/d', '/s', '/c', "call `"$runtimeCmd`"") -WorkingDirectory $pendingRoot -WindowStyle Hidden -PassThru
  $controls = New-SymppPublicationControls 31991 31991 $true $true $null $null
  $identity = [pscustomobject]@{ generation_key = 'pending-generation' }
  $pendingState = [pscustomobject]@{
    backend = [pscustomobject]@{ pid = $wrapperPid }
    publication = [pscustomobject]@{
      status = 'starting'; generation_key = $identity.generation_key; controls = $controls; published_at = $publishedAt.ToString('o')
      leader_pid = $leader.Id; leader_process_start_time_utc_ticks = $leaderIdentity
      backend = [pscustomobject]@{ pid = $wrapperPid; process_start_time_utc_ticks = $wrapperIdentity; port = 31991; runtime_root = $pendingRoot }
    }
  }
  Assert-True (Test-SymppStartingBackendOwned $pendingState $identity $controls) "Leader-death recovery must adopt the exact backend child after its published wrapper exits"
  Assert-True ([int]$pendingState.publication.backend.pid -eq $ownedPid -and [int]$pendingState.publication.backend.pid -ne $unrelated.Id) "Pending recovery must not adopt an unrelated loopback process"
} finally {
  if (Test-Path -LiteralPath $pendingRoot) { Set-Content -LiteralPath $backendRelease -Value "release" -NoNewline }
  if (-not $ownedPid -and (Test-Path -LiteralPath $wrapperChild)) {
    $reportedChild = Get-Content -LiteralPath $wrapperChild -Raw | ConvertFrom-Json
    if ($reportedChild.parent_pid -eq $wrapperPid) { $ownedPid = [int]$reportedChild.pid }
  }
  foreach ($processId in @($(if ($unrelated) { $unrelated.Id }), $ownedPid, $wrapperPid, $(if ($leader) { $leader.Id }))) {
    if ($processId -and (Get-Process -Id $processId -ErrorAction SilentlyContinue)) { & taskkill.exe /PID $processId /T /F 2>$null | Out-Null }
  }
  Remove-Item Env:SYMPP_TEST_WRAPPER_READY,Env:SYMPP_TEST_WRAPPER_RELEASE,Env:SYMPP_TEST_RUNTIME_CMD,Env:SYMPP_TEST_RUNTIME_ROOT,Env:SYMPP_TEST_WRAPPER_CHILD,Env:SYMPP_TEST_BACKEND_READY,Env:SYMPP_TEST_BACKEND_RELEASE -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $pendingBase -Recurse -Force -ErrorAction SilentlyContinue
}
& (Join-Path $PSScriptRoot "artifact-fingerprint-tests.ps1")
$artifactTemp = Join-Path $PSScriptRoot (".artifact-runtime-" + [guid]::NewGuid().ToString("N"))
try {
  $payload = Join-Path $artifactTemp "payload"
  New-Item -ItemType Directory -Path (Join-Path $payload "dashboard-static") -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $payload "start-runtime.ps1") -Value "exit 0" -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $payload "dashboard-static/index.html") -Value "ready" -Encoding UTF8
  $fingerprint = Get-SymppArtifactDirectoryFingerprint (Join-Path $payload "dashboard-static")
  $archive = Join-Path $artifactTemp "runtime.zip"
  [System.IO.Compression.ZipFile]::CreateFromDirectory($payload, $archive)
  $extractRoot = Join-Path $artifactTemp "runtime"
  New-Item -ItemType Directory -Path "$extractRoot.extracting-orphan" | Out-Null
  Remove-SymppArtifactExtractionStaging $extractRoot
  Assert-True (-not (Test-Path -LiteralPath "$extractRoot.extracting-orphan")) "Artifact staging cleanup must remove an orphaned extraction directory"
  $timings = Expand-SymppArtifactArchive $archive $extractRoot "start-runtime.ps1" ("a" * 64) "windows-x64" ("b" * 40) "0.1.9" "manifest.json" "dashboard-static" $fingerprint
  Assert-True (($timings.extract_ms -ge 0) -and (Test-SymppArtifactDashboardReady $extractRoot "dashboard-static" $fingerprint)) "Stdlib artifact extraction must preserve dashboard proof"
  function Ensure-SymppArtifactPrepared { $script:capturedDashboardRoot = $args[10]; return "cache_ready" }
  try {
    $script:capturedDashboardRoot = $null
    $rootDashboardRuntime = [pscustomobject]@{ root = $extractRoot; dashboard_root = $extractRoot; entrypoint_relative = "start-runtime.ps1"; sha256 = "a" * 64; platform = "windows-x64"; source_revision = "b" * 40; plugin_version = "0.1.9"; dashboard_fingerprint = $fingerprint }
    $rootDashboardProbe = [pscustomobject]@{ status = "artifact_selected"; selected_artifact = [pscustomobject]@{}; manifest_path = "manifest.json"; cache_root = $artifactTemp; runtime = $rootDashboardRuntime }
    $rootDashboardSelection = Resolve-LaunchArtifactSelection $pluginRoot $null $rootDashboardProbe ("b" * 40) $fingerprint $true $false
    Assert-True ($rootDashboardSelection.runtime_mode -eq "artifact" -and $script:capturedDashboardRoot -eq ".") "Root-level dashboard artifacts must retain a dot-relative asset root"
  } finally {
    Remove-Item Function:Ensure-SymppArtifactPrepared -ErrorAction SilentlyContinue
  }
} finally {
  Remove-Item -LiteralPath $artifactTemp -Recurse -Force -ErrorAction SilentlyContinue
}
& (Get-Command node.exe -ErrorAction Stop).Source (Join-Path $PSScriptRoot "state-identity-tests.js")
$nodeExitCode = $LASTEXITCODE
Assert-True ($nodeExitCode -eq 0) "Node state identity tests must pass"
& (Get-Command node.exe -ErrorAction Stop).Source (Join-Path $PSScriptRoot "bridge-response-forwarding-tests.js")
$nodeExitCode = $LASTEXITCODE
Assert-True ($nodeExitCode -eq 0) "Node bridge response forwarding test must pass"
$artifactCommandTemp = Join-Path ([IO.Path]::GetTempPath()) ("sympp-command-" + [guid]::NewGuid().ToString("N"))
$previousDatabase = $env:SYMPP_DATABASE
try {
  $env:SYMPP_DATABASE = "fixture ledger/explicit.sqlite3"
  $artifactRoot = Join-Path $artifactCommandTemp "artifact & command%TEMP%"
  $releaseEntrypoint = Join-Path $artifactRoot "bin/symphony_elixir.bat"
  New-Item -ItemType Directory -Path (Split-Path -Parent $releaseEntrypoint) -Force | Out-Null
  Set-Content -LiteralPath $releaseEntrypoint -Value "@exit /b 23" -Encoding ascii
  $artifactRuntime = [pscustomobject]@{
    root = $artifactRoot
    entrypoint = Join-Path $artifactRoot "start-runtime.ps1"
    runtime_args = $null
    workflow = $null
  }
  $artifactPlan = [pscustomobject]@{ port = 20000 }
  $artifactCommand = Get-ArtifactBackendCommand $artifactRuntime $artifactPlan $null $null (Join-Path $artifactCommandTemp "logs")
  $releaseProcess = Start-Process $artifactCommand.file -ArgumentList (Join-ProcessArgumentList $artifactCommand.args) -WorkingDirectory $artifactCommand.working_directory -WindowStyle Hidden -Wait -PassThru
  Assert-True ($releaseProcess.ExitCode -eq 23) "Windows release command must execute paths containing shell metacharacters"
  Assert-True ($artifactCommand.working_directory -eq $artifactRoot) "Direct artifact startup must preserve the artifact working directory"
  Assert-True ($artifactCommand.environment.SYMPP_RUNTIME_ARTIFACT_ACKNOWLEDGED -eq "1" -and $artifactCommand.environment.PHX_SERVER -eq "true") "Direct artifact startup must preserve release safety and server environment"
  Assert-True ((Test-Path -LiteralPath $artifactCommand.environment.RELEASE_TMP -PathType Container)) "Direct artifact startup must provide an isolated release temp directory"
  Assert-True ($artifactCommand.environment.SYMPP_DATABASE -eq [IO.Path]::GetFullPath($env:SYMPP_DATABASE)) "Release startup resolves database before changing artifact working directory"
  $artifactRuntime.runtime_args = @("-Port", "{port}")
  $customCommand = Get-ArtifactBackendCommand $artifactRuntime $artifactPlan $null $null (Join-Path $artifactCommandTemp "custom-logs")
  Assert-True ($customCommand.file -eq $artifactRuntime.entrypoint -and (@($customCommand.args) -join "|") -eq "-Port|20000") "Artifacts with custom manifest arguments must retain the declared wrapper contract"
  Assert-True ($customCommand.environment.SYMPP_DATABASE -eq $artifactCommand.environment.SYMPP_DATABASE) "Generic artifact wrappers receive the same database selection"
} finally {
  $env:SYMPP_DATABASE = $previousDatabase
  Remove-Item -LiteralPath $artifactCommandTemp -Recurse -Force -ErrorAction SilentlyContinue
}
$process = Get-Process -Id $PID
$startIdentity = Get-ProcessStartIdentity $process
$processMap = @{ [string]$PID = [pscustomobject]@{ exists = $true; start_time_utc_ticks = $startIdentity } }
$liveLease = [pscustomobject]@{ pid = $PID; process_start_time_utc_ticks = $startIdentity; created_at = [DateTimeOffset]::UtcNow.ToString("o") }
$reusedPidLease = [pscustomobject]@{ pid = $PID; process_start_time_utc_ticks = "1"; created_at = [DateTimeOffset]::UtcNow.ToString("o") }
Assert-True (Test-BridgeLeaseActive $liveLease $processMap) "Matching PID/start identity must stay live"
Assert-True (-not (Test-BridgeLeaseActive $reusedPidLease $processMap)) "Reused PID identity must be stale"
$livenessPath = [System.IO.Path]::GetTempFileName()
try {
  [System.IO.File]::WriteAllText($livenessPath, "node-lease-token")
  $nodeLease = [pscustomobject]@{ pid = $PID; process_liveness_pipe = $livenessPath; process_liveness_token = "node-lease-token" }
  Assert-True (Test-BridgeLeaseActive $nodeLease $processMap) "Matching Node liveness token must stay live"
  $nodeLease.process_liveness_token = "reused-process-token"
  Assert-True (-not (Test-BridgeLeaseActive $nodeLease $processMap)) "Mismatched Node liveness token must be stale"
} finally {
  Remove-Item -LiteralPath $livenessPath -Force -ErrorAction SilentlyContinue
}
Assert-True (-not (Test-BridgeLeaseActive $liveLease @{})) "Missing process must be stale"

$benchmark = & (Join-Path $PSScriptRoot "warm-attach-benchmark.ps1") | ConvertFrom-Json
Write-Host ("Fallback warm burst: " + ($benchmark | ConvertTo-Json -Depth 8 -Compress))
Assert-True ($benchmark.clients -eq 100 -and $benchmark.p95_ms -lt 2000) "100-client PowerShell fallback warm attach p95 must stay below 2 seconds"
Assert-True ($benchmark.backend_processes -eq 1) "Fallback warm burst listener count: expected=1 actual=$($benchmark.backend_processes)"
Assert-True ($benchmark.leases_peak -eq 100) "Fallback warm burst peak lease count: expected=100 actual=$($benchmark.leases_peak)"
Assert-True ($benchmark.leases_after -eq 0) "Fallback warm burst remaining lease count: expected=0 actual=$($benchmark.leases_after) deletion_failures=$($benchmark.lease_delete_failures -join '; ') worker_errors=$($benchmark.worker_errors -join '; ')"
Assert-True ($benchmark.remote_resolution_attempts -eq 0) "Fallback warm burst must make zero artifact or remote resolution attempts"
$nodeBurstJson = & (Get-Command node.exe -ErrorAction Stop).Source (Join-Path $PSScriptRoot "node-bridge-burst.js")
$nodeExitCode = $LASTEXITCODE
Assert-True ($nodeExitCode -eq 0) "Node bridge burst test must pass"
$nodeBurst = $nodeBurstJson | ConvertFrom-Json
Assert-True ($nodeBurst.clients -eq 30 -and $nodeBurst.board -eq 0 -and $nodeBurst.earlyLease -eq 1 -and $nodeBurst.initialize -eq 30) "30 concurrent Node bridges must initialize against the fixture backend with one health-leader lease and no dashboard traffic"
if (-not $SkipDesktopTests) {
  $coldSmokeJson = & (Get-Command node.exe -ErrorAction Stop).Source (Join-Path $PSScriptRoot "cold-start-singleton-smoke.js")
  $coldExitCode = $LASTEXITCODE
  Assert-True ($coldExitCode -eq 0) "Installed cold-herd, leader-death, and rotating-owner suite must pass"
  $coldSmoke = $coldSmokeJson | ConvertFrom-Json
  Assert-True ((@($coldSmoke.matrix.clients) -join ",") -eq "30,100" -and @($coldSmoke.matrix | Where-Object { $_.manifest -ne 1 -or $_.artifact -ne 1 -or $_.backends -ne 1 -or $_.listeners -ne 0 }).Count -eq 0) "30/100 shipped-command fixture matrices must preserve singleton cold work and release the backend listener after the final client"
  Assert-True ($coldSmoke.powershell_5_1 -and $coldSmoke.pwsh -and $coldSmoke.cleanup -and $coldSmoke.powershell_fallback.clients -eq 10 -and @($coldSmoke.leader_death | Where-Object { -not $_.prepared }).Count -eq 4) "Cold-herd coverage must prove both PowerShell shells, a stable 10-client fallback herd, cleanup, and all leader-death phases"
  Assert-True (@($coldSmoke.recovery).Count -eq 11 -and @($coldSmoke.recovery | Where-Object { $_.mode -notin "shutdown_during_recovery", "powershell_fallback_recovery", "powershell_fallback_initialize_retry" -and ($_.backends -ne 2 -or $_.pids -ne 2 -or $_.listeners -ne 0 -or $_.recovery_leaders -ne 1) }).Count -eq 0) "Node and PowerShell fallback recovery must each elect exactly one replacement backend and still reach zero listeners"
  Assert-True (@($coldSmoke.recovery | Where-Object { $_.mode -like "*ambiguous_tool" -and $_.mutations -eq 1 }).Count -eq 2 -and @($coldSmoke.recovery | Where-Object { $_.mode -notin "shutdown_during_recovery", "generation_changed_recovery", "cleanup_source_changed_recovery", "powershell_fallback_recovery", "powershell_fallback_initialize_retry" -and $_.tools_list -le $_.clients }).Count -eq 0) "Recovered adapters that issue tools/list must rebind it and never replay the ambiguous mutating tool call"
  $fallbackRecovery = $coldSmoke.recovery | Where-Object mode -eq "powershell_fallback_recovery"
  Assert-True ($fallbackRecovery.backends -eq 3 -and $fallbackRecovery.pids -eq 3 -and $fallbackRecovery.listeners -eq 0 -and $fallbackRecovery.recovery_leaders -eq 2 -and $fallbackRecovery.tools_list -eq 9) "PowerShell fallback must complete two recoveries and drain both accepted requests after EOF"
  Assert-True (@($coldSmoke.recovery | Where-Object { $_.mode -like "*backend_only_read_recovery" -and $_.tools_list -eq 3 -and $_.mutations -eq 0 }).Count -eq 2) "Node and PowerShell fallback bridges must replay an ambiguous read-only request after backend-only recovery"
  Assert-True (($coldSmoke.recovery | Where-Object mode -eq "shutdown_during_recovery").shutdown_race) "Adapters must exit when STDIO closes during heartbeat recovery"
  Assert-True (($coldSmoke.recovery | Where-Object mode -eq "generation_changed_recovery").fatal_generation) "A replacement rejected by generation validation must detach its lease and fail the adapter closed"
  Assert-True (($coldSmoke.recovery | Where-Object mode -eq "cleanup_source_changed_recovery").fatal_cleanup) "A replacement rejected by cleanup-source validation must detach its lease, fail closed, and stop cleanly"
  Assert-True (($coldSmoke.recovery | Where-Object mode -eq "powershell_fallback_recovery").fallback_recovery -and ($coldSmoke.recovery | Where-Object mode -eq "powershell_fallback_recovery").cancelled_recovery) "Surviving PowerShell fallback adapters must retain STDIO, rebind the replacement, cancel recovery on final close, and drain it after final detach"
  Assert-True (($coldSmoke.recovery | Where-Object mode -eq "powershell_fallback_initialize_retry").initialize_retry) "A provably unsent initialize must be retransmitted after PowerShell fallback recovery"
  Assert-True ($coldSmoke.powershell_fallback.clients -eq 10 -and $coldSmoke.powershell_fallback.preparations -eq 1 -and $coldSmoke.powershell_fallback.backends -eq 1) "Direct PowerShell fallback must elect one cold leader before installed identity and runtime work"
  $jobCertificationJson = & (Join-Path $PSScriptRoot "run-job-object-certification.ps1")
  $jobCertificationExitCode = $LASTEXITCODE
  Assert-True ($jobCertificationExitCode -eq 0) "Windows Job Object certification must pass"
  $jobCertification = $jobCertificationJson | ConvertFrom-Json
  $jobOwnershipVerified = if ($jobCertification.elevated_backend) { $jobCertification.owner_job_survived } else { $jobCertification.owner_rotations -eq 3 -and $jobCertification.backend_recoveries -eq 2 -and $jobCertification.mutations -eq 1 }
  Assert-True ($jobCertification.clients -eq 32 -and $jobCertification.initial_epochs -eq 1 -and $jobCertification.original_stdio -and $jobOwnershipVerified) "Job clients must preserve singleton startup and original follower STDIO through shell-owned survival or client-owned recovery"
  Assert-True ($jobCertification.processes_after -eq 0 -and $jobCertification.listeners_after -eq 0 -and $jobCertification.active_leases_after -eq 0) "Final Job close must leave no owned process, listener, or active lease"
  $persistentRuntime = @(& (Join-Path $PSScriptRoot "persistent-artifact-runtime-smoke.ps1"))[-1] | ConvertFrom-Json
  Assert-True ($persistentRuntime.installed_waves -eq 2 -and $persistentRuntime.initialize_and_tools_list -eq 3 -and $persistentRuntime.installed_pids_distinct) "Installed command must stop the artifact-static runtime and start a new backend PID for the next wave"
  Assert-True ($persistentRuntime.artifact_last_detach_stopped -and $persistentRuntime.listeners_closed -and $persistentRuntime.source_last_detach_stopped -and $persistentRuntime.isolated_runtime_ledger_ports) "Source and installed artifact cleanup must stop their managed listeners and remain isolated from the main runtime"
} else {
  Write-Host "Skipped interactive desktop startup, recovery, Job Object, and persistent runtime checks (-SkipDesktopTests)."
}

Write-Host "Launcher checks passed."
