# @orca/agents

Owner: `packages/agents`. Granularity: package.

Scope and boundaries: Agent registry, host processes, ACP sessions and permissions.

[SVG](../diagrams/svg/agents.svg) · [Editable JSON](../diagrams/source/agents.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | AgentRegistry resolves concrete agent ids or roles to AgentSpec and AgentHost; per-run role overrides are separate views over the registry. | E1: [`resolve(selector:`](../../packages/agents/src/hosts/registry.ts#L325) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/agents/src/hosts/registry.ts#L325)) |
| Implemented | AgentSession abstracts prompt, updates, config options, cancellation and close; openAcpSession supplies the production stdio implementation. | E2: [`export interface AgentSession`](../../packages/agents/src/session.ts#L28) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/agents/src/session.ts#L28)) |
| Implemented | Permission evaluation combines configured policy, sidecar rules and conditional defaults before selecting an ACP permission option. | E3: [`export async function loadEffectivePermissionPolicy`](../../packages/agents/src/permissions.ts#L216) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/agents/src/permissions.ts#L216)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | ACP AgentSession | AgentRegistry + health | dependency: resolve configured agent and host | Claim E1 above |
| E2 | ACP AgentSession | LocalHost / SshHost | call: spawn process / access files | Claim E2 above |
| E3 | ACP AgentSession | Permission evaluation | call: resolve permission requests | Claim E3 above |
| E4 | LocalHost / SshHost | External ACP binary | message: stdio or SSH stdio | Claim E2 above |

## Limits

Static source trace only. Runtime behavior, scale and interoperability have not been verified.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
