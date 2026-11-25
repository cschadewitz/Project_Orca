# Runtime package dependency spine

Owner: `repository`. Granularity: system.

Scope and boundaries: Core, stores, agents, engine, protocol and daemon; arrows mean imports, not network calls.

[SVG](../diagrams/svg/runtime-packages.svg) · [Editable JSON](../diagrams/source/runtime-packages.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Declared | Manifests declare engine dependencies on core/store/agents; store and agents depend on core. | E1: [`"dependencies"`](../../packages/engine/package.json#L17) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/engine/package.json#L17)) |
| Declared | Protocol depends on core schemas; daemon depends on protocol, core, engine, agents and store. | E2: [`"dependencies"`](../../packages/daemon/package.json#L17) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/daemon/package.json#L17)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | @orca/store: persistence ports | @orca/core: domain and pure algorithms | dependency: domain contracts | Claim E1 above |
| E2 | @orca/agents: hosts and sessions | @orca/core: domain and pure algorithms | dependency: agent configuration contracts | Claim E1 above |
| E3 | @orca/engine: orchestration | @orca/store: persistence ports | dependency: persistence ports | Claim E1 above |
| E4 | @orca/engine: orchestration | @orca/agents: hosts and sessions | dependency: agent/host invocation | Claim E1 above |
| E5 | @orca/engine: orchestration | @orca/core: domain and pure algorithms | dependency: domain and algorithms | Claim E1 above |
| E6 | @orca/protocol: wire schemas | @orca/core: domain and pure algorithms | dependency: browser-safe schemas | Claim E2 above |
| E7 | @orca/daemon: wire adaptation | @orca/protocol: wire schemas | dependency: method envelopes and views | Claim E2 above |
| E8 | @orca/daemon: wire adaptation | @orca/engine: orchestration | dependency: orchestration controls; also store/core/agents | Claim E2 above |

## Limits

Manifest declarations are the dependency graph basis. Transitive dependencies are omitted from arrows; all direct manifest edges are tabulated in baseline/dependencies.md.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
