# Disposable installed-layout observations — #702 / #703 / #706

Base: `dc62e348212cdf4e46b95e696c78641917e2ca27`. This separate test-only
slice does not incorporate or modify #738's live-delivery work. Activation stays
off and the production accepted-build map stays empty.

The smallest honest next step is an observation harness, not a qualification
producer. `tools/owned-read-proof/run.py` physically copies emitted core/store/
agents/engine/cli modules and their required external dependency closure into a
new temporary installation for each case. No source resolver, loader, or symlink
back to the checkout participates in child module resolution. This is an internal
module subset, not a packaged application or a supported production installer.
The compiler output must exist first:

```sh
./node_modules/.bin/tsc -b packages/cli/tsconfig.json
python3 -B tools/owned-read-proof/run.py > /tmp/orca-installed-proof.json
python3 -B -m unittest discover -s tools/owned-read-proof -p 'test_*.py'
```

The supervisor uses the actual stable wrapper's `typed_lifetime_lock`, exclusively,
and passes its descriptor to a bounded disposable Node subprocess. A competing
independent open actually fails kernel flock acquisition. The child's synchronous
assertion checks the inherited descriptor and named inode, plus its own fdinfo
kernel WRITE flock record. No other process's proc metadata is read. Its managed
owner enrolls only newly created disposable roots with a test-created original
identity/witness. The owner checks actual copied image bytes against an inventory
retained before child dispatch. This demonstrates physical checks under a trusted
test supervisor; it does not accept a build or authenticate an external inventory.

Cases exercise actual canonical enrollment/read and availability refusal after
mutating emitted owner code, closing the inherited descriptor, or replacing the
workspace identity inode with identical bytes. Baseline also creates the actual
closed read service, confirms unchanged unqualified coverage and rejects malformed
intake. The service owner is deliberately incomplete synthetic test scaffolding;
this does not demonstrate policy evaluation or qualification refusal for a valid
action. There is no accepting qualifier, fake approval, saved standing rule,
human verdict, or positive protected Save/read.

A separate `strace` process observes actual `pread64` syscalls. Each trace must show
exactly one four-byte positional read from an ordinary calibration file and zero
positional reads from the service resource. Calibration is a raw OS read, never
claimed as service execution. Producer callbacks/receipts do not decide these
counts. Unit negative controls reject absent/short calibration and an injected
service read. The harness fails if strace is missing or fails; no silent skip.
Trace contents and installations are removed with their temporary directories;
the report retains external counts and the copied-file SHA-256 manifest.

## Authority versus report data

The test supervisor, its immutable-in-memory original binding, inherited open-file
description and kernel flock provide local test lifetime meaning. Canonical owner
code rechecks physical root and metadata identities. The test image assertion
compares retained files on every managed assertion; it does not establish an
immutable filesystem, detect every added file, or defend against hostile same-UID
or root writers. Inventory files, manifests, child JSON, hashes and stdout reports
are ordinary mutable test data. None can mint acceptance or upgrade service
coverage. The trusted observer is separate from the producer, but both run with
the same UID; no adversarial isolation or containment is claimed.

Production acceptance would require a separately authorized verifier and protected
lookup binding an exact independently accepted installed image, Linux runtime/host,
service tool/profile and original managed lifetime to real observed conformance.
The verifier must validate observed facts rather than trust a producer report.
Current safe tools cannot establish that authority decision, fleet-wide exclusion
of older writers, a production stable-owner bridge, or a genuine current required
review. Credentials, protected approvals and live callback/permit composition are
not exercised here. #738 owns callback lineage; this harness does not duplicate it.

The bounded decision for parent is whether to commission an independently reviewed,
controlled-Linux qualification authority/record and verifier for this exact owned-I/O
profile, with retained inventory/lifetime and external observations. Alternatives
are to retain this refusal-only evidence gate, or separately design a stronger
isolated installed environment first. Neither alternative authorizes production
trust. Only after that decision and actual evidence connection should a separate
change consider emitting verified coverage and testing protected Save, refresh,
explicit live Allow once and fresh bounded reads. Do not populate accepted maps or
weaken existing qualification gates to run those positive branches.
