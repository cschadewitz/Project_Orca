# Proposed v1 data contract

**Review profile only.** [schema-v1.json](schema-v1.json) is a closed JSON Schema
2020-12 document. Every object rejects additional properties, every declared property
is required, and `schemaVersion` is exactly integer `1`. Reject unsupported versions;
never silently downgrade, strip unknown keys from a received candidate, or serialize an
error while reporting rejection. A future incompatible field/enum change needs a reviewed
schema version. The schema identifier is a local URN, not a fetch endpoint.

## Exact fields and meaning

| Field | Type / allowed values / bounds | Source and unknown rule |
| --- | --- | --- |
| `schemaVersion` | Integer `1` | Proposed format, not protocol or store version |
| `reportId`, `sessionId` | Lowercase UUIDv4, exactly 36 ASCII bytes each; distinct | Independent CSPRNG values newly generated for each preview snapshot, including retries. Session ID names this collection session only, never an agent session/daemon boot. No cross-report identifier survives |
| `mode` | `one_shot`, `rolling_snapshot` | The particular consent that authorized this snapshot |
| `windowMs` | Integer 0–86,400,000; one-shot maximum 60,000 | Actual monotonic window represented; not wall time or the age of a run. Unmeasurable window aborts preparation |
| `versions.app`, `versions.daemon`, `versions.osVersion` | `unknown` or three dot-separated decimal components, each 1–5 digits; maximum 20 characters | Verified app metadata, authorized current handshake projection, and a typed OS version API, respectively. No prerelease/build labels, distro names, command output or coercion. A source that does not exactly fit stays `unknown` |
| `versions.buildRevision` | `unknown` or exactly 40 lowercase hex characters | Only a verified public release source revision from sealed candidate identity; no worktree/private-project SHA, branch, pipeline URL or host build ID. Syntax alone cannot prove provenance |
| `versions.appProtocol`, `versions.daemonProtocol` | `unknown` or closed `{major, minor}` object, each integer 0–65,535 | Compiled app protocol; current authenticated daemon observation. No fabricated daemon protocol before handshake |
| `versions.storeFormat` | `config-generations-v3`, `unknown` | A safe, authorized compatibility observation only; packaged expected epoch does not establish actual store state. No diagnostic store traversal to discover it |
| `versions.os` | `darwin`, `win32`, `linux`, `unknown` | Platform API; no OS marketing name |
| `versions.arch` | `arm64`, `x64`, `unknown` | Actual app process architecture; does not identify CPU model or prove native execution |
| `snapshot.connection` | `live`, `reconnecting`, `disconnected`, `mismatch`, `file`, `unknown` | Connection owner's current typed state; not inferred from an arbitrary failed call |
| `snapshot.authentication` | `accepted`, `required`, `invalid`, `forbidden`, `unknown` | Authenticated current handshake or recognized typed auth refusal; never token/header data |
| `snapshot.admission` | `accepted`, `uncertain`, `recoverable_failure`, `unknown` | Typed authorized admission outcome. These are diagnostic categories, not a copy of admission records |
| `snapshot.resume` | `succeeded`, `failed`, `unknown` | Outcome of an already user-requested resume; diagnostics never resumes work |
| `snapshot.protectedState` | `available`, `unavailable`, `unknown` | Explicit typed observation already produced by normal execution; never open/decrypt/test keys for diagnostics |
| `evidence.handshake`, `evidence.admissionObservation`, `evidence.resumeObservation`, `evidence.protectedStateObservation` | Boolean or `unknown` | `true`: a safe current observation is available; `false`: producer knows none is available in scope; `unknown`: cannot establish presence. Never probes excluded files. Presence does not mean success |
| `entities` | Array of 0–64 closed `{alias, kind}` objects | In-memory remapping only; `kind` is `run`, `step`, `admission`; alias is `e1`–`e64` (1–3 characters), unique across all kinds in this bundle |
| `events` | Array of 0–256 closed events; one-shot maximum 32 | Only safe events after relevant consent, in nondecreasing `offsetMs` order; no raw event-store scan |
| `events[].offsetMs` | Integer 0–86,400,000, no larger than `windowMs` | Monotonic milliseconds relative to beginning of represented window; not persisted wall-clock dates |
| `events[].phase`, `events[].code` | Fixed enums in [failure mapping](failure-mapping.md) and schema | Phase/code combinations checked by schema; phase `unknown` only permits code `unknown` |
| `events[].entityAlias` | `unknown` or `e1`–`e64` | Must refer to an entry in `entities`. Unavailable identity is `unknown`; overflow drops events instead of exporting original IDs |
| `omissions.unavailable`, `omissions.invalid`, `omissions.budget`, `omissions.expired` | Integer 0–65,534, `at_least_65535`, or `unknown` | Counts of safe candidate observations omitted for that single reason; saturated at 65,535. No byte counts or inventory of excluded private sources |

Missing required properties, `null`, numeric strings and invented defaults fail validation.
A required but unavailable fact is explicitly `unknown`, not `false`, zero, or “healthy.”
Empty arrays mean no safe observations included, not that no failures happened. Known
snapshot outcomes for admission/resume/protected state require the corresponding evidence
flag `true`. Without handshake evidence `true`, daemon version/protocol, store format and
protected-state snapshot must remain `unknown`, protected-state observation cannot be
`true`, and authentication cannot be `accepted`. Handshake evidence is necessary for
these store claims but does not itself supply them or authorize a store read.
Event observations describe their own instant, so a historical
resume failure can coexist with a current unknown snapshot.

