# When something goes wrong

Part of the [Windows/Linux candidate guide](tester-guide.md). Everything here affects
only ORCA and the throwaway folders this test made: `orca-trial`, and on Linux
`orca-candidate`. Never use these steps on a real project or on another program.

## Stop ORCA and its bundled daemon

**Close the ORCA window.** You can also use the quit item at the bottom of the **File**
menu; its wording depends on the platform. On Windows and Linux, closing the last window
quits ORCA. ORCA then stops the background daemon it started:

- On Linux it asks the daemon to stop, and forces it after a few seconds if needed.
- On Windows it ends the daemon process directly.

Either way, ORCA itself exits within about 10 seconds, even if something is stuck. There
is no separate daemon control, and you should not need one.

After about 30 seconds, check that nothing is left:

- **Windows:** in **Task Manager ▸ Details**, no `ORCA.exe` is listed. The daemon also
  runs as `ORCA.exe`.
- **Linux:** each of these prints nothing:
  - `pgrep -a -f orca-daemon`
  - `pgrep -a -x orca`
  - `pgrep -a -f orca-candidate` (this also catches the AppImage's own process)

  Their output includes folder paths, so keep it to yourself.

**If something is still running after 30 seconds, that is a finding.** Write down what
it was (the name only) and how long you waited. Then end it:

- Windows: select it in **Task Manager ▸ Details ▸ End task**.
- Linux: run `kill <number>`, using the number `pgrep` printed. Wait 10 seconds and check
  again. Use `kill -9 <number>` only if it is still there.

Only end processes from this test.

## Interruptions

| What was interrupted | What to do |
| --- | --- |
| A folder dialog (F3) was cancelled or closed | Nothing was written. Choose **Choose project and empty workspace** again |
| ORCA closed after the review (F4), before you created files | Nothing was written. Start again from F3 |
| ORCA closed or crashed while creating files (F5) | Reopen ORCA and open **Config**. If the status bar reads **● connected**, or setup offers **Connect selected local workspace**, continue at F6. If setup refuses, don't edit or delete the half-made workspace. On Linux, make a new empty folder `~/orca-trial/workspace-2` and select it in F3. On Windows, select the same parent again; ORCA makes a new private folder. Mention the interruption in your report |
| ORCA closed before it said connected (F6) | Reopen ORCA and wait 30 seconds; it may reconnect to your reviewed folders by itself. If not, choose **Connect selected local workspace** once. If it still doesn't connect, see [failed startup](#failed-startup) |
| You chose **Launch** (F7) and aren't sure anything happened | **Don't choose Launch again.** Open **Runs**. If a run is listed, continue at F8. If not, after 30 seconds close ORCA, reopen it, connect as in F10, and look at **Runs** again. If there is still no run, report it. Don't use **Recover original launch** or **Restore protected launch** unless your coordinator asks |
| The computer restarted, crashed or lost power while ORCA was open, or a setup message mentions recovery or ownership | On the next launch, setup may show one of these:<br>• "The last session ended without closing cleanly, before this computer restarted."<br>• "Local startup ownership requires reconciliation…"<br>• "Writer ownership is unknown…"<br>• "The exact owned daemon is still running…"<br>It may also offer **Mark previous session ended** or **Reconcile same-boot ownership**. **Don't choose any of these on your own**, and don't choose **Review same-boot recovery** either. That button is always on the card once files exist, and it isn't needed in this round. Write down which message appeared, close ORCA and report it. Your coordinator decides whether you continue or start again with new folders |

## Failed startup

| What you see | What to do |
| --- | --- |
| **Windows:** no window after a minute | Look in **Task Manager ▸ Details** for `ORCA.exe`. If it is there with no window, end it as [above](#stop-orca-and-its-bundled-daemon). You may try starting ORCA **once** more. Don't keep retrying. Report "no window" |
| **Linux:** no window, or ORCA exits at once | Read the terminal. If it mentions the **sandbox** or **FUSE**, stop and follow [Linux P5](linux.md#p5p6-first-launch); there is no workaround in this round. Otherwise note the first line that looks like an error, following [the rules below](#collect-details-safely). You may try **once** more |
| Not **● connected** 30 seconds after F6 | Note the message under the setup card. Choose **Read setup again** once, then **Connect selected local workspace** once. If it still fails, close ORCA and report both messages |
| The status bar says **▣ version mismatch** | Stop and report it. Don't try to connect to anything else |
| ORCA says **connected** before you chose any folders, or shows a version that isn't on your card | Stop. Don't launch anything. Report what it showed |

While troubleshooting, **don't**:

- set `ORCA_*` environment variables
- use **File ▸ Open a store…**, **File ▸ Connect to a daemon…**, the status bar's
  **Connect to a daemon…** button, or **Connection settings** in Launch work
- edit `orca.config.yaml`, or delete `.orca` or ORCA's settings folder
- reinstall over an existing install
- run ORCA as administrator or root
- turn off your antivirus, SmartScreen or the sandbox

## Setup refused

ORCA refuses folders it can't verify, and leaves existing files as they were. The card
then shows "Setup was refused" with the reason under it, such as a workspace folder that
is not empty or a project with no branch checked out. Include that reason in the report. If
it says "Project setup could not verify its saved selection. Choose directories again.",
the folders saved from an earlier step no longer verify. Report that too. The source
checks for:

- **The project:** the top folder of a Git repository with at least one commit, on a
  branch (not a detached HEAD), owned by you. Git must be findable by ORCA (on your
  `PATH`). The project can't be your home folder itself.
- **Linux, the app workspace:** an empty folder you own that is separate from the
  project. It can't be inside the project, can't contain it, and can't be your home folder
  itself. A symbolic link is refused.
- **Windows, the parent and the project:**
  - on a local, fixed NTFS drive (the usual `C:` drive), under a normal drive-letter path
    such as `C:\Users\…`
  - not reached through a junction or link
  - not inside a folder that other users can modify
  - the project (not the parent) must be owned by your own account. A folder made from an
    administrator PowerShell window is owned by the Administrators group instead, and
    is refused.

  The source-built receipt used a harness-made private project folder and a plain parent
  folder under Documents. By the source, ordinary folders you make under `%USERPROFILE%`
  are expected to pass the same checks, but no tester has tried this yet.

Don't change folder permissions, take ownership, or run anything as administrator to get
past a refusal. You may try **once** with new folders: repeat F1 with every `orca-trial`
in the block replaced by `orca-trial-2`. Check each replacement before you press Enter.
Report the refusal message and which folder you chose.

## Collect details safely

**What helps most, in your report:**

- the step (P… or F…)
- what you did and what you expected
- what happened, in your own words
- the candidate version, your platform, architecture and OS version
- whether it happened again on one retry, and whether anything was left running after you
  closed ORCA

**ORCA's on-screen messages.** The setup, status and launch messages quoted in this
guide are fixed sentences. Copy one exactly if it contains no folder path, user or
computer name. Otherwise describe it.

**A short excerpt of Linux terminal output**, only if your coordinator asks for one:

- at most 3 lines: the first ones that look like the error
- replace your home folder path with `~`, your user name with `<user>`, and your computer
  name with `<host>`
- remove anything that looks like a token, key, password or email address, and any web
  address containing `@` or `?`
- if you are unsure about a line, describe it instead

**Never send these, even if someone asks.** Describe them in words instead.

- Anything from the app workspace:
  - `orca.config.yaml` and `first-run/`
  - `.orca/`, which contains run records and encryption-key files
  - `auth/`, which holds the daemon's local access credentials
- ORCA's settings folder. It holds your preferences, the record of the folders you chose,
  and any diagnostics files.
- Whole terminal output, log files, screenshots or screen recordings.
- Diagnostics exports. They are not part of this round. Production capture is off in this
  build, and ORCA has no in-app view of a report's contents.
- Real project names, any path outside your throwaway folders, and account or computer
  names.

Don't run commands someone else sends you to collect more information. Ask your
coordinator first, through the route on your card.
