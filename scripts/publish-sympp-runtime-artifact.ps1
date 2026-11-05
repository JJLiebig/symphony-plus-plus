[CmdletBinding()]
param(
  [string]$ManifestPath,
  [string[]]$ManifestPaths = @(),
  [string]$ManifestDir = "",
  [string[]]$RequiredPlatforms = @("linux-x64", "windows-x64", "macos-arm64"),
  [string]$Channel = "stable",
  [string]$ManifestVersion = "",
  [string]$Repository = "",
  [string]$ReleaseTag = "",
  [string]$PublishedBaseUrl = "",
  [string]$PublishedArtifactUrl = "",
  [string]$PublishedManifestUrl = "",
  [string]$ChannelOutputPath = "artifacts/sympp-runtime-artifacts.json",
  [switch]$DryRun,
  [switch]$Help
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Show-Usage {
  @"
Validates built sympp runtime artifacts before advancing a release channel.

Single-manifest mode remains available for PR/main validation. Release-channel
mode validates every required platform, verifies local SHA-256 values, and
writes one aggregate manifest with durable release asset URLs.

Usage:
  scripts/publish-sympp-runtime-artifact.ps1 -ManifestPath <manifest.json> -DryRun
  scripts/publish-sympp-runtime-artifact.ps1 -ManifestDir <dir> -PublishedBaseUrl <release-url> -ReleaseTag <tag> [-Channel stable]
"@ | Write-Host
}

if ($Help) {
  Show-Usage
  exit 0
}

function Resolve-RepoRoot {
  Split-Path -Parent $PSScriptRoot
}

function Write-JsonFile([string]$Path, $Value) {
  $json = ($Value | ConvertTo-Json -Depth 30) + [Environment]::NewLine
  [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding $false))
}

function Get-FileSha256([string]$Path) {
  (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Normalize-Platform([string]$Platform) {
  if ([string]::IsNullOrWhiteSpace($Platform)) {
    throw "Artifact manifest platform is required."
  }

  $parts = @($Platform.Trim().ToLowerInvariant() -split "-")
  if ($parts.Count -lt 2) {
    throw "Artifact manifest platform must look like '<os>-<arch>': $Platform"
  }

  $arch = switch ($parts[1]) {
    { $_ -in @("x64", "x86_64", "amd64") } { "x86_64"; break }
    { $_ -in @("arm64", "aarch64") } { "aarch64"; break }
    default { $parts[1] }
  }
  $abi = if ($parts.Count -ge 3) { $parts[2] } elseif ($parts[0] -eq "windows") { "msvc" } else { $null }

  [pscustomobject]@{
    key = "$($parts[0])-$($parts[1])"
    os = $parts[0]
    arch = $arch
    abi = $abi
  }
}

function Require-Property($Object, [string]$Name, [string]$Label) {
  if ($null -eq $Object -or -not ($Object.PSObject.Properties.Name -contains $Name)) {
    throw "$Label is missing required property '$Name'."
  }

  $Object.$Name
}

function Require-Url([string]$Value, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Value)) {
    throw "$Label is required for release-channel advancement."
  }

  $uri = [Uri]$Value
  if ($uri.Scheme -notin @("https", "http") -or [string]::IsNullOrWhiteSpace($uri.Host)) {
    throw "$Label must be an http(s) URL."
  }
}

function Normalize-McpContractFingerprint([string]$Fingerprint) {
  if ([string]::IsNullOrWhiteSpace($Fingerprint)) {
    return $null
  }

  $normalized = $Fingerprint.Trim().ToLowerInvariant()
  if ($normalized -match '^[0-9a-f]{64}$') {
    return $normalized
  }

  return $null
}

function Resolve-McpContractFingerprint($Manifest) {
  if ($Manifest.PSObject.Properties.Name -contains "mcp_contract_fingerprint") {
    $fingerprint = Normalize-McpContractFingerprint ([string]$Manifest.mcp_contract_fingerprint)
    if ($fingerprint) {
      return $fingerprint
    }
  }

  if ($Manifest.PSObject.Properties.Name -contains "launcher_contract" -and $null -ne $Manifest.launcher_contract) {
    foreach ($name in @("mcp_contract_fingerprint", "contract_fingerprint")) {
      if ($Manifest.launcher_contract.PSObject.Properties.Name -contains $name) {
        $fingerprint = Normalize-McpContractFingerprint ([string]$Manifest.launcher_contract.$name)
        if ($fingerprint) {
          return $fingerprint
        }
      }
    }
  }

  if ($Manifest.PSObject.Properties.Name -contains "contract_fingerprint") {
    $fingerprint = Normalize-McpContractFingerprint ([string]$Manifest.contract_fingerprint)
    if ($fingerprint) {
      return $fingerprint
    }
  }

  return $null
}

