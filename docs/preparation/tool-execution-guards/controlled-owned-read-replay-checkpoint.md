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
