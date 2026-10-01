# @orca/daemon

Owner: `packages/daemon`. Granularity: package.

Scope and boundaries: Transport, method table, projections, controls and notifications.

[SVG](../diagrams/svg/daemon.svg) · [Editable JSON](../diagrams/source/daemon.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | methodsFor derives registered methods from provided read/control/config/plan/agent models and event sources. Missing capabilities are represented by absent method families. | E1: [`export function methodsFor`](../../packages/daemon/src/methods.ts#L605) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/daemon/src/methods.ts#L605)) |
| Implemented | ReadModel projects engine/store state into protocol views; ControlModel invokes orchestration and PlanControlModel invokes plan mutations. | E2: [`export class ControlModel`](../../packages/daemon/src/control.ts#L225) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/daemon/src/control.ts#L225)) |
| Implemented | Configuration writes and process-local subscriptions are distinct models; maintenance wraps method execution to close admission during update. | E3: [`export class Maintenance`](../../packages/daemon/src/maintenance.ts#L5) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/daemon/src/maintenance.ts#L5)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | HTTP / WebSocket transport | Method table + maintenance | call: dispatch validated envelope | Claim E1 above |
| E2 | Method table + maintenance | ReadModel / PlanModel / AgentModel | call: read operations | Claim E1 above |
| E3 | Method table + maintenance | ControlModel / PlanControlModel / ConfigModel | call: control / document operations | Claim E2 above |
| E4 | ReadModel / PlanModel / AgentModel | Orchestrator / stores / registries | call: read and project state | Claim E2 above |
| E5 | ControlModel / PlanControlModel / ConfigModel | Orchestrator / stores / registries | call: invoke owning service | Claim E2 above |

## Limits

Static source trace only. Runtime behavior, scale and interoperability have not been verified.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
