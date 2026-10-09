# Windows diagnostics save-only scope and evidence - 9 October 2026

**The save-only memory gate passes; strict recovered-export responsiveness remains
open.** This implements Casey's approved direction: "Okay lets skip the in app
preview, just let them save and export." It starts from exact draft #595
`af75a263efd34c8935ec72cc026fa30157c95043`, preserving its consent/recovery ancestry.
The tested implementation is `21b615fe278f91888a68198475c6fcc6a791208f`.
The publication commit adds documentation, sanitized evidence and a test-only
compiled-refusal probe API correction; production code remains exactly this source.

This is an explicit product scope change, not a passing old viewer test. The
[prior observer evidence](windows-byte-preview-observer-followup.md) remains
historical: Minimal 28,311,570 bytes passed, Full 101,839,014 bytes failed, and
native text selection added 65,739,880 embedder bytes. Those receipts are retained.
The complete in-app report viewer, text-selection requirement and associated
viewer/clipboard acceptance are superseded by the owner's direction. No memory,
report-size, event-count, privacy, consent or responsiveness threshold is relaxed.

## Implemented lifecycle

The user explicitly chooses **Export current diagnostics** or **Export previous
session**. Main authenticates and validates/redacts the source, freezes canonical
UTF-8 bytes with a SHA-256 digest, and returns a bounded descriptor. The UI shows
source, byte count, remaining lifetime and tail-loss disclosure without report
contents. **Choose destination** invokes the native picker. Only the separate
**Save report** action permits private plaintext staging and native no-replace
publication. The full destination and unencrypted-file/access/sync warning remain
visible before Save. Picking or acknowledging an unknown outcome never saves.

`prepareExport` and `cancelExport` replace preview preparation/disposal.
`readPreviewBlock`, `releasePreviewBlock`, `preparePreview` and `closePreview`
are absent from the production bridge and main handlers. The preload's isolated
byte owner, renderer byte owner, report DOM and selection code are removed.
Test-only main-byte oracles are outside the production bridge.

The existing main sender/frame/document, target epoch, consent scope and source
authority checks remain. Scope version 1 persists; removing the viewer introduces
no capture, retention or sharing expansion. A single frozen report retains the
same nonrenewing five-minute lifetime, clipped by recovered history's original
expiry. New observations cannot change its bytes or digest. Destinations are
opaque, report-bound tokens. Changing/cancelling a picker clears the old token;
late replies, unmount, expiry and revoked authority restore no Save authority.
Synchronous renderer guards stop repeated clicks before React commits busy state;
main joins a repeated Save for the same token instead of creating another write.

Cancellation immediately erases/releases main bytes when no writer is live.
Pending staging/publication retains the exact frozen input and its accounting
until actual settlement. The renderer no longer acknowledges report-text
disposal. Consent revocation before native dispatch refuses publication; admitted
work can finish after revocation and reports the real outcome. Unknown outcomes
still block new Save/acknowledgement until writer cessation and verified owned
cleanup, then require explicit acknowledgement, a still-valid prepared report
(fresh explicit preparation if revoked/expired), a fresh picker and separate Save.
User-owned exports remain outside ORCA's deletion control. Status and errors use
closed text and the shared accessible announcer; there is no upload or new sharing.

## Focused verification

Eleven affected files: **114 passed, 0 failed, 5 existing platform skips**.
The report-lifecycle file was refreshed after strengthening its cancellation
assertion. Root and renderer TypeScript, app/main/preload build, affected ESLint,
Prettier, CSS token checks and whitespace pass. The corrected compiled Windows Node
refusal probe also passes with no diagnostics files, key or picker calls; it is
separate from positive native Electron acceptance. Checks used the retained pinned
dependencies and Node 24.19.0; native measurements use Electron's Node 24.21.0.

Regressions cover default-off and persistent consent, no automatic export,
canonical validation/redaction and canary refusal, no plaintext bridge methods,
verified IPC document/target authority, frozen bytes/digest, expiry, repeated
clicks, picker cancellation, stale replies, pending input retention through
timeout/off/cancel/document disposal, altered-digest refusal and publication
ordering. Linux-only filesystem/crash schedules were adapted to main-only
ownership but were not executed on Windows; prior Linux evidence is not promoted
to exact-source evidence. The separate native UI cell passes axe for current and
recovered export controls in both themes and confirms focus on Cancel export.
Manual Narrator/keyboard acceptance remains open.

