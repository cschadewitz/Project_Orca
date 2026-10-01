# Workspace provisioning

Owner: `packages/engine`. Granularity: component.

Scope and boundaries: workspace/provider.ts and git-worktree.ts, plus Kepler adapter.

[SVG](../diagrams/svg/engine-workspaces.svg) · [Editable JSON](../diagrams/source/engine-workspaces.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | LocalWorkspaceProvider reuses one checkout and, for work items, checks out or creates orca/<slug>, recording the previous branch. | E1: [`export class LocalWorkspaceProvider`](../../packages/engine/src/workspace/provider.ts#L50) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/engine/src/workspace/provider.ts#L50)) |
| Implemented | GitWorktreeProvider creates/reuses an item directory and branch through AgentHost file and exec ports; ordinary non-item children can inherit the parent workspace. | E2: [`export class GitWorktreeProvider`](../../packages/engine/src/workspace/git-worktree.ts#L20) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/engine/src/workspace/git-worktree.ts#L20)) |
| Implemented | WorkspaceProvider exposes optional release; the interface explicitly leaves automatic cleanup to callers, and the interpreter execution-finally closes sessions rather than releasing workspaces. | E3: [`export interface WorkspaceProvider`](../../packages/engine/src/workspace/provider.ts#L23) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/engine/src/workspace/provider.ts#L23)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | Run + optional work item + parent | WorkspaceProvider.provision | call: request workspace | Claim E3 above |
| E2 | WorkspaceProvider.provision | Shared checkout / branch | call: local provider checkout | Claim E1 above |
| E3 | WorkspaceProvider.provision | Git worktree per slug | call: git-worktree provider create/reuse | Claim E2 above |
| E4 | WorkspaceProvider.provision | Workspace record in run.created | data: return resolved host/cwd/branch | Claim E1 above |

## Limits

Provisioning selects a directory; it does not impose process sandboxing. Parallel item runs with a shared local checkout need an explicit ownership policy.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
