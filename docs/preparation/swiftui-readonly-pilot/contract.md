# Platform-neutral read contract v1

This is a proposed normalized boundary, not an implemented HTTP/RPC API. JSON
Schema draft 2020-12 in [schema-v1.json](schema-v1.json) freezes the review examples.
Swift `Codable`, TypeScript and later Android decoders must consume the same JSON;
no Node/Electron types, Swift enum encodings or Apple notification objects appear
on the boundary. Changes to mandatory meaning require a major schema bump.

## Existing service versus proposed facade

| Proposed operation (names reserved, not registered) | Existing foundation | Required work in #472 |
| --- | --- | --- |
| `GET /mobile/v1/session` | `hello`, `operator.discover`; protocol 2.0, workspace/instance/principal and scope | Enrollment/policy binding, read-only capability intersection, trusted endpoint validation |
| `GET /mobile/v1/runs?status=&cursor=&limit=` | `operator.page` runs/steps/children, bounded projections | Mobile field allowlist, scope-bound page revision and cursor; 50 default / 100 maximum |
| `GET /mobile/v1/runs/{runId}` | Authorized run and step projections | One run using the same `runs` payload (one item) with bounded steps/artifact references |
| `GET /mobile/v1/decisions?cursor=&limit=` | `operator.page` inputs; current live-input lifetime services | Approval summaries without answer values, options or protected revisions; refreshed owner availability |
| `GET /mobile/v1/runs/{runId}/artifacts/{artifactId}` | `operator.artifact`, artifact-to-run authorization | Mobile-safe kind allowlist and inert text projection; no arbitrary path/URL retrieval |
| Foreground read invalidations (transport binding to be agreed in #472) | `subscribe`, run notifications, live `input.invalidated` | Identity-scoped hints, recovery barrier and bounded subscription; raw store-wide stream is not mobile-safe by default |

Implementation sources: [operator contracts](../../../packages/protocol/src/operator-reads.ts),
[server composition](../../../packages/daemon/src/server.ts),
[operator read model](../../../packages/daemon/src/operator-read-model.ts),
[subscriptions](../../../packages/protocol/src/subscriptions.ts) and
[auth](../../daemon-security.md). Existing operator output caps are 100 rows,
256 KiB result and 16 KiB artifact text. This proposal retains those upper limits.
Neither `--read-only` nor `runs.control` alone defines a safe mobile read surface:
even an existing nominal read such as `agents.ping` starts an agent and is excluded.

## Identity, envelope and compatibility

Every successful packet has `schema: {major: 1, minor: 0}`, a `kind`, `context`,
UTC `asOf`, opaque `revision`, and typed `data`. Context binds `workspaceId`,
`instanceId` (daemon boot), `principalId`, `enrollmentId`, `policyRevision`.
UUIDs in the fixtures are invented; principal/enrollment/revision strings are
opaque locators, never credentials or authority. The server derives context from
the verified session, never caller actor fields. The phone compares it with the
already trusted enrollment and current session before rendering or caching.

Session data declares daemon protocol, exact available read capabilities,
`mode: read-only` and agreed visibility (`owned` or selected-workflow `all`).
Read operations require their capability, compatible schema major and daemon
protocol major 2. Additive minor/unknown fields may decode but are discarded before
display, logging or persistence; the producer must emit only the v1 allowlist.
Unknown kind/status/authority enum, missing required field, unexpected null or
incompatible major fails closed for that payload. Unknown capabilities never
enable code paths. Session advertising write mode is rejected. No version check
substitutes for server authorization. The schema is a consumer schema, allowing
additive fields; the validator separately verifies canonical fixture allowlisting.

Reject invalid UTF-8, duplicate JSON keys, nonfinite/fractional/out-of-range
integers, oversized packets and excess depth before model construction. Maximum
depth is 16, decoded response/frame size 256 KiB, text UTF-8 bytes 16 KiB, ID length
512 characters, summary 500 characters, page 100 rows; cap bytes before parsing
and before decoding compressed content. Sequences are integers no larger than
`9007199254740991` for cross-language safety. Timestamps inform presentation only.
Client observation generations and request tickets are local test-harness metadata,
not server-issued revisions and never authorization guards.

## Projection rules

| Payload | Required meaning |
| --- | --- |
| `runs` | Stable run ID, workflow ID, canonical status, bounded safe title, update time, per-run `observedSeq`, bounded steps and artifact references. Detail uses the same object. `items`, opaque `nextCursor` (null at end), `truncated`, `restartRequired`; no total unless independently supported. |
| `approvals` | Exact run/step/input ID and `durable`/`live` lifetime; observed `pending`/`answered`/`expired`, safe summary, owner availability (`available`/`unavailable`/`unknown`), evidence completeness and references. `requestId` here is a human-input ID, not a top-level Request. No option IDs, answer text or reusable live decision target is needed by a viewer. |
| `artifact` | Run, step, artifact ID, content revision, media type, text or omission. `available` requires text; `redacted`, `missing`, `binary`, `tooLarge` prohibit text. `truncated` is explicit and cannot mean complete evidence. Missing/denied resource distinctions are returned only after authorization. |
| `connection` | Local adapter fixture, never an authoritative server grant: canonical connection state, `fresh`/`stale`/`none`, last successful read time or null, sanitized reason. Repeated receipt of a connection event does not refresh a snapshot. |
| `invalidation` | Collection, nullable run ID/seq, sanitized reason. Run `seq` means source event position, not projection revision or a global cursor. No content patch is trusted as complete evidence. |
| `error` | Sanitized fixed code and retryable flag; no raw message, stack, path or server response. Context is nullable only when identity could not be verified; then discard prior protected content for denial/mismatch. |

Titles/questions/artifacts use approved public sensitivity projections only.
Unknown secrets cannot be proven absent merely by a scrubber: #472 must define
eligible artifact kinds and field provenance. Do not send launch vars, private
prompts, config, raw output/tool arguments, absolute paths or internal errors.
Artifact text containing HTML, Markdown images or URLs remains literal text. No
remote fetch, executable content, data URL, URL-selected host or automatic link
navigation. Fetch evidence by authorized run/artifact IDs only. Display omitted
context explicitly; a phone cannot assert that a decision is safe to make.

## Recovery and cache algorithm to implement

1. Keep a session generation and per-resource request ticket. Increment on
   foreground recovery, reconnect, identity/policy change or invalidation that
   supersedes a read. Cancel old work; cancellation alone is insufficient. Accept
   a response only for its current ticket/generation and verified context.
2. Establish an authorized foreground invalidation feed before reading snapshots,
   buffer bounded hints while reads are pending, and reread any family invalidated
   during its read. #472 must prove this subscribe/snapshot barrier over its chosen
   transport. If unavailable, advertise snapshot-only reads, explicitly mark them
   last observed, and refresh on user action/foreground. Do not claim live convergence.
3. Track observed sequence independently per run. Duplicate/lower hints can be
   discarded after a snapshot covers them. Any sequence greater than the snapshot
   watermark invalidates that run; a gap forces a fresh run and approval read.
   Numbers need not be adjacent in a filtered/coalesced feed: gaps are conservative
   recovery triggers, not proof of dropped events. Never compare two runs' seqs.
   Notifications for an unknown authorized run trigger one scoped fetch plus a
   membership refresh, not blind insertion of private frame content.
4. A newer hint invalidates an outstanding snapshot even if its response arrives
   last. Do not overwrite newer data with older `observedSeq` in the same boot.
   Opaque revisions compare for equality only. `input.invalidated` has no cursor:
   invalidate approvals and reread. A same-workspace boot change resets cursors and
   requires fresh discovery and snapshots; prior live asks cannot survive as current.
5. On recovery, reread Runs and Attention regardless of cursor replay: new/deleted
   runs, scope changes, ephemeral asks and lapsed leases may not be represented by
   replay. A lease-stale run only comes from a read. Do not infer it from quiet output.
   Mark snapshot freshness stale after 60 foreground seconds without a successful
   read (proposed UI policy); this does not schedule polling or change run status.
6. Bind page cursors to identity, policy, filter and revision. On `restartRequired`
   discard pagination state and refetch page one; do not append across revisions.
   Coalesce hints into one in-flight read per family and at most one follow-up;
   buffer at most 100 hints, overflow forces a full refresh. Foreground retry uses
   bounded backoff (1, 2, 5 seconds, then at most every 5 seconds); stop in background
   or on denial/mismatch. No periodic list polling or promise of a background socket.

Proposed pilot cache: in-memory summaries by default; optional protected on-device
summary cache capped at 100 runs + 100 approvals and 1 MiB total, expiring 15 minutes
after local receipt. Evict oldest first, never extend TTL on failed reads. Clock
rollback/reboot with uncertain age invalidates disk cache. Artifact bodies stay
memory-only and are dropped on background. Cache keys include workspace, principal,
enrollment and policy; boot is tracked separately. Background immediately covers
app-switcher content; unlocking does not itself establish freshness. Logout or
known revocation cancels reads and purges eligible cache; mismatch quarantines it
from rendering then removes it. Offline revocation cannot reliably erase data, so
minimization, expiry and device protection remain necessary.

Later implementation must use iOS Data Protection for cached files, exclude them
from backup, and keep credentials in passcode-bound device-only Keychain storage
with an explicit user-presence policy. No secret, raw error or response payload
in logs, URLs, analytics or crash evidence. These are proposed retention/security
defaults for owner review; this preparation creates no cache or credential.

## Server-enforced read-only acceptance

#472 must enforce enrollment and operation/resource policy at every accepted
transport, including raw `/rpc`, `/socket` and any operator adapter reachable with
mobile credentials. Deny before disclosure/effect, including revocation during an
await and active-session revocation. No broad owner token behind the facade.
Default deny every operation outside the read allowlist: answer, start/admit,
cancel, continue/resume, reconcile, revision, standing grants, config/plan writes,
agent spawn/ping, lease/claim maintenance, enrollment administration and unknown
methods. Notification registration is a separate scoped lifecycle operation owned
by #475, not a general mutation grant to the monitoring client.

Required future evidence: authenticate an isolated synthetic device principal;
attempt every mutation family through facade and direct backend paths; verify
denial and unchanged durable journals/config/grants/leases plus no spawned process.
Repeat with write-looking capabilities, wrong workflow/owner, artifact substitution,
rotated/revoked credentials and revocation during suspended reads. UI absence and
the fixture's `mode` are not this proof. Read-only completion never waits for the
later #474 command receipts and never enables a send-once command experiment.
