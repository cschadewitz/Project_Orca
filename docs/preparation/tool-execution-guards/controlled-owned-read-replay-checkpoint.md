# Controlled bootstrap replay checkpoint — incomplete

This observer-only draft starts from merged main
`aeb4ffb0e60fb4b553c70af3a4308b8b24a231d1`. The original published observer checkpoint
`613847aa64a5e34e7c3115f71ebdd049ad65c27c` is preserved in branch ancestry.
The current producer input pin is independently reviewed #751
`557f62fbe86fc8371d48f11ec37bf9db71cac436`, integrated by branch-only merge
`d816af710d620cd17f6f3317782429fdf30d3632`. Its producer/child bytes are used
unchanged; `assert_image_sources` compares every repository bundle input and the
copied child with that source commit. Candidate `verify.py` is unchanged.
Each experiment builds and retains a fresh physical image; previous observations
never qualify a different image. The historical evidence/proposals below predate
the current continuation recorded at the end.

`python3 -B tools/owned-read-proof/controlled_supervisor.py` runs only bootstrap,
under the unchanged 256 MiB trace and 60-second process limits, using `-s131072`
for lossless private writes. Original owner expiry remains 55 seconds. It retains
raw traces, original bytes, actual FIFO identities and the real flock, and uses
the existing owned-process settlement helper. It has **no connected launch path**.
Exit 1 means refusal; exit 2 means incomplete evidence, never qualification.
Python `cryptography` is required for independent AES-GCM record authentication.

## Evidence obtained

Actual fresh run `/tmp/orca-controlled-replay-plotdte2` returned producer exit 0
in 3.986750748 seconds, with 108973199 trace bytes and SHA-256
`f8c46762f1e417b0371d80b3e5fab4c50e08b2adc6e4859221837e87ff91d9f0`.
The prior draft at `9aeb6de` reconstructed one four-byte resource pread at offset 2, bytes
`73706f73` (`spos`), exclusive writer/readonly reopen/unlink/close, 12 settled
threads, and the modeled finite private publication sequence. Four protected
bootstrap records independently decrypt/authenticate and correlate the original
capture, baseline, authorization, observed result reference and actual guarded
lease file. These are partial checks, not complete bootstrap qualification.

The procfs alias investigation found `/proc/self/maps` opened readonly, closed,
then reopened readonly with the same inode. The query table now reuses the object
only for that exact originally enumerated path, retains its first observed inode,
and rejects inode replacement, writable/positional operations, mappings and an
inode already belonging to a resource/other object. Query mode/uid/gid are retained
before launch. Mutable query content is bounded and decoded completely; it is not
misrepresented as immutable original bytes.

This environment actually inherits umask `0077`, with no tracee `umask` call.
Consequently requested 0777 lock directories become 0700, and requested 0666
files become 0600. The draft retains the inherited mask from `/proc/self/status`
and models only 0022/0077; it changes neither mask nor host settings. This differs
from the producer document's 0022-only description and needs producer-contract
review/correction before acceptance.

Write-only immutable protected payloads may have no tracee stat. For those only,
the draft correlates replayed exclusive creation, synced writer close, successful
same-parent hard-link publication, directory sync and temporary unlink with an
independent observer readonly/no-follow descriptor plus final name/bytes checks.
This supplemental physical-observation rule needs source review; it is not a
producer-supplied inode claim or a generic private-root exception.

## Review follow-up: stricter checks, still no acceptance

The observer now requires exactly two credential records with distinct principals
and credential IDs. Every epoll wait, including completed one-line records,
checks its actual epoll object, registrations, result array/count and event data.
ADD-existing and MOD-absent refuse. Query handles require a successful per-open
physical stat, even when the exact query path/object was seen earlier. The
original candidate verifier remains unchanged.

This stricter query rule exposes missing physical observations in the preserved
actual trace: `/proc/self/cgroup`, `/sys/fs/cgroup//memory.max`,
`/sys/fs/cgroup//memory.high`, `/proc/meminfo` and some lifetime-fdinfo reads have
no per-open fstat. Consequently the historical partial result above is **not a
passing result under the current model**. A producer/observer observation change
or a separately reviewed query contract is needed; no path-only exception is
added. The pinned image and all raw traces remain intact. The producer's separate
review/fix work may change its source pin, so final installed runs must be fresh.

