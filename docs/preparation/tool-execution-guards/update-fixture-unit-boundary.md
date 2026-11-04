# First-run fence error-control fixture boundary

Base: `f95870890ea7efa01c5c3f57cb691617875b3212`, draft PR #809.
CI [41558207190](https://github.com/cschadewitz/Project_Orca/actions/runs/41558207190)
failed on `tyler-3` at merge candidate `0e88b265`. Job `125662297026` reports
10,064 passed, one failed, 36 skipped and one todo, in 366.75 seconds. Statics,
build and retry-admission acceptance passed; coverage reporting and compiled
smoke were skipped after the test failure. This remains a failed run, with no
retry or flaky classification. The [failure excerpt](update-fixture-failed-ci-excerpt.log)
preserves its exact assertion/error and totals, with ANSI escapes and trailing
whitespace removed. It does not identify which process held the occupied port.

The failing test expected the exact synthetic `EACCES` object injected into the
first-run fence acquisition callback. It instead received `listen EADDRINUSE`
for `127.0.0.1:59090`. Its call to `heldFirstRunFixture` first awaits `fixture()`;
that provisions unrelated update-window sockets before the injected callback can
run. `allocateHeldFirstRunFence` awaits candidate creation outside its acquisition
catch, so this setup failure propagates before the callback and before the
asserted error path. The failure is consistent with that exact source boundary;
there is no evidence identifying the competing owner or its lifetime.

The narrow fix changes only this unit control to call
`allocateHeldFirstRunFence` with disposable `mkdtemp` workspace identities,
matching the immediately preceding 16-candidate bound control. Each workspace is
registered for the existing `afterEach` cleanup. The injected `EACCES` object must
still propagate by identity with exactly one acquisition attempt. An additional
assertion requires zero allocator discards on that noncontention failure; normal
after-test cleanup still owns the workspace.

The real provisioning, surviving-writer refusal, exact held-socket collision,
colliding-identity replacement, 16-candidate bound and plugin-fixture admission
controls remain unchanged. Production code, ports, bounds, retries, timeouts,
source pins and observation launch refusals are unchanged. No scenario retry,
error suppression, arbitrary port substitution or assertion weakening was added.

Local verification with Node 24.21.0:

- Whole `packages/cli/test/update-bootstrap.test.ts`: **15 tests passed**, 9.22s,
  using one worker and the existing timeout.
- Root `tsc -p tsconfig.json --noEmit`: passed.
- ESLint and Prettier on the changed test: passed.
- `git diff --check`: passed.

The prior Python setup evidence remains separate. No host, SSH, VM260, pve2,
live observer/tracer/provider, App Smoke or manual workflow was used. The old
uncertain PR-description write remains held without retry or alternate route.
A push-triggered exact-head CI result must be reported separately; these local
checks do not turn the prior failed run into a pass.

Independent **gpt-6.1-sol, xhigh** review found no actionable issue. The reviewer
checked the source boundary, exact error identity, one attempt, zero allocator
discards, registered cleanup and unchanged real socket/production controls. Its
independent name-filtered run passed two allocator controls, with the other 13
file tests excluded by the filter. It also inspected the 15/15 full-file log and
verified the normalized failed-CI excerpt. Reviewed test SHA-256:
`223fddacf07e08c9cf048c5d3a29f7eec0fd54adb342957d1d234375cda9916e`;
excerpt SHA-256:
`3b4c35aa7787c270c90d3775da31def967c28718212dbfaab263ab73c30893f7`.
