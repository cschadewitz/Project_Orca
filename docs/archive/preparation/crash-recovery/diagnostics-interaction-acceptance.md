# Diagnostics interaction acceptance — repeated opt-out

This bounded #416/#469 slice starts from main
`408a21d8b1c93e08f95dd17298800af9df4bde2b`. Production capture remains
hard-disabled. All interactions below use synthetic bridges or disposable Linux
fixtures; no user diagnostic history is deleted or exported.

## Existing coverage inventory

The following source tests were mapped before selecting the missing behavior.
They are reusable evidence at their stated boundaries, not completion of the
whole native interaction checklist.

| Boundary | Existing source coverage |
| --- | --- |
| Consent | `renderer/test/diagnostics.test.tsx`: default Off, no automatic consent/export/picker/Save, remembered choice without production capture; `test/diagnostics-startup-consent.test.ts`: consent-fenced startup |
| Separate Save authority | Renderer descriptor-only metadata, explicit picker then Save, revision fences, expiry and stale handle disposal; `test/recovery-integration.test.ts`: fresh picker, exact committed bytes and native fixture no-replace |
| Repeated clicks | Renderer same-turn preparation and Save; integration repeated Save joins one operation |
| Cancel/back/retry | Renderer picker cancellation clears destination, late picker ignored after cancel, unmount cancellation, cancel/expiry after refused Save permits fresh export; integration unknown work requires cessation/cleanup and acknowledgement before separate fresh Save |
| Opt-out/delete | Renderer truthful failed revocation and admitted-before-revocation Save push; integration durable summary removal, unresolved work and preservation of already exported files |
| Recovery races | `test/recovery-authority.test.ts`: older Enable versus newer Off, late previous-session preparation after renderer disposal, uncertainty and maintenance retry; integration restart and interrupted-operation schedules |

Paths in the table are relative to `packages/app/`. The storage and controller
suites contain additional fault schedules; this map identifies overlap relevant
to choosing this interaction change.

## Missing behavior and implementation

Repeated **Delete all and turn off** clicks previously bypassed the renderer's
general pending-action guard. Each click dispatched another Off request and
incremented the local authority epoch, potentially suppressing the first Off's
failure feedback. The controller already coalesces durable disabled-setting
writes; this change coalesces the renderer intent until its request settles.

A synchronous dedicated Off guard now prevents duplicate dispatch and duplicate
local authority invalidation. The first Off still interrupts pending Save,
preparation, picker or cancellation work. Failure releases the guard so a
subsequent deliberate Off can retry. No storage, key, IPC contract, publication,
retention or collector behavior changes.

Four regression cases in `renderer/test/diagnostics.test.tsx` cover:

- Same-turn triple click and a later-render click issue one Off, immediately
  remove report/destination authority, retain honest feedback for refused and
  transport-failed revocation, then permit a deliberate retry.
- Off dispatches while Save is pending, coalesces repeated clicks, and keeps the
  report/destination absent with Save-first and Off-first settlement. A stale
  Save response cannot restore authority; main's authoritative push can still
  report an admitted-before-revocation Save completion truthfully.

All four cases failed before the hook change on duplicate request counts
(three versus one, or two versus one); the existing 30 renderer cases passed.

## Validation and remaining gates

The following checks passed using Node 24.19.0, installed Vitest 5.0.5 and
TypeScript 7.0.2 after a frozen dependency install with lifecycle scripts disabled:

- `node_modules/.bin/vitest run packages/app/renderer/test/diagnostics.test.tsx --maxWorkers=2`: 34/34.
- `node_modules/.bin/vitest run packages/app/test/recovery-authority.test.ts packages/app/test/recovery-integration.test.ts packages/app/test/diagnostics-shipping-ipc.test.ts packages/app/test/diagnostics-startup-consent.test.ts --maxWorkers=2`: 66/66.
- `node_modules/.bin/tsc -p tsconfig.json --noEmit` and
  `node_modules/.bin/tsc -p packages/app/renderer/tsconfig.json`.
- Targeted ESLint and Prettier for both changed TypeScript files; `git diff --check`.

A separate read-only source/test review found no blocking issue. Full CI and
packaged UI smoke have not been rerun locally for this slice. These synthetic
interaction tests do not establish whole-product independent/privacy review,
manual accessibility/disclosure comprehension, packaged Windows interactions,
second-user isolation, network equivalence, signed installed-app behavior,
Darwin/APFS/Keychain, physical interruption or crash/sleep/reboot acceptance.
First-run preflight remains separately owned.

[Windows run5](windows-c15-readiness-run5.md), merged through #663, remains the
authoritative successful hosted synthetic Windows C15 evidence for its recorded
harness/product pins and limited scope. No overlap campaign is repeated here,
and no result is extrapolated to this renderer change. The unchanged 8 MiB
controlled-payload and 32 MiB combined-memory gates remain; 4 ms is separately
deferred under #597, not passed. Renderer-combined/continuous accounting and
remaining native resource/physical acceptance stay open. Keep #416/#469 open
and production capture disabled.
