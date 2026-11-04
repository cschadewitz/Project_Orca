# Current-image qualification preparation — no designation or live proof

This document maps the qualification proof obligations for the finite controlled
bootstrap/Save/Allow Once/fresh-rule-read lane. It does not qualify the image or
cover every product permission mode. The current constructor/source checks still
reject this image, and `observe()` unconditionally refuses before probing or
starting a process. No source selector, production implementation or bound changes
are part of this continuation.

## Exact identity and drift

The [identity matrix](current-main-qualification-identity.json) freezes the state
reviewed for this continuation. Main and the remote preparation branch were read
back before edits:

| Role | Exact commit |
| --- | --- |
| Main | `f9e7225e59cfe6e83c539f2ce9922ad0677719f4` |
| Published preparation / independent rebuild | `a3b115a589864326eb210926baf8db7d4a9a6d7d` |
| Original v2 build implementation | `d2c1626c1b01f9dcac48753048fbdaf2c15c166c` |
| Offline v2 image source model | `4ebf382fe6738bb11268b47b048a3d7c7a6f2586` |
| Historical image / unchanged legacy designation selector | `3fce8bcc9afd381cd07c0e06051921307d6322b3` |

All 195 current repository image inputs match the exact Git blobs at the current
image model, original v2 build and published preparation commits. All 192 declared
dependency inputs were independently compared against the fresh installation.
Those equalities do not equate the observer harness or entire trees. The matrix
separately inventories all 16 retained observer files and 41 Python harness files,
including the new test and selection change. No Python harness path is a declared
image input. The builder, child, manifests, lock and tsconfig are separately hashed.

Compared with the historical manifest there are 13 changed repository inputs and
one added input. Their exact old/new hashes are in the matrix:

- `acp-session.ts`, `strict-permission-source.ts`, `strict-permission.ts` and
  `scoped-permissions.ts`: source interfaces, authority/standing-grant types and
  protocol shapes must agree with the finite producer path; type equality alone
  does not establish an owned live capability.
- `owned-read-scoped-capture.ts`, `protected-scoped-permission-owner.ts` and
  `scoped-permission-bridge.ts`: capture retention, pending/grant intent, standing
  review and persistence behavior are larger than the finite v2 fixture. The
  controlled producer uses the concrete-action standing-grant path; the fixture
  does not qualify all pending-intent, cancellation, replay or product UI branches.
- `owned-file-read-service.ts`, `synthetic-read-fence.ts`: exact live invocation,
  ownership, permit, retirement and dispatch behavior remains source dependent.
- Added `deferred-human-delivery.ts`, plus changed `executors/basic.ts`,
  `human-input.ts` and `protected-event-store.ts`: original delivery retention,
  final settlement and durable protected/public event association require the
  actual runtime ownership chain. A durable answer alone is insufficient.
- `controlled-owned-read-producer.ts`: v2 standing review, historical Save versus
  fresh execution authority, separate human delivery and finite fresh expiry.

These runtime changes are inherited current-main/image inputs, not changes made
by this continuation. They are explicit review obligations rather than an implicit
claim that the earlier nine-file Python review covered them all.

The legacy `assert_image_sources` checker iterates manifest-declared inputs and
checks the declared output hashes; it does not independently enforce the complete
expected input inventory or derive bundle bytes from those inputs. V2
`_source_binding` is narrower: source head, producer input, child and retained image
hash bindings. This task's exact manifest comparison and actual frozen rebuild
provide additional correspondence evidence. Builder/compiler correctness and
manifest completeness remain source/build assumptions; a generic passing checker
or self-consistent manifest would not qualify an arbitrary image.

The trusted substrate also includes the Python interpreter and cryptography,
Node/esbuild and dependency implementations, same-UID filesystem/process controls,
and any future OS, clock and tracer measurements. Hashing dependency inputs is
not a dependency/runtime audit; synthetic fixtures do not independently establish
that substrate's behavior.

## Proof obligations by layer

Paths below are relative to `tools/owned-read-proof/` unless a package is named.
“Synthetic” always means constructed histories/identities, even where the fixture
uses real AEAD, files or a genuine historical build.

