# Offline VM attempt and evidence specimen

Baseline: `d96b90a29820039ebec3f29503ef9c2915f14f37`, preparation branch
`prep/706-current-main-nonlive`, draft #809. This is a small source-only specimen,
not M1/M2 completion, an issuer, observation authorization or an evidence service.
Manual **pve2 console host custody** is the current design direction. A dedicated
serial path is only a concept; neither supplies authenticated integration here.
No platform interaction, credentials, provisioning or live test occurs.

## Implemented scope

[AttemptSpecimen](../../../tools/owned-read-proof/offline_vm_attempt.py) models one
original single-threaded attempt. Its only normal sequence is:

`reserved → bootstrap-intent → bootstrap-recorded → connected-intent → connected-recorded`

These are synthetic bookkeeping records, not commands, authority checks or proof
of runtime settlement. After reservation, an explicit `uncertain` record can end
the model early. Invalid ordering, duplicates, reentrancy, errors or lost
acknowledgment enter absorbing uncertainty. Completion permits no additional event.
No load/resume, caller-selected attempt ID, receipt, endpoint, launch callback or
automatic replay exists. A second specimen cannot reserve the same original fixture.
Mutable Python objects and injected fixture methods are trusted same-process test
dependencies, not protection against arbitrary code in that process.

Every report always has `authority=none` and false observation authorization,
process-settlement, custody-integration and durable-media verification. An internal
model event supplied by the test cannot satisfy the original closed-bootstrap graph
or fresh external authorization. All four launch guards and legacy pins are untouched.

## Evidence ordering and explicit fixture budget

The finite closed grammar contains five normal frames and one uncertainty frame.
There is no arbitrary payload, path, exception, argv, secret, traceback or external
identifier in a frame. The memory fixture reserves exactly twice the sum of all six
frame byte lengths and `1 + 2 × 6` file names before any frame write. The conservative
byte charge includes simultaneous temporary and published versions even where the
filesystem test uses a hard link. One separately counted name is an empty exclusive
reservation marker. The uncertainty slot is reserved even on the successful path.
These **test-only ceilings are not owner allocations or observation budgets**.
They neither borrow the existing report/trace/metadata allowances nor admit a new
journal into the observer's accepted grammar.

For each record: reserve once, exclusively create temporary output, write to complete
fixed length, sync the file, publish create-only, sync the directory, consume/close
the owned handle, then acknowledge through `InertAcknowledgment`. Positive short
writes advance a finite offset; zero/invalid counts and exceptions stop immediately.
No exceptional write is retried. A close is attempted once; later cleanup errors do
not replace the private first exception. Factory failures own unreturned resources.

The filesystem port lives **only in the test file**, using a test-created temporary
directory and retained directory FD. It creates an exclusive reservation marker,
syncs it and its directory, uses exclusive temporary creation and hard-link publication,
and preserves partial/uncertain files until test teardown. The executable specimen
itself imports no filesystem, process, network, supervisor or manager adapter.
Test teardown removes synthetic fixtures only; it is not an uncertain-attempt recovery
policy. No actual disk quota/preallocation, crash consistency or media durability is
claimed from successful `fsync` calls. Parent directories are trusted fixture setup;
there is no production root/path validation or usable storage adapter.

A published record can exist when directory sync, close or acknowledgment fails.
The model keeps the original association and files, refuses subsequent effects and
never overwrites, retries, infers absence or recreates a capability. There is no
post-failure retry to fill the uncertainty slot on an already ambiguous store.
The first original exception remains in `PrivateFirstFailure`, process-local and
unstringified. Thus a storage failure may leave **no acknowledged durable failure
record**; the unused reserved slot does not prove otherwise. Private memory error
retention and fixed public status are deliberately distinct from durable custody.

## Validation and remaining G4 obligations

[Focused tests](../../../tools/owned-read-proof/test_offline_vm_attempt.py) exercise
closed transitions, reservation exhaustion, duplicate original reservation, write/
sync/publication/close failures, short writes, reentrancy, first-error precedence,
lost acknowledgment and retained partial files. Tests use memory or isolated synthetic
filesystem fixtures only; no launcher body is imported, extracted or invoked.

The six architecture G4 obligations remain intact: (1) original owner, transfer and
borrowers; (2) acquisition/start success/failure/uncertainty; (3) first error and
eligible disposal; (4) durable intent/ack ordering; (5) complete unchanged-bound
accounting; (6) pre-effect refusal, original closure or surviving uncertainty custody.
This specimen tests portions of 2–5 for fixture bookkeeping only. Actual owners,
resources, starting processes, concurrency, power loss and platform custody are absent.

Before real integration, engineering still needs actual owner allocations and private
destination/retention; authenticated issuer and purpose-bound transport; a surviving
recovery owner outside guest rollback; preventive containment and immutable actual-loaded
Python/Node/native/tracer closure; complete original process settlement; current-source
qualification and retained bootstrap-to-connected lineage. Manual console possession,
a proposed serial channel, this model, a boolean or a serialized record provides none
of those. No production implementation or reachable replacement launcher is added.

Independent review is required before any publication. This local increment does not
authorize publication by itself; parent clearance remains required. No CI/App Smoke,
live observer/tracer/provider/daemon, merge, activation, access/security changes or
retry of held metadata/denied documentation actions is part of this work.
