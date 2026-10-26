# Independent review of #742 at `6f208db` — #706

> **Historical review, followed by Cal reconciliation.** The original Claude-authored
> review below is preserved verbatim from PR #744 head
> `328174064d416623364fdb19d08505215f3ae89e`, including its observations, severity
> labels, pinned baseline and reported runs. Those labels are historical assertions,
> not the current disposition. In particular, the failed-required-judge bypass was
> **not demonstrated** by that probe. Read the [Cal reconciliation](#cal-reconciliation-2026-10-26)
> for current conclusions. Claude has not approved this reconciliation.

Reviewer role: independent, non-producing review for #706. This is not an approval or
merge decision, and not acceptance of any installed, provider or production path. The
integration owner (Cal) keeps those decisions. Full installed bootstrap and connected
replay, optional module resolution, all effects and trace/runtime limits stay with the
active external observer. This note does not reproduce or replace that work.

## Pinned commits

| Item | SHA |
| --- | --- |
| Reviewed PR head (pinned) | `6f208db363ec5091b42e2e2590fc10c7dbeb025d` |
| PR base / handoff main | `46ce182308e8d5b59c4fdbabd49232b4cf4cdbdc` (verified merge-base) |
| Main after #742 merged (during this review) | `aeb4ffb0e60fb4b553c70af3a4308b8b24a231d1` |

#742 was merged while this review was in progress. The merge commit `aeb4ffb` has
parents `46ce182` and `6f208db`, and its tree is byte-identical to `6f208db` (tree
`fabd390f…`; `git diff 6f208db aeb4ffb` is empty). Every finding below was produced
against `6f208db` and therefore applies unchanged to `aeb4ffb`. No later-head review of
any other commit was performed, and no approval is carried forward.

Prior reviews on the PR (two COMMENTED reviews at `6f208db`) were source-only and said
they did not execute code. This review executed code. Hosted CI `check (node 24)` was
green at `6f208db` (run 40349371399). It was read only and not re-run.

## Severity-ordered findings

"Observed" means reproduced by running code here. "Code-read" means established by
source inspection only. "Hypothesis" means not executed.

### 1. High (observed). A failed required execution judge can become a stored allow rule

- **Where:** `packages/daemon/src/protected-scoped-permission-owner.ts:176,194,431-434,458-463,622-624`;
  `packages/daemon/src/scoped-permission-bridge.ts:167`;
  `packages/agents/src/scoped-permission-capture.ts:41,49-52`.
- **Trigger:** a capture port whose `snapshot()` reports
  `review: { result: "failed" }` together with `persistenceReview: { result: "passed" }`,
  and which implements `verifyPersistenceReview`.
- **Observed result:** Save was accepted. The protected record stored
  `requiredReview: "failed"`, the sidecar published an `approved` rule, and the later
  fresh automatic invocation was authorized by that rule and performed a physical read.
  Phases were save → human-read → rule-read, with reads in human-read and rule-read.
- **Consequence:** the Save gate in production daemon source no longer depends on the
  required judge passing. The owner never checks persistence authority itself; it
  delegates entirely to an optional port callable. That callable receives only
  `(action, sourceRefs)`, never the reviewer identity, the operator actor, the binding
  or the execution-review outcome. So the owner cannot enforce:
  - that the reviewer is distinct from the operator;
  - that the reviewer is current and holds the permission;
  - that the attestation covers a *failed* rather than an *unavailable* judge.

  In #742 those properties hold only in test code
  (`packages/cli/test/controlled-owned-read-producer.ts:211-236,324-340`). #706 states
  that "a failed required judge cannot silently become optional". This path is recorded,
  but nothing in the owner itself prevents it. It is currently inactive: no production
  importer exists (see the guard test below).
- **Minimal reproduction (probe, not committed):** in
  `controlled-owned-read-producer.ts`, change the non-automatic return of
  `captures.snapshot` to
  `{ ...original, review: { result: "failed", sourceRefs: ["probe:judge-failed"] }, persistenceReview: … }`
  and run the positive connected lane. Save is accepted and the rule-read completes.
  #742's suite has no `failed` case at all; only `unavailable` is exercised.
- **Recommended owner action:**
  1. Make the owner refuse Save when `requiredReview === "failed"`, or require a
     distinct override record that the owner authenticates itself.
  2. Pass reviewer/actor identity into `verifyPersistenceReview` so the owner can
     enforce reviewer ≠ operator and reviewer currency.
  3. Add a failing-before regression.

  This must be decided before any activation, and should be decided before more
  composition builds on this contract.

### 2. High, test validity (observed). The `revoke-rule` fault never revokes the rule

- **Where:** `controlled-owned-read-producer.ts:779-826`, specifically
  `readAuthorityRevision` at `:806`.
- **Trigger:** `fault: "revoke-rule"`.
- **Observed result:** `policy.revokeScopedRule` throws
  `typed policy transition pending or owner unavailable`
  (`packages/agents/src/typed-sidecar.ts:308`). The cause is that
  `owner.readCaptureFacts` re-reads the sidecar inside the strict policy write lock.
  The sidecar rule stays `approved`. The test "refuses revoke-rule without an extra
  read" passes on that exception, so no revoked rule is ever evaluated.
- **Consequence:** the claim "revoked actor/rule" coverage (producer contract `:196`,
  PR body) is unproven for the connected lane. Separately, a code-read observation: the
  protected owner offers no revocation grant authority of its own.
- **Recommended owner action:** supply revocation authority whose
  `readAuthorityRevision` does not re-enter the sidecar read (for example, lease and
  credential facts only, like the owner's `readAuthorityRevision`). Then remove `.fails`
  from the reproduction in `controlled-owned-read-review.test.ts`.

### 3. Medium (observed). `wrong-interval` is refused by the harness, not the service

- **Where:** `controlled-owned-read-producer.ts:836`, where `interval(captureOffset, length)`
  runs before `service.capture`; the service gate is `packages/engine/src/owned-file-read-service.ts:298`.
- **Observed result:** the AssertionError `3 !== 2` comes from the producer's own
  pre-check. The service's `controlledSupervisor.assertInterval` refusal is never reached
  by #742's tests.
- **Consequence:** contract `:37-38` says "Both connected captures enforce this interval
  independently of rule matching", but no test checked the service gate.
- **Resolution here:** `packages/engine/test/owned-file-read-controlled-supervisor.test.ts`
  now exercises the service gate directly. Mutation-checked: deleting line 298 fails it.

### 4. Medium (observed). The coverage label is derived from a callable, not from observation

- **Where:** `owned-file-read-service.ts:190-194`.
- **What it does:** supplying any `controlledSupervisor` sets
  `level: "verified-per-execution"`, `independentlyObservedEffects: true` and
  `installedRefs: [installedEvidenceRef]`.
- **What backs it in the local suite:**
  - the ref is a digest of the *bootstrap run's* authorization payload, which lives in a
    different temporary run base;
  - the only "observation" is an in-process `vi.spyOn(fs.readSync)`.
- **Observed result:** this label is persisted into the protected Save record and
  satisfies the owner's `verified()` gate.
- **Consequence:** the records read as if independent effect observation occurred. #742
  discloses that local interception is test evidence, but the persisted record does not.
- **Recommended owner action:** use a distinct evidence marker for test-supervised
  coverage, or record explicitly that this lane's persisted coverage is not evidence. The
  observer must not treat it as such.

### 5. Medium (code-read). The persistence "review" is self-issued by the runner

- **Where:** `controlled-owned-read-producer.ts:702` (`attest` directly after `require-human`)
  and `:493`.
- **What happens:** the reviewer makes no decision. The reviewer's token is authenticated
  once at issuance and never used to sign anything.
- **What "authenticated" means here:** the same process's execution-store AEAD, plus a
  check that the reviewer credential is current.
- **Consequence:** this is acceptable as a disclosed designated assumption. The wording
  "authenticated persistence attestation / persistence review" should not be read as an
  independent reviewer's approval. Combined with finding 1, the owner has no way to tell
  the difference.

### 6. Low–Medium (code-read; observed record content). Judge and persistence provenance are flattened downstream

- **Where:** `protected-scoped-permission-owner.ts:823`.
- **What happens:** `qualify` concatenates execution-judge refs and persistence refs into
  one `sourceRefs` list and drops `requiredReview`. `inspectRule` projects no review
  outcome.
- **Observed:** the protected Save record does keep
  `requiredReview: "unavailable"` and `reviewSourceRefs: []`. The persistence attestation
  also keeps `executionReview: { result: "unavailable" }`. In the finding 1 probe, the
  failed-judge ref `probe:judge-failed` would flow into qualification `sourceRefs`
  untyped.
- **Consequence (hypothesis):** future audit or UI consumers cannot tell "judge passed"
  apart from "judge failed or unavailable, plus a persistence attestation". #706 requires
  exposing the authorizer and execution-unknown states.
- **Recommended owner action:** typed provenance (`{ executionReview, persistenceReview }`).

### 7. Low (observed). Fault tests do not pin where a refusal happens

- **Where:** `packages/cli/test/controlled-owned-read.test.ts:214-221`.
- **What happens:** each fault case asserts only `rejects.toThrow()`, so any exception
  passes. Findings 2 and 3 are this weakness in practice.
- **Observed refusal origins:**

  | Fault | Refused at |
  | --- | --- |
  | review-proof | protected review (prepare) in the save phase, `CONFIG_STALE` |
  | reviewer-revoked | same as review-proof |
  | stale-revision | review in human-read, `CONFIG_STALE` |
  | cancel | review in human-read, `CONFIG_STALE` |
  | lost-ack | bridge outcome `uncertain` |
  | revoke-rule | fixture exception (finding 2) |
  | wrong-interval | harness pre-check (finding 3) |

- **Untested window:** the contract says the attestation is checked "at prepare, Save,
  final publication and saved-proof lookup". Prepare and post-Save lookup are exercised.
  Revocation between `review` and `choose` is not.

### 8. Low (code-read). `assertPersistenceCurrent()` return values are ignored

- **Where:** `protected-scoped-permission-owner.ts:433,462,833`.
- **What happens:** the return value is discarded. Every other currentness port in this
  file, and the typed-sidecar consumer, check `!== undefined`.
- **Consequence:** the type prevents this today, but a JS port returning `false` would
  pass. Use the same `!== undefined` pattern.

### 9. Low (hypothesis). Child framing never checks for trailing command bytes

- **Where:** `tools/owned-read-proof/controlled-child.mjs:93`.
- **What happens:** the child reads exactly one command per phase and never checks for
  trailing or duplicate bytes after the last phase, or for EOF. The contract says
  unexpected input refuses.
- **Owner:** framing acceptance belongs to the observer. The parent owns the pipe.

### 10. Info (observed, pre-existing). Disclosure and storage scan

- No raw tokens, content bytes or paths in public journal markers.
- `human.answered` carries a `credentialId` (pre-existing).
- The plaintext sidecar rule `match` holds the service temp directory and an inode
  stamp (`effectiveCwd`, `physicalTargetRef`). This comes from existing `matchFor`; it
  is not new in #742.
- Semantic records are encrypted under `private-execution`.

## Requirement-to-evidence matrix

| Requirement | Evidence at `6f208db` | Status |
| --- | --- | --- |
| Save produces no resource read or live answer | New test: at the end of the save phase, 1 approval, 0 `human.answered`, 0 authorization/observation/ack records, 0 reads | Verified locally |
| Persistence review keeps failed/unavailable judge provenance | Protected record keeps `unavailable`/`[]` (new test). Downstream `qualify` flattens it (finding 6). A *failed* judge is overridden into Save (finding 1) | Partially met; blocker at owner |
| Original human authority ≠ fresh automatic rule authority | Records: `authorizedBy.kind` human (`acceptedAnswerRef` = the `human.answered` event) vs rule (`ruleId`/`ruleRevision`), different invocation IDs | Verified locally |
| Automatic capture cannot acquire a live target | Code-read: automatic snapshot omits `target`; `prepare` requires `same(source.target, target)`; `completeHumanDelivery` rejects (producer `:857`). No external seam reaches a review on the automatic identity | Code-read only |
| Revoked reviewer/operator credentials | Refused at prepare (save phase) and after Save. Reviewer currency enforced only by the test port (finding 1) | Verified (test port) |
| Stale policy / lease / revision | Existing post-Save policy and lease tests; stale-revision refused at review | Verified locally |
| Tampered protected records | Persistence record (existing); Save approval record before rule-read (new test: rule-read refused at policy verdict, delivered answer unaffected) | Verified locally |
| Wrong resource/interval | Service gate unexercised by #742 (finding 3); new engine test covers it | Now covered |
| Cancellation | Refused at review in human-read, 0 reads | Verified locally |
| Late/duplicate delivery, lost acknowledgement | Deferred-ack tests; new lost-ack test: durable answer = 1, 0 authorization/observation/ack, 0 reads, bridge `uncertain` | Verified locally |
| Final synchronous currentness | Engine dispatch refuses after supervisor loss (new engine test, mutation-checked); producer sidecar/lease/seal rechecks (existing) | Verified locally |
| Rule revocation | Fixture never revokes (finding 2) | **Not demonstrated** |
| Default service stays unqualified | New engine test: `policy-per-ask`, empty refs, `false` beside a supervised instance | Verified |
| No production export/mount broadening | New guard test (main-compatible): no barrel exposes the seams; no production import of the producer/tools/inactive trio; test services type-only outside their set. Mutation-checked. `ACCEPTED_MANAGED_TYPED_BUILDS` stays `[]` (existing) | Verified |
| Supervisor authority cannot arrive through wire/config | New engine test: JSON round-trip, string callables, empty ref and non-`undefined` returns all refuse before filesystem work | Verified |
| Recording / delivery / dispatch / effect kept separate | Separate record kinds checked per phase (new tests). Effect "observation" is in-process interception only | Local only, not independent |
| Installed confinement, connected replay, trace/time limits | Not run here: observer-owned (`controlled-owned-read-observer-contract.md`); the producer contract says it is pending | Not available |

## Commands and results (Node v24.21.0, pnpm 12.4.2, Linux)

All results below were observed in this session.

- `pnpm install --frozen-lockfile`: no lockfile change.
- `vitest run packages/cli/test/controlled-owned-read.test.ts` at `6f208db`:
  **19 passed**. The positive case took 13.3 s on its own.
- Adjacent suites at `6f208db`: 11 files, **368 passed**.
  - engine: `owned-file-read-{delivery-ack,human-delivery,revocation,service}`,
    `synthetic-read-fence`
  - daemon: `scoped-permission-bridge`
  - cli: `protected-scoped-permission-owner`, `owned-read-live-integration`
  - agents: `typed-sidecar`, `strict-permission{,-source}`
- PR test plus the two branch-dependent new files together at `6f208db`: 3 files,
  **28 passed, 1 expected-fail** (the finding 2 reproduction).
- New guard test: **2 passed** on `46ce182` and on `6f208db`.
- Mutation checks, all reverted afterwards: each fails the intended test.
  - service line 298 removed;
  - supervisor `assertCurrent` removed from `current()`;
  - an injected production value import.
- `tsc -p tsconfig.json --noEmit`: pass. Changed-file `eslint` and `prettier`: pass.
- Not run: full repository suite, desktop/app smoke, installed child/strace replay.

At merged main `aeb4ffb`, the same 11 adjacent files, #742's own file and all three
new files ran together: 15 files, **398 passed, 1 expected-fail**, exit 0.

## New regression files (tests only)

- `packages/engine/test/owned-file-read-controlled-supervisor.test.ts`: covers the
  service interval gate, dispatch after supervisor loss, wire/config refusal and the
  unqualified default.
- `packages/cli/test/controlled-owned-read-review.test.ts`: reuses the #742 supervisor
  fixture unchanged and covers:
  - Save-phase separation and provenance;
  - lost-ack separation;
  - refusal origin at prepare;
  - a tampered Save approval;
  - an `it.fails` reproduction of finding 2.
- `packages/daemon/test/inactive-owned-read-mount-guard.test.ts`: barrel and production
  import-graph guard.

## Bounded verdict

At `6f208db` (identical to main `aeb4ffb`), the inactive controlled composition does what
its positive test claims locally:
- Save yields no read and no answer;
- the delivered human answer and the fresh rule authorization stay distinct;
- lost/deferred acknowledgements, stale facts, tampering and cancellation fail closed.

The default service stays unqualified, and nothing is exported or mounted.

Two items are not established:
- **Finding 1:** the production owner/bridge now accepts Save after a *failed* required
  judge, with persistence authority delegated entirely to an optional port. This blocks
  any activation and should be resolved or explicitly ratified before more composition
  depends on it.
- **Finding 2:** rule revocation was never actually demonstrated.

Findings 3–4 overstate evidence rather than authority. Nothing here is installed,
provider or production acceptance.


## Cal reconciliation (2026-10-26)

Author: Cal (`calciferschadewitz`). This addendum reconciles the original review;
it does not replace the independent reviewer or attribute these conclusions to Claude.
Source triage: [Cal review 5655430813](https://github.com/cschadewitz/Project_Orca/pull/744#pullrequestreview-5655430813).
Original #744 head: `328174064d416623364fdb19d08505215f3ae89e`.
Current main at handoff: `843e2d523a6b51180149eaa8083400321c5a9229`.
Locally reviewed dependency: #749 `6cbb946f378adeb591adb6341077fc0fd193348c`;
parent integration and final dependency pin remain separate publication gates.

### Current disposition

| Historical finding | Cal disposition |
| --- | --- |
| 1: High failed-required-judge bypass | **Not demonstrated.** The probe changes trusted capture snapshot metadata to `failed`; the actual producer has no configured execution judge, and its separate authenticated persistence attestation retains execution review `unavailable`. This is a contract-consistency/hardening question, not evidence of bypassing a real failed required judge. |
| 2: revoke-rule fixture bug | **Confirmed.** The original sidecar write-lock re-entry prevents revocation and leaves the rule approved. #749 owns the producer correction and canonical ordinary regression; this companion checks the corrected persisted state and exact refusal independently. |
| 3: service interval coverage | **Useful direct coverage retained.** #749 carries the same four engine tests byte-for-byte; integration retains a single file, not duplicate additions. |
| 4–5: callable authority / local interception / persistence attestation | **Disclosed test assumptions.** These establish local composition behavior only. The `test-supervisor-bootstrap:` provenance must remain test-designated and must not become external qualification or an independent human approval. |
| 6: downstream review provenance | The protected Save record and persistence attestation retain unavailable execution review separately. Future downstream provenance presentation remains a bounded hardening question; flattening refs does not prove an execution-judge bypass. |
| 7: broad fault exceptions | The revocation regression must be ordinary and specific. Bootstrap/setup errors, unexpected policy results and unrelated fixture failures must fail it. Other useful phase-specific companion assertions are retained. |
| 8–10: return values, child framing, disclosure/storage | Preserved as the original bounded observations/hypotheses. This reconciliation makes no new runtime change or installed acceptance claim. |

Persistence review is intentionally distinct from execution judgment. The trusted capture
verifier resolves reviewer, actor and binding from protected references and checks their
currency; this probe does not show that additional identity parameters are necessary.
Canonical execution-policy and permit checks remain separate. No runtime semantics are
changed here. Pending narrow follow-up #750 at
`34893c37ec32cc56f1d9f27e131ba38d1d76dc36` tests actual bound required-judge
not-fit/unavailable completion versus separate persistence authority. Its owner reports
49 tests passing; Cal has not rerun those checks here and source review is pending.
That proof concerns configured rule delegation, not protected Save acceptance or a
global mandatory-judge profile ceiling. It does not resolve every policy-design question.

The corrected revocation expectation is precise: a persisted revoked rule with changed
policy and rule revisions, completed Save and human-read phases, entry into rule-read,
and one fresh final `indeterminate` / `required-policy-unavailable` evaluation bound to
the revoked policy revision. This is qualification unavailability after verified
revocation; it is not evidence of a direct revoked-rule deny verdict. There must be
exactly the prior human answer, human authorization and physical read, and no subsequent
rule authorization or read. Protected revocation evidence must decode and match the
persisted rule. An unrelated exception cannot satisfy these requirements.

Save/no-answer/no-read, lost-ack, tampered approval, inactive-export and direct service
interval/currentness tests remain useful. Independent observer acceptance, installed
confinement and production activation remain pending outside this companion. The PR
stays draft for parent integration; no merge approval is implied.

### Reconciliation validation

Cal ran the following locally with Node v24.19.0 and the preinstalled binaries
(Vitest 5.0.2, TypeScript 7.0.2, ESLint 10.11.0, Prettier 3.9.9). These are actual
local versions, not a claim to have reproduced the pinned hosted toolchain.

| Target | Actual result |
| --- | --- |
| Original #744 `328174064d416623364fdb19d08505215f3ae89e`, four focused files | 30 passed, 1 expected-fail; exit 0 |
| Integrated `30c7aa30152b9fa3d24d27e6b56c8aae46e72033`, based on main `843e2d523a6b51180149eaa8083400321c5a9229` plus reviewed #749 `6cbb946f378adeb591adb6341077fc0fd193348c` | 15 files, 401 passed; no expected-fails; exit 0 |
| Root `tsc -p tsconfig.json --noEmit` | Passed after restoring the missing untracked app `node_modules/yaml` link to the already installed 2.9.1 package; no manifest/lockfile edits |
| ESLint and Prettier on all three companion test files | Passed |
| Diff whitespace, document encoding/fences, historical-text comparison | Passed; original review body retained verbatim |

The integrated run includes the four focused files plus the same 11 adjacent
engine/daemon/cli/agents suites listed in the historical commands section. The four
engine tests are identical to #749's additions and exist once. The new ordinary
companion regression requires the specific persisted revocation, protected proof,
policy result and sole prior human authorization/read described above.

The initial `pnpm exec` attempted an automatic dependency install and failed before
running tests (`ENOENT` creating `/home/agent/.local/share/pnpm`). Cal used the existing
`node_modules/.bin` tools directly. The initial root typecheck reported the missing
app `yaml` link; the corrected local installation passed. These setup failures are not
test results. No tracked dependency changes were made.

Historical commands and counts above remain the original reviewer's reported results,
not Cal reruns. The integrated count is focused/adjacent proof only: full suite,
coverage, build, renderer typecheck, desktop/app smoke, installed replay and external
observer acceptance were not run here. The implementation came unchanged from the
reviewed dependency; Cal's authored changes are the review note and companion test.
