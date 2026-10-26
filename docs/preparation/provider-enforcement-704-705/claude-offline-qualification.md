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
`invocationRef`, `outcome`, `reason`, `generation`, `bindingRef`, and since the
[classification follow-up](#evidence-classification-follow-up) `runRef`, `actionRef`,
`cwdRef`). Every value is a
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
  Even then a human must review it. It means structurally reviewable supplied rows,
  not a completed experiment: "checked" accepts any decision, the rows are not
  validated and nothing is authenticated, so a deny-only sequence reaches it. See
  [the follow-up](#evidence-classification-follow-up) for the separate completion
  outcome.
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
7. Installed receipts written in this format, inside the
   `orca.claude-qualification-experiment/1` envelope, to `installed-observations.json`,
   with provenance facts promoted to `installed-observed` by reference only. Private
   values stay in protected storage. The run must also record the independent
   counter's per-call `effect-check` reading, not only the producer's `effect-observed`
   row, and a way to authenticate those rows has to exist before any of it can count
   as verified (see below).

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

## Evidence classification follow-up

26 October 2026, on `main` at `890eb71`. The harness, its fixtures and this document
were unchanged on `main` since #745 (`39ef58c`). The #745 integration note and the
#704 status comment both said the supplied-reference classifier and the
`REVIEW-CANDIDATE` assessor are not receipt authentication or a complete experiment
validator. This follow-up reproduces those limits, keeps the merged meaning, and adds
a separate, explicit completion outcome. **Claude remains UNKNOWN. Installed
observations: NONE.** Nothing here installs a hook, launches Claude or authenticates
anything.

### What the merged code did (reproduced before editing)

A temporary block appended to the merged test file (then removed) printed:

| Input | Merged result |
| --- | --- |
| Fifteen installed facts, each `complete` / `installed-observed` with a ref that names no receipt (the installed record has zero) | `classifyProvenance(...).complete === true` |
| The same, with one shared ref `producer-ok` and `producerSuccess: true` on every fact | `complete === true` |
| Six installed-labelled rows: a cached call denied, a revocation, a second call denied; no allow and no effect anywhere | `assess` → `REVIEW-CANDIDATE`, no violations |
| Those rows with an extra key carrying a path (`validReceipt` is false for every row) | `REVIEW-CANDIDATE` |
| Those rows with the last row replayed | `REVIEW-CANDIDATE` |
| A third call after revocation that is allowed and produces an effect, with a self-reported `gen-1` | `REVIEW-CANDIDATE`, no violations |

So `installedFact` checks the shape of a supplied reference, not that it is
authentic, and `REVIEW-CANDIDATE` means "structurally reviewable": a cached dispatch
reached *some* decision and a later call was blocked. It never meant that the
allow → cached repeat → revoke experiment completed. Both are kept as they are, and
the deny-only case is now pinned by a test that names it.

### Four separate questions

| Question | Answered by | Possible answers |
| --- | --- | --- |
| Is this source/offline simulation? | `classifyExperiment(...).tier` | `simulation` (every row below installed-observed), `mixed`, `malformed`, `none`, or `supplied-structurally-valid` |
| Is supplied evidence structurally valid? | The `orca.claude-qualification-experiment/1` envelope plus `validReceipt` on every row | `MALFORMED-EVIDENCE` otherwise |
| Is the provenance independently verified? | `provenanceAuthenticity(manifest)` | `shape` complete or incomplete; `authenticity` is always `unverified` (`no-receipt-authenticator`) |
| Did the intended experiment complete? | `classifyExperiment(...).sequence` | `complete`, `incomplete`, `failed` or `inconsistent`, with reasons |

No mechanism in the repository authenticates a supplied Claude receipt or
installed-fact reference, so **no attestor is invented**. A receipt string, a
`sourceRef`, a "signed"/"verified" field or a producer success boolean does not count
as independent proof. Extra fields like these do not fit the closed formats, so they
are `MALFORMED-EVIDENCE`. The provenance tier "independently verified" therefore
cannot be reached today.

### The experiment envelope and outcomes

`evidence-format.json` gains an `experiment` section. A run header names `runRef`,
`provider`, `tool`, `providerVersion`, `adapterVersion`, `actionRef` and `cwdRef`.
Every receipt carries the header's `runRef`, and dispatch, decision and tool-start
rows also carry `actionRef` and `cwdRef`. The format also gains an `effect-check`
stage (`changed`/`unchanged`): the independent counter's per-call reading, kept apart
from the producer's `effect-observed` row. These additions are additive. Every row
valid under the merged key and stage sets is still valid, and the 89 merged tests pass
unchanged. The synthetic emitter now writes the new labels and readings.

`classifyExperiment(record, manifest)` returns one outcome. Every outcome carries
`route: "UNKNOWN"`, and none of them is a GO or a qualification:

| Outcome | When |
| --- | --- |
| `NO-EVIDENCE` | No receipts (the current installed record) |
| `MALFORMED-EVIDENCE` | Envelope or any row fails the closed format |
| `SIMULATION-ONLY` | Every row is below installed-observed. `sequence` still describes the synthetic run |
| `INCONSISTENT-EVIDENCE` | Mixed levels; another run; provider, tool, version, action or cwd mismatch at dispatch or decision; duplicate, replayed or physically reordered rows; a reused invocation; a replay dispatch; extra calls or stages; generations that disagree with the revocation; `synthetic:` rows labelled installed |
| `EXPERIMENT-FAILED` | Every merged `assess` violation, plus: a start or effect after a denial, an allow after revocation (whatever generation it reports), a counter change the receipts do not report, or a started action/cwd that differs from the checked one |
| `EXPERIMENT-INCOMPLETE` | A required stage is missing or out of order, with no violation (deny-only is here) |
| `PROVENANCE-INCOMPLETE` | The sequence is complete, but the installed-fact manifest is not shape-complete |
| `EXPERIMENT-COMPLETE-PROVENANCE-UNVERIFIED` | Structurally complete supplied experiment with a shape-complete manifest. Still unverified, still UNKNOWN |

The outcomes are checked in the table's order. The merged `assess` result is returned
alongside as `review`, so a failed experiment keeps its `NO-GO-CANDIDATE` findings for
human review and is not reported as a success.

A complete sequence must contain exactly this, in order:

1. A first call: a `new` dispatch reaches the hook, ORCA allows it (decision and hook
   response), native asks once, the tool starts, and both the producer's effect row and
   the independent counter (`changed`) show the harmless effect.
2. An identical repeat: a `cached` dispatch with no native ask still reaches the hook,
   ORCA allows it, and both the effect row and the counter show the effect.
3. One revocation after the repeat finishes.
4. One identical `cached` call with no native ask that reaches the hook, where ORCA
   denies it (decision and hook response) and the counter reads `unchanged`. A block by
   a fresh native ask, a crashed checker or a missing reading does not count.

Within each call, completion requires `native-dispatch < hook-invoked <
orca-decision < hook-response`. Allowed calls also require `hook-response <
tool-start < effect-observed < effect-check`, and the first native ask must precede
its tool start. The denied call requires `hook-response < effect-check`: a snapshot
before the denied attempt cannot establish absence after it. These are partial
orders grounded in `nativeCall`, `checker`, `execute` and `checkedEffects` in the
[harness](../../../tools/test/claude-qualification-704.test.js). They impose no total
order on optional stages. The typed harness emits its optional `permit-claim`
inside execution, after `tool-start`; the synthetic shell path emits none.

The revoked call needs an explicit `deny` in both `orca-decision` and
`hook-response`. Missing outcomes, `require-human`, `indeterminate`, `refused` or
checker failures cannot substitute for that decision. Every decision and the
revocation must carry a generation before comparisons are made. Pre-revocation
decisions must carry a generation different from the revocation's, and the
post-revocation decision must carry the revocation's. Dispatch, decision and
tool-start rows must carry `bindingRef`; the checked bindings must agree across
the identical attempts and each start must match its decision. Missing identities
are reported explicitly, never accepted through equality of absent values.
A counter reading whose
`sourceRef` equals the decision's or the hook response's is not counted as
independent. Even a distinct `sourceRef` is only a claim until rows can be
authenticated.

### Negative controls (synthetic harness rows, not installed behaviour)

Each control relabels the synthetic main experiment's rows as a hypothetical supplied
record (never persisted), changes one thing, and asserts the outcome and reason. The
controls are: deny-only; a missing cached repeat; a natively asked repeat; a repeat
allowed without an effect; an "allow" that was really a hook timeout; a missing
revocation; a missing post-revocation call; a missing independent reading; a block
after a fresh native ask; a block by a crashed checker; a counter sharing the
decision's source; duplicated rows (identical `seq`) and replayed rows (renumbered
copies); a reused invocation; a replay dispatch; another run's row; provider, tool,
CLI-version and adapter-version mismatch; action and cwd mismatch; a generation
disagreement; physically reordered rows; a revocation moved before the repeat; an
effect moved before its decision; mixed levels; `synthetic:` rows relabelled
installed; an unscripted stage; an effect after denial; an unreported counter change;
an allow and effect after revocation under a self-reported new generation; action or
cwd changed between check and start; a cached repeat that skips the hook; and malformed
envelopes and rows (unknown key, path value, string `seq`, missing `runRef` or
binding, missing header key, wrong format, non-list receipts, `null` record or row).
Every synthetic protocol scenario and failure-matrix case is also asserted to classify
as `SIMULATION-ONLY`, except the unprotected-configuration preflight, which emits no
rows and is `NO-EVIDENCE`.

