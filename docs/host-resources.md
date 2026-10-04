# Advisory daemon-machine resources

Issue #490 provides the version 1 contract in `@orca/protocol`, deterministic
`hostResourceFixture` / `workstreamSummaryFixture` values, an on-demand daemon
collector and an authorized workstream-summary port. Nothing here registers a
method, starts a monitor, changes execution or grants access. #491 owns the
runtime permission policy and authenticated API/MCP composition; #492 owns UI.
The collector is an internal trusted API, not an authorization boundary.

## Measurement contract

Every metric is `available`, `stale` (retained value and original observation),
`unsupported`, `unavailable`, or `permission-denied`. Unobserved metrics have no
value. Sources and failure reasons are closed enums: raw exceptions never become
output. All bytes are nonnegative safe integers, rates are bytes/second, CPU
utilization is a ratio in [0,1], cores may be fractional, and intervals/ages are
milliseconds. Timestamps are UTC ISO timestamps with millisecond precision.
`precision` means exact source value, cumulative counter measurement, or estimate;
it does not promise accuracy beyond the named source.

The target is always `daemon-machine`, measuring the operating system visible to
that daemon, including unrelated load. `daemonInstanceId` comes from the daemon's
existing start identity. `hostId` is an opaque collector-instance alias, not a
hostname or stable inventory identity. Linux `bootId` is the OS boot UUID, with an
explicit metric failure when unreadable; daemon restart and OS boot are distinct.
`physicalHostCapacity: unknown` prevents guest/container observations claiming
hypervisor capacity. SSH execution hosts and daemon/per-workstream attribution
are outside v1. `configuredLimits: not-collected` distinguishes configuration from
measurements and effective limits. Capabilities describe implementation support,
not current permission, successful observation, or safe launch capacity.

| Metric | Interpretation |
| --- | --- |
| CPU | `/proc/stat` counter deltas between monotonic collection starts (bounded read skew within the collection deadline). Busy excludes idle and iowait; guest counters are not added twice. Normalize against all OS-visible logical CPU time, not cgroup quota. First sample is warming-up. |
| CPU limit | Minimum visible cgroup v2 ancestor quota and effective cpuset. Process affinity/taskset limits are unmeasured. Fractional quotas remain fractional. Scope says visible hierarchy; hidden ancestors/physical hypervisor limits are not claimed. |
| Memory | `/proc/meminfo` total, `MemAvailable` estimate and `MemFree`. Free and available are independently bounded by total; available may be below free because of kernel reserves. |
| Memory limit | `currentBytes` is leaf cgroup usage. `limitBytes` is the smallest visible ancestor absolute limit. `headroomBytes` is the minimum of each finite ancestor's `max(0, memory.max - memory.current)`. These may be constrained by different ancestors: do not derive headroom from the output limit/current pair. `null` means no finite visible limit, not infinite capacity. |
| Swap | Total/used occupancy is separate from interval page-in/page-out byte rates. Page size comes from kernel auxiliary-vector `AT_PAGESZ`, never an assumed 4 KiB. Occupancy without activity does not mean thrashing. |
| Storage | Fixed store/workspace/temp roles selected by trusted bootstrap, with `statfs` total and caller-available bytes. No request supplies paths or mount selectors. Opaque `fs-1`…`fs-3` backing IDs are comparable only within a snapshot. Shared IDs are the same filesystem. tmpfs is `shared-memory`; its capacity overlaps RAM/swap, never additional independent disk capacity. Unknown filesystems remain unknown. Never sum headroom across roles. |

Cgroup CPU and memory limits have independent outcomes after shared hierarchy
discovery succeeds. Missing CPU quota/cpuset files cannot suppress readable memory
headroom or its pressure warning, and missing memory files cannot suppress readable
CPU limits. Missing non-root controller files report `unsupported-source`; denied
files report `permission-denied`, never an inferred unlimited capacity. Discovery
failures invalidate both limits. At the visible root only, absent quota or paired
memory controls are allowed independently; inconsistent memory pairs remain
unverified. Shared `cgroup-cpu-unsupported`, `cgroup-cpu-denied`,
`cgroup-memory-unsupported` and `cgroup-memory-denied` fixtures cover these states.

