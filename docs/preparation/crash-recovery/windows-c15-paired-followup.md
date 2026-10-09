# Windows C15 fault/stall fixture and stopped comparisons - 9 October 2026

**C15 remains held.** A focused Windows harness now exists, but its single failure
and single stall comparisons stopped at fixture defects. All four CLI members
finished with 29 identical semantic artifacts; this does not accept the unrun
diagnostic operations or the missing On managed-memory measurement. No comparison
was repeated after a failed cell. The final source corrections are runtime-unrun.

This starts at PR #596 head `7d7d503317c9bc2ae5bb3e3ec972e59f28a2e849` and reuses
production source/output at `5fac1a05a56152861ca08168da0b052f56e8cbae`. Product source
is unchanged. Capture stays disabled and Mac held. The
[successful save-only pair](windows-save-only-paired-followup.md) retains its
original outputs, memory observations and limitations.

## Scope, source review and safety

The isolated [supervisor](../../../packages/app/test/recovery-preparation/windows-c15-paired.mjs)
and [Electron child](../../../packages/app/test/recovery-preparation/windows-c15-child.cjs)
reuse the existing scripted CLI demo, semantic-artifact normalization, private
profile creation, disk injection, timeout/lease and owned-process cleanup patterns.
The planned schedule contains all 16 asynchronous `RecoveryDisk` methods, the
picker, completion metadata and two native writer dispatch seams. Each On cell
has its own disk/controller/profile; cells and Off/On members run sequentially.
This headless writer fixture has no renderer or viewer.

Source review checked admission and startup guards, timeout versus underlying
settlement, immediate logical Off, preserved charges, request pressure and cleanup.
The existing report-performance and payload-memory files ran with one Vitest worker:
**31 passes, zero failures/skips**. Final harness syntax, scoped ESLint/Prettier and
whitespace checks pass. The [source receipt](native-packaging-evidence/windows-c15/source-checks.json)
also keeps the preflight Vitest `spawn EPERM` and initial lint failures. This is
self-review and focused verification, not an independent review or full suite.

The initial temporary-parent native verification refused before any child or cell
ran. The [setup refusal](native-packaging-evidence/windows-c15/setup-temp-refusal.json)
is retained. A read-only ACL/source inspection found untrusted mutation grants on
that ancestry. Newly created native-private roots under the previously accepted
Documents parent were then used, as in the approved supervisor. Existing ACLs were
not repaired or changed. No real user file/process, execution store, provider,
network endpoint, credential, OS setting or physical interruption was used.
Native creation protects only new disposable fixture objects. Each fixture checks
an unrelated synthetic sentinel. Owned exits and exact-root deletion are confirmed
for both comparisons; no owned C15/CLI process remained afterward.

Before failure setup: 12 logical CPUs, 0% reported CPU load, 14,137,752 KiB free
physical RAM and 73,380,745,216 free disk bytes. Before stall: 2% load,
14,031,828 KiB free RAM and 73,383,264,256 free disk bytes. Both checks found zero
overlapping ORCA/build jobs. The failure launch rechecked overlap after the parent
correction. No heavy jobs were overlapped or unrelated processes stopped.

## Exact comparison outcomes

| Schedule/member | CLI exit | CLI elapsed, ms | Artifacts | Completed fault cells |
| --- | ---: | ---: | ---: | ---: |
| Failure Off | 0 | 38,151.6216 | 29 | Default-off baseline |
| Failure On | 0 | 37,867.2394 | 29 | 3 / 20 |
| Stall Off | 0 | 38,185.5057 | 29 | Default-off baseline |
| Stall On | 0 | 37,085.3402 | 29 | 10 / 20 |

Every semantic signature is
`ec72d1f4cd300ea6fd291cd29fc79179a48f91522ff16dce73a4dc3a34fea6ba`.
The `docs`, `login-api` and `schema` work items finish identically. The reused oracle
preserves kind/name, semantic front matter, prose and multiplicity while normalizing
generated identity/provenance/time metadata. It is not complete execution-graph,
retry/gate/credential-call equivalence or a latency distribution. Diagnostics and
the CLI run as separate owned processes on the same Windows host.

Failure completed `readSetting`, `readExportState` and `writeSetting`. It then
reported `fault-not-reached` for `open`: an already-enabled controller returns
before opening again. The final harness initializes this cell Off. The comparison
was kept and not repeated; the remaining 17 failure cells are unaccepted.

