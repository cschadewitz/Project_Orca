# Fixed diagnostic failure codes and private collection identity

This source-only preparation is based on `34bcb55780c728c04b29e05d90fb717f421e729f`.
It changes the actual collection paths in
[`controlled_diagnostics.py`](../../../tools/owned-read-proof/controlled_diagnostics.py).
It does not enable an observer, qualify an image or instantiate external custody.

## The four projections

| Existing output location | Fixed replacement value |
| --- | --- |
| Process sample `diagnosticError` | `process-sample-failed` |
| Resource sample `diagnosticError` | `resource-sample-failed` |
| Sampler `errors` item | `sampler-work-failed` |
| Final capture `errors` item | `final-sample-failed` |

Field shapes, counter collection, resource names, sample/read/period/join limits and
artifact count are unchanged. The process/resource handlers still catch only
`OSError`, `RuntimeError` and `ValueError`; sampler/final handlers still catch
`BaseException`. No arbitrary exception string, representation, truth value,
dynamic class name or traceback is consulted to produce these codes. Normal
measurement fields are unchanged; this is not a new general data sanitizer.

## Detection and ownership order

The original owner now holds one private `_collection_failure` reference. It is
initialized before the owner is shared. Every subsequent conditional write uses
the existing process-pin lock, through `_remember_collection_failure` while that
lock is held. A process failure is recorded within the existing process sampling
lock. A resource failure acquires the same lock after detection. The sampler's
outer failure records after unwinding capture. Final capture follows the existing
join and inactive-sampler check, and records under that lock too.

The first successfully recorded collection exception wins by object identity;
`is None` is the only vacancy test. This is lock-serialized recording order, **not
global chronological failure order** across threads. No new lock or thread is
introduced. Structural constructor/bind/retention `_first_failure` and disposal
`_cleanup_error` remain separate, with their existing precedence. They do not race
or overwrite the new collection slot. Recording a collection failure still does
not create an execution authority, receipt, successful collection or settlement
result. Existing error codes remain visible when retention can complete under its
original ownership gates.

Private errors and their traceback state remain only in source-owned process
memory. The existing owner pickle refusal applies to the new slot, including
when called during an active private exception handler. The slot is absent from
the explicit retention JSON projection. This is not a sandbox against arbitrary
same-process introspection, an independent surviving owner or durable first-error
storage. Failure of lock acquisition/release, arbitrary asynchronous interruption,
allocation failure and hostile replacement of internal objects remain outside this
bounded correction. Added lock acquisition has no newly established latency bound.

The create-only writer, retention consume-once/borrower gates, traced-failure
classification, traced-disposal gate, VM specimen, source pins and all four
first-statement launch refusals are unchanged.

## Bounded evidence

[`test_diagnostic_codes.py`](../../../tools/owned-read-proof/test_diagnostic_codes.py)
executes actual capture/start callback/stop/retention paths with inert OS, path,
clock and thread adapters. The callback runs synchronously on the test stack; no
thread is created. Private subclasses refuse string, repr, truth and class-name
projection; a separate falsey error verifies identity retention. Tests cover all
four sites, unchanged catch classes and limits, continued good collection, private
first recording versus later errors, exact existing JSON shape, and owner pickle
refusal with active exception context. Adjacent injected and AST suites cover
unchanged lifecycle and writer contracts. These are bookkeeping and serialization
checks, not concurrency, OS settlement or physical durability qualification.

Exact commands and results are in [diagnostic-safe-codes-checks.json](diagnostic-safe-codes-checks.json).
Independent bounded review is recorded in [diagnostic-safe-codes-review.json](diagnostic-safe-codes-review.json).
No physical diagnostic/cleanup suite, observer, tracer, App Smoke, image rebuild,
remote workflow, host probe or metadata mutation is part of this local slice.

## Next cohesive external-custody milestone

The [VM plan, section A](current-image-linux-vm-plan.md#a-owner-handoff-before-setup-approval)
and [architecture G1/G4/G7 gates](current-image-architecture-gates.md) require an
actual owner outside the candidate and guest rollback domain. Manual **pve2 console
host custody remains the selected direction**, not an authenticated issuer
integration. A dedicated serial transport remains an unimplemented concept, not an
available provider or a substitute for that owner.

The coordinator's read-only repository evidence pins the existing
[homelab access lead](https://github.com/cschadewitz/homelab/blob/be6b000e33ff9d4ef5b385be29f5a9b2ce6f8ae3/ops/pve2-setup/README.md)
to `be6b000e33ff9d4ef5b385be29f5a9b2ce6f8ae3`. That packet is **OFFLINE REVIEW ONLY**:
its proposed interface permits inventory only; create/status/start/shutdown refuse.
VMID 260, `guard-observer-01`, 4 vCPU/8 GiB/64 GiB, no NIC and Debian 13 are
unverified, unapproved proposals, not reservations or observation budgets. Earlier
root BatchMode authentication failed and must not be retried. Bootstrap would need
Casey's existing root password session and independent recovery console; no automated
host access is authenticated. Key/account enrollment supplies neither observation
authority nor loading, containment or private evidence custody. This is a pinned
ownership/access lead, not a host probe or a usable external custodian. This slice
does not change that separate repository or ask for any secret.

The next milestone is an **owner-bound original-attempt custody contract for the
actual pve2 setup**, ending in an independently reviewed setup packet, before any
provisioning or live admission. It must name the surviving operator/controller,
its authenticated control surface, the exact VM generation and original supervisor
association, and an allocated private evidence destination outside guest rollback.
Engineering can then map reservation, one-time lane consumption, fresh connected
authorization, revocation, uncertain acknowledgment and original-resource recovery
to those real interfaces. Manual console actions must have explicit custody and
recording responsibilities; a candidate report, flag, digest or inert acknowledgment
cannot supply them. No relaunch follows a lost acknowledgment or supervisor loss.

The smallest non-secret owner inputs that unlock that engineering mapping are:

- The named pve2 operator and surviving recovery/evidence custodian, plus the
  existing management/control interface or an explicit statement that no suitable
  persistent controller exists. One person may fill several roles.
- The intended VM identifier and owner-approved placement/isolation/resource
  allocation (node/storage, allowed devices and management channel, CPU/RAM/task/
  disk limits). Existing release-test suggestions are not observation allocations.
- The external private evidence location, authorized readers/recovery owner,
  retention policy and actual byte/file allocation. Existing report/trace limits
  provide no spare journal capacity. No password, token or private key is needed.

With those identifiers, source-only work can draft the concrete adapter boundary,
state/error ordering, accounting equations and failure/uncertainty tests. It cannot
establish installed availability, authenticated custody, immutable actual-loaded
Python/Node/native/tracer closure, preventive guest confinement, original
bootstrap-to-connected continuity, real settlement or media durability. An exact
setup plan and a **separate setup authorization** are needed before configuration;
a later separate live-run decision is still required. If no compatible existing
controller or evidence allocation exists, choosing and authorizing that platform
component is the concrete blocker, not another diagnostic sanitization task.
