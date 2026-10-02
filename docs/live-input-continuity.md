# Live permission callbacks (#237)

Implementation base: `7abc2342aa672ee9d2f10d565ca4f8eb546184df` (the reviewed
preparation merge). This story follows the
[frozen parallel contract](runtime-next-parallel-contract.md). The owned modules
are implemented here; the reserved integration edits are supplied separately in
[237-live-input-integration.patch](patches/237-live-input-integration.patch).
Applying the patch enables the integration fixtures. Production activation is
part of Cal's combined wiring with #318/#329/#332, not a capability this feature
branch advertises on its own. No peer branch or invented configuration generation
is required to compile or test the owned modules.

## Two lifetimes

Workflow decisions and questions still use `HumanInputPending`: the interpreter
parks, releases its lease, and recovers the gate from the protected event log.
The existing exact durable-answer and actor-audit path is unchanged.

An ACP tool-permission callback exists only during its original prompt turn.
`LiveHumanInput` holds that callback in its owning process. Its public identity is
exact run, step and input plus daemon instance, session, turn and invocation IDs.
Turn/invocation IDs are newly allocated even when the agent reuses its tool-call
ID. Identity is correlation, never authority. Config changes and client target
switches cannot replace or settle it.

The event and reduced request carry the four live identifiers in the typed
`liveDecision` field, outside free-form `context`. Protected projection preserves
only those four structural fields; context lookalikes, extra properties and
ordinary secret-bearing text retain their existing redaction rules.

The interpreter remains attached and its existing lease keeper renews normally.
A live answer uses `RunContext.withOwnership` and `emitOwned` under the existing
lease mutex; it never acquires a second answer lease or starts another
interpreter. Registering the callback precedes publishing `human.requested`, but
acceptance waits until both opening events are persisted.

Acceptance requires an injected, server-verified `LiveAnswerAuthority`. Its
`authorize(target, standing)` runs before lifetime diagnostics and again inside
the owner mutex. The callback's exact identity and offered option must match.
Only one responder can claim it. `human.answered` records the verified actor before
any standing write or callback delivery. A duplicate, stale, wrong-generation,
unauthorized, expired or owner-unavailable response never writes policy.

The offered live choices contain only ACP `allow_once` and `reject_once` options.
Agent-side remembered options (`allow_always` and `reject_always`) are not offered
or accepted, even if their IDs are guessed. ORCA's explicit standing-rule action
remains a separate authorized write. Acceptance also rechecks the initiating
actor's execution authority inside the original lease mutex; the background poll
continues to expire idle asks when no responder arrives.

