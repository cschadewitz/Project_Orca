<#
The setup's own download policy (#1238), Invoke-OrcaDownload, without a live release:

  powershell -NoProfile -ExecutionPolicy Bypass -File download.ps1

The setup's one network seam, Open-OrcaResponse (a single request, no redirect followed), is
replaced by scripted responses and streams. Everything else, every redirect, the HTTPS rule, the
size bound, the one deadline over the whole download and the cleanup of a failed one, runs as
shipped. Also checks that no message shows a redirect's signed query. Exits non-zero on the first
check that fails.
#>
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "..\..\orca-server-setup.ps1")
$base = Join-Path ([IO.Path]::GetTempPath()) ("orca-download-test-" + [guid]::NewGuid().ToString("n").Substring(0, 8))
$null = New-Item -ItemType Directory -Force $base
$secret = "X-Amz-Signature=not-for-logs"
$start = "https://github.com/owner/repo/releases/download/v1.0.0/asset.zip"
$signed = "https://objects.example.test/asset.zip?$secret"

function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw "FAILED: $message" } }

function Get-Failure([scriptblock]$run) {
  try { & $run; return "" } catch { return [string]$_.Exception.Message }
}

function Assert-Failure([string]$message, [string]$expected, [string]$target) {
  Write-Host "    $message"
  Assert ($message -like "*$expected*") "expected a failure naming '$expected', got '$message'"
  Assert (-not $message.Contains("Signature")) "the message shows a signed query: $message"
  if ($target) { Assert (-not (Test-Path -LiteralPath $target)) "a failed download left $target behind" }
}

$checks = 0
function Check([string]$title) { $script:checks++; Write-Host "  - $title" }

function New-Target { return Join-Path $base ([guid]::NewGuid().ToString("n")) }

