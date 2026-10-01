# CLI composition and configuration loading

Owner: `packages/cli`. Granularity: component.

Scope and boundaries: bootstrap.ts and selection.ts.

[SVG](../diagrams/svg/cli-bootstrap.svg) · [Editable JSON](../diagrams/source/cli-bootstrap.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | findConfig searches upward for yaml/yml/json config; paths and storeDir resolve against configDir, while missing configuration uses schema defaults. | E1: [`export async function loadConfig`](../../packages/cli/src/bootstrap.ts#L105) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/cli/src/bootstrap.ts#L105)) |
| Implemented | Plugins load serially as trusted ESM default exports before workflow validation and final Orchestrator construction. | E2: [`for (const spec of config.plugins)`](../../packages/cli/src/bootstrap.ts#L212) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/cli/src/bootstrap.ts#L212)) |
| Implemented | Run selection records role/model/item-workflow/template-pack overrides; template packs and model selection are checked against registries/known declarations. | E3: [`export function selectionOverrides`](../../packages/cli/src/commands/selection.ts#L115) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/cli/src/commands/selection.ts#L115)) |
| Implemented | ORCA_RELEASE placeholders are resolved to a concrete release path once for loaded templates/workflows. | E4: [`export async function releaseAssets`](../../packages/cli/src/bootstrap.ts#L275) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/cli/src/bootstrap.ts#L275)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | Config + defaults + CLI selection | Bootstrap loader | data: resolve config and asset paths | Claim E1 above |
| E2 | Bootstrap loader | Trusted ESM plugins | call: import and await register | Claim E2 above |
| E3 | Trusted ESM plugins | Registries / PlanService / stores | call: extend startup registries | Claim E2 above |
| E4 | Bootstrap loader | Orchestrator + ProgramService | call: validate then compose | Claim E2 above |

## Limits

PluginApi does not expose replacing SessionFactory, while a custom embedding can inject it. Config-only selection cannot activate every exported adapter.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
