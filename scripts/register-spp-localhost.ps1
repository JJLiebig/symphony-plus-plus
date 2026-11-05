param(
  [switch] $Remove
)

$ErrorActionPreference = "Stop"

$HostsPath = Join-Path $env:SystemRoot "System32\drivers\etc\hosts"
$HostName = "spp.localhost"
$Address = "127.0.0.1"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  Write-Error "Run this script from an elevated PowerShell session so it can update $HostsPath."
  exit 1
}

$lines = if (Test-Path -LiteralPath $HostsPath) {
  Get-Content -LiteralPath $HostsPath
} else {
  @()
}

$entryPattern = "(?i)^\s*127\.0\.0\.1\s+$([regex]::Escape($HostName))(\s+#.*)?\s*$"
$keptLines = @($lines | Where-Object { $_ -notmatch $entryPattern })

if ($Remove) {
  $keptLines | Set-Content -LiteralPath $HostsPath -Encoding ascii
  Write-Host "Removed $HostName from $HostsPath."
  exit 0
}

$keptLines += "$Address`t$HostName # sympp local dashboard"
$keptLines | Set-Content -LiteralPath $HostsPath -Encoding ascii

Write-Host "Registered http://$HostName:19999 for the sympp local dashboard."
