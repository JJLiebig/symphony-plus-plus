[CmdletBinding()]
param([string]$ArtifactManifest, [string]$SkillsInstall, [switch]$HostedProcessCreation)

$ErrorActionPreference = "Stop"
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "../../../.."))
$pluginRoot = Join-Path $repoRoot "plugins/symphony-plus-plus-mcp"
$launcher = Join-Path $pluginRoot "scripts/start-sympp-mcp.ps1"
# Keep executable fixtures outside checkout paths, including deeply nested worktrees.
$fixtureParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$tempRoot = Join-Path $fixtureParent ("sympp-persistent-" + [guid]::NewGuid().ToString("N"))
$runtimeFile = Join-Path $tempRoot "state/runtime.json"
if ($SkillsInstall) { $runtimeFile = Join-Path $tempRoot '.sympp-beta/runtime/codex-plugin.json' }
. (Join-Path $PSScriptRoot 'beta-install-qualification.ps1')
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
  if (-not $SkillsInstall -and [IO.Path]::GetFileName($FilePath) -ieq "cmd.exe") {
    # cmd uses shell quoting, not ArgumentList's C-runtime quote escaping.
    $psi.Arguments = $Arguments -join " "
  } else {
    foreach ($argument in $Arguments) { [void]$psi.ArgumentList.Add($argument) }
  }
  $psi.WorkingDirectory = if ($SkillsInstall) { $tempRoot } else { $repoRoot }
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $RedirectStreams
  $psi.RedirectStandardOutput = $RedirectStreams
  $psi.RedirectStandardError = $RedirectStreams
  foreach ($key in @($psi.Environment.Keys)) {
    if ([string]$key -match "(?i)(TOKEN|SECRET|API_KEY|AUTHORIZATION|GITHUB|LINEAR|OPENAI)" -or
        ($SkillsInstall -and [string]$key -eq "CODEX_HOME") -or
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
  $process = Start-IsolatedProcess $FilePath $Arguments $Environment
  try {
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(900000)) { $process.Kill($true); throw "Timed out: $FilePath" }
    $details = $stdout.GetAwaiter().GetResult() + $stderr.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) { throw "$FilePath exited $($process.ExitCode). $details" }
    Write-Host $details
  } finally {
    if (-not $process.HasExited) { $process.Kill($true) }
    $process.Dispose()
  }
}

