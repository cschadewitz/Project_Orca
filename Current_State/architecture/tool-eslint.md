# @orca/eslint-config

Owner: `tools/eslint-config`. Granularity: tool.

Scope and boundaries: Type-aware lint, app import boundary and token rules.

[SVG](../diagrams/svg/tool-eslint.svg) · [Editable JSON](../diagrams/source/tool-eslint.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Declared | The workspace config declares type-aware TypeScript lint, a header-comment rule, app import restrictions and token-only inline style rules. | E1: [`const appImportBoundary`](../../tools/eslint-config/index.js#L23) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/tools/eslint-config/index.js#L23)) |
| Implemented | A standalone CSS checker parses token usage patterns and reports violations in supplied files; root lint composes ESLint and this checker. | E2: [`import`](../../tools/eslint-config/bin/check-css-tokens.js#L10) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/tools/eslint-config/bin/check-css-tokens.js#L10)) |
| Declared | This workspace pins TypeScript 6.0.3 for typescript-eslint while root compilation declares TypeScript 7.0.2. | E3: [`"typescript":`](../../tools/eslint-config/package.json#L15) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/tools/eslint-config/package.json#L15)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | Root lint command | ESLint flat config + local rules | dependency: load lint configuration | Claim E1 above |
| E2 | ESLint flat config + local rules | App import/token/header constraints | call: enforce declared source boundaries | Claim E1 above |
| E3 | Root lint command | CSS token checker | call: scan renderer/component CSS | Claim E2 above |

## Limits

Enforcement coverage is configuration evidence, not a claim that current source passes lint.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
