# Extends the owning installed-runtime journey with connected bridges and real releases.
function Get-BetaInstallerEntry {
  $installer = Join-Path $repoRoot 'scripts/install-sympp-beta.ps1'
  if ($HostedProcessCreation) {
    $wrapper = Join-Path $tempRoot 'beta-install-hosted.ps1'
    $preload = (Join-Path $PSScriptRoot 'hosted-backend-preload.ps1').Replace("'", "''")
    $entrypoint = $installer.Replace("'", "''")
    [IO.File]::WriteAllText($wrapper, "param([string]`$SymppHome, [string]`$HerdrAppHome, [string]`$ArtifactManifest)`n`$ErrorActionPreference = 'Stop'`n. '$preload'`n& '$entrypoint' @PSBoundParameters`nexit `$LASTEXITCODE`n")
    $installer = $wrapper
  }
  return $installer
}

function Invoke-BetaInstallQualification([hashtable]$Environment, $Bridge, $CandidateManifest) {
  $installer = Get-BetaInstallerEntry
  $pwsh = (Get-Command pwsh -ErrorAction Stop).Source
  $nativeHome = Join-Path $tempRoot 'native home'
  $channelFile = Join-Path $tempRoot 'install-beta.json'
  $archive = Join-Path $tempRoot 'install-beta.zip'
  $state = Get-Content -LiteralPath $Environment.SYMPP_RUNTIME_FILE -Raw | ConvertFrom-Json
  $oldPid = [int]$state.backend.pid
  $contract = $state.backend.contract_fingerprint
  $sourceArchive = Join-Path (Split-Path -Parent $state.artifact.root) 'artifact.zip'
  Copy-Item -LiteralPath $sourceArchive -Destination $archive
  $pin = @{
    schema_version = 1; channel = 'beta'; source_revision = $state.backend.source_revision
    plugin = @{ name = 'symphony-plus-plus-mcp'; version = '0.2.0' }
    artifacts = @(@{
      platform = 'windows-x86_64'; source_revision = $state.backend.source_revision
      mcp_contract_fingerprint = $contract; path = 'install-beta.zip'; sha256 = $state.artifact.sha256
      entrypoint = 'start-runtime.ps1'
      dashboard = @{ asset_root = 'dashboard-static'; fingerprint = $CandidateManifest.dashboard.fingerprint }
    })
  }
  $pin | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $channelFile
  $arguments = @('-NoProfile', '-File', $installer, '-SymppHome', $Environment.SYMPP_HOME, '-HerdrAppHome', $nativeHome, '-ArtifactManifest', $channelFile)
  $first = Read-IsolatedCommand $pwsh $arguments $Environment
  if ($first.exit -ne 0 -or $first.stdout -notmatch 'backend unchanged') { throw "Beta no-op failed: $($first.stdout) $($first.stderr)" }
  $pinFile = Join-Path $state.plugin_root '.sympp-runtime-artifacts.json'
  if (-not (Test-Path -LiteralPath $pinFile)) { throw 'An unchanged factory did not pin the selected publication.' }
  $pinStamp = (Get-Item -LiteralPath $pinFile).LastWriteTimeUtc.Ticks
  $nativeFile = Join-Path $nativeHome 'mods/sympp/main.js'
  $stamp = (Get-Item -LiteralPath $nativeFile).LastWriteTimeUtc.Ticks
  $again = Read-IsolatedCommand $pwsh $arguments $Environment
  $state = Get-Content -LiteralPath $Environment.SYMPP_RUNTIME_FILE -Raw | ConvertFrom-Json
  if ($again.exit -ne 0 -or $state.backend.pid -ne $oldPid -or (Get-Item -LiteralPath $nativeFile).LastWriteTimeUtc.Ticks -ne $stamp -or
      (Get-Item -LiteralPath $pinFile).LastWriteTimeUtc.Ticks -ne $pinStamp) {
    throw 'Repeated beta installation restarted the backend or rewrote unchanged native files.'
  }
  foreach ($unsafeHome in @((Join-Path $tempRoot 'normal-home'), (Join-Path $tempRoot 'plugins/cache/beta'))) {
    $refusedArgs = @('-NoProfile', '-File', $installer, '-SymppHome', $unsafeHome, '-HerdrAppHome', $nativeHome, '-ArtifactManifest', $channelFile)
    $refused = Read-IsolatedCommand $pwsh $refusedArgs $Environment
    if ($refused.exit -eq 0 -or (Test-Path -LiteralPath $unsafeHome)) { throw 'Unsafe beta home was not refused before mutation.' }
  }
  $outsideHome = Join-Path $tempRoot 'outside-beta'
  $outsideState = $state | ConvertTo-Json -Depth 30 | ConvertFrom-Json
  $outsideState.publication.controls.database = Join-Path $outsideHome 'ledger.sqlite3'
  $outsideState.artifact.root = Join-Path $outsideHome 'rt/previous/runtime'
  New-Item -ItemType Directory -Force -Path (Join-Path $outsideHome 'runtime') | Out-Null
  $outsideState | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $outsideHome 'runtime/codex-plugin.json')
  $outside = Read-IsolatedCommand $pwsh @('-NoProfile', '-File', $installer, '-SymppHome', $outsideHome,
    '-HerdrAppHome', $nativeHome, '-ArtifactManifest', $channelFile) $Environment
  if ($outside.exit -eq 0 -or $outside.stderr -notmatch 'selected installation root' -or
      (Test-Path -LiteralPath (Join-Path $outsideHome 'rt'))) { throw 'An unrelated workspace home was accepted or prepared.' }
  $lockFile = $null
  for ($directory = [string]$state.plugin_root; $directory; $directory = Split-Path -Parent $directory) {
    $path = Join-Path $directory 'skills-lock.json'
    if ((Test-Path -LiteralPath $path) -and (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json).skills.'symphony-plus-plus') {
      $lockFile = $path
      break
    }
  }
  if (-not $lockFile) { throw 'The disposable Skills installation has no owning lock.' }
  $lockText = Get-Content -LiteralPath $lockFile -Raw
  try {
    $mainLock = $lockText | ConvertFrom-Json
    $mainLock.skills.'symphony-plus-plus' = [pscustomobject]@{ source = 'JJLiebig/symphony-plus-plus'; sourceType = 'github'; ref = 'main' }
    $mainLock | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $lockFile
    $stable = Read-IsolatedCommand $pwsh $arguments $Environment
    if ($stable.exit -eq 0 -or $stable.stderr -notmatch 'beta Skills installation') { throw 'A main Skills factory was accepted.' }
  } finally { [IO.File]::WriteAllText($lockFile, $lockText) }
  $pin.channel = 'stable'
  $pin | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $channelFile
  $stable = Read-IsolatedCommand $pwsh $arguments $Environment
  if ($stable.exit -eq 0 -or $stable.stderr -notmatch 'beta channel') { throw 'A stable runtime publication was accepted.' }
  $pin.channel = 'beta'
  $pin.artifacts[0].mcp_contract_fingerprint = 'f' * 64
  $pin | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $channelFile
  $mismatch = Read-IsolatedCommand $pwsh $arguments $Environment
  if ($mismatch.exit -eq 0 -or $mismatch.stderr -notmatch 'checkout Skills contract') { throw 'An incompatible runtime was accepted.' }
  $pin.artifacts[0].mcp_contract_fingerprint = $contract

  # Different verified bytes of the same real release force an actual restart.
  $zip = [IO.Compression.ZipFile]::Open($archive, [IO.Compression.ZipArchiveMode]::Update)
  try { [void]$zip.CreateEntry('beta-install-proof.txt') } finally { $zip.Dispose() }
  $pin.artifacts[0].sha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  $pin | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $channelFile
  $stateText = Get-Content -LiteralPath $Environment.SYMPP_RUNTIME_FILE -Raw
  try {
    $state.publication.backend.process_start_time_utc_ticks = '1'
    $state | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $Environment.SYMPP_RUNTIME_FILE
    $changedIdentity = Read-IsolatedCommand $pwsh $arguments $Environment
    if ($changedIdentity.exit -eq 0 -or $changedIdentity.stderr -notmatch 'process identity changed' -or
        -not (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) { throw 'Installation stopped an unverified process.' }
  } finally { [IO.File]::WriteAllText($Environment.SYMPP_RUNTIME_FILE, $stateText) }
  $updated = Read-IsolatedCommand $pwsh $arguments $Environment
  if ($updated.exit -ne 0) { throw "Beta install restart failed: $($updated.stdout) $($updated.stderr)" }
  $state = Get-Content -LiteralPath $Environment.SYMPP_RUNTIME_FILE -Raw | ConvertFrom-Json
  if ($state.backend.pid -eq $oldPid -or $state.artifact.sha256 -ne $pin.artifacts[0].sha256) { throw 'Beta install did not replace the runtime.' }
  [void](Send-BridgeRequest $Bridge @{ jsonrpc = '2.0'; id = 80; method = 'tools/list'; params = @{} })
  $goodSha = $state.artifact.sha256
  $zip = [IO.Compression.ZipFile]::Open($archive, [IO.Compression.ZipArchiveMode]::Update)
  try { [void]$zip.CreateEntry('beta-rollback-proof.txt') } finally { $zip.Dispose() }
  $pin.artifacts[0].sha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  $pin | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $channelFile
  $blockedHome = Join-Path $tempRoot 'blocked-native-home'
  [IO.File]::WriteAllText($blockedHome, 'A file cannot be a native app directory.')
  $failedArgs = @('-NoProfile', '-File', $installer, '-SymppHome', $Environment.SYMPP_HOME, '-HerdrAppHome', $blockedHome, '-ArtifactManifest', $channelFile)
  $failed = Read-IsolatedCommand $pwsh $failedArgs $Environment
  if ($failed.exit -eq 0 -or $failed.stderr -notmatch 'previous runtime is serving again') { throw 'A failed native install did not restore the previous runtime.' }
  $restored = Get-Content -LiteralPath $Environment.SYMPP_RUNTIME_FILE -Raw | ConvertFrom-Json
  if ($restored.artifact.sha256 -ne $goodSha) { throw 'Rollback did not retain the last serving artifact.' }
  [void](Send-BridgeRequest $Bridge @{ jsonrpc = '2.0'; id = 81; method = 'tools/list'; params = @{} })
  # Process creation can fail before the launcher publishes any backend PID.
  $zip = [IO.Compression.ZipFile]::Open($archive, [IO.Compression.ZipArchiveMode]::Update)
  try {
    $entry = $zip.CreateEntry('broken.exe')
    $writer = [IO.StreamWriter]::new($entry.Open())
    try { $writer.Write('This is not a Windows executable.') } finally { $writer.Dispose() }
  } finally { $zip.Dispose() }
  $pin.artifacts[0].entrypoint = 'broken.exe'
  $pin.artifacts[0].sha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  $pin | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $channelFile
  $startupFailed = Read-IsolatedCommand $pwsh $arguments $Environment
  if ($startupFailed.exit -eq 0 -or $startupFailed.stderr -notmatch 'previous runtime is serving again') { throw 'Process-creation failure did not restore the previous runtime.' }
  $restored = Get-Content -LiteralPath $Environment.SYMPP_RUNTIME_FILE -Raw | ConvertFrom-Json
  if ($restored.artifact.sha256 -ne $goodSha) { throw 'Startup failure restored the wrong artifact.' }
  [void](Send-BridgeRequest $Bridge @{ jsonrpc = '2.0'; id = 83; method = 'tools/list'; params = @{} })
  $script:backendProcessId = [int]$restored.backend.pid
  $script:backendStartTicks = (Get-Process -Id $script:backendProcessId).StartTime.ToUniversalTime().Ticks
  Write-Host 'Beta install qualified: no-op, native preservation, production/contract refusal, restart, connected bridge recovery, native-failure rollback and process-creation rollback.'
}

