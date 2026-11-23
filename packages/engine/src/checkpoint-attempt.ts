/**
 * Checkpoint attempts (#357, phase 2): what a new run started after a completed step of a
 * failed run reuses, read from the source's authoritative log. The run itself is created by
 * `Orchestrator.startCheckpointAttempt`; this module only reads.
 */
import {
  OrcaError,
  RECOVERY_BLOCKER_TEXT,
  reduceRun,
  type Artifact,
  type OrcaEvent,
  type RecoveryAssessment,
  type RecoveryBlocker,
  type RecoveryOption,
  type RunCheckpoint,
  type RunState,
} from "@orca/core";
import { executionEvents, type Stores } from "@orca/store";
import { previewRecovery } from "./recovery-preview.js";

export interface CheckpointSeedOptions {
  /** The checkpoint: a step run id, or a node id that names exactly one. The latest usable one when absent. */
  checkpoint?: string | undefined;
  /** Who asks; a run that recorded its creator is recovered only by that principal. */
  principalId?: string | undefined;
  /** The lease this caller holds on the source while it reads, which does not count as a block. */
  leaseHolder?: string | undefined;
  /** New step run ids for the reused steps. */
  newStepId(): string;
}

export interface CheckpointSeed {
  seed: RunCheckpoint;
  /** The source's authoritative state (private payloads included). */
  source: RunState;
  assessment: RecoveryAssessment;
}

/**
 * `RECOVERY_BLOCKED` for a checkpoint attempt of `runId` that cannot start: the blockers, and
 * each one's operator sentence in the message, so whoever reads only the message knows why and
 * what to do instead.
 */
export function checkpointBlocked(
  runId: string,
  option: Pick<RecoveryOption, "blockers" | "checkpointStepRunId"> | undefined,
): OrcaError {
  const blockers = option?.blockers ?? [];
  return new OrcaError(
    "RECOVERY_BLOCKED",
    `run ${runId} cannot be recovered from a checkpoint: ${blockers.map((b) => RECOVERY_BLOCKER_TEXT[b]).join(" ")}`.trim(),
    {
      runId,
      blockers,
      ...(option?.checkpointStepRunId ? { checkpointStepRunId: option.checkpointStepRunId } : {}),
    },
  );
}

/**
 * What makes a run's recorded history impossible to continue: Resume refuses these up front
 * with the preview's operator sentences (#357), rather than with the lower-level refusal the
 * interpreter would reach once it tried to load them.
 */
const VERSION_BLOCKERS: ReadonlySet<RecoveryBlocker> = new Set([
  "workflow-missing",
  "workflow-revision-mismatch",
  "generation-missing",
  "execution-inputs-missing",
]);

/**
 * Throws when Resume of `runId` (and every run it would re-drive) cannot continue on the
 * workflow version, configuration generation or launch inputs it recorded: with the codes the
 * interpreter has always refused these with (`WORKFLOW_VERSION_NOT_FOUND` for a definition that
 * is gone, else `RUN_STATE`), now with the operator sentences and the blockers in the details.
 * Read-only, without opening artifacts. Everything else (a lease, an unreviewed effect, a
 * finished run) is left to the interpreter's own refusals, which are already specific.
 */
export async function resumeBlocked(stores: Stores, runId: string): Promise<void> {
  const assessment = await previewRecovery(stores, runId, { artifacts: false });
  const option = assessment.options.find((o) => o.kind === "resume");
  const blockers = unique((option?.blockers ?? []).filter((b) => VERSION_BLOCKERS.has(b)));
  if (!blockers.length) return;
  throw new OrcaError(
    blockers.includes("workflow-missing") ? "WORKFLOW_VERSION_NOT_FOUND" : "RUN_STATE",
    `run ${runId} cannot be resumed: ${blockers.map((b) => RECOVERY_BLOCKER_TEXT[b]).join(" ")}`,
    { runId, blockers },
  );
}

const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

/**
 * The checkpoint-attempt seed for `sourceRunId`, or `RECOVERY_BLOCKED` with the preview's
 * reasons. Unverified is not refused here: the interpreter checks what the preview could not
 * (the recorded generation restores) when it creates and drives the attempt.
 */
