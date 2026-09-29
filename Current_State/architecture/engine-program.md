# Requests and work-item projections

Owner: `packages/engine`. Granularity: component.

Scope and boundaries: program/service.ts, executors.ts and work-items.ts.

[SVG](../diagrams/svg/engine-program.svg) · [Editable JSON](../diagrams/source/engine-program.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | ProgramService.submit stores a Request, creates its program run and writes programRunId back; submitAndRun/resume settle terminal root outcomes onto the Request. | E1: [`export class ProgramService`](../../packages/engine/src/program/service.ts#L32) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/engine/src/program/service.ts#L32)) |
| Implemented | deriveWorkItemProgress maps child and skipped-branch records onto work-item status/runId; later attempts supersede earlier progress. | E2: [`export function deriveWorkItemProgress`](../../packages/engine/src/program/work-items.ts#L82) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/engine/src/program/work-items.ts#L82)) |
| Implemented | Claim release recovery can project a terminal child or reset an abandoned item while excluding a successor claimant. | E3: [`export async function recoverReleasedWorkItem`](../../packages/engine/src/program/work-items.ts#L47) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/engine/src/program/work-items.ts#L47)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | User request title/body/source | ProgramService | call: submit intent | Claim E1 above |
| E2 | ProgramService | Request document | data: create/link/settle request | Claim E1 above |
| E3 | ProgramService | Program + item run events | call: start and drive program run | Claim E1 above |
| E4 | Program + item run events | WorkItem projection | data: derive item progress | Claim E2 above |

## Limits

Request settlement is explicitly invoked by ProgramService callers; daemon run controls call Orchestrator directly. Status ownership therefore differs across these entry paths.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
