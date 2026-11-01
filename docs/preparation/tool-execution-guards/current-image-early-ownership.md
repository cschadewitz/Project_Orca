# Early ownership inventory and inert first-failure model

Base: `e625d9c0e6f5979d50416f31010d4827ca9a387b`, draft PR #809,
`prep/706-current-main-nonlive`. This is a source-only inventory and an independent
inert model. It does not repair or execute the historical launcher. All four
first-executable refusal guards, source pins, image inputs and limits remain intact.
It extends the [offline cleanup preparation](current-image-cleanup-privacy.md).

## Source inventory

The following locations refer to the unchanged files at the base commit. Their
observations come from source inspection, not injected execution of these bodies.
The broad `observe` try/finally begins only after worker startup and `ObservedRun`
construction. An outer wrapper alone cannot recover resources hidden by a failing
constructor or settle a worker that still owns or uses a descriptor.

| Acquisition / transfer | Current source and ownership | Failure obligation still open |
| --- | --- | --- |
| Attempt directory | `controlled_supervisor.py:535-536`, before any broad cleanup | Retain a failed attempt for private evidence; do not equate directory removal with settlement. |
| Lifetime FD and flock | `controlled_supervisor.py:537-539`, supervisor-owned | Register immediately after open, before flock or later acquisition can fail; retain original lock identity through replay. |
| Independent exclusion FD | `controlled_supervisor.py:540-549`, local try/finally | Its close failure can replace the original exclusion failure; the lifetime FD is still outside broad cleanup. |
| Four pipe pairs | `controlled_supervisor.py:550-553`: command/send, receive/ack, stdout, stderr | Own the entire returned pair before per-end setup; later-pair failure must not strand earlier pairs. `os.pipe()` itself returns a pair or raises; the model's partial factory is a separate nested-constructor rollback case. |
| Plan, phase state and image/runtime reads | `controlled_supervisor.py:554-607` | Existing FDs remain owned across failures. Preserve original phase/capability lineage and private evidence; never recreate it from a report. |
| Clock probe | `controlled_supervisor.py:561-564` | `require_exitkill` and `probe_clock` may perform subprocess/tracer work before the broad cleanup. These paths were not invoked. Future ownership must cover that nested work without extending limits. |
| Query provenance | `controlled_supervisor.py:608`; `kernel_runtime_queries.py:113-144` | Constructor retains several FDs, and can raise before returning an owner. Each retained FD needs acquisition-scoped rollback inside the constructor. |
| Path walk and query FD registration | `kernel_runtime_queries.py:65-82,127-144` | The path walk opens a child before closing the predecessor; predecessor-close failure can strand the child and retry the predecessor in its exception path. A failure appending a newly opened FD to `self.fds` can also lose ownership. |
| Retained originals and trace | `controlled_supervisor.py:618-622` | Private writes/touch/chmod can fail before a private run report exists. Define bounded private first-failure retention and persistence without replacing it with public text. |
| Diagnostics | `controlled_supervisor.py:624-628`; `controlled_diagnostics.py:56-119` | Constructors have partial rollback, but sequential close can itself fail, mask the original error and leave another descriptor. Preserve first failure and continue owned cleanup; do not disable diagnostics. |
| Worker start and tracer callback | `controlled_supervisor.py:610-615,632-689` | `worker.start()` precedes the broad try. Worker owns send-close and uses receive/provenance; tracer ownership is bound asynchronously. Define exact ownership transfer and settlement before closing shared resources. |
| Leader query handles | `kernel_runtime_queries.py:146-174`, used from the worker | pidfd/procfd creation and append/adoption require partial rollback without substituting caller PIDs or weakening original process identity checks. |
| Final cleanup and reports | `controlled_supervisor.py:748-779`; `kernel_runtime_queries.py:199-202` | Sequential close can stop on the first error. A bounded join is not proof of settlement; other resources can still be used by a surviving worker. Report/private persistence can fail after cleanup. No retry of a potentially reused numeric descriptor. |

The wrapper functions also perform root/build/checkpoint preparation after their
first-statement refusal. Their public projections are already fixed-schema, but
they do not persist an original private error for failures before an `ObservedRun`
exists. This remains a separate obligation from public redaction.

