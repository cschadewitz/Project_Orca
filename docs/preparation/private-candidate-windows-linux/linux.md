# Linux: prerequisites, checking the download, install and launch

Part of the [Windows/Linux candidate guide](tester-guide.md). The steps are numbered
**P1–P6**, so a report can name the step where you stopped.

**Read this first.** On Linux this round offers one file: the ORCA package for **Ubuntu
24.04 Desktop, x64** (`amd64`), a `.deb` named in your card's file table. The package and
the command it installs are both called **`orca-desktop`**. Don't confuse it with
**Orca**, the screen reader that Ubuntu installs by default as the package `orca`: these
steps never run, change or remove `orca`. Don't use a tar.gz, an AppImage or an arm64
file, even if the download page lists one: they are not part of this round.

This round uses `sudo` only for APT: P3's dry run and P4's install of the checked `.deb`,
and, after the round, the reviewed removal of `orca-desktop`. Never run ORCA itself with
`sudo`, and never change a system setting to make it start.

## Prerequisites

| Check | How | If it fails |
| --- | --- | --- |
| Your computer is x64 | `uname -m` prints `x86_64` | Stop. Don't use another architecture's file |
| You run Ubuntu 24.04 Desktop | `cat /etc/os-release` (the `PRETTY_NAME` line starts `Ubuntu 24.04`) | Stop and tell your coordinator |
| Your version is on the card's tested list | The same `PRETTY_NAME` line | Ask your coordinator before continuing |
| You are in a graphical desktop session as yourself, not as root | `id -u` doesn't print `0` | Stop. Don't run ORCA as root |
| You may install software on this computer with `sudo` | It is your own computer, or its owner allowed it | Stop. That permission is not your coordinator's to give |
| Git 2.28 or newer | `git --version` | Stop. Installing Git is your own decision and outside these instructions |
| `sha256sum` is available | `sha256sum --version` | Stop and tell your coordinator |
| ORCA was never installed or run under this user account | `dpkg -s orca-desktop` says the package is not installed, and you have not run any ORCA build before | Stop and tell your coordinator. Don't remove anything to make room |
| No ORCA environment variables are set | `env \| grep '^ORCA_'` prints nothing | Stop and tell your coordinator. Don't change settings someone else made |

Keep the throwaway folders for this test in your home directory. Don't use a synced folder
(Dropbox, Nextcloud and similar), a network mount or removable media.

## P1–P2: download and check that the file is the candidate

1. **P1 Download** the `.deb` named in your card from {{DOWNLOAD_LOCATION}}, using the
   access you already have, into your `Downloads` folder. If your browser blocks the
   file or warns about it, **stop**. Don't override the warning, and don't switch to
   another download method to avoid it. Report "stopped at P1: browser warning".
