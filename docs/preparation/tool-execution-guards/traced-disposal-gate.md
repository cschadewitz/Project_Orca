# Original traced-call disposal prerequisite

Baseline: `4582a05c59a6715681b7c0b0c8f59479db180217`, preparation branch
`prep/706-current-main-nonlive`, draft PR #809. This local source correction addresses
the S7/S8 premature-disposal risk in the [architecture gates](current-image-architecture-gates.md).
It does not complete G4, M1 or any live qualification gate in the
[VM plan](current-image-linux-vm-plan.md).

## Specific source change

The historical `controlled_supervisor.observe` finalizer previously required only
control-worker inactivity before transferring eight descriptor slots and provenance
to cleanup. A failed `run_traced` can leave its original tracer or tracees unsettled;
worker inactivity does not establish their settlement.

A lexical local starts false immediately before the existing protected attempt and
becomes true only immediately after its direct original `run_traced` call returns.
The finalizer still checks the original worker first. It now refuses before any
finalizer slot transfer, clearing, provenance close, diagnostic retention or report
publication unless that original call returned. `run.closed` remains false on refusal.
The helper always raises: it preserves the existing captured body exception, then
the first cleanup exception, otherwise a fixed generic refusal. It does not convert
private exceptions to strings, truth values or public report contents.

The marker is not a function argument, report field, environment setting, receipt or
settlement setter. It cannot be supplied through the observation interface. It is
ordinary trusted source control flow, not protection against same-process hostile
mutation or an attestation of loaded code. All four first-statement launch refusals
remain unchanged, making the modified historical path unreachable through normal
entrypoints. No alternate launcher or wrapper is introduced.

## Conservative failure behavior

Any exception from the original call leaves the marker false, including callback
failure, interruption, `OwnedCleanupError`, stream-close failure or subreaper
restoration failure. An interruption after return but before the assignment also
refuses. This intentionally retains resources even when a failing call might have
completed cleanup. No retry or inference from a stopped worker is allowed.

A normal return depends on the existing synchronous `run_traced` cleanup completing
without propagating an error. That implementation, including its bounds, is unchanged.
This prerequisite is not independent proof that its process-settlement logic is
complete. Errors masked inside its stream/restoration finalizers are not recovered
here: the actual exception reaching the supervisor is preserved without conversion.
Later replay or report errors after normal return do not erase the fact of that
return. The independent worker and diagnostic ownership prerequisites still apply.

## Unwinding and custody limits

This change prevents explicit disposal by this finalizer on an ambiguous traced
outcome. It does not install a surviving recovery owner. The eight slots are raw
integer descriptors; losing references does not close them, but also loses the
bookkeeping needed to recover them. `KernelRuntimeQueries` and diagnostic pin owners
have explicit close methods and no destructor cleanup hooks in the inspected source.
`KernelRuntimeQueries.own_tracer` retains process identity data, not the `Popen` owner.
`ObservedRun` does not retain this whole live ownership graph.

Exception tracebacks may retain local objects while the exception is retained; caller
handling, garbage collection, interpreter exit or guest loss are not durable custody.
The Python `Popen` destructor source can warn, poll and retain a running child in its
module list. That is neither settlement nor recovery of the supervisor's graph. No
destructor or process behavior was executed to validate these observations.

Early acquisitions and worker startup before the existing protected attempt remain
outside this correction. Original process ownership on ambiguous launch, first-error
durability, all six G4 properties, external issuer/recovery ownership, preventive
containment, immutable actual-loaded closure and bootstrap-to-connected continuity
remain open. The next architectural prerequisite is an independently owned recovery
graph spanning acquisition through uncertain settlement, not another success flag.

## Validation and limits

The new tests execute only the actual refusal helper with inert errors. AST checks
verify the lexical marker, direct call/return placement, unchanged worker gate,
pre-transfer refusal, output-writer ordering and all four first-statement guards.
No historical body is extracted, compiled, invoked or bypassed. Existing inert
`test_attempt_cleanup` checks remain in the focused selection.

Commands and exact source hashes are recorded in `traced-disposal-checks.json`;
independent review is recorded in `traced-disposal-review.json`. These checks establish
bookkeeping, exception identity and source correspondence only. No process, thread,
host query, tracer, observer, provider, daemon, App Smoke or live test runs here.
No image rebuild, source repin, bound change, current-image designation, metadata
mutation or runtime qualification is included. The earlier retained image directory
is absent in this workspace; its artifact hashes are not freshly reverified.
