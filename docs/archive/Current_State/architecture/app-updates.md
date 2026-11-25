# Desktop updates and restart coordination

Owner: `packages/app`. Granularity: component.

Scope and boundaries: main/updates.ts, update-driver.ts, update-ipc.ts, workspace update hooks.

[SVG](../diagrams/svg/app-updates.svg) · [Editable JSON](../diagrams/source/app-updates.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | updateDriver enables the private HTTPS generic feed only in packaged Windows x64/arm64 builds, reads credentials from an operator file and disables automatic download/install and downgrade. | E1: [`export function updateDriver`](../../packages/app/src/main/update-driver.ts#L5) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/src/main/update-driver.ts#L5)) |
| Implemented | Updates orders draft preparation, daemon maintenance preparation, daemon stop and installer invocation; failure attempts resume and releases draft holds. | E2: [`async act(action:`](../../packages/app/src/main/updates.ts#L32) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/src/main/updates.ts#L32)) |
| Implemented | Workspace prepares/stops only its owned daemon; external daemon lifecycle is separate from installing the desktop app. | E3: [`async prepareUpdate`](../../packages/app/src/main/workspace.ts#L134) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/src/main/workspace.ts#L134)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | User check/download/restart | Updates state machine | call: explicit update action | Claim E2 above |
| E2 | Updates state machine | Private HTTPS feed + NsisUpdater | call: check/download/install | Claim E1 above |
| E3 | Updates state machine | Renderer draft acknowledgments | message: prepare draft barrier | Claim E2 above |
| E4 | Updates state machine | Owned daemon maintenance / stop | call: close admission then stop | Claim E3 above |

## Limits

Cross-platform desktop packaging does not imply cross-platform in-app updates. Credentials and feed service are external deployment dependencies.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
