# Connected aggregate observation — preparation only

Refs #699 / #706. This separate branch starts at independently reviewed #766
`2c746f1e5d31c7be14203d53a626166139e3b90a`. It composes the reviewed connected
kernel grammar, delivery correlations and Save authority validators. Producer
source stays `557f62fbe86fc8371d48f11ec37bf9db71cac436`. No production code,
provider configuration, shared lockfile or historical acceptance decision changes.

The bounded plan is to close the remaining effect inventory, exercise coherent
composed negatives, and gather one original bootstrap and connected observation
under the original bounds. Every attempted observation, including any refusal,
must remain in its private packet. Unsupported legitimate histories require
source analysis and a narrow correction; they cannot be skipped or exempted.

## Composition and explicit source assumptions

`controlled_aggregate.py` requires both authenticated semantic validators after
complete `ConnectedKernelReplay.run`. It closes all surviving names and exact
mutable histories: 17 protected publications (key, inputs and 15 payloads), two
enrollment records, two sidecar versions, two credential publications, one guarded
lease, three state directories and one detached resource/directory. Protected
inputs must decrypt to the producer's exact six-field empty execution input.
The final journal bytes must equal the four actual append records. Transient
strict sidecar and journal mutexes and the resource namespace must be removed.
Full replay still classifies every syscall and interval, including outside-phase
activity. Inventory counts never exempt unexamined operations.

`controlled_observation.py` accepts no command/provider arguments. It requires
the executable observer files to equal their measured Git commit before starting.
The supervisor retains actual file hashes, original PID/proc/pidfd/mount/clock
provenance, all command/ack boundaries, full trace, image bytes, and same-invocation
final named physical/byte observations. Final observations are named-path checks;
only the existing immutable publication fallback uses an independently held
readonly descriptor. Neither kind is replaced by a later `/dev` or `/proc` read.

The launcher first independently replays a fresh bootstrap. Its original
supervisor retains the closed process/resource graph and reruns authenticated
bootstrap correlations before constructing the explicit in-memory
`ConnectedDesignation`. A report, digest or child success flag cannot construct
that designation. Bootstrap and connected use separate fresh roots, lifetimes,
clock probes, originals, reports and phase tokens, while retaining the same
original physical three-file image. The historical accepted attempt remains
exactly the [existing decision](controlled-bootstrap-gate-decision.md); this
fresh preparation launcher does not import or extend its acceptance.

Trusted exact supervisor/producer/native runtime and kernel, stable clocks and
mounts, cooperative same-UID ownership, dependency build inputs, random issuance,
original callback/permit/facade identity and final ownership fence remain explicit
source assumptions. AEAD authenticates bytes under the locally retained test key;
it does not independently attest those in-memory identities or create external
review authority. Persistence review remains distinct from execution judgment.

All original notification, physical alias, source inventory, current authority,
phase, clock, 55-second owner, 60-second process and 256 MiB trace guards remain.
No external provider or account credentials are used. Disposable local issuance
is the original producer's test behavior. No accepting token is emitted;
`productionEligible` stays false and a completed observation exits 2. Independent
aggregate review and any broader acceptance obligations remain pending.

## Validation and fresh evidence

The composed controls explicitly use declared synthetic physical graphs and valid
AEAD reauthentication. They reject lost/pending final ack, coherently stale
capture/verdict, revoked operator/reviewer, wrong-phase mutation, duplicate
authorization, extra effect/name, residual lock, changed inputs and unfinished
private publication. Existing full kernel grammar and notification adversaries
remain part of the suite. These controls are not live fault traces.

Validation before the original attempt: full Python discovery passed 256 tests
(6.380 s); optimized aggregate controls passed 10 tests (0.354 s). A subsequent
regression explicitly checks that a refused bootstrap cannot construct a
designation or release connected commands. Final checks passed:

* `python3 -B -m unittest discover -s tools/owned-read-proof -p 'test_*.py'`:
  257 tests, 7.553 s.
* `python3 -O -B -m unittest discover -s tools/owned-read-proof -p 'test_controlled_aggregate.py'`:
  11 controls, 0.407 s.
* `git diff --check`: clean.

### First fresh attempt: bootstrap timeout, no connected release

