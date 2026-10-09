# M21 configuration and template integration

This slice supplies the production adapters for #333 and #355, reusing merged
[#553](https://github.com/cschadewitz/Project_Orca/pull/553) configuration review/Save/Apply
and [#544](https://github.com/cschadewitz/Project_Orca/pull/544) template controls. The branch
is `feat/m21-config-template-integration`, based on verified remote main
`db579fb7ac9cfce2e4e6901713088a80602311da`. Main was verified again before publication;
there was no branch refresh. Neither issue is closed by this slice: shared wiring,
receipt persistence/rebind and native acceptance remain.

## Production contracts

- `templates.get`, `validate`, `preview` and `history` require current `config.read`.
  `variant`, `save`, `assign` and `publish` additionally require `config.write`.
  Discovery omits unavailable authority and read-only mutations. Generation support and
  authoritative workspace/instance identity are prerequisites. Authenticated operations
  recheck the live principal around source reads and immediately before mutation or Apply;
  explicitly configured legacy loopback owner transport retains its existing authority.
- Catalog/source keys are daemon-derived configured-file identities. Config, workflow,
  catalog, source and active-generation revisions fence writes. Template and workflow
  writes share the existing configuration writer lock. New variants use exclusive
  creation; existing sources use temporary-file replacement and preserve file modes.
- Validation uses the core front-matter, expression, partial and workflow parsers. It
  rejects undeclared/duplicate IDs, missing or cyclic exact-ID partials, invalid workflow
  references and pack overrides that expand declared requirements or change the produced
  artifact kind. Diagnostics and semantic change summaries withhold source values.
- Preview renders only supplied values and artifact bodies. It does not resolve paths,
  environment, credentials or agents. It shows pack fallback and resolved partial IDs;
  output and render operations are bounded. Identifiable configured credentials and
  recognized credential syntax are withheld from output; refusals contain fixed prose.
- Save acknowledges one exact reviewed source without activation. `templates.publish`
  reviews and separately applies the saved catalog through configuration generations.
  Old admitted generations retain their instructions. Workflow assignment selects an
  instruction independently of its agent role, changes the workflow version, and requires
  a separate reviewed Save before Apply. Direct agent and decision-agent assignments,
  including selections inside inline graphs, use canonical workflow paths.
- Run provenance records the captured parsed template and exact-ID partial content
  digests, with optional fields for historical compatibility. Local revision history
  records raw-source digests and acknowledged activation generations, never old bodies
  or credentials. The two digest domains are deliberately different. Version labels do
  not promise immutable source lookup.

## App integration and retained source

Config owns the single scrolling region and the existing draft/announcement services.
The Templates tab mounts the #544 controls with an explicit “Save reviewed source” label,
reviewed catalog Apply, labelled node assignment and digest-only history. The provider
retains source drafts across Config navigation and registers pending work with the shared
update guard. Source authority withdrawal hides current source and private drafts; target
changes cannot authorize those drafts for another daemon. Reads reject superseded replies.

Asset invalidations arrive through the existing `config.changed` stream, including saves
whose config-file revision is unchanged. An exact pending source echo retains its Save
operation until acknowledgement; unrelated changes require reconciliation. Reconciliation
explicitly chooses current source or retained full replacement text and invalidates review.
Config form reconciliation replays independent operations only when their owning paths
still match; array positions are never replayed across changed collections. Raw replacements
and overlapping edits remain retained. Source comments and unknown fields stay in the
current document; Save and Apply remain distinct. Config Save's shortcut is unavailable
while Templates owns the view.

Reference selectors use unsaved configured hosts, agents, roles and declared model IDs,
plus authorized workflow IDs. Missing current references remain visibly unavailable;
unsupported/secret fields retain their established form/raw contract. Permission sidecar
ownership and explicit policy confirmation remain with #553.

## Pinned integration-owner handoff

The shared owner baseline is [#572](https://github.com/cschadewitz/Project_Orca/pull/572),
head `f4ca6540f94ad4a06704b20d0b9c4c4dd2cc9943`, described in its
`docs/implementation/shared-app-consolidation.md`. No general main, preload or Workspace
file was edited on this branch.

1. [m21-template-ipc.patch](patches/m21-template-ipc.patch) adds the closed typed template
   dispatcher to the pinned main/preload. It reuses the existing IPC handler's connection
   epoch and mutation guards. Preload remains CommonJS with type-only workspace imports.
2. [m21-template-config-composition.patch](patches/m21-template-config-composition.patch)
   gives the complete resolved bridge and Config header delta against the original #572
   files. These are the two overlaps when composing this branch: preserve first-run,
   guided-launch and Mac updater bridge fields, the first-run section, launch content and
   Launch work button. Apply this composition delta to the original pinned copies when
   resolving those files, rather than applying it again to an already merged result.

An isolated archive of #572 plus this slice and the two handoffs passed root and renderer
TypeScript checks. The IPC patch applied cleanly to the original pin. This is compilation
evidence for that exact composition, not combined-head CI or native runtime evidence.

## Bounded verification and self-review

Node 24.19.0, installed Vitest 5.0.2 and TypeScript 7.0.2 were used directly. Existing
dependencies were reused; there is no dependency, lockfile, CI or coverage-threshold change.

| Evidence | Result and scope |
| --- | --- |
| Authenticated app adapter/daemon integration | 19 cases passed, followed by one added out-of-order catalog-read case passing separately: shipped review/strict variant, fallback, Save versus Apply, assignment over real RPC, pinned provenance, comments/CRLF/metadata, invalid catalogs, source races, authority, symlinks/collisions, false receipts and preview limits. All fixtures and credentials were disposable; no agent was contacted. |
| Existing auth inventory, core templates/packs and generation restart contracts | 8 + 7 + 3 cases passed. File and memory restart keep admitted instructions and secret-free public provenance. |
| Production Config Templates route | Five mounted cases passed in both themes, navigation/authority, same-revision invalidation and pending Save echo; two added labelled assignment/false-receipt cases passed separately. |
| Config reference/reconciliation and corrections | Five selector/path reconciliation cases passed. The new source-withdrawal route and updated independent-comment reconciliation case passed separately. |
| Nearby merged surfaces | The existing focused run had 52 passing cases across config integration/route, template editor and auth inventory. One obsolete expectation rejected the now-supported independent form reconciliation; its corrected case passed separately. Reuse the editor keyboard/palette, source visibility, import/export and both-theme evidence rather than claiming another broad rerun. |
| Static checks | Slice root/renderer no-emit TypeScript; isolated #572 composition root/renderer TypeScript; changed-file ESLint/Prettier; changed CSS token check and whitespace checks. |

Focused commands use `node node_modules/vitest/vitest.mjs run` with `--maxWorkers=2`.
The production integration suite is `packages/daemon/test/template-authoring-integration.test.ts`;
mounted controls are `packages/app/renderer/test/template-studio-route.test.tsx`; selectors
and operation reconciliation are `packages/app/renderer/test/config-reference-reconciliation.test.ts`.
Only the corrected config cases and newly added races were rerun by name after changes.

Self-review checked live read/write authority, path confinement/exclusive variants,
source-free diagnostics, exact receipts, pending self-echo races, out-of-order reads,
separate Save/Apply and pinned provenance. It identified and corrected preview exception
disclosure, source-visibility withdrawal, stale catalog response replacement and unchecked
workflow assignment receipts. No shared-entrypoint mutation or automatic activation was added.

## Supported boundaries and remaining gates

Authoring reads bounded regular configured files and refuses symlink traversal. Save is
confined to the configuration directory. Managed `${...}` release patterns need concrete
local configured copies before authoring. Variants require a configured glob that admits
the sibling file. This adapter saves one source per review; it does not emulate a batch
with sequential partial commits. Assignment currently requires YAML workflow source.
Import/export is exact-source copy through the existing editor. Revision history contains
acknowledged local digests; historical body lookup is unavailable. A missing new variant
cannot be rebased onto an unrelated allocation; retain/export its source and recreate it
from current authority. An unacknowledged write may already have reached disk, so read and
reconcile before retrying.

The parent must compose the pinned wiring and run exact combined-head checks. The
independent first-run owner must supply durable configuration/asset receipt persistence
and rebind: #572 currently pins prepared bytes, so a later source Save must not silently
rewrite that receipt. Native gates remain real Electron keyboard/focus/screen-reader and
short-window scrolling, packaged app/daemon restart with retained configuration, and
macOS/Windows Keychain/DPAPI and ownership/recovery acceptance. This slice supplies no
signed delivery, updater/diagnostics enablement, Actions dispatch or physical native proof.
