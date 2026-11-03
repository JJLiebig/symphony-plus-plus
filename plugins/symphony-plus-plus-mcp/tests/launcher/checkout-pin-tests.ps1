$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../..'))
$root = Join-Path ([IO.Path]::GetTempPath()) ('sympp-checkout-pin-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $root 'runtime'), (Join-Path $root 'bundle/assets') -Force | Out-Null
try {
  $bundle = Join-Path $root 'bundle'
  'original instructions' | Set-Content (Join-Path $bundle 'SKILL.md')
  $published = @{ source_revision = 'b' * 40; artifacts = @(@{ platform = 'windows-x86_64'; path = 'published.zip' }) }
  $published | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $root 'published.json')
  @{ channels = @{ stable = @{ manifest = @{ path = (Join-Path $root 'published.json') } } } } | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $bundle 'assets/sympp-runtime-artifacts.json')
  $helpers = Join-Path $repo 'plugins/symphony-plus-plus-mcp/scripts'
  . (Join-Path $helpers 'sympp-mcp-launcher-helpers.ps1')
  $hash = Get-SymppSkillsBundleHash $bundle
  $pin = Join-Path $root 'runtime/checkout-artifacts.json'
  @{ factory_plugin_root = $bundle; source_revision = 'a' * 40; checkout = @{ revision = 'a' * 40; dirty = $true; skills_hash = $hash }; artifacts = @(@{ platform = 'windows-x86_64'; path = 'retained-cache.zip' }) } | ConvertTo-Json -Depth 8 | Set-Content $pin
  # Fresh processes use the actual cold-launch manifest resolver.
  $probe = Join-Path $root 'probe.ps1'
  @'
param($Repo, $Bundle, $FactoryHome = (Split-Path -Parent $Bundle))
$ErrorActionPreference = 'Stop'
$helpers = Join-Path $Repo 'plugins/symphony-plus-plus-mcp/scripts'
. (Join-Path $helpers 'sympp-mcp-launcher-helpers.ps1')
. (Join-Path $helpers 'sympp-mcp-artifact-channel.ps1')
. (Join-Path $helpers 'sympp-mcp-artifact-manifest.ps1')
function Get-SymppRuntimeChannel { 'stable' }
function Resolve-SymppPluginHome { $FactoryHome }
Read-SymppArtifactManifest $Bundle | ConvertTo-Json -Depth 12 -Compress
'@ | Set-Content $probe
  $first = & pwsh -NoProfile -File $probe $repo $bundle | ConvertFrom-Json
  $second = & pwsh -NoProfile -File $probe $repo $bundle | ConvertFrom-Json
  if ($first.source_revision -ne ('a' * 40) -or $second.source_revision -ne $first.source_revision -or -not $second.checkout.dirty -or -not (Test-Path $pin)) { throw 'An unchanged Skills bundle lost the checkout pin.' }
  # An outside update can change instructions without updating the install marker.
  'published instructions from an outside Skills update' | Set-Content (Join-Path $bundle 'SKILL.md')
  $updated = & pwsh -NoProfile -File $probe $repo $bundle | ConvertFrom-Json
  if ($updated.source_revision -ne ('b' * 40) -or (Test-Path $pin) -or $updated.checkout) { throw 'An outside Skills update did not drop the pin and select the published channel.' }
  $again = & pwsh -NoProfile -File $probe $repo $bundle | ConvertFrom-Json
  if ($again.source_revision -ne $updated.source_revision) { throw 'Published selection did not survive another cold start.' }
  Write-Host 'Checkout pin qualified: untouched Skills retain the build; an outside update drops the pin and selects the channel.'
} finally {
  if ([IO.Path]::GetFullPath($root).StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $root -Recurse -Force }
}