The retained root is `/tmp/orca-connected-observation-sm8ntll_`. The image was
freshly built from the fixed source and all 194 repository inputs matched the
producer pin; its 385 total inputs include the explicitly trusted dependency
build inputs. Producer, child and manifest SHA-256 values match the three hashes
in the historical decision, but these are new physical files. Observer commit
was exactly `e6276010e7cf97319cb27471c0c409597a769d35`; all 14 executable observer
file SHA-256 values and actual original file identities are retained in the
private packet.

The original bootstrap process hit `TimeoutExpired` at the unchanged independent
60-second process bound. Its sole phase log entry is command `sent: bootstrap`;
there is no bootstrap acknowledgement. No connected designation was constructed,
no connected base was created, and `connectedCommandsReleased` is false. The
launcher exited 1 with `missing permanently closed original bootstrap`. No
kernel/semantic pass, settled graph, final physical checkpoint, service-read
count, or child-success inference is claimed for this incomplete trace.

| Complete retained packet | Bytes / SHA-256 |
| --- | --- |
| `bootstrap/trace` | 107186034 bytes; `72a5b74babd13c7df8a39f1130b1985e05236b79b12624bf39c663e5e390632a` |
| `bootstrap-attempt.json` | `ce33aab5785034c55171a409b4b171f6b361231e0f534cc1ea04def981c61b0d` |
| `bootstrap-originals.json` | `4b3419f1e169ef5af6595f7fba8fee6a22eb40cdf92170713ea23bb688ab6bb6` |
| `sanitized-checkpoint.json` | `a1bacd6202f864b839f12ad4d86d5d314974818cd278f6250377e4d8ee686e9a` |

Read-only inspection found 154251 raw lines spanning about 59.989 s; the final
line is an ordinary syscall rather than a complete process settlement. The
partial private store contains the key, inputs and three payload publications.
This identifies a bounded execution refusal, not an unsupported syscall grammar
finding. The timeout packet remains intact. No retry selected a different passing
schedule, and no bound, source check or phase requirement was relaxed.

Fresh connected execution remains blocked by the absence of a completed original
bootstrap in this environment. The aggregate source and synthetic controls are
reviewable, but actual aggregate effect closure, notification proof, physical
observations, Save/human/rule correlations and current authority still require a
complete fresh connected trace under all original bounds, followed by independent
aggregate review. Raw traces, protected records, phase tokens, credentials and
process provenance stay local and unpublished.

### Read-only timeout diagnosis

The preserved trace and packets were inspected without another producer launch.
All packet hashes above remain unchanged. The phase command was sent 2.866628 s
after the supervisor start sample. Authenticated partial payload bytes identify
one baseline, one capture and one authorization; there is no producer observation
payload. The authorization publication finishes its temporary cleanup at raw
line 125046, about 33.318857 s after the first trace prefix. No completed
offset-2/length-4 `pread64` signature appears before the cut. These are partial
diagnostics, not a replacement for complete physical/event replay.

The leader continues successful checks until raw line 154250: `close` of the
workspace identity read descriptor, result 0, at trace offset 59.988616 s. Its
preceding calls include image and credential `statx`, lifetime-fdinfo reads, and
workspace-root/identity checks. At the cut there is no unfinished leader syscall;
ten workers have unfinished epoll/futex waits. No process-wide settlement or
phase acknowledgement appears. This is active source currentness work at timeout,
not evidence of an original callback wait. Bootstrap source does not enter the
connected human-delivery path. Source checks at producer `check/createOriginal`,
the installed child's `check`, and the service/fence's final currentness chain
account for these repeated physical and authority checks; none may be removed to
fit a timing budget.

The action's authenticated expiry is 61.151280266 s after supervisor launch
(the source creates it 55 seconds after capture-facts setup). Thus the independent
60-second process limit fires before the action's own expiry. This does not
justify extending either limit. The full partial trace contains 112196 completed
`statx` calls. Throughput drops sharply after about 25 s: over that remaining
interval, gaps larger than 10 ms between consecutive global trace prefixes total
about 21.031 s. Individual later gaps exceed a second between leader `statx`
entries. The earlier roughly 1.989 s gap at command-read startup belongs to the
supervisor's pre-release provenance/setup interval and is separate.

These entry-only timestamps establish progress and wall-budget exhaustion, but
cannot separate syscall/ptrace or filesystem stall time from descheduling and
other environment contention. No original CPU/scheduler samples or syscall
completion-duration stamps were retained. Current low load and unchanged CPU
quota are later observations, not proof that the original transient cause has
been identified or resolved. There is no supported source/orchestration deadlock
fix from this evidence, and no bounded retry was run merely to obtain a pass.

