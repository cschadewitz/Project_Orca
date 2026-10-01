# Run interpreter and context

Owner: `packages/engine`. Granularity: component.

Scope and boundaries: orchestrator.ts, run-context.ts and session-model.ts.

[SVG](../diagrams/svg/engine-interpreter.svg) · [Editable JSON](../diagrams/source/engine-interpreter.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | startRun pins a workflow definition, provisions workspace and appends run.created; run deduplicates in-process execution and acquires a run lease before loading context. | E1: [`private async executeLeased`](../../packages/engine/src/orchestrator.ts#L836) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/engine/src/orchestrator.ts#L836)) |
| Implemented | execute resumes from the final recorded step, schedules attempts, handles retry budgets, parks human waits and emits terminal outcomes. Losing the lease aborts without appending cancellation. | E2: [`private async execute(rc:`](../../packages/engine/src/orchestrator.ts#L934) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/engine/src/orchestrator.ts#L934)) |
| Implemented | RunContext appends events, reduces state and mirrors work-item projections; evaluation context reads visible artifacts and caches their immutable bodies by content hash. | E3: [`async evalContext`](../../packages/engine/src/run-context.ts#L237) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/engine/src/run-context.ts#L237)) |
| Implemented | Session pooling is per run and agent; it exists only in process memory and all pooled sessions close when the execution call exits. | E4: [`private async closeRunSessions`](../../packages/engine/src/orchestrator.ts#L1497) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/engine/src/orchestrator.ts#L1497)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | Start / resume / cancel caller | Run lease + Orchestrator | call: request execution/control | Claim E1 above |
| E2 | Run lease + Orchestrator | RunContext / reduced state | call: load pinned definition + replay | Claim E1 above |
| E3 | Run lease + Orchestrator | Node executors | call: schedule and await attempt | Claim E2 above |
| E4 | RunContext / reduced state | EventStore + document projections | data: append, reduce, mirror progress | Claim E3 above |

## Limits

Resumption replays workflow state and may reattempt an interrupted node. It is not a claim of exactly-once external agent side effects.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
