[CmdletBinding()]
param([string]$SymppHome = $env:SYMPP_HOME)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Checkout installation requires PowerShell 7 on Windows.' }
if (-not $SymppHome -or -not [IO.Path]::IsPathFullyQualified($SymppHome)) { throw 'Set SYMPP_HOME to the absolute path of the target factory.' }
$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeFile = Join-Path $SymppHome 'runtime/codex-plugin.json'
$state = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
$revision = (& git -C $repoRoot rev-parse HEAD).Trim()
$dirty = [bool](& git -C $repoRoot status --porcelain --untracked-files=normal)
& node (Join-Path $repoRoot 'scripts/package-portable-skills.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Skills packaging failed.' }
$output = Join-Path $repoRoot 'elixir/_build/checkout-runtime'
Push-Location (Join-Path $repoRoot 'elixir')
try {
  & mise exec -- pwsh -NoProfile -File (Join-Path $PSScriptRoot 'build-sympp-runtime-artifact.ps1') -Revision $revision -OutputDir $output
  if ($LASTEXITCODE -ne 0) { throw 'Runtime build failed.' }
} finally { Pop-Location }
$built = Get-Content -LiteralPath (Join-Path $output "sympp-runtime-$revision-windows-x64.manifest.json") -Raw | ConvertFrom-Json
$manifest = @{
  schema_version = 1; source_revision = $revision; plugin = $built.plugin
  checkout = @{ revision = $revision; dirty = $dirty; installed_at = [DateTime]::UtcNow.ToString('o') }
  artifacts = @(@{
    platform = 'windows-x86_64'; source_revision = $revision
    mcp_contract_fingerprint = $built.launcher_contract.mcp_contract_fingerprint
    path = Join-Path $output $built.artifact.file; sha256 = $built.artifact.sha256
    entrypoint = 'start-runtime.ps1'
    dashboard = @{ asset_root = 'dashboard-static'; fingerprint = $built.dashboard.fingerprint }
  })
}
$manifestFile = Join-Path $output 'checkout.json'
$manifest | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $manifestFile
$herdrHome = if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $env:USERPROFILE '.config/herdr-app' }
& (Join-Path $PSScriptRoot 'install-sympp-checkout-runtime.ps1') -SymppHome $SymppHome -HerdrAppHome $herdrHome -ArtifactManifest $manifestFile
