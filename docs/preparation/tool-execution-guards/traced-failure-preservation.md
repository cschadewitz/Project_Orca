# Traced failure identity and unsafe disposal

Baseline: `9d6cfe312493781e6578815260437a87de3b5005`, branch
`prep/706-current-main-nonlive`, draft PR #809. This is a local source correction
to [run.py](../../../tools/owned-read-proof/run.py), not process qualification or
an observation grant. Publication requires parent clearance.

## Interacting contracts

Previously, a callback/body or settlement error could be replaced by a later
`stream.close` or subreaper-restoration error. Losing `OwnedCleanupError` was
particularly unsafe: `proof_directory` preserves its disposable directory only
when that classification reaches it. Reraising an earlier ordinary body error
after failed settlement would therefore also be wrong.

The actual traced function now uses a private synchronous failure holder. It
allocates a fixed-message `OwnedCleanupError` carrier before child acquisition.
First failure and unsafe disposal are separate sticky properties. A settlement
failure or thrown acquisition without a returned process handle produces that
unsafe carrier, whose `_first_failure` preserves
the first detected exception object and `_settlement_failure` preserves the
first unsafe source object (including unavailable settlement after ambiguous start).
A captured `OwnedCleanupError` from another phase
also retains unsafe classification. Otherwise the original first exception is
reraised by identity. No successful result is returned after a recorded failure.

The detection order is the function's synchronous observation order: launch/body
(including callback, communicate and result construction), settlement, stdout
cleanup, stderr cleanup, then restoration. This is not global chronology across
processes or threads. Initial subreaper setup remains before child acquisition;
its failures propagate as before. The implementation does not claim every possible
asynchronous interruption or failed allocation is captured.

The first settlement failure still stops the original settlement sequence. There
is no added kill/wait/reap retry or broader child handling. The returncode decision
still precedes signaling: an already-reaped leader's numeric group is never signaled.
The original `process.wait(timeout=5)`, adopted-tracee five-second deadline,
`waitpid(-1, WNOHANG)` scope and 0.01-second sleep are unchanged. This preserves
the existing standalone sequential-supervisor assumption; it does not justify that
scope in a process with unrelated children.

Stream slots are consumed before each close attempt. The next eligible stream is
attempted after a close failure; a shared stream object is not closed twice.
Restoration is attempted once even after earlier failures. A failed close is not
proved release. `proof_directory` itself is unchanged: unsafe classification
prevents its `rmtree`; an ordinary settled body failure follows its existing removal
policy. A thrown `Popen` without a returned handle is conservatively unsafe: the
directory is preserved, with no inferred child absence, rediscovery or retry. No
kill/wait/reap is attempted without that original handle. Restoration failure alone
blocks success but does not assert unsettled
children when their existing cleanup returned normally.

## Private in-process evidence

The unsafe carrier uses a fixed public message with no original exception in its
arguments. Explicit `raise ... from None` suppresses implicit exception-chain
printing. The holder's representation omits contents, and both holder and unsafe
exception reject standard pickle serialization, including exception `__dict__`.
Those fixed serialization refusals also suppress active exception context.
Tests use falsey-sensitive `BaseException` objects whose string and representation
methods fail if called. No new report, traceback serialization or durable journal
is introduced. Original exception objects and tracebacks remain private in-process
references; trusted code can still inspect them. This is not same-process isolation.

## Validation and remaining obligations

The new tests replace whole ctypes, subprocess, OS, signal and clock dependencies
with strict inert adapters, including fake `CDLL`, `prctl`, `Popen`, communicate,
wait, killpg, waitpid, monotonic time and sleep. Other effectful dependencies are
forbidden. `proof_directory` uses inert temporary-path/removal adapters. The tests
exercise actual functions, not extracted copies of historical launcher code.

`test_cleanup.py` is deliberately not selected: it contains real Node/strace tests,
and its reaped-leader test leaves real `prctl` active. The selected adjacent suites
exercise only injected helpers and AST correspondence. Exact commands, counts,
hashes and independent review are recorded separately with this change.

All four first-statement launch refusals, the prior disposal gate, VM specimen,
source pins and limits remain unchanged. No image rebuild or designation, live
observer/tracer, thread/process experiment, host/network probe, provider, daemon,
App Smoke, CI or external mutation is performed in this local increment.

The [six G4 obligations](current-image-architecture-gates.md) remain incomplete.
An ambiguous exception before `Popen` returns still has no original process handle
or surviving recovery owner; conservative directory preservation and private error
identity do not settle or recover an unreturned child. Initial setup ambiguity, early acquisition ownership,
restoration uncertainty, process-group/EXITKILL correctness, actual process release,
durable private evidence and recovery after supervisor/guest loss remain unqualified.
Neither the carrier nor a normal return supplies runtime identity, containment,
session authority or original bootstrap-to-connected continuity. The disposable-VM
plan still requires the independently owned lifecycle and custody interfaces.
