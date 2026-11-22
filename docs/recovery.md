# Recovering interrupted work (#357)

Phase 1 is **assessment and preview only**. `orca recovery <runId>` says how a run could be
recovered and what each way would reuse, repeat or leave uncertain. It takes no lease, appends no
event, starts nothing and carries no approval or permission forward. Execution controls for a
checkpoint attempt are later work; host reconnection and reassignment stay with #344.

```sh
orca recovery <runId>                       # options, reasons, uncertain effects, checkpoints
orca recovery <runId> --checkpoint <nodeId> # what a checkpoint after that step reuses and repeats
orca recovery <runId> --json                # the RecoveryAssessment, for tools
```

The model is `assessRecovery` in `packages/core/src/model/recovery.ts` (pure); the store read
that feeds it is `previewRecovery` in `packages/engine/src/recovery-preview.ts`.

## Three ways back, never presented as each other

| Option | What it is | Available when |
| --- | --- | --- |
| **Resume** | Re-drives the existing run from its own log, exactly as `orca resume` does today. A step that did not complete is attempted again as a new attempt; the topmost paused ancestor is the run actually re-driven. | The run has not ended, no live lease is held by another process, and its recorded launch inputs are readable. |
| **New run** | An intentional fresh execution of the workflow. Reuses nothing. | Always. The preview lists what the old run did so it is visible what would run again. |
| **Checkpoint attempt** | A separately identified new run that would start after a completed step of a failed run, reusing that step's and its predecessors' recorded results and artifacts, linked to the original. Previewed only. | The run failed, it is a top-level run, the asker is the principal that started it (when the run recorded one), its workflow version is pinned and readable, its launch inputs are readable, it is not leased, and every artifact the checkpoint reuses reads back. |

Every refusal has a reason code (`RecoveryBlocker`) and one sentence saying what to do instead
(`RECOVERY_BLOCKER_TEXT`). A missing artifact is a blocker on the checkpoints that need it, never an
exception.

## Effects

Each step in a preview carries one effect:

- **uncertain**: it started and did not complete. It may have changed the workspace or external
  systems, and nothing in ORCA can confirm whether it did. These are listed together under
  "Review before anything runs these again". Resume of an interrupted run lists its interrupted
  step this way, because resume runs that step again.
- **repeats**: it completed; running it again repeats its work on top of the changes it already made.
- **reused**: its recorded result and artifacts are reused and it does not run.
- **not-started**: it was scheduled or skipped and never ran.

A gate, decision or step that asked a person is marked `asksAgain` whenever it would run again.
Approvals, permission answers and saved rules are never carried to a step that runs again; a
reused step's recorded decision is history, not new authority.

## Checkpoints

Every completed, non-terminal step is a checkpoint at its point in the history. A checkpoint
reuses the latest attempt of each node up to and including that step, when that attempt
completed. What ran after it last time is listed as a guide: routing is re-evaluated, so a new
attempt need not take the same path. The option's own preview uses the latest eligible checkpoint.

## Drift

When the workflow a new run would use is at a different version, or the configuration
generation differs from the one the run recorded, the preview says so. A checkpoint attempt runs
on the pinned version the original used; changed configuration means agent selections may
resolve differently and is shown for review, not refused.

## Not in phase 1

Starting a checkpoint attempt, reconciling an uncertain effect, an RPC or app surface (the
operations console is #340), host-specific orphan handling (#344), and agent-context recovery
for approvals (the Approved, then Continue contract recorded on #357).
