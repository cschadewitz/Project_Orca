# Query-constructor rollback and private failure retention

Base: `f68df5026a7d8e282ba170ccd0af1e89572f636b`, branch
`prep/706-current-main-nonlive`, draft PR #809. This increment implements a concrete
subset of the [early ownership inventory](current-image-early-ownership.md) in the
existing measured `kernel_runtime_queries.py` module. It is not connected to a new
launcher and does not change the four first-executable refusal guards.

## Actual ownership changes

The path walker previously opened a child, closed its predecessor, then recorded
the child as owned. If predecessor-close raised, its error path could retry that
predecessor and lose the child. The walker now transfers its owned variable to the
child before attempting predecessor-close. A failed predecessor-close is never
retried; the error path attempts the still-owned child exactly once. If rollback
also fails, the original exception object propagates unchanged, without formatting
either exception. No descriptor is returned from any failed walk. The secondary
walk-cleanup exception is not persisted; the refusal is not proof of OS release.

`retain()` now reserves an empty tracking slot before `open_exact()`. A reservation
failure therefore occurs before opening another descriptor. A failed open leaves
an empty slot, which cleanup consumes without calling close. A returned descriptor
replaces the slot before filesystem, inode, mount and metadata validation. The
tracking list is the owner's ordinary trusted Python list; this is not protection
against concurrent mutation, arbitrary Python replacement or interruption at every
bytecode boundary. No new per-process, path, query, trace or timeout bound is added.

The constructor establishes tracking and private error fields before initialization
and wraps its metadata reads and three global-query retentions. If any step fails,
all registered descriptors are drained in reverse order, including a descriptor
whose metadata validation failed. The original constructor exception is retained
by identity in `_first_failure` and re-raised even if cleanup fails. That private
object may retain traceback frames and sensitive state; no serialization, summary
or durable retention of those frames is implemented.

`close()` pops each descriptor before attempting disposal, continues after failures,
and privately keeps the first disposal exception in `_cleanup_error`. A disposal
failure produces only fixed `query descriptor cleanup uncertain` text, with exception
chaining suppressed. Repeated close raises the same fixed refusal without retrying
consumed descriptors. It does not cache a terminal success or skip newly registered
descriptors: existing later-adoption paths are not terminal-state gated. Successful
callback return is not independent proof that the OS released every object.

All original path spelling, non-following flags, query count/read limits, filesystem
types, inode/mount metadata, process identity and original capability checks remain.
No new observer dependency is imported. The changed module already belongs to
`OBSERVER_FILES`; its measured source hash changes, while producer/child/native
manifest bytes, image inputs and legacy source pins remain unchanged. Mutable disk
measurement still does not establish the identity of already-loaded Python code.

## Deliberately unmodified ownership gaps

`bind_leader` still has append-after-open windows for pidfd/procfd acquisition; its
worker/provenance ownership transfer requires separate review. Diagnostic constructors,
clock probes, lock/pipe setup, worker startup, shared resources and final supervisor
settlement are not repaired by this patch. No historical launch body is edited,
extracted or exercised. Existing helper functions remain query/descriptor helpers;
no alternative launcher, injected production adapter or authorization flag is added.

Cleanup failure can still mean an unreleased OS object. The patch prevents selected
ownership loss/retry paths and preserves error precedence; it cannot prove process
settlement or make the original runtime eligible for observation.

## Injected validation boundary

New tests call the actual `open_exact`, constructor, `retain` and `close` functions
with a synthetic OS object and synthetic path/namespace/filesystem interfaces. They
never open host descriptors, inspect live procfs, invoke ctypes probes, launch a
worker/process or call the historical body. The tests retain the real validation
logic over synthetic inode/mount values, including refusal of wrong filesystem
types and preservation of the opaque cgroup mount root.

They cover each path-open failure, predecessor-close failures, secondary rollback
failures, each constructor query acquisition and post-registration failure, every
constructor reservation failure, multiple cleanup failures, private error identity,
unchanged flags, repeated disposal and later registration after uncertain cleanup.
Exceptions whose `str`/`repr` raise detect accidental private error conversion.

The ordinary non-live selector gains the new tests, but is **not run in this
increment**: existing `test_kernel_runtime_queries` methods
`test_real_symlink_redirection_and_wrong_held_filesystem_refuse` and
`test_changed_namespace_and_mountinfo_refuse_without_mutating_host` instantiate
real host queries. Those tests remain unchanged and are recorded as not run, not
skipped or replaced. Validation explicitly selects injected tests and pure replay
controls, plus the existing inert ownership/privacy checks. Historical physical
image regressions and earlier full non-live runs remain separately dated evidence.
No new claim of full Python-suite or real-query qualification is made.

## Proposed durable private-failure protocol — not implemented

The in-memory exception holders do not provide durable evidence. A future writer
needs a reviewed protocol independent of public projection and execution authority:

1. **Origin and owner:** the original trusted supervisor owns a private attempt
   record before its first acquisition. A preexisting authenticated session must
   bind that attempt to the exact loaded implementation and permitted scope. That
   session and loaded-code binding are currently unavailable; a report, source hash,
   boolean, CLI/environment flag or newly written record cannot supply them.
2. **Destination:** use an independently owned, prevalidated private directory and
   retained directory descriptor outside child-writable roots. Define create-only,
   non-following, single-link ownership checks and private modes before creating
   evidence. No arbitrary path from a producer or error is accepted. This proposal
   neither creates that destination nor changes host permissions/security settings.
3. **Content and bounds:** persist a fixed schema of constant operation/phase codes,
   first-failure presence, and bounded cleanup-attempt outcomes. Original private
   artifacts remain separate immutable originals. Do not serialize arbitrary
   exceptions, traceback frames, `str`/`repr`, argv, environment, paths or tokens.
   A raw Python exception cannot preserve its in-memory identity across restart;
   the record must not claim that it does. Exact schema and byte cap must be reviewed
   before implementation within existing artifact bounds, not chosen at runtime.
4. **First-error precedence:** reserve the first-failure slot before risky work and
   preserve it against later cleanup/write/fsync failures. Distinguish acquisition,
   disposal and evidence-storage uncertainty. A failed evidence write must never
   erase or overwrite the original record or become a success/settlement marker.
5. **Commit and failure:** define complete-write, file-sync, atomic create/publication
   and directory-sync ordering with one-shot ownership of every FD. Interrupted or
   uncertain persistence leaves observation refused; no blind close/write retry,
   truncation of existing evidence, cleanup of another attempt or synthetic closure.
6. **Retention and access:** define who can read retained originals, how long they
   remain, and how authorized cleanup behaves after uncertainty. Public output stays
   fixed-schema and omits raw private exception state. Neither a stored record nor
   a public summary may be accepted as a capability or formal approval.

This is a reviewable protocol outline, not a storage implementation, authenticated
containment proposal or deployment plan. It deploys no isolation, credentials or
live probes. Runtime containment still needs its own exact trust origin, threat
model, immutable loaded-code binding and approved environment/data/resource scope.

## Evidence and outstanding gates

Companion check/review records identify the exact source delta, injected/pure test
selection, independent coverage and unchanged artifacts. The preceding head's CI
passed on one failed-job retry; its original three failures and unresolved causes
remain in the earlier recovery evidence. They are not erased by this preparation.

Independent implementation review is not formal security approval. Original session
authority, preventive containment, loaded-runtime closure, worker/process settlement,
durable private capture, original bootstrap-to-connected qualification and current
designation remain unavailable. The #779/#793/#794 denials and PR-description update
hold remain binding. No metadata retry or alternative publication route is used.
