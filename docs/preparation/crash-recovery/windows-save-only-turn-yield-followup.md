# Recovered export turn attribution and bounded verification - 9 October 2026

The later [current successful Off/On pair](windows-save-only-paired-followup.md)
adds exact-source load evidence and preserves broader timing failures. It records
the user-reported independent source review and the missing Windows C15 oracle;
remaining-gate wording below describes this earlier verification's disposition.

**The affected recovered-export 4 ms gate now passes at 3.8011 ms.** The tested
production source is `9ac669fd8b401444576fdbf39057d118d1c0cc90`, on the same draft
#596 branch. Later publication changes contain documentation/evidence only.
Production capture remains disabled; Mac and overall activation remain held.

## Attribution before changing product code

The [original save-only record](windows-save-only-followup.md) retains the
5.2331 ms failure on production source `21b615fe278f91888a68198475c6fcc6a791208f`.
Its phase maxima cannot reconstruct that specific interval: callback IDs/start/end
times were not retained, callback timing excluded the after-hook `sample()` call,
GC entries used delivery phase without entry timestamps, and its trace was removed
with the disposable profile. Native I/O elapsed maxima include asynchronous waits
and cannot be treated as main-thread blocking. There is no evidence justifying an
OS-scheduling explanation or subtraction of independent phase maxima.

One additional **unchanged-product-source** Full attribution cell ran at candidate
`fb951acdb288c7ffa0ee9032e2f4bf7bcde95182`. It retained the same current/recovered
UI preparation, picker, Save, 30 prepare/cancel repetitions, checkpoints, Off,
Full hooks/status/heartbeat/trace and exact-byte oracles. A fixed 1,024-span ring
recorded callback and observer boundaries during recovered Export; a recovered-only
500 microsecond V8 CPU sampler supplied call stacks. GC records retained actual
entry timestamps. No forced GC, heap snapshot, overlapping build/test or production
capture was used. This additional instrumentation is disclosed and not cost-free.

That cell reproduced a **4.9192 ms** same-phase recovered-export heartbeat gap.
The retained interval includes consecutive callback spans of **0.5153, 0.6451 and
3.1900 ms** before another heartbeat could run. The CPU profile records
`validateOwnedDiagnosticReport -> ControlledPayloadMemory.from -> Buffer.byteLength`
and native `Hash.update -> RecoveryController.digest`. Together with the resumed
controller's source-disposal/finalization sequence, this identifies accumulated
product completion work in consecutive microtasks as a concrete scheduling defect.
The inference is supported by the reproduced interval and stacks; it is not an
exact causal reconstruction of the original 5.2331 ms interval.

| Clipped union within each maximum recovered gap | Before fix | After fix |
| --- | ---: | ---: |
| Heartbeat wall gap, ms | 4.9192 | 3.8011 |
| Captured callback wall time, ms | 4.5728 | 3.4560 |
| Observer before/after-hook wall time, ms | 0.2817 | 0.2444 |
| Of observer: memory/status sampling, ms | 0.2504 | 0.2205 |
| Unassigned residual wall time, ms | 0.0647 | 0.1007 |
| Longest captured callback, ms | 3.1900 | 2.9468 |
| Recorded GC overlap with this gap, ms | 0 | 0 |

These are non-overlapping clipped unions, not a sum of unrelated maxima. Callback
wall time includes all work inside a callback and is not a thread-CPU measurement.
Sampling stacks are approximate; profiler startup/stop have clock brackets and
their own recorded transition costs. The residual is not attributed to OS
scheduling. The receipts cannot prove that no unrecorded native/runtime cost exists.

## Product correction and authority

Recovered Export now yields once after canonical validation/encoding and disposal
of its decrypted source, before digest/final authority admission. That breaks the
encoding/disposal/digest completion chain across main-loop turns. This does not
alter the synchronous SHA-256 algorithm, report bytes, validation/redaction,
source IDs, approved limits, consent scope, deadline or current Export path.

