> **Owner-approved save-only scope, 9 October 2026:** Casey directed, "Okay lets skip the in app preview, just let them save and export." The active crash-diagnostics flow prepares a main-owned frozen report, lets the user choose a destination, and requires a separate Save. No report contents, text-selection surface or report-byte transport is exposed to renderer/preload. Earlier viewer requirements below are historical and superseded for this flow; consent, canonical validation/redaction, expiry, exact saved output, privacy and numeric resource gates remain. See [save-only implementation and acceptance](../crash-recovery/windows-save-only-followup.md). Production capture stays disabled and Mac stays held.

# Five-minute rolling buffer: sizing and safeguards

## Approved direction versus estimates

The 3 October five-minute direction was subsequently refined by #469 decisions 1–9.
Current settled bounds are 1–15 whole minutes/default five, 1 MiB complete canonical
report and 8,192 events, persistent default-off explicit opt-in and bounded encrypted
same-boot recovery. See [the decision mapping](README.md). These policy choices do not
prove actual consent, resource/technical/privacy/native or physical acceptance.

Duration alone does not set size: event rate and field sizes do. Sparse metadata at
one event per ten seconds through one event per second gives a **roughly 10–50 KiB
planning example**. At ten events/second, the same synthetic shape is roughly 430 KiB.
These are uncompressed serialized JSON bytes, not measured production rates or a promised
upper bound. Actual heap is larger and unmeasured; compression is neither assumed nor
proposed as a way around expanded-byte limits.

## Reproducible synthetic arithmetic

Start from the unchanged baseline fixture `fixtures/valid/missing-data.json`, using its
validator's canonical `export_bytes`. Set mode `rolling_snapshot`, windowMs 300000,
64 entities with aliases e1–e64 and kind admission. Repeat the long-enum event
`{offsetMs: 300000, phase: startup, code: startup_exited_before_handshake,
entityAlias: unknown}`. Indentation and final LF are included:

| Five-minute assumption | Events | Serialized bytes | Old 256-event/256 KiB contract |
| --- | ---: | ---: | --- |
| One per ten seconds | 30 | 9,196 (9.0 KiB) | Fits |
| Old export event ceiling | 256 | 41,966 (41.0 KiB) | Fits |
| One per second | 300 | 48,346 (47.2 KiB) | Invalid: exceeds event cap |
| Ten per second | 3,000 | 439,846 (429.5 KiB) | Invalid: exceeds both caps |

The 300/3,000-event rows are byte calculations, **not valid bundles under the original
`e8678eb` schema**. The 30/256-event cases can be validated unchanged. This shape uses roughly
145 serialized bytes/event plus 4.8 KiB of envelope and all 64 aliases, not a maximum-size
proof. Existing six valid fixtures are 934–1,227 bytes. Earlier examples with different
offset digits measured 9,445 bytes at 32 events and 42,480 bytes at 256.

Keeping the old newest-256 cap would omit 44 of 300 events at one/second, leaving about
4 minutes 16 seconds of events; at ten/second, only about 26 seconds. We must not present
that cap as adequate full-window coverage or silently retain it beneath a bigger buffer.

## Current safeguards and remaining measurements

| Resource | Settled product bound / engineering limit |
| --- | --- |
| History duration | 1–15 whole minutes, five default; no complete-coverage promise. |
| Report bytes | 1 MiB complete canonical uncompressed report, including envelope/omission metadata; not a heap or aggregate-disk limit. |
| Events | 8,192 independent ceiling; byte or event limit can bind first. Historical 4,096 measurements do not validate this profile. |
| Per-event and alias/index work | Closed bounded inputs/maps; actual producer distributions and limits require reviewed conformance. No free-text truncation or raw IDs. |
| Collection/storage | Persistent explicit setting, default off; encrypted bounded checkpoints and separate OS-protected diagnostics key. No plaintext retention fallback. Production #470 capture remains disabled. |
| Preparation/preview | Immutable bounded preview with current authority; the original two-second preparation/ten-minute preview suggestions are historical engineering proposals, not owner-policy approvals or measured deadlines. Consume #470's exact contract instead of installing parallel limits. |

The previous packet proposed 4,096 events and session-only volatile history. Those
recommendations are preserved at its immutable historical head linked in README and
superseded by #469. The original 512-byte/event and 64-alias schema were sizing inputs,
not proof of the adopted ring's distribution or a new producer permission. Report
requested/observed/retained coverage and saturated omissions; no hidden smaller export cap.

Before enablement, measure safe event rates under startup, connection churn, multi-run
load and bursts; inspect actual serialized distribution and peak heap including ring,
indexes, validation and frozen preview copies. A serialized cap is not a heap guarantee.
Bound work before allocation, remove oldest eligible observations or drop new ones with
visible omissions, and leave execution unblocked. Do not broaden data collection to
fill a budget or use compression to mask overflow.

## Duration changes, expiry and crash behavior

