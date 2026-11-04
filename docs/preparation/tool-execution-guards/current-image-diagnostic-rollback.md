# Diagnostic pin and reader rollback

Base: `d657abf644bcc31ae7febb16400dcb474ec0c939`, draft PR #809, branch
`prep/706-current-main-nonlive`. This increment repairs three existing functions
in the measured `controlled_diagnostics.py`: `read_at`, `PinnedProcess.__init__`
and `PinnedProcess.close`. It follows the
[query-constructor rollback](current-image-query-rollback.md) and does not change
the historical launch body or any of its four first-executable refusal guards.

## Actual ownership and error precedence

The pin constructor owns only successful acquisition results. A supplied pidfd or
procfd remains borrowed: `os.dup` creates the owned handle. A native pidfd or proc
directory open is similarly recorded in its initialized owned slot before later
setup. Expected identity fields, non-following flags, non-inheritable settings,
initial identity comparison and the initial `sample()` call are retained.

Previously, constructor failure called `close()` directly. If closing procfd failed,
the original error was replaced and pidfd was not attempted. The constructor now
initializes private error slots before acquisition, retains the exact original
exception in `_first_failure`, attempts cleanup and re-raises that original object
even when cleanup also fails. A missing expected identity field still refuses
before any acquisition.

`close()` clears each owned slot before attempting its close, continues through
both slots after failures, and privately retains the first disposal exception in
`_cleanup_error`. It then raises fixed `diagnostic pin cleanup uncertain` text with
exception display chaining suppressed. Repeated close cannot retry a consumed
numeric handle that might already have been reused. No terminal-success cache is
introduced: a later assigned owned slot is still drained, while earlier uncertainty
remains sticky. This is not a thread-safe ownership-transfer mechanism or OS release
proof; ordinary trusted Python object ownership is an explicit assumption.

The counter reader still opens relative to the supplied directory with the original
read-only/non-following/close-on-exec flags, reads `READ_BOUND + 1`, rejects oversized
data and decodes ASCII. On read, bound or decode failure, it attempts reader-FD
cleanup once and preserves the original exception if cleanup also fails. Secondary
cleanup failure in that path is not durably retained; a refusal is not proof that
the descriptor was released. The borrowed directory is never closed.

If the read succeeds but closing the reader fails, no data is returned. The helper
raises fixed `diagnostic reader cleanup uncertain` text with display chaining
suppressed; the original close exception remains private implicit exception context.
That includes `BaseException` failures: callers see cleanup uncertainty rather than
apparently valid counter data. The private context/holder can retain traceback
frames and sensitive state. Nothing here serializes it, bounds its lifetime across
an original attempt, or supplies durable private evidence storage.

## Injected validation

The new tests execute the actual constructor, reader and close methods with an
injected OS object. Pin tests use synthetic counter strings and a synthetic poll
interface; they exercise the unchanged real `sample()` logic without host polling
or procfs reads. Reader tests execute real validation and decoding over injected
bytes. No process, worker, sampler, image or historical body is started.

Coverage includes native, duplicated and mixed acquisition paths; failure of each
acquisition, inheritable-setting step and initial counter read; initial fstat and
identity rejection; no acquisition on missing identity fields; first-error identity
through multiple cleanup failures; disposal of both handles exactly once; refusal
after uncertainty; and later owned-slot disposal without retrying prior handles.
Reader cases cover original flags/read length, open failure without closing the
borrowed directory, oversized/non-ASCII data, primary read failure, secondary close
failure and success-path close refusal. Exceptions with failing `str`/`repr` detect
accidental conversion of private error objects.

The explicit validation command selects the new injected tests, earlier query
rollback tests, pure native replay controls and inert cleanup/privacy models.
Independent normal and optimized selections use the same boundary. The whole
`test_controlled_diagnostics` module and the full non-live selector are **not run**:
the existing tests use real self pins, cgroup counters and sampler threads. They
remain unchanged, not skipped/replaced or reported passing. Real-query tests,
historical physical image regressions and builds likewise are not rerun here.

## Preserved checks and incomplete integration

`PinnedProcess.sample`, `proc_fields`, `counters`, all `SparseDiagnostics` methods,
imports, CONFIG and every diagnostic read/sample/timing limit remain unchanged.
The edited module already belongs to the measured observer inventory; no new
observer dependency is added. Source identity changes for this module, while
producer/child/native-manifest bytes, declared image inputs and legacy source pins
remain unchanged. Rehashing source still does not prove loaded-code identity.

This fix does not resolve `SparseDiagnostics.bind` insertion failure after a pin
object was constructed, outer constructor resource rollback, sampler startup/stop,
concurrent ownership transfer or final retention cleanup. Those outer paths can
still mask an earlier error or stop cleanup prematurely. Existing private diagnostic
sample/error string conversion and file publication remain unchanged; the existing
public projection continues to omit them. No end-to-end private-failure guarantee
or complete diagnostic lifecycle qualification is claimed.

The earlier [durable-failure protocol outline](current-image-query-rollback.md#proposed-durable-private-failure-protocol--not-implemented)
remains unimplemented. No private fixture writer, authenticated session authority,
containment, storage permissions, credentials or host settings are introduced.
Broader leader-handle adoption, lock/pipe setup, original worker/process settlement,
loaded-runtime closure and original bootstrap-to-connected qualification remain
open. Inert or injected tests cannot establish those properties.

The companion checks/review records identify exact source hashes and test coverage.
Prior CI failures and their unresolved causes remain preserved separately from later
passing runs. Ordinary CI evidence is distinct from this Python selection.
Independent implementation review is not formal security approval. The PR metadata
hold and #779/#793/#794 denials remain binding; no metadata retry or alternative
route is used. No live observation, designation, activation, merge or App Smoke is
part of this increment.