export async function checkpointSeed(
  stores: Stores,
  sourceRunId: string,
  options: CheckpointSeedOptions,
): Promise<CheckpointSeed> {
  const assessment = await previewRecovery(stores, sourceRunId, {
    checkpoint: options.checkpoint,
    principalId: options.principalId,
    leaseHolder: options.leaseHolder,
  });
  const option = assessment.options.find((o) => o.kind === "checkpoint-attempt");
  if (!option || option.readiness === "blocked" || !option.checkpointStepRunId)
    throw checkpointBlocked(sourceRunId, option);
  const checkpointStepRunId = option.checkpointStepRunId;
  const checkpoint = assessment.checkpoints.find((c) => c.stepRunId === checkpointStepRunId);
  if (!checkpoint) throw new OrcaError("RUN_STATE", `run ${sourceRunId} has no checkpoint ${checkpointStepRunId}`);

  const events = await executionEvents(await stores.events.read(sourceRunId), stores.execution);
  const source = reduceRun(events);
  const steps = checkpoint.reused.map((reused) => {
    const step = source.steps[reused.stepRunId];
    if (!step || step.status !== "completed" || !step.result || !step.completedAt)
      throw new OrcaError("RUN_STATE", `run ${sourceRunId} step ${reused.stepRunId} is not a completed step`);
    return {
      stepRunId: options.newStepId(),
      // A step a checkpoint attempt itself reused keeps pointing at the attempt that ran it.
      from: step.reusedFrom ?? { runId: sourceRunId, stepRunId: step.id },
      nodeId: step.nodeId,
      nodeType: step.nodeType,
      attempt: step.attempt,
      ...(step.iteration !== undefined ? { iteration: step.iteration } : {}),
      result: structuredClone(step.result),
      // A step the source itself reused lists its origin's children as history only.
      children: structuredClone(step.reusedChildren ?? step.children),
      completedAt: step.completedAt,
    };
  });
  if (steps.at(-1)?.nodeId !== checkpoint.nodeId)
    throw new OrcaError(
      "RUN_STATE",
      `run ${sourceRunId}: checkpoint ${checkpointStepRunId} is not the last reused step`,
    );

  const artifacts: Artifact[] = [];
  for (const id of new Set(steps.flatMap((s) => s.result.artifactIds))) {
    const artifact = source.artifacts[id] ?? (await stores.artifacts.get(id));
    if (!artifact) throw new OrcaError("ARTIFACT_MISSING", `artifact ${id} reused by the checkpoint is missing`);
    artifacts.push(structuredClone(artifact));
  }

  return {
    seed: {
      runId: sourceRunId,
      stepRunId: checkpointStepRunId,
      steps,
      artifacts,
      vars: await varsAt(
        stores,
        events,
        source.steps[checkpointStepRunId]!.reusedFrom ?? {
          runId: sourceRunId,
          stepRunId: checkpointStepRunId,
        },
      ),
    },
    source,
    assessment,
  };
}

/**
 * The vars as they stood when the checkpoint step completed, in the run that ran it. A step the
 * source itself reused never completed there, so its snapshot is read from the attempt that
 * ran it, not from the source's seed (which holds the vars of the source's own checkpoint).
 */
async function varsAt(
  stores: Stores,
  sourceEvents: OrcaEvent[],
  origin: { runId: string; stepRunId: string },
): Promise<Record<string, unknown>> {
  const first = sourceEvents[0];
  const events =
    first?.type === "run.created" && first.runId === origin.runId
      ? sourceEvents
      : await executionEvents(await stores.events.read(origin.runId), stores.execution);
  const completed = events.findIndex((e) => e.type === "step.completed" && e.payload.stepRunId === origin.stepRunId);
  if (completed < 0)
    throw new OrcaError("RUN_STATE", `run ${origin.runId} has no completion for ${origin.stepRunId}`, { ...origin });
  return structuredClone(reduceRun(events.slice(0, completed + 1)).run.vars);
}
