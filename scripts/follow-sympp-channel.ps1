[CmdletBinding()]
param([string]$SymppHome = $env:SYMPP_HOME)
$ErrorActionPreference = 'Stop'
if (-not $SymppHome -or -not [IO.Path]::IsPathFullyQualified($SymppHome)) { throw 'Set SYMPP_HOME to the absolute path of the target factory.' }
$state = Get-Content -LiteralPath (Join-Path $SymppHome 'runtime/codex-plugin.json') -Raw | ConvertFrom-Json
$pluginRoot = [string]$state.plugin_root
$helpers = Join-Path $PSScriptRoot '../plugins/symphony-plus-plus-mcp/scripts'
foreach ($name in @('sympp-launcher-runtime', 'sympp-mcp-launcher-helpers', 'sympp-mcp-artifact-manifest', 'sympp-mcp-artifact-channel')) { . (Join-Path $helpers "$name.ps1") }
function Get-FollowSkills([string]$pluginRoot, [string]$stage) {
$installed = Read-SymppPortableInstall $pluginRoot
if (-not $installed) { throw 'Select a portable Skills factory.' }
$channel = & node -e "process.stdout.write(require(process.argv[1]).runtimeChannel())" (Join-Path $pluginRoot 'scripts/setup-sympp.js')
if ($LASTEXITCODE -ne 0) { throw 'Could not identify the factory channel.' }
$channelsPath = Join-Path $pluginRoot 'assets/sympp-runtime-artifacts.json'
$channels = Get-Content -LiteralPath $channelsPath -Raw | ConvertFrom-Json
$published = Resolve-SymppPublishedArtifactManifest $channels.channels.$channel $channelsPath
$revision = [string]$published.source_revision
if ($revision -notmatch '^[0-9a-f]{40}$') { throw 'The published runtime has no valid source revision.' }
  & git init --quiet $stage
  if ($LASTEXITCODE -ne 0) { throw 'Could not prepare published Skills.' }
  & git -C $stage fetch --quiet --depth=1 https://github.com/JJLiebig/symphony-plus-plus $revision
  if ($LASTEXITCODE -ne 0) { throw 'Could not fetch published Skills.' }
  & git -C $stage checkout --quiet FETCH_HEAD -- skills/symphony-plus-plus
  if ($LASTEXITCODE -ne 0) { throw 'Could not extract published Skills.' }
  $bundle = Join-Path $stage 'skills/symphony-plus-plus'
  $candidate = Read-SymppPortableInstall $bundle
  if (-not $candidate -or $candidate.contract_fingerprint -ne $published.mcp_contract_fingerprint) { throw 'Published Skills do not match the runtime contract.' }
  return [pscustomobject]@{ bundle = $bundle; manifest = $published.manifest_path }
}
$stage = Join-Path (Split-Path -Parent $pluginRoot) ('.sympp-follow-' + [guid]::NewGuid().ToString('N'))
try {
  $prepared = Get-FollowSkills $pluginRoot $stage
  $herdrHome = if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $env:USERPROFILE '.config/herdr-app' }
  & (Join-Path $PSScriptRoot 'install-sympp-beta.ps1') -LocalCheckout -FollowChannel -SkillsBundle $prepared.bundle -SymppHome $SymppHome -HerdrAppHome $herdrHome -ArtifactManifest $prepared.manifest
  Write-Host 'Following the published channel.'
} finally {
  foreach ($path in @($stage)) {
    if ([IO.Path]::GetFullPath($path).StartsWith((Split-Path -Parent $pluginRoot) + '\', [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue }
  }
}
