<#
.SYNOPSIS
Turn on the Windows OpenSSH Server so ORCA can set this machine up over your tailnet (#1238,
incubating).

.DESCRIPTION
Run once, from an administrator PowerShell on the Windows machine that will host an ORCA
server. ORCA then reaches it over SSH like any other host, and its own setup
(orca-server-setup.ps1) does the rest as the account you sign in with. Get the line that
fetches and runs it from your ORCA (Add a machine, or `orca-cli remote windows-ssh`): it fetches
it into memory and runs those bytes only if they are exactly the copy that ORCA ships.

This uses only what Windows ships: the OpenSSH Server optional feature, which Windows Update
installs and keeps updated. ORCA does not bundle, update or configure it beyond the steps
below, and you maintain nothing for it beyond Windows Update.

If the OpenSSH Server is already installed, set to start automatically and running, this
changes nothing, including its firewall rules, and says so (unless it set this machine up itself
and a network adapter has been added since: then it offers to update its own adapter rule). Otherwise it lists exactly what
it would change and asks first; anything but `y` changes nothing. Only the steps still needed,
in this order:

1. feature   Install the OpenSSH Server Windows feature (OpenSSH.Server), from Windows Update.
2. firewall  Allow inbound SSH (TCP 22) over the Tailscale network adapter, with the rule
             "ORCA: OpenSSH Server over Tailscale"; block inbound SSH on every other network
             adapter there is, with the rule "ORCA: Block OpenSSH Server on other network
             adapters"; block it from every address outside Tailscale's (100.64.0.0/10 and
             fd7a:115c:a1e0::/48) on any adapter, with the rule "ORCA: Block OpenSSH Server
             outside Tailscale"; and disable the rule the feature adds for every network
             ("OpenSSH-Server-In-TCP").
3. service   Check that SSH is then blocked on every other adapter, and only then set the
             sshd service to start automatically and start it.

