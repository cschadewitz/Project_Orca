# Claude review-fix integration review - 25 October 2026

Reviewed source: `438ab5df182e516608aa95bd835fee821b9e5906`, directly 15 commits
ahead of `0c75d01eb0cab389ad1cbff5d1fb9a60bfe64362`. GitHub comparison freshly
confirmed those identities. The existing checkout and Claude branch were preserved.
Four independent GPT-6.1 Sol High reviewers covered permission/configuration,
recovery/compaction, consent/keyboard/focus, and Mac/release changes. The integration
owner reviewed artifact visibility and the protocol reference, owned all edits,
and coordinated one aggregate focused test attempt.

## Scoped findings and repairs

1. **P1, explicit authority guards inside workflow areas:** the new global writable-area
   exemption could hide config and sidecar guards with an overlapping store layout or a
   linked config path. Each read-only root is now evaluated independently; only a strict
   ancestor of a writable area may yield to that area. Tests cover overlapping roots,
   canonical linked paths, ancestor removal and ordinary deliverables. No authority was
   broadened.
2. **P1, copied update namespace with torn enrollment:** missing/unreadable enrollment
   skipped the existing-original refusal. Re-anchoring now also checks surviving guards
   before rewriting any root and refuses another existing control path. Regression cases
   cover missing/torn enrollment, original and copied required roots, and an original
   whose admission closed after the copy. Original guards must remain unchanged.
3. **P1, interrupted confirmed reset:** deleting the last guard/window before enrollment
   could leave established enrollment with neither a readable window nor a reset offer.
   Enrollment is now durably removed first. A regression interrupts deletion after the
   window is removed, preserves the workspace guard, then reprovisions and reenrolls it.

These corrections extend the scoped fixes; they do not claim to close all findings from
the 13 October review. The historical 426-finding inventory and its severity assessment
are not validation evidence for this branch.

## Source disposition

- Fan-out and distinct work-item children are excluded from earlier-sibling artifact
  visibility; same-item sequential/loop iterations retain feedback. Explicit upstream
  context remains the cross-item path. Added tests exercise concurrency-limited fan-out,
  dependency ordering, plan dispatch and artifact version isolation.
- Per-agent grant edits preserve unrelated daemon grants, pending-write edits and conflict
  drafts. Unreadable sidecars cap later allows while preserving earlier configured rules.
  No cross-target retry defect was confirmed after checking main-process epoch fencing,
  serialized writes and the pending-draft target-switch guard.
- Consent changes bind answers to card identity, preserve focus across pushes, pass native
  Enter through controls, suppress key repeat and reject stale palette targets. Always
  answers align their one-time polarity with the standing rule; the daemon checks mismatch.
- No additional scoped blocker was found in abandoned admission pruning, ownership journal
  compaction, Git reopening or explicit previous-boot settlement. Settlement retains
  explicit confirmation and the continuation fence.
- Mac startup remains packaged-only and refuses recorded attempts/journal evidence. The
  release workflow now builds first and includes the production/retry checks; changelog
  and surface-driven smoke changes match their claims in source.
- The protocol reference documents conditional method/authority discovery, current protocol
  2.0, operator/admission/revision additions and the unbumped template/draft additions.
  Documentation does not substitute for runtime interoperability or native acceptance.

## Validation and limits

Installed tools: Node `24.19.0`, pnpm `12.4.2`, TypeScript `7.0.2`, Vitest `5.0.1`.
The manifest requests Vitest `^5.0.2`; installed dependency links are not a frozen-install
proof. Existing node_modules were reused through local junctions. `pnpm exec --version`
unexpectedly began resolution; it was stopped after localhost-proxy download failures.
No tracked dependency file, credential, proxy or security setting was changed.

- One aggregate attempt over 23 focused files: 5 files passed, 18 failed; 120 tests passed,
  37 failed and 1 skipped. Fourteen suites failed to import due to missing package links
  (including `zod`, `yaml`, `@testing-library/react`). Update-window tests require the absent
  `first_run_windows.node` addon; Mac fixture/ownership tests also lacked usable native
  ownership evidence. The 1,000-cycle admission test exceeded its 30-second timeout on this
  Windows filesystem. These are failed/blocked checks, not passes.
