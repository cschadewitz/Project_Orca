# Config and workflow inspection UI

Owner: `packages/app`. Granularity: component.

Scope and boundaries: renderer/config/ and workflow/.

[SVG](../diagrams/svg/app-config-workflow.svg) · [Editable JSON](../diagrams/source/app-config-workflow.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | Config drafts retain edits over received documents, support schema/form or raw editing, revision-aware save and policy provenance. | E1: [`export function useConfig`](../../packages/app/renderer/src/config/use-config.ts#L100) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/renderer/src/config/use-config.ts#L100)) |
| Implemented | Workflow feed reads definitions and optionally run traversal; canvas layout uses a shared local graph-layout function with pan/zoom/selection. | E2: [`export function layoutGraph`](../../packages/app/renderer/src/workflow/layout.ts#L256) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/renderer/src/workflow/layout.ts#L256)) |
| Implemented | WorkflowSurface is a viewer over workflows.get and run overlays; protocol methods offer no workflow document write operation. | E3: [`export function useWorkflow`](../../packages/app/renderer/src/workflow/use-workflow.ts#L56) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/renderer/src/workflow/use-workflow.ts#L56)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | Config edits / workflow selection | Config draft model and hook | data: retain patch/text draft | Claim E1 above |
| E2 | Config draft model and hook | ConfigModel get/set RPC | call: validate/save expected revision | Claim E1 above |
| E3 | Config edits / workflow selection | Workflow read + traversal hook | call: select workflow and run overlay | Claim E3 above |
| E4 | Workflow read + traversal hook | Graph canvas / field inspector | data: layout nodes/edges and traversal | Claim E2 above |

## Limits

A workflow editor is not implemented by the viewer. Common draft bar markup does not establish workflow authoring or reload support.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
