# Leader-loop eventfd notification contract — draft, no acceptance

This narrow kernel follow-up starts at #756
`1d2dd1c6602526e9e2db52925f55928551808f0c`. It does not change candidate
`verify.py`, the supervisor, producer/runtime, namespace/path/resource checks,
phase gates, or the 55-second/60-second/256 MiB limits. Semantic #757 is a
separate reviewed component; any combined preparation is recorded separately.

## Why the old refusal occurs

All five preserved timestamped traces contain the same original notification
role. An owned leader creates `eventfd2(0, EFD_CLOEXEC|EFD_NONBLOCK)`; its main
loop registers that exact handle/object once with an owned leader-created epoll,
EPOLLIN and event data equal to the descriptor number. The observed descriptor
happens to be 19, but that number is not the role designation. Known workers and
the leader write exactly eight bytes encoding native little-endian uint64 one.
Only the original leader reads it, requesting 1024 bytes and receiving exactly
eight fully decoded bytes. Returned counters are 1, 2 or 3 in these traces.
No descriptor controls, vector I/O, alternate flags, semaphore or nonzero initial
counter appear in these lifetimes.

The current retained Node binary matches the original runtime digest. It reports
Node 24.19.0/libuv 1.52.1 on x64. That libuv version's
[Linux async implementation](https://github.com/libuv/libuv/blob/v1.52.1/src/unix/async.c)
uses this initialization and write-one/read-buffer shape. This corroborates the
native notification role; no stack trace or exact native call site is claimed.
Linux's [eventfd contract](https://man7.org/linux/man-pages/man2/eventfd.2.html)
returns the normal counter and resets it on read. The
[kernel implementation](https://github.com/torvalds/linux/blob/v6.18/fs/eventfd.c)
serializes counter changes under its lock. A kernel increment may therefore be
consumed while strace has not yet printed the writer's resumed return. Raw
interval overlap alone does not establish inconsistent counter effects.

## Exact qualification and proof

The proposed `leader-eventfd-unit-notification-v1` domain is deliberately finite:

* The actual successful zero-counter eventfd factory record and original handle
  must be retained. Creation is by the original owned leader with exactly the
  already supported CLOEXEC/NONBLOCK flags. No path, report JSON or producer
  label selects this type. The handle must remain unique and match its original
  factory object; descriptor reuse/aliases cannot qualify.
* The exact live handle/object must have one qualifying owned leader epoll
  registration: original EPOLL_CLOEXEC factory, successful leader ADD, EPOLLIN,
  and event data equal to its current descriptor. Its binding must still be
  live and unchanged. A registration entry never substitutes for its completion.
* Writes are only successful eight-byte uint64 **one** increments. Reads are
  only successful original-leader reads requesting **1024** and returning eight
  fully decoded bytes containing a positive normal counter. Unknown counts,
  truncation, partial results, EAGAIN, zero/overflow reads, vectors, alternate
  readers and controls refuse this domain. Prior noncanonical effects taint it;
  later unreviewed effects invalidate it. No generic error-result allowance is
  imported from the existing internal-I/O decoder.
* The **entire original handle lifetime**, including any pre-registration unit
  I/O, is retained and decoded. A valid active role only makes same-handle
  read/write overlaps provisional candidates. The kernel report remains
  unavailable until a full counter-state proof succeeds and all other existing
  replay checks pass.

`controlled_notifications.py` checks one single-reader normal counter. Successful
unit writes commute. For each observed drain it consumes interval-eligible writes
with the earliest completion bounds, rejecting an unavoidable unconsumed earlier
write or a drain needing a future/nonexistent unit. It also checks per-thread
call order and unique raw boundaries. Every unit must be consumed by the final
observed drain; the proven final counter is zero. This is a partial-order witness
for **counter effects only**, not a guessed kernel linearization timestamp.
No witness ordering is applied to publication, private files, callbacks, service
reads, control channels or authority records. It provides no callback-completion
or policy authority.

Only a pair of fully decoded read/write records on the same original qualified
notification handle can bypass the generic same-FD I/O-overlap refusal, subject
to that deferred lifetime proof. General ambiguous shared descriptor/path
rejection remains intact. Close/reuse, epoll lifetime/registration mutation,
descriptor controls, private/service I/O, namespace operations, mappings and
phase-boundary intersections receive no exception. All records, original raw
intervals, bytes and the complete raw trace digest remain present. Unqualified
counter roles retain the original rejection. An unused leader counter or the
worker-loop counter is not silently promoted to this role.

Current evidence needs no new producer/runtime instrumentation: initialization,
all unit writes/drains, exact descriptor roles and raw intervals are already
observed. If a future run lacks these observations or uses another grammar, it
must refuse; this delta does not expand the profile to fit it.

## Controls and all preserved outcomes

The kernel branch has **143 passing Python tests** with
`python3 -B -m unittest discover -s tools/owned-read-proof -p 'test_*.py' -q`;
`git diff --check` passes. New controls cover counter conservation, impossible
future/missing/double-consumed/unavoidable units, unread tails, duplicate raw
boundaries, noncanonical bytes/counts/results, wrong reader/factory/creator/epoll
owner/registration/data, controls before/after qualification, close/reuse and
private-file lookalikes. A different descriptor number can qualify only through
the same factory/handle/epoll proof. Existing FD19-style unproven overlaps still
refuse. A separate exhaustive oracle checks 620 small interval histories by
enumerating all valid counter operation orders and agrees with the proposed
counter algorithm; it shares no deadline/greedy implementation.

Every preserved timestamped trace was replayed with this proposed kernel model:

| Original run | Unit writes | Successful counter reads | Typed overlap pairs | Final counter |
| --- | --- | --- | --- | --- |
| `itopmgup` | 900 | 891 | 1 | 0 |
| `23z4v0qu` | 901 | 892 | 0 | 0 |
| `k3k1qgxr` | 900 | 892 | 1 | 0 |
| `0844smhv` | 902 | 894 | 1 | 0 |
| `bxhnugvl` | 901 | 892 | 1 | 0 |

All five complete the current kernel model. This does not erase or rewrite their
original reports: four originally refused the generic eventfd overlap; the
second completed the older modeled kernel checks. Their raw traces, images and
original refusals remain local and intact. No trace was selected to hide another
outcome. Counter proofs are non-authoritative `notificationCounterProofs` in the
kernel evidence, with original creation/registration positions and overlap count.
This is regression evidence, not fresh integrated qualification or an accepting
exit. The source-trust/UUID-issuance and other semantic limitations remain those
of the separate reviewed semantic scope.
