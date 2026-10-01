# Parallel implementation contract: #314, #328 and #330

This is the starting contract for three independent implementation branches. It
does not ship authentication, typed-input enforcement or builtin-node schemas.
The preparatory code reserves error codes and tests existing compatibility seams;
it registers no new method and changes no admission or authorization behavior.

Source inspection baseline: `a73ee04f5dc146d19caa265c658cea98abfd152c`.
Preparation base: `69ba87f56cd71c90423ecea5dd17888e80eee4ab` on `main`,
including the merged documentation reconciliation and CI-only PR workflow.
Read `AGENTS.md`, `CONTRIBUTING.md` and `docs/DEVELOPMENT.md` before working.
The issue bodies retain acceptance criteria beyond this boundary contract.

## One starting point, no peer-branch dependency

Start all three branches from the exact reviewed preparation commit supplied in
the preparation PR. Do not start from moving `main`, another implementation branch
or the separate documentation-review branch. If preparation is merged first,
use its verified merge commit consistently instead. The preparation PR requires
explicit approval to merge; creation of a draft PR is not merge approval.

The dependency graph is preparation -> {#314, #328, #330} -> integration.
None of these three stories depends on another implementation branch to compile
or run its owned tests. Cross-cutting acceptance is an integration gate, not an
instruction for the three agents to edit shared wiring independently.

## Existing diagnostics stay authoritative

- `packages/core/src/workflow/validate.ts` owns `ValidationIssue { path, message }`
  and `ValidationResult { ok, errors, warnings }`. `ok` means no blocking errors;
  warnings remain separate and do not block admission.
- The same module owns `NodeIssue { path?, message }` and
  `NodeValidation { errors?, warnings? }`. A custom validator returns paths
  relative to its node, never a complete workflow path. The existing hook prefixes
  them exactly once, including nested graphs. Both `field` and `.field` work;
  `[0]` stays an index suffix; an absent path identifies the node itself.
- `NodeExecutor.validate` and `NodeExecutorRegistry.validateNode` in
  `packages/engine/src/executors/types.ts` already provide the extension point.
  Bootstrap and `orca validate` already call it. Do not replace that machinery.
- `OrcaError` and `ProtocolError` keep `{ code, message, details? }` and the
  existing response envelope `{ kind: "response", id, ok: false, error }`.
  Do not introduce a parallel diagnostic hierarchy or change the RPC envelope.
- `WORKFLOW_INVALID` remains a malformed workflow-definition error.
  `WORKFLOW_INPUT_INVALID` is the distinct engine/protocol code for invalid launch
  vars. Its `details` is `{ errors: ValidationIssue[], warnings: ValidationIssue[] }`.
  Do not return raw Zod errors as this application-level contract.
- Protocol-only `AUTH_REQUIRED`, `AUTH_INVALID` and `AUTH_FORBIDDEN` are raised
  through `ProtocolFault`, not forced into `OrcaErrorCode`.

The new reserved codes are not advertised capabilities. Actual feature discovery
and any protocol minor-version update belong to final integration.

## #314: builtin custom-node validation

Own:

- `packages/engine/src/plan/executors.ts`
- `packages/engine/src/program/executors.ts`
- New adjacent plan/program schema or parsing modules
- `packages/engine/test/custom-node-validation.test.ts` and new tests named
  `builtin-node-validation*.test.ts`
- A new focused `docs/builtin-node-validation.md`, if needed

Implement schemas and share parsing between `validate` and `execute`. Preserve
documented defaults and template/expression-bearing fields. In particular,
omitting `plan-await.phase` is valid and defaults to `build`; omitting
`decision-matrix.artifact` is valid and defaults to `decisionMatrix`. Invalid
explicit values such as `plan-dispatch.concurrency: "four"` must fail before
execution. Defaults do not make malformed explicit values valid.

Cover all six builtin custom nodes, their explicit invalid fields, valid omitted
defaults, nested relative paths, warnings, and agreement between load-time and
runtime parsing. Do not edit core validation, the executor registry, bootstrap,
protocol modules, barrel exports or engine admission. Those seams already exist.

## #330: typed workflow launch inputs

Own:

- `packages/core/src/model/workflow.ts`
- New `packages/core/src/model/workflow-inputs.ts` and
  `packages/core/src/workflow/inputs.ts`
- `packages/engine/src/orchestrator.ts` admission and child-launch validation
- `packages/protocol/src/workflows.ts` plus a new
  `packages/protocol/src/workflow-inputs.ts`
- `packages/daemon/src/workflow-model.ts` plus a new
  `packages/daemon/src/workflow-inputs.ts` adapter
- New `workflow-inputs*.test.ts` tests in those packages and the existing
  `packages/engine/test/workflow-pinning.test.ts`
- A new focused `docs/workflow-inputs.md`

Freeze these compatibility decisions:

1. Preserve `inputs: Record<string, string>` as descriptions in definitions and
   workflow wire views. Add an optional `inputSchema`; do not turn `inputs` into a
   union of strings and objects. Workflows without `inputSchema` retain legacy
   input handling; the definition-immutability tightening below is separate. Declaration details are owned by this story, not the auth story.
2. Resolve declaration defaults, then workflow `vars`, then supplied launch vars,
   with later sources winning. Validate the final object without mutating any
   source. No implicit string/number/boolean coercion; CLI parsing must preserve
   explicitly typed values without silently changing legacy string behavior.
3. Pass through unknown vars by default. Strict rejection is explicit opt-in in
   the declaration; implicit strictness would break inherited parent vars.
   Required, default, enum, primitive, object/list, constraint, null and unknown
   cases need fixtures. Defaults themselves must satisfy their declarations.
4. Use the exact selected workflow definition/version for preflight and admission.
   Resume uses its persisted definition and values, not the new on-disk schema.
   Existing children reattach; only newly admitted children are newly validated.
   Do not silently validate an old version and launch the latest one.
5. Validation precedes definition recording, workspace provisioning, `run.created`,
   agent creation and child creation in `Orchestrator.startRun`. Every supported
   direct/Request-driven boundary goes through that shared admission. Do not
   invent the future Request-submission API (#329) in this story.
6. Separate workflow launch vars from agent artifact inputs and human-input gates.
   Secret references are preferred. Sensitive values/defaults must not be copied
   into validation messages, diagnostics, logs or discovery metadata. Preserve
   existing access controls; auth and redaction have different jobs.

Reserved extension points for integration (implement, but do not register yet):

- `WORKFLOWS_VALIDATE_INPUTS_METHOD = "workflows.validateInputs"` in the new
  protocol module, with `WorkflowsValidateInputsParamsSchema` and
  `WorkflowsValidateInputsResultSchema` and their inferred types.
- Params: `{ workflowId: string, version?: string, vars?: Record<string, unknown> }`.
  Omitted vars means `{}`. Result:
  `{ workflowId: string, version: string, revision: string, validation: ValidationResult }`.
  Return field failures in the result without creating a run. Do not echo resolved
  values in the wire preflight response. Unknown/inaccessible workflow handling
  is subject to #328 before this adapter runs.
- `WorkflowInputsModel` in the new daemon module exposes
  `validateInputs(params): Promise<WorkflowsValidateInputsResult>`; inject its
  definition/version resolver so tests use fixtures without editing `methods.ts`.
- `revision` is an opaque deterministic content digest of the complete normalized
  selected definition, including schema/defaults/vars, with object keys canonically
  ordered. Version text alone is insufficient: files can change without a version
  bump. Compute the digest on the server; never accept a caller-supplied definition.
- Add optional `workflowVersion` and `expectedWorkflowRevision` to engine
  `StartRunOptions` in the owned orchestrator module. Supply a separate integration
  patch adding those same optional fields to `RunsStartParamsSchema` and forwarding
  them through daemon control/CLI. Preflight clients pass both returned values.
  Explicit versions select a persisted matching version when present; otherwise a
  currently loaded definition with that same version is eligible, including a new
  workflow that has never run. When supplied, its expected digest must match. An
  unknown historical version fails rather than selecting latest. A missing version
  selects the currently loaded definition, subject to the collision check below.
- Admission compares the expected digest against the selected definition before
  validation or writes. A mismatch is `WORKFLOW_INVALID`, with a generic instruction
  to preflight again; it must not echo definitions or values. Do not misclassify it
  as a bad-input-value error. Missing versions retain `WORKFLOW_VERSION_NOT_FOUND`
  after authorization. The new fields are optional for existing callers; they do not bypass the
  deliberate same-version definition-immutability check below.
- The current version store is write-once per `(id, version)` and does not detect
  changed content; `definitionFor` currently prefers a same-version live definition.
  #330 must compare an existing stored definition before admission, reject a
  same-version content collision as `WORKFLOW_INVALID` before creating a run, and
  prefer the persisted definition for a stored run on resume. After a concurrent
  first-write race, read back and verify the stored content before provisioning or
  `run.created`. Do not redesign the store or silently replace an immutable version.
  This intentionally tightens same-version definition reuse for new admissions;
  it is not a claim that every legacy version-selection behavior is unchanged.
  Preserve the existing fallback for legacy runs with no stored snapshot; do not
  retroactively require one. This is workflow-definition identity protection, not
  #332's complete configuration/template snapshot. Test first-ever preflight and
  guarded start, same-version edits, changed versions, explicit historical selection,
  stale preflight, absent guards, persisted resume after a same-version live edit,
  and the legacy no-snapshot fallback.
- The pure core helper `validateWorkflowInputs(definition, suppliedVars)` returns
  `{ validation: ValidationResult, vars: Record<string, unknown> }`. On failure,
  `vars` is empty and unusable for admission; callers must check `validation.ok`.
  Engine failures throw the reserved `OrcaError` with the diagnostics above.

Do not edit `packages/core/src/workflow/validate.ts`, builtin executors, auth
modules, shared barrels, `protocol/src/control.ts`, `protocol/src/handshake.ts`,
daemon methods/control/read-model, CLI commands or bootstrap. Import new helpers
relatively within their package. Re-export the new schemas and pure `validateWorkflowInputs` helper from the
owned `core/src/model/workflow.ts`: `core/src/schemas.ts` already exports that
module, and `core/src/index.ts` already exports `schemas.ts`. Thus engine can import
the helper from `@orca/core` without editing a reserved barrel. Keep the helper
node-free and import `WorkflowDefinition` as a type only, avoiding a runtime cycle.
Protocol runtime imports must use `@orca/core/schemas`; root imports there are
type-only. Likewise, re-export the new protocol preflight module through owned
`protocol/src/workflows.ts`, which `protocol/src/index.ts` already exports. The
daemon adapter can then import its schemas/types from `@orca/protocol` without a
reserved-barrel edit or a cross-package source import. The app may import only
`@orca/protocol` and `@orca/design`.

## #328: daemon authentication and authorization

Own:

- New modules under `packages/daemon/src/auth/` for principal, policy, credentials,
  request context, resource checks and audit adapters
- `packages/daemon/src/server.ts`, `packages/daemon/src/socket.ts` and
  `packages/daemon/src/subscriptions.ts` for both transport enforcement paths
- New `auth*.test.ts` and `security*.test.ts` daemon tests, plus existing
  `server.test.ts` and `socket.test.ts`
- A new focused `docs/daemon-security.md`

Keep authentication, operation authorization and resource authorization distinct.
The principal must be a verified server-side identity; never trust a caller's
principal field or forwarded header without the documented trusted-proxy policy.
Enumerate every current method, socket-only subscribe/unsubscribe, notifications,
replay, artifacts and the reserved `workflows.validateInputs` operation. Unknown
operations are denied by default. Preflight requires access to the selected
workflow/revision, and cannot disclose schema or field failures before access.

Wire policy:

- No credential: `AUTH_REQUIRED`, generic missing-authentication message.
- Malformed, invalid, expired and revoked credentials: the same `AUTH_INVALID`
  code, message, details omission and transport response shape. No reason-specific
  hints in an external response; safe internal audit classifications may differ.
- Verified caller denied an operation: `AUTH_FORBIDDEN`, generic denial.
- Inaccessible and nonexistent protected resource targets must have identical
  external responses. Do not leak existence through counts, fields, linked IDs,
  schema errors, event delivery, artifact metadata/content or not-found variants.

Auth owns the policy implementation and test harnesses. The integration owner
applies its adapter to shared `MethodContext`/methods/control and CLI bootstrap.
Export a wrapper/factory from the auth modules that can be exercised against an
injected method table/context using current interfaces; do not require #330 code
to compile. Include a fixture for the reserved preflight method string. Do not
insert permissive placeholder credentials or an allow-all default to make tests
pass. A branch exposing transport code must fail closed if required policy is
absent. Existing local compatibility is allowed only when explicit and loopback.

Provide integration tests or exact integration instructions for operation/resource
checks at the shared control/read boundary, list pagination/count filtering,
mutation actor attribution, exact gate and standing-permission checks, expiry and
revocation, reconnect, proxy/origin protections, and all supported local clients.
The story is not complete while any of those requirements remain unwired.

## Shared integration ownership: Cal

Implementation agents must not independently edit these shared files:

- `packages/daemon/src/methods.ts`, `control.ts`, `read-model.ts`
- `packages/cli/src/bootstrap.ts` and existing CLI command modules
- `packages/protocol/src/control.ts`, `handshake.ts`, `version.ts`, `index.ts`
- Existing package barrels (`src/index.ts`, `core/src/schemas.ts`)
- `packages/core/src/errors.ts`, `packages/protocol/src/errors.ts` and the new
  preparation contract tests (the preparation commit owns these)
- Shared living docs (`docs/WORKFLOWS.md`, protocol README, architecture/development
  docs), manifests, lockfile and all `.github/workflows/` files

Each agent returns its full commit SHA, owned-file diff, tests/check results and a
short integration manifest naming required exports, constructor dependencies,
method/context additions and client changes. Put proposed shared-file changes in
the PR description or a separate patch artifact, not committed edits to those files.
Use new per-story modules/tests/docs for independent work.

Integration order: merge the builtin validation slice; combine input schemas and
admission; wire auth, preflight discovery/dispatch and all clients together before
exposing new capabilities. This is a verification order, not a peer dependency.
Authenticate and authorize before resource-specific validation; then validate
inputs before side effects. Re-evaluate authority on reconnect/replay and mutation.

The integration owner adds required exports and `MethodContext` wiring, preserves
read-only and maintenance behavior, ensures preflight and launch select the same
revision, and updates the protocol version only for the actually shipped contract.
Never expose an unauthenticated preflight endpoint as an intermediate convenience.

## Verification and handoff gates

Preparation fixtures assert existing legacy descriptions and defaults, diagnostic
paths, and error-envelope compatibility. They do not claim the future security or
typed validation behavior is implemented. Each implementation adds behavioral
tests for its acceptance criteria rather than weakening these compatibility tests.

Run the focused tests and repository commands in `docs/DEVELOPMENT.md`: typecheck,
lint, format:check, design:check, tests/coverage and build. Distinguish local checks
from CI. Report an unavailable check explicitly; a draft PR alone is not a pass.

Before kickoff, verify the preparation commit exists remotely, its exact-head CI
has reached a reported terminal state, issue edits have been read back and all
three agents receive this document plus the same full SHA. Main-based kickoff
additionally requires the preparation merge to have been authorized and verified.
Before shipping, run full cross-story checks, including no-side-effect rejection,
HTTP/WS parity, authorization-before-validation, denied-resource non-disclosure,
child inheritance, pinned versions, valid omitted builtin defaults, and app/CLI
migration. All issue acceptance criteria remain required after integration.
