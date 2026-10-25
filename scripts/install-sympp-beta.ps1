[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$SymppHome,
  [Parameter(Mandatory)][string]$HerdrAppHome,
  [string]$ArtifactManifest = 'https://github.com/JJLiebig/symphony-plus-plus/releases/download/sympp-runtime-beta/sympp-runtime-artifacts-beta.json'
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Beta installation requires PowerShell 7 on Windows.' }
$repoRoot = Split-Path -Parent $PSScriptRoot
$helpers = Join-Path $repoRoot 'plugins/symphony-plus-plus-mcp/scripts'
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
  # A beta-looking alias must never redirect installation into a production home.
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
    throw 'The beta database, runtime and artifact cache must stay inside the selected beta home.'
  }
}

function Write-InstallJson([string]$Path, $Value) {
  $temporary = "$Path.$PID.tmp"
  try {
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 30), [Text.UTF8Encoding]::new($false))
    [IO.File]::Move($temporary, $Path, $true)
  } finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}

function Assert-FactoryReady($State, [string]$Revision, [string]$Contract) {
  $health = Invoke-RestMethod "$($State.backend.url)/mcp/readiness" -TimeoutSec 10
  $identityPath = ([string]$health.ledger.identity.display_path).Replace('$HOME', $env:USERPROFILE)
  if ($health.status -ne 'ok' -or $health.ledger.reachable -ne $true -or $health.dashboard.ready -ne $true -or
      $health.source.revision -ne $Revision -or $health.source.mcp_contract.fingerprint -ne $Contract -or
      $health.ledger.identity.kind -ne 'sqlite' -or [IO.Path]::GetFullPath($identityPath) -ine $database) {
    throw 'Beta readiness did not match the expected revision, MCP contract, dashboard and ledger.'
  }
}

