# Linux owner-local capture composition — #702 / #703 / #706

This inactive integration connects the bounded detached-inode service to the
protected capture port and actual live-input identity. Nothing registers it in
production, enables a flag, accepts arbitrary paths/descriptors, or adds another
store, UI, rule ledger or executor framework.

`packages/daemon/src/owned-read-scoped-capture.ts` retains only invocations created
through the existing service. It checks the canonical managed binding, obtains
`protectedScopedPermissionOwner.readCaptureFacts(originalActor)` **before** calling
`service.capture`, and compares the original owner's authority stamp and original
callback identity with those facts. Failed and duplicate input registrations retain
bounded tombstones. It retains the exact actor, target, binding and facade; a copied
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
`independentlyObservedEffects: false` and `offeredChoices: []`. Required review
provenance remains unavailable. The prompt's synthetic presentation options are
never native action choices or execution authority. Tests observe successful exact
live callback delivery once (including duplicate refusal), and a durable
`human.answered` append followed by lost acknowledgement without delivery or replay.
Neither case mints a human verdict, `acceptedAnswerRef`, permit or protected Save.
A forged human verdict using that durable event is refused by the original facade.

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
map is unchanged and empty. No genuine required-review success or original native
choice qualification is available. A real managed lifetime and trusted original
owner checks must replace the disposable test assumptions before activation.

Consequently positive protected Save, confirmed Save-to-refresh, and a separate
explicit Allow once-to-first-execution are **not accepted or demonstrated** here.
A future human execution handoff must retain proof of the exact successful live
delivery to the original callback under current actor/binding/image/revision,
ceilings, lease, expiry and cancellation. It must not derive that proof from a public
receipt or durable `human.answered` event, and only that delivery may produce the
human verdict/accepted-answer reference for the first execution. A second fresh
invocation matching a stored rule would be rule-authorized. No dormant implementation
here fabricates that missing authority to make a positive test pass.

## Dependency and validation scope

Main `5a58ab7c6944c5a990382e5abcb5a76e4a3af09e` contains merged #732/#733/#734.
Corrected #736 `040a00ec4035fdea5e636e91dc22a578f1828cf1` is incorporated separately;
parent reports independent correction review passed and its hosted CI pending.
The correction is used locally without declaring combined acceptance. Parent owns
merges. This lifecycle delta does not duplicate or alter the protected-owner fix.

Checks and exact tested head are reported in the handoff. No production accepted
build entry, live activation, access/credential change, deployment, upstream message,
Mac test or Apple Silicon acceptance is included. Positive coverage and final
combined-main acceptance remain explicit independent gates.
