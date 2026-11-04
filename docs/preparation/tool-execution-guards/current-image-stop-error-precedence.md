# Preserve the original error before diagnostic stop

Base: `a0ecb4daf2eb2dc77c3714d69fd852e0fd49fe6e`, preparation branch
`prep/706-current-main-nonlive`, draft PR #809. This follows the
[attempt cleanup transfer](current-image-attempt-cleanup.md).

The historical traced-attempt call now captures its original `BaseException` in
the existing private body-error slot before entering its diagnostic-stop finalizer.
The new `stop_diagnostics` helper attempts the existing stop at that call site and
records any lookup/stop exception in the separate cleanup-error slot. Immediately
afterward, `raise_first` rethrows the original body error, or the first cleanup
error if there was no body error, before later joins, clock checks or replay.
The outer handler keeps that same original object and its existing fixed refusal.
No exception is converted to text or tested for truthiness here.

The helper adds no acquisition, wait, retry or budget. It delegates to the existing
diagnostic stop, whose implementation can perform its existing bounded join and
final capture. One call means one call at this site, not one stop globally:
`retain_and_close` retains its existing independent stop and sampler-state checks.
An internally recorded capture error or an already-stopped return is not converted
into a new success/settlement claim. Stop return values are ignored, as before.

All four first-executable launch refusals remain unchanged. The historical body
is parsed and inspected only; it is never invoked, extracted or bypassed. Original
tracer arguments, three one-second joins, diagnostic implementation, ownership
transfer, worker-uncertainty refusal, source pins and image bytes remain unchanged.
This patch preserves error identity; it does not establish resource release,
original process settlement or current-image qualification.

Seven new inert helper tests cover absent/successful diagnostics, ignored return
values, original body versus stop/later cleanup errors, stop-only failures,
BaseException variants and method-lookup failure with a prior cleanup error.
Exceptions reject string/repr/truth conversion. External OS/thread/tracer adapters
are forbidden in these helper tests. Three source-only tests check capture-before-
stop, raise-before-following-join and the unchanged entry refusal. The prior 130
bounded methods remain selected without modified assertions.

Full Python selection, real host-query/sampler/thread/process checks, historical
physical tests and image builds are not run. Ordinary CI does not execute this
Python selection. No observer/tracer/provider/daemon or App Smoke is run.

Early acquisitions and worker startup still precede the protected main attempt.
Worker-owned send cleanup/error formatting, diagnostic path construction, partial
metadata writes and durable private-failure retention remain separate gaps. Real
stop implementation failures may still prevent settlement; retaining an exception
does not discharge ownership. Trusted serial ownership, authenticated authority,
preventive containment, loaded-runtime identity and original bootstrap-to-connected
lineage remain unqualified. No report/boolean/CLI/environment override is added.

Previous failures are retained: CI 41290279626 had two EADDRINUSE failures before
one passing retry; their precise phases/listener owners remain unknown. The three
original CI 41283402840 failures and unresolved latter-two causes remain separate.
Earlier local AST-selector failures remain recorded. Base-head CI 41292903413
passed its first attempt; it does not resolve those earlier causes. The held PR
description mutation remains unknown-classification and is not retried or worked
around. Restrictions concerning #779/#793/#794 remain binding.
