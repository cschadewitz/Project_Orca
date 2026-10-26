# Protected scoped review integration checkpoint — Refs #702 / #706

This unregistered integration builds on green main
`a4ae53d1d5a8d7945f5c6782da46c833accdb29d`, published managed owner #732
`ba39c77aa98d2776a3d63a807f245539f0fddd9c` and scoped bridge #733
`c94826f0c81e180db384ece1d0347f6a05397e65`. The two unmerged dependencies were
incorporated by ordinary merge. After independent source review, parent authorized
the separately owned publication mode correction
`eea39555913e57f996d704bf738408f1962e4b93`. It was merged without conflict into runtime
head `48ce0d25041eed30417d8412961090533be98018`; only the reviewed private/exclusive
temporary publication, evidence preservation, regression tests and documentation
were incorporated. Parent subsequently approved merged main
`653dbcae1017bc6565b631f3a492b4908ce17f0b`, containing only #737's reviewed
initial fixture-port admission correction. It was incorporated by a second
conflict-free, non-force merge at `4c9c1c243aa8897f4e7de23949220551601944a9`.
That reviewed fixture is the only inherited app-test change. This slice edits no
wrapper or app runtime/coverage-test source. Lockfiles, accepted production builds
and production registration remain unchanged.

Parent subsequently supplied #734
`c12a2a2aaf5f1f8383aa8a3582d5b4d2dafc4801`. Its actual service source and
`docs/preparation/tool-execution-guards/owned-read-service-703.md` were inspected
without incorporating its branch. The handoff below follows its real facade.

## Canonical provider and lifetime

`packages/agents/src/managed-typed-store.ts` owns the shared internal provider and
opaque binding. `createInactiveTypedSidecarStore` returns one canonical store per
original owner capability. The managed CLI owner retains its enrolled token/store
instead of manufacturing one on each access. Initialization still requires its
separate pending-enrollment capability. A newly constructed managed owner receives
a different binding/store even if it observes identical policy bytes and revision.

Only identity is cached. Every provider invocation checks the original retained
root/enrollment/lifetime/build assertions again. Every store method continues its
fresh filesystem, compatibility and publication checks. Provider access does not
attempt an unlocked sidecar read while its original writer holds the typed lock.
It checks compatibility; the requested store operation checks the actual bytes.
No marker parser constructs a provider or establishes ownership. There is no
daemon-to-CLI source dependency, RPC constructor, flag or environment enablement.

The daemon bridge retains its first exact binding/store/workspace identity for the
whole method table. It rechecks the provider across asynchronous phases and before
returning a response, and synchronously asserts the original binding before final
publication. Replacing it with a same-byte owner is refused. A confirmed Save
retires that handle for further choices; a separate answer needs a fresh review.
An uncertain write, append, delivery or refresh is never automatically retried.

## Actual capture contract and policy revision boundary

`packages/agents/src/scoped-permission-capture.ts` defines the internal producer
handoff. It supplies no factory and cannot turn action JSON into a capture.

1. Before capturing immutable action authority, the real executor producer reads
   `protectedScopedPermissionOwner.readCaptureFacts(originalActor)`. This reads the
   canonical sidecar byte revision and current credential/lease facts. The authority
   revision binds the original workspace/root/enrollment, current credential
   permissions/scope/expiry, and exact held lease incarnation. Hashes here are private
   consistency stamps, never public references or authority capabilities.
2. The producer retains the exact action, input target, original credential actor,
   canonical binding/workspace, actual review outcome/provenance and original captured ceilings.
   `read` resolves that existing input capture; `forAction` supports automatic policy
   reads without requiring a review dialog. `snapshot` and `assertCurrent` resolve
   the original owner-local capability. A fresh lookup must not trust client proof.
3. Required coverage and choices must come from that actual producer. In particular,
   the existing disposable file fence is policy-per-ask, has no installed refs and
   emits no offered native choices. It is not eligible for Save. Nothing in this
   integration promotes it to verified-per-execution or invents observed evidence.
4. On confirmed publication, `policyChanged` retires every old unconsumed decision
   and permit before creating a fresh attempt under the original invocation and
   captured ceilings. It must refuse a started/uncertain dispatch. The new action
   captures the new policy byte revision. It must not mutate immutable action
   authority, rebuild a callback from disk or resend an uncertain effect. The next
   review/qualification verifies the new stamp against another actual store read.

The adapter independently retains the original invocation and captured generation
for an input, retires its old review handles, and prohibits another Save after a
successful write. An uncertain Save blocks fresh attempts for that input, including
through another review handle. The engine remains responsible for retiring its
actual decision/permit capabilities and preserving its immutable captured ceilings.

