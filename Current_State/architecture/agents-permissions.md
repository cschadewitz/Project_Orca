# Permission policy and standing rules

Owner: `packages/agents`. Granularity: component.

Scope and boundaries: permissions.ts and core/model/agent.ts.

[SVG](../diagrams/svg/agents-permissions.svg) · [Editable JSON](../diagrams/source/agents-permissions.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | First matching rule wins; configured rules precede sidecars, then built-in workspace rules apply only when default is unset. | E1: [`export function effectivePermissionPolicy`](../../packages/core/src/model/agent.ts#L289) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/core/src/model/agent.ts#L289)) |
| Implemented | Ask calls the supplied human channel, matches the selected option id and otherwise returns cancelled. Auto allow/deny select the agent-offered option kinds. | E2: [`export async function resolvePermission`](../../packages/agents/src/permissions.ts#L119) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/agents/src/permissions.ts#L119)) |
| Implemented | Policy sidecars are re-read for each live ask; unreadable sidecars are logged and skipped by the ACP adapter. | E3: [`const policyForAsk`](../../packages/agents/src/acp-session.ts#L94) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/agents/src/acp-session.ts#L94)) |
| Implemented | Standing decisions derive rules and use a dedicated file writer; callers receive added, existing or refused-rule details. | E4: [`export async function recordAlwaysDecision`](../../packages/agents/src/permissions.ts#L276) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/agents/src/permissions.ts#L276)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | Configured agent rules | effectivePermissionPolicy / decidePermission | data: highest rule precedence | Claim E1 above |
| E2 | orca.permissions.json | effectivePermissionPolicy / decidePermission | data: read overlay per ask | Claim E3 above |
| E3 | effectivePermissionPolicy / decidePermission | ACP offered permission options | message: select allow / deny / cancel | Claim E2 above |
| E4 | effectivePermissionPolicy / decidePermission | Human answer + standing rule writer | call: ask when policy requires | Claim E2 above |
| E5 | Human answer + standing rule writer | orca.permissions.json | data: persist derivable standing rule | Claim E4 above |

## Limits

Policy is cooperative authorization for reported ACP tool calls. A missing overlay and a corrupt overlay are different operational situations even though the session can fall back in both.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
