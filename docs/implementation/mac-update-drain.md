# Approved beta drain admission — #387

This bounded slice starts at exact #563 head
`732d85d92a5270bcebe10132b0ba27aac90c3862`. It implements the serving-runtime gap
in Casey's 8 October option 2: close new-work admission before existing work is
idle, retain the operations needed to finish that work, and report blockers or
permit defer. Read [native lifecycle integration](native-lifecycle-integration.md)
and [Mac native handoff](mac-native-handoff.md) for the independent installation
and recovery gates. Those historical handoffs and dependency branches are preserved.

## Executable boundary

The existing authenticated `maintenance.runtime` method accepts two additive
actions, `drain` and `defer`, using the unchanged `daemon.maintenance` grant,
owner token and exact UUID workspace/instance plus positive process ID. No new
permission, credential, capability, transport or coordinator is introduced.
`RuntimeMaintenanceRequestSchema` accepts the existing strict prepare/resume
params or the strict `RuntimeDrainParamsSchema`. Existing runtime-v1 result
validation is unchanged; drain results require `RuntimeDrainResultSchema` and
the distinct `runtime-drain-v1` proof. Discovery of `maintenance.runtime` alone
does not distinguish older prepare-only daemons; unsupported drain must refuse
without falling back to prepare-only proof.

`drain` synchronously reserves ownership and closes new admission even while
handlers, execution, queued dispatch, callbacks, renewal or continuation recovery
are busy. It returns `draining` with current activity reasons until they settle.
The owner calls `drain` again to refresh the observation; the daemon adds no polling
loop or scheduler. Concurrent requests from that owner share one observation.
Wrong targets and foreign owners refuse before changing the fence. Missing or
unavailable composition cannot establish positive drain proof.

Admission scope is explicit:

| Entry | While draining |
| --- | --- |
| `runs.start`, `runs.admit`, `requests.submit` | Refused, including new intents and transport retries through these entry points |
| `operator.admitRun`, `operator.submitRequest` | Refused by the same maintenance wrapper and underlying model guards |
| Direct calls to bound `ControlModel.startRun`, `AdmissionRetryModel.admitRetry`/`admit`, `RequestSubmissionModel.submit`/`submitRetry` | Reserve before their first service await; new entry is refused |
| Already entered admission and its queued dispatch/execution | Retains its reservation and may finish, including later run creation and child execution |
| Answers, explicit resume/continuation, existing receipt reconciliation and continuation discovery | Remain available under their existing authority/ownership rules; no automatic decision or new retry intent is created by draining |
| Reads and other existing RPCs | Remain available and are counted through handler settlement |

`Maintenance.admissionClosed()` retains its new-admission meaning. The existing
runtime and timer use `existingWorkClosed()` so closing new admission does not
blindly disable callbacks, renewals, answers or recovery of existing continuations.
`RuntimeActivity.enter(reason, true)` marks the three bound admission producers;
ordinary producer entry remains available while draining. No execution is cancelled,
force-terminated or blindly replayed to manufacture idle. Reconciliation retains
its existing receipt and current-authority constraints.

When live activity is empty, the actual serving orchestrator inventories durable
run summaries. `created`, `running`, `waiting` and `paused` remain unfinished,
including parked gates with no attached interpreter or live callback. Results
report aggregate status/count blockers; concrete run/input discovery still uses
the existing authorized reads, which remain available while draining. No run IDs,
titles, protected inputs or credentials are added to the maintenance response.
Terminal summaries alone do not establish complete protected-state readiness.

Each observation waits at most one second for its read, subject to event-loop
scheduling. A stuck reader is shared, never cancelled and never duplicated by
repeated requests. Failed/timed-out inventory returns `draining`, `unavailable`
and `truncated: true`; its late completion cannot autonomously seal admission.
The inventory refuses positive proof above 4,096 historical runs. This bounded
implementation can require later inventory optimization for large/cold stores;
defer remains available. Never delete history to pass that limit.

Producer and handler revisions guard the asynchronous inventory, including activity
that starts and finishes during its reads. Defer generation changes invalidate
pending results. Source binding, durable external fence and current reservations
are checked before promoting to `held`. `held` requires an empty complete inventory
and empty activity, then seals every runtime entry and wrapped RPC under the
existing full idle fence. Hello/subscription behavior retains the existing contract.
An old idle-only lease is never relabeled as drain proof: it must be resumed first.

An unavailable `blocked` response never releases an earlier owned drain or idle
fence. Only a positive owner/target-matching `released` acknowledgement proves
release; clients must retain prior ownership across every other response.

