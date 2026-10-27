# Windows: prerequisites, checking the download, install and launch

Part of the [Windows/Linux candidate guide](tester-guide.md). The steps are numbered
**P1–P9**, so a report can name the step where you stopped.

**Read this first.** The Windows installer for this candidate is **unsigned**. ORCA's
release documentation records that Windows shows a SmartScreen "unrecognized app"
warning on the unsigned installer, and browsers may warn about the download too. This
guide never asks you to click past either warning. So the expected result for most
Windows testers is to **stop at P1 or P4 and report what you saw**. That is a valid,
useful result, not a mistake on your part.

## Prerequisites

| Check | How | If it fails |
| --- | --- | --- |
| Your architecture is on the card | **Settings ▸ System ▸ About ▸ System type**: "x64-based processor" means x64; "ARM-based processor" means arm64 | Stop. Don't use the other architecture's file |
| Your Windows version is on the card's tested list | **Settings ▸ System ▸ About ▸ Windows specifications** | Ask your coordinator before continuing |
| You are signed in as yourself, as a standard user | You won't need administrator rights for anything here | — |
| Git for Windows 2.28 or newer is already installed | In PowerShell: `git --version` | Stop. Installing Git is your own decision and outside these instructions |
| ORCA was never installed for this user account | **Settings ▸ Apps ▸ Installed apps** lists no "ORCA" | Stop and tell your coordinator. Don't uninstall or delete anything to make room |
| No ORCA environment variables are set | In PowerShell: `Get-ChildItem Env:ORCA_*` prints nothing | Stop and tell your coordinator. Don't change settings someone else made |
| Your user folder is on a local, fixed NTFS drive (normally `C:`) | In PowerShell: `$env:USERPROFILE` shows a path starting with a drive letter, such as `C:\Users\…`. This is a first check only; setup itself refuses non-NTFS, network, removable and redirected locations | Stop if it isn't a drive-letter path. The sample can't use network, removable or redirected locations |
| You will use a normal PowerShell window | Don't use **Run as administrator** for anything in this guide | — |

The sample creates its folders directly inside your user folder. Don't put them in
OneDrive, Dropbox or another synced folder, in Temp, on a network share, or on a USB or
other removable drive. ORCA's first-run checks refuse several of these, and a synced
folder could upload test files.

## Which file

Use the NSIS installer for your architecture. electron-builder names it
`ORCA-<version>-win-<arch>.exe`, where `<version>` is `{{CANDIDATE_VERSION}}` and
`<arch>` is `x64` or `arm64`. The exact name and checksum are in your card's file table.
The `.zip` builds are archives, not the supported way to install. Don't use one unless
your card lists it for you.

## P1–P3: download and check that the file is the candidate

1. **P1 Download** the installer from {{DOWNLOAD_LOCATION}}, using the access you already
   have. If your browser blocks the file or warns about it, **stop**. Warnings include
   "isn't commonly downloaded", "could harm your device" and "blocked". Don't choose
   **Keep**, **Keep anyway** or **Unblock**, and don't switch to another download method
   to avoid the warning. Report "stopped at P1: browser warning".
2. **P2 Check the SHA-256.** In PowerShell, replacing the file name with yours:

   ```powershell
   Get-FileHash -Algorithm SHA256 "$env:USERPROFILE\Downloads\ORCA-<version>-win-<arch>.exe"
   ```

   The `Hash` value must equal the card's SHA-256 for that file name, ignoring
   upper/lower case. If it differs, **don't open the file**. Delete that download and
   report "stopped at P2: checksum mismatch".
3. **P3 Check the signature status.** This only reads the file:

   ```powershell
   Get-AuthenticodeSignature "$env:USERPROFILE\Downloads\ORCA-<version>-win-<arch>.exe" | Format-List Status
   ```

   The expected result for this round is `Status : NotSigned`. Any other status is
   unexpected: stop and report it.

## P4–P7: install

4. **P4 Open the installer** by double-clicking it. Expect a **"Windows protected your PC"**
   SmartScreen screen. **Stop: choose Don't run, or close it.** Don't choose **More info ▸
   Run anyway**. Report "stopped at P4: SmartScreen" and anything the screen said about
   the publisher, in your own words (no screenshot).
   - Continue only if no warning appeared at all and P2 matched.
   - Also stop if Microsoft Defender or other antivirus warns about the file or
     quarantines it. Don't restore or allow it.
5. **P5 Install for you only, with no administrator prompt.** If the installer asks who to
   install for, choose **Only for me** (the current user). Installing for all users would
   need administrator rights and is outside this test. The repository's installer
   settings (`perMachine: false`) are meant to need no elevation. If a User Account
   Control prompt appears anyway, choose **No** and stop.
6. **P6 Install location.** The installer offers a location. Keep the default, which is
   inside your own user profile. If it proposes `C:\Program Files` or a shared location,
   choose **Cancel** and stop.
7. **P7 Finish** the installer. Leave any **Run ORCA** option unticked; you start ORCA in
   P8.

## P8–P9: first launch

8. **P8 Launch** ORCA from the Start menu. Expect a window within about a minute. If no
   window appears, use [failed startup](when-something-goes-wrong.md#failed-startup).
9. **P9 What you should see.** From the source, the expected first screen is:
   - the ORCA window opens
   - the status bar at the bottom reads **◷ disconnected**, because no workspace has been
     chosen yet
   - the **Config** surface contains a **Dedicated project setup** card

   This has **not yet been observed on a packaged Windows candidate**. If you see
   something else, such as **● connected** before you have chosen any folders, write it
   down. Then continue with the [first-success sample](first-success-sample.md) only if
   no folder ORCA shows you is a real project.

Next: the [first-success sample](first-success-sample.md).

## After the round

When your coordinator confirms nothing more is needed:

- Close ORCA ([stop ORCA](when-something-goes-wrong.md#stop-orca-and-its-bundled-daemon)).
- Uninstall it from **Settings ▸ Apps ▸ Installed apps ▸ ORCA ▸ Uninstall**. Write down
  whether the uninstaller asked anything unexpected.
- In File Explorer, review each folder and its contents with your coordinator before
  deciding whether to remove it. Confirm that this round created the specific
  `%USERPROFILE%\orca-trial` folder and it contains only this round's disposable files.
  If setup refused a path or it already existed, leave it untouched.
  Keep any folder whose origin or contents are uncertain. Review the downloaded installer
  separately before removing it.
- ORCA's settings folder in your profile may remain after uninstalling. Leave it unless
  your coordinator asks you to remove it.

## What is and isn't proven for Windows

| Claim | Evidence | Status |
| --- | --- | --- |
| First-run setup, one harmless sample, restart and reopen | Real Windows x64 Electron 44.4.5, **source-built**, with a test-substituted folder picker ([receipt](../../implementation/m21-windows-first-run.md)) | Passed on source only |
| Clean install, launch, logs, shutdown of the **packaged** installer | [#772](https://github.com/cschadewitz/Project_Orca/issues/772) procedures W1–W5 | Not run for any candidate |
| Current Electron 44.9.1 / electron-builder 26.18.0 on Windows | [Readiness audit](../../reviews/2026-10-27-release-readiness.md) rows R5, C1 | Never packaged for Windows |
| arm64 | — | Never executed |
| Signing, publisher trust, SmartScreen reputation | [RELEASING.md](../../RELEASING.md#signing-and-notarisation-are-not-done) | Unsigned; not applicable |
| In-place upgrade from an earlier ORCA | Readiness audit C3 | Unverified; excluded from this round |