function New-LauncherContract($Manifest, [string]$McpContractFingerprint) {
  $contract = [ordered]@{}
  if ($Manifest.PSObject.Properties.Name -contains "launcher_contract" -and $null -ne $Manifest.launcher_contract) {
    foreach ($property in $Manifest.launcher_contract.PSObject.Properties) {
      if ($property.Name -notin @("workflow", "workflow_path")) {
        $contract[$property.Name] = $property.Value
      }
    }
  }

  $contract["mcp_contract_fingerprint"] = $McpContractFingerprint
  $contract["contract_fingerprint"] = $McpContractFingerprint
  return $contract
}

function Resolve-PluginIdentity($Manifest, [string]$SourceRevision) {
  $plugin = Require-Property $Manifest "plugin" "Artifact manifest"
  $name = ([string](Require-Property $plugin "name" "Artifact manifest plugin")).Trim()
  $version = ([string](Require-Property $plugin "version" "Artifact manifest plugin")).Trim()
  if ([string]::IsNullOrWhiteSpace($name) -or [string]::IsNullOrWhiteSpace($version)) {
    throw "Artifact manifest plugin must declare name and version."
  }

  $identity = [ordered]@{
    name = $name
    version = $version
  }
  if ($plugin.PSObject.Properties.Name -contains "marketplace") {
    $identity["marketplace"] = [string]$plugin.marketplace
  }
  if ($plugin.PSObject.Properties.Name -contains "packages") {
    $identity["packages"] = @($plugin.packages)
  }
  $identity["source_revision"] = $SourceRevision

  $identity
}

function Get-PluginIdentityKey($Plugin) {
  $packages = if ($Plugin.Contains("packages")) { @($Plugin["packages"]) -join "," } else { "" }
  "$($Plugin["marketplace"])|$($Plugin["name"])|$($Plugin["version"])|$packages"
}

function Get-ManifestFiles {
  $files = New-Object System.Collections.Generic.List[string]
  if (-not [string]::IsNullOrWhiteSpace($ManifestPath)) {
    $files.Add($ManifestPath)
  }
  foreach ($path in @($ManifestPaths)) {
    if (-not [string]::IsNullOrWhiteSpace($path)) {
      $files.Add($path)
    }
  }
  if (-not [string]::IsNullOrWhiteSpace($ManifestDir)) {
    foreach ($item in @(Get-ChildItem -LiteralPath $ManifestDir -Filter "*.manifest.json" -File | Sort-Object Name)) {
      $files.Add($item.FullName)
    }
  }

  @($files | ForEach-Object { (Resolve-Path -LiteralPath $_).Path } | Select-Object -Unique)
}

