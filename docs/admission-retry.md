# Retry-safe admission (#331)

This is the feature handoff for issue #331 against the frozen preparation commit
`9058fa8935ae4c999293727c005031eec93114be`. The feature branch contains the allocated
modules and three existing exclusive edits. Shared bootstrap, protocol, auth,
adapter and export changes are supplied separately in
[`patches/331-operator-integration.patch`](patches/331-operator-integration.patch).
They are not applied to this branch. This document does not claim production
capability discovery or combined operator release acceptance.

## Intent and receipts

An optional `idempotencyKey` identifies one submission intent. Its scope is the
verified principal ID, persistent workspace ID and logical operation. Credentials,
sockets, daemon boots, ACP sessions and transport choice do not change that scope.
`runs.start` and `runs.admit` share `run.admit`; Request submission uses
`request.submit`. Revision and continuation owners register the closed kinds
`revision.submit`, `revision.replace` and `run.continue` on the same facility.
Registration is trusted server composition, never a client callback/RPC name.

Retain the exact key and command across timeouts and reconnects. A different
command under that key raises `RETRY_CONFLICT` without another admission. A new
intentional run uses a new key. Omitting the key retains non-deduplicated behavior,
while still creating a server journal when the shared facility is configured.
An operation ID or admission ID is a correlation, not an authorization token.

`RetryResult<T>` distinguishes a recorded result from bounded `in-progress`
contention. A recorded result can itself be `prepared` or `recoverable-failure`;
only its inner `accepted` state promises durable work admission. Admission is not
completion, execution attachment, or exactly-once external tool effects.

`requests.submit` preserves its existing Request response. The approved wire
`runs.admit` response is `DirectAdmissionResult & { operationId: string }`.
Every prepared/accepted/recoverable-failure receipt includes that stable authorized
reference for `admissions.get/reconcile`. In-progress remains a typed `RUN_STATE`
error carrying operation ID and `inspect-or-retry`, never fabricated acceptance.
No raw client key is returned. Internal direct signatures and legacy `runs.start`'s
settled response remain unchanged.

Optional `runs.admit.expectedScope` contains verified `principalId` and persistent
`workspaceId`. The daemon checks current authority and compares both before any
admission effect. It is a guard, not authority, and is removed before canonical
intent comparison. Credential IDs and transient daemon instance IDs are excluded.

## Comparison and limits

Comparison uses validated intent, never newly captured configuration defaults.
Missing `vars` means `{}`. Object keys sort recursively; array order, explicit
selection guards, text and Unicode remain significant. Request title validation
retains its existing trim behavior for the Request document; the retry comparison
preserves the caller's title bytes. Optional top-level TypeScript fields may be
omitted. Nested undefined, nonfinite numbers, cycles, sparse arrays, accessors,
nonplain objects and unknown schema fields are refused. Source/label/selection
values participate in comparison; changing them is different intent.

Keyed input limits are 1–128 UTF-8 bytes for the opaque key, 256 KiB for the
canonical command and nesting depth 32. Revision payloads additionally have a
64 KiB ceiling. Workflow validation may impose tighter constraints. Inputs are
not truncated or split. Unkeyed legacy command size limits remain unchanged.

