# Template authoring integration handoff (#355)

This isolated renderer slice starts at current main
`65606fbce827cba914a67b999b1a47c0aab2797a`. Parent confirms reviewed preparation
packet `4aa142e870c9cedcd4d26108d975c0f7c7f4619a`; its interface proposals are not
template RPCs. No shared files, schema exports, dependencies, bridge, shell routes,
or protected execution stores are changed here.

## Implemented behavior

`TemplateAuthoringEditor` accepts one retained `TemplateAuthoringController`, an
optional explicit source-export callback, and the existing keyboard provider. It
shows catalog IDs, declared context, version metadata, usage references, saved
pack fallback, exact-ID partials, editable complete Markdown/front matter, fixture
inputs, authoritative validation errors, a sanitized change/compatibility review,
and an explicit publication action. It scrolls at its root and uses existing
ConfigField, Button, typography and draft-bar classes. Validate/publish/cancel use
the existing command palette and restore focus. No automatic PR creation or
external template publication is present.

Source drafts are exact replacement text for changed assets only. Import/export
retain comments, order, body, unknown metadata and line endings; unchanged assets
are not reconstructed. Protected or absent source cannot be edited/exported.
The variant derivation port creates draft source in the accepted Markdown format;
it is unavailable without that port and never guesses YAML edits. There is no
new pack manifest format. Pack selection tries `<pack>/<id>`, then `<id>`;
partials are checked against exact catalog IDs with no pack rewriting.

Reviews are invalidated by source changes, target/revision/generation movement,
or current write-authority changes. Pending old responses cannot attach to a
newer draft. Publication requires compatible authoritative validation and passes
the exact candidate source, target, base revision, active generation, sequence and
candidate content revision. Concurrent writes and refused/lost acknowledgements
retain drafts and block retry. Successful save does not claim activation; editing
during save retains the newer draft and requires reconciliation.

## Explicit provisional contracts and remaining integration

Every interface in `model.ts` is an app-local injected proposal. None is a
production RPC, advertised capability, pack compatibility schema, durable
publication token or immutable template-version lookup.

The shared integrator must provide the following before enabling the surface:

- An authorized catalog/source read with stable asset keys and revisions, safe
  usage/metadata projection, current target identity and active generation. Source
  withheld by current authority must remain unavailable. Do not read protected
  generation snapshots to populate an editor.
- A validator using the accepted front-matter/template parser and complete
  candidate catalog. Reject malformed front matter, duplicate/missing IDs,
  missing/cyclic partials, dangling workflow references, and incompatible pack
  requirements. Return sanitized field diagnostics and a content-bound semantic
  and upgrade diff. A fixture pass is not parser/publication integration proof.
- A preview adapter rendering only explicit supplied sample values and artifact
  bodies with the existing template renderer and exact-ID partial resolver. Never
  launch/contact agents, resolve credentials/environment, fetch artifact paths or
  access production artifacts automatically. Apply source redaction policy before
  returning preview text. Preview rendering itself is intentionally not duplicated
  in the renderer.
- A variant adapter deriving `<pack>/<id>` with the accepted parser and
  comment/order-preserving source editing. UI allows a single-segment pack name
  and refuses an existing variant. The caller owns safe new asset-key allocation;
  keys are opaque identifiers, not renderer-chosen filesystem paths.
- A separately reviewed local save/publication adapter. It must recheck current
  authority, the exact source revision, generation and candidate content identity;
  use safe allowed paths and transactional/conflict-safe storage; preserve retained
  metadata/comments; and refuse changed reviews. `saved` acknowledges source only
  and must leave the active generation unchanged. Apply remains the existing
  guarded configuration operation and admitted runs retain captured bodies/partials.
  Publication is disabled when the port is absent. No external sharing is implied.
- Shell registration, capability discovery, a single live-region announcement
  subscription, `useUpdateDraft`/navigation retention, target notification calls to
  `observe`, and an explicit reconciliation UI. `refresh()` observes new identity
  but deliberately does not rebase; after a conflict the host must display both
  retained/current source and obtain a fresh review before replacing the controller.
  In-memory drafts are not persisted to localStorage/disk.
- Node template assignment remains workflow/form wiring owned by the integrator
  and #333; role selection remains separate. Revision history, protected history
  storage, detailed compatibility requirement schema, resolved content provenance
  and actual shipped-review/strict-pack end-to-end fixtures remain runtime work.

Do not substitute invented template version lookup, guessed compatibility rules,
or current asset bodies for a run's pinned instructions. No production authoring
path is registered by this slice. Full #355 acceptance still requires the above
adapters, assignment/reconciliation/history UI and combined-head tests.

## Focused evidence

Dedicated `template-authoring-model.test.ts` and
`template-authoring-editor.test.tsx` cover source round trips, pack fallback,
exact-ID errors, protected data, invalid compatibility, guarded explicit writes,
late response/changed target races, edits during save, refusal/response loss,
fixture boundaries, keyboard palette editing/save/cancel and both-theme markup.
Native layout, real parser/renderer adapters, actual template assignment,
generation activation, physical macOS and end-to-end runtime acceptance are not
established by these injected tests.
