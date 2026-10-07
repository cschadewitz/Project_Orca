# Manual diagnostics implementation decision packet

Preparation for [#436](https://github.com/cschadewitz/Project_Orca/issues/436), under [#416](https://github.com/cschadewitz/Project_Orca/issues/416).
Reconciled on 7 October 2026 against main `c1eba301702fef0466b2d3481c36d62331ee7d48` and disabled recovery
PR [#470](https://github.com/cschadewitz/Project_Orca/pull/470) at `a174e33c307ef9348412eaad69bc0df9399ad684`. The original audit was main
`e8678ebaa06f4deb883143df288275300f762b3e`; the previous packet is retained at
[#438's historical head](https://github.com/cschadewitz/Project_Orca/tree/5201922e795e6e614f427d35ffba1ee8bee82337/docs/preparation/manual-diagnostics-implementation).
This four-document change reconciles decisions and evidence; it implements nothing.

## Settled product direction

Read [decisions 1–6](https://github.com/cschadewitz/Project_Orca/issues/469#issuecomment-5976190374),
[7](https://github.com/cschadewitz/Project_Orca/issues/469#issuecomment-5976357825),
[8](https://github.com/cschadewitz/Project_Orca/issues/469#issuecomment-5976828540) and
[9](https://github.com/cschadewitz/Project_Orca/issues/469#issuecomment-5977241702) together. The bounded owner-decision
checkpoint is cleared. The earlier session-only/volatile-only/4,096 recommendations
are historical, not current alternatives awaiting another broad approval round.

- Configurable 1–15 whole minutes, five by default; 1 MiB complete canonical
  uncompressed report and an independent **8,192-event** ceiling. Capacity loss and
  effective coverage remain visible; duration never guarantees complete history.
- Persistent explicit user opt-in, offered at first start after installation and
  changeable in Settings; off by default. Restart remembers the approved setting,
  not an unsaved preview. Opening/dismissing the app is not consent; scope expansion
  requires new consent. No upload/sharing permission follows from local capture.
- One prior opted-in Electron main/full-app crash session, recoverable only within
  the same computer boot and up to 24 hours. Clean exit removes the current session
  checkpoint. Reboot/expiry refuses recovery and attempts owned cleanup when ORCA
  next runs; no deletion-at-deadline while closed or OS/power-loss survival promise.
- Approximately five-second nonblocking encrypted checkpoints with honest possibly
  missing-tail disclosure. Use a separate OS-protected diagnostics key; unavailable
  secure storage disables persistence without plaintext fallback or execution impact.
- Exact immutable preview and separate explicit local Save. Decision 9 permits one
  private app-owned **plaintext export temporary**, only for final Save, with reviewed
  same-filesystem native no-replace publication. Unsupported destinations refuse.
  This exception does not permit plaintext capture/checkpoints.
- Unknown Save outcomes remain unknown. A fresh preview, picker and separate Save
  require proven old-writer cessation, verified owned-staging cleanup and current
  authority. Timeouts/acknowledgement alone do not clear that gate. Bounded content-free,
  key-independent cleanup records contain no report or destination path; acknowledged
  summaries are removed on opt-out after cleanup completes. Preserve possible user exports.
- Opt-out fences capture/unsaved preview authority and removes diagnostics-owned
  history/key material, reporting cleanup failure honestly. User-exported files stay
  user-owned. No shared app/keychain deletion or forensic-erasure promise.

## Mapping to the original D1–D8 review

| Original area | Current disposition |
| --- | --- |
| D1 resource profile | Range/report/event product bounds settled above. Measured peak heap, aggregate disk, operation deadlines and preview lifetime remain engineering/native acceptance. |
| D2 lifecycle | Persistent default-off explicit opt-in and bounded crash recovery replace per-session/volatile-only proposals. Actual user consent, consent-version/UI and lifecycle evidence remain required. |
| D3 fields/provenance | Closed metadata/source exclusions remain; identifiability and actual producer authority need technical/privacy review. |
| D4 protection | Separate OS-protected diagnostics key and encrypted retention are settled. Native key/ACL/path, cleanup and identity evidence remain open. |
| D5 authority | Current resource/generation checks and producer provenance remain engineering obligations. |
| D6/D7 preview/save/support | Separate preview/local Save/sharing and decisions 8–9 settle bounded export behavior. Native publication, race, accessibility and disclosure evidence remain open. |
| D8 acceptance | Packaged Mac/Windows, separately consented participants and physical walkthrough remain open. |

No blanket D1–D8 acceptance is inferred. Original contract tests and historical schemas
are versioned evidence, not proof of the current product. The reconciled integration
[contract](https://github.com/cschadewitz/Project_Orca/blob/a174e33c307ef9348412eaad69bc0df9399ad684/docs/preparation/crash-recovery/integration-contract.md) and
[handoff](https://github.com/cschadewitz/Project_Orca/blob/a174e33c307ef9348412eaad69bc0df9399ad684/docs/preparation/crash-recovery/implementation-handoff.md)
belong to #469/#470; do not create a competing implementation.

## Implementation and preparation boundaries

#470 has disabled storage/controller/IPC/UI integration. Its production native adapter
refuses authority; production boot clock and diagnostic producers remain unconnected.
Current-head Node 22 CI has a recorded retry transport failure; Node 24 passes do not
clear it or validate current main. Independent exact-head/current-base review and CI
remain with the parent. Native/privacy/network/paired-load/combined-memory and physical
acceptance remain open; the recorded 4 ms work target is missed.

#441 source at `97097ea076044555b401d49b8e75da8cc1e42df9` is **semantically adopted**
into #470 with the 8,192/schema reconciliation; it is not Git-merged. Keep #441 open
until the replacement #470 merges. #455's files were read, not imported; immutable
provenance and historical limits are retained in [budgets](budgets-and-lifecycle.md).
The parent owns any superseded disposition after verifying durable evidence retention.

- [Producer inventory](producer-inventory.md): safe sources, exclusions and authority.
- [Budgets and lifecycle](budgets-and-lifecycle.md): original arithmetic and current bounds.
- [Ownership and acceptance](ownership-and-acceptance.md): coordinated handoff and gates.

Existing [contract](../manual-diagnostics-contract/contract.md),
[privacy](../manual-diagnostics-contract/privacy-and-storage.md),
[preview](../manual-diagnostics-contract/preview-and-consent.md),
[fixtures](../manual-diagnostics-contract/fixtures/README.md) and
[D1–D8 matrix](../manual-diagnostics-contract/acceptance-and-handoff.md) remain inputs,
read with their exact revision and the later accepted contract. #436 closes only after
reconciled exact-head review; #416 remains open. #417 uploads and #418 remote requests
remain later stages. #409 safe error precision is independent.

The two Mac/two Windows cohort and M3–M5/current-macOS target remain planning context,
not certified OS/hardware or participant consent. Signing/native installation/physical
acceptance are unproven here. No activation, host/access/key change, release or merge.
