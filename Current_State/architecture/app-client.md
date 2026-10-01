# Daemon transport client and IPC contract

Owner: `packages/app`. Granularity: component.

Scope and boundaries: src/client/, bridge.ts and preload/index.cts.

[SVG](../diagrams/svg/app-client.svg) · [Editable JSON](../diagrams/source/app-client.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | DaemonClient sends HTTP request envelopes and validates response envelope and method-specific result schema before returning typed data. | E1: [`async call<R>`](../../packages/app/src/client/daemon-client.ts#L179) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/src/client/daemon-client.ts#L179)) |
| Implemented | DaemonSubscription reconnects with bounded backoff values and uses since only for a run-specific subscription; parsed notifications drive listeners. | E2: [`private onOpen()`](../../packages/app/src/client/subscription.ts#L173) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/src/client/subscription.ts#L173)) |
| Implemented | Main bridge handlers return BridgeResult success/error values instead of IPC promise error stacks; preload exposes corresponding named methods. | E3: [`function handle<P, R>`](../../packages/app/src/main/index.ts#L72) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/src/main/index.ts#L72)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | Renderer typed bridge caller | CJS preload + main handlers | message: named request / BridgeResult | Claim E3 above |
| E2 | CJS preload + main handlers | DaemonClient / DaemonSubscription | call: invoke typed client method | Claim E1 above |
| E3 | DaemonClient / DaemonSubscription | HTTP /rpc + WS /socket | message: schema-validated wire exchange | Claim E1 above |
| E4 | HTTP /rpc + WS /socket | Renderer typed bridge caller | message: parsed notifications via IPC | Claim E2 above |

## Limits

Method names and shapes are represented across protocol, daemon tables, client, bridge, preload and main. Typechecking helps but registration parity is a separate maintenance concern.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
