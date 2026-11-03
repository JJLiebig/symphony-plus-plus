$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../..'))
$root = Join-Path ([IO.Path]::GetTempPath()) ('sympp-checkout-pin-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $root 'runtime'), (Join-Path $root 'bundle/assets') -Force | Out-Null
try {
  $bundle = Join-Path $root 'bundle'
  '{"distribution":"skills"}' | Set-Content (Join-Path $bundle '.sympp-install.json')
  @{ plugin_root = $bundle } | ConvertTo-Json | Set-Content (Join-Path $root 'runtime/codex-plugin.json')
  $published = @{ source_revision = 'b' * 40; artifacts = @(@{ platform = 'windows-x86_64'; path = 'published.zip' }) }
  $published | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $bundle 'assets/published.json')
  @{ channels = @{ stable = @{ manifest = @{ path = (Join-Path $bundle 'assets/published.json') } } } } | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $bundle 'assets/sympp-runtime-artifacts.json')
  $pin = Join-Path $root 'runtime/checkout-artifacts.json'
  @{ factory_plugin_root = $bundle; source_revision = 'a' * 40; checkout = @{ revision = 'a' * 40; dirty = $true }; artifacts = @(@{ platform = 'windows-x86_64'; path = 'retained-cache.zip' }) } | ConvertTo-Json -Depth 8 | Set-Content $pin
  # New processes exercise the same manifest resolver as a cold launcher.
  $probe = Join-Path $root 'probe.ps1'
  @'
param($Repo, $Bundle, $FactoryHome = (Split-Path -Parent $Bundle))
$ErrorActionPreference = 'Stop'
. (Join-Path $Repo 'plugins/symphony-plus-plus-mcp/scripts/sympp-mcp-artifact-channel.ps1')
. (Join-Path $Repo 'plugins/symphony-plus-plus-mcp/scripts/sympp-mcp-artifact-manifest.ps1')
function Get-SymppRuntimeChannel { 'stable' }
function Resolve-SymppPluginHome { $FactoryHome }
Read-SymppArtifactManifest $Bundle | ConvertTo-Json -Depth 12 -Compress
'@ | Set-Content $probe
  $first = & pwsh -NoProfile -File $probe $repo $bundle | ConvertFrom-Json
  $second = & pwsh -NoProfile -File $probe $repo $bundle | ConvertFrom-Json
  if ($first.source_revision -ne ('a' * 40) -or $second.source_revision -ne $first.source_revision -or -not $second.checkout.dirty) { throw 'Cold selection lost the checkout pin.' }
  $otherHome = Join-Path $root 'other-factory'
  New-Item -ItemType Directory -Path $otherHome | Out-Null
  $other = & pwsh -NoProfile -File $probe $repo $bundle $otherHome | ConvertFrom-Json
  if ($other.source_revision -ne ('b' * 40)) { throw 'Checkout pin leaked to another factory sharing Skills.' }
  & (Join-Path $repo 'scripts/follow-sympp-channel.ps1') -SymppHome $root
  $followed = & pwsh -NoProfile -File $probe $repo $bundle | ConvertFrom-Json
  if ($followed.source_revision -ne ('b' * 40) -or $followed.checkout) { throw 'Follow did not return cold selection to the channel.' }
  & (Join-Path $repo 'scripts/follow-sympp-channel.ps1') -SymppHome $root
  $before = Get-Content -LiteralPath $pin -Raw
  & (Join-Path $repo 'scripts/follow-sympp-channel.ps1') -SymppHome $root
  if ((Get-Content -LiteralPath $pin -Raw) -cne $before) { throw 'Repeated follow rewrote channel selection.' }
  # Another bundle sharing this home cannot consume this factory's selection.
  $foreign = Join-Path $root 'other-bundle'
  New-Item -ItemType Directory -Path (Join-Path $foreign 'assets') -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $bundle 'assets/sympp-runtime-artifacts.json') -Destination (Join-Path $foreign 'assets/sympp-runtime-artifacts.json')
  # Keep the same home while selecting a different installed bundle.
  $isolated = & pwsh -NoProfile -File $probe $repo $foreign | ConvertFrom-Json
  if ($isolated.source_revision -ne ('b' * 40)) { throw 'Factory pin leaked to another bundle.' }
  Write-Host 'Checkout pin qualified: repeated cold selection, dirty provenance, follow, and factory isolation.'
} finally {
  if ([IO.Path]::GetFullPath($root).StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $root -Recurse -Force }
}