The missing producer is a real boundary, not a constant revision or adapter
workaround. The bounded repeated-read service owner must implement and prove this
handoff before positive Save/read acceptance can be claimed. `policyChanged` has no
default implementation. A failed handoff leaves a historical saved rule inspectable
but does not revive the original attempt or turn a lost acknowledgement into retry.

The actual #734 operation is `service.refreshPolicyRevision(invocation)`: it accepts
the original retained `TrustedOwnedReadInvocation`, only once, after an evaluated
`require-human` result and before **any** permit authorization has started. Only
`currentPolicyRevision` may change in the original snapshot. It synchronously retires
the old fence and returns a new facade/action while preserving parameters, policy,
evidence ports, expiry, original cancellation and captured ceilings. The daemon
capture owner must retain that returned facade; it must not synthesize a replacement
action or recreate service/owner/policy objects. If source eligibility, another epoch,
the binding or a ceiling changed, refresh refuses. Save cannot be used to force it.

#734's resource workspace is its real resource-local temporary-tree identity. The
capture handoff retains this separately from the managed policy workspace binding;
it never relabels immutable action evidence to make the identifiers equal. Review,
record lookup and the final qualification assertion bind both original identities
and reject replacement across awaits. The actual #734 service remains policy-per-ask,
has no installed qualification and supplies no offered native choices: it is not a
positive Save producer. Its final physical-capture assertion and authenticated live
input attachment still need a trusted capture-registry handoff, not action JSON.

Human Allow once execution remains a separate composition obligation. Canonical
`PolicyVerdictV1` already supports `authorizedBy: {kind: "human", acceptedAnswerRef}`;
no standing rule may impersonate that origin. The trusted delivery owner must prove
the exact accepted option reached the original live callback while original
invocation/lease/expiry/ceiling checks still hold before a one-use permit is issued.
A durable `human.answered` marker alone, failed/uncertain delivery, an expired turn or
restart cannot recreate that authority. This checkpoint does not implement that
human-to-execution permit handoff or claim positive acceptance for it.

## Protected approval and qualification

`packages/daemon/src/protected-scoped-permission-owner.ts` is a concrete adapter over
the existing credential store, original run lease, canonical typed store, live input
registry and protected execution/event stores. It supplies no default capture,
disclosure, installed-build or lifetime authority.

Opening a review retains an exact in-memory command/action/actor/input/revision and
performs no approval write. The destination disclosure owner approves the exact
generated command as well as the retained capture. Scope is exact, with no wildcard
or delegated authority, and expiry cannot exceed the capture's bounded lifetime.

Only an actual authorized Save enters the original lease fence, rereads actual policy bytes, rechecks original
`Authorizer.scopedRuleGrantAuthority`, requires actual passed review and
verified-per-execution coverage, and appends the existing `agent.permission` event with explicit
`scoped-rule-save-accepted` decision and protected `scopedApprovalRef`/entry through
`ProtectedEventStore`. The existing store writes an encrypted payload first and a
scrubbed public event second. The encrypted entry retains explicit Save, acceptance
time, exact observed credential permissions/scope/expiry and lease incarnation/deadline,
as well as the command/action/input/scope. Their private consistency stamps are
recomputed on lookup. This event is distinct from `human.answered` and has
no callback or execution effect. Missing protected inputs never fall back to public
plaintext. Standing publication follows approval recording within the same run
lease fence. Answering remains an independent action in the existing live registry.

Each persistence verification authenticates the retained approval and scope
record again. A protected read observation supplies both its existing asynchronous
verifier and a new synchronous final digest/identity verifier. The latter rechecks
the key, payload, inputs and sensitivity membership in bounded chunks without
rehydrating plaintext. Final publication also checks the original credential,
capture, managed binding and held lease deadline. It is not a cached authority
decision or a no-op commit assertion.

`qualify` requires an executor-retained current action, authenticates every retained
rule's approval/scope record, binds the saved rule/actor/input/previous byte revision
and original enrollment, and verifies current credentials and current invocation
facts. The typed store invokes the returned synchronous assertion after its own
last asynchronous byte/compatibility checks. Missing, corrupt, replaced or
unauthenticated evidence refuses the source. Revoked/expired rules remain retained
as tombstones and are evaluated by the existing strict policy status/time checks;
they do not grant authority. There is no new sidecar, policy ledger, queue, automatic
repair, deletion, migration or record-retention exemption. Existing protected
retention must keep the approval payload, input/key/sensitivity dependencies and
public correlation for as long as a typed record refers to them. A lookup miss does
not recreate any of those records.

## Disclosure

The adapter builds the projection from actual retained capture/record fields; the
disclosure owner cannot supply policy verdicts or effect claims. The independently
trusted destination owner approves display scope, exact projection
and allowed private-reference associations. The adapter assigns independent random
UUIDs and persists the associations inside the encrypted approval. It never encodes
or hashes raw private values into public IDs, and client input cannot supply proof.
`inspectRule` authenticates the actual current typed record and protected approval,
requires the original actor/current credential and enrollment, and returns only the
approved scope plus the existing safe decision projection. A historical Save does
not assert current execution authority, callback delivery, dispatch or effect.