function Stop-InstallBackend($State) {
  $backend = Get-Process -Id ([int]$State.backend.pid) -ErrorAction SilentlyContinue
  if (-not $backend) { return }
  Assert-InHome ([string]$State.artifact.root) $SymppHome
  if (-not $backend.Path.StartsWith(([IO.Path]::GetFullPath($State.artifact.root).TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase) -or
      (Get-ProcessStartIdentity $backend) -ne [string]$State.publication.backend.process_start_time_utc_ticks) {
    throw 'The recorded beta process identity changed. Refusing to stop it.'
  }
  $backend.Kill()
  if (-not $backend.WaitForExit(10000)) { throw 'The beta backend did not stop.' }
}

function Start-InstallBackend {
  $powershell = if ($env:SYMPP_POWERSHELL) { $env:SYMPP_POWERSHELL } else { 'pwsh' }
  & $powershell -NoProfile -NonInteractive -File $launcher -PrepareRuntimeOnly
  if ($LASTEXITCODE -ne 0) { throw "Beta startup failed (exit $LASTEXITCODE)." }
}

$SymppHome = Assert-InstallPath $SymppHome
$HerdrAppHome = Assert-InstallPath $HerdrAppHome
foreach ($path in @('mods/sympp', 'tools', 'data/sympp-requests')) {
  [void](Assert-InstallPath (Join-Path $HerdrAppHome $path))
}
$profileHome = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
if ((Split-Path -Leaf $SymppHome) -notmatch '(^|[._-])beta($|[._-])' -or
    $SymppHome.StartsWith((Join-Path $profileHome '.agents/splusplus').Replace('/', '\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $SymppHome -ieq (Join-Path $profileHome '.agents/splusplus')) {
  throw 'Choose an explicitly beta home, separate from the default production home.'
}
$runtimeFile = Join-Path $SymppHome 'runtime/codex-plugin.json'
$originalText = Get-Content -LiteralPath $runtimeFile -Raw
$original = $originalText | ConvertFrom-Json
$pluginRoot = Assert-InstallPath ([string]$original.plugin_root)
if ($pluginRoot -match '(?i)[\\/]plugins[\\/]cache[\\/]' -or
    $pluginRoot.StartsWith((Join-Path $profileHome '.agents/skills').Replace('/', '\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Beta installation cannot change a marketplace cache or a global Skills installation.'
}
$install = Read-SymppPortableInstall $pluginRoot
if (-not $install) { throw 'This command requires an existing beta portable Skills factory.' }
$selectedChannel = & node -e 'process.stdout.write(require(process.argv[1]).runtimeChannel())' (Join-Path $pluginRoot 'scripts/setup-sympp.js')
if ($LASTEXITCODE -ne 0 -or $selectedChannel -ne 'beta') { throw 'The selected factory must belong to a beta Skills installation.' }
$database = [IO.Path]::GetFullPath([string]$original.publication.controls.database)
Assert-InHome $database $SymppHome
Assert-InHome ([string]$original.artifact.root) $SymppHome
$origin = [Uri]$original.backend.url
if ($original.runtime_mode -ne 'artifact' -or $original.backend.managed -ne $true -or
    $original.frontend.status -ne 'artifact_static' -or $original.publication.controls.offline_sandbox -eq $true -or
    $origin.Scheme -ne 'http' -or -not $origin.IsLoopback -or $origin.Port -in @(19998, 19999) -or
    $origin.AbsolutePath -ne '/' -or $origin.Query -or $origin.UserInfo -or $origin.Fragment) {
  throw 'Select a managed beta artifact factory with its own loopback port and live beta ledger.'
}
$launcher = Join-Path $pluginRoot 'scripts/start-sympp-mcp.ps1'
$pinFile = Join-Path $pluginRoot '.sympp-runtime-artifacts.json'
[void](Assert-InstallPath $pinFile)
Assert-InHome $runtimeFile $SymppHome
$stage = Join-Path $SymppHome ('runtime/beta-install-' + [guid]::NewGuid().ToString('N'))
$savedEnvironment = @{}
foreach ($item in Get-ChildItem Env:SYMPP_*) { $savedEnvironment[$item.Name] = $item.Value }
$coldLock = $null
$startupLock = $null
try {
  foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $null) }
  # Retain the launcher's existing hosted process-creation seam for native CI.
  if ($env:GITHUB_ACTIONS -eq 'true') {
    foreach ($name in @('SYMPP_POWERSHELL', 'SYMPP_TEST_REAL_POWERSHELL', 'SYMPP_TEST_BACKEND_PRELOAD')) {
      if ($savedEnvironment.ContainsKey($name)) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name]) }
    }
  }
  $env:SYMPP_HOME = $SymppHome
  $env:SYMPP_RUNTIME_FILE = $runtimeFile
  $env:SYMPP_DATABASE = $database
  $env:SYMPP_LOG_DIR = Join-Path $SymppHome 'logs'
  $env:SYMPP_RUNTIME_CHANNEL = 'beta'
  $env:SYMPP_BACKEND_PORT = [string]$origin.Port
  if ($original.publication.controls.dashboard_port_explicit) { $env:SYMPP_DASHBOARD_PORT = [string]$original.publication.controls.dashboard_port }
  $env:SYMPP_OPEN_DASHBOARD = '0'
  $env:SYMPP_WORKFLOW_FILE = [string]$original.artifact.prepared_release.configured_workflow
  $coldLock = [IO.File]::Open("$runtimeFile.cold.lock", [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  New-Item -ItemType Directory -Path $stage | Out-Null
  Copy-Item -LiteralPath (Join-Path $pluginRoot '.sympp-install.json') -Destination $stage
  $manifest = (Read-SymppManifestReferenceContent $ArtifactManifest '') | ConvertFrom-Json
  if ((Get-JsonFirstPathValue $manifest @(@('channel'), @('release', 'channel'))) -ne 'beta') {
    throw 'The runtime manifest must explicitly declare the beta channel.'
  }
  $stagePin = Join-Path $stage '.sympp-runtime-artifacts.json'
  Write-InstallJson $stagePin $manifest
  $candidate = Resolve-SymppPreparedArtifactRuntime $stage $null $install.contract_fingerprint -ValidateOnly
  if ($candidate.status -ne 'artifact_selected') {
    throw 'No beta artifact matches the installed MCP contract. Update the beta Skills installation and setup first.'
  }
  Assert-InHome ([string]$candidate.runtime.root) $SymppHome
  $candidate = Resolve-SymppPreparedArtifactRuntime $stage $null $install.contract_fingerprint -ValidateOnly -PrepareArtifact
  $revision = [string]$candidate.runtime.source_revision
  if ($revision -notmatch '^[0-9a-f]{40}$') { throw 'The beta artifact has no valid source revision.' }
  $nativeInstaller = Join-Path $repoRoot 'integrations/herdr-next/install.mjs'
  # Finish native-file preflight before interrupting connected clients.
  & node $nativeInstaller --endpoint $origin.GetLeftPart([UriPartial]::Authority) --home (Join-Path $stage 'herdr')
  if ($LASTEXITCODE -ne 0) { throw 'The native view could not be prepared.' }
  $restart = $original.backend.source_revision -ne $revision -or $original.artifact.sha256 -ne $candidate.runtime.sha256
  if (-not $restart) {
    Assert-FactoryReady $original $revision $install.contract_fingerprint
    & node $nativeInstaller --endpoint $origin.GetLeftPart([UriPartial]::Authority) --home $HerdrAppHome --replace
    if ($LASTEXITCODE -ne 0) { throw 'The native view could not be installed; the beta backend is unchanged.' }
    Write-Host "Beta is current ($revision); backend unchanged."
    return
  }
  $previousRuntime = $original.artifact.prepared_release.runtime
  if (-not $previousRuntime) { throw 'The previous beta artifact has no prepared runtime for rollback.' }
  $marker = Get-Content -LiteralPath (Join-Path $original.artifact.root '.sympp-artifact.json') -Raw | ConvertFrom-Json
  $rollbackManifest = @{
    schema_version = 1; channel = 'beta'; source_revision = $original.backend.source_revision
    plugin = @{ name = $install.name; version = $install.version }
    artifacts = @(@{
      platform = $marker.platform; source_revision = $original.backend.source_revision
      mcp_contract_fingerprint = $install.contract_fingerprint
      path = Join-Path (Split-Path -Parent $original.artifact.root) 'artifact.zip'; sha256 = $marker.sha256
      entrypoint = $previousRuntime.entrypoint_relative; runtime_args = $previousRuntime.runtime_args
      dashboard = @{ asset_root = $marker.dashboard_root; fingerprint = $marker.dashboard_fingerprint }
    })
  }
  Write-InstallJson $stagePin $rollbackManifest
  $rollback = Resolve-SymppPreparedArtifactRuntime $stage $null $install.contract_fingerprint -ValidateOnly -PrepareArtifact
  if ($rollback.runtime.source_revision -ne $original.backend.source_revision) { throw 'The previous beta artifact is unavailable for rollback.' }
  $startupLock = Enter-FileLock (Resolve-StartupLockFile $runtimeFile) 10
  if ((Get-Content -LiteralPath $runtimeFile -Raw) -cne $originalText) { throw 'The beta factory changed during preparation; retry installation.' }
  Assert-FactoryReady $original $original.backend.source_revision $install.contract_fingerprint
  Write-Host 'Restarting beta. MCP clients reconnect on their next request; reload the client if it reports a connection error. Check an interrupted write before retrying it.'
  try {
    Stop-InstallBackend $original
    Write-InstallJson $pinFile $manifest
    $startupLock.Dispose(); $startupLock = $null
    Start-InstallBackend
    $updated = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
    Assert-FactoryReady $updated $revision $install.contract_fingerprint
    & node $nativeInstaller --endpoint $origin.GetLeftPart([UriPartial]::Authority) --home $HerdrAppHome --replace
    if ($LASTEXITCODE -ne 0) { throw 'The native view could not be installed.' }
  } catch {
    $failure = $_
    if ($startupLock) { $startupLock.Dispose(); $startupLock = $null }
    $startupLock = Enter-FileLock (Resolve-StartupLockFile $runtimeFile) 10
    Stop-InstallBackend (Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json)
    Write-InstallJson $pinFile $rollbackManifest
    Write-InstallJson $runtimeFile $original
    $startupLock.Dispose(); $startupLock = $null
    Start-InstallBackend
    $restored = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
    Assert-FactoryReady $restored $original.backend.source_revision $install.contract_fingerprint
    throw "Beta installation failed; the previous runtime is serving again. $($failure.Exception.Message)"
  }
  Write-Host "Beta ready ($revision). Native view installed."
} finally {
  if ($startupLock) { $startupLock.Dispose() }
  if ($coldLock) { $coldLock.Dispose(); Remove-Item -LiteralPath "$runtimeFile.cold.lock" -Force }
  if (Test-Path -LiteralPath $stage) {
    Assert-InHome $stage $SymppHome
    Remove-Item -LiteralPath $stage -Recurse -Force
  }
  foreach ($item in Get-ChildItem Env:SYMPP_*) { [Environment]::SetEnvironmentVariable($item.Name, $null) }
  foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name]) }
}
