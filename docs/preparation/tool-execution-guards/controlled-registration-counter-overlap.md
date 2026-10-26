# Finite eventfd registration overlap proposal — incomplete

Refs #699 / #706; follows #768 head
`f70c437596458d0969d9873300b34f16360741c7`. This preparation adds one narrowly
deferred kernel grammar case. It changes no producer, provider, credentials,
process/tracing limits, source designation or accepting gate. Independent review
is required before another original attempt.

The [instrumented diagnostic](controlled-connected-aggregate-observation.md)
remains refused at original observer
`935d5193aa3eea3cb0c61c2859c5ee9542bd590d`: worker unit write raw4091–4093
overlaps leader epoll ADD raw4092–4094. Its complete trace remains 113151210 bytes,
SHA-256 `e7ce418b8da24f77420240f41fed4dd7dbdc751e46afddf26b0235d4a9856e91`.
Neither that refusal nor the preceding 60-second timeout is relabeled acceptance.
The historical timeout cause remains unresolved. No new original ran here.

## Source basis and trust limits

The measured native runtime digest remains
`bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12`; a local
version query reports Node 24.19.0 / libuv 1.52.1. libuv's
[`async.c`](https://github.com/libuv/libuv/blob/v1.52.1/src/unix/async.c)
initializes a zero nonblocking non-semaphore eventfd, writes uint64 one from async
send, and reads into a 1024-byte buffer. Its
[`linux.c`](https://github.com/libuv/libuv/blob/v1.52.1/src/unix/linux.c#L1320)
registers queued watchers during polling with event data equal to the descriptor.
These sources corroborate the observed native shape; an exact native call site
or private callback identity is not independently measured.

Linux v6.18
[`eventfd_poll/eventfd_write`](https://github.com/torvalds/linux/blob/v6.18/fs/eventfd.c#L109)
provide the key race argument: poll installs its waiter before testing the
counter, ordered against writes under the waitqueue lock. A concurrent unit
increment is therefore either visible to the readiness check or supplies a
wakeup after installation. Registration does not consume or change the counter.
[`ep_insert`](https://github.com/torvalds/linux/blob/v6.18/fs/eventpoll.c#L1536)
installs the poll hook, checks current readiness and enqueues a ready item; later
event delivery polls readiness again. This supports the bounded ADD/unit-write
case without selecting an entry-order linearization or asserting callback work.

The observed release is 6.18.55. Upstream v6.18 is the reviewed semantics
reference, not a measured source/build attestation for that running kernel.
Trusted kernel/native runtime and supervisor, stable mounts/clocks, cooperative
same-UID isolation and absence of unobserved descriptor aliases remain explicit
assumptions. No hostile-process or arbitrary-memory theorem is added.

## Smallest closed grammar change

`Replay.registration_write_overlap` can defer exactly one conflicting pair per
original eventfd/epoll role. Both raw entry orders are handled. It requires:

* Completed original leader factories: `eventfd2(0, EFD_CLOEXEC|EFD_NONBLOCK)`
  and `epoll_create1(EPOLL_CLOEXEC)`, settled before both operations enter.
* The same unique original handle/object for each anonymous descriptor, with no
  alias, stale replacement, prior taint, previous registration role or epoll
  descriptor control. Numeric 19/16 are observations, not role identifiers.
* One actual known, unsettled worker writing exactly eight decoded bytes encoding
  uint64 one, result eight; one original leader ADD, result zero, EPOLLIN only,
  event data equal to the target fd. Failed, MOD/DEL, alternative masks/data,
  partial/vector/nonunit writes and another overlapping operation do not qualify.

The generic shared-descriptor/path guard still sees both full records and raw
intervals. A narrow ledger records the original objects, handles and both records.
It grants no ordering fact and forces a whole-lifetime proof before the kernel
report can return. A later completed original registration and valid leader drain
must establish the same role. A ledger with no qualified drain cannot be ignored.

`prove_registration_overlap` then requires every original counter read to enter
after ADD completion, and only the designated unit write may intersect ADD.
The existing complete normal-counter proof must account for every original unit,
counter drain, raw boundary and thread order, ending at counter zero. No local
success Boolean or isolated read/write pair substitutes for that history.

The target cannot be re-registered, MOD/DEL'd or moved to another epoll; epoll
descriptor controls invalidate the new domain. Existing other-watch and epoll
wait/close/reuse interval guards remain in place. Original live handles/watch/data
must still match at proof time. Any explicit target or epoll close must begin
after ADD and every counter operation actually completes. Both settled close
orders are supported; closing/reusing while an operation is outstanding remains
refused. A settled closed object's proof cannot be borrowed by a replacement fd.

This is a notification counter/readiness argument only. It supplies no ordering
or authority for private publication, Save, current authority, human delivery,
service dispatch or callback completion. All remaining full replay, physical,
semantic, notification, phase, clock and source obligations are unchanged.

## Controls and retained-trace analysis

Tests cover both entry orders; absent/incorrect/missing-final drains; wrong
factories, aliases, data/masks/results and worker identity; nonunit/partial/vector
or private-file I/O; a second overlapping writer/read; target/epoll close or reuse;
later MOD/DEL/other-epoll registration and descriptor controls; original closed
lifetimes; and live handle/watch replacement. A settled pre-registration unit
followed by registration and drain remains a positive control.

The candidate classifies all **155717** decoded events in the preserved diagnostic
trace offline, including 12 settled threads. Its full notification theorem finds
**904 unit writes / 895 drains / final zero**, one counter-I/O overlap and one
registration/write overlap. This is offline event/counter analysis only: no new
original ran, original final named physical checks were not performed by that
refused invocation, and no live process/descriptor/permit is reconstructed.
The original observer bytes/report/refusal remain unchanged. This analysis is not
complete bootstrap replay, semantic validation, connected release or acceptance.

Validation: 278 Python tests pass (9.938 s), 29 optimized notification controls
pass (0.055 s), and `git diff --check` is clean. The measured committed candidate
is `c69aee3d7a9310c2e174cbf9dbd082e9abc44cfa`; all 15 executable observer files
were checked against that commit before offline classification and rehashed
afterwards. The complete original trace and originals packet hashes were checked
before analysis. The local sanitized checkpoint is
`/tmp/orca-connected-diagnostics/offline-registration-committed-candidate.json`,
SHA-256 `425e2e9f4ead8a36dbc635e773740093235fed94b5b91852533f35cc47e2b80e`.
It explicitly records that original final physical and semantic checks were not
performed. Raw traces and protected records remain private locally.
