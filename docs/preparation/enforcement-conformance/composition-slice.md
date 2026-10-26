# #706 composed disposable-memory acceptance slice

This slice executes the actual inactive strict policy, bounded local judge and
owned read fence together. It follows the parent-agreed repair to two fail-closed
composition gaps: unqualified string-path capture could not match strict policy,
and completed delegated reviews could not reach fence revalidation. No unsafe
execution was demonstrated by those earlier gaps. #706 and its broader acceptance
obligations remain open. This slice uses `Refs #706` and closes no broad issue.

## Scope and dependency pins

The preparation branch integrates main
`1538d34b02eeb6ecbfeeea1464dd26f6fab85b9b`, including merged #717 policy
`d2c8625b79aff218280688304abd22a74dd973c0`, and the exact reviewed #719 fence
head `7252d22d85e83187fdb5fe036fd918b54e3f3b2f` as an explicit dependency.
Canonical types and the judge were already integrated through #716/#718.
The parent authorized the additive resource amendment and this single-owner
repair after independent architecture/policy review. The parent retains final
review and merge ownership. The draft must explicitly include #719's dependency
and coordinate whether #719 is merged first or superseded by the combined branch;
no automatic merge or closing keyword is appropriate.

Repository AGENTS.md, development/architecture guidance and the relevant contract
were read. No `.agents/skills` files were present in the checkout or
`/workspace/.agents`. Normal pinned frozen setup was rerun after integrating
#720 dependency inputs. The current-main lock, supply-chain policy, allowlisted
lifecycle hooks and sandbox settings are preserved.

## Canonical resources and actual private memory

`ActionResourceV1` is declared once in core and reused by action evidence and
approved rule predicates through the existing re-export. Existing physical
entries retain `operation` and `physicalTargetRef`. The additive alternative
requires `targetKind: disposable-memory`, `ownerRef`, `resourceRef` and
`resourceRevision`. Mutually exclusive fields reject mixed shapes at compile
time. Runtime validation rejects mixed/unknown kinds, empty/missing identities,
hidden/accessor fields and cross-kind matches. All memory identity fields and
operation must match exactly; missing fields cannot match one another.
Resource-kind support supplies no authority or coverage qualification.

`DisposableMemoryReadOwner` is unexported by the package barrel and has no
production registration. It privately retains a bounded immutable cell and
opaque capture handles in a WeakMap. Exact structured parameters identify one
cell; no raw JSON is parsed, so raw duplicate-key validation is truthfully
inapplicable for this profile. The registered codec retains owner identity,
generation and resource identity/revision before any await. Only the original
registered executor/owner pair can supply memory capture facts. Copies, public
references and forged/serialized handles cannot reconstruct the capability.
Execution reads the retained private cell, never `AgentHost.fs` or a string path.

Each owner gets a fresh lifetime identity. A bigint generation never repeats;
every policy, human ceiling, profile, authority, model/config/projection,
coverage, cwd/workspace, resource or availability replacement synchronously
replaces immutable snapshots and advances generation. Restoring old values or
availability also advances it. Cell replacement issues a never-repeated resource
revision even when its name and content return. Callers cannot choose a revision
or mutate backing snapshots. In-flight reads receive immutable snapshots, and
an old snapshot cannot defeat the final synchronous owner-generation check.

The separate `orca-disposable-memory-read-v1` profile retains every required fact
and requires a nonempty exact memory resource. Its actual registered in-process
boundary is labeled `policy-per-ask`, with explicit synthetic hook/configuration
qualification, no installed references and no installed independent-observation
claim. No existing physical/provider profile is weakened or relabeled. Generic
string-path capture retains unknown resources and observation coverage and cannot
inherit this qualification.

## Retained decisions and final dispatch

`PolicyPortV1` is unchanged. Strict policy retains completed review against the
original action object and a deep immutable full action/source snapshot, original
request, rule/delegation/config/projection, normalized result, acknowledged record
reference and deadline. Reevaluation of that exact object reruns current strict
preflight and eligibility before returning its frozen settled verdict. It never
rejudges, rerecords or extends the deadline. Changed/unavailable state, mutation,
original cancellation or expiry leaves a terminal marker; restoring values cannot
reopen the object. Copies receive no retained completion. Active review states and
source reads are bounded separately; uncooperative in-flight work keeps its
reservation until settlement. Weak terminal markers retain no full review snapshot.
Ordinary final evaluation still works when completed-review capacity is full.

A peer-reviewed microtask race was reproduced and repaired in #722: bind now
rechecks status after both eligibility awaits before authorizing projection or
installing a bound handle, and completion checks terminal state before recording.
Three deterministic regressions preserve permanent invalidation through those gaps.
The failing-before evidence and limits are retained in the validation document.

The fence owns its pending and bound handles and installs only its registered
policy's completed verdict. Manufactured/copied actions or verdicts do not mint
permits. Completion cannot reset one-use/dispatch state. Authorization recording
is followed by full current policy revalidation. After the last await,
`owner.assertCurrent` checks the original lifetime, monotonic generation,
capability, qualification and resource revision, immediately followed by consume
and executor entry without an await. This establishes same-process disposable
memory behavior only; equal verdicts and resolved Promises alone provide no
atomicity.

