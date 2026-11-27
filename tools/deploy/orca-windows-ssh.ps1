<#
.SYNOPSIS
Turn on the Windows OpenSSH Server so ORCA can set this machine up over your tailnet (#1238,
incubating).

.DESCRIPTION
Run once, from an administrator PowerShell on the Windows machine that will host an ORCA
server. ORCA then reaches it over SSH like any other host, and its own setup
(orca-server-setup.ps1) does the rest as the account you sign in with. Get the line that
downloads and runs it from your ORCA (Add a machine, or `orca-cli remote windows-ssh`): it
checks the file is exactly the one that ORCA ships before running it.

This uses only what Windows ships: the OpenSSH Server optional feature, which Windows Update
installs and keeps updated. ORCA does not bundle, update or configure it beyond the steps
below, and you maintain nothing for it beyond Windows Update.

If the OpenSSH Server is already installed, set to start automatically and running, this
changes nothing, including its firewall rules, and says so. Otherwise it lists exactly what
it would change and asks first; anything but `y` changes nothing. Only the steps still needed,
in this order:

1. feature   Install the OpenSSH Server Windows feature (OpenSSH.Server), from Windows Update.
2. firewall  Allow inbound SSH (TCP 22) only over the Tailscale network adapter, with the rule
             "ORCA: OpenSSH Server over Tailscale", and disable the rule the feature adds for
             every network ("OpenSSH-Server-In-TCP").
3. service   Check that SSH is then allowed only over Tailscale, and only then set the sshd
             service to start automatically and start it.

Before asking, it refuses, changing nothing, when sshd would not be reachable over Tailscale
alone: a Windows Firewall profile that is off or allows inbound connections by default, any
other enabled rule that allows SSH on another network (it changes no rule it did not make,
and none a policy manages), or a rule by its own name with another scope. A step that fails
stops the run before sshd is started; run it again to finish.

It needs Tailscale installed and signed in (its "Tailscale" network adapter).

Exit codes: 0 on (or already on), 1 a step failed, 2 nothing changed (declined, not an
administrator, no Tailscale adapter, a Windows without the feature, or a firewall that would
leave SSH open elsewhere).
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

function ConvertTo-OrcaRule($rule, $ports, $interfaces, $programs, $services) {
  $id = [string]$rule.InstanceID
  return [pscustomobject]@{
    Name = [string]$rule.Name
    DisplayName = [string]$rule.DisplayName
    Enabled = [string]$rule.Enabled -eq "True"
    Direction = [string]$rule.Direction
    Action = [string]$rule.Action
    Store = [string]$rule.PolicyStoreSourceType
    Protocol = [string]$ports[$id].Protocol
    LocalPort = @($ports[$id].LocalPort | ForEach-Object { [string]$_ })
    Interfaces = @($interfaces[$id].InterfaceAlias | ForEach-Object { [string]$_ })
    Program = [string]$programs[$id].Program
    Service = [string]$services[$id].Service
  }
}

function Read-OrcaFirewallRules($rules) {
  # Each filter read once for all the rules, by the rule it belongs to.
  $rules = @($rules | Where-Object { $null -ne $_ })
  if (-not $rules.Count) { return @() }
  $by = {
    param($filters)
    $map = @{}
    foreach ($filter in @($filters)) { $map[[string]$filter.InstanceID] = $filter }
    return $map
  }
  $ports = & $by ($rules | Get-NetFirewallPortFilter)
  $interfaces = & $by ($rules | Get-NetFirewallInterfaceFilter)
  $programs = & $by ($rules | Get-NetFirewallApplicationFilter)
  $services = & $by ($rules | Get-NetFirewallServiceFilter)
  return @($rules | ForEach-Object { ConvertTo-OrcaRule $_ $ports $interfaces $programs $services })
}

function Read-OrcaFirewall {
  return [pscustomobject]@{
    Allowing = Read-OrcaFirewallRules (Get-NetFirewallRule -Direction Inbound -Action Allow -Enabled True -ErrorAction SilentlyContinue)
    Ours = @(Read-OrcaFirewallRules (Get-NetFirewallRule -Name $RuleName -ErrorAction SilentlyContinue))
    Profiles = @(Get-NetFirewallProfile | ForEach-Object {
        [pscustomobject]@{ Name = [string]$_.Name; Enabled = [string]$_.Enabled -eq "True"; DefaultInbound = [string]$_.DefaultInboundAction }
      })
  }
}

