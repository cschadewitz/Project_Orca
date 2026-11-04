# Sparse diagnostic registration and constructor rollback

Base: `e908c2d1c60d8555e296189b09ab178b17bce358`, draft PR #809,
`prep/706-current-main-nonlive`. This increment follows
[diagnostic pin rollback](current-image-diagnostic-rollback.md) and repairs the
outer owner in `controlled_diagnostics.py`. No historical launch body is invoked,
extracted or changed. All four first-executable launch refusals remain unchanged.

## Ownership transfer and original failures

`SparseDiagnostics.bind` keeps a successfully constructed pin locally until its
dictionary assignment returns. If assignment fails, it detaches a partial entry
only when that entry is the identical pin, then attempts pin cleanup once. The
existing process-role and duplicate checks still precede acquisition. Supplied
handles still pass to the unchanged pin constructor as borrowed inputs.

Once assignment succeeds, the dictionary owns the pin. A subsequent lock-exit
failure leaves that ownership registered; failed outer construction drains it.
An earlier body failure wins over a secondary lock-exit error. The exact original
exception object is re-raised without converting it to text, and the first failure
and first cleanup exception are retained in private in-memory fields. A later failed
bind raises its own error while preserving those first private records.
These records cover the wrapped acquisition/registration paths. Trace-path and
lock/event setup precede the constructor's protected region; unknown-role refusal
precedes the bind region. Those failures acquire no tracked descriptor and are not
recorded in `_first_failure`.

Constructor rollback consumes each registered pin before attempting disposal and
continues despite pin cleanup errors. It then clears the resource slot before
attempting resource close. Failed resource acquisition closes nothing. Failed
proc-stat reading/parsing or pin construction closes the acquired resource, and
pin-constructor rollback is not repeated by the outer owner. A failed constructor
has not started a sampler: this is not a general teardown path for a running owner.

Native `dict.get`, `dict.pop` and `dict.popitem` operate on the internally owned
dictionary during rollback. This avoids invoking overridden mapping methods in the
failure fixtures. Ordinary internal dictionaries, fixed role strings and trusted
object ownership remain assumptions; this does not support arbitrary hostile
mappings, concurrent ownership mutation or arbitrary asynchronous interruption.
The synthetic subclass that inserts and then throws exercises partial registration,
not a claim that normal Python dictionary insertion has that failure behavior.

The private holders may retain traceback frames and sensitive state. They are not
serialized here, do not provide durable bounded evidence, and do not establish
end-to-end privacy. Secondary lock-exit failures are not separately persisted.
An attempted disposal is not proof of kernel release or original process settlement.

## Injected validation and limits

`test_sparse_rollback` uses inert locks, pins, paths and threading factories plus
the earlier fake OS/counter/poll dependencies. No actual host descriptor, procfs,
cgroup query, sampler thread, process, provider or observer is used. Two tests
exercise the real unchanged pin constructor and close implementation under those
injected dependencies, checking exact fake-descriptor disposal order.

The 16 new methods cover successful transfer, insertion failure before and after
registration, cleanup and lock-exit failures, first-error precedence, existing-pin
preservation, role/duplicate refusal, resource-open failure, own-stat read/parse
failure, all registered pins drained despite disposal failures, and no repeated
pin-constructor cleanup. The combined selection also includes earlier injected
diagnostic/query rollback, pure native replay, inert attempt and privacy tests.

The full Python selector, whole diagnostic/real-query modules, real self-pin or
sampler tests, historical physical regression and image builds are not run in this
scope. Those tests remain intact and are not reported passing. Ordinary CI does not
run this Python selection. Independent validation uses a separate checkout on the
same host, with image inputs protected from the copied harness.

## Unchanged behavior and remaining work

The whole `PinnedProcess` class, reader/parser helpers, diagnostic capture/start/
stop/retain methods, imports, CONFIG and all limits remain unchanged. Only sparse
construction/bind and a private rollback helper change. The diagnostic module's
measured source hash changes; retained native output bytes, declared image inputs
and legacy source pins do not. No new build, loaded-code proof or designation is
created by this increment.

The next lifecycle gap is `retain_and_close`: `stop()` and value construction occur
before its cleanup `finally`, and one pin-close failure prevents later pin/resource
cleanup. Sampler startup/join failure and shared ownership require separate review;
constructor rollback must not be reused as a running-sampler disposal shortcut.
Existing private error-string formatting and file creation/chmod remain unchanged.

Leader-handle adoption, worker/process settlement, durable private evidence,
authenticated original-session authority, preventive containment, immutable loaded
runtime closure and original bootstrap-to-connected qualification remain open.
No report, boolean, CLI/environment switch or synthetic test authorizes execution.
Current-image designation, live qualification, activation and merge remain absent.

The PR-description update remains held with unknown error/denial classification;
this increment does not retry or work around that mutation. Prior #779/#793/#794
restrictions and earlier CI failures/root-cause uncertainty remain binding.
