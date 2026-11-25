# Plan registration, scheduling and dispatch nodes

Owner: `packages/engine`. Granularity: component.

Scope and boundaries: plan/executors.ts.

[SVG](../diagrams/svg/engine-dispatch.svg) · [Editable JSON](../diagrams/source/engine-dispatch.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | Plan custom nodes register decomposition, ingest risks, compute a schedule, dispatch items and wait for dependencies through the same NodeExecutor contract. | E1: [`export const PLAN_EXECUTOR_TYPES`](../../packages/engine/src/plan/executors.ts#L870) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/engine/src/plan/executors.ts#L870)) |
| Implemented | planDispatchExecutor scopes candidate items, recomputes schedule, claims each item and launches children with upstream artifact context through FanOut. | E2: [`export const planDispatchExecutor`](../../packages/engine/src/plan/executors.ts#L512) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/engine/src/plan/executors.ts#L512)) |
| Implemented | The dispatch loop listens to the local plan journal and also has a polling fallback; wait mode has a deadline, while deferred/blocked/claimed outcomes remain distinct. | E3: [`const pollMs = n.pollMs`](../../packages/engine/src/plan/executors.ts#L551) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/engine/src/plan/executors.ts#L551)) |
| Implemented | Paused child runs park their parent; later execution reattaches prior branches instead of automatically creating replacements. | E4: [`const resumedId = self.interruptedChild`](../../packages/engine/src/orchestrator.ts#L1166) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/engine/src/orchestrator.ts#L1166)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | Decomposition / plan custom node | PlanService schedule + journal | call: register inputs / compute schedule | Claim E1 above |
| E2 | PlanService schedule + journal | Dispatcher + FanOut slots | message: ready set + journal wake-up | Claim E3 above |
| E3 | Dispatcher + FanOut slots | Persistent item claim | call: claim before launch | Claim E2 above |
| E4 | Dispatcher + FanOut slots | Child workflow runs | call: dispatch / reattach / cancel | Claim E4 above |

## Limits

Concurrency is allocated per dispatcher/FanOut; source does not show a shared host-wide quota or a durable global job queue.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