The main-owned frozen lease and full 4 MiB preparation reservation survive the
yield. Existing consent/document/clock/source/deadline checks execute after it;
revocation cannot return a descriptor. Three new regressions schedule Off,
document disposal and clock rollback at this exact boundary, assert no handle has
been issued and the live input/reservation remain held, then verify refusal,
final erasure and zero preparation reservation. The existing pending-write,
timeout, repeated-click, digest and native admission ordering regressions pass.

## Single verification pair

Exactly one Full and one Minimal bounded verification cell ran after the identified
fix. Full retains the additional callback/observer spans and recovered CPU sampler;
Minimal has no live byte oracle or CPU/hooks/heartbeat instrumentation. Both retain
the original synthetic 8,192-event recovered/current workload, actual production
renderer/preload/controller, separate picker/Save, 30 prepare/cancel repetitions,
periodic checkpoints, Off and seven-second minimum. No result was rerun until it
passed. Both owned-process exits and disposable-profile removals are confirmed.

| Measurement | Full | Minimal |
| --- | ---: | ---: |
| Duration, ms | 9,906.5651 | 8,355.6334 |
| Combined sampled managed increment, bytes | **27,174,818** | **16,839,518** |
| Unchanged managed gate, bytes | 33,554,432 | 33,554,432 |
| Controlled binary peak, bytes | 5,406,720 | 5,406,720 |
| Unchanged binary gate, bytes | 8,388,608 | 8,388,608 |
| Controlled bytes after Off | 0 | 0 |
| Sampled private-commit increment, bytes | 73,797,632 | 61,468,672 |
| Repetitions / periodic-busy retries | 30 / 0 | 30 / 0 |
| Recovered/current saved bytes | 950,524 / 950,469 | 950,572 / 950,490 |

Full's recovered Export heartbeat gap is **3.8011 ms**, with maximum callback
**2.9468 ms**, against the unchanged strict **4 ms** affected gate. Current Export
and repeated Export gaps are 2.8028 ms and 3.0350 ms. All four files match the
prepared length/SHA-256 and final LF, contain 8,192 events and have zero omissions.
Full also compares every saved byte with main's frozen lease. Minimal verifies
saved output after owned exit. Memory methodology remains the separate sampled
main/renderer peaks described in the original record; it is not a continuous
managed/OS peak guarantee. OS private commit is separate from the managed gate.

Four focused suites refresh the changed lifecycle plus main IPC, startup consent
and Windows refusal: **61 passed, 0 failed, 1 existing platform skip**. The lifecycle
suite has 28 passes, including the three new boundary cases. Root TypeScript,
app/main/preload build, changed-file ESLint/Prettier and whitespace pass. Prior
renderer types/CSS, unchanged preload/renderer/validation/producer/payload tests
and UI axe evidence are reused with their original source and outcomes identified;
they are not relabelled as freshly run on this source. Compiled controller and
fixture hashes, sanitized timing spans, approximate CPU stacks, test counts and
all four output digests are pinned in the
[manifest](native-packaging-evidence/windows-save-only-yield-manifest.json) and
[attribution](native-packaging-evidence/windows-save-only-yield-attribution.json).

## Remaining gates

This closes the **bounded affected recovered-export gate**, not all responsiveness
or activation acceptance. Full's Save-oracle transition gaps remain 5.2727 ms and
5.4939 ms; supplemental profiler startup/stop transitions reach 39.5307 ms and
8.9190 ms. The observer costs are reported rather than attributed to product work.
Setup reaches 10.8546 ms. Broader tails and paired execution under failures/load,
fresh independent review, manual Narrator/keyboard/disclosure, second-user isolation,
remaining expiry/network/failure/crash schedules and physical/hardware acceptance
remain. ARM64, exact-source Linux crash schedules and Mac execution are unrun.

No full suite, coverage, Actions dispatch, Vite build, merge/auto-merge, production
capture enablement, deployment, access/permission change, physical interruption or
Mac work occurred. No policy or architecture decision was needed for this fix.
The original failure and the failed attribution cell remain retained evidence.
