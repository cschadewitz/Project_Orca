<#
.SYNOPSIS
Turn on the Windows OpenSSH Server so ORCA can set this machine up over your tailnet (#1238,
incubating).

.DESCRIPTION
Run once, from an administrator PowerShell on the Windows machine that will host an ORCA
server. ORCA then reaches it over SSH like any other host, and its own setup
(orca-server-setup.ps1) does the rest as the account you sign in with.

This uses only what Windows ships: the OpenSSH Server optional feature, which Windows Update
installs and keeps updated. ORCA does not bundle, update or configure it beyond the steps
below, and you maintain nothing for it beyond Windows Update.

If the OpenSSH Server is already installed, set to start automatically and running, this
changes nothing and says so. Otherwise it lists exactly what it would change and asks first;
anything but `y` changes nothing:

1. Install the OpenSSH Server Windows feature (OpenSSH.Server), from Windows Update.
2. Set the sshd service to start automatically, and start it.
3. Allow inbound SSH (TCP 22) only over the Tailscale network adapter: the firewall rule
   "ORCA: OpenSSH Server over Tailscale". When step 1 runs, the rule the feature adds for every
   network ("OpenSSH-Server-In-TCP") is disabled, so SSH is not open on other networks.

It needs Tailscale installed and signed in (its "Tailscale" network adapter). The same steps
run from a file:

  powershell -NoProfile -ExecutionPolicy Bypass -File orca-windows-ssh.ps1

Exit codes: 0 on (or already on), 1 a step failed, 2 nothing changed (declined, not an
administrator, no Tailscale adapter, or a Windows without the feature).
#>
$ErrorActionPreference = "Stop"

$Capability = "OpenSSH.Server~~~~0.0.1.0"
$Service = "sshd"
$Adapter = "Tailscale"
$RuleName = "ORCA-OpenSSH-Server-Tailscale"
$RuleDisplay = "ORCA: OpenSSH Server over Tailscale"
$BroadRule = "OpenSSH-Server-In-TCP"

# -- what is there (read only) ------------------------------------------------------------------

function Test-OrcaElevated {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-OrcaSshState {
  $service = Get-Service -Name $Service -ErrorAction SilentlyContinue
  # Windows answers for its features only in an elevated session; the service answers in any.
  $feature = $null
  try { $feature = Get-WindowsCapability -Online -Name $Capability -ErrorAction Stop } catch { }
  return [pscustomobject]@{
    Available = $null -ne $feature -or $null -ne $service
    Installed = $null -ne $service -or ($null -ne $feature -and [string]$feature.State -eq "Installed")
    Automatic = $null -ne $service -and [string]$service.StartType -eq "Automatic"
    Running = $null -ne $service -and [string]$service.Status -eq "Running"
    Rule = $null -ne (Get-NetFirewallRule -Name $RuleName -ErrorAction SilentlyContinue)
    Tailscale = $null -ne (Get-NetAdapter -Name $Adapter -ErrorAction SilentlyContinue)
  }
}

# -- the changes (each one step, so tests can stand in for it) ----------------------------------

function Install-OrcaSshFeature {
  $null = Add-WindowsCapability -Online -Name $Capability
  # The feature's own rule opens SSH on every network: only Tailscale's is kept open.
  $broad = Get-NetFirewallRule -Name $BroadRule -ErrorAction SilentlyContinue
  if ($broad) { $null = $broad | Disable-NetFirewallRule }
}

function Start-OrcaSshService {
  Set-Service -Name $Service -StartupType Automatic
  Start-Service -Name $Service
}

function Add-OrcaSshRule {
  $null = New-NetFirewallRule -Name $RuleName -DisplayName $RuleDisplay -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort 22 -InterfaceAlias $Adapter -Profile Any `
    -Description "Added by orca-windows-ssh.ps1 (ORCA #1238): SSH only over the Tailscale adapter."
}

function Read-OrcaConsent([string]$question) {
  try { return [string](Read-Host $question) } catch { return "" }
}

# -- the run ------------------------------------------------------------------------------------

function Invoke-OrcaWindowsSsh {
  $state = Get-OrcaSshState
  if ($state.Installed -and $state.Automatic -and $state.Running) {
    Write-Host "The OpenSSH Server is already on. Nothing was changed."
    return 0
  }
  if (-not (Test-OrcaElevated)) {
    Write-Host "Run this from an administrator PowerShell: turning on the OpenSSH Server needs one. Nothing was changed."
    return 2
  }
  if (-not $state.Available) {
    Write-Host "This Windows has no OpenSSH Server feature (Windows 10 1809, Windows Server 2019 or newer has). Nothing was changed."
    return 2
  }
  if (-not $state.Tailscale) {
    Write-Host "No Tailscale network adapter: install Tailscale and sign in to your tailnet first. Nothing was changed."
    return 2
  }
  $steps = @()
  if (-not $state.Installed) {
    $steps += , @("Install the OpenSSH Server Windows feature (OpenSSH.Server) from Windows Update, which keeps it updated, and disable the firewall rule it adds for every network ($BroadRule)", "Install-OrcaSshFeature")
  }
  if (-not ($state.Automatic -and $state.Running)) {
    $steps += , @("Set the sshd service to start automatically, and start it", "Start-OrcaSshService")
  }
  if (-not $state.Rule) {
    $steps += , @("Allow inbound SSH (TCP 22) only over the Tailscale adapter: firewall rule `"$RuleDisplay`"", "Add-OrcaSshRule")
  }
  Write-Host "To let ORCA reach this machine over your tailnet, this would:"
  foreach ($step in $steps) { Write-Host "  - $($step[0])" }
  Write-Host "ORCA does not bundle or update the OpenSSH Server; Windows Update maintains it."
  $answer = Read-OrcaConsent "Make these changes? [y/N]"
  if ($answer.Trim() -notmatch '^(y|yes)$') {
    Write-Host "Nothing was changed."
    return 2
  }
  foreach ($step in $steps) {
    try {
      & $step[1]
    } catch {
      Write-Host "Could not $($step[0].Substring(0, 1).ToLower() + $step[0].Substring(1)): $($_.Exception.Message)"
      Write-Host "The steps before it stay done; run this again to finish."
      return 1
    }
  }
  Write-Host "The OpenSSH Server is on. Add this machine from ORCA: Add a machine, or orca-cli remote add you@this-machine --tailnet."
  return 0
}

# Dot-sourced (the tests), only the functions; run from a file, its exit code; pasted or piped
# into a session, the session stays open.
if ($MyInvocation.InvocationName -ne ".") {
  $code = @(Invoke-OrcaWindowsSsh)[-1]
  if ($MyInvocation.MyCommand.Path) { exit ([int]$code) }
}