Cleanup was checked independently before considering a retry: every observed
trace thread ID is absent from current `/proc`, the original process group has
no members, and no current Node/strace command matches this attempt. This is a
later cleanup check, not a reconstruction of original authority or final
physical proof. The original `run_traced` path had already killed/reaped its
owned group on timeout without an `OwnedCleanupError`.

The local sanitized diagnostic is
`/tmp/orca-connected-diagnostics/timeout-diagnosis.json`; its SHA-256 is recorded
as `2d2d7d018c88c19a6214bcdcf33ced7e5d2c4074bdcb4cf8b4ea054de0379c97`.
Fresh execution remains pending a justified timing
diagnosis or a verified resolved transient condition. All bounds, source bytes,
bootstrap prerequisites and disabled accepting outcome remain unchanged.

### Bounded resource and timing follow-up

Parent reports that #768 preparation has source-only review approval. This
records no execution or aggregate acceptance. A further read-only diagnosis
examined current cgroup, scheduler, memory, block-I/O and process counters and ran
small fixed metadata probes. No unrelated process, resource limit, security
setting, provider or account credential changed.

The old successful bootstrap remains the published 13.795040008 s / 112905714
byte record above, at observer tree `d65be8effc03ce0fc658bc86cce5fd51fe3a5964`.
Its raw/original packet is absent here, so no historical CPU/quota/throttling,
pressure, I/O, scheduler distribution or Node-byte comparison is available.
Producer source and all three producer/child/manifest hashes match the failed
attempt. The published historical tracer hash equals the failed/current tracer
hash `69f88291a4e47f258b8e32b089c919a247509f063ef3d6afe5389939051102b3`.
Current Node bytes equal the failed original's
`bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12`;
that is not a claim about the unavailable historical Node bytes.

The failed trace grows by 82.193246 MB over its first 25 seconds and 24.992788 MB
over the remaining approximately 35 seconds. Its five-second windows include
only 901 lines / 630343 bytes at 25–30 s and 790 lines / 565737 bytes at 45–50 s,
despite ongoing currentness operations. Source/image equality and this progress
distribution narrow the failure to wall-budget exhaustion during active work,
but do not identify the resource or scheduler cause of the long entry gaps.

Available current resource evidence:

* CPU quota is `400000 100000` (four CPU equivalents), weight 100, no burst.
  Cumulative throttling is 163 periods / 14428633 microseconds; it has not
  increased since the first post-failure inspection or during these probes.
  There is no pre-failure sample assigning that cumulative total to the run.
* Memory limit is 17179869184 bytes, historical cgroup peak 1400745984 bytes,
  `memory.high` is unlimited, current swap is zero, and all memory-limit/OOM
  event counters are zero. Current probe memory stayed far below the limit.
* Global and cgroup CPU/memory/I/O pressure files are unavailable. This absence
  is recorded, not treated as zero pressure. Current block-I/O counters cannot
  reconstruct historical filesystem stalls.
* Clean-probe load averages were 0.30 / 0.29 / 0.26. The before/after process
  snapshots show no other active workload making CPU progress. Existing
  non-running Git/build zombies and service processes were left untouched.
  The original owned trace IDs/group and all probe trace IDs are absent after
  cleanup; unrelated jobs are not part of that cleanup claim.

Both probes read only metadata on the same three image files. They never import
or activate the producer. Each runs exactly 9216 `lstat` checks, compares full
physical stamps, and has a 10-second process / 16 MiB trace bound. The tracer
uses the same original strace options. Raw probe traces and scripts stay local.

| Diagnostic | Untraced loop | Traced loop | Interpretation |
| --- | --- | --- | --- |
| Initial sampled probe | 0.101446408 s | 6.112134760 s | Contaminated by repeated resource sampling and a concurrently launched diagnostic packet reader; not an isolated tracing estimate. |
| One corrected probe, no sampler/concurrent commands | 0.076964040 s | 2.079994505 s | Current metadata tracing overhead; not proof of prior cause or full bootstrap timing. |