- After repairs, the supported subset passed: **5 files, 105 tests passed, 1 skipped**:
  `packages/agents/test/permissions.test.ts`, `protected-paths-session.test.ts`,
  `packages/app/renderer/test/keyboard-map.test.ts`, `tools/test/changelog.test.js` and
  `release-workflow.test.js`. The skipped case is the existing POSIX-only permission case.
- Root TypeScript checking failed on missing installed package links and consequent type
  errors. A package-only attempt also lacked built workspace declarations; neither is a pass.
- The repair files were formatted and `git diff --check` passed. The new Mac/protocol
  regressions require an appropriate POSIX/native-capable validation environment before
  acceptance; no production workaround, skip or weakened assertion was added.
- Design generation checking passed after normalizing the two generated files' local CRLF
  checkouts to LF; their Git content had no change, and the checkout normalization was
  restored. The initial byte comparison failure was a checkout-line-ending artifact.

Remaining gates: final-head CI, a complete installed-dependency typecheck/build and affected
behavior tests, protocol/reset regressions on POSIX, app smoke, and the separately held
packaged Mac/compiled Windows acceptance. Diagnostics remain disabled and native Mac
activation remains held. No runtime release, deployment, workflow dispatch or installation
was performed.

## Residual findings, outside the blocker repairs

- ORCA-mediated path checks cannot prevent an agent's native tools from editing authority
  files inside its process-accessible roots. ADR 0009 acknowledges that remaining C4-01
  boundary; this is not complete operating-system isolation.
- Removing the last focused Attention card still leaves focus on the page body when no
  neighbor survives. The inherited rule-10 gap needs an Attention-region fallback.
- The policy editor follow-up explicitly labels wildcard sidecar allows as ignored, including
  saved rows and edits in progress. Saved configuration remains compatible and is not silently
  rewritten; deny/ask rules retain their existing presentation. This is an editor explanation
  only: loader/evaluator restrictions and authorization behavior are unchanged. A title pattern
  is a match condition, not trustworthy exact-command evidence; #594 remains unresolved.

The remaining original findings require separate triage; this integration is not an audit
closure or permission to merge, release or activate native behavior.

## App smoke follow-up

