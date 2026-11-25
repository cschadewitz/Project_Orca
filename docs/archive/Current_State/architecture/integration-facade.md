# ORCA as an upstream ACP agent

Owner: `packages/integrations`. Granularity: component.

Scope and boundaries: acp-facade/.

[SVG](../diagrams/svg/integration-facade.svg) · [Editable JSON](../diagrams/source/integration-facade.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | The facade keeps in-memory sessions with selected workflow/roles/models/template pack and exposes session/new, prompt, config option change and cancel. It advertises loadSession false. | E1: [`register(app:`](../../packages/integrations/src/acp-facade/orca-acp-agent.ts#L132) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/integrations/src/acp-facade/orca-acp-agent.ts#L132)) |
| Implemented | /run selects a workflow, /status reports prior runs, ordinary text starts the selected workflow or submits a Request through ProgramService. | E2: [`private async prompt(`](../../packages/integrations/src/acp-facade/orca-acp-agent.ts#L217) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/integrations/src/acp-facade/orca-acp-agent.ts#L217)) |
| Implemented | Human questions route by run/ancestor to the bound upstream session and map gate options onto ACP permission options; output forwarding is serialized. | E3: [`async ask(q:`](../../packages/integrations/src/acp-facade/upstream-human-input.ts#L67) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/integrations/src/acp-facade/upstream-human-input.ts#L67)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | Upstream ACP client | OrcaAcpAgent session selection | message: session/new, config, prompt, cancel | Claim E1 above |
| E2 | OrcaAcpAgent session selection | ProgramService / Orchestrator | call: start workflow or submit request | Claim E2 above |
| E3 | ProgramService / Orchestrator | UpstreamHumanInput run bindings | call: ask decision/permission | Claim E3 above |
| E4 | UpstreamHumanInput run bindings | Upstream ACP client | message: request_permission options | Claim E3 above |
| E5 | ORCA event stream | Upstream ACP client | message: translated session/update | Claim E2 above |

## Limits

Facade session selections are not persisted across process restarts. ACP capability support is a subset; actual host interoperability was not exercised.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
