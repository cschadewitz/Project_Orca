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
  [string]$program = "Any", [string]$store = "Local", [bool]$enabled = $true, [string]$service = "Any", [string]$package = "",
  [string]$action = "Allow", [string[]]$remote = @("Any"), [string]$profileName = "Any", [bool]$override = $false,
  [string]$type = "Any", [string[]]$local = @("Any")) {
  return [pscustomobject]@{
    Name = $name; DisplayName = "rule $name"; Enabled = $enabled; Direction = "Inbound"; Action = $action; Store = $store
    Protocol = $protocol; LocalPort = $ports; Interfaces = $interfaces; Program = $program; Service = $service; Package = $package
    Profile = $profileName; LocalAddress = $local; RemoteAddress = $remote; InterfaceType = $type; Override = $override
  }
}
$ours = New-Rule $RuleName -interfaces @("Tailscale")
$block = New-Rule $BlockName -action "Block" -remote $OffTailnet
$edge = New-Rule $EdgeName -action "Block" -interfaces @("Ethernet", "Wi-Fi")
function New-Profile([string]$name, [bool]$enabled = $true, [string]$inbound = "Block", [string]$local = "NotConfigured") {
  return [pscustomobject]@{ Name = $name; Enabled = $enabled; DefaultInbound = $inbound; LocalRules = $local }
}
$on = @((New-Profile "Domain"), (New-Profile "Public" -local "True"))
function Get-Measured([object[]]$allowing, [object[]]$mine = @($ours), [object[]]$profiles = $on, [object[]]$blocks = @($block),
  [object[]]$edges = @($edge), [string[]]$adapters = @("Ethernet", "Wi-Fi")) {
  return Measure-OrcaFirewall ([pscustomobject]@{ Allowing = $allowing; Ours = $mine; Block = $blocks; Edge = $edges; Adapters = $adapters; Profiles = $profiles })
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
  Assert ($found.Firewall.Block -in @("missing", "ok", "wrong")) "the probe's block rule is $($found.Firewall.Block)"
  Microsoft.PowerShell.Utility\Write-Host "      $([string]($probe | Select-Object -Last 1))"
  # What each rule it reads as letting SSH in looks like there, for the record.
  $detail = powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command `
    ". '$shipped'; `$all = (Read-OrcaFirewall).Allowing; 'allowing ' + `$all.Count + ', overriding ' + @(`$all | Where-Object { `$_.Override }).Count; `$all | Where-Object { Test-OrcaRuleAllowsSsh `$_ } | Select-Object -First 2 | ConvertTo-Json -Compress; Get-NetFirewallProfile -PolicyStore ActiveStore | Select-Object Name, Enabled, DefaultInboundAction, AllowLocalFirewallRules | ConvertTo-Json -Compress"
  Assert ($LASTEXITCODE -eq 0) "the detail failed: $detail"
  Microsoft.PowerShell.Utility\Write-Host "      $([string]($detail -join ' '))"

  if (Test-OrcaElevated) {
    Check "the block rule, made on this machine as the bootstrap makes it, reads back as exactly its scope"
    # Under a name of its own, removed again: the address spellings Windows gives back are its own.
    $name = "ORCA-test-block-$([guid]::NewGuid().ToString('N'))"
    try {
      New-OrcaBlockRule $name
      $made = @(Read-OrcaFirewallRules (Get-OrcaActiveRules @{ Name = $name }))
      Assert ($made.Count -eq 1) "found $($made.Count) rules by its name"
      Microsoft.PowerShell.Utility\Write-Host "      $(ConvertTo-Json -Compress $made[0])"
      Assert (Test-OrcaBlockIsOurs $made[0]) "the block rule as made is not read as ours: $(ConvertTo-Json -Compress $made[0])"
      Set-NetFirewallRule -Name $name -PolicyStore PersistentStore -RemoteAddress $OffTailnet[0..2]
      $made = @(Read-OrcaFirewallRules (Get-OrcaActiveRules @{ Name = $name }))
      Assert (-not (Test-OrcaBlockIsOurs $made[0])) "a block rule missing a range is read as ours: $(ConvertTo-Json -Compress $made[0])"
    } finally {
      Remove-NetFirewallRule -Name $name -PolicyStore PersistentStore -ErrorAction SilentlyContinue
    }
    Assert (-not (Get-OrcaActiveRules @{ Name = $name }).Count) "the test's block rule is still there"

    Check "the adapter rule, made on this machine for its adapters as the bootstrap makes it, reads back as covering them"
    $adapters = Get-OrcaOtherAdapters
    Microsoft.PowerShell.Utility\Write-Host "      adapters: $($adapters -join ', ')"
    Assert ($adapters.Count -gt 0) "no network adapters found"
    # For the record: which of them the firewall can name one by one, and where each comes from.
    foreach ($one in $adapters) {
      $probeName = "ORCA-test-probe-$([guid]::NewGuid().ToString('N'))"
      $result = "ok"
      try { $null = New-NetFirewallRule -PolicyStore PersistentStore -Name $probeName -DisplayName "ORCA probe" -Direction Inbound -Action Block -Protocol TCP -LocalPort 22 -InterfaceAlias $one -Enabled False } catch { $result = $_.Exception.Message.Trim() }
      Remove-NetFirewallRule -Name $probeName -PolicyStore PersistentStore -ErrorAction SilentlyContinue
      Microsoft.PowerShell.Utility\Write-Host "      '$one': $result"
    }
    Microsoft.PowerShell.Utility\Write-Host "      $(Get-NetAdapter -IncludeHidden | Select-Object Name, Status, Virtual, Hidden, InterfaceDescription | ConvertTo-Json -Compress)"
    Microsoft.PowerShell.Utility\Write-Host "      $(Get-NetIPInterface | Select-Object InterfaceAlias, AddressFamily, ConnectionState | ConvertTo-Json -Compress)"
    $name = "ORCA-test-edge-$([guid]::NewGuid().ToString('N'))"
    try {
      New-OrcaEdgeRule $name $adapters
      $made = @(Read-OrcaFirewallRules (Get-OrcaActiveRules @{ Name = $name }))
      Microsoft.PowerShell.Utility\Write-Host "      $(ConvertTo-Json -Compress $made)"
      Assert ((Measure-OrcaEdge $made $adapters) -eq "ok") "the adapter rule as made does not cover this machine's adapters: $(ConvertTo-Json -Compress $made)"
      Assert ((Measure-OrcaEdge $made @($adapters + "ORCA test adapter")) -eq "stale") "an adapter it does not name is taken as covered"
    } finally {
      Remove-NetFirewallRule -Name $name -PolicyStore PersistentStore -ErrorAction SilentlyContinue
    }
    Assert (-not (Get-OrcaActiveRules @{ Name = $name }).Count) "the test's adapter rule is still there"
    $failed = ""
    try { New-OrcaEdgeRule $name @() } catch { $failed = $_.Exception.Message }
    Assert ($failed -like "*no network adapters*" -and -not (Get-OrcaActiveRules @{ Name = $name }).Count) "an adapter rule naming no adapter was made: $failed"
  }

  Check "the adapter rule: every adapter but Tailscale's, named, and nothing else"
  Assert ((Get-Measured @()).Edge -eq "ok") "the exact adapter rule is not ours"
  Assert ((Get-Measured @() -adapters @("Ethernet")).Edge -eq "ok") "a rule naming an adapter since removed is not ours"
  Assert ((Get-Measured @() -adapters @("Ethernet", "Wi-Fi", "vEthernet (Default Switch)")).Edge -eq "stale") "a new adapter is taken as covered"
  Assert ((Get-Measured @() -edges @()).Edge -eq "missing") "no adapter rule is not missing"
  Assert ((Get-Measured @() -edges @() -adapters @()).Edge -eq "ok") "no other adapter needs no rule"
  foreach ($wrong in @(
      (New-Rule $EdgeName -action "Block" -interfaces @("Ethernet", "Wi-Fi", "Tailscale")), (New-Rule $EdgeName -action "Block"),
      (New-Rule $EdgeName -action "Block" -interfaces @()), (New-Rule $EdgeName -interfaces @("Ethernet", "Wi-Fi")),
      (New-Rule $EdgeName -action "Block" -interfaces @("Ethernet", "Wi-Fi") -remote @("192.168.0.0/16")),
      (New-Rule $EdgeName -action "Block" -interfaces @("Ethernet", "Wi-Fi") -ports @("2222")),
      (New-Rule $EdgeName -action "Block" -interfaces @("Ethernet", "Wi-Fi") -profileName "Public"),
      (New-Rule $EdgeName -action "Block" -interfaces @("Ethernet", "Wi-Fi") -enabled $false),
      (New-Rule $EdgeName -action "Block" -interfaces @("Ethernet", "Wi-Fi") -store "GroupPolicy"),
      (New-Rule $EdgeName -action "Block" -interfaces @("Ethernet", "Wi-Fi") -type "Wired"))) {
    Assert ((Get-Measured @() -edges @($wrong)).Edge -eq "wrong") "an adapter rule by its name with another scope is taken as its own: $(ConvertTo-Json -Compress $wrong)"
  }
  Assert ((Get-Measured @() -edges @($edge, $edge)).Edge -eq "wrong") "two adapter rules by its name are taken as its own"

  Check "the block rule's scope: every spelling of exactly the addresses outside Tailscale's, and nothing else"
  Assert ((Get-Measured @()).Block -eq "ok") "the exact block rule is not ours"
  Assert ((Get-Measured @() -blocks @()).Block -eq "missing") "no block rule is not missing"
  $spelled = @("0.0.0.0/2", "64.0.0.0/3", "96.0.0.0/252.0.0.0", "100.0.0.0/10", "100.128.0.0-255.255.255.255",
    "0:0:0:0:0:0:0:0-FD7A:115C:A1DF:FFFF:FFFF:FFFF:FFFF:FFFF", "fd7a:115c:a1e1::-fd7a:115c:a1e1::ffff", "fd7a:115c:a1e1::1:0-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff")
  Assert ((Get-Measured @() -blocks @(New-Rule $BlockName -action "Block" -remote $spelled)).Block -eq "ok") "another spelling of the same addresses is not ours"
  foreach ($wrong in @(
      (New-Rule $BlockName -action "Block" -remote $OffTailnet[0..2]),
      (New-Rule $BlockName -action "Block" -remote @("0.0.0.0-255.255.255.255", "::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff")),
      (New-Rule $BlockName -action "Block" -remote @("0.0.0.0-100.63.255.255", "100.128.0.0-255.255.255.254", $OffTailnet[2], $OffTailnet[3])),
      (New-Rule $BlockName -action "Block"), (New-Rule $BlockName -action "Block" -remote @("Internet")),
      (New-Rule $BlockName -remote $OffTailnet), (New-Rule $BlockName -action "Block" -remote $OffTailnet -enabled $false),
      (New-Rule $BlockName -action "Block" -remote $OffTailnet -profileName "Domain"), (New-Rule $BlockName -action "Block" -remote $OffTailnet -ports @("22", "23")),
      (New-Rule $BlockName -action "Block" -remote $OffTailnet -interfaces @("Ethernet")), (New-Rule $BlockName -action "Block" -remote $OffTailnet -type "Wireless"),
      (New-Rule $BlockName -action "Block" -remote $OffTailnet -store "GroupPolicy"), (New-Rule $BlockName -action "Block" -remote $OffTailnet -program "C:\x.exe"),
      (New-Rule $BlockName -action "Block" -remote $OffTailnet -package "S-1-15-2-1"), (New-Rule $BlockName -action "Block" -remote $OffTailnet -local @("10.0.0.1")),
      (New-Rule $BlockName -action "Block" -remote $OffTailnet -protocol "UDP"))) {
    Assert ((Get-Measured @() -blocks @($wrong)).Block -eq "wrong") "a block rule by its name with another scope is taken as its own: $(ConvertTo-Json -Compress $wrong)"
  }
  Assert ((Get-Measured @() -blocks @($block, $block)).Block -eq "wrong") "two block rules by its name are taken as its own"

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
      (New-Rule $BroadRule -store "GroupPolicy"),
      # An owner alone does not keep sshd out, nor a package that is not an app container's.
      ((New-Rule "owner-only" -protocol "Any" -ports @("Any")) | Add-Member -PassThru NoteProperty Owner "S-1-5-21-1-2-3-1001"),
      (New-Rule "package-any" -ports @("Any") -package "*"), (New-Rule "package-odd" -package "S-1-5-21-1-2-3"))) {
    $measured = Get-Measured @($open)
    Assert ($measured.Others.Count -eq 1 -and -not $measured.Broad) "$($open.Name) is not found: $(ConvertTo-Json -Compress $measured)"
  }
  Assert ((Get-Measured @(New-Rule $BroadRule -store "GroupPolicy")).Others[0] -like "*set by GroupPolicy*") "a policy's rule is not named as one"
  foreach ($closed in @(
      (New-Rule "udp" -protocol "UDP"), (New-Rule "other-port" -ports @("3389")), (New-Rule "keyword" -ports @("RPC")),
      (New-Rule "range-above" -ports @("23-80")), (New-Rule "other-program" -ports @("Any") -program "C:\app\app.exe"),
      (New-Rule "other-service" -service "W32Time"), (New-Rule "tailnet-only" -interfaces @("Tailscale")),
      (New-Rule "store-app" -protocol "Any" -ports @("Any") -package "S-1-15-2-1910091885-1573563583-1104941280-2418270861-3411158377-2822700936-2990310272"),
      (New-Rule "app-only" -ports @("Any") -package "S-1-15-2-1"))) {
    $measured = Get-Measured @($closed)
    Assert (-not $measured.Others.Count -and -not $measured.Broad) "$($closed.Name) is taken to allow SSH: $(ConvertTo-Json -Compress $measured)"
  }
  Assert (-not (Get-Measured @(New-Rule "any-port" -ports @("Any"))).Bypass.Count) "a rule that does not override block rules is taken as one that does"

  Check "the firewall reading: a rule that lets SSH past block rules is told apart, and only one that allows SSH"
  foreach ($bypass in @((New-Rule "ipsec-any" -ports @("Any") -override $true), (New-Rule "ipsec-gpo" -store "GroupPolicy" -override $true))) {
    $measured = Get-Measured @($bypass)
    Assert ($measured.Bypass.Count -eq 1 -and -not $measured.Others.Count) "$($bypass.Name): $(ConvertTo-Json -Compress $measured)"
  }
  foreach ($harmless in @((New-Rule "ipsec-rdp" -ports @("3389") -override $true), (New-Rule "ipsec-tailnet" -interfaces @("Tailscale") -override $true))) {
    Assert (-not (Get-Measured @($harmless)).Bypass.Count) "$($harmless.Name) is taken to let SSH past the block rule"
  }

  Check "the profiles: on, blocking inbound by default, and not turning local rules off"
  $measured = Get-Measured @() -profiles @((New-Profile "Private" -enabled $false), (New-Profile "Public" -inbound "Allow"))
  Assert (($measured.Open -join ",") -eq "Private,Public") "open profiles: $($measured.Open -join ',')"
  $measured = Get-Measured @() -profiles @((New-Profile "Domain" -inbound "NotConfigured"))
  Assert (($measured.Open -join ",") -eq "Domain") "a profile that does not say it blocks is taken as closed"
  $measured = Get-Measured @() -profiles @((New-Profile "Domain" -local "True"), (New-Profile "Private" -local "False"), (New-Profile "Public" -local ""))
  Assert (($measured.Local -join ",") -eq "Private,Public" -and -not $measured.Open.Count) "profiles without local rules: $(ConvertTo-Json -Compress $measured)"

  Check "the listener: only an sshd_config that listens on port 22 alone, read in full, is set up"
  foreach ($fine in @($null, "", "#Port 2222`nPort 22", "Port=22", "  port 22  ", "ListenAddress 0.0.0.0`nListenAddress ::", "ListenAddress 100.64.0.1:22", "Match Group administrators`n  AuthorizedKeysFile x")) {
    $listen = Measure-OrcaSshListen $fine
    Assert (-not $listen.Problem -and ($listen.Ports -join ",") -eq "22") "'$fine' is read as: $(ConvertTo-Json -Compress $listen)"
  }
  foreach ($case in @(
      @("Port 2222", "port 2222"), @("Port 22`nPort 2200", "port 2200"), @("ListenAddress 0.0.0.0:2222", "port 2222"),
      @("ListenAddress [::]:2022", "port 2022"), @("Include C:/ProgramData/ssh/more.conf", "includes other files"),
      @("Port twenty-two", "a port this cannot read"), @("ListenAddress [fe80::1", "a listen address this cannot read"))) {
    $listen = Measure-OrcaSshListen $case[0]
    Assert ($listen.Problem -like "*$($case[1])*") "'$($case[0])' is read as: $(ConvertTo-Json -Compress $listen)"
  }

  Check "the firewall is read from the effective policy: a policy seen only there stops sshd from starting"
  # Windows' firewall cmdlets stand in for by functions: the local store holds only this machine's
  # own rules, the effective one also a policy's: a rule that lets SSH in on every network, which
  # may override block rules, and the profile's setting for local rules.
  $script:reads = New-Object Collections.ArrayList
  $script:policy = $false
  $script:override = $false
  $script:nolocal = $false
  $script:mine = $true
  function New-CimRule([string]$name, [string]$store, [string]$action = "Allow") {
    return [pscustomobject]@{ InstanceID = $name; Name = $name; DisplayName = "rule $name"; Enabled = "True"; Direction = "Inbound"; Action = $action; PolicyStoreSourceType = $store; Profile = "Any" }
  }
  function Get-NetFirewallRule {
    [CmdletBinding()] param([string]$Name, [string]$Direction, [string]$Action, [string]$Enabled, [string]$PolicyStore)
    $null = $script:reads.Add("rule:$PolicyStore")
    $rules = @()
    if ($script:mine) { $rules += New-CimRule $RuleName "Local"; $rules += New-CimRule $BlockName "Local" "Block"; $rules += New-CimRule $EdgeName "Local" "Block" }
    if ($PolicyStore -eq "ActiveStore" -and $script:policy) { $rules += New-CimRule "corp-ssh" "GroupPolicy" }
    if ($Name) { $rules = @($rules | Where-Object { $_.Name -eq $Name }) }
    if ($Action) { $rules = @($rules | Where-Object { $_.Action -eq $Action }) }
    return $rules
  }
  function Get-NetFirewallProfile {
    [CmdletBinding()] param([string]$PolicyStore)
    $null = $script:reads.Add("profile:$PolicyStore")
    if ($PolicyStore -ne "ActiveStore") { return [pscustomobject]@{ Name = "Domain"; Enabled = "NotConfigured"; DefaultInboundAction = "NotConfigured"; AllowLocalFirewallRules = "NotConfigured" } }
    return [pscustomobject]@{ Name = "Domain"; Enabled = "True"; DefaultInboundAction = "Block"; AllowLocalFirewallRules = $(if ($script:nolocal) { "False" } else { "NotConfigured" }) }
  }
  function Get-NetFirewallPortFilter { param([Parameter(ValueFromPipeline = $true)]$rule) process { [pscustomobject]@{ InstanceID = $rule.InstanceID; Protocol = "TCP"; LocalPort = "22" } } }
  function Get-NetFirewallInterfaceFilter { param([Parameter(ValueFromPipeline = $true)]$rule) process { [pscustomobject]@{ InstanceID = $rule.InstanceID; InterfaceAlias = $(if ($rule.Name -eq $RuleName) { "Tailscale" } elseif ($rule.Name -eq $EdgeName) { "Ethernet" } else { "Any" }) } } }
  function Get-NetAdapter { [CmdletBinding()] param([string]$Name) [pscustomobject]@{ Name = "Tailscale" } }
  function Get-NetIPInterface { [CmdletBinding()] param() @([pscustomobject]@{ InterfaceAlias = "Ethernet" }, [pscustomobject]@{ InterfaceAlias = "Loopback Pseudo-Interface 1" }, [pscustomobject]@{ InterfaceAlias = "Tailscale" }) }
  function Get-NetFirewallApplicationFilter { param([Parameter(ValueFromPipeline = $true)]$rule) process { if (-not $script:lost) { [pscustomobject]@{ InstanceID = $rule.InstanceID; Program = "Any"; Package = "" } } } }
  function Get-NetFirewallServiceFilter { param([Parameter(ValueFromPipeline = $true)]$rule) process { [pscustomobject]@{ InstanceID = $rule.InstanceID; Service = "Any" } } }
  function Get-NetFirewallAddressFilter { param([Parameter(ValueFromPipeline = $true)]$rule) process { [pscustomobject]@{ InstanceID = $rule.InstanceID; LocalAddress = "Any"; RemoteAddress = $(if ($rule.Name -eq $BlockName) { $OffTailnet } else { "Any" }) } } }
  function Get-NetFirewallInterfaceTypeFilter { param([Parameter(ValueFromPipeline = $true)]$rule) process { [pscustomobject]@{ InstanceID = $rule.InstanceID; InterfaceType = "Any" } } }
  function Get-NetFirewallSecurityFilter { param([Parameter(ValueFromPipeline = $true)]$rule) process { [pscustomobject]@{ InstanceID = $rule.InstanceID; OverrideBlockRules = $script:override -and $rule.Name -eq "corp-ssh" } } }
  $script:lost = $false
  $measured = Measure-OrcaFirewall (Read-OrcaFirewall)
  Assert ($measured.Ours -eq "ok" -and $measured.Block -eq "ok" -and $measured.Edge -eq "ok" -and ($measured.Adapters -join ",") -eq "Ethernet" -and -not $measured.Others.Count -and -not $measured.Open.Count -and -not $measured.Local.Count) "the local rules alone: $(ConvertTo-Json -Compress $measured)"
  Assert (@($script:reads | Where-Object { $_ -notlike "*:ActiveStore" }).Count -eq 0) "read from another store: $($script:reads -join ', ')"
  $script:policy = $true
  $measured = Measure-OrcaFirewall (Read-OrcaFirewall)
  Assert (($measured.Others -join ";") -eq "rule corp-ssh (corp-ssh, set by GroupPolicy)" -and -not $measured.Bypass.Count) "the policy's rule is not found: $(ConvertTo-Json -Compress $measured)"
  $script:override = $true
  $measured = Measure-OrcaFirewall (Read-OrcaFirewall)
  Assert (($measured.Bypass -join ";") -eq "rule corp-ssh (corp-ssh, set by GroupPolicy)" -and -not $measured.Others.Count) "the policy's overriding rule is not found: $(ConvertTo-Json -Compress $measured)"
  $script:nolocal = $true
  Assert (((Measure-OrcaFirewall (Read-OrcaFirewall)).Local -join ",") -eq "Domain") "a policy turning local rules off is not found"
  # A filter that cannot be read is no answer: the reading fails, and the run refuses.
  $script:lost = $true
  $failed = ""
  try { $null = Read-OrcaFirewall } catch { $failed = $_.Exception.Message }
  Assert ($failed -like "*could not read the scope of the firewall rule*") "a rule with no filter was read as: $failed"
  Assert ($null -ne (Get-OrcaFirewallState).PSObject.Properties["Error"]) "an unreadable firewall is not reported as one"
  $script:lost = $false
  # The run: installed and stopped, no rule of its own yet; a policy appears in the effective policy
  # as the firewall step runs, and the check before the start, which reads it there, stops it. A
  # policy's plain allow rule, which the block rule overrides, does not.
  function Get-Service { [CmdletBinding()] param([string]$Name) [pscustomobject]@{ StartType = "Manual"; Status = "Stopped" } }
  function Get-WindowsCapability { [CmdletBinding()] param([switch]$Online, [string]$Name) [pscustomobject]@{ State = "Installed" } }
  function Test-OrcaElevated { return $true }
  function Read-OrcaConsent([string]$question) { return "y" }
  function Read-OrcaSshConfig { return $null }
  function Set-OrcaSshFirewall { $script:mine = $true; $script:policy = $true; if ($script:later) { $script:nolocal = $true } }
  function Start-OrcaSshService { $script:started = $true }
  foreach ($case in @(@{ Override = $true; NoLocal = $false; Code = 1 }, @{ Override = $false; NoLocal = $true; Code = 1 }, @{ Override = $false; NoLocal = $false; Code = 0 })) {
    $script:policy = $false; $script:mine = $false; $script:started = $false
    $script:override = $case.Override; $script:nolocal = $false
    $script:reads.Clear()
    $state = Get-OrcaSshState
    Assert ($state.Firewall.Ours -eq "missing" -and $state.Firewall.Block -eq "missing" -and $state.Firewall.Edge -eq "missing" -and -not $state.Firewall.Others.Count) "before the run: $(ConvertTo-Json -Compress $state.Firewall)"
    # Local rules are turned off only once the run is under way.
    $script:later = $case.NoLocal
    $code = @(Invoke-OrcaWindowsSsh)[-1]
    Assert ($code -eq $case.Code) "$(ConvertTo-Json -Compress $case): exit $code"
    Assert ($script:started -eq ($case.Code -eq 0)) "$(ConvertTo-Json -Compress $case): sshd started is $script:started"
    Assert (@($script:reads | Where-Object { $_ -notlike "*:ActiveStore" }).Count -eq 0) "read from another store: $($script:reads -join ', ')"
  }
  foreach ($name in @("Get-NetFirewallRule", "Get-NetFirewallProfile", "Get-NetFirewallPortFilter", "Get-NetFirewallInterfaceFilter",
      "Get-NetFirewallApplicationFilter", "Get-NetFirewallServiceFilter", "Get-NetFirewallAddressFilter", "Get-NetFirewallInterfaceTypeFilter",
      "Get-NetFirewallSecurityFilter", "Get-Service", "Get-WindowsCapability", "Get-NetAdapter", "Get-NetIPInterface",
      "Test-OrcaElevated", "Read-OrcaConsent", "Read-OrcaSshConfig", "Set-OrcaSshFirewall", "Start-OrcaSshService")) {
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
    $script:state.Firewall.Ours = "ok"; $script:state.Firewall.Block = "ok"; $script:state.Firewall.Edge = "ok"; $script:state.Firewall.Broad = $false
    if ($script:fail -eq "appeared") { $script:state.Firewall.Bypass = @("rule ipsec (ipsec)") }
    if ($script:fail -eq "port") { $script:state.Listen.Problem = "sshd is set to listen on port 2222" }
  }
  function Start-OrcaSshService { $null = $script:changed.Add("service"); if ($script:fail -eq "service") { throw "the service did not start" } }

  function New-State([bool]$installed, [bool]$automatic, [bool]$running, [string]$ours = "missing", [bool]$broad = $false,
    [string[]]$others = @(), [string[]]$open = @(), [bool]$tailscale = $true, [bool]$available = $true, [string]$listen = "",
    [string]$block = "", [string[]]$local = @(), [string[]]$bypass = @(), [string]$edge = "") {
    # The ORCA rules alike, unless told otherwise.
    if (-not $block) { $block = $ours }
    if (-not $edge) { $edge = $ours }
    return [pscustomobject]@{
      Available = $available; Installed = $installed; Automatic = $automatic; Running = $running; Tailscale = $tailscale
      Firewall = [pscustomobject]@{ Ours = $ours; Block = $block; Edge = $edge; Adapters = @("Ethernet", "Wi-Fi"); Open = $open; Local = $local; Broad = $broad; Bypass = $bypass; Others = $others }
      Listen = [pscustomobject]@{ Ports = $(if ($listen) { @() } else { @(22) }); Problem = $listen }
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

  Check "already on with its own rules, and an adapter added since: its adapter rule is updated, asked first"
  $code = Invoke-Case (New-State $true $true $true -ours "ok" -edge "stale") "y"
  Assert ($code -eq 0) "exit $code"
  Assert ($script:asked -eq 1 -and ($script:changed -join ",") -eq "firewall,service") "asked $script:asked, changed $($script:changed -join ',')"
  Assert ((& $all) -like "*Update the firewall rule `"ORCA: Block OpenSSH Server on other network adapters`"*(Ethernet, Wi-Fi)*") "it said: $(& $all)"
  & $nothing (Invoke-Case (New-State $true $true $true -ours "ok" -edge "stale") "y" -elevated $false) "administrator PowerShell"

  Check "not on: refused before asking, nothing changed, when it is not elevated, has no Tailscale or no feature"
  & $nothing (Invoke-Case (New-State $false $false $false) "y" -elevated $false) "administrator PowerShell"
  & $nothing (Invoke-Case (New-State $false $false $false -tailscale $false) "y") "Tailscale"
  & $nothing (Invoke-Case (New-State $false $false $false -available $false) "y") "no OpenSSH Server feature"

  Check "a firewall where the block rule would not hold is refused before asking, and nothing changed"
  & $nothing (Invoke-Case (New-State $true $false $false -ours "wrong" -block "ok") "y") "not exactly inbound TCP 22 over the Tailscale adapter"
  & $nothing (Invoke-Case (New-State $true $false $false -ours "ok" -block "wrong") "y") "does not block exactly inbound TCP 22 from every address outside Tailscale's"
  & $nothing (Invoke-Case (New-State $true $false $false -ours "ok" -edge "wrong") "y") "does not block exactly inbound TCP 22 on network adapters other than Tailscale's"
  & $nothing (Invoke-Case (New-State $false $false $false -open @("Public")) "y") "for the Public profile"
  & $nothing (Invoke-Case (New-State $false $false $false -local @("Domain")) "y") "turns off local firewall rules for the Domain profile"
  & $nothing (Invoke-Case (New-State $true $false $false -bypass @("rule ipsec (ipsec)", "rule gpo (gpo, set by GroupPolicy)")) "y") "(OverrideBlockRules) and allow SSH: rule ipsec (ipsec); rule gpo (gpo, set by GroupPolicy). This changes no rule it did not make"
  & $nothing (Invoke-Case (New-State $true $false $false -ours "ok" -listen "sshd is set to listen on port 2222") "y") "This cannot set it up: sshd is set to listen on port 2222. It sets up the OpenSSH Server only as Windows installs it, listening on port 22 alone"
  & $nothing (Invoke-Case (New-State $true $false $false -listen "sshd_config includes other files (more.conf)") "y") "includes other files"
  $state = New-State $true $false $false
  $state.Firewall | Add-Member NoteProperty Error "Access is denied."
  & $nothing (Invoke-Case $state "y") "Could not read the Windows Firewall rules (Access is denied.)"

  Check "not installed: lists every change in order before asking, and a no changes nothing"
  foreach ($answer in @("", "n", "no", "yess", " N ")) {
    $code = Invoke-Case (New-State $false $false $false) $answer
    Assert ($code -eq 2 -and $script:asked -eq 1 -and $script:changed.Count -eq 0) "answer '$answer': exit $code, asked $script:asked, changed $($script:changed -join ', ')"
    $text = & $all
    Assert ($text -like "*Install the OpenSSH Server Windows feature*Add the firewall rule*only over the Tailscale adapter*, and add the firewall rule*ORCA: Block OpenSSH Server on other network adapters*on every network adapter but Tailscale's (Ethernet, Wi-Fi)*, and add the firewall rule*ORCA: Block OpenSSH Server outside Tailscale*from every address outside Tailscale's (100.64.0.0/10 and fd7a:115c:a1e0::/48)*disable the rule the feature adds for every network (OpenSSH-Server-In-TCP)*Check that SSH is blocked on every other network adapter and from every address outside Tailscale's, then set the sshd service to start automatically and start it*") "the steps are not all listed in order: $text"
    Assert ($text -like "*Windows Update maintains it*") "it does not say who maintains it: $text"
    Assert ($script:said[-1] -eq "Nothing was changed.") "the last line is '$($script:said[-1])'"
  }

  Check "a yes makes exactly the listed changes, in order, and starts sshd only once SSH is Tailscale-only"
  foreach ($answer in @("y", "Y", "yes", " yes ")) {
    $code = Invoke-Case (New-State $false $false $false) $answer
    Assert ($code -eq 0) "answer '$answer': exit $code"
    Assert (($script:changed -join ",") -eq "feature,firewall,service") "answer '$answer': changed $($script:changed -join ',')"
    Assert ($script:said[-1] -like "The OpenSSH Server is on. SSH is blocked on every network adapter but Tailscale's*run this again*") "the last line is '$($script:said[-1])'"
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

  Check "other rules that allow inbound connections are listed, left as they are, and do not stop the block rule's setup"
  $code = Invoke-Case (New-State $true $false $false -others @("rule store-app (store-app)", "rule gpo (gpo, set by GroupPolicy)")) "y"
  Assert ($code -eq 0) "exit $code"
  Assert (($script:changed -join ",") -eq "firewall,service") "changed $($script:changed -join ',')"
  Assert ((& $all) -like "*They stay as they are; the ORCA block rules keep SSH out of them on other adapters: rule store-app (store-app); rule gpo (gpo, set by GroupPolicy).*To let ORCA reach*") "it said: $(& $all)"

  Check "only the block rule missing: only it is added, before sshd starts"
  $code = Invoke-Case (New-State $true $false $false -ours "ok" -block "missing") "y"
  Assert ($code -eq 0) "exit $code"
  Assert (($script:changed -join ",") -eq "firewall,service") "changed $($script:changed -join ',')"
  Assert ((& $all) -like "*Add the firewall rule `"ORCA: Block OpenSSH Server outside Tailscale`"*") "it said: $(& $all)"
  Assert (-not ((& $all) -like "*over the Tailscale adapter*")) "it lists the allow rule it already has: $(& $all)"

  Check "a firewall still open elsewhere after its change is caught by the check, and sshd is not started"
  $code = Invoke-Case (New-State $true $false $false) "y" -fail "appeared"
  Assert ($code -eq 1) "exit $code"
  Assert (($script:changed -join ",") -eq "firewall") "changed $($script:changed -join ',')"
  Assert ((& $all) -like "*Could not check that SSH is blocked on every other network adapter*(OverrideBlockRules) and allow SSH: rule ipsec (ipsec)*sshd was not started by this run*") "it said: $(& $all)"

  Check "a listener changed to another port before the start is caught by the check, and sshd is not started"
  $code = Invoke-Case (New-State $true $false $false) "y" -fail "port"
  Assert ($code -eq 1) "exit $code"
  Assert (($script:changed -join ",") -eq "firewall") "changed $($script:changed -join ',')"
  Assert ((& $all) -like "*Could not check that SSH is blocked on every other network adapter*port 2222*sshd was not started by this run*") "it said: $(& $all)"

  Check "a rerun after a partial failure picks up where it stopped, and checks again before starting sshd"
  $state = New-State $false $false $false
  $null = Invoke-Case $state "y" -fail "firewall"
  $code = Invoke-Case $state "y"
  Assert ($code -eq 0) "exit $code"
  Assert (($script:changed -join ",") -eq "firewall,service") "changed $($script:changed -join ',')"

  Check "a service that fails to start says so"
  $code = Invoke-Case (New-State $true $false $false -ours "ok") "y" -fail "service"
  Assert ($code -eq 1 -and (& $all) -like "*Could not check that SSH is blocked on every other network adapter*, then set the sshd service*did not start*") "exit $code, said: $(& $all)"

  Microsoft.PowerShell.Utility\Write-Host "  all $checks OpenSSH bootstrap checks passed"
} catch {
  Microsoft.PowerShell.Utility\Write-Host $_.Exception.Message
  exit 1
}
exit 0