Stall completed `readSetting`, `readExportState`, `writeSetting`, `open`, `maintain`,
`checkpoint`, `previous`, `discardPrevious`, `cleanExit` and `cleanup`. Each parked
cell refused **128** additional prepare requests: **1,280** total, with zero added
disk calls, native dispatches or payload allocations. Each completed cell retained
one parked injection, revoked capture immediately on Off, then confirmed writer
settlement, zero reservation/binary allocation, no history/stage and bounded owned
files. Public completion took 1,001.5513-1,140.2269 ms under the injected 1,000 ms
operation timeout; these are synthetic timeout observations.

The stall campaign stopped during `writeExportState` setup, before injection. Its
destination shared the diagnostic-root string prefix and was refused by
`storage-windows.c`'s conservative prefix check. The final fixture uses
`saved-<cell>.json` beside the diagnostic root. The remaining ten stall cells,
including all Save and native-writer cases, are unaccepted. This fixes the fixture
path; no native policy or product behavior changes.

The [failure receipt](native-packaging-evidence/windows-c15/failure-results.json),
[stall receipt](native-packaging-evidence/windows-c15/stall-results.json) and
[derived summary](native-packaging-evidence/windows-c15/summary.json) retain every
completed/stopped cell and callback/heartbeat/native elapsed observation. Frozen
executed child/supervisor sources are compressed beside them; their identities and
the corrected, unrun source identities are separate in the
[manifest](native-packaging-evidence/windows-c15/manifest.json).

## Memory, fault and timing limits

No unhandled diagnostic rejection was observed in either stopped On campaign.
Failure-path writer settlement and all owned exits were confirmed. Completed cells
left no diagnostic history/stage; the current stopped cell was disposed only after
writer settlement and owned process exit. That disposal is not a passing product
cleanup oracle for the unfinished cell.

The stalled full 8,192-event checkpoint retained **3,145,728** reserved bytes and
**5,242,880** controlled binary bytes while parked, then reached zero after actual
settlement. This is below the unchanged **8,388,608** binary gate at the observed
point, not continuous native/managed allocation proof for the whole campaign.
The Off managed increments were 1,582,073 and 1,580,565 bytes. The executed child
did not emit an aggregate On managed receipt after an early stop, so the unchanged
**33,554,432** managed gate is **unproven here**. The final source now preserves this
accounting on failure; that correction was not executed. CLI memory is separate;
there is no renderer in this fixture.

Faults completed so far are injected rejections/barriers at the disk boundary over
real x64 Windows Electron/native disk/DPAPI/clock composition. They are **synthetic**,
not failed hardware, a wedged native worker, durable flush, crash or physical proof.
The planned native-write cell uses the shipping 10,000 ms timeout; it was **unrun**.
No 10-second writer/cancellation or Save/publication acceptance is inferred from
the 1-second boundary tests. Native async elapsed maxima include waits and do not
measure callback CPU time.

The owner deferred meeting the 4 ms responsiveness target in
[issue #597](https://github.com/cschadewitz/Project_Orca/issues/597). No threshold was
changed, failed observation erased or timing pass claimed. The original contract
describes main callback chunks; it does not establish a blanket renderer Layout
gate. The prior **6.986 ms Layout** remains a retained observation: only process/name
count, maximum duration and over-threshold count survive in the saved summary.
The raw trace was removed by the prior supervisor's disposable-root cleanup; the
retained CPU profile samples main recovered export. Available evidence has no
Layout timestamp/thread/phase interval, so it cannot attribute that event without
new targeted capture. No product cause or OS-noise cause is asserted, and no layout
optimization or broad test campaign was started.

## Remaining acceptance and reproduction

C15 still needs a newly authorized bounded run of the corrected failure/stall
schedules, all Save/native-writer settlement/cancellation cells and the missing On
managed receipt. Neither existing success evidence nor the partial results above
close those gates. Continuous managed/native accounting, renderer composition,
network observation, remaining native/crash schedules, manual accessibility,
second-user isolation, ARM64/physical and Mac acceptance retain their owners/status.

The fixture requires the retained verified Electron/native directory, compiled
production outputs matching the manifest and an explicitly approved private parent.
It creates no dependency install or credential. Each output directory must be fresh:
the supervisor refuses to replace an existing schedule receipt.

```powershell
node packages/app/test/recovery-preparation/windows-c15-paired.mjs <verified-electron-directory> <fresh-output-directory> failure <approved-private-parent>
node packages/app/test/recovery-preparation/windows-c15-paired.mjs <verified-electron-directory> <fresh-output-directory> stall <approved-private-parent>
```

These are follow-up recipes, not additional executions in this record. Final source
accepts descendants of the pinned PR head only when package production contents
remain unchanged, excluding the two harness files. No main publication, CI dispatch,
merge, auto-merge, deployment, Mac work, physical interruption or viewer restoration
occurred. The publication is a focused draft against the existing integration branch.