function Read-IsolatedCommand([string]$FilePath, [string[]]$Arguments, [hashtable]$Environment) {
  $process = Start-IsolatedProcess $FilePath $Arguments $Environment
  try {
    $streams = @{
      stdout = @{ reader = $process.StandardOutput; pending = $null; closed = $false; lines = [Collections.Generic.List[string]]::new() }
      stderr = @{ reader = $process.StandardError; pending = $null; closed = $false; lines = [Collections.Generic.List[string]]::new() }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    do {
      $readAny = $false
      foreach ($stream in $streams.Values) {
        if ($stream.closed) { continue }
        if (-not $stream.pending) { $stream.pending = $stream.reader.ReadLineAsync() }
        if ($stream.pending.Wait(20)) {
          if ($null -eq $stream.pending.Result) { $stream.closed = $true }
          else { $stream.lines.Add($stream.pending.Result) }
          $stream.pending = $null
          $readAny = $true
        }
      }
      # Hosted process fixtures can leave pipe handles in a detached backend.
      if ($process.HasExited -and -not $readAny) { break }
      if ([DateTime]::UtcNow -gt $deadline) { $process.Kill($true); throw "Native command timed out: $FilePath" }
      if (-not $readAny) { Start-Sleep -Milliseconds 10 }
    } while ($true)
    $result = @{ exit = $process.ExitCode; stdout = [string]::Join("`n", $streams.stdout.lines); stderr = [string]::Join("`n", $streams.stderr.lines) }
    Write-Host ($result | ConvertTo-Json -Compress)
    return $result
  } finally { $process.Dispose() }
}

function Read-CodexMcpStatus([string]$Codex, [hashtable]$Environment) {
  # The actual native host loads setup's TOML and creates the MCP process.
  # No model turn, credentials, or command-line rewriting.
  $arguments = @("app-server")
  if ($HostedProcessCreation) {
    # Pass only the existing backend-creation seam through Codex's env allowlist.
    # The generated MCP command, args and runtime selections stay untouched.
    $arguments += @("-c", 'mcp_servers.symphony_plus_plus.env_vars=["SYMPP_POWERSHELL","SYMPP_TEST_REAL_POWERSHELL","SYMPP_TEST_BACKEND_PRELOAD","SYMPP_LAUNCHER_TRACE_DIR"]')
  }
  $process = Start-IsolatedProcess $Codex $arguments $Environment
  $stderr = $process.StandardError.ReadToEndAsync()
  try {
    foreach ($request in @(
      @{ id = 1; method = "initialize"; params = @{ clientInfo = @{ name = "sympp-registration-test"; version = "1" }; capabilities = @{ experimentalApi = $true } } },
      @{ id = 2; method = "mcpServerStatus/list"; params = @{} }
    )) {
      $process.StandardInput.WriteLine(($request | ConvertTo-Json -Depth 10 -Compress))
      $process.StandardInput.Flush()
      do {
        $line = $process.StandardOutput.ReadLineAsync()
        if (-not $line.Wait(360000) -or $null -eq $line.Result) { throw "Native Codex closed or timed out: $($request.method)" }
        $response = $line.Result | ConvertFrom-Json
      } while ($response.id -ne $request.id)
      if ($response.error) { throw "Native Codex request failed: $($line.Result)" }
    }
    $server = @($response.result.data | Where-Object name -eq 'symphony_plus_plus')[0]
    Write-Host ("Native Codex MCP status: " + (@{ name = $server.name; server_info = $server.serverInfo; tools_count = @($server.tools.PSObject.Properties).Count; tools_error = $server.toolsError; health_discovered = [bool]$server.tools.'sympp.health' } | ConvertTo-Json -Depth 6 -Compress))
    return $server
  } finally {
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(30000)) { $process.Kill($true); $process.WaitForExit() }
    Write-Host ("Native Codex exit=$($process.ExitCode); stderr=" + $stderr.GetAwaiter().GetResult())
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
  Write-Host "MCP fixture: state=$($Environment.SYMPP_RUNTIME_FILE) create=$CreateMarker recover=$RecoverBackend"
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
    Write-Host "MCP initialize and tools/list succeeded."
    if ($SkillsInstall) {
      $health = Send-BridgeRequest $process @{ jsonrpc = "2.0"; id = 21; method = "tools/call"; params = @{ name = "sympp.health"; arguments = @{} } }
      Write-Host ("MCP sympp_health: " + ($health.result | ConvertTo-Json -Depth 16 -Compress))
      $identity = $health.result.structuredContent
      $healthPath = ([string]$identity.ledger.identity.display_path).Replace('$HOME', $Environment.USERPROFILE).Replace('/', '\')
      if ($identity.status -ne 'ok' -or $identity.source.revision -ne $manifest.source_revision -or
          [IO.Path]::GetFullPath($healthPath) -ine [IO.Path]::GetFullPath($Environment.SYMPP_DATABASE)) { throw 'MCP health did not confirm the selected verified runtime and ledger.' }
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
      [void](Send-BridgeRequest $process @{ jsonrpc = "2.0"; id = 6; method = "tools/list"; params = @{} })
    }
    if ($MarkerSessionId) {
      $marker = Send-BridgeRequest $process @{ jsonrpc = "2.0"; id = 5; method = "tools/call"; params = @{ name = "solo_show"; arguments = @{ session_id = $MarkerSessionId } } }
      if (@($marker.result.structuredContent.entries | Where-Object { $_.title -eq "packaged database persistence marker" }).Count -ne 1) { throw "MCP persistence marker was missing or duplicated." }
    }
    $activeState = Get-Content -LiteralPath $Environment.SYMPP_RUNTIME_FILE -Raw | ConvertFrom-Json
    $activeBackend = Get-Process -Id ([int]$activeState.backend.pid) -ErrorAction Stop
    $activeBackendStartTicks = $activeBackend.StartTime.ToUniversalTime().Ticks
    $script:backendProcessId = $activeBackend.Id
    $script:backendStartTicks = $activeBackendStartTicks
    if ($OnAttached) { & $OnAttached $activeState $MarkerSessionId }
    $activeState = Get-Content -LiteralPath $Environment.SYMPP_RUNTIME_FILE -Raw | ConvertFrom-Json
    $activeBackend = Get-Process -Id ([int]$activeState.backend.pid) -ErrorAction Stop
    $activeBackendStartTicks = $activeBackend.StartTime.ToUniversalTime().Ticks
    $script:backendProcessId = $activeBackend.Id
    $script:backendStartTicks = $activeBackendStartTicks
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
    Write-Host "MCP fixture exit: $($process.ExitCode)"
    Get-ChildItem -LiteralPath (Join-Path $Environment.SYMPP_HOME 'logs') -Filter 'beta-install-*' -File -ErrorAction SilentlyContinue |
      ForEach-Object { Write-Host "Beta install startup log: $($_.Name)"; Get-Content -LiteralPath $_.FullName | Write-Host }
    if ($Environment.SYMPP_LAUNCHER_TRACE_DIR) {
      Get-ChildItem -LiteralPath $Environment.SYMPP_LAUNCHER_TRACE_DIR -File | ForEach-Object { Get-Content -LiteralPath $_.FullName -Tail 20 | Write-Host }
    }
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
  if ($ArtifactManifest -or $SkillsInstall) {
    if ($SkillsInstall) {
      $installedRoot = [IO.Path]::GetFullPath($SkillsInstall)
      $install = Get-Content -LiteralPath (Join-Path $installedRoot ".sympp-install.json") -Raw | ConvertFrom-Json
      if (-not $ArtifactManifest) { throw "Native Skills qualification requires a candidate artifact manifest." }
      $candidateManifest = Get-Content -LiteralPath $ArtifactManifest -Raw | ConvertFrom-Json
      $candidateManifest.artifact.file = Join-Path (Split-Path -Parent $ArtifactManifest) $candidateManifest.artifact.file
      $candidateManifest.artifact.relative_path = $candidateManifest.artifact.file
      $published = Invoke-RestMethod 'https://github.com/JJLiebig/symphony-plus-plus/releases/download/sympp-v2-beta-2-20261013/sympp-runtime-artifacts-beta.json'
      $publishedCompatible = $published.launcher_contract.mcp_contract_fingerprint -eq $install.contract_fingerprint
      $manifest = if ($publishedCompatible) { $published } else { $candidateManifest }
      if (-not $publishedCompatible) {
        Write-Host "Published runtime has an older MCP contract; qualifying candidate cold start, reuse, recovery and offline operation."
        Write-Host "Same-contract cross-revision refresh is unavailable without a compatible published baseline."
      }
      $floatingManifest = Join-Path $tempRoot "floating-channel.json"
      $manifest | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $floatingManifest
      @{ schema_version = 1; channels = @{ stable = @{ manifest = @{ path = $floatingManifest } }; beta = @{ manifest = @{ path = $floatingManifest } } } } |
        ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $installedRoot "assets/sympp-runtime-artifacts.json")
      @{ version = 1; skills = @{ 'symphony-plus-plus' = @{ source = 'JJLiebig/symphony-plus-plus'; sourceType = 'github'; ref = 'beta' } } } |
        ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $tempRoot 'skills-lock.json')
      $codexHome = Join-Path $tempRoot "selected codex home"
      New-Item -ItemType Directory -Path (Join-Path $tempRoot "profile") -Force | Out-Null
    } else {
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
    }
    $betaHome = if ($SkillsInstall) { Join-Path $tempRoot '.sympp-beta' } else { Join-Path $tempRoot 'runtime-home' }
    $database = if ($SkillsInstall) { Join-Path $betaHome 'explicit ledger.sqlite3' } else { Join-Path $tempRoot 'database/explicit ledger.sqlite3' }
    $environment = @{
      SYMPP_RUNTIME_CHANNEL = "beta"; CODEX_HOME = $codexHome; SYMPP_HOME = $betaHome; SYMPP_RUNTIME_FILE = $runtimeFile
      SYMPP_DATABASE = $database; SYMPP_LOG_DIR = Join-Path $tempRoot "logs"; SYMPP_LAUNCHER_TRACE_DIR = Join-Path $tempRoot "trace"
      SYMPP_BACKEND_PORT = [string]$backendPort; SYMPP_DASHBOARD_PORT = [string]$backendPort; SYMPP_OPEN_DASHBOARD = "0"
      SYMPP_BACKEND_STARTUP_TIMEOUT_SEC = "120"; SYMPP_COLD_START_TIMEOUT_SEC = "180"
      HOME = Join-Path $tempRoot "profile"; USERPROFILE = Join-Path $tempRoot "profile"
      HOMEDRIVE = [IO.Path]::GetPathRoot($tempRoot).TrimEnd('\'); HOMEPATH = (Join-Path $tempRoot "profile").Substring(2)
      TEMP = Join-Path $tempRoot "tmp"; TMP = Join-Path $tempRoot "tmp"
    }
    $command = Join-Path $installedRoot "scripts/start-sympp-mcp.cmd"
    if ($HostedProcessCreation) {
      $shim = Join-Path $tempRoot "hosted-powershell.exe"
      $compiler = Join-Path $env:WINDIR "Microsoft.NET/Framework64/v4.0.30319/csc.exe"
      & $compiler /nologo /target:exe "/out:$shim" (Join-Path $PSScriptRoot "hosted-powershell.cs")
      if ($LASTEXITCODE -ne 0) { throw "Hosted PowerShell fixture compilation failed." }
      $environment.SYMPP_POWERSHELL = $shim
      $environment.SYMPP_TEST_REAL_POWERSHELL = (Get-Command pwsh -ErrorAction Stop).Source
      $environment.SYMPP_TEST_BACKEND_PRELOAD = Join-Path $PSScriptRoot "hosted-backend-preload.ps1"
      if ($SkillsInstall) {
        # Exercise native basename lookup, including cold start and cleanup.
        # The project copy fails if the bridge searches the workspace first.
        $trustedBin = Join-Path $tempRoot 'trusted-bin'
        New-Item -ItemType Directory -Path $trustedBin | Out-Null
        Copy-Item $shim (Join-Path $trustedBin 'pwsh.exe')
        Copy-Item $shim (Join-Path $tempRoot 'pwsh.exe')
        New-Item -ItemType File -Path (Join-Path $tempRoot 'untrusted-project') | Out-Null
        $environment.PATH = "$trustedBin;$env:PATH"
        $environment.SYMPP_POWERSHELL = 'pwsh.exe'
      }
    }
    $cmd = (Get-Command cmd.exe -ErrorAction Stop).Source
    $commandArgs = @("/d", "/c", "call `"$command`"")
    if ($SkillsInstall) {
      $codex = (Get-Command codex.exe -ErrorAction Stop).Source
      $node = (Get-Command node.exe -ErrorAction Stop).Source
      $setup = Join-Path $installedRoot "scripts/setup-sympp.js"
      if (Test-Path -LiteralPath $codexHome) { throw "Selected CODEX_HOME must genuinely not exist before setup." }
      $missing = Read-IsolatedCommand $codex @("mcp", "list", "--json") $environment
      if ($missing.exit -eq 0 -or $missing.stderr -notmatch 'does not exist') { throw "Native host did not reproduce the missing-home precondition." }
      $setupResult = Read-IsolatedCommand $node @($setup, "--host", "both") $environment
      if ($setupResult.exit -ne 0) { throw 'Setup failed from a nonexistent selected home.' }
      $configFile = Join-Path $codexHome 'config.toml'
      $unrelated = "model = `"example-model`"`n"
      $saved = $unrelated + (Get-Content -LiteralPath $configFile -Raw)
      [IO.File]::WriteAllText($configFile, $saved)
      $claudeFile = Join-Path $tempRoot '.mcp.json'
      $savedClaude = Get-Content -LiteralPath $claudeFile -Raw
      $repeated = Read-IsolatedCommand $node @($setup, '--host', 'both') $environment
      if ($repeated.exit -ne 0 -or (Get-Content $configFile -Raw) -cne $saved -or
          (Get-Content $claudeFile -Raw) -cne $savedClaude) { throw 'Repeat setup changed unrelated or already managed configuration.' }
      $listed = Read-IsolatedCommand $codex @("mcp", "list", "--json") $environment
      if ($listed.exit -ne 0) { throw 'Native Codex could not read setup registration.' }
      $registration = @(($listed.stdout | ConvertFrom-Json) | Where-Object name -eq 'symphony_plus_plus')[0]
      $claude = (Get-Content (Join-Path $tempRoot '.mcp.json') -Raw | ConvertFrom-Json).mcpServers.symphony_plus_plus
      Write-Host ("Generated Codex registration: " + ($registration | ConvertTo-Json -Depth 10 -Compress))
      Write-Host ("Generated Claude registration: " + ($claude | ConvertTo-Json -Depth 10 -Compress))
      if ($registration.transport.command -cne $claude.command -or
          (ConvertTo-Json -InputObject @($registration.transport.args) -Compress) -cne (ConvertTo-Json -InputObject @($claude.args) -Compress)) { throw 'Host registrations selected different commands or arguments.' }
      if (Test-Path -LiteralPath $database) { throw 'Generated registration qualification requires a fresh ledger.' }
      $native = Read-CodexMcpStatus $codex $environment
      if (-not $native.tools.'sympp.health') { throw 'Native Codex failed to initialize the generated registration and discover sympp_health.' }
      $cmd = $claude.command
      $commandArgs = @($claude.args)
      foreach ($property in $claude.env.PSObject.Properties) { $environment[$property.Name] = [string]$property.Value }
    }
    $assertLedger = {
      param($activeState, $sessionId)
      $readiness = Invoke-RestMethod ($activeState.backend.url + "/mcp/readiness")
      $actualPath = ([string]$readiness.ledger.identity.display_path).Replace('$HOME', $environment.USERPROFILE).Replace('/', '\')
      if ($readiness.ledger.identity.kind -ne "sqlite" -or [IO.Path]::GetFullPath($actualPath) -ine [IO.Path]::GetFullPath($database)) { throw "Packaged runtime ledger identity '$($readiness.ledger.identity.display_path)' did not match '$database'." }
      if ($activeState.runtime_mode -ne "artifact" -or $readiness.source.revision -ne $manifest.source_revision) { throw "Packaged runtime source identity mismatch." }
      if ($SkillsInstall -and ($activeState.plugin_root -ne $installedRoot -or (Test-Path (Join-Path $environment.USERPROFILE ".codex")))) { throw "Portable launch depended on a Codex cache or the source checkout." }
    }
    $first = Invoke-McpBridge $cmd $commandArgs $environment -CreateMarker -OnAttached {
      param($activeState, $sessionId)
      & $assertLedger $activeState $sessionId
      $second = Invoke-McpBridge $cmd $commandArgs $environment -MarkerSessionId $sessionId -OnAttached $assertLedger
      if ($second.backend_pid -ne $activeState.backend.pid) { throw "Warm client did not share the packaged backend." }
      if ($SkillsInstall) {
        $foreign = $environment.Clone()
        $foreign.SYMPP_HOME = Join-Path $tempRoot "other-home"
        $foreign.SYMPP_RUNTIME_FILE = Join-Path $tempRoot "other-home/runtime.json"
        $foreign.SYMPP_BACKEND_PORT = [string](New-IsolatedPort @($backendPort))
        $foreign.SYMPP_DASHBOARD_PORT = $foreign.SYMPP_BACKEND_PORT
        $isolated = $foreign.Clone()
        $isolated.SYMPP_DATABASE = Join-Path $tempRoot "database/second ledger.sqlite3"
        $independent = Invoke-McpBridge $cmd $commandArgs $isolated
        Wait-ManagedRuntimeStopped $independent.backend_pid $independent.backend_port
        if ($independent.backend_pid -eq $activeState.backend.pid) { throw "Separate ledger attached to the original runtime." }
        $script:backendProcessId = [int]$activeState.backend.pid
        $script:backendStartTicks = (Get-Process -Id $script:backendProcessId).StartTime.ToUniversalTime().Ticks
        foreach ($expectedError in @("already owned by another", "already in use")) {
          if ($expectedError -eq "already in use") {
            # An older launcher has no portable receipt; its real SQLite handle must still exclude a new owner.
            Remove-Item -LiteralPath "$database.sympp-owner.json"
          }
          $refused = Start-IsolatedProcess $cmd $commandArgs $foreign
          try {
            $errorText = $refused.StandardError.ReadToEndAsync()
            if (-not $refused.WaitForExit(60000)) { $refused.Kill($true); throw "Competing ledger home did not refuse startup." }
            $actualError = $errorText.GetAwaiter().GetResult()
            if ($refused.ExitCode -eq 0 -or $actualError -notmatch $expectedError) { throw "Competing owner expected '$expectedError'; exit=$($refused.ExitCode), stderr=$actualError" }
          } finally { $refused.Dispose() }
        }
        [void](Send-BridgeRequest $process @{ jsonrpc = "2.0"; id = 20; method = "tools/list"; params = @{} })
      }
    }
    Wait-ManagedRuntimeStopped $first.backend_pid $first.backend_port
    if ($SkillsInstall) {
      # The owning install and MCP contract stay unchanged while its branch publishes new runtime bytes.
      $beforeIdentity = Get-ChildItem -LiteralPath (Join-Path $environment.SYMPP_HOME 'runtime/launcher-validation') -Filter *.json | Get-Content -Raw | ConvertFrom-Json
      if ($beforeIdentity.revision -ne $manifest.source_revision) { throw "Cold identity did not record the initial actual runtime." }
      $manifest = $candidateManifest
      $candidateManifest | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $floatingManifest
    }
    $secondWave = Invoke-McpBridge $cmd $commandArgs $environment -MarkerSessionId $first.marker_session_id -RecoverBackend -OnAttached {
      param($activeState, $sessionId)
      & $assertLedger $activeState $sessionId
      if ($SkillsInstall) {
        Invoke-BetaInstallQualification $environment $process $candidateManifest
        $persisted = Send-BridgeRequest $process @{ jsonrpc = '2.0'; id = 82; method = 'tools/call'; params = @{ name = 'solo_show'; arguments = @{ session_id = $sessionId } } }
        if (@($persisted.result.structuredContent.entries | Where-Object title -eq 'packaged database persistence marker').Count -ne 1) {
          throw 'Beta install or rollback lost or duplicated the existing ledger marker.'
        }
      }
    }
    Wait-ManagedRuntimeStopped $secondWave.backend_pid $secondWave.backend_port
    $trace = Get-ChildItem -LiteralPath $environment.SYMPP_LAUNCHER_TRACE_DIR -File | Get-Content -Raw
    if ($SkillsInstall) {
      if ($trace -match "prepared_runtime_start") { throw "Floating channel incorrectly reused a stopped prepared release." }
      $afterIdentity = Get-ChildItem -LiteralPath (Join-Path $environment.SYMPP_HOME 'runtime/launcher-validation') -Filter *.json | Get-Content -Raw | ConvertFrom-Json
      if ($afterIdentity.revision -ne $candidateManifest.source_revision -or $afterIdentity.generation_key -ne $beforeIdentity.generation_key) { throw "Cold refresh did not preserve content identity and adopt candidate runtime provenance." }
      if (-not (Get-ChildItem -LiteralPath (Join-Path $environment.SYMPP_HOME 'runtime/launcher-cleanup') -Directory | Where-Object Name -Like "$($candidateManifest.source_revision)-*")) { throw "Cleanup snapshot did not adopt candidate runtime identity." }
    } elseif (-not ($trace -match "prepared_runtime_start")) { throw "Second wave did not exercise prepared release restart." }
    if (-not ($trace -match "backend_recovery_leader")) { throw "Second wave did not exercise backend recovery." }
    if (-not (Test-Path -LiteralPath $database -PathType Leaf)) { throw "Explicit packaged database was not created." }
    if (Test-Path -LiteralPath (Join-Path $environment.USERPROFILE ".agents/splusplus/symphony_plus_plus.sqlite3")) { throw "Packaged runtime used the default database." }
    if ($SkillsInstall) {
      $offlineEnvironment = $environment.Clone()
      if ($HostedProcessCreation) {
        # The executable-shadow fixture belongs to the MCP startup checks above.
        Remove-Item -LiteralPath (Join-Path $tempRoot 'pwsh.exe'), (Join-Path $tempRoot 'untrusted-project')
        $offlineEnvironment.PATH = $env:PATH
      }
      $offlineEnvironment.SYMPP_OFFLINE_SKILL = $installedRoot
      $offlineEnvironment.SYMPP_OFFLINE_ARTIFACT = $first.artifact_root
      $offlineEnvironment.SYMPP_OFFLINE_REVISION = $manifest.source_revision
      Invoke-IsolatedCommand (Get-Command python -ErrorAction Stop).Source @((Join-Path $repoRoot "scripts/tests/test_sympp_beta_snapshot.py"), "InstalledSnapshotTest") $offlineEnvironment
    }
    [pscustomobject]@{ artifact_revision = $manifest.source_revision; explicit_database_with_spaces = $true; warm_singleton = $true; prepared_restart = -not [bool]$SkillsInstall; floating_channel_refresh = [bool]$SkillsInstall; recovery = $true; mcp_marker_persisted = $true; listeners_closed = $true; hosted_process_creation_seam = [bool]$HostedProcessCreation; native_desktop_qualified = -not $HostedProcessCreation } | ConvertTo-Json -Compress
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
  $firstWave = Invoke-McpBridge $cmd @("/d", "/c", "call `"$installedCommand`"") $installedEnvironment
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
  $secondWave = Invoke-McpBridge $cmd @("/d", "/c", "call `"$installedCommand`"") $laterInstalledEnvironment
  $backendProcessId = $secondWave.backend_pid
  $backendStartTicks = $secondWave.backend_start_ticks
  if ($backendProcessId -eq $firstBackendProcessId) { throw "Later installed command wave reused backend pid=$backendProcessId." }
  if ($secondWave.backend_port -in @(19998, 19999)) { throw "Explicit dynamic launch used reserved port $($secondWave.backend_port)." }
  $artifactCacheRoot = [System.IO.Path]::GetFullPath((Join-Path $sourceEnvironment.SYMPP_HOME "rt"))
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
  $sourceRecovery = Invoke-McpBridge $pwsh @("-NoProfile", "-File", $launcher) $sourceEnvironment -RecoverBackend
  if ($sourceRecovery.backend_pid -eq $sourceProcessId) { throw "Source backend recovery did not replace the backend." }
  Wait-ManagedRuntimeStopped $sourceRecovery.backend_pid $backendPort
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
  if (($ArtifactManifest -or $SkillsInstall) -and (Test-Path -LiteralPath $runtimeFile)) {
    $ownedState = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
    $ownedBackend = if ([int]$ownedState.backend.pid -gt 0) { Get-Process -Id ([int]$ownedState.backend.pid) -ErrorAction SilentlyContinue } else { $null }
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
  if (-not ([System.IO.Path]::GetFullPath($tempRoot).StartsWith($ownedRoot, [StringComparison]::OrdinalIgnoreCase))) { throw "Cleanup abort: temp root escaped the system temp directory." }
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
