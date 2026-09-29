# JEV evaluation executor

Owner: `packages/integrations`. Granularity: component.

Scope and boundaries: jev/.

[SVG](../diagrams/svg/integration-jev.svg) · [Editable JSON](../diagrams/source/integration-jev.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | The plugin registers custom:jev-eval. Execution validates the custom node, requires a pinned model, resolves explicitly selected artifacts and bounds serialized state characters. | E1: [`export function jevEvalExecutor`](../../packages/integrations/src/jev/executor.ts#L138) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/integrations/src/jev/executor.ts#L138)) |
| Implemented | The HTTP provider sends a bearer-authenticated POST /v1/systemone. Node timeout and run cancellation are composed into a signal. | E2: [`async evaluate(request:`](../../packages/integrations/src/jev/http-provider.ts#L33) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/integrations/src/jev/http-provider.ts#L33)) |
| Implemented | Response validation checks requested answer keys and numerical structures; results or configured failure records become provenance-bearing artifacts with parent input ids. | E3: [`export function validateJevResponse`](../../packages/integrations/src/jev/validate.ts#L122) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/integrations/src/jev/validate.ts#L122)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | Custom node + rubric + selected artifacts | JEV executor + validation | data: resolve, bound and validate inputs | Claim E1 above |
| E2 | JEV executor + validation | Injected provider / HTTP provider | call: evaluate with timeout/abort | Claim E2 above |
| E3 | Injected provider / HTTP provider | TypeSafe service | data: POST selected bodies and context | Claim E2 above |
| E4 | JEV executor + validation | Evaluation artifact + step data | data: record validated result or failure | Claim E3 above |

## Limits

Credentials come from injection or environment; model output quality, billing and service availability are outside static scope. This review does not verify third-party API documentation.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