try {
  Check "a request that never reaches a server names only where it went"
  $message = Get-Failure { Invoke-OrcaDownload "https://orca-setup-test.invalid/asset.zip?$secret" (New-Target) 1MB 30 }
  Assert-Failure $message "Download failed" ""
  Assert ($message -like "*https://orca-setup-test.invalid/asset.zip") "the message names the address without its query: $message"

  # From here on the network is scripted: $script:serve answers each request.
  $script:hops = New-Object Collections.ArrayList
  $script:responses = New-Object Collections.ArrayList
  function Open-OrcaResponse([string]$url, [int]$timeout, [string]$accept) {
    $null = $script:hops.Add([pscustomobject]@{ url = $url; timeout = $timeout })
    $response = & $script:serve $url
    $null = $script:responses.Add($response)
    return $response
  }
  function New-Response([int]$code, [string]$location = "", $stream = $null) {
    $response = [pscustomobject]@{ StatusCode = $code; Headers = @{ Location = $location }; Stream = $stream; Disposed = $false }
    $response | Add-Member ScriptMethod GetResponseStream { return $this.Stream }
    $response | Add-Member ScriptMethod Dispose { $this.Disposed = $true }
    return $response
  }
  function New-Bytes([int]$count) { return New-Object IO.MemoryStream (, [byte[]](@(65) * $count)) }
  # A stream that gives one byte every $pause milliseconds, and honours its ReadTimeout as a
  # network stream does: a read that would wait longer fails once the timeout has passed.
  function New-SlowStream([int]$pause) {
    $stream = [pscustomobject]@{ CanTimeout = $true; ReadTimeout = -1; Pause = $pause; Timeouts = (New-Object Collections.ArrayList) }
    $stream | Add-Member ScriptMethod Read {
      param($buffer, $offset, $count)
      $null = $this.Timeouts.Add($this.ReadTimeout)
      if ($this.ReadTimeout -lt $this.Pause) {
        Start-Sleep -Milliseconds ($this.ReadTimeout + 20)
        throw (New-Object IO.IOException "The operation has timed out.")
      }
      Start-Sleep -Milliseconds $this.Pause
      $buffer[$offset] = 65
      return 1
    }
    return $stream
  }
  function Reset-Network([scriptblock]$serve) {
    $script:hops.Clear(); $script:responses.Clear(); $script:serve = $serve
  }
  function Assert-Disposed {
    foreach ($response in $script:responses) { Assert $response.Disposed "a response was left open" }
  }

  Check "a redirect to a signed HTTPS address is followed and the file written"
  Reset-Network { param($url) if ($url -eq $start) { New-Response 302 $signed } else { New-Response 200 "" (New-Bytes 5) } }
  $target = New-Target
  Invoke-OrcaDownload $start $target 1MB 30
  Assert ((Get-Item -LiteralPath $target).Length -eq 5) "the downloaded file has 5 bytes"
  Assert ($script:hops.Count -eq 2 -and $script:hops[1].url -eq $signed) "the redirect was followed to its exact address"
  Assert-Disposed

  Check "a redirect to plain HTTP is refused, without showing its query"
  Reset-Network { param($url) New-Response 302 ($signed -replace "^https:", "http:") }
  $target = New-Target
  Assert-Failure (Get-Failure { Invoke-OrcaDownload $start $target 1MB 30 }) "must use HTTPS: http://objects.example.test/asset.zip" $target
  Assert ($script:hops.Count -eq 1) "the HTTP address was never requested"
  Assert-Disposed

  Check "an error status at a signed address names the address without its query"
  Reset-Network { param($url) if ($url -eq $start) { New-Response 302 $signed } else { New-Response 403 } }
  $target = New-Target
  Assert-Failure (Get-Failure { Invoke-OrcaDownload $start $target 1MB 30 }) "HTTP 403: https://objects.example.test/asset.zip" $target
  Assert-Disposed

  Check "a redirect without a Location is refused"
  Reset-Network { param($url) New-Response 302 }
  Assert-Failure (Get-Failure { Invoke-OrcaDownload $start (New-Target) 1MB 30 }) "redirected nowhere" ""

  Check "redirects stop after 10 requests"
  Reset-Network { param($url) New-Response 302 $signed }
  Assert-Failure (Get-Failure { Invoke-OrcaDownload $start (New-Target) 1MB 30 }) "redirected too often" ""
  Assert ($script:hops.Count -eq 10) "10 requests, not $($script:hops.Count)"
  Assert-Disposed

  Check "a file over its size bound is refused and removed"
  Reset-Network { param($url) New-Response 200 "" (New-Bytes 2048) }
  $target = New-Target
  Assert-Failure (Get-Failure { Invoke-OrcaDownload $start $target 1024 30 }) "exceeds 1024 bytes" $target

  Check "a file that already exists is never written over"
  Reset-Network { param($url) New-Response 200 "" (New-Bytes 5) }
  $target = New-Target
  Set-Content -LiteralPath $target -Value "kept"
  $message = Get-Failure { Invoke-OrcaDownload $start $target 1MB 30 }
  Assert ($message -ne "") "the download failed"
  Assert ((Get-Content -LiteralPath $target) -eq "kept") "the existing file is untouched"
  Assert-Disposed

  Check "a server that keeps trickling bytes is cut off at the deadline, and the partial file removed"
  $trickle = New-SlowStream 300
  Reset-Network { param($url) New-Response 200 "" $trickle }
  $target = New-Target
  $clock = [Diagnostics.Stopwatch]::StartNew()
  Assert-Failure (Get-Failure { Invoke-OrcaDownload $start $target 1MB 2 }) "did not finish within 2 seconds" $target
  Assert ($clock.ElapsedMilliseconds -lt 3500) "cut off after $($clock.ElapsedMilliseconds) ms, not near 2 s"
  Assert ($trickle.Timeouts.Count -gt 3) "the server was read until the deadline"
  foreach ($timeout in $trickle.Timeouts) { Assert ($timeout -gt 0 -and $timeout -le 2000) "a read waited up to $timeout ms" }
  Assert-Disposed

  Check "a server that stops sending is cut off at the deadline, not after its own timeout"
  $stalled = New-SlowStream 600000
  Reset-Network { param($url) New-Response 200 "" $stalled }
  $target = New-Target
  $clock = [Diagnostics.Stopwatch]::StartNew()
  Assert-Failure (Get-Failure { Invoke-OrcaDownload $start $target 1MB 2 }) "did not finish within 2 seconds" $target
  Assert ($clock.ElapsedMilliseconds -lt 3500) "cut off after $($clock.ElapsedMilliseconds) ms, not near 2 s"
  Assert-Disposed

  Check "slow redirects count against the same deadline, and each request waits only what is left"
  Reset-Network { param($url) Start-Sleep -Milliseconds 700; New-Response 302 $signed }
  $clock = [Diagnostics.Stopwatch]::StartNew()
  Assert-Failure (Get-Failure { Invoke-OrcaDownload $start (New-Target) 1MB 2 }) "did not finish within 2 seconds" ""
  Assert ($clock.ElapsedMilliseconds -lt 3500) "cut off after $($clock.ElapsedMilliseconds) ms, not near 2 s"
  Assert ($script:hops.Count -lt 10) "the deadline, not the redirect limit, ended it"
  Assert ($script:hops[0].timeout -le 2000) "the first request may wait $($script:hops[0].timeout) ms"
  for ($i = 1; $i -lt $script:hops.Count; $i++) {
    Assert ($script:hops[$i].timeout -lt $script:hops[$i - 1].timeout) "request $i may wait as long as the one before"
  }
  Assert-Disposed

  Write-Host "  all $checks download checks passed"
} catch {
  Write-Host $_.Exception.Message
  exit 1
} finally {
  Remove-Item -LiteralPath $base -Recurse -Force -ErrorAction SilentlyContinue
}
exit 0
