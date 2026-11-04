# CLI plugin fixture admission

Source baseline: `4f9738623131c12e41d45bd65aa82ad334eedd64`, preparation branch
`prep/706-current-main-nonlive`, draft PR #809. This increment changes only test
fixture admission and its evidence. It does not advance M1/M2, choose an observation
environment, designate an image or enable observation.

## Failure and narrow correction

[CI 41298797836](https://github.com/cschadewitz/Project_Orca/actions/runs/41298797836)
failed on `tyler-2` with one raw `listen EADDRINUSE` at `127.0.0.1:47132` in
`refuses uncertified plugin startup before module execution`. It recorded 10,057
passed tests, one failed, 36 skipped and one todo in 368.03 seconds. The log has no
JavaScript callsite or listener identity. Initial fixture provisioning is the
strongest source-consistent escaping path, not an observed stack. No runner-specific
cause or listener leak is established. That failed run is retained and not retried.

The existing fixture called `provisionUpdateWindow` once. The separate first-run
fence allocator neither covers this test nor catches failure while creating its
initial fixture. Its existing 16-candidate bound and behavior remain unchanged.

The target test now opts into `pluginFixture`. Only the actual initial provisioning
call is within its contention catch. An `EADDRINUSE` can select another fresh
disposable fixture after removal of its exact owned base and successful registration
cleanup. Five initial candidates match the existing protocol provisioning precedent;
this is a new policy for this target fixture, not a claim that it previously retried.
The two allocators are never nested.

Creation, owner construction, plugin/config writes, admission capture, migration,
CLI invocation and the original assertions remain outside the retry loop. The
original scenario differs only in its fixture call. Other existing fixture callers
remain single-shot. Noncontention errors propagate without resampling or discarding
their evidence. Cleanup failure retains the provisioning error and cleanup error in
an `AggregateError`, with the original cause, and stops admission. No port mapping,
production fence, assertion, runner policy, timeout or execution bound is relaxed.

## Bounded local evidence

The seven new fixture controls run alone in an isolated checkout, with one worker
and an external 60-second deadline. They cover:

- A real owned slot-4 blocker, exact endpoint/error and held state, no durable
  provisioning writes, and one fresh successful fixture before any scenario.
- Reacquisition of only the four known earlier fixture slots while the blocker is
  still held. Every owned control is closed before resampling; no listener scan.
- Exactly five candidate attempts, preserving the final original collision object.
- Pending cleanup blocking the next candidate; cleanup failure ending admission
  while retaining both original exception objects.
- Creation errors, noncontention provisioning errors and post-admission owner
  construction errors never causing another candidate.

The real control refuses unrelated control/success-candidate failures rather than
silently counting them as intentional contention. All assertions execute outside
admission retry. The other eight existing tests are deliberately unselected locally,
including the original CLI `serve` scenario and positive child tests. Helper-only
results are not plugin-startup acceptance; ordinary exact-head CI is separate evidence.

Production provisioning awaits its listener-close callbacks but does not report
callback errors. These tests do not establish arbitrary OS settlement, global
quiescence or ownership of the historical CI listener. Later contention after
admission remains possible and must stay visible; the scenario is never retried.

See [checks](cli-plugin-fixture-checks.json) and
[independent review](cli-plugin-fixture-review.json) for exact source hashes,
commands, test outcomes, omitted validations and retained errors. Independent
review is bounded test/source review, not formal security approval.

## Preserved boundaries

All four first-executable observation refusals, legacy pins, bounds and retained
image outputs are unchanged. The test file is outside the image input manifest;
there is no rebuild or new physical image. Historical regression/current-image
qualification remain distinct. Previous failures and unknown causes remain retained.

No observer/tracer, host probe, provider, App Smoke, activation or merge is performed
by local validation. The unknown PR-description update error remains held without
retry, comment or alternate route. #779/#793/#794 restrictions remain binding.