| Layer | Existing mechanism and v2 delta | Evidence and remaining obligation |
| --- | --- | --- |
| Image correspondence | `build-controlled.mjs`; supervisor `assert_image_sources`; `ConnectedDesignation` snapshots exact directory, three files, physical stamps, bytes and proof association. | Current input/output correspondence and independent rebuild pass. Legacy positive physical controls run against historical SOURCE. Current image is rejected under that selector. Do not replace source review with metadata/hash assertions or repin to make it pass. |
| Original bootstrap closure | `ObservedRun.assert_bootstrap_closed` and `designate_bootstrap` require original settled graph, resource closure, authenticated bootstrap, unchanged observer, image, trace, report and originals; receipt callable closes over them. | Historical fixture closure is synthetic. No genuine current original bootstrap/receipt exists. An offline report, reconstructed object or success boolean cannot supply it. |
| Full kernel history | `run.py`, `verify.py`, `controlled_contract.py`, `controlled_replay.py`, `kernel_runtime_queries.py`, notifications and connected replay consume bounded process/FD/path/physical histories and control phases. | Kernel/parser adversarial unit coverage exists. `ConnectedKernelReplay` remains source-bound to the legacy designation. No complete current-source raw trace has passed it. The v2 fixture manually constructs a replay-shaped history and never establishes this prerequisite. |
| Immutable authority and scope | `controlled_semantics.py` binds original action, invocation, resource, operator/reviewer credentials, lease/revocation/current revisions and authenticated protected records. | Source/input pins and synthetic negatives exist. Kernel evidence cannot by itself measure registry, callback, retained review-handle or permit object identity in JavaScript memory. Those remain cooperative exact-source assumptions. |
| Standing Save/persistence | Producer `reviewStandingGrant` / `verifyStandingGrantReview`; `controlled_save_semantics.py` adds the exact v2 standing record, prior proof, distinct reviewer/credential, action/command/scope/lease, `reviewUntil`, null rule expiry and source-order digest. | Synthetic v2 checks bind 16 protected payloads / 18 protected files. Save must have zero reads and answers; execution-review provenance remains unavailable. This is finite concrete-action standing Save coverage, not general standing-intent qualification. |
| Separate Allow Once and fresh rule use | Producer connected phases, `controlled_delivery_semantics.py`: original answer/ack and human attribution, then distinct action/turn/invocation with current policy/authority and rule attribution. | Existing tests plus new coherent-stale, attribution and wrong-ack negatives. Actual original callback ownership, final settlement and once-only dispatch must still be correlated to a complete original run. Historical Save cannot substitute for a fresh valid execution capability. |
| Time and ownership | `controlled_timestamps.py`, `controlled_v2_model.py`: exact source binding, measured wall/monotonic samples, causal event positions, UTC millisecond floor; original 55-second owner and 60-second run bounds retained. Fresh action expiry is separately bounded by its source issuance interval. | Synthetic exact-boundary and negative checks pass. No current trace clock/namespace/runtime evidence was measured. Fresh expiry does not extend original owner, lease, process or trace bounds. |
| Closed effects and final namespace | `controlled_aggregate.py`: full-replay prerequisite, finite mutation inventory, resource/lock closure, protected publication, exact execution inputs, surviving names and journal bytes. V2 changes only protected count 17→18. | New v2 negatives cover extra mutation/name, residual resource, incomplete publication, reencrypted input drift and journal/history mismatch. The function assumes the caller already completed full replay; synthetic objects do not prove every event was consumed. |
| Final qualification boundary | `compose_connected` returns `authority: none`, no accepting token and `productionEligible: false`; `controlled_observation.py` is preparation orchestration only. | Aggregate success is deliberately non-authoritative. Independent bounded source review does not change those fields, provide formal security approval, designate an image or authorize launch. |

## New bounded adversarial validation

The only executable changes are a new test module
`test_current_qualification_boundaries.py` and its addition to the explicit
non-live selector. Seven methods exercise 17 constructed mutation cases through
the existing v2 composition/effect checks. Authenticated semantic mutations are
reencrypted by the fixture; acceptance is not mocked. Assertions target the
relevant refusal reason. Existing positive v2 composition, source binding, Save
zero-effect, timing, launch-refusal and historical physical checks remain intact.

No current designation constructor or observer/tracer is invoked by the new
module. The existing explicit non-live selection retains its four real-tracer
exclusions and 180-second outer limit. Missing historical fixture remains a test
failure, never a skip. After this new Python module, the historical fixture must
receive the exact 41-file current Python harness plus the reference JSON, subject
to the same disjointness and Git image-input checks described in the
[fixture handoff](current-main-separated-image-tests-handoff.md).

Local new/existing v2 selection: 20 methods passed in 1.341 seconds under the
unchanged 60-second outer bound. The full explicit selection passed 359 outer
methods plus seven nested historical methods in 46.627 seconds in the frozen
validation checkout. All 387 image inputs matched beforehand; all 41 candidate
Python files plus the reference manifest were copied separately after checking
disjointness, with all 392 historical declared/protected input files unchanged.
Commands, file hashes and log hashes are in
[bounded checks](current-main-qualification-checks.json).