## Inert implementation

`offline_attempt_model.py` imports only the existing pure `CleanupScope`. It has
no OS/process imports, caller-supplied acquisition/cleanup adapter, command, path,
PID, descriptor, runtime designation or connection to observer entrypoints.
`InertEndpoint` is a same-process synthetic token. Tests inject faults into model
methods and storage, never into an extracted historical launcher. Trusted model
objects remain mutable; this is not a security boundary against Python mutation.

`PrivateFirstFailure` stores the first original `BaseException` by identity and a
phase from a fixed exact-string set. Later acquisition/body/disposal errors cannot
replace it. It never calls exception `str`, `repr` or class-name formatting. Its
representation omits contents; pickle serialization is explicitly refused. Its
public status includes only fixed non-authority fields and failure presence, not
the exception, phase, traceback or supplied strings. This is not protection from
a trusted caller directly inspecting private state. An exception may retain
sensitive traceback frames, so its owner must bound its lifetime. No durable
private evidence storage is implemented or claimed.

The attempt reserves cleanup storage before constructing any pair, then gives
ownership of the entire pair to the scope before either endpoint is adopted.
Failure during either adoption leaves both endpoints owned. If internal pair
construction fails after creating one endpoint, that factory disposes its own
unreturned endpoint; it retains the acquisition error before attempting rollback.
This factory case models hidden resources in a nested constructor, not the kernel
semantics of `os.pipe()`.

Cleanup attempts pairs and endpoints in reverse order. A token is marked consumed
before disposal, and disposal failure never causes retry. Both ends and all earlier
pairs are attempted after failures. A body error is retained before cleanup and
propagates unchanged. Cleanup-only uncertainty prevents apparent context success.
The model allows at most four pairs, matching the inventoried four calls; this
model restriction changes no existing runtime or test timeout/budget.

Public outcome is `model-callbacks-returned` or `uncertain`, always with no authority,
no observation authorization, no process settlement verification and no private
evidence persistence. Successful inert disposal proves only the model transitions.
It does not prove FD closure, pipe behavior, scheduling, worker settlement or live
qualification. Returned reports are copies and cannot change retained outcomes.

## Validation and review

The new selection covers registration failure before construction; both partial
adoption positions; nested partial-factory rollback with a second cleanup error;
each disposal-failure position across four pairs; reverse ordering and first-error
identity; body/cleanup failure precedence; one-shot consumption; closed, failed and
bound admission; private representation/serialization; fixed public outcomes; and
absence of live imports or observer integration. All resources are inert objects.

The normal explicit non-live selector includes this module, retaining its existing
four real-tracer exclusions and 180-second outer bound. The companion checks and
independent review records identify exact files, fixtures, test counts and logs.
Historical-positive regression remains local and distinct from current-image
qualification and ordinary CI. Image outputs and inputs remain unchanged; the
separate Python harness inventory grows to 47 files plus its reference JSON.

## Integration decision and remaining work

No historical function imports this model and no historical body was edited,
extracted, invoked or bypassed. Independent design review agreed to defer source
integration: nested constructor rollback, worker ownership and process settlement
must be resolved together before an outer owner can be represented as adequate.
The inventory is a concrete prerequisite for that work, not a claim it is complete.

The next source-reviewable step is a constructor-local ownership design covering
every returned and unreturned query/diagnostic handle, with explicit error
precedence and disposal-once rules. Any implementation must retain original
identity checks, diagnostic behavior and fixed bounds; testing must continue to
avoid launching or extracting the guarded historical body. A private persistence
protocol must separately specify bounded capture, destination ownership, failure
handling and retention; the in-memory holder supplies none of those guarantees.

Authenticated original-session authority, preventive containment, actual loaded
runtime closure, original bootstrap-to-connected qualification and current-image
designation remain unavailable. No report/boolean/toggle/model supplies them.
Independent bounded review is not formal security approval. The #779/#793/#794
denials remain binding. PR #809 metadata updates remain on hold after the prior
unclassified error; branch publication and ordinary CI do not retry that action.
