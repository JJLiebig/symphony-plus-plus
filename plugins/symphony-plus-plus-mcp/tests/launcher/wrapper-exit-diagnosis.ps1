param([int]$Trials = 20, [string]$OutputRoot = 'artifacts/wrapper-diagnosis')

$ErrorActionPreference = 'Stop'
[Diagnostics.Process]::GetCurrentProcess().PriorityClass = [Diagnostics.ProcessPriorityClass]::BelowNormal
$receiptRoot = [IO.Path]::GetFullPath($OutputRoot)
New-Item -ItemType Directory -Force -Path $receiptRoot | Out-Null
$receipts = [Collections.Generic.List[object]]::new()
$failure = $null
foreach ($trial in 1..$Trials) {
  $trialRoot = Join-Path $receiptRoot ('trial-' + $trial)
  New-Item -ItemType Directory -Path $trialRoot | Out-Null
  $pendingBase = Join-Path ([IO.Path]::GetTempPath()) ('sympp-wrapper-diagnosis-' + [guid]::NewGuid().ToString('N'))
  $pendingRoot = Join-Path $pendingBase 'rt/windows-x64/0123456789abcdef/runtime'
  $leader = $null; $wrapperProcess = $null; $wrapperPid = 0; $ownedPid = 0
  $receipt = [ordered]@{ trial = $trial; success = $false; phase = 'setup'; observations = @(); wrapper_pid = 0; child_pid = 0; wrapper_exit = $null; error = $null }
  $observations = [Collections.Generic.List[object]]::new()
  try {
    New-Item -ItemType Directory -Path $pendingRoot -Force | Out-Null
    $runtimeCmd = Join-Path $pendingRoot 'start-runtime.cmd'
    $wrapperScript = Join-Path $pendingRoot 'wrapper.ps1'
    $wrapperReady = Join-Path $pendingRoot 'wrapper-ready'
    $wrapperRelease = Join-Path $pendingRoot 'wrapper-release'
    $leaderCmd = Join-Path $pendingRoot 'leader.cmd'
    Set-Content -LiteralPath $runtimeCmd -Value "@echo off`r`npowershell.exe -NoProfile -NonInteractive -Command `"Start-Sleep -Seconds 60`"" -NoNewline
    Set-Content -LiteralPath $wrapperScript -Value @(
      '$ErrorActionPreference = "Stop"'
      'function Phase([string]$Name) { [IO.File]::WriteAllText((Join-Path $env:SYMPP_DIAG_RECEIPTS ($Name + ".json")), (@{ phase = $Name; pid = $PID; ticks = [DateTimeOffset]::UtcNow.Ticks } | ConvertTo-Json -Compress)) }'
      'Phase "wrapper-started"'
      '[IO.File]::WriteAllText($env:SYMPP_TEST_WRAPPER_READY, "ready")'
      'while (-not (Test-Path -LiteralPath $env:SYMPP_TEST_WRAPPER_RELEASE)) { Start-Sleep -Milliseconds 25 }'
      'Phase "before-launch"'
      'Start-Process cmd.exe -ArgumentList @("/d", "/s", "/c", "call `"$env:SYMPP_TEST_RUNTIME_CMD`"") -WorkingDirectory $env:SYMPP_TEST_RUNTIME_ROOT'
      'Phase "after-launch"'
      'Phase "script-complete"'
    )
    $wrapperOut = Join-Path $trialRoot 'wrapper.stdout.log'
    $wrapperErr = Join-Path $trialRoot 'wrapper.stderr.log'
    Set-Content -LiteralPath $leaderCmd -Value "@echo off`r`npowershell.exe -NoProfile -NonInteractive -File `"%~dp0wrapper.ps1`" 1>`"$wrapperOut`" 2>`"$wrapperErr`"`r`npowershell.exe -NoProfile -NonInteractive -Command `"Start-Sleep -Seconds 60`"" -NoNewline
    $env:SYMPP_TEST_WRAPPER_READY = $wrapperReady; $env:SYMPP_TEST_WRAPPER_RELEASE = $wrapperRelease
    $env:SYMPP_TEST_RUNTIME_CMD = $runtimeCmd; $env:SYMPP_TEST_RUNTIME_ROOT = $pendingRoot; $env:SYMPP_DIAG_RECEIPTS = $trialRoot
    $leader = Start-Process cmd.exe -ArgumentList @('/d', '/s', '/c', "call `"$leaderCmd`"") -WorkingDirectory $pendingRoot -WindowStyle Hidden -PassThru
    $receipt.leader_pid = $leader.Id
    $receipt.phase = 'wrapper-ready'
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath $wrapperReady) -and [DateTimeOffset]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 25 }
    $wrapper = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($leader.Id)" -ErrorAction SilentlyContinue | Where-Object { [string]$_.CommandLine -match 'wrapper\.ps1' } | Select-Object -First 1
    if ($null -eq $wrapper) { throw 'Published wrapper discovery failed.' }
    $wrapperPid = [int]$wrapper.ProcessId; $receipt.wrapper_pid = $wrapperPid
    $wrapperProcess = Get-Process -Id $wrapperPid
    $receipt.wrapper_start_ticks = $wrapperProcess.StartTime.ToUniversalTime().Ticks
    [void]$wrapperProcess.Handle
    Set-Content -LiteralPath $wrapperRelease -Value 'ready' -NoNewline
    $receipt.phase = 'child-discovery'
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(10)
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $owned = $null
    while ($null -eq $owned -and [DateTimeOffset]::UtcNow -lt $deadline) {
      $queryWatch = [Diagnostics.Stopwatch]::StartNew()
      $rows = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$wrapperPid" -ErrorAction SilentlyContinue)
      $observations.Add([pscustomobject]@{ elapsed_ms = $watch.ElapsedMilliseconds; query_ms = $queryWatch.ElapsedMilliseconds; wrapper_exited = $wrapperProcess.HasExited; rows = @($rows | Select-Object ProcessId, ParentProcessId, CreationDate, CommandLine) })
      $owned = $rows | Where-Object { [string]$_.CommandLine -match 'start-runtime\.cmd' } | Select-Object -First 1
      if ($null -eq $owned) { Start-Sleep -Milliseconds 25 }
    }
    $receipt.discovery_ms = $watch.ElapsedMilliseconds
    if ($null -eq $owned) { throw 'Backend child CIM discovery failed.' }
    $ownedPid = [int]$owned.ProcessId; $receipt.child_pid = $ownedPid
    $receipt.phase = 'wrapper-exit'
    $exitWatch = [Diagnostics.Stopwatch]::StartNew()
    $receipt.wrapper_exit = $wrapperProcess.WaitForExit(10000)
    $receipt.exit_wait_ms = $exitWatch.ElapsedMilliseconds
    if (-not $receipt.wrapper_exit) { throw 'Published wrapper did not exit within its independent ten-second allowance.' }
    $receipt.wrapper_exit_code = $wrapperProcess.ExitCode
    $receipt.child_after_wrapper_exit = @(Get-CimInstance Win32_Process -Filter "ProcessId=$ownedPid" -ErrorAction SilentlyContinue | Select-Object ProcessId, ParentProcessId, CreationDate, CommandLine)
    if ($receipt.child_after_wrapper_exit.Count -ne 1) { throw 'Backend child was not alive after wrapper exit.' }
    $receipt.success = $true; $receipt.phase = 'complete'
  } catch {
    $receipt.error = $_.Exception.Message
    $failure = $receipt.error
    $trackedIds = @($wrapperPid, $ownedPid, $(if ($leader) { $leader.Id })) | Where-Object { $_ -gt 0 }
    $receipt.failure_snapshot = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessId -in $trackedIds -or $_.ParentProcessId -in $trackedIds } | Select-Object ProcessId, ParentProcessId, CreationDate, CommandLine)
  } finally {
    $receipt.observations = @($observations.ToArray())
    $receipt.phases = @(Get-ChildItem -LiteralPath $trialRoot -Filter '*.json' -File | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json })
    $receipt | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $trialRoot 'receipt.json')
    $receipts.Add([pscustomobject]$receipt)
    foreach ($processId in @($ownedPid, $wrapperPid, $(if ($leader) { $leader.Id }))) {
      if ($processId -and (Get-Process -Id $processId -ErrorAction SilentlyContinue)) { & taskkill.exe /PID $processId /T /F 2>$null | Out-Null }
    }
    if ($wrapperProcess) { $wrapperProcess.Dispose() }; if ($leader) { $leader.Dispose() }
    Remove-Item Env:SYMPP_TEST_WRAPPER_READY,Env:SYMPP_TEST_WRAPPER_RELEASE,Env:SYMPP_TEST_RUNTIME_CMD,Env:SYMPP_TEST_RUNTIME_ROOT,Env:SYMPP_DIAG_RECEIPTS -ErrorAction SilentlyContinue
    if (-not [IO.Path]::GetFullPath($pendingBase).StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase)) { throw 'Diagnostic cleanup escaped its temporary root.' }
    Remove-Item -LiteralPath $pendingBase -Recurse -Force -ErrorAction SilentlyContinue
  }
  Write-Host ($receipt | ConvertTo-Json -Depth 10 -Compress)
  if ($failure) { break }
}
[pscustomobject]@{ requested_trials = $Trials; completed_trials = $receipts.Count; passed_trials = @($receipts | Where-Object success).Count; first_failure = $failure } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $receiptRoot 'summary.json')
if ($failure) { throw "Wrapper diagnosis stopped at first failure: $failure" }
