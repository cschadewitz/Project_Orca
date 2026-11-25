# @orca/cli

Owner: `packages/cli`. Granularity: package.

Scope and boundaries: Executable command dispatch, composition and human terminal adapter.

[SVG](../diagrams/svg/cli.svg) · [Editable JSON](../diagrams/source/cli.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | main uses strict parseArgs and dispatches named commands; errors produce stderr diagnostics and nonzero status. | E1: [`export async function main`](../../packages/cli/src/main.ts#L23) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/cli/src/main.ts#L23)) |
| Implemented | Commands include validate/graph, agents/ping, run/submit/runs/status/events/answer, ACP/daemon modes, planning, claims, leases, Kepler inspection and demo. | E2: [`export const commands:`](../../packages/cli/src/commands/index.ts#L262) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/cli/src/commands/index.ts#L262)) |
| Implemented | CLI mostly composes the engine locally, while agent discovery/ping can contact a daemon. This creates legitimate simultaneous file-store clients. | E3: [`async function pingViaDaemon`](../../packages/cli/src/commands/index.ts#L185) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/cli/src/commands/index.ts#L185)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | argv + cwd + config path | main + command handlers | data: strict argument parse | Claim E1 above |
| E2 | main + command handlers | bootstrap composition | call: construct command runtime | Claim E2 above |
| E3 | bootstrap composition | Local engine / stores | call: wire runtime services | Claim E2 above |
| E4 | main + command handlers | Daemon probe / ACP host / terminal | message: probe or serve integration | Claim E3 above |

## Limits

Static source trace only. Runtime behavior, scale and interoperability have not been verified.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
