# Shipped workflow and template assets

Owner: `repository assets`. Granularity: assets.

Scope and boundaries: workflows/, templates/, examples/.

[SVG](../diagrams/svg/workflow-assets.svg) · [Editable JSON](../diagrams/source/workflow-assets.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Declared | The shipped program workflow composes decomposition, plan registration/risk/schedule/dispatch stages; ai-sdlc and plan-resume are separate workflow definitions. | E1: [`id:`](../../workflows/program.yaml#L4) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/workflows/program.yaml#L4)) |
| Implemented | Template discovery loads files from configured glob patterns and registers parsed front matter/body; user packs use prefix-based selection. | E2: [`export async function loadTemplates`](../../packages/core/src/template/load.ts#L7) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/core/src/template/load.ts#L7)) |
| Implemented | Plugin example demonstrates registration through definePlugin; production startup imports configured ESM modules before graph validation. | E3: [`definePlugin`](../../examples/plugin-example.ts#L5) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/examples/plugin-example.ts#L5)) |
| Declared | The JEV example opts into an evaluation plugin and shadow workflow explicitly; it is not a global evaluator enabled by default. | E4: [`plugins:`](../../examples/jev/orca.config.yaml#L43) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/examples/jev/orca.config.yaml#L43)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | Configured workflow/template globs | Core loaders + registries | data: select discovery roots | Claim E2 above |
| E2 | Shipped and user-authored files | Core loaders + registries | data: parse authoring assets | Claim E2 above |
| E3 | Core loaders + registries | Engine built-ins / custom plugins | data: supply graphs and prompt bodies | Claim E1 above |

## Limits

Baseline inspected workflow YAML as executable definitions and template discovery/frontmatter identifiers; natural-language template prose was deferred to the documentation phase.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
