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
The live query still owns a real turn signal. The initial-query intent-first and
post-Save deferred paths have source-level integration coverage; neither persists
a permission request independently from that original live owner.

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

## What must change in the run lifecycle

The current timeout does not have one universal run-level result:

- A cooperative agent can finish its cancelled turn. The agent-step executor then
  checks its deliverables: valid artifacts can complete the step; missing
  deliverables can cause another configured follow-up turn or an artifact failure.
- An uncooperative agent is terminated after the cancellation grace. Its transport
  error becomes a failed step, subject to the workflow's existing retry budget.
  Exhausted retries make the run fail.
- In either case, the original permission invocation is invalid. A later turn has
  a new local identity; repeating a provider tool-call ID does not revive it.

These behaviors come from
[`agent-step.ts`](../../packages/engine/src/executors/agent-step.ts) and
[`orchestrator.ts`](../../packages/engine/src/orchestrator.ts), rather than from a
durable approval mechanism. The current pending-input projection hides requests
when a run is completed, failed or cancelled. `PausingHumanInput` refuses permission
callbacks, and `answerOwned()` rejects answering them from a parked log. Existing
sealed continuation attachment permits selected root gate/human-decision
boundaries, not an agent step's live permission callback.

To implement the requested durable wait, the timed-out agent attempt must retire
while a new protected, non-executing request remains run-owned and visible. A
dedicated permission-intent boundary must define parking, recovery and cancellation
atomically. Merely leaving the old attention card visible or bypassing the current
continuation validator would not create a safe resumption path. This document does
not select new timeout, retry, sibling-step or run-status behavior.

## Decided starting behavior and remaining lifecycle choices

Casey's decisions already establish that ordinary authorized workspace reads do
not need approval, cancelling a run cancels its pending requests, saved rules last
until revoked, and a human wait must not consume a later execution window. The
initial behavior for a request whose original agent turn has ended is now decided:
approval records the decision, and **Approved — Continue** requires a separate
explicit Continue before a new invocation can start. This is a product requirement;
durable post-turn recovery is not implemented by the current live-intent work.

Recoverable agent context is also a product durability requirement. Losing that
context should be exceptional, with an explicit reason and recovery path, rather
than the normal outcome of a timeout, disconnection or restart. This does not claim
that every installed provider can recover context today. Capability-checked
`session/load` can restore supported provider context; it cannot restore a dead
permission callback. The current orchestrator does not supply `resumeSessionId`;
the adapter's existing fresh-session fallback is not proof of context recovery.
The durable path must not silently discard context or label a fresh session as a
restored conversation.

The investigation and acceptance checklist are tracked in the existing recovery
issue [#357](https://github.com/cschadewitz/Project_Orca/issues/357#issuecomment-6514920391),
coordinating with scoped approvals rather than reopening completed live-callback
work. No release date is committed. The remaining choices are:

| Choice                                         | Concrete example                                                                                              | Proposed starting behavior, not implemented                                                                                                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What if provider context cannot be restored?   | The provider does not support `session/load`, rejects it, or the stored session has disappeared.              | Clearly distinguish restored context from a new session. Require an explicit choice before starting a new session from approved run context; do not claim the previous callback or conversation resumed.             |
| How long should an unanswered request be kept? | The agent is gone, the approval is still unanswered, and its protected scope may contain private information. | Undecided. Agree on pending-request lifetime and private context disposal after terminal state or abandonment. Do not infer indefinite retention, reuse the action's one-minute expiry or silently delete a request. |

Run parking and recovery must also settle how unrelated step failures and parallel
siblings interact with the retained request. The existing root-decision resume
contract does not answer that for an interrupted agent step.

## Next safe implementation steps

1. Inventory supported provider/adapter versions and verify context persistence,
   protected session references, capability negotiation, restart recovery and
   missing-session behavior. Distinguish verified, unsupported and unverified
   recovery; use the existing session ports where possible.
2. Review a versioned run-owned non-executing intent and context-reference contract
   with exact scope, private provenance, fenced storage, idempotence, cancellation
   tombstones and one-use consumption. Resolve parking, sibling-step behavior and
   unanswered-request retention before enabling the affected lifecycle.
3. Record approval independently from explicit Continue. Continue must claim a
   single eligible attempt, recover supported context honestly and revalidate
   current authority before capturing the new actual invocation. Missing context
   must retain history and report an actionable recovery choice.
4. Test timeout, disconnect, restart, duplicate Continue, competing owners,
   cancellation, scope drift, revocation, expiry, uncertain effects and private
   context projection. Provider-free controls and installed-provider recovery
   acceptance remain separate evidence.

Regardless of these choices, **Allow once** must remain one-use. The later actual
invocation must match the protected canonical scope and pass fresh current checks;
a changed command, resource or workspace requires new review. Consumption must be
protected before effects. An uncertain dispatch remains consumed and cannot be
automatically retried. **Save** remains a separate until-revoked grant operation;
it does not also answer or execute the pending tool call. Recovery must persist
neither bearer secrets nor executable callbacks, permits or file descriptors.

Explicit user cancellation must cancel the pending approval and remain terminal.
Provider termination alone cannot be treated as successful execution, implicit
consent, or evidence that a new agent can receive the old response.
