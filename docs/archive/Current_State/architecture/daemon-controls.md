# Run, input and planning controls

Owner: `packages/daemon`. Granularity: component.

Scope and boundaries: control.ts and plan-control.ts.

[SVG](../diagrams/svg/daemon-controls.svg) · [Editable JSON](../diagrams/source/daemon-controls.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | answerAndResume centralizes input lookup, option validation and refusal semantics; standing permission writes occur before recording the answer. | E1: [`export async function answerAndResume`](../../packages/daemon/src/control.ts#L91) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/daemon/src/control.ts#L91)) |
| Implemented | runs.start and runs.resume await execution until it pauses or terminates; control response latency therefore spans the workflow execution call. | E2: [`async startRun(params:`](../../packages/daemon/src/control.ts#L315) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/daemon/src/control.ts#L315)) |
| Implemented | PlanControlModel handles dependency waivers, decisions, reopening and risk updates, using PlanService and read projections for results. | E3: [`export class PlanControlModel`](../../packages/daemon/src/plan-control.ts#L55) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/daemon/src/plan-control.ts#L55)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | App / RPC control parameters | ControlModel / PlanControlModel | call: answer / resume / start / mutate | Claim E1 above |
| E2 | ControlModel / PlanControlModel | Orchestrator / PlanService | call: validate ownership and execute | Claim E2 above |
| E3 | ControlModel / PlanControlModel | Permission sidecar | data: record standing grant if requested | Claim E1 above |
| E4 | ControlModel / PlanControlModel | Updated protocol view / fault | data: return after service settlement | Claim E2 above |

## Limits

Read-only removes control methods; agents.ping remains possible when an AgentModel is present. Run control is not request submission through ProgramService.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
