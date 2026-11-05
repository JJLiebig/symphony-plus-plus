# Lifecycle diagnostic self-test helpers.

function Invoke-SelfTest {
  $cases = @(
    @{ Command = 'tool --token abc123 --api-key=sk-live'; Secrets = @("abc123", "sk-live") },
    @{ Command = 'curl -H "Authorization: Bearer ey.secret" https://example.invalid'; Secrets = @("ey.secret") },
    @{ Command = 'runner /password hunter2 token=plain secret:"quoted-value"'; Secrets = @("hunter2", "plain", "quoted-value") },
    @{ Command = 'worker bearer abc.def.ghi --authorization "Bearer nested-secret"'; Secrets = @("abc.def.ghi", "nested-secret") }
  )

  foreach ($case in $cases) {
    $sanitized = Sanitize-CommandLine $case.Command
    foreach ($secret in $case.Secrets) {
      if ($sanitized.Contains($secret)) {
        throw "Sanitize-CommandLine leaked '$secret' for command: $($case.Command)"
      }
    }
  }

  $quoted = Quote-PowerShellLiteral "C:\Symphony Roots\O'Hara"
  if ($quoted -ne "'C:\Symphony Roots\O''Hara'") {
    throw "Quote-PowerShellLiteral did not emit a valid single-quoted literal."
  }

  $sourceCommandRoot = Join-Path ([System.IO.Path]::GetTempPath()) "Symphony Roots"
  $sourceCommandRoot = Join-Path $sourceCommandRoot "O'Hara Repo"
  $sourceCommand = New-SourceScriptCommand $sourceCommandRoot "scripts/smoke-sympp-mcp-http.ps1" "-Json"
  $expectedSourceCommandPath = Resolve-OptionalFullPath (Join-Path $sourceCommandRoot "scripts/smoke-sympp-mcp-http.ps1")
  $expectedSourceCommand = "& $(Quote-PowerShellLiteral $expectedSourceCommandPath) -Json"
  if ($sourceCommand -ne $expectedSourceCommand) {
    throw "New-SourceScriptCommand did not emit an absolute PowerShell invocation."
  }

  $verifyCommand = New-VerifyHttpMcpCommand $sourceCommandRoot
  $expectedVerifyCommand = "& $(Quote-PowerShellLiteral $expectedSourceCommandPath) -RepoRoot $(Quote-PowerShellLiteral (Resolve-OptionalFullPath $sourceCommandRoot))"
  if ($verifyCommand -ne $expectedVerifyCommand) {
    throw "New-VerifyHttpMcpCommand did not emit a repo-root-bound smoke invocation."
  }

  $git = Get-Command git -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($git) {
    $gitRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("sympp-fingerprint-git-" + [guid]::NewGuid().ToString("N"))
    try {
      $packageRoot = Join-Path $gitRoot "plugins/symphony-plus-plus-mcp"
      $trackedPath = Join-Path $packageRoot "scripts/tracked.ps1"
      $scratchPath = Join-Path $packageRoot "scripts/scratch.tmp"
      New-Item -ItemType Directory -Path (Split-Path -Parent $trackedPath) -Force | Out-Null
      Set-Content -LiteralPath $trackedPath -Value "tracked" -NoNewline
      Set-Content -LiteralPath $scratchPath -Value "scratch" -NoNewline
      & $git.Source @("-C", $gitRoot, "init", "-q") | Out-Null
      & $git.Source @("-C", $gitRoot, "add", "plugins/symphony-plus-plus-mcp/scripts/tracked.ps1") | Out-Null
      $trackedFingerprintPaths = @(Get-GitTrackedPackageFingerprintPaths $gitRoot $packageRoot)
      if ($trackedFingerprintPaths.Count -ne 1 -or $trackedFingerprintPaths[0] -ne "scripts/tracked.ps1") {
        throw "Git-tracked package fingerprint paths should exclude untracked scratch files."
      }

      $cacheRoot = Join-Path $gitRoot "cache/symphony-plus-plus-mcp"
      New-Item -ItemType Directory -Path (Join-Path $cacheRoot "scripts") -Force | Out-Null
      Set-Content -LiteralPath (Join-Path $cacheRoot "scripts/tracked.ps1") -Value "tracked" -NoNewline
      Set-Content -LiteralPath (Join-Path $cacheRoot "scripts/removed.ps1") -Value "removed" -NoNewline
      $mergedFingerprintPaths = @(Merge-PackageFingerprintPaths $trackedFingerprintPaths @(Get-ExistingPackageFingerprintPaths $cacheRoot))
      if ($mergedFingerprintPaths -notcontains "scripts/removed.ps1") {
        throw "Cache-only package files should be included in freshness comparisons."
      }
      $sourceFingerprint = Get-PluginPackageFingerprint $packageRoot $mergedFingerprintPaths
      $cacheFingerprint = Get-PluginPackageFingerprint $cacheRoot $mergedFingerprintPaths
      if ($sourceFingerprint -eq $cacheFingerprint) {
        throw "Cache-only package files should produce a fingerprint mismatch."
      }
    } finally {
      Remove-Item -LiteralPath $gitRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  $invalidSourcePackage = [pscustomobject]@{
    manifest_exists = $true
    manifest_parse_error = "bad json"
    package_name = "symphony-plus-plus-mcp"
    manifest_version = $null
  }
  if (Test-SourcePackageSummaryComparable $invalidSourcePackage "symphony-plus-plus-mcp") {
    throw "Invalid source package summaries must not be comparable for cache freshness."
  }

  if ((Normalize-ComparablePath "~/.codex") -ne (Normalize-ComparablePath (Join-Path $HOME ".codex"))) {
    throw "Resolve-OptionalFullPath did not expand a leading home-directory tilde."
  }

  $defaultCodexHome = Join-Path $HOME ".codex"
  if (-not (Test-DefaultCodexHome $defaultCodexHome)) {
    throw "Test-DefaultCodexHome did not recognize the absolute default Codex home."
  }
  if (-not (Test-DefaultCodexHome "~/.codex")) {
    throw "Test-DefaultCodexHome did not recognize the tilde default Codex home."
  }
  if (Test-DefaultCodexHome (Join-Path $HOME ".codex-sympp-test")) {
    throw "Test-DefaultCodexHome treated a sibling path as the default Codex home."
  }

  if (Test-PathComparisonCaseInsensitive) {
    if (-not (Test-ComparablePathEqual "SymphonyCodexHome" "symphonycodexhome")) {
      throw "Test-ComparablePathEqual should ignore case on case-insensitive platforms."
    }
  } elseif (Test-ComparablePathEqual "SymphonyCodexHome" "symphonycodexhome") {
    throw "Test-ComparablePathEqual should preserve case on case-sensitive platforms."
  }

  $tomlState = Update-TomlMultilineStringState 'note = """' $null
  $tomlState = Update-TomlMultilineStringState "enabled = false" $tomlState
  $tomlState = Update-TomlMultilineStringState '[plugins."not-a-section"]' $tomlState
  $tomlState = Update-TomlMultilineStringState '"""' $tomlState
  if (-not [string]::IsNullOrWhiteSpace($tomlState)) {
    throw "Update-TomlMultilineStringState did not ignore TOML multiline string content."
  }

  if (-not (Test-TomlTableHeaderLine '[ plugins."symphony-plus-plus-mcp@jonat-local" ]')) {
    throw "Test-TomlTableHeaderLine did not accept a valid spaced table header."
  }

  if (Test-TomlTableHeaderLine '  [1, 2],') {
    throw "Test-TomlTableHeaderLine treated an array element as a table header."
  }

  $containerDepth = Update-TomlContainerDepth 'matrix = [' 0
  $containerDepth = Update-TomlContainerDepth '  ["a"]' $containerDepth
  $containerDepth = Update-TomlContainerDepth ']' $containerDepth
  if ($containerDepth -ne 0) {
    throw "Update-TomlContainerDepth did not track multiline array depth."
  }

  if ((Update-TomlContainerDepth 'notes = ["""hello"""]' 0) -ne 0) {
    throw "Update-TomlContainerDepth did not skip same-line basic multiline strings inside arrays."
  }

  if ((Update-TomlContainerDepth "metadata = { note = '''hello''' }" 0) -ne 0) {
    throw "Update-TomlContainerDepth did not skip same-line literal multiline strings inside inline tables."
  }

  $multilineArrayState = $null
  $multilineArrayDepth = 0
  foreach ($line in @('notes = ["""', 'hello', '"""]')) {
    $nextState = Update-TomlMultilineStringState $line $multilineArrayState
    $multilineArrayDepth = Update-TomlContainerDepthForLine $line $multilineArrayDepth $multilineArrayState $nextState
    $multilineArrayState = $nextState
  }
  if ($multilineArrayDepth -ne 0) {
    throw "Update-TomlContainerDepthForLine did not track array depth after a multiline string closed."
  }

  $inlineEnabled = Find-TomlBooleanKeyAssignment '"symphony-plus-plus-mcp@jonat-local" = { note = "enabled = false", enabled = false }' "enabled" 1
  if ($null -eq $inlineEnabled -or $inlineEnabled.value -ne "false") {
    throw "Find-TomlBooleanKeyAssignment did not find a boolean key outside quoted strings."
  }

  if ($null -ne (Find-TomlBooleanKeyAssignment '"symphony-plus-plus-mcp@jonat-local" = { note = { enabled = false } }' "enabled" 1)) {
    throw "Find-TomlBooleanKeyAssignment treated a nested inline-table key as a top-level key."
  }

  if ($null -ne (Find-TomlBooleanKeyAssignment '"symphony-plus-plus-mcp@jonat-local" = { noteenabled = false }' "enabled" 1)) {
    throw "Find-TomlBooleanKeyAssignment treated a bare key suffix as a standalone enabled key."
  }

  $quotedInlineEnabled = Find-TomlBooleanKeyAssignment '"symphony-plus-plus-mcp@jonat-local" = { "enabled" = true }' "enabled" 1
  if ($null -eq $quotedInlineEnabled -or $quotedInlineEnabled.value -ne "true") {
    throw "Find-TomlBooleanKeyAssignment did not find a quoted boolean key."
  }

  $pluginKey = "symphony-plus-plus-mcp@jonat-local"
  $companionSectionPattern = '\[\s*(?:plugins|"plugins"|''plugins'')\s*\.\s*(?:"symphony-plus-plus-mcp@jonat-local"|''symphony-plus-plus-mcp@jonat-local'')\s*\]'
  $mutationRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("sympp-enable-selftest-" + [guid]::NewGuid().ToString("N"))
  $mutationCases = @(
    @{
      Name = "missing_config"
      Initial = $null
      Status = "created_config"
      Changed = $true
      Backup = $false
      CompanionSection = $true
      Contains = @()
    },
    @{
      Name = "absent_section"
      Initial = @'
[plugins."symphony-plus-plus@jonat-local"]
enabled = true

[plugins."unrelated@jonat-local"]
enabled = false

[mcp_servers.other]
url = "http://127.0.0.1:9999/mcp"
'@
      Status = "added_section"
      Changed = $true
      Backup = $true
      CompanionSection = $true
      Contains = @('[mcp_servers.other]')
    },
    @{
      Name = "disabled_section"
      Initial = @'
[plugins."symphony-plus-plus-mcp@jonat-local"]
enabled = false # dedicated only
'@
      Status = "enabled_existing_section"
      Changed = $true
      Backup = $true
      CompanionSection = $true
      Contains = @('enabled = true # dedicated only')
      Absent = @('enabled = false # dedicated only')
    },
    @{
      Name = "quoted_enabled_section"
      Initial = @'
[plugins."symphony-plus-plus-mcp@jonat-local"]
"enabled" = false # dedicated only
'@
      Status = "enabled_existing_section"
      Changed = $true
      Backup = $true
      CompanionSection = $true
      Contains = @('"enabled" = true # dedicated only')
      Absent = @('"enabled" = false # dedicated only')
    },
    @{
      Name = "missing_enabled"
      Initial = @'
[plugins."symphony-plus-plus-mcp@jonat-local"]
note = "dedicated only"
'@
      Status = "added_enabled"
      Changed = $true
      Backup = $true
      CompanionSection = $true
      Contains = @('enabled = true')
      Absent = @('enabled = false')
    },
    @{
      Name = "literal_quoted_section"
      Initial = @'
["plugins" . 'symphony-plus-plus-mcp@jonat-local' ]
enabled = false
'@
      Status = "enabled_existing_section"
      Changed = $true
      Backup = $true
      CompanionSection = $true
      Contains = @('enabled = true')
      Absent = @('enabled = false')
    },
    @{
      Name = "spaced_section_with_array"
      Initial = @'
 [ plugins."symphony-plus-plus-mcp@jonat-local" ]
 matrix = [
   ["a"]
 ]
 enabled = false
'@
      Status = "enabled_existing_section"
      Changed = $true
      Backup = $true
      CompanionSection = $true
      Contains = @('["a"]')
      Absent = @('enabled = false')
    },
    @{
      Name = "section_with_same_line_multiline_string_in_array"
      Initial = @'
[plugins."symphony-plus-plus-mcp@jonat-local"]
notes = ["""hello"""]
enabled = false
'@
      Status = "enabled_existing_section"
      Changed = $true
      Backup = $true
      CompanionSection = $true
      Contains = @('notes = ["""hello"""]')
      Absent = @('enabled = false')
    },
    @{
      Name = "section_with_multiline_string_array"
      Initial = @'
[plugins."symphony-plus-plus-mcp@jonat-local"]
notes = ["""
hello
"""]
enabled = false
'@
      Status = "enabled_existing_section"
      Changed = $true
      Backup = $true
      CompanionSection = $true
      Contains = @('hello')
      Absent = @('enabled = false')
    },
    @{
      Name = "dotted_key"
      Initial = @'
plugins."symphony-plus-plus-mcp@jonat-local".enabled = false # dedicated only
'@
      Status = "enabled_existing_dotted_key"
      Changed = $true
      Backup = $true
      CompanionSection = $false
      Contains = @('plugins."symphony-plus-plus-mcp@jonat-local".enabled = true # dedicated only')
      Absent = @('plugins."symphony-plus-plus-mcp@jonat-local".enabled = false # dedicated only')
    },
    @{
      Name = "plugins_table_dotted_key"
      Initial = @'
[plugins]
"symphony-plus-plus-mcp@jonat-local".enabled = false # dedicated only
'@
      Status = "enabled_existing_dotted_key"
      Changed = $true
      Backup = $true
      CompanionSection = $false
      Contains = @('"symphony-plus-plus-mcp@jonat-local".enabled = true # dedicated only')
      Absent = @('"symphony-plus-plus-mcp@jonat-local".enabled = false # dedicated only')
    },
    @{
      Name = "plugins_table_inline_table"
      Initial = @'
[plugins]
"symphony-plus-plus-mcp@jonat-local" = { note = "dedicated", enabled = false }
'@
      Status = "enabled_existing_inline_table"
      Changed = $true
      Backup = $true
      CompanionSection = $false
      Contains = @('"symphony-plus-plus-mcp@jonat-local" = { note = "dedicated", enabled = true }')
      Absent = @('"symphony-plus-plus-mcp@jonat-local" = { note = "dedicated", enabled = false }')
    },
    @{
      Name = "plugins_table_inline_table_quoted_enabled"
      Initial = @'
[plugins]
"symphony-plus-plus-mcp@jonat-local" = { note = "dedicated", "enabled" = false }
'@
      Status = "enabled_existing_inline_table"
      Changed = $true
      Backup = $true
      CompanionSection = $false
      Contains = @('"symphony-plus-plus-mcp@jonat-local" = { note = "dedicated", "enabled" = true }')
      Absent = @('"symphony-plus-plus-mcp@jonat-local" = { note = "dedicated", "enabled" = false }')
    },
    @{
      Name = "root_inline_table"
      Initial = @'
plugins."symphony-plus-plus-mcp@jonat-local" = { note = "dedicated", enabled = false }
'@
      Status = "enabled_existing_inline_table"
      Changed = $true
      Backup = $true
      CompanionSection = $false
      Contains = @('plugins."symphony-plus-plus-mcp@jonat-local" = { note = "dedicated", enabled = true }')
      Absent = @('plugins."symphony-plus-plus-mcp@jonat-local" = { note = "dedicated", enabled = false }')
    },
    @{
      Name = "root_inline_table_quoted_enabled"
      Initial = @'
plugins."symphony-plus-plus-mcp@jonat-local" = { note = "dedicated", "enabled" = false }
'@
      Status = "enabled_existing_inline_table"
      Changed = $true
      Backup = $true
      CompanionSection = $false
      Contains = @('plugins."symphony-plus-plus-mcp@jonat-local" = { note = "dedicated", "enabled" = true }')
      Absent = @('plugins."symphony-plus-plus-mcp@jonat-local" = { note = "dedicated", "enabled" = false }')
    },
    @{
      Name = "profile_relative_dotted_key_ignored"
      Initial = @'
[profiles.spp]
plugins."symphony-plus-plus-mcp@jonat-local".enabled = true
'@
      Status = "added_section"
      Changed = $true
      Backup = $true
      CompanionSection = $true
      Contains = @('[profiles.spp]')
    },
    @{
      Name = "profile_relative_other_market_dotted_key_ignored"
      Initial = @'
[profiles.spp]
plugins."symphony-plus-plus-mcp@other-market".enabled = true
'@
      Status = "added_section"
      Changed = $true
      Backup = $true
      CompanionSection = $true
      Contains = @('[profiles.spp]')
    },
    @{
      Name = "multiline_string_section"
      Initial = @'
[plugins."symphony-plus-plus-mcp@jonat-local"]
note = """
enabled = false
[plugins."not-a-real-section@jonat-local"]
[mcp_servers.sympp]
"""
'@
      Status = "added_enabled"
      Changed = $true
      Backup = $true
      CompanionSection = $true
      Contains = @('[plugins."not-a-real-section@jonat-local"]', '[mcp_servers.sympp]')
    },
    @{
      Name = "already_enabled"
      Initial = @'
[plugins."symphony-plus-plus-mcp@jonat-local"]
enabled = true
'@
      Status = "already_enabled"
      Changed = $false
      Backup = $false
      CompanionSection = $true
      Contains = @('enabled = true')
    }
  )

  try {
    [void](New-Item -ItemType Directory -Path $mutationRoot -Force)

    foreach ($case in $mutationCases) {
      $caseRoot = Join-Path $mutationRoot $case.Name
      $configPath = Join-Path $caseRoot "config.toml"
      [void](New-Item -ItemType Directory -Path $caseRoot -Force)

      if ($null -ne $case.Initial) {
        [System.IO.File]::WriteAllText($configPath, [string]$case.Initial, (New-StrictUtf8NoBomEncoding))
      }

      $result = Set-PluginEnabledInConfig $configPath $pluginKey
      if ($result.status -ne $case.Status) {
        throw "Set-PluginEnabledInConfig returned status '$($result.status)' for $($case.Name); expected '$($case.Status)'."
      }
      if ([bool]$result.changed -ne [bool]$case.Changed) {
        throw "Set-PluginEnabledInConfig returned changed '$($result.changed)' for $($case.Name); expected '$($case.Changed)'."
      }

      $configText = [System.IO.File]::ReadAllText($configPath)
      if ([bool]($configText -match $companionSectionPattern) -ne [bool]$case.CompanionSection) {
        throw "Set-PluginEnabledInConfig companion section presence mismatch for $($case.Name)."
      }

      foreach ($needle in @($case.Contains)) {
        if (-not $configText.Contains([string]$needle)) {
          throw "Set-PluginEnabledInConfig output for $($case.Name) did not contain expected text: $needle"
        }
      }

      if ($case.ContainsKey("Absent")) {
        foreach ($needle in @($case.Absent)) {
          if ($configText.Contains([string]$needle)) {
            throw "Set-PluginEnabledInConfig output for $($case.Name) still contained stale text: $needle"
          }
        }
      }

      if ($case.Backup) {
        if ([string]::IsNullOrWhiteSpace([string]$result.backup_path) -or -not (Test-Path -LiteralPath $result.backup_path)) {
          throw "Set-PluginEnabledInConfig did not create a backup for $($case.Name)."
        }
        $backupText = [System.IO.File]::ReadAllText([string]$result.backup_path)
        if ($backupText -cne [string]$case.Initial) {
          throw "Set-PluginEnabledInConfig backup content changed for $($case.Name)."
        }
      } elseif (-not [string]::IsNullOrWhiteSpace([string]$result.backup_path)) {
        throw "Set-PluginEnabledInConfig unexpectedly created a backup for $($case.Name)."
      }
    }

    $unsupportedMutationCases = @(
      @{
        Name = "nested_inline_no_enabled"
        Initial = @'
[plugins]
"symphony-plus-plus-mcp@jonat-local" = { note = { enabled = false } }
'@
      },
      @{
        Name = "bare_key_suffix_no_enabled"
        Initial = @'
[plugins]
"symphony-plus-plus-mcp@jonat-local" = { noteenabled = false }
'@
      }
    )

    foreach ($case in $unsupportedMutationCases) {
      $caseRoot = Join-Path $mutationRoot $case.Name
      $configPath = Join-Path $caseRoot "config.toml"
      [void](New-Item -ItemType Directory -Path $caseRoot -Force)
      [System.IO.File]::WriteAllText($configPath, [string]$case.Initial, (New-StrictUtf8NoBomEncoding))

      $summary = Get-PluginConfigSummary $configPath "jonat-local"
      $matchingEntries = @(
        $summary.symphony_plugin_entries |
          Where-Object { $_.plugin_name -eq "symphony-plus-plus-mcp" -and $_.marketplace_name -eq "jonat-local" }
      )
      if ($matchingEntries.Count -ne 1) {
        throw "Get-PluginConfigSummary did not retain one unsupported companion entry for $($case.Name)."
      }
      if ($null -ne $matchingEntries[0].enabled -or $null -ne $summary.symphony_mcp_companion_plugin_enabled) {
        throw "Get-PluginConfigSummary treated unsupported inline table $($case.Name) as enabled or disabled."
      }

      $enableThrew = $false
      try {
        [void](Set-PluginEnabledInConfig $configPath $pluginKey)
      } catch {
        $enableThrew = $true
        if ($_.Exception.Message -notmatch "Target plugin inline table contains no supported enabled = true/false entry") {
          throw "Set-PluginEnabledInConfig returned the wrong unsupported inline table error for $($case.Name): $($_.Exception.Message)"
        }
      }

      if (-not $enableThrew) {
        throw "Set-PluginEnabledInConfig did not reject unsupported inline table $($case.Name)."
      }

      if ([System.IO.File]::ReadAllText($configPath) -cne [string]$case.Initial) {
        throw "Set-PluginEnabledInConfig mutated unsupported inline table $($case.Name)."
      }

      if (@(Get-ChildItem -LiteralPath $caseRoot -Filter "config.toml.sympp-backup-*" -Force -ErrorAction SilentlyContinue).Count -ne 0) {
        throw "Set-PluginEnabledInConfig created a backup for rejected unsupported inline table $($case.Name)."
      }
    }
  } finally {
    Remove-Item -LiteralPath $mutationRoot -Recurse -Force -ErrorAction SilentlyContinue
  }

  $linkTestRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("sympp-diagnose-path-selftest-" + [guid]::NewGuid().ToString("N"))
  $targetPath = Join-Path $linkTestRoot "target"
  $targetChildPath = Join-Path $targetPath ".codex"
  $linkPath = Join-Path $linkTestRoot "link"
  $linkChildPath = Join-Path $linkPath ".codex"

  try {
    New-Item -ItemType Directory -Path $targetPath -Force | Out-Null
    New-Item -ItemType Directory -Path $targetChildPath -Force | Out-Null
    $linkCreated = $false

    $linkTypes = if ([System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows)) { @("Junction", "SymbolicLink") } else { @("SymbolicLink") }
    foreach ($linkType in $linkTypes) {
      try {
        New-Item -ItemType $linkType -Path $linkPath -Target $targetPath -Force | Out-Null
        $linkCreated = $true
        break
      } catch {
        $linkCreated = $false
      }
    }

    $resolvedLinkPath = Resolve-ComparableFileSystemPath $linkPath
    $resolvedTargetPath = Resolve-ComparableFileSystemPath $targetPath
    if ($linkCreated -and -not (Test-ComparablePathEqual $resolvedLinkPath $resolvedTargetPath)) {
      throw "Resolve-ComparableFileSystemPath did not canonicalize a filesystem link target."
    }
    $resolvedLinkChildPath = Resolve-ComparableFileSystemPath $linkChildPath
    $resolvedTargetChildPath = Resolve-ComparableFileSystemPath $targetChildPath
    if ($linkCreated -and -not (Test-ComparablePathEqual $resolvedLinkChildPath $resolvedTargetChildPath)) {
      throw "Resolve-ComparableFileSystemPath did not canonicalize a filesystem link parent target."
    }
  } finally {
    if (Test-Path -LiteralPath $linkPath) {
      try {
        [System.IO.Directory]::Delete((Resolve-OptionalFullPath $linkPath), $false)
      } catch {
      }
    }
    Remove-Item -LiteralPath $linkTestRoot -Recurse -Force -ErrorAction SilentlyContinue
  }

  $missingSourceAction = New-SourceCheckoutAction "verify_http_mcp" "workrequest_mcp" "Verify the local HTTP MCP daemon." ([pscustomobject]@{ note = "No checkout." }) $null
  if ($missingSourceAction.PSObject.Properties["command"] -or $missingSourceAction.message -notmatch "No checkout") {
    throw "New-SourceCheckoutAction should omit commands and explain missing source roots."
  }

  $currentDiagnosticCommand = New-CurrentDiagnosticCommand "-SelfTest"
  if ($currentDiagnosticCommand -notmatch "diagnose-mcp-lifecycle\.ps1" -or $currentDiagnosticCommand -notmatch "-SelfTest") {
    throw "New-CurrentDiagnosticCommand did not emit an invocation for the running diagnostic script."
  }

  Write-Host "diagnose-mcp-lifecycle self-test passed."
}
