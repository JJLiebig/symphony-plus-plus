param([switch]$RuntimeOnly)

$ErrorActionPreference = "Stop"
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "../../../.."))
$functions = @{
  "plugins/symphony-plus-plus-mcp/scripts/sympp-mcp-launcher-helpers.ps1" = @("Get-FileSha256")
  "plugins/symphony-plus-plus-mcp/scripts/sympp-mcp-artifact-runtime.ps1" = @("Get-SymppArtifactDirectoryFingerprint", "Test-SymppArtifactDashboardReady", "Test-SymppArtifactCacheReady")
}
if (-not $RuntimeOnly) { $functions["scripts/build-sympp-runtime-artifact.ps1"] = @("Get-DirectoryFingerprint") }
foreach ($path in $functions.Keys) {
  $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $repoRoot $path), [ref]$null, [ref]$null)
  foreach ($definition in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    if ($definition.Name -in $functions[$path]) { Invoke-Expression $definition.Extent.Text }
  }
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("sympp-fingerprint-" + [guid]::NewGuid().ToString("N"))
try {
  $dashboard = Join-Path $tempRoot "dashboard-static"
  [void][IO.Directory]::CreateDirectory((Join-Path $dashboard "assets"))
  $css = Join-Path $dashboard "assets/index-B4yKZhjP.css"
  $js = Join-Path $dashboard "assets/index-B-Nby7sW.js"
  [IO.File]::WriteAllText($css, "body{}")
  [IO.File]::WriteAllText($js, "export {};")
  # These released filenames sort differently on .NET Framework and modern .NET.
  $expected = "47e653ee050b0d53616f185bc4678712fc6e71c62b913def119d9dfd20341164"
  if (-not $RuntimeOnly -and (Get-DirectoryFingerprint $dashboard) -ne $expected) {
    throw "The artifact builder must hash dashboard records in ordinal order."
  }
  $actual = Get-SymppArtifactDirectoryFingerprint $dashboard
  if ($actual -ne $expected) { throw "Runtime fingerprint on PowerShell $($PSVersionTable.PSVersion) was $actual; expected $expected." }

  $dashboardMarker = Join-Path $dashboard ".sympp-artifact.json"
  [IO.File]::WriteAllText($dashboardMarker, "cache metadata")
  if ((Get-SymppArtifactDirectoryFingerprint $dashboard) -ne $expected) { throw "Runtime fingerprint must exclude its cache marker." }
  $entrypoint = Join-Path $tempRoot "start-runtime.ps1"
  [IO.File]::WriteAllText($entrypoint, "exit 0")
  $marker = Join-Path $tempRoot ".sympp-artifact.json"
  [IO.File]::WriteAllText($marker, (@{ sha256 = "a" * 64; dashboard_root = "dashboard-static"; dashboard_fingerprint = $expected } | ConvertTo-Json))
  if (-not (Test-SymppArtifactCacheReady $tempRoot "start-runtime.ps1" ("a" * 64) "dashboard-static" $expected)) {
    throw "A verified builder fingerprint must be accepted by the runtime cache."
  }
  [IO.File]::WriteAllText($css, "changed")
  if (Test-SymppArtifactCacheReady $tempRoot "start-runtime.ps1" ("a" * 64) "dashboard-static" $expected) { throw "Changed dashboard content must invalidate the cache." }
  [IO.File]::WriteAllText($css, "body{}")
  [IO.File]::WriteAllText($marker, "invalid JSON")
  if (Test-SymppArtifactCacheReady $tempRoot "start-runtime.ps1" ("a" * 64) "dashboard-static" $expected) { throw "A corrupt cache marker must be rejected." }
  [IO.File]::WriteAllText($marker, (@{ sha256 = "a" * 64; dashboard_root = "dashboard-static"; dashboard_fingerprint = $expected } | ConvertTo-Json))
  [IO.File]::Delete($entrypoint)
  if (Test-SymppArtifactCacheReady $tempRoot "start-runtime.ps1" ("a" * 64) "dashboard-static" $expected) { throw "A missing artifact entrypoint must be rejected." }
  Write-Output "Artifact fingerprint/cache checks passed on PowerShell $($PSVersionTable.PSVersion): $expected"
} finally {
  if ([IO.Directory]::Exists($tempRoot)) { [IO.Directory]::Delete($tempRoot, $true) }
}

if (-not $RuntimeOnly) {
  & (Get-Command powershell.exe -ErrorAction Stop).Source -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $PSCommandPath -RuntimeOnly
  if ($LASTEXITCODE -ne 0) { throw "Windows PowerShell artifact fingerprint/cache checks failed." }
}
