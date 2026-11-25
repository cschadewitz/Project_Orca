# CLI commands and server modes

Owner: `packages/cli`. Granularity: component.

Scope and boundaries: commands/, format.ts and human-input-cli.ts.

[SVG](../diagrams/svg/cli-commands.svg) · [Editable JSON](../diagrams/source/cli-commands.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | run/submit/answer/plan commands directly call services; answer supplies ProgramService.resume so request settlement follows the root result. | E1: [`resumeWith: (id) => app.program.resume(id)`](../../packages/cli/src/commands/index.ts#L591) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/cli/src/commands/index.ts#L591)) |
| Implemented | serve composes read/control/config/agent/plan models and uses PausingHumanInput for writing daemon mode. Its subscriptions attach to this process’s stores only. | E2: [`serve: {`](../../packages/cli/src/commands/index.ts#L621) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/cli/src/commands/index.ts#L621)) |
| Implemented | Process error handlers log and keep serving for serve mode but exit nonzero for one-shot commands. | E3: [`export function installProcessErrorHandlers`](../../packages/cli/src/main.ts#L114) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/cli/src/main.ts#L114)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | Run / submit / plan / ownership commands | Bootstrap + services | call: direct service calls | Claim E1 above |
| E2 | serve HTTP/WS mode | Bootstrap + services | dependency: wire daemon models | Claim E2 above |
| E3 | acp stdio facade mode | Bootstrap + services | dependency: wire ACP adapter | Claim E2 above |
| E4 | Run / submit / plan / ownership commands | Terminal human input / formatting | call: prompt / render result | Claim E1 above |

## Limits

The commands module also embeds a large demo fixture and server composition. Long-running process fault containment is not proven by logging uncaught errors.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