function Test-OrcaPortCovers22([string[]]$ports) {
  foreach ($port in $ports) {
    if ($port -eq "Any" -or $port -eq "22") { return $true }
    if ($port -match '^(\d+)-(\d+)$' -and [int]$Matches[1] -le 22 -and [int]$Matches[2] -ge 22) { return $true }
  }
  return $false
}

function Test-OrcaRuleAllowsSsh($rule) {
  # Inbound TCP 22 to sshd, on some network other than Tailscale's alone.
  if ($rule.Protocol -notin @("TCP", "Any", "6")) { return $false }
  if (-not (Test-OrcaPortCovers22 $rule.LocalPort)) { return $false }
  if ($rule.Program -and $rule.Program -ne "Any" -and -not $rule.Program.EndsWith("\sshd.exe", [StringComparison]::OrdinalIgnoreCase)) { return $false }
  if ($rule.Service -and $rule.Service -ne "Any" -and $rule.Service -ne $Service) { return $false }
  return -not ($rule.Interfaces.Count -eq 1 -and $rule.Interfaces[0] -eq $Adapter)
}

function Test-OrcaRuleIsOurs($rule) {
  return $rule.Enabled -and $rule.Direction -eq "Inbound" -and $rule.Action -eq "Allow" -and $rule.Store -eq "Local" -and
  $rule.Protocol -eq "TCP" -and $rule.LocalPort.Count -eq 1 -and $rule.LocalPort[0] -eq "22" -and
  $rule.Interfaces.Count -eq 1 -and $rule.Interfaces[0] -eq $Adapter -and
  (-not $rule.Program -or $rule.Program -eq "Any") -and (-not $rule.Service -or $rule.Service -eq "Any")
}

function Measure-OrcaFirewall($firewall) {
  # What stands between sshd and every network but Tailscale's: nothing here changes anything.
  $ours = if (-not $firewall.Ours.Count) { "missing" } elseif ($firewall.Ours.Count -eq 1 -and (Test-OrcaRuleIsOurs $firewall.Ours[0])) { "ok" } else { "wrong" }
  $open = @($firewall.Profiles | Where-Object { -not $_.Enabled -or $_.DefaultInbound -eq "Allow" } | ForEach-Object { $_.Name })
  $allowing = @($firewall.Allowing | Where-Object { $_.Name -ne $RuleName -and (Test-OrcaRuleAllowsSsh $_) })
  return [pscustomobject]@{
    Ours = $ours
    Open = $open
    # The feature's own every-network rule, which this may disable, and every other one, which it never changes.
    Broad = @($allowing | Where-Object { $_.Name -eq $BroadRule -and $_.Store -eq "Local" }).Count -gt 0
    Others = @($allowing | Where-Object { -not ($_.Name -eq $BroadRule -and $_.Store -eq "Local") } | ForEach-Object {
        if ($_.Store -and $_.Store -ne "Local") { "$($_.DisplayName) ($($_.Name), set by $($_.Store))" } else { "$($_.DisplayName) ($($_.Name))" }
      })
  }
}

function Get-OrcaFirewallState {
  try {
    return Measure-OrcaFirewall (Read-OrcaFirewall)
  } catch {
    return [pscustomobject]@{ Ours = "unknown"; Open = @(); Broad = $false; Others = @(); Error = $_.Exception.Message }
  }
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
    Tailscale = $null -ne (Get-NetAdapter -Name $Adapter -ErrorAction SilentlyContinue)
    Firewall = Get-OrcaFirewallState
  }
}

