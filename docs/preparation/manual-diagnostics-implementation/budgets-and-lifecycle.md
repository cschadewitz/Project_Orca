# Five-minute rolling buffer: sizing and safeguards

## Approved direction versus estimates

On 2026-10-03 Casey requested configurable pre-trigger rolling metadata, default five
minutes rather than one. Only that direction/default is approved. Runtime collection,
tester consent, durable storage and resource ceilings are not approved by this decision.

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

The 300/3,000-event rows are byte calculations, **not valid bundles under the current
schema**. The 30/256-event cases can be validated unchanged. This shape uses roughly
145 serialized bytes/event plus 4.8 KiB of envelope and all 64 aliases, not a maximum-size
proof. Existing six valid fixtures are 934–1,227 bytes. Earlier examples with different
offset digits measured 9,445 bytes at 32 events and 42,480 bytes at 256.

Keeping the old newest-256 cap would omit 44 of 300 events at one/second, leaving about
4 minutes 16 seconds of events; at ten/second, only about 26 seconds. We must not present
that cap as adequate full-window coverage or silently retain it beneath a bigger buffer.

## Proposed revised safeguards, not approved limits

| Resource | Recommendation requiring review |
| --- | --- |
| History duration | Approved default five minutes; propose configurable 1–15 whole minutes initially. Final range needs product/engineering review. |
| Byte budget | Propose **1 MiB for the complete canonical uncompressed report**, coordinated with rolling retention and preview. Reserve envelope, aliases, formatting and omission metadata within that ceiling. Do not cap the buffer at 1 MiB of raw event records and then add unbudgeted serialization overhead. |
| Event budget | Propose an independently tested starting ceiling of **4,096 safe events**, subject to producer-rate/heap measurement; whichever byte/event bound is reached first wins. This accommodates 3,000 events in the measured synthetic shape, not arbitrary 10/sec payloads. |
| Per event | Existing 512 serialized-byte ceiling remains a candidate. At 4,096 such records, events alone would be 2 MiB, so the 1 MiB byte ceiling binds earlier. Never truncate free text into a safe-looking field. |
| Alias/index budget | Keep explicitly bounded maps; original 64 export aliases needs workload review. Excess entities can cause visible omissions even when bytes/events fit. Never leak raw IDs or claim complete coverage. |
| Collection | Off until explicit tester session opt-in. Volatile minimized metadata only; no raw history, logs, audit, disk spill or key access. Restart is off. This lifecycle is proposed, not implied by approval of the default. |
| Preparation/preview | Proposed 2-second active preparation deadline, one attempt, and ten-minute frozen preview maximum. Final deadlines require measurement/review. No automatic retry or snapshot refresh while saving. |

The 1 MiB/4,096-event proposal is intentionally reversible and is not silently installed in
the existing schema. D1 review must select matching producer, validator, preview and export
bounds. If a byte/event ceiling evicts data, show the requested window, actual retained
coverage and omission/saturation/unknown counts. If export preparation must drop anything
else, disclose that additional loss separately. Never claim the configured duration
guarantees all evidence or a root cause.

Before enablement, measure safe event rates under startup, connection churn, multi-run
load and bursts; inspect actual serialized distribution and peak heap including ring,
indexes, validation and frozen preview copies. A serialized cap is not a heap guarantee.
Bound work before allocation, remove oldest eligible observations or drop new ones with
visible omissions, and leave execution unblocked. Do not broaden data collection to
fill a budget or use compression to mask overflow.

## Duration changes, expiry and crash behavior

Decreasing the window immediately expires older records. Increasing it permits future
retention only, never resurrects expired/pre-consent events. Use monotonic elapsed time
accounting for sleep. Clock uncertainty, opt-out or restart conservatively invalidates
history. Normal time-based eviction is distinct from capacity-based omission.

A volatile buffer disappears when the process crashes or restarts, along with unsaved
previews. It cannot guarantee post-crash diagnostics. Persistent crash-surviving storage
would need a separate bounded retention design, platform encryption/independent key
review, native ACL tests and approval before implementation. The old 2 MiB/24-hour
persistent proposal is not approved by the five-minute default decision.

## Preview, save and sharing remain separate

Explicit tester session consent may allow rolling collection to continue while a separate
snapshot is previewed. Main freezes one validated canonical byte buffer, length, digest
and private generation token. Later events cannot alter it. Save intent applies only to
those bytes; destination changes do not recollect, refresh or extend expiry. Opt-out
invalidates collection and unsaved preview/save authority.

Renderer-supplied JSON, digest, raw path or arbitrary source selection is not authority.
Recheck save token, immutable buffer, current observation/resource authority and destination
before publication. A local digest binds bytes, does not anonymize, and is not exported.
Expiry discards unsaved bytes and cleans operation-owned temps under the reviewed policy,
with a fixed notice; report failed cleanup honestly.

Require owner-only exclusive temp creation and atomic non-overwriting publication, with
symlink/reparse/ancestry/ACL race defenses. Reject broad inherited rights, unsafe ownership,
existing filename and unsupported filesystem semantics. Windows needs actual DACL evidence,
not POSIX mode claims. Do not chmod unrelated directories. Saved JSON is deliberately
plaintext and remains under tester control. Sharing is a later tester action; no automatic
network, email or issue upload occurs. Cancellation after publication cannot undo or
recall a file already saved/shared.
