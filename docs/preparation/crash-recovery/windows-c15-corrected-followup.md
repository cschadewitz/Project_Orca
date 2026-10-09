# Corrected Windows C15 comparisons - 9 October 2026

**The corrected synthetic failure and stall schedules complete all 20 cells;
C15 remains held because both aggregate On managed-memory measurements fail the
unchanged 33,554,432-byte limit.** No product changes, gate waiver, forced garbage
collection, timing optimization or additional comparison followed those failures.
Capture remains disabled and Mac held.

The [first record](windows-c15-paired-followup.md) retains the setup refusal and
the stopped 3/20 failure and 10/20 stall comparisons, including their frozen source
versions. The owner subsequently authorized focused regression verification and
one corrected comparison per schedule. These are corrected fixture executions,
not repetitions of the unchanged failed fixture until a passing sample appears.
All earlier evidence files remain unchanged.

## Exact source and focused verification

Both corrected pairs ran harness commit
`74a3ef441449523d110849c9d1c92aa0f61fdf83`, descended from PR #596 head
`7d7d503317c9bc2ae5bb3e3ec972e59f28a2e849`. Package product source and the verified
compiled/native composition remain unchanged from measured production
`5fac1a05a56152861ca08168da0b052f56e8cbae`. The
[manifest](native-packaging-evidence/windows-c15/corrected/manifest.json) pins
executed source snapshots, compiled/native hashes and every receipt. New evidence
is under `windows-c15/corrected`; the original manifest keeps its historical
runtime-unrun status for the earlier source correction.

The [focused regression runner](../../../tools/test/windows-c15-regressions.mjs)
uses two sequential native fixtures without a CLI execution pair. Its
[receipt](native-packaging-evidence/windows-c15/corrected/regressions.json) shows
two functional passes: the `open` cell starts Off and reaches its injection;
the old sibling destination prefix is explicitly refused while `saved-<cell>.json`
is allowed; Save completion preserves exact prepared bytes; and an intentional
stop after a cleaned cell still emits accounting with expected exit 1. Both
regression fixtures also failed the managed-memory gate, at **55,350,665** and
**37,111,361** bytes. A functional regression pass does not erase these failures.

Source review preceded execution. The previously retained focused report and
payload-memory tests remain **31 passes, zero failures/skips**, one worker.
All three harness/regression files pass syntax, scoped ESLint and Prettier checks.
The [source-check receipt](native-packaging-evidence/windows-c15/corrected/source-checks.json)
records this limited verification. No full suite, coverage, build or independent
review was added.

## Corrected paired results

| Schedule/member | CLI exit | CLI elapsed, ms | Artifacts | Diagnostic cells |
| --- | ---: | ---: | ---: | --- |
| Failure Off | 0 | 35,890.6157 | 29 | 20 default-Off baselines |
| Failure On | 0 | 40,564.6891 | 29 | 20/20 synthetic faults observed |
| Stall Off | 0 | 37,988.8603 | 29 | 20 default-Off baselines |
| Stall On | 0 | 42,225.4456 | 29 | 20/20 synthetic stalls observed |

All four signatures equal
`ec72d1f4cd300ea6fd291cd29fc79179a48f91522ff16dce73a4dc3a34fea6ba`;
`docs`, `login-api` and `schema` finish identically. Every On fault entered during
its CLI member's execution. Failure's fault campaign took **16,781.2657 ms**;
stall's took **55,234.7314 ms**, including settlement after CLI completion. Each
schedule ran once at the corrected source, with Off followed by On. These elapsed
samples are retained observations, not a distribution or deferred timing pass.

The fixed schedule covers all 16 async `RecoveryDisk` methods, the picker,
completion metadata, native publication dispatch and native write dispatch. The
[failure receipt](native-packaging-evidence/windows-c15/corrected/failure-results.json),
[stall receipt](native-packaging-evidence/windows-c15/corrected/stall-results.json)
and [summary](native-packaging-evidence/windows-c15/corrected/summary.json) retain
each operation, public outcome, deadline, cancellation, charges and cleanup checks.
Every completed cell observes exactly one injection and leaves zero reserved and
controlled binary bytes after actual writer settlement, no history/stage and
bounded owned files. Unhandled rejections and legacy key fallback calls are zero.

Stall refuses **128** concurrent prepare requests in each of 20 cells:
**2,560/2,560** refused, with zero added disk calls, native dispatches or payload
allocations. Injection outstanding peaks at one; the wrapper disk-call peak is
two where the parked call and an Off settlement check coexist. Observed native
dispatch concurrency peaks at one. Cancellation/Off immediately revokes capture
and prepared authority; maximum observed logical-Off interval is **0.5502 ms**.
This does not turn the deferred responsiveness target into a passing gate.

