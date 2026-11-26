; ORCA's additions to electron-builder's NSIS installer (#1207). electron-builder includes this
; file (nsis.include in electron-builder.yml) and inserts the macros below at the end of its
; install section and at the start of its uninstall section, before any file is removed.
;
; It also removes the updater's cache on a real uninstall (#1109): the installer keeps a copy of
; itself under %LOCALAPPDATA%\@orcaapp-updater for differential updates, and the updater keeps
; its pending download beside it, but electron-builder's uninstaller never removed that folder,
; so a full installer stayed behind. The name is electron-builder's `updaterCacheDirName`:
; package.json's name, `@orca/app`, sanitized to `@orcaapp`, plus `-updater`
; (test/windows-uninstall-cache.test.ts holds the two together).
;
; The installer puts the CLI launcher's directory, resources\bin under the install directory
; (it holds orca-cli.cmd and nothing else), on the PATH of the user who ran it, and the
; uninstaller takes exactly that entry off again. The edit itself is
; resources\installer\orca-cli-path.ps1 (build\win\orca-cli-path.ps1), which says why it is not
; done in NSIS. A failure is reported in the installer's details and does not fail the install:
; ORCA works without it, and the CLI stays runnable by its full path (docs/MULTI-MACHINE.md).

!macro orcaCliPath ACTION
  ; $0 is saved and restored around the result, so the surrounding sections keep theirs.
  Push $0
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\installer\orca-cli-path.ps1" -Action ${ACTION} -Directory "$INSTDIR\resources\bin"'
  Pop $0
  ${if} $0 == 0
    ; Open terminals keep the environment they started with; new ones read the change once
    ; Explorer has seen this broadcast.
    SendMessage 0xFFFF 0x1A 0 "STR:Environment" /TIMEOUT=5000
  ${else}
    DetailPrint "orca-cli: the user PATH was not changed ($0). Run $INSTDIR\resources\bin\orca-cli.cmd by its full path."
  ${endIf}
  Pop $0
!macroend

!macro customInstall
  !insertmacro orcaCliPath "add"
!macroend

!macro customUnInstall
  ; An update runs the old version's uninstaller with --updated, and the new installer adds the
  ; same entry back, so an update leaves the PATH alone.
  ; The updater's cache is what the next differential update starts from, so it stays then too.
  ${ifNot} ${isUpdated}
    !insertmacro orcaCliPath "remove"
    SetShellVarContext current
    RMDir /r "$LOCALAPPDATA\@orcaapp-updater"
  ${endIf}
!macroend