function Invoke-BetaBundleQualification([hashtable]$Environment, $Published, $CandidateManifest, [string]$MarkerSessionId) {
  $installer = Get-BetaInstallerEntry
  $pwsh = (Get-Command pwsh -ErrorAction Stop).Source
  $state = Get-Content -LiteralPath $Environment.SYMPP_RUNTIME_FILE -Raw | ConvertFrom-Json
  $root = [string]$state.plugin_root
  $markerFile = Join-Path $root '.sympp-install.json'
  $oldInstall = Get-Content -LiteralPath $markerFile -Raw | ConvertFrom-Json
  $oldInstall.contract_fingerprint = $Published.launcher_contract.mcp_contract_fingerprint
  $oldInstall | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $markerFile
  $helper = Join-Path $root 'scripts/sympp-herdr.js'
  [IO.File]::AppendAllText($helper, "`n// fixture: installed helper changed without updating the package marker.`n")
  $oldHelper = Get-FileHash -LiteralPath $helper -Algorithm SHA256
  $oldMarker = Get-FileHash -LiteralPath $markerFile -Algorithm SHA256
  $Published | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $root '.sympp-runtime-artifacts.json')
  $prepared = Read-IsolatedCommand $pwsh @('-NoProfile', '-File', (Join-Path $root 'scripts/start-sympp-mcp.ps1'), '-PrepareRuntimeOnly') $Environment
  if ($prepared.exit -ne 0) { throw "Could not start the older contract for bundle qualification: $($prepared.stderr)" }
  $publication = $CandidateManifest | ConvertTo-Json -Depth 30 | ConvertFrom-Json
  $publication | Add-Member -NotePropertyName channel -NotePropertyValue 'beta' -Force
  $channelFile = Join-Path $tempRoot 'bundle-upgrade.json'
  $publication | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $channelFile
  $nativeHome = Join-Path $tempRoot 'bundle-native-home'
  $blockedHome = Join-Path $tempRoot 'bundle-blocked-native-home'
  [IO.File]::WriteAllText($blockedHome, 'A file cannot be a native app directory.')
  $upgrade = @{ pid = 0 }
  $manifest = $Published
  $bridge = Join-Path $root 'scripts/start-sympp-mcp-bridge.js'
  $old = Invoke-McpBridge (Get-Command node.exe).Source @($bridge) $Environment -MarkerSessionId $MarkerSessionId -OnAttached {
    param($activeState, $sessionId)
    $failed = Read-IsolatedCommand $pwsh @('-NoProfile', '-File', $installer, '-SymppHome', $Environment.SYMPP_HOME,
      '-HerdrAppHome', $blockedHome, '-ArtifactManifest', $channelFile) $Environment
    if ($failed.exit -eq 0 -or $failed.stderr -notmatch 'previous runtime is serving again') { throw 'Contract-changing bundle failure did not restore service.' }
    $restored = Get-Content -LiteralPath $Environment.SYMPP_RUNTIME_FILE -Raw | ConvertFrom-Json
    $health = Invoke-RestMethod ($restored.backend.url + '/mcp/readiness')
    if ($health.source.mcp_contract.fingerprint -ne $oldInstall.contract_fingerprint -or
        (Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash -ne $oldHelper.Hash -or
        (Get-FileHash -LiteralPath $markerFile -Algorithm SHA256).Hash -ne $oldMarker.Hash) {
      throw 'Rollback did not restore the previous Skills bytes, marker and live contract.'
    }
    [void](Send-BridgeRequest $process @{ jsonrpc = '2.0'; id = 90; method = 'tools/list'; params = @{} })
    $installed = Read-IsolatedCommand $pwsh @('-NoProfile', '-File', $installer, '-SymppHome', $Environment.SYMPP_HOME,
      '-HerdrAppHome', $nativeHome, '-ArtifactManifest', $channelFile) $Environment
    if ($installed.exit -ne 0 -or $installed.stdout -notmatch 'Open fresh sessions') { throw 'Bundle upgrade did not succeed with fresh-session guidance.' }
    $updated = Get-Content -LiteralPath $Environment.SYMPP_RUNTIME_FILE -Raw | ConvertFrom-Json
    $upgrade.pid = [int]$updated.backend.pid
    $desired = Get-FileHash -LiteralPath (Join-Path $repoRoot 'skills/symphony-plus-plus/scripts/sympp-herdr.js') -Algorithm SHA256
    if ((Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash -ne $desired.Hash) { throw 'The installed helper drift was not replaced.' }
  }
  $beforeDrift = $upgrade.pid
  [IO.File]::AppendAllText($helper, "`n// fixture: same-contract drift with an unchanged package marker.`n")
  $repaired = Read-IsolatedCommand $pwsh @('-NoProfile', '-File', $installer, '-SymppHome', $Environment.SYMPP_HOME,
    '-HerdrAppHome', $nativeHome, '-ArtifactManifest', $channelFile) $Environment
  $repairedState = Get-Content -LiteralPath $Environment.SYMPP_RUNTIME_FILE -Raw | ConvertFrom-Json
  $desired = Get-FileHash -LiteralPath (Join-Path $repoRoot 'skills/symphony-plus-plus/scripts/sympp-herdr.js') -Algorithm SHA256
  if ($repaired.exit -ne 0 -or $repaired.stdout -notmatch 'Open fresh sessions' -or $repairedState.backend.pid -eq $beforeDrift -or
      (Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash -ne $desired.Hash) { throw 'Same-contract helper drift was missed.' }
  $upgrade.pid = [int]$repairedState.backend.pid
  $manifest = $CandidateManifest
  $fresh = Invoke-McpBridge (Get-Command node.exe).Source @($bridge) $Environment -MarkerSessionId $MarkerSessionId -OnAttached {
    param($activeState, $sessionId)
    if ($activeState.backend.pid -ne $upgrade.pid) { throw 'A fresh client did not attach to the upgraded backend.' }
    $markerStamp = (Get-Item -LiteralPath $markerFile).LastWriteTimeUtc.Ticks
    $again = Read-IsolatedCommand $pwsh @('-NoProfile', '-File', $installer, '-SymppHome', $Environment.SYMPP_HOME,
      '-HerdrAppHome', $nativeHome, '-ArtifactManifest', $channelFile) $Environment
    $unchanged = Get-Content -LiteralPath $Environment.SYMPP_RUNTIME_FILE -Raw | ConvertFrom-Json
    if ($again.exit -ne 0 -or $again.stdout -notmatch 'backend unchanged' -or $unchanged.backend.pid -ne $upgrade.pid -or
        (Get-Item -LiteralPath $markerFile).LastWriteTimeUtc.Ticks -ne $markerStamp) { throw 'An identical bundle install was not a no-op.' }
  }
  Wait-ManagedRuntimeStopped $fresh.backend_pid $fresh.backend_port
  Write-Host 'Beta bundle qualified: real contract upgrade, full bundle rollback after failure, drift replacement, fresh-client ledger continuity and idempotent repeat.'
}
