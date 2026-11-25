# Runtime foundation integration

This integration combines the three independent branches without changing their feature
branches or merging them into `main`:

- Preparation: `c7f71ea4f3c4e618fef577563eb7ceece0fae143`
- Builtin node validation, #370 / #314: `ef55358baae0e8944e2c321bc54933eb12f06c18`
- Typed inputs, #364 / #330: `d756c962562c853cc1de578bce24c198c2f22d15`
- Authentication, #368 / #328: `4e90e4af8aea2a0fe6b79c97ebafbe4db935fcdb`

The [parallel ownership contract](runtime-foundation-parallel-contract.md) remains the
history of the independent slices. This document describes the shared wiring that makes
those slices usable together. The proposed patch in `docs/patches/328-control-integration.patch`
is historical handoff material; do not apply it again over this integration.

## Admission and discovery

Protocol 1.9 registers `workflows.validateInputs` only when the daemon has its model. The
model resolves through the same `Orchestrator.selectDefinition` as admission. The method
is side-effect-free and available in read-only mode, but its authorization still requires
`runs.start` and access to the selected workflow. `hello.methods` and the
`workflows.validateInputs` capability are filtered by that authority.

The transport authenticates and checks operation authority before parsing method params;
the resource guard runs before workflow resolution and input validation. Preflight returns
only `{workflowId, version, revision, validation}`. It never returns resolved vars. Pass
both `version` as `workflowVersion` and `revision` as `expectedWorkflowRevision` to
`runs.start`. The control model forwards both. A stale digest fails before admission
writes. An explicit old version selects the persisted version, not a newer loaded one.

The CLI exposes `--workflow-version` and `--expected-workflow-revision` on `run`, `submit`
and the root workflow of `plan dispatch`. These do not pin every child to the root's
revision. Existing `--var key=value` retains its JSON-if-possible parsing and string
fallback. `--var-json key=JSON` requires valid JSON and wins over the same key in `--var`;
use a quoted JSON string when a numeric-looking value must stay a string.

`ProgramService.submit` builds the candidate Request in memory and calls the same
side-effect-free admission routine before writing it. The subsequent `startRun` is pinned
to that definition and rechecks admission. This prevents deterministic invalid input or
stale-guard failures from leaving a Request behind; it is not a distributed transaction
across the Request and workflow stores if the files change concurrently or I/O fails.

## Local authentication and clients

`orca serve` uses token mode by default. It opens `<configDir>/auth`, bootstraps a fresh
local-owner token and prints its file path, never the token. `--unauthenticated-loopback`
is the explicit compatibility option and cannot be used for a remote bind. Remote token
mode requires the configured trusted TLS proxy policy. Repeated `--trusted-proxy` and
`--allow-origin` flags supply that policy; forwarded headers do not establish identity.

CLI daemon calls, the app's main process and the update supervisor use
`ORCA_DAEMON_TOKEN`, an explicit `ORCA_DAEMON_TOKEN_FILE`, or loopback-only local discovery.
Automatically discovered local-owner credentials are not sent to remote addresses.
Credentials do not go in URLs and clients do not follow credential-bearing redirects.
Remote bearer transport requires TLS. HTTP uses `Authorization: Bearer`; WebSocket uses
`orca.v1` and `orca.bearer.<token>` subprotocols. The renderer never receives the token.

File-backed clients refresh once after `AUTH_INVALID`; the app handles close code 4401
as an immediate authentication failure rather than the ordinary five-second connection
blip. Explicit environment tokens do not auto-rotate. A daemon refusal does not cause
`orca ping` to bypass authorization by starting the agent in-process. The supervisor's
maintenance admission token remains distinct from its authentication credential.

`orca auth issue|list|rotate|revoke` manages credentials in the workspace auth directory.
Issue/rotate print a new token once; list prints safe metadata. Bootstrap credentials are
rotated by restarting the daemon, so CLI rotation cannot race its token-file publication.

## Attribution and standing decisions

The auth wrapper supplies a server-bound, per-invocation ownership callback. Control calls
it with the actual newly admitted run ID and waits for durable ownership before execution.
There is no global first-matching `run.created` listener. Interleaved direct starts cannot
acquire another caller's identity. Verified principal/credential IDs are also recorded on
`run.created`, `human.answered` and explicit `run.cancelled` events; caller-supplied actor
fields are not accepted as identity.

An `always` answer first checks grant prerequisites without writing. The engine acquires
the exact run's answer lease, rereads the durable gate, validates its pending state and
option, then appends the accepted answer. Only then, under that same lease, is the
standing rule saved. Automatic resume happens afterwards. Stale, invalid, mismatched,
lease-denied or failed-event-append decisions do not write a rule.

The event log and sidecar are separate stores. If the sidecar write fails after acceptance,
the one-time answer remains recorded and the run remains parked. The RPC error explicitly
includes `answerRecorded: true`; it does not silently resume or claim a standing grant.

## Sensitive execution state

Authoritative sensitive launch inputs and secret-bearing event payloads are kept in
authenticated encrypted, owner-only private execution records, separate from public run JSONL. Public events carry
opaque payload references where needed; only the interpreter hydrates originals. A
persisted marker makes missing/corrupt private input material fail closed on resume.
Public run reads, event reads, artifact metadata/text, live/replay notifications and execution
logger output use sanitized projections. Children inherit sensitivity even when their own
definition accepts inherited vars without declaring them. Child-only sensitive values are
propagated upward before exact child results return; encrypted append-only sensitivity
records preserve parent execution semantics and are integrity-bound to protected payloads.

New immutable workflow snapshots use owner-only `private-workflows`; legacy workflow
snapshots remain readable. Keep private execution records and protected snapshots in a
trusted backup together with run history; a public event-log export alone is not a
self-contained resumable backup. Never share the private directories as diagnostic logs.

Records use AES-256-GCM with filename-bound associated data; copying ciphertext without
keys does not disclose values. This does not defend against the daemon account or root,
which can access both keys and records. Known sensitive literals and structured values are masked in public free-form
payloads; arbitrary transformations, encodings and fragmented agent output are not general
taint tracking. Prefer secret references and avoid putting secrets in identifiers or
workflow prose. Previously persisted plaintext legacy logs are not retroactively rewritten. Histories whose
persisted definitions already declare sensitive inputs are withheld from public reads,
replay and further appends until explicit migration. Ordinary legacy runs and the historical
no-snapshot fallback remain supported; undocumented secrets in unschematized historical
logs cannot be identified automatically. See [protected storage](protected-execution-storage.md).

The release store epoch is `protected-execution-v2`. Older releases do not understand
private payload references or private workflow snapshots, so automatic activation/rollback
across the previous epoch is refused. Stop every writer, back up the complete store and
auth directory with owner-only access, and use the documented supervised migration path.
Do not resume protected runs with an older binary. Each private directory has a distinct hidden `.execution-key`; keys are created exclusively
and are never regenerated over existing ciphertext or automatically rotated. Complete
backup/restore must preserve both private directories and their keys as a unit. A pre-upgrade backup is required
for rollback to a pre-integration binary.

## Verification

The integration adds transport-level authorization/preflight/start tests, exact-run
attribution under interleaving, rejected/concurrent standing-decision tests, private
storage/resume/public-projection tests, authenticated CLI/app/reconnect tests and
supervisor coverage. See the integration PR for the final exact-head command results,
coverage, CI and Electron smoke status. Feature-only CI is not combined acceptance.
