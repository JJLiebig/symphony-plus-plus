$ErrorActionPreference = "Stop"

function Resolve-SymppOptionalPath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) {
    return $null
  }

  return [System.IO.Path]::GetFullPath($Path)
}

function Resolve-SymppPluginHome {
  $configured = Resolve-SymppOptionalPath $env:SYMPP_HOME
  if ($configured) {
    return $configured
  }

  if (-not [string]::IsNullOrWhiteSpace($HOME)) {
    return [System.IO.Path]::GetFullPath((Join-Path $HOME ".agents/splusplus"))
  }

  $profileHome = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
  if (-not [string]::IsNullOrWhiteSpace($profileHome)) {
    return [System.IO.Path]::GetFullPath((Join-Path $profileHome ".agents/splusplus"))
  }

  return [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) ".agents/splusplus"))
}

function Normalize-SymppSourceRevision([string]$Revision) {
  if ([string]::IsNullOrWhiteSpace($Revision)) {
    return $null
  }

  $normalized = $Revision.Trim().ToLowerInvariant()
  if ($normalized -match "^[0-9a-f]{40}$") {
    return $normalized
  }

  return $null
}

function Get-SymppGitHeadRevision([string]$RepoRoot) {
  $git = Get-Command git -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $git) {
    return $null
  }

  try {
    $output = @(& $git.Source @("-C", $RepoRoot, "rev-parse", "--verify", "HEAD") 2>$null)
    if ($LASTEXITCODE -eq 0 -and $output.Count -gt 0) {
      return Normalize-SymppSourceRevision ([string]$output[0])
    }
  } catch {
  }

  return $null
}

function Get-SymppMarketplaceInstallRevision([string]$RepoRoot) {
  $installPath = Join-Path $RepoRoot ".codex-marketplace-install.json"
  if (-not (Test-Path -LiteralPath $installPath)) {
    return $null
  }

  try {
    $install = Get-Content -LiteralPath $installPath -Raw | ConvertFrom-Json
    return Normalize-SymppSourceRevision ([string]$install.revision)
  } catch {
    return $null
  }
}

function Get-SymppPinnedSourceRevision([string]$Root) {
  if ([string]::IsNullOrWhiteSpace($Root)) {
    return $null
  }

  $revisionPath = Join-Path $Root ".sympp-source-revision"
  if (-not (Test-Path -LiteralPath $revisionPath)) {
    return $null
  }

  try {
    return Normalize-SymppSourceRevision (Get-Content -LiteralPath $revisionPath -Raw)
  } catch {
    return $null
  }
}

function Resolve-SymppSourceRevision([string]$RepoRoot, [string]$PluginRoot = $null) {
  $gitRevision = Get-SymppGitHeadRevision $RepoRoot
  if ($gitRevision) {
    return $gitRevision
  }

  $installRevision = Get-SymppMarketplaceInstallRevision $RepoRoot
  if ($installRevision) {
    return $installRevision
  }

  return Get-SymppPinnedSourceRevision $PluginRoot
}

function Get-SymppStablePathKey([string]$Value) {
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
    $hash = $sha256.ComputeHash($bytes)
    return (($hash | Select-Object -First 6 | ForEach-Object { $_.ToString("x2") }) -join "")
  } finally {
    $sha256.Dispose()
  }
}

function Test-SymppMiseLauncherAvailable([string]$ElixirDir, [string]$MiseCommand) {
  if (-not (Test-Path -LiteralPath (Join-Path $ElixirDir "mise.toml"))) {
    return $false
  }
  if (-not (Get-Command $MiseCommand -ErrorAction SilentlyContinue)) {
    return $false
  }

  Push-Location -LiteralPath $ElixirDir
  try {
    & $MiseCommand @("exec", "--", "mix", "--version") *> $null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  } finally {
    Pop-Location
  }
}

function Resolve-SymppDefaultLauncher([string]$ElixirDir, [string]$MiseCommand) {
  if (Test-SymppMiseLauncherAvailable $ElixirDir $MiseCommand) {
    return "mise"
  }

  return "direct"
}

