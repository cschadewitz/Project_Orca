/**
 * Read-only recovery assessment for one run (#357, phase 1): gathers the facts
 * `assessRecovery` needs from the stores and changes nothing. It takes no lease, appends no
 * event and starts nothing, so it is safe to call while another process drives the run.
 */
import {
  assessRecovery,
  OrcaError,
  reduceRun,
  type OrcaEventPayload,
  type RecoveryAssessment,
  type RecoveryRunFacts,
} from "@orca/core";
import { lapsed, type Stores } from "@orca/store";
import { INLINE_SEP, runLeaseResource } from "./orchestrator.js";

export interface RecoveryPreviewOptions {
  /** The principal asking; compared with the run's recorded creator for history-based recovery. */
  principalId?: string | undefined;
  /** The version a new run of this workflow would use now, when known. */
  currentWorkflowVersion?: string | undefined;
  /** The configuration generation a new run would be admitted on now, when known. */
  currentConfigGeneration?: string | undefined;
  now?: number;
}

export async function previewRecovery(
  stores: Stores,
  runId: string,
  options: RecoveryPreviewOptions = {},
): Promise<RecoveryAssessment> {
  const self = await runFacts(stores, runId, options.now);
  if (!self) throw new OrcaError("RUN_NOT_FOUND", `run ${runId} not found`);
  const { facts, created } = self;
  const state = facts.state;

  // Resume re-drives the topmost paused ancestor, as the orchestrator does, and so drives every
  // paused run between it and this one. Each of them is checked like this run.
  const resumeAncestors: RecoveryRunFacts[] = [];
  for (let parentId = state.run.parentRunId; parentId;) {
    const parent = await runFacts(stores, parentId, options.now);
    if (!parent || parent.facts.state.run.status !== "paused") break;
    resumeAncestors.push(parent.facts);
    parentId = parent.facts.state.run.parentRunId;
  }

  // An artifact counts only when its record and its bytes read back (the file backend also
  // checks the bytes against their hash). Checked once per id.
  const artifactIds = new Set(Object.values(state.steps).flatMap((step) => step.result?.artifactIds ?? []));
  const present = new Set<string>();
  for (const id of artifactIds) {
    try {
      if ((await stores.artifacts.get(id)) === undefined) continue;
      await stores.artifacts.bytes(id);
      present.add(id);
    } catch {
      // Missing or invalid: reported as missing, never thrown.
    }
  }

  return assessRecovery({
    ...facts,
    creatorPrincipalId: created.actor?.principalId,
    principalId: options.principalId,
    resumeAncestors,
    artifactPresent: (id) => present.has(id),
    currentWorkflowVersion: options.currentWorkflowVersion,
    currentConfigGeneration: options.currentConfigGeneration,
  });
}

/** One run's log, pinned definition, launch inputs and lease, read without writing anything. */
async function runFacts(
  stores: Stores,
  runId: string,
  now: number | undefined,
): Promise<{ facts: RecoveryRunFacts; created: OrcaEventPayload<"run.created"> } | undefined> {
  const events = await stores.events.read(runId);
  const first = events[0];
  if (!first) return undefined;
  if (first.type !== "run.created") throw new OrcaError("RUN_STATE", `run ${runId} has no run.created event`);
  const state = reduceRun(events);
  const created = first.payload;
  const rootId = state.run.workflowId.split(INLINE_SEP)[0]!;
  const workflowStored = created.workflowStored === true;
  const workflowReadable = workflowStored
    ? await stores.workflows.get(rootId, state.run.workflowVersion).then(
        (definition) => definition !== undefined,
        () => false,
      )
    : true;
  const executionInputsAvailable = created.executionInputsStored
    ? await stores.execution.getInputs(runId).then(
        (inputs) => inputs !== undefined,
        () => false,
      )
    : true;
  const lease = await stores.leases.get(runLeaseResource(runId));
  const leased = lease !== undefined && !lapsed(lease, now);
  return { facts: { state, workflowStored, workflowReadable, executionInputsAvailable, leased }, created };
}