An initial setup check in the primary checkout failed because 106 dependency
paths declared by the frozen manifest were absent (zero existing-path hash
mismatches). The shell still proceeded into the bounded non-live selection,
which passed 359 plus seven historical tests in 47.768 seconds; the historical
harness was refreshed during this overlapping invocation. That result is retained
honestly but is not used as controlled frozen-artifact validation. The corrected
invocation used `/workspace/orca-fence-validation`, required successful preflight
before continuing, and verified exact candidate harness and image input bytes.
No dependency policy, source selector or execution budget was altered.

## Independent rebuild and physical identity

Independent reviewer `/root/independent_review` executed a fresh frozen install
(9.5 seconds) and the unchanged builder from a separate detached exact-`a3b115a`
checkout, `/workspace/orca-independent-current-rebuild`. This was an actual new
build, not only hashing the parent's outputs. Node 24.21.0 / pnpm 12.4.2,
tsx 4.23.15 / esbuild 0.28.2 and normal dependency policy checks were retained.
The committed lock has two YAML documents; its workspace document matches the
single installed lock document. Complete-file lock hashes therefore differ.

All three fresh outputs in
`/tmp/orca-current-main-evidence/independent-current-image` equal the retained
current image bytes, with distinct physical file identities:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `controlled-build.json` | 48027 | `889bd46eeec3bf3133bea022591d23ad4a627b2e7bfc73d71fd8c4ecc971d977` |
| `controlled-producer.mjs` | 2248652 | `1c0bffce70e7bb70245962590f2f291b68b6afdd35078caa5fd25fbd573e5ff7` |
| `controlled-child.mjs` | 5713 | `17fdd509f6702c70229c95df53d669754118379e09ab4d26912466859f102f13` |

All 195 repository inputs matched Git and installed bytes; all 192 dependency
inputs matched the fresh install. The rebuild uses the same managed host,
toolchain and shared package cache, so it is not independent-host/toolchain
diversity or supply-chain verification. Equal bytes do not transfer physical
continuity or an original bootstrap receipt to a rebuilt copy.

Original independent record:
`/tmp/orca-current-main-evidence/independent-current-rebuild.json`, SHA-256
`099c2f4689eb17fa59b1a52432fee0f4522f265a4a27af8c66cc22a78172bbdc`.
Its [repository copy](current-main-independent-rebuild.json) is formatted JSON;
the preceding hash identifies the original local record, not that formatted copy.
The retained artifacts remain local, not a release or deployment.

## Independent bounded source review

The [independent review record](current-main-qualification-review.json) inventories
coverage per file across all 16 proof modules and all 14 historical/current
image-source drift paths. The reviewer fully reviewed the new test/selection delta,
connected v1/v2 delivery and Save correlations, aggregate composition, source/time
adapter and several complete smaller source diffs. The reviewer independently
passed the 20-method v2/new-test selection normally (1.457 seconds) and with `-O`
(1.443 seconds), each under the existing 60-second bound, and verified the matrix.

Coverage of the full syscall dispatcher, bootstrap correlations, large owned-read
service/owner changes, pending-intent APIs, cancellation/scheduling races and
pre-existing permit/fence/store machinery is explicitly partial. Dependencies,
interpreter/compiler and OS/tracer implementations were not audited. This is
cross-layer bounded source review of preparation, not complete branch coverage,
whole-stack audit, runtime qualification or formal security approval. The missing
coverage remains an obligation rather than being relabeled as completed review.

No blocking test-code finding was identified. Review requested explicit limits on
manifest completeness/bundle derivation, runtime trust and the wording of the
qualification map; those qualifications are included above. Final document/evidence
consistency is checked before publication. No checker behavior was changed to
address a documentary qualification.

## Remaining boundary and separate live work

Offline preparation can establish correspondence, explicit assumptions, bounded
synthetic rejection and independent review/rebuild evidence. It cannot supply a
new original observed process graph, physically retained bootstrap closure or
connected current-source causal/effect proof. The current legacy selector refusal
is an intentional blocker, not a test to override. No pin or launcher changes are
proposed in this continuation.

Separate #2 work would first need explicit authorization for an exact source and
image, reviewed current-source observer/designation integration, appropriate
environment/resource/tracer preflight and unchanged limits. Only original
authenticated evidence could then support the bootstrap-to-connected association.
Even such test observation would not automatically authorize production use.
The #779 security review, #793 merge and #794 formal approval denials remain binding.
This bounded implementation review is not any of those actions under another name.

PR #809's description was updated before this work to distinguish the earlier
four test-context failures, their historical/current separation, local Python
fixture evidence and passing CI `41275991519` on `a3b115a` (`tyler-2`). That prior
CI passed 10,051 tests with 36 skips and one todo plus compiled-build smoke.
Ordinary CI does not provision/run the mandatory historical Python fixture.
Any newly published head requires its own CI result.