Linux proc/cgroup v2 are the initial sources. Unsupported operating systems,
cgroup v1, unverified cgroup visibility, inaccessible sources, malformed counters,
backwards counters, oversized reads and timeouts remain explicit. No shell
commands, per-process enumeration or remote probes are used. Native I/O runs in one
lazy worker thread using synchronous filesystem operations so hung telemetry I/O
does not occupy the engine's shared libuv thread pool. Measurement semantics
follow the [kernel proc documentation](https://docs.kernel.org/filesystems/proc.html),
[kernel cgroup v2 documentation](https://docs.kernel.org/admin-guide/cgroup-v2.html)
and [Node statfs contract](https://nodejs.org/api/fs.html#class-fsstatfs).

## Freshness and ordering

On-demand refresh is no more frequent than five seconds; readings expire at
15 seconds. A source timeout does not manufacture a successful timestamp.
Successful observations use the collection-start timestamp, with age including collection time; retained observations keep their original timestamp. `collectedAt` is the end of
collection; composing a separately authorized summary must update it to the end
of that composition too. Metric ages and cache expiration use monotonic elapsed
time. Wall-clock discontinuities invalidate observations; no negative age is
rendered as fresh. Boot changes invalidate interval baselines and retained data.

`acceptResourceSnapshot` checks the request's captured connection generation
against the current generation and expected daemon identity before ordering by
sequence. A retained observation of a different boot (including stale boot data)
is rejected. The consumer clears its previous snapshot only after an authoritative
connection/target/boot transition, then submits responses with the new generation.
A delayed old request cannot reset identity. Within one sequence, cache age may
advance but cannot move backwards. Wall time alone never establishes ordering.
Consumers must keep aging retained values while disconnected; transport arrival
does not renew an observation. Schema validation rejects a metric labeled
available at or beyond expiry, even if the snapshot is otherwise valid.

## Shared warnings

`resourceWarnings` is the single `advisory-v1` policy. Warning codes include their
metric, basis and numeric threshold; consumers supply presentation text without
inventing thresholds. This initial policy is an explicitly selected heuristic,
not a calibrated workload capacity model:

- CPU busy ratio at least 0.90 over the reported interval.
- Available RAM, finite cgroup headroom or filesystem available ratio at most 0.10.
- Combined swap input/output at least 1,048,576 bytes/second over the reported interval.
- Missing or expired host observations add partial/stale-data warnings.

Stale metrics do not produce fresh pressure claims. Workstream authority denial
is separate from host-source availability. Absence of a warning guarantees
nothing: samples are neither reservations nor atomic launch preflight. V1 never
queues, blocks, kills processes or changes run state.

## Authorized workstream seam

A workstream is a root run and its descendants, including direct/root workflow
launches. Distinct observed nonterminal roots are counted once. Run status groups
count runs, not workstreams, and therefore can exceed the root count. Terminal
runs do not contribute. Paused human work remains active but waiting; dependency
or plan waits are blocked; agent/child work is executing only with verified live
lease evidence. Missing/lapsed/unknown ownership evidence is uncertain, never
zero active work or proof of execution. Configured agents and persistent work-item
claims are not enumerated.

The source must enumerate an already authorized bounded run set and supply
verified lineage plus minimal runtime/status/lease observations. Filtering occurs
before enumeration/truncation/counts, not after a global list. Authority is checked
before source work, after asynchronous reads, and before returning any counts;
revocation denies the entire result. The summary contains no run IDs, names,
paths, user text or hidden-work counts. `caller-visible` and separately authorized
`authorized-aggregate` scopes are distinct. `complete` describes only the stated
`authorized-run-set`, never all host jobs. Partial coverage is explicit.

There is intentionally no automatic adapter over unbounded store history or
in-memory attached interpreters: the former lacks bounded reads and the latter
omits parked work. #491 must supply the authenticated bounded source, including
parked runs and RunAccess-verified root lineage, and authorize aggregate machine
telemetry independently. These ports alone grant no principal, including an
existing MCP principal, additional visibility. A bundled consumer must also package the compiled
`native-io-worker.js` entry; standalone package compilation includes it, while
bundled/native-app acceptance is outside this slice.

## Work bounds

Use one collector instance per daemon, never one per incoming request. Refreshes
coalesce into one collection. At most four source operations are outstanding,
including timed-out operations until they actually settle. The native worker
also caps unresolved requests at four, never replaces a stuck/failed worker, and
is unreferenced so its event port does not keep the event loop alive. Its V8 resource limits are
16 MiB old generation, 4 MiB young generation and 1 MiB stack (these are not a
whole-process RSS guarantee). `close()` requests disposal without waiting on a
stuck syscall. This does not guarantee shutdown completion: Node may join worker
threads during exit, and termination of a kernel-blocked syscall is unverified.
Each operation has a
250 ms response deadline within the one-second collection budget (subject to
normal event-loop scheduling). There is no periodic timer. An ignored timeout can
consume a slot, but repeated reads cannot create unlimited orphan operations.

Each native file read allocates at most 65,537 bytes, accepts at most 65,536 bytes,
and closes its descriptor after settlement. Replies copy only the accepted bytes;
main-thread reply validation rejects oversized buffers before copying. There is
no async filesystem work in the worker or the main-thread native adapter.
Cgroup traversal has at most eight
path components plus the visible root, with four control reads per level and two
bounded discovery files: at most 38 cgroup file attempts, plus four proc metrics
and one auxiliary vector (43 files / 2,818,091 probed bytes maximum per refresh).
There are three fixed storage roles, each using one statfs and one stat operation.
No process history or directory trees are scanned. Snapshot output is capped at
32,768 serialized bytes and twelve warnings. Storage errors discard that role's
old reading to avoid mixing snapshot-local filesystem identity maps.

The summary collector has one outstanding collection (including an ignored
abort), a one-second response deadline and at most 1,000 authorized references
with bounded IDs. Source providers must bound enumeration allocations and state
reads themselves; this port cannot make an unbounded provider safe. It retains
no summary cache across callers. Constructor-injected adapters and clocks are
trusted implementation seams, not transport input.

## Evidence and remaining acceptance

Contract/fixture tests, source-adapter tests and measured synthetic overhead are
recorded in the draft PR. They do not establish agent-01 production acceptance.
Exact-source agent-01 Linux measurements, identity/boot verification, cgroup
mount/namespace visibility, storage-role backing, actual pressure, privilege
denial, restart/reconnect and cross-client authorization remain **unrun** until
separately authorized. UI, MCP, native/packaged-app and remote-host acceptance
are also unrun in this slice. No live daemon is changed or started for this work.

Independent maintenance preparation #485 remains inactive and independent. Compatible
semantics are byte units, bounded sources, available-vs-total, explicit staleness
and timeouts retaining source slots; its synthetic contract is not deployed
telemetry and its outage route/identity does not depend on this collector.
