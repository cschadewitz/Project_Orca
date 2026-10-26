# #704 Claude offline qualification harness — provenance plus allow/cached/revoke protocol

26 October 2026. Actual base `46ce182308e8d5b59c4fdbabd49232b4cf4cdbdc` (equal to the
handoff baseline; main had not moved). Node 24.21.0, pinned pnpm 12.4.2, existing
Vitest 5.0.5; frozen install, no dependency or lockfile change.

**Claude remains UNKNOWN. Installed observations: NONE.** This is an offline harness
for [#704](https://github.com/cschadewitz/Project_Orca/issues/704). It authorizes no
installed Claude experiment, provider launch, hook or settings change, credential or
access change, network judge or activation. Passing it is not installed proof and
being a Claude agent does not supply installed-provider evidence.

It consumes the merged #713/#724 packet ([README](README.md),
[source pins](source-pins.json), [publication metadata](claude-publication-metadata.json),
[fixture PLAN](claude-fixture-plan.md), [validation](validation.md),
[vectors](vectors.json)) without repeating the provider survey or editing those
files, the canonical contract, runtime adapters, #742's producer or the positive
observer.

| Owned file | Role |
| --- | --- |
| [claude-qualification-704.test.js](../../../tools/test/claude-qualification-704.test.js) | Runnable harness: provenance classifier, canonical mapping, protocol driver, receipt assessor |
| [provenance.json](../../../tools/test/fixtures/provider-enforcement-704-705/claude-qualification/provenance.json) | Candidate identities (re-verified) versus installed facts (all unknown) |
| [scenarios.json](../../../tools/test/fixtures/provider-enforcement-704-705/claude-qualification/scenarios.json) | Deterministic protocol scripts, synthetic native hypotheses and expected counts |
| [evidence-format.json](../../../tools/test/fixtures/provider-enforcement-704-705/claude-qualification/evidence-format.json) | Sanitized public receipt format and limits |
| [installed-observations.json](../../../tools/test/fixtures/provider-enforcement-704-705/claude-qualification/installed-observations.json) | The installed record: `NONE`, no receipts, no authorization |

## Evidence levels

| Level | What it covers here |
| --- | --- |
| source-reviewed | Candidate pins: Claude Code 2.1.309, SDK 0.3.309 (npm integrity/shasum metadata only), claude-agent-acp 0.95.0 at `ebfbfbda…`. The test re-reads both packet files and recomputes the `claude-decode`/`claude-callback` excerpt SHA256 and byte counts before using them. |
| source-function-tested | Unchanged from #713/#724: adapter offered-option membership and post-await abort-before-decode, in [the existing source test](../../../tools/test/provider-enforcement-source-704-705.test.js). The manifest cites those tests by name; this harness does not re-run excerpts as a new claim. |
| synthetic-protocol-tested | Every receipt the harness emits. The native Claude dispatch, permission cache, hook invocation and failure behaviour are stated **hypotheses per scenario**, not observations. |
| installed-observed | **None.** `installed-observations.json` is `NONE` with an empty receipt list, and the test asserts both. |

## Candidate identities versus installed evidence

The classifier reads a fixed list of required installed facts, so a fact deleted
from the manifest is reported `missing-fact`, never skipped. A fact counts as
complete only when it is marked `installed-observed` with an opaque installed
receipt reference. A `complete` value at any lower level stays unknown. Failure
semantics count only when all five modes are observed to block; otherwise the fact
is unsupported. All fifteen facts are currently unknown:

| Installed fact | What the later experiment must observe |
| --- | --- |
| executablePath, launcher, platform | Resolved executable, wrapper/launcher chain and argv, OS/arch/libc and selected optional platform package |
| packageIntegrity | Installed tarball/platform-binary digest, not registry metadata |
| cliSdkArtifactCorrespondence | Which native artifact the CLI and SDK actually run. A shared `.309` suffix is asserted not to count, even if forged as `complete` at source level |
| effectiveSettingsProvenance, protectedOwnership | Effective merge of managed/user/project/local settings; hook, checker and policy outside agent-writable locations |
| hookPrecedence, hookMatchers, hookDecisionFrame | Ordering among managed, disabled, overridden and later rewriting hooks; matcher coverage for the fixture tool; the exact output that **defers** to native permission rather than an `allow` that bypasses it (an empty success can look the same as a failed checker) |
| finalInputBinding, finalCwdBinding | Dispatched input and effective cwd equal to the checked frame after all rewrites |
| failureSemantics | Unavailable, crash, timeout, malformed and empty each block on the selected artifact |
| pendingCancellationOwnership | Pending hook/permission ownership across cancellation, late response and restart |
| cachedRepeatHookDispatch | PreToolUse runs for a natively remembered permission |

## Canonical admission over provenance

The harness maps the manifest onto accepted #700 vocabulary (`CoverageV1`,
`FactV1`, `StrictPermissionState.coverageAndState`). It does not add a field,
flag or second permission contract, and it runs the actual
`evaluateStrictPermission`/`selectStrictPermissionOption`:

