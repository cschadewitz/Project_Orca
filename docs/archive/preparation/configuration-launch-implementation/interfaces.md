# Shared interfaces for review

All new names below are **proposed app-local structural interfaces**. They are
not exports, IPC names, plugin APIs or advertised daemon capabilities. Freeze and
compile-check them in the accepted implementation baseline before agent kickoff.
The integrator alone publishes canonical types. Feature branches use matching
injected structural fixtures, never a moving peer branch.

## Exact source and contract binding

The original packet audited `e8678eb`; this refinement inspects main
`c1eba301702fef0466b2d3481c36d62331ee7d48`.
New interfaces remain proposals pending #435/#333/#334 review. Freeze must record
the full **published packet commit** and separately accepted **runtime commit**, plus
canonical export/registration availability. A source SHA is not a contract approval.
Current [config](https://github.com/cschadewitz/Project_Orca/blob/c1eba301702fef0466b2d3481c36d62331ee7d48/packages/protocol/src/config.ts),
[retry/admission](https://github.com/cschadewitz/Project_Orca/blob/c1eba301702fef0466b2d3481c36d62331ee7d48/packages/protocol/src/admission-retry.ts) and
[operator preflight](https://github.com/cschadewitz/Project_Orca/blob/c1eba301702fef0466b2d3481c36d62331ee7d48/packages/protocol/src/operator-reads.ts) bindings
are main source, not unmerged peer contracts. Feature fixtures should model actual
accepted exports; only genuinely unimplemented form/draft seams need invented fixtures.

## Reuse the current contracts

From `@orca/protocol`, reuse `ConfigDocument`, `ConfigFieldDescription`,
`ConfigSchemaDescription`, `ConfigSetParams`, `ConfigSetResult`,
`ConfigApplyParams`, `ConfigApplyResult`, `ConfigGenerationStatus`,
`WorkflowInputSchemaView`, `WorkflowsValidateInputsResult`, `RunsStartParams`,
`RunsAdmitParams`, `RunsAdmitResult`, `AdmissionRetryResult` and the canonical
Request/retry contracts available at the accepted runtime. `RunsStartParams` is
the legacy settled direct shape; prompt retry-safe launch consumes `runs.admit`
when advertised/authorized, not an invented replacement RPC. Renderer imports stay within
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
freeze the integrator must bind each operation to a proven comment-preserving
lowering against the exact base document. The current `ConfigModel.nextConfigText`
uses YAML `Document.setIn`/`deleteIn` for existing field patches; it is not an AST
move/insert API and parent-array replacement is not comment-preservation proof.
For scalar/removal edits use only unambiguous existing patch paths. For insert/move,
review node-preserving YAML AST editing of the authorized original text and submit
the exact validated/reviewed resulting `text` under the same revision, or a separately
reviewed daemon extension. Unsupported lowering blocks the structured action and
preserves the draft. This names strategies to prove, not a frozen implementation. Never join
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
// Proposed common metadata on EVERY node, including collection/union roots.
interface FieldMetadata {
  readonly acceptsAbsent: boolean | "metadata-unavailable";
  readonly acceptsNull: boolean | "metadata-unavailable";
  readonly default:
    | { state: "none" }
    | { state: "available"; value: unknown } // only authorized non-sensitive value
    | { state: "withheld" }
    | { state: "metadata-unavailable" };
}
type FieldShape = FieldMetadata & (
  | { kind: "scalar"; field: ConfigFieldDescription } // sanitized canonical descriptor
  | { kind: "object"; fields: Readonly<Record<string, FieldShape>> }
  | { kind: "array"; item: FieldShape }
  | { kind: "record"; value: FieldShape }
  | { kind: "union"; discriminator: string;
      branches: Readonly<Record<string, FieldShape>> }
  | { kind: "unsupported"; reason: "opaque" | "metadata-unavailable" }
);
```

`acceptsAbsent` and `acceptsNull` are independent authoritative input semantics,
not inferred from flattened `required: false`. A defaulted field may accept absence
without accepting null; a required nullable field may accept null without absence.
Default presence is independent of both, and an available default may itself be null,
false, zero or empty string. Withheld/unavailable never means no default, never supplies
a display value and never materializes a value in the document. Every child/branch keeps
its own parent-relative metadata. Unknown metadata keeps the shape unsupported rather
than inventing false booleans. `ConfigFieldDescription.default`/enums/help must be
sanitized under the same authority/sensitivity policy; common metadata cannot leak them
through a second copy. No runtime/schema export is added by this TypeScript example.

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
retains its local typed input values. As integrated, the review also carries the
frozen submitted command, input vars included (`command` in
`configuration-launch-contract.ts`), and main keeps it encrypted in the
admission-intent journal until the intent is abandoned. A reviewed command and
local input display must refer to the same frozen draft sequence. Command editing,
target change, workflow revision/config generation
movement or relevant capability change invalidates the review. Current auth is
rechecked server-side at submission and recovery, never frozen inside this DTO.

Map `workflowVersion`, `expectedWorkflowRevision`, `expectedConfigGeneration`
unchanged into accepted direct/Request commands. The app-owned target fence is
not an extra property injected into legacy RPC schemas. `intentId` denotes the
client submission intent; it is not `operationId`, `admissionId`, `requestId` or
`runId`. Bind it once to the accepted #331 idempotency key. The current core
`RetryResult<T>` is `resolved` with `operationId`/`replayed`/`result`, or `in-progress`
with `operationId`/`recovery`. Preserve that envelope plus nested receipt identity;
only nested `accepted` supports admitted UI. Do not flatten it into a run ID: `in-progress` and
resolved `prepared`/`recoverable-failure` do not
map to `admitted`. A run ID alone does not prove accepted execution.

No production `launch.review` API, general checkout evidence token semantics, guided
draft format or new RPC is created here. Reuse the existing encrypted palette intent
boundary for its supported scope; any guided-draft extension and checkout projection gap require the
ownership and
freeze gate in [handoff](handoff-and-tests.md).
