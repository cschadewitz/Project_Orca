# Puts the orca-cli launcher's directory on the user PATH, or takes it off again (#1207). The
# NSIS installer runs this from build/installer.nsh as `-File <this> -Action add|remove
# -Directory <install>\resources\bin`, as the user who ran the installer.
#
# The user PATH is HKCU\Environment\Path. It is read and written whole through .NET's registry
# API rather than by NSIS string handling, because:
#   - an NSIS string is a fixed-size buffer, and a truncated write would cut the PATH short;
#   - it is read without expanding %VARIABLES%, so entries like %USERPROFILE%\bin stay that way;
#   - the value keeps its registry type (REG_EXPAND_SZ or REG_SZ).
# Every other entry, including empty ones, and their order are written back unchanged. Only an
# entry equal to -Directory (ignoring case and a trailing backslash) is ever added or removed.
#
# Exit codes: 0 done or nothing to do, 3 the PATH has a type this will not rewrite, anything
# else an error. The installer reports a non-zero exit and carries on.
param(
    [Parameter(Mandatory = $true)][ValidateSet('add', 'remove')][string]$Action,
    [Parameter(Mandatory = $true)][string]$Directory
)
$ErrorActionPreference = 'Stop'

$dir = $Directory.TrimEnd('\')
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
    if ($key.GetValueNames() -contains 'Path') {
        $kind = $key.GetValueKind('Path')
        if ($kind -ne [Microsoft.Win32.RegistryValueKind]::String -and
            $kind -ne [Microsoft.Win32.RegistryValueKind]::ExpandString) {
            Write-Output "The user PATH is a $kind value, so it was left unchanged."
            exit 3
        }
        $value = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    } else {
        $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
        $value = ''
    }

    # -ne on strings ignores case, as Windows paths do.
    $entries = @($value.Split(';'))
    $others = @($entries | Where-Object { $_.TrimEnd('\') -ne $dir })
    $present = $others.Count -ne $entries.Count

    if ($Action -eq 'add') {
        if ($present) {
            Write-Output "$dir is already on the user PATH."
        } else {
            if ($value -eq '') { $next = $dir }
            elseif ($value.EndsWith(';')) { $next = $value + $dir }
            else { $next = $value + ';' + $dir }
            $key.SetValue('Path', $next, $kind)
            Write-Output "Added $dir to the user PATH."
        }
    } elseif ($present) {
        $next = $others -join ';'
        if ($next -eq '') { $key.DeleteValue('Path') } else { $key.SetValue('Path', $next, $kind) }
        Write-Output "Removed $dir from the user PATH."
    }
} finally {
    $key.Close()
}
