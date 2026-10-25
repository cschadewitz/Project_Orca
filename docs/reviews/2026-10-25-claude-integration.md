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
- The policy editor can save/display wildcard allows that the new sidecar evaluator ignores.
  Validation or an explicit ignored-rule explanation remains useful follow-up work.

The remaining original findings require separate triage; this integration is not an audit
closure or permission to merge, release or activate native behavior.
