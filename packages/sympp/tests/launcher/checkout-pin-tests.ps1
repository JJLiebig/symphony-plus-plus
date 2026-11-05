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
  $helpers = Join-Path $repo 'packages/sympp/scripts'
  . (Join-Path $helpers 'sympp-mcp-launcher-helpers.ps1')
  Copy-Item -LiteralPath (Join-Path $repo 'skills/sympp/.sympp-install.json') -Destination $bundle
  $hash = Get-SymppSkillsBundleHash $bundle
  $pin = Join-Path $root 'runtime/checkout-artifacts.json'
  @{ factory_plugin_root = $bundle; source_revision = 'a' * 40; checkout = @{ revision = 'a' * 40; dirty = $true; skills_hash = $hash }; artifacts = @(@{ platform = 'windows-x86_64'; path = 'retained-cache.zip' }) } | ConvertTo-Json -Depth 8 | Set-Content $pin
  # Fresh processes use the actual cold-launch manifest resolver.
  $probe = Join-Path $root 'probe.ps1'
  @'
param($Repo, $Bundle, $FactoryHome = (Split-Path -Parent $Bundle), [switch]$NoNode)
$ErrorActionPreference = 'Stop'
if ($NoNode) { $env:PATH = '' }
$helpers = Join-Path $Repo 'packages/sympp/scripts'
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
  $alias = Join-Path $root 'claude-skills'
  New-Item -ItemType Junction -Path $alias -Target $bundle | Out-Null
  $junction = & pwsh -NoProfile -File $probe $repo $alias $root | ConvertFrom-Json
  if ($junction.source_revision -ne ('a' * 40)) { throw 'A junctioned launcher ignored the checkout pin.' }
  $prepared = & (Get-Command powershell.exe).Source -NoProfile -File $probe $repo $alias $root | ConvertFrom-Json
  if ($prepared.source_revision -ne ('a' * 40)) { throw 'The Windows PowerShell prepared-start path ignored the junctioned pin.' }
  $selection = Get-Content -LiteralPath $pin -Raw | ConvertFrom-Json
  $selection.factory_plugin_root = $alias
  $selection | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $pin
  $canonical = & pwsh -NoProfile -File $probe $repo $bundle $root | ConvertFrom-Json
  if ($canonical.source_revision -ne ('a' * 40)) { throw 'A junctioned recorded root ignored the checkout pin.' }
  $other = Join-Path $root 'non-portable'
  New-Item -ItemType Directory -Path (Join-Path $other 'assets') -Force | Out-Null
  @{ source_revision = 'd' * 40 } | ConvertTo-Json | Set-Content (Join-Path $other 'assets/sympp-runtime-artifacts.json')
  $fallback = & (Get-Command pwsh).Source -NoProfile -File $probe $repo $other $root -NoNode | ConvertFrom-Json
  if ($fallback.source_revision -ne ('d' * 40) -or -not (Test-Path $pin)) { throw 'An unrelated checkout pin broke the Node-free non-portable fallback.' }
  # An outside update can change instructions without updating the install marker.
  # A rollback also retains a legacy selection for the previous installed launcher.
  @{ source_revision = 'c' * 40 } | ConvertTo-Json | Set-Content (Join-Path $bundle '.sympp-runtime-artifacts.json')
  'published instructions from an outside Skills update' | Set-Content (Join-Path $bundle 'SKILL.md')
  $updated = & pwsh -NoProfile -File $probe $repo $bundle | ConvertFrom-Json
  if ($updated.source_revision -ne ('b' * 40) -or (Test-Path $pin) -or $updated.checkout) { throw 'An outside Skills update did not drop the pin and select the published channel.' }
  if (Test-Path (Join-Path $bundle '.sympp-runtime-artifacts.json')) { throw 'An outside update retained a rollback selection.' }
  $again = & pwsh -NoProfile -File $probe $repo $bundle | ConvertFrom-Json
  if ($again.source_revision -ne $updated.source_revision) { throw 'Published selection did not survive another cold start.' }
  Write-Host 'Checkout pin qualified: untouched Skills retain the build; an outside update drops the pin and selects the channel.'
} finally {
  if ([IO.Path]::GetFullPath($root).StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $root -Recurse -Force }
}
