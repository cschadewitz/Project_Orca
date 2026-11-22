/**
 * Recovery eligibility and previews (#357, phase 1). Pure and read-only.
 *
 * Three ways back from interrupted, failed or uncertain work, never presented as each other:
 *
 * - **Resume** re-drives an existing run that has not ended, from its own log. An interrupted
 *   step is attempted again as a new attempt; the earlier attempt's effects are not undone.
 * - **New run** is an intentional fresh execution of the workflow. It reuses nothing.
 * - **Checkpoint attempt** is a separately identified new run that would start after a
 *   completed step of a failed run, reusing that step's and its predecessors' recorded results
 *   and artifacts, with provenance links back to the original. Phase 1 only assesses and
 *   previews it; there is no execution control yet.
 *
 * Nothing here mutates history, carries an approval or a permission forward, or decides that
 * an effect happened. A step that started and did not complete is reported as an *uncertain
 * effect* the operator has to review before anything runs it again.
 */
import { z } from "zod";
import type { RunState, StepRun, StepStatus } from "./run.js";

export const RecoveryKindSchema = z.enum(["resume", "new-run", "checkpoint-attempt"]);
export type RecoveryKind = z.infer<typeof RecoveryKindSchema>;

/** Why an option or a checkpoint is not available. Each has one sentence an operator can act on. */
export const RecoveryBlockerSchema = z.enum([
  "terminal",
  "not-terminal",
  "not-failed",
  "leased",
  "child-run",
  "cross-principal",
  "workflow-unpinned",
  "workflow-missing",
  "execution-inputs-missing",
  "missing-artifact",
  "no-checkpoint",
]);
export type RecoveryBlocker = z.infer<typeof RecoveryBlockerSchema>;

export const RECOVERY_BLOCKER_TEXT: Record<RecoveryBlocker, string> = {
  terminal:
    "The run has ended. Resume only continues a run that has not ended; start a new run or a checkpoint attempt.",
  "not-terminal":
    "The run has not ended. Resume it, or cancel it before starting a checkpoint attempt from its history.",
  "not-failed": "Only a failed run offers a checkpoint attempt. A completed or cancelled run can start a new run.",
  leased: "Another process is driving this run now. Wait for it to stop, or recover it where it is running.",
  "child-run": "This run belongs to a container step. Recover the top-level run it belongs to instead.",
  "cross-principal": "This run was started by a different principal. Only its owner can recover it from its history.",
  "workflow-unpinned":
    "The run predates pinned workflow versions, so the definition it ran is not stored. Start a new run instead.",
  "workflow-missing": "The workflow version this run used is no longer readable. Start a new run instead.",
  "execution-inputs-missing":
    "The run's recorded launch inputs are unavailable, so its history cannot be continued. Start a new run instead.",
  "missing-artifact":
    "An artifact this checkpoint reuses is missing from the artifact store. Pick an earlier checkpoint or start a new run.",
  "no-checkpoint": "No completed step of this run can be reused. Start a new run instead.",
};

/** What an operator should know about a step before recovery runs or reuses it. */
export const RecoveryEffectSchema = z.enum([
  /** Started and did not complete: it may have changed the workspace or external systems. */
  "uncertain",
  /** Completed; its changes stay, and running it again repeats its work on top of them. */
  "repeats",
  /** Its recorded result and artifacts are reused; it does not run. */
  "reused",
  /** Scheduled and never started: nothing it did needs review. */
  "not-started",
  /**
   * Started and did not complete, but it acts only inside ORCA (a gate waiting on a person, a
   * container waiting on its children, a `set`): it starts again with nothing outside to review.
   */
  "restarts",
]);
export type RecoveryEffect = z.infer<typeof RecoveryEffectSchema>;

