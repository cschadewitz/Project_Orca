# @orca/app

Owner: `packages/app`. Granularity: package.

Scope and boundaries: Electron main, CJS preload, React renderer and browser-safe client contracts.

[SVG](../diagrams/svg/app.svg) · [Editable JSON](../diagrams/source/app.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | Electron main owns daemon lifecycle/client, updates, OS alerts, preferences and IPC; BrowserWindow uses sandbox and context isolation. | E1: [`function createWindow()`](../../packages/app/src/main/index.ts#L478) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/src/main/index.ts#L478)) |
| Implemented | The preload exposes a fixed window.orca API; it does not expose generic ipcRenderer or a raw filesystem interface. | E2: [`const bridge: OrcaBridge`](../../packages/app/src/preload/index.cts#L45) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/src/preload/index.cts#L45)) |
| Implemented | The renderer composes a shared notification stream, keyboard/layer registries, appearance and announcement channels around the route-driven app. | E3: [`const keyboard = new KeyboardMap`](../../packages/app/renderer/src/main.tsx#L31) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/renderer/src/main.tsx#L31)) |
| Declared | ESLint restricts app workspace imports to protocol and design; daemon is a development dependency to build the separate bundled subprocess. | E4: [`const appImportBoundary`](../../tools/eslint-config/index.js#L23) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/tools/eslint-config/index.js#L23)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | React renderer process | Isolated CJS preload bridge | call: named window.orca calls / listeners | Claim E2 above |
| E2 | Isolated CJS preload bridge | Electron main process | message: fixed IPC channels | Claim E2 above |
| E3 | Electron main process | HTTP/WS daemon process | message: RPC and subscription transport | Claim E1 above |
| E4 | Electron main process | Preferences / private update credentials | data: main-owned preferences and feed secret | Claim E1 above |

## Limits

Static source trace only. Runtime behavior, scale and interoperability have not been verified.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