The corrected probe's full process wall times are 0.200134494 s / 2.538094447 s.
Its trace contains 9228 total `statx` entries, with a largest global inter-prefix
gap of 0.012864 s. The Node leader's measured loop scheduler deltas are about
0.517140 s runtime / 0.018636 s runnable wait. Cgroup CPU usage increases by
2.202980 s with no new throttle, memory-limit event or recorded block-I/O byte.
These measurements establish current small-probe health only. They neither
attribute the original second-long gaps nor verify recovery of their cause.

Local sanitized report hashes:

* `resource-timing-probe.json`:
  `fe2a273af3c1941a65b3f69b43be606c2fe1d3489dab24802b659473db0d8ee2`.
* `resource-timing-clean.json`:
  `207ace9ff607ed50a27922195ef010336263d4c453e543a0dbe373f3e69d8841`.
* `resource-checkpoint.json`:
  `bff189f3a193f9e0ccb5436155041be9adb1847186b27f658876fb3c7402177f`.

All are under `/tmp/orca-connected-diagnostics`, mode 0600. The negative original
packet remains unchanged. No new bootstrap/connected attempt was run: no concrete
original transient cause has been verified recovered. The next useful diagnostic,
if separately authorized, is one original run under unchanged bounds with sparse
retained monotonic trace-progress and cgroup CPU/I/O/memory-event samples plus
pinned supervisor/tracer/leader scheduler counters. Whole-packet inspection and
other diagnostic subprocesses should wait until it settles. This would gather
missing cause evidence; it adds no acceptance prerequisite or production gate.

### One authorized instrumented original investigation

Parent subsequently authorized exactly one diagnostic original run, irrespective
of the unresolved historical cause. `controlled_observation.diagnose_bootstrap`
is the fixed entrypoint: fresh private root and exact-source image build, one
original bootstrap, complete unchanged original checks, sanitized checkpoint,
then stop regardless of outcome. It never constructs a connected designation.
This is an investigation, not a success-selected qualification retry. Earlier
negative packets and diagnostic probes remain intact. Any completed new bootstrap
is new evidence only; the historical cause and independent acceptance remain
unresolved. Prior source-only approval does not cover the new instrumentation.

The measured observer inventory now includes `controlled_diagnostics.py` (15
files total). Diagnostic mode is an explicit in-process supervisor boolean; the
normal CLI still accepts no provider/command arguments. Exact diagnostic config:

* One-second relative waits, no catch-up bursts, at most 62 samples including an
  initial sample and a final sample after owned process settlement when budget
  allows. Actual monotonic before/after brackets record sampling overhead.
* Progress is trace file size and phase-event count only. It never reads trace
  contents, phase tokens, protected packets, argv or environment.
* Supervisor, tracer and original leader use actual pidfds and pinned proc
  directory descriptors. PID/starttime/parent/group/session must match before
  reading counters; subsequent opens are relative to those descriptors. Exited
  pidfds never trigger a lookup of a replacement numeric PID.
* Fixed process counters are `stat`, `schedstat` and `io`; fixed resource files
  under the held `/sys/fs/cgroup` directory are `cpu.stat`, `io.stat`,
  `memory.events` and `memory.current`. Every read is capped at 8192 bytes.
  Missing/racing counters and sampler errors remain explicit diagnostics.
* No additional subprocess runs while the owned tracer group is active. Sampling
  stops before full trace replay and packet processing. Reports, exact config,
  physical proc pins and raw counter snapshots remain in a separate private
  `bootstrap-diagnostics.json`; no diagnostic report authorizes execution.

The producer/source/image, 55-second owner expiry, independent 60-second process
limit, 256 MiB trace cap and all bootstrap physical/authority/notification/clock
guards are unchanged. No concurrent packet inspection is performed during the
run. Pre-run validation passed 266 Python tests (6.004 s), nine optimized
diagnostic controls (0.013 s), and `git diff --check`.

### Diagnostic outcome: process completes; original kernel grammar refuses

Exactly one instrumented original ran at observer commit
`935d5193aa3eea3cb0c61c2859c5ee9542bd590d`, retained under
`/tmp/orca-bootstrap-diagnostic-zk8ulzb1`. The producer pin and all three image
hashes remain unchanged. Producer exit is 0; measured monotonic process interval
is **41372058646 ns** and complete trace size **113151210 bytes**. The bootstrap
phase log contains its actual sent/received sequence. The process fits the
unchanged limits, but this is **not a bootstrap check pass**: original replay
refuses `RuntimeError: line 4092 epoll_ctl: ambiguous shared descriptor/path interval`.
The outer diagnostic exits 1 with `missing permanently closed original bootstrap`.
No connected constructor or command is used. No accepting token is emitted.

