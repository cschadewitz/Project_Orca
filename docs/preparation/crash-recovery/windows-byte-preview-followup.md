# Windows byte-backed diagnostics preview - 9 October 2026

**Acceptance remains incomplete.** The approved architecture is implemented at
`2346bc539ae25a3448d21e86448546b6c905c7c4`, starting from exact #593
`2167df73bd531a39c290818dfde04eafde31b167` and preserving #591
`5eece6c7f863e7fe833188843355e107fa2ab3a6` ancestry. Combined Minimal memory is
**55,341,566 bytes**, above the unchanged **33,554,432-byte (32 MiB)** gate and
above the previous 45,129,835-byte result. The architecture does not close the
resource gate. Production capture stays disabled; merges and Mac remain held.

## Ownership and authority

The [architecture](../../implementation/diagnostics-byte-preview.md) replaces the
complete renderer string result with metadata and sequential newline-aligned
UTF-8 blocks of at most 16,384 bytes. Main reuses one independent block backing
store, admits renderer and transport copies before returning a descriptor, and
refuses concurrent/out-of-order reads. The complete 1 MiB report ceiling and
canonical privacy validation are unchanged. Save retains the validated frozen
main bytes and original digest, independent of the decoded view.

Preload owns its isolated-world IPC copy until acknowledgement. Renderer copies
into one bounded byte owner, decodes bounded blocks, and erases incoming copies.
Retired owned buffers are zeroed before `transferToFixedLength(0)`; runtimes
without that operation retain a zeroed fallback. This is ownership disposal, not
forced GC. One reusable MessageChannel yields between batches. The view reuses
text nodes and clears their data before Close/Off disposal acknowledgement. Every
block remains readable in one labelled, focusable `pre` while open.

Main keeps the retired renderer/transport allowance until acknowledgement or
verified document/process disposal. Pending Save bytes remain owned until actual
settlement. Exact-handle disposal cannot erase a successor. Main status revisions
and descriptor revisions reject delayed snapshots in preload and renderer;
newer revocation still fences pending replies. Read authority remains bound to
the verified window document and target epoch, while disposal may cross a
revoked epoch only from that same verified document.

The implementation changes no report grammar, redaction/privacy vocabulary,
consent setting, revocation policy, report/event limits, crypto/key routing,
native filesystem rules, preview/preparation deadlines or acceptance threshold.
It assumes neither zero-copy IPC nor synchronous engine/native reclamation.

## Final bounded packaged Windows cells

Electron **44.4.5**, embedded Node **24.21.0**, Windows x64, current-user DPAPI,
and the retained MSVC clock/storage binaries were used. Their native source
SHA-256 is `3b69d61dc07f1366167f8a151c84925a78d5b70bcc74e7835936c1984a26bdd3`;
the package manifest matches this checkout and the retained x64 manifest. The
fixture uses the final compiled diagnostics and actual production preload in a
sandboxed, isolated renderer, plus the production diagnostics component bundle.
This is a bounded component/native fixture using the retained packaged runtime,
not a newly signed installer or a full application acceptance claim.

The affected On cells retain the earlier 8,192-event scenario: native-created
private disposable profile, authenticated prior promotion after forced cessation
of only the owned checkpoint producer, current capture, separate Preview/picker/
Save, 30 checkpoint/preview/close repeats, then Off. Full retains hooks, heartbeat,
status sampling, trace and plaintext oracles. Minimal retains 100 ms main and
phase-boundary renderer sampling without the live plaintext oracle. Profiling,
forced GC, heap snapshots and heap/collection tuning were absent. No tests or
builds overlapped these cells. This does not rerun the old CLI pair or prove
current paired-load responsiveness.

The slower block lifecycle crosses the existing five-second periodic checkpoint.
The initial fixture incorrectly waited for a report after `publication_pending`.
A metadata-only trace identified this valid refusal. The final fixture retries
through the visible UI, bounded to 20 attempts, without bypassing the busy fence;
Full records nine such refusals and Minimal none. Their elapsed time and resource
cost remain included. One command session was lost after a completed earlier
Full cell; it makes no acceptance claim. Its owned main/renderer exits and named
profile removal were confirmed before the final complete supervised rerun.

| Measurement | Full | Minimal |
| --- | ---: | ---: |
| Duration, ms | 11,136.0468 | 9,210.8526 |
| Main heap-used + external incremental sampled peak, bytes | 24,652,310 | 15,626,928 |
| Renderer heap + backing + embedder incremental sampled peak, bytes | 87,047,921 | 39,714,638 |
| Sum of independent process peaks, bytes | **111,700,231** | **55,341,566** |
| Continuous controlled binary admission high-water, bytes | **6,438,944** | **6,340,608** |
| Controlled bytes owned after Off, bytes | 0 | 0 |
| Simultaneous OS private-commit incremental peak, bytes | 174,600,192 | 108,761,088 |
| Saved report bytes | 950,460 | 950,504 |
| Saved events verified after exit | 8,192 | 8,192 |
| Completed repeats | 30 | 30 |

The persistent admission is 5,242,880 bytes of existing shared arena plus
1,048,576 bytes for the renderer owner and **49,152 bytes** for three bounded
block copies: **6,340,608 bytes**. The observed Full high-water includes another
98,336 bytes of transient admitted work. All controlled storage and allowances,
including the original disk/native ownership machinery, share the unchanged
8,388,608-byte allocator gate. Actual transport/decoder/engine costs remain in
process measurements; reservations do not prove physical reclamation or bound
uncontrolled engine internals. Both allocator receipts return to zero after Off.