### Red/green

Red: the reproduction table above, on merged `main`. Green:
`tools/test/claude-qualification-704.test.js` has 140 tests passing (89 merged plus
51 new). Each temporary mutation below turned the named tests red, and restoring the
file turned all 140 green again:

| Mutation | Tests that failed |
| --- | --- |
| Completion uses the merged "checked" rule (any decision) | Deny-only (pinned and control), repeat without an effect, allow-was-a-timeout (4) |
| Allow-after-revocation check removed | The self-reported new-generation control (1) |
| Effect-after-denial check removed | The effect-after-denial control (1) |
| Synthetic rows classified as supplied | The 16 scenarios that emit rows, all 20 failure-matrix cases and the main-experiment test (37) |
| Row `runRef` not compared with the header | The another-run control (1) |
| A shape-complete manifest treated as authenticated | Main experiment, complete supplied sequence, receipt strings (3) |
| Independent post-revocation reading not required | The missing-reading control (1) |
| Duplicate stage within a call ignored | The renumbered replay control (1) |
| Rows not passed through `validReceipt` | Unknown key, path value, string `seq` and the authenticity-claims test (4) |

### Independent review correction (PR #760)

[Review 5658997393](https://github.com/cschadewitz/Project_Orca/pull/760#pullrequestreview-5658997393)
found that PR #760 at `0a882f1dec780f987e5b7f5ba9aa434a5c184ae1` still
accepted a post-revocation `effect-check` moved before dispatch and renumbered,
non-deny post-revocation decisions, and missing generation/binding labels.
The correction adds 69 controls: 18 coherently reordered stage pairs, 20 missing
stages, 12 missing/non-deny outcomes, five missing-generation combinations, nine
missing-binding combinations, two binding disagreements, and three positive
controls (typed, shell, and omitted optional typed permit claims).
Every negative uses rows that still pass `validReceipt` with consecutive sequence
labels. All records are hypothetical relabelled synthetic rows; none is persisted
as installed evidence.

The tests-only red commit is `978645e7df6dd67a5cc774c4eabef1ad162e2469`, directly
on the original PR head; its classifier is unchanged. In a disposable checkout with
the existing dependencies available, run this command at that red commit and then
at the correction PR's head:

```sh
./node_modules/.bin/vitest run tools/test/claude-qualification-704.test.js \
  --maxWorkers=1 --testNamePattern='review correction'
```

Red: 38 failed, 31 passed, 140 skipped. This includes newly rejected false completions
and explicit diagnostics for missing labels already rejected by the merged assessor.
Green: 69 passed, 140 skipped. The whole file passes 209 tests. The existing 12-file
regression command above passes 635 tests with no skips. Scoped ESLint, Prettier,
JavaScript syntax and document-link/text checks plus `git diff --check` pass.
These correction checks used Node 24.19.0 and the preinstalled Vitest 5.0.2,
directly through `node_modules/.bin`; no dependency installation was needed.
Full-suite/coverage, build, app smoke and installed/provider runs were not performed.

### Limitations and what the installed experiment still needs

- Everything above runs on synthetic or hypothetical rows. No installed Claude
  behaviour was observed, and the installed record is still `NONE` (`NO-EVIDENCE`).
- Row authenticity is not established anywhere. Even a perfect supplied record stops at
  `EXPERIMENT-COMPLETE-PROVENANCE-UNVERIFIED`. Reaching a verified tier needs a
  separately designed and reviewed mechanism (for example protected-owner custody of
  the counter and hook transport) that this follow-up does not invent.
- Version and tool identity are checked against the candidate pins in the run header.
  They are not checked against installed artifacts, which remain unknown.
- `classifyProvenance`/`installedFact` and `assess` keep their merged behaviour and
  must not be used alone as acceptance.
- The installed experiment still needs every prerequisite listed above, each under its
  own authorization. It must also record per-call independent `effect-check`
  readings and emit the experiment envelope.
