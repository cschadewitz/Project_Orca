# Operator integration checkpoint

This is the shared integration of the three parallel handoffs, not production
acceptance of #331, #356 or #327. No main merge, release, deployment or actual Cal
connection is included.

## Current continuation composition

The follow-up to the initial checkpoint production-wires `runs.continue`,
`continuations.get` and `continuations.reconcile`. Authorized `runs.get` includes
an optional `continuation.expectedBoundary` opaque CAS guard. The guard is issued
only for a supported boundary and grants no authority. Parameters are the frozen
`{command, retry}` pair; both transports use the same strict schemas.

This first slice supports sealed root runs paused at durable gates or human
decisions. It refuses live callbacks, revision-only branch answers, child/ancestor
continuation, uncertain agent pauses and missing original generations. Legacy
blocking control methods keep their existing behavior. Unsupported boundaries
omit the projection rather than suggesting that a token can be invented.

Admission writes one protected decision-plus-dispatch marker before returning.
Automatic dispatch acknowledges attachment after current execution authorization
and its durable transition, holding the same run lease through execution. Startup
recovery processes at most 100 retry candidates per sweep and resolves only the
original recorded credential. Missing/revoked authority becomes blocked; a new
daemon-local owner credential is never substituted. Explicit same-principal
reconciliation may supply current authorized execution context after rotation.
Already-attached work after a crash is treated as ambiguous unless terminal
history proves settlement. A competing lease is refused without writing through
another owner's fence.

Receipt lookup uses encrypted immutable locators. They are discovery hints, never
acceptance. Startup can rebuild a missing hint only after authenticating and
syncing its existing authoritative marker. A bound claim without a marker creates
no acceptance, answer or execution. A cached retry result is also checked against
the authoritative journal before being returned.

Inspection authenticates and syncs an existing marker without appending, repairing
missing records, allocating a new private payload or attaching execution. Failed
durability verification returns `RUN_STATE` with `uncertain: true` and the original
continuation correlation for reconciliation; it does not report accepted from
merely readable bytes. Missing or rewound markers fail closed. Real HTTP/WebSocket
tests cover this behavior with actual credentials and file stores.

Internal continuation replay is bounded to 100,000 events, read in fixed-size
pages; larger histories refuse with an explicit unsupported result. This limit
does not change the bounded operator tool response limits. Generic admission
receipt dispatch has not been broadened to continuation grants: use the dedicated
continuation receipt methods.

MCP mutation discovery remains disabled pending its bounded boundary projection
and real adapter composition. Durable Request/direct startup dispatch, production
revision delivery activation, Electron, independent review and actual Cal
acceptance remain open; continuation completion does not close those gates.

## Source ancestry and ownership

The common frozen base is `9058fa8935ae4c999293727c005031eec93114be`.
The integration commit preserves these feature commits as parents:

- #412 revision: `ead9383caac9d1e5a37585e82239d9699c2e72c8`
- #413 retry admissions: `b2a364b4f02712cee439c504223bce1848bea1f2`
- #414 MCP reads: `ac081db87f056391fbce82c6165fd513bfbe97a6`

The three named `docs/patches/*-operator-integration.patch` handoffs were applied
once. Shared export, auth inventory, method registration, capability, CLI and
bootstrap collisions were consolidated rather than applying one branch's whole
version over another. Historical integration patches were not reapplied.

The integration owner changes reserved seams and dedicated continuation files.
Owner-authorized takeover corrections are incorporated from these immutable heads:

- #412 `b50785233253940d56f5de2d426cbdc27c9ebc38`: reject explicit or implicit
  automatic selection of the corrective branch.
- #413 `9f9669b1e08e6b5a1afb6671828e688cdb781aa5`: retain encrypted app admission
  intents across restart, scoped to verified principal/workspace/target, with an
  explicit abandon confirmation and an expected-scope fence before admission.
- #414 `b5a2c8f926135e14005cd57ddcf55020e6316322`: refuse preflight when the
  protected active definition differs from the captured revision, and require
  both artifact and run grants for artifact discovery.

The replacement #331 reserved patch was incorporated as an old-to-new three-way
merge, preserving the other features and continuation wiring. The #414 current
peer fixtures retain the integration's shared `PROTOCOL_VERSION`; explicit old
peer rejection remains unchanged. Historical preflight support is intentionally
limited: an admissible stored definition can still return `NOT_SUPPORTED` from
preflight when its exact trusted validation projection is unavailable.
The shared daemon's artifact method/capability discovery independently requires both
`runs.read` and `artifacts.read`.

## What this checkpoint wires

