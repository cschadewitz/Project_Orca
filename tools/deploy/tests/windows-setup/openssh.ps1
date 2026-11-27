<#
The OpenSSH Server bootstrap (#1238), orca-windows-ssh.ps1, without changing this machine:

  powershell -NoProfile -ExecutionPolicy Bypass -File openssh.ps1

First its firewall reading, as shipped, over scripted rules and profiles. Then the whole run,
with what it reads replaced by scripted states and its changes by recorders, so each check sees
exactly what the bootstrap would ask, say and change, and that sshd is never started before
SSH is allowed over Tailscale alone. Its real read-only probe of this machine runs once too.
Exits non-zero on the first check that fails.
#>
$ErrorActionPreference = "Stop"
$shipped = Join-Path $PSScriptRoot "..\..\orca-windows-ssh.ps1"
. $shipped

function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw "FAILED: $message" } }

$checks = 0
function Check([string]$title) { $script:checks++; Microsoft.PowerShell.Utility\Write-Host "  - $title" }

function New-Rule([string]$name, [string]$protocol = "TCP", [string[]]$ports = @("22"), [string[]]$interfaces = @("Any"),
  [string]$program = "Any", [string]$store = "Local", [bool]$enabled = $true, [string]$service = "Any", [string]$package = "") {
  return [pscustomobject]@{
    Name = $name; DisplayName = "rule $name"; Enabled = $enabled; Direction = "Inbound"; Action = "Allow"; Store = $store
    Protocol = $protocol; LocalPort = $ports; Interfaces = $interfaces; Program = $program; Service = $service; Package = $package
  }
}
$ours = New-Rule $RuleName -interfaces @("Tailscale")
$on = @([pscustomobject]@{ Name = "Domain"; Enabled = $true; DefaultInbound = "Block" }, [pscustomobject]@{ Name = "Public"; Enabled = $true; DefaultInbound = "Block" })
function Get-Measured([object[]]$allowing, [object[]]$mine = @($ours), [object[]]$profiles = $on) {
  return Measure-OrcaFirewall ([pscustomobject]@{ Allowing = $allowing; Ours = $mine; Profiles = $profiles })
}

