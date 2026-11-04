# Create-only private diagnostic artifact

Baseline: `8c9a62de3ccc622e3657466c03c91b1f288bd08f`, preparation branch
`prep/706-current-main-nonlive`, draft PR #809. This corrects the actual final
artifact writer in `SparseDiagnostics.retain_and_close`. It does not instantiate
the durable custody protocol required by the [architecture gates](current-image-architecture-gates.md).

## Exact change and accounting

The former `Path.write_text` could truncate an existing artifact; the later
`Path.chmod` resolved its name separately from the writer. The replacement opens
the same destination once with `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC`
and initial mode `0600`. Any existing leaf, including a regular file, symlink, FIFO
or directory, refuses before modifying it. A successful acquisition is followed by
`fchmod(fd, 0600)` before the first payload byte. It never uses `O_TRUNC` or reopens
the path for permissions.

The writer completes positive short writes using only the remaining memoryview
suffix. Each successful write advances at least one byte and cannot claim more than
the remaining payload. Zero, negative, Boolean, non-integer or oversized progress
refuses. A write exception is not retried at the application level. Once all bytes
are accepted, the same descriptor receives one `fsync`, followed by one close.
No result returns if write, sync or close fails.

This uses the existing final artifact name and payload, one writer descriptor in
place of the former file object's descriptor, and no temporary/sidecar name or
simultaneous second file version. The existing compact JSON value is encoded as
UTF-8; no fields, schema, accepted receipts, quota pools or numeric limits change.
The payload and memoryview bound the write-loop progress, not aggregate allocation
or elapsed I/O time. File sync adds one operation on that same descriptor; it adds
no resource acquisition, timeout, retry or reservation claim.

Existing sample/read/period/join limits do not establish a complete serialized-byte
allocation. In particular, this change does not invent a bound for preexisting error
strings or treat report/trace limits as spare diagnostic capacity. An encoded payload
also occupies memory before publication. Aggregate bytes, memory, I/O latency, owner
allocations and recovery accounting remain unqualified. No arbitrary new cap is
introduced to hide those gaps.

## Failure, ownership and privacy

The original one-attempt retention state and sampler identity/inactivity gates remain
unchanged. The supervisor's control-worker and traced-return gates are unchanged too.
Only after the existing borrower conditions allow disposal does the retention method
drain eligible pins/resource ownership, even if artifact creation or writing fails.
`consumed` records cleanup bookkeeping; it is not a successful publication marker.

On a writer-body failure, close is attempted once and a secondary close failure does
not replace the original exception. A close-only failure propagates its own exception.
There is no retry of the numeric handle, uncertain write, sync or retention attempt.
No failed artifact is unlinked or overwritten: a newly created empty, partial or
possibly complete file may remain, and exclusive creation refuses a later writer.
An ambiguous close may leave a resource whose recovery is not provided here.

The existing retention catch keeps the current primary exception by identity, without
string/repr/truth conversion, while its earlier `_first_failure` remains sticky.
Independent cleanup failures keep their existing precedence. No writer exception is
added to the JSON payload. `SparseDiagnostics` now explicitly refuses standard pickle
serialization so private failure references cannot escape through its `__dict__`;
that refusal suppresses active exception context with `from None`. Trusted code can
still inspect private attributes and tracebacks. The existing sampler's diagnostic
payload and error-string collection are unchanged, not newly audited or sanitized.

## What this does not establish

Ancestors and the fixture root are trusted. Exclusive non-following creation protects
the final leaf at acquisition; it does not protect hostile ancestors, later namespace
replacement, the loader or the evidence consumer. A synthetic replacement test shows
that chmod/write stay on the acquired inode even when the original name is replaced.
That deliberately demonstrates the absence of an authenticated name/custody binding.

There is no directory descriptor or directory fsync, atomic rename/commit marker,
external acknowledgment, recovery owner or authenticated evidence transport. Directory
sync failures therefore have no implemented path to test. Successful file fsync is
not a durable pathname publication, a guarantee about physical media, or permission
to consume the artifact as qualified evidence. Completing durable custody requires
the owner allocations, namespace ownership, schema/accounting and recovery contracts
already missing from G4/G7; this primitive does not supply them.

## Validation boundary

New tests execute the actual writer and retention method with strict inert OS and
thread/query/clock dependencies, or only test-created isolated temporary files. The
synthetic filesystem cases exercise an ordinary file, symlinks, FIFO and directory,
private mode, exact bytes and descriptor/name separation. No existing production
data, host counters, real thread/process, tracer or provider is accessed.

Adjacent rollback/ownership/error-precedence suites use inert dependencies and AST
source correspondence. The physical `test_controlled_diagnostics.py` and
`test_cleanup.py` modules are excluded because they probe real process state or start
threads/processes. No historical observation body is invoked, extracted or bypassed.
The four launch refusals, prior `run_traced` correction, disposal gate, VM specimen,
source pins and all limits remain unchanged. No image rebuild/designation, CI,
App Smoke, metadata mutation or publication is part of this local increment.
