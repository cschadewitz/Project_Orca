# Trying an ORCA Windows/Linux candidate

**This is a preparation draft. It is not an invitation, and it does not mean a candidate
is approved.** Your coordinator gives you a filled-in copy of this page and the pages it
links to. If any field below still shows text in double braces, such as
`{{CANDIDATE_VERSION}}`, **stop**. The candidate is not ready for you yet.

This round covers **Windows and Linux only**. Ignore any macOS files on the download page.
Do not download or open them.

## Your candidate card

| Field | Value |
| --- | --- |
| Candidate version | `{{CANDIDATE_VERSION}}` |
| Built from source commit | `{{CANDIDATE_COMMIT}}` |
| Where to download | {{DOWNLOAD_LOCATION}} |
| Platforms, architectures and file types in this round | {{SUPPORTED_PLATFORMS}} |
| Operating-system versions the coordinator tested | {{TESTED_OS_VERSIONS}} |
| Files and their SHA-256 checksums | {{ARTIFACT_TABLE}} |
| Where to send reports | {{SUPPORT_ROUTE}} |
| Participation, optional feedback and how to withdraw | {{CONSENT_NOTICE}} |
| How long reports are kept, and how to ask for deletion | {{RETENTION_POLICY}} |
| Your coordinator | {{COORDINATOR}} |

Check that your computer appears in the platform and architecture rows. If it doesn't,
stop and tell your coordinator. Don't try a different file.

On Linux, this round offers only the **Ubuntu 24.04 Desktop x64** (`amd64`) **`.deb`**
named in the file table. Its package and command are `orca-desktop`. Ignore any tar.gz,
AppImage or arm64 file on the download page.

## What you are agreeing to

- Install the candidate on your own computer, under your own user account. On Linux
  that is one `sudo apt install` of the checked `.deb`; ORCA itself always runs as you.
- Make a new throwaway folder, `orca-trial`, with a tiny throwaway Git project in it.
  Use only that folder with ORCA.
- Run one built-in sample. It starts no AI agent, needs no account and no internet, and
  leaves its throwaway project unchanged.
- Optionally send a short text report through the route on your card.

You are **not** asked to sign in to any AI provider, enter an API key, use a real
project, turn on diagnostics, send logs or screenshots, or give anyone access to your
computer. You can stop at any point. You can also skip any question, or send no report
at all.

## What this candidate is, and what it is not

- The files on the release page are **unsigned**. Windows testers instead get a
  separately distributed installer signed by **Casey Schadewitz**. The
  [Windows page](windows.md) P4 names the single case where you may continue past
  SmartScreen; every other warning, including any browser warning, means **stop and
  report**. The Linux `.deb` is unsigned too: its SHA-256 on your card is its identity.
- This round tests installing, launching and a first local run. It does not test AI coding
  agents. The provider integrations in this code (Claude, Codex, Gemini, Pi, GitHub
  Copilot CLI, OpenCode), the review judges and ORCA's own tool-guard rules are
  inactive preparation work in this candidate. They are not supported features. Do not
  configure an agent.
- **Local diagnostics:** Config has a Local diagnostics section. In this build it says
  production capture is unavailable. Leave it off. ORCA never shows you the contents of a
  diagnostics report inside the app; the only design is a separate Save to a file you
  choose. That is not part of this round. Your report is text you write yourself.
- **Updates:** do not use **Check for updates**. Update testing is a separate
  coordinator procedure. This candidate has no update feed for you.
- **Earlier installs:** if you have ever installed or run ORCA on this computer under this
  user account, stop and tell your coordinator first. Upgrading an existing install is not
  verified for this round. Do not delete anything to make room.

## Steps

1. Read the page for your platform: [Windows](windows.md) or [Linux](linux.md). It covers
   prerequisites, how to check the download, and how to install and launch.
2. Run the [first-success sample](first-success-sample.md), one step at a time.
3. Close ORCA as described in [when something goes wrong](when-something-goes-wrong.md#stop-orca-and-its-bundled-daemon).
   Check that nothing is left running.
4. If you want to, fill in the [feedback template](feedback-template.md) and send it
   through the route on your card. Successes, confusion and "I got stuck" are all useful.

## Stop and report if

- any value on your card is unfilled, or the file you downloaded doesn't match its SHA-256
- your operating system, browser or antivirus shows a security warning, or blocks the file
- an installer asks for administrator rights. The one exception is the Linux page's P4
  `sudo apt install` of the `.deb` whose hash matched
- APT's plan removes, upgrades or downgrades a package, or installs anything other than
  `orca-desktop`
- anything asks you to run ORCA with `sudo` or as root
- ORCA asks you to sign in, enter a key or token, pay, or pick an AI agent
- a folder ORCA shows you is outside your throwaway `orca-trial` folder
- anything asks you to turn off a protection: sandbox, AppArmor, SmartScreen, antivirus,
  or a permission
- files change outside `orca-trial` and the app's own install location, or you think data
  could be lost
- you're unsure whether something already happened. Don't repeat it to find out.
- you're uncomfortable for any reason

When you stop, write down the step you reached. Then use [when something goes
wrong](when-something-goes-wrong.md) to close ORCA safely and collect only safe details.
You don't need to reproduce a failure. Please don't retry a risky one.