export const RecoveryStepSchema = z.object({
  /** The run the step belongs to: an ancestor's step when resume re-drives that ancestor. */
  runId: z.string(),
  stepRunId: z.string(),
  nodeId: z.string(),
  nodeType: z.string(),
  attempt: z.number().int().positive(),
  status: z.string(),
  effect: RecoveryEffectSchema,
  /** The agent the run's provenance recorded for this node, when it is an agent step. */
  agent: z.string().optional(),
  /** A person is asked again: decisions and permissions are never carried forward. */
  asksAgain: z.boolean(),
  artifactIds: z.array(z.string()),
  missingArtifactIds: z.array(z.string()),
});
export type RecoveryStep = z.infer<typeof RecoveryStepSchema>;

export const RecoveryCheckpointSchema = z.object({
  /** The completed step a checkpoint attempt would start after. */
  stepRunId: z.string(),
  nodeId: z.string(),
  eligible: z.boolean(),
  blockers: z.array(RecoveryBlockerSchema),
  /** This step and every completed step scheduled before it, latest attempt per node. */
  reused: z.array(RecoveryStepSchema),
  /** What ran after this point last time. Routing is re-evaluated, so this is a guide, not a promise. */
  ranAfter: z.array(RecoveryStepSchema),
});
export type RecoveryCheckpoint = z.infer<typeof RecoveryCheckpointSchema>;

export const RecoveryOptionSchema = z.object({
  kind: RecoveryKindSchema,
  available: z.boolean(),
  blockers: z.array(RecoveryBlockerSchema),
  /** Resume only: the run that would actually be re-driven (the topmost paused ancestor). */
  targetRunId: z.string().optional(),
  /** Steps this option would run again, with their effect review. */
  runsAgain: z.array(RecoveryStepSchema),
});
export type RecoveryOption = z.infer<typeof RecoveryOptionSchema>;

export const RecoveryAssessmentSchema = z.object({
  runId: z.string(),
  workflowId: z.string(),
  workflowVersion: z.string(),
  status: z.string(),
  options: z.array(RecoveryOptionSchema),
  checkpoints: z.array(RecoveryCheckpointSchema),
  /** Steps whose effects nobody can confirm. Each needs review before anything repeats it. */
  uncertain: z.array(RecoveryStepSchema),
  /** Present when the current workflow or configuration differs from what the run used. */
  drift: z
    .object({
      currentWorkflowVersion: z.string().optional(),
      currentConfigGeneration: z.string().optional(),
      recordedConfigGeneration: z.string().optional(),
    })
    .optional(),
});
export type RecoveryAssessment = z.infer<typeof RecoveryAssessmentSchema>;

/** What resume needs to know about one run it would drive. */
export interface RecoveryRunFacts {
  state: RunState;
  workflowStored: boolean;
  workflowReadable: boolean;
  executionInputsAvailable: boolean;
  leased: boolean;
}

export interface RecoveryFacts {
  state: RunState;
  /** `run.created`'s recorded principal, when the run recorded one. */
  creatorPrincipalId?: string | undefined;
  /** The principal asking. Absent for a local operator with no principal model. */
  principalId?: string | undefined;
  /** `run.created.workflowStored`. */
  workflowStored: boolean;
  /** The stored definition for (workflowId, workflowVersion) could be read. */
  workflowReadable: boolean;
  /** Recorded launch inputs are present (or the run never stored any). */
  executionInputsAvailable: boolean;
  /** A live lease on the run is held by someone (not lapsed). */
  leased: boolean;
  /**
   * The paused ancestors resume would re-drive with this run, nearest first; the last is the run
   * actually re-driven. Empty for a top-level run or one whose parent is not paused. Each is
   * checked as the run itself is, because resume drives all of them.
   */
  resumeAncestors?: readonly RecoveryRunFacts[];
  /** False for an artifact id the store cannot read. */
  artifactPresent: (artifactId: string) => boolean;
  currentWorkflowVersion?: string | undefined;
  currentConfigGeneration?: string | undefined;
}

const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);
const HUMAN_NODES: ReadonlySet<string> = new Set(["gate", "decision"]);
const SETTLED_STEP: ReadonlySet<StepStatus> = new Set(["completed", "skipped"]);
/**
 * Node types whose own work stays inside ORCA. A container's effects belong to its child runs,
 * which are assessed as runs. Anything else - an agent, a plugin's custom node, a decision an
 * agent made - can act on the workspace or the outside world.
 */