The stalled full checkpoint holds **3,145,728** reserved and **5,242,880** controlled
binary bytes until release. The native-write seam holds **3,145,728** reserved and
**5,275,664** binary bytes while parked. Its shipping **10,000 ms** public timeout
returns at **10,015.4774 ms**, and Off reports `cleanup_pending` while the writer
still owns those charges. The fixture then releases the owned barrier as a
rejection, independently confirms raw disk and controller settlement, and checks
cleanup. Ordinary synthetic cells use a 1,000 ms timeout. Public/Off and actual
settlement are separately bounded; no cancellation is inferred from a timeout.

The completion-record fault occurs after real native Save publication. Both
schedules retain the controller's known-saved result and verify destination length
and SHA-256 against the frozen prepared report. Other cells verify no late
destination. This is Save completion behavior under a metadata fault; it does not
prove a failing physical device or crash durability.

## Resource failure and limits

| Member | Managed increment, bytes | RSS increment, bytes | Controlled binary peak, bytes |
| --- | ---: | ---: | ---: |
| Failure Off | 1,624,693 | 10,383,360 | 0 |
| Failure On | **64,061,697** | 71,188,480 | 5,373,952 |
| Stall Off | 1,615,513 | 10,129,408 | 0 |
| Stall On | **59,414,981** | 68,890,624 | 5,373,952 |

Managed accounting samples diagnostic Electron main `heapUsed + external` at a
requested 2 ms interval and explicit boundaries; `arrayBuffers` is not added
twice. Sampling continues through the CLI wait and finalizer, including a stopped
campaign. Both On increments exceed **33,554,432** bytes. The controlled allocator
peak stays below **8,388,608** bytes; reservation peaks at **4,194,304** and returns
to zero in every cell. Passing controlled accounting does not accept the failed
aggregate measurement. RSS is separate, not a substitute for managed/native proof.

The fixture repeatedly constructs fresh controllers, payload arenas and native
roots in one diagnostic child. The retained aggregate samples do not attribute
the failed peak to product behavior versus fixture setup/instrumentation. No
subtraction, forced GC, causal excuse or threshold adjustment was made. C15 needs
this memory failure resolved within separately approved scope before closure.

Read-only capacity checks immediately before failure and stall found 12 logical
CPUs, CPU loads **2% / 5%**, free RAM **13,966,140 / 13,844,848 KiB**, and free disk
**73,377,632,256 / 73,286,193,152 bytes**. Both found zero overlapping heavy jobs.
The receipts confirm all owned exits, exact disposable-root deletion and unchanged
synthetic sentinels; the [postflight](native-packaging-evidence/windows-c15/corrected/postflight.json)
finds no remaining matching heavy job. Newly created native-private objects use
the previously accepted Documents parent. Existing ACLs, user files/processes,
credentials, OS/security/network settings and hardware were left untouched.

## Proof boundary and remaining acceptance

These are deterministic **synthetic rejection/barrier** seams over real x64
Windows Electron/native disk, DPAPI and clock. `nativePublish` and `nativeWrite`
intercept before actual backend dispatch; they do not wedge a native worker or
prove failed hardware, durable flush or physical interruption. The headless
diagnostic child and ordinary CLI are separate processes. The normalized oracle
proves semantic artifact/work-item equality here, not complete execution-graph,
retry, gate-answer or credential-call equivalence in the shipping app.

All callback, heartbeat-gap and native elapsed observations remain in raw receipts.
Meeting the 4 ms target is deferred in
[#597](https://github.com/cschadewitz/Project_Orca/issues/597); no numeric gate was
changed. The retained **6.986 ms renderer Layout** summary lacks the raw event's
timestamp, thread ID and phase. The earlier raw trace was deleted with its
disposable root; the retained CPU profile covers main export. Existing evidence
cannot attribute that interval without targeted capture. No OS-noise or product
cause is claimed, and no new layout campaign was run.

Renderer composition, continuous managed/native allocation, network observation,
remaining native/crash/expiry schedules, accessibility, second-user isolation,
ARM64/physical, exact-source Linux crash and Mac retain their existing status.
Production capture stays disabled. Publication updates draft #599 against
`calcifer/m10-m21-m22-same-boot-config-integration`; no main publication, CI dispatch,
merge, auto-merge, deployment or viewer restoration occurred.