The follow-up suite has 62 passing tests; new synthetic fixtures are grammar or
negative controls, never service acceptance. Other local audit changes check
retained readlink/access probes, readonly process
limit queries, complete known directory entries and EOF, inherited CLOEXEC
transitions, actual fdinfo supervisor/flock identity, shared FD/path intervals
including FD-number reuse, and immutable temporary publication source identity.
Supervisor checks now use unconditional refusals rather than Python `assert`,
with an optimized-Python negative control. Semantic checks additionally bind rule
applicability, public credential permissions/scope, full nine-component resource
identity and prefix, original references, 55-second resource-lifetime ceiling and
authorization/effect publication order. These rules still need exact-head actual
coverage and review; they do not release a connected token.

## Remaining gate — do not use this draft as acceptance

* Finish process-control argument/result auditing and exercise the stricter
  probe/directory rules against fresh actual evidence once physical query
  observations are available.
* Complete shared-descriptor interval/alias audit, failed path-stat handling,
  fdinfo flock-content checks, epoll registration/result correlation and negative
  publication controls. The whole raw trace remains preserved and parsed.
* Complete semantic rule-match, managed binding/ceiling, credential permissions,
  expiry/causal ordering and original reference checks. AES-GCM authenticity and
  matching baseline/action JSON alone do not establish all these obligations.
* Review narrow decoded WAIT and verified-epoll boundary exceptions. They retain
  records in full replay and assume cooperative timing queries, not arbitrary
  output-memory isolation. PI/WAKE_OP/unknown futex operations refuse; private or
  resource file mappings refuse.
* Perform a new exact-head actual run after these checks and source review.
  Only complete independent bootstrap verification can release a connected token.
  Connected Save/human/rule phases and their external bounds remain unmeasured.

The original candidate verifier, candidate runner/fixture, engine, daemon and
protected owner are unchanged. No production trust, real credential/access,
persistent service, host security, user workspace or Mac change occurred.

## Exact historical query sequences and minimum observation proposal

This extraction uses only preserved trace
`/tmp/orca-controlled-replay-plotdte2/bootstrap/trace`, SHA-256
`f8c46762f1e417b0371d80b3e5fab4c50e08b2adc6e4859221837e87ff91d9f0`.
Locations below are **one-based raw trace line numbers**, including unfinished and
resumed lines. The trace has no per-call wall-clock timestamps, so no per-query
seconds are inferred. All listed open/read/close calls run on original leader
TID/TGID 4708. Every close returns 0.

The copied child script is first opened at line 698 and the producer bundle at
line 770. Bootstrap command consumption is line 3863; ack write is line 159686.
Thus all four native probes below finish before either copied JavaScript file is
opened. Their classification as Node-internal initialization, rather than a
project callback, follows that ordering and the pinned source search; no native
stack trace or particular libuv function name is asserted.

| Exact path | Flags | FD | Open → read → close | Requested → returned bytes | Per-open stat |
| --- | --- | --- | --- | --- | --- |
| `/proc/self/cgroup` | `O_RDONLY\|O_CLOEXEC` | 20 | 435 → 436 → 437 | 1023 → 5 | None |
| `/sys/fs/cgroup//memory.max` | `O_RDONLY\|O_CLOEXEC` | 20 | 438 → 439 → 440 | 31 → 12 | None |
| `/sys/fs/cgroup//memory.high` | `O_RDONLY\|O_CLOEXEC` | 20 | 441 → 442 → 443 | 31 → 4 | None |
| `/proc/meminfo` | `O_RDONLY\|O_CLOEXEC` | 20 | 446 → 447 → 448 | 4095 → 1447 | None |

Each occurs exactly once, in startup, as one successful open, one sequential read
and close. The doubled slash in the two cgroup paths is the actual observed
spelling; this is not permission for other aliases or normalization variants.
`/proc/self/maps` is a separate case: two startup opens, both with successful
same-FD fstat before reads. It needs no new missing-stat allowance.

The source-owned query is exactly `/proc/self/fdinfo/3`, where 3 is this run's
retained lifetime FD, not a general selectable descriptor. The sole literal
reader in the copied image is `controlled-child.mjs:39`, inside its original
`check()` callable. It opens **1225 times**, all with `O_RDONLY|O_CLOEXEC` and no
per-open stat: 2 startup, 1211 bootstrap, 12 after ack. Reader FD is 21 for 158
opens and 22 for 1067 opens. Every lifecycle reads 99 bytes, then EOF 0, requesting
8192 bytes for both calls, and closes on leader 4708. Representative lifecycles:

