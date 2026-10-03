# Shared interfaces for review

All new names below are **proposed app-local structural interfaces**. They are
not exports, IPC names, plugin APIs or advertised daemon capabilities. Freeze and
compile-check them in the accepted implementation baseline before agent kickoff.
The integrator alone publishes canonical types. Feature branches use matching
injected structural fixtures, never a moving peer branch.

## Reuse the current contracts

From `@orca/protocol`, reuse `ConfigDocument`, `ConfigFieldDescription`,
`ConfigSchemaDescription`, `ConfigSetParams`, `ConfigSetResult`,
`ConfigApplyParams`, `ConfigApplyResult`, `ConfigGenerationStatus`,
`WorkflowInputSchemaView`, `WorkflowsValidateInputsResult`, `RunsStartParams`
and the accepted Request/retry contracts. Renderer imports stay within
`@orca/protocol` and `@orca/design`; no core/engine/daemon runtime imports.

The inspected `RunOverrides` has exactly optional `roles: Record<string, string>`,
`model: string | Record<string, string>`, `itemWorkflow: string` and
`templatePack: string` fields. `model` is singular on the wire; there is no
top-level `agent` override. `roles` maps a role to an agent ID. Request submission
also carries `title`, `body`, optional `source`, `labels`, `workflowId`, the three
version/generation guard fields, `vars` and `overrides`. Use the canonical schema
rather than rebuilding it from this description. Direct launch exposes only
`workflowId`, `vars`, the three guards and optional authorized `requestId` /
`workItemId` associations; it never creates a Request through those associations.

`config.set` takes one of `text` or `patch`, `document`, `expectedRevision`,
and optional `validateOnly`. Missing patch `value` means deletion, not null.
`config.apply` takes `expectedRevision`, nonempty `expectedGeneration`, and
optional `validateOnly`; its outcomes are `applied`, `unchanged`, `validated`,
`restart-required`, `invalid`. Do not collapse those into a boolean success.

```ts
// Proposed app-only identity, copied from the verified connection snapshot.
interface EditorTarget {
  readonly workspaceId: string;
  readonly instanceId: string;
  readonly epoch: number;
}

type DocumentPath = readonly (string | number)[];
type EditIntent =
  | { kind: "set"; path: DocumentPath; value: unknown }
  | { kind: "remove"; path: DocumentPath }
  | { kind: "insert"; path: DocumentPath; index: number; value: unknown }
  | { kind: "move"; path: DocumentPath; from: number; to: number };

interface ConfigCandidate {
  readonly target: EditorTarget;
  readonly document: ConfigDocument;
  readonly expectedRevision: string;
  readonly draftSequence: number;
  readonly edits: readonly EditIntent[];
}

interface ConfigReview {
  readonly target: EditorTarget;
  readonly document: ConfigDocument;
  readonly expectedRevision: string;
  readonly draftSequence: number;
  readonly candidateRevision: string; // from validated candidate bytes
  readonly validation: readonly { path: string; message: string }[];
  readonly changes: readonly {
    path: DocumentPath;
    kind: "added" | "removed" | "changed" | "moved";
    valueDisplay: "withheld" | "non-secret";
  }[];
}
```

`EditIntent` is a pure UI operation list, **not a new wire patch format**. At
freeze the integrator must choose and prove its lowering to existing comment-
preserving edits, or propose a separately reviewed daemon extension. Never join
arbitrary record keys with dots/brackets and assume lossless addressing. Reject
unsafe/ambiguous keys in the structured control; retain the original document.
Operations are ordered, use pre-operation indices, and are validated against the
same base revision; stable UI row keys are not persisted domain IDs. No rename
silently rewrites references. No `undefined` payload is JSON-encoded as deletion.

The candidate document text available to the existing authorized editor remains
private to that editor. `ConfigReview` is a control/provenance object, not a
replacement copy of the document. Changes are summarized without echoing secret
values. A renderer review is not a server authorization token or transaction lock.

## Proposed richer form metadata (not a plugin manifest)

```ts
type FieldShape =
  | { kind: "scalar"; field: ConfigFieldDescription }
  | { kind: "object"; optional: boolean; fields: Readonly<Record<string, FieldShape>> }
  | { kind: "array"; item: FieldShape }
  | { kind: "record"; value: FieldShape }
  | { kind: "union"; discriminator: string;
      branches: Readonly<Record<string, FieldShape>> }
  | { kind: "unsupported"; reason: "opaque" | "metadata-unavailable" };
```

This proposal supplements existing schema-derived metadata; it must be generated
from the authoritative schemas, versioned/validated by the integrator and passed
through approved protocol discovery before production use. Do not hard-code a
second validation schema in React. Metadata text/defaults must obey the same
sensitivity policy as their source; sensitive defaults/enums must not leak via
descriptions, preview, logs, fixtures or error messages. A form cannot infer that
a field is non-secret because current `ConfigFieldDescription` has no flag.
Unknown plugin/extension shapes stay preserved and unsupported. No plugin code
is loaded merely to draw a form. No provider credential names are invented.

## Immutable launch review identity

```ts
interface LaunchReview {
  readonly target: EditorTarget;
  readonly draftSequence: number;
  readonly mode: "direct" | "request";
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly expectedWorkflowRevision: string;
  readonly expectedConfigGeneration: string;
  readonly checkoutEvidence:
    | { state: "unavailable" }
    | { state: "verified"; evidenceId: string }; // D1 owner-defined, not a new RPC
}

type LaunchUiState =
  | { phase: "editing" }
  | { phase: "review"; review: LaunchReview }
  | { phase: "submitting"; review: LaunchReview; intentId: string }
  | { phase: "recovering"; intentId: string; operationId?: string }
  | { phase: "admitted"; admissionId: string; requestId?: string; runId: string }
  | { phase: "blocked"; reason:
      "target-changed" | "stale-review" | "unavailable" | "unauthorized" |
      "validation" | "recovery-required" };
```

These are UI phases, not new run statuses or daemon error codes. The launch draft
retains its local typed input values; the review DTO does not echo them. A
reviewed command and local input display must refer to the same frozen draft
sequence. Command editing, target change, workflow revision/config generation
movement or relevant capability change invalidates the review. Current auth is
rechecked server-side at submission and recovery, never frozen inside this DTO.

Map `workflowVersion`, `expectedWorkflowRevision`, `expectedConfigGeneration`
unchanged into accepted direct/Request commands. The app-owned target fence is
not an extra property injected into legacy RPC schemas. `intentId` denotes the
client submission intent; it is not `operationId`, `admissionId`, `requestId` or
`runId`. Bind it once to the accepted #331 idempotency key. `RetryResult` must
remain intact: `in-progress` and resolved `prepared`/`recoverable-failure` do not
map to `admitted`. A run ID alone does not prove accepted execution.

No production `launch.review` API, checkout evidence token semantics, persistent
draft format or new RPC is created here. Those gaps require the ownership and
freeze gate in [handoff](handoff-and-tests.md).
