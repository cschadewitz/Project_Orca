# Artifacts and workflow version storage

Owner: `packages/store`. Granularity: component.

Scope and boundaries: artifact-store.ts and workflow-store.ts.

[SVG](../diagrams/svg/store-content.svg) · [Editable JSON](../diagrams/source/store-content.json) · [Coverage](../baseline/coverage.md) · [Baseline](../baseline/index.md)

## Responsibilities and implementation evidence

| Level | Claim | Evidence |
| --- | --- | --- |
| Implemented | Artifacts use metadata records plus content-hash named blobs. FileArtifactStore reloads the committed metadata index on get/list and resolves bytes separately. | E1: [`export class FileArtifactStore`](../../packages/store/src/artifact-store.ts#L86) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/store/src/artifact-store.ts#L86)) |
| Implemented | Workflow definitions are stored once per id/version using an exclusive hard link of a temporary file; reads validate the stored definition. | E2: [`export class FileWorkflowVersionStore`](../../packages/store/src/workflow-store.ts#L48) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/store/src/workflow-store.ts#L48)) |
| Inferred | Artifact metadata and body writes, and later run-event append, form multiple durable operations. No store-wide garbage collector or lifecycle transaction is exposed by these ports. | E3: [`export interface ArtifactStore`](../../packages/store/src/artifact-store.ts#L37) ([pinned](https://github.com/cschadewitz/Project_Orca/blob/09f32690ffca5d9c79f6d8702481f6efe30a4cf3/packages/store/src/artifact-store.ts#L37)) |

## Interfaces and flow

| Edge | Producer / caller | Consumer / target | Meaning | Evidence |
| --- | --- | --- | --- | --- |
| E1 | Engine artifact recorder | artifacts/blobs/<hash> | data: write content bytes | Claim E1 above |
| E2 | Engine artifact recorder | artifacts/index.jsonl | data: append metadata | Claim E1 above |
| E3 | Workflow definition registry | workflows/<id>@v<version>.json | data: pin first definition for id/version | Claim E2 above |

## Limits

Workflow version ordering is lexical; templates and effective agent configuration are not part of this workflow-definition store.

The diagram is a selected architecture view, not a complete call graph. Component ownership is the outer frame; process, storage and external nodes are explicitly labeled. Edge styles follow the [shared notation](../diagrams/notation.md).

Related: [flows](../baseline/lifecycles.md), [data and contracts](../baseline/data-contracts.md), [inputs and extension points](../baseline/inputs-extensions.md), [engineering](../baseline/engineering.md).