| Position | Open entry/completion | Read entry/completion, then EOF | Close |
| --- | --- | --- | --- |
| First startup | 3505/3508 | 3510/3512, then 3513/3515 | 3517 |
| First bootstrap | 3866/3866 | 3867/3867, then 3868/3868 | 3869 |
| First post-ack | 159689/159689 | 159690/159690, then 159691/159691 | 159692 |
| Last | 161043/161043 | 161044/161044, then 161045/161045 | 161046 |

The producer owner is handling the smallest source-owned change: replace that
one read with readonly open, explicit fstat on the opened query FD, bounded reads
on that same FD (4096-byte ceiling plus one-byte overflow detection), optional
same-FD final identity recheck, and finally-close. Keep the existing held-lifetime
fstat/named identity and actual flock check. Invoke this helper at every existing
`check()`, including startup and after ack. The query's own procfs `st_ino` is
**different from** the payload `ino:` naming the actual lifetime file; both
bindings must remain distinct. No Node/libuv-wide interception is proposed.

For the four native probes only, the proposed separately typed kernel-runtime
query contract needs prelaunch held-descriptor fstatfs evidence for procfs and
cgroup2, effective mount namespace/mountinfo, exact target resolution without
nested bind mounts or symlink redirection, and original leader/TGID/starttime
binding after launch. A supervisor's `/proc/self/cgroup` inode cannot stand in
for the child's process-relative object. Retain descriptor evidence and namespace
checks inside the same supervised execution, not in a separate shell command.
Reject alternate exec, mount/namespace/chroot changes, unknown query paths or
flags, mappings, vector/positional/write/control effects and extra/out-of-startup
invocations. Fully decode and bound all bytes; compare inode observations whenever
provided. Missing provenance still refuses. These bytes are kernel-generated
runtime telemetry, never immutable file bytes, a policy grant or qualification.
Service/private-state descriptor, inode, alias and publication obligations remain
separate and unchanged.

A **current, read-only feasibility probe**, not historical evidence, confirmed
fstatfs type `0x9fa0` for procfs nodes and `0x63677270` for cgroup2 nodes. Current
mountinfo reports `/proc` root `/`, and `/sys/fs/cgroup` root **`/..`**, both with
readonly mount options. The cgroup root field needs explicit retention/review as
kernel metadata; it must not be normalized or concatenated as an application
pathname. No mount/process provenance was captured before the historical run,
so current metadata cannot retroactively qualify it. This proposal retains the
trusted-kernel/stable-mount/cooperative same-UID assumptions and adds no path
exemption or acceptance. Fresh source/image/observations are required after the
producer owner's child change and the reviewed producer updates.

### Matching the source-owned helper candidate

Reviewed candidate #751 `557f62fbe86fc8371d48f11ec37bf9db71cac436` supplies the
source-owned helper. The observer now recognizes only the retained lifetime
fdinfo path with `O_RDONLY|O_NOFOLLOW|O_CLOEXEC`, requires its positive-inode
per-open stat, checks each request equals the unused 4097-byte sentinel buffer,
permits at most 4096 bytes, and requires EOF before close. The actual original
supervisor/flock/lifetime checks still apply. Other query flags are unchanged.
Grammar controls reject missing stat, pre-EOF close, oversize, old/broadened
flags and extra reads after EOF. The suite has 65 passing tests. This is not an
installed passing run against #751; hosted CI/source integration and a fresh
reviewed image pin remain prerequisites. No producer child edit was duplicated.

## 26 October continuation: finite trusted kernel runtime queries

`kernel_runtime_queries.py` implements the separately typed
`trusted-kernel-runtime-query-v1` contract for **only** the four native paths in
the table above. Supervisor originals are the sole input; no child report can
select a PID, mount, filesystem or query identity. This remains a draft requiring
source review and does not complete the broader semantic/effect audit.

Before launch the supervisor retains its actual namespace links and complete
mountinfo plus readonly descriptors for meminfo and both memory controls. It
checks real same-FD `fstatfs`, `fstat` and fdinfo mount IDs against the unique
covering procfs/cgroup2 mount. Component-by-component no-follow resolution refuses
symlinks, and mount selection refuses nested/covering or stacked bind mounts,
wrong filesystem/device/mount ID and redirected procfs subtrees. Mount roots are
retained verbatim; the observed cgroup2 root **`/..` is opaque metadata**, never
normalized or joined to an application path. Descriptors remain held through
replay, with namespace/mountinfo, held identity and live path rechecks.

