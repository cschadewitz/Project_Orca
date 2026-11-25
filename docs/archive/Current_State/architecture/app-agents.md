# Agents and claims UI

Owner: `packages/app`. Granularity: component.

Scope and boundaries: renderer/agents/.

[SVG](../diagrams/svg/app-agents.svg) · [Editable JSON](../diagrams/source/app-agents.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | useAgents reads configured agents/health, applies agent.changed and loads claim ownership; reattachment generation causes reread. | E1: [`export function useAgents`](../../packages/app/renderer/src/agents/use-agents.ts#L75) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/renderer/src/agents/use-agents.ts#L75)) |
| Implemented | AgentsSurface groups cards and presents claim release controls with method/writability checks. | E2: [`export function AgentsSurface`](../../packages/app/renderer/src/agents/agents-surface.tsx#L73) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/renderer/src/agents/agents-surface.tsx#L73)) |
| Implemented | Health is reported by daemon AgentModel rather than probing from renderer; the preload exposes agents.list only. | E3: [`agents: { list:`](../../packages/app/src/preload/index.cts#L108) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/src/preload/index.cts#L108)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | agents.list / claims.list | useAgents + grouping model | call: read snapshots | Claim E1 above |
| E2 | agent.changed | useAgents + grouping model | message: merge health updates | Claim E1 above |
| E3 | useAgents + grouping model | Agent cards + ownership rows | data: render host/role/health groups | Claim E2 above |
| E4 | Agent cards + ownership rows | claims.release bridge | call: release selected claim | Claim E2 above |

## Limits

Configured agent identity, health of recent handshakes, and individual agent sessions are distinct. Cards do not prove continuous agent availability.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