Minimal's largest renderer sample includes 33,567,798 backing bytes, 7,511,272
heap bytes and 3,788,880 embedder bytes. Explicit disposal of accessible owners
has not eliminated retired engine/API backing costs. These readings identify a
remaining resource blocker; they do not prove a leak or establish retainers.
Main `arrayBuffers` is not added to `external` twice, and renderer backing and
embedder values are retained. Process maxima are summed conservatively, not
claimed simultaneous; sampling is not a continuous JS/OS peak guarantee.

Full main callback maxima are previous Preview **2.9557 ms**, current Preview
**2.3731 ms**, repeated Preview **2.5285 ms**, checkpoint **1.5134 ms**, repeated
checkpoint **0.1639 ms**, and Save **2.4932 ms**. Same-phase main gaps are
**2.8674 ms** during current Preview and **3.7354 ms** during repeated Preview,
below strict 4 ms in this affected cell. All transition/setup readings remain in
the receipt, including **10.9142 ms** across previous Preview/oracle/current
Preview. Those include fixture oracle costs. This limited improvement does not
close the broader strict tail or current paired-load gate.

Full compares the complete DOM text with the saved file byte-for-byte, including
the final LF. Both post-exit supervisors parse the saved reports and verify 8,192
events with zero budget/expiry/invalid omissions. Minimal `saveExact: false`
means its live text oracle was absent. Saved SHA-256 values are
`8e3eb163d85022ea316df6eca84a2c2dd18348a067d48b100bf8b271231f35a6`
and `fd705f3f0cb57d2c75299b01907e8661133a4416d4ab20667b2ea2ebe2b57a0c`.
Fresh IDs/clock offsets explain differing bytes and hashes.

## UI, regressions and retained evidence

A separate **7,136.3759 ms** UI cell, with no repeats, verifies exact Save,
complete DOM Range text, focus and zero WCAG 2 A/AA and 2.1 AA axe violations in
both themes using the existing production `.orca`/`.orca-surface` classes.
The first standalone theme fixture lacked those classes and was corrected;
product colours were unchanged. The separate UI receipt is not resource evidence.
Its 950,579-byte, 8,192-event saved report has SHA-256
`d49cbf0145c27605982ed1f828ad48fea062a8f17a4b47b74af5e5b5ad2113bb`.

Native Chromium selection contains all visible text but suppresses the final LF;
DOM Range and Save preserve it exactly. Manual clipboard/Narrator acceptance
remains open, and this observation must not be presented as an exact native
clipboard comparison. The view remains labelled, focusable, readable and
selectable, with no omitted or paginated report text. Existing reflow evidence
remains at its prior pins; it is not renewed by this cell.

Eight focused files pass **114 tests**, fail **0**, and retain **1 existing
platform-specific skip**: the first-run selection integration case gated to
Linux. Coverage includes consent/startup, ordered reads and complete-read picker
fences, erasure/retirement accounting, cancellation/late replies, the actual
preload, stale status/successor isolation, exact UTF-8/1 MiB display, reusable DOM
node erasure and frozen Save ownership until settlement. Root and renderer
TypeScript, app/preload compilation, scoped ESLint/Prettier, CSS token checks and
whitespace checks pass. No full suite, coverage or Actions dispatch occurred.

The [manifest](native-packaging-evidence/windows-byte-preview-manifest.json) pins
measured implementation, compiled diagnostics/preload/contract, renderer fixture,
native inventory and hashes of the
[resource cells](native-packaging-evidence/windows-byte-preview-results.json),
[UI cell](native-packaging-evidence/windows-byte-preview-ui.json),
[focused cases](native-packaging-evidence/windows-byte-preview-tests.json),
[checks](native-packaging-evidence/windows-byte-preview-verification.json) and
[unsuccessful iterations](native-packaging-evidence/windows-byte-preview-iterations.json).
Raw fixtures remain local to the separate task-5 worktree/evidence directory.
All final owned exits and disposable profile removals succeeded. No keys,
plaintext report bodies, private profile paths or execution stores are published.
The previous [heap follow-up](windows-heap-churn-followup.md) and receipts remain
unchanged. Subsequent publication changes are evidence/docs only.

Self-review checked admission/release symmetry, block backing isolation and reuse,
revocation/document authority, stale closes, revision ordering, pending-read/DOM
disposal ordering, UTF-8/framing and Save independence. Independent review remains
required. The draft targets only the existing integration branch
`calcifer/m10-m21-m22-same-boot-config-integration`; author and committer are
Calcifer Schadewitz `<schadewitzcalcifer@gmail.com>`.

Remaining: **combined 32 MiB memory**, broader strict tail/current paired-load
proof, prior failure/stall and untouched-package network evidence, independent
review, manual Narrator/clipboard/selection, second-user, physical/24-hour expiry,
post-rename/pre-result and ARM64 hardware gates from the previous follow-up.
Windows first-run/updater authority is preserved. Production capture is disabled;
there is no merge, auto-merge, main publication, deployment, credentials handling
or physical interruption. Mac remains held.