Alias assignment uses observation order inside one bundle, with a private in-memory map
that is discarded with the preview. Do not derive IDs from user, workspace, hostname,
PID, admission, run or path hashes. Predictable hashes are reversible by guessing and
stable hashes permit correlation. Known source IDs can be looked up in the ephemeral map
at the producer boundary, but neither the map nor IDs enter retention/export. Rolling
storage uses its own random, retention-scoped references and remaps again per export.
No correlation with another report is promised or required.

## Proposed budgets (not policy approval or measurements)

| Resource | Exact proposed ceiling | Overflow/failure behavior |
| --- | --- | --- |
| Export file and candidate parser input | 262,144 bytes (256 KiB), uncompressed, including all JSON whitespace and final LF | Reject before parsing beyond limit; never compress/archive to bypass it |
| One-shot | 32 safe events, at most 60,000 ms from explicit consent, one immutable snapshot | No pre-consent history. Ends on snapshot, cancel, error or deadline; no automatic repeated sampling |
| Rolling | 2,097,152 bytes (2 MiB) total diagnostic storage, including metadata, ciphertext, encryption overhead and temporary diagnostic files; at most 2,048 safe events | Reserve housekeeping space inside ceiling; evict oldest safe events/drop new observations with visible budget omissions. If enforcement is uncertain, stop capture |
| Rolling time | 86,400,000 ms (24 hours) maximum per consent session and per retained event | Expire and revoke key. Restart is off and discards old buffer; no automatic carryover |
| Export from rolling | Latest at most 256 eligible safe events within preceding 24 hours | Deterministic newest-window selection, oldest-first serialization; omission count for excluded eligible events |
| One safe event | At most 512 serialized ASCII bytes before retention | Reject oversized safe observation; never truncate strings to make them look safe |
| JSON nesting | At most 12 simultaneous object/array containers, checked before parsing | Reject independently of the parser's implementation limit; braces inside strings do not count |
| Aliases | 64 in an export; at most 2,048 retention-local references in rolling storage | Bound map as well as array; drop safe events and count budget omissions |
| Preparation/projection/validation/scan | One 2,000 ms total active deadline per attempt; input also byte/event bounded | Abort and revoke one-shot grant on exception/hang; no export/raw fallback. UI time spent reading is excluded |
| Ready preview | Maximum 600,000 ms (10 minutes), also bounded by consent/session expiry | Invalidate bytes and return to fresh consent; suspend/resume uncertainty invalidates |
| Attempts | One preparation at a time, no queued auto-retries | Retry is a fresh user action with fresh disclosure/consent |

The 256 KiB/2 MiB/24-hour figures originate as #416 proposals. All rows above, including
new event/deadline caps and conservative restart behavior, require D1/D2 review before
capture is enabled. Fixture validation enforces only bundle-shape/byte/event/window
ceilings. It does not measure worker CPU/memory, deadlines, disk usage or retention.
Resource isolation must keep diagnostics off execution locks/queues. Drop diagnostics
under load; never block, cancel or mutate runs to meet these budgets.

## Serialization and exact bytes

One local `.json` file, no archive, attachments or auxiliary manifest in the export.
Canonical proposed bytes: ASCII (therefore UTF-8), keys sorted lexicographically at every
object, two-space indentation, LF newlines, final LF, no BOM, no duplicate keys, no
non-finite numbers, fractions or exponent forms. JSON arrays retain order. All permitted
string values are ASCII. Equivalent alternate JSON whitespace/order is rejected as an
export file. Check input size before decode; malformed UTF-8, overdeep/malformed JSON and
multiple top-level values fail closed. Schema validation plus the semantic checks in
[validate.py](validate.py) are both mandatory for the proposed format.

Create the immutable validated bytes once, scan those same bytes, and show their entire
text in preview. The save operation writes that same buffer, never recollects/reserializes.
A digest/byte count can bind preview and saved bytes locally; do not add the digest or
local destination to the bundle. Fixture digests identify synthetic files only, not users.
Different destination permissions, interrupted writes or stale consent invalidate saving
as described in [preview](preview-and-consent.md).

## Excluded sources and rationale

| Never read/copy into diagnostic preparation | Why |
| --- | --- |
| Prompts, source code/diffs, workflow names/bodies, request/run/step titles, agent/tool output, artifacts | User/workplace content remains sensitive when nested, encoded or fragmented |
| Logger output, stdout/stderr tails, raw error objects/messages/causes/stacks, crash dumps/minidumps, memory dumps | Free text routinely contains paths, commands, credentials or source; an error code does not make the object safe |
| Audit records, RPC request/response payloads, event logs, execution stores | Existing projections contain identifiers and content; authorization to view is not consent to export |
| Configuration, environment, command lines, headers, URLs/remotes, clipboard, screenshots | Credentials, endpoints, organization/user identity and private context |
| Absolute/relative project paths, usernames, hostnames, IPs, hardware serial/model, raw process/workspace/agent/session/run IDs | Identifying or correlatable; do not substitute predictable hashes |
| Credentials, execution/diagnostic keys, encrypted records/ciphertext, keychain material | Encryption does not make these exportable; export needs no recovery material |

The destination path is visible in local UI only, never a diagnostic field. A schema-valid
numeric version, UUID or hash can still carry private data if its provenance is wrong.
Producer source allowlisting and authorization are primary. Canary/secret-pattern scans
are defense in depth, cannot establish anonymity, and fail closed on errors/timeouts.
