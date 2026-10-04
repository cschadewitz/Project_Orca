# Roadmap mapping, implementation phases and decisions

Inventory inspected open and relevant closed GitHub issues/PRs on 2026-10-04, plus
source at [the recorded baseline](README.md). [ROADMAP.md](../../ROADMAP.md) is a
2026-10-01 ledger: its statements that configuration generations/live callbacks
remain future work are superseded by integrated code. Conversely, an open umbrella
issue does not mean its mechanisms are absent. No issues or metadata are changed
or created by this research.

## Existing work and remaining scope

| Existing issue / proposal | Observed state and reuse | Remaining relationship |
| --- | --- | --- |
| [#140](https://github.com/cschadewitz/Project_Orca/issues/140), [#221](https://github.com/cschadewitz/Project_Orca/issues/221), [#266](https://github.com/cschadewitz/Project_Orca/issues/266), [#271](https://github.com/cschadewitz/Project_Orca/issues/271), [#176](https://github.com/cschadewitz/Project_Orca/issues/176) | Closed; conservative defaults, sidecar derivation/writes/editing/live rereads exist | Preserve rule semantics; add structured action checks, protected caps and strict material-failure behavior without reopening these completed outcomes |
| [#160](https://github.com/cschadewitz/Project_Orca/issues/160), [#161](https://github.com/cschadewitz/Project_Orca/issues/161), [#162](https://github.com/cschadewitz/Project_Orca/issues/162), [#248](https://github.com/cschadewitz/Project_Orca/issues/248), [#289](https://github.com/cschadewitz/Project_Orca/issues/289) | Closed; controls, Attention/inline cards, notifications, context and concurrent gate handling | Extend shared presentation and evidence, not a second approval UI/data feed |
| [#237](https://github.com/cschadewitz/Project_Orca/issues/237), [#332](https://github.com/cschadewitz/Project_Orca/issues/332) | Closed; merged [#383](https://github.com/cschadewitz/Project_Orca/pull/383)/[#384](https://github.com/cschadewitz/Project_Orca/pull/384), integrated [#397](https://github.com/cschadewitz/Project_Orca/pull/397) | Reuse live callback/authority and captured-generation contracts; add exact action/policy evidence |
| [#328](https://github.com/cschadewitz/Project_Orca/issues/328) | Open tracking, with authentication/authorization integrated through [#371](https://github.com/cschadewitz/Project_Orca/pull/371) and later wiring | Same verified principal, resource and revocation checks; do not invent reviewer authority or rely on an unrestricted client preset |
| [#329](https://github.com/cschadewitz/Project_Orca/issues/329), [#330](https://github.com/cschadewitz/Project_Orca/issues/330); [#327](https://github.com/cschadewitz/Project_Orca/issues/327), [#331](https://github.com/cschadewitz/Project_Orca/issues/331), [#356](https://github.com/cschadewitz/Project_Orca/issues/356) | First two closed; latter tracking issues open despite substantial integrated admission/MCP/revision/continuation code | Capture authorized policy at admission and reuse receipts/reconciliation; no new request ledger or implicit business revision |
| [#335](https://github.com/cschadewitz/Project_Orca/issues/335), [#336](https://github.com/cschadewitz/Project_Orca/issues/336), [#337](https://github.com/cschadewitz/Project_Orca/issues/337) | Open capability resolution, secret boundary and negotiated delivery work | Share capability vocabulary and future secret references. Availability is separate from authority. A fixed credential-free first profile need not await the entire catalog |
| [#338](https://github.com/cschadewitz/Project_Orca/issues/338), [#339](https://github.com/cschadewitz/Project_Orca/issues/339), [#357](https://github.com/cschadewitz/Project_Orca/issues/357), [#399](https://github.com/cschadewitz/Project_Orca/issues/399) | Open conformance/storage/checkpoint/retention work | Coordinate consume/effect evidence and recovery; SQLite migration is not a hard prerequisite |
| [#340](https://github.com/cschadewitz/Project_Orca/issues/340), [#345](https://github.com/cschadewitz/Project_Orca/issues/345), [#346](https://github.com/cschadewitz/Project_Orca/issues/346), [#347](https://github.com/cschadewitz/Project_Orca/issues/347) | Open operations, usage, budget and routing work | Start with checker-local measured budgets; do not claim current whole-agent cost or build another general operations console |
| [#286](https://github.com/cschadewitz/Project_Orca/issues/286), [#296](https://github.com/cschadewitz/Project_Orca/issues/296)–[#299](https://github.com/cschadewitz/Project_Orca/issues/299) | JEV POC #296 closed; umbrella/hardening/schema/calibration open | Artifact evaluation is a useful precedent, not already a trusted tool-authorizer. Keep checker provider neutral |
| [#379](https://github.com/cschadewitz/Project_Orca/issues/379) | Open peer-message model triage study | Share shadow-mode invariants/evaluation methods only; distinct domain and no hard dependency |
| [#394](https://github.com/cschadewitz/Project_Orca/issues/394)–[#396](https://github.com/cschadewitz/Project_Orca/issues/396), [#363](https://github.com/cschadewitz/Project_Orca/issues/363), [#408](https://github.com/cschadewitz/Project_Orca/issues/408), [#409](https://github.com/cschadewitz/Project_Orca/issues/409) | Open plugin restoration/acceptance, sensitive projection, performance and protected recovery follow-ons | Builtin coordinator avoids an unnecessary executable-plugin restoration dependency; retain protected store/secret limits and measure evidence cost |
| [#410](https://github.com/cschadewitz/Project_Orca/issues/410)/[#458](https://github.com/cschadewitz/Project_Orca/pull/458), [#443](https://github.com/cschadewitz/Project_Orca/issues/443)/[#448](https://github.com/cschadewitz/Project_Orca/pull/448), [#444](https://github.com/cschadewitz/Project_Orca/issues/444)/[#447](https://github.com/cschadewitz/Project_Orca/pull/447) | Closed/merged and in this baseline: resume-authority wiring regression, completed continuation settlement, bounded direct-child startup cleanup | Preserve regression evidence; these are not outstanding blockers, and direct-child cleanup is not process-tree confinement |
| [#449](https://github.com/cschadewitz/Project_Orca/issues/449) | Open enforced unattended profile/standing trigger authority proposal | Owns filesystem/network/credential/process enforcement and supervisor; review layer consumes that boundary rather than duplicating a sandbox project |
| [#450](https://github.com/cschadewitz/Project_Orca/issues/450), [#451](https://github.com/cschadewitz/Project_Orca/issues/451), [#452](https://github.com/cschadewitz/Project_Orca/issues/452), [#453](https://github.com/cschadewitz/Project_Orca/issues/453), [#454](https://github.com/cschadewitz/Project_Orca/issues/454) | Open intake/source/router/workflow/acceptance proposals | Trigger text is untrusted input; standing enrollment grants bounded launch authority, not arbitrary per-tool approval |
| [#460](https://github.com/cschadewitz/Project_Orca/issues/460), [#350](https://github.com/cschadewitz/Project_Orca/issues/350) | #460 is closed through merged [#462](https://github.com/cschadewitz/Project_Orca/pull/462), completing the contained local Linux root-worktree foundation under #453. #350 remains the separate conflict-safe GitHub planning outbox owner | Reuse the merged workspace foundation; #449/#453 enforcement, feedback binding and expected-head/durable-outbox publication acceptance remain open. #462 postdates this research baseline and is not #449 confinement evidence; a Git worktree is not a sandbox |
| [Draft PR #459](https://github.com/cschadewitz/Project_Orca/pull/459), [draft PR #461](https://github.com/cschadewitz/Project_Orca/pull/461) | Open research-only Watch/mobile and focused iOS proposals | Share authoritative answer/presentation/receipt contracts through Watch M3 and iOS P3; live tool permissions remain read/alert-only initially |

No existing generic semantic tool-review issue was found in this inventory. A new
implementation outcome is justified for action normalization, policy ceilings,
review coordination, exact permits/evidence and adversarial conformance. Keep these
as proposed slices until implementation planning is requested; do not duplicate
the existing enforcement, mobile, secret, workspace or recovery owners.

## Triggered-flow and unattended proposal

Read the [triggered-workflow architecture at `85fa22fc90574d844675951141aa62f7d8511426`](https://github.com/cschadewitz/Project_Orca/blob/85fa22fc90574d844675951141aa62f7d8511426/docs/preparation/triggered-workflows/architecture.md)
and the [3 October Casey decisions](https://github.com/cschadewitz/Project_Orca/issues/449#issuecomment-5974260915).
The latter supersede the architecture's older human-only/local-only introduction:
human and review-agent feedback, including shared identity, are in scope; tested
fixes may publish to the existing enrolled PR branch through a separately scoped
publisher; Codex/Linux is the first intended target. None of that proves the deployed
host isolated or authorizes implementation, live activation or new credentials.

Reuse a trusted `TriggerBinding` outside writable repo content, original principal,
workflow/generation/repository/PR/actor constraints, expiry and quota, with rechecks
at admission/recovery. Dispatcher/source/publisher credentials stay outside agent
execution. A dispatcher lacking `inputs.answer` and `permissions.grant` cannot acquire
those rights by receiving review-agent feedback, even under a shared external identity.
Provenance, deduplication and self-loop prevention remain necessary. Publishing binds
the tested immutable candidate, enrolled branch, expected old head and non-force
operation; a model's approval does not satisfy this contract.

Cross-trigger serialization/quota, enrollment races, resumable source scanning,
post-dispatch edits/dismissals and race-safe publication remain proposal decisions.
The implicit checker can flag a suspicious triggered action, but cannot authenticate
a feedback author or widen the enrolled scope. A supervisor's ability to stop the
runner must survive expiry of the dispatcher's RPC credential.

The original publication inspected #462 while it was a draft at
`9d5821004385b561d152d243313150c140e24372`. **Status refresh, 4 October 2026:**
[#462](https://github.com/cschadewitz/Project_Orca/pull/462) is merged as
`49efcc7236ac127c952bb1f7a50fc6ef72f7df84`, from reviewed head
`3aa3d2c26f2c7e3237c5f27e0243980cf109ce3c`, and #460 is closed. It supplies opt-in
local Linux owned root-worktrees, trusted captured configuration, frozen base and
fail-closed retained provisioning evidence. This accepted contained foundation
does not approve this research architecture, certify a deployed host or satisfy
the broader [#449](https://github.com/cschadewitz/Project_Orca/issues/449) and
[#453](https://github.com/cschadewitz/Project_Orca/issues/453) acceptance gates.
Filesystem/network/credential/process enforcement, feedback/workflow binding and
race-safe expected-head publication with durable effect reconciliation remain open.

Related [#486](https://github.com/cschadewitz/Project_Orca/pull/486) remains open:
its offline dependency-bootstrap helper is inactive preparation, with no subprocess
runner, ACP wiring, actual dependency installation or live activation. Locked
dependency/executable closure, externally enforced offline/cache-miss behavior,
crash/concurrency reconciliation, tool readiness and trusted-controller state
isolation still need proof. Neither preparation nor marker files certify #453
readiness or #449 enforcement.

## Mobile/Watch approval proposal

Read [the refreshed Watch draft at `192df3e0079fdb05a87a0517072d66f0bd65fb7c`](https://github.com/cschadewitz/Project_Orca/blob/192df3e0079fdb05a87a0517072d66f0bd65fb7c/docs/preparation/apple-watch-approvals/README.md).
The original research read `f6dcddbc592247de495f71a7b139c617fab14c9e`; subsequent
alignment at `d3dd447033d0510c1bbe4f7907b875e5a69db972` retained shared phone scope,
receipt acceptance and independent Low Power Mode coverage. The refreshed draft
records the selected read-only pilot and preserves later phone-command and narrow
Watch-native proposals subject to their acceptance gates. Live tool callbacks
are alert-only initially. Notification delivery/read/dismissal is never consent;
notification credentials cannot answer. Keep consequential actions, credentials,
standing grants and complex context off a tiny approval surface regardless of a
model's confidence.

Its M3 proposes current-authority validation under the shared durable-answer fence
and binding to decision-relevant presentation revision. That is a useful common
contract: current live answers already have an authority callback, but baseline
durable `answerOwned` accepts actor metadata rather than the same current-authority
hook. A post-write authorization failure cannot undo acceptance. Coordinate this
gap through shared controls; do not fix it with a mobile-only or checker-only test.
See [answerOwned](../../../packages/engine/src/orchestrator.ts) and
[operator mutations](../../../packages/daemon/src/operator-mutations.ts).

The older Watch draft's open-#443/#448 wording is corrected in the linked refresh:
#448 is merged and #443 closed; strict continuation/security regressions remain
required for future mobile commands. Its distinction between answer recorded,
callback delivered, continuation
accepted and execution completed still applies. Live/answer-only retry cannot borrow
the continuation receipt contract without implementing equivalent semantics.

The focused iOS [draft #461 architecture at
`78a48bf1e19df533aff019525b325e872b7e1c26`](https://github.com/cschadewitz/Project_Orca/blob/78a48bf1e19df533aff019525b325e872b7e1c26/docs/preparation/ios-companion/architecture.md)
and its [P3 delivery slice](https://github.com/cschadewitz/Project_Orca/blob/78a48bf1e19df533aff019525b325e872b7e1c26/docs/preparation/ios-companion/delivery.md)
retain one shared command contract. The original inspection was at
`6cfa52018f9e80fb55db5b2ad82000fab681f0e8`; prior clarifications at
`aa0884b228dc8c44772e2d0ea8f8e1e5fa480281` remain preserved in this refresh.
P3 proposes shared under-fence current-authority and presentation/effect-policy
revision checks for answer-only and answer-and-continue, durable answer/cancel
receipts, and non-mutating lookup by retained client identity when a lost first
response also loses the server receipt ID. Coordinate these contracts with Watch M3
and exact tool-action evidence; do not create a third approval ledger. The iOS draft
also leaves live tool approvals read/alert-only initially. Both mobile documents
remain proposals, not implemented clients or new authority.

The [owner selected SwiftUI/Apple first, Android later](https://github.com/cschadewitz/Project_Orca/pull/461#issuecomment-5976265449),
with platform-neutral shared contracts and APNs for the Apple phase.
[Milestone 24](https://github.com/cschadewitz/Project_Orca/milestone/24) tracks
the read-only iPhone and mirrored Watch pilot. [#471](https://github.com/cschadewitz/Project_Orca/issues/471)
is complete through merged [#479](https://github.com/cschadewitz/Project_Orca/pull/479):
contracts, synthetic fixtures and a device plan are preparation only.
[#472](https://github.com/cschadewitz/Project_Orca/issues/472),
[#473](https://github.com/cschadewitz/Project_Orca/issues/473),
[#475](https://github.com/cschadewitz/Project_Orca/issues/475) and
[#477](https://github.com/cschadewitz/Project_Orca/issues/477) remain open.
This does not implement phone commands, approve native Watch decisions or prove
physical-device delivery, and it does not approve the tool-call architecture.
Swift ownership, hardware, route, visibility and signing/APNs custody remain open.

## Phased implementation recommendation

No phase is authorized by this draft. Proposed owner boundaries follow existing
packages and issue ownership; Cal should assign concrete implementation owners.

| Slice | Concrete deliverable and owner seam | Hard prerequisites | Acceptance / non-goals |
| --- | --- | --- | --- |
| S0 — contract and corpus | Core action/policy/coverage/evidence contracts; adapter/host inventory; adjudicated threat fixtures | Agreement on first promised coverage and profile owner | Source-confirmed capability facts and explicit unsupported state; no runtime authority changes |
| S1 — safe observation | Agents/engine observer, protected evidence and bounded optional checker; approved data minimization | S0; checker destination/data policy approved before egress | Label non-enforcing; preserve every existing decision; no grants, new prompts or denials |
| S2 — exact human-confirmed boundary | Shared coordinator, strict policy reads, one-shot exact-action permit, pre-dispatch evidence, current-authority checks, Attention projection | S0 plus verified interception on selected path; S1 privacy/corpus results before production rollout | Action/race/recovery suite passes; remembered-only and unsupported requirements refuse; no delegated model approvals |
| E — constrained executor | Existing #449 runner contract, #460/#453 workspace and publisher boundaries where required | Existing owner plans; a proven host/adapter implementation | Prove filesystem/network/credential/descendant limits on real host; review layer does not implement a rival sandbox |
| S3 — narrow delegation | Operator-authorized recipes, shared budgets/expiry, deterministic grant consumption and optional model veto | S2 + E for every promised effect; agreed release metrics | Unattended outage/revoke/retry/bypass tests and held-out quality gates; no arbitrary shell/session-wide authorization |
| S4 — additional paths | Certified provider hooks/native adapters, SSH remote boundary, richer session grants and mobile integration | S2 contracts; S3 evidence for any delegated path; corresponding adapter/mobile readiness | Per-version/OS conformance before advertising support; unsupported combinations remain closed |

Hard dependency graph: `S0 → S1 → production S2`; `S0 → S2 contract work`;
`{S2, E} → S3`; `S2 → S4 contract work`, and `S3 → delegated S4 rollout`.
This is acyclic. Runner work E and observation S1 can proceed in parallel after
agreeing S0's boundary vocabulary; this adds no gate to the completed #460 foundation. Shared
mobile presentation work and capability catalog discussions are coordination, not
blanket blockers. Broad #335–337 completion, SQLite #339, all trigger sources and a
Watch client are not prerequisites for a fixed supported credential-free profile.

For the existing trigger graph, #451 needs #450; #452 needs #449/#450 and integrated
admission contracts; #453 needs #449; #454 needs #451/#452/#453 and the now-merged
#444 fix. This research adds no reverse dependency and does not change those issues.
If later filed, use one proposed primary `ship-group:tool-call-safety` for the new
coherent outcome only, agree the label before creating it, cross-reference existing
groups and leave milestones unassigned until explicit release planning.

## Decisions Casey and Cal need to make

| Decision | Recommended starting answer | Why it matters |
| --- | --- | --- |
| First promise and supported path | Codex/Linux alignment with #449; certify exact provider/bridge/runner before enforcement. Generic ACP offers limited review, not complete mediation | Determines whether a profile can promise constrained effects |
| Policy ownership and immutable caps | Administrator catalog outside agent-writable storage; project operator activates revision-guarded selections | Prevents workflow/repo self-authorization |
| Hard-human and prohibited operations | Deny secret export/policy tampering; always confirm production/destructive external/history-rewrite operations; separate publisher authority | A model confidence threshold must never replace these controls |
| Unattended delegated scope | Credential-free isolated test/build recipes first; finite calls/time/concurrency; no remote publication by the general worker | Makes failure and blast radius bounded |
| Capture/live changes | Capture the authority ceiling; apply current restrictions; broaden only by explicit renewal/new epoch | Preserves reproducibility and revocation without silent elevation |
| Initial grant lifetime | One-shot only; later bounded sessions only where executor proves constraints | Avoids command approval becoming a standing shell grant |
| Checker and data policy | Provider-neutral unprivileged client; no secret-bearing context; approved destination/retention and measured budget | Controls privacy, cost, outages and reproducibility limits |
| Audit and storage failure | Protected minimal evidence before dispatch; fail closed on required policy/evidence failure | Current telemetry alone cannot prove authorization |
| Revocation and termination target | Declare maximum detection/stop latency per runner and how unknown effects are reported | Lease loss and direct-child kill do not prove all effects stopped |
| Shared approval contract | Coordinate action/presentation digest and under-fence authority with Watch M3, iOS P3 and existing live input | Avoids parallel approval ledgers and stale-display authorization |
| Rollout quality bar | Adjudicated severity corpus, zero observed critical effective false allows in fixed suite, explicit false-denial/latency budgets | Requires an accountable go/no-go decision rather than an aggregate model score |

Near term, the tradeoff is limited but auditable coverage with human confirmation.
Long term, stronger effect guarantees require runner/service boundaries, per-adapter
contracts and sustained adversarial testing. Policy sophistication alone cannot close
an execution path ORCA never controls.
