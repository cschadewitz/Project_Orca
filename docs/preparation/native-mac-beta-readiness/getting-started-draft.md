# Getting started with ORCA on your Mac

**Guide draft awaiting a tested candidate.** This is versioned source for #389's
existing Project Orca Hub. It is not a download page, invitation or tested UI walkthrough.
The coordinator must bind it to the tested candidate before publishing. Labels below
were audited on 2026-10-09 at #567 `9ac19ead4347180e44be6162a41d2d5726b3f929`,
with #569 `1a2e003e04beaa2e13cd35115faa6c4234145264` ownership restrictions.
These separate draft heads are source observations, not a packaged UI or hardware pass.
No contributor commands are part of the intended tester journey.

For the later guided session, use the short [operator checklist](operator-checklist.md).
Mac availability, a testing invitation and product approval do not grant device access,
installation permission or permission for each OS/agent action.

## Get the agreed version

Use the private download page supplied for your session. It must identify the tested
Apple Silicon candidate, its version and verification information. Do not choose a
different build or follow an unsolicited replacement link. The coordinator must say
which macOS/chip combination was tested; M3–M5 target support alone is not evidence
your combination has passed.

Download the agreed arm64 Mac installer, follow its installation steps and open ORCA
normally from Finder. If macOS reports an unverified publisher, invalid signature or
another security refusal, stop and report the stage to Casey through your session's
private support contact. Do not remove quarantine, change system protection or follow
a workaround from contributor documentation. Private download access must not require
repository/source access, and no repository token belongs in the app or a download URL.

## Choose a disposable workspace

The coordinator supplies an already prepared disposable Git project and a separate
empty writable app folder, both owned by the isolated test account and containing no
personal or workplace files. The project must have an attached branch and recorded base;
setup does not create a Git project. Missing Finder-visible Git is a blocker, not an
instruction to install tools or change PATH without agreement.

In **Config → Dedicated project setup**, choose **Choose project and empty workspace**.
Select the prepared project first, then the separate empty app folder. Review both
locations, the prepared branch/base and sample identity before **Create reviewed sample
files**. Then choose **Connect selected local workspace**. ORCA should start and
authenticate its own local daemon. You should not need an ORCA contributor checkout,
Terminal daemon, credential paste or hidden shell setup. Stop if the target is wrong.

Cancel or go back if you are unsure. Retry only after correcting the named setup problem.
Declining diagnostics must not block ordinary setup. Setup writes `orca.config.yaml`
and `first-run/` sample files into the selected app folder; daemon history is under its
`.orca` store. Local authentication and ownership evidence also stay in that app folder.
App preferences and protected intents/diagnostics use Electron's separate user-data
location, whose actual native location must be supplied for this candidate. Do not open,
copy, move or delete authentication/protected stores, journals or keys to resolve a problem.

The current app's **File → Open a store…** opens existing history in read-only mode.
It does not create the writable sample workspace. If **Dedicated project setup** is
absent, stop and report the missing control. Do not use your home folder as a substitute.

The bottom bar names the connection state, such as **connected**, **file mode**, or
**disconnected**. **Connect to a daemon…** opens connection settings, with **Use the
bundled daemon** and **Cancel**. The native beta should use its bundled local daemon;
you should not need to fill in **Daemon URL** or paste credentials. Those controls
alone do not prove the intended workspace was selected or that it is safe to write.

## Try the harmless sample first

Open Config's **Launch work**, or **⌘K → Launch or recover work**. Choose **Choose harmless
launch smoke check**, then **Preview launch**. Review the workspace, workflow and fixed
task, and the permission-policy checkbox, then choose **Launch** once. This reviewed
sample is `orca-beta-local-check`, version `1`; the coordinator supplies its exact revision.
If the sample/control is absent or disabled, mark the step blocked. JEV is not included
in supported beta setup or workflows.

A run may be running, waiting for your answer, succeeded, failed or cancelled. Read the
displayed status word and inspect the run. This agent-free sample succeeds when this
attempt reaches **succeeded** with the message “Harmless local sample completed. No agent
was started and no project files were changed.” It records a local run marker; it does
not produce an output artifact or test a coding fix. Its prepared result file describes
expectations and cannot be reused as evidence of this attempt. No agent, gate or tool
permission request runs in this sample; those require separate accepted exercises.
If a gate asks for approval, read its consequence; an answer to a workflow gate is distinct
from permission for an agent tool. A one-time permission does not grant standing access.
Do not choose an ongoing grant merely to get through the sample.