The exact unsupported overlap is startup registration of the original eventfd:

| Actual operation | Original raw interval |
| --- | --- |
| Worker eight-byte unit write to eventfd 19 | 4091–4093 |
| Leader `epoll_ctl(16, EPOLL_CTL_ADD, 19, {events=EPOLLIN, data=0x13})`, result 0 | 4092–4094 |

The original eventfd factory is raw entry 403 and original epoll factory entry
400. The worker write overlaps registration completion. Both are shared-FD
mutations under the current interval grammar. The notification exception requires
an already completed original registration and two qualifying counter operations;
`epoll_ctl` is not such an operation. Its successful return cannot establish an
ordering inside the overlap. The unrelated pending worker epoll wait remains
visible as well. This is a newly observed unsupported native startup schedule,
not an inferred accepting-path exploit or a reason to remove interval guards.

New regression controls retain refusal of this exact interval shape and accept
the contrasting settled unit-write → completed registration → counter-drain
history. No replay/notification guard changed. Any support for overlapping
registration and counter I/O requires a separate finite causal/native grammar
review, including readiness and full counter lifetime obligations. Re-running
until registration happens to settle first would not close this obligation.

The sampler retains **40 samples**, zero sampler/counter errors and the final
exited-pidfd states of original tracer and leader. Its actual sampling brackets
have median 0.8280345 ms, sum 1631.082924 ms and maximum 1341.633427 ms. These are
wall brackets including descheduling/GIL/kernel waits, not claimed added CPU
overhead. The largest bracket occurs near 38.9 s, in the same sample window as
three new cgroup throttled periods / **803339 microseconds**. This correlation
does not prove the historical timeout's cause. The current cgroup CPU delta is
32.311768 s; memory ranges from 1030356992 to 1357807616 bytes, with zero
memory-limit/OOM events. Recorded block-I/O bytes do not change. Last live pinned
scheduler deltas show about 15.522224 s tracer runtime / 0.726192 s runnable wait
and 10.057993 s leader runtime / 0.710416 s runnable wait. Snapshots bracket live
samples, so they are not complete per-process lifetime totals.

The trace progresses throughout the run: approximately 71.2 MB at 25.438 s,
104.5 MB at 36.840 s, and 113.15 MB at final settlement. The earlier 60-second
timeout is not reproduced, but its cause remains unresolved and is not attributed
to a verified recovery. All 12 newly observed trace thread IDs are absent after
cleanup. The earlier negative report and all its hashes remain unchanged.

| New complete retained packet | SHA-256 |
| --- | --- |
| `bootstrap/trace` | `e7ce418b8da24f77420240f41fed4dd7dbdc751e46afddf26b0235d4a9856e91` |
| `bootstrap-attempt.json` | `db3e7913630766fe65e18210cd17b957fab9d6220c9dff8a7deb644eed266e2c` |
| `bootstrap-originals.json` | `a20c79eb410bdc69079cc07748e25a4a066f60c833b1b290cb2b06cfbf26fb27` |
| `bootstrap-diagnostics.json` | `9367cb82721e9b4ed2f127350c546bd28c909fe794ba7572a4660dae19b6e0a1` |
| `sanitized-checkpoint.json` | `05e58a6405bea39adfd8c9eafb20e99115ab76746f97918ad1fa9433c48cb8fd` |

Raw packets, physical process pins and full metrics remain private locally.
The concrete next blocker is the finite registration/counter overlap grammar;
timing is not the refusal in this new original. Fresh connected effect closure
and independent aggregate acceptance remain incomplete. No further original
attempt ran. Final checks pass 268 Python tests (8.442 s), 19 optimized
notification controls (0.041 s), and `git diff --check`.

The subsequent [finite registration/counter proposal](controlled-registration-counter-overlap.md)
preserves these original outcomes and reports only offline event/counter analysis.
It requires independent review before another fresh attempt and grants no
accepting token or connected release.

After that bounded source review and separate authorization, the
[fresh gated observation](controlled-connected-fresh-observation.md) completes
original bootstrap checks, then times out during connected Save. It preserves
every earlier outcome and remains incomplete, with no accepting token.
