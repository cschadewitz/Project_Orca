# Configuration and launch implementation packet

**Review proposal, not a frozen API or implementation kickoff.** Preparation for
[#435](https://github.com/cschadewitz/Project_Orca/issues/435), a slice of
[#334](https://github.com/cschadewitz/Project_Orca/issues/334), coordinated with
[#333](https://github.com/cschadewitz/Project_Orca/issues/333) and consumed by
[#386](https://github.com/cschadewitz/Project_Orca/issues/386).

Inspected main on 2026-10-03: `e8678ebaa06f4deb883143df288275300f762b3e`, Git tree
`555ef179c86d0100a090d2fc067d5bb0d9740a4d`. Every source claim below is pinned to
that original commit unless the 7 October ledger below explicitly refreshes them.
The five Markdown files are the complete owned scope. No runtime,
schema, manifest, dependency, UI, MCP or existing preparation files change.

| Document | Purpose |
| --- | --- |
| [Interfaces](interfaces.md) | Proposed pure app contracts and exact existing wire types |
| [Configuration transaction](configuration.md) | Collection editing, validation, preview, save and apply |
| [Launch and first-run](launch.md) | Target-bound launch, recovery, minimal beta and unresolved choices |
| [Ownership and verification](handoff-and-tests.md) | Isolated implementation paths, future prompts and evidence gates |

The merged [#424 experience packet](../cal-first-job-experience/README.md) remains
the accepted experience source; #424 is closed through merged #428 at
`6e7e45c28d56ffffc92efe3f4dcd947dbe91c056`. Its source/spec acceptance does not
freeze every later implementation choice. Inventory the accepted evidence below
before raising only a residual D1–D3 decision; do not reopen #424. Review/freeze must name the
actual published commit
of these files and an accepted runtime baseline. The source baseline above is not
the future contract commit. Copy-ready prompts deliberately require both pins.

## Historical evidence ledger (3 October)

“Implemented” means inspected source on this exact main, not executed here.

| Claim | Status and source |
| --- | --- |
| Existing scalar/raw config editor, revision-checked validate/save | Implemented: [wire](../../../packages/protocol/src/config.ts), [form model](../../../packages/app/renderer/src/config/config-model.ts), [feed](../../../packages/app/renderer/src/config/use-config.ts). `validateOnly` is a candidate read, not a save. |
| Saved revision versus active generation and explicit apply | Implemented: [config wire](../../../packages/protocol/src/config.ts), [generation guide](../../configuration-generations.md); #332. Preserve `active`, `pending`, `restart-required`, `invalid`. |
| Authenticated target switching, workspace/instance and connection epoch | Implemented: [target shape](../../../packages/app/src/daemon-connection.ts), [boundary](../../../packages/app/renderer/src/daemon-connection/boundary.tsx); closed #318. Reuse, never rebuild. |
| Typed input declarations, version/digest preflight | Implemented: [wire](../../../packages/protocol/src/workflow-inputs.ts), [registration](../../../packages/daemon/src/methods.ts); #330. Preflight does not echo effective inputs or supply config generation. |
| Request submission and Request-free direct launch | Implemented: [Request model](../../../packages/core/src/model/request.ts), [direct params](../../../packages/protocol/src/control.ts). Direct params do not support Request overrides. |
| Rich record/union editor metadata | Missing from the original audited wire: [schema walker](../../../packages/daemon/src/config-schema.ts) emits no record value node and flattens union branches. Do not infer branch requirements from its flattened `required` flag. Proposed extension needs integrator review. |
| Plugin configuration manifest | Not present in inspected [OrcaPlugin](../../../packages/engine/src/plugin.ts): `name` and `register` only. [Core config](../../../packages/core/src/config.ts) has module-specifier strings. Existing metadata does not authorize executing plugins in the renderer or inventing provider fields. |
| Retry-safe app launch and operator mutation composition | Documented [#331 shared contract](../../runtime-operator-parallel-contract.md), with separate active integration. Not a complete installed feature of that original pinned main; superseded by the current ledger below. Use injected fixtures until the integration owner supplies accepted exact exports. |
| Full guided launch, collection creation and native first-run | Proposed/incomplete outcomes #334/#333/#386. This publication closes none of them. |

The coordination checkpoint for MCP #434 was
`951950dbf685bd3b9054a8399346eed15b403b4c`: reported source acceptance 52/60 with
eight C failures and compiled product 4/4, not final operator acceptance. This was
an attributed checkpoint, not testing performed by this packet; it is not an
implementation baseline or an import dependency. MCP remains the priority and its
owners retain every MCP file. No new dependency from MCP onto this packet exists.

## Accepted foundation inventory (7 October)

Current main is `c1eba301702fef0466b2d3481c36d62331ee7d48`. Source inspection establishes these bindings,
not a new runtime test or deployment claim. #434 is merged at
`48dabf8bf90f623cbbd8b91117d769ebd9a5b52d`; combined #415 is merged at
`3702da5b38dc449280c2837366615de741e9c45c`. Pending integration/52-of-60
wording above is historical, not the current source state.

| Accepted evidence | Current boundary / residual acceptance |
| --- | --- |
| Closed #318/#332: authenticated target isolation and saved/active generation | Reuse [connection boundary](https://github.com/cschadewitz/Project_Orca/blob/c1eba301702fef0466b2d3481c36d62331ee7d48/packages/app/renderer/src/daemon-connection/boundary.tsx) and [config wire](https://github.com/cschadewitz/Project_Orca/blob/c1eba301702fef0466b2d3481c36d62331ee7d48/packages/protocol/src/config.ts); no replacement target/config system. |
| Merged #415/#434, #331 ledger and prompt admission | [Retry wire](https://github.com/cschadewitz/Project_Orca/blob/c1eba301702fef0466b2d3481c36d62331ee7d48/packages/protocol/src/admission-retry.ts) and [registration](https://github.com/cschadewitz/Project_Orca/blob/c1eba301702fef0466b2d3481c36d62331ee7d48/packages/daemon/src/methods.ts) provide `runs.admit`, `admissions.get`/`reconcile` under current runtime availability/authority. #466 proves multiprocess admission; #468 runs CLI/ACP acceptance in CI. #331's remaining full cross-client stable-key/new-intent matrix stays open. |
| Existing protected app palette intent journal | [AdmissionIntents](https://github.com/cschadewitz/Project_Orca/blob/c1eba301702fef0466b2d3481c36d62331ee7d48/packages/app/src/main/admission-intents.ts) binds target/principal/workspace/workflow/key in OS-encrypted main storage, excludes arbitrary vars/credentials and refuses unavailable/corrupt secure storage. Reuse it; it does not persist arbitrary guided Request/input drafts or prove their whole restart matrix. |
| Integrated coherent operator preflight | [Wire](https://github.com/cschadewitz/Project_Orca/blob/c1eba301702fef0466b2d3481c36d62331ee7d48/packages/protocol/src/operator-reads.ts) / [owner](https://github.com/cschadewitz/Project_Orca/blob/c1eba301702fef0466b2d3481c36d62331ee7d48/packages/daemon/src/operator-read-model.ts) return exact target, workflow version/revision and config generation. They do not expose a general checkout proof or effective input echo. Do not rebuild preflight from unguarded reads. |
| Closed #460 via #462 at `49efcc7236ac127c952bb1f7a50fc6ef72f7df84` | [Owned-root contract](https://github.com/cschadewitz/Project_Orca/blob/c1eba301702fef0466b2d3481c36d62331ee7d48/docs/root-worktree-isolation.md) implements opt-in trusted captured local-Linux root provisioning, frozen base, ownership receipts and fail-closed replay. This is concrete D1 foundation, not a general Mac checkout picker or pre-admission app projection. |
| Closed #505 via #508 at `d3491cc06b5abc1c5d82f2c685d6f628d9d4b04b` | [Prepared-root handoff](https://github.com/cschadewitz/Project_Orca/blob/c1eba301702fef0466b2d3481c36d62331ee7d48/docs/preparation/trusted-prepared-roots/controller-handoff.md) supplies accepted synthetic copier preparation. Controller wiring/readiness/host-profile acceptance remain separate. #486 is parked optional inactive installer tooling, not a prerequisite. |
| Closed #420 via #427, synthetic first-job fixture | [Fixture evidence](https://github.com/cschadewitz/Project_Orca/blob/c1eba301702fef0466b2d3481c36d62331ee7d48/docs/preparation/beta-first-job/validation.md) establishes the repeatable offline bug/fix/check asset. Reuse it for D2; it does not by itself register a general app workflow or prove native/provider acceptance. |
| #496 owner acceptance, 5 October | [Historical record](https://github.com/cschadewitz/Project_Orca/pull/496#issuecomment-5986160454) proves one configured-worker smoke and authenticated post-SSH read at the recorded service pins. Actual Cal is not wholly disconnected; this does not certify arbitrary app/native launch, all operator flows or current credentials. |
| Closed #424 experience specification | Accepted #428 specification remains input. #435/#333/#334/#386 retain implementation/acceptance ownership; this packet does not freeze their unresolved product contracts. |

The current schema walker still flattens unions/omits record value structure and
does not preserve independent absence/nullability semantics. The refined proposed
`FieldShape` in [interfaces](interfaces.md) addresses the review's missing metadata;
integrator-owned schema derivation/edit lowering and exact contract/runtime freeze
remain required. No new launch/product decision is inferred merely from old prose.

## Review decisions, not silently chosen product behavior

1. Integrator reviews the structural metadata/edit proposal and exact safe
   collection mutation strategy. A full-array replacement cannot be assumed to
   preserve comments attached to elements.
2. #334/#327 bind D1 to accepted #460/#462 and #505 evidence where applicable,
   identifying only the residual authorized pre-admission checkout/freshness projection
   for the selected app/platform. No duplicate provisioner, arbitrary path picker or raw-file proxy.
3. #334/#386 reuse completed #420's offline asset and the recorded configured-worker
   evidence, then bind the selected app workflow ID/version/digest, task/instructions
   and result contract. Any remaining app/native asset decision belongs to those owners,
   not reopened #424/#420 or a duplicated fixture task.
4. #334/integrator reuse existing protected palette intents and identify only the
   missing guided-draft/retry restart bindings and #331 residual matrix.
   Do not persist config bytes, task text, credentials or input values in ordinary
   app preferences to claim restart durability.

The recommended smallest beta path is one existing supported fixed workflow,
one configured local agent and one verified workspace, through ordinary app
controls. Keep Request mode separate. Persistent chat, visual canvas, fleet,
Docker and template-editor completion are not blanket prerequisites. D3 PR
publication stays unavailable pending its existing owner decision.
