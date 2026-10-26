# Disposable installed-layout candidate evidence — #702 / #703 / #706

This test-only follow-up starts at reviewed #739
`4dd2e8f9ff74cb27be3f93cd02a7679ec888007b` (main base
`dc62e348212cdf4e46b95e696c78641917e2ca27`). It changes no production
lifecycle, accepted-build map, qualifier, coverage level or activation setting.
#738 owns live human delivery. Parent owns integration, review and merge. The follow-up was synchronized to merged
main `afe9387af2f14a24a4c1e218d4cab0a647efb060` before publication.

`tools/owned-read-proof/run.py` copies emitted core/store/agents/engine/cli
modules and their external dependency closure into a fresh disposable directory.
No source resolver, loader or symlink to the checkout participates. This is an
internal module subset, not a packaged application or production installer.

```sh
./node_modules/.bin/tsc -b packages/cli/tsconfig.json --force
python3 -B tools/owned-read-proof/run.py > /tmp/orca-installed-candidate.json
python3 -B -m unittest discover -s tools/owned-read-proof -p 'test_*.py'
```

## Retained original and independent verifier

Before launch the standalone supervisor provisions only new disposable roots,
identity, input and enrollment witness. It retains the physical copied inventory
(files, directories, inode/device/mode/owner and file SHA-256), canonical root
binding, root identities and immutable input bytes, runtime/tracer/Python/verifier/
supervisor identities, original lifetime descriptor and bounded scenario plan.
The child compares its canonical root binding with that original. The supervisor
uses the actual stable wrapper's `typed_lifetime_lock`, and a separate open really
fails exclusive kernel flock acquisition before each case.

`verify.py` runs as a **separate process** after the existing bounded owned-tree
settlement returns successfully. Its stdin carries the supervisor's retained
original; neither the child's JSON nor its mutable plan/inventory files decide
verification. The verifier independently inventories the physical installation,
checks root/input/runtime/observer/verifier bindings and the original inherited
flock, and reconstructs descriptor history from kernel strace records. Producer
policy assertions remain explicitly separate observations.

The verifier admits one initial exact executable/argv, one cooperative Linux
process and explicitly shared-descriptor Node threads. Every observed thread must
settle with exit zero. Process clones, further exec, group/session changes,
unsupported asynchronous I/O and incomplete or ambiguous trace fail closed.
This lane uses Linux statx decoding and strace with required EXITKILL, complete
strings for bounded payloads and raw decoding for ordinary non-positional read
buffers. A kernel refusal of io_uring setup creates no asynchronous descriptor;
a successful setup is unsupported. No kernel or security settings are changed.

Resource recognition uses observed exclusive 0400 creation inside a newly created
0700 disposable directory, actual writes matching the supervisor input, writer
close, read-only no-follow/nonblocking open, matching device/inode/owner/mode/size
stats, unlink, detached stats and reader close. It does not search for a resource
filename or trust producer-supplied descriptor numbers. Descriptor reuse is
tracked; unsupported operations, aliasing, mappings and unexpected effects refuse.
The requested raw calibration slice (offset 2, length 4) must have the exact result
count and bytes from the supervisor input. Known root-identity positional reads
are checked against retained original bytes; other unexpected positional reads
following calibration refuse. Raw calibration is never service dispatch.

## Valid action and the authority boundary

Baseline constructs the actual closed service and a complete **test-only
cooperative owner interface** with physical/lifetime checks. Its invocation and
authority identifiers are explicitly unverified test labels. It captures a valid
bounded action and evaluates it through the real strict permission-source and
policy code. Captured ceiling, current authority, protected access, coverage,
profile and review facts remain unknown; protected rule material is unavailable.
There is no injected accepting boolean, qualified source or fake approval.

The actual evaluation returns `indeterminate`; authorization rejects. The kernel
trace independently shows creation/read-only open/unlink/close and zero service
reads. Coverage remains `policy-per-ask`, installed refs remain empty and
`independentlyObservedEffects` remains false. This is valid-action observation
under absent authority, not proof of an independently qualified positive pipeline
or every individual policy failure. No protected Save, live Allow once, native
choice or positive service execution is asserted.

