param(
  [string]$Action,
  [string]$SymppHome,
  [string]$SourceDatabase,
  [int]$Port = 21498,
  [switch]$ReplaceSnapshot,
  [switch]$Help
)

$ErrorActionPreference = "Stop"
$usage = 'sympp-offline.ps1 -Action Snapshot -SourceDatabase <file> -SymppHome <directory> [-ReplaceSnapshot] | -Action View -SymppHome <directory> [-Port 21498]'
if ($Help) { Write-Output $usage; exit 0 }
# The unchanged backup helper appends --database <stage> to its migration callback.
$migrationArguments = @($args)
if ($Action -notin @("Snapshot", "View", "Migrate") -or [string]::IsNullOrWhiteSpace($SymppHome) -or
    ($Action -eq "Snapshot" -and [string]::IsNullOrWhiteSpace($SourceDatabase)) -or
    ($Action -ne "Snapshot" -and ($SourceDatabase -or $ReplaceSnapshot)) -or
    ($Action -ne "Migrate" -and $migrationArguments.Count -gt 0) -or
    ($Action -eq "Migrate" -and ($migrationArguments.Count -ne 2 -or $migrationArguments[0] -ne "--database")) -or
    $Port -lt 1 -or $Port -gt 65535 -or $Port -in @(19998, 19999)) {
  Write-Output "error: Invalid arguments. $usage"
  exit 2
}