## Executed subsets of the #707 matrix

The original [52-case symbolic corpus](corpus.v1.json) is preserved unchanged with
historical `not-run` statuses. The following table maps executable subsets to
stable IDs; it does not mark every original variation or provider path passed.
Actual tests are in
[`composed-memory-guard.test.ts`](../../../packages/engine/test/composed-memory-guard.test.ts),
with reusable fixture
[`composed-memory-guard.ts`](../../../packages/engine/test/fixtures/composed-memory-guard.ts).
Canonical resource negatives live in
[`strict-resource.test.ts`](../../../packages/agents/test/strict-resource.test.ts).

| Stable corpus IDs | Executed disposable-memory subset |
| --- | --- |
| `E706-disabled`, `E706-advisory`, `E706-rule-revocation` | Matching approved automatic rule; disabled/required/advisory modes; deterministic deny/human ceilings above advice; advisory unavailable fallback distinct from evaluated not-fit/abstention; revoke during waits |
| `E706-required-timeout`, `E706-checker-outage`, `E706-malformed`, `E706-malformed-checker`, `E706-contradictory` | Required timeout/unavailable/malformed/oversized/contradictory local frames; late fit cannot reopen or dispatch; normalized binding/projection/config substitution refuses completion |
| `E706-model-config-change`, `E706-policy-epoch`, `E706-authority-race`, `E706-policy-outage`, `E706-hook-tamper` | Rule/human/profile/policy/authority/projection/model-config/coverage/resource/cwd/availability replacement across judge, review-record and authorization-record barriers; down/up and restored values retain a new generation |
| `E706-final-arguments`, `E706-final-cwd`, `E706-final-resources` | Changed exact cell parameters, cwd and same-name cell replacement; no revision reuse on restored contents; default string-path and copied capabilities remain unqualified |
| `E706-identical-concurrent`, `E706-duplicate-answer` | Concurrent completion claims once; simultaneous dispatches share one consumed permit/receipt; exactly one authorization write, executor entry and observed read |
| `E706-expiry`, `E706-cancel-before-dispatch`, `E706-cancel-after-dispatch`, `E706-owner-death`, `E706-restart` | Original expiry/cancellation during judgment; caller/owner loss after a read preserves execution-unknown; replacement owner cannot inherit old permit/capture; no durable restart claim |
| `E706-uncertain-record`, `E706-unknown-effect`, `E706-lost-delivery-ack` | Review or authorization append may persist without acknowledgement; response loss after read; delivery remains unknown without separate callback acknowledgement; terminal no-replay |

Additional targeted cases saturate completed-review source reads, race concurrent
reevaluations with cancellation/invalidation, and stall an old source snapshot
through post-record revalidation. The latter independently proves zero executor
entries/reads despite identical stale advice returning after generation changes.
Compile/runtime resource tests cover mixed, malformed, hidden/accessor,
cross-owner/revision/kind and missing identities; empty memory evidence refuses.

The fake transport uses the actual bounded judge adapter and approved synthetic
payloads. No method, provider or network model executes. Model replacement tests
change immutable identity/config references, not real model behavior. Each
mutation barrier test attempts the full composed execution pipeline.

## Recording, delivery, dispatch and effect

The fixture reuses the existing in-memory execution and lease stores. Protected
payload adapters record normalized reviews and authorization separately. Distinct
counters track judge calls, review writes/acknowledgements, authorization writes,
fake response attempts/acknowledgements, executor entries and actual private-cell
reads. The read device increments its own count independently of fence receipts.
Protected observation records originate from those separate seams.

A recorded decision is not callback delivery or an external effect. `completed`
means the executor promise settled; delivery remains unknown until the separate
fake callback acknowledges. Uncertain review/auth records never reopen a permit.
A lost response or cancellation after reading retains the observed synthetic read
and execution-unknown without retry. Receipt inspection never infers an absent
observation or replays the operation.

## Unexecuted scope and verification

All original cases/variations outside the named subsets remain unexecuted here.
`E706-native-filesystem`, `E706-native-shell`, `E706-interactive-stdin`,
`E706-descendant`, `E706-alternate-mcp`, `E706-client-filesystem`,
`E706-client-terminal` and `E706-remote-custom` remain unsupported and unexecuted.
There is no physical/symlink/rename confinement, installed-provider/native cached
grant, durable recovery, cross-process atomicity or exactly-once claim. #594's
actual-Cal/installed acceptance and #449 containment gates remain separate.
Privacy canaries and private synthetic records do not establish production secret
handling, safe UI/audit projection or retention acceptance.

No production wiring, persisted rule writer, hook installation, credentials or
access change, live provider/network call, signing, activation, deployment,
release, upstream contact or paid benchmark was added. The test-only seeded rule
is not a persisted rule write. The full #706 scope remains open.

Reproducible validation and exact limits are in
[composition-validation.md](composition-validation.md).
