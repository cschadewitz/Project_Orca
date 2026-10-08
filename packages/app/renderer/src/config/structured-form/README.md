# Structured form integration handoff (#333)

Implementation baseline: `65606fbce827cba914a67b999b1a47c0aab2797a`.
Reviewed preparation input: #440 at `4aa142e870c9cedcd4d26108d975c0f7c7f4619a`.
These isolated app-local interfaces remain provisional until the integrator binds
them to reviewed shared declarations. This slice does not enable a production route.

`StructuredForm` consumes recursive `FieldShape`, a drawing-only projected value,
authorized path errors, an edit-access function, stable array row keys and an ordered
`onEdit` batch. It emits typed path segments, never flattened arbitrary record keys.
`projectEdits` is a display projection only; do not serialize it as configuration.
Unknown fields survive the projection. Unsupported metadata and sensitive nodes
remain unavailable; collection creation never fills child defaults. Union switches
review known field removals and preserve common and extension fields.
Only discriminated object unions are supported here. Nondiscriminated, opaque or
non-object variants must remain unsupported until the shared contract describes
their selection/edit semantics; do not flatten them into an arbitrary branch.

`StructuredEditorSession` holds edits separately from the document, captures target,
revision and sequence, validates through the actual `config.set` shape, retains the
validated private bytes, and saves those exact reviewed bytes. `ChangePreview` accepts
only path/kind summaries. Save and explicit generation-guarded apply are separate;
validated/restart-required/invalid outcomes never claim activation. Stale and ambiguous
writes freeze the retained draft. Explicit `reconcile` invalidates review and does not
retarget a draft to another workspace/instance/epoch.

The session is in-memory and must live above surface navigation. Its `snapshot().edits`
and `candidate()` are private editor state, not redacted/shareable DTOs. Do not log or
persist them unencrypted. Pass only `snapshot().changes` to the semantic preview.

## Exact remaining integration seams

- Generate authoritative recursive schema metadata, including union branches, record
  values, independent absence/null/default semantics and sanitized help/enum/defaults.
  `visibility` is an explicit local safety requirement, not a guessed flag on the old
  flattened descriptor. Bind it to the shared authoritative sensitivity metadata;
  missing evidence blocks display/edit. No old-schema-to-rich-schema inference is supplied.
- Bind `lowering.lower` to node/comment-preserving ordered YAML editing against the
  captured exact original document/revision. The required `preservesComments: true`
  declaration is a contract requiring proof, not proof itself. Return `unsupported`
  until that proof exists. Tests use an explicitly synthetic lowering result and do
  not establish YAML AST/comment fidelity. Leaf removals, union field switches, insert
  and move must retain untargeted bytes/comments; parent-array replacement is insufficient.
- Supply current target/connection/method/read/write authority through both form access
  and session access. Session repeats checks after lowering and before each command.
  Server-side authorization remains required for raw and structured writes. Bind
  `policyChange` to authoritative edit classification; policy confirmation is tied to
  one validated sequence. The permission sidecar stays with its existing separate editor.
- Bind `safeErrors` to authorized, value-free field/reference diagnostics. Hidden
  diagnostics must still block save; a validation error list cannot become success
  merely because all visible errors were redacted.
- Allocate stable transient array identities through the edit feed. `rowKey` must not
  be an index or mutable domain-id shortcut. Controls retain mounted rows on reorder
  and move focus to a remaining row/add action after removal.
- Register the in-memory session above navigation, target isolation, reconnect and
  `useUpdateDraft`. Adapt raw/form transitions with explicit replacement/discard review;
  the optional raw-navigation callback itself does not change the draft. Reconciliation
  after stale/ambiguous saves and after edits during save requires a current read and
  an explicitly reviewed new operation list, never automatic resubmission/rebase.
- Wire the existing save/discard bar, semantic/private-text review, generation status,
  routes, scrolling and single announcement channel. This component is content for
  the existing Config scroller; it introduces no additional scroll region or live region.

## Acceptance evidence and limits

Dedicated `configuration-studio-structured-{model,form,session}.test.ts[x]` cover
empty host/agent/role creation; collections and nested record values; union review;
absence/null/false/zero/empty; extension preservation; unsafe keys; daemon/reference
errors; sensitive metadata; read-only controls; both themes; Menu keyboard/Escape;
row focus; exact validation/save candidates; policy confirmation; revision/generation
conflicts; old-target/old-sequence replies; edit during save and lost acknowledgements.

These are isolated fixtures. Integrator acceptance still needs actual YAML comment/
byte-preservation, raw transitions, real server authorization, shared draft persistence,
combined shell scrolling/a11y, and end-to-end validate/review/save/apply from empty
configuration. CI, independent review, integration and merge remain with the parent.
No workflow dispatch, credentials, dependency declaration, host/security change or
deployment is part of this slice.
