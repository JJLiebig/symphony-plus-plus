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
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$currentProcess = [Diagnostics.Process]::GetCurrentProcess()
$priority = $currentProcess.GetType().GetProperty('PriorityClass').GetValue($currentProcess)
@{
  pid = $PID
  sid = $identity.User.Value
  elevated = ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  priority = $priority.ToString()
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
  while ((-not (Test-Path $stdout) -or (Get-Item $stdout).Length -eq 0) -and -not $child.HasExited -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
  $result = Get-Content $stdout -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($null -eq $result) { throw 'Backend did not emit metadata; inspect captured stderr' }
  if ($result.elevated) { throw 'Backend inherited elevation' }
  if ($result.pid -ne $child.Id) { throw 'Returned PID is not the launched process' }
  if ($result.priority -ne 'BelowNormal') { throw 'Backend did not preserve caller priority' }
  if ($result.directory -ne $testRoot -or -not $result.stdin_eof) { throw 'Working directory or stdin redirect was lost' }
  if ($result.value -ne $env:SYMPP_BACKEND_TEST_VALUE) { throw 'Backend environment was changed' }
  if ((Get-Content $stderr -Raw).Trim() -ne 'redirected error') { throw 'Stderr was not redirected' }
  $cleanupScript = '$ErrorActionPreference="Stop"; $p=[Diagnostics.Process]::GetProcessById(' + $child.Id + '); $null=$p.GetType().GetProperty("PriorityClass").GetValue($p); Stop-Process -Id $p.Id -Force; "normal-cleanup"'
  $cleanupEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cleanupScript))
  $cleanupCommand = [pscustomobject]@{ file = (Get-Command pwsh).Source; args = @('-NoProfile', '-NonInteractive', '-EncodedCommand', $cleanupEncoded) }
  $cleanup = Start-SymppWindowsBackend $cleanupCommand $testRoot $stdin (Join-Path $testRoot 'cleanup.out') (Join-Path $testRoot 'cleanup.err')
  if (-not $cleanup.WaitForExit(10000)) { & taskkill.exe /PID $cleanup.Id /T /F | Out-Null; throw 'Normal peer cleanup timed out' }
  if ((Get-Content (Join-Path $testRoot 'cleanup.out') -Raw).Trim() -ne 'normal-cleanup') { throw 'Normal peer could not query and stop the backend' }
  $child.WaitForExit()
  $batch = Join-Path $testRoot 'backend wrapper.cmd'
  [IO.File]::WriteAllText($batch, ('@"' + (Get-Command pwsh).Source + '" -NoProfile -NonInteractive -EncodedCommand ' + $encoded))
  $child = Start-SymppWindowsBackend ([pscustomobject]@{ file = $batch; args = @() }) $testRoot $stdin $stdout $stderr
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while ((Get-Item $stdout).Length -eq 0 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
  $batchResult = Get-Content $stdout -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($batchResult.elevated -or $batchResult.value -ne $env:SYMPP_BACKEND_TEST_VALUE) { throw 'Batch backend launch lost its token or environment' }
  $result | Add-Member parent_elevated ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if ($ResultPath) { $result | ConvertTo-Json | Set-Content -LiteralPath $ResultPath -Encoding UTF8 }
  $result | ConvertTo-Json -Compress
} catch {
  if ($ResultPath) {
    @{
      error = $_.ToString(); detail = $_.Exception.ToString(); stack = $_.ScriptStackTrace
      child_id = $child.Id; reported_id = $result.pid; child_type = $(if ($child) { $child.GetType().FullName })
      child_exited = $(if ($child) { $child.HasExited }); exit_code = $(if ($child -and $child.HasExited) { $child.ExitCode })
      command = $command.file
      parent_elevated = ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
      stdout = $(if (Test-Path $stdout) { Get-Content -LiteralPath $stdout -Raw -Encoding UTF8 -ErrorAction SilentlyContinue })
      stdout_length = $(if (Test-Path $stdout) { (Get-Item -LiteralPath $stdout).Length })
      stderr = $(if (Test-Path $stderr) { Get-Content -LiteralPath $stderr -Raw -Encoding UTF8 -ErrorAction SilentlyContinue })
    } | ConvertTo-Json | Set-Content -LiteralPath $ResultPath -Encoding UTF8
  }
  throw
} finally {
  if ($child -and -not $child.HasExited) { & taskkill.exe /PID $child.Id /T /F | Out-Null; $child.WaitForExit() }
  $env:SYMPP_BACKEND_TEST_VALUE = $previousTestValue
  $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
  if (-not $resolvedTestRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Test cleanup escaped temporary directory' }
  Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
}