## Evidence and pending gates

Setup used the saved environment's Node 24.19.0 and pinned pnpm 12.4.2, frozen install,
the existing 534-entry supply-chain check and unchanged lifecycle allowlist. Electron
download was skipped. Package-manager writable state stayed under /workspace.

The actual managed/file/auth/lease/store tests use newly created disposable roots
and synthetic user data. Accepted exact-build and inherited boot ownership are
explicit synthetic assumptions, not service-installation evidence. They exercise
fresh revision facts, wrong actor, credential revocation, broken run lease, changed
root/build/lifetime and refusal of the actual lower-coverage file fence. Separate
store tests exercise encrypted event persistence/restart, unconditional disclosure
withholding, missing proof and final synchronous payload/key/input/overlay seals.
The authenticated HTTP bridge also refuses the actual unqualified file capture
without exposing scope or writing approval. The protected owner's positive Save,
approval-reader and qualification branches have not been exercised with a real
qualified producer. Lower-level encrypted-event tests are not full Save/read proof.
Existing bridge fixtures remain explicitly synthetic approval owners; their positive
Save assertions do not prove the new protected owner or qualified producer.

Positive protected Save/read, actual capture refresh/permit retirement, exact-head
independent review/CI and managed/build/coverage gates remain pending. No runtime
composition is enabled and the accepted production build map remains empty. No live
grants, existing workspace operations, credentials/OS-security changes, provider
hooks/calls, deployment/release or Mac hardware actions occurred.

Final local validation on the published source delta:

- Root and renderer typechecks passed.
- Changed-source/test ESLint and Prettier checks, and `git diff --check`, passed.
- Full TypeScript/Vite build passed with pinned pnpm 12.4.2.
- Eight focused suites passed: 158 tests, no skips.
- Explicit CLI/ACP retry integration lane passed: two tests, no skips.
- Affected agents/daemon/CLI/store/core/protocol checkpoint passed: 2,885 tests,
  one existing opt-in skipped. Final runtime refinements received focused checks
  afterward; this is not final-head full-suite evidence.

An earlier whole-suite coverage run was interrupted while source/builds were still
changing. It reported the pinned-pnpm reporter forwarding fixture, synthetic Mac
replacement rehearsal and moved-home update fixture as well as the changed opaque
observation API's exact-key expectation. The observation test now verifies both
opaque verifiers; no unrelated app/wrapper files or coverage thresholds were edited.
That interrupted run is diagnostic only and is not global coverage acceptance.
The final exact-head full suite, coverage and CI remain parent integration gates.

## Review correction: shared permission-event metadata

Independent review reproduced a disclosure bug in the new permission-event branch:
it encrypted `entry` but copied the remaining metadata into the public log and
notifications. The shared API accepts arbitrary metadata, so the current producer's
fixed strings were insufficient protection. At runtime head
`48ce0d25041eed30417d8412961090533be98018`, all three new regression cases failed
with an actual file-backed public event containing the synthetic secret.

The correction applies the existing `redactExecutionValue` to **all** scoped
permission metadata after removing `entry`. The encrypted original remains intact;
public append results, restarted reads and subscription notifications receive the
same redacted projection. No caller-provided string or UUID-shaped reference is
restored as a privileged structural field. Only the existing internally generated
event identifiers and execution-payload correlation retain their established
structural treatment. If redaction makes a lookup field unavailable, existing exact
proof checks refuse; there is no fallback or authority inferred from redacted text.
Journal-event behavior and owner/binding/source qualification checks are unchanged.

Reproduction used `umask 0022`, newly created disposable roots, actual encrypted
execution/event stores and synthetic secrets only. The targeted before run had
three failed regressions and eight tests not selected by the name filter. After
the correction, the complete store test file passed all 11 cases, including secret
title/decision/tool-call metadata, ordinary and secret/UUID-shaped correlation
values, public notifications and exact private restoration.

The reviewed mode merge was first validated under `umask 0022`: 2,893 affected
tests passed, one existing opt-in skipped. The corrected metadata projection then
passed the same agents/daemon/CLI/store/core/protocol selection under `0022`:
2,896 tests passed, one existing opt-in skipped, with at most two Vitest workers.
The approved #737 recovery fixture separately passed all 22 cases on Linux under
`0022`; no Mac hardware was used. Root/renderer types, changed-file lint/format,
full TypeScript/Vite build and diff checks also passed on the combined tree.
The original owner/binding/source checks and the verified-per-execution Save gate
were not modified by this privacy correction. No positive qualified Save evidence
was manufactured. Final full-suite/global coverage and parent re-review remain
required before integration acceptance.
