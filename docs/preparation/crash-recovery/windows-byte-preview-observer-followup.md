# Preview allocation attribution and observer correction - 9 October 2026

> Casey subsequently approved removing the in-app preview and keeping explicit Save/export. The [save-only implementation and acceptance](windows-save-only-followup.md) supersede the viewer requirement and next-step choice below. These original viewer measurements and failed Full gate remain historical evidence; they are not reclassified as passing.

**Minimal now passes 32 MiB; Full remains blocked.** The corrected final cells at
`05b651add9b88609eef617e29d67d873843af177` measure **28,311,570 bytes** in Minimal
and **101,839,014 bytes** in Full versus the unchanged **33,554,432-byte** gate.
Production code remains exactly at `2346bc539ae25a3448d21e86448546b6c905c7c4`;
the correction changes a test observer and its regression, not preview semantics.
The [initial #595 evidence](windows-byte-preview-followup.md) and receipts are
retained. Their Minimal allocation interpretation is superseded below.

## Established causes

The initial fixture's readiness check used `pre.textContent.length` to distinguish
the reusable hidden view from a ready preview. That getter materializes the
**complete report string**. Polling therefore added repeated whole-report
plaintext copies to Minimal, contrary to its stated no-plaintext-oracle scope.
This was an instrumentation error, not evidence that accessible byte owners were
still holding every retired report. The earlier interpretation was too broad.

The test-only `hasCompleteDiagnosticPreview` helper now checks the existing
wrapper's structural visibility. The component exposes that wrapper only after
the complete owner has loaded. A regression makes `report.textContent` throw and
verifies that ready/closed polling never calls it. No Save or accessibility oracle
was removed. Native selection, full Save/Range text comparisons, status hooks,
heartbeat, trace and every original Full observer cost remain included in the
final Full cell. This is an explicit correction of unintended polling copies,
not a threshold change or a switch to a cheaper acceptance workload.

Three separate bounded attribution probes used 30 previews with production
transport intact. These are **diagnostic probes, not acceptance**; the first two
intentionally suppress parts of rendering to isolate allocation:

| Probe | Main increment | Renderer increment | Combined bytes |
| --- | ---: | ---: | ---: |
| Transport, no decoded strings or report DOM data | 19,316,264 | 9,374,851 | 28,691,115 |
| Transport + decoding, report DOM writes suppressed | 15,940,055 | 11,902,738 | 27,842,793 |
| Production transport + decoding + DOM, structural polling only | 20,107,590 | 11,571,574 | **31,679,164** |

The third probe leaves the complete production report and its DOM unchanged; it
removes only the full-text polling read. The renderer falls from the original
39,714,638-byte Minimal increment to 11,571,574 bytes. Process peaks and natural
collection timing vary, so these separate probe totals are not exact copy-count
subtractions. They establish that transport/decoding/DOM alone did not impose the
previous approximately 32 MiB accumulation of report backing strings.

A separate cumulative allocation sample, at 32,768-byte intervals and including
collected objects, estimates 160,382,092 main and 14,726,520 renderer allocation
bytes. Main includes crypto string decoding, serialization and snapshot
Buffer-to-string conversion. Renderer includes bridge/invoke/proxy work and
React work. These estimates are cumulative allocations, not retained memory or
continuous physical peaks; they do not establish a leak or strong retainers.
No forced GC or heap snapshot was used.

## Full native-selection lower bound

The remaining Full cost was isolated in bounded selection probes. The refined
probe used the same complete 950,614-character report and separated focus from
native selection. Renderer readings were taken before DOM Range text, after
Range text, after focus and after the unchanged native select-all oracle:

| Stage | JS heap bytes | Backing bytes | Embedder bytes |
| --- | ---: | ---: | ---: |
| Before Range | 2,798,872 | 3,740,048 | 1,972,872 |
| After Range text | 2,812,620 | 3,740,201 | 1,972,872 |
| After focus | 2,813,964 | 3,740,259 | 2,220,216 |
| After native selection | 2,848,604 | 4,691,823 | **67,960,096** |

Range text alone does not cause the large increase; focus adds only 247,344
embedder bytes. Native selection then adds **65,739,880 embedder bytes**, and the
measured renderer-only increment after that step is **70,343,299 bytes** relative
to its baseline. Both exceed 32 MiB even if
main were reduced to zero. This is a concrete observed lower bound for the
**current DOM presentation and native-selection operation**. It is not a proof
that every possible accessible byte-backed viewer is impossible.

The large cost appears during native selection of the complete offscreen report.
The readings attribute it to embedder storage; they do not identify a specific
native allocator or establish which layout/shaping structure owns every byte.
It is not one of the explicitly admitted byte copies. JavaScript owner erasure
cannot retire that allocation. Full later
falls to 2,497,112 embedder bytes after Off and natural collection; this supports
a transient engine allocation finding, not a claim of permanently retained DOM.
No such reclamation is assumed before the measured peak.

More main-only or byte-disposal tuning cannot close this Full result. The smallest
next scope decision is to **allow a different exact-text rendering/selection
surface**, while retaining every report byte, readable accessible content,
selection, exact Save and consent/privacy boundaries. A bounded feasibility
prototype must first demonstrate the unchanged 32 MiB Full gate with native
selection included; a browser-native read-only editor is one candidate, not a
promised result. The existing one-scroller/in-document presentation and keyboard,
Narrator, clipboard, reflow and selection behavior would need explicit review.
No alternate viewer or relaxed gate is silently adopted here.

## Final unchanged bounded acceptance

The existing Electron 44.4.5 / Node 24.21.0 Windows x64 runtime, verified MSVC
native binaries, current-user DPAPI, actual production preload and production
component were reused. The same 8,192-event capture, prior promotion after owned
producer cessation, separate picker/Save, 30 repeats and Off ran in native-created
private disposable profiles. Full retains native selection; Minimal has no live
plaintext oracle. Sampling cadence, binary allocator, process accounting, minimum
seven-second cells, hooks and profiling-disabled acceptance are unchanged. No
tests or builds overlapped the final cells.

| Measurement | Full | Minimal |
| --- | ---: | ---: |
| Duration, ms | 11,069.6641 | 9,210.5453 |
| Main heap-used + external increment, bytes | 27,439,411 | 16,694,401 |
| Renderer heap + backing + embedder increment, bytes | 74,399,603 | 11,617,169 |
| Sum of independent process peaks, bytes | **101,839,014** | **28,311,570** |
| Continuous controlled binary peak, bytes | 6,340,608 | 6,340,608 |
| Controlled bytes after Off | 0 | 0 |
| Simultaneous OS private-commit increment, bytes | 159,330,304 | 77,705,216 |
| Saved report bytes | 950,125 | 950,709 |
| Saved events / omissions | 8,192 / 0 | 8,192 / 0 |
| Completed repeats / busy retries | 30 / 0 | 30 / 0 |

Main callback maxima are previous Preview 2.9391 ms, current Preview 2.3480 ms,
repeated Preview 2.4277 ms and Save 2.5099 ms. Same-phase main gaps reach
**2.8593 ms** for current Preview and **2.8146 ms** for repeated Preview, preserving
the affected strict 4 ms result. All setup and transition costs remain, including
10.6814 ms across previous Preview/oracle/current Preview. Broader strict tail and
current paired-load acceptance remain open.

Full verifies Save equal to every displayed byte including final LF. Both
post-exit supervisors verify 8,192 events and zero budget/expiry/invalid omissions.
Minimal's live Save comparison remains absent. Export SHA-256 values are
`68e7e4aaf58a2591d0813ecf27258c596bcb2f99cd8ec3fad094c7d0f2407b21`
and `d55361d30e9fc656ab7b7179767cfc03dc588f021cdc40d00118d22150738368`.
Native selection still suppresses the final LF; DOM Range and Save preserve it.
All final and diagnostic owned exits and disposable profile removals succeeded.

Only the affected renderer file was rerun: **27 pass, 0 fail, 0 skip**, extending
the existing DOM erasure test with the structural polling guard. Renderer types,
affected ESLint/Prettier and whitespace pass. The previous 114 focused cases,
one existing platform skip, root types, app/preload build, CSS and both-theme axe
results remain valid at their original pin because production code is unchanged.
No full suite, coverage or Actions dispatch was run.

The [manifest](native-packaging-evidence/windows-byte-preview-observer-manifest.json)
pins compiled/native identities, fixture hashes and
[final cells](native-packaging-evidence/windows-byte-preview-observer-results.json),
[attribution](native-packaging-evidence/windows-byte-preview-attribution.json) and
[checks](native-packaging-evidence/windows-byte-preview-observer-checks.json).
No keys, report bodies, profile paths or execution stores are published.

Draft #595 remains against the existing integration branch. #591/#593 ancestry,
author and committer Calcifer Schadewitz `<schadewitzcalcifer@gmail.com>`, production
capture disabled, no-CI/no-merge/no-main-publication/no-deployment/credentials/
physical-interruption constraints and the Mac hold are preserved. Full memory,
viewer feasibility/review, broader tail/paired load and the previous independent,
manual accessibility/clipboard, second-user, expiry and hardware gates remain.
