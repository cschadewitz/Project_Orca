# Current save-only Windows pair and remaining acceptance - 9 October 2026

Later on 9 October, the [C15 harness follow-up](windows-c15-paired-followup.md)
retained one stopped failure pair and one stopped stall pair. C15 stays held;
the final fixture corrections are runtime-unrun. The owner deferred meeting the
4 ms target in [#597](https://github.com/cschadewitz/Project_Orca/issues/597), without
changing thresholds or accepting the earlier timing observations below.

**The single current Off/On execution pair, exact exports and sampled memory pass;
broader responsiveness and C15 failure/stall acceptance remain held.** This tests
exact draft #596 source `5fac1a05a56152861ca08168da0b052f56e8cbae`. Production source
is unchanged from `9ac669fd8b401444576fdbf39057d118d1c0cc90`; subsequent publication
adds documentation/evidence only. Production capture stays disabled and Mac held.
The owner-approved removal of the viewer is a scope change, not a passing old
viewer test. Earlier failures remain in the [original record](windows-save-only-followup.md)
and [turn-yield attribution](windows-save-only-turn-yield-followup.md).

## Capacity, fixture selection and boundaries

Before running: 12 logical processors, reported CPU load 0%, 33,463,424 KiB total
visible memory, 14,053,552 KiB free physical memory and 74,915,868,672 free disk
bytes. No heavy job overlap was observed or introduced; unrelated processes were
left running. One Off member followed by one On member ran sequentially, without
repeating accepted cells or changing product code.

The existing successful paired execution supervisor was reused with the current
Full save-only fixture: production renderer/preload/controller, native x64
DPAPI/storage/clock, synthetic 8,192-event recovered/current reports, native picker
and separate Save, 30 prepare/cancel repetitions, checkpoints and Off. Only its
start/done synchronization, metadata and post-exit exact-output verification were
adapted. Full retains the fixed 1,024-span ring, hooks/status/memory/heartbeat/trace
and recovered-only 500 microsecond CPU sampler used for prior attribution.

The supervisor launches `node packages/cli/dist/main.js demo --dir <disposable
fixture execution> --keep --quiet` in an isolated synthetic profile with the
existing scripted provider. The CLI has a 50-second bound; the owned fixture's
done polling has a 45-second bound, receipt polling 54 seconds and owned-exit
confirmation five seconds. Diagnostic work overlaps the CLI process lifetime,
then waits after Off. This does not prove each export overlapped a particular
executing CLI step or sustained diagnostic stress throughout the whole demo.
Only the synthetic checkpoint producer received an intentional owned-process exit;
no physical interruption, real execution store, prompt, credential, network
endpoint or deployment was used. All owned exits and disposable-state removal
are confirmed.

The execution packages `cli/core/engine/agents/store/daemon/protocol` have no source
diff from the prior accepted paired source
`49a21254dfb02dfce5182902a317298a644bc560`. The current controller and renderer
bundle hashes equal the prior post-yield manifest. Native identities, compiled
entry and retained local harness hashes are pinned in the
[paired manifest](native-packaging-evidence/windows-save-only-paired-manifest.json).

## Current pair and exact outputs

| Measurement | Off | On |
| --- | ---: | ---: |
| CLI exit code / artifact count | 0 / 29 | 0 / 29 |
| CLI elapsed time, ms | 41,942.0136 | 41,638.3387 |
| Main managed sampled increment, bytes | 4,172,715 | 23,129,999 |
| Renderer managed sampled increment, bytes | 0 | 2,454,248 |
| Combined diagnostic managed increment, bytes | 4,172,715 | **25,584,247** |
| Unchanged managed gate, bytes | 33,554,432 | 33,554,432 |
| Controlled binary peak, bytes | 0 | **5,406,720** |
| Unchanged binary gate, bytes | 8,388,608 | 8,388,608 |
| Controlled bytes after Off | 0 | 0 |
| Sampled private-commit increment, bytes | 5,402,624 | 71,864,320 |

Both semantic artifact signatures are
`ec72d1f4cd300ea6fd291cd29fc79179a48f91522ff16dce73a4dc3a34fea6ba`.
The `docs`, `login-api` and `schema` work items finish identically. The reused
normalization excludes generated identity/provenance/timestamp metadata and
normalizes generated IDs/time strings, preserving kind/name, semantic front matter,
prose and multiplicity. Raw-ID signatures differ as expected. This proves one
successful semantic pair, not complete execution-graph equivalence, a latency
distribution or behavior under diagnostic faults.

Recovered Save is **950,474 bytes**, SHA-256
`3a96ae7b0cf2fd282aa51b6db4ccd213791aef5435c60a9ef5baab5564ae06ff`;
current Save is **950,299 bytes**, SHA-256
`4f9febe75c8e8b60f2095241f2993657be94389f53cf5e03a0aedbed912c8681`.
Both match the frozen length/digest, final LF, 8,192 events and zero omissions
after owned exit. Full also compares saved bytes directly with the main-owned
frozen lease. Thirty prepare/cancel repetitions and zero legacy content calls pass.

Managed memory uses independently sampled main `heapUsed + external` and renderer
heap/backing/embedder increments; `arrayBuffers` is not added twice. Their sum is
not a continuous peak guarantee. The separate CLI process is outside diagnostic
main/renderer accounting. Private commit/RSS include other native/runtime costs
and do not use the managed gate. See the full
[paired receipt](native-packaging-evidence/windows-save-only-paired-results.json)
and [summary](native-packaging-evidence/windows-save-only-paired-summary.json).

## Timing passes and retained failures

| On same-phase observation | Heartbeat gap, ms | Longest callback, ms |
| --- | ---: | ---: |
| Recovered Export | **3.7781** | **2.9220** |
| Current Export | **3.1722** | **2.5121** |
| Repeated Export | **3.0560** | **2.6017** |
| Recovered Save | 2.7439 | 2.5720 |
| Current Save | 2.6323 | 2.4702 |

These export samples pass the unchanged strict **4 ms** gate. Within the maximum
recovered gap, clipped unions are callback wall time 3.2402 ms, observer hook time
0.2757 ms (sampling 0.2546 ms), unassigned residual 0.2622 ms and recorded GC
overlap zero. These are overlapping-interval-aware unions, not unrelated maxima
subtracted from a gap. Callback wall time is not thread CPU; the residual has no
assigned OS scheduling cause. The sanitized approximate CPU profile is
[retained](native-packaging-evidence/windows-save-only-paired-cpu.json).

**The whole observed 4 ms envelope fails.** Every over-gate callback, heartbeat
and trace statistic remains in the receipt and summary, including:

| Retained observation | Value, ms | Attribution limit |
| --- | ---: | --- |
| Off setup heartbeat / callback | 9.0785 / 8.8863 | Setup remains unattributed; no product or OS cause asserted. |
| On checkpoint-to-recovered-export heartbeat / checkpoint-labelled callback | 42.1383 / 38.7079 | Fixture starts the CPU profiler before changing phase; the callback label does not establish a product checkpoint cost. |
| On profiler-stop transition heartbeat / callback | 9.2611 / 7.6951 | Profiler stop interval; every millisecond is not individually attributed. |
| On recovered Save-to-cancel heartbeat / callback | 5.4745 / 5.2146 | Includes synchronous fixture read, byte equality, digest and JSON output checks. |
| On current Save-to-cancel heartbeat / callback | 7.4192 / 6.9436 | Includes the same exact-output oracle. |
| On renderer `Layout`, one of 12 events | **6.9860** | Retained process summary lacks timestamps/thread IDs; cannot map it to a phase or dismiss it as fixture cost. |

Known fixture work explains why profiler/output intervals cannot be treated as
isolated product costs; it does not erase their failed observations. Renderer
Layout and setup require further attribution before broader responsiveness can
close. Trace durations aggregated by process/name do not establish main-thread
blocking. Native I/O maxima (for example replace 78.3639 ms and sync 52.9533 ms)
include asynchronous waits and are not callback blocking measurements. No
speculative optimization or additional run-until-pass attempt was made.

## Proven, failed and unrun

| Gate | Current disposition |
| --- | --- |
| Successful current semantic Off/On pair, frozen output, sampled managed/binary limits and export-phase 4 ms samples | **Proven once** on exact `5fac1a0`; details and limits above. |
| Whole observed 4 ms envelope / renderer Layout and setup attribution | **Failed / open**; original, attribution and current failed samples retained separately from passing export-phase samples. |
| Focused source checks | **Reused**: 61 passes, zero failures, one platform skip plus changed-source types/build/lint at production `9ac669f`. Earlier 114 passes/five skips, unchanged renderer types/CSS and UI axe evidence retain their original source/outcomes. No broad checks repeated for this evidence-only change. |
| Independent source review | **Reported passed by the user** for exact `5fac1a0`, with no blocking save-only issues. This run did not execute another independent review or clear native/privacy/activation gates. |
| C15 failure/stall paired execution | **Unrun: Windows paired oracle missing.** Controller-model stall/refusal/pending-write/lease tests and native parked-export cleanup are useful reused evidence, not C15 proof. |
| Remaining native expiry/network/failure/crash schedules; manual Narrator/keyboard/disclosure; second-user isolation; ARM64/physical; exact-source Linux crash schedules | **Unrun / remaining gates.** |
| Mac, production capture, full suite/coverage/Actions/Vite build | **Held / unrun** under the approved scope. |

The concrete C15 gap was reported before adapting the successful supervisor:
there is no Windows fixture combining concurrent execution semantics with every
failing/stalled diagnostic operation and independent settlement, cleanup and
accounting oracles. Existing Windows native probes are standalone or exercise
parked-export cleanup; the relevant recovery-authority/crash suites are Linux-only.
No substantial new fault-injection harness was built. A separately scoped safe
Windows paired fault oracle is required; this is not a manual/hardware decision
for Casey. Manual/hardware acceptance remains with its existing owners.

No source fix, threshold change, new access/credential, second-user experiment,
physical interruption, Mac work, production capture enablement, full CI, merge,
auto-merge or main publication occurred. Overall activation stays held.