- The current record yields `indeterminate` / `coverage-or-state-unavailable`, and no
  option is selected.
- Supplying the owner precondition alone still yields `insufficient-coverage`,
  because the hook and protected configuration are unknown.
- A hypothetical, never-persisted, fully installed manifest still yields
  `insufficient-coverage` without independently observed installed effects. Only
  when that last gate is also supplied does it allow. This positive control shows
  the mapping is not a constant refusal.
- Removing any one of the fifteen facts from that hypothetical manifest returns the
  record to non-admission.

## Protocol harness

The protocol prefers authoritative inactive ORCA code to a model:

| Actual ORCA code exercised | What it decides |
| --- | --- |
| `createStrictPolicyPort` → `evaluateStrictPermission` | Allow, `rule-revoked` deny, `no-approved-match` for an unapproved hook-time cwd |
| `DisposableMemoryReadOwner` | Owner-local resource/generation, current-state assertion and the **independent effect counter** (`observedReads`) that stands in for the PLAN's `orca_fixture_mark` counter |
| `SyntheticReadFence` | One capture per original invocation (a replayed tool-use ID is refused), one-use permit, foreign-permit rejection, revalidation at dispatch (stale generation refused) and original-signal cancellation |

These parts are harness-owned and labelled `synthetic:` in receipts:

- The native dispatch/permission-cache/hook model and its failure policy.
- PreToolUse frame validation: closed, documented field names and a 4 KiB limit.
- The final input/cwd comparison at execution.
- Propagation of a revocation to live owners.
- The synthetic shell counter.
- The receipt assessor.

The native "cached" repeat is a synthetic remembered permission. It is never
presented as observed native caching. Command strings are only data: every
`node:child_process` export is replaced by a throwing guard, `fetch` is stubbed to
throw, and the test asserts that neither was reached.

Main experiment (`allow-cached-revoke`; typed row; hypothesis: hook on every
dispatch, failures block): first allow, identical repeat with a distinct invocation
and no native ask, revoke, third identical call.

| Count | Expected | Observed (synthetic) |
| --- | --- | --- |
| hook checks | 3 | 3 |
| native asks | 1 | 1 |
| ORCA allows | 2 | 2 |
| independent effects | 2 | 2 (third call: `rule-revoked`, zero effect) |

The same counts hold for the shell row. All three dispatches share one binding
label and carry three distinct invocation labels. The assessment is still
**UNKNOWN**, because no receipt is installed-observed.

| Scenario (vector ids) | Expected outcome |
| --- | --- |
| cached-hook-skipped typed/shell (`claude-cached`) | Typed: no permit, no effect. Shell: an unchecked effect. Both report `cached-repeat-not-checked` and `dispatch-not-checked`, and are assessed as a detected violation pattern |
| command/cwd changed after check (`claude-command-changed`, `claude-later-rewrite`, `claude-cwd-changed`) | Typed: `final-binding-mismatch`, zero effect. Shell: an effect with `effect-binding-mismatch` |
| cwd unapproved at check (`claude-cwd-changed`) | `require-human` / `no-approved-match`, no ask, zero effect |
| stale binding (`claude-revoked`) | Allow and permit, then revocation before dispatch: the fence refuses, zero effect |
| replay (`claude-replay`) | The replayed tool-use ID gets `invocation-already-registered`; re-dispatch of the consumed permit returns the same receipt with no new effect |
| concurrent identical (`claude-concurrent`) | Two invocations and two permits; a cross-invocation permit is `foreign-permit`; each permit yields one effect |
| cancelled pending / before dispatch (`claude-cancel-late`) | `pending-cancelled`, or the fence refuses after cancellation; zero effect |
| late response, native continues (`claude-cancel-late`, `claude-outage`) | `pending-cancelled`, then `no-permit`, zero effect; `native-continued-after-hook-failure` |
| unprotected configuration (`all-config-drift`) | Preflight `unsupported:protected-ownership`; no protocol run |
| configuration mutated mid-run (`all-config-drift`) | Hook removed: `configuration-mutated`; the repeat is unchecked and gets no permit |
| unmatched route, shell (`all-bypass`) | An unchecked effect: `dispatch-not-checked`, `effect-without-orca-allow` |
| failure matrix: unavailable/crash/timeout/malformed/empty × block/continue × typed/shell (`claude-outage`, `claude-checker-death`, `claude-malformed`) | Block: zero effect. Continue: typed has zero effect but a continuation violation; shell has one unchecked effect |

`claude-option-forged` remains covered by the existing source-function test. The
test asserts that every Claude and cross-provider #713 vector is consumed.

## Sanitized evidence format and assessment

Receipts have closed keys (`seq`, `stage`, `level`, `sourceRef`, plus `callRef`,
`invocationRef`, `outcome`, `reason`, `generation`, `bindingRef`). Every value is a
short token matching `^[a-z0-9][a-z0-9:._-]{0,63}$`, and each stage has a closed
outcome list. Limits: 12 KiB per row, 256 KiB per transport and a 4 KiB hook frame.

