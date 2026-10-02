# Operator integration checkpoint

This is the shared integration of the three parallel handoffs, not production
acceptance of #331, #356 or #327. No main merge, release, deployment or actual Cal
connection is included.

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
The authors retain their feature-owned fixes. At this checkpoint their outstanding
review findings are revision auto-selection, restart-persistent palette intent,
MCP captured-definition preflight consistency and artifact discovery grant conjunction.
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

1. Compose continuation boundary issuance, protected entry validation, a rebuildable
   receipt-to-run discovery index, exact decision plus accepted dispatch commit,
   current-authority recovery and leased attachment. The sidecar is never authority.
2. Supply the real `RevisionLog` adapter, protected-input/sensitivity promotion,
   exact reserved destination attempt and conservative delivery recovery; mount
   Attention/inline/CLI consumers only after those boundaries are proven.
3. Discover durable Request/direct/continuation dispatch after daemon restart in
   bounded batches. Accepted storage plus an in-memory callback is not startup
   discovery. Missing/revoked authority stays blocked; no daemon-owner fallback.
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
