# Controlled owned-read lifecycle: authority decision — #702 / #703 / #706

Source examined: merged main `8a98b5496e38e5c03cee722f3390383d2544e84d`, including
#738 and #740. This decision changes no runtime source, verifier, coverage, policy,
accepted-build map or activation. It claims no connected positive Save/read result.

## Decision

Do not add an accepting qualifier callback or relabel the existing service in this
change. A bounded test lane appears feasible without changing production acceptance,
but it requires a reviewed test-authority and positive-observation contract beyond
the current candidate verifier. The minimal
capability can be one supervisor-retained object, but its obligations include a
bootstrap authorization and separate persistence-review attestation. A coverage
callback alone cannot satisfy them.

Explicit test operator/reviewer/principal identities are valid assumptions for this
proposed lane. They must be named as test authorities, never real users or production
acceptance. The blocker is the current contracts and evidence model, not an inability
to designate test principals or provision another execution environment.

## Concrete boundaries in the merged implementation

| Boundary | Current behavior | Required decision for a connected test |
| --- | --- | --- |
| `createOwnedFileReadServiceForTest` | Internally emits immutable policy-per-ask coverage with no installed refs; no caller qualification intake | Where a closed supervisor's scope capability is created and validated, without admitting report/JSON/flag authority or changing the default fixture |
| `ownedReadScopedCapture.snapshot` | Review provenance comes from this fence's actual required policy review | How a separately authorized test review of persistence scope is recorded and authenticated, rather than overriding the producer's result to `passed` |
| Required-review completion | Fit yields rule-allow with passed provenance; indeterminate can yield require-human with failed provenance | Distinguish a persistence review from execution-policy judgment; preserve the rule-allow/human-attribution distinction |
| Protected source qualification | Refuses a sidecar with no retained scoped rules/approval proofs | Specify the initial test-authorized baseline and its proof, separately from the actual Save being tested |
| Automatic fresh invocation | Current owned capture producer attaches to an actual live query | Specify a retained automatic-action capability for the second read without manufacturing another human callback or using durable answer data as authority |
| `verify_trace` | Refuses every nonzero service-read plan; post-resource opens and post-calibration mutations are narrowly restricted | Specify positive resource effects plus legitimate private auth/store/sidecar activity while retaining syscall, alias, interval and settlement refusal |

The current producer therefore has no state that simultaneously supplies its
required passed-review provenance and its original require-human eligibility:
fit completion is rule-authorized; indeterminate completion has failed review
provenance. A real, separate test reviewer can resolve that distinction, but the
attestation must be bound and verified as its own authority. Reusing `judgeResultRef`
or writing a `passed` field is not that implementation.

The verifier cannot currently observe the requested connected lifecycle unchanged.
Save and live acceptance perform actual private store and sidecar I/O after the
service's resource exists. Merely changing the planned service-read count would
still refuse these operations, and deleting those trace records would invalidate
the independent observation. Refusal evidence cannot establish positive enforcement.

## Minimal proposed authority, before implementation

Retain one non-exported capability in the dedicated disposable test supervisor.
No production RPC, config, environment option, marker parser or report constructor
may recreate it. It must retain and check:

- The explicit test designation and exact bounded test plan, original installed
  file/inode inventory, runtime/observer/verifier identities, original workspace
  binding, actual held lifetime descriptor/flock, actor credentials and run lease.
- The actual service instance and its original private resource/capture lineage,
  profile, generation, parameters, ceilings, cancellation and expiry. The service's
  own synchronous descriptor/currentness checks remain mandatory and independent.
- Authenticated existing-store records for the separate test review, bootstrap
  authorization and subsequent actual Save. The reviewer record binds the exact
  action/scope/revision/actor and is checked again at use and final publication.
- Positive canonical permit/dispatch conformance evidence for the exact copied
  build/profile, verified independently against retained originals. Reports/hashes
  bind bytes; the supervisor's explicit test designation supplies authority. Neither
  candidate JSON nor refusal-only observations supply positive qualification.

The bootstrap is an explicit decision: authorize a bounded calibration through the
actual policy/permit/service under a test-only baseline, independently observe its
resource effect, then consider qualification for the connected lane. Do not set
`independentlyObservedEffects` in anticipation of the connected run or treat a raw
calibration read as a positively enforced service read. If bootstrap authority is
not accepted, the positive lane remains unavailable.

Positive observation must retain the existing descriptor/resource reconstruction
and default refusal of unsupported syscalls, transfer/duplication/mapping aliases,
noncanonical/unresolved resource opens, intersecting intervals and uncertain cleanup.
Any extra classification of legitimate private state I/O needs explicit bounds and
negative controls. The original candidate verifier and its unqualified fixture keep
their current behavior; a report from either lane still cannot mint a capability.

## Proposed connected acceptance sequence

1. Provision only disposable roots and designated test identities; retain physical
   originals and the actual exclusive managed lifetime before launching copied code.
2. Establish the explicitly authorized bootstrap and independently verified positive
   conformance evidence. Unknown qualification must refuse, without fallback.
3. Retain original capture facts before immutable action capture. Record the separate
   test review through the existing protected store and verify its exact binding.
4. Exercise actual protected Save through the command bridge. Independently observe
   zero resource reads and zero live answers; retain its genuine protected approval.
5. Refresh only through the original one-time facade. Separately deliver Allow once.
   Await the real final lease acknowledgement before any fresh qualified evaluation.
6. Require the first actual bounded read's authorization record to name the original
   delivered human answer; verify its positional kernel effect and returned bytes.
7. Capture a fresh automatic invocation under the same retained scope. Its matching
   rule authorization must be distinct from the original human capability and produce
   exactly one additional bounded read without a new human confirmation.
8. Repeat isolated negative cases: duplicates/lost acknowledgement, revocation,
   unknown qualification, changed image/root/lifetime, and observer alias/interval/
   unsupported-syscall/cleanup failures. Preserve execution-unknown after uncertain
   started effects; never infer absence or retry from an acknowledgement failure.

This is a concrete design requiring parent review, not an implemented accepting seam.
The existing settled-acknowledgement and bound-review eligibility fixes are preserved.

## Evidence checked for this decision

On the source base above, 34 existing lifecycle/review/protected-capture tests passed,
and all 18 proof tests passed, including real syscall transfer, interval and cleanup
controls. Diagnostic replay of the existing bounded trace also confirmed:

- A plan requesting two service reads refuses: `candidate verifier has no positive authority`.
- An added detached-resource positional read refuses: `unexpected service read`.
- A private credentials-file open after resource creation refuses: `unclassified post-resource open`.
- A sidecar publication rename refuses: `unsupported post-calibration path mutation`.

Those four replays are model diagnostics, not real positive effects or qualification.
No new positive pipeline, installed acceptance, existing workspace enrollment,
credential/access change, persistent service, OS/security setting or native Mac test
was performed. The next action is review of the scoped authority/bootstrap/review/
observer contract above. Positive implementation is pending that decision, not denied
by a tool or known to have partially executed.