- Exact SDK server/client/core 2.2.0 dependencies and MCP exports
- Protected retry admission bootstrap, direct admission and authorized receipt RPCs
- Conditional operator read/preflight sources and credential-bound MCP CLI entry
- Revision schemas, protected projection, interpreter hooks and app bridge plumbing
- Protocol 2.0 and `operator-journals-v4`, with coordinated-upgrade documentation
- A durable unique append primitive for the existing per-run event journal: stable
  correlation, sequence CAS, the existing append mutex, file/directory sync before
  success, and reconstruction after an uncertain acknowledgement
- Protected continuation marker projection and a registered `run.continue` service
  whose real journal/runtime adapters remain deliberately uninstalled

`runs.admit` returns the stable authorized `operationId` on every resolved receipt.
The raw client key is never a receipt. The internal `DirectAdmissionResult` and
legacy settled `runs.start` shape remain unchanged.

Capability vocabulary is not proof of implementation. Hello and method discovery
only advertise installed implementations. Revision and continuation services and
MCP mutation fixture callbacks are not installed by this checkpoint.

## Remaining production composition

1. Complete wider continuation lineage cases only after defining and testing their
   exact boundaries; the current production slice deliberately supports roots only.
2. Supply the real `RevisionLog` adapter, protected-input/sensitivity promotion,
   exact reserved destination attempt and conservative delivery recovery; mount
   Attention/inline/CLI consumers only after those boundaries are proven.
3. Add durable Request/direct admission dispatch discovery after daemon restart,
   sharing bounded retry discovery rather than racing independent cursors.
   Continuation discovery is implemented; an in-memory callback alone is still
   not startup discovery. Missing/revoked authority must stay blocked.
4. Add thin authenticated, target-bound MCP mutation endpoints delegating to those
   production services. Preserve their `RetryResult` envelopes; do not alias them
   to flat legacy receipts or claim fixture-backed methods are implemented.
5. Import and review the author fixes; re-run all combined gates on the final head.

The new continuation event projects a decision and dispatch acceptance in one
authoritative marker. Its private material uses the existing execution payload
encryption and keys. An interrupted append is reconciled by stable correlation,
not acknowledged from a sidecar and not answered twice. Fsync failures refuse
acknowledgement; an existing readable marker is re-synced before retry success.
Directory-sync behavior is platform-specific and Windows power-loss guarantees
must not be inferred from the Linux tests.

## Compatibility and refusal behavior

Old clients use closed capability and event schemas. Protocol 2.0 deliberately
rejects 1.x peers rather than presenting these changes as a compatible minor.
New authoritative events also require the store epoch advance. Managed activation
and recovery compare epochs; direct CLI/daemon startup does not enforce that
release marker. Valid unknown events fail old full schema readers; filtered reads
may bypass them. Neither behavior is a safe downgrade strategy.

Stop all writers and retain a consistent complete pre-upgrade store backup and its
matching binary. Restore the whole matching backup for rollback; binary rollback
alone does not undo journal semantics, and work after the backup needs separate
accounting. See [Updating](UPDATING.md).

Answering a stored run whose original workflow definition is unavailable now
refuses before recording an answer. The pending input is preserved. Legacy
pre-versioning runs retain their documented `workflowStored` restoration path;
no missing stored definition falls back to a newly active workflow.

## Evidence and acceptance limits

Initial combined root/renderer typecheck and build passed. The first broad Node
24.19.0 run passed 2,813 tests but failed 36: scripted-agent Unix-socket `EPERM`
blocked most end-to-end cases, and two workflow-definition cases identified the
reserved answer-path regression corrected here. The socket-enabled retry still
encountered that environment limitation. These runs are not green gates.

Focused discovery tests cover absent/partial implementations and all combinations
of artifact/run grants. Focused store tests cover file/directory sync failures,
lost acknowledgement, complete and incomplete tails, stable correlation conflict,
sequence CAS and ordinary append lock sharing. Protected tests reconstruct real
encrypted stores and verify private command omission. Continuation service tests
use explicitly injected journal/runtime fixtures and do not prove production
adapter durability. Protocol tests exercise production handshake code with 1.10
peer envelopes, not historical executable binaries.

Exact-head remote CI, final Node 22/24 tests and coverage, format/lint/design/build,
compiled CLI/runtime smoke, real Electron smoke, independent review, combined
crash/restart acceptance and actual-Cal tests remain required. No threshold,
authorization, key or durability check is relaxed by this checkpoint.

