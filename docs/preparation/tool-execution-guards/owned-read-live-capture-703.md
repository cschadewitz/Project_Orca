# Linux owner-local capture composition — #702 / #703 / #706

This inactive integration connects the bounded detached-inode service to the
protected capture port and actual live-input identity. Nothing registers it in
production, enables a flag, accepts arbitrary paths/descriptors, or adds another
store, UI, rule ledger or executor framework.

`packages/daemon/src/owned-read-scoped-capture.ts` retains only invocations created
through the existing service. It checks the canonical managed binding, obtains
`protectedScopedPermissionOwner.readCaptureFacts(originalActor)` **before** calling
`service.capture`, and compares the original owner's authority stamp and original
callback identity with those facts. The live registry also asserts the exact original
in-process query object; a copied query or target JSON cannot attach a capture.
Failed and duplicate input registrations retain bounded tombstones. It retains the exact actor, target, binding and facade; a copied
action is only a lookup key for an already retained capability. Current reads recheck
actual protected facts across awaits. They do not authorize from supplied stamps.

The service facade now exposes a synchronous `assertCurrent` over the original
fence and its physical descriptor capture. The registry uses that assertion alongside
canonical binding, live lifetime, cancellation and expiry checks. It cannot substitute
a new owner, inode, policy, captured ceiling or action. Resource-local workspace and
managed policy workspace retain their distinct original identities.

`policyChanged` consumes its transition before awaiting. It requires authentic new
policy bytes and unchanged authority/lease/revocation facts, then calls exactly
`service.refreshPolicyRevision(retainedInvocation)` and retains the returned facade.
The execution owner can retrieve that exact facade through `invocation(token)`.
A failed/uncertain transition blocks the token. The service's own retirement gate
still requires an evaluated `require-human` attempt before any permit authorization.
It preserves parameters, original cancellation/expiry and captured ceilings. No
replacement action or callback is reconstructed from durable state.

## What the closed composition actually proves

The new CLI integration suite composes disposable managed roots, real typed policy,
file-backed encrypted execution/events, credential authorization, held run leases,
strict source/policy, protected owner, command bridge, bounded service and
`askHumanInput` / `LiveHumanInput`. Managed lifetime/build acceptance remain explicit
synthetic assumptions. No existing workspace is enrolled, migrated or deleted.

The actual service remains `policy-per-ask`, `installedRefs: []`, with
`independentlyObservedEffects: false` and `offeredChoices: []`. The actual protected
composition has no completed required review. Presentation options never become
ACP native choices or execution authority. `ownedReadInputOptions` resolves the
original owned-I/O prompt roles only from this closed producer's actual capture
capability. Protected review requires verified installed coverage before using
those roles; the current unqualified fixture still refuses. No native choice
qualification is invented. This follows the reviewed owned-I/O distinction in the
[execution contract](README.md): owned dispatch does not require fabricated ACP options.

## Actual callback-to-execution plumbing

`LiveHumanInput.retainOriginalDelivery(originalQuery)` retains an ephemeral original
callback capability before answering. The registry settles it only after the actual
`human.answered` append, exact callback resolution and successful completion of the
original lease operation. Its accepted-answer reference names that actual append's
run/event id. It is correlation, not a bearer permit. A void/missing append receipt,
lost append acknowledgement, failed standing write, cancellation, shutdown, or failed
lease acknowledgement cannot issue the capability. In particular the callback may
have resolved before a failing lease wrapper reports its failure; that ambiguous
case produces no delivery authority. No durable state can reconstruct the capability.

`claimOriginalDelivery` requires the exact original query, actor and original owner
option, rejects standing answers, checks original signals/registry lifetime and binds
the capability to one actual action object. A copied query/token, public boolean,
answer string or durable event id is insufficient. The producer binds the original
owner's Allow once role through `TrustedOwnedReadInvocation.bindHumanInput`; refresh
retains that exact binding rather than installing another callback.

`executeHumanDelivery(token, signal)` is called by the original executor continuation
following its separate explicit answer. Save never calls it. It rechecks original
protected facts/binding and invokes the retained service's `completeHumanDelivery`,
then the existing canonical `authorize` and `dispatch` methods. Duplicate calls share
one terminal result; failed or uncertain attempts do not reopen. The service retains
whether this invocation actually evaluated to `require-human`, including across the
one-time Save refresh. A fresh invocation allowed by an existing rule cannot acquire
human attribution through this method.

