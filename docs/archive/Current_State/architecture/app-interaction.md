# Shared renderer interaction infrastructure

Owner: `packages/app`. Granularity: component.

Scope and boundaries: renderer/ui/, list/, keyboard-map, palette, layers and a11y/.

[SVG](../diagrams/svg/app-interaction.svg) · [Editable JSON](../diagrams/source/app-interaction.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | VirtualList renders a viewport window, owns row semantics/selection keys and supports follow/hold and prepend compensation. | E1: [`export function VirtualList`](../../packages/app/renderer/src/list/virtual-list.tsx#L161) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/renderer/src/list/virtual-list.tsx#L161)) |
| Implemented | KeyboardMap registers scoped commands; the palette reads command registries and object sources, while LayerStack centralizes Escape behavior. | E2: [`export class KeyboardMap`](../../packages/app/renderer/src/keyboard-map.ts#L273) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/renderer/src/keyboard-map.ts#L273)) |
| Implemented | Menu owns popup focus/placement and routes navigation through shared keyboard infrastructure; announcer holds a common live region. | E3: [`export function Menu`](../../packages/app/renderer/src/ui/menu.tsx#L256) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/renderer/src/ui/menu.tsx#L256)) |
| Implemented | Pane boundaries share a registry that validates/clamps remembered sizes and connects to preferences. | E4: [`export const PANE_BOUNDARIES`](../../packages/app/renderer/src/panes.ts#L88) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/renderer/src/panes.ts#L88)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | Surface components | UI primitives + Menu + PaneSplitter | dependency: compose reusable controls | Claim E3 above |
| E2 | Surface components | VirtualList + viewport arithmetic | dependency: render row windows | Claim E1 above |
| E3 | UI primitives + Menu + PaneSplitter | KeyboardMap / layers / palette | call: register scoped commands | Claim E2 above |
| E4 | VirtualList + viewport arithmetic | KeyboardMap / layers / palette | call: register list navigation | Claim E1 above |
| E5 | Surface components | Shared announcements + preferences | call: announce and persist choices | Claim E4 above |

## Limits

Accessibility and layout behavior are intended by source/test contracts; no rendered UI or assistive technology was exercised.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
