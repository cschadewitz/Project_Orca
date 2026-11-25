# Run, step, timeline and artifact inspection

Owner: `packages/app`. Granularity: component.

Scope and boundaries: renderer/runs/, step/ and artifacts/.

[SVG](../diagrams/svg/app-runs.svg) · [Editable JSON](../diagrams/source/app-runs.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | useRuns takes a list snapshot, merges run.changed and resolves unknown run ids through runs.get; reattachment generation retriggers the snapshot. | E1: [`export function useRuns`](../../packages/app/renderer/src/runs/use-runs.ts#L45) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/renderer/src/runs/use-runs.ts#L45)) |
| Implemented | Tree and timeline have separate plain models and paged feeds; step logs aggregate agent updates into bounded line/tool views with prepend and hold handling. | E2: [`export function useStepLog`](../../packages/app/renderer/src/step/use-step-log.ts#L77) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/renderer/src/step/use-step-log.ts#L77)) |
| Implemented | Artifact panel fetches selected versions, renders body-specific content and computes local version diffs. | E3: [`export function ArtifactPanel`](../../packages/app/renderer/src/artifacts/artifact-panel.tsx#L63) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/renderer/src/artifacts/artifact-panel.tsx#L63)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | Run/tree/timeline selection | Snapshot + notification hooks | call: read selected run/event pages | Claim E1 above |
| E2 | Snapshot + notification hooks | Step line/tool buffer | data: fold coalesced updates | Claim E2 above |
| E3 | Step line/tool buffer | VirtualList run/timeline/output views | data: render visible rows / follow | Claim E2 above |
| E4 | Run/tree/timeline selection | Artifact body/version panel | call: open artifact id/name/version | Claim E3 above |

## Limits

Different feeds use merge, cursor catch-up or invalidation. Cursor/selection preservation is not evidence that all cross-process store changes are pushed.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
