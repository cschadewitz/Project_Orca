# Domain and event projection

Owner: `packages/core`. Granularity: component.

Scope and boundaries: model/, events/, schemas.ts, ids/errors and shared utilities.

[SVG](../diagrams/svg/core-domain.svg) · [Editable JSON](../diagrams/source/core-domain.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | A run has workflow id/version, workspace, variables and optional request, work-item and parent links; a step is a node attempt inside that run. | E1: [`export const RunSchema`](../../packages/core/src/model/run.ts#L136) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/core/src/model/run.ts#L136)) |
| Implemented | The reducer owns the run/step/artifact/human-input projection; event sequence is distinct from wall-clock time. | E2: [`export function reduceRun`](../../packages/core/src/events/reduce.ts#L6) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/core/src/events/reduce.ts#L6)) |
| Implemented | Requests and work items are separate document shapes; work-item dependency references become plan dependency records after registration. | E3: [`export const WorkItemSchema`](../../packages/core/src/model/request.ts#L66) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/core/src/model/request.ts#L66)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | OrcaEvent records | reduceRun / reduceRunSummary | data: fold in recorded order | Claim E2 above |
| E2 | reduceRun / reduceRunSummary | RunState / RunSummary | data: derive run and step state | Claim E2 above |
| E3 | Request / WorkItem documents | RunState / RunSummary | dependency: referenced by run identifiers | Claim E1 above |

## Limits

Schema declarations constrain parsed data; not every exported schema is validated on every in-process mutation.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
