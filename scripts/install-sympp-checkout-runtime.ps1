[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$SymppHome,
  [Parameter(Mandatory)][string]$HerdrAppHome,
  [Parameter(Mandatory)][string]$ArtifactManifest
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Checkout installation requires PowerShell 7 on Windows.' }
$repoRoot = Split-Path -Parent $PSScriptRoot
$helpers = Join-Path $repoRoot 'packages/sympp/scripts'
foreach ($name in @('sympp-launcher-runtime', 'sympp-mcp-launcher-helpers', 'sympp-mcp-artifact-manifest', 'sympp-mcp-artifact-channel', 'sympp-mcp-artifact-runtime')) {
  . (Join-Path $helpers "$name.ps1")
}
function Write-Diagnostic([string]$Message) { Write-Verbose $Message }

function Assert-InstallPath([string]$Path) {
  if (-not [IO.Path]::IsPathFullyQualified($Path)) { throw 'Choose explicit absolute installation paths.' }
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
  if ($full -match '(?i)[\\/](plugins[\\/]cache|\.tmp[\\/]marketplaces)([\\/]|$)') {
    throw 'Installation cannot touch a marketplace or plugin cache.'
  }
  # Install and rollback must address the selected physical paths.
  for ($part = $full; $part; $part = Split-Path -Parent $part) {
    if ((Test-Path -LiteralPath $part) -and
        (((Get-Item -LiteralPath $part -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -or
         (Get-Item -LiteralPath $part -Force).LinkType -eq 'HardLink')) {
      throw "Use the real installation path, without junctions or symbolic links: $Path"
    }
  }
  return $full
}

function Assert-InHome([string]$Path, [string]$Root) {
  $full = Assert-InstallPath $Path
  if (-not $full.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Keep checkout data and Skills within the selected installation root.'
  }
}

function Get-BundleInventory([string]$Root) {
  $pin = Join-Path $Root '.sympp-runtime-artifacts.json'
  Get-ChildItem -LiteralPath $Root -File -Recurse -Force | Where-Object { $_.FullName -ine $pin } | ForEach-Object {
    [void](Assert-InstallPath $_.FullName)
    [IO.Path]::GetRelativePath($Root, $_.FullName) + ' ' + (Get-FileSha256 $_.FullName)
  } | Sort-Object
}

function Write-InstallJson([string]$Path, $Value) {
  $json = $Value | ConvertTo-Json -Depth 30
  if ((Test-Path -LiteralPath $Path) -and (Get-Content -LiteralPath $Path -Raw) -ceq $json) { return }
  $temporary = "$Path.$PID.tmp"
  try {
    [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
    [IO.File]::Move($temporary, $Path, $true)
  } finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}

function Assert-FactoryReady($State, [string]$Revision, [string]$Contract) {
  $health = Invoke-RestMethod "$($State.backend.url)/mcp/readiness" -TimeoutSec 10
  $identityPath = ([string]$health.ledger.identity.display_path).Replace('$HOME', $env:USERPROFILE)
  if ($health.status -ne 'ok' -or $health.ledger.reachable -ne $true -or $health.dashboard.ready -ne $true -or
      $health.source.revision -ne $Revision -or $health.source.mcp_contract.fingerprint -ne $Contract -or
      $health.ledger.identity.kind -ne 'sqlite' -or [IO.Path]::GetFullPath($identityPath) -ine $database) {
    throw 'Checkout readiness did not match the expected revision, MCP contract, dashboard and ledger.'
  }
}

function Get-InstallBackend($State) {
  $processId = 0
  if (-not [int]::TryParse([string]$State.backend.pid, [ref]$processId) -or $processId -le 0) { return }
  $backend = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if (-not $backend) { return }
  Assert-InHome ([string]$State.artifact.root) $SymppHome
  if (-not $backend.Path.StartsWith(([IO.Path]::GetFullPath($State.artifact.root).TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase) -or
      (Get-ProcessStartIdentity $backend) -ne [string]$State.publication.backend.process_start_time_utc_ticks) {
    throw 'The recorded checkout process identity changed. Refusing to stop it.'
  }
  return $backend
}

function Stop-InstallBackend($State) {
  $backend = Get-InstallBackend $State
  if (-not $backend) { return }
  $backend.Kill()
  if (-not $backend.WaitForExit(10000)) { throw 'The checkout backend did not stop.' }
}

function Start-InstallBackend {
  $powershell = if ($env:SYMPP_POWERSHELL) { $env:SYMPP_POWERSHELL } else { 'pwsh' }
  New-Item -ItemType Directory -Force -Path $env:SYMPP_LOG_DIR | Out-Null
  $startupLog = Join-Path $env:SYMPP_LOG_DIR ('checkout-install-' + [guid]::NewGuid().ToString('N') + '.log')
  . (Join-Path $helpers 'sympp-windows-backend.ps1')
  $stdinFile = "$startupLog.in"
  [IO.File]::WriteAllBytes($stdinFile, [byte[]]@())
  $command = [pscustomobject]@{ file = $powershell; args = @('-NoProfile', '-NonInteractive', '-File', $launcher, '-PrepareRuntimeOnly') }
  $process = Start-SymppWindowsBackend $command $pluginRoot $stdinFile $startupLog "$startupLog.err"
  $null = $process.Handle
  try {
    # Waiting for pipe EOF also waits for the detached Windows backend.
    if (-not $process.WaitForExit(330000)) { $process.Kill($true); throw "Checkout startup timed out. See $startupLog.err" }
    if ($process.ExitCode -ne 0) { throw "Checkout startup failed (exit $($process.ExitCode)). See $startupLog.err" }
  } finally { $process.Dispose() }
}

$SymppHome = Assert-InstallPath $SymppHome
$HerdrAppHome = Assert-InstallPath $HerdrAppHome
foreach ($path in @('mods/sympp', 'tools', 'data/sympp-requests')) {
  [void](Assert-InstallPath (Join-Path $HerdrAppHome $path))
}
$runtimeFile = Join-Path $SymppHome 'runtime/codex-plugin.json'
$originalText = Get-Content -LiteralPath $runtimeFile -Raw
$original = $originalText | ConvertFrom-Json
$pluginRoot = Assert-InstallPath ([string]$original.plugin_root)
$originalInstall = Read-SymppPortableInstall $pluginRoot
if (-not $originalInstall) { throw 'This command requires an existing checkout portable Skills factory.' }
foreach ($dataHome in @($SymppHome, $HerdrAppHome)) {
  if ($dataHome -ieq $pluginRoot -or $dataHome.StartsWith($pluginRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Keep runtime and Herdr data homes separate from the managed Skills directory.'
  }
}
$originalContract = [string]$original.backend.contract_fingerprint
if ($originalContract -ne $originalInstall.contract_fingerprint) {
  throw 'A previous Skills update is incomplete. Close all checkout clients and reopen them before installing again.'
}
$bundleSource = Join-Path $repoRoot 'skills/sympp'
$install = Read-SymppPortableInstall $bundleSource
& node (Join-Path $repoRoot 'scripts/package-portable-skills.mjs') --check | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Regenerate the checkout portable Skills bundle before installing.' }
if (-not $install) { throw 'Regenerate the checkout portable Skills bundle before installing checkout.' }
$bundleChanged = @(Compare-Object @(Get-BundleInventory $bundleSource) @(Get-BundleInventory $pluginRoot)).Count -gt 0
$database = [IO.Path]::GetFullPath([string]$original.publication.controls.database)
Assert-InHome $database $SymppHome
Assert-InHome ([string]$original.artifact.root) $SymppHome
$origin = [Uri]$original.backend.url
if ($original.runtime_mode -ne 'artifact' -or $original.backend.managed -ne $true -or
    $original.frontend.status -ne 'artifact_static' -or $original.publication.controls.offline_sandbox -eq $true -or
    $origin.Scheme -ne 'http' -or -not $origin.IsLoopback -or
    $origin.AbsolutePath -ne '/' -or $origin.Query -or $origin.UserInfo -or $origin.Fragment) {
  throw 'Select a managed checkout artifact factory with its own loopback port and live checkout ledger.'
}
$launcher = Join-Path $pluginRoot 'scripts/start-sympp-mcp.ps1'
$pinFile = Join-Path $SymppHome 'runtime/checkout-artifacts.json'
$legacyPin = Join-Path $pluginRoot '.sympp-runtime-artifacts.json'
[void](Assert-InstallPath $pinFile)
Assert-InHome $runtimeFile $SymppHome
$nativeArgs = @('--factory', $runtimeFile)
$stage = Join-Path $SymppHome ('runtime/checkout-install-' + [guid]::NewGuid().ToString('N'))
$candidateBundle = Join-Path $stage 'bundle'
$bundleBackup = Join-Path $stage 'previous-skills'
$savedEnvironment = @{}
foreach ($item in Get-ChildItem Env:SYMPP_*) { $savedEnvironment[$item.Name] = $item.Value }
$coldLock = $null
$startupLock = $null
$completed = $false
try {
  foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $null) }
  # Retain the launcher's existing hosted process-creation seam for native CI.
  foreach ($name in @('SYMPP_POWERSHELL', 'SYMPP_TEST_REAL_POWERSHELL', 'SYMPP_TEST_BACKEND_PRELOAD')) {
    if ($savedEnvironment.ContainsKey($name)) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name]) }
  }
  $env:SYMPP_HOME = $SymppHome
  $env:SYMPP_RUNTIME_FILE = $runtimeFile
  $env:SYMPP_DATABASE = $database
  $env:SYMPP_LOG_DIR = Join-Path $SymppHome 'logs'
  $env:SYMPP_RUNTIME_CHANNEL = 'stable'
  $env:SYMPP_BACKEND_PORT = [string]$origin.Port
  if ($original.publication.controls.dashboard_port_explicit) { $env:SYMPP_DASHBOARD_PORT = [string]$original.publication.controls.dashboard_port }
  $env:SYMPP_OPEN_DASHBOARD = '0'
  $env:SYMPP_WORKFLOW_FILE = [string]$original.artifact.prepared_release.configured_workflow
  $coldLock = [IO.File]::Open("$runtimeFile.cold.lock", [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  New-Item -ItemType Directory -Path $stage | Out-Null
  Copy-Item -LiteralPath (Join-Path $pluginRoot '.sympp-install.json') -Destination $stage
  Copy-Item -LiteralPath $bundleSource -Destination $candidateBundle -Recurse
  $manifest = (Read-SymppManifestReferenceContent $ArtifactManifest '') | ConvertFrom-Json
  $manifest | Add-Member -NotePropertyName channel -NotePropertyValue 'stable' -Force
  $manifestLocation = Resolve-SymppManifestReferenceUri $manifest.manifest $ArtifactManifest
  if ($manifestLocation) { $manifest = Resolve-SymppPublishedArtifactManifest $manifest $ArtifactManifest }
  else { $manifestLocation = $ArtifactManifest }
  foreach ($artifact in @(Get-SymppArtifactCandidates $manifest)) {
    foreach ($container in @($artifact, $artifact.archive, $artifact.artifact)) {
      if ($null -eq $container) { continue }
      foreach ($name in @('url', 'download_url', 'uri', 'path', 'relative_path', 'file')) {
        if ($container.PSObject.Properties[$name] -and $container.$name) {
          $container.$name = Resolve-SymppManifestReferenceUri ([pscustomobject]@{ path = $container.$name }) $manifestLocation
        }
      }
    }
  }
  $stagePin = Join-Path $candidateBundle '.sympp-runtime-artifacts.json'
  Write-InstallJson $stagePin $manifest
  $candidate = Resolve-SymppPreparedArtifactRuntime $candidateBundle $null $install.contract_fingerprint -ValidateOnly
  if ($candidate.status -ne 'artifact_selected') {
    throw 'No checkout artifact matches the checkout Skills contract. Build a runtime matching the Skills contract.'
  }
  Assert-InHome ([string]$candidate.runtime.root) $SymppHome
  $candidate = Resolve-SymppPreparedArtifactRuntime $candidateBundle $null $install.contract_fingerprint -ValidateOnly -PrepareArtifact
  $revision = [string]$candidate.runtime.source_revision
  if ($revision -notmatch '^[0-9a-f]{40}$') { throw 'The checkout artifact has no valid source revision.' }
  $manifest | Add-Member -NotePropertyName factory_plugin_root -NotePropertyValue $pluginRoot -Force
  if (-not $manifest.checkout) { throw 'A checkout manifest must record its revision and dirty state.' }
  $manifest.checkout | Add-Member -NotePropertyName skills_hash -NotePropertyValue (Get-SymppSkillsBundleHash $candidateBundle) -Force
  $manifest.artifacts[0].path = Join-Path $candidate.cache_root 'artifact.zip'
  $nativeInstaller = Join-Path $repoRoot 'integrations/herdr-next/install.mjs'
  # Finish native-file preflight before interrupting connected clients.
  & node $nativeInstaller --endpoint $origin.GetLeftPart([UriPartial]::Authority) --home (Join-Path $stage 'herdr') | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'The native view could not be prepared.' }
  $restart = $bundleChanged -or $original.backend.source_revision -ne $revision -or $original.artifact.sha256 -ne $candidate.runtime.sha256
  $startupLock = Enter-FileLock (Resolve-StartupLockFile $runtimeFile) 10
  if ((Get-Content -LiteralPath $runtimeFile -Raw) -cne $originalText) { throw 'The checkout factory changed during preparation; retry installation.' }
  $backendRunning = $null -ne (Get-InstallBackend $original)
  if (-not $restart -and $backendRunning) {
    Assert-FactoryReady $original $revision $install.contract_fingerprint
    & node $nativeInstaller --endpoint $origin.GetLeftPart([UriPartial]::Authority) --home $HerdrAppHome --replace @nativeArgs | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'The native view could not be installed; the checkout backend is unchanged.' }
    Write-InstallJson $pinFile $manifest
    if ((Test-Path -LiteralPath $legacyPin)) { Remove-Item -LiteralPath $legacyPin -Force }
    Write-Host "Factory is current ($revision); backend unchanged."
    return
  }
  $previousRuntime = $original.artifact.prepared_release.runtime
  if (-not $previousRuntime) { throw 'The previous checkout artifact has no prepared runtime for rollback.' }
  $marker = Get-Content -LiteralPath (Join-Path $original.artifact.root '.sympp-artifact.json') -Raw | ConvertFrom-Json
  $rollbackManifest = @{
    schema_version = 1; channel = 'stable'; source_revision = $original.backend.source_revision
    plugin = @{ name = $originalInstall.name; version = $originalInstall.version }
    artifacts = @(@{
      platform = $marker.platform; source_revision = $original.backend.source_revision
      mcp_contract_fingerprint = $originalContract
      path = Join-Path (Split-Path -Parent $original.artifact.root) 'artifact.zip'; sha256 = $marker.sha256
      entrypoint = $previousRuntime.entrypoint_relative; runtime_args = $previousRuntime.runtime_args
      dashboard = @{ asset_root = $marker.dashboard_root; fingerprint = $marker.dashboard_fingerprint }
    })
  }
  if (Test-Path -LiteralPath $pinFile) {
    $previousPin = Get-Content -LiteralPath $pinFile -Raw | ConvertFrom-Json
    if ($previousPin.checkout) { $rollbackManifest.checkout = $previousPin.checkout }
  }
  Write-InstallJson (Join-Path $stage '.sympp-runtime-artifacts.json') $rollbackManifest
  $rollback = Resolve-SymppPreparedArtifactRuntime $stage $null $originalContract -ValidateOnly -PrepareArtifact
  if ($rollback.runtime.source_revision -ne $original.backend.source_revision) { throw 'The previous checkout artifact is unavailable for rollback.' }
  if ($backendRunning) { Assert-FactoryReady $original $original.backend.source_revision $originalContract }
  if ($bundleChanged -or $originalContract -ne $install.contract_fingerprint) {
    Write-Host 'Skills or MCP contract changed. Open fresh sessions to see the update.'
  }
  if (-not $backendRunning) { Write-Host 'Starting the factory.' }
  else { Write-Host 'Restarting the factory. MCP clients reconnect on their next request. Check an interrupted write before retrying it.' }
  try {
    if ($backendRunning) { Stop-InstallBackend $original }
    if ($bundleChanged) {
      Assert-InHome $bundleBackup $SymppHome
      Remove-Item -LiteralPath $stagePin -Force
      Move-Item -LiteralPath $pluginRoot -Destination $bundleBackup
      Move-Item -LiteralPath $candidateBundle -Destination $pluginRoot
    }
    Write-InstallJson $pinFile $manifest
    $startupLock.Dispose(); $startupLock = $null
    Start-InstallBackend
    $updated = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
    Assert-FactoryReady $updated $revision $install.contract_fingerprint
    & node $nativeInstaller --endpoint $origin.GetLeftPart([UriPartial]::Authority) --home $HerdrAppHome --replace @nativeArgs | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'The native view could not be installed.' }
  } catch {
    $failure = $_
    if ($startupLock) { $startupLock.Dispose(); $startupLock = $null }
    $startupLock = Enter-FileLock (Resolve-StartupLockFile $runtimeFile) 10
    Stop-InstallBackend (Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json)
    if (Test-Path -LiteralPath $bundleBackup) {
      Assert-InHome $bundleBackup $SymppHome
      if (Test-Path -LiteralPath $pluginRoot) { Remove-Item -LiteralPath $pluginRoot -Recurse -Force }
      Move-Item -LiteralPath $bundleBackup -Destination $pluginRoot
    }
    $rollbackManifest.factory_plugin_root = $pluginRoot
    if (-not $rollbackManifest.checkout) { $rollbackManifest.checkout = [pscustomobject]@{ revision = $original.backend.source_revision } }
    $rollbackManifest.checkout | Add-Member -NotePropertyName skills_hash -NotePropertyValue (Get-SymppSkillsBundleHash $pluginRoot) -Force
    Write-InstallJson $pinFile $rollbackManifest
    Write-InstallJson $legacyPin $rollbackManifest
    Write-InstallJson $runtimeFile $original
    $startupLock.Dispose(); $startupLock = $null
    Start-InstallBackend
    $restored = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
    Assert-FactoryReady $restored $original.backend.source_revision $originalContract
    throw "Checkout installation failed; the previous runtime is serving again. $($failure.Exception.Message)"
  }
  if ((Test-Path -LiteralPath $legacyPin)) { Remove-Item -LiteralPath $legacyPin -Force }
  $completed = $true
  Write-Host "Factory ready ($revision). Native view installed."
} finally {
  if ($startupLock) { $startupLock.Dispose() }
  if ($coldLock) { $coldLock.Dispose(); Remove-Item -LiteralPath "$runtimeFile.cold.lock" -Force }
  if (Test-Path -LiteralPath $stage) {
    Assert-InHome $stage $SymppHome
    if (-not $completed -and (Test-Path -LiteralPath $bundleBackup)) {
      Write-Warning "Checkout rollback could not finish. Previous Skills are retained at $bundleBackup."
    } else {
      Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
      if (Test-Path -LiteralPath $stage) { Write-Warning "Checkout temporary files are retained at $stage." }
    }
  }
  foreach ($item in Get-ChildItem Env:SYMPP_*) { [Environment]::SetEnvironmentVariable($item.Name, $null) }
  foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name]) }
}
