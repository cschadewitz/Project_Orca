# Node execution and artifact handoff

Owner: `packages/engine`. Granularity: component.

Scope and boundaries: executors/basic.ts, agent-step.ts, containers.ts and types.ts.

[SVG](../diagrams/svg/engine-execution.svg) · [Editable JSON](../diagrams/source/engine-execution.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | runAgentTurn resolves input artifacts, renders a selected template/inline prompt, assigns private attempt output paths, invokes the session, collects/validates deliverables and sends bounded follow-ups. | E1: [`export async function runAgentTurn`](../../packages/engine/src/executors/agent-step.ts#L279) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/engine/src/executors/agent-step.ts#L279)) |
| Implemented | Loop/parallel/subworkflow executors use child runs. FanOut limits concurrent children, captures failures and provides a shared abort signal; parallel join and failFast choose settlement. | E2: [`export class FanOut`](../../packages/engine/src/executors/containers.ts#L130) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/engine/src/executors/containers.ts#L130)) |
| Implemented | Agent updates are coalesced into a serial append chain; the step observes append failure when draining rather than assuming the callback persisted it. | E3: [`class UpdateRecorder`](../../packages/engine/src/executors/agent-step.ts#L163) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/engine/src/executors/agent-step.ts#L163)) |
| Implemented | The interpreter routes to the first true conditional edge, otherwise the unconditional edge; terminal result.outcome ends the run irrespective of node type. | E4: [`private async route(`](../../packages/engine/src/orchestrator.ts#L1075) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/engine/src/orchestrator.ts#L1075)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | StepContext + selected node | Basic / agent / container executor | call: execute node contract | Claim E1 above |
| E2 | Basic / agent / container executor | Child runs or AgentSession | call: prompt or runChild | Claim E2 above |
| E3 | Child runs or AgentSession | Host deliverable files | data: produce attempt outputs | Claim E1 above |
| E4 | Basic / agent / container executor | Host deliverable files | data: read and validate deliverables | Claim E1 above |
| E5 | Basic / agent / container executor | ArtifactStore + run events | data: record artifact and update stream | Claim E3 above |

## Limits

artifact-present polls only required file existence before requesting cancel; artifact validation occurs in collection. Follow-ups and whole-step retries are separate budgets.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
