# Planning algorithms

Owner: `packages/core`. Granularity: component.

Scope and boundaries: plan/ and model/plan.ts.

[SVG](../diagrams/svg/core-planning.svg) · [Editable JSON](../diagrams/source/core-planning.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | computeSchedule classifies ready, running, waiting, held, unschedulable and settled items using supplied items, dependencies, risks, decisions and time. | E1: [`export function computeSchedule`](../../packages/core/src/plan/schedule.ts#L222) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/core/src/plan/schedule.ts#L222)) |
| Implemented | Hard dependency cycles block scheduling; optional soft edges inform ordering and cycle-closing soft edges are dropped. Stage dependencies use produced artifact kinds. | E2: [`const blockingGraph`](../../packages/core/src/plan/schedule.ts#L242) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/core/src/plan/schedule.ts#L242)) |
| Implemented | Decision matrices rank weighted criteria and report sensitivity; extracted artifact signals normalize risks, decisions and dependency references. | E3: [`export function evaluateDecisionMatrix`](../../packages/core/src/plan/decision-matrix.ts#L75) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/core/src/plan/decision-matrix.ts#L75)) |
| Implemented | Dependency evaluation returns persisted satisfied/waived states directly before checking target work-item/decision state. | E4: [`export function evaluateDependency`](../../packages/core/src/plan/schedule.ts#L102) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/core/src/plan/schedule.ts#L102)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | Plan snapshot + time + policy | Dependency graph / risk exposure | data: build and score graph | Claim E2 above |
| E2 | Dependency graph / risk exposure | computeSchedule | data: classify candidates | Claim E1 above |
| E3 | computeSchedule | Schedule + reasons + critical path | data: return derived snapshot | Claim E1 above |
| E4 | Matrix / artifact signals | Plan snapshot + time + policy | data: produce normalized planning inputs | Claim E3 above |

## Limits

Critical-path length uses estimate weights; it is not elapsed time or ETA. The comment describing all dependency evaluation as live is broader than the early satisfied-state return.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
