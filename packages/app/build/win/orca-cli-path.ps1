# Puts the orca-cli launcher's directory on the user PATH, or takes it off again (#1207). The
# NSIS installer runs this from build/installer.nsh as `-File <this> -Action add|remove
# -Directory <install>\resources\bin`, as the user who ran the installer.
#
# The user PATH is HKCU\Environment\Path. It is read and written whole through .NET's registry
# API rather than by NSIS string handling, because:
#   - an NSIS string is a fixed-size buffer, and a truncated write would cut the PATH short;
#   - it is read without expanding %VARIABLES%, so entries like %USERPROFILE%\bin stay that way;
#   - the value keeps its registry type (REG_EXPAND_SZ or REG_SZ).
#
# Only what this script added is ever removed. `add` appends the directory only when no entry
# already names it, and then records, under HKCU\Software\ORCA\orca-cli-path, the directory, the
# exact text it appended and whether the Path value existed before. `remove` does nothing
# without that record. With it, when the PATH still ends in the appended text, it cuts exactly
# that text off, which gives back the value as it was byte for byte: empty segments, a trailing
# `;`, an existing empty value. If the PATH was edited since, it removes the one entry it added
# and leaves the rest as it is now. A Path value the script created and left empty is deleted
# again. The record survives an update (the uninstaller skips `remove` on one, and the key is
# outside the install directory), so the entry stays the install's own across versions.
#
# Exit codes: 0 done or nothing to do, 3 the PATH has a type this will not rewrite, anything
# else an error. The installer reports a non-zero exit and carries on.
param(
    [Parameter(Mandatory = $true)][ValidateSet('add', 'remove')][string]$Action,
    [Parameter(Mandatory = $true)][string]$Directory
)
$ErrorActionPreference = 'Stop'

$recordPath = 'Software\ORCA\orca-cli-path'
$dir = $Directory.TrimEnd('\')

function Read-UserPath($key) {
    if ($key.GetValueNames() -notcontains 'Path') {
        return @{ Exists = $false; Kind = [Microsoft.Win32.RegistryValueKind]::ExpandString; Value = '' }
    }
    $kind = $key.GetValueKind('Path')
    if ($kind -ne [Microsoft.Win32.RegistryValueKind]::String -and
        $kind -ne [Microsoft.Win32.RegistryValueKind]::ExpandString) {
        Write-Output "The user PATH is a $kind value, so it was left unchanged."
        exit 3
    }
    $value = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    return @{ Exists = $true; Kind = $kind; Value = $value }
}

function Read-Record {
    $record = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($recordPath)
    if ($null -eq $record) { return $null }
    try {
        return @{
            Directory = [string]$record.GetValue('Directory', '')
            Appended  = [string]$record.GetValue('Appended', '')
            Created   = [int]$record.GetValue('Created', 0) -eq 1
        }
    } finally { $record.Close() }
}

# -eq on strings ignores case, as Windows paths do; a trailing backslash names the same directory.
function Test-SameEntry([string]$entry, [string]$target) { $entry.TrimEnd('\') -eq $target }

# Takes the install's own entry back off. Returns the new value, or $null when nothing changed.
function Remove-Owned([string]$value, $record) {
    $appended = $record.Appended
    if ($appended -ne '' -and $value.EndsWith($appended, [StringComparison]::Ordinal)) {
        $rest = $value.Substring(0, $value.Length - $appended.Length)
        # Appended without a separator only to an empty value or one already ending in `;`.
        if ($appended.StartsWith(';') -or $rest -eq '' -or $rest.EndsWith(';')) { return $rest }
    }
    # Edited since: drop the one entry it added (the last that names the directory).
    $entries = [System.Collections.Generic.List[string]]::new([string[]]$value.Split(';'))
    for ($i = $entries.Count - 1; $i -ge 0; $i--) {
        if (Test-SameEntry $entries[$i] $record.Directory.TrimEnd('\')) {
            $entries.RemoveAt($i)
            return ($entries -join ';')
        }
    }
    return $null
}

function Write-UserPath($key, $path, [string]$next, [bool]$created) {
    if ($next -eq '' -and $created) {
        if ($key.GetValueNames() -contains 'Path') { $key.DeleteValue('Path') }
    } else {
        $key.SetValue('Path', $next, $path.Kind)
    }
}

$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
    $path = Read-UserPath $key
    $record = Read-Record

    # A record for another directory is an earlier install elsewhere: take its entry off first.
    if ($null -ne $record -and -not (Test-SameEntry $record.Directory $dir)) {
        $next = Remove-Owned $path.Value $record
        if ($null -ne $next) {
            Write-UserPath $key $path $next $record.Created
            Write-Output "Removed $($record.Directory) from the user PATH."
            $path = Read-UserPath $key
        }
        [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($recordPath, $false)
        $record = $null
    }

    $present = @($path.Value.Split(';') | Where-Object { Test-SameEntry $_ $dir }).Count -gt 0

    if ($Action -eq 'add') {
        if ($present) {
            if ($null -ne $record) { Write-Output "$dir is already on the user PATH, added by this install." }
            else { Write-Output "$dir is already on the user PATH, and was not added by this install: it stays yours." }
        } else {
            $value = $path.Value
            if ($value -eq '' -or $value.EndsWith(';')) { $appended = $Directory } else { $appended = ';' + $Directory }
            $key.SetValue('Path', $value + $appended, $path.Kind)
            $owned = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($recordPath)
            try {
                $owned.SetValue('Directory', $Directory, [Microsoft.Win32.RegistryValueKind]::String)
                $owned.SetValue('Appended', $appended, [Microsoft.Win32.RegistryValueKind]::String)
                $owned.SetValue('Created', [int](-not $path.Exists), [Microsoft.Win32.RegistryValueKind]::DWord)
            } finally { $owned.Close() }
            Write-Output "Added $Directory to the user PATH."
        }
    } elseif ($null -eq $record) {
        Write-Output "This install added nothing to the user PATH, so it was left unchanged."
    } else {
        $next = Remove-Owned $path.Value $record
        if ($null -ne $next) {
            Write-UserPath $key $path $next $record.Created
            Write-Output "Removed $dir from the user PATH."
        } else {
            Write-Output "$dir was no longer on the user PATH."
        }
        [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($recordPath, $false)
    }
} finally {
    $key.Close()
}
