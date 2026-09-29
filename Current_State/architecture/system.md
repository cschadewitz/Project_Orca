# System and process boundaries

Owner: `repository`. Granularity: system.

Scope and boundaries: CLI/daemon process; Electron main/preload/renderer; agent subprocesses; local store; external services.

[SVG](../diagrams/svg/system.svg) · [Editable JSON](../diagrams/source/system.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | CLI bootstrap composes registries, file or memory stores, PlanService, Orchestrator and ProgramService; most CLI commands execute this stack in their own process. | E1: [`export async function bootstrap`](../../packages/cli/src/bootstrap.ts#L176) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/cli/src/bootstrap.ts#L176)) |
| Implemented | The daemon exposes HTTP RPC and an optional WebSocket endpoint using injected models and event sources. It is a mode of the CLI executable, not a separate orchestration implementation. | E2: [`export async function startDaemon`](../../packages/daemon/src/server.ts#L96) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/daemon/src/server.ts#L96)) |
| Implemented | Electron main owns a daemon client, daemon lifecycle and IPC. The renderer receives a named bridge through an isolated sandboxed preload. | E3: [`function createWindow()`](../../packages/app/src/main/index.ts#L478) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/src/main/index.ts#L478)) |
| Implemented | Agent execution crosses a local-child or SSH stdio boundary; artifact collection reads the agent host filesystem and records content in the orchestrator store. | E4: [`async function collect(`](../../packages/engine/src/executors/agent-step.ts#L110) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/engine/src/executors/agent-step.ts#L110)) |
| Implemented | JEV optionally sends selected artifact bodies and rendered context to an external HTTPS service; this is separate from ACP agent execution. | E5: [`async evaluate(request:`](../../packages/integrations/src/jev/http-provider.ts#L33) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/integrations/src/jev/http-provider.ts#L33)) |
| Inferred | Trust rests on configured programs, plugins, filesystem ownership and daemon reachability. The shown RPC dispatcher performs message/schema validation but has no caller identity authorization. | E6: [`export async function dispatch`](../../packages/daemon/src/server.ts#L66) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/daemon/src/server.ts#L66)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | Human / CLI or ACP host | CLI bootstrap + engine + daemon models | call: CLI commands or ACP prompt | Claim E1 above |
| E2 | Electron renderer → preload → main | CLI bootstrap + engine + daemon models | message: HTTP RPC / WebSocket notifications | Claim E2 above |
| E3 | CLI bootstrap + engine + daemon models | Run logs, plan documents, artifacts | data: append, project and read | Claim E1 above |
| E4 | CLI bootstrap + engine + daemon models | Local or SSH ACP agent | message: ACP turns; collect host files | Claim E4 above |
| E5 | CLI bootstrap + engine + daemon models | Optional TypeSafe JEV service | data: JEV POST with selected input bodies | Claim E5 above |

## Limits

No process was started; external protocol interoperability and deployment reachability remain unverified.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
