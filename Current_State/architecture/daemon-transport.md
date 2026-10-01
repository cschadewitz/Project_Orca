# RPC, socket and admission boundary

Owner: `packages/daemon`. Granularity: component.

Scope and boundaries: server.ts, socket.ts, methods.ts and maintenance.ts.

[SVG](../diagrams/svg/daemon-transport.svg) · [Editable JSON](../diagrams/source/daemon-transport.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | HTTP serves POST /rpc and GET /health; body size is limited, params are schema-checked and thrown errors become response envelopes. | E1: [`export async function dispatch`](../../packages/daemon/src/server.ts#L66) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/daemon/src/server.ts#L66)) |
| Implemented | The WebSocket upgrade accepts /socket, handles subscription lifecycle and routes other methods through the same dispatcher. | E2: [`export function attachSocket`](../../packages/daemon/src/socket.ts#L60) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/daemon/src/socket.ts#L60)) |
| Implemented | Maintenance tracks active wrapped method promises, admits hello/subscription management, and uses an optional persistent admission file plus token ownership. | E3: [`wrap(table:`](../../packages/daemon/src/maintenance.ts#L31) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/daemon/src/maintenance.ts#L31)) |
| Inferred | Default binding is loopback but host is configurable. Neither shown transport authenticates general RPC callers or checks WebSocket Origin. | E4: [`const host = opts.host`](../../packages/daemon/src/server.ts#L97) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/daemon/src/server.ts#L97)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | Local or configured network caller | HTTP /rpc or WS /socket | message: send envelope | Claim E1 above |
| E2 | HTTP /rpc or WS /socket | Method params validation | call: parse / select method | Claim E1 above |
| E3 | Method params validation | Maintenance barrier | call: admit tracked operation | Claim E3 above |
| E4 | Maintenance barrier | Model handler | call: await handler and map failure | Claim E3 above |

## Limits

Maintenance token coordinates update ownership; it is not general API authentication. Health answers process liveness, not complete storage/agent health.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
