# Explicit human revision input (#356)

This is the feature handoff against preparation commit
`9058fa8935ae4c999293727c005031eec93114be`. It implements the allocated revision
contracts, service, journal projection, delivery accounting, authenticated authority,
client helper and correction card. It does **not** advertise a production revision
capability on the feature branch. The coordinated runtime integration supplies the
reserved wiring and the production #331 retry facility. See the
[frozen contract](runtime-operator-parallel-contract.md).

## User behavior

An ordinary answer note remains audit rationale. It never becomes a corrective
instruction, changes workflow values, chooses a branch, or grants permission.

A revision-enabled durable gate offers a separate **Request changes** action. It
previews the workflow-declared destination and records a correction together with
the exact branch decision. This is one logical commit. It grants no tool permission
and does not itself authorize a subsequent execution attachment.

One destination/attempt has one active undelivered correction. A replacement names
that correction and its current version. It supersedes the previous version, retaining
its original payload and author, without answering the gate again or allocating an
attempt. Replacement remains available after the originating input has closed.

The card shows the current correction before replacement and reports pending,
delivered, rejected and superseded states. A failed or stale write keeps the draft.
An unchanged retry keeps its intent key; edited content creates a new intent. A stale
version requires explicit review. Changing connection scope or target blocks the old
draft; discarding it and starting a new correction is explicit. Late responses from
the previous scope cannot apply to the new one. The parent retains the card after the
gate closes and refreshes its authoritative pending read from push/reconnect events.
The Attention root (or step-detail parent) owns scrolling; the card adds no nested
scroll region. Long correction text wraps inside the card.

## Workflow declaration

The reserved schema patch adds `revision` to gates and human-sourced decisions:

```yaml
review:
  type: gate
  question: Is the implementation ready?
  options: [approve, changes]
  revision:
    actionId: changes
    destinationNodeId: build
    composition: replace-revision-slot
    payload:
      kind: text
      maxBytes: 8192
# In the same graph's edges:
# - { from: review, to: build, when: "choice == 'changes'" }
# - { from: review, to: done, when: "choice == 'approve'" }
```

V1 conservatively requires unique direct `choice == 'option'` branches to a declared
agent in the same graph. Ambiguous expressions, indirect routes, live permissions,
cross-child targets and other node types are unsupported. Ordinary answering cannot
select the revision branch without the correction commit. A runtime lacking revision
support refuses a revision-enabled gate rather than silently dropping the declaration.

A `values` declaration uses `inputSchema` from the existing workflow-input validator.
Defaults and validated values populate only `revision.payload.values`. They do not
merge into workflow vars. Text is appended once as an identified corrective-instruction
block after normal prompt rendering; it is never interpreted as template code.
Replacement changes this one slot, never unrelated inputs or a delivered prompt.

## Service and persistence

`RevisionInputService` implements the frozen submit/readPending/replacePending
signatures. The server issues destination IDs, attempt reservations and opaque CAS
versions bound to the source input, recorded workflow and configuration generation.
Clients cannot name arbitrary nodes or choose a new attempt.

`RunRevisionJournal` replays an append-only protected journal. A commit entry contains
the correction, original author/workspace/operation provenance, supersession and (only
for initial submission) the exact gate decision. The reserved reducer patch projects
that decision from the **same event**. There is no write-answer-then-write-correction
crash window. Public revision events contain allowlisted identity/status/decision
metadata; original entries and assembled prompts remain protected.

The journal adapter must use the runtime's existing cross-process run lease and
ownership fence, including for ordinary answers, scheduling and cancellation. It must
reread the durable log under that fence. Its `status` callback checks authoritative
cancellation, source-input state and destination movement. A read uses that same record;
closing the original gate does not remove the pending-target capability.

Before side effects, submit/replacement validate JSON, source identity, action, payload
schema, authority and CAS. Each binds its preallocated revision ID and attempt to the
shared #331 claim, then reauthorizes before committing. Response loss replays the
original receipt, even if delivery has since progressed; `readPending` gives the current
state. Recovery finds a committed operation before trying to commit again.

`createRevisionInputServices` exposes two stable operation instances for trusted #331
registration. `forAccess` supplies request-scoped live authorization through
`AsyncLocalStorage`; no principal is shared between concurrent invocations. Background
recovery must enter a newly authorized scope too. No memory retry ledger is shipped.
The feature's structural retry interfaces exactly match the frozen signatures and
must be consolidated with #331's exports during integration.

Payloads are limited to 64 KiB in UTF-8 (or a tighter workflow limit), commands to
256 KiB and nesting to 32. Values must be JSON. Map keys normalize deterministically;
arrays, strings, Unicode and selection guards retain their meaning. The shared retry
facility owns 1–128-byte keys, cross-process deduplication, retained claim quotas and
workspace-lifetime retention. It must not fingerprint payloads into public indexes.

## Delivery, interruption and cancellation

`RevisionDelivery.claim` checks run, destination, node and reserved attempt, assembles
and persists the protected prompt, then advances CAS **before** returning the handoff.
Replacement and another claim are thereafter stale. `beforeSend` rechecks live authority
and cancellation immediately before the original send while the interpreter retains
its execution lease. The runtime must never move the handoff to another step.

