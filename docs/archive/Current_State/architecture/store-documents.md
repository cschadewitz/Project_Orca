# Mutable document collections

Owner: `packages/store`. Granularity: component.

Scope and boundaries: Requests, work items, plans, dependencies, risks, decisions.

[SVG](../diagrams/svg/store-documents.svg) · [Editable JSON](../diagrams/source/store-documents.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | JsonFileDocumentStore maintains an inode/size/mtime cache, overlays queued changes for reads and coalesces concurrent mutations into locked whole-file rewrites. | E1: [`export class JsonFileDocumentStore`](../../packages/store/src/document-store.ts#L80) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/store/src/document-store.ts#L80)) |
| Implemented | The writer reloads under its file lock, writes a temporary file, syncs that file and renames it into place. | E2: [`private enqueue(`](../../packages/store/src/document-store.ts#L145) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/store/src/document-store.ts#L145)) |
| Inferred | A service-level list-then-put decision remains outside the collection lock. Independent services can base business decisions on separate snapshots even when individual writes serialize. | E3: [`private withPlan`](../../packages/engine/src/plan/service.ts#L187) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/engine/src/plan/service.ts#L187)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | PlanService / ProgramService / projections | DocumentStore<T> | call: get/list/put/putMany/delete | Claim E1 above |
| E2 | DocumentStore<T> | Mutation queue + fingerprint cache | data: queue and overlay mutations | Claim E1 above |
| E3 | Mutation queue + fingerprint cache | Whole-collection JSON file | data: locked reload, sync, rename | Claim E2 above |

## Limits

The inspected shared-store PlanService test uses sequential service calls; it does not establish simultaneous uniqueness or multi-file transaction isolation.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
