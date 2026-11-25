# Workflow, expression and template authoring

Owner: `packages/core`. Granularity: component.

Scope and boundaries: workflow/, expr/, template/, frontmatter/glob utilities.

[SVG](../diagrams/svg/core-authoring.svg) · [Editable JSON](../diagrams/source/core-authoring.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | Workflow loading parses YAML/JSON through WorkflowDefinitionSchema; validation checks graph routing, references and built-in node fields. | E1: [`export function parseWorkflow`](../../packages/core/src/workflow/load.ts#L10) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/core/src/workflow/load.ts#L10)) |
| Implemented | Expression calls resolve through a function map and evaluate a parsed AST. This path does not evaluate arbitrary JavaScript source. | E2: [`function evalAst`](../../packages/core/src/expr/evaluate.ts#L77) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/core/src/expr/evaluate.ts#L77)) |
| Implemented | Templates support expression interpolation, if/each and named partials with a depth bound. A selected pack tries pack/id before the base template. | E3: [`get(id:`](../../packages/core/src/template/registry.ts#L65) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/core/src/template/registry.ts#L65)) |
| Implemented | Custom node shape is permissive; built-in workflow validation cannot fully validate every plugin-specific field. | E4: [`export const CustomNodeSchema`](../../packages/core/src/model/workflow.ts#L308) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/core/src/model/workflow.ts#L308)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | Workflow YAML/JSON and template files | Schema + graph validation | data: parse definitions | Claim E1 above |
| E2 | Schema + graph validation | Registries | data: register loaded definitions | Claim E1 above |
| E3 | Engine executor context | Registries | call: select definition and template | Claim E3 above |
| E4 | Engine executor context | AST expression / template rendering | call: evaluate conditions and render prompt | Claim E2 above |

## Limits

Template bodies were not read as project documentation during baseline; parsers, registries, renderers and template-file metadata were inspected.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
