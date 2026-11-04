# Finalizer worker ownership precondition

Base: `160d7ebd752e2b62b92571bf6c492c6f3644c73c`, draft PR #809,
branch `prep/706-current-main-nonlive`. This follows
[diagnostic retention uncertainty](current-image-retention-rollback.md). The
historical observer remains unreachable behind the exact first-executable refusal.

## Prevent disposal before the original worker check

The historical control worker can still use `receive`, provenance pins and shared
attempt state when its bounded join times out. Previously the attempt finalizer
closed output/error pipe ends, `command` and `ack` before joining it. A live worker
only prevented `receive` close; lifetime/provenance disposal still followed.

The finalizer now first sets `run.closed` false and moves its existing
`worker.join(timeout=1)` ahead of every finalizer disposal. A check-only helper
requires the original local worker to have a non-None `ident` and report exactly
false from `is_alive()`. Join/state inspection failure produces fixed
`control-worker ownership uncertain` text with display chaining suppressed. The
original error remains private exception context. Failure leaves the remainder
of the finalizer unexecuted: no finalizer close, diagnostic retention or finalizer
report/original-packet write follows. No cleanup closure flag is granted.

The helper performs no join, wait, launch, disposal, callback or file operation. It
returns no capability or boolean. Each call inspects the supplied original worker
again; a prior result is not cached. The source integration passes the locally
created worker directly, not a report, `run.closed`, CLI/environment value or token.
This is a disposal precondition under trusted Python thread semantics, never
execution authorization, immutable loaded-code identity or process settlement.

There are still exactly three original `worker.join(timeout=1)` calls in the
historical observer, with one in this finalizer. No timeout or execution bound is
extended. Moving that join before pipe closes may withhold a signal that previously
helped the worker exit. The result is bounded refusal and retained ownership, not
an extra wait or closing first to force apparent success. No automatic recovery or
retry protocol is introduced.

## Ownership scope and remaining failure paths

This guard dominates finalizer operations only. Earlier successful-path closes of
`out_write`/`err_write`, worker writes and the worker's own `send` close may already
have occurred. The worker retains responsibility for `send` in its own `finally`;
that code is unchanged. A stopped worker does not prove its own cleanup succeeded,
or that the tracer/child/other processes settled. Retained numeric handles and
private traceback state are not durable recoverable ownership evidence.

After the precondition passes, the existing sequential cleanup is unchanged. An
individual close failure can still mask an earlier failure or skip later closes.
The normal path clears output-writer slots only after both closes; a partial
failure can therefore leave a consumed numeric handle for later cleanup to retry.
These acquisition/slot-consumption and cleanup-error precedence gaps are the next
concrete work. Early acquisition and worker-start failures still occur outside the
attempt's finalizer region.

The later diagnostic worker refusal and one-shot sampler retention rules remain
unchanged. No concurrent external `start`, `bind`, `capture`, ownership mutation or
arbitrary asynchronous interruption is qualified. A lock or mutable lifecycle field
alone is not a settlement guarantee. Runtime containment, authenticated original
session authority, bootstrap-to-connected qualification and loaded-runtime closure
remain unavailable. All four first-executable launch refusals stay exact.

## Injected and source-only validation

Seven new helper tests use inert worker objects with recorded property/method
access. They cover started/nonrunning success with no returned flag, absent or
report-shaped inputs, never-started/alive/nonboolean state, private identity/query
exceptions without string conversion, and fresh checks after state changes.
Adapters for OS/thread/tracer operations refuse if reached; no real worker, thread,
query, probe, process or disposal is used.

Three additional tests parse source only. They require the fixed closed-false and
join/refusal prefix to dominate finalizer disposal/writes, preserve all three
original one-second join calls, and preserve worker-owned `send` disposal. The
previous selection also verifies all four launch refusals and the later diagnostic
guard. No historical body is invoked, extracted or compiled for execution.

The initial targeted run passed eight methods and failed two source tests because
their selector chose the earlier lifetime-exclusion setup `finally`. Its full log
is retained separately. Selecting the unique attempt finalizer by its provenance
close corrected that test error without production changes or weaker assertions.
The combined corrected selection includes 10 new and 106 prior bounded methods.

Full Python selection, real host-query/self-pin/sampler tests, historical physical
regressions and image builds remain unrun. Ordinary CI does not run this Python
selection. Independent validation uses a separate checkout on the same host with
the Python harness disjoint from protected image inputs.

Only the supervisor's measured source identity changes; no observer dependency,
legacy source pin, declared image input, retained native output or bound changes.
No current-image designation or live proof is created. PR #809 remains draft, with
no merge/activation or App Smoke. The unknown PR-description mutation error remains
held without retry or workaround. Prior #779/#793/#794 denials and original CI
failures/root-cause uncertainty remain preserved.
