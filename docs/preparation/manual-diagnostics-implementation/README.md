# Manual diagnostics implementation decision packet

Preparation for [#436](https://github.com/cschadewitz/Project_Orca/issues/436), under
[#416](https://github.com/cschadewitz/Project_Orca/issues/416). Source reviewed 2026-10-03:
main `e8678ebaa06f4deb883143df288275300f762b3e`, containing #421/#430's corrected
contract. This directory adds decisions and implementation ownership, not implementation.

**Owner direction recorded 2026-10-03: configurable pre-trigger rolling metadata,
default five minutes.** This supersedes the earlier one-shot-only recommendation.
Only product direction/default is approved; all remaining contract details require review.
Original D1–D8 statuses are unchanged. No capture, export feature, rolling
retention, upload, keys/services, runtime modification or tester operation is authorized
by this preparation. #416 remains a hard pre-Mac-beta gate. #417 uploads and #418 remote
requests are later stages, not first-beta requirements. #409 safe error precision is
independent and does not authorize collection.

## Approved direction

Casey requested an x-minute pre-trigger buffer, configurable and defaulting to five minutes
rather than one, to retain useful context before issues. This is a product decision, not
permission to start collection, install software or operate a tester's device.

Recommend minimized **volatile** history with explicit tester opt-in before collection,
default off and off again after restart. Those lifecycle choices remain proposed.
A later export cannot reconstruct pre-consent history. Process crash/restart loses an
in-memory buffer and unsaved preview; persistent crash survival needs a separate bounded
storage/privacy/security decision.

## Remaining owner choices

1. **Keep the exact metadata allowlist?** Recommend versions, connection/failure categories,
   bounded timings and omission counts, with unknowns shown honestly. Exclude prompts,
   code, outputs, titles, credentials, paths, free-form errors, logs/audit and private IDs.
   Metadata may still identify someone in this four-person cohort. Private commit hashes
   stay unknown unless public-release provenance is established.
2. **Require exact-file preview, chosen local destination and separately chosen sharing?**
   Recommend yes; no automatic send, issue/email attachment, dump or remote control.
   Explain synced-folder and recipient-copy risks. Uncertain admission, failed resume or
   unavailable protected state stops with Casey escalation, never diagnostic retry/repair.
3. **Use volatile bounded history and separately expiring previews?** Recommend yes,
   with configuration range and resource ceilings reviewed before enablement. Five minutes
   is approved as default; a proposed 1–15-minute range, 1 MiB complete serialized report
   budget, separately bounded event count and ten-minute preview remain proposals.

See [sizing and safeguards](budgets-and-lifecycle.md). Neither 256 events nor 256 KiB is
adequate as an unquestioned five-minute policy: at one event/second the old 256-event cap
already drops history. The recommended new budget must be reconciled across buffer,
preview and export rather than retaining a smaller hidden export cap.

## Mapping to original review decisions

- D1: configurable five-minute default is decided. Configuration range, byte/event/alias
  ceilings, deadlines, preview expiry and measured heap/CPU overhead remain pending.
- D2: rolling product direction is decided. Tester opt-in, session lifetime, volatile-only
  retention, expiry and separate snapshot/save permission remain proposed.
- D3: exact fields, provenance and identifiability remain for review.
- D4: rolling encryption/key decisions are deferred only if volatile-only is accepted.
  Native export permissions remain required; no execution-key reuse.
- D5: producer ownership/current authority is engineering review.
- D6/D7: immutable preview/local save/sharing and support copy remain for review.
- D8: native candidates, consented executors and physical acceptance remain open.

The original contract contains persistent rolling design, 24-hour limits and a 256-event/
256 KiB export schema. This packet does not edit that schema or mark its tests satisfied
by the proposed new profile. Before implementation, freeze a reconciled contract revision
and explicitly identify deferred persistent-storage requirements. Approval of the default
does not approve every D1–D8 detail, tester consent or workplace sharing.

## Artifacts and evidence boundary

- [Producer inventory](producer-inventory.md): sources, unsafe fields, authority and main/integration differences
- [Budgets and lifecycle](budgets-and-lifecycle.md): synthetic size evidence and reversible limits
- [Ownership and acceptance](ownership-and-acceptance.md): ordered technical slices and test gates

Existing [contract](../manual-diagnostics-contract/contract.md), [safe failure mapping](../manual-diagnostics-contract/failure-mapping.md),
[privacy](../manual-diagnostics-contract/privacy-and-storage.md), [preview](../manual-diagnostics-contract/preview-and-consent.md),
[fixtures](../manual-diagnostics-contract/fixtures/README.md) and [D1–D8 matrix](../manual-diagnostics-contract/acceptance-and-handoff.md)
remain the complete input. This packet does not replace them.

Current cohort planning is two semi-technical Mac testers and two technical Windows testers.
M3–M5/current macOS is target context, not a certified OS/model floor. Actual model/OS/build
and participant consent are still required. Personal Apple publisher enrollment remains
pending; no signing, installation or physical acceptance is claimed here.
