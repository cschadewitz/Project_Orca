# Controlled bootstrap replay checkpoint — incomplete

This observer-only draft starts from merged main
`aeb4ffb0e60fb4b553c70af3a4308b8b24a231d1`. The installed producer input pin remains
`6f208db363ec5091b42e2e2590fc10c7dbeb025d`; the package/builder/child diff between
those commits was verified empty. Each experiment builds and retains a fresh
physical image; previous observations never qualify a different image.

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
