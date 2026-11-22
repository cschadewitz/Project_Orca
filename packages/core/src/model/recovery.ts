/**
 * Recovery eligibility and previews (#357, phase 1). Pure and read-only.
 *
 * Three ways back from interrupted, failed or uncertain work, never presented as each other:
 *
 * - **Resume** re-drives an existing run that has not ended, from its own log. An interrupted
 *   step is attempted again as a new attempt; the earlier attempt's effects are not undone. It
 *   is the same run, so an answer it already recorded still stands.
 * - **New run** is an intentional fresh execution of the workflow. It reuses nothing.
 * - **Checkpoint attempt** is a separately identified new run that would start after one
 *   completed step attempt of a failed run, reusing that point's recorded results and artifacts,
 *   with provenance links back to the original.
 *
 * Nothing here mutates history or decides that an effect happened. A step that started, did not
 * complete, was not paused on purpose and can act outside ORCA is reported as an *uncertain
 * effect*: until an operator records a review (`step.effect.reviewed`), nothing runs it again,
 * and the interpreter refuses to on its own (`needsEffectReview`, phase 2). What the read path cannot confirm (a recorded
 * configuration generation actually restoring) is reported as *unverified*, never as available.
 */
import { z } from "zod";
import { OrcaError } from "../errors.js";
import type { RunState, StepRun, StepStatus } from "./run.js";

export const RecoveryKindSchema = z.enum(["resume", "new-run", "checkpoint-attempt"]);
export type RecoveryKind = z.infer<typeof RecoveryKindSchema>;

