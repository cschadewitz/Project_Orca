# Kepler task directory adapter

Owner: `packages/integrations`. Granularity: component.

Scope and boundaries: kepler/workspace-provider.ts.

[SVG](../diagrams/svg/integration-kepler.svg) · [Editable JSON](../diagrams/source/integration-kepler.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | inspectKeplerTask scans task child directories for .git, reads AGENTS/CLAUDE task text and derives a task id from a tasks/<uuid> path. | E1: [`export async function inspectKeplerTask`](../../packages/integrations/src/kepler/workspace-provider.ts#L34) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/integrations/src/kepler/workspace-provider.ts#L34)) |
| Implemented | Provision picks a worktree by work-item repo, matching parent, first worktree, or falls back to parent/task directory. | E2: [`export class KeplerTaskWorkspaceProvider`](../../packages/integrations/src/kepler/workspace-provider.ts#L66) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/integrations/src/kepler/workspace-provider.ts#L66)) |
| Inferred | This adapter integrates through directory conventions rather than a Kepler MCP RPC client; configured agent MCP servers are a separate ACP session mechanism. | E3: [`mcpServers: opts.agent.mcpServers`](../../packages/agents/src/acp-session.ts#L207) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/agents/src/acp-session.ts#L207)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | Kepler task directory | inspectKeplerTask | data: read task files / discover worktrees | Claim E1 above |
| E2 | inspectKeplerTask | KeplerTaskWorkspaceProvider | data: provide candidates and task context | Claim E2 above |
| E3 | KeplerTaskWorkspaceProvider | Run workspace record | data: choose cwd/host | Claim E2 above |

## Limits

Directory conventions are assumptions, not a versioned Kepler API. This review did not inspect actual external task contents through this code.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
