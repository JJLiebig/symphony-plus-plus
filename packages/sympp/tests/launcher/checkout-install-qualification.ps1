# Extends the owning installed-runtime journey with connected bridges and real releases.
function Get-CheckoutInstallerEntry {
  $installer = Join-Path $repoRoot 'scripts/install-sympp-checkout-runtime.ps1'
  if ($HostedProcessCreation) {
    $wrapper = Join-Path $tempRoot 'checkout-install-hosted.ps1'
    $preload = (Join-Path $PSScriptRoot 'hosted-backend-preload.ps1').Replace("'", "''")
    $entrypoint = $installer.Replace("'", "''")
    # PowerShell prepends PSHOME to PATH, ahead of the basename fixture.
    $shim = (Join-Path $tempRoot 'trusted-bin/pwsh.exe').Replace("'", "''")
    [IO.File]::WriteAllText($wrapper, "param([string]`$SymppHome, [string]`$HerdrAppHome, [string]`$ArtifactManifest)`n`$ErrorActionPreference = 'Stop'`n`$env:SYMPP_POWERSHELL = '$shim'`n. '$preload'`n& '$entrypoint' @PSBoundParameters`nexit `$LASTEXITCODE`n")
    $installer = $wrapper
  }
  return $installer
}

function Invoke-CheckoutInstallQualification([hashtable]$Environment, $Bridge, $CandidateManifest) {
  $installer = Get-CheckoutInstallerEntry
  $pwsh = (Get-Command pwsh -ErrorAction Stop).Source
  $nativeHome = Join-Path $tempRoot 'native home'
  $channelFile = Join-Path $tempRoot 'install-checkout.json'
  $archive = Join-Path $tempRoot 'install-checkout.zip'
  $state = Get-Content -LiteralPath $Environment.SYMPP_RUNTIME_FILE -Raw | ConvertFrom-Json
  $oldPid = [int]$state.backend.pid
  $contract = $state.backend.contract_fingerprint
  $sourceArchive = Join-Path (Split-Path -Parent $state.artifact.root) 'artifact.zip'
  Copy-Item -LiteralPath $sourceArchive -Destination $archive
  $pin = @{
    schema_version = 1; channel = 'stable'; source_revision = $state.backend.source_revision
    checkout = @{ revision = $state.backend.source_revision; dirty = $false }
    plugin = @{ name = 'symphony-plus-plus-mcp'; version = '0.2.0' }
    artifacts = @(@{
      platform = 'windows-x86_64'; source_revision = $state.backend.source_revision
      mcp_contract_fingerprint = $contract; path = 'install-checkout.zip'; sha256 = $state.artifact.sha256
      entrypoint = 'start-runtime.ps1'
      dashboard = @{ asset_root = 'dashboard-static'; fingerprint = $CandidateManifest.dashboard.fingerprint }
    })
  }
  $pin | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $channelFile
  $arguments = @('-NoProfile', '-File', $installer, '-SymppHome', $Environment.SYMPP_HOME, '-HerdrAppHome', $nativeHome, '-ArtifactManifest', $channelFile)
  $first = Read-IsolatedCommand $pwsh $arguments $Environment
  if ($first.exit -ne 0 -or $first.stdout -notmatch 'backend unchanged') { throw "Checkout no-op failed: $($first.stdout) $($first.stderr)" }
  $pinFile = Join-Path $Environment.SYMPP_HOME 'runtime/checkout-artifacts.json'
  if (-not (Test-Path -LiteralPath $pinFile)) { throw 'An unchanged factory did not pin the selected publication.' }
  $pinStamp = (Get-Item -LiteralPath $pinFile).LastWriteTimeUtc.Ticks
  $nativeFile = Join-Path $nativeHome 'mods/sympp/main.js'
  $stamp = (Get-Item -LiteralPath $nativeFile).LastWriteTimeUtc.Ticks
  $again = Read-IsolatedCommand $pwsh $arguments $Environment
  $state = Get-Content -LiteralPath $Environment.SYMPP_RUNTIME_FILE -Raw | ConvertFrom-Json
  if ($again.exit -ne 0 -or $state.backend.pid -ne $oldPid -or (Get-Item -LiteralPath $nativeFile).LastWriteTimeUtc.Ticks -ne $stamp -or
      (Get-Item -LiteralPath $pinFile).LastWriteTimeUtc.Ticks -ne $pinStamp) {
    throw 'Repeated checkout installation restarted the backend or rewrote unchanged native files.'
  }
  $pin.artifacts[0].mcp_contract_fingerprint = 'f' * 64
  $pin | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $channelFile
  $mismatch = Read-IsolatedCommand $pwsh $arguments $Environment
  if ($mismatch.exit -eq 0 -or $mismatch.stderr -notmatch 'checkout Skills contract') { throw 'An incompatible runtime was accepted.' }
  $pin.artifacts[0].mcp_contract_fingerprint = $contract

  # Different verified bytes of the same real release force an actual restart.
  $zip = [IO.Compression.ZipFile]::Open($archive, [IO.Compression.ZipArchiveMode]::Update)
  try { [void]$zip.CreateEntry('checkout-install-proof.txt') } finally { $zip.Dispose() }
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
  if ($updated.exit -ne 0) { throw "Checkout install restart failed: $($updated.stdout) $($updated.stderr)" }
  $state = Get-Content -LiteralPath $Environment.SYMPP_RUNTIME_FILE -Raw | ConvertFrom-Json
  if ($state.backend.pid -eq $oldPid -or $state.artifact.sha256 -ne $pin.artifacts[0].sha256) { throw 'Checkout install did not replace the runtime.' }
  [void](Send-BridgeRequest $Bridge @{ jsonrpc = '2.0'; id = 80; method = 'tools/list'; params = @{} })
  $goodSha = $state.artifact.sha256
  $zip = [IO.Compression.ZipFile]::Open($archive, [IO.Compression.ZipArchiveMode]::Update)
  try { [void]$zip.CreateEntry('checkout-rollback-proof.txt') } finally { $zip.Dispose() }
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
  Write-Host 'Checkout install qualified: no-op, native preservation, contract refusal, restart, connected bridge recovery, native-failure rollback and process-creation rollback.'
}