/** Why an option or a checkpoint cannot be used. Each has one sentence an operator can act on. */
export const RecoveryBlockerSchema = z.enum([
  "terminal",
  "not-terminal",
  "not-failed",
  "leased",
  "child-run",
  "cross-principal",
  "workflow-unpinned",
  "workflow-missing",
  "workflow-revision-mismatch",
  "generation-missing",
  "execution-inputs-missing",
  "missing-artifact",
  "no-checkpoint",
  "effect-unreviewed",
  "effect-abandoned",
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
  "workflow-revision-mismatch":
    "The stored workflow definition no longer matches the revision this run recorded, so its history cannot be continued. Start a new run instead.",
  "generation-missing":
    "The configuration generation this run recorded is not on file, so its history cannot be continued. Start a new run instead.",
  "execution-inputs-missing":
    "The run's recorded launch inputs are unavailable, so its history cannot be continued. Start a new run instead.",
  "missing-artifact":
    "An artifact this checkpoint reuses is missing from the artifact store. Pick an earlier checkpoint or start a new run.",
  "no-checkpoint": "No completed step of this run can be reused. Start a new run instead.",
  "effect-unreviewed":
    "A step that may have changed the workspace or external systems did not finish. Check what it did, then mark it to run again or abandon the run.",
  "effect-abandoned":
    "An operator abandoned a step this would run again, so it must not run. Record the same review again to finish ending the run, or start a new run.",
};

/** What the read path could not confirm. An option with any of these is unverified, not available. */
export const RecoveryUnverifiedSchema = z.enum(["generation-restore", "generation-unreadable"]);
export type RecoveryUnverified = z.infer<typeof RecoveryUnverifiedSchema>;

export const RECOVERY_UNVERIFIED_TEXT: Record<RecoveryUnverified, string> = {
  "generation-restore":
    "The configuration generation this run recorded is on file, but whether it still restores (its agents and plugins) is checked only when the run is driven.",
  "generation-unreadable":
    "The configuration generation this run recorded could not be read here; whether it is usable is checked only when the run is driven.",
};

/** `available`: nothing blocks it and nothing is unconfirmed. Never a promise that it will succeed. */
export const RecoveryReadinessSchema = z.enum(["available", "unverified", "blocked"]);
export type RecoveryReadiness = z.infer<typeof RecoveryReadinessSchema>;

/** What an operator should know about a step before recovery runs or reuses it. */
export const RecoveryEffectSchema = z.enum([
  /** Started, did not complete and can act outside ORCA: it may have changed the workspace or external systems. */
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
  /** Did not complete and may have acted; an operator checked it and marked it to run again. */
  "reviewed",
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
  /**
   * A person will be asked. True for a gate, or a step that recorded a request to a person,
   * unless resume continues with an answer this run already recorded for it.
   */
  asksAgain: z.boolean(),
  /** Resume only: the answer this run recorded for the step still stands, so nobody is asked again. */
  answerCarried: z.boolean(),
  artifactIds: z.array(z.string()),
  missingArtifactIds: z.array(z.string()),
  /** The operator's recorded review of this attempt, when there is one. */
  review: z.enum(["run-again", "abandon"]).optional(),
});
export type RecoveryStep = z.infer<typeof RecoveryStepSchema>;

export const RecoveryCheckpointSchema = z.object({
  /** The exact completed step attempt a checkpoint attempt would start after. */
  stepRunId: z.string(),
  nodeId: z.string(),
  attempt: z.number().int().positive(),
  readiness: RecoveryReadinessSchema,
  blockers: z.array(RecoveryBlockerSchema),
  unverified: z.array(RecoveryUnverifiedSchema),
  /** The latest attempt of each node up to and including this step, when that attempt completed. */
  reused: z.array(RecoveryStepSchema),
  /** What ran after this point last time. Routing is re-evaluated, so this is a guide, not a promise. */
  ranAfter: z.array(RecoveryStepSchema),
});
export type RecoveryCheckpoint = z.infer<typeof RecoveryCheckpointSchema>;

export const RecoveryOptionSchema = z.object({
  kind: RecoveryKindSchema,
  readiness: RecoveryReadinessSchema,
  blockers: z.array(RecoveryBlockerSchema),
  unverified: z.array(RecoveryUnverifiedSchema),
  /** Resume only: the run that would actually be re-driven (the topmost paused ancestor). */
  targetRunId: z.string().optional(),
  /** Checkpoint attempt only: the step attempt this option describes. */
  checkpointStepRunId: z.string().optional(),
  /** Steps this option would run, with their effect review. */
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

/** What continuing one run's history needs, as the read path found it. */
export interface RecoveryRunFacts {
  state: RunState;
  /** `run.created.workflowStored`. */
  workflowStored: boolean;
  /** The stored definition for (workflowId, workflowVersion) could be read. */
  workflowReadable: boolean;
  /**
   * The stored definition's revision against `provenance.workflow.revision`. `not-recorded` for a
   * run with no provenance (the interpreter does not check one); `unknown` when unreadable.
   */
  revision: "matches" | "mismatch" | "not-recorded" | "unknown";
  /** The recorded configuration generation's snapshot. `not-recorded` for a run with no provenance. */
  generation: "present" | "missing" | "unreadable" | "not-recorded";
  /** Recorded launch inputs are present (or the run never stored any). */
  executionInputsAvailable: boolean;
  /** A live lease on the run is held by someone (not lapsed). */
  leased: boolean;
}

export interface RecoveryFacts extends RecoveryRunFacts {
  /** `run.created`'s recorded principal, when the run recorded one. */
  creatorPrincipalId?: string | undefined;
  /** The principal asking. Absent for a local operator with no principal model. */
  principalId?: string | undefined;
  /**
   * The paused ancestors resume would re-drive with this run, nearest first; the last is the run
   * actually re-driven. Each is checked as the run itself is, because resume drives all of them.
   */
  resumeAncestors?: readonly RecoveryRunFacts[];
  /**
   * The runs below the re-driven one that have not ended: resume re-attaches to each of them, so
   * each is checked too, and an interrupted step in any of them needs review first.
   */
  resumeDescendants?: readonly RecoveryRunFacts[];
  /** False for an artifact id the store cannot read. */
  artifactPresent: (artifactId: string) => boolean;
  /**
   * The checkpoint the checkpoint-attempt option describes: a step run id, or a node id when
   * exactly one checkpoint is at that node. Absent: the latest checkpoint that is not blocked.
   */
  checkpoint?: string | undefined;
  currentWorkflowVersion?: string | undefined;
  currentConfigGeneration?: string | undefined;
}

const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);
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
/**
 * Whether this attempt can have acted outside ORCA, from what the log durably shows. An agent
 * step, or an internal node that asks an agent (a decision), acts only through a turn, and
 * `dispatched` is recorded before each prompt is sent, on the step a pooled session serves.
 * Anything else that is not internal - a plugin's custom node - leaves no such evidence, so it
 * may have acted as soon as it started, unless its executor reported a failure with no effect.
 */
const mayActOutside = (step: StepRun): boolean =>
  step.dispatched === true || (step.nodeType !== "agent" && !INTERNAL_NODES.has(step.nodeType) && !step.noEffect);

/**
 * The attempt started and may have acted outside ORCA, whatever it reported. The interpreter
 * repeats a failed attempt automatically (its retry budget) only when this is false (#357).
 */
export function mayHaveActed(step: StepRun): boolean {
  return step.startedAt !== undefined && mayActOutside(step);
}

/**
 * The attempt began, never reported success, was not paused on purpose and can act outside
 * ORCA, so it may have acted and nobody can say whether it did. A skipped or merely scheduled
 * step never ran; a completed one is known done; a parked one asked to be attempted again.
 */
export function uncertainEffect(step: StepRun): boolean {
  return step.startedAt !== undefined && !SETTLED_STEP.has(step.status) && !step.parked && mayActOutside(step);
}

/**
 * Nothing may run this attempt again until an operator reviews it (#357). The interpreter
 * checks this before re-attempting a run's last step; recovery previews block on it.
 */
export function needsEffectReview(step: StepRun): boolean {
  return uncertainEffect(step) && step.effectReview === undefined;
}

/**
 * An operator reviewed this attempt and abandoned it: nothing may run it again, whether or not
 * the run's cancellation has landed yet. Only `run-again` clears the review fence.
 */
export function effectAbandoned(step: StepRun): boolean {
  return uncertainEffect(step) && step.effectReview?.decision === "abandon";
}

/** What continuing this run's recorded history requires and cannot be confirmed here. */
function pinChecks(member: RecoveryRunFacts): { blockers: RecoveryBlocker[]; unverified: RecoveryUnverified[] } {
  const blockers: RecoveryBlocker[] = [];
  const unverified: RecoveryUnverified[] = [];
  if (member.leased) blockers.push("leased");
  if (!member.executionInputsAvailable) blockers.push("execution-inputs-missing");
  if (member.workflowStored && !member.workflowReadable) blockers.push("workflow-missing");
  if (member.revision === "mismatch") blockers.push("workflow-revision-mismatch");
  if (member.generation === "missing") blockers.push("generation-missing");
  if (member.generation === "unreadable") unverified.push("generation-unreadable");
  if (member.generation === "present") unverified.push("generation-restore");
  return { blockers, unverified };
}

function readinessOf(blockers: readonly unknown[], unverified: readonly unknown[]): RecoveryReadiness {
  return blockers.length ? "blocked" : unverified.length ? "unverified" : "available";
}

export function assessRecovery(facts: RecoveryFacts): RecoveryAssessment {
  const { state } = facts;
  const run = state.run;
  const steps = state.stepOrder.map((id) => state.steps[id]).filter((s): s is StepRun => Boolean(s));

  /**
   * `continue`: resume, the same run, so an answer it recorded for a step still stands.
   * `fresh`: a new run or checkpoint attempt, where every request to a person is asked anew.
   */
  const viewIn = (owner: RunState, mode: "continue" | "fresh") => {
    const agentFor = new Map((owner.run.provenance?.selections ?? []).map((s) => [s.nodeId, s.agent.value]));
    const inputs = Object.values(owner.humanInputs);
    return (step: StepRun, effect: RecoveryEffect): RecoveryStep => {
      const artifactIds = step.result?.artifactIds ?? [];
      const agent = agentFor.get(step.nodeId);
      const asked = inputs.filter((input) => input.stepRunId === step.id);
      // A decision is a prompt only when it asked someone; an expression or agent decision is not.
      const human = step.nodeType === "gate" || asked.length > 0;
      const answered = asked.length > 0 && asked.every((input) => input.answer !== undefined);
      const carried = mode === "continue" && human && answered;
      return {
        runId: owner.run.id,
        stepRunId: step.id,
        nodeId: step.nodeId,
        nodeType: step.nodeType,
        attempt: step.attempt,
        status: step.status,
        effect,
        ...(agent !== undefined && step.nodeType === "agent" ? { agent } : {}),
        asksAgain: effect !== "reused" && human && !carried,
        answerCarried: carried,
        artifactIds,
        missingArtifactIds: artifactIds.filter((id) => !facts.artifactPresent(id)),
        ...(step.effectReview ? { review: step.effectReview.decision } : {}),
      };
    };
  };
  const fresh = viewIn(state, "fresh");
  const effectOf = (step: StepRun): RecoveryEffect => {
    if (step.startedAt === undefined || step.status === "skipped") return "not-started";
    if (uncertainEffect(step)) return step.effectReview?.decision === "run-again" ? "reviewed" : "uncertain";
    // Completed, or parked on purpose: it runs again on top of what it already did.
    if (step.status === "completed" || (step.parked && mayActOutside(step))) return "repeats";
    return "restarts";
  };
  // Only what still needs a decision; a reviewed step shows its review where it runs again.
  const uncertain = steps.filter(needsEffectReview).map((step) => fresh(step, "uncertain"));
  const terminal = TERMINAL.has(run.status);

  // Resume: what the interpreter does (orchestrator resume). It re-drives the topmost paused
  // ancestor, which re-attaches down to this run and every other unfinished run below it, and
  // each run it drives re-attempts its last step when that did not complete. Every run it drives
  // is checked, not only this one: the ancestors from the top down, then the rest below.
  const ancestry: RecoveryRunFacts[] = [facts, ...(facts.resumeAncestors ?? [])];
  const resumeTargetRunId = ancestry.at(-1)!.state.run.id;
  const below = (facts.resumeDescendants ?? []).filter((d) => !ancestry.some((a) => a.state.run.id === d.state.run.id));
  const resumeBlockers: RecoveryBlocker[] = terminal ? ["terminal"] : [];
  const resumeUnverified: RecoveryUnverified[] = [];
  const resumeRunsAgain: RecoveryStep[] = [];
  for (const member of terminal ? [] : [...[...ancestry].reverse(), ...below]) {
    const checks = pinChecks(member);
    resumeBlockers.push(...checks.blockers);
    resumeUnverified.push(...checks.unverified);
    const order = member.state.stepOrder;
    const last = member.state.steps[order[order.length - 1] ?? ""];
    if (last && last.status !== "completed") {
      resumeRunsAgain.push(viewIn(member.state, "continue")(last, effectOf(last)));
      if (needsEffectReview(last)) resumeBlockers.push("effect-unreviewed");
      if (effectAbandoned(last)) resumeBlockers.push("effect-abandoned");
    }
  }

  // Checkpoints: every completed, non-terminal step attempt, in scheduling order. A loop back to
  // an earlier node makes several, one for each point in the history.
  const own = pinChecks(facts);
  const checkpointBlockers: RecoveryBlocker[] = [];
  if (!terminal) checkpointBlockers.push("not-terminal");
  else if (run.status !== "failed") checkpointBlockers.push("not-failed");
  if (run.parentRunId) checkpointBlockers.push("child-run");
  if (
    facts.creatorPrincipalId !== undefined &&
    facts.principalId !== undefined &&
    facts.creatorPrincipalId !== facts.principalId
  )
    checkpointBlockers.push("cross-principal");
  if (!facts.workflowStored) checkpointBlockers.push("workflow-unpinned");
  checkpointBlockers.push(...own.blockers);

  const checkpoints: RecoveryCheckpoint[] = [];
  steps.forEach((step, index) => {
    if (step.status !== "completed") return;
    if (step.result?.outcome) return; // A terminal step ended the run; nothing follows it.
    const upTo = new Map<string, StepRun>();
    for (const s of steps.slice(0, index + 1)) upTo.set(s.nodeId, s);
    const reused = [...upTo.values()]
      .filter((s) => s.status === "completed")
      .sort((x, y) => steps.indexOf(x) - steps.indexOf(y))
      .map((s) => fresh(s, "reused"));
    const blockers = [...checkpointBlockers];
    if (reused.some((s) => s.missingArtifactIds.length)) blockers.push("missing-artifact");
    // The attempt runs again what ran after this point; anything there that may have acted
    // needs its review first.
    if (steps.slice(index + 1).some(needsEffectReview)) blockers.push("effect-unreviewed");
    if (steps.slice(index + 1).some(effectAbandoned)) blockers.push("effect-abandoned");
    checkpoints.push({
      stepRunId: step.id,
      nodeId: step.nodeId,
      attempt: step.attempt,
      readiness: readinessOf(blockers, own.unverified),
      blockers: unique(blockers),
      unverified: unique(own.unverified),
      reused,
      ranAfter: steps.slice(index + 1).map((s) => fresh(s, effectOf(s))),
    });
  });
  const selected = selectCheckpoint(checkpoints, facts.checkpoint);
  const checkpointOption: RecoveryOption = selected
    ? {
        kind: "checkpoint-attempt",
        readiness: selected.readiness,
        blockers: selected.blockers,
        unverified: selected.unverified,
        checkpointStepRunId: selected.stepRunId,
        runsAgain: selected.ranAfter,
      }
    : {
        kind: "checkpoint-attempt",
        readiness: "blocked",
        blockers: unique([...checkpointBlockers, "no-checkpoint" as const]),
        unverified: [],
        runsAgain: [],
      };

  // A new run reuses nothing and runs on today's configuration: every step may run again,
  // including the ones whose effects are uncertain here. Listed so that is visible.
  const latest = new Map<string, StepRun>();
  for (const step of steps) latest.set(step.nodeId, step);
  const newRun: RecoveryOption = {
    kind: "new-run",
    readiness: "available",
    blockers: [],
    unverified: [],
    runsAgain: [...latest.values()].map((s) => fresh(s, effectOf(s))),
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
        readiness: readinessOf(resumeBlockers, resumeUnverified),
        blockers: unique(resumeBlockers),
        unverified: unique(resumeUnverified),
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
}

/**
 * The checkpoint a caller named, by step run id or by a node id that names exactly one; without
 * a name, the latest one that is not blocked (else the latest). A node id that names several is
 * refused with their step run ids, because after a loop a node id is not a point in history.
 */
function selectCheckpoint(
  checkpoints: readonly RecoveryCheckpoint[],
  name: string | undefined,
): RecoveryCheckpoint | undefined {
  if (name === undefined)
    return [...checkpoints].reverse().find((c) => c.readiness !== "blocked") ?? checkpoints.at(-1);
  const exact = checkpoints.find((c) => c.stepRunId === name);
  if (exact) return exact;
  const atNode = checkpoints.filter((c) => c.nodeId === name);
  if (atNode.length === 1) return atNode[0];
  if (atNode.length > 1)
    throw new OrcaError(
      "CONFIG_INVALID",
      `'${name}' completed more than once in this run; name one step run instead: ${atNode
        .map((c) => `${c.stepRunId} (attempt ${c.attempt})`)
        .join(", ")}`,
      { checkpoints: atNode.map((c) => c.stepRunId) },
    );
  throw new OrcaError("CONFIG_INVALID", `this run has no completed step '${name}' to recover from`);
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}
