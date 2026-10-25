# Extends the owning installed-runtime journey with a connected bridge and real release.
function Invoke-BetaInstallQualification([hashtable]$Environment, $Bridge, $CandidateManifest) {
  $installer = Join-Path $repoRoot 'scripts/install-sympp-beta.ps1'
  if ($HostedProcessCreation) {
    $wrapper = Join-Path $tempRoot 'beta-install-hosted.ps1'
    $preload = (Join-Path $PSScriptRoot 'hosted-backend-preload.ps1').Replace("'", "''")
    $entrypoint = $installer.Replace("'", "''")
    [IO.File]::WriteAllText($wrapper, "param([string]`$SymppHome, [string]`$HerdrAppHome, [string]`$ArtifactManifest)`n`$ErrorActionPreference = 'Stop'`n. '$preload'`n& '$entrypoint' @PSBoundParameters`nexit `$LASTEXITCODE`n")
    $installer = $wrapper
  }
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
      mcp_contract_fingerprint = $contract; path = $archive; sha256 = $state.artifact.sha256
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
  if ($mismatch.exit -eq 0 -or $mismatch.stderr -notmatch 'installed MCP contract') { throw 'An incompatible runtime was accepted.' }
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
