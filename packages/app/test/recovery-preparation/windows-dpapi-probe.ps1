# Synthetic CurrentUser DPAPI only; no Electron/key-store/account or permission changes.
param(
  [ValidateSet('run', 'protect', 'restart', 'tamper', 'entropy', 'park')]
  [string]$Mode = 'run',
  [string]$Directory
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security.Cryptography.ProtectedData
$orcaPlaintext = [byte[]](0..31 | ForEach-Object { [byte]($_ + 17) })
$orcaEntropy = [Text.Encoding]::UTF8.GetBytes('ORCA-synthetic-DPAPI-probe-v1')
$orcaScope = [Security.Cryptography.DataProtectionScope]::CurrentUser
if ($Mode -ne 'run') {
  if ([IO.Path]::GetFileName($Directory) -notlike 'orca-dpapi-*' -or
      [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Directory)) -ne [IO.Path]::GetTempPath().TrimEnd('\')) {
    throw 'Disposable probe directory required'
  }
  $orcaWrapperPath = Join-Path $Directory 'wrapper.bin'
  if ($Mode -in @('protect', 'park')) {
    $orcaWrapped = [Security.Cryptography.ProtectedData]::Protect($orcaPlaintext, $orcaEntropy, $orcaScope)
    if ($orcaWrapped.Length -le $orcaPlaintext.Length) { throw 'Protection failed' }
    [IO.File]::WriteAllBytes($orcaWrapperPath, $orcaWrapped)
    if ($Mode -eq 'park') {
      [IO.File]::WriteAllText((Join-Path $Directory 'ready'), 'synthetic-ready')
      Start-Sleep -Seconds 15
    }
  } else {
    $orcaWrapped = [IO.File]::ReadAllBytes($orcaWrapperPath)
    if ($Mode -eq 'tamper') { $orcaWrapped[[Math]::Floor($orcaWrapped.Length / 2)] = $orcaWrapped[[Math]::Floor($orcaWrapped.Length / 2)] -bxor 1 }
    if ($Mode -eq 'entropy') { $orcaEntropy = [Text.Encoding]::UTF8.GetBytes('ORCA-wrong-synthetic-entropy') }
    $orcaRefused = $false
    try { $orcaRecovered = [Security.Cryptography.ProtectedData]::Unprotect($orcaWrapped, $orcaEntropy, $orcaScope) }
    catch [Security.Cryptography.CryptographicException] { $orcaRefused = $true }
    if ($Mode -eq 'restart') {
      if ($orcaRefused -or ![Linq.Enumerable]::SequenceEqual[byte]($orcaPlaintext, $orcaRecovered)) { throw 'Restart recovery failed' }
    } elseif (!$orcaRefused) { throw 'Invalid wrapper was accepted' }
  }
  exit 0
}
$orcaTemporary = [IO.Path]::GetTempPath()
$orcaOwned = Join-Path $orcaTemporary ('orca-dpapi-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($orcaOwned) | Out-Null
$orcaChildren = [Collections.Generic.List[Diagnostics.Process]]::new()
function Start-OrcaProbeChild([string]$ChildMode) {
  $orcaInfo = [Diagnostics.ProcessStartInfo]::new((Get-Process -Id $PID).Path)
  $orcaInfo.UseShellExecute = $false
  $orcaInfo.CreateNoWindow = $true
  $orcaInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
  foreach ($orcaArgument in @('-NoProfile', '-NonInteractive', '-File', $PSCommandPath, '-Mode', $ChildMode, '-Directory', $orcaOwned)) {
    $orcaInfo.ArgumentList.Add($orcaArgument)
  }
  $orcaInfo.RedirectStandardOutput = $true
  $orcaInfo.RedirectStandardError = $true
  $orcaChild = [Diagnostics.Process]::Start($orcaInfo)
  $orcaChildren.Add($orcaChild)
  return $orcaChild
}
function Complete-OrcaProbeChild([string]$ChildMode) {
  $orcaChild = Start-OrcaProbeChild $ChildMode
  if (!$orcaChild.WaitForExit(10000)) { $orcaChild.Kill($true); throw 'Synthetic child deadline exceeded' }
  if ($orcaChild.ExitCode -ne 0) { throw "Synthetic $ChildMode child failed" }
}
try {
  Complete-OrcaProbeChild 'protect'
  Complete-OrcaProbeChild 'restart'
  Complete-OrcaProbeChild 'restart'
  Complete-OrcaProbeChild 'tamper'
  Complete-OrcaProbeChild 'entropy'
  $orcaParked = Start-OrcaProbeChild 'park'
  $orcaDeadline = [DateTime]::UtcNow.AddSeconds(10)
  while (!(Test-Path -LiteralPath (Join-Path $orcaOwned 'ready'))) {
    if ([DateTime]::UtcNow -ge $orcaDeadline -or $orcaParked.HasExited) { throw 'Synthetic commit barrier failed' }
    Start-Sleep -Milliseconds 20
  }
  $orcaParked.Kill($true)
  if (!$orcaParked.WaitForExit(5000)) { throw 'Synthetic writer cessation unconfirmed' }
  Complete-OrcaProbeChild 'restart'
  [ordered]@{
    platform = 'win32'; osVersion = [Environment]::OSVersion.Version.ToString(); backend = 'System.Security.Cryptography.ProtectedData / CurrentUser DPAPI';
    syntheticBytes = 32; separateProcessRestart = $true; secondRestart = $true;
    tamperRefused = $true; wrongEntropyRefused = $true; supervisedWriterTerminated = $true; committedWrapperSurvivesProcessTermination = $true;
    differentUserRefusal = 'not run'; ElectronAsyncSafeStorage = 'not run'; diagnosticsRecovery = 'not exercised';
    method = 'Bounded hidden PowerShell children, synthetic bytes/entropy, disposable temp wrapper. No account identity, plaintext, ciphertext, paths, boot identity or errors retained. No power-loss, native diagnostics storage, inherited DACL or two-account proof.'
  } | ConvertTo-Json -Depth 3 -Compress
} finally {
  foreach ($orcaChild in $orcaChildren) {
    if (!$orcaChild.HasExited) { $orcaChild.Kill($true); $orcaChild.WaitForExit(5000) | Out-Null }
    $orcaChild.Dispose()
  }
  $orcaResolved = [IO.Path]::GetFullPath($orcaOwned)
  if ([IO.Path]::GetDirectoryName($orcaResolved) -ne $orcaTemporary.TrimEnd('\') -or [IO.Path]::GetFileName($orcaResolved) -notlike 'orca-dpapi-*') { throw 'Cleanup target refused' }
  Remove-Item -LiteralPath $orcaResolved -Recurse -Force
}
