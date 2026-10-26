# Controlled kernel publication and epoll causality — incomplete

This bounded kernel-only draft starts from frozen observer #748
`0e2045ce714103adc1bd435a83c8fdccc237fa19` on separate branch
`cal/controlled-kernel-causality`. It changes `controlled_replay.py`, its kernel
controls and this note. It does not move #748 or edit the supervisor, candidate
`verify.py`, semantic verifier/tests, producer/runtime, bounds or phase gates.
Parent coordinates integration with semantic draft [#755](https://github.com/cschadewitz/Project_Orca/pull/755)
`aa39c4c56a23dbcb5a75de70ec3575b9133b5383` and independent review.

## Additive provider contract

Every replay `Object` has `durable_publication_completion: int | None`, initially
`None`. A non-None value is a **zero-based raw trace completion-line index**.
It is never a wall-clock timestamp, duration or precise completion-time sample.
The old `publication_completion` remains the link/rename syscall completion and
must not substitute for the new field.

Availability requires the validated current file and physical parent-directory
objects, an actual physical file binding, a sole final name with the exact
publication association, and these completion-ordered observations:

```
creation completion <= last data write completion
    < writer fsync/fdatasync entry <= data-sync completion
    < writer close entry <= writer-close completion
    < link/rename entry <= publication completion
    < qualifying parent-directory fsync entry <= directory-sync completion
```

For a link, the exact original temporary alias must then be successfully
unlinked: `directory-sync completion < cleanup entry <= cleanup completion`.
The returned value is cleanup completion. For rename, temporary-alias removal is
atomic with the rename; its cleanup indices equal the publication indices and
the returned value is the later directory-sync completion. This does not assert
a separate post-unlink directory sync or crash-durable removal of the temporary
name. All required raw indices, including creation and durable completion, must
exist in replay's `entry_times` map. That map's prefix at a one-line completion
position is still only that syscall's entry timestamp; **no independently observed
absolute completion instant is inferred**. Precise effect-time evidence remains
the actual pread entry.

Explicit observations are retained as `creation_completion`,
`last_write_completion`, `data_sync_entry`, `data_sync_completion`,
`writer_close_entry`, `writer_close_completion`, `publication_entry`,
`publication_completion`, `directory_sync_entry`, `directory_sync_completion`,
`temporary_cleanup_entry` and `temporary_cleanup_completion`. The publication
method, physical parent-object association and exact temporary/final paths are
retained internally. Missing sync, identity, causal order, index or cleanup leaves
the additive field unavailable. A later unrelated sync does not erase the first
qualifying sync. Replaced named objects lose their current durable observation.
Write-only protected files receive the field only after the existing final
observer descriptor/name/content checks establish physical binding; merely
completing a syscall sequence cannot supply physical proof.

Link/rename/unlink paths now contribute their actual parent-directory object to
interval dependencies (also mkdir/rmdir). An unfinished namespace mutation and
cross-thread parent fsync cannot be ordered by replay entry: either overlap
orientation refuses. A qualifying sync must enter after publication completion,
and cleanup must enter after qualifying sync completion. No namespace or interval
exception is added.

This matches #755's required field shape: baseline, capture and authorization
objects may supply the optional integer only after complete physical publication.
There is no fallback to the older publication index. The semantic owner remains
responsible for consuming these indices and the actual resource pread entries;
no semantic predicates are duplicated here.

## Epoll watched-descriptor causality

Each registration additionally retains its actual `Handle` alongside watched
object and opaque event data. A wait validates that the number still maps to
that exact handle/object. Closing the last supported handle invalidates matching
registrations, retained handle bindings and event data across live epoll objects.
Reusing the FD alone cannot restore a registration; a fresh validated ADD is
required. Unsupported dup/transfer effects remain unsupported.

Wait intervals retain watched FD, handle, object and epoll-registration
dependencies. Watched close/reuse overlapping an unfinished wait refuses, even
when entry-order processing already removed the handle/registration. The reverse
close-before-wait overlap also refuses. These dependencies concern close/reuse,
not notification read/write operations or independent waits. Existing shared-FD
read/write interval rules remain unchanged.

## Actual validation and preserved refusal

`python3 -B -m unittest discover -s tools/owned-read-proof -p 'test_*.py' -q`
passes **111 tests**. New controls cover unfinished link/rename/unlink versus
parent fsync, unfinished fsync versus temporary cleanup, entry/completion
confusion, absent data sync/physical binding/raw index, wrong directory,
link/rename completion contracts, stale data/directory syncs that cannot settle
later writes/publications, later qualifying syncs, watched close/reuse during waits,
reverse overlaps, stale data, stale handle identity and last-handle invalidation.
The known FD19 overlap remains a negative control. `git diff --check` passes.
These are kernel grammar/negative controls, not synthetic service qualification.

Both original timestamped runs remain preserved and were replayed read-only:

* `/tmp/orca-controlled-replay-itopmgup` still refuses at **`line 5434 read:
  ambiguous shared descriptor/path interval`**. This uses zero-based indices.
* `/tmp/orca-controlled-replay-23z4v0qu` completes the current kernel model with
  12 settled threads and one actual service read. All six protected publication
  objects have the new physically bound field. Sidecar, credentials and lease
  remain unavailable where the required sync observations are missing. Their
  unavailable fields are not promoted to evidence.

The original trace hashes remain
`be34b2a129b52deaa478447053d64b3231c577b1b775d0e377c7876f8963d4e2` and
`f62ed5f7621d2028f46ad60798d5951521e27b7edf4b4d52a4bbd594850f13a7`, respectively.
This is regression replay of the exact preserved images, not universal success.

A fresh bounded attempt during this kernel work,
`/tmp/orca-controlled-replay-k3k1qgxr`, produced **112834519** trace bytes in
**11421621564 ns**, producer exit **0**, supervisor exit **1**. The final provider
rechecks its same refusal: **`line 4294 read: ambiguous shared descriptor/path
interval`**, again on eventfd 19. Its trace SHA-256 is
`90c72d559a324705a0769b8c53fa6e44b3220483e05c351d1a6915d350d673bf`.
Reviewed producer source remains `557f62fbe86fc8371d48f11ec37bf9db71cac436`;
producer/child/build hashes are the unchanged exact hashes in the
[preceding checkpoint](controlled-owned-read-replay-checkpoint.md).

### FD19 diagnosis, without suppression

In `itopmgup`, FD19 is the original retained **eventfd**, created with initial
counter 0 and `EFD_CLOEXEC|EFD_NONBLOCK`. It is not a private/service file or FD
reuse. Known worker 3278 writes 8 bytes encoding little-endian counter **1**,
entry index **5432**, completion **5436**. Original leader 3270 reads that same
modeled object at **5434**, requests 1024 bytes, and receives 8 bytes encoding
counter **1**. Nearby epoll waits/wakes corroborate notification traffic.

The write's independently observed entry prefix is
`1793040236676477383` ns; the read prefix is `1793040236676553224` ns.
Those entry samples do not establish exact write completion. The current generic
shared-FD mutation rule therefore still refuses their overlapping raw intervals.
The existing eventfd I/O decoder checks bounded results but does not implement a
complete concurrent counter-state model. A notification-specific allowance would
need a separate reviewed contract and controls; none is introduced here. The
preserved refusal and the fresh recurrence remain open audit evidence, regardless
of the other trace's modeled completion.

Raw traces/private originals stay local. No integrated #755 execution, full
qualification, accepting exit or connected launch/token is claimed. Parent owns
integration, independent kernel/semantic reviews, CI and any later gate decision.


Observed provider compatibility with approved #755 (preserved `23z4v0qu`, all
indices zero-based and present in `entry_times`; this is not integrated acceptance):

| Semantic object | Creation entry | Durable publication completion |
| --- | --- | --- |
| Baseline | 23899 | 24009 |
| Capture | 37636 | 37743 |
| Authorization | 125295 | 125400 |
| Producer observation | 159475 | 159585 |

The actual resource pread entry is **158479**. Each field belongs to its own
physically bound file. Baseline durable completion precedes capture creation;
capture durable completion precedes authorization creation; authorization durable
completion precedes pread entry. The provider shape has no identified mismatch
with #755's additive input contract. The kernel-only draft does not contain or
alter the semantic owner's files; subsequent integration must retain that owner's
commit ancestry and establish fresh evidence separately.