`run_traced` now has an optional owned-launch callback inside its existing cleanup
scope. The supervisor captures its actual tracer child, then independently checks
the trace-derived original leader using a pidfd, held proc directory, kernel
TGID/starttime/UID/parent/tracer/group/session, executable, argv, root and inherited
namespaces/mountinfo. It opens `/proc/<owned-leader>/cgroup` without following
symlinks and retains that descriptor's physical/filesystem identity; the
supervisor's `/proc/self/cgroup` inode is never substituted. These checks repeat
before releasing the protected bootstrap command. A retained trace-line anchor
must lie inside that same leader's traced exec-to-settlement lifetime and before
command completion. The existing command wait suffices; no producer handshake,
child-supplied PID or Node/libuv instrumentation was introduced.

Replay requires all four exact `O_RDONLY|O_CLOEXEC` opens on the original leader,
in the observed order before any image JavaScript open. Each has exactly one
fully decoded, bounded short sequential read (requests 1023, 31, 31 and 4095),
then close. This finite shape **does not claim an observed EOF**. Repeats, changed
spelling, wider flags, extra/oversize reads, vector/positional/write/control
operations and file mappings refuse. If stat is present, device/inode/mode/owner
and size/link comparisons still apply against the held observation. The physical
alias table remains shared with all other objects. `/proc/self/maps` and the
source-owned lifetime fdinfo retain positive-inode per-open physical binding;
fdinfo also retains bounded sentinel/EOF and actual supervisor flock checks.
All service/private/credential/lease/publication/control checks remain in place.
Namespace, mount, chroot and alternate-exec changes refuse, including namespace
flags on clone. The assumptions remain trusted kernel, stable mounts and a
cooperative same-UID owned process group, without hostile-root containment.

Validation: **80 Python tests pass** using the command at the top. Controls cover
wrong filesystem, covering/bind/stacked mounts, redirected targets and a real
no-follow symlink attempt, wrong PID/TGID/starttime reuse/ownership, changed
namespace/mountinfo, missing pre-release observation and traced-lifetime
correlation, widened spelling/flags, excess/truncated/repeated bytes and
write/vector/positional/mapping/descriptor-control attempts. The wrong-filesystem
control uses an actual held temporary-file descriptor; covering mounts and
namespace changes are injected observations, without changing host mounts or
security settings. Existing maps missing-stat and inode replacement controls
continue to pass. `git diff --check` passes. These are grammar/negative controls,
not synthetic acceptance.

### Fresh exact-source bootstrap result: still refused

Final fresh local run: `/tmp/orca-controlled-replay-q3lv_8xz`, Node **24.19.0**,
producer source **`557f62fbe86fc8371d48f11ec37bf9db71cac436`**. The supervisor
built a new physical three-file image and checked all reviewed source bytes.

| Evidence | Exact value |
| --- | --- |
| Producer image SHA-256 | `c81477f96d56bdc89e56d96aaf35fa8c62c418080406c07c63db9f75b56585fd` |
| Child image SHA-256 | `a58036e5343fe07dac8625f7d5dfc2a7e0c6bfe660ddb1e96711b5b8d002e35c` |
| Build manifest SHA-256 | `d1fcc114c726ef11d77c31d9a862e7b407d03bf82b5c195a2270add15b0d0ad0` |
| Trace SHA-256 | `f2bef1af8e2dce04bc70e785464a1e6e48d5fa6d9b8772b34de7d35d40c4dc69` |
| Trace bytes / process elapsed | **109615721 / 9.006174950 seconds** |
| Producer / supervisor exit | **0 / 1 (refusal)** |

The 256 MiB trace/60-second process bounds and source's original 55-second owner
expiry are unchanged. Kernel replay completed the four native query lifecycles,
the reviewed fdinfo lifecycles, 12 settled threads and exactly one service pread
at offset 2, length 4, bytes `73706f73` (`spos`). The first remaining refusal is
**`RuntimeError: bootstrap expiry outside original bounded execution`**, from
`controlled_semantics.py`'s existing check that original execution ends before
expiry and expiry is at most the physical resource birth time plus 55 seconds.
That semantic condition was not relaxed or repaired in this bounded step.

