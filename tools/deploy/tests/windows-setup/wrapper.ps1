# Runs tools/deploy/orca-server-setup.ps1 as the client does (its own Windows PowerShell), with
# one of its functions replaced for a test (#1238). The bundle a pull request builds is not signed
# by the release workflow, so `trust` accepts its signature; everything else runs as shipped.
#
#   real          nothing replaced: the pinned cosign checks the signature
#   trust         the signature check accepts the bundle
#   fail-health   trust, and the daemon's health check fails
#   exit-at-task  trust, and the process ends where the task would be registered, as a cut
#                 ssh session ends it
#   drive-KIND    trust, and Windows says the setup directory's volume is KIND (Network, Unknown)
#   no-boot       trust, and registering a task that starts at boot fails, as it does for an
#                 account that may not; the task is not started (a logon task runs only in a
#                 logged-on session, which a CI runner has none of)
#
# With -Feed DIR, downloads are served from DIR instead of the network: the release's API record
# from DIR\release.json, any other URL from the DIR file its last segment names.
param(
  [Parameter(Mandatory = $true)][string]$Mode,
  [string]$Version,
  [string]$Root,
  [int]$Port = 6722,
  [string]$Bundle,
  [switch]$Inspect,
  [string]$ExpectCurrent,
  [string]$Feed
)
$options = @{}
foreach ($key in $PSBoundParameters.Keys) { if ($key -ne "Mode" -and $key -ne "Feed") { $options[$key] = $PSBoundParameters[$key] } }
$mode = $Mode
$script:feed = $Feed
. (Join-Path $PSScriptRoot "..\..\orca-server-setup.ps1")
if ($mode -ne "real") {
  function Test-OrcaSignature { param($s, $manifest, $signature, $trustedRoot) }
}
if ($mode -eq "fail-health") {
  function Test-OrcaHealth { param($s) throw "the test says the daemon is unhealthy" }
}
if ($mode -eq "exit-at-task") {
  function Install-OrcaTask { param($s) [Environment]::Exit(9) }
}
if ($mode -like "drive-*") {
  $script:driveKind = $mode.Substring(6)
  function Get-OrcaDriveType { param($drive) $script:driveKind }
}
if ($mode -eq "no-boot") {
  function Register-OrcaTask {
    param($s, [bool]$atStartup)
    if ($atStartup) { throw "Access is denied (the test refuses a boot task)." }
    $null = Register-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -InputObject (New-OrcaTaskDefinition $s $false) -Force
  }
  function Start-OrcaTask { param($s) Send-Step "start" "ok" "not started by the test" }
}
if ($script:feed) {
  function Invoke-OrcaDownload {
    param([string]$url, [string]$target, [long]$limit, [int]$seconds, [string]$accept)
    if (-not $url.StartsWith("https://")) { throw "Downloads must use HTTPS: $url" }
    $name = if ($url -like "https://api.github.com/repos/*/releases/tags/*") { "release.json" } else { $url.Split("/")[-1] }
    $source = Join-Path $script:feed $name
    if (-not (Test-Path -LiteralPath $source)) { throw "Download failed with HTTP 404: $url" }
    if ((Get-Item -LiteralPath $source).Length -gt $limit) { throw "Download exceeds $limit bytes: $url" }
    if (Test-Path -LiteralPath $target) { throw "$target already exists" }
    Copy-Item -LiteralPath $source -Destination $target
  }
}
$code = @(Invoke-OrcaServerSetup $options)[-1]
exit ([int]$code)
