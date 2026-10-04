# Spike plan, ownership and completion gates

This is the first preparation deliverable for milestone 24, not permission to
perform the later spike. The new mobile issues are the implementation plan; do
not recreate the earlier P/M research slices as another set of tickets.

## Existing ownership map

| Existing issue | Research slices consolidated | Outcome and ordering |
| --- | --- | --- |
| [#471](https://github.com/cschadewitz/Project_Orca/issues/471) (this preparation) | P0 / M0 contract and device planning | No hard blocker for documentation/fixtures. Actual native execution remains future work. |
| [#472](https://github.com/cschadewitz/Project_Orca/issues/472) | P1 / M2, contained extension of #328 using #327 | Shared enrollment, device-linked read policy, projections and route recipe; contract from #471. Owns server-denial evidence. Broad parent closure is not a blocker. |
| [#473](https://github.com/cschadewitz/Project_Orca/issues/473) | P2 / shared phone part of M4–M5 | SwiftUI fixtures after #471; #472 blocks connected acceptance. Owns native cache, lifecycle and accessibility. |
| [#475](https://github.com/cschadewitz/Project_Orca/issues/475) | N1 / M1 | One APNs provider/outbox and enrollment binding; generic iPhone/Watch mirroring. Fake-provider work can proceed alongside client work; actual enrollment consumes #472. No separate Watch delivery pipeline. |
| [#477](https://github.com/cschadewitz/Project_Orca/issues/477) | P5a | Existing read-only release exit issue; integrates physical, security, accessibility, distribution and support evidence after #472/#473/#475. |
| [#474](https://github.com/cschadewitz/Project_Orca/issues/474), outside read-only milestone | P3 / M3 | Later shared fenced command acceptance/receipts and lost-first-response inspection. Does not block this pilot; no send-once/unknown exception to write acceptance. |
| [#476](https://github.com/cschadewitz/Project_Orca/issues/476), outside read-only milestone | P4 / later phone commands | Consumes #472/#473/#474; no command UI or authority in this pilot. |

Read-only release P5a requires #472 + #473 + #475 and physical/security/accessibility,
signed distribution, privacy and named support/revocation evidence under #477.
This preparation does not file another release issue or close the milestone
(closure triggers release preparation).
P5b/phone commands, native Watch approvals and Android stay later. Android can
reuse JSON, identity, projections and recovery tests, but requires its own UI,
platform notification adapter, secure storage, native integration and device tests.

Hard-dependency order is acyclic: #471 → #472; #471 → #473 fixture work;
#471 → #475 fake-provider work; #472 → #473 connected acceptance and #475 enrollment integration;
#472 + #473 + #475 → #477 read-only release acceptance. No edge points back from
commands, trigger completion or broad #327/#328 issue closure. Shared protocol,
auth and bootstrap changes need one integration owner before parallel edits.

## Concrete future spike (timebox: five engineering days, estimate)

| Step | Owner role and bounded task | Exit evidence / stop condition |
| --- | --- | --- |
| S0, half day | Named Swift maintainer + owners inventory Mac/phones/Watch, choose floor/toolchain, review contract and native design mapping | Exact [prerequisites](devices.md) recorded. Stop native work if hardware/signing permission is missing; offline contract review can continue. |
| S1, one day | #473 maintainer builds fixture-only `OrcaWire` decoder, session-generation reducer and one Attention → summary → artifact path on Mac | Shared fixtures decode identically; incompatible data rejected; all writes structurally absent; zero socket activity. No transport/enrollment implementation required for this step. |
| S2, one day | #473 maintainer adds Runs/Connection and scripted lifecycle playback | All [scenarios](fixtures/scenarios.json) produce specified stale/empty/error/recovery UI; old responses cannot win; cache limits and inert malicious text proven locally. |
| S3, one day | #472 owner designs/tests fake-authority projection adapter; #473 runs simulator accessibility/compact layout | Canonical producer fields and bounds, wrong-identity/canary/denial cases pass. Synthetic policy tests do not claim server or hardware acceptance. Native design exceptions resolved explicitly. |
| S4, one day | Separately authorized physical fixture install, by device/signing custodian with Swift maintainer | D1/D2 layout, VoiceOver, suspension and storage evidence. No endpoint, APNs registration or live ORCA credential required. Simulator-only result leaves physical gate blocked. |
| S5, half day | Owners review findings and size #472/#473/#475 integration; name release evidence owner | Go/adjust/stop record, retained failures/unknowns, chosen floor and supported hardware, updated estimate. No connected rollout implied. |

The subsequently authorized connected spike is a distinct gate after #472 has an
accepted facade: use isolated synthetic data to prove authenticated read scope,
mutation denial, foreground recovery and chosen private route on a physical phone.
The later #475 APNs/Watch spike requires separate provider custody and delivery
consent. Do not fit these blocked live activities into S1's fixture work or claim
the five-day timebox covers them. Existing Linux server tests, native simulator
checks and fake-provider notification work can proceed in parallel after contract
agreement; physical connectivity and APNs evidence cannot.

## Unresolved owner decisions

| Decision | Proposed starting point (not selected by this preparation) | Blocks |
| --- | --- | --- |
| Swift maintenance and integration | Name one Swift/Xcode maintainer and one shared protocol/auth integrator | Native implementation handoff and parallel shared-file edits |
| Hardware/support floor | Actual Mac/phone/Watch inventory; iOS 18 minimum / current stable test candidates | Toolchain pin, physical install, support claim; no purchase or upgrade assumed |
| Connectivity | Prior research recommends installed Tailscale + trusted HTTPS; owners must choose VPN, LAN-only or managed edge and host/TLS/renewal operator | Private connected spike; no assumption existing MCP tunnel/audience is usable |
| Human visibility | Device credential maps to actual human principal; selected workflows with explicitly agreed `owned` or `all` | #472 policy: new unrelated principal would hide old work; `all` can expose cross-owner/trigger work. Exact-run refinement if owners reject both |
| Enrollment and recovery | Administrator-approved single-use challenge, device-key binding, finite credential renewal, independent revocation owner | Connected acceptance. Challenge consumption, restore/reinstall, passcode loss and revocation policy need review; no QR/token minted here |
| Endpoint/identity trust | Owner-approved workspace and trusted HTTPS origin; boot changes rediscover, workspace/principal changes block | Connection setup, wrong-host/redirect acceptance. No certificate-validation bypass |
| Cache and artifact exposure | Memory first, optional bounded 15-minute protected summaries; allowlisted public artifact kinds, bodies memory-only | Privacy acceptance; owners may choose no disk cache or narrower artifact scope |
| Apple signing/APNs custody | Verify reported paid individual membership; name account holder, bundle owner, signing operator, APNs topic/environment/key custodian | Development device signing, #475 delivery, TestFlight. Connect role is not shared signing authority |
| Pilot release/support | Name testers, exact supported OS/device set, release/privacy/support and independent loss/revocation contacts | Signed distribution and milestone acceptance, not fixture preparation |

Owner/desktop-only operations remain publication/merge/deployment, standing grants,
enrollment/security changes and protected revision composition. Watch escalation
never expands phone authority. Notification delivery, approval recorded,
continuation accepted, execution resumed and terminal outcome remain separate facts.
This pilot displays authorized observations only; it produces none of those effects.
