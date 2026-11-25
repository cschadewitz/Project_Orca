# @orca/font-build

Owner: `tools/font-build`. Granularity: tool.

Scope and boundaries: Font source dependencies, subsetting and committed outputs.

[SVG](../diagrams/svg/tool-fonts.svg) · [Editable JSON](../diagrams/source/tool-fonts.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | The font build script consumes installed IBM Plex and Noto font sources, subsets selected glyph ranges and emits bundled font assets. | E1: [`import`](../../tools/font-build/build-fonts.js#L26) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/tools/font-build/build-fonts.js#L26)) |
| Declared | Font source packages and subset tools are isolated in a tooling workspace, with upstream telemetry postinstalls disabled in workspace configuration. | E2: [`"@ibm/plex-sans": false`](../../pnpm-workspace.yaml#L19) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/pnpm-workspace.yaml#L19)) |
| Declared | Design font tests inspect declared faces/glyph coverage and bundled files. | E3: [`describe(`](../../packages/design/test/fonts.test.ts#L36) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/design/test/fonts.test.ts#L36)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | IBM Plex + Noto packages | font-build subsetting script | data: read pinned dependency font inputs | Claim E1 above |
| E2 | font-build subsetting script | Committed woff2 + licenses | data: subset and emit | Claim E1 above |
| E3 | Committed woff2 + licenses | Design CSS / app renderer | dependency: load bundled typefaces | Claim E3 above |

## Limits

No assets were regenerated; actual glyph rendering is unverified.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
