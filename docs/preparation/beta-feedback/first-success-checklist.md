# First-success checklist

> **Superseded diagnostics wording, 27 October 2026**
> ([#786](https://github.com/cschadewitz/Project_Orca/issues/786)): mentions of a #416
> *preview* below predate the owner's 9 October Save/export-only decision. There is no
> in-app report viewer, and current source keeps production capture disabled
> (`DIAGNOSTICS_PRODUCTION_ENABLED = false`). Do not ask testers to preview, enable or
> export diagnostics. For Windows/Linux private candidates use
> [private-candidate-windows-linux](../private-candidate-windows-linux/README.md).
> The content below is otherwise unchanged.

Use with the [tester guide](tester-guide.md) and matching candidate instructions.
This records a journey; it does not replace the
[#403 physical test matrix](../native-mac-testing/test-matrix.md).
All rows start **not tested**. Choose **pass** only for something observed,
**fail** for a tried step with the wrong result, **blocked** when a prerequisite
prevents trying it, or **not tested** when skipped/declined. Record a short reason
and any hint needed. A later pass never erases an earlier failure or help received.

| Step | What to check locally | State / reason / help received |
| --- | --- | --- |
| S1 Install | The agreed candidate installs and opens using its matching Mac or Windows guide without a security bypass. | not tested |
| S2 Setup | Setup completes using only the agreed disposable sample data; cancellation or uncertainty is recorded. | not tested |
| S3 Authenticated connection | The candidate shows a connection to the intended authorized daemon. Do not infer authentication from merely seeing a window or disable authentication to proceed. If the approved display/guide cannot establish this, mark blocked and ask the coordinator. No token or endpoint is copied. | not tested |
| S4 Workspace and agent | The displayed workspace is the intended disposable one, and the selected agent is the agreed fixture or separately authorized agent/version. No private path or project name goes in the report. | not tested |
| S5 Launch | The agreed first job starts once and its status is understandable. If uncertain whether it started, stop rather than submit it again. | not tested |
| S6 Approval understood | Before choosing, you can explain the action and whether permission is once or ongoing. Use only the agreed gate/permission fixture. No prompt encountered means not tested, not a pass. Unclear scope means stop without answering. | not tested |
| S7 Review evidence | Review the result and any expected diff/test evidence locally. Record which evidence exists and whether it supports the change; never paste it into feedback. A report-only sample has no code diff/test proof: say so. Missing required evidence is fail; unexercised diff/test review remains not tested. | not tested |
| S8 Verify intent | Compare the actual result with the intended task and the fixture's expected result, not just the status. Record met / partly met / not met / unknown. A completed run with the wrong outcome is fail here. | not tested |

Use the existing [safe sample contract](../native-mac-testing/fixture-contracts.md#safe-sample-inputoutput)
for the first job and [gate/permission fixtures](../native-mac-testing/fixture-contracts.md#gate-permission-and-failure-fixtures)
for S6, once supplied and validated in the candidate. Do not recreate those fixtures
or substitute a checkout demo when the packaged sample is absent. A real-agent job
requires separate authorization, including sign-in/cost and workspace scope.

Report the states, evidence limits and **intent met** separately. Do not label the
whole journey successful while required steps are blocked, failed or not tested.
The optional report may be sent without diagnostics. For diagnostic acceptance,
#390 separately consumes #416's validated preview/export/cancel walkthrough and
privacy tests; completing S1-S8 cannot satisfy that gate.