$previousEnvironment = @{}
$ledgerLock = $null
function Write-Diagnostic([string]$Message) { [Console]::Error.WriteLine($Message) }
try {
  if ($PSVersionTable.PSVersion.Major -lt 7 -or -not $IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne "X64") {
    throw "Offline viewing requires Windows x64 and PowerShell 7."
  }
  $offlineHome = [IO.Path]::GetFullPath($SymppHome)
  $ledgerRoot = Join-Path $offlineHome "ledger"
  $database = Join-Path $ledgerRoot "snapshot.sqlite3"
  $homeMarker = Join-Path $offlineHome ".sympp-offline-home"
  if (-not (Test-Path -LiteralPath $homeMarker -PathType Leaf)) {
    if ($Action -ne "Snapshot" -or ((Test-Path -LiteralPath $offlineHome) -and @(Get-ChildItem -LiteralPath $offlineHome -Force).Count -gt 0)) {
      throw "Choose a new, empty -SymppHome for Snapshot. Keep it separate from every online runtime home."
    }
    New-Item -ItemType Directory -Path $offlineHome -Force | Out-Null
    [IO.File]::WriteAllText($homeMarker, "offline-view-v1")
  }
  if ([IO.File]::ReadAllText($homeMarker) -ne "offline-view-v1") { throw "This is not an offline viewer home." }
  if ($Action -ne "Migrate") {
    try {
      $ledgerLock = [IO.File]::Open((Join-Path $offlineHome "offline.lock"), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch { throw "Stop the offline viewer before copying again; another Snapshot or View owns this home." }
  } else {
    $database = [IO.Path]::GetFullPath($migrationArguments[1])
    if ([IO.Path]::GetDirectoryName($database) -ine $ledgerRoot -or [IO.Path]::GetFileName($database) -notlike ".beta-snapshot-*.sqlite3") {
      throw "Migrate only accepts the temporary snapshot created inside this home's ledger directory."
    }
  }
  if ($Action -eq "Snapshot") {
    if (-not (Test-Path -LiteralPath $SourceDatabase -PathType Leaf)) { throw "The explicit -SourceDatabase does not exist." }
    $SourceDatabase = [IO.Path]::GetFullPath($SourceDatabase)
    $python = Get-Command python, python3 -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $python) { throw "Snapshot requires Python 3.9 or newer on PATH for SQLite's online backup." }
  }

  $logRoot = Join-Path $offlineHome "logs"
  $temporaryRoot = Join-Path $offlineHome "tmp"
  foreach ($directory in @($ledgerRoot, $logRoot, $temporaryRoot)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
  $environment = @{}
  foreach ($entry in Get-ChildItem Env:) {
    if ($entry.Name -match "^(SYMPP_|HERDR_|RELEASE_)" -or $entry.Name -in @("TEMP", "TMP", "TMPDIR", "ERL_FLAGS", "ERL_AFLAGS", "ELIXIR_ERL_OPTIONS")) {
      $environment[$entry.Name] = $null
    }
  }
  $isolated = @{
    SYMPP_HOME = $offlineHome; SYMPP_DATABASE = $database; SYMPP_OFFLINE_SANDBOX = "1"
    SYMPP_RUNTIME_ARTIFACT = "1"; SYMPP_RUNTIME_ARTIFACT_ACKNOWLEDGED = "1"
    SYMPP_BACKEND_PORT = [string]$Port; SYMPP_OPEN_DASHBOARD = "0"
    SYMPP_OPERATOR_CONFIG = Join-Path $offlineHome "operator-board.json"
    SYMPP_LOGS_ROOT = $logRoot; SYMPP_LOG_DIR = $logRoot
    TEMP = $temporaryRoot; TMP = $temporaryRoot; TMPDIR = $temporaryRoot; RELEASE_TMP = $temporaryRoot
    SYMPP_OFFLINE_EVAL = Join-Path $temporaryRoot "offline-eval.exs"
  }
  foreach ($name in $isolated.Keys) { $environment[$name] = $isolated[$name] }
  foreach ($name in $environment.Keys) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
    [Environment]::SetEnvironmentVariable($name, $environment[$name], "Process")
  }

  foreach ($name in @("sympp-launcher-runtime", "sympp-mcp-launcher-helpers", "sympp-mcp-artifact-manifest", "sympp-mcp-artifact-channel", "sympp-mcp-artifact-runtime")) {
    . (Join-Path $PSScriptRoot "$name.ps1")
  }
  $skillRoot = Split-Path -Parent $PSScriptRoot
  $install = Read-SymppPortableInstall $skillRoot
  if (-not $install) { throw "Use sympp-offline.ps1 from an installed Symphony++ skill bundle." }
  $prepared = Resolve-SymppPreparedArtifactRuntime $skillRoot $null $install.contract_fingerprint -ValidateOnly -PrepareArtifact
  if ($prepared.status -ne "artifact_selected" -or -not $prepared.runtime) { throw "The installed runtime artifact is unavailable. Re-add the skill and retry." }
  $runtime = $prepared.runtime
  $release = Join-Path $runtime.root "bin/symphony_elixir.bat"
  $verify = ':ok = SymphonyElixir.SymphonyPlusPlus.OfflineSandbox.verify!(System.fetch_env!(~s(SYMPP_DATABASE)))'
  # Keep Elixir's ! and other cmd.exe metacharacters out of the release batch command.
  $evaluateFile = 'Code.eval_file(System.get_env(~s(SYMPP_OFFLINE_EVAL)))'

  switch ($Action) {
    "Snapshot" {
      $arguments = @((Join-Path $PSScriptRoot "sympp_beta_snapshot.py"), "snapshot", $SourceDatabase, $database, "--sandbox-root", $ledgerRoot)
      if ($ReplaceSnapshot) { $arguments += "--replace" }
      $arguments += @("--migrate", (Join-Path $PSHOME "pwsh.exe"), "-NoProfile", "-File", $PSCommandPath, "-Action", "Migrate", "-SymppHome", $offlineHome)
      & $python.Source @arguments
      if ($LASTEXITCODE -ne 0) { throw "Snapshot failed; no new copy was published. Stop View before replacing an existing snapshot." }
      Write-Output "snapshot: $($database | ConvertTo-Json -Compress)"
      Write-Output "runtime: $($runtime.source_revision)"
    }
    "Migrate" {
      $expression = $verify + '; {:ok, _} = Application.ensure_all_started(:ecto_sql); alias SymphonyElixir.SymphonyPlusPlus.Repo; {:ok, repo} = Repo.start_link(Repo.child_options(database: System.fetch_env!(~s(SYMPP_DATABASE)))); try do :ok = SymphonyElixir.SymphonyPlusPlus.WorkRequests.Repository.migrate(Repo) after GenServer.stop(repo) end'
      [IO.File]::WriteAllText($env:SYMPP_OFFLINE_EVAL, $expression)
      try { & $release eval $evaluateFile *> (Join-Path $logRoot "migration.log") }
      finally { Remove-Item -LiteralPath $env:SYMPP_OFFLINE_EVAL -Force }
      if ($LASTEXITCODE -ne 0) { throw "Staged snapshot migration failed. See logs/migration.log in the offline home." }
    }
    "View" {
      [IO.File]::WriteAllText($env:SYMPP_OFFLINE_EVAL, $verify)
      try { & $release eval $evaluateFile *> (Join-Path $logRoot "verify.log") }
      finally { Remove-Item -LiteralPath $env:SYMPP_OFFLINE_EVAL -Force }
      if ($LASTEXITCODE -ne 0) { throw "View requires a marked snapshot. Run -Action Snapshot first; see logs/verify.log for details." }
      Write-Output "board: $(("http://127.0.0.1:$Port/sympp/board") | ConvertTo-Json -Compress)"
      Write-Output "stop: Press Ctrl+C in this terminal before refreshing the snapshot."
      $start = [Diagnostics.ProcessStartInfo]::new((Join-Path $PSHOME "pwsh.exe"))
      $start.UseShellExecute = $false
      # Only this foreground wrapper receives Ctrl+C; its finally owns the entire child tree.
      $start.CreateNoWindow = $true
      $start.RedirectStandardOutput = $true
      $start.RedirectStandardError = $true
      foreach ($argument in @("-NoProfile", "-File", $runtime.entrypoint, "-IUnderstandThatThisWillBeRunningWithoutTheUsualGuardrails", "-LogsRoot", $logRoot, "-Port", [string]$Port)) {
        $start.ArgumentList.Add($argument)
      }
      $child = $null
      try {
        $child = [Diagnostics.Process]::Start($start)
        $stdout = $child.StandardOutput.ReadToEndAsync()
        $stderr = $child.StandardError.ReadToEndAsync()
        Wait-Process -InputObject $child
        if ($child.ExitCode -ne 0) { throw "Offline viewer stopped with an error. See logs/viewer.log in its home." }
      } finally {
        if ($child) {
          try {
            if (-not $child.HasExited) { $child.Kill($true) }
            $child.WaitForExit()
            [IO.File]::WriteAllText((Join-Path $logRoot "viewer.log"), $stdout.GetAwaiter().GetResult() + $stderr.GetAwaiter().GetResult())
          } finally { $child.Dispose() }
        }
      }
    }
  }
} catch {
  Write-Output "error: $($_.Exception.Message | ConvertTo-Json -Compress)"
  exit 1
} finally {
  if ($ledgerLock) { $ledgerLock.Dispose() }
  foreach ($name in $previousEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process") }
}
