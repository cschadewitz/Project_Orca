# Desktop workspace and daemon lifecycle

Owner: `packages/app`. Granularity: component.

Scope and boundaries: src/main/index.ts, workspace.ts, daemon-process.ts, connection-state.ts.

[SVG](../diagrams/svg/app-main.svg) · [Editable JSON](../diagrams/source/app-main.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | Workspace can choose explicit daemon URL, bundled daemon for the default workspace, or a read-only bundled daemon for an opened store. Switching closes the old stream and owned daemon before rebuilding the client. | E1: [`private async performSwitch`](../../packages/app/src/main/workspace.ts#L260) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/src/main/workspace.ts#L260)) |
| Implemented | Main forwards one store-wide daemon subscription to windows; per-run replay support in the client is not used for this shared store subscription. | E2: [`params: {},`](../../packages/app/src/main/index.ts#L220) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/src/main/index.ts#L220)) |
| Implemented | ConnectionMachine derives visible connection state from socket/handshake/process state, with delayed loss presentation and a generation signal for reattachment. | E3: [`export class ConnectionMachine`](../../packages/app/src/main/connection-state.ts#L115) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/src/main/connection-state.ts#L115)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | Open store / environment selection | Workspace state machine | call: choose target | Claim E1 above |
| E2 | Workspace state machine | Owned bundled daemon | call: start/stop own daemon only | Claim E1 above |
| E3 | Workspace state machine | DaemonClient + subscription | call: swap client and socket | Claim E1 above |
| E4 | DaemonClient + subscription | Connection snapshot to renderer | message: link state + hello + generation | Claim E3 above |

## Limits

File mode still reads through a daemon. A process opened by another operator is not owned by the app lifecycle.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
