# Configuration document editing

Owner: `packages/daemon`. Granularity: component.

Scope and boundaries: config-model.ts and config-schema.ts.

[SVG](../diagrams/svg/daemon-config.svg) · [Editable JSON](../diagrams/source/daemon-config.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | ConfigModel reads raw config and permission documents, hashes revisions and returns a schema description plus effective policy. Raw text is returned without redaction. | E1: [`async get():`](../../packages/daemon/src/config-model.ts#L150) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/daemon/src/config-model.ts#L150)) |
| Implemented | Set supports text/patch and validateOnly; revision comparison occurs under the respective writer lock and refusal preserves the client draft. | E2: [`private async writeConfigFile`](../../packages/daemon/src/config-model.ts#L216) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/daemon/src/config-model.ts#L216)) |
| Implemented | The model changes files and publishes document revisions. Bootstrap-built registries remain fixed; live sessions independently re-read permission sidecars. | E3: [`const agents = AgentRegistry.fromConfig(config)`](../../packages/cli/src/bootstrap.ts#L182) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/cli/src/bootstrap.ts#L182)) |
| Implemented | Schema description walks Zod nodes to derive field descriptions rather than maintaining a second manually written config field list. | E4: [`export function describeConfigSchema`](../../packages/daemon/src/config-schema.ts#L50) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/daemon/src/config-schema.ts#L50)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | Config form/raw draft | ConfigModel revision + validation | call: patch/text with expectedRevision | Claim E2 above |
| E2 | ConfigModel revision + validation | orca.config.yaml/json | data: locked atomic config write | Claim E2 above |
| E3 | ConfigModel revision + validation | orca.permissions.json | data: sidecar-specific replace | Claim E2 above |
| E4 | ConfigModel revision + validation | config.changed + effective view | message: publish revision after write | Claim E1 above |

## Limits

Editing an agent executable, templates or workspace config is not a hot-reload operation. Reflection depends on Zod structural details and needs compatibility coverage.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