The eight controlled executions are baseline; changed emitted image; closed
inherited lifetime descriptor; replaced identity inode with identical bytes;
wrong calibration offset; raw read through a different descriptor; raw injected
read through the actual retained service descriptor; and an extra process. Each
negative case must fail for its named reason, not merely fail for any reason.
The raw service fault obtains the real open result through temporary test-only
instrumentation, issues a raw read and restores the API. The verifier never
receives that variable. These are deliberately unauthorized raw test effects,
not service policy dispatch. Evidence-mutation unit controls separately remove
trace events and alter bytes, offsets, lengths, descriptors, flags, inodes,
settlement and process/exec/descriptor operations.

## Meaning and limits

Every report is **candidate evidence only**, with no authority to mint coverage.
A SHA-256 binds bytes; it does not establish acceptance. Reports retain originals
and observations but remain ordinary mutable data. Traces and copied layouts are
disposed only after settlement. No fleet exclusion, hostile containment or
immutable filesystem is claimed. Supervisor, verifier, observer and cooperative
producer share a UID; pre/post physical snapshots cannot defeat a hostile same-UID
or root writer or establish every transient mutation. This is a standalone,
sequential, single-group test, not a reusable concurrent supervisor.

A positive policy/permit/dispatch pipeline still requires a separately authorized
qualification authority and protected lookup binding independently reviewed
conformance to the exact installed image, Linux runtime/host, tool/profile and
original managed lifetime, together with genuine principal/current authority and
protected approval/review capabilities. This verifier supplies candidate facts;
it does not supply those capabilities. Do not populate accepted maps, upgrade
coverage or weaken the gates to reach positive branches. Fleet exclusion,
production stable-owner composition and Mac Silicon acceptance remain separate
prerequisites. No existing workspace, credential, service or OS/network/security
configuration is touched.

## Owned trace-process cleanup correction

Review of `22b7c00cdf5d5c9d1758ad101861732315e3ea8a` found that Python's
`subprocess.run(timeout=30)` settled only its direct strace child. Without
PTRACE_O_EXITKILL, a traced Node descendant could survive, retain the lifetime
lock and outlive temporary-directory disposal. That source did not prove safe
failure cleanup; no claim is made that Python communicate necessarily hangs.

The corrected sequential supervisor requires advertised `--kill-on-exit` support
before launching scenarios and passes that option to the real tracer (unsupported
or rejected execution fails closed). It creates one owned session/process group,
uses bounded communicate, and kills that group only while its tracer leader remains unreaped, then waits
for the tracer. Once communicate has reaped the tracer, it never signals the old
numeric group; required EXITKILL and bounded descendant reaping settle that path.
Process-local Linux subreaper state lets it reap adopted tracees, including ones
that changed groups, before returning or propagating timeout. It restores the
previous process-local state afterward; no persistent OS configuration changes.
This standalone supervisor launches no unrelated concurrent children. Its waitpid
calls reap only its own children; there is no process discovery or arbitrary kill.
If bounded settlement cannot be established, `OwnedCleanupError` preserves the
new disposable directory instead of treating disposal as safe.

Deterministic regressions launch an actual traced Node parent and Node descendant.
Both reach a readiness handshake with the inherited lifetime descriptor. A hung
tree times out; a second case deliberately kills its own tracer. After each case,
both specifically recorded PIDs are absent and a fresh independent descriptor
successfully takes the exclusive lock, with the directory still present. Missing
EXITKILL support refuses before scenarios; injected uncertain cleanup preserves
the disposable directory. These tests cover failure cleanup, not qualification.

Re-review of `800f714e147d10c6bd4058e46ca7dc0218dc2536` found that its unconditional
post-communicate killpg could signal a reused numeric PGID after the tracer was
reaped. The correction reads existing `returncode` without poll/wait before its
signal decision. An unreaped leader pins group identity through the timeout
signal; an already reaped leader gets no group signal. A deterministic regression
failed on both successful and killed-tracer communicate outcomes before the fix,
and now asserts no killpg, poll or wait on either already-reaped path. Real hung
Node tree and tracer-death settlement tests remain in place. The waitpid(-1) scope
still requires this standalone sequential supervisor to have no unrelated children.

## Recorded local run

The [candidate observation record](owned-read-candidate-observations.json) binds the
test source bytes and records eight controlled executions plus 12 mutation/cleanup
tests on Node 24.19.0 / strace 6.13. Baseline observed 11 settled threads and zero
service reads; its valid action returned `indeterminate / authority-unavailable`.
These are local candidate observations, not independent review or hosted CI.
