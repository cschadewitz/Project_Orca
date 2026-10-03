# Configuration and launch implementation packet

**Review proposal, not a frozen API or implementation kickoff.** Preparation for
[#435](https://github.com/cschadewitz/Project_Orca/issues/435), a slice of
[#334](https://github.com/cschadewitz/Project_Orca/issues/334), coordinated with
[#333](https://github.com/cschadewitz/Project_Orca/issues/333) and consumed by
[#386](https://github.com/cschadewitz/Project_Orca/issues/386).

Inspected main on 2026-10-03: `e8678ebaa06f4deb883143df288275300f762b3e`, Git tree
`555ef179c86d0100a090d2fc067d5bb0d9740a4d`. Every source claim below is pinned to
that commit. The five new documents are the complete owned diff. No runtime,
schema, manifest, dependency, UI, MCP or existing preparation files change.

| Document | Purpose |
| --- | --- |
| [Interfaces](interfaces.md) | Proposed pure app contracts and exact existing wire types |
| [Configuration transaction](configuration.md) | Collection editing, validation, preview, save and apply |
| [Launch and first-run](launch.md) | Target-bound launch, recovery, minimal beta and unresolved choices |
| [Ownership and verification](handoff-and-tests.md) | Isolated implementation paths, future prompts and evidence gates |

The merged [#424 experience packet](../cal-first-job-experience/README.md) remains
the experience source; this packet does not rewrite its wireframes or pretend its
D1–D3 decisions were resolved. Review/freeze must name the actual published commit
of these files and an accepted runtime baseline. The source baseline above is not
the future contract commit. Copy-ready prompts deliberately require both pins.

## Evidence ledger

“Implemented” means inspected source on this exact main, not executed here.

| Claim | Status and source |
| --- | --- |
| Existing scalar/raw config editor, revision-checked validate/save | Implemented: [wire](../../../packages/protocol/src/config.ts), [form model](../../../packages/app/renderer/src/config/config-model.ts), [feed](../../../packages/app/renderer/src/config/use-config.ts). `validateOnly` is a candidate read, not a save. |
| Saved revision versus active generation and explicit apply | Implemented: [config wire](../../../packages/protocol/src/config.ts), [generation guide](../../configuration-generations.md); #332. Preserve `active`, `pending`, `restart-required`, `invalid`. |
| Authenticated target switching, workspace/instance and connection epoch | Implemented: [target shape](../../../packages/app/src/daemon-connection.ts), [boundary](../../../packages/app/renderer/src/daemon-connection/boundary.tsx); closed #318. Reuse, never rebuild. |
| Typed input declarations, version/digest preflight | Implemented: [wire](../../../packages/protocol/src/workflow-inputs.ts), [registration](../../../packages/daemon/src/methods.ts); #330. Preflight does not echo effective inputs or supply config generation. |
| Request submission and Request-free direct launch | Implemented: [Request model](../../../packages/core/src/model/request.ts), [direct params](../../../packages/protocol/src/control.ts). Direct params do not support Request overrides. |
| Rich record/union editor metadata | Missing from current wire: [schema walker](../../../packages/daemon/src/config-schema.ts) emits no record value node and flattens union branches. Do not infer branch requirements from its flattened `required` flag. Proposed extension needs integrator review. |
| Plugin configuration manifest | Not present in inspected [OrcaPlugin](../../../packages/engine/src/plugin.ts): `name` and `register` only. [Core config](../../../packages/core/src/config.ts) has module-specifier strings. Existing metadata does not authorize executing plugins in the renderer or inventing provider fields. |
| Retry-safe app launch and operator mutation composition | Documented [#331 shared contract](../../runtime-operator-parallel-contract.md), with separate active integration. Not a complete installed feature of this pinned main. Use injected fixtures until the integration owner supplies accepted exact exports. |
| Full guided launch, collection creation and native first-run | Proposed/incomplete outcomes #334/#333/#386. This publication closes none of them. |

The coordination checkpoint for MCP #434 was
`951950dbf685bd3b9054a8399346eed15b403b4c`: reported source acceptance 52/60 with
eight C failures and compiled product 4/4, not final operator acceptance. This is
an attributed checkpoint, not testing performed by this packet; it is not an
implementation baseline or an import dependency. MCP remains the priority and its
owners retain every MCP file. No new dependency from MCP onto this packet exists.

## Review decisions, not silently chosen product behavior

1. Integrator reviews the structural metadata/edit proposal and exact safe
   collection mutation strategy. A full-array replacement cannot be assumed to
   preserve comments attached to elements.
2. #334/#327 resolve #424 D1: smallest authorized, fresh repo/checkout evidence for
   a configured disposable workspace. No arbitrary path picker or raw-file proxy.
3. #334/#420 resolve D2: actual reviewed `start → agent → end` asset identity,
   typed task input, instructions and result-artifact contract. It is not already
   a shipped preset merely because the design recommends it.
4. #334/integrator settle protected launch-draft/retry-intent restart recovery.
   Do not persist config bytes, task text, credentials or input values in ordinary
   app preferences to claim restart durability.

The recommended smallest beta path is one existing supported fixed workflow,
one configured local agent and one verified workspace, through ordinary app
controls. Keep Request mode separate. Persistent chat, visual canvas, fleet,
Docker and template-editor completion are not blanket prerequisites. D3 PR
publication stays unavailable pending its existing owner decision.
