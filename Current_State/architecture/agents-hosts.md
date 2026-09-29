# Host adapters and agent registry

Owner: `packages/agents`. Granularity: component.

Scope and boundaries: host.ts and hosts/.

[SVG](../diagrams/svg/agents-hosts.svg) · [Editable JSON](../diagrams/source/agents-hosts.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | LocalHost spawns the configured command/args with inherited environment overlaid by agent and invocation environment; its exec path uses a shell. | E1: [`spawnAgent(agent:`](../../packages/agents/src/hosts/local-host.ts#L47) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/agents/src/hosts/local-host.ts#L47)) |
| Implemented | SshHost constructs a quoted login-shell command over the ssh binary; remote filesystem methods issue shell commands, including batched existence checks. | E2: [`spawnAgent(agent:`](../../packages/agents/src/hosts/ssh-host.ts#L66) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/agents/src/hosts/ssh-host.ts#L66)) |
| Implemented | Agent health is memory owned by the registry: handshake success/failure and stream activity update it; it is not a persistent agent history. | E3: [`export class AgentHealthTracker`](../../packages/agents/src/hosts/registry.ts#L95) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/agents/src/hosts/registry.ts#L95)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | Registry + role mapping | Host interface | call: resolve agent host | Claim E1 above |
| E2 | Host interface | Local child process / filesystem | call: spawn and file operations | Claim E1 above |
| E3 | Host interface | SSH child / remote shell / files | message: SSH command and content stream | Claim E2 above |
| E4 | Registry + role mapping | Health memory | data: record handshake / activity | Claim E3 above |

## Limits

SSH transport uses the local ssh process and remote credentials/configuration. Remote process-tree cleanup and cross-OS path semantics require later execution evidence.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