Standing rules require distinct `permissions.grant` authority. Their write occurs
after accepted input under the same lease. Failure reports `answerRecorded: true`
and propagates `HumanInputPending` to the original prompt, so the run parks and no
tool approval is delivered. Resuming opens a new invocation with a new identity;
it does not replay that recorded tool approval. Permission policy continues to
reread the sidecar per ask (#271).

## Expiration, reconnect and other processes

Run cancellation, lease loss, agent exit/connection loss, turn timeout/end, daemon
shutdown and revoked execution authority invalidate callbacks. A rejected host
response arriving after expiration cannot cancel the next prompt. Losing a lease
prevents any further execution write, including answer acceptance.

`LiveExecutionAuthorities` binds a verified actor to an admitted root, lets child
runs inherit that lifetime, and rechecks credentials while no responder is
present. Unreadable authority fails closed. Its lifecycle is independent of UI
connections. Disconnecting a UI neither approves nor cancels work. Reconnect uses
an authorized `inputs.list`; current callbacks remain pending, while callbacks
whose lease has lapsed are expired. Durable workflow gates retain their existing
restart recovery.

Cross-process forwarding is deliberately not implemented. A process without the
callback returns `RUN_STATE` with `details.liveInputState: "owner-unavailable"`
(or `"expired"` once the lease is absent/lapsed). Answer at the owning daemon.
It never transfers a session, takes over a live lease or replays a tool decision.
`LiveHumanInput.inspect` is an internal projection: callers must authorize its
exact run first, as the daemon's read guard does.

The ACP upstream adapter sends generation-bound permissions to its authenticated
live fallback. An upstream ACP option alone supplies neither verified actor nor
current standing-rule authority. Legacy upstream gates still work; disconnect or
a reply from a replaced target parks a durable gate rather than accepting a stale
answer. A transport that does not supply an invocation lifetime retains the
conservative permission-cancellation fallback.

## Session context

`openAcpSession` accepts an explicit `resumeSessionId`. It checks the agent's
`loadSession` capability before sending `session/load`. Unsupported/failed loads
open a fresh session and report `SessionContinuity` as `fresh` with the reason;
a successful load reports `loaded`. The integration patch records this on
`agent.session.opened.continuity`. Default engine restart behavior
remains fresh; automatic persisted session selection is not implemented.
Loading conversation context does not restore a tool callback, authorize a tool,
move an agent process between hosts, or inject text into an active turn.

## Integration handoff

Apply the patch to this feature head, then consolidate its reserved edits with
the other stories. It includes orchestrator/run-context, authenticated answer
control, read projection, protocol schemas/exports, version/capability, approval
UI and dedicated integration tests. No core error enum additions: `RUN_STATE`
carries `liveInputState`; existing `RUN_LEASED`, `NOT_SUPPORTED`,
`HUMAN_INPUT_PENDING` and `INTERNAL` retain their meanings.

Constructor dependencies to wire at the combined daemon composition root:

1. Construct one `LiveHumanInput(identity.instanceId)` from #318's single boot
   identity. Do not allocate a different identity per transport or per run.
2. Construct `LiveExecutionAuthorities(isCurrentActor)` using the active
   credential store and explicit trusted-local authority where appropriate.
   Bind a root only after its exact ownership is durable; inherit that binding
   for children before executing them. On authorized resume, bind the resumed
   tree before interpreter attachment. Forget entries when execution detaches.
3. Pass `{ port, executionSignal: id => authorities.signalFor(id) }` as
   `OrchestratorOptions.liveInput`. The normal input port defaults to this port;
   custom upstream ports must retain it as their live fallback. The options are
   server dependencies, never client parameters or captured config generations.
4. Close both lifetime owners at daemon shutdown, before releasing execution
   resources. UI socket close must call neither. Keep authorization and sidecar
   rereads live across #332 configuration activation.
5. Serve the same orchestrator through `ReadModel` and `ControlModel`. The patched
   auth guard supplies a per-call authority that revalidates credentials and
   exact run scope inside acceptance. Do not call `answerInput` for live inputs
   with only an audit actor.

The additive wire fields are `OpenInputView.live: {target, state}` and
`InputsAnswerParams.live: target`. A live answer requires that complete identity;
`resume: false` is refused because delivery continues the original turn.
`inputs.live` is advertised only for a wired control model and authorized
responders. The candidate protocol minor is 1.10; consolidate that increment with
the other stories once, at integration. The app forwards the exact identity and
disables expired/unavailable cards. Existing notifications trigger the same scoped
reads; no new polling channel or second gate engine is added.

Required existing-test updates belong to Cal: fixtures that synthesize parked
permission callbacks must instead use live invocations or assert refusal;
permission-card fixtures that expect enabled answers must supply `live.state:
"pending"` and its target. The exact remaining fixtures are `daemon/test/runtime-integration.test.ts`
(three parked-permission cases), `app/renderer/test/attention-surface.test.tsx`
(three permission-card cases), `app/renderer/test/inline-asks.test.tsx` (one case),
and `protocol/test/protocol.test.ts` (one capability inventory snapshot).
Version snapshots, if pinned, move with the combined protocol increment. Durable workflow-gate fixtures must stay unchanged.

## Validation

Owned tests cover exact identity mismatches, concurrent responders, authority
rechecks/revocation, sidecar ordering/failure, lease loss, cancellation/expiration,
reconnect reads, process/restart boundaries, upstream target replacement, and a
real ACP subprocess through multiple turns, cancel, timeout, process death,
late-host failure, and capability-checked session loading.

The separate integration test in the patch exercises the real interpreter,
renewed lease, second-interpreter refusal, read/control models, accepted standing
write failure followed by fresh resume, and authenticated HTTP/WebSocket answers
and reconnects. A feature-only result does not establish cross-story acceptance.
Real application smoke and cross-platform checks must run at the final combined
head as required by the frozen contract. No completion percentage, ETA or agent
cost is introduced.

The PR review also identified a required combined UI check: an already-connected
Attention/inline permission card must be invalidated on callback timeout,
owner/agent death and execution-authority revocation, without requiring a
reconnect. Expiration does not emit `input.answered`, so the integration must
provide an expiry/invalidation path and test that the card stops offering answers.
The feature slice and its current reserved patch do not claim this UI gate passes.

Verification on this implementation (2026-10-02): the unpatched feature tree
passed `pnpm test` (198 files, 2,386 tests; one skipped), `typecheck`, `lint`,
`format:check`, `design:check` and `build`. The final integration patch passed
61 focused tests across seven files, including the durable-gate and streaming
append-failure regressions, plus typecheck. `git apply --check` verifies the
handoff patch against the feature tree.

An earlier full candidate-integration run had 2,381 passes and nine failures:
eight are the existing fixture/capability updates named above; the ninth exposed
session-continuity metadata interfering with the output-write failure fixture.
That regression was fixed by recording continuity on `agent.session.opened` and
its test passes in the final focused run. The full combined suite is not claimed
as passing. App smoke is not executed here; it remains required at the combined
production-wired head.

PR #383 review corrections: automatic upstream fallback no longer answers an
already-open durable gate after disconnect or target replacement; unbound runs
retain their fallback. The revised reserved patch rejects agent-remembered
options, checks execution authority at acceptance, and preserves typed live
identity through protected storage. Its focused regression suite passed 63 tests
across six files, including HTTP/WebSocket remembered-option refusals, immediate
credential revocation before polling, and protected projection with a one-character
secret. Typecheck passed on the applied patch. The revised feature tree passed
the full suite (2,387 tests passed, one skipped), typecheck, lint and format check.
These results do not replace the combined-suite and App smoke requirements above.
