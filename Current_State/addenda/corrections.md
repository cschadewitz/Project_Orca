# Source-backed corrections after the checkpoint

These corrections supersede the specified baseline statements. They were made after documentation comparison began; the 186 frozen baseline files and their hashes remain unchanged. Existing documentation prompted reinspection, but **implementation source is the evidence for every correction**. Neither correction nor comparison implies runtime verification. [Checkpoint](../BASELINE-CHECKPOINT.md) · [Baseline](../baseline/index.md) · [Differences](../comparison/differences.md)

## C01 Workflow version identity is conditional

**Affected:** the word “pinned” in [lifecycles](../baseline/lifecycles.md), [data contracts](../baseline/data-contracts.md), [U04](../baseline/uncertainties.md), and the [interpreter](../architecture/engine-interpreter.md) / [stored-content](../architecture/store-content.md) specifications must be read with this qualification.

**Implemented:** `Orchestrator.definitionFor` selects the registered definition when its version string matches the run's recorded version; only otherwise does it retrieve the stored definition. An older run without `workflowStored` may fall back to the current registered definition. A missing required version raises `WORKFLOW_VERSION_NOT_FOUND`. Consequently, saving the first definition under an `(id, version)` key does **not** establish immutable replay when somebody edits a file without changing its version. The baseline overstated the guarantee when it used “pinned” without qualification. [async definitionFor(](../../packages/engine/src/orchestrator.ts#L722); [export class FileWorkflowVersionStore](../../packages/store/src/workflow-store.ts#L48).

**Inferred:** full invocation reproducibility additionally depends on separately loaded templates, agent configuration and plugin/provider versions; the baseline's broader uncertainty remains. No claim is made about a resumed execution's actual outputs.

## C02 Artifact RPC has a text view and omission metadata

**Affected:** E4 in [daemon projections](../architecture/daemon-projections.md), including its editable JSON evidence claim, and the corresponding artifact-view sentence in [data contracts](../baseline/data-contracts.md). “Text, image and binary views” was incorrect.

**Implemented:** `artifactsGet` returns metadata plus `text` for supported text content within the requested limit; it returns an `omitted` reason of `binary` for non-text media and `tooLarge` for oversized text. `ArtifactsGetResultSchema` has no image payload field. The artifact panel renders the returned text in a `pre` element. The underlying artifact store can retain bytes; that does not imply an image rendering or binary-download RPC. [async artifactsGet(](../../packages/daemon/src/read-model.ts#L582); [export const ArtifactsGetResultSchema](../../packages/protocol/src/artifacts.ts#L104); [Artifact panel text body](../../packages/app/renderer/src/artifacts/artifact-panel.tsx#L243).

The original diagram's generic view/data edges remain usable; this correction replaces its inaccurate claim, not its topology.

## C03 Artifact blob paths are relative to the artifact directory

**Affected:** the storage table in [data contracts](../baseline/data-contracts.md) abbreviates the blob path as `blobs/<hash>` beside `artifacts/index.jsonl`, making its root ambiguous.

**Implemented:** the full paths relative to `storeDir` are **`artifacts/blobs/<sha256>`** and **`artifacts/index.jsonl`**. `FileArtifactStore` constructs its `JsonlLogDir` under `artifacts` and its blob base from that same directory. [export class FileArtifactStore](../../packages/store/src/artifact-store.ts#L86); [private get base()](../../packages/store/src/artifact-store.ts#L95).

## C04 Run variables are merged without a workflow-specific input validator

**Affected:** stage 3 of [lifecycles](../baseline/lifecycles.md) says `startRun` “validates variables.” That is too broad.

**Implemented:** `startRun` validates supplied selection overrides, records the workflow definition, provisions/accepts the workspace and appends run creation. It merges `def.vars` with `opts.vars`. Workflow `inputs` is a map of names to descriptive strings, explicitly informational, and `vars` admits unknown values; this path does not enforce a workflow-specific required-input/type schema. Transport/CLI parsing and run-event schemas provide their own structural checks, which are different from validating workflow input semantics. [startRun](../../packages/engine/src/orchestrator.ts#L214), [validateOverrides](../../packages/engine/src/orchestrator.ts#L794), [WorkflowDefinition inputs](../../packages/core/src/model/workflow.ts#L340).

This correction limits the baseline claim; it does not recommend inventing a new input-schema system without a product requirement. It also reinforces why schema declarations must be distinguished from a traced validation call.

## Documentation clarifies one uncertainty without changing source facts

Baseline U10 observed the early return for already-satisfied dependencies. [PLANNING](../../docs/PLANNING.md#L201) explicitly distinguishes sticky `satisfied`/`waived` states from live evaluation of `open`/`failed` dependencies. This supplies evidence of **declared intent**, not proof of all reopening paths. The observed implementation is unchanged; the remaining cross-document terminology discrepancy is D09.
