# M21 implementation composition self-review - 9 October 2026

PR #605 implementation head `c2b469fb5a437c7056eaecc2c7bb141dff2255aa` is now
composed into local branch `calcifer/integration-candidate-20261009`. Its exact
base and sole parent are #584 `6fcd543a368246c2156f86a225072a871c754435`.
The composed and tested source head is
**`b5086ffc20c3c132b5061af3253be1b9c55f4575`**, with parents the prior local
candidate `98104c039f59e1f6d72901b5a6b46270ed7bf42a` and that #605 head.
All previous maximal tips remain ancestors and divergent #577 stays excluded.

This supplements the [initial review](2026-10-09-integration-candidate.md).
The [sanitized M21 receipt](integration-m21-composition-2026-10-09.json) contains
source hashes, unchanged protected paths, exact input checks and per-file tests.
The original receipts retain their historical source pins. Counts are not summed
or promoted to aggregate/native acceptance. Full local logs and JSON reports are
in this desktop task's `evidence/` directory beside the checkout.

M21's native Request/restart acceptance is still owned by its separate task.
Composition proceeded without waiting for that result, as instructed. No native
harness, Electron, build, live service/provider, CI or publication ran here.

## Exact composition and conflicts

Read #605 metadata and fetched its ref, verifying that one implementation commit
was missing from the candidate. main remained
`db579fb7ac9cfce2e4e6901713088a80602311da`. The final read-only ref check still
showed #605 at the incorporated head and its base branch at #584. Author and
committer remain Calcifer Schadewitz `<schadewitzcalcifer@gmail.com>`.

The only textual conflict was the `.orca-window` comment in shared design CSS.
Both inputs specify the same `grid-template-columns: minmax(0, 1fr)`. Retained
the existing explanatory comment and identical declaration; the resulting CSS
file is byte-identical in Git to the previous candidate. #605's Config layout
corrections were already present, so the Config surface/layout files have no
additional composition diff. Generated tokens were not edited. Read
[design rules](../design/RULES.md) before this UI overlap review.

The guided launch route test auto-merged. Its existing first-run sample and
diagnostics-navigation checks remain alongside #605's new Request selection,
typed-draft, accepted-receipt and recovery-only authority cases; the merged file
passes. No other textual conflict occurred.

## Substantive source review

- **Request capture and authority:** main obtains the exact captured workflow
  input schema from guarded preflight, rather than a separate potentially drifting
  definition read. Choice pagination checks target, generation, restart state,
  repeated cursors and bounds. Request preview and main's retained-intent check
  carry the descriptor, supported overrides and expected workflow/configuration
  revisions. Main rechecks resolved selection provenance and checkout identity
  before retention/send. The daemon shares the defaulted Request constructor with
  admission, validates selections against captured registries, withholds input
  values, rechecks current authority/generation and enforces the projection bound.
  Missing captured item workflows are rejected before admission.
- **Protected recovery and repeat actions:** recovery uses its current inspect or
  reconcile grants independently of new-launch/config-read availability. The
  original protected descriptor, principal/target scope, operation and retry key
  remain the recovery basis. Accepted receipts cease to block updates while the
  retained intent still prevents a second launch. Invalid typed editor text is
  retained through navigation; it invalidates preview instead of reusing an older
  valid value. The smoke-check selector clears unrelated Request overrides/text.
- **Config focus and first-run overlap:** array/record structural actions can
  focus an actual reference `select`. Existing narrow layout and scroll ownership
  remain unchanged. Main/preload, Workspace, CLI bootstrap/command composition and
  first-run writer/closed-bootstrap wiring are byte-unchanged from the previous
  candidate. The existing Windows POSIX ownership refusal remains supported as a
  refusal, with no UID shim or weakened check.
- **Template read/write boundaries:** authoritative catalog diagnostics reach
  the mounted editor. A clean read-only view can reconcile and preview fixtures;
  retained edits and mutations still require write authority. Blank IDs are
  refused, partial consumers use exact IDs and applied history records the
  reviewed source digests rather than a later reload. Existing writer locks,
  target/revision/generation fences and separate Save/Apply remain in place.
- **Held features:** diagnostics contract/controller/initializer/native code and
  main registration are byte-unchanged. `DIAGNOSTICS_PRODUCTION_ENABLED` remains
  false, and shipping IPC/persisted-consent/Windows refusal checks pass again.
  Managed updater activation remains explicitly false. The CLI safeguard
  resolution, installed plugin verifier, writer barrier and closed trusted-serve
  refusal pass affected regression checks. C15 managed-memory failure and the
  unsupported exact-command positive handoff remain unresolved; neither was
  tuned, waived or activated.

No additional bounded integration defect was found in these reviewed overlaps.
This is self-review, not an independent acceptance decision.

## Executed lightweight checks

Node 24.19.0 / pnpm 12.4.2, Windows x64, existing frozen dependencies. On the exact
composed source head, **266 passed, 0 failed, 2 skipped across 21 affected files**
with one Vitest worker at a time. The two skips are supported-platform first-run
sample cases in `guided-launch-adapter.test.ts`; the Windows ownership-refusal
case ran. The receipt records their exact names.

The selected files cover Config form/routes, guided launch controller/route/shared
bindings/surface/main adapter, template model/editor/route/service, Request
preflight, captured generation and selection validation, operator schemas, and
retained diagnostics/CLI/plugin/writer-barrier safeguards. This is an affected
source/renderer suite, not the full combined suite or native acceptance.

Root and renderer `tsc --noEmit`, CSS token checks, scoped ESLint over fourteen
changed overlap files, canonical-Git-blob Prettier over those files, ancestry,
unchanged-held-wiring and `git diff --check` passed. The initial read-only helper
attempt used an unsupported Windows path for an ESM import; converting the helper
path to a file URL corrected the helper and the checks completed. Product source
did not change for that repair. Shared design CSS's historical format limitation
was not expanded or reformatted; its composition content is unchanged.

## Remaining prerequisites

1. M21 must return its final native Windows Request/Abandon-intent-confirmation
   and restart reconciliation disposition, exact tested head and sanitized receipt.
   Review and compose any resulting final delta through the parent. Source tests
   here cannot certify that native workflow.
2. The parent still coordinates aggregate validation and any heavy build/Electron
   window. Full suite/coverage, mandatory no-skip retry cases, compiled bundle
   checks, native/platform/UI acceptance and any required independent review remain
   unrun for this local candidate.
3. C15 enabled-mode memory failure, updater activation and exact-command evidence
   remain separate held gates. No constituent evidence closes them.
4. CI and consolidated publication remain gated on M21's final disposition and
   combined validation, with the parent owning the checkpoint and final merge.