function Test-SymppWindowsPlatform {
  return [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
}

function Get-SymppWindowsProcessorArchitecture {
  $arch = [Environment]::GetEnvironmentVariable("PROCESSOR_ARCHITEW6432", "Process")
  if ([string]::IsNullOrWhiteSpace($arch)) {
    $arch = [Environment]::GetEnvironmentVariable("PROCESSOR_ARCHITECTURE", "Process")
  }
  if (-not [string]::IsNullOrWhiteSpace($arch)) {
    return $arch
  }

  try {
    $runtimeArch = [System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
    if (-not [string]::IsNullOrWhiteSpace($runtimeArch)) {
      return $runtimeArch
    }
  } catch {
  }

  if ([IntPtr]::Size -eq 8) {
    return "AMD64"
  }

  return "x86"
}

function Convert-SymppProcessorArchitectureToTargetArch([string]$Architecture) {
  if ([string]::IsNullOrWhiteSpace($Architecture)) {
    return $null
  }

  switch ($Architecture.Trim().ToLowerInvariant()) {
    "amd64" { return "x86_64" }
    "x64" { return "x86_64" }
    "arm64" { return "aarch64" }
    "aarch64" { return "aarch64" }
    "x86" { return "x86" }
    "ia64" { return "ia64" }
    default { return $null }
  }
}

function Get-SymppRuntimeOsKey {
  if ([System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows)) {
    return "windows"
  }
  if ([System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Linux)) {
    return "linux"
  }
  if ([System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::OSX)) {
    return "macos"
  }

  return $null
}

function Get-SymppRuntimeArchKey {
  $architecture = $null
  if (Test-SymppWindowsPlatform) {
    $architecture = Get-SymppWindowsProcessorArchitecture
  } else {
    try {
      $architecture = [System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
    } catch {
    }
  }

  return Convert-SymppProcessorArchitectureToTargetArch $architecture
}

function Get-SymppRuntimeAbiKey {
  if (Test-SymppWindowsPlatform) {
    return "msvc"
  }
  if ([System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Linux)) {
    if ([string]::IsNullOrWhiteSpace($env:TARGET_ABI)) {
      return "gnu"
    }

    return $env:TARGET_ABI.Trim().ToLowerInvariant()
  }

  if ([string]::IsNullOrWhiteSpace($env:TARGET_ABI)) {
    return $null
  }

  return $env:TARGET_ABI.Trim().ToLowerInvariant()
}

function Get-SymppRuntimePlatformKey {
  $os = Get-SymppRuntimeOsKey
  $arch = Get-SymppRuntimeArchKey
  if ([string]::IsNullOrWhiteSpace($os) -or [string]::IsNullOrWhiteSpace($arch)) {
    return $null
  }

  return "$os-$arch"
}

function Set-SymppWindowsNativeTargetEnvironment {
  if (-not (Test-SymppWindowsPlatform)) {
    return
  }

  $processorArchitecture = Get-SymppWindowsProcessorArchitecture
  $processArchitecture = [Environment]::GetEnvironmentVariable("PROCESSOR_ARCHITECTURE", "Process")
  $nativeArchitecture = [Environment]::GetEnvironmentVariable("PROCESSOR_ARCHITEW6432", "Process")
  if ([string]::IsNullOrWhiteSpace($processArchitecture) -or
      (-not [string]::IsNullOrWhiteSpace($nativeArchitecture) -and $processArchitecture.Trim() -ne $processorArchitecture.Trim())) {
    [Environment]::SetEnvironmentVariable("PROCESSOR_ARCHITECTURE", $processorArchitecture, "Process")
    $env:PROCESSOR_ARCHITECTURE = $processorArchitecture
  }

  $targetArch = Convert-SymppProcessorArchitectureToTargetArch $processorArchitecture
  if (-not [string]::IsNullOrWhiteSpace($targetArch) -and
      [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable("TARGET_ARCH", "Process"))) {
    [Environment]::SetEnvironmentVariable("TARGET_ARCH", $targetArch, "Process")
    $env:TARGET_ARCH = $targetArch
  }

  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable("TARGET_OS", "Process"))) {
    [Environment]::SetEnvironmentVariable("TARGET_OS", "windows", "Process")
    $env:TARGET_OS = "windows"
  }

  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable("TARGET_ABI", "Process"))) {
    [Environment]::SetEnvironmentVariable("TARGET_ABI", "msvc", "Process")
    $env:TARGET_ABI = "msvc"
  }
}

function Resolve-SymppDefaultMixBuildRoot([string]$RepoRoot, [string]$Launcher, [string]$Purpose, [string]$PluginRoot = $null) {
  $sourceKey = Resolve-SymppSourceRevision $RepoRoot $PluginRoot
  if (-not $sourceKey) {
    $sourceKey = "unknown"
  }

  $shortSourceKey = $sourceKey.Substring(0, [Math]::Min(12, $sourceKey.Length))
  $pathKey = Get-SymppStablePathKey ([System.IO.Path]::GetFullPath($RepoRoot))
  $launcherKey = $Launcher -replace "[^A-Za-z0-9_.-]", "_"
  return [System.IO.Path]::GetFullPath((Join-Path (Resolve-SymppPluginHome) "build/$Purpose/$launcherKey/$shortSourceKey-$pathKey"))
}

function Set-SymppDefaultMixBuildRoot([string]$RepoRoot, [string]$Launcher, [string]$Purpose, [string]$PluginRoot = $null) {
  if (-not [string]::IsNullOrWhiteSpace($env:MIX_BUILD_ROOT)) {
    return
  }

  $buildRoot = Resolve-SymppDefaultMixBuildRoot $RepoRoot $Launcher $Purpose $PluginRoot
  New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null
  $env:MIX_BUILD_ROOT = $buildRoot
  [Environment]::SetEnvironmentVariable("MIX_BUILD_ROOT", $buildRoot, "Process")
}