An earlier fresh run with the same source/image also completed kernel replay and
refused at that same check: `/tmp/orca-controlled-replay-hi9yqv_f`, 109791682 bytes,
11.292822106 seconds, trace SHA-256
`8b8ba224c31f9d62b696a97ee02f699cd177ccee84447e9676818899f214be89`.
Neither run qualifies bootstrap. The supervisor has no accepting exit or
connected launch and released no connected token. Raw traces and retained
originals, including disposable private records, stay local. Parent retains
source review, CI and merge ownership; the separate main tampered-approval test
was not edited. Cal identity/assignment is retained on draft #748.

## Source-review follow-up: explicit leader effects and expiry operands

The common native-descriptor guard in `7fc8f3e` already required the original
leader for read/close. The follow-up makes that requirement explicit in each
native read and close branch as well. Two new negative controls exercise another
known `CLONE_THREAD|CLONE_FILES` member on **each of the four paths**, verifying
that a rejected read does not consume the query and a rejected close does not
remove its handle or advance startup completion. General private/resource
semantics are unchanged. The current Python suite has **82 passing tests**;
`git diff --check` passes.

Read-only regression replay of the preserved `q3lv_8xz` image/trace with this
follow-up completes the same kernel checks and reaches the same semantic refusal.
This is regression replay of the exact preserved image, not a new fresh bootstrap
or qualification. Its image and trace hashes remain as recorded above.

The retained operands of `controlled_semantics.py`'s actual predicate are:

| Operand | Actual epoch seconds used by Python |
| --- | --- |
| `startedWallTime` | `1793038623.3832116` |
| `finishedWallTime` | `1793038632.3893685` |
| authenticated `expiry` | `1793038680.23` |
| `resource.birth_ns / 1e9` | `1793038625.2270284` |
| `resource.birth_ns / 1e9 + 55` | `1793038680.2270284` |

Evaluating each conjunct separately gives:

* `startedWallTime <= finishedWallTime`: **true**.
* `finishedWallTime < expiry`: **true**, with 47.84063148498535 seconds remaining.
* `expiry <= resource.birth_ns / 1e9 + 55`: **false**, by
  0.002971649169921875 seconds in the actual floating-point evaluation.

The exact statx birth value is `tv_sec=1793038625`, `tv_nsec=227028421`, or
`1793038625227028421` integer nanoseconds. All **67** decoded statx birth
observations for resource device **0:33**, inode **876**, agree; first/last
one-based raw lines are **23284/160976**. Every returned mask is
`STATX_ALL|STATX_MNT_ID` (`0x1fff`), including `STATX_BTIME` (`0x0800`), rather
than a zero/default unreported birth field. The retained effective `/tmp`
mountinfo entry is tmpfs, device **0:33**, mount ID **106**, and the resource
statx also reports mount ID `0x6a` (106). This is retained mountinfo/statx evidence,
not a new resource-descriptor fstatfs measurement after its unlink/close.

Authenticated expiry is `2026-10-26T18:18:00.230Z`; subtracting exactly 55 seconds
implies the source's millisecond owner clock sample at
`2026-10-26T18:17:05.230Z`. Hence exact
`expiry - 55 seconds - btime` is **2,971,579 ns**. The earlier fresh run's same
quantity is **3,022,489 ns**. These inferred clock samples come from the reviewed
`Date.now()+55000` source and authenticated expiry, not independent wall-clock
samples in the trace. Snapshot construction precedes service construction and
the fixture creation syscall. Source order therefore supports the intended upper
bound if those timestamp values are directly comparable at the required
precision; an owner-origin mismatch is **not established** by this evidence.
The upper bound is against resource birth, not process launch. Expiry being
56.84678840637207 seconds after launch does not identify the failing conjunct.

Retained supervisor start/finish UTC values are
`2026-10-26T18:17:03.383212Z` / `2026-10-26T18:17:12.389369Z`.
Their difference is 9.006156921386719 seconds, versus reported monotonic elapsed
9.006174950000059 seconds. The phase log has only sent/received event order;
command consumption and acknowledgement occur at raw lines **3639/161019**.
**Exact phase wall timestamps were not retained**. The trace has no wall-clock
prefixes or decoded `clock_gettime`/`gettimeofday` calls establishing the owner
sample. No historical phase timestamps or clock adjustment conclusions are
invented from file times.