Owner `defer` releases only a still-draining fence, even when work remains active.
It does not cancel, settle or discard that work. Lost source proof, a foreign token
or an external durable fence refuses release and retains ownership. After `held`,
defer refuses; the existing prepare/resume lease lifecycle applies. A client with
an uncertain response must retain its local ownership and reconcile explicitly;
the new API is not an automatic retry or recovery implementation.

## Compact handoff to app/updater integration

The main/index, preload, Workspace and first-run-owned files are untouched. No app
approval path calls these new actions yet. The existing Mac coordinator creates
its admission token at preparation and holds drafts before acquiring admission;
that ordering cannot simply be used at drain start because it would block the
user operations needed to finish existing work.

A future integration should extend the existing coordinator/guards, carrying one
main-owned token and the exact authenticated target from approved candidate through
drain and idle preparation:

1. After current approval of the exact trusted update, call `maintenance.runtime`
   with `{action: "drain", token, target}` on that captured managed target. Preserve
   target ownership and existing callback/answer/continuation access. Do not acquire
   the existing all-call Workspace/draft freeze at this edge.
2. Validate runtime-drain-v1 and the full exact target. Display activity or aggregate
   unfinished-work blockers and allow authorized work completion or owner `defer`.
   Keep an uncertain/lost outcome closed; do not redirect cleanup to a new daemon.
3. Require positive `held` drain proof, then freeze drafts/windows and compose the
   existing `prepareAdmission(target, token)` using the **same** token. No resume or
   release interval may occur between drain quiescence and guarded preparation.
   The existing runtime-v1 prepare proof is compatible at this point; it cannot
   substitute for the preceding parked-work inventory.
4. Retain admissions through installation and initial health/version/daemon-identity
   checks. Release only under the eventual accepted commit/restart/recovery contract.
   This slice produces no native commit owner or permission to release after install.

This is a process-local fence for the bound serving admission producers. Arbitrary
direct engine callers or another process writing shared stores are outside its
proof. Complete protected-writer capture, durable replacement admission, fresh
closed bootstrap, full protected-state plus matching-binary restore, signed native
engine/ordinary-quit acceptance and Keychain/intent-journal/TCC continuity remain
separate gates. Production Mac updates remain unavailable/disabled. There is no
installation-completion claim, rollback readiness, positive native acceptance or
restore implementation. Automatic rollback still requires positive proof that no
newer work, including startup/migration writes, is lost; otherwise preserve both
complete generations for explicit recovery. Other strategies remain deferred until
M10 and M22 complete.

## Author evidence and review

Portable local Node 24.19.0, existing Vitest 5.0.2 and TypeScript 7.0.2; no dependency
manifest or lockfile changes. Repository AGENTS/development/architecture instructions
and both required native handoffs were read; local `.agents`/`.codex` locations
contain no applicable skill. Author: Calcifer Schadewitz
`<schadewitzcalcifer@gmail.com>`.

Focused final validation is recorded in the draft PR: 80 tests in 10 files with at
most two workers, including 15 new drain/activity cases. Tests use the real
authenticated disposable daemon, production bootstrap/admission models and file
stores. One live-callback test explicitly supplies a synthetic authority/owned-writer
seam; no test result is signed native acceptance. Cases cover no work, active and
stalled work, parked-gate answering, existing callback settlement, admission before
its first service await, direct model refusal before service effects, defer,
wrong/foreign/unauthorized ownership, failed/oversized/stuck inventory, repeated
requests, completed intervening activity, late results and lost serving proof.
Relevant changed-file statics and whitespace/format checks accompany that evidence.
Root TypeScript no-emit, changed-file ESLint, changed-code Prettier, diff whitespace
and scoped document UTF-8/LF/link checks pass. Renderer/build/full-suite/coverage
checks were not rerun for this daemon/protocol slice. The base's documented #559
guided-launch adapter lint issue remains for the separate first-run owner/root to
compose; that file is untouched and focused lint is not full combined-CI proof.

Initial test harness failures were corrected without weakening the policy assertions:
a runs-list synchronization call also invoked the spied inventory, a bootstrap-bound
capture callback was not a live spy seam, and the public terminal status is
`succeeded` while the core status is `completed`. Self-review also removed run IDs
from the maintenance projection and prevented old idle-only leases from gaining
drain proof by relabeling. Root owns independent exact-head/schema review and CI.
No broad suite, coverage, workflow dispatch, live daemon mutation, release, merge,
provider, native host, signing, access, credential or security-policy change occurred.
This author publishes one draft stacked on #563 and stops; no subsequent slice follows.
