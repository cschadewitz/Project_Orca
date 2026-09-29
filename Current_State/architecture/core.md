# @orca/core

Owner: `packages/core`. Granularity: package.

Scope and boundaries: Shared domain, authoring, pure planning and utilities.

[SVG](../diagrams/svg/core.svg) · [Editable JSON](../diagrams/source/core.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | Exports a browser-safe schema subpath plus Node-aware loading/utilities through the main barrel. The package has no workspace runtime dependencies. | E1: [`export * from "./schemas.js"`](../../packages/core/src/index.ts#L7) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/core/src/index.ts#L7)) |
| Implemented | Run state is folded from typed events; planning scheduling and matrix evaluation are functions over supplied snapshots. | E2: [`export function reduceRun`](../../packages/core/src/events/reduce.ts#L6) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/core/src/events/reduce.ts#L6)) |
| Implemented | Authoring combines workflow schemas/validation, a custom expression interpreter, and a custom prompt template renderer. | E3: [`export function validateWorkflow`](../../packages/core/src/workflow/validate.ts#L31) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/core/src/workflow/validate.ts#L31)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | Engine, store, protocol consumers | Domain schemas + event reducer | dependency: use domain contracts and projections | Claim E1 above |
| E2 | Engine, store, protocol consumers | Workflow / expression / templates | call: load and evaluate definitions | Claim E3 above |
| E3 | Engine, store, protocol consumers | Plan graph, risk, decisions, scheduling | call: compute planning decisions | Claim E2 above |

## Limits

Static source trace only. Runtime behavior, scale and interoperability have not been verified.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
