# Recovering interrupted work (#357)

Phase 1 is **assessment and preview**. `orca recovery <runId>` says how a run could be
recovered and what each way would reuse, repeat or leave uncertain. It takes no lease, appends no
event, starts nothing and carries no approval or permission forward.

Phase 2 starts with **side-effect review** (below): a step that may have acted and never finished
is never run again on its own, and `orca recovery review` records an operator's decision about
it. Starting a checkpoint attempt and the app's recovery panel follow; host reconnection and
reassignment stay with #344.

```sh
orca recovery <runId>                       # options, reasons, uncertain effects, checkpoints
orca recovery <runId> --checkpoint <stepRunId|nodeId> # one checkpoint: what it reuses and repeats
orca recovery <runId> --json                # the RecoveryAssessment, for tools
orca recovery review <runId> <stepRunId> --run-again [--note text]  # checked it; it may run again
orca recovery review <runId> <stepRunId> --abandon [--note text]    # it must not; end the run here
```

The command does not go through `bootstrap`: it takes no writer claim, stamps no store format,
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
| **Checkpoint attempt** | A separately identified new run that would start after a completed step of a failed run, reusing that step's and its predecessors' recorded results and artifacts, linked to the original. Previewed only, for now. | The run failed, it is a top-level run, the asker is the principal that started it (when the run recorded one), its workflow version is pinned and readable, its launch inputs are readable, it is not leased, every artifact the checkpoint reuses reads back, and every step after it that may have acted has been reviewed. |

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
  start, the session did not open) is retried as before.
- Any other node that can act outside ORCA (a plugin's custom node) is retried only when its
  executor states the attempt did nothing outside, `failed(code, message, details, true,
  "none")`; `step.failed` records that as `effect: "none"`. Without it the attempt is assumed to
  have acted.
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

## Drift

When the workflow a new run would use is at a different version, or the configuration
generation differs from the one the run recorded, the preview says so. A checkpoint attempt runs
on the pinned version the original used; changed configuration means agent selections may
resolve differently and is shown for review, not refused.

## Not yet

Starting a checkpoint attempt and the app's recovery panel (both phase 2, next), reconciling an
uncertain effect automatically, the operations console (#340), host-specific orphan handling
(#344), and agent-context recovery for approvals (the Approved, then Continue contract recorded
on #357).
