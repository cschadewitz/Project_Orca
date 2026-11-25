# Tester's physical Mac checklist

This is a future checklist for [#390](https://github.com/cschadewitz/Project_Orca/issues/390),
prepared under #403. **Nothing here has been run on your Mac.** The version, download,
setup screens and recovery instructions must come from the approved candidate and
[#389 guide](https://github.com/cschadewitz/Project_Orca/issues/389); exact button
labels are not yet frozen. Ask the test coordinator to fill those gaps before starting.

## Before starting

The coordinator records approval for this session, including the device, installation
location, separate test account/workspace, allowed screenshots, sleep/restart and any
real-agent use. Agree on who will remove test state afterward. Willingness to try ORCA
does not authorize remote access, installing software or accessing personal projects.
You can stop at any time. No remote operator is required by this checklist.

Use a separate approved Mac account and an empty folder named `ORCA Sample α`, containing
only the coordinator's synthetic fixtures. Do not select Documents, Desktop, a real
repository or a folder containing personal material. A coordinator must supply:

- The approved signed candidate, version/checksum identity sheet and invited download
  instructions, plus the getting-started guide and a named support contact.
- A verified cleanup plan for the disposable account/folders; no blanket Library cleanup.
- A copy of the [evidence template](evidence-template.md), initially all **not run**.
- For the optional upgrade section, #387's approved pair of versions and complete
  disposable backup/restore procedure. Otherwise that section stays **blocked**.

**Stop conditions:** stop if told to remove quarantine, bypass a security warning,
disable Gatekeeper, provide a repository token, paste a secret into ORCA, grant broad
disk access without an explained need, run a Terminal workaround, use a real project,
or if the app identifies the wrong workspace. Stop on unexplained file changes or
unexpected spending/account prompts. Record the visible message without exposing a
secret and contact the coordinator. Do not try to make a failed check pass by changing
security settings. A normal downloaded-app confirmation for the verified publisher is
different from an unverified-developer, damaged-app or malware block; uncertainty means stop.

## Walkthrough

For each step record expected versus actual, pass/fail/blocked, and an evidence ID.
Screenshots should contain only the ORCA test window or a cropped relevant prompt.
Keep account names, notifications and other windows out of them.

| Step / matrix IDs | What to do | Expected result and when to stop |
| --- | --- | --- |
| 1 / MAC-01 | In About This Mac, record chip/model and macOS version/build, without serial number. Download the exact candidate through the invitation instructions in a browser. Have the coordinator compare the checksum and publisher identity sheet. | Apple Silicon, approved OS and exact candidate match. No source checkout or repository account is needed. Mismatch or inaccessible download: stop, do not choose another build. |
| 2 / MAC-02 | Install through the approved DMG or ZIP instructions into the agreed location, then open ORCA from Finder. Do not use Terminal to launch it. | Normal macOS first-open behavior, verified publisher and app window. Record any Gatekeeper prompt. Unverified/damaged/malware warning: stop. The browser download's quarantine is preserved for this test. |
| 3 / MAC-03/04 | Follow first-run setup. Cancel folder selection once, go back if offered, then select only `ORCA Sample α`. Repeat setup if the guide allows it. | Cancellation makes no unwanted selection; the confirmed workspace is shown correctly and the bundled local daemon connects without shell setup. Wrong workspace, endless startup or external daemon requirement: stop. |
| 4 / MAC-06 | Choose the guide's harmless sample. Wait for it to finish, open its result and compare with the fixture text supplied by the coordinator. | Success and the exact sample report, without provider sign-in, payment or installing an agent. Record the run ID and result view. Unexpected credentials or missing sample: stop and mark blocked/fail as appropriate. |
| 5 / MAC-07 | Start the sample gate. Read the question and consequences; leave it unanswered, quit normally and reopen. Then choose Finish sample once. | The pending question survives, is answered once, and the run completes once. No publishing or real project work occurs. |
| 6 / MAC-07/13 | With the coordinator's permission fixture, deny the requested operation first. Retry and choose allow once, then repeat the same operation. For an actual macOS folder prompt, also test cancel/deny only within the agreed test setup. | Denial preserves the target file; allow once affects only the fixture and does not silently grant future access. OS prompts are explained and scoped. Record absent prompts as not observed, not as proof of TCC behavior. Never grant Full Disk Access just to continue. |
| 7 / MAC-08/11 | Start another held sample and cancel it. Run the deliberately failing sample. Use the coordinator-prepared unwritable test folder, then retry with the valid sample folder. | Cancelled/failed states are understandable, do not show false success, and offer useful recovery. No writes escape the sample folders. Do not change permissions on your own folders. |
| 8 / MAC-09 | Close the last window, then reopen from the Dock. Next use ORCA's Quit command and reopen from Finder. | Closing the window can keep the Mac app running. Explicit Quit ends the owned daemon (coordinator verifies); reopening reconnects once and keeps history/preferences. No duplicate sample runs. |
| 9 / MAC-10 | With the sample idle, ask the coordinator to perform only the approved disposable-daemon disconnect. Follow the app's documented reconnect/restart action. | Connection loss is explained, unsafe writes are unavailable, and history converges on recovery. No shell daemon or security bypass is needed. If no approved injection/recovery exists, mark blocked. |
| 10 / MAC-14 | Use the keyboard to visit controls, open/close menus and answer a fresh fixture gate. Try both themes and a smaller window. With permission, enable VoiceOver and navigate the same route. | Focus stays visible and returns from menus; statuses have words, controls have useful names, and everything can be reached/scrolled. Record defects; a screenshot alone cannot prove VoiceOver. Restore your previous accessibility preference afterward. |
| 11 / MAC-15 | Leave only the disposable gate pending, put the Mac to sleep and wake it. After approval, restart the Mac and reopen ORCA from Finder. | No duplicate execution; workspace, historical result and pending gate remain coherent. Record sleep/wake separately from restart. Do not restart with unrelated unsaved work. |
| 12 / MAC-12 | Only with separate approval, follow the guide for an already authorized local agent and a tiny disposable task. Record tool/version, test preflight and inspect its result. | Clear sign-in/tool/architecture guidance and scoped permissions. No silent installation or access to unrelated files. Credentials remain in the provider's normal local sign-in flow. No approval/account/tool means blocked, never simulated success. |
| 13 / MAC-16 | Follow #387's exact upgrade and restore checklist using only its paired candidates, disposable data and keys. Link its evidence here. | Configuration/history/pending work survive; unsafe replacement is refused; recovery matches the full backup. Do not invent a binary-only rollback or delete keys. Missing procedure or pair means blocked. |
| 14 / all | Quit, review the record with the coordinator and perform only the agreed test cleanup. | Keep a sanitized report; preserve any unresolved failure until its safe cleanup is agreed. Record leftovers. Do not uninstall another ORCA installation or remove personal data. |

The coordinator checks signature/notary/architecture/process details; the tester need not run
developer commands. Compare DMG and ZIP only in separately reset test accounts/states.
For usability acceptance, at least one target-like participant follows the published
guide without hidden coaching: record each hint needed as a guide/usability defect.
Launch, data-loss and security blockers remain open before expanding the invited cohort.
Hosted CI cannot supply this physical acceptance record.