const INTERNAL_NODES: ReadonlySet<string> = new Set([
  "start",
  "end",
  "gate",
  "decision",
  "set",
  "loop",
  "parallel",
  "subworkflow",
]);
const mayActOutside = (step: StepRun): boolean =>
  !INTERNAL_NODES.has(step.nodeType) || step.agentSessionId !== undefined;

export function assessRecovery(facts: RecoveryFacts): RecoveryAssessment {
  const { state } = facts;
  const run = state.run;
  const steps = state.stepOrder.map((id) => state.steps[id]).filter((s): s is StepRun => Boolean(s));
  const viewIn = (owner: RunState) => {
    const agentFor = new Map((owner.run.provenance?.selections ?? []).map((s) => [s.nodeId, s.agent.value]));
    const humanSteps = new Set(Object.values(owner.humanInputs).map((input) => input.stepRunId));
    return (step: StepRun, effect: RecoveryEffect): RecoveryStep => {
      const artifactIds = step.result?.artifactIds ?? [];
      const agent = agentFor.get(step.nodeId);
      return {
        runId: owner.run.id,
        stepRunId: step.id,
        nodeId: step.nodeId,
        nodeType: step.nodeType,
        attempt: step.attempt,
        status: step.status,
        effect,
        ...(agent !== undefined && step.nodeType === "agent" ? { agent } : {}),
        asksAgain: effect !== "reused" && (HUMAN_NODES.has(step.nodeType) || humanSteps.has(step.id)),
        artifactIds,
        missingArtifactIds: artifactIds.filter((id) => !facts.artifactPresent(id)),
      };
    };
  };
  const view = viewIn(state);
  // A step that began, never reported success and can act outside ORCA may have acted. A skipped
  // or merely scheduled step never ran; a completed one is known done.
  const isUncertain = (step: StepRun): boolean =>
    step.startedAt !== undefined && !SETTLED_STEP.has(step.status) && mayActOutside(step);
  const uncertain = steps.filter(isUncertain).map((step) => view(step, "uncertain"));

  const terminal = TERMINAL.has(run.status);
  const child = Boolean(run.parentRunId);
  const shared: RecoveryBlocker[] = [];
  if (facts.leased) shared.push("leased");
  if (!facts.executionInputsAvailable) shared.push("execution-inputs-missing");

  // Resume: what the interpreter does today (orchestrator resume). It re-drives the topmost
  // paused ancestor, which re-attaches down to this run, and each run it drives re-attempts its
  // last step when that did not complete. Every run in that chain is checked, not only this one.
  const ancestors = facts.resumeAncestors ?? [];
  const chain: RecoveryRunFacts[] = [
    {
      state,
      workflowStored: facts.workflowStored,
      workflowReadable: facts.workflowReadable,
      executionInputsAvailable: facts.executionInputsAvailable,
      leased: facts.leased,
    },
    ...ancestors,
  ];
  const resumeTargetRunId = chain.at(-1)!.state.run.id;
  const resumeBlockers: RecoveryBlocker[] = terminal ? ["terminal"] : [];
  const resumeRunsAgain: RecoveryStep[] = [];
  for (const member of terminal ? [] : [...chain].reverse()) {
    if (member.leased) resumeBlockers.push("leased");
    if (!member.executionInputsAvailable) resumeBlockers.push("execution-inputs-missing");
    if (member.workflowStored && !member.workflowReadable) resumeBlockers.push("workflow-missing");
    const order = member.state.stepOrder;
    const last = member.state.steps[order[order.length - 1] ?? ""];
    if (last && last.status !== "completed") resumeRunsAgain.push(viewIn(member.state)(last, effectOf(last)));
  }

  // Checkpoints: every completed step, in scheduling order. A loop back to an earlier node makes
  // several, one for each point in the history.
  const latest = new Map<string, StepRun>();
  for (const step of steps) latest.set(step.nodeId, step);
  const checkpointBlockers: RecoveryBlocker[] = [];
  if (!terminal) checkpointBlockers.push("not-terminal");
  else if (run.status !== "failed") checkpointBlockers.push("not-failed");
  if (child) checkpointBlockers.push("child-run");
  if (
    facts.creatorPrincipalId !== undefined &&
    facts.principalId !== undefined &&
    facts.creatorPrincipalId !== facts.principalId
  )
    checkpointBlockers.push("cross-principal");
  if (!facts.workflowStored) checkpointBlockers.push("workflow-unpinned");
  else if (!facts.workflowReadable) checkpointBlockers.push("workflow-missing");
  checkpointBlockers.push(...shared);

  const checkpoints: RecoveryCheckpoint[] = [];
  steps.forEach((step, index) => {
    if (step.status !== "completed") return;
    if (step.result?.outcome) return; // A terminal step ended the run; nothing follows it.
    // What the history held at that point: the latest attempt of each node up to and including
    // this step, when that attempt completed. Later attempts are not part of the checkpoint.
    const upTo = new Map<string, StepRun>();
    for (const s of steps.slice(0, index + 1)) upTo.set(s.nodeId, s);
    const reused = [...upTo.values()]
      .filter((s) => s.status === "completed")
      .sort((x, y) => steps.indexOf(x) - steps.indexOf(y))
      .map((s) => view(s, "reused"));
    const after = steps.slice(index + 1);
    const blockers = [...checkpointBlockers];
    if (reused.some((s) => s.missingArtifactIds.length)) blockers.push("missing-artifact");
    checkpoints.push({
      stepRunId: step.id,
      nodeId: step.nodeId,
      eligible: blockers.length === 0,
      blockers: unique(blockers),
      reused,
      ranAfter: after.map((s) => view(s, effectOf(s))),
    });
  });
  const bestCheckpoint = [...checkpoints].reverse().find((c) => c.eligible);
  const checkpointOption: RecoveryOption = {
    kind: "checkpoint-attempt",
    available: Boolean(bestCheckpoint),
    blockers: bestCheckpoint
      ? []
      : unique(
          checkpoints.length
            ? checkpoints.flatMap((c) => c.blockers)
            : [...checkpointBlockers, "no-checkpoint" as const],
        ),
    runsAgain: bestCheckpoint?.ranAfter ?? [],
  };

  // A new run reuses nothing: every step of the workflow may run again, including the ones
  // whose effects are uncertain here. It is listed so that is visible, not to forbid it.
  const newRun: RecoveryOption = {
    kind: "new-run",
    available: true,
    blockers: [],
    runsAgain: [...latest.values()].map((s) => view(s, effectOf(s))),
  };

  const recordedConfig = run.provenance?.configGeneration;
  const versionDrift =
    facts.currentWorkflowVersion !== undefined && facts.currentWorkflowVersion !== run.workflowVersion;
  const configDrift =
    facts.currentConfigGeneration !== undefined &&
    recordedConfig !== undefined &&
    facts.currentConfigGeneration !== recordedConfig;

  return {
    runId: run.id,
    workflowId: run.workflowId,
    workflowVersion: run.workflowVersion,
    status: run.status,
    options: [
      {
        kind: "resume",
        available: resumeBlockers.length === 0,
        blockers: unique(resumeBlockers),
        ...(resumeTargetRunId !== run.id ? { targetRunId: resumeTargetRunId } : {}),
        runsAgain: resumeRunsAgain,
      },
      newRun,
      checkpointOption,
    ],
    checkpoints,
    uncertain,
    ...(versionDrift || configDrift
      ? {
          drift: {
            ...(versionDrift ? { currentWorkflowVersion: facts.currentWorkflowVersion } : {}),
            ...(configDrift
              ? { currentConfigGeneration: facts.currentConfigGeneration, recordedConfigGeneration: recordedConfig }
              : {}),
          },
        }
      : {}),
  };

  function effectOf(step: StepRun): RecoveryEffect {
    if (step.startedAt === undefined || step.status === "skipped") return "not-started";
    if (isUncertain(step)) return "uncertain";
    return step.status === "completed" ? "repeats" : "restarts";
  }
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}
