# T3 Code session adapter boundary

Owner: `packages/integrations`. Granularity: component.

Scope and boundaries: t3code/contracts.ts and session.ts.

[SVG](../diagrams/svg/integration-t3code.svg) · [Editable JSON](../diagrams/source/integration-t3code.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | openT3CodeSession creates a thread, subscribes to thread events and maps prompt/cancel/close onto orchestration commands. | E1: [`export async function openT3CodeSession`](../../packages/integrations/src/t3code/session.ts#L33) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/integrations/src/t3code/session.ts#L33)) |
| Declared | T3CodeRpc and mirrored command/event types define the expected external contract; the file labels them handwritten mirrors. | E2: [`export interface T3CodeRpc`](../../packages/integrations/src/t3code/contracts.ts#L52) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/integrations/src/t3code/contracts.ts#L52)) |
| Implemented | UnimplementedT3CodeRpc throws NOT_SUPPORTED for both call and subscribe; no concrete transport is wired by CLI bootstrap. | E3: [`export class UnimplementedT3CodeRpc`](../../packages/integrations/src/t3code/session.ts#L161) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/integrations/src/t3code/session.ts#L161)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | Injected SessionFactory caller | T3 Code session adapter | call: open with project/model/RPC | Claim E1 above |
| E2 | T3 Code session adapter | Injected T3CodeRpc | call: dispatch commands / subscribe | Claim E1 above |
| E3 | Injected T3CodeRpc | External T3 Code server | declared: transport contract; implementation absent | Claim E3 above |

## Limits

A supported configuration-only T3 connection and live contract compatibility are not established. Treat as partial adapter implementation, not a shipped end-to-end transport.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