Binding, invocation and generation values are per-run sequence labels, never hashes
or digests. The test asserts that no receipt contains a command, input value, cwd
or `/`.

The assessor never returns GO:

- Any violation in an installed-observed run is a `NO-GO-CANDIDATE`; in a synthetic
  run it is only `SYNTHETIC-VIOLATION-DETECTED`.
- `REVIEW-CANDIDATE` requires all of: every receipt installed-observed, complete
  installed provenance, a checked cached repeat and a blocked post-revocation call.
  Even then a human must review it.
- Everything else is `UNKNOWN`, including the empty installed record, mixed-level
  receipts and receipts relabelled as installed without complete provenance. The
  relabelling exists only inside the test, to show that the gate is reachable.

## Prerequisites for the later installed experiment

Each item needs its own explicit authorization (PLAN "Authorization needed later"):

1. A named host and an isolated fixture workspace. The resolved CLI/SDK/platform
   artifact tuple with installed digests. CLI/SDK correspondence established from
   the artifacts, never from version suffixes.
2. Effective settings provenance and protected, non-agent-writable ownership of the
   hook, checker and policy. The managed precedence and matcher order recorded
   privately.
3. The hook decision frame: an ORCA allow must defer to native permission, not
   bypass it, and must be distinguishable from an empty or failed checker. A
   bypassing `allow` cannot exercise the native cache and is a stop.
4. Fail-closed behaviour observed for all five failure modes on the selected
   artifact (for example, whether `onFailure: block` exists and applies there). An
   unset failure policy that continues is a NO-GO for the shell row.
5. Native permission remembered only if already legitimately available or narrowly
   authorized for the exact fixture. A wider remembered grant is a stop.
6. The PLAN budget (one session, at most ten minutes, three typed then three shell
   actions, one outstanding, two-second checker deadline, no retries). The typed
   row runs first.
7. Installed receipts written in this format to `installed-observations.json`, with
   provenance facts promoted to `installed-observed` by reference only. Private
   values stay in protected storage.

Crash, timeout, cancellation and replay negatives need a further bounded
authorization, and none may run on a production session.

## Validation

| Check | Result |
| --- | --- |
| `pnpm exec vitest run tools/test/claude-qualification-704.test.js --maxWorkers=1` | 89 passed |
| Existing #713/#724, #594, strict-permission, live-input, fence and composed-memory regressions plus the new file (command below) | 12 files, 515 passed, zero skipped |
| `ci-classification`, `ci-package-selection`, `ci-shadow-selection` tool tests | 3 files, 160 passed |
| Scoped `eslint` and `prettier --check` on the new JS/JSON | Passed |
| `pnpm run lint` | Passed with `NODE_OPTIONS=--max-old-space-size=8192`; the first run hit V8's default heap limit (OOM, exit 134) before reporting |
| `pnpm run format:check`, `pnpm run typecheck` | Passed |
| Markdown local links, LF, final newline, trailing whitespace, fences; `git diff --check` | Passed |

```sh
pnpm exec vitest run tools/test/claude-qualification-704.test.js \
  packages/agents/test/provider-qualification-704-705.test.ts \
  tools/test/provider-enforcement-source-704-705.test.js \
  tools/test/acp-command-evidence-source.test.js \
  packages/agents/test/command-evidence-v1-594.test.ts \
  packages/agents/test/strict-permission.test.ts \
  packages/agents/test/permissions.test.ts \
  packages/agents/test/live-input-session.test.ts \
  packages/engine/test/live-input.test.ts \
  packages/daemon/test/live-input-authority.test.ts \
  packages/engine/test/synthetic-read-fence.test.ts \
  packages/engine/test/composed-memory-guard.test.ts --maxWorkers=2
```

Failing-before/passing-after: the new file did not exist at base. Each temporary
mutation below turned the named tests red; restoring it turned all 89 green again.

| Mutation | Tests that failed |
| --- | --- |
| Changed one SDK integrity character in the manifest | The pin-match test (1 failed) |
| A fabricated `installed-observed` protectedOwnership | The NONE and canonical-record tests (2 failed) |
| Main experiment with the hook skipped on the cached repeat | The counts, cache-labelling and relabelling tests (3 failed) |
| Revocation not propagated to live owners | `stale-binding` (1 failed) |
| Harness final-binding check removed | Command and cwd changed (2 failed) |
| Assessor ignoring continuation after failure | Late response plus the typed continue-matrix rows |
| Revoke step removed from the main experiment | The main experiment and the relabelling gate (2 failed) |

Mutations 4 and 5 show what is harness-owned: propagation of revocation and the
final-binding comparison are model code, while the refusal itself comes from the
actual fence and evaluator.

Not run:

- The full suite and coverage.
- Build, App smoke and platform/beta acceptance.
- Upstream Claude, adapter or SDK suites.
- Any installed, native, provider or actual-Cal check.
- Hooks, settings or network judges.

#704 and #705 stay open. #594 unsupported mode and ownership are unchanged.
