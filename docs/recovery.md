# Recovering interrupted work (#357)

Phase 1 is **assessment and preview only**. `orca recovery <runId>` says how a run could be
recovered and what each way would reuse, repeat or leave uncertain. It takes no lease, appends no
event, starts nothing and carries no approval or permission forward. Execution controls for a
checkpoint attempt are later work; host reconnection and reassignment stay with #344.

```sh
orca recovery <runId>                       # options, reasons, uncertain effects, checkpoints
orca recovery <runId> --checkpoint <stepRunId|nodeId> # one checkpoint: what it reuses and repeats
orca recovery <runId> --json                # the RecoveryAssessment, for tools
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
| **Resume** | Re-drives the existing run from its own log, exactly as `orca resume` does today. The topmost paused ancestor is the run actually re-driven, and it re-attaches down to this one; each run in that chain attempts its unfinished last step again. | The run has not ended, and for every run in that chain: no live lease held by another process, readable launch inputs, and a readable pinned definition. |
| **New run** | An intentional fresh execution of the workflow. Reuses nothing. | Always. The preview lists what the old run did so it is visible what would run again. |
| **Checkpoint attempt** | A separately identified new run that would start after a completed step of a failed run, reusing that step's and its predecessors' recorded results and artifacts, linked to the original. Previewed only. | The run failed, it is a top-level run, the asker is the principal that started it (when the run recorded one), its workflow version is pinned and readable, its launch inputs are readable, it is not leased, and every artifact the checkpoint reuses reads back. |

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

- **uncertain**: it started, did not complete, and can act outside ORCA (an agent, a plugin's
  custom node, a decision an agent made). It may have changed the workspace or external
  systems, and nothing in ORCA can confirm whether it did. These are listed together under
  "Review before anything runs these again". Resume of an interrupted run lists its interrupted
  step this way, because resume runs that step again.
- **repeats**: it completed; running it again repeats its work on top of the changes it already made.
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

## Not in phase 1

Starting a checkpoint attempt, reconciling an uncertain effect, an RPC or app surface (the
operations console is #340), host-specific orphan handling (#344), and agent-context recovery
for approvals (the Approved, then Continue contract recorded on #357).
