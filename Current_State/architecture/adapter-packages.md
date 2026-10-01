# Application, integration and tooling dependencies

Owner: `repository`. Granularity: system.

Scope and boundaries: Composition packages and build-only edges around the runtime spine.

[SVG](../diagrams/svg/adapter-packages.svg) · [Editable JSON](../diagrams/source/adapter-packages.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Declared | CLI composes the engine, integrations and daemon and includes scripted testing support for demo. | E1: [`"dependencies"`](../../packages/cli/package.json#L17) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/cli/package.json#L17)) |
| Declared | App runtime imports protocol/design; daemon is a development dependency used for bundled subprocess production. | E2: [`"dependencies"`](../../packages/app/package.json#L17) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/package.json#L17)) |
| Declared | Integrations depend on engine/agents/store/core; testing depends on agents/core and ACP SDK. | E3: [`"dependencies"`](../../packages/integrations/package.json#L21) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/integrations/package.json#L21)) |
| Declared | Font and ESLint tools are independent workspace dependency closures. | E4: [`packages:`](../../pnpm-workspace.yaml#L2) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/pnpm-workspace.yaml#L2)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | @orca/cli: composition and executables | @orca/integrations: ACP / Kepler / T3 / JEV | dependency: compose adapters | Claim E1 above |
| E2 | @orca/cli: composition and executables | @orca/engine + daemon runtime spine | dependency: direct runtime services | Claim E1 above |
| E3 | @orca/cli: composition and executables | @orca/testing: scripted ACP executable | dependency: demo fixture runtime dependency | Claim E1 above |
| E4 | @orca/integrations: ACP / Kepler / T3 / JEV | @orca/engine + daemon runtime spine | dependency: engine ports; also agents/store/core | Claim E3 above |
| E5 | @orca/app: desktop processes | @orca/protocol + design | dependency: runtime wire/design imports | Claim E2 above |
| E6 | @orca/app: desktop processes | @orca/engine + daemon runtime spine | dependency: development-only daemon bundling | Claim E2 above |
| E7 | font-build + eslint-config tooling | @orca/protocol + design | dependency: generate fonts / enforce source constraints | Claim E4 above |

## Limits

Detailed external and development dependencies are in the manifest table. Build-time inclusion of daemon code is separate from renderer authority.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
