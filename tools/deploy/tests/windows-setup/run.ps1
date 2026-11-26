<#
The Windows server setup (#1238) on a real Windows machine, against a real bundle:

  powershell -NoProfile -ExecutionPolicy Bypass -File run.ps1 -Bundle DIR -Version X.Y.Z

DIR holds orca-server-X.Y.Z-win-x64.zip and its manifest, as server-bundle.py assembles them.
Each case runs tools/deploy/orca-server-setup.ps1 in its own Windows PowerShell through
wrapper.ps1 and reads its `orca-setup:` lines. It registers and removes the real scheduled task
\ORCA\orca-server, so it runs only on a throwaway machine (a CI runner). Throws on the first
case that fails.
#>
param(
  [Parameter(Mandatory = $true)][string]$Bundle,
  [Parameter(Mandatory = $true)][string]$Version
)
$ErrorActionPreference = "Stop"
$wrapper = Join-Path $PSScriptRoot "wrapper.ps1"
$base = Join-Path ([IO.Path]::GetTempPath()) ("orca-setup-test-" + [guid]::NewGuid().ToString("n").Substring(0, 8))
$root = Join-Path $base "orca-server"
$stem = "orca-server-$Version-win-x64"

# The PR's bundle is unsigned: a signature file that no signer made stands in for one.
$carried = Join-Path $base "carried"
$null = New-Item -ItemType Directory -Force $carried
Copy-Item (Join-Path $Bundle "$stem.zip"), (Join-Path $Bundle "$stem.manifest.json") $carried
Set-Content -LiteralPath (Join-Path $carried "$stem.manifest.json.sigstore.json") -Value '{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}'

function Invoke-Setup([string]$mode, [string]$at = $root, [string]$from = $carried, [string]$version = $Version, [string[]]$more = @()) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $lines = @(& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $wrapper -Mode $mode `
        -Version $version -Root $at -Bundle $from @more)
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  $values = @($lines | Where-Object { $_ -like "orca-setup: *" } | ForEach-Object { ConvertFrom-Json $_.Substring(12) })
  $lines | ForEach-Object { Write-Host "    $_" }
  return [pscustomobject]@{
    code = $code
    steps = @($values | Where-Object { $null -ne $_.PSObject.Properties["step"] })
    done = (@($values | Where-Object { $null -ne $_.PSObject.Properties["done"] }) | Select-Object -First 1)
    inspected = (@($values | Where-Object { $null -ne $_.PSObject.Properties["inspected"] }) | Select-Object -First 1)
  }
}

function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw "FAILED: $message" } }

function Get-Step($run, [string]$name) { return @($run.steps | Where-Object { $_.step -eq $name }) | Select-Object -Last 1 }

function Assert-Step($run, [string]$name, [string]$result, [string]$detail = "") {
  $step = Get-Step $run $name
  Assert ($null -ne $step) "no $name step"
  Assert ($step.result -eq $result) "$name is $($step.result), not $result ($($step.detail))"
  if ($detail) { Assert ($step.detail -match $detail) "$name says '$($step.detail)', not /$detail/" }
}

function Get-Task { Get-ScheduledTask -TaskPath "\ORCA\" -TaskName "orca-server" -ErrorAction SilentlyContinue }

function Get-Daemons([string]$under) {
  $releases = (Join-Path $under "releases") + "\"
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
      $_.ExecutablePath -and $_.ExecutablePath.StartsWith($releases, [StringComparison]::OrdinalIgnoreCase)
    })
}

function Stop-Daemon {
  Stop-ScheduledTask -TaskPath "\ORCA\" -TaskName "orca-server" -ErrorAction SilentlyContinue
  Get-Daemons $root | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-Sleep -Seconds 2
}

$case = 0
function Case([string]$title) { $script:case++; Write-Host "`n[$script:case] $title" }

try {
  Case "an archive entry outside its root is refused before anything is unpacked, and the run is put back"
  $evil = Join-Path $base "evil"
  $null = New-Item -ItemType Directory -Force $evil
  $evilStem = "orca-server-9.9.9-win-x64"
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zipPath = Join-Path $evil "$evilStem.zip"
  $zip = [IO.Compression.ZipFile]::Open($zipPath, [IO.Compression.ZipArchiveMode]::Create)
  try {
    $null = $zip.CreateEntry("$evilStem/")
    $writer = New-Object IO.StreamWriter($zip.CreateEntry("$evilStem/../escaped.txt").Open())
    $writer.Write("outside")
    $writer.Dispose()
  } finally {
    $zip.Dispose()
  }
  $manifest = [ordered]@{
    schema = "orca-server-bundle/1"; name = "orca-server"; version = "9.9.9"; platform = "win-x64"; root = $evilStem
    entry = "orca-daemon.mjs"; node = @{ path = "runtime/node.exe" }; sourceSha = ("0" * 40)
    archive = [ordered]@{ name = "$evilStem.zip"; sha256 = (Get-FileHash -Algorithm SHA256 $zipPath).Hash.ToLowerInvariant(); size = (Get-Item $zipPath).Length }
  }
  Set-Content -LiteralPath (Join-Path $evil "$evilStem.manifest.json") -Value (ConvertTo-Json -Depth 5 $manifest)
  Set-Content -LiteralPath (Join-Path $evil "$evilStem.manifest.json.sigstore.json") -Value "{}"
  $evilRoot = Join-Path $base "evil-root"
  $run = Invoke-Setup "trust" $evilRoot $evil "9.9.9"
  Assert ($run.code -eq 1) "exit $($run.code), not 1"
  Assert-Step $run "stage" "failed" "Bundle entry refused"
  Assert-Step $run "cleanup" "ok"
  Assert (-not (Get-ChildItem -Recurse -Force $base -Filter escaped.txt)) "an entry was written outside its root"
  Assert ($null -eq (Get-Task)) "a task was left behind"
  Assert (-not (Test-Path (Join-Path $evilRoot "deployment.json"))) "deployment.json was left behind"

  Case "a signature from no pinned signer is refused by the real pinned cosign, and the first install is put back"
  $run = Invoke-Setup "real"
  Assert ($run.code -eq 1) "exit $($run.code), not 1"
  Assert-Step $run "stage" "failed" "Bundle signature refused"
  Assert-Step $run "cleanup" "ok"
  Assert (Test-Path (Join-Path $root "tools\cosign-v3.1.4-windows-amd64.exe")) "the pinned cosign was not fetched"
  Assert (-not (Test-Path (Join-Path $root "current.txt"))) "current.txt was left behind"
  Assert (-not (Test-Path (Join-Path $root "releases\v$Version"))) "an unverified release was published"
  Assert (-not (Get-ChildItem -Force $root -Filter ".setup-stage-*")) "staging scratch was left behind"
  Assert ($null -eq (Get-Task)) "a task was left behind"

  Case "inspect changes nothing and names the account, the directory and a first install"
  $run = Invoke-Setup "trust" -more @("-Inspect")
  Assert ($run.code -eq 0) "exit $($run.code)"
  Assert ($run.inspected.root -eq $root -and $null -eq $run.inspected.current) "inspected $(ConvertTo-Json -Compress $run.inspected)"
  Assert ($run.inspected.account -eq [Security.Principal.WindowsIdentity]::GetCurrent().Name) "account $($run.inspected.account)"

  Case "a daemon that never turns healthy: the task, the selection and the files are put back, the verified release stays"
  $run = Invoke-Setup "fail-health"
  Assert ($run.code -eq 1) "exit $($run.code), not 1"
  Assert-Step $run "stage" "changed"
  Assert-Step $run "task" "changed"
  Assert-Step $run "start" "failed" "unhealthy"
  Assert-Step $run "cleanup" "ok"
  Assert ($null -eq (Get-Task)) "the task was left behind"
  Assert (-not (Test-Path (Join-Path $root "current.txt"))) "current.txt was left behind"
  Assert (-not (Test-Path (Join-Path $root "deployment.json"))) "deployment.json was left behind"
  Assert (Test-Path (Join-Path $root "releases\v$Version\runtime\node.exe")) "the verified release was removed"
  Assert ((Get-Daemons $root).Count -eq 0) "the daemon is still running"

  Case "a run cut off before its task: the next run puts back what it did, then finishes the setup"
  $run = Invoke-Setup "exit-at-task"
  Assert ($run.code -eq 9) "exit $($run.code), not 9"
  Assert (Test-Path (Join-Path $root ".setup-journal.json")) "no journal was left for the next run"
  $run = Invoke-Setup "trust"
  Assert ($run.code -eq 0) "exit $($run.code)"
  Assert-Step $run "recover" "repaired"
  Assert-Step $run "existing" "ok" "staged and verified"
  Assert-Step $run "stage" "ok"
  Assert-Step $run "select" "changed"
  Assert-Step $run "task" "changed" "at boot"
  Assert-Step $run "start" "changed" "healthy"
  Assert ($null -eq (Get-Step $run "boot")) "the task does not start at boot"
  Assert ($run.done.version -eq $Version -and $run.done.root -eq $root) "done $(ConvertTo-Json -Compress $run.done)"
  Assert (-not (Test-Path (Join-Path $root ".setup-journal.json"))) "the journal was not retired"
  $task = Get-Task
  Assert ($task.Principal.LogonType -eq "S4U") "the task logs on as $($task.Principal.LogonType)"
  Assert ([string]$task.State -eq "Running") "the task is $($task.State)"
  $said = & (Join-Path $root "orca.cmd") --version
  Assert ($LASTEXITCODE -eq 0 -and "$said".Trim() -eq $Version) "orca.cmd --version says $said"

  Case "a second run verifies and changes nothing"
  $run = Invoke-Setup "trust"
  Assert ($run.code -eq 0) "exit $($run.code)"
  foreach ($name in @("files", "existing", "stage", "select", "task", "start")) { Assert-Step $run $name "ok" }

  Case "a stopped daemon is started again"
  Stop-Daemon
  $run = Invoke-Setup "trust"
  Assert ($run.code -eq 0) "exit $($run.code)"
  Assert-Step $run "start" "repaired" "healthy"

  Case "a failed repair registers the managed task back as it was, still this setup's, still running"
  $xml = [string](Export-ScheduledTask -TaskPath "\ORCA\" -TaskName "orca-server")
  # Same owner, identity and trigger, another action (cmd.exe by name, not by its full path):
  # a repair registers it again.
  $drifted = $xml -replace '<Command>[^<]*</Command>', '<Command>cmd.exe</Command>'
  Assert ($drifted -ne $xml) "the task has no command to change"
  $null = Register-ScheduledTask -TaskPath "\ORCA\" -TaskName "orca-server" -Xml $drifted -Force
  $run = Invoke-Setup "fail-health"
  Assert ($run.code -eq 1) "exit $($run.code), not 1"
  Assert-Step $run "task" "changed"
  Assert-Step $run "cleanup" "ok"
  $restored = Get-Task
  Assert ($restored.Actions[0].Execute -eq "cmd.exe") "the task was not put back as it was: $($restored.Actions[0].Execute)"
  Assert ([string]$restored.Description -like "orca-server-setup:*") "the restored task lost its owner: $($restored.Description)"
  Assert ([string]$restored.State -eq "Running") "the restored task is $($restored.State)"
  $run = Invoke-Setup "trust" -more @("-Inspect")
  Assert ($run.code -eq 0) "inspect after the rollback exits $($run.code)"
  $run = Invoke-Setup "trust"
  Assert ($run.code -eq 0) "exit $($run.code)"
  Assert-Step $run "task" "changed"
  Assert ((Get-Step $run "start").detail -match "healthy") "the repaired task's daemon is not healthy"
  Assert ((Get-Task).Actions[0].Execute -ne "cmd.exe") "the repair did not register the task again"

  Case "a managed task whose privilege changed is refused, not reused, with the same action and description"
  $xml = [string](Export-ScheduledTask -TaskPath "\ORCA\" -TaskName "orca-server")
  $task = Get-Task
  $task.Principal.RunLevel = "Highest"
  $null = Register-ScheduledTask -TaskPath "\ORCA\" -TaskName "orca-server" -InputObject $task -Force
  try {
    Assert ([string](Get-Task).Principal.RunLevel -eq "Highest") "the test could not raise the task's privilege"
    $run = Invoke-Setup "trust"
    Assert ($run.code -eq 2) "exit $($run.code), not 2"
    Assert-Step $run "existing" "refused" "Highest privileges"
    Assert ([string](Get-Task).Principal.RunLevel -eq "Highest") "the refused task was changed"
  } finally {
    $null = Register-ScheduledTask -TaskPath "\ORCA\" -TaskName "orca-server" -Xml $xml -Force
  }

  Case "a setup directory reached through a junction is refused before anything there or its task is touched"
  $snapshot = {
    $files = Get-ChildItem -LiteralPath $root -Force -File | Sort-Object Name | ForEach-Object { "$($_.Name)=$((Get-FileHash -Algorithm SHA256 $_.FullName).Hash)" }
    ($files -join ";") + "|" + [string](Export-ScheduledTask -TaskPath "\ORCA\" -TaskName "orca-server")
  }
  $before = & $snapshot
  # The directory itself a junction to the managed one, marker and all; and a junction above it.
  $linked = Join-Path $base "linked-root"
  $null = New-Item -ItemType Junction -Path $linked -Target $root
  $above = Join-Path $base "linked-parent"
  $null = New-Item -ItemType Junction -Path $above -Target $base
  try {
    foreach ($at in @($linked, (Join-Path $above "orca-server"))) {
      foreach ($more in @(@(), @("-Inspect"))) {
        $run = Invoke-Setup "trust" $at -more $more
        Assert ($run.code -eq 2) "$at exits $($run.code), not 2"
        Assert-Step $run "inventory" "refused" "link or junction"
        Assert (@($run.steps | Where-Object { $_.step -in @("fence", "recover", "journal", "cleanup") }).Count -eq 0) "$at got past the inventory"
      }
    }
    Assert ((& $snapshot) -ceq $before) "the managed directory or its task changed"
    Assert ([string](Get-Task).State -eq "Running") "the daemon was stopped"
  } finally {
    cmd /c rmdir "$linked"
    cmd /c rmdir "$above"
  }
  Assert (Test-Path (Join-Path $root "current.txt")) "removing the junctions removed what they led to"

  Case "a setup confirmed as a first install refuses a repair, and changes nothing"
  $run = Invoke-Setup "trust" -more @("-ExpectCurrent", "none")
  Assert ($run.code -eq 2) "exit $($run.code), not 2"
  Assert (@($run.steps | Where-Object { $_.result -eq "refused" }).Count -eq 1) "nothing was refused"
  Assert ($null -eq (Get-Step $run "cleanup")) "a refusal before any change still cleaned up"
  Assert ([string](Get-Task).State -eq "Running") "the daemon was stopped"

  Case "a release changed since it was staged is refused, never started"
  $inside = Join-Path $root "releases\v$Version\orca-server.json"
  $original = [IO.File]::ReadAllText($inside)
  [IO.File]::AppendAllText($inside, " ")
  $run = Invoke-Setup "trust"
  Assert ($run.code -eq 2) "exit $($run.code), not 2"
  Assert-Step $run "existing" "refused" "changed since this setup staged"
  [IO.File]::WriteAllText($inside, $original)

  Case "a scheduled task for ORCA this setup did not make is refused"
  $action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c exit 0"
  $null = Register-ScheduledTask -TaskName "orca-by-hand" -Action $action -Force
  try {
    $run = Invoke-Setup "trust"
    Assert ($run.code -eq 2) "exit $($run.code), not 2"
    Assert-Step $run "inventory" "refused" "orca-by-hand"
  } finally {
    Unregister-ScheduledTask -TaskName "orca-by-hand" -Confirm:$false
  }

  Case "with everything back, the setup verifies again"
  $run = Invoke-Setup "trust"
  Assert ($run.code -eq 0) "exit $($run.code)"
  Assert-Step $run "existing" "ok" "selected and verified"
  Write-Host "`nall $case cases passed"
} finally {
  Stop-Daemon
  Unregister-ScheduledTask -TaskPath "\ORCA\" -TaskName "orca-server" -Confirm:$false -ErrorAction SilentlyContinue
}
