<#
The OpenSSH Server bootstrap (#1238), orca-windows-ssh.ps1, without changing this machine:

  powershell -NoProfile -ExecutionPolicy Bypass -File openssh.ps1

What it reads is replaced by scripted states and its changes by recorders, so each check sees
exactly what the bootstrap would ask, say and change. Its real read-only probe of this machine
runs once too. Exits non-zero on the first check that fails.
#>
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "..\..\orca-windows-ssh.ps1")

function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw "FAILED: $message" } }

$checks = 0
function Check([string]$title) { $script:checks++; Write-Host "  - $title" }

# The seams: what the machine looks like, the answer typed, and what was changed.
$script:said = New-Object Collections.ArrayList
$script:changed = New-Object Collections.ArrayList
$script:asked = 0
function Write-Host([string]$line) { $null = $script:said.Add($line); Microsoft.PowerShell.Utility\Write-Host "      $line" }
function Get-OrcaSshState { return $script:state }
function Test-OrcaElevated { return $script:elevated }
function Read-OrcaConsent([string]$question) { $script:asked++; return $script:answer }
function Install-OrcaSshFeature { $null = $script:changed.Add("feature") }
function Start-OrcaSshService { $null = $script:changed.Add("service"); if ($script:failService) { throw "the service did not start" } }
function Add-OrcaSshRule { $null = $script:changed.Add("rule") }

function New-State([bool]$installed, [bool]$automatic, [bool]$running, [bool]$rule = $false, [bool]$tailscale = $true, [bool]$available = $true) {
  return [pscustomobject]@{ Available = $available; Installed = $installed; Automatic = $automatic; Running = $running; Rule = $rule; Tailscale = $tailscale }
}
function Invoke-Case($state, [string]$answer = "", [bool]$elevated = $true, [bool]$failService = $false) {
  $script:said.Clear(); $script:changed.Clear(); $script:asked = 0
  $script:state = $state; $script:answer = $answer; $script:elevated = $elevated; $script:failService = $failService
  return @(Invoke-OrcaWindowsSsh)[-1]
}
$all = { $script:said -join "`n" }

try {
  Check "the real read-only probe of this machine answers every question"
  # In its own process: in this one Get-OrcaSshState is the stand-in above.
  $shipped = powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command `
    ". '$(Join-Path $PSScriptRoot "..\..\orca-windows-ssh.ps1")'; Get-OrcaSshState | ConvertTo-Json -Compress"
  Assert ($LASTEXITCODE -eq 0) "the probe failed: $shipped"
  $found = ConvertFrom-Json ([string]($shipped | Select-Object -Last 1))
  foreach ($name in @("Available", "Installed", "Automatic", "Running", "Rule", "Tailscale")) {
    Assert ($found.$name -is [bool]) "the probe's $name is $($found.$name)"
  }
  Microsoft.PowerShell.Utility\Write-Host "      $([string]($shipped | Select-Object -Last 1))"

  Check "already installed, automatic and running: nothing asked, nothing changed, says so"
  $code = Invoke-Case (New-State $true $true $true) -elevated $false
  Assert ($code -eq 0) "exit $code"
  Assert ($script:asked -eq 0) "it asked"
  Assert ($script:changed.Count -eq 0) "it changed $($script:changed -join ', ')"
  Assert ((& $all) -like "*already on. Nothing was changed.*") "it said: $(& $all)"

  Check "not on, from a session that is not elevated: refused before asking, nothing changed"
  $code = Invoke-Case (New-State $false $false $false) "y" -elevated $false
  Assert ($code -eq 2) "exit $code"
  Assert ($script:asked -eq 0 -and $script:changed.Count -eq 0) "it asked or changed something"
  Assert ((& $all) -like "*administrator PowerShell*Nothing was changed.*") "it said: $(& $all)"

  Check "no Tailscale adapter: refused before asking, nothing changed"
  $code = Invoke-Case (New-State $false $false $false -tailscale $false) "y"
  Assert ($code -eq 2 -and $script:asked -eq 0 -and $script:changed.Count -eq 0) "exit $code, asked $script:asked, changed $($script:changed -join ', ')"
  Assert ((& $all) -like "*Tailscale*Nothing was changed.*") "it said: $(& $all)"

  Check "a Windows without the feature: refused, nothing changed"
  $code = Invoke-Case (New-State $false $false $false -available $false) "y"
  Assert ($code -eq 2 -and $script:asked -eq 0 -and $script:changed.Count -eq 0) "exit $code"

  Check "not installed: lists every change before asking, and a no changes nothing"
  foreach ($answer in @("", "n", "no", "yess", " N ")) {
    $code = Invoke-Case (New-State $false $false $false) $answer
    Assert ($code -eq 2) "answer '$answer': exit $code"
    Assert ($script:asked -eq 1) "answer '$answer': asked $script:asked times"
    Assert ($script:changed.Count -eq 0) "answer '$answer': changed $($script:changed -join ', ')"
    $text = & $all
    Assert ($text -like "*Install the OpenSSH Server Windows feature*OpenSSH-Server-In-TCP*") "the feature step is not listed: $text"
    Assert ($text -like "*start automatically, and start it*") "the service step is not listed: $text"
    Assert ($text -like "*only over the Tailscale adapter*") "the firewall step is not listed: $text"
    Assert ($text -like "*Windows Update maintains it*") "it does not say who maintains it: $text"
    Assert ($script:said[-1] -eq "Nothing was changed.") "the last line is '$($script:said[-1])'"
  }

  Check "a yes makes exactly the listed changes, in order"
  foreach ($answer in @("y", "Y", "yes", " yes ")) {
    $code = Invoke-Case (New-State $false $false $false) $answer
    Assert ($code -eq 0) "answer '$answer': exit $code"
    Assert (($script:changed -join ",") -eq "feature,service,rule") "answer '$answer': changed $($script:changed -join ',')"
    Assert ($script:said[-1] -like "The OpenSSH Server is on.*") "the last line is '$($script:said[-1])'"
  }

  Check "installed but stopped, with the rule there: only the service is listed and changed"
  $code = Invoke-Case (New-State $true $false $false -rule $true) "y"
  Assert ($code -eq 0) "exit $code"
  Assert (($script:changed -join ",") -eq "service") "changed $($script:changed -join ',')"
  Assert (-not ((& $all) -like "*Install the OpenSSH*")) "it lists the feature it already has"
  Assert (-not ((& $all) -like "*firewall rule*")) "it lists the rule it already has"

  Check "a step that fails stops there, says which, and does not go on"
  $code = Invoke-Case (New-State $false $false $false) "y" -failService $true
  Assert ($code -eq 1) "exit $code"
  Assert (($script:changed -join ",") -eq "feature,service") "changed $($script:changed -join ',')"
  Assert ((& $all) -like "*Could not set the sshd service to start automatically*did not start*run this again*") "it said: $(& $all)"

  Microsoft.PowerShell.Utility\Write-Host "  all $checks OpenSSH bootstrap checks passed"
} catch {
  Microsoft.PowerShell.Utility\Write-Host $_.Exception.Message
  exit 1
}
exit 0
