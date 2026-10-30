# Permission waits and provider continuation

This records the supported boundary for the standing-rule and initial-approval
work. It does not enable a production guard, change the turn timeout, define a
new run lifecycle, or implement durable permission recovery.

## What the current transport owns

An ACP turn is one outstanding `session/prompt` request. In
[`acp-session.ts`](../../packages/agents/src/acp-session.ts), `prompt()` creates a
private turn ID, an abort signal and one optional timeout timer. Notifications and
agent activity do not restart that timer. A permission request is accepted only
for that exact active turn and ACP session. Its local invocation ID is generated
by ORCA; a provider's reported tool-call ID is not execution authority.

Cancellation aborts the turn signal and sends `session/cancel`. A cooperative
agent can end that prompt while its session stays connected. An agent that does
not end the prompt within the cancellation grace is terminated. Process or
connection closure also invalidates the turn. The prompt's `finally` block aborts
and clears its private turn record.

[`permissions.ts`](../../packages/agents/src/permissions.ts) releases an aborted
permission wait without waiting for an uncooperative human callback. It checks
cancellation again after an answer. A late result cannot authorize the expired
invocation. The old callback's failure handler also checks exact active-turn
identity before failing a prompt, so it cannot cancel a later turn.

The new actual-transport controls in
[`acp-permission-lifetime.test.ts`](../../packages/agents/test/acp-permission-lifetime.test.ts)
exercise timeout with ongoing activity, explicit cancellation and a late callback
failure. Each starts a new turn on the same cooperative session, reuses the
provider's tool-call identifier, and requires a distinct local turn and invocation.
Only the new callback's own answer can finish that turn. These controls establish
cooperative cancellation and new-turn isolation; they do not establish installed
provider behavior, process-death recovery or `session/load` recovery.

## What a longer human wait can mean

A deferred owned-read intent can wait without holding an executable action. After
the final genuine delivery acknowledgement, it must acquire current authority,
capture a new action bounded by the individual execution window and the actual
lease, re-evaluate current policy, and consume its permit once. Cancellation,
failed acknowledgement and uncertain execution cannot reopen that attempt.

That separation does not keep an ACP callback alive after its turn terminates.
The live query still owns a real turn signal. The initial-query intent-first
candidate is separate from the already implemented post-Save deferred invocation;
source review and tests must establish its wiring before claiming it works.

An until-revoked saved rule is likewise not a stored callback, action, permit or
lease. Later invocations still need their own current authority and execution
expiry. Keeping a rule valid does not revive an expired action.

## Durable ownership that is still needed

The existing `resumeSessionId` option can load provider context when supported.
The interface supplies no pending-request identifier or contract for restoring an
old JSON-RPC permission callback. The orchestrator's sealed durable continuation
boundary explicitly refuses live callback identities; it must not be widened by
relabeling a permission callback as a workflow decision.

A durable approval would need a separately protected, versioned, non-executing
intent owned by the run. It must retain exact scope and human-review provenance,
use authenticated compare-and-swap and idempotence, enforce cancellation
tombstones, and revalidate workspace, resource, credential, policy, revocation and
lease before a later choice can create fresh authority. It must persist neither
a reusable execution permit nor an allegedly resumable callback. A fresh provider
invocation must be independently captured and matched before an approved intent
can affect it. One-use approval requires its own protected consumption contract;
it must never silently become a standing grant.

The following choices remain unresolved and are not implemented here:

- Whether a human explicitly chooses Continue or ORCA automatically starts a new
  provider prompt after approval; either requires a genuinely new invocation.
- How an approval remains visible and owned when its previous step or turn has
  ended, including run failure versus parking and recovery after process loss.
- The retained pending-intent privacy/retention policy and one-use consumption
  recovery contract when publication or delivery acknowledgement is uncertain.

Explicit user cancellation must cancel the pending approval and remain terminal.
Provider termination alone cannot be treated as successful execution, implicit
consent, or evidence that a new agent can receive the old response.
