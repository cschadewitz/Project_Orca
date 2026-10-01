# Planning application service

Owner: `packages/engine`. Granularity: component.

Scope and boundaries: plan/service.ts.

[SVG](../diagrams/svg/engine-plan.svg) · [Editable JSON](../diagrams/source/engine-plan.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | PlanService owns plan creation, item registration, dependency reconciliation, risk/decision mutation, artifact intake and schedule queries. | E1: [`export class PlanService`](../../packages/engine/src/plan/service.ts#L146) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/engine/src/plan/service.ts#L146)) |
| Implemented | withPlan serializes reentrant asynchronous operations by plan id/key within one service instance, using an in-memory promise map and async ownership context. | E2: [`private withPlan`](../../packages/engine/src/plan/service.ts#L187) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/engine/src/plan/service.ts#L187)) |
| Implemented | Artifact intake records produced stages and normalized signals; exceptions become reported issues/logs rather than rolling back the earlier run artifact event. | E3: [`async onArtifactRecorded`](../../packages/engine/src/plan/service.ts#L1271) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/engine/src/plan/service.ts#L1271)) |
| Inferred | Plan document updates and audit journal append are separate awaits. The journal is an audit of these mutations, not the sole replay source for the plan document collections. | E4: [`private async ensurePlanLocked`](../../packages/engine/src/plan/service.ts#L212) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/engine/src/plan/service.ts#L212)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | CLI / daemon controls / engine hooks | PlanService + local plan lock | call: register, mutate, reconcile, query | Claim E1 above |
| E2 | PlanService + local plan lock | Plan document collections | data: read/write business documents | Claim E4 above |
| E3 | PlanService + local plan lock | PlanJournal | data: append audit entries | Claim E4 above |
| E4 | PlanService + local plan lock | Core schedule / risk / matrix | call: derive schedule and decisions | Claim E1 above |

## Limits

A service lock is not an interprocess transaction. Scheduling is a snapshot computation; it does not itself reserve global execution capacity.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
