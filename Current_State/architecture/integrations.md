# @orca/integrations

Owner: `packages/integrations`. Granularity: package.

Scope and boundaries: ACP facade, Kepler workspaces, T3 Code adapter and JEV plugin.

[SVG](../diagrams/svg/integrations.svg) · [Editable JSON](../diagrams/source/integrations.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | The package exports four independent adapters with different maturity and trust boundaries; core engine interfaces remain the integration seams. | E1: [`export * from "./acp-facade/index.js"`](../../packages/integrations/src/index.ts#L9) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/integrations/src/index.ts#L9)) |
| Implemented | The ACP facade exposes ORCA as an agent and translates ORCA events and human gates to the upstream client. | E2: [`export class OrcaAcpAgent`](../../packages/integrations/src/acp-facade/orca-acp-agent.ts#L87) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/integrations/src/acp-facade/orca-acp-agent.ts#L87)) |
| Implemented | T3CodeRpc has an injectable contract and an explicitly unimplemented default transport class. | E3: [`export class UnimplementedT3CodeRpc`](../../packages/integrations/src/t3code/session.ts#L161) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/integrations/src/t3code/session.ts#L161)) |
| Implemented | JEV is registered through the same custom executor plugin API used by application extensions. | E4: [`export function createJevEvalPlugin`](../../packages/integrations/src/jev/plugin.ts#L10) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/integrations/src/jev/plugin.ts#L10)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | ACP facade | Engine extension contracts | dependency: call orchestration and human-input port | Claim E2 above |
| E2 | Kepler provider | Engine extension contracts | dependency: implement workspace provider | Claim E1 above |
| E3 | T3 Code session adapter | Engine extension contracts | dependency: implement session contract via injected RPC | Claim E3 above |
| E4 | JEV evaluation plugin | Engine extension contracts | dependency: register custom executor | Claim E4 above |

## Limits

Static source trace only. Runtime behavior, scale and interoperability have not been verified.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
