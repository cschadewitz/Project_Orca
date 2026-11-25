# @orca/design

Owner: `packages/design`. Granularity: package.

Scope and boundaries: Token/semantic sources, generated CSS/TS/fonts and component CSS/API.

[SVG](../diagrams/svg/design.svg) · [Editable JSON](../diagrams/source/design.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | build-tokens.js reads tokens.json and semantics.json and emits CSS custom properties/type styles and typed TypeScript maps; check mode compares generated output. | E1: [`const T = read`](../../packages/design/build-tokens.js#L17) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/design/build-tokens.js#L17)) |
| Implemented | Component CSS consumes tokens; React primitives live in app, while component-api.d.ts describes their expected properties. | E2: [`export interface`](../../packages/design/src/component-api.d.ts#L28) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/design/src/component-api.d.ts#L28)) |
| Declared | Contrast, font, token and component tests declare invariants for both themes and semantic glyph/type coverage. These tests were not run. | E3: [`test(`contrast`](../../packages/design/test/contrast.test.ts#L108) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/design/test/contrast.test.ts#L108)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | tokens.json + semantics.json | build-tokens.js | data: source design values and words | Claim E1 above |
| E2 | build-tokens.js | Generated CSS + TS maps | data: generate / compare output | Claim E1 above |
| E3 | Component CSS + API declarations | Generated CSS + TS maps | dependency: reference tokens | Claim E2 above |
| E4 | App primitives and surfaces | Component CSS + API declarations | dependency: compose style-backed primitives | Claim E2 above |

## Limits

Generated outputs were inventoried, not regenerated. Bundled font production belongs to the separate font-build workspace.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