Decreasing the window immediately expires older records. Increasing it permits future
retention only, never resurrects expired/pre-consent events. The accepted recovery contract uses
trustworthy same-boot elapsed age;
uncertainty must refuse/revoke affected authority rather than extend retention. Normal
time eviction is separate from capacity loss. Reboot clears recovery eligibility,
not the persistent opt-in. Restart invalidates unsaved preview/save tokens; one eligible
encrypted prior crash checkpoint may be recovered within its original 24-hour anchor.

The memory ring alone still disappears on main crash. #470 owns the encrypted recovery
implementation; this packet adds no storage. Clean exit removes current-session history;
opt-out/discard removes owned history sooner. Expired/ineligible history is refused and
cleanup attempted when ORCA runs, with failures visible. User exports remain untouched.
The earlier 2 MiB aggregate-disk suggestion is historical; consume the exact reviewed
#470 storage accounting and measure it rather than treating report size as disk proof.

## Preview, save and sharing remain separate

The persistent explicit local setting may allow rolling collection to continue while a separate
snapshot is previewed. Main freezes one validated canonical byte buffer, length, digest
and private generation token. Later events cannot alter it. Save intent applies only to
those bytes; destination changes do not recollect, refresh or extend expiry. Opt-out
invalidates collection and unsaved preview/save authority.

Renderer-supplied JSON, digest, raw path or arbitrary source selection is not authority.
Recheck save token, immutable buffer, current observation/resource authority and destination
before publication. A local digest binds bytes, does not anonymize, and is not exported.
Expiry discards unsaved bytes and cleans operation-owned temps under the reviewed policy,
with a fixed notice; report failed cleanup honestly.

Decision 9 permits one private app-owned plaintext temporary only for final Save,
and same-filesystem native no-replace publication relative to ORCA app data. Refuse
unsupported destinations. Decision 8 requires proven old-writer cessation and verified
owned-staging cleanup before a fresh preview, picker and new Save after unknown outcome.
Failed cleanup remains visible and blocks further Save; content-free key-independent
cleanup records stay bounded and acknowledged summaries disappear on opt-out after cleanup.
Require owner-only exclusive temp creation and atomic non-overwriting publication, with
symlink/reparse/ancestry/ACL race defenses. Reject broad inherited rights, unsafe ownership,
existing filename and unsupported filesystem semantics. Windows needs actual DACL evidence,
not POSIX mode claims. Do not chmod unrelated directories. Saved JSON is deliberately
plaintext and remains under tester control. Sharing is a later tester action; no automatic
network, email or issue upload occurs. Cancellation after publication cannot undo or
recall a file already saved/shared.

## Immutable historical benchmark retention (#455)

The three files at
`https://github.com/cschadewitz/Project_Orca/commit/38a50e0c0ca4465afc4ec7f6ecaef496739756b3`
were read and their Git blobs/byte digests checked on 7 October. They were **not imported**
into #470 or this packet. Implementation measured: `97097ea076044555b401d49b8e75da8cc1e42df9`;
measured harness commit: `9d8499f3b3a91692e14e9a5038975de01f8c9f4d`.

| Retained asset at immutable results head | Git blob / SHA-256 of original bytes |
| --- | --- |
| [Results prose](https://github.com/cschadewitz/Project_Orca/blob/38a50e0c0ca4465afc4ec7f6ecaef496739756b3/docs/benchmarks/diagnostics-buffer.md) | `3d9db422cd6a1b43188d3f1ff6c0914357d002a0` / `72ac9d657e3e9e3e6364f71dcd8ea88727acf953a2e173e56cc486a92640b2a9` |
| [Raw measurements](https://github.com/cschadewitz/Project_Orca/blob/38a50e0c0ca4465afc4ec7f6ecaef496739756b3/docs/benchmarks/diagnostics-buffer-results.json) | `40fa0749931c70ae2ba827504660501b88fe81c9` / `86a15e6cafce0eaa3409a9d66330af3149d34404652e4b4e84f47682704fddf6` |
| [Harness](https://github.com/cschadewitz/Project_Orca/blob/38a50e0c0ca4465afc4ec7f6ecaef496739756b3/tools/benchmarks/diagnostics-buffer.js) | `419b567834199f40ab9cf9c215d0fdcba5f12c05` / `bec6563cc6e2bf52e438e805a8252382f05839959e5b4ce9a7c0f74bfc4f483d` |

Historical Linux synthetic/logical-time/tmpfs scope: burst hit 4,096, omitted 1,154 and
retained 238.95 seconds; largest runtime export 610,453 bytes. Worst record call 15.749 ms;
burst/maximum trial-three snapshot median/max 111.164/217.017 ms. Preview/export copies
added roughly 1.48–1.75 MiB JS heap, sampled preparation growth reached 19.78 MiB, and
maximum-field schema fixture was 615,488 bytes. Keep outliers and sampled-peak limits.
These are neither physical-disk/native/paired-load evidence nor 8,192-event measurements.
The 13.65 events/s and 793,865-byte estimates are arithmetic, not increased-cap trials.
No benchmark was rerun for this docs change. Retain these original assets and provenance
before any parent-owned superseded closure of #455; closure cannot erase its limits or
establish #416/#469/native acceptance.