The store accepts resolved positive integer quotas: 100,000 retained claims per
workspace and 10,000 per principal by default. The reserved patch exposes
`admissionRetry.maxClaimsPerWorkspace` and `maxClaimsPerPrincipal` through the
existing configuration boundary; changes require runtime restart. At quota,
new allocations raise `RETRY_LIMIT`; existing replay, inspection and reconciliation
remain available. Bound/ambiguous claims count too. No claim expires, is evicted,
or automatically releases a key. Storage grows with retained intent; each phase
uses immutable protected snapshots, and failed publication can leave protected
orphans. Identical repeated resolution does not write another snapshot.
Explicit compaction/tombstones remain [#399](https://github.com/cschadewitz/Project_Orca/issues/399).

## Persistence and failure ordering

`FileRetryClaimStore` reuses `ExecutionStore` and its protected-execution key.
Canonical command, comparison bytes, binding, receipt and key lookup mapping are
protected generation records. A protected random lookup salt makes public/index
names opaque; there is no independent encryption key, secret-bearing public
payload fingerprint, or raw client-key path. Missing retained lookup salt fails
closed instead of allocating a new lookup namespace.

One short cross-process catalog lock accounts quotas and reserves an operation.
A write-ahead catalog entry repairs interrupted publication of its ordinal,
operation pointer and protected key mapping before another allocation. Public
metadata holds opaque references and counters only. Immutable protected material
is durable before its pointer; file and containing-directory synchronization
precede acknowledgement. The operation mutex covers binding, admission effects
and result publication. Existing file-lock rules never steal a live or unknown
owner by age. A contender waits at most the configured lock budget (100 ms by
default), returning the same operation's `in-progress` receipt when known. An
empty/unknown lock left during lock publication is a typed lock refusal and needs
existing lock recovery; it is not evidence of a new admission.

`RetryContext.bind` is a write-once durable CAS: identical repeats succeed,
changed target bindings conflict. The context expires when its mutex exits;
pending binding writes drain before the lock is released. Only a fresh claim
calls `prepare`; an interrupted bound claim calls its registered `recover`.
An interrupted *unbound* claim stays `in-progress` rather than capturing newer
defaults. No callback or original credential is serialized as reusable authority.

Request preparation binds the admission and Request IDs before the existing
protected Request preparation. Recovery can reconstruct a lost admission index
from that sealed preparation. Providers exposing reserved run identities also
preallocate the program root; its recovery reads that exact root. Older admissions
retain their existing protected-correlation recovery. Request, ownership, root
link and accepted index ordering remain one Request lifecycle.

Direct preparation captures and validates the exact workflow and generation,
binds preallocated admission/run IDs, and seals its launch material. The reserved
orchestrator patch uses the reserved run ID and authenticated `directAdmissionId`
creation metadata, outside workflow vars. Recovery checks that exact creation
record and its original associations before finishing ownership and acceptance.
It never fabricates a Request. The existing execution lease remains independent.

If private run inputs exist without a committed creation event, workspace
provisioning may already have happened. Reconciliation returns the same reserved
IDs with `recoverable-failure`; it does not provision again. Missing protected
preparation/generation also fails closed. A failure after `run.created`, ownership,
root-link or acceptance publication reconciles the original work. Full-store
backups and matching binaries remain required for rollback; partial index or
protected-store restoration is not supported.

## Authority and execution

Every operation rechecks current authority before validation, replay and response.
Request replay additionally checks the resolved original workflow, even if the
active program default changed. Another principal/workspace cannot inspect a
receipt by guessing its ID. Direct admission requires `runs.start` and the
existing association grants; Request submission also needs workspace `plan.write`.
Credential rotation preserves principal scope, but revocation is effective now.

The daemon schedules execution only after durable acceptance and exact ownership.
A replay never automatically re-drives a terminal, parked or already-started run.
Automatic attachment checks for a sole `run.created` event and absence of a lease;
the execution lease closes the subsequent race. Explicit reconciliation checks
current resume authority when renewal/attachment is required. An expired original
execution credential is never replaced with the daemon owner's credential.

Accepted receipts are durable dispatch references even if their in-memory callback
is lost. `batch()` visits at most 100 indexed records and advances a durable circular
cursor; no full ledger scan occurs per discovery call. Startup dispatch orchestration
and receipt presentation belong to combined runtime wiring. Until a valid current
execution context is available, authorized inspection and `runs.get` distinguish
admitted work from work that has attached; explicit existing-run continuation stays
with the integrator-owned continuation service. Receipt reconciliation does not
silently resume an already-started run.

## Adapter handoff and remaining acceptance

The reserved patch wires the production ledger, Request/direct services,
`runs.admit`, `admissions.get/reconcile`, current credential factories, grants,
capabilities and legacy `runs.start`. It supplies CLI `--idempotency-key`; generated
keys are printed before submission for reuse after process loss. Keyed local
explicit workspace/selection overrides are refused because the frozen direct
command does not carry those options. Their unkeyed legacy path is preserved.

ACP Request callers retain `orca/idempotencyKey` in prompt `_meta` across retries.
Keyed Request provenance uses a stable API source, so reconnecting with a new ACP
session does not change the command. Unkeyed prompts keep legacy session provenance.
The frozen direct command cannot represent ACP session workspace/selection; keyed
ACP direct prompts explicitly report unsupported and point to `runs.admit`.
The app palette uses a main-process encrypted journal, persisted and flushed before
admission. It consumes the already-defined `operator.discover` authenticated
principal/workspace projection; this standalone feature supplies only structural
consumer fixtures and its reserved wiring, with no peer-branch import. Main captures
the client and fences connection epochs before and after discovery/admission. The
server also checks `expectedScope` before effects. Endpoint, stable principal and
workspace scope survive credential rotation, renderer loss and daemon restarts;
bundled targets use their stable local workspace identity rather than a temporary port.

A palette record saves only workflow ID, local intent ID, random retry key, stable scope
and retained state; no credential, arbitrary workflow vars, or secret command payload.
A guided-launch record in the same journal also saves its reviewed submitted command,
input vars and Request text included. Electron safeStorage encrypts the journal;
unavailable keychains, Linux `basic_text`, corruption and decryption errors refuse
admission, with no plaintext or in-memory fallback. No key is auto-expired or silently
replaced. An explicitly abandoned intent is dropped at the next write, since nothing
reads it again; at 1,000 retained intents the journal refuses further allocation, and
says so, until one is recovered or abandoned. Full app-data plus matching OS keychain
recovery is required if lost.

“Start or recover a run” always reuses a retained intent, including after an accepted
response, so crashing before the renderer opens the run does not create new work.
“Abandon retained run intent” asks for explicit native confirmation that the original
run may still exist/running, is not cancelled, and the next start creates separate work.
Cancelling preserves the old intent. Confirmation rechecks current authentication and
scope; generation fencing prevents a previously queued retry from becoming new work
after abandonment or a late result navigating away from a newer intent. The journal
is owned by the single-instance Electron main process, never renderer localStorage.

Headless Linux without a secure keyring and macOS with an unavailable keychain have a
tested blocked state; no runner image/security settings are changed. Electron end-to-end
smoke must distinguish that refusal from successful durable admission, and remains a
combined-head integration gate.
MCP production consumption, revisions and continuations belong to #327/#356 and
the parent integration task, not this branch.

Clients must check capability/method discovery before relying on retry support:
older `runs.start` schemas may ignore unknown fields. The feature-only schemas
and optional constructor seams must not be advertised as wired capabilities.

Feature tests exercise file-backed claims, separate process races and owner death,
conflicts, revocation, quotas, JSON limits, binding CAS, escaped contexts, lost
acknowledgements and Request/direct recovery. Tests gated by
`ORCA_RETRY_INTEGRATION=1` exercise real bootstrap/HTTP/WebSocket/legacy-start/ACP
wiring in an isolated checkout with the named patch applied. They deliberately
skip on the feature branch. Final merged Node 24 coverage, compiled smoke,
Electron App smoke, peer-story acceptance and independent review remain the
integrator's exact-head gates; feature checks do not substitute for them.

## Handoff verification

On this feature checkout, typecheck, lint, formatting, design generation checks
and build passed. The final focused retry suite passed all 21 tests on Node 22
and Node 24. The shared patch passed `git apply --check`; its isolated checkout
compiled and passed the real HTTP/WebSocket and ACP integration tests. A compiled
CLI smoke launched a start/end workflow in two separate processes with one key:
both returned the same completed run and the store contained exactly one run.

The broader Node 24 suite passed 2,762 tests but timed out in the reusable demo
setup; the demo's four tests passed when rerun alone. The Node 22 coverage run
passed 2,762 tests but timed out in demo setup/tests and the 10,000-event timeline
test. Neither broad invocation is a clean full-suite gate, and no coverage pass
is claimed. Electron smoke was not run. The integrator must rerun the required
checks on the combined head, including these timing-sensitive tests.

## Review correction validation

The review correction adds secure durable palette intent retention, an explicit
abandon/new-intent boundary, authenticated scope fencing and receipt result schemas.
Focused tests cover reconstructed process/renderer ownership, lost acknowledgement,
concurrent retries, credential rotation/revocation, changed principal/workspace/target,
corruption, missing secure storage, Linux plaintext-backend refusal, cancellation,
confirmation-time authority changes and delayed-discovery/abandon races.

Validation is performed in an isolated exact-head checkout with the reserved patch
applied, then the shared-file edits are removed from the published feature source.
The feature source contains the approved new app helper and prefixed tests; shared
main/preload/bridge/palette/auth/exports remain only in the reserved patch. Actual
OS-keychain encryption and real Electron launch are not claimed by injected-backend
unit tests. Final combined-head CI and Electron smoke remain integrator requirements.

Local correction checks: patched focused Node 22 and Node 24 each passed 57 tests;
app/protocol/HTTP wiring passed 315 tests; unpatched feature tests passed 37 with the
two wiring-only cases intentionally skipped. Root/renderer typechecks, TypeScript
build, patched Vite renderer build, ESLint/CSS, formatting and design checks passed.
The patched app-only Node coverage run passed existing gates at 99.37% statements,
99.16% branches and 100% functions/lines (269 tests). Main-process files are excluded
by the repository's existing coverage configuration, so this is not a journal coverage
percentage. A full coverage attempt encountered sandbox Unix-socket EPERM in ACP
subprocess tests; no full-suite coverage pass is claimed.

Real encrypted Linux smoke requires an available/unlocked supported secret-service
backend in the runner's desktop session, after Electron ready. A display alone is
insufficient; `basic_text` or `--password-store=basic` must not be accepted. Real macOS
smoke requires accessible Keychain and consistent app identity. Preserve the same app
user-data and keychain between restart attempts. Existing daemon-RPC smoke fixtures
bypass the palette journal and cannot substitute for that explicit scenario. See
[Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).

An accepted keyed replay can survive retry-catalog acquisition contention. Only when
the catalog mutex times out before its callback runs, the file store performs a
read-only lookup using the existing protected salt and scoped-key mapping. It must
find a validated accepted record; missing, invalid or unfinished records retain the
original timeout. The lookup never creates, repairs or recovers catalog state. The
engine still reauthorizes, compares canonical intent, acquires the original operation
mutex, reloads the record and validates the durable receipt. Operation-mutex
contention retains the existing `in-progress` response.
