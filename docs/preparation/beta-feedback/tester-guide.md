# Trying ORCA: a short feedback guide

> **Superseded diagnostics wording, 27 October 2026**
> ([#786](https://github.com/cschadewitz/Project_Orca/issues/786)): mentions of a #416
> *preview* below predate the owner's 9 October Save/export-only decision. There is no
> in-app report viewer, and current source keeps production capture disabled
> (`DIAGNOSTICS_PRODUCTION_ENABLED = false`). Do not ask testers to preview, enable or
> export diagnostics. For Windows/Linux private candidates use
> [private-candidate-windows-linux](../private-candidate-windows-linux/README.md).
> The content below is otherwise unchanged.

**Preparation draft, not an invitation.** Before use, Casey or your agreed test
coordinator must supply the tested candidate, matching setup instructions and a
private support contact. You can stop, skip any question or decline all feedback
and diagnostics. That does not disable normal ORCA use. Agreeing to test does not
give anyone permission to install software, access your computer or use your files.

## Before you start

Use only the agreed disposable sample workspace, with no personal or workplace
material. Follow the candidate's installation instructions supplied through the
[#389 getting-started guide](https://github.com/cschadewitz/Project_Orca/issues/389).
That link tracks guide preparation; it is not a finished installation guide.
Use the agreed [first-job fixture](../native-mac-testing/fixture-contracts.md#safe-sample-inputoutput),
not a real project. The fixture is proposed until confirmed in the candidate.
If either is missing, mark **blocked** and ask the coordinator; do not improvise.

Mac testers should be able to follow the final guide without Terminal commands.
Windows testers should use the coordinator's candidate-specific Windows instructions;
the Mac instructions do not establish Windows support. Technical experience is not
a reason to bypass a warning or change authentication settings. Missing Windows
instructions also means blocked.

## Try, then compare

Follow the [first-success checklist](first-success-checklist.md), one step at a
time. Say what you hoped to achieve in ordinary words without copying your prompt.
Before approving anything, read what it will do and whether approval is once or
ongoing. If that is unclear, leave it unanswered and stop. Review the result and
any diff/test evidence locally: a green status alone does not prove the result is
right. Record any hint from a person or agent; needing help is useful feedback.

## When to stop

Stop for an unverified publisher/security warning, unexpected credentials or cost,
the wrong workspace, unexplained file changes, possible data loss, or a request to
disable protection, grant broad access or use a real project. Do not retry work
whose outcome is uncertain, repair files/stores, restart agents or update software
to collect feedback. Report the stage and a safe summary to Casey through the
agreed private contact. You need not reproduce a risky failure. Stop whenever you
are uncomfortable, even if no error appears.

## Where and what to report

Send the optional [copyable report](report-template.md) to **Casey through the
private contact supplied for your session**. If no route was supplied, keep it
locally and ask the coordinator before sharing. Do not put personal reports on
public GitHub. The coordinator can turn a reviewed, content-free summary into an
issue. Report successes, confusion and wrong results as well as crashes. “Unknown,”
“not tested” and “prefer not to share” are all useful answers.

Share only your own short description and information you choose to supply. Exclude
credentials, prompts, code/diffs, agent output, full paths, raw logs, screenshots,
workplace data and personal identity. Copy only a separately identified safe error
code; if unsure, write “unknown,” not the surrounding error text. Hardware/OS details
can identify someone in a four-person group; leave them out if you prefer.

The only diagnostic route, **once available and validated in your candidate**, is
[#416's manual preview and local export](https://github.com/cschadewitz/Project_Orca/issues/416).
It must show the exact contents, omissions and local destination before you choose
to export; cancel if unsure. Exporting does not share anything. Sharing is a
separate choice of recipient and destination; recipient copies cannot be recalled.
No automatic attachment/upload, raw-log substitute or remote access is part of this
guide. If the feature is unavailable, submit a text report without diagnostics.
