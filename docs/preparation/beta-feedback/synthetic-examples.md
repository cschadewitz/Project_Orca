# Synthetic completed reports

> **Superseded diagnostics wording, 27 October 2026**
> ([#786](https://github.com/cschadewitz/Project_Orca/issues/786)): mentions of a #416
> *preview* below predate the owner's 9 October Save/export-only decision. There is no
> in-app report viewer, and current source keeps production capture disabled
> (`DIAGNOSTICS_PRODUCTION_ENABLED = false`). Do not ask testers to preview, enable or
> export diagnostics. For Windows/Linux private candidates use
> [private-candidate-windows-linux](../private-candidate-windows-linux/README.md).
> The content below is otherwise unchanged.

All four reports below are invented documentation examples, **not tester evidence**.
Candidate IDs, source commits, checksums and hardware are deliberately `unknown`;
there was no packaged candidate or device execution. A real consenting tester may
supply those fields using the [template](report-template.md). No example is a
diagnostic payload or evidence of Windows/Mac support. “Safe code: unknown” avoids
claiming that today's internal errors are an approved #416 export mapping.

## Example A: sample result met intent

- Report alias: SYN-A; experience: success observation.
- Intended task/result: complete the supplied harmless report sample and recognize
  its expected result. Intent met: yes in this fictional scenario.
- App version, exact candidate/build/source, package/checksum: unknown (synthetic).
  OS/version/architecture and hardware/chip: unknown. Agent: scripted fixture;
  version unknown.
- Steps: followed supplied setup, selected the disposable sample and fixture agent,
  launched once, understood and answered its gate, then compared its report locally.
- Expected: one successful sample with the agreed report. Observed: that report
  appeared once and matched the fixture. Repeatability: one fictional attempt;
  not repeated. Safe code: unknown. Impact/stop reason: none.
- Agent help: yes, the scripted fixture produced the expected report; this says
  nothing about real-agent quality. Person hints: none in the fictional scenario.
- Local evidence: report checked; no code diff or software tests exercised.
  S1-S6 pass; S7 pass for report review only (diff/test review not tested);
  S8 pass, intent met. Diagnostics: declined; no export or sharing.
- Desired next step: none. Triage: success observation; coordinator records the
  limited fixture outcome. Physical, real-agent and diff/test acceptance stay open.

## Example B: stuck during setup

- Report alias: SYN-B; experience: stuck setup.
- Intended task/result: select the disposable workspace and reach the first sample.
  Intent met: not tested; setup prevented the launch.
- App version, exact candidate/build/source, package/checksum: unknown (synthetic).
  OS/version/architecture and hardware/chip: prefer not to share. Agent/version:
  not used.
- Steps: opened the candidate and tried to choose the sample workspace once.
  Stuck at S2. Expected: folder selection confirmed and setup continued.
  Observed: setup remained on folder selection without explaining the next step.
- Repeatability: once, not retried. Safe code: unknown. Impact: unable to continue;
  stopped instead of editing settings. Agent help: not used. Person hints: none.
- Local evidence: no result, diff or tests. S1 pass; S2 fail; S3-S8 blocked by
  setup. Diagnostics: unavailable; no export/sharing. Desired next step: explain
  how to finish selection safely.
- Triage: provisional B0 launch/setup blocker; Casey routes to onboarding owner to
  reproduce synthetically. If guidance is the cause, #389 also owns its correction.
  Ask only which generic control was attempted if the tester wishes to add it.

## Example C: agent failed to deliver

- Report alias: SYN-C; experience: agent failure.
- Intended task/result: an independently authorized agent should make a tiny change
  in a disposable example and provide test evidence. Intent met: no.
- App version, exact candidate/build/source, package/checksum: unknown (synthetic).
  OS/version/architecture and hardware/chip: unknown. Agent/version: unknown;
  authorized real-agent scenario is fictional, not an executed account session.
- Steps: completed setup, selected the intended agent/workspace, launched once,
  understood a one-time approval and waited. Stuck after S5/S6 at evidence review.
  Expected: completed change with tests. Observed: run reported failure and no
  required result was available. No output or error text copied.
- Repeatability: once, not retried. Safe code: unknown. Impact: task unfinished;
  stopped. Agent help: no completed result; reason unknown. Person hints: none.
- Local evidence: required result/diff/tests absent. S1-S6 pass; S7 fail for missing
  required evidence; S8 fail, intent not met. Diagnostics: preview cancelled;
  no export/sharing. Desired next step: understandable failure guidance.
- Triage: B1 investigation, **not yet reproducible**; agent integration owner checks
  a synthetic case and records whether product, configuration or provider caused
  it. No request for agent logs or permission to restart the tester's job.

## Example D: technically successful, wrong intent

- Report alias: SYN-D; experience: wrong intent.
- Intended task/result: in a synthetic task, add an optional behavior while keeping
  the old default. Intent met: no; the default changed too.
- App version, exact candidate/build/source, package/checksum: unknown (synthetic).
  OS/version/architecture and hardware/chip: unknown. Agent/version: unknown.
- Steps: followed setup and authorized disposable-agent instructions, launched once,
  understood approval, then reviewed the diff/tests locally. Expected: opt-in only.
  Observed: run succeeded and its tests passed, but review showed the old default
  had changed. No prompt, diff, output or tests are included in this report.
- Repeatability: one fictional attempt, not retried. Safe code: unknown.
  Impact: proposed result rejected; no publishing or merge. Agent help: partly;
  it produced work but missed the constraint. Person hints: one reminder to compare
  the outcome with intent at S8; an unassisted pass cannot be claimed.
- Local evidence: diff and tests reviewed, including their failure to cover the
  intended default. S1-S7 pass for completing those checks; S8 fail, intent not met.
  Diagnostics: declined; no export/sharing. Desired next step: preserve the default.
- Triage: B1 investigation with product/workflow owner; verify the agreed requirement
  in a synthetic reproduction, then route to bug, guidance or feature work. Technical
  completion does not count as intent success. No unsafe retries requested.
