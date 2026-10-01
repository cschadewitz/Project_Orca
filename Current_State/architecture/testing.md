# @orca/testing

Owner: `packages/testing`. Granularity: package.

Scope and boundaries: Scripted ACP agent, playbooks and test setup helpers.

[SVG](../diagrams/svg/testing.svg) · [Editable JSON](../diagrams/source/testing.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | ScriptedAgent implements an ACP agent driven by playbook responses, deliverable parsing, configured permissions/updates and persisted scripted state. | E1: [`export class ScriptedAgent`](../../packages/testing/src/scripted-agent/agent.ts#L62) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/testing/src/scripted-agent/agent.ts#L62)) |
| Implemented | The executable loads a playbook and serves ACP over stdio; tests and the CLI demo use this as a subprocess integration fixture. | E2: [`async function main`](../../packages/testing/src/scripted-agent/main.ts#L15) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/testing/src/scripted-agent/main.ts#L15)) |
| Declared | PlaybookSchema describes supported scripted response data and settings; it is deterministic test infrastructure, not evidence that a real provider behaves similarly. | E3: [`export const PlaybookSchema`](../../packages/testing/src/scripted-agent/playbook.ts#L38) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/testing/src/scripted-agent/playbook.ts#L38)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | Tests / CLI demo | Playbook YAML + state file | data: create scripted fixtures | Claim E1 above |
| E2 | Tests / CLI demo | orca-scripted-agent executable | call: spawn fixture agent | Claim E2 above |
| E3 | Playbook YAML + state file | orca-scripted-agent executable | data: select scripted responses | Claim E3 above |
| E4 | orca-scripted-agent executable | ACP requests and deliverable writes | message: simulate ACP + output files | Claim E1 above |

## Limits

The CLI declares this package as a runtime dependency for demo; its code is excluded from in-process coverage because tests spawn it.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
