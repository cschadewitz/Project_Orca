# Proposed budgets and one-shot lifecycle

All limits remain proposals. No product runtime, capture performance, memory, disk, key,
network or native-device measurements were made. The offline checker validates a shape,
not resource isolation.

## Synthetic size evidence

The six unchanged committed valid fixtures are 934–1,227 bytes. On 2026-10-03 a local
Python calculation used the baseline validator's canonical `export_bytes` and
`validate_bytes`, starting with `fixtures/valid/missing-data.json`:

- Set 64 aliases to `e1`–`e64`, kind `admission`.
- Repeat event `{offsetMs: window, phase: startup, code: startup_exited_before_handshake,
  entityAlias: unknown}`.
- For `one_shot`, use window 60,000 and 32 events: **9,445 bytes**, validator accepted.
- For `rolling_snapshot`, use window 86,400,000 and 256 events: **42,480 bytes**,
  validator accepted.

These are reproducible synthetic shapes, not maximum-size proofs or realistic event rates.
They support retaining 256 KiB as a defensive parser/report ceiling rather than a target.
Do not pad reports, expand the allowlist or read logs to fill space. A tighter ceiling can
be considered after real safe-producer fixtures exist; any increase needs review.

## Recommended first-beta profile, subject to owner review

| Bound | Proposal and reasoning |
| --- | --- |
| Export | Keep 262,144 uncompressed bytes including canonical whitespace/final LF; enforce before parse, plus closed-schema depth/type/semantic checks. No archive bypass. |
| Collection | One immutable current snapshot per explicit consent, at most 32 eligible safe events and 64 aliases. Prefer immediate snapshot; do not wait 60 seconds to accumulate history. No pre-consent event retention or timer-driven session collection. |
| Active preparation | Keep 2,000 ms as an initial abort ceiling to test, not a proven performance SLA. One attempt, no queue/automatic retry. No CPU-heavy work on execution paths. |
| Grant | End acquisition when the snapshot is ready; 60 seconds is the absolute consent-to-preparation bound, not a background capture window. Abort on cancellation, authority uncertainty or timeout. |
| Ready preview | At most 600,000 ms; cancel/back/restart/unsafe elapsed time invalidates earlier. Saving uses a separate still-valid preview/save grant bound to those immutable bytes. |
| Persistence | Zero persistent one-shot history. Keep minimized bytes in bounded main-process memory; only explicit save creates an operation-owned protected temp file and final local JSON. |
| Overload | Drop diagnostics with honest omission/unknown information, or reject the report. Never block work, repair state, extend collection, spill raw data or retry execution. |

Collection grant expiry and preview expiry are distinct states: the one-shot acquisition
grant ends at readiness, while the explicitly disclosed preview/save permission continues
only for the reviewed snapshot's bounded lifetime. Before implementation, D2/D6 must resolve
this distinction in the original state wording so a live preview neither reacquires data nor
accidentally claims an ended acquisition grant permits new collection.

## Rolling stays deferred

The existing 2 MiB / 2,048 events / 24 hours are unapproved. At 512 serialized bytes per
event, 2,048 events alone reserve 1,048,576 bytes, leaving 1,048,576 bytes under 2 MiB for
metadata, ciphertext overhead, references and all operation-owned temp files. This arithmetic
is feasible only if the actual encoding and simultaneous write/cleanup peaks fit; it is not
a storage benchmark. A simple full-copy rewrite could exceed the ceiling. Reserve overhead,
bound references and prove peak usage before any future implementation.

Twenty-four hours materially increases exposure and can include overnight use; it is not
needed for the recommended manual snapshot. Any future rolling proposal must justify the
support benefit, renewed explicit opt-in, independent diagnostic key/platform protection,
retention including sleep, restart-off, revocation and verified cleanup. No key creation,
cryptographic implementation or persistent access configuration belongs to this work.

## Exact bytes and local storage

Main owns one validated canonical byte buffer, its length, digest and private generation
token. Preview displays all bytes and derives summaries from that buffer. Renderer-supplied
JSON, hashes, raw paths or arbitrary source selections are not authority. A local digest
binds the frozen preview to the save operation; it is not anonymization and is not exported.
Changing destination never recollects or reserializes.

Recheck consent/save token, buffer identity, current authority and destination immediately
before publication. An owner-only exclusively created temp file and atomic non-overwriting
publication must preserve reviewed bytes without a path or permission TOCTOU. Reject symlink/
reparse substitutions, unsafe ancestry/ownership, inherited broad ACLs, existing filename
and unsupported filesystem semantics. Never chmod unrelated user directories.

Windows requires tested DACL/owner handling; POSIX mode bits are not a Windows guarantee.
The existing protected execution helper skips some mode checks on Windows and must not be
presented as diagnostic export security. Saved JSON is intentionally plaintext under the
tester's access controls; encryption of hypothetical rolling history would not protect a
deliberately shared export.

Cancellation before publication removes only operation-owned temporary files; after the
atomic commit, report the saved file honestly. Failed cleanup is visible and bounded; never
claim secure erasure on SSDs/backups or recall of recipient copies. No external diagnostic
traffic, automatic attachment or sharing action accompanies save.
