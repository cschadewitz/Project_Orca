# Attempt cleanup transfer and first-error ordering

Base: `c1018de914ae1e03cc93a2e6f7ace68275f2a804`, draft PR #809,
branch `prep/706-current-main-nonlive`. This follows the
[finalizer worker precondition](current-image-finalizer-worker-guard.md). All four
first-executable launch refusals remain exact; historical integration is inspected
as source only, never invoked, extracted or bypassed.

## Consume local ownership before disposal

The historical normal path now snapshots its two output-writer handles, clears
both owning local slots, then attempts both closes. A failure on either writer
therefore cannot leave an already-consumed writer slot for the finalizer to retry.
The finalizer still refuses before transfer if the original control worker's join
or state is uncertain. Its existing one-second join and all execution limits remain.

Once that precondition passes, the finalizer snapshots its eight descriptor slots
and original provenance owner, clears all corresponding local ownership slots,
then attempts each non-None descriptor and provenance close independently. The
helper accepts only exact tuples of length two or eight: the existing groups, not
an open-ended iterator. It acquires nothing and adds no join, retry, launch or worker
settlement operation. Worker-owned `send` and the earlier setup `other` descriptor
remain outside these groups and unchanged.

The helper is not a reusable resource owner or a global FD registry. The source
caller consumes its persistent ownership slots before transferring the group; it
must not deliberately replay an old snapshot. Distinct original live descriptors,
trusted tuple contents/OS/provenance methods and serial ownership are assumptions.
Historical numeric references in evidence or traceback frames are not cleanup
ownership. Attempted close does not prove release, and no callback result supplies
execution authority.

## Retain the first error through later eligible stages

`AttemptCleanupFailures` holds the first main-body error separately from the first
cleanup/finalization error. Only the outer main-body exception handler writes the
body slot. Descriptor/provenance failures, diagnostic retention failures and final
metadata/publication failures enter the cleanup slot in attempt order. None checks
are explicit; errors are never tested for truthiness or converted to text here.

Normal writer cleanup failure is raised after both closes, then captured by the
main-body handler as the same original object. Eligible finalizer cleanup continues
through descriptor/provenance errors, then attempts diagnostic retention and final
metadata work. Earlier failures remain sticky even if later work succeeds. Existing
refusal fields receive fixed text. The holder has a fixed representation and refuses
pickle serialization; it is not added to the report or `ObservedRun` dataclass.

The finalizer raises the first main-body error if present, otherwise its first
cleanup/finalization error. Only after that check succeeds can `run.closed` become
true. This intentionally changes the unreachable historical failure behavior:
instead of returning an `ObservedRun` containing a refusal, a failed attempt raises
the retained exception after eligible cleanup/evidence attempts. On worker
uncertainty, the original body error wins if one exists; otherwise the fixed worker
refusal is raised. No transfer, disposal or final evidence write follows uncertainty.

This is private in-memory error precedence, not durable evidence. Exception objects
may retain sensitive frames; callers that later print exceptions are not made
privacy-safe by this holder. Existing worker error formatting, diagnostic sample
strings and outer wrapper projections remain separate obligations. Partial files
may remain if final metadata/write/chmod fails; there is no atomic rollback or
guarantee of a new persisted final report.

## Validation boundary

Ten new helper tests use fake OS closes and inert provenance owners. They cover
each descriptor and owner failure, combined errors, body-over-cleanup precedence,
diagnostic/metadata ordering, consumed normal writers omitted from the final group,
invalid/unbounded input groups, and private representation/pickle refusal. Four new
source-only tests verify actual slot transfer, fixed body capture, finalization
error classification, diagnostic continuation and closed-true ordering.

Two existing AST controls were adapted to the reviewed source shape: the attempt
finalizer is selected independently of an inline `provenance.close` now delegated
to the helper; the diagnostic guard must still immediately precede the retention
call, even with path construction inside its error handler. Worker uncertainty still
dominates all transfer, cleanup and writes. All three original joins, their exact
one-second bounds, worker-owned send cleanup and four entry refusals remain checked.

No historical body is executed to test this integration. The corrected combined
selection contains 14 new and 116 prior bounded methods. Full Python selection,
real host-query/self-pin/sampler/worker tests, historical physical regression and
image builds are not run. Ordinary CI does not run this Python selection.

## Remaining gaps and retained evidence

Early acquisitions and worker startup still precede the protected main attempt.
The inner `run_traced`/`diagnostics.stop()` finally can still replace an earlier
execution error before the outer body handler sees it; this holder does not recover
an error already lost there. Worker-owned send cleanup and its error formatting are
unchanged. A diagnostic path-construction failure can prevent entering diagnostic
retention; other diagnostic uncertainty intentionally retains its resources. The
metadata block stops at its first failure and does not promise all later writes.

Concurrent lifecycle admission, durable recovery of retained ownership, original
child/tracer/process settlement, authenticated session authority, preventive
containment and immutable loaded-runtime closure remain unresolved. No cleanup
flag, report or synthetic test qualifies those properties.

Only the supervisor's measured source identity changes. Legacy pins, declared image
inputs, retained native outputs and original bounds remain unchanged. No new image
build, designation, live observation, activation or merge is performed. Prior local
AST-selector failures and original CI failures are retained. In particular,
CI 41290279626 had two EADDRINUSE test failures on its first attempt and passed one
same-source failed-job retry; exact failing phases/listener owners remain unknown.
Earlier CI 41283402840 uncertainty remains separate. The PR-description mutation
hold and #779/#793/#794 restrictions remain untouched, without retry or workaround.
