# First-launch fixture follow-up after source byte safety CI

The reviewed source-byte increment was published at
`52a883a05fe9e0f2d8146ab852621b15154e9069`. Its push-triggered
[CI run 41577928469](https://github.com/cschadewitz/Project_Orca/actions/runs/41577928469)
completed **failure** on `tyler-1`, merge candidate
`855346a2db92f6113c763992260a74de6ac6b918` over the unchanged base
`f9e7225e59cfe6e83c539f2ce9922ad0677719f4`.

The only failing test was
`packages/app/test/mac-managed-replacement-startup.test.ts` →
`provisions on a first launch and opens ordinary startup`, line 133. It expected
`ordinary` and received `unknown`, after 15ms. The suite passed 10,064 tests with one
failure, 36 skipped and one todo, in 367.12 seconds. Statics, build and retry-admission
acceptance passed. Coverage reporting/upload and compiled smoke were skipped after
the failure. This failed evidence is retained independently of any later passing
run; it is not classified as flaky and was not blindly rerun.

## What the evidence establishes

The fixture and its three relevant production files are byte-identical between
the preceding source baseline and the failed head. The Python increment changes
none of them. A local diagnostic selection of the unchanged ten-test file passes
in 1.01 seconds. Neither fact establishes the historical CI cause.

Production startup deliberately catches private setup failures and returns
`unknown`. The retained CI log does not include the original exception, syscall
code, occupied port, fixture path, lease slot or journal failure. Exact historical
cause therefore remains unavailable; the assertion cannot be relabeled as proof
of `EADDRINUSE`. That uncertainty is material and retained in the checks record.

Source inspection identifies a narrower real fixture defect: `installed(true)`
returns before the preparation `try` block and skips its resource selection. Real
`provisionUpdateWindow` must acquire **all eight mapped app-root slots** before it
publishes the first window/guard/enrollment. A single occupied slot can refuse
that provisioning; startup's recovery/catch path then returns `unknown` correctly.
The established-fixture path already selects up to five disposable directories
on preparation-only `EADDRINUSE`.

An isolated Linux synthetic-backend demonstration used two separate fresh roots,
each with an absent control path before initialize. Holding owned app-root slot 7
produced `unknown`, `ordinaryAllowed=false`, and no guard/window records. With all
eight slots available, the separate root returned `ordinary` and published its
guard/window. Each startup initialized once; owned native sockets and temporary
files were cleaned. This establishes the unchecked resource-selection mechanism,
not the missing historical CI exception. It exercises no Darwin addon, Keychain,
host configuration, observer, tracer, VM or live replacement.

## Narrow fixture boundary

The fix selects an available **existing app-root** eight-slot range during fresh
fixture preparation, inside the existing at-most-five disposable-candidate bound.
Probes close before the scenario. The control path stays absent until real first
startup provisioning; no control inode is created to predict an identity. The
production backend, port mapping, eight slots, startup logic, refusal/catch path,
deadlines and original assertions remain intact.

Only preparation `EADDRINUSE` permits another disposable fixture. Other errors
propagate as their original object. Startup is invoked once outside the selection
catch; an `unknown` result is not retried or converted into success. Availability
probes do not reserve ports through subsequent startup, so a later competing bind
can still cause a correct refusal. No general concurrency or CI-success guarantee
is inferred from preflight.

The [source byte safety profile](source-byte-bounds-and-delivery-profile.md) and its
original reviewed checks remain unchanged. Clock trace 1 MiB and diagnostics
52,121,905 bytes remain distinct source restrictions. Helper pipe capture, complete
preventive acquisition, installed compatibility, actual host principal/root/quota,
raw privacy policy and binary retrieval route remain unresolved. The proposed
12 GiB profile and nonsecret delivery pilot are proposals, not host allocations or
end-to-end delivery proof. No host or PR metadata mutation is part of this follow-up.

## Validation and independent review

The [checks record](source-byte-bounds-ci-followup-checks.json) pins the failed CI
log, pre-edit demonstration, unchanged baseline/production bytes and final fixture.
The final four-file startup/recovery/update-window selection passes **86 tests**
in 7.83 seconds. Root TypeScript, targeted ESLint, formatting and diff checks pass. Independent **gpt-6.1-sol, xhigh**
review passes all 18 tests from the modified file, with one worker, in 2.81 seconds,
without skips or todo. It confirms the unchanged three production files and all
ten Python candidate hashes from the original source-safety review.

The reviewer requested a successful selection after an owned first-candidate
collision, followed by exactly one first startup. That regression is included,
alongside the occupied-slot refusal, five-candidate bound, partial socket/base
cleanup and exact `EACCES`/`EADDRINUSE`/null/undefined/primitive hook failure
propagation. One test-local lint directive permits the intentional primitive throw;
it changes no production or global lint/security rule. The original ten scenarios
and their assertions remain, with the additional absent-control assertion.

No Python source/test bytes changed in this follow-up, so the prior 185 normal,
185 optimized and 622 outer plus seven historical child results remain the exact
source-safety evidence. A new push-triggered CI run is separate evidence; a later
pass cannot establish the missing original CI exception or host readiness.

Independent review has no remaining source finding within this fixture boundary.
Native blocker acquisition and the gap after availability probes remain explicit
resource preconditions. The original failed run and missing caught exception remain
recorded; no later pass retroactively supplies that historical evidence.
