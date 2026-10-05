# Host-resource read access proposal (#491)

**Proposed policy — requires review before production integration or any grant.**
This draft implements an injected-source contract and authorization tests only.
The normal daemon command does not mount a collector or this operation.

## Two independent authorities

`host.telemetry.read` is a new explicit operation permission for advisory measurements
of the connected daemon's OS-visible machine. It reveals aggregate activity outside a
caller's runs. It does not authorize reading those runs, enumerating their identifiers,
or receiving an ORCA-wide workstream count. It is independent of workflow/run scope:
a restricted service principal can be deliberately granted host telemetry without
also receiving unrestricted run access. Review must explicitly accept that disclosure.

No preset grants this permission, including owner/bootstrap and local compatibility.
Existing records remain explicit lists; no migration, wildcard expansion, owner fallback,
or automatic grant to Cal or another credential is introduced. Only token-authenticated
composition with persistent workspace identity can mount the operation.

Caller-visible workstreams additionally require `runs.read` and current run ownership
and root-workflow visibility. A separately injected trusted source must enumerate only
the bounded authorized run set, including parked work, and supply #495's summary over
that exact set. Hidden runs must not change counts, completeness, errors, or enumeration
work. The daemon checks every supplied run before reading the summary and again before
publication. Scope changes or revocation discard the whole in-flight result. There is
also a mandatory synchronous publication fence, invoked after the final per-run awaits
and the operation-promise continuation. It covers the entire authorized set's ownership,
root visibility, lineage, index coverage and summary revision. A provider must invalidate
that fence atomically with every relevant mutation; an asynchronous revision check alone
is insufficient. Missing or failed fences refuse publication. The final fence is followed
by no awaits. A future persistent index must establish this guarantee across writers;
the current ownership store and asynchronous resolver alone do not supply it.
Response-lifetime guards repeat the credential and coverage fence immediately at HTTP
and WebSocket serialization, after the dispatcher/authorization wrappers' awaits.
There is no fallback scan of all runs, no owner identity, and no authorized-aggregate mode in
this slice. Counts embedded in the host snapshot are always discarded.

Without `runs.read`, `workstreams` is `permission-denied/not-authorized`. With the grant
but without the bounded source, it is `unavailable/scope-unverified`. Neither is zero.
The injected summary must say `caller-visible` and `authorized-run-set`; incomplete,
stale, unsupported and denied states retain the shared meanings.

## Closed read and bounds

MCP `get_daemon_resources` maps only to `operator.hostResources`. Input is exactly
`{target: {workspaceId, instanceId}}`, copied from authenticated discovery. The shared
#495 snapshot is returned directly, with its own daemon/host/boot provenance; no
MCP-local telemetry DTO, thresholds or workstream-count definition is introduced.
There are no host, URL, PID, path, mount, shell, refresh or remote-host selectors.
The method remains a read when run mutation services are absent (read-only daemon).

Registration, `hello`, operator discovery and MCP discovery depend on both an installed
source and the explicit permission. Unauthorized calls are rejected before parameter
diagnostics or source work. Credentials, grants and scope are pinned to the original
invocation and checked after every source/resource await and immediately before return.
The request target and returned daemon instance must match the live composition.

The mount admits one source operation at a time, including an operation that ignores
abort after timeout. It has a one-second response deadline and a five-second minimum
between source starts; it retains no caller summary cache and starts no background
monitor. Shared limits are 32,768 snapshot bytes and 1,000 authorized run references.
The transport's existing 64 KiB command / 256 KiB MCP envelope ceilings still apply.
Malformed or oversized data and thrown source diagnostics produce fixed public errors.
Metrics and warnings are validated with the shared schema and warning function, with
no missing-as-zero or safe-to-launch conclusion.

Separately collected summaries use the shared `composeResourceSnapshot` helper after
all asynchronous checks. `collectedAt` covers completion, while host and summary ages
advance independently using monotonic elapsed time. Their original `observedAt` values
remain intact; expired available observations become stale/expired and the shared warning
policy is reapplied. Future observations and backwards composition clocks still fail.
Shared `advanceResourceSnapshot` keeps the last known boot in a provenance cursor across
unavailable readings. That retained evidence is never inserted into the wire observation;
only an authoritative connection/target/boot transition may reset it.

## Shared ownership and integration gaps

#490 / draft #495 owns `host-resources.ts`, `host-resource-fixtures.ts`, their tests,
measurement semantics, warning policy and collectors. This slice initially imported those
three protocol files byte-for-byte from reviewed head
`a94d78a5e7e8ebb8cd8274a71cbe0a4010058d93`, including the independent cgroup CPU/memory
availability fixtures. The fixtures remain byte-identical. Review corrections add the
shared provenance/composition helpers and their tests in `host-resources.ts`, coordinated
with [#495](https://github.com/cschadewitz/Project_Orca/pull/495#issuecomment-5986324081)
and [#497](https://github.com/cschadewitz/Project_Orca/pull/497#issuecomment-5986324858).
These shared helper changes must be carried into #495 and adopted by #497; schema,
measurement values and warning thresholds are unchanged. #491 owns the new wire contract,
method inventory, daemon mount, MCP mapping and authorization tests. #492 owns renderer
adoption. Shared protocol files and barrel exports must be reconciled when these drafts
integrate, retaining one contract. No renderer or collector files are changed here.

Production collector mounting, a bounded caller-authorized runtime/parked-run index,
integration with #495's summary collector, grant issuance/UI, actual-agent acceptance,
Linux agent-01 observations and boot/reconnect acceptance remain separate review and
integration work. Protocol version/closed-capability compatibility must be reviewed with
the protocol owner before production mounting; this unmounted draft leaves version 2.0
unchanged. Synthetic transport tests do not establish deployed access, timing
noninterference of a future index, collection overhead or real-host acceptance.
No credentials outside disposable tests, deployment, activation or merge is authorized.