A Windows Firewall block rule wins over every allow rule, local or a policy's, so other rules
that allow inbound connections (Windows' own app rules, say) cannot open SSH on another
adapter; they are listed, and left as they are. An adapter added or enabled later is not named by the
adapter rule until this runs again (the address rule still applies to it); run this again after
adding one, and it updates its own rule. Before asking, it refuses, changing nothing, when that block
would not hold: a Windows Firewall profile that is off or does not block inbound connections by
default, a policy that turns local rules off (the ORCA rules would not apply), an enabled rule
that lets SSH past block rules (OverrideBlockRules), a rule by one of its own names with another
scope, or a firewall it cannot read in full. It reads the effective policy (ActiveStore: local
rules and every policy's) and changes local rules only (PersistentStore). It also refuses an
sshd_config that listens anywhere but port 22, or that it cannot read in full (an Include, say):
the firewall it sets up is for port 22 alone. A step that fails stops the run before sshd is
started; run it again to finish.

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
$BlockName = "ORCA-OpenSSH-Server-Block-Off-Tailscale"
$BlockDisplay = "ORCA: Block OpenSSH Server outside Tailscale"
# Every address but Tailscale's: 100.64.0.0/10 and fd7a:115c:a1e0::/48.
$OffTailnet = @("0.0.0.0-100.63.255.255", "100.128.0.0-255.255.255.255",
  "::-fd7a:115c:a1df:ffff:ffff:ffff:ffff:ffff", "fd7a:115c:a1e1::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff")
$EdgeName = "ORCA-OpenSSH-Server-Block-Other-Adapters"
$EdgeDisplay = "ORCA: Block OpenSSH Server on other network adapters"
$BroadRule = "OpenSSH-Server-In-TCP"

# -- what is there (read only) ------------------------------------------------------------------

function Test-OrcaElevated {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function ConvertTo-OrcaRule($rule, $ports, $interfaces, $programs, $services, $addresses, $types, $security) {
  $id = [string]$rule.InstanceID
  # A rule whose scope could not be read is not taken as closed.
  foreach ($filter in @($ports, $interfaces, $programs, $services, $addresses, $types, $security)) {
    if ($null -eq $filter[$id]) { throw "could not read the scope of the firewall rule $($rule.Name)" }
  }
  if ([string]$rule.Enabled -notin @("True", "False")) { throw "could not tell whether the firewall rule $($rule.Name) is enabled" }
  $override = [string]$security[$id].OverrideBlockRules
  if ($override -notin @("True", "False")) { throw "could not tell whether the firewall rule $($rule.Name) overrides block rules" }
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
    # An app package's own rule: only that package's app container is let in, never sshd.
    Package = [string]$programs[$id].Package
    Owner = [string]$rule.Owner
    Service = [string]$services[$id].Service
    Profile = [string]$rule.Profile
    LocalAddress = @($addresses[$id].LocalAddress | ForEach-Object { [string]$_ })
    RemoteAddress = @($addresses[$id].RemoteAddress | ForEach-Object { [string]$_ })
    InterfaceType = [string]$types[$id].InterfaceType
    # Lets authenticated connections past every block rule, ours included.
    Override = $override -eq "True"
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
  $addresses = & $by ($rules | Get-NetFirewallAddressFilter)
  $types = & $by ($rules | Get-NetFirewallInterfaceTypeFilter)
  $security = & $by ($rules | Get-NetFirewallSecurityFilter)
  return @($rules | ForEach-Object { ConvertTo-OrcaRule $_ $ports $interfaces $programs $services $addresses $types $security })
}

function Get-OrcaActiveRules([hashtable]$query) {
  # The effective policy (ActiveStore): local rules and every policy's, as Windows enforces them.
  # Only "none found" is an empty answer; any other failure ends the reading.
  try {
    return @(Get-NetFirewallRule -PolicyStore ActiveStore @query -ErrorAction Stop)
  } catch {
    if ($_.CategoryInfo.Category -eq "ObjectNotFound") { return @() }
    throw
  }
}

function Read-OrcaFirewall {
  $profiles = @(Get-NetFirewallProfile -PolicyStore ActiveStore -ErrorAction Stop | ForEach-Object {
      $enabled = [string]$_.Enabled
      if ($enabled -notin @("True", "False")) { throw "could not tell whether the $($_.Name) firewall profile is on ($enabled)" }
      [pscustomobject]@{
        Name = [string]$_.Name; Enabled = $enabled -eq "True"; DefaultInbound = [string]$_.DefaultInboundAction
        # Whether local rules (the ORCA ones) apply at all: a policy may turn them off.
        LocalRules = [string]$_.AllowLocalFirewallRules
      }
    })
  if (-not $profiles.Count) { throw "could not read the firewall profiles" }
  return [pscustomobject]@{
    Allowing = Read-OrcaFirewallRules (Get-OrcaActiveRules @{ Direction = "Inbound"; Action = "Allow"; Enabled = "True" })
    Ours = @(Read-OrcaFirewallRules (Get-OrcaActiveRules @{ Name = $RuleName }))
    Block = @(Read-OrcaFirewallRules (Get-OrcaActiveRules @{ Name = $BlockName }))
    Edge = @(Read-OrcaFirewallRules (Get-OrcaActiveRules @{ Name = $EdgeName }))
    Adapters = Get-OrcaOtherAdapters
    Profiles = $profiles
  }
}

function Get-OrcaOtherAdapters {
  # Every IP interface but Tailscale's and loopback, connected or not: where SSH could come in, and
  # what the firewall names an adapter by. An adapter with none (disabled, or a virtual function
  # that carries another one's traffic) takes no IP traffic itself until it has one; then it is
  # here, and this rule needs updating. Read in full or not at all.
  $names = @(Get-NetIPInterface -ErrorAction Stop | ForEach-Object { [string]$_.InterfaceAlias })
  return @($names | Where-Object { $_ -and $_ -ne $Adapter -and $_ -notmatch '^Loopback Pseudo-Interface' } | Sort-Object -Unique)
}

function ConvertTo-OrcaAddressRanges([string[]]$addresses) {
  # Addresses ("a", "a-b", "a/bits" or "a/mask") as merged numeric ranges, one "family:first-last"
  # each, so two spellings of the same set compare equal. Anything else (a keyword) throws.
  $ranges = foreach ($text in $addresses) {
    $parts = @($text.Trim() -split '-', 2)
    if ($parts.Count -eq 2) {
      $first = [Net.IPAddress]::Parse($parts[0]).GetAddressBytes()
      $last = [Net.IPAddress]::Parse($parts[1]).GetAddressBytes()
    } else {
      $pieces = @($parts[0] -split '/', 2)
      $first = [Net.IPAddress]::Parse($pieces[0]).GetAddressBytes()
      $bits = $first.Length * 8
      if ($pieces.Count -eq 2) {
        if ($pieces[1] -match '^\d+$') { $bits = [int]$pieces[1] }
        else { $bits = 0; foreach ($byte in [Net.IPAddress]::Parse($pieces[1]).GetAddressBytes()) { for ($b = 7; $b -ge 0; $b--) { if ($byte -band (1 -shl $b)) { $bits++ } } } }
      }
      $last = [byte[]]$first.Clone()
      for ($i = 0; $i -lt $first.Length; $i++) {
        $keep = [Math]::Max(0, [Math]::Min(8, $bits - 8 * $i))
        $mask = (0xFF -shl (8 - $keep)) -band 0xFF
        $first[$i] = $first[$i] -band $mask
        $last[$i] = $first[$i] -bor ((-bnot $mask) -band 0xFF)
      }
    }
    if ($first.Length -ne $last.Length) { throw "the address range $text mixes IPv4 and IPv6" }
    $number = { param($bytes) [Numerics.BigInteger]::Parse("0" + (-join ($bytes | ForEach-Object { $_.ToString("x2") })), "AllowHexSpecifier") }
    [pscustomobject]@{ Family = $first.Length; First = & $number $first; Last = & $number $last }
  }
  $merged = New-Object Collections.ArrayList
  foreach ($range in @($ranges | Sort-Object Family, First)) {
    $previous = if ($merged.Count) { $merged[$merged.Count - 1] } else { $null }
    if ($previous -and $previous.Family -eq $range.Family -and $range.First -le $previous.Last + 1) {
      if ($range.Last -gt $previous.Last) { $previous.Last = $range.Last }
    } else { $null = $merged.Add([pscustomobject]@{ Family = $range.Family; First = $range.First; Last = $range.Last }) }
  }
  return @($merged | ForEach-Object { "$($_.Family):$($_.First)-$($_.Last)" })
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
  # Only a rule constrained to an app package (an app container's SID) is known not to match
  # sshd, which runs in none. An owner alone proves nothing, and anything else counts.
  if ($rule.PSObject.Properties["Package"] -and $rule.Package -match '^S-1-15-2-[0-9-]+$') { return $false }
  return -not ($rule.Interfaces.Count -eq 1 -and $rule.Interfaces[0] -eq $Adapter)
}

function Test-OrcaRuleIsOurs($rule) {
  return $rule.Enabled -and $rule.Direction -eq "Inbound" -and $rule.Action -eq "Allow" -and $rule.Store -eq "Local" -and
  $rule.Protocol -eq "TCP" -and $rule.LocalPort.Count -eq 1 -and $rule.LocalPort[0] -eq "22" -and
  $rule.Interfaces.Count -eq 1 -and $rule.Interfaces[0] -eq $Adapter -and
  (-not $rule.Program -or $rule.Program -eq "Any") -and (-not $rule.Service -or $rule.Service -eq "Any")
}

function Test-OrcaBlockIsOurs($rule) {
  # Inbound TCP 22 blocked from exactly every address outside Tailscale's, on every network.
  if (-not ($rule.Enabled -and $rule.Direction -eq "Inbound" -and $rule.Action -eq "Block" -and $rule.Store -eq "Local" -and
      $rule.Profile -eq "Any" -and $rule.Protocol -eq "TCP" -and $rule.LocalPort.Count -eq 1 -and $rule.LocalPort[0] -eq "22" -and
      $rule.Interfaces.Count -eq 1 -and $rule.Interfaces[0] -eq "Any" -and $rule.InterfaceType -eq "Any" -and
      (-not $rule.Program -or $rule.Program -eq "Any") -and -not $rule.Package -and (-not $rule.Service -or $rule.Service -eq "Any") -and
      $rule.LocalAddress.Count -eq 1 -and $rule.LocalAddress[0] -eq "Any")) { return $false }
  try {
    return ((ConvertTo-OrcaAddressRanges $rule.RemoteAddress) -join ",") -eq ((ConvertTo-OrcaAddressRanges $OffTailnet) -join ",")
  } catch { return $false }
}

function Measure-OrcaEdge($rules, [string[]]$adapters) {
  # The rule that blocks SSH on every other adapter: "ok", "stale" (an adapter it does not name yet,
  # which the firewall step adds), "wrong" (another scope), or "missing" (none, while one is needed).
  if (-not $rules.Count) { if ($adapters.Count) { return "missing" } else { return "ok" } }
  $rule = $rules[0]
  if ($rules.Count -ne 1 -or -not ($rule.Enabled -and $rule.Direction -eq "Inbound" -and $rule.Action -eq "Block" -and $rule.Store -eq "Local" -and
      $rule.Profile -eq "Any" -and $rule.Protocol -eq "TCP" -and $rule.LocalPort.Count -eq 1 -and $rule.LocalPort[0] -eq "22" -and
      $rule.InterfaceType -eq "Any" -and (-not $rule.Program -or $rule.Program -eq "Any") -and -not $rule.Package -and
      (-not $rule.Service -or $rule.Service -eq "Any") -and $rule.LocalAddress.Count -eq 1 -and $rule.LocalAddress[0] -eq "Any" -and
      $rule.RemoteAddress.Count -eq 1 -and $rule.RemoteAddress[0] -eq "Any")) { return "wrong" }
  # Never Tailscale's own adapter, nor every adapter (which would be Tailscale's too).
  if (-not $rule.Interfaces.Count -or $rule.Interfaces -contains "Any" -or $rule.Interfaces -contains $Adapter) { return "wrong" }
  if (@($adapters | Where-Object { $rule.Interfaces -notcontains $_ }).Count) { return "stale" }
  return "ok"
}

function Measure-OrcaFirewall($firewall) {
  # What stands between sshd and every network but Tailscale's: nothing here changes anything.
  $one = {
    param($rules, $test)
    if (-not $rules.Count) { "missing" } elseif ($rules.Count -eq 1 -and (& $test $rules[0])) { "ok" } else { "wrong" }
  }
  # Only a profile that is on and blocks inbound by default counts as closed.
  $open = @($firewall.Profiles | Where-Object { -not $_.Enabled -or $_.DefaultInbound -ne "Block" } | ForEach-Object { $_.Name })
  # Local rules apply unless a policy says otherwise; anything else is not taken as applying.
  $local = @($firewall.Profiles | Where-Object { $_.LocalRules -notin @("True", "NotConfigured") } | ForEach-Object { $_.Name })
  $allowing = @($firewall.Allowing | Where-Object { $_.Name -ne $RuleName -and (Test-OrcaRuleAllowsSsh $_) })
  $named = {
    param($rule)
    if ($rule.Store -and $rule.Store -ne "Local") { "$($rule.DisplayName) ($($rule.Name), set by $($rule.Store))" } else { "$($rule.DisplayName) ($($rule.Name))" }
  }
  return [pscustomobject]@{
    Ours = & $one $firewall.Ours ${function:Test-OrcaRuleIsOurs}
    Block = & $one $firewall.Block ${function:Test-OrcaBlockIsOurs}
    Edge = Measure-OrcaEdge @($firewall.Edge) @($firewall.Adapters)
    Adapters = @($firewall.Adapters)
    Open = $open
    Local = $local
    # The feature's own every-network rule, which this may disable.
    Broad = @($allowing | Where-Object { $_.Name -eq $BroadRule -and $_.Store -eq "Local" }).Count -gt 0
    # Rules that would let SSH past the block rule: never changed here, so refused.
    Bypass = @($allowing | Where-Object { $_.Override } | ForEach-Object { & $named $_ })
    # Every other rule that may allow SSH elsewhere, which the block rule overrides: listed only.
    Others = @($allowing | Where-Object { -not $_.Override -and -not ($_.Name -eq $BroadRule -and $_.Store -eq "Local") } | ForEach-Object { & $named $_ })
  }
}

function Get-OrcaFirewallState {
  try {
    return Measure-OrcaFirewall (Read-OrcaFirewall)
  } catch {
    return [pscustomobject]@{ Ours = "unknown"; Block = "unknown"; Edge = "unknown"; Adapters = @(); Open = @(); Local = @(); Broad = $false; Bypass = @(); Others = @(); Error = $_.Exception.Message }
  }
}

function Read-OrcaSshConfig {
  # The OpenSSH Server's own configuration, as the service reads it; none yet before its first start.
  $path = Join-Path $env:ProgramData "ssh\sshd_config"
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  return [IO.File]::ReadAllText($path)
}

function Measure-OrcaSshListen($text) {
  # The ports sshd would listen on, or why that cannot be told here. Only port 22 is set up.
  $ports = New-Object Collections.ArrayList
  if ($null -ne $text) {
    foreach ($raw in ($text -split "`r?`n")) {
      $line = $raw.Trim()
      if (-not $line -or $line.StartsWith("#")) { continue }
      $words = @($line -split '[\s=]+', 2)
      $key = $words[0].ToLowerInvariant()
      $value = if ($words.Count -gt 1) { $words[1].Trim() } else { "" }
      if ($key -eq "include") { return [pscustomobject]@{ Ports = @(); Problem = "sshd_config includes other files ($value)" } }
      if ($key -eq "port") {
        if ($value -notmatch '^\d{1,5}$') { return [pscustomobject]@{ Ports = @(); Problem = "sshd_config has a port this cannot read ($value)" } }
        $null = $ports.Add([int]$value)
      }
      if ($key -eq "listenaddress") {
        $address = @($value -split '\s+')[0]
        if ($address -match '^\[.*\]:(\d{1,5})$' -or $address -match '^[^:\[\]]+:(\d{1,5})$') { $null = $ports.Add([int]$Matches[1]) }
        elseif ($address -match '^\[' -or ($address -match ':' -and $address -notmatch '^[0-9A-Fa-f:]+$')) {
          return [pscustomobject]@{ Ports = @(); Problem = "sshd_config has a listen address this cannot read ($value)" }
        }
      }
    }
  }
  if (-not $ports.Count) { $null = $ports.Add(22) }
  $other = @($ports | Where-Object { $_ -ne 22 } | Sort-Object -Unique)
  if ($other.Count) { return [pscustomobject]@{ Ports = @($ports); Problem = "sshd is set to listen on port $($other -join ', ')" } }
  return [pscustomobject]@{ Ports = @(22); Problem = "" }
}

function Get-OrcaSshListen {
  try { return Measure-OrcaSshListen (Read-OrcaSshConfig) } catch { return [pscustomobject]@{ Ports = @(); Problem = "could not read sshd_config ($($_.Exception.Message))" } }
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
    Listen = Get-OrcaSshListen
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
  if ($firewall.Block -eq "wrong") {
    return "The firewall rule `"$BlockDisplay`" ($BlockName) is there but does not block exactly inbound TCP 22 from every address outside Tailscale's. Remove it, then run this again."
  }
  if ($firewall.Edge -eq "wrong") {
    return "The firewall rule `"$EdgeDisplay`" ($EdgeName) is there but does not block exactly inbound TCP 22 on network adapters other than Tailscale's. Remove it, then run this again."
  }
  if ($firewall.Open.Count) {
    return "Windows Firewall is off, or does not block inbound connections by default, for the $($firewall.Open -join ', ') profile(s), so SSH would be open on every network. Turn it on and block inbound by default, then run this again."
  }
  if ($firewall.Local.Count) {
    return "A policy turns off local firewall rules for the $($firewall.Local -join ', ') profile(s), so the rules this adds would not apply. Ask whoever manages this machine's firewall to allow local rules or to limit SSH to Tailscale, then run this again."
  }
  if ($firewall.Bypass.Count) {
    return "These enabled firewall rules let connections past block rules (OverrideBlockRules) and allow SSH: $($firewall.Bypass -join '; '). This changes no rule it did not make; disable or narrow them, then run this again."
  }
  return ""
}

# -- the changes (each one step, so tests can stand in for it) ----------------------------------

function Install-OrcaSshFeature {
  # The service it adds stays stopped until the firewall step below is done and checked.
  $null = Add-WindowsCapability -Online -Name $Capability
}

function New-OrcaBlockRule([string]$name) {
  # A block rule wins over every allow rule but one that overrides block rules (refused above).
  $null = New-NetFirewallRule -PolicyStore PersistentStore -Name $name -DisplayName $BlockDisplay -Direction Inbound -Action Block `
    -Protocol TCP -LocalPort 22 -RemoteAddress $OffTailnet -Profile Any `
    -Description "Added by orca-windows-ssh.ps1 (ORCA #1238): no SSH from addresses outside Tailscale's, whatever other rules allow."
}

function New-OrcaEdgeRule([string]$name, [string[]]$adapters) {
  # Named adapters only: with none named, a rule would block every adapter, Tailscale's too.
  if (-not $adapters.Count) { throw "no network adapters to block SSH on" }
  $null = New-NetFirewallRule -PolicyStore PersistentStore -Name $name -DisplayName $EdgeDisplay -Direction Inbound -Action Block `
    -Protocol TCP -LocalPort 22 -InterfaceAlias $adapters -Profile Any `
    -Description "Added by orca-windows-ssh.ps1 (ORCA #1238): no SSH on network adapters other than Tailscale's, whatever other rules allow. Run it again after adding an adapter."
}

function Set-OrcaSshFirewall {
  # Changes are made to the local rules (PersistentStore) only, and checked in the effective policy.
  if (-not (Get-NetFirewallRule -Name $RuleName -PolicyStore PersistentStore -ErrorAction SilentlyContinue)) {
    $null = New-NetFirewallRule -PolicyStore PersistentStore -Name $RuleName -DisplayName $RuleDisplay -Direction Inbound -Action Allow `
      -Protocol TCP -LocalPort 22 -InterfaceAlias $Adapter -Profile Any `
      -Description "Added by orca-windows-ssh.ps1 (ORCA #1238): SSH only over the Tailscale adapter."
  }
  if (-not (Get-NetFirewallRule -Name $BlockName -PolicyStore PersistentStore -ErrorAction SilentlyContinue)) { New-OrcaBlockRule $BlockName }
  $adapters = Get-OrcaOtherAdapters
  if ($adapters.Count) {
    if (Get-NetFirewallRule -Name $EdgeName -PolicyStore PersistentStore -ErrorAction SilentlyContinue) {
      # Its own rule, brought up to the adapters there are now.
      $null = Set-NetFirewallRule -Name $EdgeName -PolicyStore PersistentStore -InterfaceAlias $adapters
    } else { New-OrcaEdgeRule $EdgeName $adapters }
  }
  # Added again by the feature when it is installed: disabled after that, every time.
  $broad = Get-NetFirewallRule -Name $BroadRule -PolicyStore PersistentStore -ErrorAction SilentlyContinue
  if ($broad -and [string]$broad.Enabled -eq "True") { $null = $broad | Disable-NetFirewallRule }
}

function Assert-OrcaSshTailnetOnly {
  $state = Get-OrcaSshState
  if ($state.Listen.Problem) { throw $state.Listen.Problem }
  $firewall = $state.Firewall
  $refusal = Get-OrcaFirewallRefusal $firewall
  if ($refusal) { throw $refusal }
  if ($firewall.Ours -ne "ok") { throw "the firewall rule `"$RuleDisplay`" is not in place" }
  if ($firewall.Block -ne "ok") { throw "the firewall rule `"$BlockDisplay`" is not in place" }
  if ($firewall.Edge -ne "ok") { throw "the firewall rule `"$EdgeDisplay`" does not cover every network adapter but Tailscale's" }
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
  # Already on is left alone, unless it is this script's own setup with an adapter added since.
  $ownStale = $state.Firewall.Ours -eq "ok" -and $state.Firewall.Edge -eq "stale"
  if ($state.Installed -and $state.Automatic -and $state.Running -and -not $ownStale) {
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
  if ($state.Listen.Problem) {
    Write-Host "This cannot set it up: $($state.Listen.Problem). It sets up the OpenSSH Server only as Windows installs it, listening on port 22 alone: set it back, or set up its firewall yourself. Nothing was changed."
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
  if ($state.Firewall.Edge -eq "missing") { $firewall += "add the firewall rule `"$EdgeDisplay`", which blocks inbound SSH on every network adapter but Tailscale's ($($state.Firewall.Adapters -join ', ')), whatever other rules allow" }
  elseif ($state.Firewall.Edge -eq "stale") { $firewall += "update the firewall rule `"$EdgeDisplay`" to block inbound SSH on every network adapter but Tailscale's ($($state.Firewall.Adapters -join ', '))" }
  if ($state.Firewall.Block -ne "ok") { $firewall += "add the firewall rule `"$BlockDisplay`", which also blocks inbound SSH from every address outside Tailscale's (100.64.0.0/10 and fd7a:115c:a1e0::/48), on any adapter" }
  if (-not $state.Installed) { $firewall += "disable the rule the feature adds for every network ($BroadRule)" }
  elseif ($state.Firewall.Broad) { $firewall += "disable the feature's rule that allows SSH on every network ($BroadRule)" }
  if ($firewall.Count) { $steps += , @(($firewall -join ", and "), "Set-OrcaSshFirewall") }
  $steps += , @("check that SSH is blocked on every other network adapter and from every address outside Tailscale's, then set the sshd service to start automatically and start it", "Start-OrcaSshService")
  if ($state.Firewall.Others.Count) {
    Write-Host "These enabled firewall rules may allow inbound connections on other networks. They stay as they are; the ORCA block rules keep SSH out of them on other adapters: $($state.Firewall.Others -join '; ')."
  }
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
  Write-Host "The OpenSSH Server is on. SSH is blocked on every network adapter but Tailscale's, and from every address outside Tailscale's; after adding a network adapter, run this again. Add this machine from ORCA: Add a machine, or orca-cli remote add you@this-machine --tailnet."
  return 0
}

# Dot-sourced (the tests), only the functions; run from a file, its exit code; pasted or piped
# into a session, the session stays open.
if ($MyInvocation.InvocationName -ne ".") {
  $code = @(Invoke-OrcaWindowsSsh)[-1]
  if ($MyInvocation.MyCommand.Path) { exit ([int]$code) }
}
