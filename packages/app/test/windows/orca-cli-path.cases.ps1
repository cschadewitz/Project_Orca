# The Windows installer's PATH edit (#1207), packages/app/build/win/orca-cli-path.ps1, run
# against the real HKCU\Environment\Path on a throwaway Windows runner (desktop.yml). Each case
# sets the user PATH to a starting value and type, runs add and then remove, and checks the
# unexpanded value and its registry type after each. The runner's own PATH and the script's
# ownership record are put back afterwards, whatever happens.
#
# Usage: pwsh -File orca-cli-path.cases.ps1 -Script <path to orca-cli-path.ps1>
param([Parameter(Mandatory = $true)][string]$Script)
$ErrorActionPreference = 'Stop'

$String = [Microsoft.Win32.RegistryValueKind]::String
$Expand = [Microsoft.Win32.RegistryValueKind]::ExpandString
$record = 'Software\ORCA\orca-cli-path'
$dir = 'C:\Users\o''brien\AppData\Local\Programs\ORCA\resources\bin'
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')

function State {
    if ($key.GetValueNames() -notcontains 'Path') { return 'absent' }
    $value = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    return "$($key.GetValueKind('Path')):$value"
}
function Set-Start($start) {
    if ($null -eq $start) { if ($key.GetValueNames() -contains 'Path') { $key.DeleteValue('Path') } }
    else { $key.SetValue('Path', $start.Value, $start.Kind) }
}
function Run([string]$action, [string]$directory = $dir) {
    & pwsh -NoLogo -NoProfile -NonInteractive -File $Script -Action $action -Directory $directory | Write-Host
    if ($LASTEXITCODE -ne 0) { throw "$action exited $LASTEXITCODE" }
}
function Expect([string]$what, [string]$actual, [string]$expected) {
    if ($actual -cne $expected) { throw "${what}: '$actual', expected '$expected'" }
    Write-Host "ok  $what = $actual"
}
function Owned { $null -ne [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($record) }

$saved = if ($key.GetValueNames() -contains 'Path') {
    @{ Kind = $key.GetValueKind('Path'); Value = $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames') }
} else { $null }
$savedRecord = Owned
if ($savedRecord) { throw "an orca-cli PATH record is already present; this runner is not fresh" }

try {
    $cases = @(
        @{ Name = 'no Path value'; Start = $null; Added = "ExpandString:$dir" },
        @{ Name = 'an empty REG_SZ value'; Start = @{ Kind = $String; Value = '' }; Added = "String:$dir" },
        @{ Name = 'unexpanded entries and a trailing empty segment'
           Start = @{ Kind = $Expand; Value = '%USERPROFILE%\bin;;C:\tools;' }
           Added = "ExpandString:%USERPROFILE%\bin;;C:\tools;$dir" },
        @{ Name = 'a REG_SZ value'; Start = @{ Kind = $String; Value = 'C:\tools' }; Added = "String:C:\tools;$dir" }
    )
    foreach ($case in $cases) {
        Set-Start $case.Start
        $before = State
        Run 'add'
        Expect "$($case.Name), after add" (State) $case.Added
        if (-not (Owned)) { throw "$($case.Name): add recorded no ownership" }
        # Add again, as a reinstall or update does: nothing changes.
        Run 'add'
        Expect "$($case.Name), after a second add" (State) $case.Added
        Run 'remove'
        Expect "$($case.Name), after remove" (State) $before
        if (Owned) { throw "$($case.Name): remove left its record" }
    }

    # An entry the user already had is theirs: add leaves it, and remove does not take it off.
    foreach ($existing in @($dir, "$dir\", $dir.ToUpperInvariant())) {
        Set-Start @{ Kind = $Expand; Value = "C:\tools;$existing;%SystemRoot%" }
        $before = State
        Run 'add'
        Expect "pre-existing '$existing', after add" (State) $before
        if (Owned) { throw "pre-existing '$existing': add claimed an entry it did not add" }
        Run 'remove'
        Expect "pre-existing '$existing', after remove" (State) $before
    }

    # Edited after install: only the added entry comes off, the user's change stays.
    Set-Start @{ Kind = $Expand; Value = 'C:\tools' }
    Run 'add'
    $key.SetValue('Path', "C:\first;C:\tools;$dir;C:\later", $Expand)
    Run 'remove'
    Expect 'edited since install, after remove' (State) 'ExpandString:C:\first;C:\tools;C:\later'

    # Removed by the user already: remove changes nothing and drops its record.
    Set-Start @{ Kind = $Expand; Value = 'C:\tools' }
    Run 'add'
    $key.SetValue('Path', 'C:\tools;C:\mine', $Expand)
    Run 'remove'
    Expect 'already removed by the user, after remove' (State) 'ExpandString:C:\tools;C:\mine'
    if (Owned) { throw "remove left its record after the user removed the entry" }

    # Installed elsewhere next: the earlier install's entry moves to the new directory.
    Set-Start @{ Kind = $Expand; Value = 'C:\tools' }
    Run 'add' 'D:\Old\ORCA\resources\bin'
    Run 'add'
    Expect 'moved install, after add' (State) "ExpandString:C:\tools;$dir"
    Run 'remove'
    Expect 'moved install, after remove' (State) 'ExpandString:C:\tools'

    # Nothing recorded: remove is a no-op.
    Set-Start @{ Kind = $Expand; Value = "C:\tools;$dir" }
    Run 'remove'
    Expect 'nothing recorded, after remove' (State) "ExpandString:C:\tools;$dir"

    # A type it will not rewrite: refused with exit 3, value untouched.
    $key.SetValue('Path', [byte[]](1, 2), [Microsoft.Win32.RegistryValueKind]::Binary)
    & pwsh -NoLogo -NoProfile -NonInteractive -File $Script -Action add -Directory $dir | Write-Host
    if ($LASTEXITCODE -ne 3) { throw "a REG_BINARY Path: add exited $LASTEXITCODE, expected 3" }
    if ($key.GetValueKind('Path') -ne [Microsoft.Win32.RegistryValueKind]::Binary) { throw "a REG_BINARY Path was rewritten" }
    Write-Host "ok  a REG_BINARY Path is refused and left alone"
} finally {
    Set-Start $saved
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($record, $false)
    $key.Close()
}
Write-Host "all orca-cli PATH cases passed"
