# Release, deployment and CI

Owner: `repository tooling`. Granularity: infrastructure.

Scope and boundaries: Root scripts, .github workflows, app packaging and tools/deploy.

[SVG](../diagrams/svg/delivery.svg) · [Editable JSON](../diagrams/source/delivery.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Declared | Root scripts define tsc project-reference compilation, Vite renderer bundling, Vitest, ESLint, formatting and design generation. CI declares Node 22/24 lanes plus desktop and smoke workflows. | E1: [`"scripts":`](../../package.json#L11) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/package.json#L11)) |
| Implemented | The standalone deployment tool stages releases and coordinates activation with process/admission checks, a pending journal, systemd stop/start, symlink selection and recovery. | E2: [`def activate(`](../../tools/deploy/orca-release.py#L241) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/tools/deploy/orca-release.py#L241)) |
| Implemented | Activation compatibility compares storeEpoch; store changes requiring a different epoch are refused rather than migrated automatically. | E3: [`def compatible(`](../../tools/deploy/orca-release.py#L91) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/tools/deploy/orca-release.py#L91)) |
| Declared | Desktop packages target Linux/macOS/Windows; mac signing/notarization is explicitly disabled in configuration. Publication waits for selected build/verification jobs. | E4: [`mac:`](../../packages/app/electron-builder.yml#L82) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/app/electron-builder.yml#L82)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | Source commit + lockfile + compatibility metadata | CI / release preparation and publication | dependency: configured checks/build/package | Claim E1 above |
| E2 | CI / release preparation and publication | Desktop artifacts + daemon bundle | data: publish matched release assets | Claim E4 above |
| E3 | Source commit + lockfile + compatibility metadata | Managed daemon release directory | data: stage verified managed release | Claim E2 above |
| E4 | Managed daemon release directory | systemd + current symlink + pending journal | call: guarded activate / recover | Claim E2 above |

## Limits

No workflow, deployment helper, packaging command or integration test was executed. Environment-provided signing, SSH and feed secrets were not read.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
