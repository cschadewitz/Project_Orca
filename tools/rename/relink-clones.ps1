<#
  Points existing clones at the renamed repositories (Windows). Same as relink-clones.sh:

    pwsh tools/rename/relink-clones.ps1 [-DryRun] [CLONE...]     (default: the current directory)

  For every remote whose URL names cschadewitz/Project_Orca or cschadewitz/Project_Orca_Infra,
  sets it to Orrery or Orrery-Infra. Idempotent. Each change is appended to the cutover log
  ($env:CUTOVER_LOG, default .\cutover-log.json) for rollback.sh.
#>
param(
  [switch]$DryRun,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Clones
)
$ErrorActionPreference = 'Stop'
$owner = if ($env:CUTOVER_OWNER) { $env:CUTOVER_OWNER } else { 'cschadewitz' }
$log = if ($env:CUTOVER_LOG) { $env:CUTOVER_LOG } else { Join-Path (Get-Location) 'cutover-log.json' }
if (-not $Clones) { $Clones = @((Get-Location).Path) }

function New-Url([string]$url) {
  $infra = "([:/]$owner/)Project_Orca_Infra(\.git)?/?$"
  if ($url -match $infra) { return $url -replace $infra, '${1}Orrery-Infra${2}' }
  return $url -replace "([:/]$owner/)Project_Orca(\.git)?/?$", '${1}Orrery${2}'
}

$failed = $false
foreach ($clone in $Clones) {
  Write-Output "`n== $clone"
  git -C $clone rev-parse --git-dir 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Output "  FAIL  not a Git clone"; $failed = $true; continue }
  $clone = (Resolve-Path $clone).Path
  foreach ($remote in (git -C $clone remote)) {
    foreach ($url in (git -C $clone config --get-all "remote.$remote.url")) {
      $next = New-Url $url
      if ($next -eq $url) { Write-Output "  ok    $remote $url"; continue }
      if ($DryRun) {
        Write-Output "  would point $remote at $next"
        Write-Output "        `$ git -C $clone config --fixed-value --replace-all remote.$remote.url $next $url"
        continue
      }
      Write-Output "  do    point $remote at $next"
      git -C $clone config --fixed-value --replace-all "remote.$remote.url" $next $url
      if ($LASTEXITCODE -ne 0) { throw "git config failed for $remote" }
      $entry = [ordered]@{ at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); kind = 'remote-url';
        clone = $clone; remote = $remote; before = $url; after = $next }
      Add-Content -Path $log -Value ($entry | ConvertTo-Json -Compress)
    }
  }
}
if ($DryRun) { Write-Output "`n(dry run: nothing was changed)" }
if ($failed) { exit 1 }