function Get-OrcaFirewallRefusal($firewall) {
  # Why SSH would still be open on another network whatever this did: for the person to change.
  if ($firewall.PSObject.Properties["Error"]) {
    return "Could not read the Windows Firewall rules ($($firewall.Error)), so it cannot tell whether SSH would be open on other networks."
  }
  if ($firewall.Ours -eq "wrong") {
    return "The firewall rule `"$RuleDisplay`" ($RuleName) is there but not exactly inbound TCP 22 over the Tailscale adapter. Remove it, then run this again."
  }
  if ($firewall.Open.Count) {
    return "Windows Firewall is off, or allows inbound connections by default, for the $($firewall.Open -join ', ') profile(s), so SSH would be open on every network. Turn it on and block inbound by default, then run this again."
  }
  if ($firewall.Others.Count) {
    return "These enabled firewall rules allow SSH on networks other than Tailscale: $($firewall.Others -join '; '). This changes no rule it did not make; disable or narrow them, then run this again."
  }
  return ""
}

# -- the changes (each one step, so tests can stand in for it) ----------------------------------

function Install-OrcaSshFeature {
  # The service it adds stays stopped until the firewall step below is done and checked.
  $null = Add-WindowsCapability -Online -Name $Capability
}

function Set-OrcaSshFirewall {
  if (-not (Get-NetFirewallRule -Name $RuleName -ErrorAction SilentlyContinue)) {
    $null = New-NetFirewallRule -Name $RuleName -DisplayName $RuleDisplay -Direction Inbound -Action Allow `
      -Protocol TCP -LocalPort 22 -InterfaceAlias $Adapter -Profile Any `
      -Description "Added by orca-windows-ssh.ps1 (ORCA #1238): SSH only over the Tailscale adapter."
  }
  # Added again by the feature when it is installed: disabled after that, every time.
  $broad = Get-NetFirewallRule -Name $BroadRule -PolicyStore PersistentStore -ErrorAction SilentlyContinue
  if ($broad -and [string]$broad.Enabled -eq "True") { $null = $broad | Disable-NetFirewallRule }
}

function Assert-OrcaSshTailnetOnly {
  $firewall = (Get-OrcaSshState).Firewall
  $refusal = Get-OrcaFirewallRefusal $firewall
  if ($refusal) { throw $refusal }
  if ($firewall.Ours -ne "ok") { throw "the firewall rule `"$RuleDisplay`" is not in place" }
  if ($firewall.Broad) { throw "the rule $BroadRule still allows SSH on every network" }
}

function Start-OrcaSshService {
  Set-Service -Name $Service -StartupType Automatic
  Start-Service -Name $Service
}

function Read-OrcaConsent([string]$question) {
  try { return [string](Read-Host $question) } catch { return "" }
}

# -- the run ------------------------------------------------------------------------------------

function Invoke-OrcaWindowsSsh {
  $state = Get-OrcaSshState
  if ($state.Installed -and $state.Automatic -and $state.Running) {
    # Its firewall policy is the person's own: left as it is, and not called Tailscale-only.
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
  $refusal = Get-OrcaFirewallRefusal $state.Firewall
  if ($refusal) {
    Write-Host "$refusal Nothing was changed."
    return 2
  }
  $steps = @()
  if (-not $state.Installed) {
    $steps += , @("install the OpenSSH Server Windows feature (OpenSSH.Server) from Windows Update, which keeps it updated", "Install-OrcaSshFeature")
  }
  # The firewall is set and checked on every run that starts sshd, before it starts.
  $firewall = @()
  if ($state.Firewall.Ours -ne "ok") { $firewall += "add the firewall rule `"$RuleDisplay`", which allows inbound SSH (TCP 22) only over the Tailscale adapter" }
  if (-not $state.Installed) { $firewall += "disable the rule the feature adds for every network ($BroadRule)" }
  elseif ($state.Firewall.Broad) { $firewall += "disable the feature's rule that allows SSH on every network ($BroadRule)" }
  if ($firewall.Count) { $steps += , @($firewall -join ", and ", "Set-OrcaSshFirewall") }
  $steps += , @("check that SSH is allowed only over Tailscale, then set the sshd service to start automatically and start it", "Start-OrcaSshService")
  Write-Host "To let ORCA reach this machine over your tailnet, this would, in order:"
  foreach ($step in $steps) { Write-Host "  - $($step[0].Substring(0, 1).ToUpper() + $step[0].Substring(1))." }
  Write-Host "ORCA does not bundle or update the OpenSSH Server; Windows Update maintains it."
  $answer = Read-OrcaConsent "Make these changes? [y/N]"
  if ($answer.Trim() -notmatch '^(y|yes)$') {
    Write-Host "Nothing was changed."
    return 2
  }
  foreach ($step in $steps) {
    try {
      if ($step[1] -eq "Start-OrcaSshService") { Assert-OrcaSshTailnetOnly }
      & $step[1]
    } catch {
      Write-Host "Could not $($step[0]): $($_.Exception.Message)"
      Write-Host "sshd was not started by this run. The steps before it stay done; run this again to finish."
      return 1
    }
  }
  Write-Host "The OpenSSH Server is on, reachable over Tailscale only. Add this machine from ORCA: Add a machine, or orca-cli remote add you@this-machine --tailnet."
  return 0
}

# Dot-sourced (the tests), only the functions; run from a file, its exit code; pasted or piped
# into a session, the session stays open.
if ($MyInvocation.InvocationName -ne ".") {
  $code = @(Invoke-OrcaWindowsSsh)[-1]
  if ($MyInvocation.MyCommand.Path) { exit ([int]$code) }
}
