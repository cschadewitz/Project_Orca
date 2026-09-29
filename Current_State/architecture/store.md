# @orca/store

Owner: `packages/store`. Granularity: package.

Scope and boundaries: Persistence ports and file/memory implementations.

[SVG](../diagrams/svg/store.svg) · [Editable JSON](../diagrams/source/store.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | Stores groups events, artifacts, requests, workItems, claims, leases, plan collections/journal and workflow versions; bootstrap selects fileStores or memoryStores. | E1: [`export interface Stores`](../../packages/store/src/document-store.ts#L223) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/store/src/document-store.ts#L223)) |
| Implemented | File implementations combine per-log append serialization, whole-collection rewrites, blob files, immutable workflow definitions and ownership records. | E2: [`export function fileStores`](../../packages/store/src/document-store.ts#L239) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/store/src/document-store.ts#L239)) |
| Inferred | These ports expose no cross-collection transaction; durability and atomicity are operation-specific rather than one database transaction spanning a run and plan. | E3: [`export interface DocumentStore`](../../packages/store/src/document-store.ts#L20) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/store/src/document-store.ts#L20)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | Engine / daemon readers | Stores ports | call: invoke persistence ports | Claim E1 above |
| E2 | Stores ports | JSONL run + plan logs | data: append and replay | Claim E2 above |
| E3 | Stores ports | JSON documents + blobs + versions | data: read/write collections and content | Claim E2 above |
| E4 | Stores ports | Claims / leases / file locks | call: coordinate ownership | Claim E2 above |

## Limits

Static source trace only. Runtime behavior, scale and interoperability have not been verified.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
