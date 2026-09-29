# ACP session lifecycle

Owner: `packages/agents`. Granularity: component.

Scope and boundaries: acp-session.ts, session.ts and config-options.ts.

[SVG](../diagrams/svg/agents-session.svg) · [Editable JSON](../diagrams/source/agents-session.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | openAcpSession spawns a process, connects ACP, initializes capabilities, then creates a new ACP session with cwd and configured MCP servers. | E1: [`export async function openAcpSession`](../../packages/agents/src/acp-session.ts#L69) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/agents/src/acp-session.ts#L69)) |
| Implemented | One active prompt is admitted per session; timeout/abort requests cancellation, grace expiry fails the turn and termination escalates from SIGTERM to SIGKILL. | E2: [`const requestCancel`](../../packages/agents/src/acp-session.ts#L283) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/agents/src/acp-session.ts#L283)) |
| Implemented | ACP fs handlers restrict absolute paths lexically to configured roots, then delegate to HostFileSystem; they do not sandbox direct agent OS operations. | E3: [`function withinRoots`](../../packages/agents/src/acp-session.ts#L61) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/agents/src/acp-session.ts#L61)) |
| Implemented | The concrete adapter creates session/new and exposes no session/load method through AgentSession. Engine run replay therefore is distinct from restoring an ACP conversation. | E4: [`export interface AgentSession`](../../packages/agents/src/session.ts#L28) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/agents/src/session.ts#L28)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | Engine session factory | openAcpSession | call: open and prompt / cancel / close | Claim E1 above |
| E2 | openAcpSession | ACP agent process | message: initialize → session/new → prompt | Claim E1 above |
| E3 | ACP agent process | Updates + config option cache | message: session/update notifications | Claim E1 above |
| E4 | ACP agent process | Host filesystem roots | call: fs requests through root checks | Claim E3 above |

## Limits

External agents may operate outside ACP fs callbacks. Path checks are not a claim of realpath/symlink confinement.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
