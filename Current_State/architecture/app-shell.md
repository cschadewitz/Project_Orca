# Renderer shell, navigation and appearance

Owner: `packages/app`. Granularity: component.

Scope and boundaries: renderer/App.tsx, routes/route-table, chrome/, appearance/panes.

[SVG](../diagrams/svg/app-shell.svg) · [Editable JSON](../diagrams/source/app-shell.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | App owns active surface, route, dock content and one shared Attention feed used by chrome counts and surfaces. | E1: [`const attention = useAttention()`](../../packages/app/renderer/src/App.tsx#L138) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/renderer/src/App.tsx#L138)) |
| Implemented | Surface identity comes from design semantics; route resolution maps object links to surfaces and selections. | E2: [`export function resolveRoute`](../../packages/app/renderer/src/route-table.ts#L89) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/renderer/src/route-table.ts#L89)) |
| Implemented | Preferences store theme, per-surface density, pane sizes and alert settings; mergePreferences applies patches without resetting unrelated choices. | E3: [`export function mergePreferences`](../../packages/app/src/preferences/schema.ts#L136) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/src/preferences/schema.ts#L136)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | Routes / deep links / command palette | App shell + shared Attention feed | call: select surface/object | Claim E2 above |
| E2 | App shell + shared Attention feed | Five surfaces + dock | containment: render selected content | Claim E1 above |
| E3 | Appearance + PaneSplitter registry | Five surfaces + dock | data: apply token-bound layout choices | Claim E3 above |
| E4 | Appearance + PaneSplitter registry | Main PreferencesFile | message: read/write preference patch | Claim E3 above |

## Limits

The five surfaces are Attention, Runs, Plan, Agents and Config; workflow inspection is reached through Config/routes, not a sixth top-level surface.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
