# Recovering interrupted work (#357)

Phase 1 is **assessment and preview**. `orca recovery <runId>` says how a run could be
recovered and what each way would reuse, repeat or leave uncertain. It takes no lease, appends no
event, starts nothing and carries no approval or permission forward.

Phase 2 adds **side-effect review** (below): a step that may have acted and never finished is
never run again on its own, and `orca recovery review` records an operator's decision about it.
It also adds **starting a checkpoint attempt** (`orca recovery start`, below), and the app's
recovery section (below). Host reconnection and reassignment stay with #344.

```sh
orca recovery <runId>                       # options, reasons, uncertain effects, checkpoints
orca recovery <runId> --checkpoint <stepRunId|nodeId> # one checkpoint: what it reuses and repeats
orca recovery <runId> --json                # the RecoveryAssessment, for tools
orca recovery review <runId> <stepRunId> --run-again [--note text]  # checked it; it may run again
orca recovery review <runId> <stepRunId> --abandon [--note text]    # it must not; end the run here
orca recovery start <runId> [--checkpoint <stepRunId|nodeId>] [--idempotency-key k]  # start a checkpoint attempt and follow it
orca recovery retire <runId> <attemptRunId> # retire an attempt that was reserved and never created
```

The preview does not go through `bootstrap`: it takes no writer claim, stamps no store format,
loads no plugin and records no configuration generation. It reads the config file, checks the
store format in read mode, opens the file stores and reads. Configuration drift needs a
generation, which only a writer records, so the CLI does not report it; the API does when given
the current generation.

The model is `assessRecovery` in `packages/core/src/model/recovery.ts` (pure); the store read
that feeds it is `previewRecovery` in `packages/engine/src/recovery-preview.ts`.

## Three ways back, never presented as each other

| Option | What it is | Available when |
| --- | --- | --- |
| **Resume** | Re-drives the existing run from its own log, exactly as `orca resume` does. The topmost paused ancestor is the run actually re-driven, and it re-attaches down to this one and every other unfinished run below it; each of them attempts its unfinished last step again. | The run has not ended, and for every run resume drives: no live lease held by another process, readable launch inputs, a readable pinned definition, and no interrupted step that may have acted and has not been reviewed. |
| **New run** | An intentional fresh execution of the workflow. Reuses nothing. | Always. The preview lists what the old run did so it is visible what would run again. |
| **Checkpoint attempt** | A separately identified new run that would start after a completed step of a failed run, reusing that step's and its predecessors' recorded results and artifacts, linked to the original. Started with `orca recovery start` (below). | The run failed, it is a top-level run, the asker is the principal that started it (when the run recorded one), its workflow version is pinned and readable, its launch inputs are readable, it is not leased, every artifact the checkpoint reuses reads back, and every step after it that may have acted has been reviewed. |

Each option and checkpoint has a **readiness**: `available` (nothing blocks it and nothing is
unconfirmed), `unverified` (nothing blocks it, but the read path cannot confirm something the
interpreter checks when it drives the run) or `blocked`. Unverified is never shown as available.
Today the one unverified case is a run whose provenance records a configuration generation: the
read path checks the snapshot is on file (missing blocks), but only a writer can show it still
restores with its agents and plugins. The read path does check the stored definition's revision
against the one the run recorded; a mismatch blocks, as it does in the interpreter. For an inline
child run (a loop body or parallel branch) that is the definition built from its stored root, as
the interpreter builds it; a root that no longer holds that inline graph blocks as missing.

Every refusal has a reason code (`RecoveryBlocker`) and one sentence saying what to do instead
(`RECOVERY_BLOCKER_TEXT`). A missing artifact is a blocker on the checkpoints that need it, never an
exception.

## Effects

Each step in a preview carries one effect:

