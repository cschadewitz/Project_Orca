# Runs tools/deploy/orca-server-setup.ps1 as the client does (its own Windows PowerShell), with
# one of its functions replaced for a test (#1238). The bundle a pull request builds is not signed
# by the release workflow, so `trust` accepts its signature; everything else runs as shipped.
#
#   real          nothing replaced: the pinned cosign checks the signature
#   trust         the signature check accepts the bundle
#   fail-health   trust, and the daemon's health check fails
#   exit-at-task  trust, and the process ends where the task would be registered, as a cut
#                 ssh session ends it
param(
  [Parameter(Mandatory = $true)][string]$Mode,
  [string]$Version,
  [string]$Root,
  [int]$Port = 6722,
  [string]$Bundle,
  [switch]$Inspect,
  [string]$ExpectCurrent
)
$options = @{}
foreach ($key in $PSBoundParameters.Keys) { if ($key -ne "Mode") { $options[$key] = $PSBoundParameters[$key] } }
$mode = $Mode
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
$code = @(Invoke-OrcaServerSetup $options)[-1]
exit ([int]$code)
