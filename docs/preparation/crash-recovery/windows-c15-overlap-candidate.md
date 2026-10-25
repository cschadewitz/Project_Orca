# Windows C15: bounded real-work overlap correction

This is a test-only draft for parent review before any Windows dispatch. It does
not establish C15 acceptance. Product source remains
`95ee280be309d50f29b46cb66a12d480fdfc8a7d`, tree
`8bf5c38903ec0bc13c7c8a313068ba378bda3230`. The branch starts from freshly fetched
main `41e4da4f8847b34f6a062ead842102d39f6f7898`.

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
observed-entry promise. The supervisor records monotonic start/end intervals
around each spawned CLI's lifetime. Every one of the 20 entries must belong to
one of those intervals. Completion, startup, receipt waits and the inter-demo
gap are never extended to satisfy a cell. Entries in the inter-demo gap or at/
after the final exit are rejected. These intervals prove concurrent CLI process
execution, not continuous CPU use or an exact engine-node transition; that is
the same execution scope as the original paired proof.

The monotonic check avoids comparing the unrelated origins of `performance.now()`
in the supervisor and Electron child. The legacy elapsed assertion is retained
as an additional legacy requirement; the nanosecond interval check is
necessary to establish overlap. A portable test runs actual subprocess work and
checks its clock values against parent-recorded intervals. Windows Node/Electron
clock comparability and the full corrected campaign still require the reviewed
Windows run; portable tests cannot establish them.

## Preserved boundaries and verification

All 20 original faults, 128 pressure attempts per stall cell, fault operation
limits, cleanup assertions, memory baseline placement, 2 ms sampling and memory
budgets remain unchanged. There is no GC, baseline reset, Off subtraction,
security/activation change or production source modification. The diagnostic
observes memory throughout both demos with the same baseline and budget. A
larger workload can expose a memory failure; no such failure is hidden or waived.

`candidate.json` pins the changed supervisor, child, portable tests and new
`tools/windows-c15/overlap.mjs`; product commit/tree, compiled inventory, native
source and Electron archive pins remain unchanged. Staging seals the exact
harness HEAD and manifest at runtime, so no circular precomputed harness commit
pin is introduced.

Portable coverage accepts a complete 20-entry overlap during two actual bounded
subprocess computations and rejects a short workload, entries between demos,
missing timestamps, incomplete cells/workloads, failed CLI members and overlapping
sequential intervals. The original receipt, adversarial bounds, inventory,
workflow and historical cell-parity tests remain. Final verification results and
any compiler/environment limitations are reported with the draft PR. No workflow
is dispatched by this change. Hosted synthetic scope, physical/native failure
limits, sampling limits, deferred timing and the Mac hold remain in force.
