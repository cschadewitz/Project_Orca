# Linux: prerequisites, checking the download, extract and launch

Part of the [Windows/Linux candidate guide](tester-guide.md). The steps are numbered
**P1–P6**, so a report can name the step where you stopped. Nothing here needs `sudo`,
installs a system package, or changes a system setting.

## Prerequisites

| Check | How | If it fails |
| --- | --- | --- |
| Your architecture is on the card | `uname -m`: `x86_64` means x64; `aarch64` means arm64 | Stop. Don't use the other architecture's file |
| Your distribution and version are on the card's tested list | `cat /etc/os-release` (the `PRETTY_NAME` line) | Ask your coordinator before continuing |
| You are in a graphical desktop session as yourself, not as root | `id -u` doesn't print `0` | Stop. Don't run ORCA as root |
| Git 2.28 or newer | `git --version` | Stop. Installing Git is your own decision and outside these instructions |
| `sha256sum` is available | `sha256sum --version` | Stop and tell your coordinator |
| ORCA was never run under this user account | You have not installed, extracted or run ORCA before | Stop and tell your coordinator. Don't delete anything to make room |
| No ORCA environment variables are set | `env \| grep '^ORCA_'` prints nothing | Stop and tell your coordinator. Don't change settings someone else made |

Keep everything for this test in new folders in your home directory. Don't use a synced
folder (Dropbox, Nextcloud and similar), a network mount or removable media.

## Which file

electron-builder names the Linux builds like this. The exact names and checksums are in
your card's file table.

| File | Architectures | Notes |
| --- | --- | --- |
| `ORCA-<version>-linux-<arch>.tar.gz` | x64 and arm64 | An archive of the app folder. The default choice for this round unless your card says otherwise |
| `ORCA-<version>-linux-x86_64.AppImage` | x64 only | A single-file wrapper around the same app. AppImages typically need FUSE on your system |

## P1–P2: download and check that the file is the candidate

1. **P1 Download** the file from {{DOWNLOAD_LOCATION}}, using the access you already
   have. If your browser blocks the file or warns about it, **stop**. Don't override the
   warning, and don't switch to another download method to avoid it. Report "stopped at
   P1: browser warning".
2. **P2 Check the SHA-256**, replacing the file name with yours:

   ```sh
   sha256sum ~/Downloads/ORCA-<version>-linux-<arch>.tar.gz
   ```

   The first field must equal the card's SHA-256 for that file name. If it differs,
   **don't extract or run the file**. Delete that download and report "stopped at P2:
   checksum mismatch". Linux builds carry no signature, so the checksum is the identity
   check ([RELEASING.md](../../RELEASING.md#signing-and-notarisation-are-not-done)).

## P3–P4: extract into a new folder

3. **P3 Make a new folder for the app.** If `mkdir` says the folder exists, stop. Don't
   reuse or empty it.

   ```sh
   mkdir ~/orca-candidate
   ```

4. **P4 Put the candidate in it.** For the **tar.gz**:

   ```sh
   tar -xzf ~/Downloads/ORCA-<version>-linux-<arch>.tar.gz -C ~/orca-candidate
   ls ~/orca-candidate
   ```

   Look for the folder that holds an `orca` program and a `resources` folder. It is either
   `~/orca-candidate` itself or the single folder inside it. Call that folder the **app
   folder**. If you find neither, stop and report it.

   For the **AppImage** instead (x64 only):

   ```sh
   cp ~/Downloads/ORCA-<version>-linux-x86_64.AppImage ~/orca-candidate/
   chmod u+x ~/orca-candidate/ORCA-<version>-linux-x86_64.AppImage
   ```

   Don't move anything into `/usr`, `/opt` or any other system location, and don't add
   ORCA to your application menu.

## P5–P6: first launch

5. **P5 Launch from a terminal**, so you can see a startup message if there is one. Use
   no extra options.

   ```sh
   cd ~/orca-candidate
   ls
   ```

   If `ls` shows `orca` and `resources`, you're already in the app folder. Otherwise run
   `cd` followed by the name of the single folder `ls` showed. Then start ORCA:

   ```sh
   ./orca
   ```

   For the AppImage: `~/orca-candidate/ORCA-<version>-linux-x86_64.AppImage`.

   The terminal stays busy while ORCA runs and may print lines that include your folder
   names. Those lines stay on your computer. See [collecting
   details](when-something-goes-wrong.md#collect-details-safely) before sharing any of
   them.

   **Stop, and use [failed startup](when-something-goes-wrong.md#failed-startup), if:**
   - no window appears within a minute
   - the terminal mentions the **sandbox**, for example "SUID sandbox helper" or "No usable
     sandbox". In the local build that #779 inspected, Chromium's `chrome-sandbox` helper
     was not setuid (mode 755). The sandbox then relies on unprivileged user namespaces,
     which some distributions restrict. **Don't** add `--no-sandbox`, and don't change
     `chrome-sandbox` ownership or mode. Don't change `sysctl`, AppArmor or SELinux
     settings either. Report it as a launch blocker.
   - the AppImage says it needs **FUSE** (for example it mentions `libfuse` or
     `fusermount`). Don't install packages. Use the tar.gz if your card lists it,
     otherwise report it.

6. **P6 What you should see.** From the source, the expected first screen is:
   - the ORCA window opens
   - the status bar at the bottom reads **◷ disconnected**, because no workspace has been
     chosen yet
   - the **Config** surface contains a **Dedicated project setup** card

   This has **not yet been observed on a packaged Linux candidate**. If you see something
   else, such as **● connected** before you have chosen any folders, write it down. Then
   continue with the [first-success sample](first-success-sample.md) only if no folder
   ORCA shows you is a real project.

Next: the [first-success sample](first-success-sample.md).

## After the round

When your coordinator confirms nothing more is needed:

1. Close ORCA ([stop ORCA](when-something-goes-wrong.md#stop-orca-and-its-bundled-daemon)).
2. In your file manager, review each folder and its contents with your coordinator before
   deciding whether to remove it. Confirm that this round created the specific folder
   (`~/orca-candidate` or `~/orca-trial`) and that it contains only this round's disposable
   files. If setup refused a path or it already existed, leave it untouched.
   Keep any folder whose origin or contents are uncertain. Review the exact downloaded
   tar.gz or AppImage separately before removing it. There is no bulk cleanup command.

3. ORCA's settings folder in your home configuration directory may remain. Leave it
   unless your coordinator asks you to remove it.

## What is and isn't proven for Linux

| Claim | Evidence | Status |
| --- | --- | --- |
| First-run directory, Git and setup checks, and the agent-free sample interpreter | Portable source tests on Linux x64 (`packages/app/test/first-run*.test.ts`, `packages/cli/test/first-run-sample.test.ts`) and this preparation's [offline validation](README.md#validation-record) | Offline only |
| Packaged tar.gz/AppImage contents | [#779](https://github.com/cschadewitz/Project_Orca/pull/779) built a local unsigned x64 tar.gz and AppImage from `4d5176c` and found them statically consistent. They are not a candidate | Static only; UI not launched |
| Packaged launch, bundled daemon, rendering, shutdown | [#772](https://github.com/cschadewitz/Project_Orca/issues/772) procedures L1–L3 | Not run for any candidate |
| arm64 | — | Never executed |
| Updates | Linux has no desktop updater | Not applicable |