2. **P2 Check the SHA-256** before anything else touches the file. Replace the file name
   with the exact one from your card:

   ```sh
   cd ~/Downloads
   sha256sum ./ORCA-<version>-linux-amd64.deb
   ```

   The first field must equal the card's SHA-256 for that file name. If it differs,
   **don't install, open or unpack the file**. Delete that download and report "stopped
   at P2: checksum mismatch". Linux builds carry no signature, so the checksum is the
   identity check ([RELEASING.md](../../RELEASING.md#signing-and-notarisation-are-not-done)).

## P3–P4: review APT's plan, then install

3. **P3 Review APT's plan.** This dry run only shows what APT would do and changes
   nothing. It uses `sudo` so that APT reads the same system configuration as the real
   install, and the same options as P4:

   ```sh
   sudo apt-get install --simulate --trivial-only --no-install-recommends --no-remove ./ORCA-<version>-linux-amd64.deb
   ```

   `sudo` asks for **your own** computer password in this terminal. That is not an ORCA
   or provider prompt; never type it anywhere else or share it. The `./` makes APT read
   the file you checked, not a package from the internet. The approved plan is exactly:

   - under "The following NEW packages will be installed:", only `orca-desktop`
   - the summary line `0 upgraded, 1 newly installed, 0 to remove and …` (the number of
     "not upgraded" packages doesn't matter)

   **Stop** if the plan removes any package, upgrades or downgrades any package, installs
   or downloads any package other than `orca-desktop`, or names `orca`. Report "stopped
   at P3: unexpected APT plan" and copy only the package names. Don't change your
   system's package sources or settings to get a different plan.

4. **P4 Install** the same file, once, with the same options as P3 but without
   `--simulate`:

   ```sh
   sudo apt-get install --trivial-only --no-install-recommends --no-remove ./ORCA-<version>-linux-amd64.deb
   ```

   APT works out its plan again here. The two options are there to refuse a plan that
   differs from P3's before anything changes: `--trivial-only` refuses a plan that
   installs or upgrades anything besides the file you name, and `--no-remove` refuses
   any removal. If APT prints "Trivial Only specified but this is not a trivial
   operation" or "Packages need to be removed but remove is disabled", nothing was
   installed. Stop and report "stopped at P4: APT plan differed from P3". Don't run it
   again, and don't remove either option.

   Before the install lines, APT prints its plan again. If it differs from P3 and APT
   carries on anyway, stop as soon as it finishes and report it. APT may also
   print a note that the download "is performed unsandboxed as root" because the file is
   in your home folder. That note is about APT reading the file and is expected. Expect
   the output to end with lines such as "Setting up orca-desktop".

   **Stop, and don't try again, if:**
   - APT prints an error, or the install fails. The package refuses to install when it
     cannot load its AppArmor profile, rather than weakening the sandbox. Report the
     last lines you saw, after checking them for folder names
   - anything mentions AppArmor, `apparmor_parser` or a sandbox and the install did not
     finish
   - anything asks you to disable a protection, edit `/etc`, or change `sysctl`

   Don't retry with `dpkg -i`, `apt install`, `--yes`, `--force` options, a different
   file or a different package manager. Don't bypass any warning.

   Check the result:

   ```sh
   dpkg -s orca-desktop | grep '^Status'
   ```

   Expect `Status: install ok installed`.

## P5–P6: first launch

5. **P5 Launch from a terminal, as yourself**, so you can see a startup message if there
   is one. Use no extra options:

   ```sh
   orca-desktop
   ```

   Never `sudo orca-desktop`, and never `orca` (that starts the screen reader). Once this
   first launch works you may also open ORCA from the app menu, but this round uses the
   terminal.

   The terminal stays busy while ORCA runs and may print lines that include your folder
   names. Those lines stay on your computer. See [collecting
   details](when-something-goes-wrong.md#collect-details-safely) before sharing any of
   them.

   **Stop, and use [failed startup](when-something-goes-wrong.md#failed-startup), if:**
   - no window appears within a minute
   - the terminal or a dialog mentions the **sandbox** or **AppArmor**, for example "SUID
     sandbox helper", "No usable sandbox", `userns` or "apparmor". **Don't** add
     `--no-sandbox`, and don't change `chrome-sandbox` ownership or mode. Don't change
     `sysctl`, AppArmor or SELinux settings, or the installed files under `/opt/ORCA`.
     Report it as a launch blocker.

6. **P6 What you should see.** From the source, the expected first screen is:
   - the ORCA window opens
   - the status bar at the bottom reads **◷ disconnected**, because no workspace has been
     chosen yet
   - the **Config** surface contains a **Dedicated project setup** card

   If you see something else, such as **● connected** before you have chosen any
   folders, write it down. Then continue with the [first-success
   sample](first-success-sample.md) only if no folder ORCA shows you is a real project.

Next: the [first-success sample](first-success-sample.md).

## After the round

When your coordinator confirms nothing more is needed:

1. Close ORCA ([stop ORCA](when-something-goes-wrong.md#stop-orca-and-its-bundled-daemon)).
2. Remove the package, and only that package. First look at the plan, which changes
   nothing:

   ```sh
   sudo apt-get remove --simulate orca-desktop
   ```

   Under "The following packages will be REMOVED:" expect only `orca-desktop`. If the
   plan lists `orca` or any other package, stop and tell your coordinator. Otherwise:

   ```sh
   sudo apt-get remove orca-desktop
   ```

   APT shows the plan again and asks "Do you want to continue?". Answer `y` only if it
   still lists only `orca-desktop`; otherwise answer `n` and tell your coordinator.
   Never `apt remove orca`, `apt purge` or `apt autoremove` for this round: `orca` is the
   screen reader, and the other two can remove packages this round didn't install.
3. In your file manager, review each folder and its contents with your coordinator before
   deciding whether to remove it. Confirm that this round created the specific folder
   (`~/orca-trial`) and that it contains only this round's disposable files.
   If setup refused a path or it already existed, leave it untouched.
   Keep any folder whose origin or contents are uncertain. Review the exact downloaded
   `.deb` separately before removing it. There is no bulk cleanup command, and nothing
   here touches your other files.
4. ORCA's settings folder in your home configuration directory may remain. Leave it
   unless your coordinator asks you to remove it.

## What is and isn't proven for Linux

| Claim | Evidence | Status |
| --- | --- | --- |
| First-run directory, Git and setup checks, and the agent-free sample interpreter | Portable source tests on Linux x64 (`packages/app/test/first-run*.test.ts`, `packages/cli/test/first-run-sample.test.ts`) and this preparation's [offline validation](README.md#validation-record) | Offline only |
| `.deb` packaging, install script, sandboxed launch and removal | [#854](https://github.com/cschadewitz/Project_Orca/pull/854) and the hosted Ubuntu 24.04 check in `desktop.yml` ([INSTALL-LINUX.md](../../INSTALL-LINUX.md#what-is-checked-and-what-is-not)). A hosted runner is not a desktop install and runs no sample | Per build, hosted only |
| Install, launch, sample and F10 reopen on a fresh Ubuntu 24.04 Desktop | Coordinator gates G3–G4 for this candidate | Not recorded for a versioned candidate |
| x64 tar.gz | On a stock Ubuntu 24.04 setup it aborted before its first window with the SUID sandbox helper error ([#853](https://github.com/cschadewitz/Project_Orca/issues/853)). The AppImage was not launched there | Not offered |
| arm64 | The arm64 `.deb` is built but no check installs or launches it | Untested; not offered |
| Updates | Linux has no desktop updater | Not applicable |
