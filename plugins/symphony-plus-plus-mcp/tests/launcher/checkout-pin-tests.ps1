$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../..'))
$root = Join-Path ([IO.Path]::GetTempPath()) ('sympp-checkout-pin-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $root 'runtime'), (Join-Path $root 'bundle/assets') -Force | Out-Null
$savedGitConfig = @{}
foreach ($name in @('GIT_CONFIG_COUNT','GIT_CONFIG_KEY_0','GIT_CONFIG_VALUE_0')) { $savedGitConfig[$name] = [Environment]::GetEnvironmentVariable($name) }
try {
  $bundle = Join-Path $root 'bundle'
  Copy-Item -LiteralPath (Join-Path $repo 'skills/symphony-plus-plus/.sympp-install.json') -Destination $bundle
  New-Item -ItemType Directory -Path (Join-Path $bundle 'scripts') | Out-Null
  Copy-Item -LiteralPath (Join-Path $repo 'plugins/symphony-plus-plus-mcp/scripts/setup-sympp.js') -Destination (Join-Path $bundle 'scripts/setup-sympp.js')
  @{ skills = @{ 'symphony-plus-plus' = @{ source = 'JJLiebig/symphony-plus-plus'; ref = 'main' } } } | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $root 'skills-lock.json')
  @{ plugin_root = $bundle } | ConvertTo-Json | Set-Content (Join-Path $root 'runtime/codex-plugin.json')
  $published = @{ source_revision = 'b' * 40; mcp_contract_fingerprint = 'b' * 64; artifacts = @(@{ platform = 'windows-x86_64'; path = 'published.zip' }) }
  $published | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $root 'published.json')
  @{ channels = @{ stable = @{ manifest = @{ path = (Join-Path $root 'published.json') } } } } | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $bundle 'assets/sympp-runtime-artifacts.json')
  $publishedRepo = Join-Path $root 'published-repo'
  $publishedBundle = Join-Path $publishedRepo 'skills/symphony-plus-plus'
  New-Item -ItemType Directory -Path $publishedBundle -Force | Out-Null
  Copy-Item -Path "$bundle/*" -Destination $publishedBundle -Recurse
  Copy-Item -LiteralPath (Join-Path $bundle '.sympp-install.json') -Destination $publishedBundle
  $publishedInstall = Get-Content -LiteralPath (Join-Path $publishedBundle '.sympp-install.json') -Raw | ConvertFrom-Json
  $publishedInstall.contract_fingerprint = 'b' * 64
  $publishedInstall | ConvertTo-Json | Set-Content (Join-Path $publishedBundle '.sympp-install.json')
  & git init --quiet $publishedRepo
  & git -C $publishedRepo add .
  & git -C $publishedRepo -c user.name=fixture -c user.email=fixture@example.invalid commit --quiet -m fixture
  $published.source_revision = (& git -C $publishedRepo rev-parse HEAD).Trim()
  $published | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $root 'published.json')
  $env:GIT_CONFIG_COUNT = '1'
  $env:GIT_CONFIG_KEY_0 = "url.$($publishedRepo.Replace('\','/')).insteadOf"
  $env:GIT_CONFIG_VALUE_0 = 'https://github.com/JJLiebig/symphony-plus-plus'
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
  if ($other.source_revision -ne $published.source_revision) { throw 'Checkout pin leaked to another factory sharing Skills.' }
  $helpers = Join-Path $repo 'plugins/symphony-plus-plus-mcp/scripts'
  foreach ($name in @('sympp-launcher-runtime', 'sympp-mcp-launcher-helpers', 'sympp-mcp-artifact-manifest', 'sympp-mcp-artifact-channel')) { . (Join-Path $helpers "$name.ps1") }
  $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'scripts/follow-sympp-channel.ps1'), [ref]$null, [ref]$null)
  $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-FollowSkills' }, $true)
  Invoke-Expression $definition.Extent.Text
  $prepared = Get-FollowSkills $bundle (Join-Path $root 'fetched')
  $restoredInstall = Read-SymppPortableInstall $prepared.bundle
  if ($restoredInstall.contract_fingerprint -ne ('b' * 64)) { throw 'Follow did not prepare the published Skills contract.' }
  Remove-Item -LiteralPath $pin
  $followed = & pwsh -NoProfile -File $probe $repo $bundle | ConvertFrom-Json
  if ($followed.source_revision -ne $published.source_revision -or $followed.checkout) { throw 'Follow did not return cold selection to the channel.' }
  if (Test-Path -LiteralPath $pin) { throw 'Follow retained a checkout pin.' }
  # Another bundle sharing this home cannot consume this factory's selection.
  $foreign = Join-Path $root 'other-bundle'
  New-Item -ItemType Directory -Path (Join-Path $foreign 'assets') -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $bundle 'assets/sympp-runtime-artifacts.json') -Destination (Join-Path $foreign 'assets/sympp-runtime-artifacts.json')
  # Keep the same home while selecting a different installed bundle.
  $isolated = & pwsh -NoProfile -File $probe $repo $foreign | ConvertFrom-Json
  if ($isolated.source_revision -ne $published.source_revision) { throw 'Factory pin leaked to another bundle.' }
  Write-Host 'Checkout pin qualified: repeated cold selection, dirty provenance, published Skills preparation, and factory isolation.'
} finally {
  foreach ($name in $savedGitConfig.Keys) { [Environment]::SetEnvironmentVariable($name, $savedGitConfig[$name]) }
  if ([IO.Path]::GetFullPath($root).StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $root -Recurse -Force }
}
