# Windows C15: bounded real-work overlap correction

This updates the existing test-only draft PR #663 after product prerequisite
[#665](https://github.com/cschadewitz/Project_Orca/pull/665) passed independent review
and CI run `40208887722` at `87e8e19d5fe793e96ee62f33fb8c4d54ad88d19b`, then
merged as `14666a315b43bc859ad0b73dda92ddf280b0de10`. Fresh fetch confirmed that
merge is current main; PR #663 was still `d3543733b05335b1629dc795404b031a53a7fc66`.
Merge commit `a4b7bb4` incorporates main without rewriting the PR's history.
No documentation conflicts occurred. Main also includes test-only #666.

The deliberately selected **product source commit** is
`14666a315b43bc859ad0b73dda92ddf280b0de10`, entire source tree
`38ef685a664f8407103dff71b8a68e5a3230d4a6`. This is separate from the evolving
harness commit sealed at staging. The source incorporates reviewed store-locked
scripted-agent counter transactions and their existing consumption checkpoints.
The workflow's source checkout and `candidate.json` agree on this exact commit.
All 365 executable hashes are regenerated from its isolated frozen build; five
executable files differ from the old candidate (daemon socket, agent-step executor,
artifact/document stores and scripted agent; their exact old/new digests are
retained in the selected-source provenance report). No old digest is reused for changed bytes.
The Windows native digest was recomputed from the selected source and remains
`555b8b174c43fa2b11aa3cd16466b04a0872819d3f73f6987262e11ec7a305b5` because
those native bytes are unchanged. Compiler 7.0.2 and Electron archive pins remain.

This is still **not C15 acceptance**. Historical preparation/run-1/run-2 identities,
failures and transfer findings remain in their original records. References below
to the old source or 29/32 result describe that history. Parent owns independent
re-review, CI and any later single bounded Windows dispatch; this update dispatches
nothing.

## Diagnosis and evidence attribution

The parent supplied decisive raw-receipt findings for
[run 40199888746](https://github.com/cschadewitz/Project_Orca/actions/runs/40199888746),
harness `2ad2ce53d8425392c2eeedc40158199bd95a160b`. The parent materialized
[artifact 12601937371](https://github.com/cschadewitz/Project_Orca/actions/runs/40199888746/artifacts/12601937371)
using `github_download_workflow_artifact` followed by supported Sediment
`download_file(file_id='file_00000000bb2081f5a56145254fdf876c')` and verified
61,820 bytes, ZIP SHA-256
`ffb14af27e9ebee0bed3aeb39edcb4afc75f3964e3d69e3d0ca78ef34295a911`.
This execution environment has no exposed `download_file` tool. Its Cal artifact
fetch succeeded with a new reusable file reference, but these receipt findings
are parent-verified evidence, not a new local hash/parse. No expired URL or denied
network workaround was used. PR661 preserves the earlier transfer failure as
history and records the later evidence separately.

The only failed required stall gate is
`runs[1].allFaultsEnteredDuringExecution=false`. Both CLI and diagnostic exit 0;
`completed=true`, `diagnostic.ok=true`, all 20 cells observed, all individual cell
checks true, no unhandled rejections, `zeroAfterEveryCell=true`, owned exits and
cleanup true. Stall On managed increment is **15,787,247 bytes** against
33,554,432; controlled binary peak is **2,490,368 bytes** against 8,388,608.
CLI execution is **29,151.6431 ms**, campaign **49,566.4969 ms**; the last
`nativeWrite` enters at **29,493.7383 ms**, with public elapsed **10,014.2102 ms**.
Failure On managed increment is **18,001,619 bytes** and its overlap, correctness
and memory gates pass. Memory is not the failed stall gate. This is an overlap
proof gap, with no demonstrated product correctness defect. The failed receipts
and frozen historical scripts remain unchanged.

## Defined workload and overlap protocol

Each Off/On member now executes exactly **two complete sequential CLI demos**, in
separate fresh disposable workspaces. Both demos must exit 0 and independently
produce 29 artifacts: 58 total for each mode. The existing semantic normalization
is applied to each demo separately; corresponding semantic signatures and work
item sets must match across Off/On. The fixed count is chosen before execution
and cannot grow in response to diagnostics. There is no retry, sleep, held agent
step, completion gate or filler work. The second demo starts immediately after
the first exits, before reading any stores or computing semantic oracles.

Each CLI retains the original 50-second bound. Two actual workloads permit up to
100 seconds of CLI execution per mode. The diagnostic's existing execution wait
is correspondingly bounded at 100 seconds, with a 120-second overall watchdog
for the two workloads and receipt/exit margin. The workflow's 20-minute bound is
unchanged. These changes account for more defined work; they do not extend a
fault's operation timeout. A very fast runner can still finish too early and
must fail overlap rather than manufacture a pass.

The original `enteredMs < executionElapsedMs` assertion remains mandatory. It is
supplemented by same-host `process.hrtime.bigint()` evidence: the diagnostic
records a timestamp at the actual `arm.inject()` entry, before resolving the
observed-entry promise. **Parent spawn/exit callback brackets are insufficient:**
an independent review reproduced all 20 entries after the CLI exited while the
parent was blocked, yet before the parent's exit callback. Those brackets are
now audit metadata only and never the overlap interval.

A fixed, digest-pinned `--import` preload executes inside the unmodified compiled
CLI, preserving its original `main.js` entry/argv and direct-invocation guard.
It captures start at preload module evaluation (after its built-in imports),
and end at the beginning of its synchronous `exit` listener, before serialization
or pipe writes. It adds no timer, work gate, candidate import, engine hook or exit
interception. It does not fabricate workflow work. Each corresponding demo still
must independently exit successfully and meet the original artifact/oracle gate.

The child sends exactly one complete JSON receipt over spawn's dedicated anonymous
fd 3 pipe. There is no receipt pathname to substitute, poll late or reuse. The
parent requires EOF and successful exit within the unchanged 50-second bound;
missing, malformed, extra, oversized and signaled receipts fail closed. Receipt
schema, launch nonce, actual child PID, CLI entry, working directory, preload digest
and exit code must match the launch. Child timestamps must fall within the parent
launch audit envelope. A duplicated/substituted receipt from the other demo fails.
The binding environment variable is deleted before CLI entry and `--import` is
passed only on this CLI's argv, so scripted agents do not inherit instrumentation.
This trusts the pinned CLI and harness; it is not authentication against a malicious
process controlling its own code/pipe or a hostile runner.

Every one of the 20 fault entries must be strictly inside one child interval:
`start + 2000 ns < entry && entry + 2000 ns < end`. Exact boundaries and their
2-microsecond exclusion zones, post-exit entries and inter-demo gaps are rejected
even when the supervisor is descheduled. The precise claim is overlap
with the **CLI's captured lifecycle segment from preload evaluation to beginning
exit**, conditional on successful complete demo/oracle validation. This includes
module loading, setup, event-loop waits and CLI cleanup before exit. It does not
prove continuous CPU use, simultaneous engine work, a particular engine transition,
or exact OS process termination. The small receipt I/O after the end stamp is
excluded. Parent notification/pipe delivery delays cannot enlarge the interval.

[Microsoft's QPC guidance](https://learn.microsoft.com/en-us/windows/win32/sysinfo/acquiring-high-resolution-time-stamps)
states that cross-thread readings within one tick have ambiguous ordering;
[the QPC API](https://learn.microsoft.com/en-us/windows/win32/api/profileapi/nf-profileapi-queryperformancecounter)
documents resolution below one microsecond. The fixed **two microseconds at each
boundary** conservatively exceeds that tick and nanosecond conversion rounding.
It narrows the accepted interval; it never moves a boundary outward or admits a
near-boundary fault. No runtime calibration, artificial wait or native/product
change is added. This is captured-clock lifecycle overlap at that exclusion and
resolution, never exact physical overlap or continuous CPU activity. Node/Electron
same-host clock comparability remains a Windows verification requirement.

The monotonic check avoids comparing the unrelated origins of `performance.now()`
in the supervisor and Electron child. The original elapsed assertion remains an
additional requirement. Linux Node subprocess tests use the actual preload, pipe
collector and validator. They deterministically block parent callback delivery
while an independent child records all 20 entries 200 ms after the CLI begins
exit; the old parent bracket accepts those entries and the new gate rejects them.
A separate real inter-demo-gap case also rejects all 20 entries. Windows Node/
Electron monotonic-clock comparability, extra-pipe behavior and the full corrected
campaign still require parent review and a later reviewed Windows run. No portable
result establishes corrected Windows acceptance.

## Preserved boundaries and verification

All 20 original faults, 128 pressure attempts per stall cell, fault operation
limits, cleanup assertions, memory baseline placement, 2 ms sampling and memory
budgets remain unchanged. There is no GC, baseline reset, Off subtraction,
security/activation change or production source modification. The diagnostic
observes memory throughout both demos with the same baseline and budget. A
larger workload can expose a memory failure; no such failure is hidden or waived.

`candidate.json` pins the changed supervisor, child, portable tests and new
`tools/windows-c15/overlap.mjs`, lifecycle collector, preload and bounded parity
runner. Product commit/tree and compiled inventory are deliberately regenerated
for the selected reviewed merged source. The native digest is recomputed; native
bytes and Electron archive remain unchanged. Staging seals the exact
harness HEAD and manifest at runtime, so no circular precomputed harness commit
pin is introduced.

Portable coverage accepts a complete 20-entry overlap during two actual bounded
subprocess computations and rejects a short workload, entries between demos,
missing timestamps/receipts, substituted bindings, duplicate/oversized/malformed
pipe data, killed/failed children, incomplete cells/workloads and overlapping
sequential intervals. The original receipt, adversarial bounds, inventory,
workflow and historical cell-parity tests remain. Final verification results and
any compiler/environment limitations are reported with the draft PR. No workflow
is dispatched by this change. Hosted synthetic scope, physical/native failure
limits, sampling limits, deferred timing and the Mac hold remain in force.

## Historical d3543733 verification (old candidate, retained)

Linux Node 24.19.0 built the pinned source with the existing TypeScript 7.0.2
compiler. All **365 compiled executable files** match the unchanged manifest,
and all **14 portable tests** pass, including source/compiled substitution,
closed inventory, receipt seal, frozen campaign parity, delayed parent delivery
and real inter-demo gaps. Focused ESLint, Prettier and whitespace checks pass.
Only legitimate harness hashes and new preload/collector entries are refreshed;
all source/tree/compiler/native/Electron/compiled pins are identical to PR663's
prior `48e8145` manifest. No source or frozen history is edited.

A supplemental real compiled CLI probe is **not an artifact-parity pass**. One
preload launch exited 0 but produced 32 artifacts instead of the required 29.
A subsequent sequential comparison on the same pinned build produced 29 for an
unmodified launch and 32 for a preload launch, both exit 0 with schema/login-api/
docs work items done. These observations do not establish the cause of the
artifact difference or establish corrected workload parity. The strict 29-per-
demo/58-per-mode gate remains unchanged and would reject the 32-artifact result;
no counts are normalized away, extra demos appended or gate waived. That local
verification limit blocked the old candidate. The reviewed #665 counter correction
and the new selected-source comparison below address parity separately; they do
not explain the exact historical 32-artifact interleaving. No Windows workflow was
dispatched; parent review remains required first.
