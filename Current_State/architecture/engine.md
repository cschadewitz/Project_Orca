# @orca/engine

Owner: `packages/engine`. Granularity: package.

Scope and boundaries: Interpreter and application services, executors, workspace and plugin ports.

[SVG](../diagrams/svg/engine.svg) · [Editable JSON](../diagrams/source/engine.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | Orchestrator composes stores, registries, executors, a session factory, human-input port, workspace provider and PlanService. | E1: [`export interface OrchestratorOptions`](../../packages/engine/src/orchestrator.ts#L86) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/engine/src/orchestrator.ts#L86)) |
| Implemented | Built-in node executors include basic routing, agent turns, containers and program/plan custom executors. | E2: [`export function builtinExecutors`](../../packages/engine/src/executors/index.ts#L28) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/engine/src/executors/index.ts#L28)) |
| Implemented | PluginApi exposes registries and plan service plus human/workspace replacements; SessionFactory is separately injected through OrchestratorOptions. | E3: [`export interface PluginApi`](../../packages/engine/src/plugin.ts#L14) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/engine/src/plugin.ts#L14)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | Orchestrator / RunContext | NodeExecutorRegistry + executors | call: execute one node attempt | Claim E2 above |
| E2 | Orchestrator / RunContext | PlanService / ProgramService | call: synchronize planning and request lifecycle | Claim E1 above |
| E3 | Orchestrator / RunContext | Agents + stores + core | dependency: persist and invoke agents | Claim E1 above |
| E4 | Orchestrator / RunContext | Workspace / human-input / plugin ports | call: invoke injected services | Claim E3 above |

## Limits

Static source trace only. Runtime behavior, scale and interoperability have not been verified.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
