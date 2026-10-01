# @orca/protocol

Owner: `packages/protocol`. Granularity: package.

Scope and boundaries: Wire envelopes, method schemas, views, notifications and compatibility.

[SVG](../diagrams/svg/protocol.svg) · [Editable JSON](../diagrams/source/protocol.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | Protocol uses request/response/notification envelopes with id/method/params and success/error results, validated with Zod. It is not a JSON-RPC 2.0 envelope. | E1: [`export const RequestMessageSchema`](../../packages/protocol/src/envelope.ts#L14) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/protocol/src/envelope.ts#L14)) |
| Implemented | Compatibility requires equal major and a daemon minor at least the client minor; current source constant is 1.8. | E2: [`export const PROTOCOL_VERSION`](../../packages/protocol/src/version.ts#L103) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/protocol/src/version.ts#L103)) |
| Implemented | DisplayStatus folds core run/step status and outcome plus lease context; it is a presentation vocabulary distinct from the seven core run states. | E3: [`export function displayStatusForRun`](../../packages/protocol/src/status.ts#L71) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/protocol/src/status.ts#L71)) |
| Declared | workflows.changed is a schema/client extension point without a runtime workflow reload producer traced in the method table and bootstrap. | E4: [``workflows.changed` is in the list`](../../packages/protocol/src/version.ts#L52) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/protocol/src/version.ts#L52)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | Protocol schemas + method constants | Core schema subpath / domain types | dependency: reuse domain schema/types | Claim E1 above |
| E2 | Daemon dispatch and projections | Protocol schemas + method constants | dependency: validate requests / construct views | Claim E1 above |
| E3 | App client / preload / renderer | Protocol schemas + method constants | dependency: validate results / notifications | Claim E1 above |
| E4 | Daemon dispatch and projections | Version + capabilities + errors | message: hello advertises compatibility | Claim E2 above |

## Limits

Method families: runs/events, inputs, artifacts, claims, workflows, agents, config, planning, controls, subscriptions and maintenance. Error code is open string; consumers must tolerate unknown codes. See data-contracts for family ownership.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