## Bounded Windows cells

The retained verified Electron 44.4.5 Windows x64 runtime, MSVC native clock/storage
binaries, current-user DPAPI, actual production preload and production diagnostics
component were reused. Production capture remains disabled; only the disposable
fixture injects its capture override. A producer records 8,192 synthetic events,
checkpoints and then ceases as an owned child; a fresh owned app promotes recovery
and records another 8,192 events. Both recovered and current reports run through
the production renderer controls, separate picker and Save. Each cell completes
30 repeated prepare/cancel exports, periodic checkpoints and Off.

Full retains async hooks, status observations, heartbeat, trace and exact saved-byte
oracles. Minimal retains 100 ms main sampling and phase-boundary renderer samples
with no live full-report oracle; its exact-output checks happen in the supervisor
after owned exit. Both have a minimum seven-second duration. No tests/builds
overlapped these cells. No forced GC or heap snapshot was used. Renderer readings
include heap, backing and embedder storage; main uses heap-used plus external,
without double-counting arrayBuffers. The combined number is the sum of separate
sampled process peaks, not a continuous managed/OS peak guarantee.

| Measurement | Full | Minimal |
| --- | ---: | ---: |
| Duration, ms | 9,708.6682 | 8,551.3857 |
| Combined sampled managed increment, bytes | **25,186,277** | **16,912,092** |
| Unchanged managed gate, bytes | 33,554,432 | 33,554,432 |
| Controlled binary peak, bytes | 5,406,720 | 5,406,720 |
| Unchanged binary gate, bytes | 8,388,608 | 8,388,608 |
| Controlled bytes after Off | 0 | 0 |
| Sampled simultaneous private-commit increment, bytes | 70,332,416 | 60,952,576 |
| Repeated exports / bounded periodic-busy retries | 30 / 0 | 30 / 8 |
| Recovered saved bytes | 950,458 | 950,421 |
| Current saved bytes | 950,295 | 950,603 |
| Events / omissions in each saved file | 8,192 / 0 | 8,192 / 0 |

Full verifies each saved file equal to every frozen main byte. All four post-exit
files match their prepared length and SHA-256, contain the final LF and have 8,192
events and zero budget/expiry/invalid omissions. Digests are in the sanitized
[results](native-packaging-evidence/windows-save-only-results.json).

**The unchanged strict 4 ms responsiveness gate fails for recovered preparation.**
Full's affected callback maxima are previous Export 3.2287 ms, current Export
2.3422 ms, repeated Export 2.5136 ms, previous Save 2.5338 ms and current Save
2.4183 ms. Same-phase heartbeat gaps are previous Export **5.2331 ms**, current
Export 2.7757 ms and repeated Export 2.9307 ms. The failing gap is retained without
reclassification or a threshold change. Full Save-oracle transition gaps reach
6.4482 ms and 5.2546 ms; setup reaches 16.5502 ms. These observations also leave
broader tail/current paired-load acceptance open. No causal attribution beyond
the recorded phase is established and no repeated run is used to erase the failure.

The first attempt under the task workspace failed native parent ACL verification
before launching a cell. It changed no existing permissions and cleaned its owned
state. Final cells and the separate UI cell use newly created native-verified
private profiles under the previously accepted parent. Every owned exit and profile
removal succeeds. No keys, report bodies, profile paths or execution stores are
published. The [manifest](native-packaging-evidence/windows-save-only-manifest.json)
pins code, native/compiled identities, fixture hashes and check receipts.

## Remaining acceptance and publication limits

Fresh independent review, strict recovered-export responsiveness, broader tail and
current paired execution under failures/load, manual Narrator/keyboard/disclosure
review, second-user isolation, remaining expiry/network/failure/crash schedules and
physical/hardware acceptance remain. Viewer feasibility, native report selection
and in-app report clipboard checks are retired requirements by owner scope change,
not claimed passes. Windows ARM64 native execution and Mac acceptance are unrun;
Mac stays held. Production capture stays disabled.

This is an integration-only draft against
`calcifer/m10-m21-m22-same-boot-config-integration`. Author and committer remain
Calcifer Schadewitz `<schadewitzcalcifer@gmail.com>`. No full suite, coverage or
Actions dispatch, merge/auto-merge, main publication, deployment, new access or
physical interruption was performed. No automatic upload or new sharing is added.