Cancel through the tested app control when needed and wait for confirmed cancellation.
Partial edits may remain. An uncertain result is a reason to stop, not to submit again.
A deliberate new attempt needs its own disposable copy and identity; it must not reuse
the earlier result as proof of success.

The older **Start or recover a run** palette action still exists; the guided sequence
above uses **Launch or recover work**. If **Preview launch**, **Launch**, or required
**Recover original launch** controls are absent, mark the walkthrough blocked.
**Abandon retained run intent** does not cancel existing work and must not be used as
a recovery shortcut for an uncertain result.

## Use a real agent only by agreement

The coordinator must identify the supported tool/adapter/version, verify Finder-launch
availability and supported sign-in, and obtain your agreement to this one run. Existing
provider subscriptions or credentials, possible prompt/code transmission, who pays,
spending limit and stopping plan must be explained before work starts. ORCA should not
install or sign into an agent silently or request your secrets in the renderer.

For the [prepared first coding task](../beta-first-job/acceptance.md), use only its
disposable shipping-fee repository and agreed prompt. Review the minimal diff and test
result. The repository's offline reference fix demonstrates the exercise, not a real-agent
or installed-app pass. Unsupported tools, expired sign-in, wrong architecture/version,
missing executable or unexplained PATH problems need the tested preflight recovery route;
do not add broad permissions or read unrelated files to work around them.

## Recover and ask for help

For a wrong workspace, denied folder, lost connection, missing agent or expired sign-in,
stop writes and use the candidate's named recovery action. If the action is unavailable
or its outcome is unknown, report the stage and separately identified safe code. Never
copy the surrounding raw error, token or private path. Locked or unavailable protected
state requires escalation; deleting journals or resetting Keychain can destroy recovery.

If the app was lost during local-daemon startup or cleanup, #569 can refuse the same
workspace until ownership is reconciled. Its source has no supported orphan-recovery
command; #570's integration owner must supply one before this journey is accepted.
**Recover original launch** repairs a retained intent, not daemon ownership. Preserve
the old workspace and report the stage. Another empty workspace starts independent
new work; it does not recover the old run. Repeated Connect or restarts are not a fix.

Updates should follow the tested #387 flow: approve the specific update, then let the
app install it automatically when its accepted safe-state conditions hold. Actual control
names, deferral and recovery steps await that owner's signed N-to-N+1 validation. Do not
manually replace software or attempt restore while work or a draft is active on the basis
of this draft. Use only the approved candidate-specific recovery instructions.

Diagnostics, once validated in this candidate, are optional and separate from ordinary
use. Rolling capture starts off and requires explicit opt-in. Preview the exact allowlisted
report, omissions and local destination before choosing local export; cancel if unsure.
Export does not upload or share. Sharing is a separate choice of recipient and destination,
and recipient copies cannot be recalled. If diagnostics are unavailable, a short text
report is enough; do not substitute raw logs, screenshots, prompts, code or agent output.

Current source calls this section **Local diagnostics**, with **Keep off** and
**Enable local diagnostics**. It currently states that production capture is unavailable;
enabling the setting does not prove diagnostics were collected. The completed guide must
match the native-validated preview/destination/**Save**/**Cancel** controls. Do not enable
capture or export merely to complete an instruction that the candidate cannot support.

Send optional feedback to Casey through the private contact supplied for your session.
Use the [short tester guide](../beta-feedback/tester-guide.md) and
[report template](../beta-feedback/report-template.md). If the support destination was
not supplied, keep the report locally and obtain it before sharing. You can stop testing
or decline feedback without granting anyone machine access or workplace-sharing authority.

## Publication and walkthrough checklist for the coordinator

Before putting this prose into the existing Hub, bind it to the exact signed candidate,
private download route, tested OS/chip and supported sample/agent, actual first-run and
launch control names, local data locations, updater owner's tested procedure and #416's
validated consent/preview/export/cancel behavior. Keep Hub access unchanged and check
download links as an invited user without implicit source access.

Have a target-like participant follow the published candidate-matched guide without
hidden coaching under #390's separately agreed physical session. Record hints and failed
instructions, revise the prose and preserve blocked/fail outcomes. Signed N-to-N+1,
protected-key recovery and manual diagnostic privacy remain hard acceptance gates.
Publishing a guide alone completes none of #385/#386/#388/#390/#416.

The app integration owner supplies the final coherent candidate head, native paths,
real-agent configuration persistence/rebind and #570 recovery through root. The pinned
local launch sample cannot substitute for `beta-first-job-v1`, gate/artifact/cancel
fixtures or a real-agent pass. Exact controls/source pins and remaining publication
fields are listed in the [acceptance runbook](acceptance-runbook.md).
