# Moved-home fixture admission

Base: `920c2ada3b1348ed06b50ca7b10bb85be10a0c67`, branch
`prep/706-current-main-nonlive`, draft PR #809. This increment changes the protocol
test fixture only; it is separate from the preceding guard/privacy implementation.

CI 41293856721 failed at the moved-home test's actual reanchor assertion after
fixture setup and rename completed: `EADDRINUSE` at `127.0.0.1:56294`. Source and
port arithmetic point to root-slot acquisition before publication, but the exact
root and listener remain unknown. Other preserved bind failures and two earlier
assertion failures with unknown causes remain separate. Occurrence on `tyler-2`
does not establish a runner defect, leak or harmless flakiness. Later passing CI
does not resolve those original causes.

The original `home` helper admitted only the original paths. Its optional preparation
callback now checks the paths needed by the moved-home scenario before returning a
fixture. Future identities replace the path while preserving device, inode, uid and
JSON field order. Test-only port calculation mirrors the unchanged production
mapping. The finite union covers old app/workspace ranges, predicted moved
app/workspace ranges and the moved-control mutex: at most 33 unique ports, deduplicated
as production does. No alternate production port, reuse mode or fence is introduced.

Temporary exclusive listeners are registered before listen and all registered
servers receive a cleanup attempt. Only an acquisition `EADDRINUSE` after successful
cleanup can resample fixture preparation, using the existing five-attempt cap.
Any cleanup failure produces an aggregate failure and prevents resampling. The
original rename, reanchor and subsequent enrollment/writer assertions remain
single-shot outside the admission loop; the only change to that test is passing
the preparation callback into `home`.

Seven new controls cover predicted versus actual renamed identity, real held-port
refusal with unchanged durable files, preparation resampling, exactly five known
blocker failures, noncontention propagation, cleanup continuation and combined
contention/cleanup failure. Owned endpoints and held states are recorded inside
preparation callbacks and asserted outside the retry loop. The known-blocker tests
require the exact address and port, so unrelated conflicts cannot satisfy those
assertions. A moved-app-derived port can share a range with another identity; the
test proves the owned endpoint caused refusal, not which internal root was visited
first. Simultaneous listeners are bounded by 33 preflight listeners plus one blocker.

Cleanup fault injection closes each real server before throwing a synthetic error.
It validates error propagation, continuation and refusal to resample; it does not
simulate an actual OS close failure or prove release after one. Real cleanup
uncertainty remains a failure. Ordinary Node teardown of an already non-listening
server is tolerated for the failed-listen/registered-test-cleanup paths.

Validation uses isolated checkouts, existing frozen dependencies, Node 24, one
Vitest worker and `timeout --kill-after=5s 60s` per exact selected batch. Only seven
new controls plus the original moved-home scenario are selected; the other 26
tests, including the real surviving-child scenario, are excluded by name. No new
skip or expected-failure marker is added. Genuine protocol calls retain their normal
local boot/namespace and fixture-directory identity reads. There is no runner host
access, listener scan, identity dump, observer/tracer/provider/daemon or App Smoke.
Global setup creates a temporary bundle directory, but this selection invokes no
child bundle build or child scenario.

Temporary listener release before the actual operation leaves a check/use race.
The controlled cases establish this preparation mechanism and real refusal behavior;
they cannot retrospectively identify a CI listener, eliminate external contention,
or fix unrelated CLI/Mac/recreation/torn-write failures. No failed-base CI rerun is
part of this increment. Any later ordinary CI belongs to the changed reviewed head.

All four launch refusal guards, source pins, production implementations, execution
limits and retained native image bytes remain unchanged. No current-image designation,
live observation or settlement qualification is claimed. The unknown-classification
PR-description hold and #779/#793/#794 restrictions remain untouched.