Internal delivery metadata is separate from the four public states:

| Internal state | Public state | Replacement |
| --- | --- | --- |
| unclaimed | pending | authorized CAS only |
| claimed | pending, handoff unconfirmed | refused |
| confirmed | delivered | refused |
| uncertain | pending, handoff unconfirmed | refused |

Confirmation requires evidence from the original external turn. Process death or an
ambiguous transport failure is not evidence of delivery: the claim remains inspectable
and cannot be automatically replayed. This does not promise exactly-once external agent
execution. A crash before the claim may recover the same intended attempt; after it,
recovery stops for explicit handling. Cancellation rejects unclaimed pending revisions
and blocks dispatch, preserving confirmed history. `rejectUndeliveredRevision` is the
runtime cancellation transition; authoritative cancelled status also projects rejection
for an unclaimed record.

## Authorization and adapter contract

- Initial submission and replacement require current `inputs.answer` **and**
  `runs.control` on the exact run. Operation grants precede wire diagnostics.
- Metadata reads require `runs.read`. Protected payload reads additionally require
  both mutation grants, regardless of whether replacement is still possible.
- Actor and credential attribution come from the verified server context. Credential
  rotation keeps principal identity; revocation and wrong principals fail closed.
- The three method/capability names are `inputs.revise`, `inputs.revisionPending` and
  `inputs.replaceRevision`. The reserved patch registers them only with an explicitly
  supplied authenticated service and filters discovery by the current grants.
- `RevisionInputClient` provides the CLI/API submission and pending-replacement helper.
  It requires negotiated methods and the caller's retained intent key. It never falls
  back to an answer note. ACP/MCP remain unsupported until their owners wire the same
  contract; the helper's negotiation tests are not end-to-end ACP/MCP acceptance.
- The reserved core error is `REVISION_STALE`. Until that enum is integrated, the
  feature service takes an injected `() => OrcaError`; fixtures use existing `RUN_STATE`
  rather than casting a code absent from the baseline.

## Reserved integration patch and remaining combined work

[356-operator-integration.patch](patches/356-operator-integration.patch) is an exact
patch against the pinned start, intentionally **unapplied** on this branch. It provides
barrel exports, workflow declarations/validation, `REVISION_STALE`, an atomic revision
event/reducer, protected public projection, input invalidation, protocol projections,
auth inventory/discovery, conditional RPC registration, app bridge/client/IPC plumbing,
and interpreter hooks for boundary declaration, attempt reservation and prompt delivery.
It also keeps ordinary answers from selecting the revision branch.

The integrator must compose the following reserved pieces with #331 and the shared
continuation/ownership implementation before advertising methods:

1. Supply `RevisionLog` over the existing protected event store, with lease ownership
   reused while executing and acquired for parked mutations. Validate decoded entries,
   promote legacy/non-sensitive run inputs using the existing protected-input boundary,
   and add correction payload literals to sensitivity before any prompt/output events.
   The patch refuses to write revision events without protected inputs.
2. Implement `revisionRuntime.reserveStep/forStep`: persist the boundary declaration
   with workflow/generation identity, reserve exactly one future step ID, reuse it only
   before any delivery claim, and refuse ambiguous resumes. Tie `status` and cancellation
   to the same durable ownership boundary. Wire `RevisionDelivery` into those exact hooks.
3. Register the two operation objects with production #331 claims and construct
   authenticated request scopes from transport context. Durable continuation/dispatch
   uses current execution authority; a queued promise is not durable admission.
4. Populate authorized boundary projections and retain/read pending receipts after a
   gate closes. Compose the new card in Attention and inline step detail with the existing
   connection scope, announcements and notification feed. Wire the CLI command parser to
   the helper. Do not derive destination IDs or CAS versions in an adapter.
5. Consolidate shared exports, update the auth documentation matrix and exhaustiveness
   fixtures, and choose protocol/store compatibility changes once for the combined work.

Those are the integration owner's existing scope, not new follow-up issues. #398 owns
later composition/history reuse and #399 owns retry compaction. Neither is implemented
or duplicated here. No main merge, release, deployment or live agent launch is part of
this handoff.

## Verification boundaries

Focused tests cover declaration refusals, exact identity, atomic commit interruption,
retry conflict/replay, current authority, immutable supersession, competing stale edits,
claim-versus-replacement, intended prompt assembly, cancellation and ambiguous restart.
The actual journal projection is also replayed from authenticated encrypted files after
recreating the store. The card tests exercise its real DOM and actions, draft retention,
all four states and connection changes. Adapter tests cover explicit negotiation refusal.

The claim facility and execution-fence adapters in service tests are faithful fixtures.
They do not prove multi-process #331 durability, production attempt reservation or a real
Electron flow. The reserved patch is apply-checked and typechecked in a separate scratch
copy. Final combined Node 22/24 tests/coverage, HTTP/WebSocket contract tests, compiled
runtime smoke, Electron smoke and independent review remain required on the integrated
head. Feature-only checks must not close #356's combined acceptance criteria.