`SyntheticReadFence.completeHumanDelivery` claims the original delivery capability,
requires installed `verified-per-execution` coverage and an unchanged eligible current
policy result, and derives the canonical human verdict/accepted-answer reference.
The normal permit and dispatch path revalidates the exact underlying policy result,
actor/authority, original delivery, ceilings, expiry, cancellation and physical inode,
and records authorization before I/O. A policy-returned human string without this
actual delivery handoff is refused. These functions contain the callback-to-verdict/
permit plumbing; no positive qualified execution is manufactured to exercise it.

`reviewProvenance` reports passed only after this fence's actual required-review
binding/completion returns an evaluated fit, a canonical allow and a protected judge
record reference. A plain allow verdict or a supplied review-reference string does
not establish provenance. Refresh requires fresh provenance for its new action.

Tests observe successful exact callback delivery, one-action capability binding,
wrong actor/option/query/token refusals, duplicate delivery/completion, durable append
without delivery, and callback resolution followed by lost lease acknowledgement.
They also observe denial/cancellation and actor/binding/image/revision/lease/expiry/
registry changes between delivery and execution. The actual unqualified service
refuses before a permit, authorization record or independently observed OS read.
Lower-level tests retain the existing synthetic approval assumption while checking
actual strict-policy/offline-judge provenance and refusal of an injected human verdict.

The actual protected source refuses qualification; strict evaluation is indeterminate.
The authenticated command bridge refuses review/Save, leaves the live callback
pending and writes neither an approval nor a standing rule. Actual sidecar byte
changes, wrong actor, root binding loss, image change, credential revocation, broken
lease, cancellation, service close and expiry refuse retained capture access before
I/O. A new real policy byte revision reaches the service's actual refresh gate;
its indeterminate evaluation cannot be retired as an eligible human ask. The failed
transition cannot be replayed.

The existing #734 fixture remains explicitly synthetic and unqualified. Its only
compatibility adjustment supplies #736's newly required synchronous source assertion,
checking its existing synthetic marker/authority/lease assumptions. Coverage,
installed refs, native choices and Save qualification gates are unchanged. A separate
lower-level test uses that fixture's existing synthetic approval helper to persist
and revoke an exact rule through the actual typed store. Revocation blocks both an
already issued permit and a fresh invocation, retains the tombstone and performs no
OS read. This is not positive protected Save evidence.

## Positive steps still blocked

No independently accepted installed build/host/tool/profile qualification record or
protected conformance lookup exists for this producer. The production accepted-build
map is unchanged and empty. A real managed lifetime and trusted original owner
checks must replace the disposable test assumptions before activation. Native ACP
choice qualification remains absent and unchanged; this owned-I/O path uses its
actual owner prompt roles behind the installed-coverage gate instead.

Consequently positive protected Save, confirmed Save-to-refresh, and a separate
explicit Allow once-to-first-execution are **not accepted or demonstrated** here.
The actual service cannot truthfully produce verified coverage until an independent
accepted installed record and protected conformance lookup bind this exact build,
host, tool, profile and managed lifetime. The protected composition also needs a
genuine current required-review record. Those are external evidence gates, not
missing callback-to-verdict/permit plumbing. Their positive acceptance branches
remain untested rather than being covered by invented qualification. Subsequent
fresh invocations retain normal rule authorization and cannot reuse the original
human-delivery capability.

## Dependency and validation scope

Main `5a58ab7c6944c5a990382e5abcb5a76e4a3af09e` contains merged #732/#733/#734.
Corrected #736 `040a00ec4035fdea5e636e91dc22a578f1828cf1` is incorporated separately;
parent reports independent correction review passed and its hosted CI pending.
The correction is used locally without declaring combined acceptance. Parent owns
merges. This lifecycle delta does not duplicate or alter the protected-owner privacy fix;
its separate owned-prompt resolver preserves the installed-coverage gate.

Checks and exact tested head are reported in the handoff. No production accepted
build entry, live activation, access/credential change, deployment, upstream message,
Mac test or Apple Silicon acceptance is included. Positive coverage and final
combined-main acceptance remain explicit independent gates.