- **uncertain**: it started, did not complete, was not paused on purpose, and can act outside
  ORCA (an agent, a plugin's custom node, a decision an agent made). It may have changed the
  workspace or external systems, and nothing in ORCA can confirm whether it did. Until it is
  reviewed, these are listed together under "Review before anything runs these again", and any
  option that would run one again is blocked (`effect-unreviewed`).
- **reviewed**: uncertain, and an operator checked it and marked it to run again.
- **repeats**: it completed, or it paused on purpose (an agent waiting on a person's answer);
  running it again repeats its work on top of the changes it already made.
- **reused**: its recorded result and artifacts are reused and it does not run.
- **restarts**: it started and did not complete, but it acts only inside ORCA (a gate waiting on
  a person, a container waiting on its children, a `set`), so it starts again with nothing outside
  to review. A container's children are assessed as runs of their own.
- **not-started**: it was scheduled or skipped and never ran.

A gate, or any step that recorded a request to a person, is marked `asksAgain` when it would run
again. A decision made by an expression or an agent is not a prompt. Resume is the same run, so
an answer it already recorded for the step it re-attempts still stands (`answerCarried`) and
nobody is asked again; a new run or checkpoint attempt asks everyone anew, and a reused step's
recorded decision there is history, not new authority.

## Side-effect review

A step attempt that began, never reported an outcome, was not paused on purpose, and can act
outside ORCA is an *uncertain effect*: a crash, a lost connection or a broken lease mid-step
leaves one, and so does a failed step that reported its failure after it may already have
acted. ORCA cannot know whether its change happened, so it never runs that step again on its own:

- The interpreter refuses to re-attempt such a step as a run's last step
  (`EFFECT_REVIEW_REQUIRED`, naming the run, step run and node). The refusal comes before
  anything is written, and `run`/`resume` check every unfinished run they would re-attach to
  first, so a child run's interrupted step never fails the container step waiting on it. A run
  another live interpreter holds is left to it: its open step is in flight, not interrupted, and
  the lease refuses on its own.
- An operator checks what the step did, then records a review, `step.effect.reviewed`, with
  `orca recovery review <runId> <stepRunId>`:
  - `--run-again`: it may run again. Resume (or a checkpoint attempt) runs it as a new attempt;
    its earlier changes stay.
  - `--abandon`: it must not run again. The decision alone is a denial: from the moment it is
    recorded every execution entry refuses that step (`EFFECT_ABANDONED`), even if the
    cancellation that follows never lands. The run is then cancelled ("abandoned after
    side-effect review") under the same lease that recorded the decision, so no other
    interpreter can attach in between; the children it was waiting on are cancelled after.
    Recording the same abandon again finishes an interrupted cancellation.
  `--note` records why. The review is taken under the run's lease, so it is refused while
  another process drives the run.
- The same review again is a no-op, so a retried or reconnected request is safe. A different
  decision for an already-reviewed step is refused, and so is a review of a step that needs none
  (it completed, was skipped, paused on purpose, or was never started): a stale review cannot
  land on a later attempt.

The retry budget follows the same rule. A failed attempt is retried automatically
(`maxAttempts`) only on durable evidence that it did nothing outside ORCA:

- An agent step (or a decision or other step an agent answers) records `agent.turn.started`
  before each prompt is sent, on its own session or the run's pooled one. Once one is recorded
  the step is `dispatched` and its failure is never retried automatically: it fails the run, and
  the step is uncertain until reviewed. A failure before the first prompt (the agent did not
  start, the session did not open) is retried as before. The record is synced to durable
  storage (`synchronizeEvent`, an fsync on the file and SQLite stores) before the prompt goes
  out, so a crash or power loss cannot lose the evidence of a prompt that was sent; a store that
  cannot sync it refuses the turn (`NOT_SUPPORTED`) and no prompt is sent.
- Any other node that can act outside ORCA (a plugin's custom node) is retried only when its
  executor states the attempt did nothing outside, `failed(code, message, details, true,
  "none")`; `step.failed` records that as `effect: "none"`. Without it the attempt is assumed to
  have acted. An executor can instead pass `"repeatable"`: the attempt may have acted but
  repeating it is safe, so the budget may repeat it; nothing is recorded about its effect, so an
  attempt left when the budget is spent waits for review like any other. `custom:jev-eval`
  states `none` for failures before its request is sent, and `repeatable` after that only when
  the node sets `repeatable: true`; an invalid or wrong-model answer comes after the request too.
- Steps that act only inside ORCA (gates, `set`, containers) are retried as before.

A step paused on purpose is different: an agent that asked a person, or a container waiting on a
child, is recorded as `parked` when the run pauses, and resume re-attempts it by design, as
before. Reconciling the effect itself (proving it happened, or undoing it) is not something
ORCA does; the review records the operator's decision and who made it.

## Checkpoints

Every completed, non-terminal step is a checkpoint at its point in the history. A checkpoint
reuses the latest attempt of each node up to and including that step, when that attempt
completed. What ran after it last time is listed as a guide: routing is re-evaluated, so a new
attempt need not take the same path.

A checkpoint is one step attempt, named by its step run id. `--checkpoint` takes that id, or a
node id that completed exactly once; after a loop a node id names several points in history and
is refused with their ids. The checkpoint-attempt option's readiness, reasons and repeat list
describe the named checkpoint, and without one the latest checkpoint that is not blocked.

## Starting a checkpoint attempt

`orca recovery start <runId>` creates the attempt and follows it as `orca run` does (exit 0 on
success, 2 on failure or cancellation, 3 when it pauses for input). `--checkpoint` names the
checkpoint as in the preview; without it, the latest one that is not blocked is used.

- **One event.** The attempt is a new top-level run. Its `run.created` carries a `checkpoint`
  block: the source run and checkpoint step, the reused steps (under new step run ids, each
  with `reusedFrom` naming the source attempt, plus its recorded result and child-run links),
  the artifact records they produced (same ids, `producedBy` unchanged) and the vars as they
  stood when the checkpoint completed (read from the run that ran it, when the source itself
  reused it). The projection shows the reused steps as completed, never started here, and
  `run.checkpoint` links back to the source. A reused step's child runs appear as
  `reusedChildren`, history only: they stay the source's, so cancelling, resuming or answering
  the attempt never reaches them. The interpreter then routes on from
  the checkpoint, as resume does from a completed step.
- **Nothing carries authority.** A reused gate's recorded choice routes the attempt, but nobody's
  answer is replayed: any step that runs again asks again.
- **Pinned like the source.** The attempt uses the source's recorded configuration generation
  and its pinned workflow revision, its launch inputs (with everything it treated as sensitive,
  overlays included) and its workspace, so the reused steps' changes are where the next step
  expects them. It is checked again when it is created: a preview that went stale (a review now
  missing, the source leased, an artifact gone) refuses with `RECOVERY_BLOCKED` and its reasons,
  and writes nothing.
- **One at a time.** It is created under the source's run lease. Each attempt is recorded
  against its source in the execution store (`checkpointAttempts`), and a new one is refused
  while the last one has not finished, because they share the workspace. The record is written
  before the attempt's run, so an attempt that was reserved and never created (the process
  stopped in between) also holds the workspace: only its own admission, reconciled, creates
  it, or `orca recovery retire <runId> <attemptRunId>` retires it, after which its admission can
  never create it and another attempt may start. A reservation whose private inputs were
  written without a log (creation may have begun) cannot be retired; only reconciling ends it. The source's log is never changed.
- **Retry-safe.** With a persistent store, the command goes through retry-safe admission
  (`run.recover`, `CheckpointAdmissionService`). It reserves the run id before anything is
  written, and the attempt runs under the same bounded first-attachment policy as a direct run.
  That policy is published in two phases: its binding is recorded before the run is created, so
  an interruption between the two is finished by reconciling the admission rather than leaving
  a run nothing can attach.
  The printed retry key, given again with `--idempotency-key`, returns the same attempt rather
  than starting another, and the same key with a different run or checkpoint is a conflict. An
  admission that was interrupted after reserving its attempt is reconciled by the command (the
  same key, or the next run of it), which creates exactly that attempt. A
  run that recorded no configuration generation has nothing to pin an admission to, so it is
  started directly.

## Over the daemon

Protocol 2.5 carries the same three actions for the app:

- `runs.recovery` (`runs.read`) answers the assessment above for one run, with the caller as
  the principal. It writes nothing, so a `--read-only` daemon answers it. For a caller without
  `artifacts.read` it opens no artifact and names none: each checkpoint is unverified
  (`artifacts-unchecked`) on that point rather than blocked, and the attempt checks its
  artifacts when it is created.
- `runs.reviewEffect` (`runs.control`) records a review of one uncertain step attempt, as
  `orca recovery review` does, and returns the run.
- `runs.recover` (`runs.start`, on a daemon with retry-safe admission) starts a checkpoint
  attempt as `orca recovery start` does: one attempt per idempotency key, authorized as a new
  run of the source's workflow and only for the principal that started the source. The daemon
  then drives it once, under the same first-attachment policy as `runs.admit`, and its receipt
  reads back and reconciles through `admissions.get` and `admissions.reconcile`. A caller
  finishing a checkpoint attempt passes `kind: "run.recover"` to `admissions.reconcile`; the
  daemon reads the receipt's kind first and refuses any other kind before it reconciles,
  creates or drives anything. Reconciling it
  can create the reserved attempt, so while new admission is closed (an update drain) it is
  refused like `runs.recover`; `admissions.get` stays open and read-only.

Run views say where a run and its steps came from: `checkpoint` on a run summary, and
`reusedFrom`, `reusedChildren` and `effectReview` on a step. In history pages and event frames,
a caller without `artifacts.read` gets a checkpoint attempt's `run.created` without the reused
artifact records or ids. A `step.effect.reviewed` event reaches only a client that reads
protocol 2.5 events (`protocol` on `runs.events` and `subscribe`); an older client's pages and
streams skip it and keep their cursors. A checkpoint receipt is not carried by
`operator.admission` or `operator.reconcileAdmission`, which refuse it before doing anything.

## When recovery is refused

Every refusal comes before anything is written, claimed or run, so the same idempotency key
can be used again once the cause is gone. A `RECOVERY_BLOCKED` refusal carries its reasons in
`details.blockers`, and its message includes each reason's operator sentence
(`RECOVERY_BLOCKER_TEXT`). `daemon/test/recovery-safe-failures-357.test.ts` covers each case:

| Case | Checkpoint attempt (`runs.recover`) | Resume (`runs.resume`) |
| --- | --- | --- |
| Another principal's run | `RECOVERY_BLOCKED` (`cross-principal`) | `RUN_NOT_FOUND` to a caller scoped to their own runs: a run they may not see is not confirmed to exist |
| Stale or unknown checkpoint | `CONFIG_INVALID`, naming the step it has no completed run of | not applicable |
| Missing artifact | `RECOVERY_BLOCKED` (`missing-artifact`). Left to choose, the latest checkpoint that is not blocked is picked | not applicable (Resume reuses nothing) |
| Workflow version or configuration gone or changed | `RECOVERY_BLOCKED` (`workflow-missing`, `workflow-revision-mismatch`, `generation-missing`, `execution-inputs-missing`) | `WORKFLOW_VERSION_NOT_FOUND` for a definition that is gone, otherwise `RUN_STATE`, with the same blockers and sentences |
| Permission revoked | `AUTH_FORBIDDEN` when the caller may no longer start the workflow; `AUTH_INVALID` for a revoked credential | `AUTH_FORBIDDEN` without `runs.control`; `AUTH_INVALID` for a revoked credential |

Resume checks the recorded workflow version, configuration generation and launch inputs of every
run it would re-drive before it takes a lease (`resumeBlocked`), without opening artifacts.
Leases and unreviewed effects keep their own refusals (`RUN_LEASED_ELSEWHERE`,
`EFFECT_REVIEW_REQUIRED`). `engine/test/crash-resume-357.test.ts` resumes runs left by a real
process that exited or was killed, and checks that no completed step runs again.

## Drift

When the workflow a new run would use is at a different version, or the configuration
generation differs from the one the run recorded, the preview says so. A checkpoint attempt runs
on the pinned version the original used; changed configuration means agent selections may
resolve differently and is shown for review, not refused.

## Not yet

Recovery previews on the operations board (#340), reconciling an
uncertain effect automatically, the operations console (#340), host-specific orphan handling
(#344), and agent-context recovery for approvals (the Approved, then Continue contract recorded
on #357).

## In the app

Selecting a run that stopped (failed, cancelled or held, not running or succeeded) shows a
**Recovery** section in its summary, read from `runs.recovery`: each option with the same
reasons the CLI prints, the steps that need review, and the checkpoints, newest first. Each
control is drawn only when the daemon lists its method, so a daemon before protocol 2.5 shows
none of it and a `--read-only` daemon shows the assessment without buttons.

- **Mark to run again** and **Abandon the run** record a review (`runs.reviewEffect`).
  Abandoning asks for confirmation first.
- **Start an attempt from here** sends `runs.recover` for that checkpoint. The intent (the
  verified connection and principal, the source run, the checkpoint, its idempotency key, a
  reserved receipt once there is one, and the attempt the daemon accepted) is kept by the app's
  main process in an encrypted journal (`recovery-intents.enc`, OS keychain, never plain text),
  not in the window. An SSH profile's connection is identified by the profile, its effective SSH
  endpoint (server and jump chain), the daemon's remote port and the host-key pins its tunnel sealed, not
  its tunnel's local port, so reconnecting to the same verified endpoint finds the same intent
  while a changed endpoint or a replaced pin does not. A tunnel that has not sealed its pins
  cannot start a recovery. Leaving the run, selecting a step, reloading or restarting the app finds the
  same intent above the checkpoints, and no other checkpoint of that run can be started
  meanwhile:
  - **Ask again** sends the same key after any answer that is not an outcome: a lost reply, an
    in-progress answer, or an error. An error answers that request only and cannot show that an
    earlier, lost request admitted nothing, so it never ends the intent. A start refused because
    a step still needs review can be asked again with the same key once it is reviewed.
  - **Finish the attempt** after a receipt that reserved the attempt without confirming it was
    created reconciles that receipt (`admissions.reconcile` with `kind: "run.recover"`) and
    never starts another.
  - **Abandon this recovery**, after a confirmation, forgets an unresolved intent. It cancels
    nothing on the daemon; the next start is new work with a new key.
  - Once the daemon accepts an attempt for this source, the attempt is written to the intent
    before anyone is told, so a lost reply, a reload or a changed connection still finds it:
    **Open the attempt**, or **Start a separate attempt**, which confirms and then forgets the
    link so the next start uses a new key.

  Main runs one start, finish or dismissal per source run at a time, a dismissal's confirmation
  included. An answer that arrives after the connection changed is recorded against its own
  intent and not shown on the new connection. A started attempt is selected in the run tree.
- A checkpoint attempt's summary names the run and step it started after, and a reused step
  says which run it came from. A step with a recorded review says what was decided.

