# Typed workflow launch inputs

A workflow can declare the vars a run of it must be started with. The declaration is
enforced when a run is admitted, before anything is written, and the same check is
available as a side-effect-free preflight. This is #330; the boundary decisions are frozen
in [runtime-foundation-parallel-contract.md](runtime-foundation-parallel-contract.md).

## Three different "inputs"

These are distinct, and this document is only about the first:

| Concept | Where it is declared | When it is checked |
| --- | --- | --- |
| **Launch inputs** - the vars a run starts with (`run.created`'s `vars`) | the workflow's `inputSchema` (and `inputs` descriptions) | at admission, and by preflight |
| **Artifact inputs** - what an agent node reads | an `agent` node's `inputs: [ArtifactRef]` | when the step resolves them |
| **Human-input gates** - an answer a person gives mid-run | `gate` nodes and `human` decision sources | when the gate is answered |

## Declaring inputs

`inputs` stays what it always was: a map of name to description, informational only. A
workflow with no `inputSchema` behaves exactly as before - nothing is checked and a run
starts on `{ ...vars, ...suppliedVars }`.

`inputSchema` is optional and sits beside it:

```yaml
id: release
name: Release
version: "4"
inputs:
  title: What is being released          # still shown; still informational
vars:
  channel: beta                          # workflow vars override declaration defaults
inputSchema:
  unknown: allow                         # allow (default) | warn | reject
  fields:
    title: { type: string, required: true, minLength: 3, maxLength: 80 }
    count: { type: integer, default: 1, minimum: 1, maximum: 10 }
    channel: { type: string, enum: [beta, stable] }
    dryRun: { type: boolean, default: false }
    tags: { type: array, items: { type: string }, maxItems: 5 }
    repo:
      type: object
      additionalProperties: false
      properties:
        url: { type: string, required: true, pattern: "^(git@|https://)" }
        branches: { type: array, items: { type: string } }
    notes: { type: string, nullable: true }
    tokenRef: { type: string, sensitive: true, description: "Name of the secret holding the token" }
```

A declaration has a `type` - `string`, `number`, `integer`, `boolean`, `object` or
`array` - and optionally:

- `description`; `required` (the resolved value must be present); `nullable` (`null` is
  accepted; otherwise `null` is an error); `sensitive` (see below);
- `default`, on top-level fields only;
- `enum` (strings, numbers or booleans, matching `type`);
- `minLength`, `maxLength`, `pattern` for strings - `pattern` is an unanchored regular
  expression with the `u` flag, like JSON Schema's;
- `minimum`, `maximum` (inclusive) for numbers and integers;
- `items`, `minItems`, `maxItems` for arrays;
- `properties` and `additionalProperties` (default `true`) for objects. A nested
  property can be `required`.

The declaration is closed. An unknown key (a typo like `requried`), a constraint for
another type, contradictory bounds, an invalid `pattern`, a nested `default`, or a
`default` its own declaration refuses all fail at load time as `WORKFLOW_INVALID`, so a
workflow that would refuse every launch never loads.

## Resolution and validation

The vars a run starts with are resolved as, later sources winning:

1. declaration defaults (copied, never shared with the definition),
2. the workflow's own `vars`,
3. the vars supplied at launch.

A supplied value of `undefined` counts as absent. The resolved object is then validated
against the declaration. Nothing is coerced: `"3"` is not an integer and `"true"` is not
a boolean. No source is mutated. The result is deterministic for a given definition and
supplied vars, and it is the object recorded on `run.created`.

**Unknown vars** - names that are neither declared nor among the workflow's own `vars` -
pass through by default, because a child run inherits all of its parent's vars. `unknown:
warn` passes them with a warning; `unknown: reject` refuses the launch. Choose `reject`
only for a workflow that is never a subworkflow of another, or whose parents carry no
vars it does not declare.

`validateWorkflowInputs(definition, suppliedVars)` in `@orca/core` (and
`@orca/core/schemas`) is the one implementation; admission and preflight both call it. It
returns `{ validation: { ok, errors, warnings }, vars }`, where `vars` is empty when
`ok` is false.

Every issue is `{ path, message }`: `vars.count`, `vars.repo.url`,
`vars.repo.branches[1]`. Messages say what is wrong and never quote the value.

## Admission

`Orchestrator.startRun` is the single admission path - the CLI's `run` and `submit`, the
daemon's `runs.start`, the program service's work items, the ACP facade and every child a
container node spawns all go through it. In order, before any write:

1. **Select the definition.** With `workflowVersion`, the copy the workflow-version store
   kept for it, else the loaded file when it is at that version (a workflow that has never
   run). Any other version is `WORKFLOW_VERSION_NOT_FOUND` with the versions that exist -
   never the latest instead. Without a version, the loaded file, provided that any stored
   definition of the same version has the same content (see below).
2. **Check the expected revision**, when `expectedWorkflowRevision` is given. A mismatch is
   `WORKFLOW_INVALID` with a generic "validate them again" message and no details.
3. Check per-run selection overrides (#186), as before.
4. **Validate the inputs.** Failure is `WORKFLOW_INPUT_INVALID` with
   `details: { errors, warnings }` - the same issues a preflight reports. The message
   lists the first three issues.
5. Record the definition, provision the workspace, append `run.created`.

A refused launch therefore leaves no stored definition, no workspace, no run, no agent
session and no child. A child that fails validation fails its parent's step the way any
step error does; it is never created.

Only newly admitted runs are validated. A resumed run uses the definition and vars it
recorded. A container step that is re-attempted re-attaches to the children its earlier
attempt spawned without validating them again; only branches that never started are
admitted fresh.

## Revisions and the same-version rule

A **revision** is `sha256:` plus the SHA-256 of the definition's canonical JSON (object
keys sorted, `undefined` members dropped), from `workflowRevision` in `@orca/engine`. It
covers everything in the definition, including the schema, defaults and vars. Version
text alone is not identity, because a file can change without its `version` changing. The
server computes it; a client never supplies a definition.

A version is immutable once a run has recorded it. Admission now enforces that:

- A new launch whose loaded file has the same `version` as a stored definition but
  different content is refused as `WORKFLOW_INVALID`. Bump the version. Launching that
  version explicitly (`workflowVersion`) still works and uses the stored copy.
- When two processes race to record a new version first, the one that loses reads back
  what was stored and is refused unless it is the same content.
- A stored run resumes on its stored snapshot, even if the file was edited in place. A run
  from before versioning (no `workflowStored` on `run.created`) keeps its old fallback:
  the current file.

This tightens one earlier behaviour on purpose. Previously, a same-version edit was
silently used for new runs and for resumes. This is definition-identity protection only;
the complete configuration and template snapshot is #332.

## Preflight: `workflows.validateInputs`

Reserved in `@orca/protocol` (`WORKFLOWS_VALIDATE_INPUTS_METHOD`). It is not yet
registered or advertised; authorization (#328) and wiring land at integration.

```text
params: { workflowId: string, version?: string, vars?: Record<string, unknown> }   // vars defaults to {}
result: { workflowId, version, revision, validation: { ok, errors, warnings } }
```

Field failures come back in `validation`; only an unknown workflow or version, or a
same-version collision, is an error. The result never echoes the resolved values. A
client that then launches passes `version` as `workflowVersion` and `revision` as
`expectedWorkflowRevision`, so it cannot validate one definition and start another.

The daemon's `WorkflowInputsModel` (`packages/daemon/src/workflow-inputs.ts`) implements
it over an injected resolver. In a daemon that resolver is
`orchestratorDefinitionResolver(orchestrator)`, which is `Orchestrator.selectDefinition`:
the same selection admission uses.

## Discovery

`workflows.get` carries the declaration as `WorkflowView.inputSchema`, next to the
unchanged `inputs` descriptions. The wire schema is deliberately loose: `type` and
`unknown` are strings, and unknown keys survive. That way an older client reads a newer
daemon's declaration instead of failing.

## Sensitive inputs and secrets

Prefer a **reference** to a secret over the secret itself: declare `tokenRef` (the name
of an environment variable or a vault path) and resolve it where it is used. On the combined runtime integration, sensitive vars use protected execution storage;
ordinary vars remain in public run history. See [protected storage](protected-execution-storage.md).

`sensitive: true` on a declaration, inherited by everything beneath it, means:

- validation messages never include the value, the declared `pattern` or the `enum`;
  unknown object keys beneath a sensitive declaration report at the enclosing declared
  path, since a supplied key can itself be secret;
- the `workflows.get` view omits its `default` and `enum` at every depth, and omits the
  workflow's own `vars` value for that name. An enclosing default or workflow var is
  omitted in full when any object property or array item declaration is sensitive;
- the preflight result never contains values at all.

### Outstanding integration gate: protected execution values

This section records the independent #330 slice's handoff. The combined integration
implements the encrypted storage, projections and migration fences described in
[runtime integration](runtime-foundation-integration.md) and
[protected execution storage](protected-execution-storage.md). The limitations below
describe the slice before that shared wiring, not the integrated runtime.

The current implementation does **not** protect sensitive execution values after
admission: `run.created`, `runs.get`, `runs.events` and live/replayed `event.appended`
still expose them. #363 tracks this gap; it is a prerequisite for accepting #330,
not a waiver of the frozen contract. Do not remove authoritative resume values as
an interim redaction fix.

Proposed integration design (not implemented in this owned-module slice):

- Introduce a private execution-value store accessed only by the engine. Store each
  sensitive top-level value (including values with sensitive descendants) as an
  immutable encrypted record, with an opaque reference in the durable run data.
  Define key provisioning, rotation, backup/restore and authorized engine access
  before choosing a storage adapter; a plaintext sidecar is not sufficient.
- Keep the reference map separate from user vars, so a user object cannot impersonate
  a reference. Bind records to the run and selected workflow revision. Persist the
  protected records before publishing `run.created`; recover or garbage-collect
  orphaned records after a failed admission.
- Hydrate only the engine's execution state, including child inheritance and resumed
  runs. Missing records or unavailable keys must fail closed before execution, never
  fall back to redacted placeholders or the latest workflow's defaults.
- Protect sensitive defaults and workflow vars in stored definition snapshots too.
  Preserve the original revision and immutable identity when hydrating snapshots.
  Otherwise moving launch values alone leaves another plaintext copy on disk.
- Build one public projection for run views and events, used by reads, live delivery,
  replay and diagnostic logging. Omit protected values and private references. Define
  how historical plaintext records are migrated or conservatively withheld; current
  schemas alone cannot identify every secret in an old event.
- Verify crash/restart, pinned resume, children, missing-key failure, definition
  persistence and HTTP/WS read/live/replay parity with sentinel secrets. Also audit
  execution outputs and logger call sites; hiding `run.created` alone is insufficient.

The shared-file patch for this design remains an integration-owner deliverable.
The storage/key lifecycle and legacy migration need an agreed contract before it
can safely replace authoritative event-sourced inputs.

Redaction is not access control. Who may read a workflow or start a run is #328's.

## Compatibility and evolution

- `inputs: Record<string, string>` is unchanged in definitions and on the wire;
  `inputSchema` is additive and optional on both.
- Adding an optional field, loosening a constraint or adding a default is
  backward-compatible for launches. Adding a required field, tightening a constraint or
  changing a type can refuse launches that worked before, so treat it as a version bump.
  Runs already recorded are unaffected either way.
- `WORKFLOW_INPUT_INVALID` (bad launch values) and `WORKFLOW_INVALID` (a malformed or
  changed definition) stay distinct codes. Both travel in the existing
  `{ code, message, details? }` error and RPC envelope. Issue paths and the `details`
  shape are the contract; message wording may improve.