CI #358 found eight protocol-1 fixture failures; the isolated fixture repair in
`ae902c40c976a6c0c3497777102198f324e5cd80` passed all 67 affected tests locally.
CI #359 then passed all 2,886 tests on both supported Node versions, and Node 22
build/compiled smoke. Its sole failure was app Node-side coverage for three newly
wired revision client methods. The follow-up adds 15 focused tests covering those
exact RPC methods; thresholds and exclusions are unchanged. Fresh complete-suite
coverage remains required on the next published head.


## Protected revision adapter checkpoint

Integration owns `packages/engine/src/revision-runtime.ts` and its dedicated
`revision-runtime*.test.ts` coverage, plus the shared claim verification seam.
The adapter reuses the protected run journal and held execution lease. Its
versioned private entries support atomic gate-plus-correction publication, exact
future attempt reservation, sensitivity promotion, replacement CAS and conservative
claim/send accounting. This checkpoint does not yet advertise or mount revision
mutation capabilities: production authority, transport and delivery composition
must pass before activation.

Before each publication attempt, a correlation-only guard is durably written via
the existing protected execution store. It is not acceptance. If that guard exists
but its authoritative marker is absent, recovery is uncertain and refuses to
recreate the answer or deliver the correction. A bound claim with no attempted
publication can still retry. Existing markers must be authenticated and synced
before a cached receipt can be returned, including inspection and reconciliation.
No second authoritative journal or encryption key lifecycle is introduced.

These checks use available local evidence. Coordinated rollback of all guards,
claims and journal records cannot always be detected. They do not establish a
universal exactly-once guarantee; full-store backup and matching-binary rollback
requirements still apply.

The app journal rejects unavailable encryption and Linux `basic_text`; ordinary
Electron launch smoke does not prove encrypted intent restart. Acceptance requires
a usable unlocked OS key store, the same app user-data across restart, recovery of
the same server run, and explicit refusal when encryption is unavailable. Mock
safeStorage tests only establish control behavior.

CI #361 on `3b8910a1b24bfe6ca3b63467cf796fa8c221ddfe` passed both Node jobs,
including Node 24 aggregate coverage and both build/compiled smoke stages. This
is evidence for that preceding checkpoint only. The corrected combined source
passed 303 app tests, 70 focused admission/MCP tests and the separately enabled
`ORCA_RETRY_INTEGRATION=1` HTTP/WebSocket test. Opt-in tests skipped by the default
suite are not counted as acceptance evidence. Fresh exact-head CI and Electron
validation remain required after publication.

The combined review caught and fixed an app/discovery mismatch: authenticated
`operator.discover` now reports the actual installed RPC table filtered by current
grants, including `runs.admit` only when available. Unimplemented MCP mutation
aliases remain absent. The enabled HTTP/WebSocket regression drives discovery,
real admission, retained intent recovery after controller reconstruction, and
viewer omission. The separately enabled ACP retry integration test also passes.

The pre-correction local Node 24 complete-suite coverage attempt ran 3,041 passing tests,
34 failures and 3 skips. Failures remain in source-scripted-agent/demo subprocess
paths with observed tsx Unix-socket `EPERM`; this run is not a coverage gate pass.
Root/renderer typecheck, repository lint/format/design and compiled build/demo
smoke pass. Remote exact-head CI must establish the complete subprocess and
aggregate coverage result.

### Revision delivery ambiguity correction

The first adapter checkpoint (`744c488` local review snapshot) had a reproduced
rewind gap: after a delivered R1's transition markers were removed, replacing the
restored unclaimed R1 with R2 could bypass a revision-specific claim guard. That
snapshot was not activated or published as a branch head.

The corrected guard uses one consumed boundary-version identity across submission,
replacement and delivery transitions. Version-2 metadata binds the run, opaque
destination, current version, exact attempt, configuration generation and workflow
revision. Strict replay checks both consumed historical versions and the current
frontier. Surviving attempt evidence without its advancing marker makes reads,
replacement, reservation and delivery uncertain; it cannot be turned into a new
revision or advertised as safely replaceable. Valid historical advancement remains
usable. Read-only validation of prior version-1 evidence fails closed on malformed
or mismatched metadata; this does not imply a deployed migration history.

Regression evidence covers the confirmed-delivery/rewind/replacement sequence,
including earlier refusal from pending reads, old delivery hooks and conflicting
historical markers. Independent re-review remains an open gate. The runtime and
its current-bound-actor authorization seam remain unmounted until the production
composition and transport checks are complete.


The corrected adapter's 34 runtime, 18 service and 29 receipt-recovery tests pass
on Node 22 and Node 24. The unchanged original reproduction against the corrected
compiled engine refuses replacement with `RUN_STATE` / `revision-publication-uncertain`
and the original operation correlation before any second send. This is implementation
and regression evidence; independent re-review is still open.
