# Manual diagnostics implementation decision packet

Preparation for [#436](https://github.com/cschadewitz/Project_Orca/issues/436), under
[#416](https://github.com/cschadewitz/Project_Orca/issues/416). Source reviewed 2026-10-03:
main `e8678ebaa06f4deb883143df288275300f762b3e`, containing #421/#430's corrected
contract. This directory adds decisions and implementation ownership, not implementation.

**All original D1–D8 decisions remain pending.** No capture, export feature, rolling
retention, upload, keys/services, runtime modification or tester operation is authorized
by this preparation. #416 remains a hard pre-Mac-beta gate. #417 uploads and #418 remote
requests are later stages, not first-beta requirements. #409 safe error precision is
independent and does not authorize collection.

## Four questions for Casey

Ask these separately if easier. The recommendations below are proposals, not recorded answers.

1. **For the first beta, should diagnostics only prepare a one-time snapshot when the
   tester asks?** Recommend yes: default off, explicit “Allow once,” current safe facts
   only, no background or rolling capture. This sacrifices pre-failure history to
   minimize retention and simplify consent. Rolling history stays deferred, with its
   own future opt-in. Even one-shot collection must disclose scope before starting.
2. **May that snapshot include only the listed versions, connection/failure categories,
   bounded timings and omission counts?** Recommend yes, with unknowns shown honestly.
   Exclude prompts, code, outputs, titles, credentials, paths, free-form errors, logs,
   audit records and private identifiers. Metadata can still identify someone in a
   four-person cohort. Keep build revision unknown unless its public-release provenance
   is independently established; a private repository commit is not a public identifier.
3. **Should the tester review the entire exact file, choose its local destination, and
   separately decide whether and with whom to share it?** Recommend yes. No automatic
   send, prefilled issue/email, server, crash dump or remote control. Explain synced-folder
   risk and that recipient copies cannot be recalled. For uncertain admission, failed
   resume or unavailable protected state, stop and escalate to Casey; never retry or
   repair work merely to gather evidence.
4. **Is an unsaved snapshot limited to this attempt, discarded on cancellation/restart,
   and expired after at most ten minutes acceptable?** Recommend yes, with a 256 KiB hard
   report ceiling, no persistent one-shot history, and earlier invalidation when authority
   or elapsed time becomes uncertain. A deliberately saved file remains under the tester's
   control. Keep the proposed 2 MiB/24-hour rolling policy unapproved and deferred.

Answers approve product/privacy/support intent only for the exact reviewed revision.
Engineers must still resolve D1 resource evidence, D3 provenance, D4 platform security,
D5 authority, D6 byte/UI correctness and D8 native acceptance. Tester consent and workplace
sharing permission are separate; Casey's approval supplies neither.

## Decision mapping and scope reconciliation

| Question | Original decision mapping | Engineering review still required |
| --- | --- | --- |
| 1 | D2, one-shot portion of D1 | Producer lifetime, cancellation, resource isolation; explicitly amend future #416 scope if rolling is deferred |
| 2 | D3 | Exact schema/provenance and current authorized observations; unknown gates remain mandatory |
| 3 | D6, D7 | IPC/destination/race controls, accessibility, support runbook |
| 4 | D1, D2 | Benchmarked deadlines/memory, bounded cleanup, platform filesystem checks; D4 rolling crypto deferred, not approved |

The original contract includes rolling-mode design and tests. Recommending a one-shot-only
first implementation does **not** silently remove #416 acceptance or mark rolling-related
requirements satisfied. After an explicit owner decision, the integration owner must record
which rolling requirements are deferred and retain applicable one-shot filesystem tests.
Do not change D1–D8 status in the previous directory as part of this PR.

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
