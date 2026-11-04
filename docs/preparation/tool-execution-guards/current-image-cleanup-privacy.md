# Offline acquisition cleanup and public failure projection

Base: `7c4113d1425d68ed5b104e80260c3a99ddb1319e`, branch
`prep/706-current-main-nonlive`, draft PR #809. This increment advances two
preparation obligations from the [observation design](current-image-observation-design.md).
It does not execute, extract or expose the historical launcher for testing.
All four first-executable-statement refusal guards remain unchanged.

## Scope and ownership semantics

`offline_cleanup.CleanupScope` is a synchronous, single-threaded owner used only
by `current_image_inspection`. It imports no OS/process/launcher interfaces. Its
factory and disposer arguments are trusted Python functions, not commands or
authorization. The inspector supplies its existing read-only `os.open` operations
and `os.close`; all pathname, inode, type, size, byte and stamp checks are retained.

The owner reserves its tracking entry before calling a factory, then records the
returned resource before returning to the caller. A failed registration allocation
therefore precedes acquisition. If a factory raises, the scope becomes uncertain
and closes all earlier returned resources. A factory must itself release resources
that it acquired but never returned: the owner cannot discover such hidden state.

Cleanup is reverse-order and one-shot. Each entry is consumed before calling its
disposer, and every remaining disposer is attempted even after `BaseException` or
a non-`None` result. Return flags are not accepted as successful release. Reentrant
cleanup/acquisition poisons the in-progress outcome; admission after closure is
refused before running a factory. Repeated `close()` returns the same terminal
outcome without retrying a numeric descriptor that may already have been reused.
This is not a thread-safe ownership-transfer or worker/process-management API.

Terminal status is either `callbacks-returned` or `uncertain`. The former means
only that all registered disposers returned `None` without detected scope misuse.
It does not prove OS closure, process settlement, absence of hidden resources or
successful completion of the body. Its report explicitly has `authority: none`
and `processSettlementVerified: false`. If cleanup alone is uncertain, context
exit raises fixed text and the inspector returns no snapshot. If the body already
failed, its original exception object is preserved privately while remaining
cleanup still runs; exception text is never converted by the owner.

The owner cap is 39 resources, derived from the inspector's existing maximum of
one root descriptor, 32 path components and two descriptors for each of three
image files. No path-depth, file-size, trace, owner/run, process or cleanup timeout
was increased. Kernel failures can still leave release uncertain; the code does
not retry or claim that every OS close error is recoverable.

## Privacy projection

`public_summary` and `public_checkpoint` live in the already measured
`controlled_observation.py`, avoiding an unmeasured observer dependency. They are
pure fixed-schema projections and have no file, replay, builder, process or tracer
operations. `safe_summary` keeps its historical signature but delegates only the
private report dictionary, without reading paths or replay objects.

All input strings, digest strings, source identifiers, roots, paths, phase logs,
tokens, stderr, nested diagnostics and unknown fields are dropped. A string that
looks like a SHA-256 digest could still be a private token in a mislabeled field;
therefore format validation alone is not used to copy such fields. Public output
contains fixed record/reason strings and forces no authority, no accepting token,
no production eligibility and no observation authorization. It does not invent a
negative claim about whether commands were historically released.

Only exact integer `traceBytes`, `elapsedNanoseconds` and `returncode` values are
projected, bounded respectively by the existing trace limit, existing run limit
and the finite status range -255..255. Booleans, floats, NaN, infinities and strings
are rejected as these metrics. This is a display schema, not authentication of
the claimed numbers or a guarantee against covert encoding by a malicious trusted
producer. No report is accepted as an execution capability.

Checkpoints allow at most two attempt summaries, corresponding to the original
bootstrap/connected lanes. Malformed containers or excessive attempts produce a
fixed refusal; unknown/deep structures are not traversed. Both historical wrapper
write/return paths now use the projection and fixed failure reasons, without
`str(error)`, `repr(error)` or exception class names. These paths remain unreachable
behind their original first-statement guards. Tests call only the pure projections;
source checks verify guarded integration without executing or stripping a guard.

The original private supervisor reports, raw traces and receipt/correlation
validation are untouched. Public projection neither mutates those objects nor
supplies evidence to the original capability checks. Public output intentionally
omits even report digests; any later audited evidence-publication mechanism must
derive its linkage from retained private originals, not arbitrary summary fields.
Private capture/persistence of failures before an original run exists remains a
future launcher obligation; this increment does not claim a complete private
failure-storage protocol or execute a pre-run failure path.

## Independent review and validation boundary

Injected cleanup tests cover reverse one-shot release, partial acquisition at each
position, registration-allocation failure before the factory, multiple cleanup
failures, non-`None` cleanup returns, body-failure preservation, reentrancy, closed
scope/bound admission and a synthetic reused numeric handle. The latter is an
inert integer model, not a signal, OS descriptor-reuse proof or process-settlement
test. Existing real offline image tests exercise the owner with file descriptors,
including read/close failure and physical replacement checks, without image launch.

Privacy tests place private values into every formerly copied string/digest field,
cyclic nested diagnostics, unknown containers and exceptions whose `__str__` and
`__repr__` must never run. They check exact integer bounds, forced non-authority,
two-attempt limits, no I/O in `safe_summary`, and all four source-level guards.
The normal explicit non-live selector includes the new tests and retains its four
real-tracer exclusions. No alternative historical-launch test route was added.

All image inputs, native artifact bytes, legacy source pins, original historical
positive tests and runtime bounds remain unchanged. The inspection/observer
preparation code has a new source identity, with the standalone cleanup helper
inventoried separately. Historical fixture harness inventory is now 45 Python
files plus the reference JSON, copied only after disjointness checks and verification
that all 392 historical protected inputs are unchanged. Missing fixtures remain
failures, not skips. Local Python evidence is separate from ordinary Vitest CI.

Final test counts, exact source/log hashes and independent review coverage are in
the accompanying check/review records. These tests and callback outcomes are not
original process settlement, loaded-runtime proof or live qualification.

## Remaining gates

The historical launcher still lacks reviewed acquisition-scoped integration for
locks, pipes, probes, provenance, worker start and process ownership/settlement.
This helper does not perform or qualify that integration. Its original broad
cleanup body remains unexecuted; future work must account for every producer,
ownership transfer and failure edge without changing the existing bounds.

Authenticated original-session authority, preventive containment, immutable loaded
interpreter/module closure, private pre-run failure capture, and original
bootstrap-to-connected qualification remain unavailable. No boolean, JSON report,
CLI/environment toggle or cleanup outcome replaces those gates. Any future live
plan needs separate authorization for its exact environment, scope and unchanged
limits after the missing implementation/review obligations are addressed.

No observer/tracer/provider/daemon, App Smoke, designation, activation, merge, new
credential/access or security-setting action is part of this increment. The
#779/#793/#794 denials remain binding. Independent bounded implementation review
is not formal security approval.
