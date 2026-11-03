[CmdletBinding()]
param([string]$SymppHome = $env:SYMPP_HOME)
$ErrorActionPreference = 'Stop'
if (-not $SymppHome -or -not [IO.Path]::IsPathFullyQualified($SymppHome)) { throw 'Set SYMPP_HOME to the absolute path of the target factory.' }
$state = Get-Content -LiteralPath (Join-Path $SymppHome 'runtime/codex-plugin.json') -Raw | ConvertFrom-Json
$pin = Join-Path $SymppHome 'runtime/checkout-artifacts.json'
if (-not (Test-Path -LiteralPath (Join-Path $state.plugin_root '.sympp-install.json'))) { throw 'Select a portable Skills factory.' }
if (Test-Path -LiteralPath $pin) {
  $manifest = Get-Content -LiteralPath $pin -Raw | ConvertFrom-Json
  if (-not $manifest.checkout) { Write-Host 'Following the published channel on the next cold start.'; return }
  $channel = Get-Content -LiteralPath (Join-Path $state.plugin_root 'assets/sympp-runtime-artifacts.json') -Raw | ConvertFrom-Json
  $channel | Add-Member -NotePropertyName factory_plugin_root -NotePropertyValue $state.plugin_root -Force
  $temporary = "$pin.$PID.tmp"
  try {
    $channel | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $temporary
    [IO.File]::Move($temporary, $pin, $true)
  } finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}
Write-Host 'Following the published channel on the next cold start.'