Coarse inode time is a supported hypothesis, not a proven cause for this run.
The kernel's [multigrain timestamp documentation](https://docs.kernel.org/filesystems/multigrain-ts.html)
explains jiffy-based inode stamping. Representative upstream Linux 6.18
[tmpfs source](https://github.com/torvalds/linux/blob/v6.18/mm/shmem.c) initializes
birth time from the inode's initial timestamp and returns it with `STATX_BTIME`;
[`current_time`](https://github.com/torvalds/linux/blob/v6.18/fs/inode.c) obtains a
coarse clock value before any applicable fine-time handling. These sources are
context, not attestation of the running kernel binary. A **current read-only**
probe on the same environment reports kernel release `6.18.55`,
`clock_getres(CLOCK_REALTIME)=1 ns`, and
`clock_getres(CLOCK_REALTIME_COARSE)=4 ms`. It does not retroactively measure the
clock used for the historical inode birth. Nanosecond representation and a valid
birth-time mask alone do not prove a fine-grained sampling instant.

The expiry predicate, 55-second owner bound, 60-second process timeout, clock
assumptions and refusing status remain unchanged. No guessed slack, launch-based
rebasing or circular `expiry-55` acceptance was added. A precision-based correction
requires separately reviewed evidence; this checkpoint proposes no numerical
allowance and creates no accepting or connected path.

## Fresh-observation correction: integer UNIX create-entry expiry bound

The supervisor now requests the installed strace 6.13 option
`--absolute-timestamps=format:unix,precision:ns`, verified against its actual
`--help` and an owned, harmless `/usr/bin/true` capability probe. `-ttt` is not
used because its default precision is microseconds. `-T` is not used. A normal
one-line record provides an **entry-prefix sample**, not a separately observed
absolute completion timestamp. The adapter preserves the original unfinished /
resumed raw-line framing; it does not derive a completion time from a duration
or substitute a resumed prefix for the resource's entry prefix.

The upstream 6.13 [entry decoder](https://github.com/strace/strace/blob/v6.13/src/syscall.c)
prints the prefix on syscall entry, and its
[prefix implementation](https://github.com/strace/strace/blob/v6.13/src/strace.c)
samples `CLOCK_REALTIME`. The supervisor retains the installed tracer path,
binary SHA-256, version/help digest, actual probe trace/digest and realtime
before/after samples. The probe must have exact nine-digit fractional UNIX
prefixes inside that independent wall-clock bracket. A different tracer version
or unsupported documented option refuses rather than changing host settings.

`controlled_timestamps.py` strips only this exact prefix before calling the
unchanged candidate event decoder. Missing, malformed, wrong-precision,
out-of-run or backward prefixes refuse, as do unrequested elapsed-time suffixes.
Every raw prefix remains in the preserved original trace and its kernel digest.
Supervisor start, phase-send brackets, acknowledgement observation and finish
are retained as integer UNIX nanoseconds, each surrounded by monotonic reads.
The samples must admit one common realtime-minus-monotonic offset within their
actual read brackets, without guessed tolerance. The run retains the independent
60-second monotonic limit and the unchanged cleanup helper. Boot identity,
installed tracer bytes and the actual namespace inventory are checked again.
This environment exposes no `time` / `time_for_children` namespace links; that
absence is explicitly retained from the real inventory, not synthesized as a
namespace identity. Available namespace checks remain in place.

The expiry check now uses only:

```
S <= C <= F < E <= C + 55_000_000_000  # all integer nanoseconds
```

`S` and `F` are independent retained supervisor samples; `E` is parsed from the
AES-GCM-authenticated, exactly UTC-millisecond expiry without float conversion.
`C` is the entry prefix of the already validated original leader's successful
exclusive fixture writer open. It is bound to the original resource object,
canonical resource path, exact open call/flags/mode/result and raw entry-line
index. Failed/readonly opens, other PIDs, duplicate resources, other objects and
completion-line substitution cannot supply this anchor. The exact reviewed
producer source `557f62fbe86fc8371d48f11ec37bf9db71cac436` and input SHA-256
`c9d4a7185bdb07d05b7f0ca192e65fc6efa574141862f3994c8cc35bbd584e86`
establish that expiry construction precedes service/resource creation. The
supervisor still verifies all original build inputs and image bytes; the expiry
check also requires that source ordering and the exact retained producer/child
image association.

This is a necessary conservative **post-owner create-entry anchor**, not a
measurement of the owner issuance instant. The source's 55-second owner duration
is unchanged. Btime remains part of physical metadata; it is no longer substituted
for a fine-grained wall-clock upper anchor. No guessed slack, lifetime extension,
clock-assumption change or accepting status was added. The old untimestamped
trace is still preserved and now refuses for missing timestamp provenance; it
cannot retrospectively pass this check.

Validation: **93 Python tests pass**, plus `git diff --check`. New controls cover
missing/wrong precision/format/clock, independent probe mismatch, child-supplied
timestamp rejection, backward/reversed/out-of-run times, incompatible monotonic
samples, fractional rollover, exact equality and +1 ns overrun, `F == E`,
failed/readonly/wrong-PID/duplicate/wrong-object/raw-line anchors, delayed
completion that cannot excuse excess expiry, missing source ordering and changed
image bytes. These remain grammar/negative controls, not synthetic qualification.
The earlier explicit native read/close leader checks remain clarity/regression
hardening: the preceding common guard already required leader/read-close-stat
shape, so no demonstrated read/close bypass is claimed.

### Fresh timestamped evidence: modeled checks complete, still incomplete status

The final fresh run is `/tmp/orca-controlled-replay-23z4v0qu`, using a newly built
physical image of reviewed source `557f62f`. Producer, child and build manifest
hashes remain the exact three hashes recorded above. It produced **112949571**
trace bytes in **10537562270 ns** (10.537562270 seconds), with producer exit **0**
and supervisor exit **2**, explicitly incomplete evidence. Kernel replay records
12 settled threads, one service pread (offset 2, length 4, `73706f73`) and the
retained query checks. Four semantic records authenticate/correlate, and the
new necessary expiry predicate passes:

| Value | Actual integer nanoseconds |
| --- | --- |
| `S` | `1793040346953488096` |
| `C` | `1793040349389751722` |
| `F` | `1793040357491049200` |
| `E` | `1793040404388000000` |
| `C + 55_000_000_000` | `1793040404389751722` |

The upper difference is **1751722 ns**; `E - F` is **46896950800 ns**. `C` is raw
one-based line **23320**, original leader **3605**, writer FD/result **21**, flags
`O_WRONLY|O_CREAT|O_EXCL|O_TRUNC|O_CLOEXEC`, mode `0400`. Its literal prefix is
`1793040349.389751722`. The raw line SHA-256 (excluding newline) is
`c2e0aab946cb89479b824a8109421eaa8a66993bdb342aadb6fcddbd2812a75b`.
The complete original timestamped trace SHA-256 is
`f62ed5f7621d2028f46ad60798d5951521e27b7edf4b4d52a4bbd594850f13a7`.
Installed tracer SHA-256 is
`69f88291a4e47f258b8e32b089c919a247509f063ef3d6afe5389939051102b3`;
its retained independent capability-probe trace SHA-256 is
`45a041ec60e3f4961cb2e17537163a21004220fac955fcff95745afc464a39e1`.

The first fresh timestamped bootstrap, `/tmp/orca-controlled-replay-itopmgup`, is
also preserved. It produced 112924716 bytes in 13490842087 ns, producer exit 0,
supervisor exit 1, and refused **`line 5434 read: ambiguous shared descriptor/path
interval`** (the diagnostic uses zero-based entry indices). An unfinished known
thread operation on shared FD 19 spans indices 5432–5436 while the leader reads
that FD at index 5434. No interval exception was introduced. Its trace SHA-256 is
`be34b2a129b52deaa478447053d64b3231c577b1b775d0e377c7876f8963d4e2`.
This refusal remains relevant to the outstanding interval/effect audit; the
second run's modeled completion does not dispose of it. A preliminary prelaunch
attempt stopped on an unavailable optional time-namespace link before Node or a
protected bootstrap command was launched; actual namespace absence is now
retained as described above.

The second run has no remaining modeled syscall/semantic refusal, but reports
**`unavailable-effect-audit-and-source-review-pending`**. The broader audit and
independent final source review remain required. There is still no accepting
exit, connected launch or connected token. Raw traces/private originals stay
local. Candidate `verify.py`, producer/runtime bytes, security settings and all
55-second/60-second/256 MiB bounds remain unchanged.
