# Private control-worker failures and consumed send ownership

Base: `8e8cecc2cad5195dc0023cc2338aaf5771a61048`, branch
`prep/706-current-main-nonlive`, draft PR #809. This continues
[original-error capture before diagnostic stop](current-image-stop-error-precedence.md).

The historical control worker previously appended `repr(error)` to a shared list;
its final send close could also escape through thread exception reporting. A
separate `AttemptCleanupFailures` instance now retains the original worker-body
exception and first send-close exception privately, without formatting or testing
exception truthiness. The main attempt's holder remains separate.

In the worker's existing finally, the original `send` slot is copied and cleared
before one close attempt. The close helper catches `BaseException` into the worker
cleanup slot. No main-finalizer ownership of `send` is introduced: its existing
eight-handle group remains exact. A failed close is not retried from a consumed
slot. This is caller bookkeeping, not a replay-resistant descriptor registry or
proof of OS release; deliberately replaying an old numeric snapshot is unsupported.

At each of the two existing main-path joins, the existing inactive-worker helper
now precedes the private worker-error read. The helper requires a started worker
and exact false liveness; uncertainty refuses without reading the holder. An
original worker-body error wins over its send-close error. Either prevents apparent
main-path success. A prior main traced/body failure still wins and does not inspect
the worker holder: the outer finalizer and its uncertainty/ownership policy remain
unchanged. This is observation-order precedence, not a total chronology across
threads. Only the original trusted worker writes its holder; main reads after the
inactivity gate. No new lock, join, wait, retry or budget is added.

All four first-executable launch refusals, tracer arguments, control-body effect
operations, three one-second joins, source pins and retained image inputs/outputs
remain unchanged. The historical body and its nested control function are inspected
as source only, never invoked, extracted or bypassed. Real worker settlement and
concurrent lifecycle safety are not established by these changes.

Six new inert helper tests cover normal/zero handles, consumed slots, close-only
failure, original worker-body precedence, no repeated close from an empty slot and
BaseException capture. Five AST tests check private capture, exact worker-finally
transfer, both join/gate/read sequences, holder separation and main-finalizer
exclusion of `send`. The existing worker-finally assertion is updated to require
the exact consumed-slot sequence; its ownership, join-bound and refusal assertions
remain. The bounded selection contains 151 methods. No real OS close, worker,
probe, diagnostic stop, observer/tracer/provider/daemon or App Smoke is exercised.
Ordinary CI does not run this Python selection.

Privacy remains partial. Original exception objects retain potentially sensitive
frames, and an outer caller printing a re-raised exception can reveal them. Existing
diagnostic sampler strings remain separate. No durable bounded private-evidence
store or sanitized public exception API is supplied. Early acquisitions/worker
startup still precede the protected main attempt; partial metadata, diagnostic path
failure and retained uncertain resources remain gaps. Authenticated authority,
preventive containment, loaded-runtime closure and original process settlement are
unavailable. No image designation or live qualification follows from inert checks.

Base-head CI 41293856721 remains failed: the moved-home reanchor assertion rejected
with EADDRINUSE at port 56294. Independent read-only analysis separates the observed
assertion failure from inferred root-slot acquisition and unknown listener identity.
No retry, fixture assertion change or production fence change is part of this guard
increment. Earlier CI/local failures and unresolved causes remain preserved. The
unknown-classification PR-description hold and #779/#793/#794 restrictions remain.
