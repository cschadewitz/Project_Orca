# Diagnostic retention ownership and uncertainty

Base: `5b848936192e4274f34b095eb19311565781cbef`, draft PR #809,
branch `prep/706-current-main-nonlive`. This follows
[sparse registration rollback](current-image-sparse-rollback.md). It changes
diagnostic retention bookkeeping and adds a disposal refusal in the unreachable
historical supervisor body. All four first-executable launch refusals remain exact.

## One retention attempt, no inferred settlement

Each constructed diagnostic owner admits one `retain_and_close` attempt. Admission
immediately changes its private state from `ready` to `uncertain`; repeated or
reentrant calls refuse before stop, writing or cleanup. There is no retry path from
uncertainty in this increment. This is internal disposal bookkeeping, not a runtime
authorization capability or a report that can permit observation.

The method snapshots the sampler object, calls the existing `stop()` once, and adds
no join or wait budget. Stop failure with any sampler object present retains every
pin and the resource descriptor, even if the sampler might have finished. Stop
failure with no sampler before or after can dispose under the trusted single-owner
assumption. A successful stop must leave the identical sampler object; if present,
its `ident` must show it started and `is_alive()` must return exactly false. An alive,
never-started, replaced or uninspectable sampler refuses and retains ownership.
The mutable `stopped` field alone is insufficient.

Once disposal is eligible, value preparation, serialization, path construction,
writing and chmod are inside the cleanup region. Cleanup marks the attempt
`consumed`, removes each pin's dictionary ownership before attempting its close,
attempts all pins despite disposal errors, then clears and closes the resource
slot. Original operation errors retain identity and precedence; the first private
failure and cleanup records remain sticky. A cleanup-only failure produces fixed
`diagnostic retention cleanup uncertain` text and no successful result.

`consumed` means ownership slots were consumed for disposal attempts, not that the
OS released handles. Private error objects may retain sensitive traceback state.
There is no durable failure writer or new retention bound. A file written before a
chmod or cleanup failure may still exist; this code does not promise atomic private
publication, rollback, removal or successful evidence retention. Existing file
creation/chmod order and private data formatting are unchanged.

## The original control worker is another diagnostic owner

Source review found that the historical `control` worker can still call `bind`
after its bounded join times out. Immediately before diagnostic retention, inside
the existing diagnostic error handler, the supervisor now checks that the original
local worker has an `ident` and reports exactly non-running. Uncertain results and
inspection errors produce fixed refusal text before `retain_and_close` is called.
This check uses the worker object, not `run.closed`, a report, CLI/environment input
or a synthetic authorization field. It adds no wait and is not execution authority.

That body remains unreachable behind the unchanged first-statement refusal. Tests
only parse its source and verify the guard dominates its retention call. They do
not invoke, extract, compile for execution or otherwise bypass the historical body.
The additional check protects diagnostic disposal at that call only. Earlier pipe,
lifetime and provenance cleanup still occurs before it and remains an unresolved
ownership gap when the control worker is live or uncertain.

Trusted ordinary Python thread semantics, object identity and serial ownership are
explicit assumptions. No concurrent external `capture`, `bind`, `start` or object
mutation is permitted by the reasoning here. The retention guard does not prevent
all later lifecycle misuse; those other methods remain unchanged. The sampler lock
alone cannot prove global quiescence because capture reads resources outside it.
Started/non-running checks and diagnostic `samplerStopped` metadata establish no
tracee or original process settlement, loaded-runtime identity or launch authority.

## Bounded validation

The new test module uses inert thread objects, fake OS handles, in-memory paths and
synthetic pins. Two tests invoke the unchanged real `stop` implementation with
inert dependencies, including its original one-second join argument. No real
thread, host query, probe, process, provider, observer or tracer is started.

Cases cover no sampler and started/non-running sampler; alive, never-started,
replaced or uninspectable sampler; stop failures with and without a sampler;
preparation/serialization/path/write/chmod failures; each and combined disposal
failures; sticky private errors; and reentrant/repeated attempts without repeated
side effects. Source-only tests verify the new original-worker disposal guard and
all four launch refusals. These are bookkeeping/error-precedence and source-shape
checks, not OS release, thread settlement or live qualification.

The full Python selector, real host-query/self-pin/sampler modules, historical
physical regression and image builds remain unrun. Ordinary CI does not run this
Python selection. Independent validation uses a separate checkout on the same
host with the copied harness disjoint from protected image inputs.

## Remaining obligations

The next ownership gap is the earlier historical finalizer: pipe/lifetime/provenance
disposal can precede proof that its control worker has stopped. Uncertain retained
diagnostic ownership also needs a separately reviewed resolution protocol; this
increment intentionally provides no automatic retry. Sampler start failure and
concurrent lifecycle admission remain incomplete. Atomic private file creation,
bounded durable first-failure storage and existing private string conversion remain
unresolved, as do original process settlement, authenticated session authority,
preventive containment and immutable loaded-runtime closure.

The diagnostic and supervisor measured source hashes change. Declared producer/image
inputs, retained native outputs, legacy pins and all bounds remain unchanged. No new
build, current-image designation, original bootstrap-to-connected qualification or
live proof is created. PR #809 stays draft, with no merge or activation. The held PR
description mutation remains unknown and is not retried or worked around. Prior
#779/#793/#794 denials and original CI failure history remain binding.
