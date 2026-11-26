<#
.SYNOPSIS
Turn a reachable Windows x64 machine into a managed ORCA server, in one step (#1238, incubating).

.DESCRIPTION
The Windows counterpart of orca-server-setup.py, with the same steps, the same output and the
same rules: every step idempotent, a re-run verifies and repairs instead of installing again,
an installation this setup did not make is refused, only a release this setup verified and
staged itself is ever started, and a failed run puts back everything it changed.

It runs as the account that will run the daemon, with no administrator rights needed beyond
what that account already has, and keeps everything under one per-user directory,
%LOCALAPPDATA%\orca-server unless -Root says otherwise. Windows has no Python to run
orca-release.py, so this script verifies and stages the bundle itself:

0. account     With -ExpectAccount, refuses to run as any other account than the one the
               person confirmed.
   confirmed   Under the fence, before any change: with -ExpectRoot and -ExpectCurrent,
               refuses unless the setup directory, and whether this is a first install
               (`none`) or a repair of VERSION, are still exactly what -Inspect showed.
1. platform    Windows x64, Windows PowerShell 5.1 or newer, the Task Scheduler cmdlets.
2. inventory   Refuses a machine with an ORCA installation this setup did not make (its
               directory, a scheduled task, a launcher on PATH or a running ORCA process):
               those are migrated by hand, never taken over.
   existing    `current.txt`, and any `releases\vVERSION`, are accepted only as the release
               this setup staged from the verified bundle for exactly VERSION (its receipt);
               anything else is refused, never started.
3. files       `deployment.json` (written once; a re-run checks the keys this setup owns and
               adds missing ones), the operator configs (written once, never rewritten), and
               the `orca.cmd`, `orca-acp.cmd` and `orca-daemon.cmd` launchers.
4. stage       The signed bundle the client carried (-Bundle): its manifest's signature is
               checked with the pinned cosign against the pinned signer before a byte of the
               archive is read, the archive against the signed manifest, then it is unpacked
               (regular files under its one root only) into this run's own scratch
               (`<root>\.setup-stage-*`, named in the journal), checked against the manifest,
               run (version, the scripted demo, `validate` of both configs, a temporary
               daemon's hello), receipted, and moved into `releases\vVERSION`.
5. select      `current.txt` names `vVERSION`, only when nothing is selected yet.
6. task        The scheduled task \ORCA\orca-server, run as this account whether or not it is
               logged on (S4U: no password is stored), started at boot. An account that may not
               register a boot task gets one started at its logon instead, with a warning.
7. start       The task started, and the daemon's hello checked against the release.

Each run holds the deployment's admission lock exclusively from before its first change to its
end. Before its first change it records what it found (the task, whether it ran, `current.txt`
and this setup's own files) in `<root>\.setup-journal.json`. A run that fails puts all of that
back, checks that it is back, and reports a `cleanup` step. A run that never got to (the ssh
session was cut, which ends its processes) leaves the journal, and the next run puts that state
back first (`recover`).

It prints one `orca-setup: {json}` line per step, `{"detail", "result", "step"}` with result
`ok`, `changed`, `repaired`, `warning`, `refused` or `failed`, and one last `{"done": ...}` line.
Nothing else it prints is meant to be read. Exit code 0, 1 (failed) or 2 (refused).

-Inspect changes nothing: it runs the platform, inventory and existing checks and prints one
`{"inspected": true, "account", "root", "current"}` line for the person to confirm.

  powershell -NoProfile -ExecutionPolicy Bypass -File orca-server-setup.ps1 -Version X.Y.Z -Bundle DIR

DIR holds the three bundle files (orca-server-X.Y.Z-win-x64.zip, its .manifest.json and
.manifest.json.sigstore.json). With -OfflineBundle it also carries cosign-windows-amd64.exe and a
Sigstore trusted_root.json, both checked against the digests pinned here, for a host that cannot
reach GitHub or Sigstore; otherwise the pinned cosign is downloaded once into `<root>\tools`.
Dot-sourced (`. orca-server-setup.ps1`), it only defines its functions: tests replace one and run
Invoke-OrcaServerSetup.
#>
param(
  [string]$Version,
  [string]$Root,
  [int]$Port = 6722,
  [string]$Bundle,
  [switch]$OfflineBundle,
  [switch]$Inspect,
  [string]$ExpectAccount,
  [string]$ExpectRoot,
  [string]$ExpectCurrent
)

$ErrorActionPreference = "Stop"

$SetupMarker = "orca-server-setup"
$VersionPattern = '^\d+\.\d+\.\d+(?:-(?:rc|beta|alpha)\.\d+)?$'
# The prebuilt Windows server bundle's signer: exactly this workflow, dispatched on main of exactly
# this repository (release-server-bundle-windows.yml). Changing it is a reviewed change here.
$BundleRepository = "cschadewitz/Project_Orca"
$BundleSigner = "https://github.com/$BundleRepository/.github/workflows/release-server-bundle-windows.yml@refs/heads/main"
$BundleIssuer = "https://token.actions.githubusercontent.com"
$BundleTrigger = "workflow_dispatch"
$BundleSchema = "orca-server-bundle/1"
$BundlePlatform = "win-x64"
$BundleNode = "runtime/node.exe"
$BundleEntry = "orca-daemon.mjs"
$BundleMaxBytes = 512MB
$BundleMaxUnpacked = 1536MB
# The cosign the Windows release workflow verifies with, checked against this digest every use.
$CosignVersion = "v3.1.4"
$CosignName = "cosign-windows-amd64.exe"
$CosignSha256 = "cbe953787074611f1334cbf37dc1cf953995bb8c45398eb4fc7bb781d29c1f2a"
# A carried Sigstore trusted root is trusted only by these pins (orca-release.py TRUSTED_ROOT_SHA256).
$PushedTrustedRoot = "trusted_root.json"
$TrustedRootMax = 1MB
$TrustedRootSha256 = @(
  "6494e21ea73fa7ee769f85f57d5a3e6a08725eae1e38c755fc3517c9e6bc0b66"
)
$TaskPath = "\ORCA\"
$TaskName = "orca-server"
$HealthSeconds = 60
$ScratchPrefix = ".setup-stage-"
# The files this setup writes in its directory: journaled, so a failed run puts each back.
$OwnedFiles = @("deployment.json", "orca.cmd", "orca-acp.cmd", "orca-daemon.cmd", "orca.config.yaml", "orca-kepler.config.yaml")
# deployment.json keys this setup owns: checked on every run, never left to drift.
$OwnedKeys = @("root", "service", "scheduledTask", "setup", "url", "platform")
$Reconcile = "Reconcile it by hand: this setup starts only a release it staged and verified itself, for exactly the version asked for."
$Guidance = "Migrate it by hand first; this setup never takes over an installation it did not make."
$OrcaProcess = '(?:orca-daemon|packages[\\/]cli[\\/](?:dist|src)[\\/]main\.|orca\s+(?:acp|run|program|serve))'
$OrcaLauncher = 'orca-release\.py|orca-daemon\.mjs|packages[\\/]cli[\\/]dist[\\/]main\.js|@orca/cli'
# A new server lists no workflows: the release's own need agents for their roles, and a new
# server has none yet (docs/MULTI-MACHINE.md).
$ServerConfig = @"
# Written by $SetupMarker (#1238). Yours to edit: setup never rewrites it.
# Add the agents this server runs, and the workflows other machines delegate to
# (docs/MULTI-MACHINE.md). The release's own workflows need agents for their roles;
# once those agents are declared, they can be listed with:
#   workflows: ['`${ORCA_RELEASE}/workflows/**/*.yaml']
workflows: []
templates: ['`${ORCA_RELEASE}/templates/**/*.md']

"@

class OrcaRefused : System.Exception {
  OrcaRefused([string]$message) : base($message) {}
}

function Refuse([string]$message) { throw [OrcaRefused]::new($message) }

# -- output ------------------------------------------------------------------------------------

function ConvertTo-JsonText($value) {
  # Keys sorted, compact: the same line shape as the Linux setup's json.dumps(sort_keys=True).
  if ($null -eq $value) { return "null" }
  if ($value -is [bool]) { if ($value) { return "true" } else { return "false" } }
  if ($value -is [string]) { return (ConvertTo-Json -Compress -InputObject $value) }
  if ($value -is [int] -or $value -is [long] -or $value -is [double]) { return [string]$value }
  if ($value -is [System.Collections.IDictionary]) {
    $parts = foreach ($key in ($value.Keys | Sort-Object { [string]$_ } -CaseSensitive)) {
      (ConvertTo-Json -Compress -InputObject ([string]$key)) + ":" + (ConvertTo-JsonText $value[$key])
    }
    return "{" + ($parts -join ",") + "}"
  }
  if ($value -is [System.Management.Automation.PSCustomObject]) {
    $table = [ordered]@{}
    foreach ($property in $value.PSObject.Properties) { $table[$property.Name] = $property.Value }
    return ConvertTo-JsonText $table
  }
  if ($value -is [System.Collections.IEnumerable]) {
    $parts = foreach ($item in $value) { ConvertTo-JsonText $item }
    return "[" + ($parts -join ",") + "]"
  }
  return (ConvertTo-Json -Compress -InputObject $value)
}

function Send-Line($value) {
  # A session that went away loses the line, not the run.
  try {
    [Console]::Out.WriteLine("orca-setup: " + (ConvertTo-JsonText $value))
    [Console]::Out.Flush()
  } catch {
    $null = $_
  }
}

function Send-Step([string]$step, [string]$result, [string]$detail = "") {
  Send-Line ([ordered]@{ step = $step; result = $result; detail = $detail })
}

# -- files -------------------------------------------------------------------------------------

$Utf8 = New-Object System.Text.UTF8Encoding $false

function Test-Reparse([string]$path) {
  $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  return ($null -ne $item) -and (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Test-PlainFile([string]$path) {
  return [IO.File]::Exists($path) -and -not (Test-Reparse $path)
}

function Test-Present([string]$path) {
  return [IO.File]::Exists($path) -or [IO.Directory]::Exists($path)
}

function Write-TextFile([string]$path, [string]$text) {
  # Atomically. Returns $true when the file changed.
  if ((Test-PlainFile $path) -and [IO.File]::ReadAllText($path) -ceq $text) { return $false }
  $temporary = Join-Path ([IO.Path]::GetDirectoryName($path)) (".{0}.{1}.tmp" -f [IO.Path]::GetFileName($path), $PID)
  [IO.File]::WriteAllText($temporary, $text, $Utf8)
  if ([IO.File]::Exists($path)) { [IO.File]::Replace($temporary, $path, [NullString]::Value) } else { [IO.File]::Move($temporary, $path) }
  return $true
}

function Get-Sha256([string]$path) {
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
}

function Get-TextSha256([string]$text) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return (($sha.ComputeHash($Utf8.GetBytes($text)) | ForEach-Object { $_.ToString("x2") }) -join "")
  } finally {
    $sha.Dispose()
  }
}

function Get-Snapshot([string]$path) {
  # A file as rollback restores it: its text, or $null when absent. Anything but a plain file is
  # refused before any change (`existing`), so it never gets here.
  if (-not (Test-PlainFile $path)) { return $null }
  return [IO.File]::ReadAllText($path)
}

function Read-Json([string]$path) {
  return (ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($path)))
}

function Get-Property($object, [string]$name) {
  if ($null -eq $object -or $object -isnot [System.Management.Automation.PSCustomObject]) { return $null }
  $property = $object.PSObject.Properties[$name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

# -- processes ---------------------------------------------------------------------------------

function ConvertTo-Argument([string]$argument) {
  # One argument as the C runtime's command line parser reads it back.
  if ($argument -ne "" -and $argument -notmatch '[\s"]') { return $argument }
  $builder = New-Object System.Text.StringBuilder
  [void]$builder.Append('"')
  $slashes = 0
  foreach ($character in $argument.ToCharArray()) {
    if ($character -eq '\') { $slashes++; continue }
    if ($character -eq '"') { [void]$builder.Append([char]'\', 2 * $slashes + 1) }
    elseif ($slashes) { [void]$builder.Append([char]'\', $slashes) }
    $slashes = 0
    [void]$builder.Append($character)
  }
  if ($slashes) { [void]$builder.Append([char]'\', 2 * $slashes) }
  [void]$builder.Append('"')
  return $builder.ToString()
}

function New-StartInfo([string]$file, [string[]]$arguments, [string]$directory, [hashtable]$environment) {
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $file
  $info.Arguments = (($arguments | ForEach-Object { ConvertTo-Argument $_ }) -join " ")
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  if ($directory) { $info.WorkingDirectory = $directory }
  # Nothing from this session's ORCA environment reaches the release.
  foreach ($name in @($info.EnvironmentVariables.Keys)) {
    if ($name -like "ORCA_*") { $info.EnvironmentVariables.Remove($name) }
  }
  if ($environment) { foreach ($name in $environment.Keys) { $info.EnvironmentVariables[$name] = $environment[$name] } }
  return $info
}

function Invoke-Program([string]$file, [string[]]$arguments, [string]$directory, [hashtable]$environment, [int]$seconds = 120) {
  $info = New-StartInfo $file $arguments $directory $environment
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $process = [System.Diagnostics.Process]::Start($info)
  $out = $process.StandardOutput.ReadToEndAsync()
  $err = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit($seconds * 1000)) {
    try { $process.Kill() } catch { $null = $_ }
    throw "$([IO.Path]::GetFileName($file)) $($arguments -join ' ') did not finish within $seconds s"
  }
  $process.WaitForExit()
  return [pscustomobject]@{ code = $process.ExitCode; stdout = $out.Result; stderr = $err.Result }
}

function Get-Account {
  return [Security.Principal.WindowsIdentity]::GetCurrent().Name
}

# -- the daemon --------------------------------------------------------------------------------

function ConvertTo-Canonical($value) {
  # For comparing parsed JSON: key order never matters.
  return ConvertTo-JsonText $value
}

function Invoke-Hello([int]$port, [string]$tokenFile, $protocol, [int]$milliseconds = 5000) {
  $token = ([IO.File]::ReadAllText($tokenFile)).Trim()
  if ($token -notmatch '^[A-Za-z0-9._~-]+$') { throw "Invalid daemon credential" }
  $body = $Utf8.GetBytes((ConvertTo-JsonText ([ordered]@{
          kind = "request"; id = 1; method = "hello"; params = [ordered]@{ client = "orca-release"; protocol = $protocol }
        })))
  $request = [Net.WebRequest]::Create("http://127.0.0.1:$port/rpc")
  $request.Method = "POST"
  $request.Proxy = $null
  $request.Timeout = $milliseconds
  $request.ContentType = "application/json"
  $request.Headers["authorization"] = "Bearer $token"
  $stream = $request.GetRequestStream()
  try { $stream.Write($body, 0, $body.Length) } finally { $stream.Dispose() }
  $response = $request.GetResponse()
  try {
    $reader = New-Object IO.StreamReader($response.GetResponseStream(), $Utf8)
    $reply = ConvertFrom-Json -InputObject $reader.ReadToEnd()
  } finally {
    $response.Dispose()
  }
  if (-not $reply.ok) { throw "Daemon refused hello: $(ConvertTo-JsonText $reply.error)" }
  return $reply.result
}

function Assert-Hello($hello, $record, [string]$node) {
  # The managed process, exactly this release's version, protocol, capabilities and barrier.
  $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$hello.processId)" -ErrorAction SilentlyContinue
  if ($null -eq $owner -or -not $owner.ExecutablePath -or
    [IO.Path]::GetFullPath($owner.ExecutablePath) -ne [IO.Path]::GetFullPath($node)) {
    throw "Daemon hello does not belong to this release's runtime"
  }
  if ($hello.orcaVersion -ne $record.version -or
    (ConvertTo-Canonical $hello.protocol) -ne (ConvertTo-Canonical $record.compatibility.protocol)) {
    throw "Unexpected daemon version or protocol: $($hello.orcaVersion) $(ConvertTo-Canonical $hello.protocol)"
  }
  $missing = @($record.compatibility.capabilities | Where-Object { @($hello.capabilities) -notcontains $_ })
  if ($missing.Count) { throw "Daemon is missing $($missing -join ', ')" }
  if (@($hello.methods) -notcontains "maintenance") { throw "Daemon has no admission barrier" }
}

function Wait-Hello([int]$port, [string]$tokenFile, $record, [string]$node, [int]$seconds, [scriptblock]$gone) {
  $deadline = [DateTime]::UtcNow.AddSeconds($seconds)
  $last = $null
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($gone -and (& $gone)) { throw "The daemon exited before it said hello" }
    try {
      $hello = Invoke-Hello $port $tokenFile $record.compatibility.protocol
      Assert-Hello $hello $record $node
      return
    } catch {
      $last = $_.Exception.Message
      Start-Sleep -Milliseconds 500
    }
  }
  throw "Health check failed: $last"
}

# -- the setup ---------------------------------------------------------------------------------

function New-OrcaSetup([string]$version, [string]$root, [int]$port, [string]$bundle, [bool]$offline,
  [string]$expectAccount, [string]$expectRoot, [string]$expectCurrent) {
  if (-not $root) { $root = Join-Path $env:LOCALAPPDATA "orca-server" }
  return @{
    Version = $version; Port = $port; Bundle = $bundle; Offline = $offline
    Root = [IO.Path]::GetFullPath($root).TrimEnd('\')
    ExpectAccount = $expectAccount; ExpectRoot = $expectRoot; ExpectCurrent = $expectCurrent
    Before = $null; Staging = $null; Fence = @()
    CreatedCurrent = $false; RegisteredTask = $false
  }
}

function Get-RootPath($s, [string]$name) { return (Join-Path $s.Root $name) }
function Get-Release($s) { return (Join-Path (Join-Path $s.Root "releases") ("v" + $s.Version)) }
function Get-Receipt($s) { return (Join-Path (Join-Path $s.Root "receipts") ("v" + $s.Version + ".json")) }
function Get-Journal($s) { return (Get-RootPath $s ".setup-journal.json") }

function Get-OurTask {
  return Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue
}

function Test-OurTask($task) {
  return ($null -ne $task) -and ([string]$task.Description).Contains($SetupMarker)
}

function Get-TaskRoot($task) {
  # The setup directory a task of this setup runs from: its working directory.
  if ($null -eq $task -or @($task.Actions).Count -ne 1) { return $null }
  return ([string]$task.Actions[0].WorkingDirectory).TrimEnd('\')
}

function Get-PendingJournal($s) {
  # What an interrupted run recorded before its first change, or $null. Read only.
  $path = Get-Journal $s
  if (-not (Test-Present $path)) { return $null }
  try {
    $journal = Read-Json $path
    if ($journal.by -ne $SetupMarker -or $null -eq (Get-Property $journal "before")) { throw "shape" }
  } catch {
    Refuse "$path is unreadable: inspect the server and remove it by hand."
  }
  if ($journal.operation -ne "setup" -or $journal.version -ne $s.Version -or $journal.root -ne $s.Root) {
    Refuse ("An interrupted setup of v$($journal.version) is pending here. Run that setup again to finish it, " +
      "or reconcile by hand; this run changes nothing.")
  }
  return $journal
}

function Get-Lifecycle($s) {
  # A first install (`none`), or a repair of the selected version, as it will be once an
  # interrupted run is put back.
  $journal = Get-PendingJournal $s
  if ($null -ne $journal) {
    if ($null -ne $journal.before.current) { return $s.Version } else { return "none" }
  }
  if (Test-Present (Get-RootPath $s "current.txt")) { return $s.Version }
  return "none"
}

function Test-OrcaPlatform($s) {
  if ($env:OS -ne "Windows_NT" -or -not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -ne "AMD64") {
    Refuse "This machine is not Windows x64 ($env:OS $env:PROCESSOR_ARCHITECTURE); this ORCA server bundle runs on Windows x64."
  }
  if ($PSVersionTable.PSVersion.Major -lt 5 -or ($PSVersionTable.PSVersion.Major -eq 5 -and $PSVersionTable.PSVersion.Minor -lt 1)) { Refuse "The ORCA server setup needs Windows PowerShell 5.1 or newer." }
  if (-not (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) {
    Refuse "The Task Scheduler cmdlets (ScheduledTasks) are not available. The ORCA server runs as a scheduled task."
  }
  $os = [Environment]::OSVersion.Version
  Send-Step "platform" "ok" "Windows $($os.Major).$($os.Minor).$($os.Build) x64, PowerShell $($PSVersionTable.PSVersion)"
}

function Test-OrcaInventory($s) {
  $found = New-Object System.Collections.Generic.List[string]
  $marker = Get-RootPath $s ".orca-setup.json"
  if ((Test-Present $s.Root) -and -not (Test-PlainFile $marker)) {
    if (-not [IO.Directory]::Exists($s.Root) -or (Test-Reparse $s.Root) -or @(Get-ChildItem -LiteralPath $s.Root -Force).Count) {
      $found.Add("$($s.Root) exists and was not made by this setup")
    }
  }
  # A scheduled task for ORCA other than ours, or ours for another setup directory.
  foreach ($task in @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -match '(^|[^a-z])orca' -or $_.TaskPath -match '\\ORCA\\' })) {
    $ours = $task.TaskPath -eq $TaskPath -and $task.TaskName -eq $TaskName -and (Test-OurTask $task)
    if (-not $ours) { $found.Add("scheduled task $($task.TaskPath)$($task.TaskName)") }
    elseif ((Get-TaskRoot $task) -ne $s.Root) { $found.Add("scheduled task $($task.TaskPath)$($task.TaskName) for $(Get-TaskRoot $task)") }
  }
  # A launcher on PATH that runs ORCA, other than ours.
  foreach ($directory in @(([string]$env:PATH).Split([IO.Path]::PathSeparator) | Where-Object { $_ })) {
    foreach ($name in @("orca.cmd", "orca.bat", "orca.ps1", "orca.exe", "orca-acp.cmd", "orca-acp.bat", "orca-acp.ps1", "orca-acp.exe")) {
      $candidate = Join-Path $directory $name
      try {
        if (-not [IO.File]::Exists($candidate)) { continue }
        if ([IO.Path]::GetFullPath($directory).TrimEnd('\') -eq $s.Root) { continue }
        $stream = [IO.File]::OpenRead($candidate)
        try {
          $buffer = New-Object byte[] 65536
          $head = [Text.Encoding]::ASCII.GetString($buffer, 0, $stream.Read($buffer, 0, $buffer.Length))
        } finally {
          $stream.Dispose()
        }
      } catch {
        continue
      }
      if ($name -like "*.exe" -or $head -match $OrcaLauncher) { $found.Add("launcher $candidate") }
    }
  }
  # An ORCA process of this account that is not the managed daemon of this root.
  $releases = (Join-Path $s.Root "releases") + "\"
  foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
    if ($process.ProcessId -eq $PID -or -not $process.CommandLine -or $process.CommandLine -notmatch $OrcaProcess) { continue }
    if ($process.ExecutablePath -and $process.ExecutablePath.StartsWith($releases, [StringComparison]::OrdinalIgnoreCase)) { continue }
    if ($process.CommandLine.Contains($SetupMarker)) { continue }
    # The task's own cmd.exe, running this root's launcher.
    if ($process.CommandLine.IndexOf((Get-RootPath $s "orca-daemon.cmd"), [StringComparison]::OrdinalIgnoreCase) -ge 0) { continue }
    $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwner -ErrorAction SilentlyContinue
    if ($null -eq $owner -or $owner.ReturnValue -ne 0) { continue }
    if ("$($owner.Domain)\$($owner.User)" -ne (Get-Account)) { continue }
    # Its id only: a command line can hold anything, secrets included.
    $found.Add("process $($process.ProcessId)")
  }
  if ($found.Count) { Refuse ("Found an ORCA installation this setup did not make: " + ($found -join "; ") + ". " + $Guidance) }
  Send-Step "inventory" "ok" "no unmanaged ORCA installation"
}

function Test-OrcaAccount($s) {
  $account = Get-Account
  if ($s.ExpectAccount -and $account -ne $s.ExpectAccount) {
    Refuse "This connection runs as $account, not $($s.ExpectAccount) as confirmed. Nothing was changed."
  }
  Send-Step "account" "ok" $account
}

function Get-ReleaseDigests($s, [string]$release) {
  # What a receipt vouches for: every path, kind and content of the release, and its record.
  try {
    $record = Read-Json (Join-Path $release ".orca-release.json")
  } catch {
    Refuse "$release has no readable release record. $Reconcile"
  }
  if ($record.source -ne "bundle" -or $record.version -ne $s.Version -or $record.node -ne $BundleNode -or $record.entry -ne $BundleEntry) {
    Refuse "$release is not the server bundle for v$($s.Version). $Reconcile"
  }
  $base = [IO.Path]::GetFullPath($release).TrimEnd('\') + "\"
  $entries = New-Object System.Collections.Generic.List[string]
  $items = @(Get-ChildItem -LiteralPath $release -Recurse -Force | ForEach-Object {
      [pscustomobject]@{ item = $_; relative = $_.FullName.Substring($base.Length).Replace('\', '/') }
    } | Sort-Object relative -CaseSensitive)
  foreach ($entry in $items) {
    $relative = ConvertTo-Json -Compress -InputObject $entry.relative
    if (($entry.item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      Refuse "$release holds $($entry.relative), which is a link. $Reconcile"
    }
    if ($entry.item.PSIsContainer) { $entries.Add("[$relative,""dir""]") }
    else { $entries.Add("[$relative,""file"",""$(Get-Sha256 $entry.item.FullName)""]") }
  }
  return [ordered]@{ tree = (Get-TextSha256 ("[" + ($entries -join ",") + "]")); entries = $entries.Count }
}

function Get-WantedReceipt($s, [string]$staged) {
  $digests = Get-ReleaseDigests $s $staged
  return [ordered]@{ by = $SetupMarker; version = $s.Version; release = (Get-Release $s); tree = $digests.tree; entries = $digests.entries }
}

function Test-OrcaRelease($s) {
  # `releases\vVERSION` is the release this setup staged from the verified bundle: a plain
  # directory of `releases`, and its receipt still matches.
  $release = Get-Release $s
  $releases = Join-Path $s.Root "releases"
  if ((Test-Reparse $releases) -or (Test-Reparse $release) -or -not [IO.Directory]::Exists($release)) {
    Refuse "$release is not a directory of $releases. $Reconcile"
  }
  try {
    $receipt = Read-Json (Get-Receipt $s)
  } catch {
    Refuse "$release has no receipt from this setup. $Reconcile"
  }
  if ((ConvertTo-Canonical $receipt) -ne (ConvertTo-Canonical (Get-WantedReceipt $s $release))) {
    Refuse "$release changed since this setup staged and verified it. $Reconcile"
  }
}

function Get-WantedManifest($s) {
  return [ordered]@{
    root = $s.Root; repository = $BundleRepository; cwd = $s.Root; platform = $BundlePlatform
    cliConfig = (Get-RootPath $s "orca.config.yaml"); daemonConfig = (Get-RootPath $s "orca.config.yaml")
    acpConfig = (Get-RootPath $s "orca-kepler.config.yaml"); url = "http://127.0.0.1:$($s.Port)"
    service = "$TaskPath$TaskName"; scheduledTask = $true
    setup = $SetupMarker
  }
}

function Get-ExistingManifest($s) {
  # Read only: the deployment.json there is, checked to be this setup's with the keys it owns as
  # they must be. Refused before anything is written otherwise.
  $path = Get-RootPath $s "deployment.json"
  if (-not (Test-Present $path)) { return $null }
  $wanted = Get-WantedManifest $s
  try {
    $existing = Read-Json $path
  } catch {
    Refuse "$path is not readable JSON. Repair it by hand."
  }
  if ($existing -isnot [System.Management.Automation.PSCustomObject] -or $existing.setup -ne $SetupMarker) {
    Refuse "$path was not written by this setup. $Guidance"
  }
  if ($existing.url -ne $wanted.url) { Refuse "This server already listens on $($existing.url); set up with that port." }
  foreach ($key in $OwnedKeys) {
    $property = $existing.PSObject.Properties[$key]
    if ($null -ne $property -and (ConvertTo-JsonText $property.Value) -ne (ConvertTo-JsonText $wanted[$key])) {
      Refuse "$path sets $key to $(ConvertTo-JsonText $property.Value), not $(ConvertTo-JsonText $wanted[$key]). Repair it by hand; setup does not rewrite it."
    }
  }
  return $existing
}

function Test-OrcaExisting($s) {
  $null = Get-PendingJournal $s
  foreach ($name in $OwnedFiles + @("current.txt")) {
    $path = Get-RootPath $s $name
    if ((Test-Present $path) -and -not (Test-PlainFile $path)) { Refuse "$path is not a plain file this setup wrote. Repair it by hand." }
  }
  $null = Get-ExistingManifest $s
  $current = Get-RootPath $s "current.txt"
  if (Test-Present $current) {
    $selected = [IO.File]::ReadAllText($current).Trim()
    if ($selected -ne "v$($s.Version)") { Refuse "$current selects $selected, not v$($s.Version). $Reconcile" }
    Test-OrcaRelease $s
    Send-Step "existing" "ok" "v$($s.Version) is selected and verified"
  } elseif (Test-Present (Get-Release $s)) {
    Test-OrcaRelease $s
    Send-Step "existing" "ok" "v$($s.Version) is staged and verified"
  } else {
    Send-Step "existing" "ok" "nothing selected yet"
  }
}

function Open-Lock([string]$path) {
  return [IO.File]::Open($path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
}

function Enter-OrcaFence($s) {
  # The admission and update locks, held exclusively to the end of the run.
  Test-OrcaConfirmed $s $true
  $null = [IO.Directory]::CreateDirectory($s.Root)
  $marker = Get-RootPath $s ".orca-setup.json"
  if (-not (Test-PlainFile $marker)) { $null = Write-TextFile $marker ((ConvertTo-JsonText ([ordered]@{ by = $SetupMarker; version = 1 })) + "`n") }
  foreach ($name in @("admission.lock", "update.lock")) {
    try {
      $s.Fence += , (Open-Lock (Get-RootPath $s $name))
    } catch {
      Refuse ("Another setup, an update or an ORCA command is running on this server ($($_.Exception.Message.Trim())). " +
        "Run the setup again once it has finished.")
    }
  }
  if (Test-Present (Get-RootPath $s "activation.json")) { Refuse "An interrupted update is pending on this server; resolve it first." }
  Send-Step "fence" "ok" "no setup or update is running"
}

function Exit-OrcaFence($s) {
  foreach ($handle in $s.Fence) { $handle.Dispose() }
  $s.Fence = @()
}

function Get-TaskXml {
  # The task as rollback restores it, without its registration record, which registering it
  # again rewrites.
  $task = Get-OurTask
  if ($null -eq $task) { return $null }
  $xml = [string](Export-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName)
  return ($xml -replace '(?s)<RegistrationInfo>.*?</RegistrationInfo>', '<RegistrationInfo />')
}

function Get-OrcaState($s) {
  # The task, selection and files this setup may change, as they are now: a plain object, the
  # same whether it was just read or read back from a journal.
  $task = Get-OurTask
  $files = [ordered]@{}
  foreach ($name in $OwnedFiles) { $files[$name] = Get-Snapshot (Get-RootPath $s $name) }
  $state = [ordered]@{
    task = Get-TaskXml
    active = ($null -ne $task -and [string]$task.State -eq "Running")
    current = Get-Snapshot (Get-RootPath $s "current.txt")
    files = $files
  }
  return (ConvertFrom-Json -InputObject (ConvertTo-JsonText $state))
}

function Test-OrcaConfirmed($s, [bool]$quiet = $false) {
  if ($s.ExpectRoot -and $s.Root -ne $s.ExpectRoot) {
    Refuse "The setup directory is $($s.Root), not $($s.ExpectRoot) as confirmed. Nothing was changed."
  }
  if ($s.ExpectCurrent -and (Get-Lifecycle $s) -ne $s.ExpectCurrent) {
    $found = if ((Get-Lifecycle $s) -eq "none") { "a first install" } else { "a repair of v$($s.Version)" }
    Refuse "This is now $found, not what was confirmed. Check the server again. Nothing was changed."
  }
  if (-not $quiet) { Send-Step "confirmed" "ok" "$(Get-Account), $($s.Root)" }
}

function Invoke-OrcaRecover($s) {
  $journal = Get-PendingJournal $s
  if ($null -eq $journal) { Send-Step "recover" "ok" "no interrupted setup"; return }
  $problems = Restore-OrcaState $s $journal.before (Get-Property $journal "staging")
  if ($problems.Count) { throw ("Could not put back what an interrupted setup changed: " + ($problems -join "; ")) }
  [IO.File]::Delete((Get-Journal $s))
  Send-Step "recover" "repaired" "put back what an interrupted setup had changed"
}

function Start-OrcaJournal($s) {
  $s.Before = Get-OrcaState $s
  $s.Staging = $null
  Write-OrcaJournal $s
}

function Write-OrcaJournal($s) {
  $journal = [ordered]@{ by = $SetupMarker; operation = "setup"; version = $s.Version; root = $s.Root; before = $s.Before }
  if ($s.Staging) { $journal.staging = $s.Staging }
  $null = Write-TextFile (Get-Journal $s) ((ConvertTo-JsonText $journal) + "`n")
}

function Stop-OrcaDaemon($s) {
  # Stopping the task ends its cmd.exe; the daemon it started is ended by its runtime's path.
  Stop-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue
  $releases = (Join-Path $s.Root "releases") + "\"
  foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue)) {
    if ($process.ExecutablePath -and $process.ExecutablePath.StartsWith($releases, [StringComparison]::OrdinalIgnoreCase)) {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
}

function Get-OwnedScratch($s, $staging) {
  # A journal's staging scratch, only if it is one this setup makes.
  if (-not $staging) { return $null }
  $path = [IO.Path]::GetFullPath([string]$staging)
  if ([IO.Path]::GetDirectoryName($path) -ne $s.Root -or -not [IO.Path]::GetFileName($path).StartsWith($ScratchPrefix) -or (Test-Reparse $path)) {
    return $null
  }
  return $path
}

function Restore-OrcaState($s, $before, $staging) {
  # Put the task, `current.txt` and this setup's files back as `before`, remove the run's own
  # scratch, then check. Returns what could not be put back or confirmed. A release in
  # `releases\` is never removed: it is not this transaction's to remove.
  $problems = New-Object System.Collections.Generic.List[string]
  $attempt = {
    param([string]$what, [scriptblock]$action)
    try { & $action } catch { $problems.Add("${what}: $($_.Exception.Message)") }
  }
  $now = Get-OrcaState $s
  if ($now.active -and -not $before.active) { & $attempt "stop" { Stop-OrcaDaemon $s } }
  if ($now.task -cne $before.task) {
    & $attempt "scheduled task" {
      if ($null -eq $before.task) { Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -Confirm:$false }
      else { $null = Register-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -Xml $before.task -Force }
    }
  }
  if ($now.current -cne $before.current) {
    & $attempt "current.txt" {
      $path = Get-RootPath $s "current.txt"
      if ($null -eq $before.current) { [IO.File]::Delete($path) } else { $null = Write-TextFile $path $before.current }
    }
  }
  foreach ($name in $OwnedFiles) {
    $prior = $before.files.$name
    if ($now.files.$name -cne $prior) {
      & $attempt $name {
        $path = Get-RootPath $s $name
        if ($null -eq $prior) { [IO.File]::Delete($path) } else { $null = Write-TextFile $path $prior }
      }
    }
  }
  $scratch = Get-OwnedScratch $s $staging
  if ($scratch -and (Test-Present $scratch)) { & $attempt "staging scratch" { Remove-Item -LiteralPath $scratch -Recurse -Force } }
  if ($before.active -and -not (Get-OrcaState $s).active) { & $attempt "start" { Start-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName } }
  $after = Get-OrcaState $s
  if ($scratch -and (Test-Present $scratch)) { $problems.Add("the staging scratch is still there") }
  foreach ($name in $OwnedFiles) {
    if ($after.files.$name -cne $before.files.$name) { $problems.Add("$name is not back as it was") }
  }
  if ($after.task -cne $before.task) { $problems.Add("the scheduled task is not back as it was") }
  if ($after.current -cne $before.current) { $problems.Add("current.txt is not back as it was") }
  if ($after.active -and -not $before.active) { $problems.Add("the daemon is still running") }
  return , $problems
}

function Get-Launcher([string]$kind, $s) {
  # Paths relative to the launcher itself (%~dp0), so a directory with any name works.
  $head = @(
    "@echo off",
    "rem ${SetupMarker}: the managed ORCA $kind launcher (#1238).",
    "setlocal",
    'set "ORCA_CURRENT="',
    'set /p ORCA_CURRENT=<"%~dp0current.txt"',
    'if not defined ORCA_CURRENT goto none',
    'set "ORCA_RELEASE=%~dp0releases\%ORCA_CURRENT%"',
    'set "ORCA_CURRENT="',
    'set "ORCA_MAINTENANCE_TOKEN="',
    'set "ORCA_ADMISSION_FILE="'
  )
  $run = '"%ORCA_RELEASE%\runtime\node.exe" "%ORCA_RELEASE%\orca-daemon.mjs"'
  $line = switch ($kind) {
    "cli" { "$run --config ""%~dp0orca.config.yaml"" %*" }
    "acp" { "$run --config ""%~dp0orca-kepler.config.yaml"" acp %*" }
    "daemon" { "$run --config ""%~dp0orca.config.yaml"" --cwd ""%~dp0."" serve --host 127.0.0.1 --port $($s.Port)" }
  }
  $tail = @($line, "exit /b %ERRORLEVEL%", ":none", "echo orca: no release is selected here 1>&2", "exit /b 1")
  return (($head + $tail) -join "`r`n") + "`r`n"
}

function Install-OrcaFiles($s) {
  $manifest = Get-WantedManifest $s
  $changed = New-Object System.Collections.Generic.List[string]
  $repaired = New-Object System.Collections.Generic.List[string]
  $path = Get-RootPath $s "deployment.json"
  $existing = Get-ExistingManifest $s
  if ($null -ne $existing) {
    $missing = @($manifest.Keys | Where-Object { $null -eq $existing.PSObject.Properties[$_] })
    if ($missing.Count) {
      foreach ($key in $missing) { $existing | Add-Member -NotePropertyName $key -NotePropertyValue $manifest[$key] }
      $null = Write-TextFile $path ((ConvertTo-JsonText $existing) + "`n")
      $repaired.Add("deployment.json (" + ($missing -join ", ") + ")")
    }
  } else {
    $null = Write-TextFile $path ((ConvertTo-JsonText $manifest) + "`n")
    $changed.Add("deployment.json")
  }
  foreach ($name in @("orca.config.yaml", "orca-kepler.config.yaml")) {
    if (-not (Test-Present (Get-RootPath $s $name))) {
      $null = Write-TextFile (Get-RootPath $s $name) $ServerConfig
      $changed.Add($name)
    }
  }
  foreach ($pair in @(@("orca.cmd", "cli"), @("orca-acp.cmd", "acp"), @("orca-daemon.cmd", "daemon"))) {
    if (Write-TextFile (Get-RootPath $s $pair[0]) (Get-Launcher $pair[1] $s)) { $changed.Add($pair[0]) }
  }
  $result = if ($changed.Count) { "changed" } elseif ($repaired.Count) { "repaired" } else { "ok" }
  Send-Step "files" $result ((@($changed) + @($repaired)) -join ", ")
}

function Get-BundleNames([string]$version) {
  $stem = "orca-server-$version-$BundlePlatform"
  return [ordered]@{ stem = $stem; archive = "$stem.zip"; manifest = "$stem.manifest.json"; signature = "$stem.manifest.json.sigstore.json" }
}

function Copy-Checked([string]$source, [string]$target, [long]$limit, [string]$what) {
  if (-not (Test-PlainFile $source) -or (Get-Item -LiteralPath $source -Force).Length -gt $limit) {
    throw "$what is missing, or not a regular file within its size limit"
  }
  Copy-Item -LiteralPath $source -Destination $target
}

function Get-OrcaCosign($s) {
  # The pinned cosign, fetched (or taken from the carried bundle) once and re-hashed every use.
  $tools = Get-RootPath $s "tools"
  $null = [IO.Directory]::CreateDirectory($tools)
  $path = Join-Path $tools "cosign-$CosignVersion-windows-amd64.exe"
  if (-not (Test-Present $path)) {
    $partial = Join-Path $tools ("cosign-{0}.partial" -f [guid]::NewGuid().ToString("n"))
    try {
      if ($s.Offline) {
        # Offline: the carried cosign or nothing. The network is never tried.
        Copy-Checked (Join-Path $s.Bundle $CosignName) $partial 256MB "Pushed cosign"
        if ((Get-Sha256 $partial) -ne $CosignSha256) { throw "Pushed cosign does not match its pinned digest" }
      } else {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $ProgressPreference = "SilentlyContinue"
        Invoke-WebRequest -UseBasicParsing -OutFile $partial "https://github.com/sigstore/cosign/releases/download/$CosignVersion/$CosignName"
        if ((Get-Sha256 $partial) -ne $CosignSha256) { throw "Downloaded cosign does not match its pinned digest" }
      }
      [IO.File]::Move($partial, $path)
    } finally {
      if ([IO.File]::Exists($partial)) { [IO.File]::Delete($partial) }
    }
  }
  if (-not (Test-PlainFile $path) -or (Get-Sha256 $path) -ne $CosignSha256) {
    throw "$path does not match the pinned cosign digest; remove it to fetch it again"
  }
  return $path
}

function Test-OrcaSignature($s, [string]$manifest, [string]$signature, [string]$trustedRoot) {
  # The manifest's signature, by the pinned signer only. Throws when it is not.
  $cosign = Get-OrcaCosign $s
  $tuf = Join-Path (Get-RootPath $s "tools") "sigstore"
  $null = [IO.Directory]::CreateDirectory($tuf)
  $arguments = @("verify-blob", $manifest, "--bundle", $signature,
    "--certificate-identity", $BundleSigner, "--certificate-oidc-issuer", $BundleIssuer,
    "--certificate-github-workflow-repository", $BundleRepository,
    "--certificate-github-workflow-ref", "refs/heads/main",
    "--certificate-github-workflow-trigger", $BundleTrigger)
  if ($trustedRoot) { $arguments += @("--trusted-root", $trustedRoot) }
  $result = Invoke-Program $cosign $arguments $tuf @{ TUF_ROOT = $tuf; HOME = $tuf; USERPROFILE = $tuf }
  if ($result.code -ne 0) {
    $lines = @(("$($result.stdout)`n$($result.stderr)").Split("`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $detail = if ($lines.Count) { $lines[-1] } else { "no output" }
    throw "Bundle signature refused: $detail"
  }
}

function Get-PushedTrustedRoot($s, [string]$directory) {
  $path = Join-Path $s.Bundle $PushedTrustedRoot
  $copy = Join-Path $directory $PushedTrustedRoot
  Copy-Checked $path $copy $TrustedRootMax "Pushed trusted root"
  if ($TrustedRootSha256 -notcontains (Get-Sha256 $copy)) {
    throw "Pushed trusted root is not one this release trusts; update ORCA, or set up with internet access"
  }
  return $copy
}

function Test-OrcaBundle($s, [string]$downloads) {
  # Signature first (pinned signer), then the manifest, then the archive's digest.
  $names = Get-BundleNames $s.Version
  $manifestPath = Join-Path $downloads $names.manifest
  $archivePath = Join-Path $downloads $names.archive
  $trust = if ($s.Offline) { Get-PushedTrustedRoot $s $downloads } else { $null }
  Test-OrcaSignature $s $manifestPath (Join-Path $downloads $names.signature) $trust
  $manifest = Read-Json $manifestPath
  $expected = [ordered]@{ schema = $BundleSchema; name = "orca-server"; version = $s.Version; platform = $BundlePlatform; root = $names.stem }
  foreach ($key in $expected.Keys) {
    if ((Get-Property $manifest $key) -ne $expected[$key]) { throw "Bundle manifest $key is $(Get-Property $manifest $key), expected $($expected[$key])" }
  }
  if ($manifest.entry -ne $BundleEntry -or (Get-Property (Get-Property $manifest "node") "path") -ne $BundleNode) {
    throw "Bundle manifest names an unexpected runtime or entry"
  }
  if ([string]$manifest.sourceSha -notmatch '^[0-9a-f]{40}$') { throw "Bundle manifest has no source commit" }
  $listed = Get-Property $manifest "archive"
  if ((Get-Property $listed "name") -ne $names.archive -or [string](Get-Property $listed "sha256") -notmatch '^[0-9a-f]{64}$') {
    throw "Bundle manifest does not describe the archive"
  }
  if ([long]$listed.size -ne (Get-Item -LiteralPath $archivePath).Length -or (Get-Sha256 $archivePath) -ne $listed.sha256) {
    throw "Bundle archive does not match its signed manifest digest"
  }
  return $manifest
}

function Expand-OrcaBundle([string]$archive, [string]$rootName, [string]$destination) {
  # Regular files and directories only, all under the single expected root, no links, absolute
  # paths, drive letters or `..`, and bounded in size: checked before anything is written.
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($archive)
  try {
    $unpacked = [long]0
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName
      $parts = $name.TrimEnd('/').Split('/')
      $kind = ($entry.ExternalAttributes -shr 16) -band 0xF000
      if ($parts[0] -ne $rootName -or $name.StartsWith("/") -or $name.Contains("\") -or $name.Contains(":") -or
        $parts -contains ".." -or $parts -contains "." -or $parts -contains "" -or ($kind -ne 0 -and $kind -ne 0x8000 -and $kind -ne 0x4000)) {
        throw "Bundle entry refused: $name"
      }
      $unpacked += $entry.Length
      if ($unpacked -gt $BundleMaxUnpacked) { throw "Bundle unpacks beyond the size limit" }
    }
    foreach ($entry in $zip.Entries) {
      $relative = $entry.FullName.Substring($rootName.Length).TrimStart('/')
      if (-not $relative) { continue }
      $target = Join-Path $destination ($relative.TrimEnd('/').Replace('/', '\'))
      if ($entry.FullName.EndsWith("/")) { $null = [IO.Directory]::CreateDirectory($target); continue }
      $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
    }
  } finally {
    $zip.Dispose()
  }
}

function Test-OrcaStaged($s, [string]$stage, $record) {
  # The release runs: its CLI's version, the scripted demo, both configs, a temporary daemon's
  # hello. The demo and the daemon run in the system's temporary directory: nothing under the
  # setup directory, whose configuration the daemon would otherwise find.
  $scratch = Join-Path ([IO.Path]::GetTempPath()) ("orca-setup-" + [guid]::NewGuid().ToString("n").Substring(0, 12))
  $null = [IO.Directory]::CreateDirectory($scratch)
  try {
    Test-OrcaRuns $s $stage $record $scratch
  } finally {
    Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Test-OrcaRuns($s, [string]$stage, $record, [string]$scratch) {
  $node = Join-Path $stage "runtime\node.exe"
  $entry = Join-Path $stage $BundleEntry
  $run = {
    param([string[]]$arguments, [string]$directory, [hashtable]$environment)
    $result = Invoke-Program $node (@($entry) + $arguments) $directory $environment
    if ($result.code -ne 0) { throw "$($arguments -join ' ') exited $($result.code): $(([string]$result.stderr).Trim())" }
    return ([string]$result.stdout).Trim()
  }
  $version = & $run @("--version") $stage @{}
  if ($version -ne $s.Version) { throw "Built CLI version mismatch: $version" }
  & $run @("demo", "--dir", (Join-Path $scratch "demo")) $stage @{ ORCA_RELEASE = $stage } | Out-Null
  foreach ($config in @("orca.config.yaml", "orca-kepler.config.yaml")) {
    & $run @("--config", (Get-RootPath $s $config), "validate") $s.Root @{ ORCA_RELEASE = $stage } | Out-Null
  }
  $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = $listener.LocalEndpoint.Port
  $listener.Stop()
  $workspace = Join-Path $scratch "serve"
  $null = [IO.Directory]::CreateDirectory($workspace)
  $info = New-StartInfo $node @($entry, "--cwd", $workspace, "serve", "--port", [string]$port) $stage @{}
  # Its output is not this setup's: read and dropped, never left to fill a pipe.
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $daemon = [System.Diagnostics.Process]::Start($info)
  $null = $daemon.StandardOutput.ReadToEndAsync()
  $null = $daemon.StandardError.ReadToEndAsync()
  try {
    Wait-Hello $port (Join-Path $workspace "auth\local-client.token") $record $node $HealthSeconds { $daemon.HasExited }
  } finally {
    if (-not $daemon.HasExited) {
      try { $daemon.Kill() } catch { $null = $_ }
      $null = $daemon.WaitForExit(10000)
    }
  }
}

function Invoke-OrcaStage($s) {
  $release = Get-Release $s
  if (Test-Present $release) {
    Test-OrcaRelease $s
    Send-Step "stage" "ok" "v$($s.Version) already staged and verified"
    return
  }
  if (-not $s.Bundle) { throw "No bundle to stage: pass -Bundle with the three server bundle files" }
  # Staged into this transaction's own scratch, named in the journal first: a run cut off
  # mid-stage leaves only that, which recovery removes.
  $scratch = Join-Path $s.Root ($ScratchPrefix + [guid]::NewGuid().ToString("n").Substring(0, 12))
  $null = [IO.Directory]::CreateDirectory($scratch)
  $s.Staging = $scratch
  Write-OrcaJournal $s
  $names = Get-BundleNames $s.Version
  $downloads = Join-Path $scratch "bundle"
  $stage = Join-Path $scratch "release"
  $null = [IO.Directory]::CreateDirectory($downloads)
  $null = [IO.Directory]::CreateDirectory($stage)
  Copy-Checked (Join-Path $s.Bundle $names.manifest) (Join-Path $downloads $names.manifest) 4MB "Bundle file $($names.manifest)"
  Copy-Checked (Join-Path $s.Bundle $names.signature) (Join-Path $downloads $names.signature) 4MB "Bundle file $($names.signature)"
  Copy-Checked (Join-Path $s.Bundle $names.archive) (Join-Path $downloads $names.archive) $BundleMaxBytes "Bundle file $($names.archive)"
  $manifest = Test-OrcaBundle $s $downloads
  # The exact signed bytes this release was verified from, kept in its record.
  $receipt = [ordered]@{}
  foreach ($kind in @("archive", "manifest", "signature")) {
    $file = Join-Path $downloads $names[$kind]
    $receipt[$kind + "Sha256"] = Get-Sha256 $file
    $receipt[$kind + "Size"] = (Get-Item -LiteralPath $file).Length
  }
  if ($receipt.archiveSha256 -ne $manifest.archive.sha256) { throw "Verified archive changed before unpacking" }
  Expand-OrcaBundle (Join-Path $downloads $names.archive) $manifest.root $stage
  foreach ($relative in @($BundleNode, $BundleEntry)) {
    if (-not (Test-PlainFile (Join-Path $stage $relative.Replace('/', '\')))) { throw "Bundle has no regular $relative" }
  }
  $inside = Read-Json (Join-Path $stage "orca-server.json")
  $contract = Read-Json (Join-Path $stage "release-compatibility.json")
  if ($inside.version -ne $s.Version -or $inside.sourceSha -ne $manifest.sourceSha -or $inside.entry -ne $manifest.entry -or
    $inside.node -ne $manifest.node.path -or (ConvertTo-Canonical $contract) -ne (ConvertTo-Canonical $manifest.compatibility)) {
    throw "Unpacked bundle disagrees with its signed manifest"
  }
  $record = [ordered]@{ version = $s.Version; sha = $manifest.sourceSha; node = $BundleNode; entry = $BundleEntry
    source = "bundle"; compatibility = $contract; bundle = $receipt
  }
  $null = Write-TextFile (Join-Path $stage ".orca-release.json") ((ConvertTo-JsonText $record) + "`n")
  Test-OrcaStaged $s $stage (ConvertFrom-Json -InputObject (ConvertTo-JsonText $record))
  $wanted = Get-WantedReceipt $s $stage
  $null = [IO.Directory]::CreateDirectory((Join-Path $s.Root "receipts"))
  $null = Write-TextFile (Get-Receipt $s) ((ConvertTo-JsonText $wanted) + "`n")
  $null = [IO.Directory]::CreateDirectory((Join-Path $s.Root "releases"))
  if (Test-Present $release) { throw "$release appeared while this setup staged it; nothing was published" }
  [IO.Directory]::Move($stage, $release)
  Test-OrcaRelease $s
  Remove-Item -LiteralPath $scratch -Recurse -Force
  $s.Staging = $null
  Write-OrcaJournal $s
  Send-Step "stage" "changed" "v$($s.Version) staged from the signed bundle"
}

function Select-OrcaRelease($s) {
  $current = Get-RootPath $s "current.txt"
  if (Test-Present $current) { Send-Step "select" "ok" "current is v$($s.Version)"; return }
  $null = Write-TextFile $current ("v" + $s.Version + "`r`n")
  $s.CreatedCurrent = $true
  Send-Step "select" "changed" "current -> v$($s.Version)"
}

function New-OrcaTaskDefinition($s, [bool]$atStartup) {
  $account = Get-Account
  $launcher = Get-RootPath $s "orca-daemon.cmd"
  $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\cmd.exe" -Argument "/d /c ""$launcher""" -WorkingDirectory $s.Root
  $trigger = if ($atStartup) { New-ScheduledTaskTrigger -AtStartup } else { New-ScheduledTaskTrigger -AtLogOn -User $account }
  # At boot: whether or not the account is logged on, with no password stored (S4U). At logon
  # (the fallback): in the account's own session.
  $logon = if ($atStartup) { "S4U" } else { "Interactive" }
  $principal = New-ScheduledTaskPrincipal -UserId $account -LogonType $logon -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
  return New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
    -Description "${SetupMarker}: the managed ORCA daemon for $($s.Root) (#1238)."
}

function Test-TaskCurrent($s, $task) {
  # Ours, for this root, running this root's launcher as this account.
  if (-not (Test-OurTask $task) -or (Get-TaskRoot $task) -ne $s.Root) { return $false }
  $wanted = (New-OrcaTaskDefinition $s $true).Actions[0]
  $action = $task.Actions[0]
  return $action.Execute -eq $wanted.Execute -and $action.Arguments -eq $wanted.Arguments -and
  [string]$task.Description -eq [string](New-OrcaTaskDefinition $s $true).Description
}

function Install-OrcaTask($s) {
  $task = Get-OurTask
  if (Test-TaskCurrent $s $task) {
    if ([string]$task.State -eq "Disabled") {
      $null = Enable-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName
      Send-Step "task" "repaired" "$TaskPath$TaskName enabled"
    } else {
      Send-Step "task" "ok" "$TaskPath$TaskName"
    }
    return
  }
  try {
    $null = Register-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -InputObject (New-OrcaTaskDefinition $s $true) -Force
    $s.RegisteredTask = $true
    Send-Step "task" "changed" "$TaskPath$TaskName, started at boot whether or not $(Get-Account) is logged on"
  } catch {
    # An account that may not register a boot task: started at its logon instead.
    $reason = $_.Exception.Message
    $null = Register-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -InputObject (New-OrcaTaskDefinition $s $false) -Force
    $s.RegisteredTask = $true
    Send-Step "task" "changed" "$TaskPath$TaskName"
    Send-Step "boot" "warning" ("could not register a task that starts at boot ($($reason.Trim())), so the daemon starts when " +
      "$(Get-Account) logs on. An administrator can run this setup once as this account from an elevated session to start it at boot.")
  }
}

function Test-OrcaHealth($s) {
  # The release `current.txt` names, answering as the task's own process. A first start creates
  # its store and credential file, so it gets a minute.
  $release = Get-Release $s
  $record = Read-Json (Join-Path $release ".orca-release.json")
  Wait-Hello $s.Port (Get-RootPath $s "auth\local-client.token") $record (Join-Path $release "runtime\node.exe") $HealthSeconds $null
}

function Start-OrcaTask($s) {
  $active = [string](Get-OurTask).State -eq "Running"
  if (-not $active) { Start-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName }
  Test-OrcaHealth $s
  $result = if ($active) { "ok" } elseif ($s.RegisteredTask -or $s.CreatedCurrent) { "changed" } else { "repaired" }
  Send-Step "start" $result "daemon healthy on 127.0.0.1:$($s.Port)"
}

function Undo-OrcaRun($s) {
  # After a failure: everything back as this run found it, checked, and reported as `cleanup`.
  if ($null -eq $s.Before) { return }
  $problems = Restore-OrcaState $s $s.Before $s.Staging
  if ($problems.Count) {
    Send-Step "cleanup" "failed" ("Could not confirm everything is back as it was: " + ($problems -join "; ") + ". The next setup run puts it back first.")
    return
  }
  [IO.File]::Delete((Get-Journal $s))
  Send-Step "cleanup" "ok" "everything this run changed is back as it was"
}

function Invoke-OrcaInspect($s) {
  $step = "platform"
  try {
    foreach ($pair in @(@("platform", "Test-OrcaPlatform"), @("inventory", "Test-OrcaInventory"), @("existing", "Test-OrcaExisting"))) {
      $step = $pair[0]
      $null = & $pair[1] $s
    }
  } catch [OrcaRefused] {
    Send-Step $step "refused" $_.Exception.Message
    return 2
  } catch {
    Send-Step $step "failed" ([string]$_.Exception.Message)
    return 1
  }
  $current = if ((Get-Lifecycle $s) -eq "none") { $null } else { $s.Version }
  Send-Line ([ordered]@{ inspected = $true; account = (Get-Account); root = $s.Root; current = $current })
  return 0
}

function Invoke-OrcaRun($s) {
  $step = "account"
  $done = $null
  try {
    foreach ($pair in @(@("account", "Test-OrcaAccount"), @("platform", "Test-OrcaPlatform"), @("inventory", "Test-OrcaInventory"),
        @("fence", "Enter-OrcaFence"), @("confirmed", "Test-OrcaConfirmed"), @("recover", "Invoke-OrcaRecover"),
        @("existing", "Test-OrcaExisting"), @("journal", "Start-OrcaJournal"), @("files", "Install-OrcaFiles"),
        @("stage", "Invoke-OrcaStage"), @("select", "Select-OrcaRelease"), @("task", "Install-OrcaTask"), @("start", "Start-OrcaTask"))) {
      $step = $pair[0]
      $null = & $pair[1] $s
    }
    $step = "finish"
    $done = [ordered]@{ done = $true; root = $s.Root; command = (Get-RootPath $s "orca.cmd"); account = (Get-Account)
      version = $s.Version; port = $s.Port; platform = $BundlePlatform
    }
    [IO.File]::Delete((Get-Journal $s))
  } catch [OrcaRefused] {
    Send-Step $step "refused" $_.Exception.Message
    Undo-OrcaRun $s
    return 2
  } catch {
    $message = [string]$_.Exception.Message
    Send-Step $step "failed" $message.Substring(0, [Math]::Min(2000, $message.Length))
    Undo-OrcaRun $s
    return 1
  } finally {
    Exit-OrcaFence $s
  }
  Send-Line $done
  return 0
}

function Invoke-OrcaServerSetup($options) {
  # Arguments checked as the Linux setup's are; a bad one is a usage error (exit 2).
  $usage = {
    param([string]$message)
    [Console]::Error.WriteLine("orca-server-setup: error: $message")
    return 2
  }
  $version = [string]$options.Version
  if ($version -notmatch $VersionPattern) { return (& $usage "-Version takes X.Y.Z or X.Y.Z-rc.N") }
  if ($options.Root -and -not [IO.Path]::IsPathRooted([string]$options.Root)) { return (& $usage "-Root must be absolute") }
  $port = if ($options.ContainsKey("Port")) { [int]$options.Port } else { 6722 }
  if ($port -lt 1024 -or $port -gt 65535) { return (& $usage "-Port must be 1024-65535") }
  if ($options.OfflineBundle -and -not $options.Bundle) { return (& $usage "-OfflineBundle needs -Bundle") }
  $bundle = if ($options.Bundle) { [IO.Path]::GetFullPath([string]$options.Bundle) } else { $null }
  $s = New-OrcaSetup $version ([string]$options.Root) $port $bundle ([bool]$options.OfflineBundle) `
    ([string]$options.ExpectAccount) ([string]$options.ExpectRoot) ([string]$options.ExpectCurrent)
  if ($options.Inspect) { return (Invoke-OrcaInspect $s) }
  return (Invoke-OrcaRun $s)
}

if ($MyInvocation.InvocationName -ne ".") {
  $code = @(Invoke-OrcaServerSetup $PSBoundParameters)[-1]
  exit ([int]$code)
}
