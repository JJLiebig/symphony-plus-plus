$ErrorActionPreference = "Stop"
$launcher = Join-Path $PSScriptRoot "../../scripts/start-sympp-mcp.ps1"
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($launcher, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw "Launcher does not parse." }
foreach ($name in @("Select-AvailablePort", "Get-FreeTcpPort", "Resolve-BackendPlan", "Test-BackendLaunchCompatible", "Test-BackendContractMatches", "Normalize-McpContractFingerprint", "Resolve-SymppDatabasePath", "Test-SymppDatabasePathsMatch")) {
  $definition = $ast.Find({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
  }, $true)
  Invoke-Expression $definition.Extent.Text
}
$default = $ast.Find({ param($node)
  $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
    $node.Left.Extent.Text -eq '$DefaultBackendPort'
}, $true)
Invoke-Expression $default.Extent.Text

function Test-PortAvailable([int]$Port) { return $Port -notin $script:occupied }
$script:occupied = @()
if ((Select-AvailablePort $DefaultBackendPort) -ne 19998) { throw "Default startup must prefer 19998." }
$script:occupied = @(19998, 19999)
if ((Select-AvailablePort $DefaultBackendPort) -ne 20000) { throw "Occupied ports must be skipped in ascending order." }
if ((Select-AvailablePort $DefaultBackendPort @(20000)) -ne 20001) { throw "Reserved ports must be skipped too." }
if ((Select-AvailablePort 21000) -ne 21000) { throw "Explicit preferred ports must be respected." }
$dynamic = Select-AvailablePort 0
if ($dynamic -lt 1 -or $dynamic -gt 65535) { throw "Explicit port zero must still select an available port." }
Write-Output "Port selection: preferred default, ascending collisions, reservations, and explicit overrides passed."

$previousDatabase = $env:SYMPP_DATABASE
try {
  $env:SYMPP_DATABASE = Join-Path $PSScriptRoot "requested ledger.sqlite3"
  $script:occupied = @(19998)
  function Test-SymppWindowsPlatform { return $IsWindows }
  function Assert-LoopbackHttpOrigin { }
  function Test-RuntimeEntryExternalOverride { return $false }
  function Write-Diagnostic { }
  function Format-BackendLaunchCompatibilityMismatch { return "different database" }
  function Get-SymppBackendHealthWithRetry {
    return [pscustomobject]@{ healthy = $true; contract_fingerprint = "a" * 64; ledger_identity = [pscustomobject]@{ kind = "sqlite"; display_path = Join-Path $PSScriptRoot "other ledger.sqlite3" } }
  }
  $plan = Resolve-BackendPlan 19998 $null $null 1 $null ("a" * 64) $false
  if (-not $plan.should_start -or $plan.port -ne 19999) { throw "Different database at preferred port must select a new backend." }
  $rejected = $false
  try { $null = Resolve-BackendPlan 19998 "http://127.0.0.1:19998" $null 1 $null ("a" * 64) $true } catch { $rejected = $_.Exception.Message -match "not compatible" }
  if (-not $rejected) { throw "Explicit URL with a different database must fail." }
} finally { $env:SYMPP_DATABASE = $previousDatabase }
Write-Output "Backend selection: explicit database rejects incompatible preferred reuse and explicit URL."