The original integration head `5af9d2b0950bc46f5a1085da44cba228b1990779`
passed [CI 40184244590](https://github.com/cschadewitz/Project_Orca/actions/runs/40184244590).
The manually dispatched [App smoke 40185207858](https://github.com/cschadewitz/Project_Orca/actions/runs/40185207858)
checked out that exact head. Linux functional Electron smoke passed. Windows type
proof passed all six tests; native encrypted-intent acceptance passed both tests on
Windows and macOS. macOS native revision acceptance passed. The two failures below
are distinct and do not invalidate that passing evidence.

### Reviewed Linux/macOS type fixtures

All four screenshots on each platform compared an old 640 by 2921 fixture with a
640 by 3493 actual image. Commit `1f0fb0a` added ObjectId examples and object-kind
glyphs; Windows fixtures were updated by `066246f`, while Linux/macOS remained
stale, as already recorded in the [10 October design review](2026-10-10-design-conformance.md).
Commit `a0d00f4` describes the intended glyph additions and remaining platform work.

A Sol Medium reviewer inspected all 24 expected/actual/diff images from the
[Linux artifact](https://github.com/cschadewitz/Project_Orca/actions/runs/40185207858/artifacts/12596355958)
and [macOS artifact](https://github.com/cschadewitz/Project_Orca/actions/runs/40185207858/artifacts/12595607517).
Each actual image's first 2200 pixels is exactly equal to its expected image.
Changes begin with the intended ObjectId section and expanded glyph catalog.
Bundled glyphs are legible without tofu; missing glyphs in the faces-off control
remain expected fallback behavior. The eight fixtures now use those reviewed
actual PNG bytes, verified against the downloaded artifacts. Windows fixtures,
type-proof source, screenshot threshold and assertion deadlines are unchanged.
The transient macOS 3461-pixel capture settled to the saved 3493-pixel image; it
does not explain the persistent content difference.

### Windows revision refusal and cursor correction

The [Windows revision artifact](https://github.com/cschadewitz/Project_Orca/actions/runs/40185207858/artifacts/12596326104)
contains sanitized evidence: profile and ownership checks passed, one
`inputs.revise` call was sent, no receipt returned, and its error was
`STORE_LOCK_TIMEOUT`. The 15-second receipt assertion cannot recover a rejected
request. An unchanged-head local Windows run passed once, demonstrating that a
single pass is not evidence that the historical refusal was harmless.

The retry catalog has a 100ms acquisition deadline. Continuation discovery runs
at startup and every five seconds, and its batch read unconditionally published
and synced `cursor.json`, even for an empty catalog or unchanged complete page.
The existing [CI403 contention analysis](../runtime-operator-integration.md#ci403-catalog-contention-test-separation)
already demonstrated that this unnecessary empty-cursor sync can block a fresh
foreground admission. The failed runner did not record the exact lock holder,
so attributing that particular refusal to the background cursor remains an
inference, not captured ownership evidence.

The correction skips publication only when the parsed cursor equals the next
cursor. Catalog repair, the shared mutex, changed-page durability, quotas,
authorization, accepted-replay checks and bounded refusal behavior remain intact.
No mutation retry, timeout increase, assertion suppression or fixture-only
quiescence was added. This removes a demonstrated contention source; it does not
guarantee every concurrent fresh admission can acquire the catalog.

Three new behavioral regressions failed against the old implementation: an empty
batch created an unnecessary cursor, and existing empty/populated cursors were
rewritten. With the correction, the focused fresh-validation, continuation-locator
and catalog-contention suites passed **51 tests in three files** on Windows.
The locator coverage also checks persisted advancement beyond 100 entries and
wrap after another store instance reads the final page. Focused TypeScript build,
ESLint, formatting and `git diff --check` passed. A separate Sol High review found
no safety or correctness issue in this delta.

After rebuilding the corrected store, the native Windows revision workflow passed
its complete UI/save/restart/conflict/review/delivery test once (30.4 seconds).
All existing assertions remained enabled. This is local focused acceptance, not a
substitute for the final hosted platform rerun.

Validation used a local frozen install with Node 24.19.0, pnpm 12.4.2 and the exact
locked Electron 44.4.5. Dependency manifests and lockfile were not modified.
Final-head CI and hosted Linux/macOS type-proof/native acceptance remain parent
gates. This follow-up dispatched no workflow and performed no merge, deployment,
release, security-setting change or activation.

## Final dependency and main composition

After the smoke correction was published, parent coordination approved composing
the exact [dependency PR636](https://github.com/cschadewitz/Project_Orca/pull/636)
head `3b726d7456c77c3041b65d94ae526de254b15232` and docs-only main
`fdb3500d56f6d22a53ea3d618b9232c968577353` into this integration branch.
The dependency head passed [CI 40185294006](https://github.com/cschadewitz/Project_Orca/actions/runs/40185294006)
and its independent [source, lock and advisory review](https://github.com/cschadewitz/Project_Orca/pull/636#pullrequestreview-5642789601).
It includes Electron 44.9.1 and compatible transitive security patches.

Both merges completed without conflicts. Every dependency manifest and the
lockfile remain byte-identical to that reviewed dependency head; no resolution
or lockfile regeneration was performed. The corrected M10 docs from main and all
Claude fixes remain in the composition. The original Claude and dependency
branches were preserved.

A fresh frozen install of the combined tree used Node 24.19.0, pnpm 12.4.2,
Vitest 5.0.5, Playwright 1.64.1 and Electron 44.9.1. The combined build passed.
The earlier Electron 44.4.5 results above remain historical evidence; final
interaction checks and hosted verification must use the composed head.

On that combined tree, the three focused store/engine suites passed all **51
tests**, and the complete native Windows revision workflow passed once with
Electron 44.9.1 (**34.2 seconds**). Changed-file ESLint and formatting checks also
passed. No full local suite was repeated. Final aggregate CI, independent parent
delta review and the coordinated exact-head hosted App smoke run remain gates;
the reviewed Linux/macOS snapshots still require that final Electron-version
comparison. This follow-up did not merge into main or close any source PR.
