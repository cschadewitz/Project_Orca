# First-success sample: the harmless local check

Part of the [Windows/Linux candidate guide](tester-guide.md). Do this after P9 on
[Windows](windows.md) or P6 on [Linux](linux.md). The steps are numbered **F1–F10**.

The sample is ORCA's built-in **harmless local sample**. ORCA's source identifies it as
workflow `orca-beta-local-check`, version `1`, revision
`sha256:31027c78fb1ea553caf218b8366e7ea08d6a141efce5cb53b32e781fd7390567`. It is three
steps: start, record a fixed marker, end. **It starts no AI agent, runs no commands, uses
no account, credential or paid service, needs no internet, and does not change the
project it is pointed at.** Completing it shows that ORCA can be set up, connect to its
own background daemon and run one piece of work on your computer. It does not test
coding, agents, diagnostics or updates.

The expected results below come from the source. F3–F8 follow the same sequence as a
passing **source-built** Windows x64 run (the [first-run receipt](../../implementation/m21-windows-first-run.md)).
F10's automatic reconnect comes from the source alone. None of this has **yet been
observed on a packaged candidate**. Write down anything that differs, even if it seems
minor.

## What it uses, and how to stop it

| Resource | Bound |
| --- | --- |
| Internet, accounts, AI providers, money | None |
| Processes | ORCA itself (several OS processes is normal for an Electron app) and one ORCA daemon started in the background, reachable only from this computer (`127.0.0.1`). Both exit when you close the ORCA window ([stop ORCA](when-something-goes-wrong.md#stop-orca-and-its-bundled-daemon)) |
| Your throwaway project | Unchanged. It holds only what you create in F1 |
| Your throwaway app workspace | Setup writes `orca.config.yaml` and four files under `first-run/`, about 5.5 KB in total. Connecting and one run add ORCA's store (`.orca/`) and an `auth/` folder. Running this sample through ORCA's engine offline wrote about 28 KB of store data; the packaged daemon may differ slightly |
| ORCA's settings folder | One small record of the folders you reviewed |
| Time | Each setup step and the run take seconds. Connecting can take up to 30 seconds |
| Afterwards | Nothing keeps running and nothing is scheduled |

**To stop at any point, close the ORCA window.** Nothing in this sample needs to be
undone. Leave the throwaway folders as they are until you've written your report.

## F1: make the throwaway project

ORCA's setup needs an existing Git project to point the sample at. Make a new, empty one
just for this test:

- The commands set a throwaway commit author for this one commit only. They don't change
  your Git settings, add a remote, or contact the internet. If you have set up global Git
  hooks, those may still run; they are your own configuration.
- Both blocks refuse any inherited `GIT_*` environment variable before creating folders.
  If refused, stop and tell your coordinator; leave your session settings unchanged.
- Paste each block as a whole. If `orca-trial` already exists, the block stops before
  touching anything, so an existing folder is never reused. If it reports that the folder
  exists, or shows any other error, **stop**.

**Linux** (Bash terminal):

<!-- validate: linux-project -->
```bash
(
  orca_trial_environment=$(env) || { printf '%s\n' 'Stop: environment inspection failed; contact your coordinator.' >&2; exit 1; }
  if [[ $'\n'"$orca_trial_environment" == *$'\n'GIT_*=* ]]; then
    printf '%s\n' 'Stop: inherited GIT_* settings; contact your coordinator.' >&2
    exit 1
  fi
) &&
mkdir ~/orca-trial &&
mkdir ~/orca-trial/project ~/orca-trial/workspace &&
cd ~/orca-trial/project &&
git init -b trial &&
printf 'Throwaway ORCA trial project. Safe to delete.\n' > README.txt &&
git add README.txt &&
git -c "user.name=ORCA trial" -c "user.email=trial@example.invalid" -c commit.gpgsign=false commit --no-verify -m "Trial project" &&
git status --short &&
git log --oneline
```

**Windows:**

- Use a normal PowerShell window, **not** one opened with **Run as administrator**.
  Folders made from an elevated window are owned by the Administrators group, and setup
  refuses a project you don't own.
- There is no `workspace` folder here. On Windows, ORCA creates a new private workspace
  folder itself in F5.

<!-- validate: windows-project -->
```powershell
& {
  $ErrorActionPreference = 'Stop'
  if (Get-ChildItem Env:GIT_*) { throw 'Stop: inherited GIT_* settings; contact your coordinator.' }
  New-Item -ItemType Directory "$env:USERPROFILE\orca-trial"
  New-Item -ItemType Directory "$env:USERPROFILE\orca-trial\project"
  Set-Location "$env:USERPROFILE\orca-trial\project"
  git init -b trial
  Set-Content -Path README.txt -Value "Throwaway ORCA trial project. Safe to delete."
  git add README.txt
  git -c "user.name=ORCA trial" -c "user.email=trial@example.invalid" -c commit.gpgsign=false commit --no-verify -m "Trial project"
  git status --short
  git log --oneline
}
```

**Expected:** `git status --short` prints nothing. `git log --oneline` prints exactly
one line ending in `Trial project`. Keep this window open; you'll use it again in F8.

## F2: open project setup

In ORCA, choose **Config** in the navigation, and find the **Dedicated project setup**
card. On a first run it offers **Choose project and empty workspace**. If it instead says
"The last session ended without closing cleanly…", or offers **Mark previous session
ended** or **Reconcile same-boot ownership**, stop: see
[interruptions](when-something-goes-wrong.md#interruptions).

Two buttons appear on the card normally, and you won't need either one in this round:
**Review saved configuration for reopening**, and from F5 on, **Review same-boot
recovery**. Don't choose them.

## F3: choose the two folders (nothing is written yet)

Choose **Choose project and empty workspace**. A folder dialog opens. Select the folder
and choose **Review selection**. If ORCA accepts the project, a second dialog opens for
the workspace. If ORCA refuses the project, the second dialog doesn't open.

| Dialog title | Linux: select | Windows: select |
| --- | --- | --- |
| **Choose a prepared Git project** | `~/orca-trial/project` | `%USERPROFILE%\orca-trial\project` |
| Linux: **Choose a separate empty app workspace**. Windows: **Choose a parent for a new private app workspace** | `~/orca-trial/workspace` | `%USERPROFILE%\orca-trial` |

Cancelling either dialog keeps the previous selection and writes nothing. If ORCA refuses
the selection, don't change any folder permissions; see
[setup refused](when-something-goes-wrong.md#setup-refused). A refusal shows "Setup was
refused. Check directory ownership, writable access and Git…".

## F4: review

The card now shows what it will do. Check every line **before** choosing anything:

| Line | Expected |
| --- | --- |
| `Project:` | your throwaway project folder from F1 |
| `App workspace:` | Linux: `…/orca-trial/workspace`. Windows: `…\orca-trial\orca-workspace-` followed by a random id |
| `Selected parent:` (Windows only) | `…\orca-trial`, with the sentence "Create the displayed new private folder and sample files. Existing parent and project permissions stay unchanged." |
| `Prepared branch:` | `trial / base` followed by a 40-character commit id. Its first 7 characters match `git log --oneline` from F1 |
| `Sample:` | `orca-beta-local-check / 1 / sha256:31027c78fb1ea553caf218b8366e7ea08d6a141efce5cb53b32e781fd7390567` |

If any line names a different folder, branch or sample, **stop**. Don't choose the create
button.

## F5: create the sample files

Choose **Create reviewed sample files** on Linux, or **Create reviewed private workspace
and sample files** on Windows. Expect the message **"Sample files prepared. Connect the
selected local workspace when ready."** Only the app workspace receives files (see the
table above). The project is not touched.

## F6: connect

Choose **Connect selected local workspace**. Within 30 seconds:

- the message reads **"Selected workspace connected. Open Launch work and choose the
  harmless sample; review permissions before launching."**
- the status bar reads **● connected** and shows `orca-daemon {{CANDIDATE_VERSION}}`

If the version shown is different, stop and report it. If it isn't connected after 30
seconds, see [failed startup](when-something-goes-wrong.md#failed-startup).

## F7: launch the sample once

1. In **Config**, choose **Launch work**.
2. Choose **Choose harmless launch smoke check**.
3. Choose **Preview launch**. A review appears: "Review the exact target, workflow and
   inputs before launching." Check that it names workflow `orca-beta-local-check` and the
   task "Check this selected local workspace without starting an agent or changing
   project files." If it names another workflow, an agent or a model, or asks for any
   key, token or sign-in, **stop**.
4. Tick **Permission review**. Its wording is generic and appears on every launch: "I
   reviewed the configured permission policy. This work may execute commands in the
   prepared checkout; permission requests still require their own confirmation." This
   sample's configuration has no agents, and its workflow runs no commands.
5. Choose **Launch** once. Don't choose it again, even if nothing seems to happen. Wait 30
   seconds, then see [interruptions](when-something-goes-wrong.md#interruptions).

No permission question or other prompt should appear. If one does, don't answer it. Stop
and report it.

## F8: check the result

- The launch area shows the admission as `accepted`, with a run id.
- The **Runs** list shows one run of `orca-beta-local-check`, marked **✓ succeeded**.
  The sample's final message is "Harmless local sample completed. No agent was started
  and no project files were changed."
- In your F1 terminal or PowerShell window, still inside the project folder, run these
  again:

  ```sh
  git status --short
  git log --oneline
  ```

  Expect the same output as F1: nothing, then one `Trial project` line.

Any other status, a second run, or a change in the project is a finding. Report it.

## F9: close ORCA

Close the ORCA window, then check that nothing is left running:
[stop ORCA](when-something-goes-wrong.md#stop-orca-and-its-bundled-daemon).

## F10 (optional): reopen

Start ORCA again (P8 on Windows, P5 on Linux). From the source, ORCA rechecks your
reviewed folders at startup and reconnects to them by itself. Within 30 seconds, the
status bar should read **● connected**. If it doesn't, open **Config** and choose
**Connect selected local workspace** once. **Runs** should show the same single run,
still **✓ succeeded**, and no new run. Close ORCA again as in F9.

## Not part of this round

The `beta-first-job-v1` coding task ([fixture](../../../examples/beta-first-job/README.md),
[acceptance](../beta-first-job/acceptance.md)) needs a real AI agent. That means a sign-in,
possible cost, data sent to a provider, and explicit authorization. It is a **later
prerequisite** that the coordinator would arrange separately, and it is not part of these
instructions. Don't configure an agent in **Config** for this round.