function Read-BuiltManifest([string]$Path) {
  $fullPath = (Resolve-Path -LiteralPath $Path).Path
  $manifest = Get-Content -LiteralPath $fullPath -Raw | ConvertFrom-Json
  if ((Require-Property $manifest "status" "Artifact manifest") -ne "built") {
    throw "Artifact manifest status must be 'built': $fullPath"
  }

  $revision = [string](Require-Property $manifest "source_revision" "Artifact manifest")
  if ($revision -notmatch '^[0-9a-f]{40}$') {
    throw "Artifact manifest source_revision must be a 40-character SHA: $fullPath"
  }

  $platform = Normalize-Platform ([string](Require-Property $manifest "platform" "Artifact manifest"))
  $artifact = Require-Property $manifest "artifact" "Artifact manifest"
  $artifactFile = [string](Require-Property $artifact "file" "Artifact manifest artifact")
  $expectedSha = ([string](Require-Property $artifact "sha256" "Artifact manifest artifact")).ToLowerInvariant()
  if ($expectedSha -notmatch '^[0-9a-f]{64}$') {
    throw "Artifact manifest artifact.sha256 must be a SHA256 hex digest: $fullPath"
  }

  $artifactPath = Join-Path (Split-Path -Parent $fullPath) $artifactFile
  if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
    throw "Artifact package referenced by manifest is missing: $artifactPath"
  }

  $actualSha = Get-FileSha256 $artifactPath
  if ($actualSha -ne $expectedSha) {
    throw "Artifact package SHA256 mismatch for $artifactPath. Expected $expectedSha, got $actualSha."
  }

  $dashboard = Require-Property $manifest "dashboard" "Artifact manifest"
  $dashboardFingerprint = [string](Require-Property $dashboard "fingerprint" "Artifact manifest dashboard")
  if ($dashboardFingerprint -notmatch '^[0-9a-f]{64}$') {
    throw "Artifact manifest dashboard.fingerprint must be a SHA256 hex digest: $fullPath"
  }

  $contractFingerprint = Resolve-McpContractFingerprint $manifest
  if (-not $contractFingerprint) {
    throw "Artifact manifest must declare mcp_contract_fingerprint or contract_fingerprint: $fullPath"
  }
  $pluginIdentity = Resolve-PluginIdentity $manifest $revision

  [pscustomobject]@{
    path = $fullPath
    manifest = $manifest
    manifest_sha256 = Get-FileSha256 $fullPath
    revision = $revision
    platform = $platform
    artifact_path = (Resolve-Path -LiteralPath $artifactPath).Path
    artifact_file = Split-Path -Leaf $artifactPath
    artifact_sha256 = $expectedSha
    artifact_size = (Get-Item -LiteralPath $artifactPath).Length
    contract_fingerprint = $contractFingerprint
    launcher_contract = New-LauncherContract $manifest $contractFingerprint
    plugin = $pluginIdentity
    plugin_key = Get-PluginIdentityKey $pluginIdentity
  }
}

function New-AssetUrl([string]$BaseUrl, [string]$FileName) {
  $escaped = [Uri]::EscapeDataString($FileName).Replace("%2D", "-").Replace("%2E", ".").Replace("%5F", "_")
  "$($BaseUrl.TrimEnd('/'))/$escaped"
}

$repoRoot = Resolve-RepoRoot
$manifestFiles = @(Get-ManifestFiles)
if ($manifestFiles.Count -eq 0) {
  throw "At least one artifact manifest is required."
}

$records = @($manifestFiles | ForEach-Object { Read-BuiltManifest $_ })

if ($records.Count -eq 1 -and [string]::IsNullOrWhiteSpace($PublishedBaseUrl)) {
  $record = $records[0]
  if ($DryRun) {
    Write-Host "Dry run: validated $($record.path) and $($record.artifact_path) for channel '$Channel'."
    exit 0
  }

  Require-Url $PublishedArtifactUrl "PublishedArtifactUrl"
  Require-Url $PublishedManifestUrl "PublishedManifestUrl"

  $channelDoc = [ordered]@{
    schema_version = 1
    channel = $Channel
    advanced_at = (Get-Date).ToUniversalTime().ToString("o")
    source_revision = $record.revision
    plugin = $record.plugin
    mcp_contract_fingerprint = $record.contract_fingerprint
    contract_fingerprint = $record.contract_fingerprint
    platform = $record.platform.key
    artifact = [ordered]@{
      url = $PublishedArtifactUrl
      sha256 = $record.artifact_sha256
      size_bytes = $record.artifact_size
      mcp_contract_fingerprint = $record.contract_fingerprint
      contract_fingerprint = $record.contract_fingerprint
    }
    manifest = [ordered]@{
      url = $PublishedManifestUrl
      sha256 = $record.manifest_sha256
    }
    launcher_contract = $record.launcher_contract
  }

  $channelPath = if ([System.IO.Path]::IsPathRooted($ChannelOutputPath)) { $ChannelOutputPath } else { Join-Path $repoRoot $ChannelOutputPath }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $channelPath) | Out-Null
  Write-JsonFile $channelPath $channelDoc
  Write-Host "Wrote release channel manifest $channelPath"
  exit 0
}

Require-Url $PublishedBaseUrl "PublishedBaseUrl"
$revisions = @($records | ForEach-Object { $_.revision } | Select-Object -Unique)
if ($revisions.Count -ne 1) {
  throw "Release-channel artifacts must share one source revision; found $($revisions -join ', ')."
}
$sourceRevision = $revisions[0]

