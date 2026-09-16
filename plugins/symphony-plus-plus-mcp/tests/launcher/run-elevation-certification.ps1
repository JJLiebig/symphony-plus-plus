param([string]$ResultPath)
$ErrorActionPreference = 'Stop'
[Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'BelowNormal'
$previousCertification = $env:SYMPP_ELEVATION_CERTIFICATION
$previousCase = $env:SYMPP_COLD_ONLY
$previousSid = $env:SYMPP_TEST_SHELL_SID
try {
  $sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
  $shell = Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | Where-Object SessionId -eq $sessionId | Select-Object -First 1
  if (-not $shell) { throw 'Certification needs the logged-in desktop shell.' }
  $env:SYMPP_TEST_SHELL_SID = (Invoke-CimMethod -InputObject $shell -MethodName GetOwnerSid).Sid
  $env:SYMPP_ELEVATION_CERTIFICATION = '1'
  $env:SYMPP_COLD_ONLY = $null
  & (Get-Command node.exe -ErrorAction Stop).Source (Join-Path $PSScriptRoot 'cold-start-singleton-smoke.js') 2>&1 |
    Tee-Object -Variable result | Out-Host
  if ($ResultPath) { $result | Set-Content -LiteralPath $ResultPath }
  if ($LASTEXITCODE -ne 0) { throw "Mixed-elevation certification failed with exit code $LASTEXITCODE." }
} finally {
  $env:SYMPP_ELEVATION_CERTIFICATION = $previousCertification
  $env:SYMPP_COLD_ONLY = $previousCase
  $env:SYMPP_TEST_SHELL_SID = $previousSid
}
