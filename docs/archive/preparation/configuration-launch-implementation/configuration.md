# Configuration forms and acknowledged apply

This is a proposed implementation behavior contract for #333. Source baseline and
status terminology are in [README](README.md); exact proposed shapes are in
[interfaces](interfaces.md).

## Current metadata/edit boundary

Source refresh is main `c1eba301702fef0466b2d3481c36d62331ee7d48`. Existing revision/save/apply and
target isolation
are merged foundations. [Interfaces](interfaces.md) now proposes common authoritative
absence/null/default metadata for every node and names the existing YAML patch boundary
versus node-preserving collection lowering that still requires proof. Neither extension
is frozen or exported here; #435/#333/integrator own contract approval and implementation.

## Form scope and truthful defaults

- Start with existing `ConfigField`, `config-form`, `config-model`, `use-config`,
  draft bar and raw editor. Expose empty supported collections and optional
  objects so a user can create a host, an agent and a role binding through forms.
- Field labels, enums, types and defaults come from authoritative metadata. An
  absent key remains absent; show a default as provenance/placeholder, never
  materialize all defaults when adding a row. `false`, `0`, empty string, null
  and absent are distinct. Requiredness, nullability and default presence come from independent authoritative
  metadata; a nullable required key still cannot be deleted. Never infer them from the
  current walker's flattened `required` flag.
- Host/agent/role IDs and references are chosen from authorized existing data,
  with daemon-side validation. Deleting an in-use host/agent reports precise
  authorized references and refuses invalid save. Do not rewrite consumers.
- Arrays support explicit insert/delete/reorder with stable focus; records
  support explicit add/remove with duplicate/unsafe-key refusal. Optional
  objects have create/remove actions. Union branch switching requires branch
  metadata and a review of removed fields. Flattened metadata alone is insufficient.
- Preserve extension fields and comments through form edits and raw transitions.
  Never replace the whole parsed document by JSON serialization. In particular,
  existing parent-array patching is not proof that comments within moved/deleted
  elements survive. The integrator must prove scalar/removal patch addressing and node-preserving
  collection text/AST lowering against the exact document/revision first, including
  comments attached to moved elements, unsafe record keys and raw/form transitions.
- `plugins` remains a list of existing module specifiers; no manifest registry,
  plugin execution, credential-editor UI or guessed provider keys are added.
  Models come from configured/discovered supported choices; configured declaration
  does not guarantee an ACP session will accept that model.

Unknown shapes may use the existing advanced raw view only under current
`config.read`/write authority. It is not a workaround that makes first-beta users
hand-edit JSON or YAML. The supported beta preset must have a complete guided
path; unsupported required setup blocks with a useful explanation. Raw config
must never be copied into launch previews, MCP DTOs, support exports or logs.

## Transaction sequence

1. Read the two configuration documents and generation status through existing
   authorized methods. Capture target identity/epoch and each document's own
   revision. Store draft changes separately from the loaded document.
2. Edit a draft without mutating disk. A raw/form transition must show which
   unsaved representation would be replaced; cancel keeps it. A navigation or
   reconnect cannot silently switch the draft's base revision or target.
3. Validate the exact candidate using `config.set` with `validateOnly: true`,
   the captured `expectedRevision`, and exactly one edit representation. Place
   daemon field errors; announce summary once through the existing live region.
   Late results for another target/draft sequence are ignored. No save or apply.
4. Review the candidate change set/text within the authorized editor, preserving
   defaults versus explicit values and document ownership. Sensitive values
   are withheld from new semantic summaries; existing raw text is not a safe
   shareable redaction source. Show policy changes and request explicit approval
   of their actual scope; validation is never permission to grant a policy.
5. Save the identical reviewed candidate with its original `expectedRevision`.
   Refuse stale revision. Do not silently replay it against the latest revision
   after Reload: retain the user's edits, reconcile explicitly, validate and
   review again. Clear only the submitted draft sequence, not edits typed while
   the write was pending. An acknowledgement must match the original target.
6. Saved does not mean active. Refresh authoritative generation state. Offer
   explicit Apply for the acknowledged saved revision and captured active
   generation, only if the method is implemented and currently authorized.
   Optional apply validation does not activate. Apply sends existing guarded
   `ConfigApplyParams` and displays its actual outcome.
7. `applied`/`unchanged` are accepted only from the matching acknowledgement;
   `validated`, `restart-required`, `invalid`, disconnect and ambiguous response
   never claim activation. Re-read after response loss to establish actual
   saved/active state before offering another action. Never automatically restart
   a daemon, overwrite a stale revision, or rerun active work.

This is an acknowledged sequence of separate operations, **not a promised atomic
save-plus-apply transaction**. Existing runs retain their admitted execution
configuration; current authorization/revocation and permission sidecars stay live.
The sidecar is a separate document/revision, has no `default` field, and keeps
its existing policy editor/confirmation semantics. Saving a sidecar must not be
misreported as a config-generation activation or vice versa.

## Draft lifetime and errors

Use the existing target boundary and `useUpdateDraft` registration. Planned
switches block on unresolved drafts; unsolicited identity/epoch change freezes
them under the original target. Never retarget automatically because a URL is
unchanged. Workspace identity is durable; instance/epoch are freshness fences.
Reconnect requires current identity/capability data before resuming writes.

No new disk persistence of sensitive config drafts is approved here. Navigation
retention is in-app; restart persistence is a separate integrator decision, not
an accidental localStorage dump. Show that limit truthfully.

Handle missing/denied config, unsupported metadata, malformed raw document,
cross-field validation, stale revision, stale generation, read-only connection,
revoked authority, cancelled preview and lost acknowledgement distinctly. Error
messages should name the field/action, never quote secret-bearing rejected values.
UI disabled states are explanations; server-side checks remain authoritative.