$recordsByPlatform = @{}
foreach ($record in $records) {
  if ($recordsByPlatform.ContainsKey($record.platform.key)) {
    throw "Release-channel artifacts contain duplicate platform '$($record.platform.key)'."
  }
  $recordsByPlatform[$record.platform.key] = $record
}

$required = @($RequiredPlatforms | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object { (Normalize-Platform $_).key })
foreach ($platform in $required) {
  if (-not $recordsByPlatform.ContainsKey($platform)) {
    throw "Release-channel artifact is missing required platform '$platform'."
  }
}

$pluginKeys = @($records | ForEach-Object { $_.plugin_key } | Select-Object -Unique)
if ($pluginKeys.Count -ne 1) {
  throw "Release-channel artifacts must share one plugin identity."
}
$plugin = [ordered]@{}
foreach ($property in $records[0].plugin.GetEnumerator()) {
  $plugin[$property.Key] = $property.Value
}
$plugin["source_revision"] = $sourceRevision
$contractFingerprints = @($records | ForEach-Object { $_.contract_fingerprint } | Select-Object -Unique)
if ($contractFingerprints.Count -ne 1) {
  throw "Release-channel artifacts must share one MCP contract fingerprint; found $($contractFingerprints -join ', ')."
}
$contractFingerprint = $contractFingerprints[0]
$manifestVersionValue = if ([string]::IsNullOrWhiteSpace($ManifestVersion)) {
  if ([string]::IsNullOrWhiteSpace($ReleaseTag)) { $sourceRevision.Substring(0, 12) } else { $ReleaseTag }
} else {
  $ManifestVersion
}

$aggregateArtifacts = @()
foreach ($record in @($records | Sort-Object { $_.platform.key })) {
  $entrypoint = if ($record.platform.os -eq "windows") { "start-runtime.ps1" } else { "start-runtime.sh" }
  $aggregateArtifacts += [ordered]@{
    platform = [ordered]@{
      os = $record.platform.os
      arch = $record.platform.arch
      abi = $record.platform.abi
    }
    source_revision = $sourceRevision
    mcp_contract_fingerprint = $contractFingerprint
    contract_fingerprint = $contractFingerprint
    archive = [ordered]@{
      url = New-AssetUrl $PublishedBaseUrl $record.artifact_file
      sha256 = $record.artifact_sha256
      size_bytes = $record.artifact_size
    }
    build_manifest = [ordered]@{
      url = New-AssetUrl $PublishedBaseUrl (Split-Path -Leaf $record.path)
      sha256 = $record.manifest_sha256
    }
    runtime = [ordered]@{
      command = $entrypoint
      args = @()
      mcp_path = "/mcp"
      health_path = "/health"
    }
    backend = $record.manifest.backend
    dashboard = [ordered]@{
      asset_root = "dashboard-static"
      entrypoint = "index.html"
      fingerprint = $record.manifest.dashboard.fingerprint
      index = $record.manifest.dashboard.index
      vite_manifest = $record.manifest.dashboard.vite_manifest
    }
    fallback = [ordered]@{
      developer_source_compile = "allowed_with_explicit_source_checkout"
      installed_user_source_compile = "disabled_by_default"
    }
  }
}

$aggregate = [ordered]@{
  schema_version = 1
  plugin = $plugin
  release = [ordered]@{
    channel = $Channel
    manifest_version = $manifestVersionValue
    source_revision = $sourceRevision
    repository = $Repository
    tag = $ReleaseTag
    published_base_url = $PublishedBaseUrl.TrimEnd("/")
    required_platforms = @($required | ForEach-Object {
        $platform = Normalize-Platform $_
        [ordered]@{ os = $platform.os; arch = $platform.arch; abi = $platform.abi }
      })
  }
  source_revision = $sourceRevision
  mcp_contract_fingerprint = $contractFingerprint
  contract_fingerprint = $contractFingerprint
  launcher_contract = [ordered]@{
    manifest = "sympp-runtime-artifact"
    version = 1
    mcp_contract_fingerprint = $contractFingerprint
    contract_fingerprint = $contractFingerprint
  }
  artifacts = $aggregateArtifacts
}

$channelPath = if ([System.IO.Path]::IsPathRooted($ChannelOutputPath)) { $ChannelOutputPath } else { Join-Path $repoRoot $ChannelOutputPath }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $channelPath) | Out-Null
Write-JsonFile $channelPath $aggregate
Write-Host "Wrote aggregate release channel manifest $channelPath"