try {
  Check "the real read-only probe of this machine answers every question"
  # In its own process: in this one Get-OrcaSshState is replaced below.
  $probe = powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command `
    ". '$shipped'; Get-OrcaSshState | ConvertTo-Json -Compress -Depth 4"
  Assert ($LASTEXITCODE -eq 0) "the probe failed: $probe"
  $found = ConvertFrom-Json ([string]($probe | Select-Object -Last 1))
  foreach ($name in @("Available", "Installed", "Automatic", "Running", "Tailscale")) {
    Assert ($found.$name -is [bool]) "the probe's $name is $($found.$name)"
  }
  Assert ($null -eq $found.Firewall.PSObject.Properties["Error"]) "the firewall could not be read: $($found.Firewall.Error)"
  Assert ($found.Firewall.Ours -in @("missing", "ok", "wrong")) "the probe's own rule is $($found.Firewall.Ours)"
  Microsoft.PowerShell.Utility\Write-Host "      $([string]($probe | Select-Object -Last 1))"

  Check "the firewall reading: its own rule only when exactly TCP 22 over Tailscale"
  Assert ((Get-Measured @()).Ours -eq "ok") "the exact rule is not ours"
  Assert ((Get-Measured @() @()).Ours -eq "missing") "no rule is not missing"
  foreach ($wrong in @(
      (New-Rule $RuleName), (New-Rule $RuleName -interfaces @("Tailscale") -enabled $false),
      (New-Rule $RuleName -interfaces @("Tailscale") -ports @("22", "23")), (New-Rule $RuleName -protocol "Any" -interfaces @("Tailscale")),
      (New-Rule $RuleName -interfaces @("Tailscale", "Ethernet")), (New-Rule $RuleName -interfaces @("Tailscale") -store "GroupPolicy"))) {
    Assert ((Get-Measured @() @($wrong)).Ours -eq "wrong") "a rule by its name with another scope is taken as its own: $(ConvertTo-Json -Compress $wrong)"
  }

  Check "the firewall reading: every enabled rule that allows SSH elsewhere is found, and none that does not"
  $broad = New-Rule $BroadRule -program "C:\Windows\System32\OpenSSH\sshd.exe"
  $measured = Get-Measured @($broad)
  Assert ($measured.Broad -and -not $measured.Others.Count) "the feature's own rule: $(ConvertTo-Json -Compress $measured)"
  foreach ($open in @(
      (New-Rule "any-port" -ports @("Any")), (New-Rule "range" -ports @("20-30")), (New-Rule "any-protocol" -protocol "Any"),
      (New-Rule "by-number" -protocol "6"), (New-Rule "sshd-any-port" -ports @("Any") -program "%SystemRoot%\System32\OpenSSH\SSHD.EXE"),
      (New-Rule "lan-and-tailnet" -interfaces @("Tailscale", "Ethernet")), (New-Rule "sshd-service" -service "sshd"),
      (New-Rule $BroadRule -store "GroupPolicy"))) {
    $measured = Get-Measured @($open)
    Assert ($measured.Others.Count -eq 1 -and -not $measured.Broad) "$($open.Name) is not found: $(ConvertTo-Json -Compress $measured)"
  }
  Assert ((Get-Measured @(New-Rule $BroadRule -store "GroupPolicy")).Others[0] -like "*set by GroupPolicy*") "a policy's rule is not named as one"
  foreach ($closed in @(
      (New-Rule "udp" -protocol "UDP"), (New-Rule "other-port" -ports @("3389")), (New-Rule "keyword" -ports @("RPC")),
      (New-Rule "range-above" -ports @("23-80")), (New-Rule "other-program" -ports @("Any") -program "C:\app\app.exe"),
      (New-Rule "other-service" -service "W32Time"), (New-Rule "tailnet-only" -interfaces @("Tailscale")),
      (New-Rule "store-app" -protocol "Any" -ports @("Any") -package "S-1-15-2-1910091885-1573563583-1104941280-2418270861-3411158377-2822700936-2990310272"))) {
    $measured = Get-Measured @($closed)
    Assert (-not $measured.Others.Count -and -not $measured.Broad) "$($closed.Name) is taken to allow SSH: $(ConvertTo-Json -Compress $measured)"
  }
  $measured = Get-Measured @() -profiles @([pscustomobject]@{ Name = "Private"; Enabled = $false; DefaultInbound = "Block" }, [pscustomobject]@{ Name = "Public"; Enabled = $true; DefaultInbound = "Allow" })
  Assert (($measured.Open -join ",") -eq "Private,Public") "open profiles: $($measured.Open -join ',')"
  $measured = Get-Measured @() -profiles @([pscustomobject]@{ Name = "Domain"; Enabled = $true; DefaultInbound = "NotConfigured" })
  Assert (($measured.Open -join ",") -eq "Domain") "a profile that does not say it blocks is taken as closed"

  Check "the firewall is read from the effective policy: a policy's rule seen only there stops sshd from starting"
  # Windows' firewall cmdlets stand in for by functions: the local store holds only this machine's
  # own rules, the effective one also a policy's that lets SSH in on every network.
  $script:reads = New-Object Collections.ArrayList
  $script:policy = $false
  $script:mine = $true
  function New-CimRule([string]$name, [string]$store) {
    return [pscustomobject]@{ InstanceID = $name; Name = $name; DisplayName = "rule $name"; Enabled = "True"; Direction = "Inbound"; Action = "Allow"; PolicyStoreSourceType = $store }
  }
  function Get-NetFirewallRule {
    [CmdletBinding()] param([string]$Name, [string]$Direction, [string]$Action, [string]$Enabled, [string]$PolicyStore)
    $null = $script:reads.Add("rule:$PolicyStore")
    $rules = @()
    if ($script:mine) { $rules += New-CimRule $RuleName "Local" }
    if ($PolicyStore -eq "ActiveStore" -and $script:policy) { $rules += New-CimRule "corp-ssh" "GroupPolicy" }
    if ($Name) { $rules = @($rules | Where-Object { $_.Name -eq $Name }) }
    return $rules
  }
  function Get-NetFirewallProfile {
    [CmdletBinding()] param([string]$PolicyStore)
    $null = $script:reads.Add("profile:$PolicyStore")
    if ($PolicyStore -ne "ActiveStore") { return [pscustomobject]@{ Name = "Domain"; Enabled = "NotConfigured"; DefaultInboundAction = "NotConfigured" } }
    return [pscustomobject]@{ Name = "Domain"; Enabled = "True"; DefaultInboundAction = "Block" }
  }
  function Get-NetFirewallPortFilter { param([Parameter(ValueFromPipeline = $true)]$rule) process { [pscustomobject]@{ InstanceID = $rule.InstanceID; Protocol = "TCP"; LocalPort = "22" } } }
  function Get-NetFirewallInterfaceFilter { param([Parameter(ValueFromPipeline = $true)]$rule) process { [pscustomobject]@{ InstanceID = $rule.InstanceID; InterfaceAlias = $(if ($rule.Name -eq $RuleName) { "Tailscale" } else { "Any" }) } } }
  function Get-NetFirewallApplicationFilter { param([Parameter(ValueFromPipeline = $true)]$rule) process { if (-not $script:lost) { [pscustomobject]@{ InstanceID = $rule.InstanceID; Program = "Any"; Package = "" } } } }
  function Get-NetFirewallServiceFilter { param([Parameter(ValueFromPipeline = $true)]$rule) process { [pscustomobject]@{ InstanceID = $rule.InstanceID; Service = "Any" } } }
  $script:lost = $false
  $measured = Measure-OrcaFirewall (Read-OrcaFirewall)
  Assert ($measured.Ours -eq "ok" -and -not $measured.Others.Count -and -not $measured.Open.Count) "the local rules alone: $(ConvertTo-Json -Compress $measured)"
  Assert (@($script:reads | Where-Object { $_ -notlike "*:ActiveStore" }).Count -eq 0) "read from another store: $($script:reads -join ', ')"
  $script:policy = $true
  $measured = Measure-OrcaFirewall (Read-OrcaFirewall)
  Assert (($measured.Others -join ";") -eq "rule corp-ssh (corp-ssh, set by GroupPolicy)") "the policy's rule is not found: $(ConvertTo-Json -Compress $measured)"
  # A filter that cannot be read is no answer: the reading fails, and the run refuses.
  $script:lost = $true
  $failed = ""
  try { $null = Read-OrcaFirewall } catch { $failed = $_.Exception.Message }
  Assert ($failed -like "*could not read the scope of the firewall rule*") "a rule with no filter was read as: $failed"
  Assert ((Get-OrcaFirewallState).PSObject.Properties["Error"]) "an unreadable firewall is not reported as one"
  $script:lost = $false
  # The run: installed and stopped, no rule of its own yet; a policy's rule appears in the effective
  # policy as the firewall step runs, and the check before the start, which reads it there, stops it.
  $script:policy = $false
  $script:mine = $false
  $script:started = $false
  function Get-Service { [CmdletBinding()] param([string]$Name) [pscustomobject]@{ StartType = "Manual"; Status = "Stopped" } }
  function Get-WindowsCapability { [CmdletBinding()] param([switch]$Online, [string]$Name) [pscustomobject]@{ State = "Installed" } }
  function Get-NetAdapter { [CmdletBinding()] param([string]$Name) [pscustomobject]@{ Name = "Tailscale" } }
  function Test-OrcaElevated { return $true }
  function Read-OrcaConsent([string]$question) { return "y" }
  function Set-OrcaSshFirewall { $script:mine = $true; $script:policy = $true }
  function Start-OrcaSshService { $script:started = $true }
  $script:reads.Clear()
  $state = Get-OrcaSshState
  Assert ($state.Firewall.Ours -eq "missing" -and -not $state.Firewall.Others.Count) "before the run: $(ConvertTo-Json -Compress $state.Firewall)"
  $code = @(Invoke-OrcaWindowsSsh)[-1]
  Assert ($code -eq 1) "exit $code"
  Assert (-not $script:started) "sshd was started with a policy's rule letting SSH in everywhere"
  Assert (@($script:reads | Where-Object { $_ -notlike "*:ActiveStore" }).Count -eq 0) "read from another store: $($script:reads -join ', ')"
  foreach ($name in @("Get-NetFirewallRule", "Get-NetFirewallProfile", "Get-NetFirewallPortFilter", "Get-NetFirewallInterfaceFilter",
      "Get-NetFirewallApplicationFilter", "Get-NetFirewallServiceFilter", "Get-Service", "Get-WindowsCapability", "Get-NetAdapter",
      "Test-OrcaElevated", "Read-OrcaConsent", "Set-OrcaSshFirewall", "Start-OrcaSshService")) {
    Remove-Item -LiteralPath "function:$name"
  }
  # The shipped ones back, for the run below to replace again.
  . $shipped

  # From here on, the run: the seams are what the machine looks like, the answer typed, and what was changed.
  $script:said = New-Object Collections.ArrayList
  $script:changed = New-Object Collections.ArrayList
  $script:asked = 0
  function Write-Host([string]$line) { $null = $script:said.Add($line); Microsoft.PowerShell.Utility\Write-Host "      $line" }
  function Get-OrcaSshState { return $script:state }
  function Test-OrcaElevated { return $script:elevated }
  function Read-OrcaConsent([string]$question) { $script:asked++; return $script:answer }
  function Install-OrcaSshFeature {
    $null = $script:changed.Add("feature")
    # As Windows does: the feature comes with its rule for every network, and sshd stopped.
    $script:state.Installed = $true; $script:state.Firewall.Broad = $true
  }
  function Set-OrcaSshFirewall {
    $null = $script:changed.Add("firewall")
    if ($script:fail -eq "firewall") { throw "the firewall refused the rule" }
    $script:state.Firewall.Ours = "ok"; $script:state.Firewall.Broad = $false
    if ($script:fail -eq "appeared") { $script:state.Firewall.Others = @("rule lan (lan)") }
  }
  function Start-OrcaSshService { $null = $script:changed.Add("service"); if ($script:fail -eq "service") { throw "the service did not start" } }

  function New-State([bool]$installed, [bool]$automatic, [bool]$running, [string]$ours = "missing", [bool]$broad = $false,
    [string[]]$others = @(), [string[]]$open = @(), [bool]$tailscale = $true, [bool]$available = $true) {
    return [pscustomobject]@{
      Available = $available; Installed = $installed; Automatic = $automatic; Running = $running; Tailscale = $tailscale
      Firewall = [pscustomobject]@{ Ours = $ours; Open = $open; Broad = $broad; Others = $others }
    }
  }
  function Invoke-Case($state, [string]$answer = "", [bool]$elevated = $true, [string]$fail = "") {
    $script:said.Clear(); $script:changed.Clear(); $script:asked = 0
    $script:state = $state; $script:answer = $answer; $script:elevated = $elevated; $script:fail = $fail
    return @(Invoke-OrcaWindowsSsh)[-1]
  }
  $all = { $script:said -join "`n" }
  $nothing = {
    param([int]$code, [string]$like)
    Assert ($code -eq 2) "exit $code, not 2"
    Assert ($script:asked -eq 0) "it asked"
    Assert ($script:changed.Count -eq 0) "it changed $($script:changed -join ', ')"
    Assert ((& $all) -like "*$like*Nothing was changed.*") "it said: $(& $all)"
  }

  Check "already installed, automatic and running: nothing asked, nothing changed, its firewall left as it is"
  $code = Invoke-Case (New-State $true $true $true -broad $true -others @("x (x)")) -elevated $false
  Assert ($code -eq 0) "exit $code"
  Assert ($script:asked -eq 0 -and $script:changed.Count -eq 0) "it asked or changed something"
  Assert ((& $all) -eq "The OpenSSH Server is already on. Nothing was changed.") "it said: $(& $all)"

  Check "not on: refused before asking, nothing changed, when it is not elevated, has no Tailscale or no feature"
  & $nothing (Invoke-Case (New-State $false $false $false) "y" -elevated $false) "administrator PowerShell"
  & $nothing (Invoke-Case (New-State $false $false $false -tailscale $false) "y") "Tailscale"
  & $nothing (Invoke-Case (New-State $false $false $false -available $false) "y") "no OpenSSH Server feature"

  Check "a firewall that would leave SSH open elsewhere is refused before asking, and nothing changed"
  & $nothing (Invoke-Case (New-State $true $false $false -ours "wrong") "y") "not exactly inbound TCP 22 over the Tailscale adapter"
  & $nothing (Invoke-Case (New-State $false $false $false -open @("Public")) "y") "for the Public profile"
  & $nothing (Invoke-Case (New-State $true $false $false -others @("rule lan (lan)", "rule gpo (gpo, set by GroupPolicy)")) "y") "rule lan (lan); rule gpo (gpo, set by GroupPolicy). This changes no rule it did not make"
  $state = New-State $true $false $false
  $state.Firewall | Add-Member NoteProperty Error "Access is denied."
  & $nothing (Invoke-Case $state "y") "Could not read the Windows Firewall rules (Access is denied.)"

  Check "not installed: lists every change in order before asking, and a no changes nothing"
  foreach ($answer in @("", "n", "no", "yess", " N ")) {
    $code = Invoke-Case (New-State $false $false $false) $answer
    Assert ($code -eq 2 -and $script:asked -eq 1 -and $script:changed.Count -eq 0) "answer '$answer': exit $code, asked $script:asked, changed $($script:changed -join ', ')"
    $text = & $all
    Assert ($text -like "*Install the OpenSSH Server Windows feature*Add the firewall rule*only over the Tailscale adapter*disable the rule the feature adds for every network (OpenSSH-Server-In-TCP)*Check that SSH is allowed only over Tailscale, then set the sshd service to start automatically and start it*") "the steps are not all listed in order: $text"
    Assert ($text -like "*Windows Update maintains it*") "it does not say who maintains it: $text"
    Assert ($script:said[-1] -eq "Nothing was changed.") "the last line is '$($script:said[-1])'"
  }

  Check "a yes makes exactly the listed changes, in order, and starts sshd only once SSH is Tailscale-only"
  foreach ($answer in @("y", "Y", "yes", " yes ")) {
    $code = Invoke-Case (New-State $false $false $false) $answer
    Assert ($code -eq 0) "answer '$answer': exit $code"
    Assert (($script:changed -join ",") -eq "feature,firewall,service") "answer '$answer': changed $($script:changed -join ',')"
    Assert ($script:said[-1] -like "The OpenSSH Server is on, reachable over Tailscale only.*") "the last line is '$($script:said[-1])'"
  }

  Check "installed but stopped, behind the feature's every-network rule: the firewall is set before sshd starts"
  $code = Invoke-Case (New-State $true $false $false -broad $true) "y"
  Assert ($code -eq 0) "exit $code"
  Assert (($script:changed -join ",") -eq "firewall,service") "changed $($script:changed -join ',')"
  Assert ((& $all) -like "*Add the firewall rule*disable the feature's rule that allows SSH on every network (OpenSSH-Server-In-TCP)*") "it said: $(& $all)"
  Assert (-not ((& $all) -like "*Install the OpenSSH*")) "it lists the feature it already has"

  Check "installed, stopped, firewall already Tailscale-only: still checked, then only the service changed"
  $code = Invoke-Case (New-State $true $false $true -ours "ok") "y"
  Assert ($code -eq 0) "exit $code"
  Assert (($script:changed -join ",") -eq "service") "changed $($script:changed -join ',')"
  Assert (-not ((& $all) -like "*firewall rule*")) "it lists a firewall change it does not need: $(& $all)"

  Check "a failed firewall change stops the run before sshd is started"
  $code = Invoke-Case (New-State $false $false $false) "y" -fail "firewall"
  Assert ($code -eq 1) "exit $code"
  Assert (($script:changed -join ",") -eq "feature,firewall") "changed $($script:changed -join ',')"
  Assert ((& $all) -like "*Could not add the firewall rule*the firewall refused the rule*sshd was not started by this run*run this again*") "it said: $(& $all)"

  Check "a firewall still open elsewhere after its change is caught by the check, and sshd is not started"
  $code = Invoke-Case (New-State $true $false $false) "y" -fail "appeared"
  Assert ($code -eq 1) "exit $code"
  Assert (($script:changed -join ",") -eq "firewall") "changed $($script:changed -join ',')"
  Assert ((& $all) -like "*Could not check that SSH is allowed only over Tailscale*rule lan (lan)*sshd was not started by this run*") "it said: $(& $all)"

  Check "a rerun after a partial failure picks up where it stopped, and checks again before starting sshd"
  $state = New-State $false $false $false
  $null = Invoke-Case $state "y" -fail "firewall"
  $code = Invoke-Case $state "y"
  Assert ($code -eq 0) "exit $code"
  Assert (($script:changed -join ",") -eq "firewall,service") "changed $($script:changed -join ',')"

  Check "a service that fails to start says so"
  $code = Invoke-Case (New-State $true $false $false -ours "ok") "y" -fail "service"
  Assert ($code -eq 1 -and (& $all) -like "*Could not check that SSH is allowed only over Tailscale, then set the sshd service*did not start*") "exit $code, said: $(& $all)"

  Microsoft.PowerShell.Utility\Write-Host "  all $checks OpenSSH bootstrap checks passed"
} catch {
  Microsoft.PowerShell.Utility\Write-Host $_.Exception.Message
  exit 1
}
exit 0
