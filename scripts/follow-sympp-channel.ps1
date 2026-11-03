[CmdletBinding()]
param([string]$SymppHome = $env:SYMPP_HOME)
$ErrorActionPreference = 'Stop'
if (-not $SymppHome -or -not [IO.Path]::IsPathFullyQualified($SymppHome)) { throw 'Set SYMPP_HOME to the absolute path of the target factory.' }
$state = Get-Content -LiteralPath (Join-Path $SymppHome 'runtime/codex-plugin.json') -Raw | ConvertFrom-Json
$pluginRoot = [string]$state.plugin_root
$helpers = Join-Path $PSScriptRoot '../plugins/symphony-plus-plus-mcp/scripts'
foreach ($name in @('sympp-launcher-runtime', 'sympp-mcp-launcher-helpers', 'sympp-mcp-artifact-manifest', 'sympp-mcp-artifact-channel')) { . (Join-Path $helpers "$name.ps1") }
$installed = Read-SymppPortableInstall $pluginRoot
if (-not $installed) { throw 'Select a portable Skills factory.' }
$channel = & node -e "process.stdout.write(require(process.argv[1]).runtimeChannel())" (Join-Path $pluginRoot 'scripts/setup-sympp.js')
if ($LASTEXITCODE -ne 0) { throw 'Could not identify the factory channel.' }
$channelsPath = Join-Path $pluginRoot 'assets/sympp-runtime-artifacts.json'
$channels = Get-Content -LiteralPath $channelsPath -Raw | ConvertFrom-Json
$published = Resolve-SymppPublishedArtifactManifest $channels.channels.$channel $channelsPath
$revision = [string]$published.source_revision
if ($revision -notmatch '^[0-9a-f]{40}$') { throw 'The published runtime has no valid source revision.' }
$stage = Join-Path (Split-Path -Parent $pluginRoot) ('.sympp-follow-' + [guid]::NewGuid().ToString('N'))
$backup = "$stage.previous"
$pin = Join-Path $SymppHome 'runtime/checkout-artifacts.json'
$completed = $false
try {
  & git init --quiet $stage
  if ($LASTEXITCODE -ne 0) { throw 'Could not prepare published Skills.' }
  & git -C $stage fetch --quiet --depth=1 https://github.com/JJLiebig/symphony-plus-plus $revision
  if ($LASTEXITCODE -ne 0) { throw 'Could not fetch published Skills.' }
  & git -C $stage checkout --quiet FETCH_HEAD -- skills/symphony-plus-plus
  if ($LASTEXITCODE -ne 0) { throw 'Could not extract published Skills.' }
  $bundle = Join-Path $stage 'skills/symphony-plus-plus'
  $candidate = Read-SymppPortableInstall $bundle
  if (-not $candidate -or $candidate.contract_fingerprint -ne $published.mcp_contract_fingerprint) { throw 'Published Skills do not match the runtime contract.' }
  $changed = $installed.payload_sha256 -ne $candidate.payload_sha256 -or $installed.contract_fingerprint -ne $candidate.contract_fingerprint
  Move-Item -LiteralPath $pluginRoot -Destination $backup
  try {
    Move-Item -LiteralPath $bundle -Destination $pluginRoot
    if (Test-Path -LiteralPath $pin) { Remove-Item -LiteralPath $pin -Force }
  } catch {
    if (Test-Path -LiteralPath $pluginRoot) { Remove-Item -LiteralPath $pluginRoot -Recurse -Force }
    Move-Item -LiteralPath $backup -Destination $pluginRoot
    throw
  }
  $completed = $true
  if ($changed) { Write-Host 'Skills or MCP contract changed. Open fresh agent sessions to see the update.' }
  Write-Host 'Following the published channel on the next cold start.'
} finally {
  foreach ($path in @($stage, $backup)) {
    if ($path -eq $backup -and -not $completed) { continue }
    if ([IO.Path]::GetFullPath($path).StartsWith((Split-Path -Parent $pluginRoot) + '\', [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue }
  }
}
