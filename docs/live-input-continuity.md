# Live permission callbacks (#237)

**Current reading, 7 October 2026:** these owner-local callback lifetimes are
implemented in the combined protocol **2.0** runtime. Protocol 1.10 and feature-only
validation below are original integration checkpoints. Durable gates, expired
callbacks and process/session restoration retain the distinct limits described here;
see the [capability ledger](ROADMAP.md) for remaining actual-client/native acceptance.

The combined runtime wires owner-local live permissions through engine, daemon and app.
[237-live-input-integration.patch](patches/237-live-input-integration.patch) is retained
as a historical handoff against preparation baseline
`7abc2342aa672ee9d2f10d565ca4f8eb546184df`, reconciled with the other feature heads.
Do not apply it to the integrated tree. Historical feature checks below are not final
combined acceptance.

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

Production `prepareExecution` walks authenticated creation lineage and verifies the
original root principal and durable ownership before execution. Without an explicit
renewal, the original credential must remain current. Revoked/missing authority fails
before attaching an interpreter; the execution lifetime is independent of UI sockets.

After bootstrap credential rotation, `runs.resume` and daemon `requests.reconcile`
are explicit renewal boundaries. Reconciliation validates the accepted root before
acknowledging recovery and passes the same verified authority to its queued worker.
The server supplies a separate attachment capability: the current credential must
represent the original protected principal and durable root owner, retain workflow
scope plus `runs.control` and `runs.start`, and retain `plan.write` for a Request root.
The capability is rechecked under the acquired execution lease and applies to that
authenticated tree. It cannot replace an already attached interpreter, select another
principal's credential, change `run.created`, restore a prior callback or grant a tool.
A same-boot renewed binding can continue through later durable pauses while current
grants/revocation are still checked; process restart requires explicit renewal again.

Answering a durable gate never supplies renewal authority. If its answer is recorded
but automatic continuation needs renewal, the response is `RUN_STATE` with
`answerRecorded: true` and `executionResumeRequired: true`. Resume explicitly rather
than answering the same gate again. The new execution opens a new session/invocation;
a fresh tool permission requires its own exact new one-time answer. An agent offering
only remembered permission kinds is cancelled immediately rather than publishing an
impossible-to-answer live card. Existing dead callbacks remain expired.

Disconnecting a UI neither approves nor cancels work. Reconnect uses an authorized
`inputs.list`; current callbacks remain pending while lapsed callbacks are expired.
Durable gates remain recoverable subject to historical generation restoration and
current authorization.

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

## Connected callback invalidation

Connected clients receive `input.invalidated` when their owning callback expires.
`LiveHumanInput.onInvalidated` exposes only its complete target, never the question,
secret-bearing context or abort reason. `Subscription` attaches before replay and
uses the existing method/run filters and current credential/resource authorization.
Execution-principal revocation updates other authorized observers; a revoked reader's
socket is closed instead of sending that reader private state.

This is ephemeral state, not `human.answered` or another event-store append. It carries
no `seq`, advances no cursor and is not replayed, including after lease loss. Attention
retains exact-identity invalidations per connection generation, so initial/scoped reads
already in flight cannot re-enable expired controls. Inline cards share that feed.
The disabled record and daemon waiting count remain; invalidation never calls answer,
cancel or resume. Replacement invocations are distinct and reconnect reconciles via
an authorized `inputs.list` snapshot.

The server passes the same port as `MethodContext.liveInputs` through context
construction. Socket unsubscription detaches only the observer, never the port.
Focused coverage includes authenticated sockets, stale reads, exact identities, client
connection epochs, lease-fenced refusal and durable gate recovery. Final app smoke
still belongs to the production-wired integration head.

## Session context

`openAcpSession` accepts an explicit `resumeSessionId`. It checks the agent's
`loadSession` capability before sending `session/load`. Unsupported/failed loads
open a fresh session and report `SessionContinuity` as `fresh` with the reason;
a successful load reports `loaded`. The integrated engine records this on
`agent.session.opened.continuity`.

Callers that require a load can set `requireContextRecovery: true` alongside a
nonempty `resumeSessionId`. Missing IDs fail before spawn. Unsupported, rejected
or timed-out loads reject the open, close the connection and run bounded cleanup
of the owned process; they never send `session/new` or a prompt. These failures
carry a sanitized `details.contextRecoveryReason`: `missing-session-id`,
`load-unsupported`, `load-failed` or `load-timeout`. Provider error text and stderr
are omitted from these load-failure errors. A successful load still establishes
only protocol success, not expected native checkpoint identity or context completeness.
See [#357 investigation and remaining contract](archive/preparation/agent-context-recovery-357/README.md).

Default engine restart behavior remains fresh; automatic persisted session
selection and durable approval continuation are not implemented by this option.
Loading conversation context does not restore a tool callback, authorize a tool,
move an agent process between hosts, or inject text into an active turn.

## Integrated wiring

The integrated orchestrator/run context, authenticated answer control, read projection,
protocol exports and approval UI use the same owner-local port. `RUN_STATE` carries
`liveInputState`; no core error enum is added.

The daemon constructs one `LiveHumanInput` from its boot identity and one
`LiveExecutionAuthorities` checker using current credentials and durable ownership.
Before execution it reconstructs the sealed root actor for each run, including children,
and applies only a separately verified explicit renewal when one exists. Detachment
forgets the active callback binding; eligible same-boot renewal remains current-checked. The orchestrator
receives the port and execution signal as server dependencies, never client parameters
or captured generation data. Read and control models share that orchestrator; answer
authority revalidates credentials and exact run scope inside acceptance. Daemon shutdown
closes the lifetime owners; UI socket closure does not. Permission sidecar reads remain live.

The additive wire fields are `OpenInputView.live: {target, state}` and
`InputsAnswerParams.live: target`. A live answer requires that complete identity;
`resume: false` is refused because delivery continues the original turn.
`inputs.live` is advertised only for a wired control model and authorized
responders. The combined protocol version is 1.10.

## Historical feature validation

Owned tests cover exact identity mismatches, concurrent responders, authority
rechecks/revocation, sidecar ordering/failure, lease loss, cancellation/expiration,
reconnect reads, process/restart boundaries, upstream target replacement, and a
real ACP subprocess through multiple turns, cancel, timeout, process death,
late-host failure, and capability-checked session loading.

The historical patch included an integration test exercising the real interpreter,
renewed lease, second-interpreter refusal, read/control models, accepted standing
write failure followed by fresh resume, and authenticated HTTP/WebSocket answers
and reconnects. A feature-only result does not establish cross-story acceptance.
Real application smoke and cross-platform checks must run at the final combined
head as required by the frozen contract. No completion percentage, ETA or agent
cost is introduced.

The PR review also identified a required combined UI check: an already-connected
Attention/inline permission card must be invalidated on callback timeout,
owner/agent death and execution-authority revocation, without requiring a
reconnect. Expiration does not emit `input.answered`; the combined implementation
now supplies the ephemeral `input.invalidated` path and focused connected-card tests.
These checks do not replace final application smoke.

Verification on this implementation (2026-10-02): the unpatched feature tree
passed `pnpm test` (198 files, 2,386 tests; one skipped), `typecheck`, `lint`,
`format:check`, `design:check` and `build`. The final integration patch passed
61 focused tests across seven files, including the durable-gate and streaming
append-failure regressions, plus typecheck. The handoff was checked against its original
feature tree; that is not an
instruction to apply it to this integrated tree.

An earlier full candidate-integration run had 2,381 passes and nine failures:
eight concerned fixture/capability updates on that historical candidate; the ninth exposed
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
