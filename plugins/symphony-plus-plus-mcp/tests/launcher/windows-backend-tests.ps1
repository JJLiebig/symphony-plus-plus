param([string]$ResultPath)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { return }
$scripts = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../scripts'))
. (Join-Path $scripts 'sympp-mcp-launcher-helpers.ps1')
. (Join-Path $scripts 'sympp-windows-backend.ps1')
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$testRoot = Join-Path $tempRoot ('sympp backend &' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testRoot)
$child = $null
$previousTestValue = $env:SYMPP_BACKEND_TEST_VALUE
try {
  $stdin = Join-Path $testRoot 'stdin.log'
  $stdout = Join-Path $testRoot 'stdout.log'
  $stderr = Join-Path $testRoot 'stderr.log'
  [IO.File]::WriteAllText($stdin, '')
  $script = @'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
@{
  pid = $PID
  sid = $identity.User.Value
  elevated = ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  priority = [Diagnostics.Process]::GetCurrentProcess().PriorityClass.ToString()
  directory = [Environment]::CurrentDirectory
  stdin_eof = [Console]::In.ReadToEnd() -eq ''
  value = $env:SYMPP_BACKEND_TEST_VALUE
} | ConvertTo-Json -Compress | Write-Output
[Console]::Error.WriteLine('redirected error')
Start-Sleep -Seconds 15
'@
  $env:SYMPP_BACKEND_TEST_VALUE = 'spaces & percent %PATH% and unicode ' + [char]0xe4
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
  $command = [pscustomobject]@{ file = (Get-Command pwsh).Source; args = @('-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded) }
  [Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'BelowNormal'
  $child = Start-SymppWindowsBackend $command $testRoot $stdin $stdout $stderr
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while ((-not (Test-Path $stdout) -or (Get-Item $stdout).Length -eq 0) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
  $result = Get-Content $stdout -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($result.elevated) { throw 'Backend inherited elevation' }
  if ($result.pid -ne $child.Id) { throw 'Returned PID is not the launched process' }
  if ($result.priority -ne 'BelowNormal') { throw 'Backend did not preserve caller priority' }
  if ($result.directory -ne $testRoot -or -not $result.stdin_eof) { throw 'Working directory or stdin redirect was lost' }
  if ($result.value -ne $env:SYMPP_BACKEND_TEST_VALUE) { throw 'Backend environment was changed' }
  if ((Get-Content $stderr -Raw).Trim() -ne 'redirected error') { throw 'Stderr was not redirected' }
  Stop-Process -Id $child.Id -Force
  $child.WaitForExit()
  $batch = Join-Path $testRoot 'backend wrapper.cmd'
  [IO.File]::WriteAllText($batch, ('@"' + (Get-Command pwsh).Source + '" -NoProfile -NonInteractive -EncodedCommand ' + $encoded))
  $child = Start-SymppWindowsBackend ([pscustomobject]@{ file = $batch; args = @() }) $testRoot $stdin $stdout $stderr
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while ((Get-Item $stdout).Length -eq 0 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
  $batchResult = Get-Content $stdout -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($batchResult.elevated -or $batchResult.value -ne $env:SYMPP_BACKEND_TEST_VALUE) { throw 'Batch backend launch lost its token or environment' }
  $result | Add-Member parent_elevated ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if ($ResultPath) { $result | ConvertTo-Json | Set-Content -LiteralPath $ResultPath }
  $result | ConvertTo-Json -Compress
} finally {
  if ($child -and -not $child.HasExited) { & taskkill.exe /PID $child.Id /T /F | Out-Null; $child.WaitForExit() }
  $env:SYMPP_BACKEND_TEST_VALUE = $previousTestValue
  $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
  if (-not $resolvedTestRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Test cleanup escaped temporary directory' }
  Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
}
